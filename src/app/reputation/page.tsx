"use client";

import { RankBadge } from "@/components/dashboard";
import { Avatar, Card, CardHeader, PageHeader, StatusBadge, TxLink } from "@/components/ui";
import { short } from "@/lib/format";
import { useStore } from "@/lib/store";

export default function ReputationPage() {
  const { state, dispatch } = useStore();
  const rows = [...state.reputation].sort((a, b) => b.score - a.score);
  const finalized = state.requests.filter((r) => r.finalized && (r.status === "Validated" || r.status === "Rejected" || r.status === "Overturned"));

  return (
    <>
      <PageHeader
        eyebrow="ReputationRegistry.sol"
        title="Reputation Registry"
        description="Feedback is only posted after a validation result is final — unchallenged, or challenge-resolved. Self-reported claims never move a score."
      />
      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader title="Leaderboard" />
          <div className="px-4 pb-4">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-muted"><tr className="border-b border-line"><th className="pb-2 font-normal">Rank</th><th className="pb-2 font-normal">Agent</th><th className="pb-2 font-normal">Feedback</th><th className="pb-2 text-right font-normal">Score</th></tr></thead>
              <tbody>
                {rows.map((r, i) => {
                  const agent = state.agents.find((a) => a.address === r.agent);
                  return (
                    <tr key={r.agent} className="border-b border-line last:border-0">
                      <td className="py-3"><RankBadge rank={i + 1} /></td>
                      <td className="py-3">
                        <span className="flex items-center gap-2.5">
                          <Avatar address={r.agent} size={24} />
                          <span>
                            <span className="block text-[13px] font-medium text-ink">{agent?.name ?? "Agent"}</span>
                            <span className="block font-mono text-[11px] text-muted">{short(r.agent)}</span>
                          </span>
                        </span>
                      </td>
                      <td className="py-3 text-xs text-muted">{r.feedback} validated</td>
                      <td className="py-3 text-right">
                        <div className="ml-auto flex w-32 items-center gap-2">
                          <div className="h-1.5 flex-1 rounded-full bg-slate-100"><div className="h-full rounded-full bg-teal" style={{ width: `${r.score}%` }} /></div>
                          <span className="rounded-md bg-teal-soft px-2 py-0.5 text-xs font-semibold text-teal-dark">{r.score.toFixed(1)}</span>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>

        <Card>
          <CardHeader title="Finalized outcomes feeding reputation" />
          <ul className="divide-y divide-line px-4 pb-2">
            {finalized.length === 0 && <li className="py-6 text-sm text-muted">No finalized outcomes yet.</li>}
            {finalized.map((r) => {
              const tx = r.txHashes[r.txHashes.length - 1];
              return (
                <li key={r.id} className="flex cursor-pointer items-center justify-between gap-3 py-3" onClick={() => dispatch({ type: "SELECT", id: r.id })}>
                  <div className="flex items-center gap-2.5">
                    <Avatar address={r.agent} size={24} />
                    <div>
                      <p className="text-[13px] font-medium text-ink">#{r.id} · {r.task}</p>
                      <p className="text-[11px] text-muted">
                        {r.status === "Validated" ? "Positive feedback posted" : r.status === "Rejected" ? "No feedback — payment refused" : "No feedback — result overturned"}
                        {" · "}<TxLink hash={tx.hash} />
                      </p>
                    </div>
                  </div>
                  <StatusBadge status={r.status} />
                </li>
              );
            })}
          </ul>
        </Card>
      </div>
    </>
  );
}
