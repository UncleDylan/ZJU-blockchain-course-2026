import type { ReactNode } from 'react';
import { Icon, short, type IconName } from './ui';

export type View = 'assets' | 'pools' | 'arbitrage' | 'simulation';

export interface ViewMeta { label: string; eyebrow: string; title: string; lede: string; icon: IconName }

export const VIEWS: Record<View, ViewMeta> = {
  assets: {
    label: '资产', icon: 'wallet', eyebrow: 'FAUCET · LOCAL TESTNET',
    title: '资产与水龙头',
    lede: '连接本地钱包，领取 TKA 与 TKB，为建池、兑换和套利准备资产。',
  },
  pools: {
    label: '交易池', icon: 'layers', eyebrow: 'AMM · CONSTANT PRODUCT',
    title: '交易池与流动性',
    lede: '创建代币对、注入流动性并取得 ERC721 凭证，随后完成兑换或销毁赎回。',
  },
  arbitrage: {
    label: '原子套利', icon: 'bolt', eyebrow: 'BONUS · ATOMIC ARBITRAGE',
    title: '双交易所原子套利',
    lede: '比较两家交易所的储备价格，在一笔交易内完成跨所低买高卖，利润不足则整笔回滚。',
  },
  simulation: {
    label: '模拟', icon: 'chart', eyebrow: 'SIMULATION · 20 ACCOUNTS',
    title: '多用户随机模拟',
    lede: '20 个地址、15 轮随机兑换与流动性操作的链上结果与不变量核对记录。',
  },
};

const NAV: View[] = ['assets', 'pools', 'arbitrage', 'simulation'];

interface Props {
  view: View;
  onViewChange: (view: View) => void;
  hasWallet: boolean;
  account: string;
  chainId?: number;
  requiredChainId?: number;
  pending: string;
  onConnect: () => void;
  children: ReactNode;
}

function BrandMark() {
  return <span className="brand-mark" aria-hidden="true">
    <svg viewBox="0 0 40 40" width="40" height="40">
      <defs>
        <linearGradient id="brand-gradient" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#4d86ff" /><stop offset=".55" stopColor="#7aa2ff" /><stop offset="1" stopColor="#2fd3a4" />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="38" height="38" rx="12" fill="#0b0d12" />
      <path d="M20 9.6c-3 3.9-6.6 7.8-6.6 11.4a6.6 6.6 0 0 0 13.2 0c0-3.6-3.6-7.5-6.6-11.4Z" fill="#ffffff" fillOpacity=".94" />
      <path d="M16.4 20.6a3.7 3.7 0 0 0 3.5 3.7" stroke="url(#brand-gradient)" strokeWidth="1.5" strokeLinecap="round" fill="none" />
    </svg>
  </span>;
}

export default function AppShell({ view, onViewChange, hasWallet, account, chainId, requiredChainId, pending, onConnect, children }: Props) {
  const correctChain = requiredChainId !== undefined && chainId === requiredChainId;
  return <div className="shell">
    <aside className="rail">
      <div className="rail__brand">
        <BrandMark />
        <span className="brand-text"><strong>MiniDEX</strong><small>AMM 测试交易所</small></span>
      </div>
      <nav className="nav" aria-label="主导航">
        {NAV.map((id) => <button key={id} type="button" className="nav__item" aria-current={view === id ? 'page' : undefined}
          onClick={() => onViewChange(id)}>
          <Icon name={VIEWS[id].icon} />
          <span className="nav__label">{VIEWS[id].label}</span>
          {id === 'arbitrage' && <span className="nav__badge" aria-hidden="true">Bonus</span>}
        </button>)}
      </nav>
      <div className="rail__foot">
        <span className="rail__status">
          <span className={`dot ${correctChain ? 'dot--ok' : requiredChainId === undefined ? 'dot--idle' : 'dot--warn'}`} />
          {requiredChainId === undefined ? '等待部署配置' : `Chain ${requiredChainId}`}
        </span>
        <span className="rail__note">仅用于课程本地测试</span>
      </div>
    </aside>

    <div className="stage">
      <header className="topbar">
        <div className="topbar__path">
          <span className="topbar__brand">MiniDEX</span>
          <Icon name="chevron" size={13} />
          <span className="topbar__view">{VIEWS[view].label}</span>
        </div>
        <div className="topbar__wallet">
          {requiredChainId !== undefined && (chainId === undefined
            ? <span className="pill pill--idle"><span className="dot dot--idle" />未连接</span>
            : <span className={`pill ${correctChain ? 'pill--ok' : 'pill--warn'}`}>
              <span className={`dot ${correctChain ? 'dot--ok' : 'dot--warn'}`} />Chain {chainId}
            </span>)}
          {account && <span className="chip mono" title={account}>{short(account)}</span>}
          <button type="button" className="btn btn--primary btn--sm" onClick={onConnect} disabled={!hasWallet || !!pending}>
            {pending === 'connect' ? '连接中…' : account ? '重新连接钱包' : '连接钱包'}
          </button>
        </div>
      </header>
      <main className="workspace">{children}</main>
      <footer className="foot">
        <span>MiniDEX · AMM 去中心化交易所课程项目</span>
        <span className="foot__dot" aria-hidden="true" />
        <span>领币、建池、流动性、兑换、NFT 赎回、多用户模拟与原子套利</span>
      </footer>
    </div>
  </div>;
}
