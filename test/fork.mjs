// End-to-end test of the Worker against a local Ethereum mainnet fork.
//
// Starts a Hardhat fork of mainnet, runs the Worker with `cf dev` against it,
// and drives it through each scenario by moving the fork's clock. Expectations
// are computed from the contracts' own state, so the test holds whichever
// month mainnet is in.
//
// Usage: npm run test:fork
//   FORK_RPC_URL  mainnet RPC to fork (default: a public endpoint)
//   FORK_BLOCK    block to fork at; needs an archive RPC (default: latest)
//
// Nothing here touches mainnet. Transactions go to the fork, signed by
// Hardhat's public test accounts.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FORK_RPC_URL =
  process.env.FORK_RPC_URL || "https://ethereum-rpc.publicnode.com";
const FORK_BLOCK = process.env.FORK_BLOCK;

// cf dev --mode forktest loads only .dev.vars.forktest (gitignored), never the
// project's .dev.vars, so real secrets can't be picked up
const MODE = "forktest";
const SECRETS_FILE = join(ROOT, `.dev.vars.${MODE}`);

// Hardhat's well-known test accounts, funded on the fork. Never use these keys
// on a real network.
const MINTER_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const HUMAN_KEY =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const MINTER = privateKeyToAccount(MINTER_KEY).address;
const RUN_TOKEN = randomBytes(16).toString("hex");
// Stands in for an API key in a real RPC URL, to check it never leaks
const FAKE_RPC_KEY = `fork-test-key-${randomBytes(6).toString("hex")}`;

const CIRCULARITY = "0x8680db891ff8c34f2ffcefac43d55059d010a821";
const BURN_CEREMONY = "0x83cc08E3783E9fF097e87a63BEc7503465C84714";
const ARTIST = "0x29b18dFc73C410A98078753c4e718Ca317bC71D5";

const abi = parseAbi([
  "function burn()",
  "function mint(uint256 amount)",
  "function contractMonth() view returns (uint256)",
  "function contractYear() view returns (uint256)",
  "function owners(uint256) view returns (address)",
  "function ownerOf(uint256) view returns (address)",
  "function currentId() view returns (uint256)",
  "function amountEligibleToMint() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
]);

// ---------------------------------------------------------------------------
// Reporting

let passed = 0;
let failed = 0;

function section(title) {
  console.log(`\n${title}`);
}

