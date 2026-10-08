/**
 * Reads Talidator state from Monad testnet and maps it onto the dashboard's data model.
 *
 * State (requests, votes, stakes, challenges, reputation) comes from contract views — batched into
 * Multicall3 by the public client. Activity and per-request transaction hashes come from event logs,
 * fetched incrementally in 100-block chunks (Monad's eth_getLogs range limit).
 */
import { formatEther, parseEventLogs, type Hex } from "viem";
import type {
  Activity, ActivityKind, Agent, AgentRole, Asset, NetworkStats, ProtocolParams, RequestStatus, Validator, ValidationRequest, Vote,
} from "../types";
import { agentNameFromURI, decodeClaim, describeClaim } from "./claims";
import { contracts, deployment, publicClient } from "./config";

const ROLE: Record<number, AgentRole> = { 1: "trader", 2: "validator", 3: "challenger" };
const REG = { Pending: 1, Passed: 2, Failed: 3 };
const CH = { Open: 1 };
const ESCROW: Record<number, ValidationRequest["escrow"]> = { 0: "none", 1: "funded", 2: "released", 3: "refunded" };
const REQUEST_PAGE = 25n;
// eth_getLogs block range per call: 100 on Monad's public RPC, 10 on Alchemy's free tier, 1000 on Alchemy paid.
// Only used when no Envio indexer is configured.
const LOG_CHUNK = BigInt(process.env.NEXT_PUBLIC_LOG_CHUNK_SIZE || 100);
const CHUNKS_PER_POLL = 25;
const INITIAL_BACKFILL = LOG_CHUNK * 200n; // 20k blocks (~2h) at the default chunk size

const num = (wei: bigint) => Number(formatEther(wei));
const lc = (a: string) => a.toLowerCase();
const ASSETS: Asset[] = ["ETH", "BTC", "LINK"];

export interface Snapshot {
  requests: ValidationRequest[];
  validators: Validator[];
  agents: Agent[];
  reputation: { agent: string; score: number; feedback: number }[];
  activity: Activity[];
  stats: NetworkStats;
  params: ProtocolParams;
  blockNumber: bigint;
  /** true while older event history is still being backfilled */
  backfilling: boolean;
  /** where indexed state came from this poll */
  source?: "envio" | "rpc";
}

type DecodedLog = {
  eventName: string;
  args: Record<string, unknown>;
  transactionHash: Hex;
  logIndex: number;
  blockNumber: bigint;
};

/** Incremental event cache, kept for the page lifetime. */
export class LogCache {
  logs: DecodedLog[] = [];
  cursor: bigint | null = null;
  blockTimes = new Map<bigint, number>();
}

async function syncLogs(cache: LogCache, latest: bigint) {
  const c = contracts!;
  const start = BigInt(deployment!.startBlock);
  if (cache.cursor === null) cache.cursor = latest - INITIAL_BACKFILL > start ? latest - INITIAL_BACKFILL : start - 1n;
  const addresses = [c.identity, c.staking, c.registry, c.escrow, c.market, c.reputation].map((x) => x.address);
  const abi = [...c.identity.abi, ...c.staking.abi, ...c.registry.abi, ...c.escrow.abi, ...c.market.abi, ...c.reputation.abi];

  // Fetch this poll's chunks in parallel (one JSON-RPC batch), then append in order.
  const ranges: [bigint, bigint][] = [];
  let cursor: bigint = cache.cursor;
  for (let i = 0; i < CHUNKS_PER_POLL && cursor < latest; i++) {
    const from: bigint = cursor + 1n;
    const to: bigint = from + LOG_CHUNK - 1n < latest ? from + LOG_CHUNK - 1n : latest;
    ranges.push([from, to]);
    cursor = to;
  }
  const results = await Promise.all(ranges.map(([fromBlock, toBlock]) => publicClient.getLogs({ address: addresses, fromBlock, toBlock })));
  for (const raw of results) cache.logs.push(...(parseEventLogs({ abi, logs: raw }) as unknown as DecodedLog[]));
  cache.cursor = cursor;
  if (cache.logs.length > 3000) cache.logs = cache.logs.slice(-3000);
  return cursor < latest;
}

function mapStatus(status: number, overturned: boolean, votesCast: number, challengeStatus: number): RequestStatus {
  if (status === REG.Pending) return votesCast === 0 ? "Pending" : "In Progress";
  if (challengeStatus === CH.Open) return "Challenged";
  if (overturned) return "Overturned";
  return status === REG.Passed ? "Validated" : "Rejected";
}

