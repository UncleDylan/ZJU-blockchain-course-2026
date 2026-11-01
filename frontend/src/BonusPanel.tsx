import { useEffect, useState } from 'react';
import { BrowserProvider, Contract, formatUnits, parseUnits } from 'ethers';
import { errorMessage, type Deployment, type WalletProvider } from './chain';
import { Badge, Flash, Icon, Loading, SectionHead, compact, useAutoClear } from './ui';

interface PoolView { name: string; address: string; poolId: number; reserveA: bigint | string; reserveB: bigint | string; priceBPerA: string; tokenA?: string }
interface Route { startOnFirst: boolean; firstPoolId: number; secondPoolId: number; tokenIn: string; amountIn: bigint; intermediateAmount: bigint; returnedAmount: bigint; profit: bigint }
interface Execution { transactionHash: string; trader: string; profit: string; gasCostWei: string; walletBefore: string; walletAfter: string; intermediateAmount: string; returnedAmount: string; params: { tokenIn: string; amountIn: string; startOnFirst: boolean }; before: PoolView[]; after: PoolView[]; swapEvents: number }
interface BonusReport { type: string; version: number; status: string; arbitrageAddress: string; marketTrades: number; users: { address: string; dex1Trades: number; dex2Trades: number }[]; tokens: { address: string; symbol: string }[]; execution: Execution; rollback: { transactionHash: string; status: number; reason: string; poolsUnchanged: boolean; tokenBalancesUnchanged: boolean } }
interface Props { deployment: Deployment; wallet?: WalletProvider; account: string; correctChain: boolean; onChanged: () => void }
const tokenAbi = ['function allowance(address,address) view returns(uint256)', 'function approve(address,uint256) returns(bool)', 'function balanceOf(address) view returns(uint256)'];
const amount = (value: bigint | string) => compact(formatUnits(BigInt(value), 18));
const gasText = (value: bigint | string) => {
  const ether = formatUnits(BigInt(value), 18);
  return Number(ether) < 0.000001 ? '< 0.000001' : compact(ether);
};
const shortPrice = (value: string) => Number(value).toLocaleString('zh-CN', { maximumFractionDigits: 8 });

