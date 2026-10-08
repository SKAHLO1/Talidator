import { indexer, type Agent } from "envio";
import { recordEvent } from "../lib/events";
import { bumpStats, decodeDataUri, lc, ROLE_NAMES, short } from "../lib/util";

const ZERO = "0x0000000000000000000000000000000000000000";

// Registered(agentId, tokenURI, owner) is emitted right before AgentRegistered in the same tx;
// create the agent here so the token URI / name are known.
indexer.onEvent({ contract: "IdentityRegistry", event: "Registered" }, async ({ event, context }) => {
  const id = event.params.agentId.toString();
  const meta = decodeDataUri(event.params.tokenURI);
  const existing = await context.Agent.get(id);
  const agent: Agent = {
    id,
    tokenId: event.params.agentId,
    owner: lc(event.params.owner),
    wallet: existing?.wallet ?? "",
    role: existing?.role ?? "TRADER",
    name: typeof meta?.name === "string" && meta.name ? meta.name : `Agent #${id}`,
    tokenURI: event.params.tokenURI,
    registeredAt: event.block.timestamp,
    registeredTx: event.transaction.hash,
    reputationCount: existing?.reputationCount ?? 0,
    reputationPassed: existing?.reputationPassed ?? 0,
    reputationScoreSum: existing?.reputationScoreSum ?? 0,
    reputationScore: existing?.reputationScore ?? 0,
  };
  context.Agent.set(agent);
  await bumpStats(context, (s) => ({ agents: s.agents + 1 }));
});

indexer.onEvent({ contract: "IdentityRegistry", event: "AgentRegistered" }, async ({ event, context }) => {
  const id = event.params.agentId.toString();
  const role = ROLE_NAMES[Number(event.params.role) as 1 | 2 | 3] ?? "TRADER";
  const agent = await context.Agent.getOrThrow(id);
  context.Agent.set({ ...agent, role, wallet: lc(event.params.agentWallet) });
  recordEvent(context, event, {
    kind: "registered",
    title: role === "VALIDATOR" ? "Validator registered" : role === "CHALLENGER" ? "Challenger registered" : "Agent registered",
    detail: `${agent.name} · ${short(event.params.agentWallet)}`,
    actors: [event.params.agentWallet, agent.owner],
  });
});

// Identity NFTs can change hands; keep the owner current (mint is handled by Registered).
indexer.onEvent({ contract: "IdentityRegistry", event: "Transfer" }, async ({ event, context }) => {
  if (lc(event.params.from) === ZERO) return;
  const agent = await context.Agent.get(event.params.tokenId.toString());
  if (agent) context.Agent.set({ ...agent, owner: lc(event.params.to) });
});
