"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { X, ShieldCheck, Skull, Users } from "lucide-react";
import { useActions } from "@/lib/actions";
import { SYMBOL } from "@/lib/chain/config";
import { cx, short } from "@/lib/format";
import { mon, sameAddr, useMe } from "@/lib/hooks";
import { useStore, type Scenario } from "@/lib/store";
import type { Asset } from "@/lib/types";
import { Avatar, Button } from "./ui";

/** Pairs with a Chainlink Data Feed on Monad testnet (see lib/chain/market.ts). */
const pairs: { asset: Asset; quote: string; size: string }[] = [
  { asset: "ETH", quote: "USD", size: "1.2" },
  { asset: "BTC", quote: "USD", size: "0.05" },
  { asset: "LINK", quote: "USD", size: "50" },
];

const scenarios: { id: Scenario; title: string; body: string; icon: typeof ShieldCheck; tone: string }[] = [
  {
    id: "honest", title: "Honest trade", icon: ShieldCheck, tone: "text-emerald-600 bg-emerald-50",
    body: "Claim built from real Chainlink price rounds on Monad testnet. Validators re-execute it and should PASS.",
  },
  {
    id: "fabricated", title: "Catch the liar", icon: Skull, tone: "text-rose-600 bg-rose-50",
    body: "Fake exit price + inflated PnL. Re-execution fails, so payment is refunded.",
  },
  {
    id: "colluding", title: "Colluding validators", icon: Users, tone: "text-amber-600 bg-amber-50",
    body: "Fabricated claim sent to validators you pick. Run the daemon with COLLUDING=Alpha,Beta and select them.",
  },
];

