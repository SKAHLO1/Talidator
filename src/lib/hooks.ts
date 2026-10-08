"use client";

import { useConnection } from "wagmi";
import { CHAIN_ID, SYMBOL } from "./chain/config";

/** The connected wallet, and whether it is on Monad testnet. */
export function useMe(): { address: string | null; connected: boolean; onMonad: boolean } {
  const conn = useConnection();
  return {
    address: conn.address ?? null,
    connected: conn.isConnected,
    onMonad: conn.isConnected && conn.chainId === CHAIN_ID,
  };
}

/** Format a native-currency amount, e.g. `0.15 MON`. */
export const mon = (n: number, dp = 4) => `${Number(n.toFixed(dp)).toLocaleString("en-US", { maximumFractionDigits: dp })} ${SYMBOL}`;

export const sameAddr = (a?: string | null, b?: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
