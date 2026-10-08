/**
 * Autonomous mode for the Qwen auditor agent (src/lib/agent/auditor.ts).
 *
 * The daemon asks the agent to audit every finalized, unchallenged result while its challenge window is open.
 * If the agent concludes the result is wrong and recommends a challenge with enough confidence, the challenger
 * agent stakes the bond on-chain — an LLM making a real, economically-backed on-chain decision.
 */
import type { Hex } from "viem";
import { runAudit, type AuditResult } from "../../../src/lib/agent/auditor";
import type { AgentAccount } from "./agents";
import { C, publicClient } from "./clients";
import { env } from "./env";
import { log } from "./log";
import { call } from "./signer";

const apiKey = env("QWEN_API_KEY") || env("DASHSCOPE_API_KEY") || "";
export const auditorEnabled = (env("AUDITOR") ?? "off").toLowerCase() === "on" && Boolean(apiKey);
const MIN_CONFIDENCE = Number(env("AUDITOR_MIN_CONFIDENCE") ?? 0.8);
const audited = new Map<Hex, AuditResult>();

export async function autoAudit(requestHash: Hex, challenger: AgentAccount) {
  if (audited.has(requestHash)) return;
  // Same viem version, two node_modules copies (repo root vs contracts/) — the types are structurally identical.
  const client = publicClient as unknown as Parameters<typeof runAudit>[1];
  const audit = await runAudit(requestHash, client, C, {
    apiKey, baseUrl: env("QWEN_BASE_URL"), model: env("QWEN_MODEL"),
  });
  audited.set(requestHash, audit);
  log.info(`Qwen audit ${requestHash.slice(0, 10)}: ${audit.verdict} (${Math.round(audit.confidence * 100)}%) · ${audit.steps.length} tool calls · ${audit.summary}`);

  if (audit.verdict !== "result_wrong" || audit.recommendedAction !== "challenge" || audit.confidence < MIN_CONFIDENCE) return;
  // Re-check on-chain state right before committing the bond.
  const [chId, bond] = await Promise.all([
    publicClient.readContract({ ...C.market, functionName: "challengeOf", args: [requestHash] }),
    publicClient.readContract({ ...C.market, functionName: "challengeBond" }),
  ]);
  if (chId !== 0n) return;
  const hash = await call(challenger.signer, C.market, "challenge", [requestHash], bond);
  log.tx(`Auditor agent challenged ${requestHash.slice(0, 10)} (bond staked)`, hash);
}
