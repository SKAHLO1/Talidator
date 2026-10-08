import type { Hex } from "viem";
import { evaluate } from "../../../src/lib/chain/claims";
import { C, chain, confirm, operator, publicClient, wallet } from "./clients";
import { call, type AgentSigner } from "./signer";

const STATUS = { None: 0, Pending: 1, Passed: 2, Failed: 3 } as const;
const CHALLENGE = { None: 0, Open: 1, Upheld: 2, Rejected: 3 } as const;
const DEAL = { None: 0, Funded: 1, Released: 2, Refunded: 3 } as const;

export { STATUS, CHALLENGE, DEAL };

/**
 * A validator re-executes the claim behind `requestHash`, signs its vote (EIP-712) and hands it to the
 * relayer, which submits it on-chain via `submitVoteBySig` — validators never need to hold gas for voting.
 * `collude` forces a PASS regardless of the evidence (the staged dishonest validator from the PRD).
 */
export async function castVote(validator: AgentSigner, requestHash: Hex, opts: { collude?: boolean } = {}) {
  const req = await publicClient.readContract({ ...C.registry, functionName: "getRequest", args: [requestHash] });
  const ev = await evaluate(publicClient, req.requestURI, requestHash);
  const pass = opts.collude ? true : ev.pass;

  const signature = await validator.signTypedData({
    domain: { name: "Talidator ValidationRegistry", version: "1", chainId: chain.id, verifyingContract: C.registry.address },
    types: { Vote: [{ name: "requestHash", type: "bytes32" }, { name: "pass", type: "bool" }, { name: "evidenceHash", type: "bytes32" }] },
    primaryType: "Vote",
    message: { requestHash, pass, evidenceHash: ev.evidenceHash },
  });

  const hash = await wallet(operator).writeContract({
    ...C.registry,
    functionName: "submitVoteBySig",
    args: [requestHash, validator.address, pass, ev.evidenceHash, signature],
    chain,
    account: operator,
  });
  await confirm(hash);
  return { hash, pass, reason: opts.collude ? "colluding: voted PASS regardless of evidence" : ev.reason };
}

/** A fresh-quorum reviewer independently re-executes the original claim. Uphold iff the original result was wrong. */
export async function review(reviewer: AgentSigner, challengeId: bigint, opts: { collude?: boolean } = {}) {
  const ch = await publicClient.readContract({ ...C.market, functionName: "getChallenge", args: [challengeId] });
  const req = await publicClient.readContract({ ...C.registry, functionName: "getRequest", args: [ch.requestHash] });
  const ev = await evaluate(publicClient, req.requestURI, ch.requestHash);
  const uphold = opts.collude ? false : ev.pass !== ch.originalPassed;
  const hash = await call(reviewer, C.market, "submitReview", [challengeId, uphold]);
  return { hash, uphold, reason: ev.reason };
}

/** Arbiter fallback (operator is the arbiter by default): decide by re-execution. */
export async function arbitrate(challengeId: bigint) {
  const ch = await publicClient.readContract({ ...C.market, functionName: "getChallenge", args: [challengeId] });
  const req = await publicClient.readContract({ ...C.registry, functionName: "getRequest", args: [ch.requestHash] });
  const uphold = (await evaluate(publicClient, req.requestURI, ch.requestHash)).pass !== ch.originalPassed;
  const hash = await wallet(operator).writeContract({
    ...C.market, functionName: "resolveByArbiter", args: [challengeId, uphold], chain, account: operator,
  });
  await confirm(hash);
  return { hash, uphold };
}

/** Keeper: settle escrow once a result exists (release on pass, refund on fail). Returns null if nothing to do. */
export async function settleEscrow(requestHash: Hex) {
  const deal = await publicClient.readContract({ ...C.escrow, functionName: "getDeal", args: [requestHash] });
  if (deal.state !== DEAL.Funded) return null;
  const [finalized, passed] = await publicClient.readContract({ ...C.registry, functionName: "outcome", args: [requestHash] });
  if (!finalized) return null;
  const hash = await wallet(operator).writeContract({
    ...C.escrow, functionName: passed ? "release" : "refund", args: [requestHash], chain, account: operator,
  });
  await confirm(hash);
  return { hash, released: passed, amount: deal.amount };
}
