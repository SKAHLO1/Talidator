import { isHex } from "viem";
import type { AuditResult } from "@/lib/agent/auditor";
import { adminConfigured, adminDb } from "@/lib/firebase/admin";

/**
 * Deterministic audit lookup for the Chainlink CRE keeper workflow (cre/talidator-keeper).
 *
 * Returns which of the given requests the AI auditor has flagged as wrong. It only reads *stored* verdicts — never
 * runs the model — so every node in the CRE DON gets the identical answer, as identical-consensus requires.
 *   GET /api/audit/flags?requestHashes=0xabc…,0xdef…
 */
const MIN_CONFIDENCE = Number(process.env.AUDIT_FLAG_MIN_CONFIDENCE || 0.8);

export async function GET(request: Request) {
  const raw = new URL(request.url).searchParams.get("requestHashes") ?? "";
  const hashes = [...new Set(raw.split(",").map((h) => h.trim().toLowerCase()))].filter((h) => isHex(h) && h.length === 66).slice(0, 50);
  if (!adminConfigured || hashes.length === 0) return Response.json({ flagged: [] }, { headers: { "Cache-Control": "no-store" } });

  const snaps = await adminDb().getAll(...hashes.map((h) => adminDb().collection("audits").doc(h)));
  const flagged = snaps
    .filter((s) => s.exists)
    .map((s) => s.data() as AuditResult)
    .filter((a) => a.verdict === "result_wrong" && a.confidence >= MIN_CONFIDENCE)
    .map((a) => a.requestHash.toLowerCase())
    .sort();
  return Response.json({ flagged }, { headers: { "Cache-Control": "no-store" } });
}
