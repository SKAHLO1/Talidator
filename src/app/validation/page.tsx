"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import { RecentActivity, RequestsTable } from "@/components/dashboard";
import { Button, PageHeader, Stat } from "@/components/ui";
import { useMine } from "@/lib/account/mine";
import { cx } from "@/lib/format";
import { useStore } from "@/lib/store";
import type { RequestStatus } from "@/lib/types";

type Filter = "All" | "Mine" | RequestStatus;
const statusFilters: RequestStatus[] = ["Pending", "In Progress", "Validated", "Rejected", "Challenged", "Overturned"];

export default function ValidationPage() {
  const { state, dispatch } = useStore();
  const mine = useMine();
  const [filter, setFilter] = useState<Filter>("All");
  const filters: Filter[] = ["All", ...(mine.me ? (["Mine"] as const) : []), ...statusFilters];
  const rows =
    filter === "All" ? state.requests
      : filter === "Mine" ? mine.requests
        : state.requests.filter((r) => r.status === filter);
  const count = (s: RequestStatus) => state.requests.filter((r) => r.status === s).length;

  return (
    <>
      <PageHeader
        eyebrow="ValidationRegistry.sol"
        title="Validation Registry"
        description="Every request is re-executed by an independent validator set. A configurable N-of-M quorum decides the recorded result, and only a passing result releases escrow."
        action={<Button onClick={() => dispatch({ type: "START_OPEN", open: true })}><Plus size={16} /> Start Validation</Button>}
      />

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Total requests" value={state.stats.totalRequests} sub={`Latest ${state.requests.length} shown`} />
        <Stat label="Awaiting votes" value={count("Pending") + count("In Progress")} sub="Simple-majority quorum" />
        <Stat label="Validated" value={count("Validated")} sub="Payment releasable" />
        <Stat label="Rejected / Overturned" value={count("Rejected") + count("Overturned")} sub="Payment refused or slashed" />
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_308px]">
        <div className="min-w-0">
          <div className="no-scrollbar mb-3 flex gap-2 overflow-x-auto">
            {filters.map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={cx("rounded-full px-3 py-1.5 text-xs font-medium whitespace-nowrap transition", filter === f ? "bg-navy text-white" : "bg-white text-muted ring-1 ring-line hover:text-ink")}
              >
                {f === "Mine" ? "Mine & watching" : f}
              </button>
            ))}
          </div>
          <RequestsTable requests={rows} title={`${rows.length} request${rows.length === 1 ? "" : "s"}`} action={<span className="text-xs text-muted">Click a row for votes & tx hashes</span>} />
        </div>
        <RecentActivity limit={10} showVotes />
      </div>
    </>
  );
}
