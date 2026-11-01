import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BrowserProvider, Contract, formatEther, formatUnits } from 'ethers';
import { errorMessage, parseDeployment, type Deployment } from './chain';
import './App.css';
import AppShell, { VIEWS, type View } from './AppShell';
import { Badge, Flash, Icon, Loading, PageHead, SectionHead, compact, useAutoClear } from './ui';
import PoolPanel from './PoolPanel';
import SimulationPanel from './SimulationPanel';
import BonusPanel from './BonusPanel';

interface TokenState { balance: string; amount: string; nextClaimAt: number }

const COOLDOWN_MS = 24 * 60 * 60 * 1000;

function countdown(ms: number) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return [hours, minutes, seconds].map((value) => String(value).padStart(2, '0')).join(':');
}

function App() {
  const wallet = window.ethereum;
  const walletRevision = useRef(0);
  const [view, setView] = useState<View>('assets');
  const [deployment, setDeployment] = useState<Deployment>();
  const [selectedDex, setSelectedDex] = useState('');
  const poolDeployment = useMemo(() => deployment
    ? { ...deployment, miniDEX: selectedDex || deployment.miniDEX }
    : undefined, [deployment, selectedDex]);
  const [configError, setConfigError] = useState('');
  const [account, setAccount] = useState('');
  const [chainId, setChainId] = useState<number>();
  const [ethBalance, setEthBalance] = useState('');
  const [tokens, setTokens] = useState<TokenState[]>([]);
  const [refresh, setRefresh] = useState(0);
  const [pending, setPending] = useState('');
  const [message, setMessage] = useState('');
  useAutoClear(message, setMessage);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const controller = new AbortController();
    fetch(`${import.meta.env.BASE_URL}deployment.json`, { cache: 'no-store', signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('未找到部署配置，请先在 contracts 目录运行 npm run deploy。');
        let config: unknown;
        try { config = await response.json(); }
        catch { throw new Error('部署配置无法读取，请先在 contracts 目录运行 npm run deploy，再刷新页面。'); }
        return parseDeployment(config);
      }).then(setDeployment)
      .catch((reason: unknown) => { if (!controller.signal.aborted) setConfigError(errorMessage(reason)); });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!wallet) return;
    let active = true;
    const revision = walletRevision.current;
    const onAccounts = (...args: unknown[]) => {
      walletRevision.current++;
      setAccount((args[0] as string[])[0] ?? ''); setError(''); setMessage('');
    };
    const onChain = (...args: unknown[]) => {
      walletRevision.current++;
      setChainId(Number(args[0])); setError(''); setMessage('');
    };
    wallet.on?.('accountsChanged', onAccounts);
    wallet.on?.('chainChanged', onChain);
    Promise.all([
      wallet.request({ method: 'eth_accounts' }), wallet.request({ method: 'eth_chainId' }),
    ]).then(([accounts, chain]: [string[], string]) => {
      if (active && revision === walletRevision.current) { setAccount(accounts[0] ?? ''); setChainId(Number(chain)); }
    }).catch((reason: unknown) => { if (active) setError(errorMessage(reason)); });
    return () => {
      active = false;
      wallet.removeListener?.('accountsChanged', onAccounts);
      wallet.removeListener?.('chainChanged', onChain);
    };
  }, [wallet]);

  const correctChain = !!deployment && chainId === deployment.chainId;
  useEffect(() => {
    setTokens([]); setEthBalance(''); setLoading(false);
    if (!wallet || !account || !deployment || !correctChain) return;
    let active = true;
    const provider = new BrowserProvider(wallet);
    setLoading(true);
    Promise.all([
      provider.getBalance(account),
      Promise.all(deployment.tokens.map(async (token) => {
        if (await provider.getCode(token.address) === '0x') {
          throw new Error('代币地址没有合约代码，本地链可能已重启，请重新部署并刷新页面。');
        }
        const contract = new Contract(token.address, deployment.tokenAbi, provider);
        const [balance, decimals, amount, nextClaimAt, symbol] = await Promise.all([
          contract.balanceOf(account), contract.decimals(), contract.FAUCET_AMOUNT(),
          contract.nextClaimAt(account), contract.symbol(),
        ]);
        if (symbol !== token.symbol) throw new Error('链上代币与部署配置不一致，请重新部署并刷新页面。');
        return { balance: formatUnits(balance, decimals), amount: formatUnits(amount, decimals), nextClaimAt: Number(nextClaimAt) * 1000 };
      })),
    ]).then(([eth, values]) => {
      if (active) { setEthBalance(formatEther(eth)); setTokens(values); }
    }).catch((reason: unknown) => { if (active) setError(errorMessage(reason)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; provider.destroy(); };
  }, [wallet, account, deployment, correctChain, refresh]);

  const connect = async () => {
    if (!wallet) return;
    walletRevision.current++;
    setPending('connect'); setError(''); setMessage('');
    try {
      const accounts: string[] = await wallet.request({ method: 'eth_requestAccounts' });
      setAccount(accounts[0] ?? '');
      setChainId(Number(await wallet.request({ method: 'eth_chainId' })));
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setPending(''); }
  };

  const switchNetwork = async () => {
    if (!wallet || !deployment) return;
    setPending('network'); setError(''); setMessage('');
    const target = `0x${deployment.chainId.toString(16)}`;
    try {
      try {
        await wallet.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: target }] });
      } catch (reason) {
        if ((reason as { code?: number }).code !== 4902 || deployment.chainId !== 31337) throw reason;
        await wallet.request({ method: 'wallet_addEthereumChain', params: [{
          chainId: target, chainName: 'MiniDEX Local',
          nativeCurrency: { name: 'Test Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: ['http://127.0.0.1:8545'],
        }] });
        await wallet.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: target }] });
      }
      setChainId(Number(await wallet.request({ method: 'eth_chainId' })));
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setPending(''); }
  };

  const claim = useCallback(async (index: number) => {
    if (!wallet || !deployment || !account) return;
    setPending(`claim-${index}`); setError(''); setMessage('');
    const provider = new BrowserProvider(wallet);
    try {
      if ((await provider.getNetwork()).chainId !== BigInt(deployment.chainId)) throw new Error('钱包网络已改变，请切换回部署网络。');
      const signer = await provider.getSigner(account);
      const contract = new Contract(deployment.tokens[index].address, deployment.tokenAbi, signer);
      const tx = await contract.claim();
      setMessage(`交易已提交，等待确认：${tx.hash}`);
      await tx.wait();
      setMessage(`${deployment.tokens[index].symbol} 领取成功。交易：${tx.hash}`);
    } catch (reason) { setMessage(''); setError(errorMessage(reason)); }
    finally { provider.destroy(); setPending(''); setRefresh((value) => value + 1); }
  }, [wallet, deployment, account]);

  const meta = VIEWS[view];
  const tokenCards = deployment?.tokens.map((token, index) => {
    const state = tokens[index];
    const cooling = !!state && state.nextClaimAt > now;
    const remaining = cooling ? state.nextClaimAt - now : 0;
    const progress = !state ? 0 : cooling ? Math.min(1, Math.max(0, 1 - remaining / COOLDOWN_MS)) : 1;
    return <section className="token-card" key={token.address} aria-label={token.name} data-accent={index === 0 ? 'a' : 'b'}>
      <div className="token-card__head">
        <div className="token-card__id">
          <span className="token-avatar" aria-hidden="true">{token.symbol.slice(-1)}</span>
          <div>
            <p className="token-card__symbol">{token.symbol}</p>
            <p className="token-card__name">{token.name}</p>
          </div>
        </div>
        <Badge>ERC-20</Badge>
      </div>
      <div className="token-card__balance">
        <span className={state ? 'token-value' : 'token-value is-empty'} title={state?.balance}>{state ? compact(state.balance) : '—'}</span>
        <span className="token-unit">{token.symbol}</span>
      </div>
      <p className="micro">我的余额</p>
      <div className="meter-block">
        <div className="meter-block__row">
          <span className="micro">{!account ? '等待连接' : !correctChain ? '等待正确网络' : cooling ? '领取冷却中' : '可以领取'}</span>
          <span className="micro mono">{!account || !correctChain ? '—' : cooling ? countdown(remaining) : '就绪'}</span>
        </div>
        <div className="meter"><i style={{ width: `${(progress * 100).toFixed(1)}%` }} /></div>
        {cooling && <p className="micro">下次可领取：{new Date(state.nextClaimAt).toLocaleString()}</p>}
      </div>
      <div className="token-card__contract">
        <span className="micro">合约地址</span>
        <code className="addr">{token.address}</code>
      </div>
      <button type="button" className="btn btn--primary btn--block" onClick={() => claim(index)}
        disabled={!account || !correctChain || !state || !!pending || cooling}>
        {pending === `claim-${index}` ? '等待钱包 / 链上确认…' : cooling ? '领取冷却中' : `领取 ${state?.amount ?? '1000'} ${token.symbol}`}
      </button>
    </section>;
  });

  const exchangeSelect = deployment?.exchanges && deployment.exchanges.length > 1
    ? <label className="select">
      <span className="select__label">当前交易所</span>
      <select value={poolDeployment?.miniDEX} onChange={(event) => setSelectedDex(event.target.value)}>
        {deployment.exchanges.map((exchange) => <option value={exchange.address} key={exchange.address}>{exchange.name}</option>)}
      </select>
    </label>
    : undefined;

  return <AppShell view={view} onViewChange={setView} hasWallet={!!wallet} account={account}
    chainId={chainId} requiredChainId={deployment?.chainId} pending={pending} onConnect={connect}>
    <PageHead eyebrow={meta.eyebrow} title={meta.title} lede={meta.lede}
      actions={view === 'pools' ? exchangeSelect : view === 'assets'
        ? <button type="button" className="bonus-link" onClick={() => setView('arbitrage')}>
          <Icon name="bolt" size={15} />
          <span>Bonus · 原子套利</span>
          <Icon name="arrow" size={14} />
        </button>
        : undefined} />

    {configError && <Flash tone="bad">{configError}</Flash>}
    {error && <Flash tone="bad">{error}</Flash>}
    {message && <Flash tone="ok">{message}</Flash>}

    {view === 'assets' && <>
      {!deployment && !configError && <Loading>正在读取部署配置…</Loading>}
      <section className="panel" aria-labelledby="wallet-title">
        <SectionHead id="wallet-title" title="钱包与网络" hint="本地链账户、网络与余额状态"
          actions={<button type="button" className="btn btn--ghost btn--sm" disabled={!account || !correctChain || loading || !!pending}
            onClick={() => { setError(''); setRefresh((value) => value + 1); }}>刷新余额</button>} />
        {!wallet && <Flash tone="warn">未检测到钱包扩展，请在安装了 MetaMask 等钱包的浏览器中打开此页面。</Flash>}
        <dl className="kv kv--wallet">
          <div><dt>当前账户</dt><dd className="mono">{account || '尚未连接'}</dd></div>
          <div><dt>网络 Chain ID</dt><dd className="mono">{chainId ?? '—'}</dd>{deployment && <span className="kv__hint">需要 {deployment.chainId}</span>}</div>
          <div><dt>测试 ETH 余额</dt><dd className="mono" title={ethBalance}>{ethBalance ? `${compact(ethBalance)} ETH` : '—'}</dd></div>
        </dl>
        {wallet && account && deployment && !correctChain && <div className="callout callout--warn" role="alert">
          <Icon name="alert" size={18} />
          <div className="callout__body">
            <strong>网络不匹配</strong>
            <p>请切换到合约所在网络后领取。</p>
          </div>
          <button type="button" className="btn btn--ghost btn--sm" onClick={switchNetwork} disabled={!!pending}>切换到部署网络</button>
        </div>}
        <details className="disclosure">
          <summary>本地链与钱包说明</summary>
          <div className="disclosure__body">
            <p>本地 RPC：http://127.0.0.1:8545，Chain ID：31337。Windows 钱包需先建立 SSH 端口转发。</p>
            <p>领币交易需要少量测试 ETH。可使用 Hardhat 节点提供的预置测试账户；切换账户后可分别领取。</p>
          </div>
        </details>
      </section>

      <section className="stack" aria-labelledby="faucet-title">
        <SectionHead id="faucet-title" title="领取测试币" hint="每个地址每种代币每 24 小时可领取 1,000 枚，冷却时间在链上独立记录。" />
        {loading && <Loading>正在读取链上余额…</Loading>}
        <div className="token-grid">{tokenCards}</div>
      </section>

      <section className="panel panel--tinted" aria-labelledby="quickstart-title">
        <SectionHead id="quickstart-title" title="快速开始" hint="四个步骤覆盖基础功能与 Bonus 的完整流程。" />
        <ol className="steps">
          <li><span className="steps__n">01</span><div><strong>领取测试币</strong><p>连接钱包，分别领取 TKA 与 TKB。</p></div></li>
          <li><span className="steps__n">02</span><div><strong>创建交易池</strong><p>为两个代币建立恒定乘积交易池。</p></div></li>
          <li><span className="steps__n">03</span><div><strong>注入流动性</strong><p>按比例投入资产，获得 ERC721 凭证。</p></div></li>
          <li><span className="steps__n">04</span><div><strong>兑换与套利</strong><p>兑换、销毁赎回，或跨所完成原子套利。</p></div></li>
        </ol>
      </section>
    </>}

    {view === 'pools' && <>
      {!deployment && !configError && <Loading>正在读取部署配置…</Loading>}
      {poolDeployment && <PoolPanel key={poolDeployment.miniDEX} deployment={poolDeployment} wallet={wallet} account={account}
        correctChain={correctChain} onChanged={() => setRefresh((value) => value + 1)} />}
    </>}

    {view === 'arbitrage' && <>
      {!deployment && !configError && <Loading>正在读取部署配置…</Loading>}
      {deployment?.arbitrage
        ? <BonusPanel key={`${account}-${chainId}`} deployment={deployment} wallet={wallet} account={account}
          correctChain={correctChain} onChanged={() => setRefresh((value) => value + 1)} />
        : deployment && <section className="panel"><SectionHead title="Bonus · 原子套利" hint="当前部署未包含套利合约。" />
          <p className="sub">请先重新部署合约（contracts 目录运行 npm run deploy），再刷新页面。</p></section>}
    </>}

    {view === 'simulation' && <>
      {!deployment && !configError && <Loading>正在读取部署配置…</Loading>}
      {deployment && <SimulationPanel deployment={deployment} />}
    </>}
  </AppShell>;
}
export default App;
