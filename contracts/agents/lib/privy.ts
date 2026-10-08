/**
 * Privy server wallets for Talidator's validator and challenger agents.
 *
 * Instead of deriving agent keys from a mnemonic on the daemon's host, each agent gets a Privy-managed wallet
 * (keys never leave Privy's enclave) bound to a Privy *policy* that encodes exactly what that role may do:
 *
 *   validator  — sign EIP-712 votes for the ValidationRegistry on Monad testnet only; register its identity;
 *                bond (with a per-tx value cap) / unbond / withdraw on ValidatorStaking; review challenges.
 *   challenger — register; open challenges (bond capped) and withdraw credits on the ChallengeMarket.
 *
 * Anything else (arbitrary transfers, other contracts, other chains, key export) is denied by default — so a
 * compromised daemon can't drain or repurpose the agents' wallets.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PrivyClient } from "@privy-io/node";
import { parseEther, toHex, type Address, type Hex, type TypedDataDefinition } from "viem";
import { C, chain } from "./clients";
import { env } from "./env";
import type { AgentSigner } from "./signer";

export const privyEnabled = Boolean(env("PRIVY_APP_ID") && env("PRIVY_APP_SECRET"));
const CAIP2 = `eip155:${chain.id}` as const;
const STATE_FILE = fileURLToPath(new URL("../../.privy-state.json", import.meta.url));

let client: PrivyClient | null = null;
function privy() {
  if (!privyEnabled) throw new Error("Set PRIVY_APP_ID and PRIVY_APP_SECRET in contracts/.env to use Privy server wallets.");
  client ??= new PrivyClient({ appId: env("PRIVY_APP_ID")!, appSecret: env("PRIVY_APP_SECRET")! });
  return client;
}

type State = { chainId: number; contracts: string; policies: Record<string, string> };
const contractsKey = () => [C.identity, C.staking, C.registry, C.market].map((c) => c.address.toLowerCase()).join(",");
function loadState(): State {
  if (existsSync(STATE_FILE)) {
    const s = JSON.parse(readFileSync(STATE_FILE, "utf8")) as State;
    // Policies pin contract addresses — a redeploy needs fresh policies.
    if (s.chainId === chain.id && s.contracts === contractsKey()) return s;
  }
  return { chainId: chain.id, contracts: contractsKey(), policies: {} };
}
const saveState = (s: State) => writeFileSync(STATE_FILE, JSON.stringify(s, null, 2) + "\n");

// Minimal ABI fragments for calldata conditions.
const fn = (name: string, inputs: string[]) => ({ type: "function" as const, name, inputs: inputs.map((type, i) => ({ name: `a${i}`, type })), outputs: [], stateMutability: "nonpayable" as const });
const ABI = {
  register: [fn("register", ["string", "uint8", "address"])],
  bond: [fn("bond", ["uint256"])],
  beginUnbonding: [fn("beginUnbonding", [])],
  withdraw: [fn("withdraw", [])],
  submitReview: [fn("submitReview", ["uint256", "bool"])],
  challenge: [fn("challenge", ["bytes32"])],
  withdrawCredits: [fn("withdrawCredits", [])],
};

const to = (address: Address) => ({ field_source: "ethereum_transaction", field: "to", operator: "eq", value: address.toLowerCase() });
const onChain = { field_source: "ethereum_transaction", field: "chain_id", operator: "eq", value: String(chain.id) };
const call = (name: keyof typeof ABI) => ({ field_source: "ethereum_calldata", field: "function_name", operator: "eq", value: name, abi: ABI[name] });
const maxValue = (wei: bigint) => ({ field_source: "ethereum_transaction", field: "value", operator: "lte", value: toHex(wei) });
const tx = (name: string, conditions: object[]) => ({ name, method: "eth_sendTransaction", action: "ALLOW", conditions: [onChain, ...conditions] });

function policyFor(role: "validator" | "challenger") {
  const maxBond = parseEther(env("PRIVY_MAX_BOND") ?? "1");
  const register = tx("Register ERC-8004 identity", [to(C.identity.address), call("register"), maxValue(0n)]);
  if (role === "validator") {
    return {
      version: "1.0" as const,
      name: "talidator-validator",
      chain_type: "ethereum" as const,
      rules: [
        {
          name: "Sign Talidator votes (EIP-712) for this ValidationRegistry on Monad only",
          method: "eth_signTypedData_v4",
          action: "ALLOW",
          conditions: [
            { field_source: "ethereum_typed_data_domain", field: "verifyingContract", operator: "eq", value: C.registry.address.toLowerCase() },
            { field_source: "ethereum_typed_data_domain", field: "chainId", operator: "eq", value: String(chain.id) },
          ],
        },
        register,
        tx(`Bond stake (≤ ${env("PRIVY_MAX_BOND") ?? "1"} MON per tx)`, [to(C.staking.address), call("bond"), maxValue(maxBond)]),
        tx("Begin unbonding", [to(C.staking.address), call("beginUnbonding"), maxValue(0n)]),
        tx("Withdraw unbonded stake", [to(C.staking.address), call("withdraw"), maxValue(0n)]),
        tx("Review challenges", [to(C.market.address), call("submitReview"), maxValue(0n)]),
      ],
    };
  }
  return {
    version: "1.0" as const,
    name: "talidator-challenger",
    chain_type: "ethereum" as const,
    rules: [
      register,
      tx("Open challenges (bond capped)", [to(C.market.address), call("challenge"), maxValue(maxBond)]),
      tx("Withdraw challenge credits", [to(C.market.address), call("withdrawCredits"), maxValue(0n)]),
    ],
  };
}

/** Create (once) and cache the role policy; returns its id. */
async function ensurePolicy(role: "validator" | "challenger") {
  const state = loadState();
  if (state.policies[role]) return state.policies[role]!;
  const policy = await privy().policies().create(policyFor(role) as Parameters<ReturnType<PrivyClient["policies"]>["create"]>[0]);
  state.policies[role] = policy.id;
  saveState(state);
  return policy.id;
}

