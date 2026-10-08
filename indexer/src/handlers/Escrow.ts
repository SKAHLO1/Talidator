import { indexer } from "envio";
import { recordEvent } from "../lib/events";
import { bumpStats, lc, mon, short } from "../lib/util";

const label = async (context: { ValidationRequest: { get: (id: string) => Promise<{ seq: number } | undefined> } }, id: string) => {
  const r = await context.ValidationRequest.get(id);
  return r ? `Trade #${r.seq}` : `Request ${id.slice(0, 10)}`;
};

indexer.onEvent({ contract: "Escrow", event: "Deposited" }, async ({ event, context }) => {
  const id = lc(event.params.requestHash);
  context.EscrowDeal.set({
    id,
    payer: lc(event.params.payer),
    payee: lc(event.params.payee),
    amount: event.params.amount,
    state: "FUNDED",
    fundedAt: event.block.timestamp,
    settledAt: undefined,
    settledTx: undefined,
  });
  await bumpStats(context, (s) => ({ totalEscrowed: s.totalEscrowed + event.params.amount }));
  recordEvent(context, event, {
    kind: "deposit",
    title: "Payment escrowed",
    detail: `${await label(context, id)} · ${mon(event.params.amount)} for ${short(event.params.payee)}`,
    requestHash: id,
    actors: [event.params.payer, event.params.payee],
  });
});

indexer.onEvent({ contract: "Escrow", event: "Released" }, async ({ event, context }) => {
  const id = lc(event.params.requestHash);
  const deal = await context.EscrowDeal.getOrThrow(id);
  context.EscrowDeal.set({ ...deal, state: "RELEASED", settledAt: event.block.timestamp, settledTx: event.transaction.hash });
  await bumpStats(context, (s) => ({ totalReleased: s.totalReleased + event.params.amount }));
  recordEvent(context, event, {
    kind: "payment",
    title: "Payment released",
    detail: `${await label(context, id)} · ${mon(event.params.amount)} to ${short(event.params.payee)}`,
    requestHash: id,
    actors: [event.params.payee, deal.payer],
  });
});

indexer.onEvent({ contract: "Escrow", event: "Refunded" }, async ({ event, context }) => {
  const id = lc(event.params.requestHash);
  const deal = await context.EscrowDeal.getOrThrow(id);
  context.EscrowDeal.set({ ...deal, state: "REFUNDED", settledAt: event.block.timestamp, settledTx: event.transaction.hash });
  await bumpStats(context, (s) => ({ totalRefunded: s.totalRefunded + event.params.amount }));
  recordEvent(context, event, {
    kind: "refund",
    title: "Payment refused",
    detail: `${await label(context, id)} · ${mon(event.params.amount)} refunded`,
    requestHash: id,
    actors: [event.params.payer, deal.payee],
  });
});
