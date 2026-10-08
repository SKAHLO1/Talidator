import { indexer } from "envio";
import { recordEvent } from "../lib/events";
import { bumpStats, lc, mon, short } from "../lib/util";

indexer.onEvent({ contract: "ChallengeMarket", event: "ChallengeOpened" }, async ({ event, context }) => {
  const id = event.params.challengeId.toString();
  const requestId = lc(event.params.requestHash);
  const request = await context.ValidationRequest.getOrThrow(requestId);
  context.Challenge.set({
    id,
    request_id: requestId,
    challenger: lc(event.params.challenger),
    bond: event.params.bond,
    reviewers: event.params.reviewers.map(lc),
    status: "OPEN",
    upholdVotes: 0,
    rejectVotes: 0,
    slashedTotal: 0n,
    challengerPayout: 0n,
    openedAt: event.block.timestamp,
    resolvedAt: undefined,
  });
  context.ValidationRequest.set({ ...request, challenge_id: id });
  await bumpStats(context, (s) => ({ challenges: s.challenges + 1, openChallenges: s.openChallenges + 1 }));
  recordEvent(context, event, {
    kind: "challenge",
    title: "Challenge raised",
    detail: `Trade #${request.seq} · bond ${mon(event.params.bond)} by ${short(event.params.challenger)}`,
    requestHash: requestId,
    actors: [event.params.challenger, request.requester, ...request.validators, ...event.params.reviewers],
  });
});

indexer.onEvent({ contract: "ChallengeMarket", event: "ReviewSubmitted" }, async ({ event, context }) => {
  const id = event.params.challengeId.toString();
  const reviewer = lc(event.params.reviewer);
  const challenge = await context.Challenge.getOrThrow(id);
  const uphold = event.params.uphold;
  context.Review.set({
    id: `${id}-${reviewer}`,
    challenge_id: id,
    reviewer,
    uphold,
    timestamp: event.block.timestamp,
    txHash: event.transaction.hash,
  });
  context.Challenge.set({
    ...challenge,
    upholdVotes: challenge.upholdVotes + (uphold ? 1 : 0),
    rejectVotes: challenge.rejectVotes + (uphold ? 0 : 1),
  });
  const v = await context.Validator.get(reviewer);
  if (v) context.Validator.set({ ...v, reviewsCast: v.reviewsCast + 1 });
});

indexer.onEvent({ contract: "ChallengeMarket", event: "ChallengeResolved" }, async ({ event, context }) => {
  const id = event.params.challengeId.toString();
  const challenge = await context.Challenge.getOrThrow(id);
  const upheld = event.params.upheld;
  context.Challenge.set({
    ...challenge,
    status: upheld ? "UPHELD" : "REJECTED",
    slashedTotal: event.params.slashedTotal,
    challengerPayout: event.params.challengerPayout,
    resolvedAt: event.block.timestamp,
  });
  const request = await context.ValidationRequest.get(challenge.request_id);
  await bumpStats(context, (s) => ({
    openChallenges: Math.max(0, s.openChallenges - 1),
    upheldChallenges: s.upheldChallenges + (upheld ? 1 : 0),
  }));
  recordEvent(context, event, {
    kind: upheld ? "challenge-won" : "challenge-lost",
    title: upheld ? "Challenge successful" : "Challenge rejected",
    detail: upheld
      ? `Trade #${request?.seq ?? "?"} · slashed ${mon(event.params.slashedTotal)}, challenger paid ${mon(event.params.challengerPayout)}`
      : `Trade #${request?.seq ?? "?"} · challenger bond forfeited`,
    requestHash: challenge.request_id,
    actors: [challenge.challenger, request?.requester ?? "", ...(request?.validators ?? [])],
  });
});
