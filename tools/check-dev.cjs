// Read-only checks used by the development startup scripts.
const fs = require('node:fs');
const path = require('node:path');

async function rpc(method, params = []) {
  const response = await fetch('http://127.0.0.1:8545', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(3000),
  });
  const body = await response.json();
  if (!response.ok || body.error) throw new Error(body.error?.message || `HTTP ${response.status}`);
  return body.result;
}

async function main() {
  const mode = process.argv[2];
  if (mode === 'web') {
    const response = await fetch('http://127.0.0.1:3000', { signal: AbortSignal.timeout(3000) });
    if (!response.ok || !(await response.text()).includes('MiniDEX')) throw new Error('MiniDEX frontend is not ready.');
    return;
  }
  if (mode !== 'rpc' && mode !== 'deployment') throw new Error('Expected rpc, web or deployment.');
  if (await rpc('eth_chainId') !== '0x7a69') throw new Error('Port 8545 is not the expected local chain (31337).');
  if (mode === 'rpc') return;
  const configPath = path.join(__dirname, '../frontend/public/deployment.json');
  let config;
  try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')); }
  catch { process.exitCode = 1; return; }
  const addresses = [...(config.tokens || []).map(t => t.address),
    ...(config.exchanges || []).map(d => d.address), config.arbitrage];
  if (config.chainId !== 31337 || config.tokens?.length !== 2 || config.exchanges?.length !== 2 ||
      addresses.some(a => typeof a !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(a))) {
    process.exitCode = 1; return;
  }
  for (const address of addresses) {
    if (await rpc('eth_getCode', [address, 'latest']) === '0x') { process.exitCode = 1; return; }
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 2; });
