"use client";

import { createContext, useContext, useEffect, useReducer, type Dispatch, type ReactNode } from "react";
import type { Snapshot } from "./chain/reader";
import type { Activity, Agent, NetworkStats, ProtocolParams, Validator, ValidationRequest } from "./types";

/**
 * UI state. Everything protocol-related is hydrated from the Monad testnet contracts by <LiveSync/>;
 * between polls the reducer only ticks countdowns so timers stay smooth.
 */

export type Scenario = "honest" | "fabricated" | "colluding";

export interface Toast {
  id: string;
  tone: "success" | "danger" | "info";
  title: string;
  detail?: string;
  ttl: number;
}

export interface SyncInfo {
  status: "loading" | "ok" | "error" | "undeployed";
  error?: string;
  blockNumber?: string;
  backfilling?: boolean;
  source?: "envio" | "rpc";
  refreshNonce: number;
}

export interface State {
  requests: ValidationRequest[];
  activity: Activity[];
  validators: Validator[];
  agents: Agent[];
  reputation: { agent: string; score: number; feedback: number }[];
  stats: NetworkStats;
  params: ProtocolParams | null;
  sync: SyncInfo;
  selectedId: number | null;
  startOpen: boolean;
  toasts: Toast[];
}

const initialState: State = {
  requests: [],
  activity: [],
  validators: [],
  agents: [],
  reputation: [],
  stats: { tvl: 0, totalValidators: 0, totalRequests: 0, activeChallenges: 0, slashed: 0 },
  params: null,
  sync: { status: "loading", refreshNonce: 0 },
  selectedId: null,
  startOpen: false,
  toasts: [],
};

export type Action =
  | { type: "TICK" }
  | { type: "SELECT"; id: number | null }
  | { type: "START_OPEN"; open: boolean }
  | { type: "TOAST"; tone: Toast["tone"]; title: string; detail?: string }
  | { type: "DISMISS_TOAST"; id: string }
  | { type: "HYDRATE"; snapshot: Snapshot }
  | { type: "SYNC_STATUS"; status: SyncInfo["status"]; error?: string }
  | { type: "REFRESH" };

let uid = 0;
const nid = () => `${Date.now().toString(36)}-${(uid++).toString(36)}`;
const dec = (n: number | null) => (n != null && n > 0 ? n - 1 : n);

function reducer(s: State, a: Action): State {
  switch (a.type) {
    case "TICK":
      return {
        ...s,
        requests: s.requests.map((r) => ({
          ...r, secondsLeft: dec(r.secondsLeft), challengeWindow: dec(r.challengeWindow), challengeResolveIn: dec(r.challengeResolveIn),
        })),
        activity: s.activity.map((x) => ({ ...x, ago: x.ago + 1 })),
        toasts: s.toasts.map((t) => ({ ...t, ttl: t.ttl - 1 })).filter((t) => t.ttl > 0),
      };

    case "SELECT":
      return { ...s, selectedId: a.id };

    case "START_OPEN":
      return { ...s, startOpen: a.open };

    case "TOAST":
      return { ...s, toasts: [{ id: nid(), tone: a.tone, title: a.title, detail: a.detail, ttl: a.tone === "danger" ? 10 : 7 }, ...s.toasts] };

    case "DISMISS_TOAST":
      return { ...s, toasts: s.toasts.filter((t) => t.id !== a.id) };

    case "HYDRATE": {
      const snap = a.snapshot;
      return {
        ...s,
        requests: snap.requests, validators: snap.validators, agents: snap.agents, reputation: snap.reputation,
        activity: snap.activity, stats: snap.stats, params: snap.params,
        sync: { ...s.sync, status: "ok", error: undefined, blockNumber: snap.blockNumber.toString(), backfilling: snap.backfilling, source: snap.source },
      };
    }

    case "SYNC_STATUS":
      return { ...s, sync: { ...s.sync, status: a.status, error: a.error } };

    case "REFRESH":
      return { ...s, sync: { ...s.sync, refreshNonce: s.sync.refreshNonce + 1 } };
  }
}

const Ctx = createContext<{ state: State; dispatch: Dispatch<Action> } | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  useEffect(() => {
    const t = setInterval(() => dispatch({ type: "TICK" }), 1000);
    return () => clearInterval(t);
  }, []);
  return <Ctx.Provider value={{ state, dispatch }}>{children}</Ctx.Provider>;
}

export function useStore() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useStore must be used inside <StoreProvider>");
  return v;
}
