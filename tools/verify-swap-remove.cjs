// Run on Ubuntu after a fresh deployment. Uses only unlocked local test accounts.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {JsonRpcProvider,Contract,parseEther:e,formatEther:f}=require('../contracts/node_modules/ethers');
const {readFile,mkdir,writeFile}=require('node:fs/promises');
const path=require('node:path');
(async()=>{
 const root=path.resolve(__dirname,'..'),config=JSON.parse(await readFile(path.join(root,'frontend/public/deployment.json'),'utf8'));
 const provider=new JsonRpcProvider('http://127.0.0.1:8545',undefined,{cacheTimeout:-1});
 let browser;
 try{
 if((await provider.getNetwork()).chainId!==31337n)throw Error('Local chain 31337 required');
 const users=await provider.listAccounts();
 const dex=new Contract(config.miniDEX,config.dexAbi,users[0]);
 for(const user of users.slice(0,3))for(const info of config.tokens){
   const token=new Contract(info.address,config.tokenAbi,user);await(await token.claim()).wait();await(await token.approve(config.miniDEX,e('1000'))).wait();
 }
 await(await dex.createPool(config.tokens[0].address,config.tokens[1].address)).wait();
 await(await dex.addLiquidity(1,e('100'),e('400'),0,0,0,Math.floor(Date.now()/1000)+3600)).wait();
 await(await dex.connect(users[1]).addLiquidity(1,e('50'),e('200'),0,0,0,Math.floor(Date.now()/1000)+3600)).wait();
 const initial=await dex.getPool(1),a=new Contract(initial.tokenA,config.tokenAbi,provider),b=new Contract(initial.tokenB,config.tokenAbi,provider);
 const reserves=p=>({a:f(p.reserveA),b:f(p.reserveB),k:(p.reserveA*p.reserveB).toString()});
 const record={wallet:'local EIP-1193 adapter; not MetaMask',initial:reserves(initial),trades:[]};
 let account=users[2].address,connected=false;
 browser=await chromium.launch({headless:true});
 const page=await browser.newPage({viewport:{width:1280,height:1000}}),errors=[];page.on('pageerror',err=>errors.push(err.message));
 await page.exposeFunction('localTestRpc',async({method,params})=>{
   if(method==='eth_requestAccounts'){connected=true;return [account];}if(method==='eth_accounts')return connected?[account]:[];
   return provider.send(method,params??[]);
 });
 await page.addInitScript(()=>{const listeners=new Map();window.ethereum={request:args=>window.localTestRpc(args),on:(event,l)=>{if(!listeners.has(event))listeners.set(event,new Set());listeners.get(event).add(l)},removeListener:(event,l)=>listeners.get(event)?.delete(l),emit:(event,data)=>{for(const l of listeners.get(event)??[])l(data)}};});
 await page.goto('http://127.0.0.1:3000',{waitUntil:'networkidle'});await page.getByRole('button',{name:'连接钱包',exact:true}).click();
 await page.getByRole('button',{name:'管理池 #1 流动性',exact:true}).click();
 const output=path.join(root,'docs/screenshots');await mkdir(output,{recursive:true});
 const section=page.getByRole('region',{name:'池 #1 · 流动性与 NFT',exact:true});
 for(const [direction,input,tokenIn,tokenOut]of [['A','10',a,b],['B','5',b,a]]){
   const quote=await dex.quoteSwap(1,await tokenIn.getAddress(),e(input)),before=await tokenOut.balanceOf(account),beforePool=await dex.getPool(1);
   await page.getByRole('combobox',{name:/兑换方向/}).selectOption(direction);await page.getByLabel('兑换输入数量',{exact:true}).fill(input);
   await page.getByRole('button',{name:'获取兑换报价',exact:true}).click();await page.getByText(/预计输出：/).waitFor();
   if(direction==='A')await section.screenshot({path:path.join(output,'step5-quote.png')});
   await page.getByRole('button',{name:'授权并兑换',exact:true}).click();await page.getByRole('status').filter({hasText:'兑换成功。交易：'}).waitFor({timeout:60000});
   const after=await tokenOut.balanceOf(account),pool=await dex.getPool(1);
   if(after-before!==quote.amountOut||pool.reserveA*pool.reserveB<=beforePool.reserveA*beforePool.reserveB)throw Error('Swap amount or fee invariant mismatch');
   record.trades.push({direction,input,output:f(quote.amountOut),fee:f(quote.feeAmount),after:reserves(pool),transaction:(await page.getByRole('status').filter({hasText:'兑换成功。交易：'}).innerText()).match(/0x[0-9a-fA-F]{64}/)[0]});
 }
 await page.getByRole('button',{name:'刷新流动性与 NFT',exact:true}).waitFor({state:'visible'});
 await page.waitForFunction(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent==='刷新流动性与 NFT');return b&&!b.disabled;});
 await section.screenshot({path:path.join(output,'step5-swap.png')});
 await(await dex.transferFrom(users[0].address,users[1].address,1)).wait();
 account=users[0].address;await page.evaluate(addr=>window.ethereum.emit('accountsChanged',[addr]),account);
 await page.getByText('当前账户尚无流动性 NFT。',{exact:true}).waitFor();
 if(await page.getByRole('button',{name:'预览赎回 NFT #1',exact:true}).count())throw Error('Original provider can redeem transferred NFT');
 account=users[1].address;await page.evaluate(addr=>window.ethereum.emit('accountsChanged',[addr]),account);
 const quote=await dex.previewRemoveLiquidity(2),beforeA=await a.balanceOf(account),beforeB=await b.balanceOf(account);
 await page.getByRole('button',{name:'预览赎回 NFT #2',exact:true}).first().click();
 await page.getByRole('button',{name:'确认销毁 NFT #2 并赎回',exact:true}).click();
 await page.getByRole('status').filter({hasText:'赎回成功，NFT #2 已销毁'}).waitFor({timeout:60000});
 await page.getByRole('article',{name:'NFT #2',exact:true}).filter({hasText:'当前持有人：已销毁'}).waitFor();
 if(await a.balanceOf(account)-beforeA!==quote.amountA||await b.balanceOf(account)-beforeB!==quote.amountB)throw Error('Redemption balance mismatch');
 if(await dex.redeemedAt(2)===0n||await dex.ownerOf(1)!==account||await dex.totalSupply()!==1n)throw Error('Burn/ownership mismatch');
 record.redemption={nft:2,a:f(quote.amountA),b:f(quote.amountB),by:account,remaining:reserves(await dex.getPool(1)),historyPreserved:true};
 await section.screenshot({path:path.join(output,'step5-redemption.png')});
 await page.reload({waitUntil:'networkidle'});await page.getByRole('button',{name:'管理池 #1 流动性',exact:true}).click();
 await page.getByRole('article',{name:'NFT #2',exact:true}).filter({hasText:'当前持有人：已销毁'}).waitFor();
 await page.setViewportSize({width:390,height:844});if(!(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)))throw Error('Mobile overflow');
 if(errors.length)throw Error(errors.join('\n'));
 const code=await provider.getCode(config.miniDEX);
 Object.assign(record,{result:'passed',pageErrors:errors,mobileOverflow:false,persistsAfterReload:true,deployedCodeBytes:(code.length-2)/2});
 await writeFile(path.join(root,'docs/step5-verification.json'),JSON.stringify(record,null,2)+'\n');console.log(JSON.stringify(record));
 }finally{if(browser)await browser.close();provider.destroy();}
})().catch(err=>{console.error(err);process.exitCode=1});
