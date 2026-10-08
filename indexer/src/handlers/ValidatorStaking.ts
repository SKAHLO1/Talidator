import { indexer, type Validator } from "envio";
import { recordEvent } from "../lib/events";
import { bumpStats, lc, logId, mon, short } from "../lib/util";

const fresh = (id: string, agentId: bigint, at: number): Validator => ({
  id,
  agentId,
  bonded: 0n,
  totalBonded: 0n,
  slashed: 0n,
  slashCount: 0,
  status: "ACTIVE",
  unbondAt: undefined,
  votesCast: 0,
  votesPass: 0,
  votesFail: 0,
  votesAgreed: 0,
  votesOverturned: 0,
  reviewsCast: 0,
  firstBondedAt: at,
});

indexer.onEvent({ contract: "ValidatorStaking", event: "Bonded" }, async ({ event, context }) => {
  const id = lc(event.params.validator);
  const existing = await context.Validator.get(id);
  const v = existing ?? fresh(id, event.params.agentId, event.block.timestamp);
  const wasActive = existing?.status === "ACTIVE";
  context.Validator.set({
    ...v,
    bonded: event.params.total,
    totalBonded: v.totalBonded + event.params.amount,
    status: "ACTIVE",
    unbondAt: undefined,
  });
  await bumpStats(context, (s) => ({
    validators: s.validators + (existing ? 0 : 1),
    activeValidators: s.activeValidators + (wasActive ? 0 : 1),
    totalBonded: s.totalBonded + event.params.amount,
  }));
  recordEvent(context, event, {
    kind: "bonded",
    title: existing ? "Bond topped up" : "Validator bonded",
    detail: `${short(event.params.validator)} · ${mon(event.params.total)} bonded`,
    actors: [event.params.validator],
  });
});

indexer.onEvent({ contract: "ValidatorStaking", event: "UnbondingStarted" }, async ({ event, context }) => {
  const v = await context.Validator.getOrThrow(lc(event.params.validator));
  context.Validator.set({ ...v, status: "UNBONDING", unbondAt: Number(event.params.unlockAt) });
  await bumpStats(context, (s) => ({ activeValidators: Math.max(0, s.activeValidators - 1) }));
  recordEvent(context, event, {
    kind: "unbonding",
    title: "Validator unbonding",
    detail: `${short(event.params.validator)} unlocks at ${new Date(Number(event.params.unlockAt) * 1000).toISOString()}`,
    actors: [event.params.validator],
  });
});

indexer.onEvent({ contract: "ValidatorStaking", event: "Withdrawn" }, async ({ event, context }) => {
  const v = await context.Validator.getOrThrow(lc(event.params.validator));
  context.Validator.set({ ...v, status: "WITHDRAWN", bonded: 0n, unbondAt: undefined });
  await bumpStats(context, (s) => ({ totalBonded: s.totalBonded - event.params.amount }));
});

indexer.onEvent({ contract: "ValidatorStaking", event: "Slashed" }, async ({ event, context }) => {
  const id = lc(event.params.validator);
  const v = await context.Validator.getOrThrow(id);
  context.Validator.set({ ...v, bonded: v.bonded - event.params.amount, slashed: v.slashed + event.params.amount, slashCount: v.slashCount + 1 });
  context.Slash.set({
    id: logId(event),
    validator_id: id,
    amount: event.params.amount,
    recipient: lc(event.params.recipient),
    timestamp: event.block.timestamp,
    txHash: event.transaction.hash,
  });
  await bumpStats(context, (s) => ({ totalSlashed: s.totalSlashed + event.params.amount, totalBonded: s.totalBonded - event.params.amount }));
  recordEvent(context, event, {
    kind: "slashed",
    title: "Validator slashed",
    detail: `${short(event.params.validator)} · ${mon(event.params.amount)}`,
    actors: [event.params.validator],
  });
});
