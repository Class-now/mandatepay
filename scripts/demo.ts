/**
 * End-to-end walkthrough of MandatePay.
 *
 *   npx hardhat run scripts/demo.ts                    # local Shanghai chain with MockUSD8
 *   VAULT=0x.. npx hardhat run scripts/demo.ts --network aevum   # real tUSD8 on Aevum testnet
 *
 * Roles: the owner funds the vault and issues a mandate; the agent holds only a session key and
 * never pays gas; a relayer submits the agent's signed intents; the merchant receives tUSD8.
 * Every step prints the transaction hash (and an explorer link on Aevum).
 */
import hre from "hardhat";
import { keccak256, toHex, parseUnits, formatUnits, type Hex, type Address } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { clients } from "./chain";

const TUSD8: Address = "0x456569838f1d43009A91ebA4263147Afd7233483";
const EXPLORER = "https://explorer-test.qday.info";
const usd = (n: string) => parseUnits(n, 6);
const fmt = (n: bigint) => `${formatUnits(n, 6)} tUSD8`;

async function main() {
  const onAevum = hre.network.name === "aevum";
  const { publicClient, wallets, opts } = await clients();
  const [owner] = wallets;
  const chainId = await publicClient.getChainId();
  const link = (h: Hex) => (onAevum ? `${EXPLORER}/tx/${h}` : h);
  const wait = async (label: string, h: Hex) => {
    const r = await publicClient.waitForTransactionReceipt({ hash: h });
    console.log(`  ${r.status === "success" ? "ok " : "FAIL"} ${label}: ${link(h)}`);
    return r;
  };

  // --- token and vault
  let tokenAddress: Address;
  if (onAevum) {
    tokenAddress = TUSD8;
  } else {
    const mock = await hre.viem.deployContract("MockUSD8", [], opts());
    await mock.write.mint([owner.account.address, usd("100")]);
    tokenAddress = mock.address;
  }
  const token = await hre.viem.getContractAt("MockUSD8", tokenAddress, opts());
  const vault = process.env.VAULT
    ? await hre.viem.getContractAt("MandateVault", process.env.VAULT as Address, opts())
    : await hre.viem.deployContract("MandateVault", [tokenAddress], opts());
  console.log(`chain ${chainId}  vault ${vault.address}  token ${tokenAddress}`);

  // --- actors: the agent is a fresh session key with zero gas; merchant is any address
  const agent = privateKeyToAccount((process.env.AGENT_KEY as Hex) ?? generatePrivateKey());
  const merchant = (process.env.MERCHANT as Address) ?? privateKeyToAccount(generatePrivateKey()).address;
  console.log(`owner ${owner.account.address}\nagent ${agent.address} (session key, no gas)\nmerchant ${merchant}`);

  // 1. owner funds the vault
  console.log("\n1. Owner deposits 5 tUSD8");
  await wait("approve", await token.write.approve([vault.address, usd("5")]));
  await wait("deposit", await vault.write.deposit([usd("5")]));

  // 2. owner issues a mandate
  console.log("\n2. Owner issues a mandate: 1/payment, 3/day, review above 0.5, 7 days, one merchant");
  const block = await publicClient.getBlock();
  const createHash = await vault.write.createMandate([
    agent.address,
    usd("1"),
    usd("3"),
    86400,
    Number(block.timestamp + 7n * 86400n),
    usd("0.5"),
    toHex("demo-shopping-agent", { size: 32 }),
    [merchant],
  ]);
  await wait("createMandate", createHash);
  const id = await vault.read.mandateCount();
  console.log(`  mandate #${id}, spendable now ${fmt(await vault.read.spendableNow([id]))}`);

  // helper: agent signs an intent, owner's wallet acts as relayer
  const intent = async (amount: bigint, reference: string) => {
    const ref = keccak256(toHex(reference));
    const deadline = BigInt((await publicClient.getBlock()).timestamp) + 600n;
    const signature = await agent.signTypedData({
      domain: { name: "MandateVault", version: "1", chainId, verifyingContract: vault.address },
      types: {
        PaymentIntent: [
          { name: "mandateId", type: "uint256" },
          { name: "merchant", type: "address" },
          { name: "amount", type: "uint256" },
          { name: "ref", type: "bytes32" },
          { name: "deadline", type: "uint256" },
        ],
      },
      primaryType: "PaymentIntent",
      message: { mandateId: id, merchant, amount, ref, deadline },
    });
    return [id, merchant, amount, ref, deadline, signature] as const;
  };
  const tryPay = async (label: string, args: Awaited<ReturnType<typeof intent>>) => {
    try {
      await vault.simulate.payWithSig(args);
      return wait(label, await vault.write.payWithSig(args));
    } catch (e: any) {
      const decoded = e?.walk?.((x: any) => x?.data?.errorName)?.data?.errorName;
      const known = String(e?.message ?? e).match(
        /RefAlreadyUsed|OverPerTxCap|OverBudget|MandateRevokedError|MandateExpired|MerchantNotAllowed|OwnerIsFrozen|BadSignature|IntentExpired|InsufficientBalance/,
      )?.[0];
      const name = decoded ?? known ?? e?.shortMessage ?? String(e);
      console.log(`  blocked ${label}: ${name}`);
    }
  };

  // 3. gasless payment within limits
  console.log("\n3. Agent pays invoice INV-1001 (0.4) gaslessly through the relayer");
  await tryPay("payWithSig INV-1001", await intent(usd("0.4"), "INV-1001"));

  // 4. retry of the same invoice is refused
  console.log("\n4. Agent times out and retries INV-1001: refused, no double payment");
  await tryPay("retry INV-1001", await intent(usd("0.4"), "INV-1001"));

  // 5. over cap
  console.log("\n5. Agent tries 1.5 in one payment: over the per-payment cap");
  await tryPay("INV-1002", await intent(usd("1.5"), "INV-1002"));

  // 6. escalation
  console.log("\n6. Agent pays 0.9: above the review threshold, held for the owner");
  await tryPay("INV-1003", await intent(usd("0.9"), "INV-1003"));
  const pendingId = await vault.read.pendingCount();
  console.log(`  pending #${pendingId}; owner approves`);
  await wait("approvePending", await vault.write.approvePending([pendingId]));

  // 7. revoke
  console.log("\n7. Owner revokes the mandate; the agent's next intent fails in the same block");
  await wait("revoke", await vault.write.revoke([id]));
  await tryPay("INV-1004", await intent(usd("0.2"), "INV-1004"));

  console.log(`\nmerchant received ${fmt(await token.read.balanceOf([merchant]))}`);
  console.log(`owner free balance in vault ${fmt(await vault.read.balanceOf([owner.account.address]))}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
