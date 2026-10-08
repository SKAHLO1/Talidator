import { keccak256, toBytes, toHex, type Hex } from "viem";
import { reexecute, type ChainReader, type TradeClaim } from "./market";

/** Claims travel on-chain as `data:` URIs so validators need no IPFS / off-chain fetch. */
const PREFIX = "data:application/json;base64,";

function toBase64(s: string) {
  if (typeof Buffer !== "undefined") return Buffer.from(s, "utf8").toString("base64");
  return btoa(String.fromCharCode(...new TextEncoder().encode(s)));
}

function fromBase64(s: string) {
  if (typeof Buffer !== "undefined") return Buffer.from(s, "base64").toString("utf8");
  return new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)));
}

export function encodeClaim(claim: TradeClaim): { uri: string; requestHash: Hex; json: string } {
  const json = JSON.stringify(claim);
  return { uri: PREFIX + toBase64(json), requestHash: keccak256(toBytes(json)), json };
}

export function decodeClaim(uri: string): TradeClaim | null {
  try {
    if (uri.startsWith(PREFIX)) return JSON.parse(fromBase64(uri.slice(PREFIX.length)));
    if (uri.startsWith("data:application/json,")) return JSON.parse(decodeURIComponent(uri.slice(22)));
  } catch {
    /* fallthrough */
  }
  return null;
}

/**
 * Re-execute against the Chainlink feed on Monad and commit to the result: evidenceHash = keccak256(canonical
 * result JSON). The rounds a claim pins are immutable, so every honest validator commits to the same hash.
 */
export async function evaluate(client: ChainReader, uri: string, requestHash: Hex) {
  const claim = decodeClaim(uri);
  if (!claim) return { pass: false, evidenceHash: keccak256(toHex("undecodable-claim")), reason: "claim not decodable", claim: null, result: null };
  const hashOk = keccak256(toBytes(JSON.stringify(claim))) === requestHash;
  const result = await reexecute(client, claim);
  const pass = hashOk && result.pass;
  const evidence = JSON.stringify({ requestHash, hashOk, ...result });
  return { pass, evidenceHash: keccak256(toBytes(evidence)), reason: hashOk ? result.reason : "requestHash mismatch", claim, result };
}

export function describeClaim(claim: TradeClaim) {
  const [asset, quote] = claim.pair.split("/");
  return { asset, quote, task: `Execute ${claim.size} ${asset} ${claim.side}` };
}

/** Agent metadata lives in the ERC-721 tokenURI as a data URI. */
export function agentTokenURI(name: string, description = "") {
  return "data:application/json;base64," + toBase64(JSON.stringify({ name, description, type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1" }));
}

export function agentNameFromURI(uri: string): string | null {
  try {
    if (uri.startsWith(PREFIX)) return JSON.parse(fromBase64(uri.slice(PREFIX.length))).name ?? null;
  } catch {
    /* ignore */
  }
  return null;
}
