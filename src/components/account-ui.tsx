"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Bell, LogIn, Loader2, Star } from "lucide-react";
import { useConnection } from "wagmi";
import { useAccount } from "@/lib/account/account";
import { useMine } from "@/lib/account/mine";
import { ago, cx, short } from "@/lib/format";
import { useStore } from "@/lib/store";
import type { WatchItem } from "@/lib/account/model";

/** Sign-in button (connected wallet, no session) or the signed-in profile chip. */
export function AccountButton() {
  const account = useAccount();
  const conn = useConnection();
  if (account.status === "disabled" || !conn.isConnected) return null;

  if (account.status === "signed-in" && account.uid) {
    const name = account.profile?.displayName || short(account.uid);
    return (
      <Link href="/account" className="inline-flex items-center gap-2 rounded-lg border border-line bg-white py-1.5 pr-3 pl-1.5 text-xs font-medium text-ink shadow-sm hover:bg-slate-50" title="Your account">
        <ProfileAvatar url={account.profile?.avatarUrl} name={name} size={22} />
        <span className="max-w-[120px] truncate">{name}</span>
      </Link>
    );
  }
  const busy = account.status === "signing-in" || account.status === "loading";
  return (
    <button
      onClick={account.signIn}
      disabled={busy}
      className="inline-flex items-center gap-2 rounded-lg border border-teal bg-white px-3 py-1.5 text-xs font-medium text-teal-dark shadow-sm hover:bg-teal-soft disabled:opacity-60"
      title="Sign a message to unlock your personal dashboard"
    >
      {busy ? <Loader2 size={14} className="animate-spin" /> : <LogIn size={14} />}
      {account.status === "signing-in" ? "Check your wallet…" : "Sign in"}
    </button>
  );
}

export function ProfileAvatar({ url, name, size = 28 }: { url?: string; name: string; size?: number }) {
  const [broken, setBroken] = useState(false);
  if (url && !broken) {
    // eslint-disable-next-line @next/next/no-img-element -- arbitrary user-supplied URL; next/image would need every host allow-listed
    return <img src={url} alt="" width={size} height={size} onError={() => setBroken(true)} className="shrink-0 rounded-full object-cover" style={{ width: size, height: size }} />;
  }
  return (
    <span className="flex shrink-0 items-center justify-center rounded-full bg-navy-2 text-[10px] font-semibold text-[#5fd3c4] uppercase" style={{ width: size, height: size }}>
      {name.replace(/^0x/, "").slice(0, 2)}
    </span>
  );
}

/** In-app alerts for on-chain events involving the user or their watchlist. */
export function AlertsBell() {
  const account = useAccount();
  const { alerts, unread } = useMine();
  const { dispatch, state } = useStore();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  if (account.status !== "signed-in") return null;
  const seenAt = account.profile?.alertsSeenAt ?? 0;

  const toggle = () => {
    setOpen((o) => !o);
    if (!open && unread > 0) account.markAlertsSeen();
  };
  const openRequest = (hash?: string) => {
    const r = hash && state.requests.find((x) => x.requestHash.toLowerCase() === hash.toLowerCase());
    if (r) dispatch({ type: "SELECT", id: r.id });
    setOpen(false);
  };

  return (
    <div className="relative" ref={ref}>
      <button onClick={toggle} className="relative flex h-8 w-8 items-center justify-center rounded-lg border border-line bg-white text-ink shadow-sm hover:bg-slate-50" aria-label={`Alerts${unread ? ` (${unread} unread)` : ""}`}>
        <Bell size={15} />
        {unread > 0 && (
          <span className="absolute -top-1.5 -right-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-rose-500 px-1 text-[9px] font-bold text-white">
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 z-30 mt-2 w-80 overflow-hidden rounded-xl border border-line bg-white shadow-lg">
          <div className="flex items-center justify-between border-b border-line px-3 py-2.5">
            <p className="text-sm font-semibold text-ink">Alerts</p>
            <Link href="/account#alerts" onClick={() => setOpen(false)} className="text-[11px] font-medium text-teal hover:underline">Preferences</Link>
          </div>
          <ul className="max-h-96 divide-y divide-line overflow-y-auto">
            {alerts.length === 0 && (
              <li className="px-3 py-6 text-center text-xs text-muted">No alerts yet. Events on your agents, requests and watchlist show up here.</li>
            )}
            {alerts.slice(0, 40).map((a) => (
              <li key={a.id}>
                <button onClick={() => openRequest(a.requestHash)} className="flex w-full gap-2.5 px-3 py-2.5 text-left hover:bg-slate-50">
                  <span className={cx("mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full", a.at > seenAt ? "bg-rose-500" : "bg-transparent")} />
                  <span className="min-w-0">
                    <span className="block text-xs font-medium text-ink">{a.title}</span>
                    <span className="block truncate text-[11px] text-muted">{a.detail}</span>
                    <span className="block text-[10px] text-muted">{ago(a.ago)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** A private label on an agent, editable inline. Only visible to the signed-in user. */
export function AgentLabel({ agent }: { agent: string }) {
  const account = useAccount();
  const [draft, setDraft] = useState<string | null>(null);
  if (account.status !== "signed-in") return null;
  const note = account.notes[agent.toLowerCase()];

  if (draft !== null) {
    const save = () => {
      account.setNote(agent, draft, note?.note ?? "");
      setDraft(null);
    };
    return (
      <input
        autoFocus
        value={draft}
        maxLength={40}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Enter") save();
          if (e.key === "Escape") setDraft(null);
        }}
        placeholder="Private label"
        className="w-28 rounded border border-teal px-1.5 py-0.5 text-[11px] outline-none"
      />
    );
  }
  return (
    <button
      type="button"
      onClick={() => setDraft(note?.label ?? "")}
      className={cx("rounded px-1.5 py-0.5 text-[10px]", note?.label ? "bg-slate-100 text-muted hover:bg-slate-200" : "text-slate-400 hover:text-teal")}
      title="Private label — only you see this"
    >
      {note?.label || "+ label"}
    </button>
  );
}

/** Star toggle for the user's watchlist. Hidden when accounts aren't available. */
export function WatchButton({ kind, refId, label, className }: { kind: WatchItem["kind"]; refId: string; label: string; className?: string }) {
  const account = useAccount();
  if (account.status === "disabled") return null;
  const watched = account.isWatched(refId);
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        account.toggleWatch(kind, refId, label);
      }}
      className={cx("inline-flex items-center justify-center rounded-md p-1 transition hover:bg-slate-100", watched ? "text-amber-500" : "text-slate-300 hover:text-slate-500", className)}
      title={account.status !== "signed-in" ? "Sign in to use a watchlist" : watched ? "Remove from watchlist" : "Add to watchlist"}
      aria-label={watched ? "Remove from watchlist" : "Add to watchlist"}
      aria-pressed={watched}
    >
      <Star size={15} fill={watched ? "currentColor" : "none"} />
    </button>
  );
}
