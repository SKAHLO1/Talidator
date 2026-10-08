/**
 * Live market data (Chainlink Data Feeds on Monad testnet) + trade re-execution.
 *
 * The PRD requires re-execution to be deterministic: every validator must reach the same pass/fail from
 * the same inputs. A claim therefore pins the exact Chainlink feed rounds it traded on. Historical rounds are
 * immutable on-chain, so every validator reading `getRoundData` over any Monad RPC sees identical prices.
 * The check is purely rules-based:
 *
 *   1. entry + exit rounds exist on the pair's feed (same phase, exit after entry, timestamps match)
 *   2. claimed fills lie within ± slippage of each round's answer
 *   3. the strategy signal held: `momentum-v1` goes long only after an up-tick (entry round > previous round),
 *      short only after a down-tick
 *   4. reported PnL equals the PnL recomputed from the claimed fills
 *
 * Shared by the Next.js app and the off-chain agents (relative imports only).
 */
import type { Address } from "viem";

export type Pair = "ETH/USD" | "BTC/USD" | "LINK/USD";
export type Side = "long" | "short";

export interface FeedRound {
  roundId: string;
  price: number;
  updatedAt: number;
}

export interface TradeClaim {
  version: 2;
  agentId: string;
  pair: Pair;
  side: Side;
  size: number;
  strategy: "momentum-v1";
  /** Chainlink aggregator proxy the rounds belong to */
  feed: Address;
  entryRound: string;
  entryTime: number;
  entryPrice: number;
  exitRound: string;
  exitTime: number;
  exitPrice: number;
  reportedPnl: number;
  nonce: string;
}

export interface ReexecutionResult {
  pass: boolean;
  checks: { roundsExist: boolean; entryInRange: boolean; exitInRange: boolean; signalValid: boolean; pnlMatches: boolean };
  entry: FeedRound | null;
  exit: FeedRound | null;
  recomputedPnl: number | null;
  reason: string;
}

/** Chainlink Data Feeds (aggregator proxies) on Monad testnet — https://docs.chain.link/data-feeds/price-feeds/addresses?network=monad */
export const FEEDS: Record<Pair, Address> = {
  "ETH/USD": "0x5c8c8482f064049248F86D9F4aFa4B1f2F5b6d31",
  "BTC/USD": "0x12C0F44368a02081ce58a936d1C1F606BB301715",
  "LINK/USD": "0x2A9FBFbf392594c4Dd7593C8a91cdEbc02e5b884",
};
export const PAIRS = Object.keys(FEEDS) as Pair[];
export const FEED_DECIMALS = 8;
export const SLIPPAGE = 0.001; // 0.1%

