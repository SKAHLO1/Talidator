"use client";

import { useState, type FormEvent } from "react";
import { KeyRound, Lock, LockOpen, LogOut } from "lucide-react";
import { useConnection } from "wagmi";
import { AccountButton, ProfileAvatar, WatchButton } from "@/components/account-ui";
import { Avatar, Button, Card, CardHeader, PageHeader } from "@/components/ui";
import { useAccount } from "@/lib/account/account";
import { ALERT_LABELS, type AlertKey, type Profile } from "@/lib/account/model";
import { cx, short } from "@/lib/format";
import { useStore } from "@/lib/store";

function ProfileForm({ profile }: { profile: Profile }) {
  const account = useAccount();
  const [displayName, setName] = useState(profile.displayName);
  const [avatarUrl, setAvatar] = useState(profile.avatarUrl);
  const [saving, setSaving] = useState(false);
  const urlOk = !avatarUrl || /^https:\/\/\S+$/.test(avatarUrl);
  const dirty = displayName !== profile.displayName || avatarUrl !== profile.avatarUrl;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    await account.updateProfile({ displayName: displayName.trim(), avatarUrl: avatarUrl.trim() });
    setSaving(false);
  };

  const input = "w-full rounded-lg border border-line px-3 py-2 text-sm outline-none focus:border-teal focus:ring-2 focus:ring-teal/20";
  return (
    <form onSubmit={submit} className="space-y-3 px-4 pb-5">
      <div className="flex items-center gap-3">
        <ProfileAvatar url={avatarUrl} name={displayName || profile.address} size={48} />
        <div>
          <p className="text-sm font-medium text-ink">{displayName || "Unnamed"}</p>
          <p className="font-mono text-[11px] text-muted">{profile.address}</p>
        </div>
      </div>
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-muted">Display name</span>
        <input value={displayName} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="e.g. Ada's trading desk" className={input} />
      </label>
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-muted">Avatar URL</span>
        <input value={avatarUrl} maxLength={500} onChange={(e) => setAvatar(e.target.value)} placeholder="https://…" className={input} />
        {!urlOk && <span className="mt-1 block text-[11px] text-rose-600">Use an https:// image URL</span>}
      </label>
      <Button type="submit" disabled={!dirty || !urlOk || saving}>{saving ? "Saving…" : "Save profile"}</Button>
    </form>
  );
}

