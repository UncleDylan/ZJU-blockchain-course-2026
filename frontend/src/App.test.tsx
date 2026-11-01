import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { parseEther } from 'ethers';
import App from './App';
import type { WalletProvider } from './chain';

const mock = vi.hoisted(() => ({
  balances: new Map<string, bigint>(), next: new Map<string, bigint>(),
  claim: vi.fn(), getSigner: vi.fn(),
}));
vi.mock('ethers', async (original) => {
  const real = await original<typeof import('ethers')>();
  return {
    ...real,
    BrowserProvider: class {
      getBalance = async () => real.parseEther('10000');
      getCode = async () => '0x1234';
      getNetwork = async () => ({ chainId: 31337n });
      getSigner = mock.getSigner;
      destroy() {}
    },
    Contract: class {
      poolCount = async () => 0n;
      getPools = async () => [];
      address: string;
      signer: { address?: string };
      constructor(address: string, _abi: unknown, signer: { address?: string }) { this.address = address; this.signer = signer; }
      balanceOf = async (account: string) => mock.balances.get(`${this.address}:${account}`) ?? 0n;
      decimals = async () => 18n;
      FAUCET_AMOUNT = async () => real.parseEther('1000');
      nextClaimAt = async (account: string) => mock.next.get(`${this.address}:${account}`) ?? 0n;
      symbol = async () => this.address.endsWith('1') ? 'TKA' : 'TKB';
      claim = async () => {
        mock.claim(this.address, this.signer.address);
        return { hash: '0xabc', wait: async () => {
          const key = `${this.address}:${this.signer.address}`;
          mock.balances.set(key, real.parseEther('1000'));
          mock.next.set(key, BigInt(Math.floor(Date.now() / 1000) + 86400));
        } };
      };
    },
  };
});

const alice = '0x0000000000000000000000000000000000000011';
const bob = '0x0000000000000000000000000000000000000022';
const tokenA = '0x0000000000000000000000000000000000000001';
const config = {
  miniDEX: '0x0000000000000000000000000000000000000003', dexAbi: [],
  chainId: 31337, tokenAbi: [], tokens: [
    { name: 'Token A', symbol: 'TKA', address: tokenA },
    { name: 'Token B', symbol: 'TKB', address: '0x0000000000000000000000000000000000000002' },
  ],
};
function installWallet(accounts: string[] = [], chain = '0x7a69') {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const request = vi.fn(async ({ method }: { method: string }) => {
    if (method === 'eth_accounts') return accounts;
    if (method === 'eth_requestAccounts') return [alice];
    if (method === 'eth_chainId') return chain;
    if (method === 'wallet_switchEthereumChain') { chain = '0x7a69'; listeners.get('chainChanged')?.(chain); return null; }
    throw new Error(`Unexpected method ${method}`);
  });
  window.ethereum = { request,
    on: (event, listener) => { listeners.set(event, listener); },
    removeListener: (event) => { listeners.delete(event); },
  } as WalletProvider;
  return { request, emit: (event: string, data: unknown) => listeners.get(event)?.(data) };
}
beforeEach(() => {
  mock.balances.clear(); mock.next.clear(); mock.claim.mockReset();
  mock.getSigner.mockReset().mockImplementation(async (address: string) => ({ address }));
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => config }));
  delete window.ethereum;
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); delete window.ethereum; });

describe('Token faucet UI', () => {
  test('shows both tokens and clear guidance when no wallet is installed', async () => {
    render(<App />);
    expect(await screen.findByRole('region', { name: 'Token A' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Token B' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('未检测到钱包');
    expect(screen.getByRole('button', { name: '连接钱包' })).toBeDisabled();
  });
  test('explains missing deployment instead of showing an unusable claim form', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false } as Response);
    render(<App />);
    expect(await screen.findByText(/未找到部署配置/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /领取 1000/ })).not.toBeInTheDocument();
  });
  test('connects, claims, waits for confirmation and refreshes balance and cooldown', async () => {
    installWallet();
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: '连接钱包' }));
    const button = await screen.findByRole('button', { name: '领取 1000.0 TKA' });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    expect(await screen.findByText(/TKA 领取成功/)).toBeInTheDocument();
    const card = screen.getByRole('region', { name: 'Token A' });
    await waitFor(() => expect(within(card).getByRole('button')).toHaveTextContent('领取冷却中'));
    expect(within(card).getByText('1000.0')).toBeInTheDocument();
    expect(within(card).getByRole('button')).toBeDisabled();
    expect(mock.claim).toHaveBeenCalledWith(tokenA, alice);
  });
  test('blocks claims on the wrong network and supports switching', async () => {
    const wallet = installWallet([alice], '0x1');
    render(<App />);
    const switchButton = await screen.findByRole('button', { name: '切换到部署网络' });
    expect(screen.getByRole('button', { name: '领取 1000 TKA' })).toBeDisabled();
    fireEvent.click(switchButton);
    await waitFor(() => expect(screen.getByRole('button', { name: '领取 1000.0 TKA' })).toBeEnabled());
    expect(wallet.request).toHaveBeenCalledWith({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x7a69' }] });
  });
  test('refreshes account balances on wallet switch and clears them on disconnect', async () => {
    mock.balances.set(`${tokenA}:${bob}`, parseEther('50'));
    const wallet = installWallet([alice]);
    render(<App />);
    await waitFor(() => expect(screen.getByRole('button', { name: '领取 1000.0 TKA' })).toBeEnabled());
    act(() => wallet.emit('accountsChanged', [bob]));
    expect(await screen.findByText('50.0')).toBeInTheDocument();
    act(() => wallet.emit('accountsChanged', []));
    expect(await screen.findByText('尚未连接')).toBeInTheDocument();
    expect(screen.queryByText('50.0')).not.toBeInTheDocument();
  });
  test('shows wallet cancellation and lets the user retry', async () => {
    const wallet = installWallet();
    wallet.request.mockImplementation(async ({ method }) => {
      if (method === 'eth_accounts') return [];
      if (method === 'eth_chainId') return '0x7a69';
      throw Object.assign(new Error('User rejected'), { code: 4001 });
    });
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: '连接钱包' }));
    expect(await screen.findByText('已取消钱包操作，可以重新尝试。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '连接钱包' })).toBeEnabled();
  });
});
