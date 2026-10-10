/**
 * Long-running validator network + relayer + keeper. Run it next to the dashboard in On-chain mode:
 *
 *   npm run validator -- --network local
 *   COLLUDING=Alpha,Beta npm run validator -- --network local     # stage dishonest validators
 *
 * Every POLL_MS it:
 *   • votes (via EIP-712 + relayer) for managed validators assigned to pending requests
 *   • reviews open challenges where a managed validator is on the fresh quorum
 *   • finalizes requests past their voting deadline
 *   • settles escrow: refunds failed results at once, releases passed results once final
 *     (challenge window elapsed / challenge resolved)
 *   • posts reputation for final outcomes
 *   • acts as arbiter when a challenge has no reviewers or its review deadline passed without a majority
 */
import { createServer } from "node:http";
import type { Hex } from "viem";
import { ensureSetup, getChallenger, getValidatorNetwork, type AgentAccount } from "./lib/agents";
import { auditorEnabled, autoAudit } from "./lib/auditor";
import { C, chain, confirm, operator, publicClient, rpcProvider, wallet } from "./lib/clients";
import { env } from "./lib/env";
import { log } from "./lib/log";
import { arbitrate, castVote, review, settleEscrow, CHALLENGE, DEAL, STATUS } from "./lib/validator";

const POLL_MS = Number(env("POLL_MS") ?? 2500);
// KEEPER=off hands escrow settlement + reputation posting to the Chainlink CRE workflow (../cre).
const KEEPER = (env("KEEPER") ?? "on").toLowerCase() !== "off";
const colluding = new Set((env("COLLUDING") ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
const managed = new Map<string, AgentAccount>();
const isColluder = (addr: string) => {
  const v = managed.get(addr.toLowerCase());
  return !!v && colluding.has(v.name.replace("Validator ", "").toLowerCase());
};

const done = new Set<Hex>(); // requests fully settled — skip on later polls
const busy = new Set<string>();

async function once(key: string, fn: () => Promise<void>) {
  if (busy.has(key)) return;
  busy.add(key);
  try {
    await fn();
  } catch (e) {
    log.warn(`${key}: ${(e as Error).message.split("\n")[0]}`);
  } finally {
    busy.delete(key);
  }
}

let challengeWindow = 600n;

async function handleRequest(h: Hex, now: bigint) {
  const r = await publicClient.readContract({ ...C.registry, functionName: "getRequest", args: [h] });

  if (r.status === STATUS.Pending) {
    if (now > r.deadline) {
      await once(`finalize:${h}`, async () => {
        const tx = await wallet(operator).writeContract({ ...C.registry, functionName: "finalize", args: [h], chain, account: operator });
        log.tx(`finalize() after deadline`, await confirm(tx));
      });
      return;
    }
    for (const v of r.validators) {
      const agent = managed.get(v.toLowerCase());
      if (!agent) continue;
      const vote = await publicClient.readContract({ ...C.registry, functionName: "getVote", args: [h, v] });
      if (vote.choice !== 0) continue;
      await once(`vote:${h}:${v}`, async () => {
        const res = await castVote(agent.signer, h, { collude: isColluder(v) });
        log.tx(`${agent.name} → ${res.pass ? "PASS" : "FAIL"} · ${h.slice(0, 10)}`, res.hash);
      });
    }
    return;
  }

  // Finalized + unchallenged + window open: let the Qwen auditor decide whether to challenge.
  if (auditorEnabled && now <= r.finalizedAt + challengeWindow) {
    const chId = await publicClient.readContract({ ...C.market, functionName: "challengeOf", args: [h] });
    if (chId === 0n) await once(`audit:${h}`, async () => autoAudit(h, await getChallenger()));
  }

  // Finalized: settle escrow + reputation (unless the CRE workflow is the keeper).
  if (!KEEPER) return;
  const [isFinal, deal, posted, [, passed]] = await Promise.all([
    publicClient.readContract({ ...C.market, functionName: "isFinal", args: [h] }),
    publicClient.readContract({ ...C.escrow, functionName: "getDeal", args: [h] }),
    publicClient.readContract({ ...C.reputation, functionName: "posted", args: [h] }),
    publicClient.readContract({ ...C.registry, functionName: "outcome", args: [h] }),
  ]);

  if (deal.state === DEAL.Funded && (!passed || isFinal)) {
    await once(`settle:${h}`, async () => {
      const s = await settleEscrow(h);
      if (s) log.tx(s.released ? `Escrow.release() ${h.slice(0, 10)}` : `Escrow.refund() ${h.slice(0, 10)}`, s.hash);
    });
  }
  if (isFinal && !posted) {
    await once(`rep:${h}`, async () => {
      const tx = await wallet(operator).writeContract({ ...C.reputation, functionName: "postOutcome", args: [h], chain, account: operator });
      log.tx(`ReputationRegistry.postOutcome() ${h.slice(0, 10)}`, await confirm(tx));
    });
  }
  if (isFinal && posted && deal.state !== DEAL.Funded) done.add(h);
}

async function handleChallenge(id: bigint, now: bigint, arbiter: string) {
  const ch = await publicClient.readContract({ ...C.market, functionName: "getChallenge", args: [id] });
  if (ch.status !== CHALLENGE.Open) return;

  if (now <= ch.reviewDeadline) {
    for (const rv of ch.reviewers) {
      const agent = managed.get(rv.toLowerCase());
      if (!agent) continue;
      const voted = await publicClient.readContract({ ...C.market, functionName: "reviewVote", args: [id, rv] });
      if (voted !== 0) continue;
      await once(`review:${id}:${rv}`, async () => {
        const res = await review(agent.signer, id, { collude: isColluder(rv) });
        log.tx(`${agent.name} review #${id} → ${res.uphold ? "UPHOLD" : "REJECT"}`, res.hash);
      });
      // re-read: the vote may have resolved the challenge
      const cur = await publicClient.readContract({ ...C.market, functionName: "getChallenge", args: [id] });
      if (cur.status !== CHALLENGE.Open) return;
    }
  }

  const arbiterMayAct = ch.reviewers.length === 0 || now > ch.reviewDeadline;
  if (arbiterMayAct && arbiter.toLowerCase() === operator.address.toLowerCase()) {
    await once(`arbiter:${id}`, async () => {
      const res = await arbitrate(id);
      log.tx(`Arbiter resolved #${id} → ${res.uphold ? "UPHOLD" : "REJECT"}`, res.hash);
    });
  }
}

async function tick() {
  const [block, hashes, count, arbiter, window] = await Promise.all([
    publicClient.getBlock(),
    publicClient.readContract({ ...C.registry, functionName: "getRequestHashes", args: [0n, 30n] }),
    publicClient.readContract({ ...C.market, functionName: "challengeCount" }),
    publicClient.readContract({ ...C.market, functionName: "arbiter" }),
    publicClient.readContract({ ...C.market, functionName: "challengeWindow" }),
  ]);
  challengeWindow = window;
  // Anvil only mines on demand, so its head timestamp can lag wall-clock time.
  const wall = BigInt(Math.floor(Date.now() / 1000));
  const now = block.timestamp > wall ? block.timestamp : wall;
  for (const h of hashes) if (!done.has(h)) await handleRequest(h, now);
  for (let id = count; id > 0n && id > count - 20n; id--) await handleChallenge(id, now, arbiter);
}

/**
 * Health endpoint for hosts that need an HTTP port (e.g. a Render web service). Bound before setup so the
 * host sees the port immediately; answers 503 if polling has stalled for 5 minutes so uptime monitors alert.
 */
const health = { status: "starting", startedAt: Date.now(), lastTickAt: 0, lastError: "" };
function serveHealth() {
  const port = Number(env("PORT"));
  if (!port) return;
  createServer((_req, res) => {
    const stale = health.status === "running" && Date.now() - health.lastTickAt > 5 * 60_000;
    res.writeHead(stale ? 503 : 200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ...health, stale, chainId: chain.id, validators: managed.size }));
  }).listen(port, () => log.info(`health endpoint on :${port}`));
}