export async function readSnapshot(cache: LogCache): Promise<Snapshot> {
  const c = contracts;
  if (!c || !deployment) throw new Error("Talidator is not deployed on Monad testnet yet");
  const read = publicClient.readContract;

  const block = await publicClient.getBlock();
  const now = Number(block.timestamp);

  const [
    totalAgents, validatorAddrs, requestCount, hashes, challengeCount,
    minBond, challengeBond, challengeWindow, reviewPeriod, slashBps, cutBps, votingPeriod, arbiter,
    stakingBal, escrowBal, marketBal,
  ] = await Promise.all([
    read({ ...c.identity, functionName: "totalAgents" }),
    read({ ...c.staking, functionName: "getValidators" }),
    read({ ...c.registry, functionName: "requestCount" }),
    read({ ...c.registry, functionName: "getRequestHashes", args: [0n, REQUEST_PAGE] }),
    read({ ...c.market, functionName: "challengeCount" }),
    read({ ...c.staking, functionName: "minBond" }),
    read({ ...c.market, functionName: "challengeBond" }),
    read({ ...c.market, functionName: "challengeWindow" }),
    read({ ...c.market, functionName: "reviewPeriod" }),
    read({ ...c.market, functionName: "slashBps" }),
    read({ ...c.market, functionName: "challengerCutBps" }),
    read({ ...c.registry, functionName: "votingPeriod" }),
    read({ ...c.market, functionName: "arbiter" }),
    publicClient.getBalance({ address: c.staking.address }),
    publicClient.getBalance({ address: c.escrow.address }),
    publicClient.getBalance({ address: c.market.address }),
  ]);

  // ── agents ──
  const ids = Array.from({ length: Number(totalAgents) }, (_, i) => BigInt(i + 1));
  const agentRows = await Promise.all(
    ids.map(async (id) => {
      const [info, owner, uri] = await Promise.all([
        read({ ...c.identity, functionName: "getAgent", args: [id] }),
        read({ ...c.identity, functionName: "ownerOf", args: [id] }),
        read({ ...c.identity, functionName: "tokenURI", args: [id] }),
      ]);
      return { id, info, owner, name: agentNameFromURI(uri) ?? `Agent #${id}` };
    }),
  );
  const agents: Agent[] = agentRows.map((a) => ({
    tokenId: Number(a.id),
    name: a.name,
    address: a.info.agentWallet,
    role: ROLE[a.info.role] ?? "trader",
    owner: a.owner,
    registeredAt: new Date(Number(a.info.registeredAt) * 1000).toISOString().slice(0, 10),
    adversarial: /adversarial|shady|liar/i.test(a.name),
  }));
  const walletOfAgent = new Map(agentRows.map((a) => [a.id, a.info.agentWallet as string]));
  const nameOf = (addr: unknown) =>
    agents.find((a) => lc(a.address) === lc(String(addr)))?.name ?? `${String(addr).slice(0, 6)}…${String(addr).slice(-4)}`;

  // ── validators ──
  const validators: Validator[] = await Promise.all(
    validatorAddrs.map(async (addr) => {
      const [stake, stats] = await Promise.all([
        read({ ...c.staking, functionName: "getStake", args: [addr] }),
        read({ ...c.registry, functionName: "validatorStats", args: [addr] }),
      ]);
      const [, cast, agreed] = stats;
      return {
        address: addr,
        name: nameOf(addr),
        successRate: cast === 0n ? 100 : Math.round((Number(agreed) / Number(cast)) * 100),
        totalVotes: Number(cast),
        stake: num(stake.amount),
        slashed: num(stake.slashedTotal),
        status: stake.unbondAt > 0n ? "unbonding" : !stake.active ? (stake.slashedTotal > 0n ? "slashed" : "inactive") : "active",
      } satisfies Validator;
    }),
  );

  // ── challenges (recent) ──
  const chIds: bigint[] = [];
  for (let id = challengeCount; id > 0n && id > challengeCount - 30n; id--) chIds.push(id);
  const challenges = await Promise.all(chIds.map((id) => read({ ...c.market, functionName: "getChallenge", args: [id] })));
  const challengeByHash = new Map(challenges.map((ch) => [ch.requestHash, ch]));
  const challengeById = new Map(chIds.map((id, i) => [id, challenges[i]]));

  // ── requests ──
  const total = Number(requestCount);
  const idOf = new Map<string, number>(hashes.map((h, i) => [h, total - i]));
  const requests: ValidationRequest[] = await Promise.all(
    hashes.map(async (h) => {
      const [r, deal, isFinal] = await Promise.all([
        read({ ...c.registry, functionName: "getRequest", args: [h] }),
        read({ ...c.escrow, functionName: "getDeal", args: [h] }),
        read({ ...c.market, functionName: "isFinal", args: [h] }),
      ]);
      const votesRaw = await Promise.all(r.validators.map((v) => read({ ...c.registry, functionName: "getVote", args: [h, v] })));
      const votes: Vote[] = votesRaw.map((v) => (v.choice === 1 ? "pass" : v.choice === 2 ? "fail" : null));
      const claim = decodeClaim(r.requestURI);
      const d = claim ? describeClaim(claim) : { asset: "ETH", quote: "?", task: "Unrecognised claim format" };
      const ch = challengeByHash.get(h);
      const cast = votes.filter(Boolean).length;
      const finalizedAt = Number(r.finalizedAt);
      const windowLeft = finalizedAt ? finalizedAt + Number(challengeWindow) - now : 0;
      const status = mapStatus(r.status, r.overturned, cast, ch?.status ?? 0);
      return {
        id: idOf.get(h)!,
        requestHash: h,
        agent: walletOfAgent.get(r.agentId) ?? r.requester,
        requester: r.requester,
        payer: deal.state === 0 ? undefined : deal.payer,
        asset: (ASSETS.includes(d.asset as Asset) ? d.asset : "ETH") as Asset,
        quote: d.quote,
        task: d.task,
        validators: [...r.validators],
        votes,
        threshold: r.threshold,
        status,
        secondsLeft: r.status === REG.Pending ? Math.max(0, Number(r.deadline) - now) : null,
        challengeWindow: (status === "Validated" || status === "Rejected") && !ch && windowLeft > 0 ? windowLeft : null,
        challengeResolveIn: ch && ch.status === CH.Open ? Math.max(0, Number(ch.reviewDeadline) - now) : null,
        challenger: ch?.challenger,
        payment: num(deal.amount),
        escrow: ESCROW[deal.state] ?? "none",
        finalized: isFinal,
        txHashes: [],
      } satisfies ValidationRequest;
    }),
  );

  // ── events → activity + per-request tx hashes ──
  const backfilling = await syncLogs(cache, block.number);
  const txByHash = new Map<string, { label: string; hash: string }[]>();
  const addTx = (h: unknown, label: string, hash: string) => {
    const k = String(h);
    txByHash.set(k, [...(txByHash.get(k) ?? []), { label, hash }]);
  };
  const activity: Activity[] = [];
  const pushAct = (kind: ActivityKind, title: string, detail: string, log: DecodedLog, actors: unknown[] = []) =>
    activity.push({
      id: `${log.transactionHash}-${log.logIndex}`, kind, title, detail, ago: 0, at: 0, txHash: log.transactionHash,
      requestHash: typeof log.args.requestHash === "string" ? log.args.requestHash : undefined,
      actors: actors.filter(Boolean).map((x) => lc(String(x))),
    });
  const tradeLabel = (h: unknown) => (idOf.has(String(h)) ? `Trade #${idOf.get(String(h))}` : `Request ${String(h).slice(0, 10)}`);

  for (const log of cache.logs) {
    const a = log.args;
    const tx = log.transactionHash;
    switch (log.eventName) {
      case "Deposited":
        addTx(a.requestHash, `Escrow.deposit() · ${num(a.amount as bigint)}`, tx);
        break;
      case "ValidationRequested":
        addTx(a.requestHash, "validationRequest()", tx);
        pushAct("request", "Validation requested", tradeLabel(a.requestHash), log, [a.requester, ...((a.validators as string[]) ?? [])]);
        break;
      case "VoteSubmitted":
        addTx(a.requestHash, `Vote · ${nameOf(a.validator)} → ${a.pass ? "pass" : "fail"}`, tx);
        pushAct("vote", `Vote cast: ${a.pass ? "PASS" : "FAIL"}`, `${tradeLabel(a.requestHash)} • ${nameOf(a.validator)}`, log, [a.validator]);
        break;
      case "ValidationFinalized":
        addTx(a.requestHash, `Quorum finalized · ${a.passed ? "PASS" : "FAIL"}`, tx);
        pushAct(a.passed ? "validated" : "rejected", a.passed ? "Validation completed" : "Validation failed",
          `${tradeLabel(a.requestHash)} • ${a.passVotes}/${Number(a.passVotes) + Number(a.failVotes)} pass`, log);
        break;
      case "Released":
        addTx(a.requestHash, "Escrow.release()", tx);
        pushAct("payment", "Payment released", `${tradeLabel(a.requestHash)} • ${num(a.amount as bigint)} to ${nameOf(a.payee)}`, log, [a.payee]);
        break;
      case "Refunded":
        addTx(a.requestHash, "Escrow.refund() — payment refused", tx);
        pushAct("rejected", "Payment refused", `${tradeLabel(a.requestHash)} • refunded to client`, log, [a.payer]);
        break;
      case "ChallengeOpened":
        addTx(a.requestHash, `ChallengeMarket.challenge() · bond ${num(a.bond as bigint)}`, tx);
        pushAct("challenge", "Challenge raised", `${tradeLabel(a.requestHash)} • by ${nameOf(a.challenger)}`, log, [a.challenger, ...((a.reviewers as string[]) ?? [])]);
        break;
      case "ReviewSubmitted": {
        const ch = challengeById.get(a.challengeId as bigint);
        if (ch) addTx(ch.requestHash, `Review · ${nameOf(a.reviewer)} → ${a.uphold ? "uphold" : "reject"}`, tx);
        break;
      }
      case "ChallengeResolved":
        addTx(a.requestHash, a.upheld ? `Challenge upheld · slashed ${num(a.slashedTotal as bigint)}` : "Challenge rejected · bond forfeited", tx);
        pushAct(a.upheld ? "challenge-won" : "challenge-lost", a.upheld ? "Challenge successful" : "Challenge rejected",
          `${tradeLabel(a.requestHash)} • ${a.upheld ? `Slashed ${num(a.slashedTotal as bigint)}` : "bond forfeited"}`, log);
        break;
      case "NewFeedback":
        addTx(a.requestHash, "ReputationRegistry.postOutcome()", tx);
        pushAct("reputation", "Reputation posted", `${tradeLabel(a.requestHash)} • score ${a.score}`, log);
        break;
      case "AgentRegistered":
        pushAct("registered", Number(a.role) === 2 ? "Validator registered" : "Agent registered", nameOf(a.agentWallet), log, [a.agentWallet]);
        break;
    }
  }
  for (const r of requests) r.txHashes = txByHash.get(r.requestHash) ?? [];

  // Real timestamps for the most recent activity rows (cached per block).
  activity.reverse();
  // Keep enough history that per-user dashboards and alerts still have rows on a busy network.
  const recent = activity.slice(0, 200);
  const blockOfTx = new Map(cache.logs.map((l) => [l.transactionHash, l.blockNumber]));
  const missing = [...new Set(recent.map((x) => blockOfTx.get(x.txHash as Hex)!).filter((b) => b !== undefined && !cache.blockTimes.has(b)))];
  await Promise.all(missing.map(async (b) => cache.blockTimes.set(b, Number((await publicClient.getBlock({ blockNumber: b })).timestamp))));
  for (const x of recent) {
    const t = cache.blockTimes.get(blockOfTx.get(x.txHash as Hex)!);
    x.at = t ?? now;
    x.ago = t ? Math.max(0, now - t) : 0;
  }

  // ── reputation ──
  const traders = agentRows.filter((a) => a.info.role === 1);
  const reputationRows = await Promise.all(
    traders.map(async (t) => {
      const [count, avg] = await read({ ...c.reputation, functionName: "getSummary", args: [t.id] });
      return { agent: t.info.agentWallet as string, score: Number(avg) / 100, feedback: Number(count) };
    }),
  );

  return {
    requests,
    validators,
    agents,
    reputation: reputationRows.filter((r) => r.feedback > 0),
    activity: recent,
    stats: {
      tvl: num(stakingBal + escrowBal + marketBal),
      totalValidators: validatorAddrs.length,
      totalRequests: total,
      activeChallenges: challenges.filter((ch) => ch.status === CH.Open).length,
      slashed: validators.reduce((s, v) => s + v.slashed, 0),
    },
    params: {
      challengeWindowSec: Number(challengeWindow),
      challengeBond: num(challengeBond),
      slashPercent: Number(slashBps) / 100,
      challengerCutPercent: Number(cutBps) / 100,
      minBond: num(minBond),
      votingPeriodSec: Number(votingPeriod),
      reviewPeriodSec: Number(reviewPeriod),
      arbiter,
    },
    blockNumber: block.number,
    backfilling,
    source: "rpc",
  };
}
