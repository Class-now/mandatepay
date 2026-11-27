import { expect } from "chai";
import hre from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { getAddress, keccak256, toHex, zeroAddress } from "viem";

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

async function fixture() {
  const [owner, agent, merchant, impostor, relayer] = await hre.viem.getWalletClients();
  const dir = await hre.viem.deployContract("PayeeDirectory");
  const publicClient = await hre.viem.getPublicClient();
  const as = (w: typeof owner) => hre.viem.getContractAt("PayeeDirectory", dir.address, { client: { wallet: w } });
  const signAccept = async (signer = agent, principal = owner.account.address, handle = "travel-bot") =>
    signer.signTypedData({
      domain: { name: "PayeeDirectory", version: "1", chainId: await publicClient.getChainId(), verifyingContract: dir.address },
      types: { AcceptAgent: [{ name: "agent", type: "address" }, { name: "principal", type: "address" }, { name: "handle", type: "bytes32" }] },
      primaryType: "AcceptAgent",
      message: { agent: agent.account.address, principal, handle: keccak256(toHex(handle)) },
    });
  return { dir, owner, agent, merchant, impostor, relayer, as, signAccept };
}

describe("PayeeDirectory", () => {
  it("merchant claims a handle and payees are confirmed only against the right address", async () => {
    const { dir, merchant, impostor, as } = await loadFixture(fixture);
    await (await as(merchant)).write.registerMerchant(["coffee-shop", "https://example.com/coffee"]);
    expect(await dir.read.resolve(["coffee-shop"])).to.equal(getAddress(merchant.account.address));
    expect(await dir.read.confirmPayee(["coffee-shop", merchant.account.address])).to.equal(true);
    expect(await dir.read.confirmPayee(["coffee-shop", impostor.account.address])).to.equal(false);
    expect(await dir.read.confirmPayee(["unknown-shop", zeroAddress])).to.equal(false);
    const m = await dir.read.merchantOf([merchant.account.address]);
    expect(m.handle).to.equal("coffee-shop");
  });

  it("refuses taken, duplicate and malformed handles", async () => {
    const { merchant, impostor, as } = await loadFixture(fixture);
    await (await as(merchant)).write.registerMerchant(["coffee-shop", ""]);
    await expectRevert((await as(impostor)).write.registerMerchant(["coffee-shop", ""]), "HandleTaken");
    await expectRevert((await as(merchant)).write.registerMerchant(["second-name", ""]), "AlreadyRegistered");
    for (const bad of ["Coffee-Shop", "ab", "a".repeat(33), "coffee shop", "café"]) {
      await expectRevert((await as(impostor)).write.registerMerchant([bad, ""]), "BadHandle");
    }
  });

  it("released handles can be claimed again", async () => {
    const { dir, merchant, impostor, as } = await loadFixture(fixture);
    await (await as(merchant)).write.registerMerchant(["coffee-shop", ""]);
    await (await as(merchant)).write.releaseMerchant();
    expect(await dir.read.resolve(["coffee-shop"])).to.equal(zeroAddress);
    await (await as(impostor)).write.registerMerchant(["coffee-shop", ""]);
    expect(await dir.read.resolve(["coffee-shop"])).to.equal(getAddress(impostor.account.address));
  });

  it("agent identity is declared by the principal and confirmed by a gasless signature", async () => {
    const { dir, owner, agent, relayer, as, signAccept } = await loadFixture(fixture);
    await (await as(owner)).write.declareAgent([agent.account.address, "travel-bot", "ipfs://card"]);
    let a = await dir.read.agentOf([agent.account.address]);
    expect(a.principal).to.equal(getAddress(owner.account.address));
    expect(a.confirmed).to.equal(false);
    // relayer submits the agent's signature; the agent spends no gas
    await (await as(relayer)).write.acceptAgent([agent.account.address, await signAccept()]);
    a = await dir.read.agentOf([agent.account.address]);
    expect(a.confirmed).to.equal(true);
    expect(a.handle).to.equal("travel-bot");
  });

  it("rejects a confirmation signed by someone else or for another handle", async () => {
    const { owner, agent, impostor, relayer, as, signAccept } = await loadFixture(fixture);
    await (await as(owner)).write.declareAgent([agent.account.address, "travel-bot", ""]);
    await expectRevert((await as(relayer)).write.acceptAgent([agent.account.address, await signAccept(impostor)]), "BadSignature");
    await expectRevert(
      (await as(relayer)).write.acceptAgent([agent.account.address, await signAccept(agent, owner.account.address, "other-bot")]),
      "BadSignature",
    );
  });

  it("only the principal can change or remove an agent; a new handle clears the confirmation", async () => {
    const { dir, owner, agent, impostor, relayer, as, signAccept } = await loadFixture(fixture);
    await (await as(owner)).write.declareAgent([agent.account.address, "travel-bot", ""]);
    await (await as(relayer)).write.acceptAgent([agent.account.address, await signAccept()]);
    await expectRevert((await as(impostor)).write.declareAgent([agent.account.address, "evil-bot", ""]), "NotPrincipal");
    await expectRevert((await as(impostor)).write.removeAgent([agent.account.address]), "NotPrincipal");
    // same handle, new card: stays confirmed
    await (await as(owner)).write.declareAgent([agent.account.address, "travel-bot", "ipfs://v2"]);
    expect((await dir.read.agentOf([agent.account.address])).confirmed).to.equal(true);
    // new handle: needs the agent's consent again
    await (await as(owner)).write.declareAgent([agent.account.address, "shopping-bot", ""]);
    expect((await dir.read.agentOf([agent.account.address])).confirmed).to.equal(false);
    await (await as(owner)).write.removeAgent([agent.account.address]);
    expect((await dir.read.agentOf([agent.account.address])).principal).to.equal(zeroAddress);
    await expectRevert((await as(relayer)).write.acceptAgent([agent.account.address, await signAccept()]), "NotRegistered");
  });
});
