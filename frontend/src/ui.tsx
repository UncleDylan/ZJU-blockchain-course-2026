import { useEffect } from 'react';
import type { ReactNode } from 'react';

/** Clears a transient success/in-progress message a moment after it is shown, so confirmations do not pile up. */
export function useAutoClear(value: string, clear: (next: string) => void, delay = 10000) {
  useEffect(() => {
    if (!value) return undefined;
    const timer = window.setTimeout(() => clear(''), delay);
    return () => window.clearTimeout(timer);
  }, [value, clear, delay]);
}

/** Icon set: stroke icons drawn on a 24x24 grid. */
export type IconName =
  | 'wallet' | 'droplet' | 'layers' | 'swap' | 'bolt' | 'chart' | 'route'
  | 'refresh' | 'check' | 'alert' | 'info' | 'arrow' | 'plus' | 'chevron'
  | 'clock' | 'coins' | 'shield' | 'spark';

const PATHS: Record<IconName, ReactNode> = {
  wallet: <><rect x="3" y="6.4" width="18" height="12.8" rx="3.4" /><path d="M3 10.4h18" /><circle cx="16.8" cy="14.9" r="1.1" fill="currentColor" stroke="none" /></>,
  droplet: <><path d="M12 3.6c3.1 3.9 6 7.3 6 10.3a6 6 0 0 1-12 0c0-3 2.9-6.4 6-10.3Z" /><path d="M9.4 14.6a2.7 2.7 0 0 0 2.6 2.6" /></>,
  layers: <><path d="M12 3.8 20.2 8 12 12.2 3.8 8Z" /><path d="M4.6 12.3 12 16l7.4-3.7" /><path d="M4.6 16.4 12 20l7.4-3.6" /></>,
  swap: <><path d="M6.5 8.5h10.2l-2.6-2.6" /><path d="M17.5 15.5H7.3l2.6 2.6" /></>,
  bolt: <path d="M13.4 3 6.2 13.2h4.6L10 21l7.4-10.6h-4.8L13.4 3Z" />,
  chart: <><path d="M4 19.5V4.5" /><path d="M4 19.5h16" /><path d="m7.5 15.5 3.4-4.6 3 2.6 4.6-6" /></>,
  route: <><path d="M5 6.5h7.5a4.2 4.2 0 0 1 0 8.4H8" /><path d="m10 3.8-3 2.7 3 2.7" /><path d="m10 17.9-3 2.6 3 2.7" /></>,
  refresh: <><path d="M20 12a8 8 0 1 1-2.4-5.7" /><path d="M20 4.4V9h-4.6" /></>,
  check: <path d="m4.8 12.6 4.4 4.4 9.8-9.8" />,
  alert: <><path d="M12 4.2 21 19.4H3L12 4.2Z" /><path d="M12 9.7v4.1" /><circle cx="12" cy="16.7" r=".95" fill="currentColor" stroke="none" /></>,
  info: <><circle cx="12" cy="12" r="8.4" /><path d="M12 11v5.2" /><circle cx="12" cy="8.2" r=".95" fill="currentColor" stroke="none" /></>,
  arrow: <><path d="M7 17 17 7" /><path d="M8.5 7H17v8.5" /></>,
  plus: <><path d="M12 5.2v13.6" /><path d="M5.2 12h13.6" /></>,
  chevron: <path d="m9.5 6 6 6-6 6" />,
  clock: <><circle cx="12" cy="12" r="8.4" /><path d="M12 7.6V12l3 1.8" /></>,
  coins: <><ellipse cx="12" cy="6.8" rx="7" ry="2.9" /><path d="M5 6.8v4.9c0 1.6 3.1 2.9 7 2.9s7-1.3 7-2.9V6.8" /><path d="M5 11.7v4.9c0 1.6 3.1 2.9 7 2.9s7-1.3 7-2.9v-4.9" /></>,
  shield: <path d="M12 3.4 19 6v5.4c0 4.2-2.9 7.4-7 9.2-4.1-1.8-7-5-7-9.2V6l7-2.6Z" />,
  spark: <><path d="M12 3.4v3.4" /><path d="M12 17.2v3.4" /><path d="M3.4 12h3.4" /><path d="M17.2 12h3.4" /><path d="m6 6 2.4 2.4" /><path d="m15.6 15.6 2.4 2.4" /><path d="m18 6-2.4 2.4" /><path d="m8.4 15.6-2.4 2.4" /></>,
};

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {PATHS[name]}
    </svg>
  );
}

export type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'neutral';

export function Badge({ tone = 'neutral', dot = false, children }: { tone?: Tone; dot?: boolean; children: ReactNode }) {
  return <span className={`pill pill--${tone}`}>{dot && <span className={`dot dot--${tone === 'neutral' ? 'idle' : tone}`} />}{children}</span>;
}

const FLASH_ICON: Record<Tone, IconName> = { ok: 'check', warn: 'alert', bad: 'alert', info: 'info', neutral: 'info' };

export function Flash({ tone = 'info', children }: { tone?: Tone; children: ReactNode }) {
  return <div className={`flash flash--${tone}`} role={tone === 'bad' || tone === 'warn' ? 'alert' : 'status'}>
    <Icon name={FLASH_ICON[tone]} size={17} />
    <div className="flash__body">{children}</div>
  </div>;
}

export function PageHead({ eyebrow, title, lede, actions }: { eyebrow: string; title: string; lede: string; actions?: ReactNode }) {
  return <header className="page-head">
    <div className="page-head__text">
      <p className="eyebrow"><span className="eyebrow__bar" aria-hidden="true" />{eyebrow}</p>
      <h1>{title}</h1>
      <p className="lede">{lede}</p>
    </div>
    {actions && <div className="page-head__actions">{actions}</div>}
  </header>;
}

export function SectionHead({ id, title, hint, actions }: { id?: string; title: string; hint?: string; actions?: ReactNode }) {
  return <div className="section-head">
    <div className="section-head__text"><h2 id={id}>{title}</h2>{hint && <p className="sub">{hint}</p>}</div>
    {actions && <div className="section-head__actions">{actions}</div>}
  </div>;
}

export function Stat({ label, value, unit, wide = false }: { label: string; value: string; unit?: string; wide?: boolean }) {
  return <div className={`stat${wide ? ' stat--wide' : ''}`}>
    <span className="stat__label">{label}</span>
    <span className="stat__value">{value}{unit && <small>{unit}</small>}</span>
  </div>;
}

export function Loading({ children }: { children: ReactNode }) {
  return <p className="loading" role="status"><span className="spinner" aria-hidden="true" />{children}</p>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}

export function short(address: string) {
  return address.length > 13 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

/** Trims long 18-decimal strings so figures stay on one line (display only). */
export function compact(value: string, digits = 4) {
  if (!value.includes('.')) return value;
  const [whole, fraction] = value.split('.');
  if (fraction.length <= 6) return value;
  const zeros = whole === '0' || whole === '-0' || whole === '' ? (fraction.match(/^0*/)?.[0].length ?? 0) : 0;
  if (zeros >= fraction.length - 1) return whole || '0';
  if (zeros > 0) {
    const significant = fraction.slice(zeros, zeros + digits).replace(/0+$/, '');
    return significant ? `${whole}.${'0'.repeat(zeros)}${significant}` : whole || '0';
  }
  const trimmed = fraction.slice(0, digits).replace(/0+$/, '');
  return trimmed ? `${whole}.${trimmed}` : whole;
}
