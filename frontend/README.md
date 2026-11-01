# MiniDEX 前端

使用 React、TypeScript、Vite 和 ethers，实现钱包连接、领币、池子管理、添加流动性、兑换、NFT 查询、销毁赎回、双交易所切换和原子套利。使用前先部署合约，生成 `public/deployment.json`；详细说明见 [ERC20 与水龙头](../docs/tokens.md)。

VMware 共享目录请在项目根目录运行 `node tools/install-shared.mjs frontend` 安装依赖。Vite 已启用文件轮询，支持在 Windows 编辑、Ubuntu 运行时更新页面。以下普通安装命令适用于支持符号链接的文件系统。

## 安装与运行

建议使用 Node.js 24。使用 nvm 时，在 `frontend/` 目录执行：

```bash
nvm install
nvm use
```

也可以自行安装满足 `package.json` 中 `engines` 要求的 Node.js 版本。

首次安装依赖并启动：

```bash
npm ci
npm start
```

访问终端显示的地址（默认 [http://localhost:3000](http://localhost:3000)，端口占用时自动选择其他端口）。`npm run dev` 与 `npm start` 等效。

## 检查与构建

```bash
npm run typecheck
npm test
npm run build
```

`npm test` 使用 Vitest 执行一次测试；`npm run test:watch` 持续监听修改。测试配置在 `vite.config.ts`，测试文件为 `src/*.test.tsx`。

生产文件输出到 `build/`。执行 `npm run preview`，在 [http://localhost:4173](http://localhost:4173) 本地预览生产构建。

HTML 入口位于 `frontend/index.html`；图片、图标等静态资源放在 `public/`，代码和样式放在 `src/`。

## 源码结构

| 文件 | 职责 |
| --- | --- |
| `src/App.tsx` | 应用状态：读取 `deployment.json`、连接钱包、切换网络、余额与领取冷却；组合四个视图 |
| `src/AppShell.tsx` | 界面外壳：左侧导航（资产 / 交易池 / 原子套利 / 模拟）、顶栏链状态与账户、页脚 |
| `src/ui.tsx` | 通用组件：图标、状态标签、提示条、页头、区块标题、数据块、加载与空状态 |
| `src/PoolPanel.tsx` | 交易池创建、分页查询、储备与参考价、交易所切换 |
| `src/LiquidityPanel.tsx` | 添加流动性、兑换报价与执行、ERC721 凭证列表与销毁赎回 |
| `src/BonusPanel.tsx` | 两所价差、套利路线检测与原子执行、历史演示与失败回滚验证 |
| `src/SimulationPanel.tsx` | 多用户模拟报告：统计、价格曲线、地址明细与交易列表 |
| `src/chain.ts` | 部署配置解析、钱包类型与 revert 错误文案 |
| `src/App.css` | 页面布局、颜色、按钮、表单、表格、图表与窄屏样式 |

界面使用浅色背景和深色主按钮，金额与地址使用等宽字体。窄屏下导航改为顶部标签，宽表格在容器内滚动；390px 宽度下检查通过。
