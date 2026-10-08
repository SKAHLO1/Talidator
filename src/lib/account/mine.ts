"use client";

import { useMemo } from "react";
import { useConnection } from "wagmi";
import { useStore } from "../store";
import type { Activity, ValidationRequest } from "../types";
import { useAccount } from "./account";
import { ALERT_LABELS, type AlertKey } from "./model";

const lc = (s?: string | null) => (s ?? "").toLowerCase();

/**
 * Whose dashboard is this? The signed-in wallet if there is a session, otherwise the connected wallet
 * (so "my agents" still works before signing in; watchlist/profile/alerts need the session).
 */
export function useViewer() {
  const account = useAccount();
  const conn = useConnection();
  const address = account.uid ?? (conn.address ? conn.address.toLowerCase() : null);
  return { address, signedIn: account.status === "signed-in", account };
}

/** Everything on-chain that involves the viewer or something they watch. */
export function useMine() {
  const { state } = useStore();
  const { address, signedIn, account } = useViewer();

  return useMemo(() => {
    const me = lc(address);
    const myAgents = new Set(state.agents.filter((a) => me && (lc(a.owner) === me || lc(a.address) === me)).map((a) => lc(a.address)));
    if (me) myAgents.add(me);
    const watchedAgents = new Set(account.watchlist.filter((w) => w.kind === "agent").map((w) => w.ref));
    const watchedRequests = new Set(account.watchlist.filter((w) => w.kind === "request").map((w) => w.ref));

    const ownsRequest = (r: ValidationRequest) =>
      !!me && (
        [r.requester, r.payer, r.challenger].some((x) => lc(x) === me) ||
        myAgents.has(lc(r.agent)) ||
        r.validators.some((v) => myAgents.has(lc(v)))
      );
    const watchesRequest = (r: ValidationRequest) =>
      watchedRequests.has(lc(r.requestHash)) || watchedAgents.has(lc(r.agent)) || r.validators.some((v) => watchedAgents.has(lc(v)));
    const isMine = (r: ValidationRequest) => ownsRequest(r) || watchesRequest(r);

    const relevantHashes = new Set(state.requests.filter(isMine).map((r) => lc(r.requestHash)));
    for (const h of watchedRequests) relevantHashes.add(h);
    const isMyActivity = (a: Activity) =>
      (!!a.requestHash && relevantHashes.has(lc(a.requestHash))) ||
      a.actors.some((x) => myAgents.has(x) || watchedAgents.has(x));

    const requests = state.requests.filter(isMine);
    const activity = state.activity.filter(isMyActivity);

    // Alerts: my activity, filtered by the kinds the user opted into.
    const prefs = account.profile?.alerts;
    const enabledKinds = new Set(
      prefs ? (Object.keys(ALERT_LABELS) as AlertKey[]).filter((k) => prefs[k]).flatMap((k) => ALERT_LABELS[k].kinds) : [],
    );
    const alerts = signedIn ? activity.filter((a) => enabledKinds.has(a.kind)) : [];
    const seenAt = account.profile?.alertsSeenAt ?? 0;
    const unread = alerts.filter((a) => a.at > seenAt).length;

    return { me, signedIn, requests, activity, alerts, unread, isMine, ownsRequest, myAgents };
  }, [state.agents, state.requests, state.activity, address, signedIn, account.watchlist, account.profile]);
}
