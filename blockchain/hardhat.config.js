require('@nomicfoundation/hardhat-toolbox');
require('dotenv').config();

// Amoy is only wired up when the env vars are present, so `npx hardhat test`
// and the local node work on a fresh clone with no .env at all.
const AMOY_RPC_URL = process.env.AMOY_RPC_URL || '';
const DEPLOYER_PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY || '';

const networks = {
  hardhat: { chainId: 31337 },
  localhost: { url: 'http://127.0.0.1:8545', chainId: 31337 },
};

if (AMOY_RPC_URL && DEPLOYER_PRIVATE_KEY) {
  networks.amoy = {
    url: AMOY_RPC_URL,
    accounts: [DEPLOYER_PRIVATE_KEY],
    chainId: 80002,
  };
}

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: '0.8.24',
    settings: {
      // Trades a slightly bigger one-time deploy cost for cheaper gas on every
      // later call — the right trade for a contract that gets registered once
      // and read/written to many times. `runs: 200` is Hardhat/Solidity's own
      // recommended default; nothing here has been hand-tuned for this project.
      optimizer: { enabled: true, runs: 200 },
    },
  },
  networks,
  etherscan: {
    apiKey: {
      polygonAmoy: process.env.POLYGONSCAN_API_KEY || '',
    },
  },
  paths: {
    sources: './contracts',
    tests: './test',
    cache: './cache',
    artifacts: './artifacts',
  },
};
