import { generateSiweNonce } from "viem/siwe";
import { adminConfigured, adminDb } from "@/lib/firebase/admin";

const NONCE_TTL_MS = 10 * 60 * 1000;

/** Issue a single-use SIWE nonce. Stored server-side so a signed message can't be replayed. */
export async function POST() {
  if (!adminConfigured) return Response.json({ error: "Accounts are not configured on this deployment" }, { status: 503 });
  const nonce = generateSiweNonce();
  try {
    await adminDb().collection("siweNonces").doc(nonce).set({ expiresAt: Date.now() + NONCE_TTL_MS });
  } catch (e) {
    console.error("SIWE nonce: Firestore write failed:", e);
    return Response.json({ error: "Account storage is unavailable (check the FIREBASE_* env vars)" }, { status: 500 });
  }
  return Response.json({ nonce }, { headers: { "Cache-Control": "no-store" } });
}
