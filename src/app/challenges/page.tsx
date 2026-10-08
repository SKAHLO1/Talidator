"use client";

import { Gavel, Loader2 } from "lucide-react";
import { AssetIcon, Avatar, Button, Card, CardHeader, PageHeader, Stat, StatusBadge } from "@/components/ui";
import { countdown, short } from "@/lib/format";
import { useActions } from "@/lib/actions";
import { mon, useMe } from "@/lib/hooks";
import { useStore } from "@/lib/store";
import type { ValidationRequest } from "@/lib/types";

function Row({ r, children }: { r: ValidationRequest; children: React.ReactNode }) {
  const { dispatch } = useStore();
  return (
    <li className="flex flex-col gap-3 py-3.5 sm:flex-row sm:items-center sm:justify-between">
      <button className="flex items-center gap-3 text-left" onClick={() => dispatch({ type: "SELECT", id: r.id })}>
        <AssetIcon asset={r.asset} size={30} />
        <div>
          <p className="text-[13px] font-medium text-ink">#{r.id} · {r.asset}/{r.quote} · {r.task}</p>
          <p className="flex items-center gap-1.5 text-[11px] text-muted"><Avatar address={r.agent} size={14} /> {short(r.agent)} · {r.votes.filter((v) => v === "pass").length}/{r.votes.length} PASS</p>
        </div>
      </button>
      <div className="flex items-center gap-3">{children}</div>
    </li>
  );
}

export default function ChallengesPage() {
  const { state } = useStore();
  const actions = useActions();
  const me = useMe();
  const p = state.params;
  const open = state.requests.filter((r) => (r.status === "Validated" || r.status === "Rejected") && r.challengeWindow);
  const active = state.requests.filter((r) => r.status === "Challenged");
  const resolved = state.requests.filter((r) => r.challenger && r.status !== "Challenged");

  return (
    <>
      <PageHeader
        eyebrow="ChallengeMarket.sol"
        title="Challenge Market"
        description="After a quorum result finalizes, anyone can stake a bond disputing it. A fresh quorum re-checks the claim: if the challenger is right, the original validators are slashed and the challenger is paid from the slashed stake."
      />
      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Challenge bond" value={p ? mon(p.challengeBond) : "—"} />
        <Stat label="Challenge window" value={p ? `${Math.round(p.challengeWindowSec / 60)} min` : "—"} />
        <Stat label="Slash per wrong vote" value={p ? `${p.slashPercent}% of bond` : "—"} />
        <Stat label="Challenger cut" value={p ? `${p.challengerCutPercent}%` : "—"} sub="of slashed stake" />
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader title={`Open challenge windows (${open.length})`} />
          <ul className="divide-y divide-line px-4 pb-2">
            {open.length === 0 && (
              <li className="py-6 text-sm text-muted">
                No results are inside their challenge window right now. Results become challengeable as soon as a quorum finalizes.
              </li>
            )}
            {open.map((r) => (
              <Row key={r.id} r={r}>
                <span className="text-xs text-amber-600 tabular-nums">{countdown(r.challengeWindow)}</span>
                <Button variant="danger" className="px-3 py-1.5 text-xs" disabled={!me.connected || !p} onClick={() => actions.challenge(r.id)}>
                  <Gavel size={13} /> Challenge
                </Button>
              </Row>
            ))}
          </ul>
        </Card>

        <div className="flex flex-col gap-5">
          <Card>
            <CardHeader title={`Under re-verification (${active.length})`} />
            <ul className="divide-y divide-line px-4 pb-2">
              {active.length === 0 && <li className="py-6 text-sm text-muted">No active challenges.</li>}
              {active.map((r) => (
                <Row key={r.id} r={r}>
                  <span className="inline-flex items-center gap-1.5 text-xs text-muted"><Loader2 size={12} className="animate-spin" /> fresh quorum · {countdown(r.challengeResolveIn)}</span>
                  <StatusBadge status={r.status} />
                </Row>
              ))}
            </ul>
          </Card>
          <Card>
            <CardHeader title="Resolved" />
            <ul className="divide-y divide-line px-4 pb-2">
              {resolved.length === 0 && <li className="py-6 text-sm text-muted">Nothing resolved yet.</li>}
              {resolved.map((r) => (
                <Row key={r.id} r={r}>
                  <span className="text-xs text-muted">{r.status === "Overturned" ? "Challenger won · validators slashed" : "Challenger bond forfeited"}</span>
                  <StatusBadge status={r.status} />
                </Row>
              ))}
            </ul>
          </Card>
        </div>
      </div>
    </>
  );
}
