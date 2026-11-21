import { expect } from "chai";
import hre from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { keccak256, toHex, parseUnits, getAddress, maxUint128, zeroAddress } from "viem";

const usd = (n: string) => parseUnits(n, 6);
const ref = (s: string) => keccak256(toHex(s));
const DAY = 86400n;

async function expectRevert(p: Promise<unknown>, name: string) {
  try {
    await p;
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    expect(msg, msg).to.include(name);
    return;
  }
  expect.fail(`expected revert ${name}`);
}

async function deployFixture() {
  const [owner, agent, merchant, other, relayer] = await hre.viem.getWalletClients();
  const token = await hre.viem.deployContract("MockUSD8");
  const vault = await hre.viem.deployContract("MandateVault", [token.address]);
  const publicClient = await hre.viem.getPublicClient();

  await token.write.mint([owner.account.address, usd("1000")]);
  await token.write.approve([vault.address, usd("1000")]);
  await vault.write.deposit([usd("500")]);

  const now = BigInt(await time.latest());
  // perTx 20, budget 50/day, review above 10, 7 days, merchant allow-list
  await vault.write.createMandate([
    agent.account.address,
    usd("20"),
    usd("50"),
    Number(DAY),
    Number(now + 7n * DAY),
    usd("10"),
    toHex("travel-bot", { size: 32 }),
    [merchant.account.address],
  ]);
  const asAgent = await hre.viem.getContractAt("MandateVault", vault.address, { client: { wallet: agent } });
  const asOther = await hre.viem.getContractAt("MandateVault", vault.address, { client: { wallet: other } });
  const asRelayer = await hre.viem.getContractAt("MandateVault", vault.address, { client: { wallet: relayer } });
  return { owner, agent, merchant, other, relayer, token, vault, asAgent, asOther, asRelayer, publicClient };
}

async function signIntent(
  wallet: any,
  vault: `0x${string}`,
  id: bigint,
  merchant: `0x${string}`,
  amount: bigint,
  r: `0x${string}`,
  deadline: bigint,
) {
  const chainId = await (await hre.viem.getPublicClient()).getChainId();
  return wallet.signTypedData({
    domain: { name: "MandateVault", version: "1", chainId, verifyingContract: vault },
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
    message: { mandateId: id, merchant, amount, ref: r, deadline },
  });
}

