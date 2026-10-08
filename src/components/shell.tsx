"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";
import {
  ChevronDown, Gavel, House, Layers, Menu, RefreshCw, Settings, ShieldCheck, Star, IdCard, Wallet, X, CheckCircle2, AlertTriangle, Info, UserRound,
} from "lucide-react";
import { useConnect, useConnection, useConnectors, useDisconnect, useSwitchChain } from "wagmi";
import { useAccount } from "@/lib/account/account";
import { CHAIN_ID, chain } from "@/lib/chain/config";
import { AccountButton, AlertsBell } from "./account-ui";
import { cx, short } from "@/lib/format";
import { useMe } from "@/lib/hooks";
import { useStore } from "@/lib/store";
import { Logo } from "./ui";
import { StartValidationModal } from "./start-validation";
import { RequestDrawer } from "./request-drawer";

const nav = [
  { href: "/", label: "Dashboard", icon: House },
  { href: "/validation", label: "Validation Registry", icon: ShieldCheck },
  { href: "/identity", label: "Identity Registry", icon: IdCard },
  { href: "/reputation", label: "Reputation Registry", icon: Star },
  { href: "/staking", label: "Staking", icon: Layers },
  { href: "/challenges", label: "Challenge Market", icon: Gavel },
  { href: "/account", label: "Account", icon: UserRound },
  { href: "/settings", label: "Settings", icon: Settings },
];

function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const { state } = useStore();
  const me = useMe();
  return (
    <div className="flex h-full flex-col px-5 py-7">
      <Link href="/" onClick={onNavigate} className="mb-10 flex items-center gap-3 px-2">
        <Logo />
        <span className="text-[26px] font-semibold tracking-tight text-white">Talidator</span>
      </Link>
      <nav className="flex flex-col gap-1.5">
        {nav.map(({ href, label, icon: Icon }) => {
          const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              onClick={onNavigate}
              className={cx(
                "flex items-center gap-4 rounded-lg px-4 py-3 text-[13.5px] transition",
                active ? "bg-navy-2 text-[#5fd3c4]" : "text-slate-200 hover:bg-white/5",
              )}
            >
              <Icon size={20} strokeWidth={1.7} className={active ? "text-[#5fd3c4]" : "text-slate-300"} />
              {label}
            </Link>
          );
        })}
      </nav>
      <div className="mt-auto pt-10">
        <div className="flex items-center gap-3 rounded-xl border border-white/10 px-4 py-3.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-navy-2">
            <span className={cx("h-2 w-2 rounded-full", me.onMonad ? "bg-emerald-400" : me.connected ? "bg-amber-400" : "bg-slate-500")} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-medium text-white">{chain.name}</p>
            <p className="text-xs text-slate-400">{me.address ? short(me.address) : "Not connected"}</p>
          </div>
          <RefreshCw size={12} className={cx("text-slate-400", state.sync.status === "loading" && "animate-spin")} />
        </div>
        <p className="mt-9 text-[13px] leading-5 text-slate-300">Verifiable agents.<br />Trusted outcomes.</p>
      </div>
    </div>
  );
}

function ConnectButton({ onClick, label = "Connect Wallet" }: { onClick: () => void; label?: string }) {
  return (
    <button onClick={onClick} className="inline-flex items-center gap-2 rounded-lg bg-teal px-3.5 py-2 text-sm font-medium text-white hover:bg-teal-dark">
      <Wallet size={16} /> {label}
    </button>
  );
}

