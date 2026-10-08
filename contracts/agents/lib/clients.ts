import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, formatEther, http, type Account, type Hex } from "viem";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { foundry, monadTestnet } from "viem/chains";
import {
  challengeMarketAbi, escrowAbi, identityRegistryAbi, reputationRegistryAbi, validationRegistryAbi, validatorStakingAbi,
} from "../../../src/lib/chain/abi";
import type { Deployment } from "../../../src/lib/chain/deployments";
import { NETWORK, env } from "./env";

export const chain = NETWORK === "monadTestnet" ? monadTestnet : foundry;
// RPC_URL wins; otherwise Alchemy's Monad testnet node when ALCHEMY_API_KEY is set; otherwise the public RPC.
const alchemyUrl = env("ALCHEMY_API_KEY") ? `https://monad-testnet.g.alchemy.com/v2/${env("ALCHEMY_API_KEY")}` : undefined;
const rpcUrl = env("RPC_URL") || (chain.id === monadTestnet.id ? alchemyUrl : undefined) || chain.rpcUrls.default.http[0];
export const rpcProvider = env("RPC_URL") ? "custom" : alchemyUrl && chain.id === monadTestnet.id ? "alchemy" : "public";

// Multicall batching keeps Chainlink round reads inside public-RPC rate limits (Monad: 15 req/s).
export const publicClient = createPublicClient({ chain, transport: http(rpcUrl), pollingInterval: 500, batch: { multicall: { wait: 16 } } });

// Anvil's well-known public test mnemonic — only ever used for the local chain.
const ANVIL_MNEMONIC = "test test test test test test test test test test test junk";
const mnemonic = env("MNEMONIC") ?? (chain.id === foundry.id ? ANVIL_MNEMONIC : undefined);

/** HD account from MNEMONIC (required for any agent not backed by a Privy server wallet). */
export const hd = (index: number) => {
  if (!mnemonic) throw new Error("Set MNEMONIC in contracts/.env — mnemonic-backed agent accounts are derived from it (see .env.example).");
  return mnemonicToAccount(mnemonic, { addressIndex: index });
};

/** Deployer / client / relayer / arbiter. */
export const operator: Account = env("PRIVATE_KEY") ? privateKeyToAccount(env("PRIVATE_KEY") as Hex) : hd(0);

export const wallet = (account: Account) => createWalletClient({ account, chain, transport: http(rpcUrl) });

// Agents read the deploy script's output directly (the web app only receives the Monad testnet one).
const depFile = fileURLToPath(new URL(`../../deployments/${chain.id}.json`, import.meta.url));
if (!existsSync(depFile)) {
  throw new Error(`No deployment for chain ${chain.id}. Run \`npm run deploy:${NETWORK === "monadTestnet" ? "monad" : "local"}\` first.`);
}
const dep = JSON.parse(readFileSync(depFile, "utf8")) as Deployment;
export const deployment = dep;

export const C = {
  identity: { address: dep.IdentityRegistry, abi: identityRegistryAbi },
  staking: { address: dep.ValidatorStaking, abi: validatorStakingAbi },
  registry: { address: dep.ValidationRegistry, abi: validationRegistryAbi },
  escrow: { address: dep.Escrow, abi: escrowAbi },
  market: { address: dep.ChallengeMarket, abi: challengeMarketAbi },
  reputation: { address: dep.ReputationRegistry, abi: reputationRegistryAbi },
} as const;

export const explorerTx = (hash: Hex) =>
  chain.blockExplorers ? `${chain.blockExplorers.default.url}/tx/${hash}` : hash;

/** Wait for a tx, throw on revert, and return its hash. */
export async function confirm(hash: Hex) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`tx reverted: ${hash}`);
  return hash;
}

export const fmt = (wei: bigint) => `${Number(formatEther(wei)).toFixed(4)} ${chain.nativeCurrency.symbol}`;
