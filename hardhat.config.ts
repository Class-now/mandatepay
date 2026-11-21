import type { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-viem";

// Aevum runs the Shanghai EVM: no MCOPY, TSTORE/TLOAD or blob opcodes.
const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.24",
    settings: { evmVersion: "shanghai", optimizer: { enabled: true, runs: 200 } },
  },
  networks: {
    hardhat: {
      hardfork: "shanghai",
      chainId: process.env.FORK_AEVUM ? 44005 : 31337,
      // FORK_AEVUM=1 runs the network against a live copy of Aevum testnet (real tUSD8).
      ...(process.env.FORK_AEVUM ? { forking: { url: "https://rpc-test.qday.info" } } : {}),
    },
    aevum: {
      url: "https://rpc-test.qday.info",
      chainId: 44005,
      accounts: process.env.DEPLOYER_KEY ? [process.env.DEPLOYER_KEY] : [],
    },
  },
};

export default config;