function WalletMenu({ address, network, onDisconnect }: { address: string; network: string; onDisconnect: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button onClick={() => setOpen((o) => !o)} className="inline-flex items-center gap-2 rounded-lg border border-line bg-white py-1.5 pr-3 pl-2 text-xs font-medium text-ink shadow-sm hover:bg-slate-50">
        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-navy-2"><Wallet size={11} className="text-[#5fd3c4]" /></span>
        {short(address)}
        <ChevronDown size={14} className="text-muted" />
      </button>
      {open && (
        <div className="absolute right-0 z-30 mt-2 w-60 rounded-xl border border-line bg-white p-2 text-sm shadow-lg">
          <p className="px-2 py-1.5 text-xs text-muted">Connected to {network}</p>
          <p className="px-2 pb-2 font-mono text-[11px] break-all text-ink">{address}</p>
          <button onClick={() => { onDisconnect(); setOpen(false); }} className="w-full rounded-lg px-2 py-2 text-left text-rose-600 hover:bg-rose-50">
            Disconnect
          </button>
        </div>
      )}
    </div>
  );
}

function WalletButton() {
  const { dispatch } = useStore();
  const conn = useConnection();
  const connectors = useConnectors();
  const connect = useConnect();
  const disconnect = useDisconnect();
  const switchChain = useSwitchChain();
  const account = useAccount();

  if (!conn.isConnected || !conn.address) {
    return (
      <ConnectButton
        label={connect.isPending ? "Connecting…" : "Connect Wallet"}
        onClick={() => {
          const injected = connectors[0];
          if (!injected) return dispatch({ type: "TOAST", tone: "danger", title: "No wallet found", detail: "Install MetaMask or another injected wallet." });
          connect.mutate(
            { connector: injected, chainId: CHAIN_ID },
            { onError: (e) => dispatch({ type: "TOAST", tone: "danger", title: "Wallet connection failed", detail: e.message.split("\n")[0] }) },
          );
        }}
      />
    );
  }
  if (conn.chainId !== CHAIN_ID) {
    return (
      <button
        onClick={() => switchChain.mutate({ chainId: CHAIN_ID })}
        className="inline-flex items-center gap-2 rounded-lg bg-amber-500 px-3.5 py-2 text-sm font-medium text-white hover:bg-amber-600"
      >
        <AlertTriangle size={15} /> Switch to {chain.name}
      </button>
    );
  }
  return <WalletMenu address={conn.address} network={chain.name} onDisconnect={() => { account.signOut(); disconnect.mutate({}); }} />;
}

function SyncBadge() {
  const { state } = useStore();
  const { status, blockNumber, error, backfilling, source } = state.sync;
  return (
    <Link
      href="/settings"
      title={error}
      className={cx(
        "hidden items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium ring-1 sm:inline-flex",
        status === "error" || status === "undeployed" ? "bg-rose-50 text-rose-700 ring-rose-200" : "bg-teal-soft text-teal-dark ring-teal/30",
      )}
    >
      <span className={cx("h-1.5 w-1.5 rounded-full", status === "ok" ? "bg-teal animate-pulse" : status === "loading" ? "bg-slate-400" : "bg-rose-500")} />
      {status === "undeployed" ? "Not deployed" : status === "error" ? "RPC error" : status === "loading" ? "Syncing…" : `Block ${blockNumber} · ${source === "envio" ? "Envio" : "RPC"}${backfilling ? " · indexing history" : ""}`}
    </Link>
  );
}

/** Shown on every page until the contracts are deployed / reachable. */
function SyncNotice() {
  const { state, dispatch } = useStore();
  const { status, error } = state.sync;
  if (status === "undeployed") {
    return (
      <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
        <p className="font-medium">Talidator isn&apos;t deployed on {chain.name} yet.</p>
        <p className="mt-1 text-amber-800">
          Add a funded <code>PRIVATE_KEY</code> to <code>contracts/.env</code>, run <code>npm run deploy:monad</code> in <code>contracts/</code>,
          then restart the app. The deploy script writes the addresses into <code>src/lib/chain/deployments.ts</code>.
        </p>
      </div>
    );
  }
  if (status === "error") {
    return (
      <div className="mb-4 flex items-start justify-between gap-3 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-900">
        <div>
          <p className="font-medium">Can&apos;t read from {chain.name}.</p>
          <p className="mt-1 break-all text-rose-800">{error}</p>
        </div>
        <button onClick={() => dispatch({ type: "REFRESH" })} className="shrink-0 rounded-lg bg-white px-3 py-1.5 text-xs font-medium ring-1 ring-rose-200 hover:bg-rose-100">
          Retry
        </button>
      </div>
    );
  }
  return null;
}

function Toasts() {
  const { state, dispatch } = useStore();
  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-50 flex w-[min(360px,calc(100vw-2rem))] flex-col gap-2">
      {state.toasts.slice(0, 4).map((t) => {
        const Icon = t.tone === "success" ? CheckCircle2 : t.tone === "danger" ? AlertTriangle : Info;
        const color = t.tone === "success" ? "text-emerald-500" : t.tone === "danger" ? "text-rose-500" : "text-blue-500";
        return (
          <div key={t.id} className="animate-slide-in pointer-events-auto flex gap-3 rounded-xl border border-line bg-white p-3.5 shadow-lg">
            <Icon size={18} className={cx("mt-0.5 shrink-0", color)} />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-ink">{t.title}</p>
              {t.detail && <p className="mt-0.5 text-xs text-muted">{t.detail}</p>}
            </div>
            <button onClick={() => dispatch({ type: "DISMISS_TOAST", id: t.id })} className="text-muted hover:text-ink" aria-label="Dismiss">
              <X size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  return (
    <div className="flex min-h-screen">
      <aside className="fixed inset-y-0 left-0 z-20 hidden w-[243px] bg-navy lg:block">
        <SidebarContent />
      </aside>

      {mobileOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={() => setMobileOpen(false)} />
          <aside className="animate-slide-in absolute inset-y-0 left-0 w-[260px] bg-navy">
            <SidebarContent onNavigate={() => setMobileOpen(false)} />
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col lg:pl-[243px]">
        <header className="flex items-center justify-between gap-3 px-4 pt-4 sm:px-7 lg:justify-end lg:pt-4">
          <div className="flex items-center gap-2 lg:hidden">
            <button onClick={() => setMobileOpen(true)} className="rounded-lg p-2 text-ink hover:bg-slate-100" aria-label="Open menu">
              <Menu size={20} />
            </button>
            <span className="font-semibold">Talidator</span>
          </div>
          <div className="flex items-center gap-2">
            <SyncBadge />
            <AlertsBell />
            <AccountButton />
            <WalletButton />
          </div>
        </header>
        <main className="flex-1 px-4 pt-3 pb-8 sm:px-7">
          <SyncNotice />
          {children}
        </main>
      </div>

      <StartValidationModal />
      <RequestDrawer />
      <Toasts />
    </div>
  );
}
