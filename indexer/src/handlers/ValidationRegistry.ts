import { indexer, type EvmOnEventContext } from "envio";
import { recordEvent } from "../lib/events";
import { bumpStats, decodeDataUri, lc, short } from "../lib/util";

const tradeLabel = (seq: number) => `Trade #${seq}`;

indexer.onEvent({ contract: "ValidationRegistry", event: "ValidationRequested" }, async ({ event, context }) => {
  const id = lc(event.params.requestHash);
  const stats = await context.ProtocolStats.get("global");
  const seq = (stats?.requests ?? 0) + 1;
  const claim = decodeDataUri(event.params.requestURI);
  const agent = await context.Agent.get(event.params.agentId.toString());

  context.ValidationRequest.set({
    id,
    seq,
    agent_id: agent ? agent.id : undefined,
    agentId: event.params.agentId,
    requester: lc(event.params.requester),
    validators: event.params.validators.map(lc),
    threshold: Number(event.params.threshold),
    requestURI: event.params.requestURI,
    pair: typeof claim?.pair === "string" ? claim.pair : undefined,
    side: typeof claim?.side === "string" ? claim.side : undefined,
    size: typeof claim?.size === "number" ? claim.size : undefined,
    deadline: Number(event.params.deadline),
    status: "PENDING",
    passVotes: 0,
    failVotes: 0,
    overturned: false,
    passed: undefined,
    createdAt: event.block.timestamp,
    createdTx: event.transaction.hash,
    finalizedAt: undefined,
    // Escrow.deposit() is keyed by the same hash and may have happened first.
    escrow_id: id,
    challenge_id: undefined,
    reputationPosted: false,
  });
  await bumpStats(context, (s) => ({ requests: s.requests + 1 }));
  recordEvent(context, event, {
    kind: "request",
    title: "Validation requested",
    detail: `${tradeLabel(seq)} · ${claim?.pair ?? "custom task"} · ${agent?.name ?? short(event.params.requester)}`,
    requestHash: id,
    actors: [event.params.requester, agent?.wallet ?? "", agent?.owner ?? "", ...event.params.validators],
  });
});

indexer.onEvent({ contract: "ValidationRegistry", event: "VoteSubmitted" }, async ({ event, context }) => {
  const requestId = lc(event.params.requestHash);
  const validatorId = lc(event.params.validator);
  const request = await context.ValidationRequest.getOrThrow(requestId);
  const pass = event.params.pass;

  context.Vote.set({
    id: `${requestId}-${validatorId}`,
    request_id: requestId,
    validator_id: validatorId,
    pass,
    evidenceHash: event.params.evidenceHash,
    timestamp: event.block.timestamp,
    txHash: event.transaction.hash,
  });
  context.ValidationRequest.set({
    ...request,
    status: "IN_PROGRESS",
    passVotes: request.passVotes + (pass ? 1 : 0),
    failVotes: request.failVotes + (pass ? 0 : 1),
  });
  const v = await context.Validator.get(validatorId);
  if (v) {
    context.Validator.set({ ...v, votesCast: v.votesCast + 1, votesPass: v.votesPass + (pass ? 1 : 0), votesFail: v.votesFail + (pass ? 0 : 1) });
  }
  recordEvent(context, event, {
    kind: "vote",
    title: `Vote cast: ${pass ? "PASS" : "FAIL"}`,
    detail: `${tradeLabel(request.seq)} · ${short(event.params.validator)}`,
    requestHash: requestId,
    actors: [event.params.validator],
  });
});

/** Credit or debit each validator's agreement with the given outcome. */
async function scoreVotes(
  context: EvmOnEventContext,
  requestId: string,
  outcomePass: boolean,
  mode: "finalize" | "overturn",
) {
  const votes = await context.Vote.getWhere({ request_id: { _eq: requestId } });
  for (const vote of votes) {
    const v = await context.Validator.get(vote.validator_id);
    if (!v) continue;
    if (mode === "finalize") {
      if (vote.pass === outcomePass) context.Validator.set({ ...v, votesAgreed: v.votesAgreed + 1 });
    } else if (vote.pass === outcomePass) {
      // The new (overturned) outcome: these validators were right after all.
      context.Validator.set({ ...v, votesAgreed: v.votesAgreed + 1 });
    } else {
      context.Validator.set({ ...v, votesAgreed: Math.max(0, v.votesAgreed - 1), votesOverturned: v.votesOverturned + 1 });
    }
  }
}

indexer.onEvent({ contract: "ValidationRegistry", event: "ValidationFinalized" }, async ({ event, context }) => {
  const id = lc(event.params.requestHash);
  const request = await context.ValidationRequest.getOrThrow(id);
  const passed = event.params.passed;
  context.ValidationRequest.set({
    ...request,
    status: passed ? "PASSED" : "FAILED",
    passed,
    passVotes: Number(event.params.passVotes),
    failVotes: Number(event.params.failVotes),
    finalizedAt: event.block.timestamp,
  });
  await scoreVotes(context, id, passed, "finalize");
  await bumpStats(context, (s) => (passed ? { passed: s.passed + 1 } : { failed: s.failed + 1 }));
  recordEvent(context, event, {
    kind: passed ? "validated" : "rejected",
    title: passed ? "Validation completed" : "Validation failed",
    detail: `${tradeLabel(request.seq)} · ${event.params.passVotes}/${Number(event.params.passVotes) + Number(event.params.failVotes)} pass`,
    requestHash: id,
    actors: [request.requester, ...request.validators],
  });
});

indexer.onEvent({ contract: "ValidationRegistry", event: "ResultOverturned" }, async ({ event, context }) => {
  const id = lc(event.params.requestHash);
  const request = await context.ValidationRequest.getOrThrow(id);
  context.ValidationRequest.set({ ...request, overturned: true, passed: event.params.passed });
  await scoreVotes(context, id, event.params.passed, "overturn");
  await bumpStats(context, (s) => ({
    overturned: s.overturned + 1,
    // Move the request between the passed/failed buckets.
    passed: s.passed + (event.params.passed ? 1 : -1),
    failed: s.failed + (event.params.passed ? -1 : 1),
  }));
  recordEvent(context, event, {
    kind: "overturned",
    title: "Result overturned",
    detail: `${tradeLabel(request.seq)} · now ${event.params.passed ? "PASS" : "FAIL"}`,
    requestHash: id,
    actors: [request.requester, ...request.validators],
  });
});
