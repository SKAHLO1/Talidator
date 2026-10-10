# Talidator validator / relayer / keeper daemon — long-running, so it can't live on Vercel.
# Build from the REPO ROOT (the agents share src/lib/chain with the web app):
#
#   docker build -f contracts/Dockerfile -t talidator-daemon .
#   docker run --env-file contracts/.env talidator-daemon
#
# Required env: PRIVATE_KEY (operator / relayer, funded with MON) and either PRIVY_APP_ID + PRIVY_APP_SECRET
# (validators on Privy server wallets) or MNEMONIC. Optional: ALCHEMY_API_KEY / RPC_URL, AUDITOR=on + QWEN_API_KEY,
# KEEPER=off (when the Chainlink CRE workflow is the keeper), COLLUDING, POLL_MS, AGENT_GAS_BUFFER.
# PORT (set automatically by Render web services) serves a /health JSON endpoint for uptime pingers.
FROM node:22-slim

WORKDIR /app

# Shared chain modules (ABIs, claims, market data) import viem from the repo root's node_modules.
COPY package.json package-lock.json ./
RUN node -e "const p=require('./package.json');require('fs').writeFileSync('package.json',JSON.stringify({name:'talidator-shared',private:true,dependencies:{viem:p.dependencies.viem}}))" \
  && npm install --omit=dev --no-audit --no-fund

COPY contracts/package.json contracts/package-lock.json contracts/
RUN cd contracts && npm ci --no-audit --no-fund

COPY src/lib/chain src/lib/chain
COPY src/lib/agent src/lib/agent
COPY contracts/agents contracts/agents
COPY contracts/deployments contracts/deployments
COPY contracts/tsconfig.json contracts/

WORKDIR /app/contracts
ENV NODE_ENV=production
CMD ["npx", "tsx", "agents/validator-daemon.ts", "--network", "monadTestnet"]
