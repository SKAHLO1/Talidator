"use client";

import { useCallback, useEffect, useState } from "react";
import { Bot, ChevronDown, Loader2, RefreshCw } from "lucide-react";
import type { AuditResult } from "@/lib/agent/auditor";
import { modelLabel } from "@/lib/agent/model";
import { cx } from "@/lib/format";
import { Button } from "./ui";

const TOOL_LABEL: Record<string, string> = {
  get_request: "Read request & votes on-chain",
  decode_claim: "Decoded the trader's claim",
  reexecute_claim: "Re-executed the claim",
  get_price_rounds: "Inspected Chainlink rounds",
  get_validator_record: "Checked a validator's record",
  get_agent_reputation: "Checked the trader's reputation",
};

const VERDICT = {
  result_correct: { label: "Result looks correct", cls: "bg-emerald-50 text-emerald-700 ring-emerald-200" },
  result_wrong: { label: "Result looks WRONG", cls: "bg-rose-50 text-rose-700 ring-rose-200" },
  inconclusive: { label: "Inconclusive", cls: "bg-slate-100 text-slate-700 ring-slate-200" },
} as const;

/** Qwen auditor agent for one request (server-side via /api/audit); shows the model actually configured / used. */
export function AuditPanel({ requestHash, challengeOpen }: { requestHash: string; challengeOpen: boolean }) {
  const [audit, setAudit] = useState<AuditResult | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [model, setModel] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSteps, setShowSteps] = useState(false);

  useEffect(() => {
    let live = true;
    fetch(`/api/audit?requestHash=${requestHash}`)
      .then((r) => r.json())
      .then((j) => {
        if (!live) return;
        setAudit(j.audit ?? null);
        setEnabled(j.enabled !== false);
        if (typeof j.model === "string") setModel(j.model);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [requestHash]);

  const run = useCallback(async (force = false) => {
    setRunning(true);
    setError(null);
    try {
      const res = await fetch("/api/audit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestHash, force }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? `Audit failed (${res.status})`);
      setAudit(j.audit);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  }, [requestHash]);

  if (!enabled && !audit) return null;
  const v = audit ? VERDICT[audit.verdict] : null;
  // The stored audit records the model that produced it; otherwise show the configured one.
  const shownModel = audit?.model ?? model;

  return (
    <div className="rounded-xl border border-line p-4">
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-sm font-medium text-ink">
          <Bot size={16} className="text-teal" /> AI auditor
          {shownModel && (
            <span title={shownModel} className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-normal text-muted">{modelLabel(shownModel)} · tool use</span>
          )}
        </p>
        {audit && enabled && (
          <button onClick={() => run(true)} disabled={running} className="text-muted hover:text-ink disabled:opacity-50" aria-label="Re-run audit" title="Re-run audit">
            <RefreshCw size={14} className={cx(running && "animate-spin")} />
          </button>
        )}
      </div>

      {!audit && !running && (
        <>
          <p className="mt-1 text-xs text-muted">
            An autonomous agent re-checks this result: it reads the votes on-chain, re-executes the claim, inspects market data and
            validator track records, then recommends an action.
          </p>
          <Button variant="secondary" className="mt-3" onClick={() => run()}>
            <Bot size={15} /> Run audit
          </Button>
        </>
      )}

      {running && (
        <p className="mt-3 flex items-center gap-2 text-xs text-muted">
          <Loader2 size={14} className="animate-spin" /> Agent is investigating… (planning, calling tools, re-executing)
        </p>
      )}
      {error && <p className="mt-2 text-xs text-rose-600">{error}</p>}

      {audit && v && !running && (
        <div className="mt-3 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className={cx("rounded-md px-2 py-1 text-xs font-medium ring-1 ring-inset", v.cls)}>{v.label}</span>
            <span className="text-[11px] text-muted">confidence {Math.round(audit.confidence * 100)}% · {new Date(audit.createdAt * 1000).toLocaleString()}</span>
          </div>
          {audit.recommendedAction === "challenge" && (
            <p className={cx("rounded-lg px-3 py-2 text-xs font-medium", challengeOpen ? "bg-rose-50 text-rose-700" : "bg-slate-50 text-muted")}>
              {challengeOpen ? "The agent recommends challenging this result while the window is open." : "The agent would challenge, but the window has closed."}
            </p>
          )}
          <p className="text-sm text-ink">{audit.summary}</p>
          {audit.findings.length > 0 && (
            <ul className="list-disc space-y-0.5 pl-4 text-xs text-muted">
              {audit.findings.map((f, i) => <li key={i}>{f}</li>)}
            </ul>
          )}
          <button onClick={() => setShowSteps((s) => !s)} className="flex items-center gap-1 text-[11px] font-medium text-teal hover:underline">
            <ChevronDown size={12} className={cx("transition", showSteps && "rotate-180")} /> {audit.steps.length} tool calls
          </button>
          {showSteps && (
            <ol className="space-y-1.5">
              {audit.steps.map((s, i) => (
                <li key={i} className="rounded-lg bg-slate-50 px-2.5 py-1.5">
                  <p className="text-[11px] font-medium text-ink">{i + 1}. {TOOL_LABEL[s.tool] ?? s.tool}</p>
                  <pre className="mt-0.5 max-h-24 overflow-auto text-[10px] whitespace-pre-wrap text-muted">{JSON.stringify(s.result).slice(0, 600)}</pre>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  );
}
