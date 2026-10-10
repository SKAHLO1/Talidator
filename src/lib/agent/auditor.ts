/**
 * Talidator auditor agent — a Qwen model (QWEN_MODEL, default qwen3.8-max) with tool use.
 *
 * Given a validation request, the model plans an investigation and calls tools that read the chain
 * (request, votes, challenge state, validator track records, agent reputation), decode the trader's claim,
 * independently re-execute it against the live Chainlink price feeds on Monad testnet, and inspect raw feed rounds.
 * It finishes with a
 * structured verdict and a recommended on-chain action (e.g. "challenge"), which the daemon's autonomous mode
 * can execute. Shared by the web app (/api/audit) and the agents (contracts/agents) — relative imports only.
 */
import type { Address, Hex, PublicClient } from "viem";
import { formatEther } from "viem";
import type {
  challengeMarketAbi, identityRegistryAbi, reputationRegistryAbi, validationRegistryAbi, validatorStakingAbi,
} from "../chain/abi";
import { decodeClaim, evaluate } from "../chain/claims";
import { QWEN_DEFAULTS } from "./model";
import { PAIRS, recentRounds, type Pair } from "../chain/market";

export interface AuditContracts {
  identity: { address: Address; abi: typeof identityRegistryAbi };
  staking: { address: Address; abi: typeof validatorStakingAbi };
  registry: { address: Address; abi: typeof validationRegistryAbi };
  market: { address: Address; abi: typeof challengeMarketAbi };
  reputation: { address: Address; abi: typeof reputationRegistryAbi };
}

export interface LlmConfig {
  apiKey: string;
  baseUrl?: string;
  model?: string;
}

export interface AuditVerdict {
  verdict: "result_correct" | "result_wrong" | "inconclusive";
  /** what an honest participant should do next */
  recommendedAction: "none" | "challenge" | "wait";
  confidence: number;
  summary: string;
  findings: string[];
}

export interface AuditStep {
  tool: string;
  args: Record<string, unknown>;
  result: unknown;
}

export interface AuditResult extends AuditVerdict {
  requestHash: Hex;
  model: string;
  steps: AuditStep[];
  createdAt: number;
}

export { QWEN_DEFAULTS };

const STATUS = ["None", "Pending", "Passed", "Failed"] as const;
const CHALLENGE = ["None", "Open", "Upheld", "Rejected"] as const;
const MAX_TURNS = 10;

const SYSTEM = `You are Talidator's independent auditor agent on Monad. Talidator is an ERC-8004 Validation Registry:
a trader agent claims a trade, a quorum of bonded validators re-executes it and votes PASS/FAIL, escrowed payment is
released only on PASS, and anyone may stake a bond to challenge a finalized result inside the challenge window.
If a challenge is upheld, validators who voted for the wrong outcome are slashed and the challenger is paid.

Your job: decide whether the recorded quorum result for a request is correct, using the tools. Plan before acting.
Always (1) fetch the request, (2) re-execute the claim yourself, and (3) when anything looks off, inspect the raw
Chainlink feed rounds and the validators' track records. Never trust the trader's reported numbers or the validators' votes
without checking. Be precise and cite numbers from tool outputs.

Recommend "challenge" ONLY if the result is finalized, you are confident it is wrong, and the challenge window is
still open (a wrong challenge forfeits the bond). Recommend "wait" if voting is still in progress.

When done, reply with ONLY a JSON object:
{"verdict":"result_correct"|"result_wrong"|"inconclusive","recommendedAction":"none"|"challenge"|"wait",
 "confidence":0..1,"summary":"one or two sentences","findings":["short evidence bullet", ...]}`;

