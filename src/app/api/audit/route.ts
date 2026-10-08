import { isHex, type Hex, type PublicClient } from "viem";
import { runAudit, type AuditResult } from "@/lib/agent/auditor";
import { contracts, publicClient } from "@/lib/chain/config";
import { adminConfigured, adminDb } from "@/lib/firebase/admin";

// The agent makes several model + chain round trips.
export const maxDuration = 60;

const CACHE_TTL_S = 10 * 60;
const apiKey = process.env.QWEN_API_KEY || process.env.DASHSCOPE_API_KEY || "";
const llm = { apiKey, baseUrl: process.env.QWEN_BASE_URL, model: process.env.QWEN_MODEL };

const bad = (error: string, status = 400) => Response.json({ error }, { status });
const valid = (h: unknown): h is Hex => typeof h === "string" && isHex(h) && h.length === 66;

async function cached(hash: Hex): Promise<AuditResult | null> {
  if (!adminConfigured) return null;
  const snap = await adminDb().collection("audits").doc(hash.toLowerCase()).get();
  return snap.exists ? (snap.data() as AuditResult) : null;
}

/** Latest stored audit for a request (no model call). */
export async function GET(request: Request) {
  const hash = new URL(request.url).searchParams.get("requestHash");
  if (!valid(hash)) return bad("Expected ?requestHash=0x…");
  const audit = await cached(hash);
  return Response.json({ audit, enabled: Boolean(apiKey) }, { headers: { "Cache-Control": "no-store" } });
}

/** Run (or return a fresh cached) Qwen audit for a request. */
export async function POST(request: Request) {
  if (!apiKey) return bad("The AI auditor is not configured (QWEN_API_KEY)", 503);
  if (!contracts) return bad("Contracts are not deployed", 503);
  const body = (await request.json().catch(() => ({}))) as { requestHash?: unknown; force?: unknown };
  if (!valid(body.requestHash)) return bad("Expected { requestHash }");
  const hash = body.requestHash;

  const prior = await cached(hash);
  if (prior && !body.force && Math.floor(Date.now() / 1000) - prior.createdAt < CACHE_TTL_S) {
    return Response.json({ audit: prior, cached: true });
  }

  try {
    const audit = await runAudit(hash, publicClient as PublicClient, contracts, llm);
    if (adminConfigured) {
      // Firestore can't store `undefined`; tool results are plain JSON already.
      await adminDb().collection("audits").doc(hash.toLowerCase()).set(JSON.parse(JSON.stringify(audit)));
    }
    return Response.json({ audit, cached: false });
  } catch (e) {
    return bad(`Audit failed: ${(e as Error).message.split("\n")[0]}`, 502);
  }
}
