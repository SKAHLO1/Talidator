import { describe, it } from "vitest";
import { createTestIndexer } from "envio";

type Address = `0x${string}`;
const CHAIN = 10143;
const trader: Address = "0x1111111111111111111111111111111111111111";
const liar: Address = "0x2222222222222222222222222222222222222222";
const v: Address[] = ["0xaaaa000000000000000000000000000000000001", "0xaaaa000000000000000000000000000000000002", "0xaaaa000000000000000000000000000000000003"];
const reviewers: Address[] = ["0xbbbb000000000000000000000000000000000001", "0xbbbb000000000000000000000000000000000002", "0xbbbb000000000000000000000000000000000003"];
const challenger: Address = "0xcccc000000000000000000000000000000000001";
const H1 = "0x" + "11".repeat(32);
const H2 = "0x" + "22".repeat(32);
const H3 = "0x" + "33".repeat(32);
const BOND = 150_000_000_000_000_000n; // 0.15
const uri = (name: string) => "data:application/json;base64," + Buffer.from(JSON.stringify({ name })).toString("base64");
const claimUri = (pair: string) =>
  "data:application/json;base64," + Buffer.from(JSON.stringify({ version: 1, pair, side: "long", size: 1.2 })).toString("base64");

const register = (agentId: bigint, wallet: Address, role: bigint, name: string) => [
  { contract: "IdentityRegistry", event: "Registered", params: { agentId, tokenURI: uri(name), owner: wallet } },
  { contract: "IdentityRegistry", event: "AgentRegistered", params: { agentId, role, agentWallet: wallet } },
] as const;

const request = (hash: string, agentId: bigint, requester: Address, pair: string) => [
  { contract: "Escrow", event: "Deposited", params: { requestHash: hash, payer: challenger, payee: requester, amount: 10n ** 16n } },
  {
    contract: "ValidationRegistry", event: "ValidationRequested",
    params: { requestHash: hash, agentId, requester, validators: v, threshold: 2n, requestURI: claimUri(pair), deadline: 9_999_999_999n },
  },
] as const;

const votes = (hash: string, pass: [boolean, boolean, boolean]) =>
  v.map((validator, i) => ({ contract: "ValidationRegistry", event: "VoteSubmitted", params: { requestHash: hash, validator, pass: pass[i]!, evidenceHash: H1 } }) as const);

