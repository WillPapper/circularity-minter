// Burns the Circularity NFT for the prior month (which mints the current
// month's NFT to its recorded owner) and mints any Circularity Burn Ceremony
// NFTs that are owed. Contract source: https://github.com/WillPapper/circularity
//
// Both contract functions are permissionless, so any funded wallet can call
// them. Every run reads on-chain state first and only sends transactions that
// are due, so runs are idempotent: re-running after a success, or after a human
// has already burned/minted, sends nothing.

import {
  BaseError,
  createPublicClient,
  createWalletClient,
  formatEther,
  http,
  parseAbi,
  type Address,
  type Hash,
  type Hex,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { mainnet } from "viem/chains";

export const CIRCULARITY_ADDRESS: Address =
  "0x8680db891ff8c34f2ffcefac43d55059d010a821";
export const BURN_CEREMONY_ADDRESS: Address =
  "0x83cc08E3783E9fF097e87a63BEc7503465C84714";

const circularityAbi = parseAbi([
  "function burn()",
  "function contractMonth() view returns (uint256)",
  "function contractYear() view returns (uint256)",
]);

const burnCeremonyAbi = parseAbi([
  "function mint(uint256 amount)",
  "function currentId() view returns (uint256)",
  "function amountEligibleToMint() view returns (uint256)",
]);

// Mainnet produces a block every 12 seconds, so polling faster only spends
// subrequests. Two receipt waits must fit in a Cron Trigger's 15 minute limit.
const RECEIPT_POLLING_INTERVAL_MS = 12_000;
const RECEIPT_TIMEOUT_MS = 5 * 60_000;

export interface MinterConfig {
  PRIVATE_KEY: string;
  RPC_URL: string;
}

export interface Status {
  blockNumber: number;
  blockTime: string;
  minter: { address: Address; balanceEth: string };
  circularity: {
    // Month (1-12) and year of the NFT that currently exists
    contractMonth: number;
    contractYear: number;
    burnDue: boolean;
  };
  burnCeremony: {
    currentId: number;
    amountEligibleToMint: number;
  };
}

export type StepResult =
  | { status: "skipped"; reason: string }
  | {
      status: "confirmed";
      transactionHash: Hash;
      blockNumber: number;
      gasUsed: string;
    }
  | { status: "failed"; error: string; transactionHash?: Hash };

export interface RunReport {
  ok: boolean;
  before: Status;
  burn: StepResult;
  mint: StepResult;
}

// Deriving the account costs ~9ms of CPU cold, so reuse it within an isolate
let cachedAccount: { key: Hex; account: PrivateKeyAccount } | undefined;

function getAccount(privateKey: string | undefined): PrivateKeyAccount {
  const key = parsePrivateKey(privateKey);
  if (cachedAccount?.key !== key) {
    cachedAccount = { key, account: privateKeyToAccount(key) };
  }
  return cachedAccount.account;
}

function createClients(config: MinterConfig) {
  if (!config.RPC_URL) throw new Error("RPC_URL is not set");
  const account = getAccount(config.PRIVATE_KEY);
  // Batching folds concurrent reads into one HTTP request, which keeps runs
  // well under the Workers Free plan limit of 50 subrequests per invocation.
  const transport = http(config.RPC_URL, { batch: true });
  return {
    account,
    publicClient: createPublicClient({ chain: mainnet, transport }),
    walletClient: createWalletClient({ account, chain: mainnet, transport }),
  };
}

function parsePrivateKey(value: string | undefined): Hex {
  const key = (value ?? "").trim();
  const prefixed = key.startsWith("0x") ? key : `0x${key}`;
  // Never include the value in the error message
  if (!/^0x[0-9a-fA-F]{64}$/.test(prefixed)) {
    throw new Error("PRIVATE_KEY must be a 32-byte hex string");
  }
  return prefixed as Hex;
}

function formatMonth(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, "0")}`;
}

// viem's full messages include the request URL, and RPC providers often put
// the API key in its path. Use shortMessage plus the provider's own error
// details (e.g. "insufficient funds"), then redact the URL as a backstop.
export function errorMessage(error: unknown, rpcUrl?: string): string {
  let message: string;
  if (error instanceof BaseError) {
    const { shortMessage, details } = error;
    message =
      details && !shortMessage.includes(details)
        ? `${shortMessage} Details: ${details}`
        : shortMessage;
  } else {
    message = error instanceof Error ? error.message : String(error);
  }
  return rpcUrl ? redact(message, rpcUrl) : message;
}

function redact(message: string, rpcUrl: string): string {
  const secrets = [rpcUrl];
  try {
    const { pathname, search } = new URL(rpcUrl);
    secrets.push(search, pathname);
  } catch {
    // Not a parseable URL; redacting the raw string is all we can do
  }
  return secrets
    .filter((secret) => secret.length > 1)
    .reduce((text, secret) => text.split(secret).join("[redacted]"), message);
}

export async function getStatus(config: MinterConfig): Promise<Status> {
  return readStatus(createClients(config));
}

async function readStatus({
  account,
  publicClient,
}: ReturnType<typeof createClients>): Promise<Status> {
  const [chainId, block] = await Promise.all([
    publicClient.getChainId(),
    publicClient.getBlock(),
  ]);
  if (chainId !== mainnet.id) {
    throw new Error(`RPC_URL is on chain ${chainId}, expected mainnet (1)`);
  }

  // Pin every read to one block so the state is consistent
  const blockNumber = block.number;
  const [contractMonth, contractYear, currentId, eligible, balance] =
    await Promise.all([
      publicClient.readContract({
        address: CIRCULARITY_ADDRESS,
        abi: circularityAbi,
        functionName: "contractMonth",
        blockNumber,
      }),
      publicClient.readContract({
        address: CIRCULARITY_ADDRESS,
        abi: circularityAbi,
        functionName: "contractYear",
        blockNumber,
      }),
      publicClient.readContract({
        address: BURN_CEREMONY_ADDRESS,
        abi: burnCeremonyAbi,
        functionName: "currentId",
        blockNumber,
      }),
      publicClient.readContract({
        address: BURN_CEREMONY_ADDRESS,
        abi: burnCeremonyAbi,
        functionName: "amountEligibleToMint",
        blockNumber,
      }),
      publicClient.getBalance({ address: account.address, blockNumber }),
    ]);

  // Circularity.burn() derives the month and year from block.timestamp in UTC,
  // and reverts if both already match the stored contractMonth/contractYear
  const blockDate = new Date(Number(block.timestamp) * 1000);
  const blockMonth = blockDate.getUTCMonth() + 1;
  const blockYear = blockDate.getUTCFullYear();

  return {
    blockNumber: Number(blockNumber),
    blockTime: blockDate.toISOString(),
    minter: { address: account.address, balanceEth: formatEther(balance) },
    circularity: {
      contractMonth: Number(contractMonth),
      contractYear: Number(contractYear),
      burnDue:
        BigInt(blockMonth) !== contractMonth ||
        BigInt(blockYear) !== contractYear,
    },
    burnCeremony: {
      currentId: Number(currentId),
      amountEligibleToMint: Number(eligible),
    },
  };
}

export async function runMinter(config: MinterConfig): Promise<RunReport> {
  const clients = createClients(config);
  const { account, publicClient, walletClient } = clients;
  const before = await readStatus(clients);

  // Simulating first means a call that would revert (for example, because a
  // human already burned this month) fails here instead of costing gas
  async function submit(
    label: string,
    write: () => Promise<Hash>,
  ): Promise<StepResult> {
    let hash: Hash | undefined;
    try {
      hash = await write();
      console.log(`${label}: submitted ${hash}`);
      const receipt = await publicClient.waitForTransactionReceipt({
        hash,
        pollingInterval: RECEIPT_POLLING_INTERVAL_MS,
        timeout: RECEIPT_TIMEOUT_MS,
      });
      if (receipt.status !== "success") {
        return { status: "failed", error: "Transaction reverted", transactionHash: hash };
      }
      console.log(`${label}: confirmed in block ${receipt.blockNumber}`);
      return {
        status: "confirmed",
        transactionHash: hash,
        blockNumber: Number(receipt.blockNumber),
        gasUsed: receipt.gasUsed.toString(),
      };
    } catch (error) {
      const message = errorMessage(error, config.RPC_URL);
      console.error(`${label}: ${message}`);
      return { status: "failed", error: message, transactionHash: hash };
    }
  }

  // Burn the prior month's Circularity NFT, minting the current month's
  const { contractMonth, contractYear, burnDue } = before.circularity;
  const burn: StepResult = burnDue
    ? await submit("burn", async () => {
        const { request } = await publicClient.simulateContract({
          account,
          address: CIRCULARITY_ADDRESS,
          abi: circularityAbi,
          functionName: "burn",
        });
        return walletClient.writeContract(request);
      })
    : {
        status: "skipped",
        reason: `Already burned for ${formatMonth(contractYear, contractMonth)}`,
      };

  // Mint every Burn Ceremony NFT that is owed. Normally this is 1, but minting
  // the full eligible amount catches up automatically after missed months.
  const amount = BigInt(before.burnCeremony.amountEligibleToMint);
  const mint: StepResult =
    amount > 0n
      ? await submit("mint", async () => {
          const { request } = await publicClient.simulateContract({
            account,
            address: BURN_CEREMONY_ADDRESS,
            abi: burnCeremonyAbi,
            functionName: "mint",
            args: [amount],
          });
          return walletClient.writeContract(request);
        })
      : { status: "skipped", reason: "No Burn Ceremony NFTs are eligible to mint" };

  return {
    ok: burn.status !== "failed" && mint.status !== "failed",
    before,
    burn,
    mint,
  };
}
