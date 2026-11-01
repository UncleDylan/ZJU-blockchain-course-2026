import { expect } from "chai";
import hre from "hardhat";
const { ethers, networkHelpers } = await hre.network.create();
const e=ethers.parseEther;

describe("Swaps, fees and NFT redemption",function(){
  async function fixture(){
    const [alice,bob,charlie]=await ethers.getSigners();
    const dex=await ethers.deployContract("MiniDEX");
    const x=await ethers.deployContract("TestToken",["A","A"]),y=await ethers.deployContract("TestToken",["B","B"]);
    await Promise.all([dex,x,y].map(c=>c.waitForDeployment()));
    const [a,b]=BigInt(await x.getAddress())<BigInt(await y.getAddress())?[x,y]:[y,x];
    await dex.createPool(await a.getAddress(),await b.getAddress());
    for(const user of [alice,bob,charlie]) for(const token of [a,b]){
      await token.connect(user).claim();await token.connect(user).approve(await dex.getAddress(),e("1000"));
    }
    const deadline=(await networkHelpers.time.latest())+3600;
    await dex.addLiquidity(1,e("100"),e("400"),0,0,0,deadline);
    return {dex,a,b,alice,bob,charlie,deadline};
  }
  it("quotes and executes both directions with a 0.3% fee retained in reserves",async function(){
    const {dex,a,b,bob,deadline}=await networkHelpers.loadFixture(fixture);
    const input=e("10"),expected=input*997n*e("400")/(e("100")*1000n+input*997n);
    const quote=await dex.quoteSwap(1,await a.getAddress(),input);
    expect(quote.amountOut).to.equal(expected);expect(quote.feeAmount).to.equal(e("0.03"));
    const before=await b.balanceOf(bob.address),k=e("100")*e("400");
    await expect(dex.connect(bob).swap(1,await a.getAddress(),input,expected,deadline)).to.emit(dex,"Swapped").withArgs(1n,bob.address,await a.getAddress(),input,expected,e("0.03"));
    const pool=await dex.getPool(1);
    expect(await b.balanceOf(bob.address)-before).to.equal(expected);
    expect(pool.reserveA).to.equal(e("110"));expect(pool.reserveB).to.equal(e("400")-expected);
    expect(pool.reserveA*pool.reserveB).to.be.greaterThan(k);
    const reverse=await dex.quoteSwap(1,await b.getAddress(),e("5"));
    await dex.connect(bob).swap(1,await b.getAddress(),e("5"),reverse.amountOut,deadline);
    const after=await dex.getPool(1);expect(after.reserveA*after.reserveB).to.be.greaterThan(pool.reserveA*pool.reserveB);
    expect(await a.balanceOf(await dex.getAddress())).to.equal(after.reserveA);
    expect(await b.balanceOf(await dex.getAddress())).to.equal(after.reserveB);
  });
  it("rejects a stale quote atomically when another trade changes the price",async function(){
    const {dex,a,b,bob,charlie,deadline}=await networkHelpers.loadFixture(fixture);
    const quote=await dex.quoteSwap(1,await a.getAddress(),e("10"));
    await dex.connect(charlie).swap(1,await a.getAddress(),e("100"),0,deadline);
    const before=await a.balanceOf(bob.address),pool=await dex.getPool(1);
    await expect(dex.connect(bob).swap(1,await a.getAddress(),e("10"),quote.amountOut,deadline)).to.be.revertedWithCustomError(dex,"SlippageExceeded");
    expect(await a.balanceOf(bob.address)).to.equal(before);expect((await dex.getPool(1)).reserveB).to.equal(pool.reserveB);
    expect(await b.balanceOf(await dex.getAddress())).to.equal(pool.reserveB);
  });
  it("rejects invalid tokens, zero/dust/oversized inputs, empty pools and expired trades",async function(){
    const {dex,a,b,bob,deadline}=await networkHelpers.loadFixture(fixture);
    await expect(dex.quoteSwap(1,bob.address,1)).to.be.revertedWithCustomError(dex,"InvalidTokenPair");
    await expect(dex.quoteSwap(1,await a.getAddress(),0)).to.be.revertedWithCustomError(dex,"InvalidAmount");
    await expect(dex.quoteSwap(1,await a.getAddress(),2n**128n)).to.be.revertedWithCustomError(dex,"InvalidAmount");
    await expect(dex.quoteSwap(1,await b.getAddress(),1)).to.be.revertedWithCustomError(dex,"InsufficientLiquidity");
    await expect(dex.quoteSwap(2,await a.getAddress(),1)).to.be.revertedWithCustomError(dex,"PoolNotFound");
    await expect(dex.swap(1,await a.getAddress(),e("1"),0,0)).to.be.revertedWithCustomError(dex,"DeadlineExpired");
    const third=await ethers.deployContract("TestToken",["C","C"]);await third.waitForDeployment();
    await dex.createPool(await a.getAddress(),await third.getAddress());
    await expect(dex.quoteSwap(2,await a.getAddress(),1)).to.be.revertedWithCustomError(dex,"InsufficientLiquidity");
    await a.connect(bob).approve(await dex.getAddress(),0);
    await expect(dex.connect(bob).swap(1,await a.getAddress(),e("1"),0,deadline)).to.be.revertedWithCustomError(a,"ERC20InsufficientAllowance");
  });
  it("returns the current share including retained fees and burns the NFT once",async function(){
    const {dex,a,b,alice,bob,deadline}=await networkHelpers.loadFixture(fixture);
    const position=await dex.positions(1),supply=await dex.totalShares(1);
    await dex.connect(bob).swap(1,await a.getAddress(),e("10"),0,deadline);
    const pool=await dex.getPool(1),quote=await dex.previewRemoveLiquidity(1);
    expect(quote.amountA).to.equal(pool.reserveA*position.shares/supply);
    expect(quote.amountB).to.equal(pool.reserveB*position.shares/supply);
    const hypotheticalNoFeeOut=e("10")*e("400")/e("110");
    expect(quote.amountB).to.be.greaterThan((e("400")-hypotheticalNoFeeOut)*position.shares/supply);
    const balanceA=await a.balanceOf(alice.address),balanceB=await b.balanceOf(alice.address);
    await expect(dex.removeLiquidity(1,quote.amountA,quote.amountB,deadline)).to.emit(dex,"LiquidityRemoved").withArgs(1n,1n,alice.address,quote.amountA,quote.amountB,position.shares);
    expect(await a.balanceOf(alice.address)-balanceA).to.equal(quote.amountA);
    expect(await b.balanceOf(alice.address)-balanceB).to.equal(quote.amountB);
    expect(await dex.totalShares(1)).to.equal(1000n);expect(await dex.totalSupply()).to.equal(0n);
    expect(await dex.redeemedAt(1)).to.be.greaterThan(0n);expect(await dex.redeemedBy(1)).to.equal(alice.address);
    expect((await dex.positions(1)).shares).to.equal(position.shares);
    expect(await dex.getPoolPositionIds(1,0,10)).to.deep.equal([1n]);
    await expect(dex.ownerOf(1)).to.be.revertedWithCustomError(dex,"ERC721NonexistentToken");
    await expect(dex.removeLiquidity(1,0,0,deadline)).to.be.revertedWithCustomError(dex,"ERC721NonexistentToken");
    expect(await dex.getOwnerPositionIds(alice.address,0,10)).to.have.length(0);
  });
  it("lets only the current NFT holder redeem after transfer, not the original provider or an approved operator",async function(){
    const {dex,alice,bob,charlie,deadline}=await networkHelpers.loadFixture(fixture);
    await dex.approve(charlie.address,1);
    await expect(dex.connect(charlie).removeLiquidity(1,0,0,deadline)).to.be.revertedWithCustomError(dex,"NotPositionOwner");
    await dex.transferFrom(alice.address,bob.address,1);
    await expect(dex.removeLiquidity(1,0,0,deadline)).to.be.revertedWithCustomError(dex,"NotPositionOwner");
    await dex.connect(bob).removeLiquidity(1,0,0,deadline);
    expect(await dex.redeemedBy(1)).to.equal(bob.address);
  });
  it("protects withdrawals with two minimum amounts and a deadline",async function(){
    const {dex,alice,deadline}=await networkHelpers.loadFixture(fixture);
    const quote=await dex.previewRemoveLiquidity(1);
    await expect(dex.removeLiquidity(1,quote.amountA+1n,0,deadline)).to.be.revertedWithCustomError(dex,"SlippageExceeded");
    await expect(dex.removeLiquidity(1,0,quote.amountB+1n,deadline)).to.be.revertedWithCustomError(dex,"SlippageExceeded");
    await expect(dex.removeLiquidity(1,0,0,0)).to.be.revertedWithCustomError(dex,"DeadlineExpired");
    expect(await dex.ownerOf(1)).to.equal(alice.address);
  });
  it("keeps other positions and shared-token pools intact when one position is redeemed",async function(){
    const {dex,a,b,bob,deadline}=await networkHelpers.loadFixture(fixture);
    await dex.connect(bob).addLiquidity(1,e("50"),e("200"),0,0,0,deadline);
    const c=await ethers.deployContract("TestToken",["C","C"]);await c.waitForDeployment();await c.claim();await c.approve(await dex.getAddress(),e("1000"));
    await dex.createPool(await a.getAddress(),await c.getAddress());await dex.addLiquidity(2,e("10"),e("10"),0,0,0,deadline);
    const second=await dex.getPool(2);
    await dex.removeLiquidity(1,0,0,deadline);
    expect((await dex.getPool(2)).reserveA).to.equal(second.reserveA);
    const first=await dex.getPool(1),third=await dex.getPool(2);
    const shared=third.tokenA===await a.getAddress()?third.reserveA:third.reserveB;
    expect(await a.balanceOf(await dex.getAddress())).to.equal(first.reserveA+shared);
    expect(await b.balanceOf(await dex.getAddress())).to.equal(first.reserveB);
    const quote=await dex.previewRemoveLiquidity(2);
    await dex.connect(bob).removeLiquidity(2,quote.amountA,quote.amountB,deadline);
    expect(await dex.totalShares(1)).to.equal(1000n);
  });
  it("rolls back swaps and NFT burns when a token begins charging transfer fees",async function(){
    const {dex,a,alice,deadline}=await networkHelpers.loadFixture(fixture);
    const fee=await ethers.deployContract("FeeToken");await fee.waitForDeployment();await fee.setFeeEnabled(false);
    await dex.createPool(await a.getAddress(),await fee.getAddress());await fee.approve(await dex.getAddress(),e("1000"));
    await dex.addLiquidity(2,e("100"),e("100"),0,0,0,deadline);await fee.setFeeEnabled(true);
    const before=await dex.getPool(2),balance=await a.balanceOf(alice.address);
    for(const token of [a,fee])await expect(dex.swap(2,await token.getAddress(),e("1"),0,deadline)).to.be.revertedWithCustomError(dex,"UnsupportedTransfer");
    await expect(dex.removeLiquidity(2,0,0,deadline)).to.be.revertedWithCustomError(dex,"UnsupportedTransfer");
    expect(await dex.ownerOf(2)).to.equal(alice.address);expect(await dex.redeemedAt(2)).to.equal(0n);
    expect((await dex.getPool(2)).reserveA).to.equal(before.reserveA);expect(await a.balanceOf(alice.address)).to.equal(balance);
  });
});
