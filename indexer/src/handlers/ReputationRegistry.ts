import { indexer } from "envio";
import { recordEvent } from "../lib/events";
import { lc } from "../lib/util";

// Reputation is derived only from final validation outcomes; mirror the on-chain average per agent.
indexer.onEvent({ contract: "ReputationRegistry", event: "NewFeedback" }, async ({ event, context }) => {
  const agentId = event.params.agentId.toString();
  const requestId = lc(event.params.requestHash);
  const score = Number(event.params.score);
  const agent = await context.Agent.get(agentId);
  if (agent) {
    const count = agent.reputationCount + 1;
    const sum = agent.reputationScoreSum + score;
    context.Agent.set({
      ...agent,
      reputationCount: count,
      reputationPassed: agent.reputationPassed + (event.params.passed ? 1 : 0),
      reputationScoreSum: sum,
      reputationScore: Math.floor((sum * 100) / count),
    });
  }
  const request = await context.ValidationRequest.get(requestId);
  if (request) context.ValidationRequest.set({ ...request, reputationPosted: true });
  recordEvent(context, event, {
    kind: "reputation",
    title: "Reputation posted",
    detail: `${request ? `Trade #${request.seq}` : requestId.slice(0, 10)} · ${agent?.name ?? `agent #${agentId}`} scored ${score}`,
    requestHash: requestId,
    actors: [agent?.wallet ?? "", agent?.owner ?? ""],
  });
});
