/**
 * Envio HyperIndex read path. When NEXT_PUBLIC_ENVIO_GRAPHQL_URL is set, the dashboard reads requests, votes,
 * escrow, challenges, validators, agents, reputation, the activity feed and network aggregates from the
 * Talidator indexer (../../indexer) in a single GraphQL query — no eth_getLogs scanning. Only the live head,
 * protocol parameters and contract balances still come from the RPC (one Multicall3 batch).
 */
import { formatEther } from "viem";
import type { Activity, ActivityKind, Agent, AgentRole, Asset, RequestStatus, Validator, ValidationRequest, Vote } from "../types";
import { decodeClaim, describeClaim } from "./claims";
import { contracts, publicClient } from "./config";
import type { Snapshot } from "./reader";

export const ENVIO_GRAPHQL_URL = process.env.NEXT_PUBLIC_ENVIO_GRAPHQL_URL || "";

const REQUESTS = 25;
const ACTIVITY = 200;

const QUERY = /* GraphQL */ `
  query Dashboard($requests: Int!, $activity: Int!) {
    ProtocolStats(where: { id: { _eq: "global" } }) {
      agents validators requests challenges openChallenges totalSlashed
    }
    Agent(order_by: { tokenId: asc }, limit: 1000) {
      id tokenId owner wallet role name registeredAt reputationCount reputationScore
    }
    Validator(limit: 1000) {
      id bonded slashed status votesCast votesAgreed
    }
    ValidationRequest(order_by: { seq: desc }, limit: $requests) {
      id seq agentId requester validators threshold requestURI deadline status overturned finalizedAt reputationPosted
      agent { wallet }
      votes { validator_id pass }
      escrow { payer amount state }
      challenge { id challenger status openedAt }
      events(order_by: { blockNumber: asc }) { title txHash }
    }
    ProtocolEvent(order_by: { timestamp: desc }, limit: $activity) {
      id kind title detail timestamp txHash requestHash actors
    }
  }
`;

type Gql<T> = { data?: T; errors?: { message: string }[] };
type Row = Record<string, unknown>;
interface Result {
  ProtocolStats: { agents: number; validators: number; requests: number; challenges: number; openChallenges: number; totalSlashed: string }[];
  Agent: { id: string; tokenId: string; owner: string; wallet: string; role: string; name: string; registeredAt: number; reputationCount: number; reputationScore: number }[];
  Validator: { id: string; bonded: string; slashed: string; status: string; votesCast: number; votesAgreed: number }[];
  ValidationRequest: (Row & {
    id: string; seq: number; agentId: string; requester: string; validators: string[]; threshold: number; requestURI: string;
    deadline: number; status: string; overturned: boolean; finalizedAt: number | null; reputationPosted: boolean;
    agent: { wallet: string } | null;
    votes: { validator_id: string; pass: boolean }[];
    escrow: { payer: string; amount: string; state: string } | null;
    challenge: { id: string; challenger: string; status: string; openedAt: number } | null;
    events: { title: string; txHash: string }[];
  })[];
  ProtocolEvent: { id: string; kind: string; title: string; detail: string; timestamp: number; txHash: string; requestHash: string | null; actors: string[] }[];
}

const wei = (v: bigint | string | number | null | undefined) => Number(formatEther(BigInt(v ?? 0)));
const ROLE: Record<string, AgentRole> = { TRADER: "trader", VALIDATOR: "validator", CHALLENGER: "challenger" };
const ESCROW: Record<string, ValidationRequest["escrow"]> = { FUNDED: "funded", RELEASED: "released", REFUNDED: "refunded" };
const ASSETS: Asset[] = ["ETH", "BTC", "LINK"];
/** Indexer activity kinds → dashboard activity kinds (icons / alert categories). */
const KIND: Record<string, ActivityKind> = {
  request: "request", vote: "vote", validated: "validated", rejected: "rejected", payment: "payment", deposit: "payment",
  refund: "rejected", challenge: "challenge", "challenge-won": "challenge-won", "challenge-lost": "challenge-lost",
  overturned: "challenge-won", slashed: "challenge-won", reputation: "reputation", registered: "registered",
  bonded: "registered", unbonding: "registered",
};

