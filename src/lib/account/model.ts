import type { ActivityKind } from "../types";
import type { NotesKeyInfo, Sealed } from "./vault";

/** Firestore: users/{uid} — uid is the lowercase wallet address. */
export interface Profile {
  address: string;
  displayName: string;
  avatarUrl: string;
  alerts: AlertPrefs;
  /** unix seconds; alerts newer than this are unread */
  alertsSeenAt: number;
  /** Mera passkey that holds the notes encryption key (absent = notes stored in plaintext) */
  notesKey?: NotesKeyInfo;
  createdAt?: unknown;
  lastLoginAt?: unknown;
}

/** Which on-chain events show up as alerts for this user. */
export type AlertPrefs = Record<AlertKey, boolean>;
export type AlertKey = "requests" | "votes" | "results" | "payments" | "challenges" | "reputation";

export const ALERT_LABELS: Record<AlertKey, { label: string; description: string; kinds: ActivityKind[] }> = {
  requests: { label: "New requests", description: "A validation request involving you or a watched item", kinds: ["request"] },
  votes: { label: "Validator votes", description: "Each vote cast on your or watched requests", kinds: ["vote"] },
  results: { label: "Quorum results", description: "A request passes or fails", kinds: ["validated", "rejected"] },
  payments: { label: "Payments", description: "Escrow released or refunded", kinds: ["payment"] },
  challenges: { label: "Challenges", description: "Challenges raised and resolved, slashing", kinds: ["challenge", "challenge-won", "challenge-lost"] },
  reputation: { label: "Reputation", description: "Final outcomes posted to the Reputation Registry", kinds: ["reputation"] },
};

export const DEFAULT_ALERTS: AlertPrefs = { requests: true, votes: false, results: true, payments: true, challenges: true, reputation: false };

/** Firestore: users/{uid}/watchlist/{id} — id is the lowercase address or request hash. */
export interface WatchItem {
  kind: "agent" | "request";
  ref: string;
  label: string;
  addedAt?: unknown;
}

/** Firestore: users/{uid}/notes/{agentAddressLowercase} — private labels on agents. */
export interface AgentNote {
  label: string;
  /** plaintext body — empty when `enc` is set */
  note: string;
  /** AES-GCM-encrypted body (key derived from the user's passkey via Mera PRF) */
  enc?: Sealed;
  updatedAt?: unknown;
  /** client-only: body is encrypted and the vault is locked */
  locked?: boolean;
}

export const SIWE_STATEMENT = "Sign in to Talidator. This request will not trigger a transaction or cost gas.";
