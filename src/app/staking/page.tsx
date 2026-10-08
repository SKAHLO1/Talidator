"use client";

import { useState } from "react";
import { Avatar, Button, Card, CardHeader, PageHeader, Stat } from "@/components/ui";
import { useActions } from "@/lib/actions";
import { SYMBOL } from "@/lib/chain/config";
import { cx, short } from "@/lib/format";
import { mon, sameAddr, useMe } from "@/lib/hooks";
import { useStore } from "@/lib/store";

const statusStyle = {
  active: "bg-emerald-50 text-emerald-600",
  slashed: "bg-rose-50 text-rose-600",
  unbonding: "bg-slate-100 text-slate-600",
  inactive: "bg-amber-50 text-amber-700",
};

export default function StakingPage() {
  const { state } = useStore();
  const actions = useActions();
  const me = useMe();
  const p = state.params;

  // Validators whose identity this wallet owns, or whose agent wallet it is.
  const mine = state.validators.filter((v) => {
    const agent = state.agents.find((a) => sameAddr(a.address, v.address));
    return sameAddr(v.address, me.address) || sameAddr(agent?.owner, me.address);
  });
  // A registered validator identity that hasn't bonded yet (only the agent wallet itself can bond).
  const unbondedIdentity = state.agents.find(
    (a) => a.role === "validator" && sameAddr(a.address, me.address) && !state.validators.some((v) => sameAddr(v.address, a.address)),
  );
  const options = [...mine.map((v) => ({ address: v.address, name: v.name })), ...(unbondedIdentity ? [{ address: unbondedIdentity.address, name: unbondedIdentity.name }] : [])];

  const [picked, setTarget] = useState("");
  const [amount, setAmount] = useState("");
  const target = picked || options[0]?.address || "";
  const selected = state.validators.find((v) => v.address === target);
  const totalStake = state.validators.reduce((s, v) => s + v.stake, 0);
  const totalSlashed = state.validators.reduce((s, v) => s + v.slashed, 0);
  const amountValue = Number(amount || p?.minBond || 0) || 0;
  const canSign = sameAddr(target, me.address);

  return (
    <>
      <PageHeader
        eyebrow="ValidatorStaking.sol"
        title="Staking"
        description={
          p
            ? `Validators post a bond to register. A vote overturned by a successful challenge is slashed ${p.slashPercent}%; slashed funds pay the challenger (${p.challengerCutPercent}%) and the treasury.`
            : "Validators post a bond to register. Votes overturned by a successful challenge are slashed."
        }
      />
      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Total bonded" value={mon(totalStake, 3)} />
        <Stat label="Active validators" value={state.validators.filter((v) => v.status === "active").length} />
        <Stat label="Minimum bond" value={p ? mon(p.minBond) : "—"} />
        <Stat label="Slashed to date" value={mon(totalSlashed, 3)} />
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
        <Card>
          <CardHeader title="Validator bonds" />
          <div className="overflow-x-auto">
            <table className="w-full min-w-[620px] text-left text-sm">
              <thead>
                <tr className="border-y border-line bg-slate-50/60 text-xs text-muted">
                  <th className="py-2.5 pl-4 font-normal">Validator</th>
                  <th className="py-2.5 font-normal">Agreement rate</th>
                  <th className="py-2.5 font-normal">Votes</th>
                  <th className="py-2.5 font-normal">Bonded</th>
                  <th className="py-2.5 font-normal">Slashed</th>
                  <th className="py-2.5 pr-4 font-normal">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {state.validators.length === 0 && (
                  <tr><td colSpan={6} className="py-8 text-center text-sm text-muted">No validators bonded yet.</td></tr>
                )}
                {[...state.validators].sort((a, b) => b.stake - a.stake).map((v) => (
                  <tr key={v.address}>
                    <td className="py-3 pl-4">
                      <span className="flex items-center gap-2.5">
                        <Avatar address={v.address} size={26} />
                        <span>
                          <span className="block text-[13px] font-medium text-ink">{v.name}</span>
                          <span className="block font-mono text-[11px] text-muted">{short(v.address)}</span>
                        </span>
                      </span>
                    </td>
                    <td className="py-3">
                      <div className="flex items-center gap-2">
                        <div className="h-1.5 w-16 rounded-full bg-slate-100"><div className="h-full rounded-full bg-teal" style={{ width: `${v.successRate}%` }} /></div>
                        <span className="text-xs text-muted">{v.successRate}%</span>
                      </div>
                    </td>
                    <td className="py-3 text-xs text-muted">{v.totalVotes}</td>
                    <td className="py-3 text-xs font-medium text-ink">{mon(v.stake, 3)}</td>
                    <td className={cx("py-3 text-xs", v.slashed ? "font-medium text-rose-600" : "text-muted")}>{v.slashed ? `−${mon(v.slashed, 3)}` : "—"}</td>
                    <td className="py-3 pr-4">
                      <span className={cx("rounded-md px-2 py-1 text-[11px] font-medium capitalize", statusStyle[v.status])}>{v.status}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card className="h-fit p-5">
          <h2 className="text-[15px] font-semibold text-ink">Manage your bond</h2>
          {!me.connected || options.length === 0 ? (
            <p className="mt-2 text-sm text-muted">
              Connect the agent wallet of a registered validator identity to bond. Register one in the Identity Registry first.
            </p>
          ) : (
            <div className="mt-4 space-y-3">
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-muted">Validator</span>
                <select value={target} onChange={(e) => setTarget(e.target.value)} className="w-full rounded-lg border border-line px-3 py-2 text-sm outline-none focus:border-teal">
                  {options.map((v) => <option key={v.address} value={v.address}>{v.name} · {short(v.address)}</option>)}
                </select>
              </label>
              <p className="text-xs text-muted">Currently bonded: <b className="text-ink">{mon(selected?.stake ?? 0)}</b></p>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-muted">Amount ({SYMBOL})</span>
                <input value={amount} placeholder={String(p?.minBond ?? "")} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" className="w-full rounded-lg border border-line px-3 py-2 text-sm outline-none focus:border-teal" />
              </label>
              <div className="grid grid-cols-2 gap-2">
                <Button disabled={!canSign || selected?.status === "unbonding" || amountValue <= 0} onClick={() => actions.bond(target, amountValue)}>Bond</Button>
                <Button variant="secondary" disabled={!canSign || !selected} onClick={() => actions.unbondOrWithdraw(target)}>
                  {selected?.status === "unbonding" ? "Withdraw" : "Begin unbonding"}
                </Button>
              </div>
              {!canSign && <p className="text-[11px] text-amber-700">Switch your wallet to this validator&apos;s agent wallet to sign.</p>}
              <p className="text-[11px] text-muted">
                Unbonding deactivates the validator immediately. Stake unlocks after the unbonding period, so it stays slashable through open challenge windows.
              </p>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
