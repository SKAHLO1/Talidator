"use client";

import Link from "next/link";
import { ArrowRight, BadgeCheck, Check, Crown, Gavel, MoreHorizontal, ArrowUpRight, UserRound, AlertTriangle, XCircle, Send, Star, Vote } from "lucide-react";
import { chain } from "@/lib/chain/config";
import { ago, countdown, cx, short } from "@/lib/format";
import { useViewer } from "@/lib/account/mine";
import { mon, sameAddr } from "@/lib/hooks";
import { useStore } from "@/lib/store";
import type { Activity, ActivityKind, ValidationRequest } from "@/lib/types";
import { WatchButton } from "./account-ui";
import { HeroArt } from "./hero-art";
import { AssetIcon, Avatar, Card, CardHeader, StatusBadge, TxLink, VoteDots } from "./ui";

export function Hero() {
  const { dispatch } = useStore();
  return (
    <section className="hero-bg relative overflow-hidden rounded-xl text-white">
      <div className="relative z-10 flex flex-col gap-6 p-6 sm:p-10 md:max-w-[58%]">
        <p className="text-xs font-medium tracking-[0.16em] text-slate-300 uppercase">Validation Registry</p>
        <h1 className="text-[28px] leading-[1.15] font-semibold tracking-tight sm:text-[32px]">
          Independent validation<br className="hidden sm:block" /> for trustworthy agents.
        </h1>
        <p className="max-w-md text-[15px] leading-6 text-slate-200">
          Agents re-execute, vote, and stake. Only validated results unlock payment.
        </p>
        <div className="flex flex-wrap gap-4">
          <button onClick={() => dispatch({ type: "START_OPEN", open: true })} className="inline-flex items-center gap-3 rounded-lg bg-teal px-5 py-3 text-sm font-medium text-white shadow-lg shadow-teal/20 transition hover:bg-teal-dark">
            Start Validation <ArrowRight size={16} />
          </button>
          <a href="https://eips.ethereum.org/EIPS/eip-8004" target="_blank" rel="noreferrer" className="inline-flex items-center rounded-lg px-7 py-3 text-sm font-medium ring-1 ring-white/70 ring-inset transition hover:bg-white/10">
            View Docs
          </a>
        </div>
      </div>
      <HeroArt className="pointer-events-none absolute top-1/2 right-0 hidden h-[108%] max-w-[44%] -translate-y-1/2 md:block lg:right-4" />
    </section>
  );
}

export function NetworkPanel() {
  const { state } = useStore();
  const s = state.stats;
  const cells = [
    { label: "Total Validators", value: s.totalValidators },
    { label: "Total Requests", value: s.totalRequests },
    { label: "Active Challenges", value: s.activeChallenges },
    { label: "Slashed Stake", value: mon(s.slashed, 3) },
  ];
  return (
    <Card className="p-4">
      <div className="border-b border-line pb-4">
        <p className="text-sm text-muted">Network</p>
        <p className="mt-2 flex items-center gap-2 text-sm font-medium text-ink">
          <span className={cx("h-2 w-2 rounded-full", state.sync.status === "ok" ? "bg-teal" : "bg-rose-500")} /> {chain.name}
        </p>
      </div>
      <div className="border-b border-line py-4">
        <p className="text-sm text-muted">Total Value Locked</p>
        <p className="mt-1 flex items-baseline gap-3">
          <span className="text-[22px] font-semibold text-ink tabular-nums">{mon(s.tvl, 3)}</span>
        </p>
        <p className="mt-1 text-[11px] text-muted">Validator bonds + escrow + challenge bonds</p>
      </div>
      <div className="grid grid-cols-2">
        {cells.map((c, i) => (
          <div key={c.label} className={cx("py-4", i % 2 === 0 ? "border-r border-line pr-4" : "pl-6", i < 2 && "border-b border-line")}>
            <p className="text-xs text-muted">{c.label}</p>
            <p className="mt-2 text-[15px] font-semibold text-ink tabular-nums">{c.value}</p>
          </div>
        ))}
      </div>
    </Card>
  );
}

