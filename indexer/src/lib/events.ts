import type { ProtocolEvent } from "envio";
import { lc } from "./util";

type EventStore = { ProtocolEvent: { set: (e: ProtocolEvent) => void } };

type LogMeta = {
  logIndex: number;
  block: { number: number; timestamp: number };
  transaction: { hash: string };
};

/** Append one row to the activity feed. `actors` drive per-user feeds and alerts in the app. */
export function recordEvent(
  context: EventStore,
  event: LogMeta,
  row: { kind: string; title: string; detail: string; requestHash?: string; actors?: readonly string[] },
) {
  context.ProtocolEvent.set({
    id: `${event.transaction.hash}-${event.logIndex}`,
    kind: row.kind,
    title: row.title,
    detail: row.detail,
    request_id: row.requestHash ? lc(row.requestHash) : undefined,
    requestHash: row.requestHash ? lc(row.requestHash) : undefined,
    actors: (row.actors ?? []).filter(Boolean).map(lc),
    timestamp: event.block.timestamp,
    blockNumber: event.block.number,
    txHash: event.transaction.hash,
  });
}
