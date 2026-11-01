// Requires Playwright (or PLAYWRIGHT_MODULE pointing to an existing installation).
// Run in Ubuntu after a fresh deployment: node tools/verify-liquidity.cjs
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {JsonRpcProvider,Contract}=require('../contracts/node_modules/ethers');
const {readFile,mkdir}=require('node:fs/promises');
const path=require('node:path');
(async()=>{
 const root=path.resolve(__dirname,'..');
 const config=JSON.parse(await readFile(path.join(root,'frontend/public/deployment.json'),'utf8'));
 const provider=new JsonRpcProvider('http://127.0.0.1:8545');
 if((await provider.getNetwork()).chainId!==31337n)throw Error('Local chain 31337 required');
 const users=await provider.listAccounts();let account=users[0].address,connected=false;
 const browser=await chromium.launch({headless:true});
 try{
 const page=await browser.newPage({viewport:{width:1280,height:1000}});const errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.exposeFunction('localTestRpc',async({method,params})=>{
   if(method==='eth_requestAccounts'){connected=true;return [account];}
   if(method==='eth_accounts')return connected?[account]:[];
   return provider.send(method,params??[]);
 });
 await page.addInitScript(()=>{const listeners=new Map();window.ethereum={request:args=>window.localTestRpc(args),on:(e,l)=>{if(!listeners.has(e))listeners.set(e,new Set());listeners.get(e).add(l)},removeListener:(e,l)=>listeners.get(e)?.delete(l),emit:(e,data)=>{for(const l of listeners.get(e)??[])l(data)}};});
 await page.goto('http://127.0.0.1:3000',{waitUntil:'networkidle'});
 await page.getByRole('button',{name:'连接钱包',exact:true}).click();
 async function claim(){for(const symbol of ['TKA','TKB']){
   await page.getByRole('button',{name:`领取 1000.0 ${symbol}`,exact:true}).click();
   await page.getByRole('status').filter({hasText:`${symbol} 领取成功`}).waitFor({timeout:30000});
 }}
 await claim();
 await page.getByRole('button',{name:'创建交易池',exact:true}).click();
 await page.getByRole('status').filter({hasText:'交易池创建成功'}).waitFor({timeout:30000});
 await page.getByRole('button',{name:'管理池 #1 流动性',exact:true}).click();
 async function deposit(a,b){
   await page.getByLabel(/^最大投入 A/).fill(a);await page.getByLabel(/^最大投入 B/).fill(b);
   await page.getByRole('button',{name:'预览实际投入',exact:true}).click();
   await page.getByText(/预计实际投入：/).waitFor();
   await page.getByRole('button',{name:'授权并添加流动性',exact:true}).click();
   await page.getByRole('status').filter({hasText:'添加流动性成功'}).waitFor({timeout:60000});
 }
 await deposit('100','400');
 await page.getByRole('article',{name:'NFT #1',exact:true}).first().waitFor();
 account=users[1].address;
 await page.evaluate(a=>window.ethereum.emit('accountsChanged',[a]),account);
 await claim();await deposit('100','200');
 await page.getByRole('article',{name:'NFT #2',exact:true}).first().waitFor();
 const dex=new Contract(config.miniDEX,config.dexAbi,provider);
 const pool=await dex.getPool(1),position=await dex.positions(2);
 if(pool.reserveA!==150n*10n**18n||pool.reserveB!==600n*10n**18n||position.shares!==100n*10n**18n)throw Error('Pool accounting mismatch');
 if(await dex.ownerOf(1)!==users[0].address||await dex.ownerOf(2)!==users[1].address)throw Error('NFT ownership mismatch');
 const token=new Contract(pool.tokenA,config.tokenAbi,provider);
 if(await token.balanceOf(account)!==950n*10n**18n)throw Error('Unused maximum input was spent');
 const out=path.join(root,'docs/screenshots');await mkdir(out,{recursive:true});
 await page.getByRole('region',{name:'池 #1 · 流动性与 NFT',exact:true}).screenshot({path:path.join(out,'step4-liquidity.png')});
 await page.reload({waitUntil:'networkidle'});await page.getByRole('button',{name:'管理池 #1 流动性',exact:true}).click();
 await page.getByRole('article',{name:'NFT #2',exact:true}).first().waitFor();
 await page.setViewportSize({width:390,height:844});
 if(!(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)))throw Error('Mobile overflow');
 if(errors.length)throw Error(errors.join('\n'));
 console.log(JSON.stringify({result:'passed',users:2,reserveA:'150',reserveB:'600',secondUserShares:position.shares.toString(),secondUserTokenABalance:'950',NFTs:2,persistsAfterReload:true,mobileOverflow:false,pageErrors:errors,wallet:'local EIP-1193 adapter; not MetaMask'}));
 }finally{await browser.close();provider.destroy();}
})().catch(e=>{console.error(e);process.exitCode=1});
