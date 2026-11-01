import { useEffect, useState } from 'react';
import { formatUnits, isAddress } from 'ethers';
import type { Deployment } from './chain';
import { Icon, Loading, SectionHead } from './ui';

interface User { address: string; randomOperations: number; warmupAdds: number; actions: { swap: number; add: number; remove: number }; gasCostWei: string; balanceAWei: string; balanceBWei: string; activeNFTs: number }
interface Snapshot { round: number; reserveA: string; reserveB: string; priceBPerA: string; activeNFTs: number; mintedNFTs: number; redeemedNFTs: number; wallElapsedSeconds: number; chainElapsedSeconds: number }
interface Report {
  type: 'minidex-simulation'; version: number; runId: string; status: 'running' | 'passed' | 'failed';
  startedAt: string; completedAt?: string; elapsedSeconds: number; chainId: number; dex: string;
  config: { users: number; rounds: number; intervalMs: number; seed: number }; completedRounds: number;
  tokens: { address: string; symbol: string; decimals: number }[];
  counters: { randomOperations: number; swap: number; add: number; remove: number; transactions: number; unexpectedFailures: number; skipped: number };
  invariants: { core: number; full: number; passed: boolean }; users: User[]; snapshots: Snapshot[];
  latestTransactions: { action: string; user: string; transactionHash: string; blockNumber: number }[]; error?: string;
}
function parseReport(value: unknown): Report {
  const data = value as Report;
  if (!data || data.type !== 'minidex-simulation' || data.version !== 1 || !isAddress(data.dex) ||
      !['running','passed','failed'].includes(data.status) || !data.config || !data.counters || !data.invariants ||
      !Array.isArray(data.users) || !Array.isArray(data.snapshots) || !Array.isArray(data.tokens) || data.tokens.length !== 2 ||
      !Array.isArray(data.latestTransactions) || data.users.some(user => !isAddress(user.address) ||
        !/^\d+$/.test(user.gasCostWei) || !/^\d+$/.test(user.balanceAWei) || !/^\d+$/.test(user.balanceBWei)) ||
      data.snapshots.some(point => !Number.isFinite(Number(point.priceBPerA)))) {
    throw Error('模拟记录格式无效，请查看本地运行报告。');
  }
  if (data.status === 'passed' && (!data.invariants.passed || data.config.users < 20 ||
      data.users.length !== data.config.users || data.completedRounds !== data.config.rounds ||
      data.counters.randomOperations !== data.users.length * data.config.rounds ||
      data.users.some(user => user.randomOperations !== data.config.rounds))) {
    throw Error('模拟记录的通过状态与核对数据不一致。');
  }
  return data;
}
const number = (value: string | number) => Number(value).toLocaleString('zh-CN', { maximumFractionDigits: 6 });
const actionLabel: Record<string,string> = { swap:'兑换', add:'添加', remove:'撤销', approve:'授权', claim:'领币', deploy:'部署', createPool:'建池' };

const W = 800, H = 250, PL = 64, PR = 20, PT = 20, PB = 44;

