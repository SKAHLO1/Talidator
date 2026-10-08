"use client";

import { useState } from "react";
import {
  Hero, NetworkPanel, RecentActivity, ReputationLeaderboard, RequestsTable, TopStakers, ValidatorPerformance, WatchlistCard, YourAgents,
} from "@/components/dashboard";
import { useMine } from "@/lib/account/mine";
import { cx, short } from "@/lib/format";
import { useStore } from "@/lib/store";

type View = "mine" | "network";

export default function Dashboard() {
  const { state } = useStore();
  const mine = useMine();
  const [picked, setView] = useState<View | null>(null);
  // Signed-in users land on their own dashboard; everyone else sees the network.
  const view: View = picked ?? (mine.signedIn ? "mine" : "network");
  const personal = view === "mine" && !!mine.me;

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_308px]">
      <div className="flex min-w-0 flex-col gap-5">
        <Hero />
        {mine.me && (
          <div className="flex items-center justify-between gap-3">
            <div className="inline-flex rounded-lg bg-white p-1 ring-1 ring-line" role="tablist">
              {(["mine", "network"] as const).map((v) => (
                <button
                  key={v}
                  role="tab"
                  aria-selected={view === v}
                  onClick={() => setView(v)}
                  className={cx("rounded-md px-3 py-1.5 text-xs font-medium transition", view === v ? "bg-navy text-white" : "text-muted hover:text-ink")}
                >
                  {v === "mine" ? "My dashboard" : "Network"}
                </button>
              ))}
            </div>
            {personal && <p className="truncate text-xs text-muted">Showing activity for {short(mine.me!)} and your watchlist</p>}
          </div>
        )}
        {personal ? (
          <RequestsTable
            title="Your requests & watchlist"
            requests={mine.requests}
            emptyText="Nothing yet: requests you make, fund, challenge or validate, and ones you star, appear here."
          />
        ) : (
          <RequestsTable requests={state.requests.slice(0, 6)} />
        )}
        <div className="grid gap-3 md:grid-cols-3">
          <ValidatorPerformance />
          <ReputationLeaderboard />
          <TopStakers />
        </div>
      </div>
      <div className="flex flex-col gap-4">
        <NetworkPanel />
        <YourAgents />
        {personal && <WatchlistCard />}
        {personal ? (
          <RecentActivity title="Your activity" source={mine.activity} limit={6} showVotes emptyText="No on-chain activity involving you yet." />
        ) : (
          <RecentActivity />
        )}
      </div>
    </div>
  );
}
