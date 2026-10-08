import type { ProtocolStats } from "envio";

export const lc = (a: string) => a.toLowerCase();

/** Stable id for a log: `${txHash}-${logIndex}`. */
export const logId = (event: { transaction: { hash: string }; logIndex: number }) => `${event.transaction.hash}-${event.logIndex}`;

export const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** wei → "0.1500 MON" for human-readable activity rows (exact amounts stay in BigInt fields). */
export const mon = (wei: bigint) => `${(Number(wei) / 1e18).toFixed(4).replace(/\.?0+$/, "") || "0"} MON`;

const PREFIX = "data:application/json;base64,";

/** Decode a `data:application/json;base64,…` URI (agent tokenURIs and Talidator trade claims). */
export function decodeDataUri(uri: string): Record<string, unknown> | null {
  try {
    if (uri.startsWith(PREFIX)) return JSON.parse(Buffer.from(uri.slice(PREFIX.length), "base64").toString("utf8"));
    if (uri.startsWith("data:application/json,")) return JSON.parse(decodeURIComponent(uri.slice(22)));
  } catch {
    /* not a data URI we understand */
  }
  return null;
}

export const EMPTY_STATS: ProtocolStats = {
  id: "global",
  agents: 0,
  validators: 0,
  activeValidators: 0,
  requests: 0,
  passed: 0,
  failed: 0,
  overturned: 0,
  challenges: 0,
  openChallenges: 0,
  upheldChallenges: 0,
  totalBonded: 0n,
  totalSlashed: 0n,
  totalEscrowed: 0n,
  totalReleased: 0n,
  totalRefunded: 0n,
};

type StatsStore = {
  ProtocolStats: {
    getOrCreate: (e: ProtocolStats) => Promise<ProtocolStats>;
    set: (e: ProtocolStats) => void;
  };
};

/** Read-modify-write the single global stats row. */
export async function bumpStats(context: StatsStore, patch: (s: ProtocolStats) => Partial<ProtocolStats>) {
  const stats = await context.ProtocolStats.getOrCreate(EMPTY_STATS);
  context.ProtocolStats.set({ ...stats, ...patch(stats) });
}

export const ROLE_NAMES = { 1: "TRADER", 2: "VALIDATOR", 3: "CHALLENGER" } as const;
