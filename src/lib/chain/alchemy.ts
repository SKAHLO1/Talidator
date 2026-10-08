/**
 * Alchemy's Monad testnet node. The key is server-only (ALCHEMY_API_KEY); browsers reach Alchemy through the
 * read-only /api/rpc proxy instead, enabled with NEXT_PUBLIC_USE_ALCHEMY_PROXY=true.
 */
export const ALCHEMY_RPC_URL = process.env.ALCHEMY_API_KEY
  ? `https://monad-testnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`
  : "";

export const ALCHEMY_PROXY_ENABLED = process.env.NEXT_PUBLIC_USE_ALCHEMY_PROXY === "true";
