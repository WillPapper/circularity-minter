import { bindings, defineConfig, triggers } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

// The Cloudflare account comes from CLOUDFLARE_ACCOUNT_ID (for example in a
// gitignored .env file) or is chosen when cf asks, so no ID is committed here.
export default defineConfig({
  worker: {
    name: "circularity-minter",
    compatibilityDate: "2026-11-01",
    entrypoint,
    observability: {
      enabled: true,
    },
    triggers: [
      // Daily at 1 AM UTC. The run on the 1st does the month's burn and mint;
      // runs on other days send nothing unless that run failed, in which case
      // they retry it. 1 AM is used instead of midnight to give humans an hour
      // on the 1st to burn/mint for on-chain provenance if desired. If they
      // do, the run sees nothing is due and sends no transactions.
      triggers.scheduled({ schedule: "0 1 * * *" }),
    ],
    // Set with `npm run deploy:secrets` or `cf workers secrets update` (see
    // README)
    env: {
      // 0x-prefixed private key of the wallet that pays gas
      PRIVATE_KEY: bindings.secret(),
      // Ethereum mainnet JSON-RPC endpoint
      RPC_URL: bindings.secret(),
      // Bearer token for the manual POST /run endpoint
      RUN_TOKEN: bindings.secret(),
    },
  },
});
