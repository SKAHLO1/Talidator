# Talidator

A working **ERC-8004 Validation Registry** on Monad. Independent validator agents re-execute a trader agent's claimed trade, vote in an N-of-M quorum, and stake bonds behind their votes. Only a validated result unlocks escrowed payment. An open challenge market lets anyone dispute a result, and validators who voted wrong get slashed

```
talidator/
├── src/                 Next.js 16 dashboard (App Router, Tailwind 4, wagmi 3 / viem)
│   ├── lib/chain/       shared with the agents: ABIs, deployments, market data + re-execution, Envio + Alchemy clients
│   └── lib/agent/       Qwen 3.8 Max auditor agent (shared by /api/audit and the daemon)
├── contracts/           Foundry workspace
│   ├── src/             the six protocol contracts + KeeperReceiver (Chainlink CRE)
│   ├── test/            forge tests (44), including the full demo scenarios
│   ├── script/          Deploy.s.sol, DeployKeeper.s.sol
│   ├── agents/          demo runner, single-request CLI, validator/relayer/keeper/auditor daemon (Privy wallets)
│   └── scripts/         deploy + ABI export helpers
├── indexer/             Envio HyperIndex indexer (config.yaml, schema.graphql, handlers, tests)
└── cre/                 Chainlink CRE keeper workflow (talidator-keeper)
```

## Contracts

| Contract | Role |
| --- | --- |
| `IdentityRegistry` | ERC-8004-style ERC-721 identity for each agent (trader, validator or challenger), bound to an `agentWallet` |
| `ValidatorStaking` | Validators bond native currency. The ChallengeMarket slashes overturned votes. Withdrawals go through an unbonding period so stake stays slashable |
| `ValidationRegistry` | `validationRequest(validatorSet, agentId, requestURI, requestHash)`. Each validator re-executes and votes pass/fail with an evidence hash, either directly or through a relayer with an EIP-712 signature. The result is finalized on a simple-majority threshold (or an explicit N-of-M), or at the voting deadline |
| `Escrow` | The payer locks funds against a `requestHash`. They're released to the trader only on a passing result, and refunded on a failing or overturned one |
| `ChallengeMarket` | Anyone can bond a challenge within the window. A fresh quorum of bonded validators outside the original set re-checks the claim. If the challenge is upheld, the wrong voters are slashed and the challenger gets their bond back plus a cut. If rejected, the bond is forfeited. An arbiter is the fallback when no reviewers are available or no majority forms |
| `ReputationRegistry` | Feedback comes only from *final* outcomes: a challenge window that closed with no challenge, or a resolved challenge. It never comes from self-reported claims |

