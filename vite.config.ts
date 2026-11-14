import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";

// The Cloudflare plugin reads cloudflare.config.ts
export default defineConfig({
  plugins: [cloudflare()],
});
