/** hardhat-viem only knows chains bundled with viem, so Aevum testnet is defined here. */
import hre from "hardhat";
import { defineChain } from "viem";

export const aevumTestnet = defineChain({
  id: 44005,
  name: "QDay Aevum Testnet",
  nativeCurrency: { name: "tQDAY", symbol: "tQDAY", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc-test.qday.info"] } },
  blockExplorers: { default: { name: "QDay Explorer", url: "https://explorer-test.qday.info" } },
});

/** Public client, wallet clients and a `client` option for deployContract/getContractAt on any network. */
export async function clients() {
  const chain = hre.network.name === "aevum" ? aevumTestnet : undefined;
  const publicClient = await hre.viem.getPublicClient(chain ? { chain } : undefined);
  const wallets = await hre.viem.getWalletClients(chain ? { chain } : undefined);
  const opts = (wallet = wallets[0]) => ({ client: { public: publicClient, wallet } });
  return { chain, publicClient, wallets, opts };
}
