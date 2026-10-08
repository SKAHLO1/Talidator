/**
 * Talidator keeper — a Chainlink CRE workflow that orchestrates Talidator's upkeep on Monad testnet.
 *
 * Every run (cron):
 *   1. EVM read  — KeeperReceiver.pendingActions(): which requests need finalize / escrow release / refund /
 *                  reputation posting (computed on-chain, one call).
 *   2. HTTP      — asks Talidator's AI auditor (Qwen agent, via /api/audit/flags) whether any result about to be
 *                  paid out was flagged as wrong; flagged releases are held back so a challenge can land first.
 *                  Identical consensus across DON nodes (the endpoint only serves stored verdicts).
 *   3. EVM write — a signed report with the remaining actions, delivered by the CRE Forwarder to
 *                  KeeperReceiver.onReport(), which executes each action with try/catch.
 */
import {
  cre,
  consensusIdenticalAggregation,
  encodeCallMsg,
  EVMClient,
  getNetwork,
  LAST_FINALIZED_BLOCK_NUMBER,
  prepareReportRequest,
  Runner,
  TxStatus,
  bytesToHex,
  type HTTPSendRequester,
  type Runtime,
} from "@chainlink/cre-sdk";
import { decodeFunctionResult, encodeAbiParameters, encodeFunctionData, parseAbi, zeroAddress, type Address, type Hex } from "viem";
import { z } from "zod";

const configSchema = z.object({
  schedule: z.string(),
  chainSelectorName: z.string(),
  keeperAddress: z.string(),
  auditFlagsUrl: z.string().optional(),
  batchLimit: z.number().int().positive(),
  writeGasLimit: z.string(),
});
type Config = z.infer<typeof configSchema>;

const keeperAbi = parseAbi(["function pendingActions(uint256 limit) view returns (uint8[] actions, bytes32[] hashes)"]);
const ACTION = ["None", "Finalize", "Release", "Refund", "PostReputation"] as const;
const RELEASE = 2;

/** HTTP fetch run on each DON node; the result must be identical across nodes. */
const fetchFlags = (sender: HTTPSendRequester, url: string): string => {
  const res = sender.sendRequest({ method: "GET", url }).result();
  if (res.statusCode !== 200) throw new Error(`audit flags HTTP ${res.statusCode}`);
  const body = JSON.parse(Buffer.from(res.body).toString("utf-8")) as { flagged?: string[] };
  return (body.flagged ?? []).map((h) => h.toLowerCase()).sort().join(",");
};

const onCron = (runtime: Runtime<Config>): string => {
  const config = runtime.config;
  if (/^0x0{40}$/i.test(config.keeperAddress)) throw new Error("Set keeperAddress in the workflow config (deploy KeeperReceiver first)");

  const network = getNetwork({ chainFamily: "evm", chainSelectorName: config.chainSelectorName });
  if (!network) throw new Error(`Network not found: ${config.chainSelectorName}`);
  const evm = new EVMClient(network.chainSelector.selector);
  const keeper = config.keeperAddress as Address;

  // 1 · What upkeep is due?
  const read = evm
    .callContract(runtime, {
      call: encodeCallMsg({
        from: zeroAddress,
        to: keeper,
        data: encodeFunctionData({ abi: keeperAbi, functionName: "pendingActions", args: [BigInt(config.batchLimit)] }),
      }),
      blockNumber: LAST_FINALIZED_BLOCK_NUMBER,
    })
    .result();
  const [actionsRaw, hashesRaw] = decodeFunctionResult({ abi: keeperAbi, functionName: "pendingActions", data: bytesToHex(read.data) });
  let actions = [...actionsRaw];
  let hashes = [...hashesRaw] as Hex[];
  runtime.log(`pending: ${actions.map((a, i) => `${ACTION[a] ?? a}(${hashes[i]!.slice(0, 10)})`).join(", ") || "none"}`);
  if (actions.length === 0) return "nothing to do";

  // 2 · AI-gated payouts: hold releases the auditor agent flagged as wrong.
  const releases = hashes.filter((_, i) => actions[i] === RELEASE);
  if (config.auditFlagsUrl && releases.length > 0) {
    const url = `${config.auditFlagsUrl}?requestHashes=${releases.join(",")}`;
    const flagged = new Set(
      new cre.capabilities.HTTPClient()
        .sendRequest(runtime, fetchFlags, consensusIdenticalAggregation<string>())(url)
        .result()
        .split(",")
        .filter(Boolean),
    );
    if (flagged.size) {
      runtime.log(`holding ${flagged.size} release(s) flagged by the AI auditor: ${[...flagged].join(", ")}`);
      const keep = actions.map((a, i) => !(a === RELEASE && flagged.has(hashes[i]!.toLowerCase())));
      actions = actions.filter((_, i) => keep[i]);
      hashes = hashes.filter((_, i) => keep[i]);
    }
    if (actions.length === 0) return "all pending releases held by the auditor";
  }

  // 3 · Signed report → CRE Forwarder → KeeperReceiver.onReport()
  const payload = encodeAbiParameters([{ type: "uint8[]" }, { type: "bytes32[]" }], [actions, hashes]);
  const report = runtime.report(prepareReportRequest(payload)).result();
  const write = evm.writeReport(runtime, { receiver: keeper, report, gasConfig: { gasLimit: config.writeGasLimit } }).result();
  if (write.txStatus !== TxStatus.SUCCESS) throw new Error(`keeper report failed: ${write.errorMessage || write.txStatus}`);
  const tx = bytesToHex(write.txHash || new Uint8Array(32));
  runtime.log(`executed ${actions.length} action(s) · tx ${tx}`);
  return tx;
};

function initWorkflow(config: Config) {
  return [cre.handler(new cre.capabilities.CronCapability().trigger({ schedule: config.schedule }), onCron)];
}

export async function main() {
  const runner = await Runner.newRunner<Config>({ configSchema });
  await runner.run(initWorkflow);
}

main();
