/**
 * Deploy all contracts with `forge script`, then export ABIs + addresses to the Next.js app.
 *
 *   npm run deploy:local    (anvil running on :8545)
 *   npm run deploy:monad    (PRIVATE_KEY in contracts/.env, funded with testnet MON)
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { run } from "./forge";

const envFile = fileURLToPath(new URL("../.env", import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

const i = process.argv.indexOf("--network");
const network = i !== -1 ? process.argv[i + 1] : "local";

// Anvil's well-known dev key #0 — public, local chain only.
const ANVIL_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const key = network === "local" ? (process.env.PRIVATE_KEY ?? ANVIL_KEY) : process.env.PRIVATE_KEY;
if (!key) {
  console.error("Set PRIVATE_KEY in contracts/.env to deploy to Monad testnet.");
  process.exit(1);
}

// --keeper deploys only the Chainlink CRE KeeperReceiver against the existing deployment.
const keeper = process.argv.includes("--keeper");
const rpc = network === "local" ? "local" : "monad_testnet";
const script = keeper ? "script/DeployKeeper.s.sol" : "script/Deploy.s.sol";
const code = run("forge", ["script", script, "--rpc-url", rpc, "--broadcast", "--private-key", key]);
if (code !== 0) process.exit(code);

if (!keeper) await import("./export-abi");