describe("MandateVault", () => {
  it("agent pays an allow-listed merchant within limits", async () => {
    const { asAgent, token, vault, merchant, owner } = await loadFixture(deployFixture);
    await asAgent.write.pay([1n, merchant.account.address, usd("8"), ref("inv-1")]);
    expect(await token.read.balanceOf([merchant.account.address])).to.equal(usd("8"));
    expect(await vault.read.balanceOf([owner.account.address])).to.equal(usd("492"));
    expect(await vault.read.spendableNow([1n])).to.equal(usd("20"));
  });

  it("only the agent can pay directly", async () => {
    const { asOther, merchant } = await loadFixture(deployFixture);
    await expectRevert(asOther.write.pay([1n, merchant.account.address, usd("1"), ref("x")]), "NotAgent");
  });

  it("blocks merchants outside the allow-list", async () => {
    const { asAgent, other } = await loadFixture(deployFixture);
    await expectRevert(asAgent.write.pay([1n, other.account.address, usd("1"), ref("x")]), "MerchantNotAllowed");
  });

  it("enforces the per-payment cap", async () => {
    const { asAgent, merchant } = await loadFixture(deployFixture);
    await expectRevert(asAgent.write.pay([1n, merchant.account.address, usd("20.01"), ref("x")]), "OverPerTxCap");
  });

  it("enforces the rolling budget and resets it next window", async () => {
    const { asAgent, merchant } = await loadFixture(deployFixture);
    for (let i = 0; i < 5; i++) await asAgent.write.pay([1n, merchant.account.address, usd("10"), ref(`a${i}`)]);
    await expectRevert(asAgent.write.pay([1n, merchant.account.address, usd("1"), ref("a5")]), "OverBudget");
    await time.increase(Number(DAY));
    await asAgent.write.pay([1n, merchant.account.address, usd("10"), ref("a6")]);
  });

  it("rejects a reused ref (agent retries cannot double-pay)", async () => {
    const { asAgent, merchant } = await loadFixture(deployFixture);
    await asAgent.write.pay([1n, merchant.account.address, usd("5"), ref("inv-7")]);
    await expectRevert(asAgent.write.pay([1n, merchant.account.address, usd("5"), ref("inv-7")]), "RefAlreadyUsed");
  });

  it("revoke stops the agent immediately", async () => {
    const { vault, asAgent, merchant } = await loadFixture(deployFixture);
    await vault.write.revoke([1n]);
    await expectRevert(asAgent.write.pay([1n, merchant.account.address, usd("1"), ref("x")]), "MandateRevokedError");
    expect(await vault.read.spendableNow([1n])).to.equal(0n);
  });

  it("freeze is an owner-wide kill switch and is reversible", async () => {
    const { vault, asAgent, merchant } = await loadFixture(deployFixture);
    await vault.write.setFrozen([true]);
    await expectRevert(asAgent.write.pay([1n, merchant.account.address, usd("1"), ref("x")]), "OwnerIsFrozen");
    await vault.write.setFrozen([false]);
    await asAgent.write.pay([1n, merchant.account.address, usd("1"), ref("x")]);
  });

  it("expired mandates cannot pay", async () => {
    const { asAgent, merchant } = await loadFixture(deployFixture);
    await time.increase(Number(7n * DAY));
    await expectRevert(asAgent.write.pay([1n, merchant.account.address, usd("1"), ref("x")]), "MandateExpired");
  });

  it("only the owner can manage a mandate", async () => {
    const { asOther } = await loadFixture(deployFixture);
    await expectRevert(asOther.write.revoke([1n]), "NotOwner");
    await expectRevert(asOther.write.updateLimits([1n, 1n, 1n, 1n, 1n]), "NotOwner");
  });

  it("escalates large payments and pays on owner approval", async () => {
    const { vault, asAgent, token, merchant, owner } = await loadFixture(deployFixture);
    await asAgent.write.pay([1n, merchant.account.address, usd("15"), ref("big")]);
    const p = await vault.read.getPending([1n]);
    expect(p.status).to.equal(1); // Waiting
    expect(await token.read.balanceOf([merchant.account.address])).to.equal(0n);
    expect(await vault.read.heldOf([owner.account.address])).to.equal(usd("15"));
    await vault.write.approvePending([1n]);
    expect(await token.read.balanceOf([merchant.account.address])).to.equal(usd("15"));
    expect(await vault.read.heldOf([owner.account.address])).to.equal(0n);
    await expectRevert(vault.write.approvePending([1n]), "NotWaiting");
  });

  it("rejecting an escalation returns funds and budget", async () => {
    const { vault, asAgent, merchant, owner } = await loadFixture(deployFixture);
    await asAgent.write.pay([1n, merchant.account.address, usd("15"), ref("big")]);
    await vault.write.rejectPending([1n]);
    expect(await vault.read.balanceOf([owner.account.address])).to.equal(usd("500"));
    const m = await vault.read.getMandate([1n]);
    expect(m.spent).to.equal(0n);
  });

  it("unanswered escalations can be expired by anyone after the window", async () => {
    const { vault, asAgent, asOther, merchant, owner } = await loadFixture(deployFixture);
    await asAgent.write.pay([1n, merchant.account.address, usd("15"), ref("big")]);
    await expectRevert(asOther.write.expirePending([1n]), "ReviewWindowOpen");
    await time.increase(Number(3n * DAY));
    await asOther.write.expirePending([1n]);
    expect(await vault.read.balanceOf([owner.account.address])).to.equal(usd("500"));
  });

  it("gasless: a relayer submits the agent's signed intent", async () => {
    const { vault, asRelayer, agent, merchant, token } = await loadFixture(deployFixture);
    const deadline = BigInt(await time.latest()) + 600n;
    const sig = await signIntent(agent, vault.address, 1n, merchant.account.address, usd("9"), ref("g1"), deadline);
    await asRelayer.write.payWithSig([1n, merchant.account.address, usd("9"), ref("g1"), deadline, sig]);
    expect(await token.read.balanceOf([merchant.account.address])).to.equal(usd("9"));
    // replaying the same signed intent fails
    await expectRevert(
      asRelayer.write.payWithSig([1n, merchant.account.address, usd("9"), ref("g1"), deadline, sig]),
      "RefAlreadyUsed",
    );
  });

  it("gasless: rejects tampered amounts, wrong signers and stale intents", async () => {
    const { vault, asRelayer, agent, other, merchant } = await loadFixture(deployFixture);
    const deadline = BigInt(await time.latest()) + 600n;
    const sig = await signIntent(agent, vault.address, 1n, merchant.account.address, usd("9"), ref("g2"), deadline);
    await expectRevert(
      asRelayer.write.payWithSig([1n, merchant.account.address, usd("10"), ref("g2"), deadline, sig]),
      "BadSignature",
    );
    const bad = await signIntent(other, vault.address, 1n, merchant.account.address, usd("9"), ref("g2"), deadline);
    await expectRevert(
      asRelayer.write.payWithSig([1n, merchant.account.address, usd("9"), ref("g2"), deadline, bad]),
      "BadSignature",
    );
    await time.increase(601);
    await expectRevert(
      asRelayer.write.payWithSig([1n, merchant.account.address, usd("9"), ref("g2"), deadline, sig]),
      "IntentExpired",
    );
  });

  it("owner cannot over-withdraw funds held for review", async () => {
    const { vault, asAgent, merchant, owner } = await loadFixture(deployFixture);
    await asAgent.write.pay([1n, merchant.account.address, usd("15"), ref("big")]);
    await expectRevert(vault.write.withdraw([usd("500"), owner.account.address]), "InsufficientBalance");
    await vault.write.withdraw([usd("485"), owner.account.address]);
  });

  it("any-merchant mandate becomes an allow-list once a merchant is added", async () => {
    const { vault, agent, merchant, other } = await loadFixture(deployFixture);
    const now = BigInt(await time.latest());
    await vault.write.createMandate([
      agent.account.address, usd("5"), usd("5"), Number(DAY), Number(now + DAY), maxUint128, toHex("x", { size: 32 }), [],
    ]);
    const asAgent = await hre.viem.getContractAt("MandateVault", vault.address, { client: { wallet: agent } });
    await asAgent.write.pay([2n, other.account.address, usd("1"), ref("p")]);
    await vault.write.setMerchant([2n, merchant.account.address, true]);
    await expectRevert(asAgent.write.pay([2n, other.account.address, usd("1"), ref("q")]), "MerchantNotAllowed");
    expect(getAddress((await vault.read.getMandate([2n])).agent)).to.equal(getAddress(agent.account.address));
  });

  it("rejects bad mandate parameters", async () => {
    const { vault, agent, owner } = await loadFixture(deployFixture);
    const now = BigInt(await time.latest());
    const label = toHex("x", { size: 32 });
    await expectRevert(vault.write.createMandate([zeroAddress, 1n, 1n, 1, Number(now + DAY), 0n, label, []]), "BadParams");
    await expectRevert(vault.write.createMandate([owner.account.address, 1n, 1n, 1, Number(now + DAY), 0n, label, []]), "BadParams");
    await expectRevert(vault.write.createMandate([agent.account.address, 2n, 1n, 1, Number(now + DAY), 0n, label, []]), "BadParams");
    await expectRevert(vault.write.createMandate([agent.account.address, 1n, 1n, 1, Number(now), 0n, label, []]), "BadParams");
  });
});