export default function BonusPanel({ deployment, wallet, account, correctChain, onChanged }: Props) {
  const [report, setReport] = useState<BonusReport>();
  const [market, setMarket] = useState<PoolView[]>([]), [refresh, setRefresh] = useState(0), [loading, setLoading] = useState(false);
  const [capital, setCapital] = useState(deployment.tokens[0].address), [size, setSize] = useState('10'), [minProfit, setMinProfit] = useState('0.001');
  const [route, setRoute] = useState<Route>(), [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [error, setError] = useState('');
  useAutoClear(message, setMessage);
  const [localResult, setLocalResult] = useState<Execution>();
  const venues = deployment.exchanges ?? [];
  const ready = !!wallet && !!account && correctChain && venues.length === 2;
  const symbol = (address: string) => deployment.tokens.find(token => token.address.toLowerCase() === address.toLowerCase())?.symbol
    ?? report?.tokens.find(token => token.address.toLowerCase() === address.toLowerCase())?.symbol ?? address;
  const canonicalTokens = [...deployment.tokens].sort((a, b) => BigInt(a.address) < BigInt(b.address) ? -1 : 1);

  useEffect(() => {
    let active = true;
    fetch(`${import.meta.env.BASE_URL}bonus.json`, { cache: 'no-store' }).then(async response => {
      if (!response.ok) return; const data = await response.json();
      if (data.type === 'minidex-bonus' && data.version === 1 && data.status === 'passed' && data.execution && data.rollback && active) setReport(data);
    }).catch(() => {});
    return () => { active = false; };
  }, []);

  useEffect(() => { setRoute(undefined); }, [capital, size, account, correctChain]);

  async function readMarkets(provider: BrowserProvider): Promise<PoolView[]> {
    const options = { blockTag: Number(await provider.send('eth_blockNumber', [])) };
    return Promise.all(venues.map(async venue => {
      const dex = new Contract(venue.address, deployment.dexAbi, provider);
      const id = await dex.getPoolId(deployment.tokens[0].address, deployment.tokens[1].address, options);
      if (id === 0n) throw Error('请先在两个交易所创建测试代币对并添加流动性。');
      const pool = await dex.getPool(id, options);
      return {
        name: venue.name, address: venue.address, poolId: Number(id), tokenA: pool.tokenA, reserveA: pool.reserveA, reserveB: pool.reserveB,
        priceBPerA: pool.reserveA === 0n ? '0' : formatUnits(pool.reserveB * 10n ** 18n / pool.reserveA, 18),
      };
    }));
  }

  useEffect(() => {
    setMarket([]); if (!ready || !wallet) return; let active = true;
    const provider = new BrowserProvider(wallet); setLoading(true);
    readMarkets(provider).then(rows => { if (active) setMarket(rows); }).catch(reason => { if (active) setError(errorMessage(reason)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; provider.destroy(); };
  }, [deployment, wallet, ready, refresh]);

  async function detect() {
    if (!ready || !wallet || busy) return; setBusy(true); setError(''); setMessage(''); setRoute(undefined);
    const provider = new BrowserProvider(wallet);
    try {
      const value = parseUnits(size, 18); if (value <= 0n) throw Error('套利资金必须大于零。');
      const rows = await readMarkets(provider); setMarket(rows);
      const arb = new Contract(deployment.arbitrage!, deployment.arbitrageAbi!, provider);
      const blockTag = Number(await provider.send('eth_blockNumber', []));
      const choices = await Promise.all([true, false].map(async startOnFirst => {
        const firstPoolId = rows[startOnFirst ? 0 : 1].poolId, secondPoolId = rows[startOnFirst ? 1 : 0].poolId;
        const quote = await arb.quote(startOnFirst, firstPoolId, secondPoolId, capital, value, { blockTag });
        return { startOnFirst, firstPoolId, secondPoolId, tokenIn: capital, amountIn: value, intermediateAmount: quote.intermediateAmount, returnedAmount: quote.returnedAmount, profit: quote.profit } as Route;
      }));
      choices.sort((a, b) => a.returnedAmount > b.returnedAmount ? -1 : a.returnedAmount < b.returnedAmount ? 1 : 0); setRoute(choices[0]);
    } catch (reason) { setError(errorMessage(reason)); } finally { provider.destroy(); setBusy(false); }
  }

  async function execute() {
    if (!route || !wallet || !ready || busy) return;
    setBusy(true); setError(''); setMessage(''); const provider = new BrowserProvider(wallet);
    try {
      const profitFloor = parseUnits(minProfit, 18);
      if (profitFloor <= 0n || profitFloor > route.profit) throw Error('最低利润必须大于零且不超过本次预计利润。');
      if ((await provider.getNetwork()).chainId !== BigInt(deployment.chainId)) throw Error('请先切换回部署网络。');
      const signer = await provider.getSigner(account), token = new Contract(route.tokenIn, tokenAbi, signer), arb = new Contract(deployment.arbitrage!, deployment.arbitrageAbi!, signer);
      const allowance: bigint = await token.allowance(account, deployment.arbitrage);
      if (allowance < route.amountIn) {
        if (allowance > 0n) { setMessage('正在重置套利资金授权。'); await (await token.approve(deployment.arbitrage, 0)).wait(); }
        setMessage('请在钱包授权本次套利资金。'); await (await token.approve(deployment.arbitrage, route.amountIn)).wait();
      }
      const before = await readMarkets(provider), walletBefore: bigint = await token.balanceOf(account);
      const block = await provider.getBlock('latest'); if (!block) throw Error('无法读取区块。');
      const params = { ...route, minIntermediate: route.intermediateAmount * 995n / 1000n || 1n, minProfit: profitFloor, deadline: block.timestamp + 600 };
      const tx = await arb.execute(params); setMessage(`原子套利交易已提交：${tx.hash}`); const receipt = await tx.wait();
      const event = receipt.logs.filter((log: { address: string }) => log.address.toLowerCase() === deployment.arbitrage!.toLowerCase())
        .map((log: { topics: string[]; data: string }) => arb.interface.parseLog(log))
        .find((log: { name: string } | null) => log?.name === 'ArbitrageExecuted');
      if (!event) throw Error('交易已确认，但无法解析套利事件，请核对回执。');
      const after = await readMarkets(provider), walletAfter: bigint = await token.balanceOf(account);
      setLocalResult({
        transactionHash: tx.hash, trader: account, profit: event.args.profit.toString(),
        gasCostWei: (receipt.gasUsed * receipt.gasPrice).toString(), walletBefore: walletBefore.toString(), walletAfter: walletAfter.toString(),
        intermediateAmount: event.args.intermediateAmount.toString(), returnedAmount: event.args.returnedAmount.toString(),
        params: { tokenIn: route.tokenIn, amountIn: route.amountIn.toString(), startOnFirst: route.startOnFirst }, before, after, swapEvents: 2,
      });
      setMarket(after); setRoute(undefined); setMessage('原子套利成功：两次兑换已在一笔交易内完成。'); onChanged();
    } catch (reason) { setMessage(''); setError(errorMessage(reason)); } finally { provider.destroy(); setBusy(false); }
  }

  const spread = market.length === 2 && Number(market[0].priceBPerA) > 0 && Number(market[1].priceBPerA) > 0
    ? (Number(market[1].priceBPerA) / Number(market[0].priceBPerA) - 1) * 100
    : undefined;

  function pools(rows: PoolView[], label: string, labels: { symbol: string }[] = canonicalTokens) {
    return <div className="venue-grid" aria-label={label}>{rows.map(pool => <article className="venue-card" key={pool.address}>
      <div className="venue-card__head">
        <h4>{pool.name}</h4>
        <Badge tone="neutral">池 #{pool.poolId}</Badge>
      </div>
      <div className="venue-card__metrics">
        <div><span className="micro">{labels[0].symbol} 储备</span><strong className="mono">{amount(pool.reserveA)}</strong></div>
        <div><span className="micro">{labels[1].symbol} 储备</span><strong className="mono">{amount(pool.reserveB)}</strong></div>
      </div>
      <p className="venue-card__price">参考价 <strong className="mono">{shortPrice(pool.priceBPerA)}</strong> {labels[1].symbol}/{labels[0].symbol}</p>
      <code className="addr">{pool.address}</code>
    </article>)}</div>;
  }

  function result(value: Execution, heading: string, labels: { symbol: string }[] = canonicalTokens) {
    return <section className="result-card" aria-label={heading}>
      <SectionHead title={heading} hint="同一笔交易内完成两次兑换，任一环节失败则整笔回滚。" />
      <div className="stats">
        <div className="stat"><span className="stat__label">实际利润</span><span className="stat__value">{amount(value.profit)}<small>{symbol(value.params.tokenIn)}</small></span></div>
        <div className="stat"><span className="stat__label">本次投入</span><span className="stat__value">{amount(value.params.amountIn)}<small>{symbol(value.params.tokenIn)}</small></span></div>
        <div className="stat"><span className="stat__label">中间代币</span><span className="stat__value">{amount(value.intermediateAmount)}</span></div>
        <div className="stat"><span className="stat__label">返回数量</span><span className="stat__value">{amount(value.returnedAmount)}</span></div>
        <div className="stat"><span className="stat__label">Gas 消耗</span><span className="stat__value">{gasText(value.gasCostWei)}<small>ETH</small></span></div>
      </div>
      <div className="route-path">
        <span className="route-node">投入 {amount(value.params.amountIn)} {symbol(value.params.tokenIn)}</span>
        <span className="route-arrow"><Icon name="chevron" size={14} /></span>
        <span className="route-node route-node--accent">{value.params.startOnFirst ? 'DEX 1' : 'DEX 2'}</span>
        <span className="route-arrow"><Icon name="swap" size={14} /></span>
        <span className="route-node route-node--accent">{value.params.startOnFirst ? 'DEX 2' : 'DEX 1'}</span>
        <span className="route-arrow"><Icon name="chevron" size={14} /></span>
        <span className="route-node route-node--ok">返回 {amount(value.returnedAmount)} {symbol(value.params.tokenIn)}</span>
      </div>
      <p>套利者本币余额：{amount(value.walletBefore)} → {amount(value.walletAfter)}；Gas {gasText(value.gasCostWei)} ETH。</p>
      <p className="mono break">交易：{value.transactionHash}</p>
      <p className="micro">套利前</p>{pools(value.before, `${heading}套利前`, labels)}
      <p className="micro">套利后</p>{pools(value.after, `${heading}套利后`, labels)}
    </section>;
  }

  return <section className="panel" aria-labelledby="bonus-title">
    <SectionHead id="bonus-title" title="Bonus · 双交易所原子套利" hint="使用自有测试币，自动比较两个交易顺序；两次兑换均含 0.3% 手续费，利润不足时整笔回滚。利润以输入币计算，未扣除 ETH Gas。"
      actions={<button type="button" className="btn btn--ghost btn--sm" disabled={!ready || busy || loading}
        onClick={() => { setRoute(undefined); setError(''); setRefresh(value => value + 1); }}><Icon name="refresh" size={15} />刷新两所价格</button>} />

    {loading && <Loading>正在读取两所储备…</Loading>}
    {spread !== undefined && <div className="spread-card">
      <Icon name="spark" size={18} />
      <div><span className="micro">当前两所参考价价差</span>
        <strong className={`spread-card__value ${spread >= 0 ? 'is-up' : 'is-down'}`}>{spread >= 0 ? '+' : ''}{spread.toFixed(2)}%</strong></div>
      <p className="micro">检测后会自动选出去程 / 回程的最佳顺序，并在一次交易内完成。</p>
    </div>}
    {market.length > 0 && pools(market, '当前两所储备')}

    <div className="subcard">
      <h3><Icon name="bolt" size={16} />套利参数</h3>
      <div className="form-grid">
        <label className="field"><span>套利本币</span>
          <select value={capital} onChange={event => setCapital(event.target.value)} disabled={busy}>
            {deployment.tokens.map(token => <option value={token.address} key={token.address}>{token.symbol}</option>)}
          </select></label>
        <label className="field"><span>套利投入数量</span>
          <input inputMode="decimal" value={size} onChange={event => setSize(event.target.value)} disabled={busy} /></label>
        <label className="field"><span>最低利润（输入币）</span>
          <input inputMode="decimal" value={minProfit} onChange={event => setMinProfit(event.target.value)} disabled={busy} /></label>
      </div>
      <div className="btn-row">
        <button type="button" className="btn btn--ghost" disabled={!ready || busy || !size} onClick={detect}>
          {busy ? '正在检测…' : '自动检测套利路线'}</button>
        <button type="button" className="btn btn--primary" disabled={!ready || busy || !route || route.profit === 0n} onClick={execute}>授权并执行原子套利</button>
      </div>
      {!ready && <p className="micro">连接钱包并切换到部署网络后可检测并执行；历史演示结果可直接查看。</p>}
    </div>

    {route && <div className={route.profit > 0n ? 'route-card' : 'route-card route-card--empty'}>
      <div className="route-card__head">
        <Badge tone={route.profit > 0n ? 'ok' : 'warn'} dot>{route.profit > 0n ? '可执行路线' : '无盈利路线'}</Badge>
        <span className="micro mono">{route.profit > 0n ? `利润 ${amount(route.profit)} ${symbol(route.tokenIn)}` : '换一个投入规模再试'}</span>
      </div>
      <p className="route-card__sentence">{`最佳顺序：${route.startOnFirst ? 'DEX 1 → DEX 2' : 'DEX 2 → DEX 1'}；预计返回 ${amount(route.returnedAmount)} ${symbol(route.tokenIn)}；预计盈亏 ${amount(route.returnedAmount - route.amountIn)} ${symbol(route.tokenIn)}。`}</p>
      {route.profit === 0n && <p className="hint">当前输入规模没有可盈利路线，可在两所交易后重新检测。</p>}
    </div>}

    {message && <Flash tone="ok">{message}</Flash>}
    {error && <Flash tone="bad">{error}</Flash>}

    {localResult && result(localResult, '本次钱包套利结果')}

    {report && <div className="history">
      <SectionHead title="自动模拟与套利演示记录" hint={`${report.users.length} 个地址，共 ${report.marketTrades} 次跨所随机交易。`} />
      {report.arbitrageAddress.toLowerCase() !== deployment.arbitrage?.toLowerCase() && <p className="hint">这是另一套部署的历史演示结果。</p>}
      {result(report.execution, '脚本自动套利结果', report.tokens)}
      <div className="callout callout--ok">
        <Icon name="shield" size={18} />
        <div className="callout__body">
          <strong>失败回滚验证</strong>
          <p>回执状态 {report.rollback.status}，原因 {report.rollback.reason}；两池储备及用户代币余额均未改变，失败交易仍消耗 Gas。</p>
          <p className="mono break">失败交易：{report.rollback.transactionHash}</p>
        </div>
      </div>
    </div>}
  </section>;
}
