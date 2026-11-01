import { expect } from "chai";
import hre from "hardhat";
const { ethers, networkHelpers } = await hre.network.create();
const e=ethers.parseEther;

describe("Atomic two-venue arbitrage",function(){
  async function fixture(){
    const [alice,bob,trader,other]=await ethers.getSigners();
    const x=await ethers.deployContract("TestToken",["A","A"]),y=await ethers.deployContract("TestToken",["B","B"]);
    const first=await ethers.deployContract("MiniDEX"),second=await ethers.deployContract("MiniDEX");
    await Promise.all([x,y,first,second].map(c=>c.waitForDeployment()));
    const [a,b]=BigInt(await x.getAddress())<BigInt(await y.getAddress())?[x,y]:[y,x];
    const arb=await ethers.deployContract("AtomicArbitrage",[await first.getAddress(),await second.getAddress()]);await arb.waitForDeployment();
    for(const user of [alice,bob,trader,other])for(const token of [a,b]){
      await token.connect(user).claim();
      for(const target of [first,second,arb])await token.connect(user).approve(await target.getAddress(),e("1000"));
    }
    for(const dex of [first,second])await dex.createPool(await a.getAddress(),await b.getAddress());
    const deadline=(await networkHelpers.time.latest())+3600;
    await first.addLiquidity(1,e("400"),e("800"),0,0,0,deadline);
    await second.connect(bob).addLiquidity(1,e("800"),e("400"),0,0,0,deadline);
    const params={startOnFirst:true,firstPoolId:1,secondPoolId:1,tokenIn:await a.getAddress(),amountIn:e("10"),minIntermediate:1n,minProfit:1n,deadline};
    return {a,b,first,second,arb,alice,bob,trader,other,params,deadline};
  }
  it("executes both fee-paying swaps in one receipt and pays principal plus profit to the caller",async function(){
    const {a,b,first,second,arb,trader,params}=await networkHelpers.loadFixture(fixture);
    const quote=await arb.quote(true,1,1,params.tokenIn,params.amountIn);
    expect(quote.profit).to.be.greaterThan(0n);
    const before=await a.balanceOf(trader.address),midBefore=await b.balanceOf(trader.address);
    const tx=await arb.connect(trader).execute({...params,minIntermediate:quote.intermediateAmount,minProfit:quote.profit});
    await expect(tx).to.emit(arb,"ArbitrageExecuted").withArgs(trader.address,params.tokenIn,true,1n,1n,params.amountIn,quote.intermediateAmount,quote.returnedAmount,quote.profit);
    const receipt=await tx.wait();
    const swapTopic=first.interface.getEvent("Swapped").topicHash;
    expect(receipt!.logs.filter(log=>log.topics[0]===swapTopic)).to.have.length(2);
    expect(await a.balanceOf(trader.address)-before).to.equal(quote.profit);
    expect(await b.balanceOf(trader.address)).to.equal(midBefore);
    expect(await a.balanceOf(await arb.getAddress())).to.equal(0n);expect(await b.balanceOf(await arb.getAddress())).to.equal(0n);
    expect(await a.allowance(await arb.getAddress(),await first.getAddress())).to.equal(0n);
    expect(await b.allowance(await arb.getAddress(),await second.getAddress())).to.equal(0n);
  });
  it("also supports starting with the other token and the reverse venue order",async function(){
    const {b,arb,trader,params}=await networkHelpers.loadFixture(fixture);
    const quote=await arb.quote(false,1,1,await b.getAddress(),e("10"));
    expect(quote.profit).to.be.greaterThan(0n);
    await arb.connect(trader).execute({...params,startOnFirst:false,tokenIn:await b.getAddress(),minProfit:quote.profit});
  });
  it("reverts both swaps, user balances and allowances when the final profit is insufficient",async function(){
    const {a,b,first,second,arb,trader,params}=await networkHelpers.loadFixture(fixture);
    const p1=await first.getPool(1),p2=await second.getPool(1),balance=await a.balanceOf(trader.address);
    const allowance=await a.allowance(trader.address,await arb.getAddress());
    await expect(arb.connect(trader).execute({...params,minProfit:e("10000")})).to.be.revertedWithCustomError(arb,"InsufficientProfit");
    expect((await first.getPool(1)).reserveA).to.equal(p1.reserveA);expect((await first.getPool(1)).reserveB).to.equal(p1.reserveB);
    expect((await second.getPool(1)).reserveA).to.equal(p2.reserveA);expect((await second.getPool(1)).reserveB).to.equal(p2.reserveB);
    expect(await a.balanceOf(trader.address)).to.equal(balance);expect(await a.allowance(trader.address,await arb.getAddress())).to.equal(allowance);
    expect(await a.balanceOf(await arb.getAddress())).to.equal(0n);expect(await b.balanceOf(await arb.getAddress())).to.equal(0n);
    expect(await a.allowance(await arb.getAddress(),await first.getAddress())).to.equal(0n);
  });
  it("refuses a losing round trip and protects the first-leg minimum",async function(){
    const {a,b,arb,trader,params}=await networkHelpers.loadFixture(fixture);
    const losing=await arb.quote(false,1,1,await a.getAddress(),e("10"));expect(losing.profit).to.equal(0n);
    await expect(arb.connect(trader).execute({...params,startOnFirst:false})).to.be.revertedWithCustomError(arb,"InsufficientProfit");
    await expect(arb.connect(trader).execute({...params,minIntermediate:e("1000")})).to.be.revertedWithCustomError(await ethers.getContractAt("MiniDEX",await arb.dex1()),"SlippageExceeded");
    expect(await b.balanceOf(trader.address)).to.equal(e("1000"));
  });
  it("cannot spend donated balances as another caller's profit",async function(){
    const {a,b,arb,trader,other,params}=await networkHelpers.loadFixture(fixture);
    await a.connect(other).transfer(await arb.getAddress(),e("30"));await b.connect(other).transfer(await arb.getAddress(),e("50"));
    await arb.connect(trader).execute(params);
    expect(await a.balanceOf(await arb.getAddress())).to.equal(e("30"));expect(await b.balanceOf(await arb.getAddress())).to.equal(e("50"));
  });
  it("rejects invalid venues, routes, zero-profit limits and expired requests",async function(){
    const {first,second,arb,trader,params}=await networkHelpers.loadFixture(fixture);
    await expect(ethers.deployContract("AtomicArbitrage",[trader.address,await first.getAddress()])).to.be.revertedWithCustomError(arb,"InvalidVenue");
    await expect(ethers.deployContract("AtomicArbitrage",[await first.getAddress(),await first.getAddress()])).to.be.revertedWithCustomError(arb,"InvalidVenue");
    await expect(arb.execute({...params,deadline:0})).to.be.revertedWithCustomError(arb,"DeadlineExpired");
    for(const patch of [{amountIn:0n},{minProfit:0n},{minIntermediate:0n}])await expect(arb.execute({...params,...patch})).to.be.revertedWithCustomError(arb,"InvalidAmount");
    await expect(arb.quote(true,1,1,trader.address,e("1"))).to.be.revertedWithCustomError(arb,"InvalidRoute");
    const c=await ethers.deployContract("TestToken",["C","C"]);await c.waitForDeployment();
    await second.createPool(params.tokenIn,await c.getAddress());
    await expect(arb.quote(true,1,2,params.tokenIn,e("1"))).to.be.revertedWithCustomError(arb,"InvalidRoute");
  });
  it("requires the caller's own capital approval",async function(){
    const {a,arb,trader,params}=await networkHelpers.loadFixture(fixture);
    await a.connect(trader).approve(await arb.getAddress(),0);
    await expect(arb.connect(trader).execute(params)).to.be.revertedWithCustomError(a,"ERC20InsufficientAllowance");
  });
});
