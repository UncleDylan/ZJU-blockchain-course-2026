# Ubuntu 共享目录开发环境

本项目在 Windows 共享目录中编辑，在 Ubuntu 虚拟机中安装依赖、编译、运行和验证。

## 环境与路径

- Windows：`E:\VMware Shared Folder\Blockchain\hw2\ZJU-blockchain-course-2026`
- Ubuntu：`/mnt/hgfs/VMware_Shared_Folder/Blockchain/hw2/ZJU-blockchain-course-2026`
- SSH：在 Windows 执行 `ssh Ubuntu-64-bit`。
- 本次使用 Node.js `22.22.1`、npm `9.2.0`，满足两个工程的 `engines` 约束；仓库 `.nvmrc` 推荐 Node.js 24。

## 安装依赖

依赖已安装时，重启后的服务恢复可在 Windows PowerShell 中执行：

```powershell
cd 'E:\VMware Shared Folder\Blockchain\hw2\ZJU-blockchain-course-2026'
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\start-dev.ps1
```

先启动 Ubuntu 虚拟机，脚本会等待 SSH，检查并启动本地链和前端；部署配置或合约缺失时重新部署两种代币、双交易所与套利合约，已有部署则保留。随后启动 Windows RPC 隧道，使用网页期间保持该终端开启。脚本不自动领币、建池、添加流动性或运行模拟。本地链重启后旧交易和领取记录会丢失，需要重新准备演示数据。

启动检查失败时脚本停止并显示原因，不会强制结束占用端口的进程。Ubuntu 日志为 `/tmp/blockchain-hw2-node.log` 和 `/tmp/blockchain-hw2-frontend.log`。

在 Ubuntu 的项目根目录执行：

```bash
cd /mnt/hgfs/VMware_Shared_Folder/Blockchain/hw2/ZJU-blockchain-course-2026
node tools/install-shared.mjs
```

VMware 共享文件系统不支持 npm 默认创建的符号链接，直接 `npm ci` 会出现 `ENOTSUP ... symlink`。本脚本使用 `npm ci --no-bin-links`，然后为直接依赖中的 Node 命令生成普通 shell 启动文件，因此原有 npm scripts 可以继续使用。脚本只重装依赖和生成 `node_modules/.bin` 下的命令，不修改锁文件或业务代码。移动项目目录后需要重新运行脚本，以更新启动文件中的绝对路径。

也可以只安装一侧：

```bash
node tools/install-shared.mjs contracts
node tools/install-shared.mjs frontend
```

## 合约检查

```bash
cd contracts
npm run typecheck
npm test
```

`typecheck` 会先执行合约编译，再执行 TypeScript 类型检查。

## 启动本地链与部署

Ubuntu 终端一，在项目 `contracts/` 中执行并保持运行：

```bash
npm run node
```

Ubuntu 终端二，在同一 `contracts/` 中执行：

```bash
npm run deploy
```

RPC 为 `http://127.0.0.1:8545`，Chain ID 为 `31337`。部署脚本打印 `MiniDEX` 地址。停止并重启默认内存链后，状态会重置，需要重新部署。

## 前端检查与启动

在项目 `frontend/` 中执行：

```bash
npm test
npm run build
npm start -- --host 0.0.0.0 --strictPort
```

`build` 包含 TypeScript 检查和 Vite 生产构建。Ubuntu 内可访问 `http://127.0.0.1:3000`；Windows 可通过虚拟机 IP 的 3000 端口访问。当前前端已接入 ERC20 水龙头，需先部署合约生成配置，再构建前端，见 [代币实现说明](tokens.md)。Vite 已启用轮询监听，以处理共享目录下 Windows 文件编辑不触发 Ubuntu 变更事件的问题。

若之后需要从 Windows 钱包访问虚拟机内的本地链，可在 Windows 单独保持以下 SSH 隧道，再将钱包 RPC 设为 `http://127.0.0.1:8545`：

```powershell
ssh -N -L 8545:127.0.0.1:8545 Ubuntu-64-bit
```

本地链提供的测试账户及密钥仅用于开发，不应用于真实资产。

## 本次基线验证记录（2026-10-29）

以下结果均在 Ubuntu 中对共享目录内的同一份代码实际执行得到：

| 检查 | 结果 |
| --- | --- |
| 两侧依赖安装 | 使用共享目录安装脚本成功，合约 191 个包、前端 116 个包 |
| 合约编译 | Solidity 0.8.20，EVM paris，1 个合约文件编译成功 |
| 合约 TypeScript 检查 | `npm run typecheck` 通过 |
| 合约测试 | `npm test`：1 passing |
| 本地链部署 | `npm run deploy` 成功 |
| 链上读取 | Chain ID 31337；合约字节码 819 字节；`helloworld()` 返回 `hello world` |
| 前端测试 | `npm test`：1 passed |
| 前端类型检查与生产构建 | `npm run build` 通过，输出位于 `frontend/build/` |
| 开发服务器 | Ubuntu 本机 HTTP 可访问；Windows 访问 `http://192.168.100.129:3000` 返回 HTTP 200，标题为 `React DApp Starter` |

本次新启动的内存链上，MiniDEX 地址为 `0x5FbDB2315678afecb367f032d93F642f64180aa3`。实际使用时仍以每次部署输出为准。

本次后台服务日志在 Ubuntu 的 `/tmp/blockchain-hw2-node.log` 和 `/tmp/blockchain-hw2-frontend.log`；日志不属于提交材料。节点日志可能包含本地测试账户密钥，不要上传。

以上是搭建环境时的历史基线，仅记录初始模板的 `hello world` 和 React 示例页面。后续实现了 AMM、NFT 流动性凭证、多用户模拟和双所套利；当前功能与验证结果见 [项目 README](../README.md)。
