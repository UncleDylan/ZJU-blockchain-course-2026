import {beforeEach,afterEach,expect,test,vi} from 'vitest';
import {render,screen,fireEvent,waitFor,cleanup} from '@testing-library/react';
import BonusPanel from './BonusPanel';
import type {WalletProvider} from './chain';
const mock=vi.hoisted(()=>({quote:vi.fn(),execute:vi.fn()}));
vi.mock('ethers',async original=>{
 const real=await original<typeof import('ethers')>();
 return {...real,BrowserProvider:class{send=async()=> '0x64';getNetwork=async()=>({chainId:31337n});getSigner=async()=>({});getBlock=async()=>({timestamp:100});destroy(){}},
 Contract:class{quote=mock.quote;execute=mock.execute;getPoolId=async()=>1n;getPool=async()=>({tokenA:'0x0000000000000000000000000000000000000001',reserveA:real.parseEther('400'),reserveB:real.parseEther('400')});allowance=async()=>real.parseEther('1000');balanceOf=async()=>real.parseEther('1000');}};
});
const addr=(n:number)=>`0x${n.toString(16).padStart(40,'0')}`;
const deployment={chainId:31337,miniDEX:addr(3),dexAbi:[],tokenAbi:[],tokens:[{name:'Token A',symbol:'TKA',address:addr(1)},{name:'Token B',symbol:'TKB',address:addr(2)}],exchanges:[{name:'DEX 1',address:addr(3)},{name:'DEX 2',address:addr(4)}],arbitrage:addr(5),arbitrageAbi:[]};
const wallet={request:async()=>null} as WalletProvider;
beforeEach(()=>{vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:false,status:404}));mock.quote.mockReset();mock.execute.mockReset();});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
test('blocks execution without a wallet',()=>{
 render(<BonusPanel deployment={deployment} account='' correctChain={false} onChanged={()=>{}}/>);
 expect(screen.getByRole('button',{name:'自动检测套利路线'})).toBeDisabled();
 expect(screen.getByRole('button',{name:'授权并执行原子套利'})).toBeDisabled();
});
test('compares both venue orders and chooses the larger return',async()=>{
 mock.quote.mockImplementation(async(first:boolean)=>({intermediateAmount:20n*10n**18n,returnedAmount:(first?11n:12n)*10n**18n,profit:(first?1n:2n)*10n**18n}));
 render(<BonusPanel deployment={deployment} wallet={wallet} account={addr(9)} correctChain onChanged={()=>{}}/>);
 fireEvent.click(screen.getByRole('button',{name:'自动检测套利路线'}));
 expect(await screen.findByText(/最佳顺序：DEX 2 → DEX 1/)).toHaveTextContent('预计盈亏 2.0 TKA');
 await waitFor(()=>expect(screen.getByRole('button',{name:'授权并执行原子套利'})).toBeEnabled());
 expect(mock.quote).toHaveBeenCalledTimes(2);
});
test('does not offer execution for losing routes',async()=>{
 mock.quote.mockResolvedValue({intermediateAmount:10n,returnedAmount:9n*10n**18n,profit:0n});
 render(<BonusPanel deployment={deployment} wallet={wallet} account={addr(9)} correctChain onChanged={()=>{}}/>);
 fireEvent.click(screen.getByRole('button',{name:'自动检测套利路线'}));
 expect(await screen.findByText(/当前输入规模没有可盈利路线/)).toBeInTheDocument();
 expect(screen.getByRole('button',{name:'授权并执行原子套利'})).toBeDisabled();
});
test('explains an atomic rollback and never displays a success result',async()=>{
 mock.quote.mockResolvedValue({intermediateAmount:20n*10n**18n,returnedAmount:12n*10n**18n,profit:2n*10n**18n});
 mock.execute.mockRejectedValue(Object.assign(new Error('reverted'),{revert:{name:'InsufficientProfit'}}));
 render(<BonusPanel deployment={deployment} wallet={wallet} account={addr(9)} correctChain onChanged={()=>{}}/>);
 fireEvent.click(screen.getByRole('button',{name:'自动检测套利路线'}));
 await waitFor(()=>expect(screen.getByRole('button',{name:'授权并执行原子套利'})).toBeEnabled());
 fireEvent.click(screen.getByRole('button',{name:'授权并执行原子套利'}));
 expect(await screen.findByRole('alert')).toHaveTextContent('两次兑换和资产转移已整体回滚');
 expect(screen.queryByText('本次钱包套利结果')).not.toBeInTheDocument();
});
