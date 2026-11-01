# MiniDEX 合约工程

使用 Hardhat 3、ethers 6 和 TypeScript。`contracts/TestToken.sol` 实现 ERC20 测试币与水龙头；`contracts/MiniDEX.sol` 实现交易池、按比例添加流动性、ERC721 凭证、恒定乘积兑换及销毁赎回，0.3% 兑换手续费留在池中；`contracts/AtomicArbitrage.sol` 实现双交易所原子套利。流动性设计和验证见 [实现说明](../docs/liquidity.md)，套利实现见 [Bonus 说明](../docs/bonus.md)。

VMware 共享目录请在项目根目录运行 `node tools/install-shared.mjs contracts` 安装依赖，以避开符号链接限制。以下普通安装命令适用于支持符号链接的文件系统。

## 安装与检查

建议使用 Node.js 24。在 `contracts/` 目录执行：

```bash
nvm install
nvm use
npm ci
npm run compile
npm run typecheck
npm test
```

`npm run build` 与 `npm run compile` 等效。类型检查会先编译合约并生成类型。当前 Solidity 编译器为 0.8.20，OpenZeppelin 使用兼容该编译器的稳定版 5.4.0。

## 在本地 Hardhat 节点上部署

先启动节点，并保持该终端开启：

```bash
npm run node
```

在另一个终端进入 `contracts/`，使用相同的 Node.js 版本后执行：

```bash
npm run deploy
```

默认 RPC 地址为 `http://127.0.0.1:8545`，Chain ID 为 `31337`。部署脚本部署 TKA、TKB、两个 MiniDEX 与 AtomicArbitrage，并将地址和 ABI 写入 `../frontend/public/deployment.json`。本地链重启后应重新部署，再刷新前端；生产构建也应在部署后重新生成。

部署后可执行 `npm run verify:tokens`，用最后三个预置测试账户实际领取两种代币并检查重复领取被拒绝。该脚本会消耗这些地址本轮的领取额度，立即重跑前需重新部署。

## 在 Ganache 上部署

启动 Ganache，在 `hardhat.config.ts` 中调整 `ganache.url` 以匹配其 RPC 地址，然后执行：

```bash
npm run deploy:ganache
```

也可以通过环境变量 `LOCAL_RPC_URL` 或 `GANACHE_RPC_URL` 覆盖对应的 RPC 地址。部署使用节点提供的已解锁测试账户。

使用临时内存链测试部署脚本时，可执行 `npx hardhat run scripts/deploy.ts --network hardhat`。该链随进程退出销毁，生成的地址不能用于前端；随后需对持久运行的本地节点重新部署。

## 多用户随机模拟

保持本地节点运行，在本目录执行 `npm run simulate`，脚本自动部署新的测试合约，使用 20 个预置地址运行随机兑换、添加与撤销，并输出报告。再执行 `npm run verify:simulation`，只读复核交易回执和结束区块状态。参数、实际数据与检查方法见 [模拟说明](../docs/simulation.md)。

## 双所原子套利 Bonus

保持本地节点运行，执行 `npm run bonus`，自动准备两所流动性、20 地址市场交易、盈利套利和失败回滚演示；执行 `npm run verify:bonus` 只读复核历史回执。详见 [Bonus 说明](../docs/bonus.md)。普通部署只生成合约，不自动制造价差。
