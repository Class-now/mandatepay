/**
 * Fork check against the real tUSD8 on Aevum testnet (no keys, nothing is broadcast).
 *   npm run fork:check      (FORK_AEVUM=1 hardhat run scripts/fork-check.ts)
 *
 * 1. Deploys MandateVault on a local fork of Aevum, pointing at the live tUSD8 contract.
 * 2. Funds a fresh owner with tUSD8 by impersonating an existing holder.
 * 3. Owner signs an EIP-3009 ReceiveWithAuthorization; a relayer submits depositWithAuthorization.
 * 4. Replaying the same authorization must fail; a mandate payment must reach the merchant.
 */
import hre from "hardhat";
import { getAddress, keccak256, parseUnits, toHex, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const TUSD8: Address = "0x456569838f1d43009A91ebA4263147Afd7233483";
const HOLDER: Address = "0xc219ae18045BB05A399a8Ade4133306bB7ef430C"; // received 5 tUSD8 from the faucet

const erc20 = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "version", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
] as const;

function check(cond: unknown, msg: string) {
  if (!cond) throw new Error("FAILED: " + msg);
  console.log("  ok  " + msg);
}

async function main() {
  if (!process.env.FORK_AEVUM) throw new Error("run with FORK_AEVUM=1");
  const pub = await hre.viem.getPublicClient();
  const [relayer] = await hre.viem.getWalletClients();
  const chainId = await pub.getChainId();
  console.log(`fork of chain ${chainId} at block ${await pub.getBlockNumber()}`);

  const owner = privateKeyToAccount(generatePrivateKey());
  const agent = privateKeyToAccount(generatePrivateKey());
  const merchant = privateKeyToAccount(generatePrivateKey()).address;
  const amount = parseUnits("2", 6);

  // fund the fresh owner with real tUSD8 from the faucet holder
  await hre.network.provider.request({ method: "hardhat_impersonateAccount", params: [HOLDER] });
  await hre.network.provider.request({ method: "hardhat_setBalance", params: [HOLDER, toHex(10n ** 18n)] });
  const holder = await hre.viem.getWalletClient(HOLDER);
  await pub.waitForTransactionReceipt({ hash: await holder.writeContract({ address: TUSD8, abi: erc20, functionName: "transfer", args: [owner.address, amount] }) });
  check((await pub.readContract({ address: TUSD8, abi: erc20, functionName: "balanceOf", args: [owner.address] })) === amount, "owner holds 2 tUSD8 (real token on the fork)");

  const vault = await hre.viem.deployContract("MandateVault", [TUSD8]);
  const name = await pub.readContract({ address: TUSD8, abi: erc20, functionName: "name" });
  const version = await pub.readContract({ address: TUSD8, abi: erc20, functionName: "version" });

  // EIP-3009 ReceiveWithAuthorization signed by the owner, submitted by the relayer
  const nonce = keccak256(toHex(`mandatepay-fork-${Date.now()}`));
  const validBefore = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const sig = await owner.signTypedData({
    domain: { name, version, chainId, verifyingContract: TUSD8 },
    types: {
      ReceiveWithAuthorization: [
        { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "ReceiveWithAuthorization",
    message: { from: owner.address, to: vault.address, value: amount, validAfter: 0n, validBefore, nonce },
  });
  const r = ("0x" + sig.slice(2, 66)) as Hex;
  const s = ("0x" + sig.slice(66, 130)) as Hex;
  const v = parseInt(sig.slice(130, 132), 16);
  const args = [owner.address, amount, 0n, validBefore, nonce, v, r, s] as const;

  await pub.waitForTransactionReceipt({ hash: await vault.write.depositWithAuthorization(args, { account: relayer.account }) });
  check((await vault.read.balanceOf([owner.address])) === amount, `gasless deposit credited 2 tUSD8 (domain "${name}" v${version})`);
  check((await pub.readContract({ address: TUSD8, abi: erc20, functionName: "balanceOf", args: [vault.address] })) === amount, "vault holds the real tUSD8");

  let replayed = false;
  try { await vault.write.depositWithAuthorization(args, { account: relayer.account }); replayed = true; } catch { /* expected */ }
  check(!replayed, "replaying the same authorization is rejected by tUSD8");

  // owner (impersonated: its key is local) issues a mandate; agent pays a merchant through it
  await hre.network.provider.request({ method: "hardhat_setBalance", params: [owner.address, toHex(10n ** 18n)] });
  const ownerWallet = await hre.viem.getWalletClient(owner.address, { account: owner });
  const now = BigInt((await pub.getBlock()).timestamp);
  await pub.waitForTransactionReceipt({
    hash: await ownerWallet.writeContract({
      address: vault.address, abi: vault.abi, functionName: "createMandate",
      args: [agent.address, parseUnits("1", 6), parseUnits("1.5", 6), 86400n, now + 86400n, parseUnits("1", 6), keccak256(toHex("fork-check")), [merchant]],
    }),
  });
  await hre.network.provider.request({ method: "hardhat_setBalance", params: [agent.address, toHex(10n ** 18n)] });
  const agentWallet = await hre.viem.getWalletClient(agent.address, { account: agent });
  await pub.waitForTransactionReceipt({
    hash: await agentWallet.writeContract({ address: vault.address, abi: vault.abi, functionName: "pay", args: [1n, merchant, parseUnits("0.75", 6), keccak256(toHex("invoice-1"))] }),
  });
  check((await pub.readContract({ address: TUSD8, abi: erc20, functionName: "balanceOf", args: [merchant] })) === parseUnits("0.75", 6), "agent paid merchant 0.75 real tUSD8 through the mandate");
  console.log(`fork check passed (vault on fork ${getAddress(vault.address)})`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