describe("Talidator indexer — Catch the Liar scenarios", () => {
  it("indexes identities, bonds, quorum results, escrow, challenges, slashing and reputation", async (t) => {
    const indexer = createTestIndexer();
    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            ...register(1n, trader, 1n, "Momentum Trader"),
            ...register(2n, liar, 1n, "Shady Trader (adversarial demo)"),
            ...v.flatMap((w, i) => register(BigInt(3 + i), w, 2n, `Validator ${i}`)),
            ...reviewers.flatMap((w, i) => register(BigInt(6 + i), w, 2n, `Reviewer ${i}`)),
            ...[...v, ...reviewers].map((validator, i) => ({
              contract: "ValidatorStaking", event: "Bonded", params: { validator, agentId: BigInt(3 + i), amount: BOND, total: BOND },
            }) as const),

            // 1 · honest trade passes, payment released
            ...request(H1, 1n, trader, "ETH/USDT"),
            ...votes(H1, [true, true, true]),
            { contract: "ValidationRegistry", event: "ValidationFinalized", params: { requestHash: H1, passed: true, passVotes: 3n, failVotes: 0n } },
            { contract: "Escrow", event: "Released", params: { requestHash: H1, payee: trader, amount: 10n ** 16n } },

            // 2 · the liar fails, payment refused
            ...request(H2, 2n, liar, "SOL/USDC"),
            ...votes(H2, [false, false, false]),
            { contract: "ValidationRegistry", event: "ValidationFinalized", params: { requestHash: H2, passed: false, passVotes: 0n, failVotes: 3n } },
            { contract: "Escrow", event: "Refunded", params: { requestHash: H2, payer: challenger, amount: 10n ** 16n } },

            // 3+4 · two validators collude, a challenge overturns the result and slashes them
            ...request(H3, 2n, liar, "BTC/USDT"),
            ...votes(H3, [true, true, false]),
            { contract: "ValidationRegistry", event: "ValidationFinalized", params: { requestHash: H3, passed: true, passVotes: 2n, failVotes: 1n } },
            { contract: "ChallengeMarket", event: "ChallengeOpened", params: { challengeId: 1n, requestHash: H3, challenger, bond: 5n * 10n ** 16n, reviewers } },
            { contract: "ChallengeMarket", event: "ReviewSubmitted", params: { challengeId: 1n, reviewer: reviewers[0]!, uphold: true } },
            { contract: "ChallengeMarket", event: "ReviewSubmitted", params: { challengeId: 1n, reviewer: reviewers[1]!, uphold: true } },
            { contract: "ValidationRegistry", event: "ResultOverturned", params: { requestHash: H3, passed: false } },
            { contract: "ValidatorStaking", event: "Slashed", params: { validator: v[0]!, amount: 45_000_000_000_000_000n, recipient: challenger } },
            { contract: "ValidatorStaking", event: "Slashed", params: { validator: v[1]!, amount: 45_000_000_000_000_000n, recipient: challenger } },
            { contract: "ChallengeMarket", event: "ChallengeResolved", params: { challengeId: 1n, requestHash: H3, upheld: true, slashedTotal: 9n * 10n ** 16n, challengerPayout: 45_000_000_000_000_000n } },

            // reputation from final outcomes
            { contract: "ReputationRegistry", event: "NewFeedback", params: { agentId: 1n, requestHash: H1, score: 100n, passed: true } },
            { contract: "ReputationRegistry", event: "NewFeedback", params: { agentId: 2n, requestHash: H2, score: 0n, passed: false } },
          ],
        },
      },
    });

    // Identities
    const traderAgent = await indexer.Agent.getOrThrow("1");
    t.expect(traderAgent.name).toBe("Momentum Trader");
    t.expect(traderAgent.role).toBe("TRADER");
    t.expect(traderAgent.wallet).toBe(trader);
    t.expect(traderAgent.reputationScore).toBe(10000);
    t.expect((await indexer.Agent.getOrThrow("2")).reputationScore).toBe(0);
    t.expect((await indexer.Agent.getOrThrow("3")).role).toBe("VALIDATOR");

    // Requests carry claim details, sequence numbers and outcomes
    const r1 = await indexer.ValidationRequest.getOrThrow(H1);
    t.expect([r1.seq, r1.status, r1.passed, r1.pair, r1.reputationPosted, r1.escrow_id]).toEqual([1, "PASSED", true, "ETH/USDT", true, H1]);
    const r3 = await indexer.ValidationRequest.getOrThrow(H3);
    t.expect([r3.seq, r3.status, r3.overturned, r3.passed, r3.challenge_id]).toEqual([3, "PASSED", true, false, "1"]);

    // Escrow lifecycle
    t.expect((await indexer.EscrowDeal.getOrThrow(H1)).state).toBe("RELEASED");
    t.expect((await indexer.EscrowDeal.getOrThrow(H2)).state).toBe("REFUNDED");
    t.expect((await indexer.EscrowDeal.getOrThrow(H3)).state).toBe("FUNDED");

    // Validator aggregates: colluders lose agreement credit and get slashed; the dissenter is vindicated.
    const colluder = await indexer.Validator.getOrThrow(v[0]!);
    t.expect([colluder.votesCast, colluder.votesAgreed, colluder.votesOverturned, colluder.slashCount, colluder.bonded])
      .toEqual([3, 2, 1, 1, BOND - 45_000_000_000_000_000n]);
    const dissenter = await indexer.Validator.getOrThrow(v[2]!);
    t.expect([dissenter.votesCast, dissenter.votesAgreed, dissenter.votesOverturned, dissenter.slashCount]).toEqual([3, 3, 0, 0]);
    t.expect((await indexer.Validator.getOrThrow(reviewers[0]!)).reviewsCast).toBe(1);

    // Challenge
    const ch = await indexer.Challenge.getOrThrow("1");
    t.expect([ch.status, ch.upholdVotes, ch.slashedTotal]).toEqual(["UPHELD", 2, 9n * 10n ** 16n]);

    // Network aggregates
    const s = await indexer.ProtocolStats.getOrThrow("global");
    t.expect({
      agents: s.agents, validators: s.validators, activeValidators: s.activeValidators, requests: s.requests,
      passed: s.passed, failed: s.failed, overturned: s.overturned, challenges: s.challenges,
      openChallenges: s.openChallenges, upheldChallenges: s.upheldChallenges, totalSlashed: s.totalSlashed,
    }).toEqual({
      agents: 8, validators: 6, activeValidators: 6, requests: 3,
      passed: 1, failed: 2, overturned: 1, challenges: 1,
      openChallenges: 0, upheldChallenges: 1, totalSlashed: 9n * 10n ** 16n,
    });
  });
});
