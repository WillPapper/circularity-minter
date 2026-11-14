# circularity-minter

A minting bot for the Circularity NFT, running as a [Cloudflare Worker](https://developers.cloudflare.com/workers/) on a [Cron Trigger](https://developers.cloudflare.com/workers/configuration/cron-triggers/). It's managed with the [Cloudflare CLI](https://developers.cloudflare.com/cf/) (`cf`) and configured in `cloudflare.config.ts`. It previously ran on Vercel and sent transactions through Syndicate's Transaction Cloud.

At 1 AM UTC on the first of every month it:

1. Calls `burn()` on [Circularity](https://etherscan.io/address/0x8680db891ff8c34f2ffcefac43d55059d010a821), which burns the prior month's NFT and mints the current month's NFT to its recorded owner.
2. Calls `mint(amount)` on [Circularity - Burn Ceremony](https://etherscan.io/address/0x83cc08E3783E9fF097e87a63BEc7503465C84714), minting every Burn Ceremony NFT that is owed to the artist.

1 AM is used instead of midnight to give humans an hour to burn and mint themselves for on-chain provenance. Contract source: [WillPapper/circularity](https://github.com/WillPapper/circularity).

## How it behaves

- **Idempotent.** Each run reads on-chain state first and sends only the transactions that are due. Re-running after a success, or after a human already burned and minted, sends nothing.
- **Catches up.** `burn()` jumps straight to the current month, and `mint` uses `amountEligibleToMint()` rather than a fixed 1, so a missed month is recovered on the next run.
- **No wasted gas on reverts.** Every call is simulated before it is sent.
- **Independent steps.** A failed burn doesn't stop the mint, or the reverse. If either fails, the invocation is marked as failed in the Worker's Cron Events.

Both contract functions are permissionless, so any wallet with ETH for gas can run this. The wallet never holds the NFTs.

## Endpoints

| Route | Description |
| --- | --- |
| `GET /` | Read-only status: the current Circularity month, Burn Ceremony NFTs owed, and the minter wallet's address and balance. |
| `POST /run` | Runs the same job as the cron immediately. Requires `Authorization: Bearer <RUN_TOKEN>`. It waits for receipts, so keep the connection open until it responds (usually under a minute). |

## Setup

Install dependencies and sign in to Cloudflare:

```bash
npm install
npx cf auth login
```

If your login can access more than one Cloudflare account, choose one with a gitignored `.env` file in the project root:

```bash
echo "CLOUDFLARE_ACCOUNT_ID=<account id>" > .env
```

Create a dedicated wallet for the bot and fund it with a small amount of ETH. A normal month uses about 145k to 165k gas: 77k to 97k for the burn, plus 68k for minting one Burn Ceremony NFT.

### First deploy

`cf` can't set secrets on a Worker that doesn't exist yet, so the first deploy uploads them with the code:

```bash
npm run deploy:secrets
```

It prompts, with hidden input, for:

- `PRIVATE_KEY`: the bot wallet's 0x-prefixed private key
- `RPC_URL`: an Ethereum mainnet JSON-RPC URL, for example from Alchemy or Infura
- `RUN_TOKEN`: any long random string, which you'll need for `POST /run`

The values are piped straight to `cf deploy --secrets-file`, so they never touch disk or shell history. Run it again any time to rotate secrets.

If the deploy runs somewhere you can't type into (for example, a remote agent's machine), set the secrets yourself first:

1. Create a Worker named `circularity-minter`, with any placeholder code (for example, the dashboard's Hello World template).
2. Add the secrets to it, either in the dashboard under **Settings** > **Variables and Secrets** (type **Secret**), or with `cf` on your own machine. This zsh loop prompts for each value with hidden input. In bash, use `read -rsp "$name: " value` instead:

   ```bash
   for name in PRIVATE_KEY RPC_URL RUN_TOKEN; do read -rs "value?$name: " && echo && cf workers secrets update "$name" --worker circularity-minter --type secret_text --text "$value"; done; unset value
   ```

3. Run `npm run deploy`. It replaces the placeholder code and keeps the secrets. If it reports a configuration conflict with the placeholder, review the diff and rerun with `--force`.

### Later deploys

```bash
npm run deploy
```

Existing secrets carry over to new versions.

To catch up immediately instead of waiting for the next cron:

```bash
curl -X POST -H "Authorization: Bearer $RUN_TOKEN" https://circularity-minter.<your-subdomain>.workers.dev/run
```

### Workers plan

The Workers Paid plan is recommended. Deriving the signing key takes about 9ms of CPU on a cold start, and the Free plan allows 10ms per invocation. Free plan subrequest limits (50 per invocation) are fine: RPC reads are batched, and receipts are polled once per block.

## Monitoring

- Each run's report is logged as JSON. View it in the dashboard under the Worker's **Observability** tab, or stream live logs with `wrangler tail circularity-minter`. `cf` can't tail logs yet, so this is the one task that falls back to Wrangler (installed globally, not as a project dependency). It reads the same `.env` account.
- Failed runs appear under the Worker's **Settings** > **Triggers** > **Cron Events**.
- `GET /` shows the minter wallet's balance, so you can top it up before it runs dry.

## Local development

Copy `.dev.vars.example` to `.dev.vars` and fill it in. `.dev.vars` is gitignored. Then:

```bash
npm run dev
curl "http://localhost:5173/cdn-cgi/local/scheduled?cron=0+1+1+*+*&format=json"
```

The second command triggers the scheduled handler. Local runs send real transactions to whatever `RPC_URL` points at, so use the fork test below to try changes without spending ETH.

`npm run typecheck` regenerates the binding types in `.cloudflare/types` and type-checks the project.

## Testing

```bash
npm run test:fork
```

This runs an end-to-end test against a local mainnet fork in about 15 seconds. It starts a Hardhat fork of Ethereum mainnet, runs the Worker with `cf dev` against it, and moves the fork's clock through each scenario:

1. A scheduled run that catches up every missed month
2. Re-runs, by cron and `POST /run`, that send nothing
3. `POST /run` rejecting missing and wrong tokens
4. Humans burning and minting before the 1 AM run, which then sends nothing
5. Missed months up to December, then a year rollover to January
6. Exactly 12 missed months, where `burn()` only updates the year
7. An empty wallet failing loudly without changing anything, then recovering once funded
8. The RPC URL's key never appearing in responses or logs, including while the RPC is down

Expectations are computed from the contracts' state at the fork, so the test works whichever month mainnet is in.

The test never touches mainnet or your `.dev.vars`. It writes its own `.dev.vars.forktest` holding Hardhat's public test keys, removes it afterwards, and aborts unless the Worker is signing with the test key on the fork.

| Variable | Default | Description |
| --- | --- | --- |
| `FORK_RPC_URL` | A public mainnet RPC | The RPC to fork. Use your own for reliability. |
| `FORK_BLOCK` | Latest block | Pins the fork to a block. Requires an archive RPC. |
