import { deployApp } from "./lib/deployment.js";

async function main() {
  const { deployment } = await deployApp(true);
  console.log(JSON.stringify(deployment.tokens, null, 2));
  console.log(`MiniDEX deployed to ${deployment.miniDEX}`);
  console.log(`DEX 2: ${deployment.exchanges[1]?.address}; atomic arbitrage: ${deployment.arbitrage}`);
  console.log(`Chain ID: ${deployment.chainId}; frontend/public/deployment.json updated.`);
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