const aggregatorAbi = [
  {
    type: "function", name: "getRoundData", stateMutability: "view",
    inputs: [{ name: "_roundId", type: "uint80" }],
    outputs: [
      { name: "roundId", type: "uint80" }, { name: "answer", type: "int256" }, { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" }, { name: "answeredInRound", type: "uint80" },
    ],
  },
  {
    type: "function", name: "latestRoundData", stateMutability: "view", inputs: [],
    outputs: [
      { name: "roundId", type: "uint80" }, { name: "answer", type: "int256" }, { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" }, { name: "answeredInRound", type: "uint80" },
    ],
  },
] as const;

/**
 * Anything that can do a viem-style `readContract` (the app's and the agents' public clients come from
 * different viem copies, so this is structural).
 */
export interface ChainReader {
  readContract(args: { address: Address; abi: typeof aggregatorAbi; functionName: "getRoundData" | "latestRoundData"; args?: readonly [bigint] }): Promise<unknown>;
}

const round = (x: number, dp = 6) => Math.round(x * 10 ** dp) / 10 ** dp;
const PHASE_SHIFT = 64n;
const phaseOf = (id: bigint) => id >> PHASE_SHIFT;
const aggRoundOf = (id: bigint) => id & ((1n << PHASE_SHIFT) - 1n);

function toRound(raw: unknown): FeedRound | null {
  const [roundId, answer, , updatedAt] = raw as readonly [bigint, bigint, bigint, bigint, bigint];
  if (updatedAt === 0n || answer <= 0n) return null;
  return { roundId: roundId.toString(), price: Number(answer) / 10 ** FEED_DECIMALS, updatedAt: Number(updatedAt) };
}

/** True only for an on-chain revert — never for transport errors (rate limits, timeouts), which must not become a FAIL vote. */
function isRevert(e: unknown) {
  for (let x = e as { name?: string; message?: string; details?: string; cause?: unknown } | undefined; x; x = x.cause as typeof x) {
    if (x.name === "ContractFunctionRevertedError" || /revert|No data present/i.test(`${x.details ?? ""} ${x.message ?? ""}`)) return true;
  }
  return false;
}

/** One historical round (null if it doesn't exist on the feed). Throws on RPC errors. */
export async function getRound(client: ChainReader, pair: Pair, roundId: bigint): Promise<FeedRound | null> {
  try {
    return toRound(await client.readContract({ address: FEEDS[pair], abi: aggregatorAbi, functionName: "getRoundData", args: [roundId] }));
  } catch (e) {
    if (isRevert(e)) return null; // aggregators revert for unknown rounds
    throw e;
  }
}

export async function latestRound(client: ChainReader, pair: Pair): Promise<FeedRound> {
  const r = toRound(await client.readContract({ address: FEEDS[pair], abi: aggregatorAbi, functionName: "latestRoundData" }));
  if (!r) throw new Error(`${pair} feed has no data`);
  return r;
}

/** Up to `limit` consecutive rounds ending at `toRound` (default: latest), oldest first. Stays within one phase. */
export async function recentRounds(client: ChainReader, pair: Pair, limit = 10, toRoundId?: bigint): Promise<FeedRound[]> {
  const end = toRoundId ?? BigInt((await latestRound(client, pair)).roundId);
  const n = BigInt(Math.max(1, Math.min(30, limit)));
  const first = aggRoundOf(end) > n ? end - n + 1n : end - aggRoundOf(end) + 1n;
  const ids: bigint[] = [];
  for (let id = first; id <= end; id++) ids.push(id);
  return (await Promise.all(ids.map((id) => getRound(client, pair, id)))).filter((r): r is FeedRound => !!r);
}

const within = (price: number, r: FeedRound) => Math.abs(price - r.price) <= r.price * SLIPPAGE;

export const pnlOf = (side: Side, size: number, entry: number, exit: number) =>
  round((side === "long" ? exit - entry : entry - exit) * size, 4);

const isPair = (p: unknown): p is Pair => typeof p === "string" && p in FEEDS;

/** Re-execute a trader's claim against the live Chainlink feed on Monad testnet. */
export async function reexecute(client: ChainReader, claim: TradeClaim): Promise<ReexecutionResult> {
  const fail = (reason: string): ReexecutionResult => ({
    pass: false, reason, entry: null, exit: null, recomputedPnl: null,
    checks: { roundsExist: false, entryInRange: false, exitInRange: false, signalValid: false, pnlMatches: false },
  });
  if (claim.version !== 2 || !isPair(claim.pair)) return fail("failed: unsupported claim version or pair");
  if (claim.feed?.toLowerCase() !== FEEDS[claim.pair].toLowerCase()) return fail("failed: claim does not reference the pair's Chainlink feed");

  let entryId: bigint, exitId: bigint;
  try {
    entryId = BigInt(claim.entryRound);
    exitId = BigInt(claim.exitRound);
  } catch {
    return fail("failed: malformed round ids");
  }

  const samePhase = phaseOf(entryId) === phaseOf(exitId);
  const prevId = aggRoundOf(entryId) > 1n ? entryId - 1n : null;
  const [entry, exit, prev] = await Promise.all([
    getRound(client, claim.pair, entryId),
    getRound(client, claim.pair, exitId),
    prevId !== null ? getRound(client, claim.pair, prevId) : Promise.resolve(null),
  ]);

  const roundsExist = !!entry && !!exit && samePhase && exitId > entryId
    && entry.updatedAt === claim.entryTime && exit.updatedAt === claim.exitTime;
  const entryInRange = !!entry && within(claim.entryPrice, entry);
  const exitInRange = !!exit && within(claim.exitPrice, exit);
  const signalValid = !!prev && !!entry && (claim.side === "long" ? entry.price > prev.price : entry.price < prev.price);
  const recomputedPnl = roundsExist ? pnlOf(claim.side, claim.size, claim.entryPrice, claim.exitPrice) : null;
  const pnlMatches = recomputedPnl !== null && Math.abs(recomputedPnl - claim.reportedPnl) <= 0.01;

  const checks = { roundsExist, entryInRange, exitInRange, signalValid, pnlMatches };
  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k);
  return { pass: failed.length === 0, checks, entry, exit, recomputedPnl, reason: failed.length ? `failed: ${failed.join(", ")}` : "all checks passed" };
}

/**
 * An honest trader: finds a real momentum signal in recent Chainlink rounds, enters at that round's price and
 * exits `hold` rounds later, reporting fills + PnL truthfully.
 */
export async function honestClaim(client: ChainReader, agentId: bigint | string, pair: Pair, size: number, seed: number, nonce: string): Promise<TradeClaim> {
  const rounds = await recentRounds(client, pair, 30);
  const hold = 1 + (seed % 3);
  const candidates = rounds.length - hold - 1; // entry index i needs i-1 >= 0 and i+hold < length
  for (let k = 0; k < candidates; k++) {
    const i = 1 + ((seed + k * 7) % candidates);
    const prev = rounds[i - 1]!, entry = rounds[i]!, exit = rounds[i + hold]!;
    if (BigInt(entry.roundId) !== BigInt(prev.roundId) + 1n || BigInt(exit.roundId) !== BigInt(entry.roundId) + BigInt(hold)) continue;
    if (entry.price === prev.price) continue;
    const side: Side = entry.price > prev.price ? "long" : "short";
    return {
      version: 2, agentId: String(agentId), pair, side, size, strategy: "momentum-v1", feed: FEEDS[pair],
      entryRound: entry.roundId, entryTime: entry.updatedAt, entryPrice: entry.price,
      exitRound: exit.roundId, exitTime: exit.updatedAt, exitPrice: exit.price,
      reportedPnl: pnlOf(side, size, entry.price, exit.price), nonce,
    };
  }
  throw new Error(`No momentum signal in recent ${pair} Chainlink rounds yet`);
}

/** The adversarial "liar": starts from a real trade, then fakes a better fill and inflates the PnL. */
export async function fabricatedClaim(client: ChainReader, agentId: bigint | string, pair: Pair, size: number, seed: number, nonce: string): Promise<TradeClaim> {
  const real = await honestClaim(client, agentId, pair, size, seed, nonce);
  const fakeExit = real.side === "long" ? real.exitPrice * 1.035 : real.exitPrice * 0.965;
  return { ...real, exitPrice: round(fakeExit), reportedPnl: round(pnlOf(real.side, size, real.entryPrice, fakeExit) + Math.abs(real.entryPrice * size) * 0.02, 4) };
}