export function StartValidationModal() {
  const { state, dispatch } = useStore();
  const actions = useActions();
  const me = useMe();

  const traders = state.agents.filter((a) => a.role === "trader" && (sameAddr(a.owner, me.address) || sameAddr(a.address, me.address)));
  const liar = traders.find((t) => t.adversarial);
  const honest = traders.filter((t) => !t.adversarial);

  const [scenario, setScenario] = useState<Scenario>("honest");
  const [agent, setAgent] = useState("");
  const [pair, setPair] = useState(0);
  const [amount, setAmount] = useState("1.2");
  const [paymentInput, setPayment] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  if (!state.startOpen) return null;

  const selectedAgent = agent || (scenario === "honest" ? honest[0]?.address : liar?.address) || traders[0]?.address || "";
  const payment = paymentInput || "0.01";
  const setSize = picked.length || 3;
  const threshold = Math.floor(setSize / 2) + 1;
  const evenSet = picked.length > 0 && picked.length % 2 === 0;
  const close = () => dispatch({ type: "START_OPEN", open: false });

  const toggleValidator = (addr: string) => setPicked((p) => (p.includes(addr) ? p.filter((x) => x !== addr) : [...p, addr]));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const p = pairs[pair];
    setBusy(true);
    await actions.startValidation({
      agent: selectedAgent, asset: p.asset, quote: p.quote, size: Number(amount) || 1,
      payment: Number(payment) || 0, scenario, validators: picked.length ? picked : undefined,
    });
    setBusy(false);
  };

  const input = "w-full rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink outline-none focus:border-teal focus:ring-2 focus:ring-teal/20";
  const pickable = state.validators.filter((v) => v.status === "active" && v.address !== selectedAgent);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <div className="absolute inset-0 bg-navy/50 backdrop-blur-[2px]" onClick={close} />
      <form onSubmit={submit} className="animate-pop relative max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-white p-6 shadow-2xl sm:rounded-2xl">
        <div className="mb-5 flex items-start justify-between">
          <div>
            <h2 className="text-lg font-semibold text-ink">Start Validation</h2>
            <p className="text-sm text-muted">
              Escrow payment, then call <code className="text-xs">validationRequest()</code> on Monad testnet. Two wallet transactions.
            </p>
          </div>
          <button type="button" onClick={close} className="rounded-lg p-1 text-muted hover:bg-slate-100" aria-label="Close"><X size={18} /></button>
        </div>

        <p className="mb-2 text-xs font-medium text-muted">Claim</p>
        <div className="mb-5 grid gap-2">
          {scenarios.map((s) => (
            <button
              type="button"
              key={s.id}
              onClick={() => { setScenario(s.id); setAgent(""); }}
              className={cx("flex items-start gap-3 rounded-xl border p-3 text-left transition", scenario === s.id ? "border-teal bg-teal-soft/60 ring-1 ring-teal" : "border-line hover:bg-slate-50")}
            >
              <span className={cx("flex h-8 w-8 shrink-0 items-center justify-center rounded-lg", s.tone)}><s.icon size={16} /></span>
              <span>
                <span className="block text-sm font-medium text-ink">{s.title}</span>
                <span className="block text-xs text-muted">{s.body}</span>
              </span>
            </button>
          ))}
        </div>

        {traders.length === 0 ? (
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
            {me.connected ? (
              <>This wallet doesn&apos;t own a trader identity yet. <Link href="/identity" onClick={close} className="font-medium underline">Register a trader agent</Link> first.</>
            ) : (
              "Connect your wallet to request a validation."
            )}
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="sm:col-span-2">
              <span className="mb-1 block text-xs font-medium text-muted">Trader agent</span>
              <select value={selectedAgent} onChange={(e) => setAgent(e.target.value)} className={input}>
                {traders.map((t) => (
                  <option key={t.address} value={t.address}>{t.name} · {short(t.address)}</option>
                ))}
              </select>
            </label>
            <label>
              <span className="mb-1 block text-xs font-medium text-muted">Asset pair</span>
              <select value={pair} onChange={(e) => { setPair(Number(e.target.value)); setAmount(pairs[Number(e.target.value)].size); }} className={input}>
                {pairs.map((p, i) => <option key={p.asset} value={i}>{p.asset} / {p.quote}</option>)}
              </select>
            </label>
            <label>
              <span className="mb-1 block text-xs font-medium text-muted">Size ({pairs[pair].asset})</span>
              <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" className={input} />
              <span className="mt-1 block text-[11px] text-muted">Side is set by the Chainlink momentum signal</span>
            </label>
            <label className="sm:col-span-2">
              <span className="mb-1 block text-xs font-medium text-muted">Escrowed payment ({SYMBOL})</span>
              <input value={paymentInput} placeholder={payment} onChange={(e) => setPayment(e.target.value)} inputMode="decimal" className={input} />
            </label>
            <div className="sm:col-span-2">
              <span className="mb-1 block text-xs font-medium text-muted">
                Validator set {picked.length ? `(${picked.length} picked)` : "(auto: 3 random active validators)"}
              </span>
              {pickable.length === 0 ? (
                <p className="text-xs text-rose-600">No active validators are bonded on-chain yet.</p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {pickable.map((v) => (
                    <button
                      type="button"
                      key={v.address}
                      onClick={() => toggleValidator(v.address)}
                      className={cx("inline-flex items-center gap-1.5 rounded-full py-1 pr-2.5 pl-1 text-xs ring-1 transition", picked.includes(v.address) ? "bg-teal-soft text-teal-dark ring-teal" : "text-muted ring-line hover:bg-slate-50")}
                    >
                      <Avatar address={v.address} size={18} /> {v.name.replace("Validator ", "")}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        <div className="mt-5 rounded-lg bg-slate-50 px-3 py-2.5 text-xs text-muted">
          Quorum: <b className="text-ink">{threshold}-of-{setSize}</b> · Challenge window:{" "}
          <b className="text-ink">{state.params ? `${Math.round(state.params.challengeWindowSec / 60)} min` : "—"}</b> · Challenge bond:{" "}
          <b className="text-ink">{state.params ? mon(state.params.challengeBond) : "—"}</b>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={close}>Cancel</Button>
          <Button type="submit" disabled={!me.connected || !selectedAgent || busy || evenSet || pickable.length === 0}>
            {!me.connected ? "Connect wallet first" : busy ? "Submitting…" : "Submit request"}
          </Button>
        </div>
        {evenSet && <p className="mt-2 text-right text-[11px] text-amber-700">Pick an odd number of validators so a simple majority can&apos;t tie.</p>}
      </form>
    </div>
  );
}
