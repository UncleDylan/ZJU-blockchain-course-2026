import { expect } from "chai";
import hre from "hardhat";

const { ethers, networkHelpers } = await hre.network.create();

describe("TestToken faucet", function () {
  async function fixture() {
    const [alice, bob, spender] = await ethers.getSigners();
    const tokenA = await ethers.deployContract("TestToken", ["Token A", "TKA"]);
    const tokenB = await ethers.deployContract("TestToken", ["Token B", "TKB"]);
    await Promise.all([tokenA.waitForDeployment(), tokenB.waitForDeployment()]);
    return { tokenA, tokenB, alice, bob, spender };
  }

  it("deploys two distinct ERC20s with 18 decimals and no initial supply", async function () {
    const { tokenA, tokenB } = await networkHelpers.loadFixture(fixture);
    expect(await tokenA.getAddress()).not.to.equal(await tokenB.getAddress());
    expect(await tokenA.name()).to.equal("Token A");
    expect(await tokenA.symbol()).to.equal("TKA");
    expect(await tokenB.name()).to.equal("Token B");
    expect(await tokenB.symbol()).to.equal("TKB");
    expect(await tokenA.decimals()).to.equal(18n);
    expect(await tokenB.decimals()).to.equal(18n);
    expect(await tokenA.totalSupply()).to.equal(0n);
    expect(await tokenB.totalSupply()).to.equal(0n);
  });

  it("lets different users claim independently on each token", async function () {
    const { tokenA, tokenB, alice, bob } = await networkHelpers.loadFixture(fixture);
    const amount = ethers.parseEther("1000");
    for (const user of [alice, bob]) {
      for (const token of [tokenA, tokenB]) {
        await token.connect(user).claim();
        expect(await token.balanceOf(user.address)).to.equal(amount);
      }
    }
    expect(await tokenA.totalSupply()).to.equal(amount * 2n);
    expect(await tokenB.totalSupply()).to.equal(amount * 2n);
  });

  it("emits claim details and rejects early repeat claims without changing balances", async function () {
    const { tokenA, alice } = await networkHelpers.loadFixture(fixture);
    const tx = await tokenA.claim();
    const receipt = await tx.wait();
    const block = await ethers.provider.getBlock(receipt!.blockNumber);
    const next = BigInt(block!.timestamp) + 86_400n;
    await expect(tx).to.emit(tokenA, "TokensClaimed").withArgs(alice.address, ethers.parseEther("1000"), next);
    expect(await tokenA.nextClaimAt(alice.address)).to.equal(next);
    await expect(tokenA.claim()).to.be.revertedWithCustomError(tokenA, "FaucetCooldown").withArgs(next);
    expect(await tokenA.balanceOf(alice.address)).to.equal(ethers.parseEther("1000"));
    expect(await tokenA.totalSupply()).to.equal(ethers.parseEther("1000"));
  });

  it("allows another claim exactly at the end of the cooldown", async function () {
    const { tokenA, alice } = await networkHelpers.loadFixture(fixture);
    await tokenA.claim();
    const next = await tokenA.nextClaimAt(alice.address);
    await networkHelpers.time.setNextBlockTimestamp(next - 1n);
    await expect(tokenA.claim()).to.be.revertedWithCustomError(tokenA, "FaucetCooldown");
    await networkHelpers.time.setNextBlockTimestamp(next);
    await tokenA.claim();
    expect(await tokenA.balanceOf(alice.address)).to.equal(ethers.parseEther("2000"));
  });

  it("supports transfers and allowance-based spending for later DEX integration", async function () {
    const { tokenA, alice, bob, spender } = await networkHelpers.loadFixture(fixture);
    await tokenA.claim();
    await tokenA.transfer(bob.address, ethers.parseEther("100"));
    await tokenA.approve(spender.address, ethers.parseEther("50"));
    await tokenA.connect(spender).transferFrom(alice.address, bob.address, ethers.parseEther("50"));
    expect(await tokenA.balanceOf(alice.address)).to.equal(ethers.parseEther("850"));
    expect(await tokenA.balanceOf(bob.address)).to.equal(ethers.parseEther("150"));
    expect(await tokenA.allowance(alice.address, spender.address)).to.equal(0n);
  });
});