function timeLeft(r: ValidationRequest) {
  if (r.status === "Pending" || r.status === "In Progress") return <span className="text-ink tabular-nums">{countdown(r.secondsLeft)}</span>;
  if ((r.status === "Validated" || r.status === "Rejected") && r.challengeWindow)
    return (
      <span className="inline-flex items-center gap-1 text-amber-600 tabular-nums" title="Challenge window open">
        <Gavel size={12} /> {countdown(r.challengeWindow)}
      </span>
    );
  if (r.status === "Challenged" && r.challengeResolveIn)
    return <span className="text-rose-600 tabular-nums">Re-check {r.challengeResolveIn}s</span>;
  return <span className="text-muted">—</span>;
}

export function RequestsTable({ requests, title = "Active Validation Requests", href = "/validation", action, emptyText = "No requests match this filter." }: {
  requests: ValidationRequest[]; title?: string; href?: string; action?: React.ReactNode; emptyText?: string;
}) {
  const { dispatch } = useStore();
  return (
    <Card>
      <CardHeader title={title} href={href} action={action} className="pb-4" />
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] text-left text-sm">
          <thead>
            <tr className="border-y border-line bg-slate-50/60 text-xs text-muted">
              <th className="py-2.5 pl-4 font-normal">ID</th>
              <th className="py-2.5 font-normal">Trader Agent</th>
              <th className="py-2.5 font-normal">Asset / Task</th>
              <th className="py-2.5 font-normal">Validators</th>
              <th className="py-2.5 font-normal">Status</th>
              <th className="py-2.5 font-normal">Time Left</th>
              <th className="py-2.5 pr-4" />
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {requests.length === 0 && (
              <tr><td colSpan={7} className="py-10 text-center text-sm text-muted">{emptyText}</td></tr>
            )}
            {requests.map((r) => (
              <tr key={r.id} onClick={() => dispatch({ type: "SELECT", id: r.id })} className="cursor-pointer transition hover:bg-slate-50/80">
                <td className="py-3.5 pl-4 text-[13px] font-semibold text-ink">#{r.id}</td>
                <td className="py-3.5">
                  <span className="flex items-center gap-2 text-[13px] text-muted">
                    <Avatar address={r.agent} size={22} /> {short(r.agent)}
                  </span>
                </td>
                <td className="py-3.5">
                  <span className="flex items-center gap-2.5">
                    <AssetIcon asset={r.asset} />
                    <span>
                      <span className="block text-xs font-medium text-ink">{r.asset} / {r.quote}</span>
                      <span className="block text-[11px] text-muted">{r.task}</span>
                    </span>
                  </span>
                </td>
                <td className="py-3.5"><VoteDots validators={r.validators} votes={r.votes} /></td>
                <td className="py-3.5"><StatusBadge status={r.status} /></td>
                <td className="py-3.5 text-xs">{timeLeft(r)}</td>
                <td className="py-3.5 pr-4 text-right whitespace-nowrap">
                  <WatchButton kind="request" refId={r.requestHash} label={`#${r.id} · ${r.asset}/${r.quote} · ${r.task}`} />
                  <button className="rounded-md p-1 text-ink hover:bg-slate-100" aria-label={`Open request ${r.id}`}>
                    <MoreHorizontal size={16} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

export function YourAgents() {
  const { state } = useStore();
  const { address, account } = useViewer();
  const mine = state.agents
    .filter((a) => address && (sameAddr(a.owner, address) || sameAddr(a.address, address)))
    .slice(0, 3);
  return (
    <Card>
      <CardHeader title="Your Agents" href="/identity" />
      <div className="space-y-1 px-4 pb-4">
        {!address && <p className="py-4 text-sm text-muted">Connect a wallet to see your agents.</p>}
        {address && mine.length === 0 && (
          <p className="py-4 text-sm text-muted">
            No agents owned by this wallet. <Link href="/identity" className="text-teal hover:underline">Register one</Link>.
          </p>
        )}
        {address && mine.map((a) => (
          <div key={a.address} className="flex items-center gap-4 py-2.5">
            {a.role === "trader" ? (
              <span className="flex h-11 w-11 items-center justify-center rounded-full bg-slate-100 ring-4 ring-slate-50"><Avatar address={a.address} size={34} /></span>
            ) : (
              <span className="flex h-11 w-11 items-center justify-center rounded-full bg-teal text-white ring-4 ring-teal-soft"><BadgeCheck size={22} /></span>
            )}
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-ink">
                {a.name}
                {account.notes[a.address.toLowerCase()]?.label && (
                  <span className="ml-1.5 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-normal text-muted">{account.notes[a.address.toLowerCase()].label}</span>
                )}
              </p>
              <p className="text-xs text-muted">{short(a.address)}</p>
            </div>
            <span className="inline-flex items-center gap-1 rounded-md bg-teal-soft px-2 py-1 text-[10px] font-medium text-teal-dark" title="ERC-8004 identity token">
              <Check size={10} /> ID #{a.tokenId}
            </span>
          </div>
        ))}
      </div>
    </Card>
  );
}

const activityStyle: Record<ActivityKind, { icon: typeof Check; cls: string }> = {
  validated: { icon: Check, cls: "bg-teal-soft text-teal" },
  payment: { icon: ArrowUpRight, cls: "bg-teal-soft text-teal" },
  "challenge-won": { icon: AlertTriangle, cls: "bg-rose-50 text-rose-500" },
  "challenge-lost": { icon: Gavel, cls: "bg-slate-100 text-slate-500" },
  challenge: { icon: Gavel, cls: "bg-amber-50 text-amber-600" },
  rejected: { icon: XCircle, cls: "bg-rose-50 text-rose-500" },
  registered: { icon: UserRound, cls: "bg-indigo-50 text-indigo-500" },
  request: { icon: Send, cls: "bg-blue-50 text-blue-500" },
  vote: { icon: Vote, cls: "bg-slate-100 text-slate-600" },
  reputation: { icon: Star, cls: "bg-amber-50 text-amber-500" },
};

export function RecentActivity({ limit = 4, showVotes = false, source, title = "Recent Activity", emptyText = "No on-chain activity yet." }: {
  limit?: number; showVotes?: boolean; source?: Activity[]; title?: string; emptyText?: string;
}) {
  const { state } = useStore();
  const items = (source ?? state.activity).filter((a) => showVotes || a.kind !== "vote").slice(0, limit);
  return (
    <Card>
      <CardHeader title={title} href="/validation" />
      <ul className="divide-y divide-line px-4 pb-2">
        {items.length === 0 && <li className="py-4 text-sm text-muted">{emptyText}</li>}
        {items.map((a) => {
          const s = activityStyle[a.kind];
          return (
            <li key={a.id} className="animate-slide-in flex gap-4 py-3.5">
              <span className={cx("mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full", s.cls)}><s.icon size={13} strokeWidth={2.5} /></span>
              <div className="min-w-0">
                <p className="text-xs font-medium text-ink">{a.title}</p>
                <p className="mt-1 truncate text-[11px] text-muted">{a.detail}</p>
                <p className="mt-1 flex items-center gap-2 text-[11px] text-muted">
                  {ago(a.ago)} {a.txHash && <TxLink hash={a.txHash} />}
                </p>
              </div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

export function WatchlistCard() {
  const { state, dispatch } = useStore();
  const { account } = useViewer();
  if (account.status !== "signed-in") return null;
  const items = account.watchlist;
  return (
    <Card>
      <CardHeader title="Watchlist" href="/account#watchlist" />
      <ul className="divide-y divide-line px-4 pb-2">
        {items.length === 0 && (
          <li className="py-4 text-sm text-muted">Star an agent or request to follow it here and get alerts for it.</li>
        )}
        {items.slice(0, 6).map((w) => {
          const request = w.kind === "request" ? state.requests.find((r) => r.requestHash.toLowerCase() === w.ref) : undefined;
          const agent = w.kind === "agent" ? state.agents.find((a) => a.address.toLowerCase() === w.ref) : undefined;
          return (
            <li key={w.ref} className="flex items-center gap-3 py-2.5">
              {agent ? <Avatar address={agent.address} size={22} /> : request ? <AssetIcon asset={request.asset} size={22} /> : <span className="h-[22px] w-[22px] rounded-full bg-slate-100" />}
              <button
                className="min-w-0 flex-1 text-left"
                disabled={!request}
                onClick={() => request && dispatch({ type: "SELECT", id: request.id })}
              >
                <span className="block truncate text-xs font-medium text-ink">{w.label || short(w.ref)}</span>
                <span className="block text-[11px] text-muted">
                  {request ? `#${request.id} · ${request.status}` : agent ? `${agent.role} · ID #${agent.tokenId}` : w.kind === "request" ? "Older request" : short(w.ref)}
                </span>
              </button>
              <WatchButton kind={w.kind} refId={w.ref} label={w.label} />
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

export function ValidatorPerformance({ limit = 4 }: { limit?: number }) {
  const { state } = useStore();
  return (
    <Card className="h-full">
      <CardHeader title="Validator Performance" href="/staking" className="pb-5" />
      <div className="overflow-x-auto px-4 pb-3">
        <table className="w-full text-left text-[11px]">
          <thead className="text-muted">
            <tr className="border-b border-line"><th className="pb-2 font-normal">Validator</th><th className="pb-2 font-normal">Success Rate</th><th className="pb-2 font-normal">Total Votes</th><th className="pb-2 font-normal">Stake</th></tr>
          </thead>
          <tbody>
            {state.validators.length === 0 && (
              <tr><td colSpan={4} className="py-4 text-muted">No validators bonded yet.</td></tr>
            )}
            {state.validators.slice(0, limit).map((v) => (
              <tr key={v.address}>
                <td className="py-2.5"><span className="flex items-center gap-2 text-muted"><Avatar address={v.address} size={20} />{short(v.address)}</span></td>
                <td className="py-2.5 text-muted">{v.successRate}%</td>
                <td className="py-2.5 text-muted">{v.totalVotes}</td>
                <td className={cx("py-2.5 whitespace-nowrap", v.status === "slashed" ? "text-rose-600" : "text-muted")}>{mon(v.stake, 3)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

export function RankBadge({ rank }: { rank: number }) {
  if (rank === 1) return <Crown size={14} className="text-amber-400" fill="currentColor" />;
  const cls = rank === 2 ? "bg-slate-200 text-slate-700" : rank === 3 ? "bg-orange-100 text-orange-700" : "text-ink";
  return <span className={cx("inline-flex h-4 w-4 items-center justify-center rounded text-[10px] font-semibold", cls)}>{rank}</span>;
}

export function ReputationLeaderboard({ limit = 5 }: { limit?: number }) {
  const { state } = useStore();
  const rows = [...state.reputation].sort((a, b) => b.score - a.score).slice(0, limit);
  return (
    <Card className="h-full">
      <CardHeader title="Reputation Leaderboard" href="/reputation" className="pb-5" />
      <div className="px-4 pb-3">
        <table className="w-full text-left text-[11px]">
          <thead className="text-muted"><tr className="border-b border-line"><th className="pb-2 font-normal">Rank</th><th className="pb-2 font-normal">Agent</th><th className="pb-2 text-right font-normal">Reputation</th></tr></thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={3} className="py-4 text-muted">No final outcomes yet — scores post once a challenge window closes.</td></tr>
            )}
            {rows.map((r, i) => (
              <tr key={r.agent}>
                <td className="py-2.5"><RankBadge rank={i + 1} /></td>
                <td className="py-2.5"><span className="flex items-center gap-2 text-muted"><Avatar address={r.agent} size={18} />{short(r.agent)}</span></td>
                <td className="py-2.5 text-right"><span className="rounded-md bg-teal-soft px-2 py-1 font-semibold text-teal-dark">{r.score.toFixed(1)}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

export function TopStakers({ limit = 5 }: { limit?: number }) {
  const { state } = useStore();
  const rows = [...state.validators].sort((a, b) => b.stake - a.stake).slice(0, limit);
  return (
    <Card className="h-full">
      <CardHeader title="Top Stakers" href="/staking" className="pb-5" />
      <div className="px-4 pb-3">
        <table className="w-full text-left text-[11px]">
          <thead className="text-muted"><tr className="border-b border-line"><th className="pb-2 font-normal">Rank</th><th className="pb-2 font-normal">Validator</th><th className="pb-2 text-right font-normal">Stake</th></tr></thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={3} className="py-4 text-muted">No stake bonded yet.</td></tr>
            )}
            {rows.map((v, i) => (
              <tr key={v.address}>
                <td className="py-2.5"><RankBadge rank={i + 1} /></td>
                <td className="py-2.5"><span className="flex items-center gap-2 text-muted"><Avatar address={v.address} size={18} />{short(v.address)}</span></td>
                <td className="py-2.5 text-right text-muted">{mon(v.stake, 3)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

export function ViewAllLink({ href }: { href: string }) {
  return <Link href={href} className="text-xs font-medium text-teal hover:text-teal-dark">View All</Link>;
}
