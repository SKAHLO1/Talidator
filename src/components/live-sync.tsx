"use client";

import { useEffect, useRef } from "react";
import { contracts } from "@/lib/chain/config";
import { ENVIO_GRAPHQL_URL, readSnapshotFromEnvio } from "@/lib/chain/envio";
import { LogCache, readSnapshot } from "@/lib/chain/reader";
import { useStore } from "@/lib/store";

const POLL_MS = 4000;

/**
 * Polls Talidator state and hydrates the store. With an Envio indexer configured, indexed state comes from its
 * GraphQL API; if that fails (indexer redeploying, network blip) the poll falls back to reading the chain over RPC.
 */
export function LiveSync() {
  const { state, dispatch } = useStore();
  const cache = useRef(new LogCache());
  const inFlight = useRef(false);
  const { refreshNonce } = state.sync;

  useEffect(() => {
    if (!contracts) {
      dispatch({ type: "SYNC_STATUS", status: "undeployed" });
      return;
    }
    let cancelled = false;
    const poll = async () => {
      if (inFlight.current) return;
      inFlight.current = true;
      try {
        let snapshot;
        if (ENVIO_GRAPHQL_URL) {
          try {
            snapshot = await readSnapshotFromEnvio();
          } catch (e) {
            console.warn("Envio indexer unavailable, falling back to RPC:", (e as Error).message);
          }
        }
        snapshot ??= await readSnapshot(cache.current);
        if (!cancelled) dispatch({ type: "HYDRATE", snapshot });
      } catch (e) {
        if (!cancelled) dispatch({ type: "SYNC_STATUS", status: "error", error: (e as Error).message.split("\n")[0] });
      } finally {
        inFlight.current = false;
      }
    };
    poll();
    const timer = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [refreshNonce, dispatch]);

  return null;
}
