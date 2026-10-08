import { parseEther, type Address } from "viem";
import { agentTokenURI } from "../../../src/lib/chain/claims";
import { C, chain, confirm, fmt, hd, operator, publicClient, wallet } from "./clients";
import { env } from "./env";
import { log } from "./log";
import { privyAgentSigner, privyEnabled } from "./privy";
import { call, localSigner, type AgentSigner } from "./signer";

export const ROLE = { Trader: 1, Validator: 2, Challenger: 3 } as const;

export interface AgentAccount {
  name: string;
  role: (typeof ROLE)[keyof typeof ROLE];
  address: Address;
  signer: AgentSigner;
}

const VALIDATOR_NAMES = ["Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta"];

export interface Agents {
  trader: AgentAccount;
  liar: AgentAccount;
  validators: AgentAccount[];
  challenger: AgentAccount;
}

const local = (name: string, role: AgentAccount["role"], index: number): AgentAccount => {
  const signer = localSigner(hd(index));
  return { name, role, address: signer.address, signer };
};

let cached: Agents | null = null;
let validatorsOnly: AgentAccount[] | null = null;

/**
 * Validators + challenger: Privy server wallets when PRIVY_APP_ID/SECRET are set, otherwise HD accounts 3–9
 * from MNEMONIC. Traders always come from MNEMONIC (1 = honest, 2 = adversarial) — they're the "client" agents.
 */
async function loadNetwork(): Promise<{ validators: AgentAccount[]; challenger: AgentAccount }> {
  if (privyEnabled) {
    const validators: AgentAccount[] = [];
    for (const n of VALIDATOR_NAMES) {
      const signer = await privyAgentSigner(`validator-${n.toLowerCase()}`, "validator", `Talidator Validator ${n}`);
      validators.push({ name: `Validator ${n}`, role: ROLE.Validator, address: signer.address, signer });
    }
    const cs = await privyAgentSigner("challenger", "challenger", "Talidator Challenger");
    return { validators, challenger: { name: "Challenger", role: ROLE.Challenger, address: cs.address, signer: cs } };
  }
  return {
    validators: VALIDATOR_NAMES.map((n, i) => local(`Validator ${n}`, ROLE.Validator, 3 + i)),
    challenger: local("Challenger", ROLE.Challenger, 9),
  };
}

/** All demo agents (needs MNEMONIC for the two traders). */
export async function getAgents(): Promise<Agents> {
  if (cached) return cached;
  const net = await loadNetwork();
  validatorsOnly = net.validators;
  cached = {
    trader: local("Momentum Trader", ROLE.Trader, 1),
    liar: local("Shady Trader (adversarial demo)", ROLE.Trader, 2),
    ...net,
  };
  return cached;
}

let challengerOnly: AgentAccount | null = null;

/** Just the validator network (what the daemon runs) — no trader keys required. */
export async function getValidatorNetwork() {
  if (!validatorsOnly) {
    const net = await loadNetwork();
    validatorsOnly = net.validators;
    challengerOnly = net.challenger;
  }
  return validatorsOnly;
}

/** The challenger agent (used by the daemon's autonomous auditor). */
export async function getChallenger() {
  if (!challengerOnly) await getValidatorNetwork();
  return challengerOnly!;
}

export const allAgents = (a: Agents) => [a.trader, a.liar, ...a.validators, a.challenger];

export const nameOf = (a: AgentAccount[], address: Address) =>
  a.find((x) => x.address.toLowerCase() === address.toLowerCase())?.name ?? address;

export async function agentId(address: Address) {
  return publicClient.readContract({ ...C.identity, functionName: "agentIdOfWallet", args: [address] });
}

/** Top up an agent from the operator so it can pay gas / bonds (skipped on the local chain). */
async function fund(a: AgentAccount, target: bigint) {
  if (chain.id === 31337) return;
  const bal = await publicClient.getBalance({ address: a.address });
  if (bal >= target) return;
  const hash = await wallet(operator).sendTransaction({ to: a.address, value: target - bal, chain, account: operator });
  await confirm(hash);
  log.info(`funded ${a.name} with ${fmt(target - bal)}`);
}

/**
 * Idempotent: registers each agent's ERC-8004 identity and keeps each validator bonded at 1.5× the minimum
 * (so a single 30% slash leaves it active). Safe to run before every demo / daemon start.
 */
export async function ensureSetup(list: AgentAccount[]) {
  const [minBond, challengeBond] = await Promise.all([
    publicClient.readContract({ ...C.staking, functionName: "minBond" }),
    publicClient.readContract({ ...C.market, functionName: "challengeBond" }),
  ]);
  const gas = parseEther(env("AGENT_GAS_BUFFER") ?? "0.03");
  const targetBond = (minBond * 3n) / 2n;

  for (const a of list) {
    const extra = a.role === ROLE.Validator ? targetBond : a.role === ROLE.Challenger ? challengeBond * 2n : 0n;
    await fund(a, extra + gas);

    let id = await agentId(a.address);
    if (id === 0n) {
      await call(a.signer, C.identity, "register", [agentTokenURI(a.name), a.role, a.address]);
      id = await agentId(a.address);
      log.ok(`registered ${a.name} as agent #${id}${a.signer.kind === "privy" ? " (Privy server wallet)" : ""}`);
    }

    if (a.role === ROLE.Validator) {
      const stake = await publicClient.readContract({ ...C.staking, functionName: "getStake", args: [a.address] });
      if (stake.unbondAt === 0n && stake.amount < targetBond) {
        await call(a.signer, C.staking, "bond", [id], targetBond - stake.amount);
        log.ok(`${a.name} bonded → ${fmt(targetBond)}`);
      }
    }
  }
}
