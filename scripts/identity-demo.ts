/**
 * Confirmation of Payee + agent identity on top of MandatePay.
 *
 *   npx hardhat run scripts/identity-demo.ts                                  # local chain
 *   VAULT=0x.. [DIRECTORY=0x..] npx hardhat run scripts/identity-demo.ts --network aevum
 *
 * 1. deploy PayeeDirectory (unless DIRECTORY is given)
 * 2. a merchant claims the handle "demo-coffee-<n>" from its own address
 * 3. the owner issues a mandate for a fresh session key and declares it as "demo-shopping-agent"
 * 4. the agent accepts its identity with one gasless signature (the owner relays it)
 * 5. the agent receives an invoice "pay demo-coffee-<n> at 0x..", checks the directory, signs and pays
 * 6. an invoice with the same handle but a look-alike address fails the check: the agent never signs
 */
import hre from "hardhat";
import { keccak256, toHex, parseUnits, parseEther, formatUnits, type Hex, type Address } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { clients } from "./chain";

const TUSD8: Address = "0x456569838f1d43009A91ebA4263147Afd7233483";
const EXPLORER = "https://explorer-test.qday.info";
const usd = (n: string) => parseUnits(n, 6);
const fmt = (n: bigint) => `${formatUnits(n, 6)} tUSD8`;

async function main() {
  const onAevum = hre.network.name === "aevum";
  const { chain, publicClient, wallets, opts } = await clients();
  const [owner] = wallets;
  const chainId = await publicClient.getChainId();
  const link = (h: Hex) => (onAevum ? `${EXPLORER}/tx/${h}` : h);
  const wait = async (label: string, h: Hex) => {
    const r = await publicClient.waitForTransactionReceipt({ hash: h });
    console.log(`  ${r.status === "success" ? "ok " : "FAIL"} ${label}: ${link(h)}`);
    if (r.status !== "success") throw new Error(`${label} failed`);
    return r;
  };

  // --- vault (existing on Aevum, fresh locally)
  let tokenAddress: Address = TUSD8;
  let vault;
  if (onAevum) {
    vault = await hre.viem.getContractAt("MandateVault", process.env.VAULT as Address, opts());
  } else {
    const mock = await hre.viem.deployContract("MockUSD8", [], opts());
    await mock.write.mint([owner.account.address, usd("10")]);
    tokenAddress = mock.address;
    vault = await hre.viem.deployContract("MandateVault", [tokenAddress], opts());
    await mock.write.approve([vault.address, usd("10")]);
    await vault.write.deposit([usd("10")]);
  }
  const token = await hre.viem.getContractAt("MockUSD8", tokenAddress, opts());

  // 1. directory
  console.log("1. PayeeDirectory");
  const dir = process.env.DIRECTORY
    ? await hre.viem.getContractAt("PayeeDirectory", process.env.DIRECTORY as Address, opts())
    : await hre.viem.deployContract("PayeeDirectory", [], opts());
  console.log(`  directory ${dir.address}  vault ${vault.address}`);

  // 2. merchant claims a handle (it needs a little gas for its one transaction)
  const merchantKey = (process.env.MERCHANT_KEY as Hex) ?? generatePrivateKey();
  const merchantAcct = privateKeyToAccount(merchantKey);
  const merchantWallet = onAevum
    ? (await import("viem")).createWalletClient({ account: merchantAcct, chain, transport: (await import("viem")).http() })
    : (await hre.viem.getWalletClients())[3];
  const merchant = merchantWallet.account!.address;
  const handle = `demo-coffee-${Date.now() % 100000}`;
  console.log(`\n2. Merchant ${merchant} claims "${handle}"`);
  if (onAevum) await wait("gas for merchant (0.002 tQDAY)", await owner.sendTransaction({ to: merchant, value: parseEther("0.002") }));
  const dirAsMerchant = await hre.viem.getContractAt("PayeeDirectory", dir.address, { client: { public: publicClient, wallet: merchantWallet as any } });
  await wait("registerMerchant", await dirAsMerchant.write.registerMerchant([handle, "https://class-now.github.io/mandatepay/"]));

  // 3. mandate + declared identity
  const agent = privateKeyToAccount(generatePrivateKey());
  console.log(`\n3. Owner issues a mandate to session key ${agent.address} and declares it "demo-shopping-agent"`);
  const now = (await publicClient.getBlock()).timestamp;
  await wait(
    "createMandate",
    await vault.write.createMandate([agent.address, usd("0.5"), usd("1"), 86400, Number(now + 7n * 86400n), usd("0.5"), toHex("demo-shopping-agent", { size: 32 }), [merchant]]),
  );
  const id = await vault.read.mandateCount();
  await wait("declareAgent", await dir.write.declareAgent([agent.address, "demo-shopping-agent", "https://github.com/Class-now/mandatepay#agent-identity"]));

  // 4. gasless acceptance
  console.log("\n4. Agent accepts its identity with a signature; the owner relays it (agent has no gas)");
  const acceptSig = await agent.signTypedData({
    domain: { name: "PayeeDirectory", version: "1", chainId, verifyingContract: dir.address },
    types: { AcceptAgent: [{ name: "agent", type: "address" }, { name: "principal", type: "address" }, { name: "handle", type: "bytes32" }] },
    primaryType: "AcceptAgent",
    message: { agent: agent.address, principal: owner.account.address, handle: keccak256(toHex("demo-shopping-agent")) },
  });
  await wait("acceptAgent", await dir.write.acceptAgent([agent.address, acceptSig]));
  const card = await dir.read.agentOf([agent.address]);
  console.log(`  agentOf: handle=${card.handle} principal=${card.principal} confirmed=${card.confirmed}`);

  // the agent-side check before it signs anything
  const payInvoice = async (invoice: { payee: string; address: Address; amount: bigint; ref: string }) => {
    const ok = await dir.read.confirmPayee([invoice.payee, invoice.address]);
    if (!ok) {
      console.log(`  refused before signing: "${invoice.payee}" is ${await dir.read.resolve([invoice.payee])}, invoice says ${invoice.address}`);
      return;
    }
    const ref = keccak256(toHex(invoice.ref));
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
      message: { mandateId: id, merchant: invoice.address, amount: invoice.amount, ref, deadline },
    });
    await wait(`payWithSig ${invoice.ref}`, await vault.write.payWithSig([id, invoice.address, invoice.amount, ref, deadline, signature]));
  };

  // 5. genuine invoice
  console.log(`\n5. Invoice INV-2001: pay "${handle}" 0.3 at ${merchant}`);
  await payInvoice({ payee: handle, address: merchant, amount: usd("0.3"), ref: `INV-2001-${handle}` });

  // 6. look-alike invoice
  const lookAlike = privateKeyToAccount(generatePrivateKey()).address;
  console.log(`\n6. Phishing invoice INV-2002: pay "${handle}" 0.3 at look-alike ${lookAlike}`);
  await payInvoice({ payee: handle, address: lookAlike, amount: usd("0.3"), ref: `INV-2002-${handle}` });

  console.log(`\nmerchant "${handle}" received ${fmt(await token.read.balanceOf([merchant]))}; look-alike received ${fmt(await token.read.balanceOf([lookAlike]))}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
