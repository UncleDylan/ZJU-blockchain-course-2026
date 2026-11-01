import { expect } from "chai";
import hre from "hardhat";
const { ethers, networkHelpers } = await hre.network.create();

describe("MiniDEX pool registry", function () {
  async function fixture() {
    const [alice, bob] = await ethers.getSigners();
    const dex = await ethers.deployContract("MiniDEX");
    const a = await ethers.deployContract("TestToken", ["A", "A"]);
    const b = await ethers.deployContract("TestToken", ["B", "B"]);
    const c = await ethers.deployContract("TestToken", ["C", "C"]);
    await Promise.all([dex, a, b, c].map(contract => contract.waitForDeployment()));
    const [first, second] = [await a.getAddress(), await b.getAddress()].sort((x,y) => BigInt(x) < BigInt(y) ? -1 : 1);
    return { dex, a, b, c, alice, bob, first: first!, second: second! };
  }
  it("creates a canonically ordered empty pool and records its creator and time", async function () {
    const { dex, alice, first, second } = await networkHelpers.loadFixture(fixture);
    const tx = await dex.createPool(second, first);
    const receipt = await tx.wait();
    const block = await ethers.provider.getBlock(receipt!.blockNumber);
    await expect(tx).to.emit(dex, "PoolCreated").withArgs(1n, first, second, alice.address);
    const pool = await dex.getPool(1);
    expect(pool.tokenA).to.equal(first); expect(pool.tokenB).to.equal(second);
    expect(pool.reserveA).to.equal(0n); expect(pool.reserveB).to.equal(0n);
    expect(pool.creator).to.equal(alice.address); expect(pool.createdTimestamp).to.equal(BigInt(block!.timestamp));
    expect(await dex.poolCount()).to.equal(1n);
    expect(await dex.getPoolId(first, second)).to.equal(1n);
    expect(await dex.getPoolId(second, first)).to.equal(1n);
  });
  it("rejects repeated pairs in either order even from a different user", async function () {
    const { dex, bob, first, second } = await networkHelpers.loadFixture(fixture);
    await dex.createPool(first, second);
    for (const [a,b] of [[first,second],[second,first]]) {
      await expect(dex.connect(bob).createPool(a!,b!)).to.be.revertedWithCustomError(dex,"PoolAlreadyExists").withArgs(1n);
    }
    expect(await dex.poolCount()).to.equal(1n);
  });
  it("rejects zero addresses, identical tokens, EOAs and non-ERC20 contracts", async function () {
    const { dex, first, bob } = await networkHelpers.loadFixture(fixture);
    await expect(dex.createPool(ethers.ZeroAddress,first)).to.be.revertedWithCustomError(dex,"InvalidTokenPair");
    await expect(dex.createPool(first,first)).to.be.revertedWithCustomError(dex,"InvalidTokenPair");
    await expect(dex.createPool(first,bob.address)).to.be.revertedWithCustomError(dex,"UnsupportedToken").withArgs(bob.address);
    await expect(dex.createPool(first,await dex.getAddress())).to.be.revertedWithCustomError(dex,"UnsupportedToken");
    expect(await dex.poolCount()).to.equal(0n);
  });
  it("allows users without token balances to register pools without transferring assets", async function () {
    const { dex, a, b, bob } = await networkHelpers.loadFixture(fixture);
    await dex.connect(bob).createPool(await a.getAddress(),await b.getAddress());
    expect((await dex.getPool(1)).creator).to.equal(bob.address);
    expect(await a.balanceOf(await dex.getAddress())).to.equal(0n);
    expect(await a.balanceOf(bob.address)).to.equal(0n);
  });
  it("paginates multiple pairs and handles empty and out-of-range pages", async function () {
    const { dex, a, b, c } = await networkHelpers.loadFixture(fixture);
    expect(await dex.getPools(0,10)).to.have.length(0);
    await dex.createPool(await a.getAddress(),await b.getAddress());
    await dex.createPool(await a.getAddress(),await c.getAddress());
    expect(await dex.getPools(0,1)).to.have.length(1);
    expect((await dex.getPools(1,10))[0]!.tokenB).to.equal((await dex.getPool(2)).tokenB);
    expect(await dex.getPools(2,10)).to.have.length(0);
    expect(await dex.getPools(ethers.MaxUint256,10)).to.have.length(0);
    await expect(dex.getPools(0,0)).to.be.revertedWithCustomError(dex,"InvalidPageSize");
    await expect(dex.getPools(0,101)).to.be.revertedWithCustomError(dex,"InvalidPageSize");
  });
  it("rejects lookup of pool IDs that do not exist", async function () {
    const { dex } = await networkHelpers.loadFixture(fixture);
    for (const id of [0,1]) await expect(dex.getPool(id)).to.be.revertedWithCustomError(dex,"PoolNotFound").withArgs(id);
  });
});
