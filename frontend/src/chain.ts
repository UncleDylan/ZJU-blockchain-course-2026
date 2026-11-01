import { isAddress, isError, type Eip1193Provider, type InterfaceAbi } from 'ethers';

export interface WalletProvider extends Eip1193Provider {
  on?(event: string, listener: (...args: unknown[]) => void): void;
  removeListener?(event: string, listener: (...args: unknown[]) => void): void;
}
declare global { interface Window { ethereum?: WalletProvider } }
export interface TokenInfo { name: string; symbol: string; address: string }
export interface Deployment { chainId: number; tokens: TokenInfo[]; tokenAbi: InterfaceAbi; miniDEX: string; dexAbi: InterfaceAbi; exchanges?: {name:string;address:string}[]; arbitrage?:string; arbitrageAbi?:InterfaceAbi }

export function parseDeployment(value: unknown): Deployment {
  const data = value as Deployment | null;
  if (!data || !Number.isSafeInteger(data.chainId) || data.chainId <= 0 ||
      !isAddress(data.miniDEX) || !Array.isArray(data.dexAbi) ||
      !Array.isArray(data.tokenAbi) || !Array.isArray(data.tokens) || data.tokens.length !== 2 ||
      data.tokens.some((token) => !token || typeof token.name !== 'string' ||
        typeof token.symbol !== 'string' || !isAddress(token.address)) ||
      data.tokens[0].address.toLowerCase() === data.tokens[1].address.toLowerCase()) {
    throw new Error('部署配置无效，请重新运行合约部署脚本。');
  }
  if (data.exchanges && (!Array.isArray(data.exchanges) || data.exchanges.length === 0 || data.exchanges.some(exchange => !isAddress(exchange.address)))) throw new Error('交易所配置无效。');
  if (data.arbitrage && (!isAddress(data.arbitrage) || !Array.isArray(data.arbitrageAbi) || data.exchanges?.length !== 2)) throw new Error('套利配置无效。');
  return data;
}
export function errorMessage(error: unknown): string {
  const name = (error as { revert?: { name?: string } })?.revert?.name;
  if (name === 'FaucetCooldown') return '还在领取冷却期，请刷新余额查看下次领取时间。';
  if (name === 'UnsupportedToken') return '地址不是可用的 ERC20 合约。';
  if (name === 'PoolAlreadyExists') return '该代币对的交易池已存在，请刷新池子列表。';
  if (name === 'SlippageExceeded') return '价格或份额已变化，实际结果低于最低接收量，请刷新报价后重试。';
  if (name === 'DeadlineExpired') return '交易已超过截止时间，请重新报价并提交。';
  if (name === 'InsufficientLiquidity') return '池子流动性不足，或输出数量过小，请调整输入。';
  if (name === 'NotPositionOwner') return '只有当前 NFT 持有人可以赎回。';
  if (name === 'ERC721NonexistentToken') return 'NFT 不存在或已被销毁，请刷新列表。';
  if (name === 'UnsupportedTransfer') return '代币实际转账数量不符，本次交易已回滚。';
  if (name === 'InsufficientProfit') return '套利结果未达到最低利润，两次兑换和资产转移已整体回滚。';
  if (name === 'InvalidRoute') return '两条兑换路径的代币对不匹配，请重新检测。';
  if (isError(error, 'ACTION_REJECTED') || (error as { code?: number })?.code === 4001) return '已取消钱包操作，可以重新尝试。';
  if (isError(error, 'INSUFFICIENT_FUNDS')) return '测试 ETH 不足，请使用本地链预置的测试账户支付 Gas。';
  if (isError(error, 'CALL_EXCEPTION')) return '合约调用失败，请检查代币地址、交易参数和部署状态，再刷新重试。';
  const text = error instanceof Error ? error.message : String(error ?? '');
  if (/could not coalesce|fetch failed|network changed|SERVER_ERROR|TIMEOUT|ECONNREFUSED|Failed to fetch/i.test(text)) {
    return '本地链连接中断，请确认 Hardhat 节点与 RPC 仍在运行，然后重新刷新。';
  }
  return text || '操作失败，请检查钱包和本地链连接。';
}