export async function queryEnvio(): Promise<Result> {
  const res = await fetch(ENVIO_GRAPHQL_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: QUERY, variables: { requests: REQUESTS, activity: ACTIVITY } }),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Envio indexer responded ${res.status}`);
  const json = (await res.json()) as Gql<Result>;
  if (json.errors?.length) throw new Error(`Envio: ${json.errors[0]!.message}`);
  if (!json.data) throw new Error("Envio: empty response");
  return json.data;
}

/** Map one Envio response + live chain values onto the dashboard model (same shape as the RPC reader). */
export function mapEnvio(
  d: Result,
  live: {
    now: number;
    blockNumber: bigint;
    minBond: number;
    challengeWindowSec: number;
    reviewPeriodSec: number;
    tvl: number;
    params: Snapshot["params"];
  },
): Snapshot {
  const { now } = live;
  const lc = (a: string) => a.toLowerCase();

  const agents: Agent[] = d.Agent.map((a) => ({
    tokenId: Number(a.tokenId),
    name: a.name,
    address: a.wallet,
    role: ROLE[a.role] ?? "trader",
    owner: a.owner,
    registeredAt: new Date(a.registeredAt * 1000).toISOString().slice(0, 10),
    adversarial: /adversarial|shady|liar/i.test(a.name),
  }));
  const nameOf = (addr: string) => agents.find((a) => lc(a.address) === lc(addr))?.name ?? `${addr.slice(0, 6)}…${addr.slice(-4)}`;

  const validators: Validator[] = d.Validator.map((v) => {
    const stake = wei(v.bonded);
    const slashed = wei(v.slashed);
    const active = v.status === "ACTIVE" && stake >= live.minBond;
    return {
      address: v.id,
      name: nameOf(v.id),
      successRate: v.votesCast === 0 ? 100 : Math.round((v.votesAgreed / v.votesCast) * 100),
      totalVotes: v.votesCast,
      stake,
      slashed,
      status: v.status === "UNBONDING" || v.status === "WITHDRAWN" ? "unbonding" : active ? "active" : slashed > 0 ? "slashed" : "inactive",
    };
  });

  const requests: ValidationRequest[] = d.ValidationRequest.map((r) => {
    const voteOf = new Map(r.votes.map((v) => [lc(v.validator_id), v.pass]));
    const votes: Vote[] = r.validators.map((v) => (voteOf.has(lc(v)) ? (voteOf.get(lc(v)) ? "pass" : "fail") : null));
    const claim = decodeClaim(r.requestURI);
    const desc = claim ? describeClaim(claim) : { asset: "ETH", quote: "?", task: "Unrecognised claim format" };
    const pending = r.status === "PENDING" || r.status === "IN_PROGRESS";
    const ch = r.challenge;
    const open = ch?.status === "OPEN";
    let status: RequestStatus;
    if (pending) status = r.votes.length ? "In Progress" : "Pending";
    else if (open) status = "Challenged";
    else if (r.overturned) status = "Overturned";
    else status = r.status === "PASSED" ? "Validated" : "Rejected";
    const windowLeft = r.finalizedAt ? r.finalizedAt + live.challengeWindowSec - now : 0;
    const finalized = !pending && (ch ? !open : windowLeft <= 0);
    return {
      id: r.seq,
      requestHash: r.id,
      agent: r.agent?.wallet ?? r.requester,
      requester: r.requester,
      payer: r.escrow?.payer,
      asset: (ASSETS.includes(desc.asset as Asset) ? desc.asset : "ETH") as Asset,
      quote: desc.quote,
      task: desc.task,
      validators: r.validators,
      votes,
      threshold: r.threshold,
      status,
      secondsLeft: pending ? Math.max(0, r.deadline - now) : null,
      challengeWindow: (status === "Validated" || status === "Rejected") && !ch && windowLeft > 0 ? windowLeft : null,
      challengeResolveIn: open && ch ? Math.max(0, ch.openedAt + live.reviewPeriodSec - now) : null,
      challenger: ch?.challenger,
      payment: wei(r.escrow?.amount),
      escrow: r.escrow ? (ESCROW[r.escrow.state] ?? "none") : "none",
      finalized,
      txHashes: r.events.map((e) => ({ label: e.title, hash: e.txHash })),
    };
  });

  const activity: Activity[] = d.ProtocolEvent.map((e) => ({
    id: e.id,
    kind: KIND[e.kind] ?? "request",
    title: e.title,
    detail: e.detail,
    at: e.timestamp,
    ago: Math.max(0, now - e.timestamp),
    txHash: e.txHash,
    requestHash: e.requestHash ?? undefined,
    actors: e.actors,
  }));

  const s = d.ProtocolStats[0];
  return {
    requests,
    validators,
    agents,
    reputation: d.Agent.filter((a) => a.role === "TRADER" && a.reputationCount > 0).map((a) => ({
      agent: a.wallet, score: a.reputationScore / 100, feedback: a.reputationCount,
    })),
    activity,
    stats: {
      tvl: live.tvl,
      totalValidators: s?.validators ?? validators.length,
      totalRequests: s?.requests ?? requests.length,
      activeChallenges: s?.openChallenges ?? 0,
      slashed: wei(s?.totalSlashed),
    },
    params: live.params,
    blockNumber: live.blockNumber,
    backfilling: false,
    source: "envio",
  };
}

/** Full snapshot: Envio for indexed state, one RPC multicall for the live head, params and balances. */
export async function readSnapshotFromEnvio(): Promise<Snapshot> {
  const c = contracts;
  if (!c) throw new Error("Talidator is not deployed on Monad testnet yet");
  const read = publicClient.readContract;
  const [data, block, minBond, challengeBond, challengeWindow, reviewPeriod, slashBps, cutBps, votingPeriod, arbiter, b1, b2, b3] =
    await Promise.all([
      queryEnvio(),
      publicClient.getBlock(),
      read({ ...c.staking, functionName: "minBond" }),
      read({ ...c.market, functionName: "challengeBond" }),
      read({ ...c.market, functionName: "challengeWindow" }),
      read({ ...c.market, functionName: "reviewPeriod" }),
      read({ ...c.market, functionName: "slashBps" }),
      read({ ...c.market, functionName: "challengerCutBps" }),
      read({ ...c.registry, functionName: "votingPeriod" }),
      read({ ...c.market, functionName: "arbiter" }),
      publicClient.getBalance({ address: c.staking.address }),
      publicClient.getBalance({ address: c.escrow.address }),
      publicClient.getBalance({ address: c.market.address }),
    ]);
  return mapEnvio(data, {
    now: Number(block.timestamp),
    blockNumber: block.number,
    minBond: wei(minBond),
    challengeWindowSec: Number(challengeWindow),
    reviewPeriodSec: Number(reviewPeriod),
    tvl: wei(b1 + b2 + b3),
    params: {
      challengeWindowSec: Number(challengeWindow),
      challengeBond: wei(challengeBond),
      slashPercent: Number(slashBps) / 100,
      challengerCutPercent: Number(cutBps) / 100,
      minBond: wei(minBond),
      votingPeriodSec: Number(votingPeriod),
      reviewPeriodSec: Number(reviewPeriod),
      arbiter,
    },
  });
}
