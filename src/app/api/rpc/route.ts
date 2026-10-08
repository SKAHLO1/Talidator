import { ALCHEMY_RPC_URL } from "@/lib/chain/alchemy";

/**
 * Read-only JSON-RPC proxy to Alchemy's Monad testnet node. Keeps ALCHEMY_API_KEY server-side; the browser
 * talks to /api/rpc. Writes never pass through here — users sign and broadcast with their own wallet.
 */
const ALLOWED = new Set([
  "eth_chainId", "net_version", "eth_blockNumber", "eth_getBlockByNumber", "eth_getBlockByHash", "eth_call",
  "eth_getBalance", "eth_getCode", "eth_getStorageAt", "eth_getLogs", "eth_getTransactionByHash",
  "eth_getTransactionReceipt", "eth_getTransactionCount", "eth_estimateGas", "eth_gasPrice", "eth_maxPriorityFeePerGas",
  "eth_feeHistory",
]);
const MAX_BATCH = 100;
const MAX_BODY = 256 * 1024;

type RpcReq = { jsonrpc?: string; id?: unknown; method?: unknown; params?: unknown };
const reject = (id: unknown, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code: -32601, message } });

export async function POST(request: Request) {
  if (!ALCHEMY_RPC_URL) return Response.json({ error: "RPC proxy not configured (ALCHEMY_API_KEY)" }, { status: 503 });
  const text = await request.text();
  if (text.length > MAX_BODY) return Response.json({ error: "Request too large" }, { status: 413 });

  let body: RpcReq | RpcReq[];
  try {
    body = JSON.parse(text);
  } catch {
    return Response.json(reject(null, "Parse error"), { status: 400 });
  }
  const batch = Array.isArray(body) ? body : [body];
  if (batch.length === 0 || batch.length > MAX_BATCH) return Response.json(reject(null, "Invalid batch size"), { status: 400 });

  // Forward allowed calls; answer disallowed ones locally so a batch stays aligned.
  const allowed = batch.filter((r) => typeof r.method === "string" && ALLOWED.has(r.method));
  const denied = batch.filter((r) => !allowed.includes(r)).map((r) => reject(r.id, `Method not allowed: ${String(r.method)}`));
  let forwarded: unknown[] = [];
  if (allowed.length) {
    const upstream = await fetch(ALCHEMY_RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(Array.isArray(body) ? allowed : allowed[0]),
      cache: "no-store",
    });
    const json = await upstream.json().catch(() => null);
    if (!json) return Response.json(reject(null, `Upstream error ${upstream.status}`), { status: 502 });
    forwarded = Array.isArray(json) ? json : [json];
  }
  const out = [...forwarded, ...denied];
  return Response.json(Array.isArray(body) ? out : out[0], { headers: { "Cache-Control": "no-store" } });
}