async function main() {
  log.title(`Talidator validator daemon · ${chain.name}`);
  serveHealth();
  const validators = await getValidatorNetwork();
  for (const v of validators) managed.set(v.address.toLowerCase(), v);
  await ensureSetup(validators);
  log.ok(`Managing ${managed.size} validators: ${validators.map((v) => v.name.replace("Validator ", "")).join(", ")}`);
  log.info(`wallets: ${validators[0]?.signer.kind === "privy" ? "Privy server wallets (policy-bound)" : "mnemonic"} · RPC: ${rpcProvider}`);
  if (colluding.size) log.warn(`Colluding (always PASS, reject challenges): ${[...colluding].join(", ")}`);
  if (auditorEnabled) {
    const challenger = await getChallenger();
    await ensureSetup([challenger]);
    log.ok(`Qwen auditor agent: on · challenges from ${challenger.name} (${challenger.address})`);
  }
  log.info(`relayer / arbiter: ${operator.address}${KEEPER ? " · keeper: on" : " · keeper: off (CRE workflow)"} · polling every ${POLL_MS}ms`);

  health.status = "running";
  for (;;) {
    try {
      await tick();
      health.lastTickAt = Date.now();
    } catch (e) {
      health.lastError = (e as Error).message.split("\n")[0]!;
      log.warn(`poll failed: ${health.lastError}`);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

main();