/** Find the agent's wallet by its stable external id, or create it bound to the role policy. */
async function ensureWallet(externalId: string, role: "validator" | "challenger", displayName: string) {
  for await (const w of privy().wallets().list({ external_id: externalId, chain_type: "ethereum" })) {
    return w;
  }
  const policyId = await ensurePolicy(role);
  return privy().wallets().create({
    chain_type: "ethereum",
    external_id: externalId,
    display_name: displayName,
    policy_ids: [policyId],
    idempotency_key: `talidator-${chain.id}-${externalId}`,
  });
}

function privySigner(walletId: string, address: Address): AgentSigner {
  const eth = () => privy().wallets().ethereum();
  return {
    address,
    kind: "privy",
    async signTypedData(td: TypedDataDefinition) {
      const domain = td.domain ?? {};
      const res = await eth().signTypedData(walletId, {
        params: {
          typed_data: {
            domain: { ...domain, chainId: domain.chainId === undefined ? undefined : Number(domain.chainId) } as never,
            types: td.types as never,
            primary_type: td.primaryType as string,
            message: td.message as Record<string, unknown>,
          },
        },
      });
      return res.signature as Hex;
    },
    async send({ to: target, data, value }) {
      const res = await eth().sendTransaction(walletId, {
        caip2: CAIP2,
        params: { transaction: { to: target, data, value: value ? toHex(value) : undefined, chain_id: chain.id } },
      });
      return res.hash as Hex;
    },
  };
}

/** Load (or provision) a Privy-backed signer for a validator / challenger agent. */
export async function privyAgentSigner(slug: string, role: "validator" | "challenger", displayName: string) {
  const w = await ensureWallet(`talidator-${chain.id}-${slug}`, role, displayName);
  return privySigner(w.id, w.address as Address);
}