**Re-execution uses live prices and stays deterministic, as the PRD requires.** Claims travel on-chain as `data:` URIs. Each claim pins the exact rounds of a [Chainlink Data Feed on Monad testnet](https://docs.chain.link/data-feeds/price-feeds/addresses?network=monad) that it traded on: ETH/USD, BTC/USD or LINK/USD. Historical rounds can't change, so every validator reading `getRoundData` gets identical prices. Validators check that:
- both rounds exist on the pair's feed and their timestamps match the claim
- both fills are within 0.1% of the round prices
- the momentum signal really held: long only after an up-tick from the previous round, short only after a down-tick
- the reported PnL matches the fills

This logic is in [`src/lib/chain/market.ts`](src/lib/chain/market.ts).

## Running on Monad testnet

The web app runs **only against the Talidator contracts on Monad testnet** (chain ID 10143). There is no mock data or simulation mode. Until the contracts are deployed, every page shows a "not deployed" notice instead of numbers.

You need Node 22 and Foundry (`forge` / `anvil`). The npm scripts find Foundry in `~/.foundry/bin` even when it isn't on your PATH.

1. **Configure.** Copy `contracts/.env.example` to `contracts/.env` and fill in:
   - `PRIVATE_KEY`: the deployer / relayer / keeper / arbiter account, funded with testnet MON.
   - `MNEMONIC`: a **fresh** mnemonic. The agent accounts (trader, liar, 6 validators, challenger) are derived from it, and the operator funds them automatically.

   Never use anvil's well-known dev keys on Monad. Their addresses carry EIP-7702 "sweeper" delegations there, which drain any MON they receive.
2. **Deploy.** From `contracts/`:
   ```bash
   npm install
   npm test
   npm run deploy:monad
   ```
   This deploys all six contracts and writes their addresses into `src/lib/chain/deployments.ts`.
3. **Run the agents** (two terminals, both in `contracts/`):
   ```bash
   npm run demo:monad
   ```
   ```bash
   npm run validator -- --network monadTestnet
   ```
   `demo:monad` runs the four demo moments. The validator daemon runs the validators, relayer and keeper that the dashboard relies on. During a live demo, submit one claim at a time with `npm run request -- --network monadTestnet [--liar]`.
4. **Run the app** from the repo root:
   ```bash
   npm install
   npm run dev
   ```
   Connect a wallet on Monad testnet. The app will offer to switch networks if needed.

Optionally, set `NEXT_PUBLIC_MONAD_RPC_URL` to use a private RPC instead of the public one.

To verify the contracts on Monad's explorer (check Monad's docs for the current Sourcify endpoint):

```bash
forge verify-contract <address> src/ValidationRegistry.sol:ValidationRegistry --chain 10143 --verifier sourcify --verifier-url https://sourcify-api-monad.blockvision.org
```

## The demo: "Catch the Liar"

`npm run demo:*` prints every transaction hash:

1. **Honest trader.** The quorum passes and `Escrow.release()` pays the trader.
2. **Liar.** A fabricated exit price and inflated PnL. All three validators vote FAIL and `Escrow.refund()` refuses payment.
3. **Collusion.** Validators Alpha and Beta pass the lie, while Gamma dissents.
4. **Challenge.** The challenger bonds, and a fresh quorum (Delta, Epsilon, Zeta) upholds the challenge. Alpha and Beta are each slashed 30% of their bond, and the challenger is repaid their bond plus 50% of the slashed stake.

To stage collusion from the dashboard instead:
1. Run the daemon with `COLLUDING=Alpha,Beta`.
2. In **Start Validation**, pick "Colluding validators" and select Alpha, Beta and one honest validator.
3. Challenge the result from its request drawer.

## Sponsor integrations

| Sponsor | What it does in Talidator | Where |
| --- | --- | --- |
| **Envio** (HyperIndex) | Indexes all six contracts on Monad testnet into derived entities. The dashboard reads them in one GraphQL query instead of scanning logs | [`indexer/`](indexer), [`src/lib/chain/envio.ts`](src/lib/chain/envio.ts) |
| **Alchemy** | Monad testnet node for the agents, server routes and browser. Browser reads go through a read-only proxy so the key stays server-side | [`src/app/api/rpc`](src/app/api/rpc/route.ts), [`src/lib/chain/alchemy.ts`](src/lib/chain/alchemy.ts) |
| **Privy** | Server wallets for the validator and challenger agents, each bound to a role policy | [`contracts/agents/lib/privy.ts`](contracts/agents/lib/privy.ts) |
| **Qwen 3.8 Max** | An auditor agent with tool use that re-checks results and can challenge them on-chain | [`src/lib/agent/auditor.ts`](src/lib/agent/auditor.ts) |
| **Chainlink Data Feeds** | Live ETH, BTC and LINK prices on Monad testnet. Validators re-execute trades against the feed rounds | [`src/lib/chain/market.ts`](src/lib/chain/market.ts) |
| **Chainlink CRE** | A keeper workflow: on-chain read, an AI-verdict check over HTTP, then a signed report written on-chain | [`cre/talidator-keeper`](cre/talidator-keeper), [`KeeperReceiver.sol`](contracts/src/KeeperReceiver.sol) |
| **Mera** | Private notes encrypted in the browser with a key derived from the user's passkey | [`src/lib/account/vault.ts`](src/lib/account/vault.ts) |

