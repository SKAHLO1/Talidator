"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { WagmiProvider } from "wagmi";
import { wagmiConfig } from "@/lib/chain/config";
import { AccountProvider } from "@/lib/account/account";
import { StoreProvider } from "@/lib/store";
import { LiveSync } from "./live-sync";

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <StoreProvider>
          <AccountProvider>
            <LiveSync />
            {children}
          </AccountProvider>
        </StoreProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
