// Default addresses for the hosted console. URL parameters override them:
//   ?vault=0x..&token=0x..&rpc=http://127.0.0.1:8545
export const AEVUM = {
  id: 44005,
  name: "QDay Aevum Testnet",
  rpc: "https://rpc-test.qday.info",
  explorer: "https://explorer-test.qday.info",
  currency: { name: "tQDAY", symbol: "tQDAY", decimals: 18 },
};

export const DEFAULTS = {
  vault: "0xe990d83f74ae1adf11360dd3af69eb8470768f22", // MandateVault on Aevum testnet (deployed 2026-11-21, block 3746666)
  token: "0x456569838f1d43009A91ebA4263147Afd7233483", // tUSD8 (6 decimals)
};
