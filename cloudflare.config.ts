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
      // 1 AM UTC on the first of every month. 1 AM is used instead of
      // midnight to give humans an hour to burn/mint for on-chain provenance
      // if desired. If they do, this run sees nothing is due and sends no
      // transactions.
      triggers.scheduled({ schedule: "0 1 1 * *" }),
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
