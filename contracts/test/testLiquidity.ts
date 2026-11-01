import { expect } from "chai";
import hre from "hardhat";
const { ethers, networkHelpers } = await hre.network.create();
const e = ethers.parseEther;

describe("NFT liquidity positions", function () {
  async function fixture() {
    const [alice,bob] = await ethers.getSigners();
    const dex = await ethers.deployContract("MiniDEX");
    const x = await ethers.deployContract("TestToken",["A","A"]);
    const y = await ethers.deployContract("TestToken",["B","B"]);
    await Promise.all([dex,x,y].map(c=>c.waitForDeployment()));
    const [a,b] = BigInt(await x.getAddress()) < BigInt(await y.getAddress()) ? [x,y] : [y,x];
    await dex.createPool(await a.getAddress(),await b.getAddress());
    for (const user of [alice,bob]) for (const token of [a,b]) {
      await token.connect(user).claim();
      await token.connect(user).approve(await dex.getAddress(),e("1000"));
    }
    const deadline = (await networkHelpers.time.latest())+3600;
    return {dex,a,b,alice,bob,deadline};
  }
  it("mints an ERC721 with real deposits, locked minimum shares and on-chain metadata",async function(){
    const {dex,a,b,alice,deadline}=await networkHelpers.loadFixture(fixture);
    const quote=await dex.previewAddLiquidity(1,e("100"),e("400"));
    expect(quote.shares).to.equal(e("200")-1000n);
    const tx=await dex.addLiquidity(1,e("100"),e("400"),e("100"),e("400"),quote.shares,deadline);
    await expect(tx).to.emit(dex,"LiquidityAdded").withArgs(1n,1n,alice.address,e("100"),e("400"),quote.shares);
    expect(await dex.ownerOf(1)).to.equal(alice.address);
    expect(await dex.totalShares(1)).to.equal(e("200"));
    expect(await a.balanceOf(await dex.getAddress())).to.equal(e("100"));
    expect(await b.balanceOf(await dex.getAddress())).to.equal(e("400"));
    const pool=await dex.getPool(1); expect(pool.reserveA).to.equal(e("100"));expect(pool.reserveB).to.equal(e("400"));
    const position=await dex.positions(1);expect(position.provider).to.equal(alice.address);expect(position.poolId).to.equal(1n);
    const meta=JSON.parse(Buffer.from((await dex.tokenURI(1)).split(',')[1]!,"base64").toString());
    expect(meta.shares).to.equal(quote.shares.toString());expect(meta.amountA).to.equal(e("100").toString());
    expect(meta.createdTimestamp).to.equal(position.createdTimestamp.toString());
  });
  it("consumes only ratio-matched amounts and assigns proportional shares to later providers",async function(){
    const {dex,a,b,bob,deadline}=await networkHelpers.loadFixture(fixture);
    await dex.addLiquidity(1,e("100"),e("400"),0,0,0,deadline);
    const quote=await dex.previewAddLiquidity(1,e("100"),e("200"));
    expect(quote.amountA).to.equal(e("50"));expect(quote.amountB).to.equal(e("200"));expect(quote.shares).to.equal(e("100"));
    await dex.connect(bob).addLiquidity(1,e("100"),e("200"),quote.amountA,quote.amountB,quote.shares,deadline);
    expect(await a.balanceOf(bob.address)).to.equal(e("950"));expect(await b.balanceOf(bob.address)).to.equal(e("800"));
    expect(await dex.totalShares(1)).to.equal(e("300"));expect((await dex.positions(2)).shares).to.equal(e("100"));
    const other=await dex.previewAddLiquidity(1,e("10"),e("100"));expect(other.amountB).to.equal(e("40"));
  });
  it("tracks current NFT owners separately from original providers",async function(){
    const {dex,alice,bob,deadline}=await networkHelpers.loadFixture(fixture);
    await dex.addLiquidity(1,e("10"),e("10"),0,0,0,deadline);
    await dex.transferFrom(alice.address,bob.address,1);
    expect(await dex.getOwnerPositionIds(alice.address,0,10)).to.have.length(0);
    expect(await dex.getOwnerPositionIds(bob.address,0,10)).to.deep.equal([1n]);
    expect(await dex.getPoolPositionIds(1,0,10)).to.deep.equal([1n]);
    expect((await dex.positions(1)).provider).to.equal(alice.address);
    await expect(dex.transferFrom(bob.address,alice.address,1)).to.be.revertedWithCustomError(dex,"ERC721InsufficientApproval");
  });
  it("reverts all transfers and accounting if the second token has insufficient allowance",async function(){
    const {dex,a,b,alice,deadline}=await networkHelpers.loadFixture(fixture);
    await b.approve(await dex.getAddress(),0);
    await expect(dex.addLiquidity(1,e("100"),e("100"),0,0,0,deadline)).to.be.revertedWithCustomError(b,"ERC20InsufficientAllowance");
    expect(await a.balanceOf(alice.address)).to.equal(e("1000"));expect(await a.balanceOf(await dex.getAddress())).to.equal(0n);
    expect((await dex.getPool(1)).reserveA).to.equal(0n);expect(await dex.totalShares(1)).to.equal(0n);expect(await dex.positionCount()).to.equal(0n);
  });
  it("rejects expired, zero, dust, oversized and slippage-violating deposits",async function(){
    const {dex,deadline}=await networkHelpers.loadFixture(fixture);
    await expect(dex.addLiquidity(1,1,1,0,0,0,0)).to.be.revertedWithCustomError(dex,"DeadlineExpired");
    for(const [a,b] of [[0n,1n],[1n,1n],[2n**128n,1n]]) await expect(dex.previewAddLiquidity(1,a,b)).to.be.revertedWithCustomError(dex,"InvalidAmount");
    await expect(dex.addLiquidity(1,e("10"),e("10"),e("11"),0,0,deadline)).to.be.revertedWithCustomError(dex,"SlippageExceeded");
    await expect(dex.addLiquidity(1,e("10"),e("10"),0,0,e("11"),deadline)).to.be.revertedWithCustomError(dex,"SlippageExceeded");
    await expect(dex.previewAddLiquidity(2,1,1)).to.be.revertedWithCustomError(dex,"PoolNotFound");
  });
  it("paginates sources and owner NFTs, and rejects invalid IDs or limits",async function(){
    const {dex,alice,deadline}=await networkHelpers.loadFixture(fixture);
    await dex.addLiquidity(1,e("10"),e("10"),0,0,0,deadline);
    await dex.addLiquidity(1,e("10"),e("10"),0,0,0,deadline);
    expect(await dex.getPoolPositionIds(1,1,1)).to.deep.equal([2n]);
    expect(await dex.getOwnerPositionIds(alice.address,2n**255n,10)).to.have.length(0);
    await expect(dex.getPoolPositionIds(1,0,101)).to.be.revertedWithCustomError(dex,"InvalidPageSize");
    await expect(dex.getOwnerPositionIds(alice.address,0,0)).to.be.revertedWithCustomError(dex,"InvalidPageSize");
    await expect(dex.tokenURI(3)).to.be.revertedWithCustomError(dex,"ERC721NonexistentToken");
  });
  it("rejects fee-on-transfer tokens without minting shares or recording reserves",async function(){
    const {dex,a,deadline}=await networkHelpers.loadFixture(fixture);
    const fee=await ethers.deployContract("FeeToken");await fee.waitForDeployment();
    await dex.createPool(await a.getAddress(),await fee.getAddress());
    await fee.approve(await dex.getAddress(),e("100"));
    await expect(dex.addLiquidity(2,e("100"),e("100"),0,0,0,deadline)).to.be.revertedWithCustomError(dex,"UnsupportedTransfer");
    expect((await dex.getPool(2)).reserveA).to.equal(0n);
    expect(await dex.totalShares(2)).to.equal(0n);expect(await dex.positionCount()).to.equal(0n);
    expect(await fee.balanceOf(await dex.getAddress())).to.equal(0n);
  });
  it("blocks reentrant deposits during safe NFT minting",async function(){
    const {dex,a,b}=await networkHelpers.loadFixture(fixture);
    const receiver=await ethers.deployContract("CallbackLP");await receiver.waitForDeployment();
    const address=await receiver.getAddress();
    await a.transfer(address,e("10"));await b.transfer(address,e("10"));
    await receiver.provide(await dex.getAddress(),await a.getAddress(),await b.getAddress(),e("10"));
    expect(await receiver.reentryRejected()).to.equal(true);
    expect(await dex.ownerOf(1)).to.equal(address);expect(await dex.positionCount()).to.equal(1n);
  });});
