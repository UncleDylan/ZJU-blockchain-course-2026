import {afterEach,beforeEach,expect,test,vi} from 'vitest';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import SimulationPanel from './SimulationPanel';
const address=(index:number)=>`0x${index.toString(16).padStart(40,'0')}`;
const deployment={chainId:31337,miniDEX:address(100),dexAbi:[],tokenAbi:[],tokens:[]};
const fixture=()=>({type:'minidex-simulation',version:1,runId:'test',status:'passed',startedAt:'2026-10-29T00:00:00Z',elapsedSeconds:86,
  chainId:31337,dex:address(100),config:{users:20,rounds:15,intervalMs:250,seed:20261029},completedRounds:15,
  tokens:[{address:address(101),symbol:'TKA',decimals:18},{address:address(102),symbol:'TKB',decimals:18}],
  counters:{randomOperations:300,swap:166,add:106,remove:48,transactions:404,unexpectedFailures:0,skipped:0},
  invariants:{core:336,full:16,passed:true},
  users:Array.from({length:20},(_,index)=>({address:address(index+1),randomOperations:15,warmupAdds:1,actions:{swap:8,add:6,remove:2},gasCostWei:'1000000000000',balanceAWei:'900000000000000000000',balanceBWei:'1000000000000000000000',activeNFTs:4})),
  snapshots:[{round:0,reserveA:'2000',reserveB:'2000',priceBPerA:'1',activeNFTs:20,mintedNFTs:20,redeemedNFTs:0,wallElapsedSeconds:1,chainElapsedSeconds:100},{round:15,reserveA:'1800',reserveB:'1900',priceBPerA:'1.0555',activeNFTs:58,mintedNFTs:106,redeemedNFTs:48,wallElapsedSeconds:86,chainElapsedSeconds:404}],
  latestTransactions:[],
});
beforeEach(()=>{vi.stubGlobal('fetch',vi.fn());});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
test('shows completed results and all 20 user rows without a wallet',async()=>{
  vi.mocked(fetch).mockResolvedValue({ok:true,json:async()=>fixture()} as Response);
  render(<SimulationPanel deployment={deployment}/>);
  expect(await screen.findByText(/模拟通过 · 15 \/ 15 轮/)).toBeInTheDocument();
  expect(screen.getByText('300')).toBeInTheDocument();
  fireEvent.click(screen.getByText('查看 20 个地址明细'));
  expect(screen.getAllByRole('row')).toHaveLength(21);
  expect(screen.getByRole('img',{name:'每轮储备参考价格变化'})).toBeInTheDocument();
});
test('labels an older deployment as historical rather than current results',async()=>{
  const report=fixture();report.dex=address(999);
  vi.mocked(fetch).mockResolvedValue({ok:true,json:async()=>report} as Response);
  render(<SimulationPanel deployment={deployment}/>);
  expect(await screen.findByText(/另一套部署的历史结果/)).toBeInTheDocument();
});
test('does not show a success label when a report contradicts its invariant checks',async()=>{
  const report=fixture();report.invariants.passed=false;
  vi.mocked(fetch).mockResolvedValue({ok:true,json:async()=>report} as Response);
  render(<SimulationPanel deployment={deployment}/>);
  expect(await screen.findByText('模拟记录的通过状态与核对数据不一致。')).toBeInTheDocument();
  expect(screen.queryByText(/模拟通过/)).not.toBeInTheDocument();
});
test('handles absence of simulation artifacts',async()=>{
  vi.mocked(fetch).mockResolvedValue({ok:false,status:404} as Response);
  render(<SimulationPanel deployment={deployment}/>);
  expect(await screen.findByText('暂无模拟记录。')).toBeInTheDocument();
});