export default function SimulationPanel({ deployment }: { deployment: Deployment }) {
  const [report, setReport] = useState<Report>();
  const [error, setError] = useState(''), [empty, setEmpty] = useState(false), [loading, setLoading] = useState(false), [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError('');
    fetch(`${import.meta.env.BASE_URL}simulation.json`, { cache: 'no-store', signal: controller.signal })
      .then(async response => {
        if (response.status === 404) { setEmpty(true); return undefined; }
        if (!response.ok) throw Error('暂时无法读取模拟记录。');
        return parseReport(await response.json());
      })
      .then(data => { if (!controller.signal.aborted && data) { setReport(data); setEmpty(false); } })
      .catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '读取失败。'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [refresh]);
  useEffect(() => { if (report?.status !== 'running') return; const timer = window.setInterval(() => setRefresh(value => value + 1), 5000); return () => window.clearInterval(timer); }, [report?.status]);

  const last = report?.snapshots.at(-1), prices = report?.snapshots.map(point => Number(point.priceBPerA)) ?? [];
  const low = prices.length ? Math.min(...prices) : 0, high = prices.length ? Math.max(...prices) : 1;
  const x = (index: number) => PL + index * (W - PL - PR) / Math.max(1, prices.length - 1);
  const y = (value: number) => PT + (1 - (value - low) / (high - low || 1)) * (H - PT - PB);
  const linePoints = prices.map((value, index) => `${x(index).toFixed(1)},${y(value).toFixed(1)}`).join(' ');
  const areaPath = prices.length > 1
    ? `M ${x(0).toFixed(1)},${H - PB} L ${prices.map((value, index) => `${x(index).toFixed(1)},${y(value).toFixed(1)}`).join(' L ')} L ${x(prices.length - 1).toFixed(1)},${H - PB} Z`
    : '';
  const gridValues = prices.length ? [high, high - (high - low) / 3, high - 2 * (high - low) / 3, low] : [];
  const matching = report?.chainId === deployment.chainId && report?.dex.toLowerCase() === deployment.miniDEX.toLowerCase();
  const state = report?.status === 'passed' ? 'passed' : report?.status === 'failed' ? 'failed' : 'running';

  return <section className="panel" aria-labelledby="simulation-title">
    <SectionHead id="simulation-title" title="多用户模拟结果" hint="由脚本创建地址、随机兑换与增删流动性，逐轮核对链上资产与 NFT 账本。"
      actions={<button type="button" className="btn btn--ghost btn--sm" disabled={loading} onClick={() => setRefresh(value => value + 1)}>
        <Icon name="refresh" size={15} />刷新模拟结果</button>} />

    {!report && loading && <Loading>正在读取模拟结果…</Loading>}
    {empty && !report && <p className="hint">暂无模拟记录。</p>}
    {error && <p className="error">{error}</p>}

    {report && <>
      <div className={`run-status run-status--${state}`} data-state={state}>
        <span className="run-status__dot" aria-hidden="true" />
        <p className="run-status__text">{report.status === 'passed' ? '模拟通过' : report.status === 'failed' ? '模拟失败' : '模拟运行中'} · {report.completedRounds} / {report.config.rounds} 轮 · 用时 {report.elapsedSeconds} 秒</p>
        <span className="run-status__meta mono">seed {report.config.seed}</span>
      </div>
      {!matching && <p className="hint">这是另一套部署的历史结果，当前页面的池子状态可能不同。</p>}

      <div className="stats">
        <div className="stat"><span className="stat__label">模拟地址</span><span className="stat__value">{report.users.length}</span></div>
        <div className="stat"><span className="stat__label">随机操作</span><span className="stat__value">{report.counters.randomOperations}</span></div>
        <div className="stat"><span className="stat__label">兑换</span><span className="stat__value">{report.counters.swap}</span></div>
        <div className="stat"><span className="stat__label">添加流动性</span><span className="stat__value">{report.counters.add}</span></div>
        <div className="stat"><span className="stat__label">撤销流动性</span><span className="stat__value">{report.counters.remove}</span></div>
        <div className="stat"><span className="stat__label">异常失败</span><span className={`stat__value ${report.counters.unexpectedFailures === 0 ? 'is-ok' : 'is-bad'}`}>{report.counters.unexpectedFailures}</span></div>
      </div>

      <p className="hint">资产与账本核对 {report.invariants.core} 次，完整资产 / NFT 核对 {report.invariants.full} 次。{report.invariants.passed ? '全部通过。' : report.status === 'running' ? '尚在运行。' : '未通过，请查看错误记录。'}</p>
      {report.error && <p className="error">{report.error}</p>}

      {last && <>
        <div className="latest-row">
          <div className="latest-item"><span className="micro">最新储备 {report.tokens[0].symbol}</span><strong className="mono">{number(last.reserveA)}</strong></div>
          <div className="latest-item"><span className="micro">最新储备 {report.tokens[1].symbol}</span><strong className="mono">{number(last.reserveB)}</strong></div>
          <div className="latest-item"><span className="micro">有效 NFT</span><strong className="mono">{last.activeNFTs}</strong></div>
          <div className="latest-item"><span className="micro">已赎回</span><strong className="mono">{last.redeemedNFTs}</strong></div>
        </div>

        <div className="chart-block">
          <div className="chart-block__head">
            <div>
              <h3>价格变化 · 1 {report.tokens[0].symbol} 对应的 {report.tokens[1].symbol}</h3>
              <p className="micro">共 {prices.length} 个采样点，纵轴按本次价格范围缩放</p>
            </div>
            <div className="chart-legend">
              <span className="chart-legend__dot" aria-hidden="true" />储备比参考价
            </div>
          </div>
          <svg className="simulation-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="每轮储备参考价格变化">
            <defs>
              <linearGradient id="chart-area" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#2f6bff" stopOpacity=".2" />
                <stop offset="100%" stopColor="#2f6bff" stopOpacity="0" />
              </linearGradient>
              <linearGradient id="chart-line" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0%" stopColor="#2f6bff" /><stop offset="100%" stopColor="#0fb389" />
              </linearGradient>
            </defs>
            {gridValues.map((value, index) => <g key={index}>
              <line className="chart-grid" x1={PL} y1={y(value)} x2={W - PR} y2={y(value)} />
              <text className="chart-axis" x={PL - 12} y={y(value) + 4} textAnchor="end">{number(value)}</text>
            </g>)}
            {areaPath && <path className="chart-area" d={areaPath} fill="url(#chart-area)" />}
            {prices.length > 1 && <polyline className="chart-line" points={linePoints} fill="none" stroke="url(#chart-line)" strokeWidth="2.5"
              strokeLinejoin="round" strokeLinecap="round" pathLength={1} />}
            {prices.map((value, index) => <circle key={index} className="chart-dot" cx={x(index)} cy={y(value)} r="2.6" />)}
            <text className="chart-axis" x={PL} y={H - 14}>初始化</text>
            <text className="chart-axis" x={W - PR} y={H - 14} textAnchor="end">第 {report.completedRounds} 轮</text>
          </svg>
          <p className="hint">这是储备比参考价格，实际成交受数量与手续费影响。链上时间跨度 {last.chainElapsedSeconds} 秒，实际运行时间以墙钟用时为准。</p>
        </div>
      </>}

      <details className="disclosure">
        <summary>查看 {report.users.length} 个地址明细</summary>
        <div className="table-wrap"><table>
          <thead><tr><th>地址</th><th>随机操作</th><th>兑换</th><th>添加</th><th>撤销</th><th>有效 NFT</th><th>{report.tokens[0].symbol} 余额</th><th>{report.tokens[1].symbol} 余额</th><th>Gas ETH</th></tr></thead>
          <tbody>{report.users.map(user => <tr key={user.address}>
            <td className="mono">{user.address}</td><td>{user.randomOperations}</td><td>{user.actions.swap}</td><td>{user.actions.add}</td><td>{user.actions.remove}</td><td>{user.activeNFTs}</td>
            <td>{number(formatUnits(user.balanceAWei, 18))}</td><td>{number(formatUnits(user.balanceBWei, 18))}</td><td>{number(formatUnits(user.gasCostWei, 18))}</td></tr>)}</tbody>
        </table></div>
      </details>

      <details className="disclosure">
        <summary>最近 {report.latestTransactions.length} 笔交易</summary>
        <ul className="tx-list">{report.latestTransactions.map(tx => <li key={tx.transactionHash}>
          <span className="tx-list__action">{actionLabel[tx.action] ?? tx.action}</span>
          <span className="micro">区块 {tx.blockNumber}</span>
          <code className="mono break">{tx.transactionHash}</code></li>)}</ul>
      </details>

      <p className="hint">开始于 {new Date(report.startedAt).toLocaleString()}；共确认 {report.counters.transactions} 笔交易（含部署、领币、授权与建池）。</p>
      <p className="mono break micro">交易所：{report.dex}</p>
    </>}
  </section>;
}