const TOOLS = [
  {
    type: "function",
    function: {
      name: "get_request",
      description: "Read a validation request from the ValidationRegistry: status, votes per validator, threshold, effective outcome, finalization time, challenge state and the remaining challenge window.",
      parameters: { type: "object", properties: { requestHash: { type: "string" } }, required: ["requestHash"] },
    },
  },
  {
    type: "function",
    function: {
      name: "decode_claim",
      description: "Decode the trader's claimed trade (pair, side, size, Chainlink feed + entry/exit round ids, times and prices, reported PnL) from the request's data URI.",
      parameters: { type: "object", properties: { requestHash: { type: "string" } }, required: ["requestHash"] },
    },
  },
  {
    type: "function",
    function: {
      name: "reexecute_claim",
      description: "Independently re-execute the claim against the live Chainlink Data Feed on Monad testnet. Returns each check (rounds exist, entry/exit fills within slippage of the round price, momentum signal valid, PnL matches), the on-chain entry/exit rounds and the recomputed PnL.",
      parameters: { type: "object", properties: { requestHash: { type: "string" } }, required: ["requestHash"] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_price_rounds",
      description: "Raw Chainlink Data Feed rounds (roundId, price in USD, updatedAt) on Monad testnet for a pair: up to 30 consecutive rounds ending at toRound (default: the latest round), oldest first.",
      parameters: {
        type: "object",
        properties: { pair: { type: "string", enum: PAIRS }, toRound: { type: "string" }, limit: { type: "number" } },
        required: ["pair"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_validator_record",
      description: "A validator's bond, slashing history and voting track record (assigned, votes cast, votes that agreed with final outcomes).",
      parameters: { type: "object", properties: { address: { type: "string" } }, required: ["address"] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_agent_reputation",
      description: "The trader agent's ERC-8004 identity and its reputation derived from final validated outcomes.",
      parameters: { type: "object", properties: { agentId: { type: "string" } }, required: ["agentId"] },
    },
  },
] as const;

type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[] }
  | { role: "tool"; tool_call_id: string; content: string };

async function runTool(name: string, args: Record<string, unknown>, client: PublicClient, c: AuditContracts): Promise<unknown> {
  const hash = String(args.requestHash ?? "") as Hex;
  switch (name) {
    case "get_request": {
      const [r, [finalized, passed], window, chId] = await Promise.all([
        client.readContract({ ...c.registry, functionName: "getRequest", args: [hash] }),
        client.readContract({ ...c.registry, functionName: "outcome", args: [hash] }),
        client.readContract({ ...c.market, functionName: "challengeWindow" }),
        client.readContract({ ...c.market, functionName: "challengeOf", args: [hash] }),
      ]);
      if (r.status === 0) return { error: "No request with this hash" };
      const votes = await Promise.all(r.validators.map((v) => client.readContract({ ...c.registry, functionName: "getVote", args: [hash, v] })));
      const block = await client.getBlock();
      const now = Number(block.timestamp);
      const ch = chId > 0n ? await client.readContract({ ...c.market, functionName: "getChallenge", args: [chId] }) : null;
      return {
        status: STATUS[r.status],
        agentId: r.agentId.toString(),
        requester: r.requester,
        threshold: r.threshold,
        votes: r.validators.map((v, i) => ({ validator: v, vote: ["none", "PASS", "FAIL"][votes[i]!.choice], evidenceHash: votes[i]!.evidenceHash })),
        finalized,
        effectiveOutcome: finalized ? (passed ? "PASS" : "FAIL") : "pending",
        overturned: r.overturned,
        secondsUntilVotingDeadline: r.status === 1 ? Math.max(0, Number(r.deadline) - now) : null,
        challengeWindowSecondsLeft: finalized && !ch ? Math.max(0, Number(r.finalizedAt) + Number(window) - now) : 0,
        challenge: ch ? { id: chId.toString(), status: CHALLENGE[ch.status], challenger: ch.challenger, upholdVotes: ch.upholdVotes, rejectVotes: ch.rejectVotes } : null,
      };
    }
    case "decode_claim": {
      const r = await client.readContract({ ...c.registry, functionName: "getRequest", args: [hash] });
      return decodeClaim(r.requestURI) ?? { error: "Claim is not a Talidator trade claim" };
    }
    case "reexecute_claim": {
      const r = await client.readContract({ ...c.registry, functionName: "getRequest", args: [hash] });
      const ev = await evaluate(client, r.requestURI, hash);
      return {
        pass: ev.pass,
        reason: ev.reason,
        evidenceHash: ev.evidenceHash,
        checks: ev.result?.checks,
        chainlinkEntry: ev.result?.entry,
        chainlinkExit: ev.result?.exit,
        reportedPnl: ev.claim?.reportedPnl,
        recomputedPnl: ev.result?.recomputedPnl ?? null,
      };
    }
    case "get_price_rounds": {
      const pair = String(args.pair) as Pair;
      if (!PAIRS.includes(pair)) return { error: `pair must be one of ${PAIRS.join(", ")}` };
      const to = args.toRound ? BigInt(String(args.toRound)) : undefined;
      return recentRounds(client, pair, Number(args.limit) || 10, to);
    }
    case "get_validator_record": {
      const addr = String(args.address) as Address;
      const [stake, stats] = await Promise.all([
        client.readContract({ ...c.staking, functionName: "getStake", args: [addr] }),
        client.readContract({ ...c.registry, functionName: "validatorStats", args: [addr] }),
      ]);
      return {
        bondedMON: formatEther(stake.amount),
        slashedMON: formatEther(stake.slashedTotal),
        active: stake.active,
        assigned: Number(stats[0]),
        votesCast: Number(stats[1]),
        agreedWithFinalOutcome: Number(stats[2]),
      };
    }
    case "get_agent_reputation": {
      const id = BigInt(String(args.agentId));
      const [agent, [count, avg]] = await Promise.all([
        client.readContract({ ...c.identity, functionName: "getAgent", args: [id] }).catch(() => null),
        client.readContract({ ...c.reputation, functionName: "getSummary", args: [id] }),
      ]);
      return { exists: !!agent, wallet: agent?.agentWallet, finalOutcomes: Number(count), averageScore: Number(avg) / 100 };
    }
    default:
      return { error: `Unknown tool ${name}` };
  }
}

async function chat(llm: Required<LlmConfig>, messages: ChatMessage[]) {
  const res = await fetch(`${llm.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${llm.apiKey}` },
    body: JSON.stringify({ model: llm.model, messages, tools: TOOLS, tool_choice: "auto", temperature: 0.1 }),
  });
  if (!res.ok) throw new Error(`Qwen API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = (await res.json()) as { choices?: { message: Extract<ChatMessage, { role: "assistant" }> }[] };
  const msg = json.choices?.[0]?.message;
  if (!msg) throw new Error("Qwen API returned no choices");
  return msg;
}

function parseVerdict(text: string): AuditVerdict {
  const match = text.match(/\{[\s\S]*\}/);
  try {
    const v = JSON.parse(match ? match[0] : text) as Partial<AuditVerdict>;
    return {
      verdict: v.verdict === "result_correct" || v.verdict === "result_wrong" ? v.verdict : "inconclusive",
      recommendedAction: v.recommendedAction === "challenge" || v.recommendedAction === "wait" ? v.recommendedAction : "none",
      confidence: Math.max(0, Math.min(1, Number(v.confidence) || 0)),
      summary: String(v.summary ?? "").slice(0, 600),
      findings: Array.isArray(v.findings) ? v.findings.map(String).slice(0, 10) : [],
    };
  } catch {
    return { verdict: "inconclusive", recommendedAction: "none", confidence: 0, summary: text.slice(0, 600), findings: [] };
  }
}

/** Run the agent loop for one request. Throws on transport/API errors. */
export async function runAudit(requestHash: Hex, client: PublicClient, contracts: AuditContracts, cfg: LlmConfig): Promise<AuditResult> {
  const llm = { baseUrl: cfg.baseUrl || QWEN_DEFAULTS.baseUrl, model: cfg.model || QWEN_DEFAULTS.model, apiKey: cfg.apiKey };
  const steps: AuditStep[] = [];
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM },
    { role: "user", content: `Audit validation request ${requestHash} on Monad testnet and give your verdict.` },
  ];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const msg = await chat(llm, messages);
    messages.push({ role: "assistant", content: msg.content ?? null, tool_calls: msg.tool_calls });
    if (!msg.tool_calls?.length) {
      return { ...parseVerdict(msg.content ?? ""), requestHash, model: llm.model, steps, createdAt: Math.floor(Date.now() / 1000) };
    }
    for (const callReq of msg.tool_calls) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(callReq.function.arguments || "{}");
      } catch {
        /* model sent malformed JSON; tool will report the error */
      }
      const result = await runTool(callReq.function.name, args, client, contracts).catch((e: Error) => ({ error: e.message.split("\n")[0] }));
      steps.push({ tool: callReq.function.name, args, result });
      messages.push({ role: "tool", tool_call_id: callReq.id, content: JSON.stringify(result, (_, v) => (typeof v === "bigint" ? v.toString() : v)) });
    }
  }
  return {
    verdict: "inconclusive", recommendedAction: "none", confidence: 0, summary: "Stopped after the maximum number of steps.",
    findings: [], requestHash, model: llm.model, steps, createdAt: Math.floor(Date.now() / 1000),
  };
}
