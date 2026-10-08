"use client";

import { BaseError, parseEther, type Address, type Hex } from "viem";
import { getConnection, switchChain, waitForTransactionReceipt, writeContract } from "wagmi/actions";
import { agentTokenURI, encodeClaim } from "./chain/claims";
import { CHAIN_ID, contracts, publicClient, wagmiConfig } from "./chain/config";
import { fabricatedClaim, honestClaim, type Pair } from "./chain/market";
import { useStore, type Scenario } from "./store";
import type { AgentRole, Asset } from "./types";

const ROLE_ID: Record<AgentRole, number> = { trader: 1, validator: 2, challenger: 3 };

export interface StartInput {
  agent: string;
  asset: Asset;
  quote: string;
  size: number;
  payment: number;
  scenario: Scenario;
  /** explicit validator set; otherwise 3 are sampled from active validators */
  validators?: string[];
}

function errorMessage(e: unknown) {
  if (e instanceof BaseError) return e.shortMessage;
  return e instanceof Error ? e.message.split("\n")[0] : String(e);
}

/** Wallet transactions against the Talidator contracts on Monad testnet. */
export function useActions() {
  const { state, dispatch } = useStore();
  const toast = (tone: "success" | "danger" | "info", title: string, detail?: string) => dispatch({ type: "TOAST", tone, title, detail });

  async function ensureWallet(): Promise<Address> {
    if (!contracts) throw new Error("Contracts are not deployed on Monad testnet yet");
    const conn = getConnection(wagmiConfig);
    if (!conn.isConnected || !conn.address) throw new Error("Connect a wallet first");
    if (conn.chainId !== CHAIN_ID) await switchChain(wagmiConfig, { chainId: CHAIN_ID });
    return conn.address;
  }

  /** Send one tx, wait for it, toast the result. Returns false if it failed or was rejected. */
  async function send(label: string, fn: () => Promise<Hex>) {
    try {
      toast("info", `${label}…`, "Confirm in your wallet");
      const hash = await fn();
      const receipt = await waitForTransactionReceipt(wagmiConfig, { hash, chainId: CHAIN_ID });
      if (receipt.status !== "success") throw new Error(`Transaction reverted (${hash.slice(0, 10)}…)`);
      toast("success", label, `${hash.slice(0, 10)}…${hash.slice(-6)}`);
      return true;
    } catch (e) {
      toast("danger", `${label} failed`, errorMessage(e));
      return false;
    } finally {
      dispatch({ type: "REFRESH" });
    }
  }

  /** Run a wallet flow, surfacing setup errors (no wallet, wrong chain…) as a toast. */
  async function guarded(label: string, fn: (c: NonNullable<typeof contracts>, me: Address) => Promise<unknown>) {
    try {
      const me = await ensureWallet();
      return await fn(contracts!, me);
    } catch (e) {
      toast("danger", label, errorMessage(e));
      return false;
    }
  }

  return {
    startValidation: (input: StartInput) =>
      guarded("Could not start validation", async (c, me) => {
        const trader = state.agents.find((a) => a.address === input.agent);
        if (!trader) throw new Error("Pick a trader agent");
        if (trader.owner.toLowerCase() !== me.toLowerCase() && trader.address.toLowerCase() !== me.toLowerCase()) {
          throw new Error("Your wallet must own this trader identity (or be its agent wallet)");
        }
        const pair = `${input.asset}/${input.quote}` as Pair;
        const seed = Math.floor(Date.now() / 1000);
        const nonce = `${seed}-${Math.random().toString(36).slice(2, 8)}`;
        const claim = input.scenario === "honest"
          ? await honestClaim(publicClient, BigInt(trader.tokenId), pair, input.size, seed, nonce)
          : await fabricatedClaim(publicClient, BigInt(trader.tokenId), pair, input.size, seed, nonce);
        const { uri, requestHash } = encodeClaim(claim);

        let set = input.validators ?? [];
        if (set.length === 0) {
          const pool = state.validators.filter((v) => v.status === "active" && v.address.toLowerCase() !== trader.address.toLowerCase());
          set = [...pool].sort(() => Math.random() - 0.5).slice(0, 3).map((v) => v.address);
        }
        if (set.length === 0) throw new Error("No active validators are bonded yet");

        dispatch({ type: "START_OPEN", open: false });
        if (input.payment > 0) {
          const ok = await send("Escrow payment", () => writeContract(wagmiConfig, {
            ...c.escrow, functionName: "deposit", args: [requestHash, trader.address as Address], value: parseEther(String(input.payment)),
          }));
          if (!ok) return false;
        }
        return send("Validation requested", () => writeContract(wagmiConfig, {
          ...c.registry, functionName: "validationRequest", args: [set as Address[], BigInt(trader.tokenId), uri, requestHash],
        }));
      }),

    challenge: (id: number) =>
      guarded("Challenge failed", async (c) => {
        const r = state.requests.find((x) => x.id === id);
        if (!r) throw new Error("Request not found");
        if (!state.params) throw new Error("Protocol parameters not loaded yet");
        const bond = state.params.challengeBond;
        return send(`Challenge #${id}`, () => writeContract(wagmiConfig, {
          ...c.market, functionName: "challenge", args: [r.requestHash as Hex], value: parseEther(String(bond)),
        }));
      }),

    registerAgent: (name: string, role: AgentRole, agentWallet?: string) =>
      guarded("Registration failed", (c, me) =>
        send(`Register ${name}`, () => writeContract(wagmiConfig, {
          ...c.identity, functionName: "register", args: [agentTokenURI(name), ROLE_ID[role], (agentWallet || me) as Address],
        }))),

    bond: (validator: string, amount: number) =>
      guarded("Bond failed", async (c) => {
        const agent = state.agents.find((a) => a.address.toLowerCase() === validator.toLowerCase());
        if (!agent) throw new Error("Validator identity not found");
        return send("Bond stake", () => writeContract(wagmiConfig, {
          ...c.staking, functionName: "bond", args: [BigInt(agent.tokenId)], value: parseEther(String(amount)),
        }));
      }),

    unbondOrWithdraw: (validator: string) =>
      guarded("Unbonding failed", async (c) => {
        const v = state.validators.find((x) => x.address.toLowerCase() === validator.toLowerCase());
        return v?.status === "unbonding"
          ? send("Withdraw stake", () => writeContract(wagmiConfig, { ...c.staking, functionName: "withdraw" }))
          : send("Begin unbonding", () => writeContract(wagmiConfig, { ...c.staking, functionName: "beginUnbonding" }));
      }),

    /** Keeper action anyone can call: settle escrow once a result exists. */
    settleEscrow: (id: number, release: boolean) =>
      guarded("Settlement failed", async (c) => {
        const r = state.requests.find((x) => x.id === id);
        if (!r) throw new Error("Request not found");
        return send(release ? "Release payment" : "Refund payment", () => writeContract(wagmiConfig, {
          ...c.escrow, functionName: release ? "release" : "refund", args: [r.requestHash as Hex],
        }));
      }),
  };
}