function check(condition, description, actual) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${description}`);
  } else {
    failed++;
    const detail = actual === undefined ? "" : ` (got ${JSON.stringify(actual)})`;
    console.log(`  ✗ ${description}${detail}`);
  }
}

// ---------------------------------------------------------------------------
// Processes

const children = [];

function redact(text) {
  return text.split(FORK_RPC_URL).join("<FORK_RPC_URL>");
}

async function freePort() {
  const server = createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  server.close();
  return port;
}

// Starts a process in its own process group and resolves once its output
// matches readyPattern. Output is kept for error messages and leak checks.
function start(name, command, args, env, readyPattern) {
  const child = spawn(command, args, {
    cwd: ROOT,
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.output = "";
  children.push(child);
  return new Promise((resolve, reject) => {
    const fail = (reason) =>
      reject(new Error(`${name} ${reason}:\n${redact(child.output.slice(-3000))}`));
    const timer = setTimeout(() => fail("did not start within 2 minutes"), 120_000);
    const onData = (chunk) => {
      child.output = (child.output + chunk).slice(-200_000);
      const match = child.output.replace(/\x1b\[[0-9;]*m/g, "").match(readyPattern);
      if (match) {
        clearTimeout(timer);
        resolve(match);
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (code) => {
      clearTimeout(timer);
      fail(`exited with code ${code}`);
    });
  });
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    return;
  }
  await once(child, "exit");
}

function cleanup() {
  for (const child of children) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      // Already exited
    }
  }
  rmSync(SECRETS_FILE, { force: true });
}

process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});

// ---------------------------------------------------------------------------
// Chain helpers

let forkUrl;
let client;

async function rpc(method, params = []) {
  const response = await fetch(forkUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = await response.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

async function setTime(timestamp) {
  await rpc("evm_setNextBlockTimestamp", [timestamp]);
  await rpc("evm_mine");
}

const read = (address, functionName, args = []) =>
  client.readContract({ address, abi, functionName, args });

const ownerOf = (month) =>
  read(CIRCULARITY, "ownerOf", [BigInt(month)]).catch(() => null);

async function chainState() {
  const [month, year, currentId, eligible, artistBalance, nonce, block] =
    await Promise.all([
      read(CIRCULARITY, "contractMonth"),
      read(CIRCULARITY, "contractYear"),
      read(BURN_CEREMONY, "currentId"),
      read(BURN_CEREMONY, "amountEligibleToMint"),
      read(BURN_CEREMONY, "balanceOf", [ARTIST]),
      client.getTransactionCount({ address: MINTER }),
      client.getBlock(),
    ]);
  return {
    month: Number(month),
    year: Number(year),
    currentId: Number(currentId),
    eligible: Number(eligible),
    artistBalance: Number(artistBalance),
    nonce,
    blockNumber: Number(block.number),
    time: Number(block.timestamp),
  };
}

// Months are { year, month } with month 1-12, matching the contract
function monthAfter(timestamp) {
  const date = new Date(timestamp * 1000);
  const december = date.getUTCMonth() === 11;
  return {
    year: date.getUTCFullYear() + (december ? 1 : 0),
    month: december ? 1 : date.getUTCMonth() + 2,
  };
}

const firstOfMonth = ({ year, month }, hour, minute = 0) =>
  Date.UTC(year, month - 1, 1, hour, minute) / 1000;

const label = ({ year, month }) => `${year}-${String(month).padStart(2, "0")}`;

// ---------------------------------------------------------------------------
// Worker helpers

let workerUrl;
const responses = [];

async function worker(path, init = {}) {
  const response = await fetch(new URL(path, workerUrl), {
    ...init,
    signal: AbortSignal.timeout(180_000),
  });
  const text = await response.text();
  responses.push(text);
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    // Not JSON
  }
  return { status: response.status, text, json };
}

async function cron() {
  const cronExpression = encodeURIComponent("0 1 1 * *");
  const { json } = await worker(
    `/cdn-cgi/local/scheduled?cron=${cronExpression}&format=json`,
  );
  return json?.outcome;
}

function run(token = RUN_TOKEN) {
  return worker("/run", {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

// Runs the cron at the current fork time and checks that it burns into
// `target` and mints every Burn Ceremony NFT owed
async function expectScheduledRun(target) {
  const before = await chainState();
  const recordedOwner = await read(CIRCULARITY, "owners", [BigInt(target.month)]);

  check((await cron()) === "ok", "the cron run succeeds");

  const after = await chainState();
  check(
    after.month === target.month && after.year === target.year,
    `Circularity moves to ${label(target)}`,
    label(after),
  );
  check(
    (await ownerOf(target.month)) === recordedOwner,
    `the ${label(target)} NFT belongs to its recorded owner`,
  );
  if (before.month !== target.month) {
    check(
      (await ownerOf(before.month)) === null,
      `the ${label(before)} NFT is burned`,
    );
  }
  check(
    after.currentId === before.currentId + before.eligible && after.eligible === 0,
    `all ${before.eligible} owed Burn Ceremony NFT(s) are minted`,
    { before: before.currentId, after: after.currentId, stillOwed: after.eligible },
  );
  check(
    after.artistBalance === before.artistBalance + before.eligible,
    "they go to the artist",
  );
  check(
    after.nonce === before.nonce + 2,
    "exactly two transactions are sent",
    after.nonce - before.nonce,
  );
}

// ---------------------------------------------------------------------------
// Scenarios

async function main() {
  section("Setup");
  const forkPort = await freePort();
  // Hardhat ignores the path, so it carries the fake key for leak checks
  const workerRpcUrl = `http://127.0.0.1:${forkPort}/${FAKE_RPC_KEY}`;

  const hardhat = start(
    "Hardhat",
    join(ROOT, "node_modules/.bin/hardhat"),
    ["--config", "test/hardhat.config.cjs", "node", "--hostname", "127.0.0.1", "--port", String(forkPort)],
    {
      ...process.env,
      FORK_RPC_URL,
      FORK_BLOCK: FORK_BLOCK ?? "",
      HARDHAT_DISABLE_TELEMETRY_PROMPT: "true",
    },
    /Started HTTP and WebSocket JSON-RPC server at (http:\/\/\S+)/,
  );
  forkUrl = (await hardhat)[1];
  client = createPublicClient({ transport: http(forkUrl) });
  const hardhatProcess = children.at(-1);
  console.log(`  Hardhat fork running at ${forkUrl}`);

  writeFileSync(
    SECRETS_FILE,
    `PRIVATE_KEY="${MINTER_KEY}"\nRPC_URL="${workerRpcUrl}"\nRUN_TOKEN="${RUN_TOKEN}"\n`,
    { mode: 0o600 },
  );

  // Keep any real secrets in the shell's environment away from the Worker
  const { PRIVATE_KEY, RPC_URL, RUN_TOKEN: _, ...devEnv } = process.env;
  const devProcess = start(
    "cf dev",
    join(ROOT, "node_modules/.bin/cf"),
    ["dev", "--mode", MODE],
    devEnv,
    /Local:\s+(http:\/\/\S+)/,
  );
  workerUrl = (await devProcess)[1];
  const dev = children.at(-1);
  console.log(`  Worker running at ${workerUrl}`);

  // Abort unless the Worker is signing with the test key against the fork
  const status = await worker("/");
  const safe =
    status.json?.minter?.address === MINTER &&
    status.json?.minter?.balanceEth === "10000";
  check(safe, "the Worker signs with the Hardhat test key on the fork", status.json ?? status.text);
  if (!safe) throw new Error("Refusing to continue: the Worker isn't using the test secrets");

  const fork = await chainState();
  console.log(
    `  Forked block ${fork.blockNumber} (${new Date(fork.time * 1000).toISOString()}): ` +
      `Circularity is on ${label(fork)}, ${fork.eligible} Burn Ceremony NFT(s) owed`,
  );

  // 1
  const first = monthAfter(fork.time);
  section(`1. Scheduled run at 1 AM on ${label(first)}-01`);
  await setTime(firstOfMonth(first, 1));
  await expectScheduledRun(first);

  // 2
  section("2. Running again sends nothing");
  const beforeRerun = await chainState();
  check((await cron()) === "ok", "a second cron run succeeds");
  const manual = await run();
  check(
    manual.status === 200 &&
      manual.json?.burn?.status === "skipped" &&
      manual.json?.mint?.status === "skipped",
    "POST /run reports both steps skipped",
    manual.json,
  );
  check((await chainState()).nonce === beforeRerun.nonce, "no transactions are sent");
  const idle = await worker("/");
  check(
    idle.json?.circularity?.burnDue === false &&
      idle.json?.burnCeremony?.amountEligibleToMint === 0,
    "GET / shows nothing due",
    idle.json,
  );

  // 3
  section("3. POST /run requires the token");
  check((await run(null)).status === 401, "a request with no token is rejected");
  check((await run("wrong-token")).status === 401, "a wrong token is rejected");
  check((await worker("/run")).status === 404, "GET /run is not found");

  // 4
  const second = monthAfter(firstOfMonth(first, 1));
  section(`4. Humans burn and mint at 00:30 on ${label(second)}-01, before the cron`);
  await setTime(firstOfMonth(second, 0, 30));
  const human = createWalletClient({
    account: privateKeyToAccount(HUMAN_KEY),
    chain: mainnet,
    transport: http(forkUrl),
  });
  const owed = (await chainState()).eligible;
  for (const hash of [
    await human.writeContract({ address: CIRCULARITY, abi, functionName: "burn" }),
    await human.writeContract({ address: BURN_CEREMONY, abi, functionName: "mint", args: [BigInt(owed)] }),
  ]) {
    await client.waitForTransactionReceipt({ hash });
  }
  await setTime(firstOfMonth(second, 1));
  const beforeHumanCron = await chainState();
  check((await cron()) === "ok", "the 1 AM cron run succeeds");
  const afterHumanCron = await chainState();
  check(afterHumanCron.nonce === beforeHumanCron.nonce, "the bot sends no transactions");
  check(
    afterHumanCron.month === second.month && afterHumanCron.currentId === beforeHumanCron.currentId,
    "the humans' burn and mint stand",
  );

  // 5
  const december = {
    year: second.month === 12 ? second.year + 1 : second.year,
    month: 12,
  };
  const january = { year: december.year + 1, month: 1 };
  section(`5. Missed months until ${label(december)}, then a year rollover to ${label(january)}`);
  await setTime(firstOfMonth(december, 1));
  await expectScheduledRun(december);
  await setTime(firstOfMonth(january, 1));
  await expectScheduledRun(january);

  // 6
  // With exactly 12 months missed, burn() only updates the year: the month's
  // NFT already exists, so nothing is burned or minted
  const nextJanuary = { year: january.year + 1, month: 1 };
  section(`6. Exactly a year missed, ${label(january)} to ${label(nextJanuary)}`);
  await setTime(firstOfMonth(nextJanuary, 1));
  await expectScheduledRun(nextJanuary);

  // 7
  const afterJanuary = monthAfter(firstOfMonth(nextJanuary, 1));
  section(`7. An empty wallet on ${label(afterJanuary)}-01 fails loudly, then recovers`);
  await rpc("hardhat_setBalance", [MINTER, "0x0"]);
  await setTime(firstOfMonth(afterJanuary, 1));
  const beforeEmpty = await chainState();
  check((await cron()) === "exception", "the cron run is marked failed");
  const emptyRun = await run();
  check(
    emptyRun.status === 500 &&
      emptyRun.json?.burn?.status === "failed" &&
      emptyRun.json?.mint?.status === "failed",
    "POST /run returns 500 with both steps failed",
    emptyRun.json,
  );
  check(
    /fund/i.test(emptyRun.json?.burn?.error ?? ""),
    "the error says the wallet lacks funds",
    emptyRun.json?.burn?.error,
  );
  const afterEmpty = await chainState();
  check(
    afterEmpty.nonce === beforeEmpty.nonce &&
      afterEmpty.month === beforeEmpty.month &&
      afterEmpty.currentId === beforeEmpty.currentId,
    "nothing is sent and nothing changes",
  );
  await rpc("hardhat_setBalance", [MINTER, "0x21e19e0c9bab2400000"]); // 10,000 ETH
  const recovered = await run();
  const afterRecovery = await chainState();
  check(
    recovered.status === 200 &&
      afterRecovery.month === afterJanuary.month &&
      afterRecovery.eligible === 0,
    "after funding the wallet, POST /run burns and mints",
    recovered.json,
  );

  // 8
  section("8. The RPC URL's key never leaks");
  await stop(hardhatProcess);
  const down = await worker("/");
  check(
    down.status === 500 && down.json?.error?.startsWith("HTTP request failed"),
    "GET / returns a short error while the RPC is down",
    down.json ?? down.text,
  );
  check((await run()).status === 500, "POST /run returns 500 while the RPC is down");
  check(
    responses.every((text) => !text.includes(FAKE_RPC_KEY)),
    "no Worker response in any scenario contains it",
  );
  check(!dev.output.includes(FAKE_RPC_KEY), "the Worker's logs don't contain it");
}

let error;
try {
  await main();
} catch (caught) {
  error = caught;
} finally {
  cleanup();
}
if (error) console.error(`\n${redact(error.stack ?? String(error))}`);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(error || failed > 0 ? 1 : 0);
