# circularity-minter

A minting bot for the Circularity NFT, running as a [Cloudflare Worker](https://developers.cloudflare.com/workers/) on a [Cron Trigger](https://developers.cloudflare.com/workers/configuration/cron-triggers/). It previously ran on Vercel and sent transactions through Syndicate's Transaction Cloud.

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

```bash
npm install
npx wrangler login
```

Create a dedicated wallet for the bot and fund it with a small amount of ETH. A normal month uses about 145k to 165k gas: 77k to 97k for the burn, plus 68k for minting one Burn Ceremony NFT.

Set the three secrets. Each command prompts for the value, and the first one offers to create the Worker:

```bash
npx wrangler secret put PRIVATE_KEY   # 0x-prefixed private key of the bot wallet
npx wrangler secret put RPC_URL       # Ethereum mainnet JSON-RPC URL, e.g. from Alchemy or Infura
npx wrangler secret put RUN_TOKEN     # any long random string, e.g. from `openssl rand -hex 32`
```

Then deploy:

```bash
npm run deploy
```

`wrangler deploy` refuses to deploy until all three secrets are set.

To catch up immediately instead of waiting for the next cron:

```bash
curl -X POST -H "Authorization: Bearer $RUN_TOKEN" https://circularity-minter.<your-subdomain>.workers.dev/run
```

### Workers plan

The Workers Paid plan is recommended. Deriving the signing key takes about 9ms of CPU on a cold start, and the Free plan allows 10ms per invocation. Free plan subrequest limits (50 per invocation) are fine: RPC reads are batched, and receipts are polled once per block.

## Monitoring

- Each run's report is logged as JSON. View it in the dashboard under the Worker's **Observability** tab, or stream it with `npx wrangler tail`.
- Failed runs appear under the Worker's **Settings** > **Triggers** > **Cron Events**.
- `GET /` shows the minter wallet's balance, so you can top it up before it runs dry.

## Local development

Copy `.dev.vars.example` to `.dev.vars` and fill it in. `.dev.vars` is gitignored. Then:

```bash
npm run dev
curl "http://localhost:8787/cdn-cgi/local/scheduled?cron=0+1+1+*+*&format=json"
```

The second command triggers the scheduled handler. Local runs send real transactions to whatever `RPC_URL` points at. To test without spending ETH, point it at a local mainnet fork (for example `npx hardhat node --fork <mainnet RPC URL>` with `chainId: 1`) and use one of the fork's funded test accounts.

After changing `wrangler.jsonc`, regenerate `worker-configuration.d.ts` with `npm run types`. Type-check with `npm run typecheck`.
