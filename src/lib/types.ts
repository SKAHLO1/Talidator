export type Asset = "ETH" | "BTC" | "LINK";

export type RequestStatus =
  | "Pending"
  | "In Progress"
  | "Validated"
  | "Rejected"
  | "Challenged"
  | "Overturned";

export type Vote = "pass" | "fail" | null;

export type AgentRole = "trader" | "validator" | "challenger";

export interface Agent {
  tokenId: number;
  name: string;
  /** the agent wallet bound to the identity */
  address: string;
  role: AgentRole;
  owner: string;
  registeredAt: string;
  /** name marks it as the staged adversarial trader */
  adversarial?: boolean;
}

/** All amounts are in the chain's native currency (MON). */
export interface Validator {
  address: string;
  name: string;
  successRate: number;
  totalVotes: number;
  stake: number;
  slashed: number;
  status: "active" | "slashed" | "unbonding" | "inactive";
}

export interface ValidationRequest {
  /** position in the ValidationRegistry (1-based) */
  id: number;
  requestHash: string;
  agent: string;
  /** wallet that called validationRequest() */
  requester: string;
  /** wallet that funded the escrow, if any */
  payer?: string;
  asset: Asset;
  quote: string;
  task: string;
  validators: string[];
  votes: Vote[];
  threshold: number;
  status: RequestStatus;
  /** seconds until the voting deadline (while pending / in progress) */
  secondsLeft: number | null;
  /** seconds left in the post-validation challenge window */
  challengeWindow: number | null;
  /** seconds until a raised challenge's review deadline */
  challengeResolveIn: number | null;
  challenger?: string;
  payment: number;
  escrow: "none" | "funded" | "released" | "refunded";
  /** challenge window elapsed or challenge resolved */
  finalized: boolean;
  txHashes: { label: string; hash: string }[];
}

export type ActivityKind =
  | "validated"
  | "rejected"
  | "challenge"
  | "challenge-won"
  | "challenge-lost"
  | "registered"
  | "payment"
  | "request"
  | "vote"
  | "reputation";

export interface Activity {
  id: string;
  kind: ActivityKind;
  title: string;
  detail: string;
  ago: number; // seconds ago
  /** unix seconds of the block that emitted it */
  at: number;
  txHash?: string;
  /** the validation request this event belongs to, if any */
  requestHash?: string;
  /** addresses directly involved (validator, payee, challenger, agent wallet…) — lowercase */
  actors: string[];
}

export interface NetworkStats {
  tvl: number;
  totalValidators: number;
  totalRequests: number;
  activeChallenges: number;
  slashed: number;
}

export interface ProtocolParams {
  challengeWindowSec: number;
  challengeBond: number;
  slashPercent: number;
  challengerCutPercent: number;
  minBond: number;
  votingPeriodSec: number;
  reviewPeriodSec: number;
  arbiter: string;
}