function AlertPrefs({ profile }: { profile: Profile }) {
  const account = useAccount();
  return (
    <ul className="divide-y divide-line px-4 pb-2">
      {(Object.keys(ALERT_LABELS) as AlertKey[]).map((k) => {
        const on = profile.alerts[k];
        return (
          <li key={k} className="flex items-center justify-between gap-4 py-3">
            <div>
              <p className="text-sm font-medium text-ink">{ALERT_LABELS[k].label}</p>
              <p className="text-xs text-muted">{ALERT_LABELS[k].description}</p>
            </div>
            <button
              role="switch"
              aria-checked={on}
              aria-label={ALERT_LABELS[k].label}
              onClick={() => account.updateProfile({ alerts: { ...profile.alerts, [k]: !on } })}
              className={cx("relative h-5 w-9 shrink-0 rounded-full transition", on ? "bg-teal" : "bg-slate-300")}
            >
              <span className={cx("absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all", on ? "left-[18px]" : "left-0.5")} />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function Watchlist() {
  const account = useAccount();
  const { state, dispatch } = useStore();
  if (account.watchlist.length === 0) {
    return <p className="px-4 pb-5 text-sm text-muted">Nothing watched yet. Use the ☆ on any agent or request.</p>;
  }
  return (
    <ul className="divide-y divide-line px-4 pb-2">
      {account.watchlist.map((w) => {
        const request = w.kind === "request" ? state.requests.find((r) => r.requestHash.toLowerCase() === w.ref) : undefined;
        return (
          <li key={w.ref} className="flex items-center gap-3 py-2.5">
            {w.kind === "agent" ? <Avatar address={w.ref} size={22} /> : <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-muted">REQ</span>}
            <button className="min-w-0 flex-1 text-left" disabled={!request} onClick={() => request && dispatch({ type: "SELECT", id: request.id })}>
              <span className="block truncate text-sm text-ink">{w.label || short(w.ref)}</span>
              <span className="block font-mono text-[11px] text-muted">{short(w.ref, 6, 6)}{request ? ` · ${request.status}` : ""}</span>
            </button>
            <WatchButton kind={w.kind} refId={w.ref} label={w.label} />
          </li>
        );
      })}
    </ul>
  );
}

/** Mera passkey encryption for note bodies: enable / unlock / lock. */
function VaultControl() {
  const { vault } = useAccount();
  if (vault.status === "unsupported") return <span className="text-[11px] text-muted">Passkeys unavailable here</span>;
  const btn = "inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium ring-1 disabled:opacity-50";
  if (vault.status === "none") {
    return (
      <button onClick={vault.enable} disabled={vault.busy} className={cx(btn, "text-teal-dark ring-teal hover:bg-teal-soft")}>
        <KeyRound size={12} /> {vault.busy ? "Check your passkey…" : "Encrypt with passkey"}
      </button>
    );
  }
  if (vault.status === "locked") {
    return (
      <button onClick={vault.unlock} disabled={vault.busy} className={cx(btn, "text-amber-700 ring-amber-300 hover:bg-amber-50")}>
        <Lock size={12} /> {vault.busy ? "Check your passkey…" : "Unlock notes"}
      </button>
    );
  }
  return (
    <button onClick={vault.lock} className={cx(btn, "text-emerald-700 ring-emerald-300 hover:bg-emerald-50")}>
      <LockOpen size={12} /> Unlocked · lock
    </button>
  );
}

function VaultExplainer() {
  const { vault } = useAccount();
  if (vault.status === "unsupported") return null;
  return (
    <p className="-mt-1 px-4 pb-2 text-[11px] text-muted">
      {vault.status === "none"
        ? "Optionally encrypt note bodies with a key derived from a passkey (Mera PRF). The server and database then only ever store ciphertext."
        : "Note bodies are encrypted in your browser with a key derived from your passkey (Mera PRF namespace “talidator.notes.v1”). The key is never stored — your passkey on any device re-derives it."}
    </p>
  );
}

function Notes() {
  const account = useAccount();
  const { state } = useStore();
  const entries = Object.entries(account.notes);
  const [editing, setEditing] = useState<{ agent: string; label: string; note: string } | null>(null);
  if (entries.length === 0 && !editing) {
    return <p className="px-4 pb-5 text-sm text-muted">Add private labels to agents from the Identity Registry. Only you can see them.</p>;
  }
  return (
    <ul className="divide-y divide-line px-4 pb-2">
      {entries.map(([agent, n]) => {
        const name = state.agents.find((a) => a.address.toLowerCase() === agent)?.name ?? short(agent);
        const isEditing = editing?.agent === agent;
        return (
          <li key={agent} className="py-3">
            <div className="flex items-center gap-2">
              <Avatar address={agent} size={20} />
              <span className="text-sm text-ink">{name}</span>
              <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-muted">{n.label || "no label"}</span>
              {!isEditing && (
                <button
                  className="ml-auto text-[11px] font-medium text-teal hover:underline disabled:cursor-not-allowed disabled:text-muted disabled:no-underline"
                  disabled={!!n.locked}
                  title={n.locked ? "Unlock your notes first" : undefined}
                  onClick={() => setEditing({ agent, label: n.label, note: n.note })}
                >
                  Edit
                </button>
              )}
            </div>
            {isEditing ? (
              <div className="mt-2 space-y-2">
                <input value={editing.label} maxLength={40} onChange={(e) => setEditing({ ...editing, label: e.target.value })} placeholder="Label" className="w-full rounded-lg border border-line px-3 py-1.5 text-sm outline-none focus:border-teal" />
                <textarea value={editing.note} maxLength={1000} rows={3} onChange={(e) => setEditing({ ...editing, note: e.target.value })} placeholder="Private note" className="w-full rounded-lg border border-line px-3 py-1.5 text-sm outline-none focus:border-teal" />
                <div className="flex gap-2">
                  <Button className="px-3 py-1.5 text-xs" onClick={() => { account.setNote(agent, editing.label, editing.note); setEditing(null); }}>Save</Button>
                  <Button variant="secondary" className="px-3 py-1.5 text-xs" onClick={() => setEditing(null)}>Cancel</Button>
                  <Button variant="ghost" className="ml-auto px-3 py-1.5 text-xs text-rose-600" onClick={() => { account.setNote(agent, "", ""); setEditing(null); }}>Delete</Button>
                </div>
              </div>
            ) : (
              n.locked
                ? <p className="mt-1 flex items-center gap-1 text-xs text-muted"><Lock size={11} /> Encrypted — unlock with your passkey to read</p>
                : n.note && <p className="mt-1 text-xs whitespace-pre-wrap text-muted">{n.note}</p>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export default function AccountPage() {
  const account = useAccount();
  const conn = useConnection();

  if (account.status === "disabled") {
    return (
      <>
        <PageHeader title="Account" description="Personal dashboards, watchlists and alerts." />
        <Card className="p-5 text-sm text-muted">
          Accounts aren&apos;t configured on this deployment. Set the <code>NEXT_PUBLIC_FIREBASE_*</code> and <code>FIREBASE_*</code> environment
          variables (see <code>.env.example</code>) and redeploy. The on-chain dashboard works without them.
        </Card>
      </>
    );
  }

  if (account.status !== "signed-in" || !account.profile) {
    return (
      <>
        <PageHeader title="Account" description="Sign in with your wallet to get a personal dashboard, watchlist, private labels and alerts." />
        <Card className="max-w-lg p-6">
          <h2 className="text-[15px] font-semibold text-ink">Sign in with Ethereum</h2>
          <p className="mt-1 text-sm text-muted">
            You&apos;ll sign a one-time message. It doesn&apos;t send a transaction or cost gas. Your account is your wallet address, so
            your dashboard matches the agents and requests you own on-chain.
          </p>
          <div className="mt-4">
            {account.status === "loading" ? (
              <p className="text-sm text-muted">Checking session…</p>
            ) : conn.isConnected ? (
              <AccountButton />
            ) : (
              <p className="text-sm text-amber-700">Connect your wallet (top right) first.</p>
            )}
          </div>
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Account"
        description="Your profile, alert preferences, watchlist and private labels. Stored in Firestore under your wallet address — only you can read them."
        action={<Button variant="secondary" onClick={account.signOut}><LogOut size={15} /> Sign out</Button>}
      />
      <div className="grid gap-5 lg:grid-cols-2">
        <div className="flex flex-col gap-5">
          <Card>
            <CardHeader title="Profile" />
            <ProfileForm key={`${account.profile.displayName}|${account.profile.avatarUrl}`} profile={account.profile} />
          </Card>
          <Card>
            <div id="alerts" className="scroll-mt-20" />
            <CardHeader title="Alert preferences" />
            <p className="-mt-1 px-4 pb-1 text-xs text-muted">Alerts cover on-chain events on your agents, your requests and your watchlist.</p>
            <AlertPrefs profile={account.profile} />
          </Card>
        </div>
        <div className="flex flex-col gap-5">
          <Card>
            <div id="watchlist" className="scroll-mt-20" />
            <CardHeader title={`Watchlist (${account.watchlist.length})`} />
            <Watchlist />
          </Card>
          <Card>
            <CardHeader title="Private labels & notes" action={<VaultControl />} />
            <VaultExplainer />
            <Notes />
          </Card>
        </div>
      </div>
    </>
  );
}