### Envio HyperIndex

**What gets indexed:**
- Entities: `Agent`, `Validator`, `ValidationRequest`, `Vote`, `EscrowDeal`, `Challenge`, `Review`, `Slash`, `ProtocolEvent` and `ProtocolStats`.
- Derived and aggregated fields:
  - each validator's agreement rate, including when an overturn later re-scores its vote
  - slash history and the network totals
  - each agent's reputation average
  - claim fields parsed from the request's `data:` URI
  - an activity feed with the addresses involved, which powers per-user feeds and alerts

**Tests:** [`src/indexer.test.ts`](indexer/src/indexer.test.ts) replays all four demo moments and checks every derived value.

**Running it:** Envio's CLI runs on Linux, so use WSL on Windows.

```bash
cd indexer
pnpm install
pnpm codegen
pnpm test
pnpm dev     # local run, needs Docker
```

**Deploying:** push the repo, then create an indexer at [envio.dev/app](https://envio.dev/app) with **root directory `indexer`**. Set `NEXT_PUBLIC_ENVIO_GRAPHQL_URL` to its GraphQL endpoint, and the sync badge then reads "Envio". If Envio is unreachable, the app falls back to RPC for that poll.

### Alchemy

Set `ALCHEMY_API_KEY` (server-only) and `NEXT_PUBLIC_USE_ALCHEMY_PROXY=true`.
- **Server code and agents** call `https://monad-testnet.g.alchemy.com/v2/<key>` directly.
- **Browsers** use `/api/rpc`, which:
  - forwards only read methods, handling JSON-RPC batches
  - blocks writes and signing methods
  - never exposes the key

**Getting the agents and the CRE simulation onto Alchemy:** set `ALCHEMY_API_KEY` in `contracts/.env`, and put your Alchemy URL in `cre/project.yaml`.

**Free tier limit:** Alchemy allows only 10 blocks per `eth_getLogs` call. Envio handles event history, so this only matters for the RPC fallback. Set `NEXT_PUBLIC_LOG_CHUNK_SIZE=10` for it.

### Privy server wallets

Set `PRIVY_APP_ID` and `PRIVY_APP_SECRET` in `contracts/.env`. The agents then provision Privy wallets for validators Alpha–Zeta and the challenger. They're found again by `external_id`, so restarts reuse the same wallets.

Each wallet gets a **role policy**, and Privy's policy engine denies everything not listed:

**Validator policy:**
- sign EIP-712 votes only for this `ValidationRegistry` on chain 10143
- register its identity
- `bond` (value-capped by `PRIVY_MAX_BOND`), `beginUnbonding`, `withdraw`
- `submitReview`

**Challenger policy:**
- register its identity
- `challenge` (bond capped) and `withdrawCredits`

A compromised daemon host therefore can't transfer funds, call other contracts, act on other chains or export keys.

### Qwen 3.8 Max auditor agent

The agent reaches its own verdict with real tool calls, then answers with structured JSON:
- `get_request` — votes, outcome and challenge window
- `decode_claim`
- `reexecute_claim` — independent re-execution
- `get_price_rounds` — raw Chainlink feed rounds
- `get_validator_record`
- `get_agent_reputation`

The JSON holds the verdict, a recommended action, a confidence score and its findings.

**In the dashboard:** the request drawer has an **AI auditor** panel. It calls `/api/audit`, which caches each verdict in Firestore, and shows the verdict, findings and full tool trace.

**Autonomous mode:** run the daemon with `AUDITOR=on` and `QWEN_API_KEY`. When the agent is at least `AUDITOR_MIN_CONFIDENCE` sure a finalized result is wrong and its window is open, the challenger agent stakes a bond and challenges it on-chain.

The bounty requires a published article about how Qwen was used.

### Chainlink CRE keeper

`cre/talidator-keeper` is a cron workflow (TypeScript SDK). Each run:
1. **EVM read** of `KeeperReceiver.pendingActions()`, which works out on-chain which requests need finalizing, an escrow release or refund, or a reputation post.
2. **HTTP** to `/api/audit/flags`, which returns only stored verdicts, so identical consensus holds across nodes. Releases the auditor flagged are held back.
3. **EVM write** of a signed report through the CRE Forwarder to `KeeperReceiver.onReport()`. That contract accepts only allow-listed forwarders (and optionally a pinned workflow owner), and runs each action with try/catch.

**Live on Monad testnet:** `KeeperReceiver` is at [`0x213c61be671bd14d688f54b8Ccf224fD4680EC90`](https://testnet.monadexplorer.com/address/0x213c61be671bd14d688f54b8Ccf224fD4680EC90). Both Monad forwarders (simulation and production) are allow-listed, and the address is already in `cre/talidator-keeper/config.*.json`. To redeploy, run `npm run deploy:keeper` in `contracts/`; it writes `deployments/keeper-10143.json`.

**Run it:** set `auditFlagsUrl` in `config.production.json` to your deployed app. Install Bun and the CRE CLI, run `cre login`, then:
```bash
cd cre/talidator-keeper
npm install
npm run simulate             # dry run
npm run simulate:broadcast   # real tx via Monad's simulation forwarder
```
Run the daemon with `KEEPER=off` so CRE does the keeping.

### Mera passkey encryption

On the Account page, **Encrypt with passkey** creates a passkey and evaluates its PRF under a Talidator-specific salt, `sha256("talidator.notes.v1")`. The result is an isolated namespace, unrelated to any wallet key. HKDF turns its output into a non-extractable AES-256-GCM key that lives only in memory.

Note bodies are encrypted in the browser, so Firestore only holds `{iv, ct}`. Existing notes are migrated when encryption is first enabled.

The same synced passkey on another device re-derives the key and decrypts the notes. That's the bounty's cross-device test, and nothing secret is stored anywhere.

## How the dashboard reads and writes

- [`LiveSync`](src/components/live-sync.tsx) polls every 4 s, from Envio when configured, otherwise from [`reader.ts`](src/lib/chain/reader.ts) over RPC.
  - Contract views are batched into Multicall3, and everything else goes out as JSON-RPC batches, so the public RPC's rate limits hold.
  - Without Envio, event logs are indexed incrementally in chunks of `NEXT_PUBLIC_LOG_CHUNK_SIZE` blocks (100 on Monad's public RPC, 10 on Alchemy's free tier).
- Every action is a wallet transaction built in [`actions.ts`](src/lib/actions.ts): start a validation (escrow and `validationRequest`), challenge, register an agent, bond / unbond / withdraw, and release / refund escrow.

## Accounts: personal dashboards (Firebase)

On-chain state stays the source of truth. Firebase only stores what the chain can't hold.

- **Sign-in is Sign-In with Ethereum.**
  1. [`/api/auth/nonce`](src/app/api/auth/nonce/route.ts) issues a single-use nonce, stored in Firestore.
  2. The user signs the SIWE message in their wallet. This is free and sends no transaction.
  3. [`/api/auth/verify`](src/app/api/auth/verify/route.ts) checks the domain, chain ID and nonce, then verifies the signature against Monad. This works for EOAs, smart accounts and EIP-7702 wallets.
  4. It returns a Firebase custom token whose uid is the lowercase wallet address.

  If the connected wallet switches to another address, that wallet's session is signed out.
- **Per-user data** lives in Firestore under `users/{walletAddress}`:
  - the profile (display name, avatar) and alert preferences
  - a `watchlist/` subcollection of starred agents and requests
  - a `notes/` subcollection of private labels and notes on agents

  [`firestore.rules`](firestore.rules) restricts every document to its owner. The fields the server owns can't be edited, and nonces are server-only.
- **My dashboard** shows the requests the user made, paid for, challenged or validated, plus their starred items. It also has their own activity feed and a watchlist card. The alerts bell shows on-chain events on those items, filtered by the user's alert preferences.
- **Without Firebase env vars**, sign-in is hidden and the app runs as a public on-chain dashboard.

### Firebase setup

1. Create a Firebase project and enable **Firestore** (production mode).
2. Deploy the security rules: `npx firebase-tools deploy --only firestore:rules --project <id>`.
3. Under **Project settings → General**, add a Web app and copy its config into `NEXT_PUBLIC_FIREBASE_*`.
4. Under **Project settings → Service accounts**, generate a private key. Copy its values into `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL` and `FIREBASE_PRIVATE_KEY`. Keep the key on one line, with literal `\n` sequences.

Custom-token sign-in doesn't need any Firebase Auth provider enabled.

### Local development with emulators

This needs Java. firebase-tools 15 requires Java 21+, so use `firebase-tools@13` with an older JDK.

```bash
npx firebase-tools@13 emulators:start --only auth,firestore --project demo-talidator
```

Then add these to `.env.local`:

```
NEXT_PUBLIC_FIREBASE_API_KEY=demo-key
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=localhost
NEXT_PUBLIC_FIREBASE_PROJECT_ID=demo-talidator
NEXT_PUBLIC_FIREBASE_APP_ID=demo-app
NEXT_PUBLIC_USE_FIREBASE_EMULATORS=true
FIREBASE_PROJECT_ID=demo-talidator
FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080
```

## Deploying to Vercel

1. Import the repo into Vercel. The framework preset is Next.js, with no build settings to change.
2. Add every variable from [`.env.example`](.env.example) under **Settings → Environment Variables**:
   - the six `NEXT_PUBLIC_*` contract addresses and `NEXT_PUBLIC_DEPLOY_BLOCK`
   - the Firebase web config and Admin credentials
   - `SIWE_DOMAIN`, set to your production domain (for example `talidator.vercel.app`)

   Leave the emulator variables unset.
3. Deploy. `NEXT_PUBLIC_*` values are baked in at build time, so redeploy after changing them.
4. Custom-token sign-in doesn't use Firebase's authorized-domains list. If you later add Google or email sign-in, add the Vercel domain under **Authentication → Settings → Authorized domains**.

**The validator daemon can't run on Vercel**, because it's long-running. Run it on any container host (Railway, Fly.io, Render, a VPS):

```bash
docker build -f contracts/Dockerfile -t talidator-daemon .
docker run --env-file contracts/.env talidator-daemon
```

## Design notes and open questions

- **Collusion is punished, not prevented.** A colluding first quorum still finalizes. The challenge market makes collusion costly afterwards, as the PRD frames it.
- **Payment timing.** Following the PRD's flow, `Escrow.release()` is callable as soon as a quorum passes. The bundled keeper is more conservative: it refunds failures immediately, but only releases a pass once the result is final, meaning its challenge window has closed.
- **Reviewer selection** is a pseudo-random walk over the bonded validators, which is fine for a testnet demo. Production would use a VRF.
- **EIP-7702 wallets.** Monad supports EIP-7702, so an EOA can have code. Relayed votes are therefore checked with ECDSA first, and ERC-1271 is only a fallback. OpenZeppelin's `SignatureChecker` alone would reject a valid signature from a delegated EOA.
- **The market data is synthetic by design.** The PRD asks for deterministic re-execution against *fixed* market data, so claims are checked against a seeded candle set that every validator regenerates identically. Swapping in real prices would need a pinned source that every validator can fetch identically, such as an oracle snapshot.
- **Validator registration is permissionless**: anyone with a validator identity and the minimum bond can join. Sybil resistance currently rests on the bond size, which is the PRD's open question.
