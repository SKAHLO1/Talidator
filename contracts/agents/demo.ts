/**
 * "Catch the Liar" — the PRD's live demo, run end-to-end against real contracts.
 *
 * Trades are built from and re-executed against live Chainlink Data Feed rounds on Monad testnet, so a plain
 * local anvil chain (no feeds) can't run it — use Monad testnet or an anvil fork of it.
 *
 *   npm run demo:monad     (Monad testnet; needs MNEMONIC + funded operator in contracts/.env;
 *                           with PRIVY_APP_ID/SECRET the validators + challenger use Privy server wallets)
 *
 * Moments:
 *   1. Honest trader  → quorum PASS → escrow releases payment
 *   2. Liar trader    → quorum FAIL → payment refused (refunded to client)
 *   3. Colluding validators pass a fabricated trade → challenger stakes a bond
 *   4. Fresh quorum upholds the challenge → colluders slashed, challenger paid from the slashed stake
 */
import { parseEther, type Hex } from "viem";
import { encodeClaim, describeClaim } from "../../src/lib/chain/claims";
import { fabricatedClaim, honestClaim, type TradeClaim } from "../../src/lib/chain/market";
import { agentId, allAgents, ensureSetup, getAgents, nameOf, type AgentAccount, type Agents } from "./lib/agents";
import { C, chain, confirm, fmt, operator, publicClient, rpcProvider, wallet } from "./lib/clients";
import { env } from "./lib/env";
import { log } from "./lib/log";
import { call } from "./lib/signer";
import { castVote, review, settleEscrow, CHALLENGE } from "./lib/validator";

const PAYMENT = parseEther(env("DEMO_PAYMENT") ?? "0.01");
const seed = Math.floor(Date.now() / 1000);

async function request(agents: Agents, trader: AgentAccount, claim: TradeClaim, validatorIdx: number[]) {
  const { uri, requestHash } = encodeClaim(claim);
  const d = describeClaim(claim);
  const set = validatorIdx.map((i) => agents.validators[i]!.address);
  log.step(`${trader.name} claims: ${claim.pair} ${claim.side} ${claim.size} · entry ${claim.entryPrice} (round ${claim.entryRound}) → exit ${claim.exitPrice} (round ${claim.exitRound}) · PnL ${claim.reportedPnl}`);
  log.info(`requestHash ${requestHash}`);

  const dep = await wallet(operator).writeContract({
    ...C.escrow, functionName: "deposit", args: [requestHash, trader.address], value: PAYMENT, chain, account: operator,
  });
  log.tx(`Escrow.deposit(${fmt(PAYMENT)})`, await confirm(dep));

  const id = await agentId(trader.address);
  log.tx(`validationRequest() · ${d.asset}/${d.quote}`, await call(trader.signer, C.registry, "validationRequest", [set, id, uri, requestHash]));
  return requestHash;
}

async function vote(agents: Agents, requestHash: Hex, validatorIdx: number[], colluders: number[] = []) {
  for (const i of validatorIdx) {
    const v = agents.validators[i]!;
    const r = await castVote(v.signer, requestHash, { collude: colluders.includes(i) });
    log.tx(`${v.name} → ${r.pass ? "PASS" : "FAIL"}`, r.hash);
    log.info(r.reason);
  }
  const [, passed] = await publicClient.readContract({ ...C.registry, functionName: "outcome", args: [requestHash] });
  (passed ? log.ok : log.bad)(`Quorum result: ${passed ? "PASSED" : "FAILED"}`);
  return passed;
}

async function settle(requestHash: Hex) {
  const s = await settleEscrow(requestHash);
  if (!s) return;
  if (s.released) log.tx(`Escrow.release() → trader paid ${fmt(s.amount)}`, s.hash);
  else log.tx(`Escrow.refund() → payment refused`, s.hash);
}

