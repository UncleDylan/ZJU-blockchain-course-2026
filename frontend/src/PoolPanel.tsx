import { useEffect, useRef, useState } from 'react';
import { BrowserProvider, Contract, formatUnits, isAddress, ZeroAddress } from 'ethers';
import { errorMessage, type Deployment, type WalletProvider } from './chain';
import { Badge, Empty, Flash, Icon, Loading, SectionHead, compact, useAutoClear } from './ui';
import LiquidityPanel from './LiquidityPanel';

interface Pool { tokenA: string; tokenB: string; reserveA: bigint; reserveB: bigint; createdTimestamp: bigint; creator: string }
interface Meta { symbol: string; decimals: number }
interface Props { deployment: Deployment; wallet?: WalletProvider; account: string; correctChain: boolean; onChanged: () => void }
const PAGE_SIZE = 10;
const metadataAbi = ['function decimals() view returns(uint8)', 'function symbol() view returns(string)'];

export default function PoolPanel({ deployment, wallet, account, correctChain, onChanged }: Props) {
  const [selectedPoolId, setSelectedPoolId] = useState<number>();
  const [tokenA, setTokenA] = useState(deployment.tokens[0].address);
  const [tokenB, setTokenB] = useState(deployment.tokens[1].address);
  const [pools, setPools] = useState<Pool[]>([]);
  const [meta, setMeta] = useState<Map<string, Meta>>(new Map());
  const [count, setCount] = useState(0);
  const [offset, setOffset] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  useAutoClear(message, setMessage);
  const detailRef = useRef<HTMLDivElement>(null);
  const ready = !!wallet && !!account && correctChain;

  useEffect(() => {
    setPools([]); setCount(0); setLoading(false); setError('');
    if (!ready || !wallet) return;
    let active = true;
    const provider = new BrowserProvider(wallet);
    setLoading(true);
    (async () => {
      if (await provider.getCode(deployment.miniDEX) === '0x') throw new Error('交易所尚未部署，请重新部署并刷新页面。');
      const dex = new Contract(deployment.miniDEX, deployment.dexAbi, provider);
      const [total, rows]: [bigint, Pool[]] = await Promise.all([dex.poolCount(), dex.getPools(offset, PAGE_SIZE)]);
      const addresses = [...new Set(rows.flatMap((pool) => [pool.tokenA, pool.tokenB]))];
      const loaded = await Promise.all(addresses.map(async (address) => {
        const token = new Contract(address, metadataAbi, provider);
        const [symbol, decimals] = await Promise.all([token.symbol(), token.decimals()]);
        return [address.toLowerCase(), { symbol: symbol as string, decimals: Number(decimals) }] as const;
      }));
      if (active) { setCount(Number(total)); setPools(rows); setMeta(new Map(loaded)); }
    })().catch(reason => { if (active) setError(errorMessage(reason)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; provider.destroy(); };
  }, [deployment, wallet, ready, account, offset, refresh]);

  useEffect(() => {
    if (selectedPoolId === undefined || !detailRef.current) return;
    const node = detailRef.current;
    if (typeof node.scrollIntoView === 'function') node.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [selectedPoolId]);

  async function createPool(event: React.FormEvent) {
    event.preventDefault(); setError(''); setMessage('');
    if (!ready || !wallet || pending) return;
    if (!isAddress(tokenA) || !isAddress(tokenB) || tokenA.toLowerCase() === ZeroAddress || tokenB.toLowerCase() === ZeroAddress) {
      setError('请输入两个有效的非零 ERC20 合约地址。'); return;
    }
    if (tokenA.toLowerCase() === tokenB.toLowerCase()) { setError('请选择两种不同的代币。'); return; }
    const provider = new BrowserProvider(wallet);
    setPending(true);
    try {
      if ((await provider.getNetwork()).chainId !== BigInt(deployment.chainId)) throw new Error('钱包网络已改变，请切换回部署网络。');
      const dex = new Contract(deployment.miniDEX, deployment.dexAbi, await provider.getSigner(account));
      const existing = await dex.getPoolId(tokenA, tokenB);
      if (existing !== 0n) throw new Error(`该代币对的交易池已存在，编号为 ${existing}。`);
      const tx = await dex.createPool(tokenA, tokenB);
      setMessage(`创建交易已提交，等待确认：${tx.hash}`);
      await tx.wait();
      setMessage(`交易池创建成功。交易：${tx.hash}`);
      setOffset(0); setRefresh(value => value + 1);
    } catch (reason) {
      setMessage('');
      if ((reason as { revert?: { name?: string } })?.revert?.name === 'UnsupportedToken') setError('地址不是可用的 ERC20 合约。');
      else setError(errorMessage(reason));
    } finally { provider.destroy(); setPending(false); }
  }

  const info = (address: string): Meta => meta.get(address.toLowerCase())
    ?? (() => {
      const known = deployment.tokens.find(token => token.address.toLowerCase() === address.toLowerCase());
      return { symbol: known?.symbol ?? address, decimals: 18 };
    })();

  const label = (address: string) => deployment.tokens.find(token => token.address.toLowerCase() === address.toLowerCase())?.symbol ?? address;

  return <section className="panel" aria-labelledby="pools-title">
    <SectionHead id="pools-title" title="AMM 交易池" hint="创建空池后注入流动性获得 NFT，随后在管理面板兑换或销毁赎回。"
      actions={<button type="button" className="btn btn--ghost btn--sm" disabled={!ready || pending || loading}
        onClick={() => setRefresh(value => value + 1)}><Icon name="refresh" size={15} />刷新池子</button>} />

    <form className="create-pool" onSubmit={createPool}>
      <div className="form-grid form-grid--2">
        <label className="field"><span>代币 A 合约地址</span>
          <input className="mono" value={tokenA} onChange={event => setTokenA(event.target.value.trim())} disabled={pending} spellCheck={false} /></label>
        <label className="field"><span>代币 B 合约地址</span>
          <input className="mono" value={tokenB} onChange={event => setTokenB(event.target.value.trim())} disabled={pending} spellCheck={false} /></label>
      </div>
      <div className="create-pool__foot">
        <p className="micro">首次建池后需注入流动性才会产生价格。</p>
        <button type="submit" className="btn btn--primary" disabled={!ready || pending}>{pending ? '等待创建确认…' : '创建交易池'}</button>
      </div>
    </form>

    {!ready && <p className="hint">连接钱包并切换到部署网络后，可创建和查看交易池。</p>}
    {error && <Flash tone="bad">{error}</Flash>}
    {message && <Flash tone="ok">{message}</Flash>}
    {loading && <Loading>正在读取交易池…</Loading>}

    {ready && !loading && !error && <p className="hint">
      {count === 0 ? '共 0 个交易池，尚未创建交易池。' : `共 ${count} 个交易池，当前显示 ${offset + 1}–${offset + pools.length}。`}
    </p>}

    <div className="pool-list">{pools.map((pool, index) => {
      const id = offset + index + 1;
      const a = info(pool.tokenA), b = info(pool.tokenB);
      const empty = pool.reserveA === 0n || pool.reserveB === 0n;
      const reserveA = Number(formatUnits(pool.reserveA, a.decimals));
      const reserveB = Number(formatUnits(pool.reserveB, b.decimals));
      const price = !empty ? (reserveB / reserveA) : 0;
      return <article className="pool-card" key={id} aria-label={`交易池 #${id}`}>
        <div className="pool-card__head">
          <div className="pool-pair">
            <span className="pair-avatars" aria-hidden="true">
              <span className="token-avatar token-avatar--sm">{a.symbol.slice(-1)}</span>
              <span className="token-avatar token-avatar--sm token-avatar--b">{b.symbol.slice(-1)}</span>
            </span>
            <div><h3>{label(pool.tokenA)} / {label(pool.tokenB)}</h3><p className="micro mono">POOL #{id}</p></div>
          </div>
          <Badge tone={empty ? 'warn' : 'ok'} dot>{empty ? '待注入' : '活跃'}</Badge>
        </div>

        <div className="pool-metrics">
          <div className="pool-metric"><span className="micro">储备 {a.symbol}</span><strong className="mono">{compact(formatUnits(pool.reserveA, a.decimals))}</strong></div>
          <div className="pool-metric"><span className="micro">储备 {b.symbol}</span><strong className="mono">{compact(formatUnits(pool.reserveB, b.decimals))}</strong></div>
          <div className="pool-metric"><span className="micro">参考价</span><strong className="mono">{empty ? '—' : `1 ${a.symbol} ≈ ${price.toFixed(4)} ${b.symbol}`}</strong></div>
        </div>

        <div className="ratio" aria-hidden="true">
          {empty ? <i className="ratio__empty" /> : <>
            <i className="ratio__a" style={{ flexGrow: Math.max(reserveA, 1e-9) }} />
            <i className="ratio__b" style={{ flexGrow: Math.max(reserveB, 1e-9) }} />
          </>}
        </div>

        <dl className="pool-meta">
          <div><dt>创建者</dt><dd className="mono">{pool.creator}</dd></div>
          <div><dt>创建时间</dt><dd>{new Date(Number(pool.createdTimestamp) * 1000).toLocaleString()}</dd></div>
        </dl>

        <button type="button" className="btn btn--block" disabled={pending}
          onClick={() => setSelectedPoolId(id)}>{selectedPoolId === id ? '正在管理' : `管理池 #${id} 流动性`}</button>
      </article>;
    })}</div>

    {count > PAGE_SIZE && <div className="pager">
      <button type="button" className="btn btn--ghost btn--sm" disabled={offset === 0 || loading || pending}
        onClick={() => setOffset(value => Math.max(0, value - PAGE_SIZE))}>上一页</button>
      <span className="micro mono">{Math.floor(offset / PAGE_SIZE) + 1} / {Math.ceil(count / PAGE_SIZE)}</span>
      <button type="button" className="btn btn--ghost btn--sm" disabled={offset + PAGE_SIZE >= count || loading || pending}
        onClick={() => setOffset(value => value + PAGE_SIZE)}>下一页</button>
    </div>}

    <div className="mechanics" aria-label="交易池机制">
      <div><span className="micro">定价模型</span><strong>x · y = k</strong></div>
      <div><span className="micro">交易手续费</span><strong>0.3% 留池</strong></div>
      <div><span className="micro">流动性凭证</span><strong>ERC721 份额</strong></div>
    </div>

    {ready && wallet && selectedPoolId !== undefined && <div ref={detailRef} className="liquidity-detail">
      <LiquidityPanel key={`${selectedPoolId}-${account}`} deployment={deployment} wallet={wallet} account={account} poolId={selectedPoolId}
        onChanged={() => { setRefresh(v => v + 1); onChanged(); }} />
    </div>}
    {!ready && pools.length === 0 && !loading && !error && <Empty>连接钱包后即可查看交易池列表。</Empty>}
  </section>;
}
