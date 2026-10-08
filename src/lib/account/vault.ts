"use client";

/**
 * Passkey-encrypted private notes (Mera PRF key derivation — non-wallet use).
 *
 * One passkey, one isolated namespace: the PRF salt below is unique to Talidator's notes, so the 32 bytes it
 * yields are unrelated to any wallet key or other app's keys on the same passkey. HKDF turns them into an
 * AES-256-GCM key that only ever lives in memory (non-extractable CryptoKey); notes are encrypted in the browser
 * before they reach Firestore, so the server and database only ever see ciphertext. The same (synced) passkey on
 * another device re-derives the same key and decrypts the same notes — nothing secret is stored anywhere.
 */
import { createPasskeyWithPrfOutput, getPasskeyPrfOutput, type PasskeyCredentialMetadata } from "@category-labs/mera";

const enc = new TextEncoder();
const dec = new TextDecoder();

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** Namespace salt for the notes key: sha256("talidator.notes.v1"). */
async function notesSalt() {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode("talidator.notes.v1")));
}

/** PRF output → non-extractable AES-256-GCM key (exported for tests). */
export async function deriveKey(prfOutput: Uint8Array<ArrayBuffer>) {
  const ikm = await crypto.subtle.importKey("raw", prfOutput, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: enc.encode("talidator"), info: enc.encode("talidator.notes.aes-256-gcm.v1") },
    ikm,
    { name: "AES-GCM", length: 256 },
    false, // never extractable — the key can't leave this tab
    ["encrypt", "decrypt"],
  );
}

export interface Sealed {
  iv: string;
  ct: string;
}

export async function seal(key: CryptoKey, plaintext: string): Promise<Sealed> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(plaintext)));
  return { iv: b64(iv), ct: b64(ct) };
}

export async function open(key: CryptoKey, sealed: Sealed): Promise<string> {
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(sealed.iv) }, key, unb64(sealed.ct));
  return dec.decode(pt);
}

/** Stored on the profile: which passkey holds the notes key + a check value to detect the wrong passkey. */
export interface NotesKeyInfo {
  credentialId: string;
  transports?: string[];
  check: Sealed;
  createdAt: number;
}

const CHECK = "talidator-notes-key-check-v1";

export function passkeySupported() {
  return typeof window !== "undefined" && typeof PublicKeyCredential !== "undefined" && window.isSecureContext;
}

/** First-time setup: create a passkey (one prompt) and derive the notes key from its PRF namespace. */
export async function createNotesKey(userName: string, displayName: string) {
  const { prfOutput, credentialId, transports } = await createPasskeyWithPrfOutput({
    rp: { id: window.location.hostname, name: "Talidator" },
    user: { name: userName, displayName },
    prfSalt: await notesSalt(),
  });
  const key = await deriveKey(prfOutput);
  prfOutput.fill(0);
  const info: NotesKeyInfo = {
    credentialId,
    ...(transports ? { transports: [...transports] } : {}),
    check: await seal(key, CHECK),
    createdAt: Math.floor(Date.now() / 1000),
  };
  return { key, info };
}

/** Unlock on any device: one passkey prompt re-derives the same key; the check value proves it's the right one. */
export async function unlockNotesKey(info: NotesKeyInfo) {
  const credential: PasskeyCredentialMetadata = { credentialId: info.credentialId, transports: info.transports };
  const { prfOutput } = await getPasskeyPrfOutput({ rpId: window.location.hostname, credential, prfSalt: await notesSalt() });
  const key = await deriveKey(prfOutput);
  prfOutput.fill(0);
  try {
    if ((await open(key, info.check)) !== CHECK) throw new Error();
  } catch {
    throw new Error("That passkey doesn't hold this account's notes key.");
  }
  return key;
}
