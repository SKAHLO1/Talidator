/**
 * Submit a single validation request — handy for live demos / recordings alongside the daemon.
 *
 *   npm run request -- --network monadTestnet              # honest trade by the Momentum Trader
 *   npm run request -- --network monadTestnet --liar       # fabricated claim by the adversarial trader
 *   npm run request -- --validators 0,1,2 --pair BTC/USD  # pick validators (indexes into Alpha..Zeta) / pair
 */
import { parseEther } from "viem";
import { describeClaim, encodeClaim } from "../../src/lib/chain/claims";
import { fabricatedClaim, honestClaim, PAIRS, type Pair } from "../../src/lib/chain/market";
import { agentId, ensureSetup, getAgents } from "./lib/agents";
import { C, chain, confirm, fmt, operator, publicClient, wallet } from "./lib/clients";
import { arg, env } from "./lib/env";
import { log } from "./lib/log";
import { call } from "./lib/signer";

const liar = process.argv.includes("--liar");
const pair = (arg("pair") ?? (liar ? "BTC/USD" : "ETH/USD")) as Pair;
if (!PAIRS.includes(pair)) throw new Error(`--pair must be one of ${PAIRS.join(", ")}`);
const picks = (arg("validators") ?? "0,1,2").split(",").map(Number);
const payment = parseEther(env("DEMO_PAYMENT") ?? "0.01");

const agents = await getAgents();
const trader = liar ? agents.liar : agents.trader;
await ensureSetup([trader, ...picks.map((i) => agents.validators[i]!)]);
const id = await agentId(trader.address);
const seed = Math.floor(Date.now() / 1000);
const size = Number(arg("size") ?? (pair === "BTC/USD" ? 0.05 : pair === "LINK/USD" ? 50 : 1));
const claim = await (liar ? fabricatedClaim : honestClaim)(publicClient, id, pair, size, seed, `${seed}-cli`);
const { uri, requestHash } = encodeClaim(claim);
const set = picks.map((i) => agents.validators[i]!.address);

log.title(`${liar ? "Fabricated" : "Honest"} request on ${chain.name}`);
log.step(`${trader.name}: ${describeClaim(claim).task} · ${pair} · PnL ${claim.reportedPnl}`);
const dep = await wallet(operator).writeContract({ ...C.escrow, functionName: "deposit", args: [requestHash, trader.address], value: payment, chain, account: operator });
log.tx(`Escrow.deposit(${fmt(payment)})`, await confirm(dep));
log.tx("validationRequest()", await call(trader.signer, C.registry, "validationRequest", [set, id, uri, requestHash]));
log.ok(`requestHash ${requestHash} — validators: ${picks.map((i) => agents.validators[i]!.name).join(", ")}`);
