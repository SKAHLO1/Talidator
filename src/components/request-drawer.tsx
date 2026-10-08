"use client";

import { Check, Circle, Loader2, X, XCircle, Gavel } from "lucide-react";
import { countdown, cx, short } from "@/lib/format";
import { useActions } from "@/lib/actions";
import { mon, useMe } from "@/lib/hooks";
import { useStore } from "@/lib/store";
import type { ValidationRequest } from "@/lib/types";
import { WatchButton } from "./account-ui";
import { AuditPanel } from "./audit-panel";
import { AssetIcon, Avatar, Button, StatusBadge, TxLink } from "./ui";

type StepState = "done" | "active" | "failed" | "todo";

function steps(r: ValidationRequest): { label: string; detail: string; state: StepState }[] {
  const cast = r.votes.filter((v) => v !== null).length;
  const passes = r.votes.filter((v) => v === "pass").length;
  const voting = r.status === "Pending" || r.status === "In Progress";
  const rejected = r.status === "Rejected";
  const challenged = r.status === "Challenged";
  const overturned = r.status === "Overturned";

  return [
    { label: "Request posted", detail: "validationRequest() on ValidationRegistry", state: "done" },
    {
      label: "Validators re-execute & vote",
      detail: `${cast}/${r.votes.length} votes cast`,
      state: voting ? "active" : "done",
    },
    {
      label: `Quorum tally (${r.threshold}-of-${r.votes.length})`,
      detail: voting ? "Waiting for votes" : `${passes} PASS · ${r.votes.length - passes - r.votes.filter((v) => v === null).length} FAIL`,
      state: voting ? "todo" : rejected ? "failed" : "done",
    },
    {
      label: "Escrow payment",
      detail:
        r.escrow === "none" ? "No payment escrowed"
          : r.escrow === "released" ? `${mon(r.payment)} released to trader`
            : r.escrow === "refunded" ? `${mon(r.payment)} refunded — payment refused`
              : rejected || overturned ? `${mon(r.payment)} held · refundable` : `${mon(r.payment)} held in escrow`,
      state: r.escrow === "released" ? "done" : r.escrow === "refunded" ? "failed" : "todo",
    },
    {
      label: "Challenge window",
      detail: challenged
        ? `Fresh quorum re-checking · review closes in ${countdown(r.challengeResolveIn)}`
        : overturned
          ? "Challenge upheld · validators slashed"
          : r.challengeWindow
            ? `${countdown(r.challengeWindow)} left to challenge`
            : r.finalized && !rejected ? "Closed — result final" : "—",
      state: challenged || r.challengeWindow ? "active" : overturned ? "failed" : r.finalized && !rejected ? "done" : "todo",
    },
  ];
}

function StepIcon({ state }: { state: StepState }) {
  if (state === "done") return <span className="flex h-6 w-6 items-center justify-center rounded-full bg-emerald-500 text-white"><Check size={14} strokeWidth={3} /></span>;
  if (state === "failed") return <span className="flex h-6 w-6 items-center justify-center rounded-full bg-rose-500 text-white"><X size={14} strokeWidth={3} /></span>;
  if (state === "active") return <span className="flex h-6 w-6 items-center justify-center rounded-full bg-blue-50 text-blue-600 ring-1 ring-blue-200"><Loader2 size={14} className="animate-spin" /></span>;
  return <span className="flex h-6 w-6 items-center justify-center rounded-full bg-slate-100 text-slate-300"><Circle size={10} /></span>;
}

