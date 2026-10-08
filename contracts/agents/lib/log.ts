import type { Hex } from "viem";
import { explorerTx } from "./clients";

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

export const log = {
  title: (s: string) => console.log(`\n${c.bold(c.cyan("━━ " + s + " " + "━".repeat(Math.max(0, 60 - s.length))))}`),
  step: (s: string) => console.log(`  ${c.bold("›")} ${s}`),
  info: (s: string) => console.log(`    ${c.dim(s)}`),
  ok: (s: string) => console.log(`  ${c.green("✔")} ${s}`),
  bad: (s: string) => console.log(`  ${c.red("✘")} ${s}`),
  warn: (s: string) => console.log(`  ${c.yellow("!")} ${s}`),
  tx: (label: string, hash: Hex) => console.log(`    ${c.dim(label.padEnd(34))} ${c.cyan(explorerTx(hash))}`),
  c,
};
