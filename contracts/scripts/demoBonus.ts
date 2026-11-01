import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Contract } from "ethers";
import { deployApp } from "./lib/deployment.js";
import hre from "hardhat";

const requireThat=(value:boolean,message:string)=>{if(!value)throw Error(message);};
async function main(){
  const connection=await hre.network.create();
  requireThat((await connection.ethers.provider.getNetwork()).chainId===31337n,"Bonus demo only supports local chain 31337");
  requireThat((await connection.ethers.getSigners()).length>=20,"Need 20 unlocked local accounts");
  const seed=Number(process.env.BONUS_SEED??20261029),rounds=Number(process.env.BONUS_ROUNDS??3);
  requireThat(Number.isInteger(seed)&&seed>=0&&seed<=0xffffffff&&Number.isInteger(rounds)&&rounds>=1&&rounds<=20,"Invalid demo options");
  let randomState=seed>>>0;
  const random=()=>{randomState=(randomState+0x6d2b79f5)>>>0;let t=randomState;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return((t^(t>>>14))>>>0)/4294967296;};
  const started=Date.now(),root=fileURLToPath(new URL("../../",import.meta.url));
  const {ethers,tokenA,tokenB,miniDEX:first,secondDEX:second,arbitrage:arb,deployment}=await deployApp(true);
  if(!second||!arb)throw Error("Bonus deployment missing");
  const users=(await ethers.getSigners()).slice(0,20),addresses=await Promise.all(users.map(user=>user.getAddress()));
  const [a,b]=BigInt(await tokenA.getAddress())<BigInt(await tokenB.getAddress())?[tokenA,tokenB]:[tokenB,tokenA];
  const addrA=await a.getAddress(),addrB=await b.getAddress(),arbAddress=await arb.getAddress();
  const e=ethers.parseEther,minimum=(value:bigint)=>value*995n/1000n||1n;
  const deadline=async()=>{const block=await ethers.provider.getBlock("latest");return block!.timestamp+600;};
  const journal:Record<string,unknown>[]=[],snapshots:Record<string,unknown>[]=[];
  async function confirm(tx:{hash:string;wait:()=>Promise<import('ethers').TransactionReceipt|null>},action:string,user:string,details:Record<string,unknown>={}){
    const receipt=await tx.wait();requireThat(receipt?.status===1,`${action} failed`);
    journal.push({action,user,transactionHash:tx.hash,blockNumber:receipt!.blockNumber,gasUsed:receipt!.gasUsed,gasCostWei:receipt!.gasUsed*receipt!.gasPrice,...details});return receipt!;
  }
  async function snapshot(){
    return Promise.all([first,second!].map(async(dex,index)=>{
      const pool=await dex.getPool(1);
      requireThat(await a.balanceOf(await dex.getAddress())===pool.reserveA&&await b.balanceOf(await dex.getAddress())===pool.reserveB,"Pool assets differ from reserves");
      return {name:`DEX ${index+1}`,address:await dex.getAddress(),poolId:1,reserveA:pool.reserveA,reserveB:pool.reserveB,priceBPerA:ethers.formatEther(pool.reserveB*e("1")/pool.reserveA)};
    }));
  }
  for(let i=0;i<20;i++){
    for(const token of [a,b]){
      await confirm(await token.connect(users[i]!).claim(),"claim",addresses[i]!,{token:await token.getAddress()});
      for(const dex of [first,second])await confirm(await token.connect(users[i]!).approve(await dex.getAddress(),e("1000")),"approve",addresses[i]!);
    }
  }
  for(const dex of [first,second])await confirm(await dex.createPool(addrA,addrB),"createPool",addresses[0]!);
  for(let i=0;i<20;i++)for(const dex of [first,second])await confirm(await dex.connect(users[i]!).addLiquidity(1,e("20"),e("20"),0,0,0,await deadline()),"add",addresses[i]!);
  snapshots.push({stage:"initial",pools:await snapshot()});
  const counts=addresses.map(address=>({address,dex1Trades:0,dex2Trades:0}));
  for(let round=1;round<=rounds;round++){
    const order=users.map((_,i)=>i);
    for(let i=19;i>0;i--){const j=Math.floor(random()*(i+1));[order[i],order[j]]=[order[j]!,order[i]!];}
    for(const i of order){
      const venue=random()<0.5?0:1,dex=venue===0?first:second;
      // Different random order-flow biases make price discrepancies reproducible.
      const aToB=random()<(venue===0?0.75:0.25),token=aToB?a:b,amount=e(String(1+Math.floor(random()*8)));
      const quote=await dex.quoteSwap(1,await token.getAddress(),amount);
      await confirm(await dex.connect(users[i]!).swap(1,await token.getAddress(),amount,minimum(quote.amountOut),await deadline()),"marketSwap",addresses[i]!,{venue:venue+1,tokenIn:await token.getAddress(),amountIn:amount,amountOut:quote.amountOut});
      if(venue===0)counts[i]!.dex1Trades++;else counts[i]!.dex2Trades++;
    }
    snapshots.push({stage:`round ${round}`,pools:await snapshot()});console.log(JSON.stringify({stage:"market",round,trades:round*20}));
  }
  const capitalUser=users[19]!,trader=addresses[19]!;
  const candidates: {startOnFirst:boolean;tokenIn:string;amountIn:bigint;intermediateAmount:bigint;returnedAmount:bigint;profit:bigint}[]=[];
  for(const startOnFirst of [true,false])for(const tokenIn of [addrA,addrB])for(const size of [1,2,5,10,20,40]){
    const quote=await arb.quote(startOnFirst,1,1,tokenIn,e(String(size)));
    candidates.push({startOnFirst,tokenIn,amountIn:e(String(size)),intermediateAmount:quote.intermediateAmount,returnedAmount:quote.returnedAmount,profit:quote.profit});
  }
  candidates.sort((x,y)=>x.profit>y.profit?-1:x.profit<y.profit?1:0);
  const best=candidates[0]!;requireThat(best.profit>e("0.001"),"No profitable candidate: change the seed or increase market rounds");
  const input=best.tokenIn.toLowerCase()===addrA.toLowerCase()?a:b,middle=input===a?b:a;
  await confirm(await input.connect(capitalUser).approve(arbAddress,e("1000")),"approveArbitrage",trader);
  const before=await snapshot(),walletBefore=await input.balanceOf(trader),middleBefore=await middle.balanceOf(trader);
  const params={startOnFirst:best.startOnFirst,firstPoolId:1,secondPoolId:1,tokenIn:best.tokenIn,amountIn:best.amountIn,
    minIntermediate:minimum(best.intermediateAmount),minProfit:minimum(best.profit),deadline:await deadline()};
  const receipt=await confirm(await arb.connect(capitalUser).execute(params),"arbitrage",trader);
  const after=await snapshot(),walletAfter=await input.balanceOf(trader);
  const parsed=receipt.logs.filter(log=>log.address.toLowerCase()===arbAddress.toLowerCase()).map(log=>arb.interface.parseLog(log)).find(log=>log?.name==="ArbitrageExecuted");
  const swapTopic=first.interface.getEvent("Swapped").topicHash,swapLogs=receipt.logs.filter(log=>log.topics[0]===swapTopic);
  requireThat(!!parsed&&swapLogs.length===2&&walletAfter-walletBefore===best.profit,"Atomic receipt or profit mismatch");
  requireThat(await middle.balanceOf(trader)===middleBefore&&await a.balanceOf(arbAddress)===0n&&await b.balanceOf(arbAddress)===0n,"Arbitrage retained assets");
  for(const dex of [first,second])for(const token of [a,b])requireThat(await token.allowance(arbAddress,await dex.getAddress())===0n,"Residual venue allowance");

  const failedBefore=await snapshot(),failedBalance=await input.balanceOf(trader),allowanceBefore=await input.allowance(trader,arbAddress);
  const nativeBefore=await ethers.provider.getBalance(trader);
  const failureBlock=await ethers.provider.getBlockNumber();
  const failureParams={...params,minIntermediate:1,minProfit:e("10000"),deadline:await deadline()};
  let failedHash:string|undefined;
  try{
    const tx=await arb.connect(capitalUser).execute(failureParams,{gasLimit:1_500_000});
    failedHash=tx.hash;await tx.wait();
  }catch(error){
    if(!failedHash){
      const serialized=String(error)+JSON.stringify(error,(_,value)=>typeof value==="bigint"?value.toString():value);
      for(const hash of new Set(serialized.match(/0x[0-9a-fA-F]{64}/g)??[])){
        const candidate=await ethers.provider.getTransactionReceipt(hash);
        if(candidate?.status===0&&candidate.to?.toLowerCase()===arbAddress.toLowerCase()){failedHash=hash;break;}
      }
    }
  }
  // Hardhat may throw at send-time even though the reverted transaction was mined.
  // Locate it by sender, destination and exact calldata in the newly mined blocks.
  if(!failedHash){
    const latest=await ethers.provider.getBlockNumber(),data=arb.interface.encodeFunctionData("execute",[failureParams]);
    for(let height=failureBlock+1;height<=latest;height++){
      const block=await ethers.provider.getBlock(height);
      for(const hash of block!.transactions){
        const tx=await ethers.provider.getTransaction(hash),receipt=await ethers.provider.getTransactionReceipt(hash);
        if(tx?.from.toLowerCase()===trader.toLowerCase()&&tx.to?.toLowerCase()===arbAddress.toLowerCase()&&tx.data===data&&receipt?.status===0)failedHash=hash;
      }
    }
  }
  requireThat(!!failedHash,"Unable to locate the mined reverted transaction");
  const failure=await ethers.provider.getTransactionReceipt(failedHash!);
  requireThat(failure?.status===0&&failure.logs.length===0,"Failure was not an atomic on-chain revert");
  const trace=await ethers.provider.send("debug_traceTransaction",[failedHash!,{disableMemory:true,disableStack:true,disableStorage:true}]);
  const returned=trace.returnValue.startsWith("0x")?trace.returnValue:`0x${trace.returnValue}`;
  requireThat(arb.interface.parseError(returned)?.name==="InsufficientProfit","Unexpected rollback reason");
  const failedAfter=await snapshot();
  const json=(value:unknown)=>JSON.stringify(value,(_,v)=>typeof v==="bigint"?v.toString():v);
  requireThat(json(failedBefore)===json(failedAfter)&&await input.balanceOf(trader)===failedBalance&&await input.allowance(trader,arbAddress)===allowanceBefore,"Failed arbitrage changed assets or pools");
  const gasCost=failure!.gasUsed*failure!.gasPrice;
  requireThat(nativeBefore-await ethers.provider.getBalance(trader)===gasCost,"Reverted transaction gas accounting mismatch");
  const report={type:"minidex-bonus",version:1,status:"passed",startedAt:new Date(started).toISOString(),completedAt:new Date().toISOString(),seed,rounds,
    chainId:31337,dexes:deployment.exchanges,arbitrageAddress:arbAddress,users:counts,marketTrades:rounds*20,orderFlowBias:{dex1AToB:0.75,dex2AToB:0.25},
    tokens:[{address:addrA,symbol:await a.symbol(),decimals:18},{address:addrB,symbol:await b.symbol(),decimals:18}],snapshots,candidates,
    execution:{params,trader,transactionHash:receipt.hash,blockNumber:receipt.blockNumber,swapEvents:swapLogs.length,before,after,
      walletBefore,walletAfter,intermediateAmount:parsed!.args.intermediateAmount,returnedAmount:parsed!.args.returnedAmount,profit:parsed!.args.profit,gasCostWei:receipt.gasUsed*receipt.gasPrice},
    rollback:{transactionHash:failedHash,blockNumber:failure!.blockNumber,status:failure!.status,reason:"InsufficientProfit",logs:failure!.logs.length,poolsUnchanged:true,tokenBalancesUnchanged:true,allowanceUnchanged:true,gasCostWei:gasCost},journal};
  await mkdir(`${root}docs/bonus-runs`,{recursive:true});
  await writeFile(`${root}docs/bonus-runs/${started}-${seed}.json`,JSON.stringify(report,(_,v)=>typeof v==="bigint"?v.toString():v,2)+"\n");
  await writeFile(`${root}frontend/public/bonus.json`,JSON.stringify(report,(_,v)=>typeof v==="bigint"?v.toString():v,2)+"\n");
  console.log(JSON.stringify({status:"passed",users:20,marketTrades:rounds*20,profit:ethers.formatEther(best.profit),token:await input.symbol(),transactionHash:receipt.hash,failedHash,failedReceiptStatus:failure!.status,swapEvents:swapLogs.length,report:`docs/bonus-runs/${started}-${seed}.json`}));
}
main().catch(error=>{console.error(error);process.exitCode=1;});
