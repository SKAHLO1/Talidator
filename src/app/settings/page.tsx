"use client";

import { Card, CardHeader, PageHeader } from "@/components/ui";
import { CHAIN_ID, CONTRACT_INFO, EXPLORER, RPC_PROVIDER, RPC_URL, chain, deployment, explorerAddress } from "@/lib/chain/config";
import { ENVIO_GRAPHQL_URL } from "@/lib/chain/envio";
import { cx } from "@/lib/format";
import { mon } from "@/lib/hooks";
import { useStore } from "@/lib/store";

function Params() {
  const { state } = useStore();
  const p = state.params;
  if (!p) {
    return <p className="px-4 pb-5 text-sm text-muted">{state.sync.status === "undeployed" ? "Available once the contracts are deployed." : "Reading from chain…"}</p>;
  }
  const rows: [string, string][] = [
    ["Quorum", "Simple majority of the requested validator set (N/2 + 1)"],
    ["Voting period", `${p.votingPeriodSec / 60} min`],
    ["Challenge window", `${p.challengeWindowSec / 60} min`],
    ["Review period", `${p.reviewPeriodSec / 60} min`],
    ["Minimum validator bond", mon(p.minBond)],
    ["Challenge bond", mon(p.challengeBond)],
    ["Slash per overturned vote", `${p.slashPercent}% of bond`],
    ["Challenger cut", `${p.challengerCutPercent}% of slashed stake`],
    ["Arbiter", p.arbiter],
  ];
  return (
    <dl className="grid grid-cols-[170px_1fr] gap-y-2 px-4 pb-5 text-sm">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted">{k}</dt>
          <dd className={cx("text-ink", v.startsWith("0x") && "font-mono text-xs break-all")}>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export default function SettingsPage() {
  const { state } = useStore();
  const { status, blockNumber, error } = state.sync;

  return (
    <>
      <PageHeader title="Settings" description={`Network, deployed contracts and on-chain protocol parameters on ${chain.name}.`} />
      <div className="grid gap-5 lg:grid-cols-2">
        <div className="flex flex-col gap-5">
          <Card>
            <CardHeader title="Network" />
            <dl className="grid grid-cols-[120px_1fr] gap-y-2 px-4 pb-5 text-sm">
              <dt className="text-muted">Chain</dt><dd className="text-ink">{chain.name}</dd>
              <dt className="text-muted">Chain ID</dt><dd className="font-mono text-ink">{CHAIN_ID}</dd>
              <dt className="text-muted">RPC</dt>
              <dd className="text-xs text-ink">
                <span className="mr-2 rounded bg-slate-100 px-1.5 py-0.5 font-medium">
                  {RPC_PROVIDER === "alchemy" ? "Alchemy" : RPC_PROVIDER === "custom" ? "Custom" : "Monad public"}
                </span>
                <span className="font-mono break-all">{RPC_URL}</span>
              </dd>
              <dt className="text-muted">Indexer</dt>
              <dd className="text-xs text-ink">
                {ENVIO_GRAPHQL_URL ? (
                  <><span className="mr-2 rounded bg-teal-soft px-1.5 py-0.5 font-medium text-teal-dark">Envio HyperIndex</span><span className="font-mono break-all">{ENVIO_GRAPHQL_URL}</span></>
                ) : (
                  <span className="text-muted">None — reading event logs over RPC</span>
                )}
              </dd>
              <dt className="text-muted">Explorer</dt>
              <dd><a className="font-mono text-xs break-all text-teal hover:underline" href={EXPLORER} target="_blank" rel="noreferrer">{EXPLORER}</a></dd>
              <dt className="text-muted">Sync</dt>
              <dd className={cx("text-xs", status === "error" || status === "undeployed" ? "text-rose-600" : "text-ink")}>
                {status === "ok" ? `Synced · block ${blockNumber}` : status === "loading" ? "Syncing…" : status === "undeployed" ? "Contracts not deployed" : `RPC error: ${error}`}
              </dd>
            </dl>
          </Card>
          <Card>
            <CardHeader title="Protocol parameters (on-chain)" />
            <Params />
          </Card>
        </div>

        <Card className="h-fit">
          <CardHeader
            title="Contracts"
            action={
              deployment
                ? <span className="rounded-md bg-teal-soft px-2 py-1 text-[11px] font-medium text-teal-dark">Deployed · block {deployment.startBlock}</span>
                : <span className="rounded-md bg-amber-50 px-2 py-1 text-[11px] font-medium text-amber-700">Not deployed</span>
            }
          />
          <ul className="divide-y divide-line px-4 pb-2">
            {CONTRACT_INFO.map((c) => {
              const address = deployment?.[c.name];
              return (
                <li key={c.name} className="py-3">
                  <p className="text-sm font-medium text-ink">{c.name}.sol</p>
                  <p className="text-[11px] text-muted">{c.description}</p>
                  {address ? (
                    <a href={explorerAddress(address)} target="_blank" rel="noreferrer" className="mt-1 block font-mono text-[11px] break-all text-teal hover:underline">{address}</a>
                  ) : (
                    <p className="mt-1 text-[11px] text-muted">Run <code>npm run deploy:monad</code> in <code>contracts/</code></p>
                  )}
                </li>
              );
            })}
          </ul>
        </Card>
      </div>
    </>
  );
}
