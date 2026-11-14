// Local Ethereum mainnet fork for test/fork.mjs. Keeps chain ID 1 so the
// Worker's mainnet chain check passes.
const blockNumber = process.env.FORK_BLOCK
  ? Number(process.env.FORK_BLOCK)
  : undefined;

module.exports = {
  networks: {
    hardhat: {
      chainId: 1,
      forking: {
        url: process.env.FORK_RPC_URL,
        ...(blockNumber ? { blockNumber } : {}),
      },
    },
  },
  paths: {
    root: "..",
    cache: ".cloudflare/hardhat/cache",
    artifacts: ".cloudflare/hardhat/artifacts",
  },
};
