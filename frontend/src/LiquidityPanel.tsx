import { useEffect, useState } from 'react';
import { BrowserProvider, Contract, formatUnits, parseUnits, ZeroAddress } from 'ethers';
import { errorMessage, type Deployment, type WalletProvider } from './chain';
import { Badge, Empty, Flash, Icon, Loading, SectionHead, Stat, compact, short, useAutoClear } from './ui';

interface Props { deployment: Deployment; wallet: WalletProvider; account: string; poolId: number; onChanged: () => void }
interface Position { id: bigint; poolId: bigint; shares: bigint; amountA: bigint; amountB: bigint; createdTimestamp: bigint; provider: string; owner: string; redeemedTimestamp: bigint; redeemedBy: string }
interface PoolData { tokenA: string; tokenB: string; reserveA: bigint; reserveB: bigint; shares: bigint; decimalsA: number; decimalsB: number; symbolA: string; symbolB: string }
interface Quote { amountA: bigint; amountB: bigint; shares: bigint }
const metadataAbi = ['function decimals() view returns(uint8)', 'function symbol() view returns(string)', 'function allowance(address,address) view returns(uint256)', 'function approve(address,uint256) returns(bool)'];

export default function LiquidityPanel({ deployment, wallet, account, poolId, onChanged }: Props) {
  const [data, setData] = useState<PoolData>();
  const [swapAmount, setSwapAmount] = useState('');
  const [direction, setDirection] = useState('A');
  const [swapQuote, setSwapQuote] = useState<{ amountOut: bigint; feeAmount: bigint }>();
  const [removeQuote, setRemoveQuote] = useState<{ tokenId: bigint; amountA: bigint; amountB: bigint }>();
  useEffect(() => { setSwapQuote(undefined); setRemoveQuote(undefined); }, [swapAmount, direction, account, poolId]);
  const [mine, setMine] = useState<Position[]>([]), [sources, setSources] = useState<Position[]>([]);
  const [ownerOffset, setOwnerOffset] = useState(0), [sourceOffset, setSourceOffset] = useState(0);
  const [amountA, setAmountA] = useState(''), [amountB, setAmountB] = useState('');
  const [quote, setQuote] = useState<Quote>();
  const [refresh, setRefresh] = useState(0), [busy, setBusy] = useState(false), [loading, setLoading] = useState(false);
  const [message, setMessage] = useState(''), [error, setError] = useState('');
  useAutoClear(message, setMessage);
  useEffect(() => { setQuote(undefined); }, [amountA, amountB, poolId, account]);
  useEffect(() => { setMessage(''); setOwnerOffset(0); setSourceOffset(0); }, [account, poolId]);
  useEffect(() => {
    let active = true;
    const provider = new BrowserProvider(wallet);
    setLoading(true); setData(undefined); setMine([]); setSources([]); setError('');
    (async () => {
      const dex = new Contract(deployment.miniDEX, deployment.dexAbi, provider);
      // Keep ownership, burn history and reserves from one block consistent.
      const options = { blockTag: await provider.getBlockNumber() };
      const pool = await dex.getPool(poolId, options);
      const a = new Contract(pool.tokenA, metadataAbi, provider), b = new Contract(pool.tokenB, metadataAbi, provider);
      const [decimalsA, decimalsB, symbolA, symbolB, shares, ownIds, sourceIds] = await Promise.all([
        a.decimals(options), b.decimals(options), a.symbol(options), b.symbol(options), dex.totalShares(poolId, options),
        dex.getOwnerPositionIds(account, ownerOffset, 10, options), dex.getPoolPositionIds(poolId, sourceOffset, 10, options),
      ]);
      const load = async (ids: bigint[]) => Promise.all(ids.map(async id => {
        const [p, redeemedTimestamp, redeemedBy] = await Promise.all([dex.positions(id, options), dex.redeemedAt(id, options), dex.redeemedBy(id, options)]);
        const owner = redeemedTimestamp === 0n ? await dex.ownerOf(id, options) : ZeroAddress;
        return { id, poolId: p.poolId, shares: p.shares, amountA: p.amountA, amountB: p.amountB, createdTimestamp: p.createdTimestamp, provider: p.provider, owner, redeemedTimestamp, redeemedBy };
      }));
      const [own, all] = await Promise.all([load(ownIds), load(sourceIds)]);
      if (active) {
        setData({ tokenA: pool.tokenA, tokenB: pool.tokenB, reserveA: pool.reserveA, reserveB: pool.reserveB, shares, decimalsA: Number(decimalsA), decimalsB: Number(decimalsB), symbolA, symbolB });
        setMine(own); setSources(all);
      }
    })().catch(reason => { if (active) setError(errorMessage(reason)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; provider.destroy(); };
  }, [deployment, wallet, account, poolId, refresh, ownerOffset, sourceOffset]);

  async function deposit(submit: boolean) {
    if (!data || busy) return;
    setBusy(true); setError(''); setMessage('');
    const provider = new BrowserProvider(wallet);
    try {
      if ((await provider.getNetwork()).chainId !== BigInt(deployment.chainId)) throw Error('请先切换回部署网络。');
      const desiredA = parseUnits(amountA, data.decimalsA), desiredB = parseUnits(amountB, data.decimalsB);
      if (desiredA <= 0n || desiredB <= 0n) throw Error('请输入大于零的投入数量。');
      const signer = await provider.getSigner(account);
      const dex = new Contract(deployment.miniDEX, deployment.dexAbi, signer);
      const result = await dex.previewAddLiquidity(poolId, desiredA, desiredB);
      const preview = { amountA: result.amountA, amountB: result.amountB, shares: result.shares };
      setQuote(preview);
      if (!submit) return;
      // Only approve the requested maximum, never an unlimited allowance.
      for (const [address, amount, label] of [[data.tokenA, desiredA, data.symbolA], [data.tokenB, desiredB, data.symbolB]] as const) {
        const token = new Contract(address, metadataAbi, signer);
        const allowance: bigint = await token.allowance(account, deployment.miniDEX);
        if (allowance < amount) {
          if (allowance > 0n) { setMessage(`正在重置 ${label} 授权，请在钱包确认。`); await (await token.approve(deployment.miniDEX, 0)).wait(); }
          setMessage(`正在授权 ${label} 的本次最大投入，请在钱包确认。`);
          await (await token.approve(deployment.miniDEX, amount)).wait();
        }
      }
      const block = await provider.getBlock('latest');
      if (!block) throw Error('无法读取最新区块。');
      const minimum = (value: bigint) => { const min = value * 995n / 1000n; return min > 0n ? min : 1n; };
      const tx = await dex.addLiquidity(poolId, desiredA, desiredB, minimum(preview.amountA), minimum(preview.amountB), minimum(preview.shares), block.timestamp + 600);
      setMessage(`添加交易已提交，等待确认：${tx.hash}`);
      await tx.wait();
      setMessage(`添加流动性成功，已获得 ERC721 NFT。交易：${tx.hash}`);
      setQuote(undefined); setSwapQuote(undefined); setRemoveQuote(undefined); setOwnerOffset(0); setSourceOffset(0); setRefresh(value => value + 1); onChanged();
    } catch (reason) { setMessage(''); setError(errorMessage(reason)); }
    finally { provider.destroy(); setBusy(false); }
  }
  const minimum = (value: bigint) => { const min = value * 995n / 1000n; return min > 0n ? min : 1n; };

  async function trade(submit: boolean) {
    if (!data || busy) return;
    const provider = new BrowserProvider(wallet);
    setBusy(true); setError(''); setMessage('');
    try {
      if ((await provider.getNetwork()).chainId !== BigInt(deployment.chainId)) throw Error('请先切换回部署网络。');
      const input = parseUnits(swapAmount, direction === 'A' ? data.decimalsA : data.decimalsB);
      if (input <= 0n) throw Error('请输入大于零的兑换数量。');
      const signer = await provider.getSigner(account), dex = new Contract(deployment.miniDEX, deployment.dexAbi, signer);
      const address = direction === 'A' ? data.tokenA : data.tokenB;
      const result = submit && swapQuote ? swapQuote : await dex.quoteSwap(poolId, address, input);
      const current = { amountOut: result.amountOut, feeAmount: result.feeAmount }; setSwapQuote(current);
      if (!submit) return;
      const token = new Contract(address, metadataAbi, signer), allowance: bigint = await token.allowance(account, deployment.miniDEX);
      if (allowance < input) {
        if (allowance > 0n) { setMessage('请在钱包确认重置兑换授权。'); await (await token.approve(deployment.miniDEX, 0)).wait(); }
        setMessage('请在钱包确认本次兑换数量的授权。'); await (await token.approve(deployment.miniDEX, input)).wait();
      }
      const block = await provider.getBlock('latest'); if (!block) throw Error('无法读取区块。');
      const tx = await dex.swap(poolId, address, input, minimum(current.amountOut), block.timestamp + 600);
      setMessage(`兑换交易已提交，等待确认：${tx.hash}`); await tx.wait();
      setMessage(`兑换成功。交易：${tx.hash}`); setSwapQuote(undefined); setQuote(undefined); setRemoveQuote(undefined); setRefresh(v => v + 1); onChanged();
    } catch (reason) { setMessage(''); setError(errorMessage(reason)); }
    finally { provider.destroy(); setBusy(false); }
  }

  async function redeem(tokenId: bigint, submit: boolean) {
    if (!data || busy) return;
    const provider = new BrowserProvider(wallet);
    setBusy(true); setError(''); setMessage('');
    try {
      if ((await provider.getNetwork()).chainId !== BigInt(deployment.chainId)) throw Error('请先切换回部署网络。');
      const dex = new Contract(deployment.miniDEX, deployment.dexAbi, await provider.getSigner(account));
      const current = submit && removeQuote?.tokenId === tokenId ? removeQuote : await dex.previewRemoveLiquidity(tokenId);
      setRemoveQuote({ tokenId, amountA: current.amountA, amountB: current.amountB }); if (!submit) return;
      const block = await provider.getBlock('latest'); if (!block) throw Error('无法读取区块。');
      const tx = await dex.removeLiquidity(tokenId, minimum(current.amountA), minimum(current.amountB), block.timestamp + 600);
      setMessage(`赎回交易已提交，等待确认：${tx.hash}`); await tx.wait();
      setMessage(`赎回成功，NFT #${tokenId} 已销毁，资产已返还当前持有人。交易：${tx.hash}`);
      setRemoveQuote(undefined); setSwapQuote(undefined); setQuote(undefined); setOwnerOffset(0); setRefresh(v => v + 1); onChanged();
    } catch (reason) { setMessage(''); setError(errorMessage(reason)); }
    finally { provider.destroy(); setBusy(false); }
  }

  const owned = (p: Position) => p.redeemedTimestamp === 0n && p.owner.toLowerCase() === account.toLowerCase();
  const invested = (p: Position) => {
    if (!data || p.poolId !== BigInt(poolId)) return `${compact(p.amountA.toString())} / ${compact(p.amountB.toString())}`;
    return `${compact(formatUnits(p.amountA, data.decimalsA))} ${data.symbolA} / ${compact(formatUnits(p.amountB, data.decimalsB))} ${data.symbolB}`;
  };
  const positionList = (rows: Position[], empty: string) => rows.length === 0
    ? <Empty>{empty}</Empty>
    : <div className="positions">{rows.map(p => <article className="position" key={p.id.toString()} aria-label={`NFT #${p.id}`}>
      <div className="position__head">
        <h4>NFT #{p.id.toString()} <span className="dim">· 池 #{p.poolId.toString()}</span></h4>
        <div className="position__aside">
          {owned(p) && p.poolId === BigInt(poolId) && <button type="button" className="btn btn--ghost btn--sm" disabled={busy || loading}
            onClick={() => redeem(p.id, false)}><Icon name="refresh" size={14} />预览赎回 NFT #{p.id.toString()}</button>}
          <Badge tone={p.redeemedTimestamp === 0n ? 'ok' : 'neutral'} dot>{p.redeemedTimestamp === 0n ? '持有中' : '已销毁'}</Badge>
        </div>
      </div>
      <div className="position__rows">
        <div className="position-row"><span className="position-row__label">份额</span>
          <span className="mono" title={`${p.shares.toString()}（最小单位）`}>{compact(p.shares.toString())}</span></div>
        <div className="position-row"><span className="position-row__label">最初投入</span><span className="mono">{invested(p)}</span></div>
        <div className="position-row"><span className="position-row__label">原始提供者</span><span className="mono" title={p.provider}>{short(p.provider)}</span></div>
        <div className="position-row"><span className="position-row__label">当前持有人：</span>
          <span className="mono" title={p.redeemedTimestamp === 0n ? p.owner : '已销毁'}>{p.redeemedTimestamp === 0n ? short(p.owner) : '已销毁'}</span></div>
      </div>
      <p className="position__meta">创建于 {new Date(Number(p.createdTimestamp) * 1000).toLocaleString()}
        {p.redeemedTimestamp > 0n && ` · 已赎回 ${new Date(Number(p.redeemedTimestamp) * 1000).toLocaleString()}（${short(p.redeemedBy)}）`}</p>
      {owned(p) && p.poolId !== BigInt(poolId) && <p className="micro">切换到池 #{p.poolId.toString()} 可赎回该 NFT。</p>}
    </article>)}</div>;

  const price = data && data.reserveA > 0n && data.reserveB > 0n
    ? compact(formatUnits(data.reserveB * 10n ** BigInt(data.decimalsA) * 10n ** 18n / (data.reserveA * 10n ** BigInt(data.decimalsB)), 18))
    : '暂无流动性';

  return <section className="panel panel--detail" aria-labelledby="liquidity-title">
    <SectionHead id="liquidity-title" title={`池 #${poolId} · 流动性与 NFT`} hint="存入资产取得 ERC721 份额凭证，赎回时销毁 NFT 并返还资产与手续费权益。"
      actions={<button type="button" className="btn btn--ghost btn--sm" disabled={busy || loading}
        onClick={() => { setQuote(undefined); setSwapQuote(undefined); setRemoveQuote(undefined); setRefresh(v => v + 1); }}>
        <Icon name="refresh" size={15} />刷新流动性与 NFT</button>} />
    {loading && <Loading>正在读取流动性…</Loading>}
    {data && <>
      <div className="stats">
        <Stat label={`储备 ${data.symbolA}`} value={compact(formatUnits(data.reserveA, data.decimalsA))} />
        <Stat label={`储备 ${data.symbolB}`} value={compact(formatUnits(data.reserveB, data.decimalsB))} />
        <div className="stat"><span className="stat__label">总份额（最小单位）</span>
          <span className="stat__value stat__value--num">{data.shares.toString()}</span></div>
        <Stat label="储备比参考价" value={price} unit={data.reserveA > 0n && data.reserveB > 0n ? `${data.symbolB} / ${data.symbolA}` : undefined} />
      </div>
      <p className="hint">首笔投入决定初始比例，后续按当前比例使用代币，多余数量留在钱包；份额按比例分配。</p>

      <div className="liquidity-grid">
        <section className="subcard" aria-labelledby="add-title">
          <h3 id="add-title"><Icon name="droplet" size={16} />添加流动性</h3>
          <div className="field-row">
            <label className="field"><span>最大投入 A（{data.symbolA}）</span>
              <input inputMode="decimal" value={amountA} onChange={e => setAmountA(e.target.value)} disabled={busy} /></label>
            <label className="field"><span>最大投入 B（{data.symbolB}）</span>
              <input inputMode="decimal" value={amountB} onChange={e => setAmountB(e.target.value)} disabled={busy} /></label>
          </div>
          <div className="btn-row">
            <button type="button" className="btn btn--ghost" onClick={() => deposit(false)} disabled={busy || !amountA || !amountB}>预览实际投入</button>
            <button type="button" className="btn btn--primary" onClick={() => deposit(true)} disabled={busy || !amountA || !amountB}>
              {busy ? '等待钱包 / 链上确认…' : '授权并添加流动性'}</button>
          </div>
          <p className="micro">最多需要分别确认两种代币授权和一次添加交易。最低到账量与份额按本次报价的 99.5% 保护，交易有效期 10 分钟。</p>
          {quote && <div className="quote">
            <div className="quote__row"><dt>预计实际投入：</dt><dd>{compact(formatUnits(quote.amountA, data.decimalsA))} {data.symbolA} / {compact(formatUnits(quote.amountB, data.decimalsB))} {data.symbolB}</dd></div>
            <div className="quote__row"><dt>获得份额（最小单位）：</dt><dd className="mono">{quote.shares.toString()}</dd></div>
          </div>}
        </section>

        <section className="subcard" aria-labelledby="swap-title">
          <h3 id="swap-title"><Icon name="swap" size={16} />代币兑换</h3>
          <p className="micro">手续费 0.3% 留在池中，按份额由持有人赎回时结算。最低输出按报价的 99.5% 保护，交易有效期 10 分钟。</p>
          <div className="price-note"><span>储备比参考价</span><strong className="mono">{data.reserveA > 0n && data.reserveB > 0n ? `1 ${data.symbolA} ≈ ${price} ${data.symbolB}` : '暂无流动性'}</strong></div>
          <div className="field-row">
            <label className="field"><span>兑换方向</span>
              <select value={direction} onChange={e => setDirection(e.target.value)} disabled={busy}>
                <option value="A">{data.symbolA} → {data.symbolB}</option>
                <option value="B">{data.symbolB} → {data.symbolA}</option>
              </select></label>
            <label className="field"><span>兑换输入数量</span>
              <input inputMode="decimal" value={swapAmount} onChange={e => setSwapAmount(e.target.value)} disabled={busy} /></label>
          </div>
          <div className="btn-row">
            <button type="button" className="btn btn--ghost" disabled={busy || loading || !swapAmount} onClick={() => trade(false)}>获取兑换报价</button>
            <button type="button" className="btn btn--primary" disabled={busy || loading || !swapAmount || !swapQuote || data.reserveA === 0n || data.reserveB === 0n}
              onClick={() => trade(true)}>授权并兑换</button>
          </div>
          {swapQuote && <div className="quote">
            <div className="quote__row"><dt>预计输出：</dt><dd>{compact(formatUnits(swapQuote.amountOut, direction === 'A' ? data.decimalsB : data.decimalsA))} {direction === 'A' ? data.symbolB : data.symbolA}</dd></div>
            <div className="quote__row"><dt>最低输出：</dt><dd>{compact(formatUnits(minimum(swapQuote.amountOut), direction === 'A' ? data.decimalsB : data.decimalsA))} {direction === 'A' ? data.symbolB : data.symbolA}</dd></div>
            <div className="quote__row"><dt>手续费约</dt><dd>{compact(formatUnits(swapQuote.feeAmount, direction === 'A' ? data.decimalsA : data.decimalsB))} {direction === 'A' ? data.symbolA : data.symbolB}</dd></div>
          </div>}
        </section>
      </div>
    </>}

    {message && <Flash tone="ok">{message}</Flash>}
    {error && <Flash tone="bad">{error}</Flash>}

    {removeQuote && data && <div className="callout callout--accent" aria-label="赎回预览">
      <Icon name="droplet" size={18} />
      <div className="callout__body">
        <strong>销毁 NFT #{removeQuote.tokenId.toString()} 预计取回</strong>
        <p>{compact(formatUnits(removeQuote.amountA, data.decimalsA))} {data.symbolA} / {compact(formatUnits(removeQuote.amountB, data.decimalsB))} {data.symbolB}，包含当前份额对应的手续费权益。</p>
      </div>
      <button type="button" className="btn btn--primary btn--sm" disabled={busy || loading}
        onClick={() => redeem(removeQuote.tokenId, true)}>确认销毁 NFT #{removeQuote.tokenId.toString()} 并赎回</button>
    </div>}

    <section aria-labelledby="mine-title">
      <div className="section-head">
        <div className="section-head__text"><h3 id="mine-title">我的流动性 NFT</h3><p className="sub">包含当前账户在所有池子中的凭证</p></div>
        <div className="pager pager--inline">
          <button type="button" className="btn btn--ghost btn--sm" disabled={busy || loading || ownerOffset === 0}
            onClick={() => setOwnerOffset(v => Math.max(0, v - 10))}>我的 NFT 上一页</button>
          <button type="button" className="btn btn--ghost btn--sm" disabled={busy || loading || mine.length < 10}
            onClick={() => setOwnerOffset(v => v + 10)}>我的 NFT 下一页</button>
        </div>
      </div>
      {positionList(mine, '当前账户尚无流动性 NFT。')}
    </section>

    <section aria-labelledby="sources-title">
      <div className="section-head">
        <div className="section-head__text"><h3 id="sources-title">该池流动性来源</h3><p className="sub">含已销毁的历史凭证，用于核对赎回记录</p></div>
        <div className="pager pager--inline">
          <button type="button" className="btn btn--ghost btn--sm" disabled={busy || loading || sourceOffset === 0}
            onClick={() => setSourceOffset(v => Math.max(0, v - 10))}>来源上一页</button>
          <button type="button" className="btn btn--ghost btn--sm" disabled={busy || loading || sources.length < 10}
            onClick={() => setSourceOffset(v => v + 10)}>来源下一页</button>
        </div>
      </div>
      {positionList(sources, '该池尚无流动性提供记录。')}
    </section>

    <p className="hint">NFT 可转让，原始提供者与当前持有人分别记录。历史投入量不等于未来赎回数量，资产权益按份额计算。赎回会销毁整个 NFT，已赎回记录保留在来源列表。</p>
  </section>;
}
