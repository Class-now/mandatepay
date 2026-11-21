/** Deploy MandateVault against tUSD8.  DEPLOYER_KEY=0x.. npx hardhat run scripts/deploy.ts --network aevum */
import hre from "hardhat";
import { clients } from "./chain";

const TUSD8 = "0x456569838f1d43009A91ebA4263147Afd7233483";

async function main() {
  const { publicClient, opts } = await clients();
  const token = hre.network.name === "aevum" ? TUSD8 : (await hre.viem.deployContract("MockUSD8", [], opts())).address;
  const vault = await hre.viem.deployContract("MandateVault", [token], opts());
  const block = await publicClient.getBlockNumber();
  console.log(JSON.stringify({ network: hre.network.name, chainId: await publicClient.getChainId(), vault: vault.address, token, block: block.toString() }, null, 2));
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
