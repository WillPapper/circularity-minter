# circularity-minter

## This repository is public

Everything pushed here is public permanently, on every branch: files, commit messages, and PR descriptions. Deleting a file or force-pushing doesn't remove it from clones, forks, or caches. Be extra careful when handling secrets.

- Never commit real secrets. That includes wallet private keys, RPC URLs (providers put API keys in the URL), `RUN_TOKEN` values, and Cloudflare or other API tokens. Keep the Cloudflare account ID out of the repo too: it belongs in the gitignored `.env`.
- Real secrets live only in Cloudflare and in gitignored local files (`.dev.vars*` and `.env*`). Set them on the Worker with `npm run deploy:secrets`. Keep those patterns in `.gitignore`.
- The only key material allowed in the repo is obvious placeholders (like `.dev.vars.example`) and Hardhat's well-known public test keys in `test/`.
- Never put secret values in commit messages, PR descriptions, issues, logs, or command-line arguments, which end up in shell history. Read them with hidden prompts, as `scripts/deploy-with-secrets.sh` does.
- Before every commit, review `git diff --cached` for secrets. When adding a file that holds secrets, confirm it's ignored with `git check-ignore -v <file>`.
- If a real secret is ever pushed, treat it as compromised and rotate it immediately (for the bot wallet, move its funds to a new wallet). Rewriting history isn't enough on its own.

## Project

- Cloudflare Worker managed with the `cf` CLI and configured in `cloudflare.config.ts`. Use Wrangler only for what `cf` can't do yet, such as live logs (`wrangler tail circularity-minter`).
- After changing `src/`, run `npm run typecheck` and `npm run test:fork` (end-to-end test against a local mainnet fork).
