import { FieldValue } from "firebase-admin/firestore";
import { isHex } from "viem";
import { parseSiweMessage } from "viem/siwe";
import { DEFAULT_ALERTS } from "@/lib/account/model";
import { CHAIN_ID, publicClient } from "@/lib/chain/config";
import { adminAuth, adminConfigured, adminDb } from "@/lib/firebase/admin";

const bad = (error: string, status = 400) => Response.json({ error }, { status });

/** "https://Talidator.vercel.app/ " → "talidator.vercel.app" — tolerate how env UIs usually get filled in. */
const normalizeHost = (s: string) => s.trim().replace(/^["']|["']$/g, "").replace(/^https?:\/\//i, "").replace(/\/.*$/, "").toLowerCase();

/** SIWE_DOMAIN may list several hosts (comma-separated), e.g. a custom domain plus the vercel.app one. */
const allowedHosts = (request: Request) =>
  (process.env.SIWE_DOMAIN || request.headers.get("host") || "").split(",").map(normalizeHost).filter(Boolean);

/**
 * Sign-In with Ethereum → Firebase session.
 * Verifies the signed message (EOAs, ERC-1271 smart accounts and EIP-7702-delegated EOAs via viem), burns the
 * nonce, creates the user's profile on first login, and returns a Firebase custom token whose uid is the
 * lowercase wallet address — so Firestore rules can key every user document to the wallet that signed in.
 */
export async function POST(request: Request) {
  if (!adminConfigured) return bad("Accounts are not configured on this deployment", 503);

  let body: { message?: unknown; signature?: unknown };
  try {
    body = await request.json();
  } catch {
    return bad("Invalid JSON body");
  }
  const { message, signature } = body;
  if (typeof message !== "string" || message.length > 2000 || typeof signature !== "string" || !isHex(signature)) {
    return bad("Expected { message, signature }");
  }

  const parsed = parseSiweMessage(message);
  // The domain the user signed for must be ours. Prefer an explicit SIWE_DOMAIN (e.g. "talidator.vercel.app");
  // fall back to the Host header, never a client-settable forwarding header.
  const hosts = allowedHosts(request);
  if (!parsed.address || !parsed.nonce) return bad("Malformed SIWE message");
  if (parsed.chainId !== CHAIN_ID) return bad(`Sign in on chain ${CHAIN_ID}`);
  const host = hosts.find((h) => h === parsed.domain?.toLowerCase());
  if (!host) {
    return bad(`SIWE domain does not match this site: signed for "${parsed.domain}", this deployment accepts ${hosts.map((h) => `"${h}"`).join(", ") || "(none)"}`);
  }

  // Burn the nonce first so a message can only ever be used once.
  const db = adminDb();
  const nonceRef = db.collection("siweNonces").doc(parsed.nonce);
  const fresh = await db.runTransaction(async (tx) => {
    const snap = await tx.get(nonceRef);
    if (!snap.exists) return false;
    tx.delete(nonceRef);
    return (snap.get("expiresAt") as number) > Date.now();
  });
  if (!fresh) return bad("Nonce expired or already used — try signing in again", 401);

  const valid = await publicClient
    .verifySiweMessage({ message, signature, domain: host, nonce: parsed.nonce })
    .catch(() => false);
  if (!valid) return bad("Signature verification failed", 401);

  const uid = parsed.address.toLowerCase();
  const userRef = db.collection("users").doc(uid);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(userRef);
    if (snap.exists) {
      tx.update(userRef, { lastLoginAt: FieldValue.serverTimestamp() });
    } else {
      tx.set(userRef, {
        address: parsed.address,
        displayName: "",
        avatarUrl: "",
        alerts: DEFAULT_ALERTS,
        alertsSeenAt: Math.floor(Date.now() / 1000),
        createdAt: FieldValue.serverTimestamp(),
        lastLoginAt: FieldValue.serverTimestamp(),
      });
    }
  });

  const token = await adminAuth().createCustomToken(uid, { wallet: parsed.address });
  return Response.json({ token }, { headers: { "Cache-Control": "no-store" } });
}
