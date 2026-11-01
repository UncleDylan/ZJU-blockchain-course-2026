import hre from "hardhat";
import {readFile,readdir,writeFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
const assert=(ok:boolean,message:string)=>{if(!ok)throw Error(`Bonus verification failed: ${message}`);};
async function main(){
 const root=fileURLToPath(new URL("../../",import.meta.url));
 const files=(await readdir(`${root}docs/bonus-runs`)).filter(name=>/^\d+-\d+\.json$/.test(name)).sort();
 const report=JSON.parse(await readFile(process.env.BONUS_REPORT??`${root}docs/bonus-runs/${files.at(-1)}`,"utf8"));
 const {ethers}=await hre.network.create();assert((await ethers.provider.getNetwork()).chainId===31337n&&report.status==="passed","wrong chain or failed report");
 const arb=await ethers.getContractAt("AtomicArbitrage",report.arbitrageAddress);
 const venues=await Promise.all(report.dexes.map((venue:{address:string})=>ethers.getContractAt("MiniDEX",venue.address)));
 const tokens=await Promise.all(report.tokens.map((token:{address:string})=>ethers.getContractAt("TestToken",token.address)));
 const receipt=await ethers.provider.getTransactionReceipt(report.execution.transactionHash),failure=await ethers.provider.getTransactionReceipt(report.rollback.transactionHash);
 assert(receipt?.status===1&&receipt.to?.toLowerCase()===report.arbitrageAddress.toLowerCase(),"successful receipt");
 assert(failure?.status===0&&failure.logs.length===0&&failure.to?.toLowerCase()===report.arbitrageAddress.toLowerCase(),"reverted receipt");
 const topic=venues[0]!.interface.getEvent("Swapped").topicHash;
 const swaps=receipt!.logs.filter(log=>log.topics[0]===topic);
 assert(swaps.length===2&&new Set(swaps.map(log=>log.address.toLowerCase())).size===2,"not two venues in one receipt");
 const event=receipt!.logs.filter(log=>log.address.toLowerCase()===report.arbitrageAddress.toLowerCase()).map(log=>arb.interface.parseLog(log)).find(log=>log?.name==="ArbitrageExecuted");
 assert(!!event&&event.args.profit===BigInt(report.execution.profit)&&event.args.returnedAmount===BigInt(report.execution.returnedAmount),"profit event");
 const input=await ethers.getContractAt("TestToken",report.execution.params.tokenIn),trader=report.execution.trader;
 const balanceBefore=await input.balanceOf(trader,{blockTag:receipt!.blockNumber-1}),balanceAfter=await input.balanceOf(trader,{blockTag:receipt!.blockNumber});
 assert(balanceAfter-balanceBefore===event!.args.profit&&balanceBefore===BigInt(report.execution.walletBefore)&&balanceAfter===BigInt(report.execution.walletAfter),"wallet profit");
 for(let i=0;i<venues.length;i++){
   const before=await venues[i]!.getPool(1,{blockTag:receipt!.blockNumber-1}),after=await venues[i]!.getPool(1,{blockTag:receipt!.blockNumber});
   assert(before.reserveA===BigInt(report.execution.before[i].reserveA)&&before.reserveB===BigInt(report.execution.before[i].reserveB),"before reserves");
   assert(after.reserveA===BigInt(report.execution.after[i].reserveA)&&after.reserveB===BigInt(report.execution.after[i].reserveB),"after reserves");
   const failedBefore=await venues[i]!.getPool(1,{blockTag:failure!.blockNumber-1}),failedAfter=await venues[i]!.getPool(1,{blockTag:failure!.blockNumber});
   assert(failedBefore.reserveA===failedAfter.reserveA&&failedBefore.reserveB===failedAfter.reserveB,"rollback reserves");
   const address=await venues[i]!.getAddress();
   for(let j=0;j<tokens.length;j++){
     const actual=await tokens[j]!.balanceOf(address,{blockTag:failure!.blockNumber});
     assert(actual===(j===0?failedAfter.reserveA:failedAfter.reserveB),"stored and actual reserves");
   }
 }
 for(const token of tokens){
   const before=await token.balanceOf(trader,{blockTag:failure!.blockNumber-1}),after=await token.balanceOf(trader,{blockTag:failure!.blockNumber});
   const allowanceBefore=await token.allowance(trader,report.arbitrageAddress,{blockTag:failure!.blockNumber-1}),allowanceAfter=await token.allowance(trader,report.arbitrageAddress,{blockTag:failure!.blockNumber});
   assert(before===after&&allowanceBefore===allowanceAfter,"rollback wallet or approval");
   let sum=await token.balanceOf(report.arbitrageAddress,{blockTag:failure!.blockNumber});assert(sum===0n,"retained contract funds");
   for(const venue of report.dexes)sum+=await token.balanceOf(venue.address,{blockTag:failure!.blockNumber});
   for(const user of report.users)sum+=await token.balanceOf(user.address,{blockTag:failure!.blockNumber});
   assert(sum===await token.totalSupply({blockTag:failure!.blockNumber}),"token conservation");
 }
 const trace=await ethers.provider.send("debug_traceTransaction",[failure!.hash,{disableMemory:true,disableStack:true,disableStorage:true}]);
 assert(arb.interface.parseError(trace.returnValue.startsWith("0x")?trace.returnValue:`0x${trace.returnValue}`)?.name==="InsufficientProfit","rollback reason");
 const nativeBefore=await ethers.provider.getBalance(trader,failure!.blockNumber-1),nativeAfter=await ethers.provider.getBalance(trader,failure!.blockNumber);
 assert(nativeBefore-nativeAfter===failure!.gasUsed*failure!.gasPrice,"failed transaction gas");
 for(let offset=0;offset<report.journal.length;offset+=20){
   await Promise.all(report.journal.slice(offset,offset+20).map(async(row:{transactionHash:string;user:string})=>{
     const mined=await ethers.provider.getTransactionReceipt(row.transactionHash);
     assert(mined?.status===1&&mined.from.toLowerCase()===row.user.toLowerCase(),"journal receipt");
   }));
 }
 assert(new Set(report.users.map((user:{address:string})=>user.address.toLowerCase())).size===20,"20 users");
 assert(report.users.every((user:{dex1Trades:number;dex2Trades:number})=>user.dex1Trades+user.dex2Trades===report.rounds),"user participation");
 assert(report.journal.filter((row:{action:string})=>row.action==="marketSwap").length===report.marketTrades,"market count");
 const result={result:"passed",successfulTransaction:receipt!.hash,failedTransaction:failure!.hash,twoSwapsInOneReceipt:true,profitMatchesBalance:true,
   rollbackReason:"InsufficientProfit",rollbackAssetsAndPools:true,failedGasStillPaid:true,assetConservation:true,confirmedSuccessReceipts:report.journal.length,users:20,marketTrades:report.marketTrades};
 await writeFile(`${root}docs/bonus-verification.json`,JSON.stringify(result,null,2)+"\n");console.log(JSON.stringify(result));
}
main().catch(error=>{console.error(error);process.exitCode=1;});
