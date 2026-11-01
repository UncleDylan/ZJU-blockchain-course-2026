import hre from "hardhat";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const assert = (value: boolean, message: string) => { if (!value) throw Error(`Report verification failed: ${message}`); };
async function main() {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const files = (await readdir(`${root}docs/simulation-runs`)).filter(name => /^\d+-\d+\.json$/.test(name)).sort();
  const file = process.env.SIM_REPORT ?? `${root}docs/simulation-runs/${files.at(-1) ?? 'missing.json'}`;
  const report = JSON.parse(await readFile(file, "utf8"));
  const { ethers } = await hre.network.create();
  assert((await ethers.provider.getNetwork()).chainId === 31337n && report.chainId === 31337, "wrong chain");
  assert(report.status === "passed" && report.invariants.passed, "run did not pass");
  assert(report.users.length >= 20 && new Set(report.users.map((row: { address: string }) => row.address.toLowerCase())).size === report.users.length, "need distinct users");
  const snapshot = report.snapshots.at(-1);
  const options = { blockTag: snapshot.blockNumber };
  const block = await ethers.provider.getBlock(snapshot.blockNumber);
  assert(block !== null && block.timestamp === snapshot.chainTimestamp, "recorded block missing or different");
  const dex = await ethers.getContractAt("MiniDEX", report.dex);
  const a = await ethers.getContractAt("TestToken", report.tokens[0].address);
  const b = await ethers.getContractAt("TestToken", report.tokens[1].address);
  const [pool, totalShares, nftSupply, minted, supplyA, supplyB, dexA, dexB] = await Promise.all([
    dex.getPool(1, options), dex.totalShares(1, options), dex.totalSupply(options), dex.positionCount(options),
    a.totalSupply(options), b.totalSupply(options), a.balanceOf(report.dex, options), b.balanceOf(report.dex, options),
  ]);
  assert(ethers.formatEther(pool.reserveA) === snapshot.reserveA && ethers.formatEther(pool.reserveB) === snapshot.reserveB, "final reserves");
  assert(dexA === pool.reserveA && dexB === pool.reserveB && totalShares === BigInt(snapshot.totalShares), "DEX assets or shares");
  assert(nftSupply === BigInt(snapshot.activeNFTs) && minted === BigInt(snapshot.mintedNFTs), "NFT totals");
  let walletA = 0n, walletB = 0n, ownerNFTs = 0n;
  const ledger = new Map<string, { gas: bigint; gasCost: bigint; random: number; swap: number; add: number; remove: number }>();
  for (const user of report.users) {
    const [balanceA, balanceB, nfts] = await Promise.all([a.balanceOf(user.address, options), b.balanceOf(user.address, options), dex.balanceOf(user.address, options)]);
    assert(balanceA === BigInt(user.balanceAWei) && balanceB === BigInt(user.balanceBWei) && nfts === BigInt(user.activeNFTs), `user balances: ${user.address}`);
    assert(user.randomOperations === report.config.rounds, "user round participation");
    walletA += balanceA; walletB += balanceB; ownerNFTs += nfts;
    ledger.set(user.address.toLowerCase(), { gas: 0n, gasCost: 0n, random: 0, swap: 0, add: 0, remove: 0 });
  }
  assert(walletA + dexA === supplyA && walletB + dexB === supplyB && ownerNFTs === nftSupply, "global conservation");
  assert(new Set(report.journal.map((row: { transactionHash: string }) => row.transactionHash)).size === report.journal.length, "duplicate receipt");
  for (let offset = 0; offset < report.journal.length; offset += 20) {
    await Promise.all(report.journal.slice(offset, offset + 20).map(async (row: { transactionHash: string; user: string; blockNumber: number; gasUsed: string; gasCostWei: string; phase: string; action: string; details: Record<string, string> }) => {
      const receipt = await ethers.provider.getTransactionReceipt(row.transactionHash);
      assert(receipt !== null && receipt.status === 1, `missing successful receipt: ${row.transactionHash}`);
      const mined = receipt!;
      assert(mined.from.toLowerCase() === row.user.toLowerCase() && mined.blockNumber === row.blockNumber && mined.blockNumber <= snapshot.blockNumber, "receipt sender or block");
      const cost = mined.gasUsed * mined.gasPrice;
      assert(mined.gasUsed === BigInt(row.gasUsed) && cost === BigInt(row.gasCostWei), "receipt gas");
      const user = ledger.get(row.user.toLowerCase()); assert(!!user, "unknown sender");
      user!.gas += mined.gasUsed; user!.gasCost += cost;
      if (row.phase === "random") user!.random++;
      if (row.action === "swap" || row.action === "add" || row.action === "remove") {
        user![row.action]++;
        assert(mined.to?.toLowerCase() === report.dex.toLowerCase(), "DEX action destination");
        const eventName = row.action === "swap" ? "Swapped" : row.action === "add" ? "LiquidityAdded" : "LiquidityRemoved";
        const parsed = mined.logs.filter(log => log.address.toLowerCase() === report.dex.toLowerCase()).map(log => dex.interface.parseLog(log)).find(log => log?.name === eventName);
        assert(!!parsed, `missing ${eventName}`);
        if (row.action === "swap") assert(parsed!.args.amountOut === BigInt(row.details.amountOut), "swap output log");
        else assert(parsed!.args.tokenId === BigInt(row.details.tokenId), "position event ID");
      }
    }));
  }
  for (const user of report.users) {
    const actual = ledger.get(user.address.toLowerCase())!;
    assert(actual.gas === BigInt(user.gasUsed) && actual.gasCost === BigInt(user.gasCostWei) && actual.random === user.randomOperations, "user receipt accounting");
    assert(actual.swap === user.actions.swap && actual.add === user.actions.add && actual.remove === user.actions.remove, "user operation counts");
  }
  for (const action of ["swap", "add", "remove"] as const) assert([...ledger.values()].reduce((sum, user) => sum + user[action], 0) === report.counters[action], "global operation counts");
  assert(report.journal.length === report.counters.transactions && report.counters.randomOperations === report.users.length * report.config.rounds, "global transaction count");
  const result = { result: "passed", runId: report.runId, verifiedBlock: snapshot.blockNumber, distinctUsers: report.users.length,
    confirmedReceipts: report.journal.length, reservesMatch: true, walletBalancesMatch: true, gasAndCountsMatch: true,
    assetConservation: true, verifier: "read-only RPC verification at the recorded block" };
  await writeFile(`${root}docs/simulation-verification.json`, JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
