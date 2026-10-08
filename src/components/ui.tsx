"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { Bot, ShieldCheck, UserRound, Swords } from "lucide-react";
import { explorerTx } from "@/lib/chain/config";
import { cx } from "@/lib/format";
import { useStore } from "@/lib/store";
import type { Asset, RequestStatus, Vote } from "@/lib/types";

export function Logo({ className = "h-8 w-8" }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" fill="none" className={className} aria-hidden>
      <path d="M16 2 30 16 16 30 2 16Z" stroke="#3fbfae" strokeWidth="2" strokeLinejoin="round" />
      <path d="M16 8 24 16 16 24 8 16Z" stroke="#3fbfae" strokeWidth="2" strokeLinejoin="round" />
      <path d="M16 13 19 16 16 19 13 16Z" fill="#3fbfae" />
    </svg>
  );
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <section className={cx("card", className)}>{children}</section>;
}

export function CardHeader({ title, href, action, className }: { title: string; href?: string; action?: ReactNode; className?: string }) {
  return (
    <div className={cx("flex items-center justify-between px-4 pt-4 pb-3", className)}>
      <h2 className="text-[15px] font-semibold text-ink">{title}</h2>
      {action ?? (href && (
        <Link href={href} className="text-xs font-medium text-teal hover:text-teal-dark">View All</Link>
      ))}
    </div>
  );
}

const statusStyles: Record<RequestStatus, string> = {
  "In Progress": "bg-blue-50 text-blue-600 ring-blue-100",
  Pending: "bg-amber-50 text-amber-600 ring-amber-100",
  Validated: "bg-emerald-50 text-emerald-600 ring-emerald-100",
  Challenged: "bg-rose-50 text-rose-600 ring-rose-100",
  Rejected: "bg-red-50 text-red-600 ring-red-100",
  Overturned: "bg-slate-100 text-slate-600 ring-slate-200",
};

export function StatusBadge({ status }: { status: RequestStatus }) {
  return (
    <span className={cx("inline-flex items-center rounded-md px-2.5 py-1 text-xs font-medium ring-1 ring-inset whitespace-nowrap", statusStyles[status])}>
      {status}
    </span>
  );
}

const palette = ["#6d5dd3", "#3b5bdb", "#d6409f", "#7048e8", "#1c7ed6", "#0c8599", "#e8590c"];

function colorFor(address: string) {
  let h = 0;
  for (const c of address) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return palette[h % palette.length];
}

export function Avatar({ address, size = 24, className }: { address: string; size?: number; className?: string }) {
  const { state } = useStore();
  const agent = state.agents.find((a) => a.address === address);
  const role = agent?.role ?? "validator";
  const icon = Math.round(size * 0.55);

  if (role === "trader") {
    return (
      <span
        className={cx("inline-flex shrink-0 items-center justify-center rounded-full", agent?.adversarial ? "bg-rose-100 text-rose-700" : "bg-slate-200 text-slate-700", className)}
        style={{ width: size, height: size }}
      >
        <Bot size={icon} strokeWidth={2.2} />
      </span>
    );
  }
  const Icon = role === "challenger" ? Swords : agent?.name === "Validator Agent" ? ShieldCheck : UserRound;
  return (
    <span
      className={cx("inline-flex shrink-0 items-center justify-center rounded-full text-white", className)}
      style={{ width: size, height: size, background: colorFor(address) }}
    >
      <Icon size={icon} strokeWidth={2.2} />
    </span>
  );
}

const assetStyle: Record<Asset, { bg: string; glyph: ReactNode }> = {
  ETH: {
    bg: "#627eea",
    glyph: (
      <svg viewBox="0 0 16 16" className="h-3.5 w-3.5"><path d="M8 1 3.5 8.2 8 10.8l4.5-2.6Z" fill="#fff" /><path d="M8 11.7 3.5 9.1 8 15l4.5-5.9Z" fill="#fff" opacity=".75" /></svg>
    ),
  },
  BTC: { bg: "#f7931a", glyph: <span className="text-[13px] font-bold text-white">₿</span> },
  LINK: {
    bg: "#2a5ada",
    glyph: (
      <svg viewBox="0 0 16 16" className="h-3.5 w-3.5"><path d="M8 2 13 5v6l-5 3-5-3V5Z" fill="none" stroke="#fff" strokeWidth="1.8" /></svg>
    ),
  },
};

export function AssetIcon({ asset, size = 26 }: { asset: Asset; size?: number }) {
  const s = assetStyle[asset];
  return (
    <span className="inline-flex shrink-0 items-center justify-center rounded-full" style={{ width: size, height: size, background: s.bg }}>
      {s.glyph}
    </span>
  );
}

export function VoteDots({ validators, votes }: { validators: string[]; votes: Vote[] }) {
  const cast = votes.filter((v) => v !== null).length;
  return (
    <div className="flex flex-col items-start gap-0.5">
      <span className="text-xs font-medium text-ink">{cast} / {votes.length}</span>
      <div className="flex -space-x-1">
        {validators.map((v, i) => (
          <span key={v + i} className={cx("rounded-full ring-2", votes[i] === "pass" ? "ring-emerald-400" : votes[i] === "fail" ? "ring-red-400" : "ring-white opacity-60")}>
            <Avatar address={v} size={14} />
          </span>
        ))}
        <span className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-slate-700 text-[8px] font-bold text-white ring-2 ring-white">
          {votes.filter((v) => v === "pass").length}
        </span>
      </div>
    </div>
  );
}

export function Button({
  children, onClick, variant = "primary", className, type = "button", disabled,
}: {
  children: ReactNode; onClick?: () => void; variant?: "primary" | "secondary" | "ghost" | "danger" | "outline-light";
  className?: string; type?: "button" | "submit"; disabled?: boolean;
}) {
  const styles = {
    primary: "bg-teal text-white hover:bg-teal-dark shadow-sm",
    secondary: "bg-white text-ink ring-1 ring-inset ring-line hover:bg-slate-50",
    ghost: "text-muted hover:bg-slate-100 hover:text-ink",
    danger: "bg-rose-600 text-white hover:bg-rose-700",
    "outline-light": "bg-transparent text-white ring-1 ring-inset ring-white/70 hover:bg-white/10",
  }[variant];
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={cx("inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50", styles, className)}
    >
      {children}
    </button>
  );
}

export function PageHeader({ eyebrow, title, description, action }: { eyebrow?: string; title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div>
        {eyebrow && <p className="mb-1 text-xs font-medium uppercase tracking-[0.14em] text-teal">{eyebrow}</p>}
        <h1 className="text-2xl font-semibold tracking-tight text-ink">{title}</h1>
        {description && <p className="mt-1 max-w-2xl text-sm text-muted">{description}</p>}
      </div>
      {action}
    </div>
  );
}

export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="card p-4">
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-2 text-xl font-semibold text-ink">{value}</p>
      {sub && <p className="mt-1 text-xs text-muted">{sub}</p>}
    </div>
  );
}

export function TxLink({ hash, label }: { hash: string; label?: string }) {
  const text = label ?? `${hash.slice(0, 8)}…${hash.slice(-6)}`;
  return (
    <a
      href={explorerTx(hash)}
      target="_blank"
      rel="noreferrer"
      className="font-mono text-[11px] text-teal hover:underline"
      title={hash}
    >
      {text}
    </a>
  );
}
