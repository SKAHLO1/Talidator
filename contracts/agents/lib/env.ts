import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const envFile = fileURLToPath(new URL("../../.env", import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

function arg(name: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

export const NETWORK = (arg("network") ?? process.env.NETWORK ?? "local") as "local" | "monadTestnet";
export const env = (key: string) => process.env[key];
export { arg };
