import { createPublicClient, http, isAddress } from "viem";
import { monadTestnet } from "viem/chains";
import { createConfig } from "wagmi";
import { injected } from "wagmi/connectors";
import {
  challengeMarketAbi, escrowAbi, identityRegistryAbi, reputationRegistryAbi, validationRegistryAbi, validatorStakingAbi,
} from "./abi";
import { ALCHEMY_PROXY_ENABLED, ALCHEMY_RPC_URL } from "./alchemy";
import { deployments, type Deployment } from "./deployments";

/** Talidator runs on Monad testnet only. */
export const chain = monadTestnet;
export const CHAIN_ID = monadTestnet.id;
/**
 * RPC selection, most specific first:
 *  1. NEXT_PUBLIC_MONAD_RPC_URL — explicit override (e.g. a local fork)
 *  2. Alchemy — server code calls it directly with ALCHEMY_API_KEY; browsers use the /api/rpc proxy
 *  3. Monad's public RPC
 */
function pickRpc(): { url: string; provider: "custom" | "alchemy" | "public" } {
  if (process.env.NEXT_PUBLIC_MONAD_RPC_URL) return { url: process.env.NEXT_PUBLIC_MONAD_RPC_URL, provider: "custom" };
  if (typeof window === "undefined" && ALCHEMY_RPC_URL) return { url: ALCHEMY_RPC_URL, provider: "alchemy" };
  if (typeof window !== "undefined" && ALCHEMY_PROXY_ENABLED) return { url: `${window.location.origin}/api/rpc`, provider: "alchemy" };
  return { url: monadTestnet.rpcUrls.default.http[0], provider: "public" };
}
const rpc = pickRpc();
export const RPC_URL = rpc.url;
export const RPC_PROVIDER = rpc.provider;
export const EXPLORER = monadTestnet.blockExplorers.default.url;
export const SYMBOL = monadTestnet.nativeCurrency.symbol;

export const wagmiConfig = createConfig({
  chains: [monadTestnet],
  connectors: [injected()],
  transports: { [monadTestnet.id]: http(RPC_URL) },
  ssr: true,
});

/**
 * Reads are batched two ways so a dashboard poll stays within public-RPC rate limits:
 * contract reads issued in the same tick are aggregated into one Multicall3 call, and
 * everything else goes out as JSON-RPC batches.
 */
export const publicClient = createPublicClient({
  chain: monadTestnet,
  transport: http(RPC_URL, { batch: { batchSize: 50 } }),
  batch: { multicall: { batchSize: 4096 } },
});

/**
 * Contract addresses come from NEXT_PUBLIC_* env vars when all six are set (e.g. on Vercel), otherwise from
 * the file the deploy script generates. NEXT_PUBLIC_ vars are inlined at build time, so each one must be read
 * with a literal `process.env.NAME` and a rebuild is needed after changing them.
 */
function deploymentFromEnv(): Deployment | null {
  const env = {
    IdentityRegistry: process.env.NEXT_PUBLIC_IDENTITY_REGISTRY,
    ValidatorStaking: process.env.NEXT_PUBLIC_VALIDATOR_STAKING,
    ValidationRegistry: process.env.NEXT_PUBLIC_VALIDATION_REGISTRY,
    Escrow: process.env.NEXT_PUBLIC_ESCROW,
    ChallengeMarket: process.env.NEXT_PUBLIC_CHALLENGE_MARKET,
    ReputationRegistry: process.env.NEXT_PUBLIC_REPUTATION_REGISTRY,
  };
  const values = Object.values(env);
  if (values.every((v) => !v)) return null;
  const bad = Object.entries(env).filter(([, v]) => !v || !isAddress(v)).map(([k]) => k);
  if (bad.length) {
    throw new Error(`Invalid or missing contract address env vars: ${bad.join(", ")} (set all six or none)`);
  }
  return {
    ...(env as Record<keyof typeof env, `0x${string}`>),
    chainId: CHAIN_ID,
    startBlock: Number(process.env.NEXT_PUBLIC_DEPLOY_BLOCK || 0),
    deployer: "0x0000000000000000000000000000000000000000",
  };
}

export const deployment: Deployment | null = deploymentFromEnv() ?? deployments[CHAIN_ID] ?? null;

export const CONTRACT_INFO = [
  { name: "IdentityRegistry", description: "ERC-8004 ERC-721 agent identities" },
  { name: "ReputationRegistry", description: "Feedback posted only after finalized validations" },
  { name: "ValidationRegistry", description: "N-of-M quorum voting on validationRequest()" },
  { name: "ValidatorStaking", description: "Validator bonds, slashing and withdrawals" },
  { name: "ChallengeMarket", description: "Challenge bonds, fresh-quorum re-verification, payouts" },
  { name: "Escrow", description: "Releases payment only on a passing quorum result" },
] as const;

export const contracts = deployment
  ? ({
      identity: { address: deployment.IdentityRegistry, abi: identityRegistryAbi },
      staking: { address: deployment.ValidatorStaking, abi: validatorStakingAbi },
      registry: { address: deployment.ValidationRegistry, abi: validationRegistryAbi },
      escrow: { address: deployment.Escrow, abi: escrowAbi },
      market: { address: deployment.ChallengeMarket, abi: challengeMarketAbi },
      reputation: { address: deployment.ReputationRegistry, abi: reputationRegistryAbi },
    } as const)
  : null;

export type Contracts = NonNullable<typeof contracts>;

export const explorerTx = (hash: string) => `${EXPLORER}/tx/${hash}`;
export const explorerAddress = (address: string) => `${EXPLORER}/address/${address}`;
