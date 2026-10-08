"use client";

import { useState, type FormEvent } from "react";
import { Check, Copy } from "lucide-react";
import { AgentLabel, WatchButton } from "@/components/account-ui";
import { Avatar, Button, Card, CardHeader, PageHeader } from "@/components/ui";
import { cx, short } from "@/lib/format";
import { isAddress } from "viem";
import { useActions } from "@/lib/actions";
import { mon, useMe } from "@/lib/hooks";
import { useStore } from "@/lib/store";
import type { AgentRole } from "@/lib/types";

const roleStyle: Record<AgentRole, string> = {
  trader: "bg-blue-50 text-blue-600",
  validator: "bg-teal-soft text-teal-dark",
  challenger: "bg-amber-50 text-amber-700",
};

export default function IdentityPage() {
  const { state } = useStore();
  const actions = useActions();
  const me = useMe();
  const [name, setName] = useState("");
  const [role, setRole] = useState<AgentRole>("trader");
  const [agentWallet, setAgentWallet] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const walletTaken = !!me.address && state.agents.some((a) => a.address.toLowerCase() === (agentWallet || me.address!).toLowerCase());
  const walletValid = !agentWallet || isAddress(agentWallet);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    await actions.registerAgent(name.trim(), role, agentWallet || undefined);
    setName("");
    setAgentWallet("");
  };

  const copy = (addr: string) => {
    navigator.clipboard?.writeText(addr);
    setCopied(addr);
    setTimeout(() => setCopied(null), 1200);
  };

  return (
    <>
      <PageHeader
        eyebrow="IdentityRegistry.sol"
        title="Identity Registry"
        description="ERC-8004 agent identities, minted as ERC-721 tokens. Trader, validator and challenger agents all resolve to a portable on-chain identity."
      />
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
        <Card>
          <CardHeader title={`${state.agents.length} registered agents`} />
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead>
                <tr className="border-y border-line bg-slate-50/60 text-xs text-muted">
                  <th className="py-2.5 pl-4 font-normal">Token</th>
                  <th className="py-2.5 font-normal">Agent</th>
                  <th className="py-2.5 font-normal">Role</th>
                  <th className="py-2.5 font-normal">Owner</th>
                  <th className="py-2.5 font-normal">Registered</th>
                  <th className="py-2.5 font-normal">Status</th>
                  <th className="py-2.5 pr-4 font-normal"><span className="sr-only">Watch</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {state.agents.length === 0 && (
                  <tr><td colSpan={7} className="py-8 text-center text-sm text-muted">No agents registered on-chain yet.</td></tr>
                )}
                {state.agents.map((a) => (
                  <tr key={a.address}>
                    <td className="py-3 pl-4 text-xs font-semibold text-ink">#{a.tokenId}</td>
                    <td className="py-3">
                      <span className="flex items-center gap-2.5">
                        <Avatar address={a.address} size={26} />
                        <span>
                          <span className="flex items-center gap-1.5 text-[13px] font-medium text-ink">{a.name} <AgentLabel agent={a.address} /></span>
                          <button onClick={() => copy(a.address)} className="flex items-center gap-1 font-mono text-[11px] text-muted hover:text-ink">
                            {short(a.address)} {copied === a.address ? <Check size={10} /> : <Copy size={10} />}
                          </button>
                        </span>
                      </span>
                    </td>
                    <td className="py-3"><span className={cx("rounded-md px-2 py-1 text-[11px] font-medium capitalize", roleStyle[a.role])}>{a.role}</span></td>
                    <td className="py-3 font-mono text-[11px] text-muted">{me.address && a.owner.toLowerCase() === me.address.toLowerCase() ? "You" : short(a.owner)}</td>
                    <td className="py-3 text-xs text-muted">{a.registeredAt}</td>
                    <td className="py-3">
                      {a.adversarial ? (
                        <span className="rounded-md bg-rose-50 px-2 py-1 text-[11px] font-medium text-rose-600">Adversarial</span>
                      ) : (
                        <span className="inline-flex items-center gap-1 rounded-md bg-teal-soft px-2 py-1 text-[11px] font-medium text-teal-dark"><Check size={10} /> On-chain</span>
                      )}
                    </td>
                    <td className="py-3 pr-4 text-right">
                      <WatchButton kind="agent" refId={a.address} label={a.name} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card className="h-fit p-5">
          <h2 className="text-[15px] font-semibold text-ink">Register an agent</h2>
          <p className="mt-1 text-xs text-muted">
            Mints an ERC-721 identity to your wallet, bound to an agent wallet the agent transacts from.
            {state.params && ` Validators then bond at least ${mon(state.params.minBond)} on the Staking page.`}
          </p>
          <form onSubmit={submit} className="mt-4 space-y-3">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted">Agent name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Validator Zeta" className="w-full rounded-lg border border-line px-3 py-2 text-sm outline-none focus:border-teal focus:ring-2 focus:ring-teal/20" />
            </label>
            <div>
              <span className="mb-1 block text-xs font-medium text-muted">Role</span>
              <div className="grid grid-cols-3 gap-2">
                {(["trader", "validator", "challenger"] as AgentRole[]).map((r) => (
                  <button type="button" key={r} onClick={() => setRole(r)} className={cx("rounded-lg py-2 text-xs font-medium capitalize ring-1 transition", role === r ? "bg-teal-soft text-teal-dark ring-teal" : "text-muted ring-line hover:bg-slate-50")}>
                    {r}
                  </button>
                ))}
              </div>
            </div>
            <label className="block">
                <span className="mb-1 block text-xs font-medium text-muted">Agent wallet</span>
                <input
                  value={agentWallet}
                  onChange={(e) => setAgentWallet(e.target.value.trim())}
                  placeholder={me.address ?? "0x…"}
                  className="w-full rounded-lg border border-line px-3 py-2 font-mono text-xs outline-none focus:border-teal focus:ring-2 focus:ring-teal/20"
                />
                <span className={cx("mt-1 block text-[11px]", walletTaken || !walletValid ? "text-rose-600" : "text-muted")}>
                  {!walletValid ? "Not a valid address" : walletTaken ? "This wallet already has an identity — enter a different agent wallet" : "Defaults to your connected wallet. Each wallet can back one agent."}
                </span>
              </label>
            <Button type="submit" className="w-full" disabled={!me.connected || !name.trim() || walletTaken || !walletValid}>Mint identity</Button>
          </form>
        </Card>
      </div>
    </>
  );
}