async function main() {
  log.title(`Talidator demo on ${chain.name} (chain ${chain.id})`);
  const agents = await getAgents();
  log.info(`RPC: ${rpcProvider} · validator wallets: ${agents.validators[0]!.signer.kind === "privy" ? "Privy server wallets (policy-bound)" : "mnemonic"}`);
  log.step("Ensuring agent identities and validator bonds…");
  await ensureSetup(allAgents(agents));
  log.ok("Agents ready");
  const traderId = await agentId(agents.trader.address);
  const liarId = await agentId(agents.liar.address);

  log.title("1 · Honest trader — payment released");
  const h1 = await request(agents, agents.trader, await honestClaim(publicClient, traderId, "ETH/USD", 1.2, seed, `${seed}-1`), [0, 1, 2]);
  await vote(agents, h1, [0, 1, 2]);
  await settle(h1);

  log.title("2 · Catch the liar — fabricated result refused");
  const h2 = await request(agents, agents.liar, await fabricatedClaim(publicClient, liarId, "LINK/USD", 50, seed + 1, `${seed}-2`), [0, 1, 2]);
  await vote(agents, h2, [0, 1, 2]);
  await settle(h2);

  log.title("3 · Colluding validators pass a lie");
  const h3 = await request(agents, agents.liar, await fabricatedClaim(publicClient, liarId, "BTC/USD", 0.05, seed + 2, `${seed}-3`), [0, 1, 2]);
  await vote(agents, h3, [0, 1, 2], [0, 1]);
  log.warn("Escrow deliberately left unsettled — we dispute the result first.");

  log.title("4 · Challenge market — colluders slashed");
  const bond = await publicClient.readContract({ ...C.market, functionName: "challengeBond" });
  const colluders = [agents.validators[0]!, agents.validators[1]!];
  const stakesBefore = await Promise.all(colluders.map((v) => publicClient.readContract({ ...C.staking, functionName: "getStake", args: [v.address] })));
  const chBalBefore = await publicClient.getBalance({ address: agents.challenger.address });

  const chTx = await call(agents.challenger.signer, C.market, "challenge", [h3], bond);
  const receipt = await publicClient.getTransactionReceipt({ hash: chTx });
  log.tx(`ChallengeMarket.challenge(bond ${fmt(bond)})`, chTx);
  const id = await publicClient.readContract({ ...C.market, functionName: "challengeOf", args: [h3] });
  const ch = await publicClient.readContract({ ...C.market, functionName: "getChallenge", args: [id] });
  log.info(`fresh quorum: ${ch.reviewers.map((r) => nameOf(agents.validators, r)).join(", ")}`);

  for (const r of ch.reviewers) {
    const cur = await publicClient.readContract({ ...C.market, functionName: "getChallenge", args: [id] });
    if (cur.status !== CHALLENGE.Open) break;
    const reviewer = agents.validators.find((v) => v.address.toLowerCase() === r.toLowerCase());
    if (!reviewer) continue;
    const res = await review(reviewer.signer, id);
    log.tx(`${reviewer.name} review → ${res.uphold ? "UPHOLD" : "REJECT"}`, res.hash);
  }

  const done = await publicClient.readContract({ ...C.market, functionName: "getChallenge", args: [id] });
  if (done.status === CHALLENGE.Upheld) {
    log.ok(`Challenge upheld · slashed ${fmt(done.slashedTotal)} · challenger cut ${fmt(done.challengerPayout)}`);
    for (const [k, v] of colluders.entries()) {
      const after = await publicClient.readContract({ ...C.staking, functionName: "getStake", args: [v.address] });
      log.info(`${v.name}: ${fmt(stakesBefore[k]!.amount)} → ${fmt(after.amount)}`);
    }
    const chBalAfter = await publicClient.getBalance({ address: agents.challenger.address });
    const gasCost = receipt.gasUsed * receipt.effectiveGasPrice;
    log.info(`Challenger net: +${fmt(chBalAfter - chBalBefore + gasCost)} (bond returned + cut, before gas)`);
  } else {
    log.bad(`Challenge status ${done.status} — expected Upheld`);
  }
  await settle(h3); // now overturned → client refunded

  log.title("Done");
  log.ok("All four demo moments completed on-chain. Open the dashboard to see them.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
