/**
 * Runs a Foundry binary (forge / anvil / cast) whether or not Foundry is on PATH —
 * falls back to ~/.foundry/bin. Usage: tsx scripts/forge.ts <forge|anvil|cast> [...args]
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function foundryBin(tool: string) {
  const exe = process.platform === "win32" ? `${tool}.exe` : tool;
  const local = join(process.env.FOUNDRY_DIR ?? join(homedir(), ".foundry"), "bin", exe);
  return existsSync(local) ? local : tool;
}

export function run(tool: string, args: string[], extraEnv: Record<string, string> = {}) {
  const res = spawnSync(foundryBin(tool), args, {
    stdio: "inherit",
    env: { ...process.env, FOUNDRY_DISABLE_NIGHTLY_WARNING: "1", ...extraEnv },
  });
  if (res.error) throw res.error;
  return res.status ?? 1;
}

if (process.argv[1]?.endsWith("forge.ts")) {
  const [tool, ...args] = process.argv.slice(2);
  process.exit(run(tool, args));
}