export function RequestDrawer() {
  const { state, dispatch } = useStore();
  const actions = useActions();
  const me = useMe();
  const r = state.requests.find((x) => x.id === state.selectedId);
  if (!r) return null;
  const agent = state.agents.find((a) => a.address === r.agent);
  const close = () => dispatch({ type: "SELECT", id: null });

  return (
    <div className="fixed inset-0 z-40">
      <div className="absolute inset-0 bg-navy/30" onClick={close} />
      <aside className="animate-slide-in absolute inset-y-0 right-0 flex w-full max-w-md flex-col overflow-y-auto bg-white shadow-2xl">
        <div className="flex items-start justify-between border-b border-line p-5">
          <div className="flex items-center gap-3">
            <AssetIcon asset={r.asset} size={36} />
            <div>
              <p className="text-xs text-muted">Request #{r.id}</p>
              <p className="font-semibold text-ink">{r.asset} / {r.quote} · {r.task}</p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <WatchButton kind="request" refId={r.requestHash} label={`#${r.id} · ${r.asset}/${r.quote} · ${r.task}`} className="p-1.5" />
            <button onClick={close} className="rounded-lg p-1 text-muted hover:bg-slate-100" aria-label="Close"><X size={18} /></button>
          </div>
        </div>

        <div className="space-y-6 p-5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Avatar address={r.agent} size={28} />
              <div>
                <p className="text-sm font-medium text-ink">{agent?.name ?? "Agent"}</p>
                <p className="font-mono text-xs text-muted">{short(r.agent)}</p>
              </div>
            </div>
            <StatusBadge status={r.status} />
          </div>

          <ol className="relative space-y-4">
            {steps(r).map((s, i, arr) => (
              <li key={s.label} className="relative flex gap-3">
                {i < arr.length - 1 && <span className="absolute top-7 left-3 h-[calc(100%-4px)] w-px bg-line" />}
                <StepIcon state={s.state} />
                <div>
                  <p className={cx("text-sm font-medium", s.state === "todo" ? "text-muted" : "text-ink")}>{s.label}</p>
                  <p className="text-xs text-muted">{s.detail}</p>
                </div>
              </li>
            ))}
          </ol>

          <div>
            <p className="mb-2 text-xs font-medium tracking-wide text-muted uppercase">Validator votes</p>
            <div className="divide-y divide-line rounded-xl border border-line">
              {r.validators.map((v, i) => {
                const vote = r.votes[i];
                const val = state.validators.find((x) => x.address === v);
                return (
                  <div key={v} className="flex items-center justify-between px-3 py-2.5">
                    <div className="flex items-center gap-2">
                      <Avatar address={v} size={22} />
                      <div>
                        <p className="text-sm text-ink">{val?.name ?? short(v)}</p>
                        <p className="font-mono text-[11px] text-muted">{short(v)} · {mon(val?.stake ?? 0)} bonded</p>
                      </div>
                    </div>
                    {vote === "pass" ? (
                      <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-600"><Check size={14} /> PASS</span>
                    ) : vote === "fail" ? (
                      <span className="inline-flex items-center gap-1 text-xs font-medium text-rose-600"><XCircle size={14} /> FAIL</span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-xs text-muted"><Loader2 size={12} className="animate-spin" /> re-executing</span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          <AuditPanel key={r.requestHash} requestHash={r.requestHash} challengeOpen={!!r.challengeWindow} />

          {(r.status === "Validated" || r.status === "Rejected") && r.challengeWindow ? (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
              <p className="text-sm font-medium text-amber-900">Think this result is wrong?</p>
              <p className="mt-1 text-xs text-amber-800">
                Stake a {mon(state.params?.challengeBond ?? 0)} bond. A fresh quorum re-checks the claim — if you&apos;re right, the original validators are slashed and you earn a cut.
              </p>
              <Button variant="danger" className="mt-3" onClick={() => actions.challenge(r.id)} disabled={!me.connected || !state.params}>
                <Gavel size={15} /> Challenge result · {countdown(r.challengeWindow)} left
              </Button>
            </div>
          ) : null}

          {r.escrow === "funded" && (r.status === "Validated" || r.status === "Rejected" || r.status === "Overturned") && (
            <div className="rounded-xl border border-line p-4">
              <p className="text-sm font-medium text-ink">Settle escrow</p>
              <p className="mt-1 text-xs text-muted">
                {r.status === "Validated"
                  ? r.challengeWindow
                    ? "The quorum passed. Release is allowed now, but waiting until the challenge window closes protects the payer."
                    : "The result is final. Anyone can release the payment to the trader."
                  : "The result failed, so the payer can be refunded. Anyone can trigger it."}
              </p>
              <Button variant="secondary" className="mt-3" disabled={!me.connected} onClick={() => actions.settleEscrow(r.id, r.status === "Validated")}>
                {r.status === "Validated" ? `Release ${mon(r.payment)}` : `Refund ${mon(r.payment)}`}
              </Button>
            </div>
          )}

          <div>
            <p className="mb-2 text-xs font-medium tracking-wide text-muted uppercase">Transactions</p>
            {r.txHashes.length === 0 && (
              <p className="text-xs text-muted">{state.sync.backfilling ? "Indexing event history…" : "No events found in the indexed block range."}</p>
            )}
            <ul className="space-y-2">
              {r.txHashes.map((t, i) => (
                <li key={`${t.hash}-${i}`} className="flex items-center justify-between gap-3 rounded-lg bg-slate-50 px-3 py-2">
                  <span className="truncate text-xs text-ink">{t.label}</span>
                  <TxLink hash={t.hash} />
                </li>
              ))}
            </ul>
            <p className="mt-3 font-mono text-[11px] break-all text-muted">requestHash {r.requestHash}</p>
          </div>
        </div>
      </aside>
    </div>
  );
}
