import hre from "hardhat";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { TransactionReceipt, TransactionResponse } from "ethers";
import { deployApp } from "./lib/deployment.js";

type Action = "swap" | "add" | "remove";
type Phase = "setup" | "warmup" | "random";
const root = fileURLToPath(new URL("../../", import.meta.url));
const serialize = (value: unknown) => JSON.stringify(value, (_, item) => typeof item === "bigint" ? item.toString() : item, 2) + "\n";
function integer(name: string, fallback: number, min: number, max: number) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw Error(`${name} must be an integer in [${min}, ${max}]`);
  return value;
}
function randomGenerator(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const check = (condition: boolean, reason: string) => { if (!condition) throw Error(`Invariant failed: ${reason}`); };

async function main() {
  const config = {
    users: integer("SIM_USERS", 20, 20, 100),
    rounds: integer("SIM_ROUNDS", 15, 1, 100),
    intervalMs: integer("SIM_INTERVAL_MS", 250, 0, 10_000),
    seed: integer("SIM_SEED", 20261029, 0, 0xffff_ffff),
  };
  const connection = await hre.network.create();
  const network = await connection.ethers.provider.getNetwork();
  if (network.chainId !== 31337n) throw Error("Simulation only supports the local 31337 test chain.");
  const available = await connection.ethers.getSigners();
  if (available.length < config.users) throw Error(`Need ${config.users} unlocked local accounts; got ${available.length}.`);
  const started = Date.now(), runId = `${started}-${config.seed}`;
  const { ethers, tokenA, tokenB, miniDEX: dex, deployment } = await deployApp();
  const users = (await ethers.getSigners()).slice(0, config.users);
  const addresses = await Promise.all(users.map(user => user.getAddress()));
  const dexAddress = await dex.getAddress();
  const [a, b] = BigInt(await tokenA.getAddress()) < BigInt(await tokenB.getAddress()) ? [tokenA, tokenB] : [tokenB, tokenA];
  const addressA = await a.getAddress(), addressB = await b.getAddress();
  const symbolA = await a.symbol(), symbolB = await b.symbol();
  const random = randomGenerator(config.seed);
  const choose = (max: number) => Math.floor(random() * max);
  const minimum = (amount: bigint) => { const value = amount * 995n / 1000n; return value > 0n ? value : 1n; };
  const e = ethers.parseEther;
  const stats = addresses.map(address => ({ address, setupTransactions: 0, warmupAdds: 0, randomOperations: 0,
    actions: { swap: 0, add: 0, remove: 0 }, gasUsed: 0n, gasCostWei: 0n, balanceAWei: 0n, balanceBWei: 0n, activeNFTs: 0 }));
  const statsByAddress = new Map(stats.map(row => [row.address.toLowerCase(), row]));
  const counters = { swap: 0, add: 0, remove: 0, randomOperations: 0, skipped: 0, transactions: 0, unexpectedFailures: 0 };
  const auditCounts = { core: 0, full: 0 };
  const journal: { phase: Phase; action: string; user: string; transactionHash: string; blockNumber: number;
    gasUsed: bigint; gasCostWei: bigint; details: Record<string, unknown> }[] = [];
  const positions = new Map<bigint, { owner: string; shares: bigint; redeemed: boolean }>();
  const snapshots: Record<string, unknown>[] = [];
  let reserveA = 0n, reserveB = 0n, shares = 0n;
  let state: "running" | "passed" | "failed" = "running", completedRounds = 0, error: string | undefined;
  let completedAt: string | undefined;
  const startBlock = await ethers.provider.getBlockNumber();
  const startChainBlock = await ethers.provider.getBlock(startBlock);
  const reportPath = `${root}docs/simulation-runs/${runId}.json`;
  await mkdir(`${root}docs/simulation-runs`, { recursive: true });

  function summary() {
    return { type: "minidex-simulation", version: 1, runId, status: state, startedAt: new Date(started).toISOString(),
      completedAt, elapsedSeconds: Math.round((Date.now() - started) / 1000), config, completedRounds,
      chainId: Number(network.chainId), dex: dexAddress,
      tokens: [{ address: addressA, symbol: symbolA, decimals: 18 }, { address: addressB, symbol: symbolB, decimals: 18 }],
      counters, invariants: { ...auditCounts, passed: state === "passed" }, users: stats, snapshots,
      startBlock, error, latestTransactions: journal.slice(-15) };
  }
  async function persist() {
    const full = { ...summary(), journal };
    await writeFile(`${reportPath}.tmp`, serialize(full)); await rename(`${reportPath}.tmp`, reportPath);
    const publicPath = `${root}frontend/public/simulation.json`;
    await writeFile(`${publicPath}.tmp`, serialize(summary())); await rename(`${publicPath}.tmp`, publicPath);
  }
  async function note(phase: Phase, action: string, user: string,
    tx: Pick<TransactionResponse, "wait" | "hash">, details: Record<string, unknown> = {}) {
    const receipt = await tx.wait();
    check(receipt !== null && receipt.status === 1, `${action}: transaction not confirmed`);
    const confirmed = receipt!;
    const gasCostWei = confirmed.gasUsed * confirmed.gasPrice;
    const row = statsByAddress.get(user.toLowerCase());
    check(!!row, "transaction sender outside simulated users");
    row!.gasUsed += confirmed.gasUsed; row!.gasCostWei += gasCostWei;
    if (phase === "setup") row!.setupTransactions++;
    if (phase === "warmup") row!.warmupAdds++;
    if (action === "swap" || action === "add" || action === "remove") { counters[action]++; row!.actions[action]++; }
    if (phase === "random") { counters.randomOperations++; row!.randomOperations++; }
    counters.transactions++;
    journal.push({ phase, action, user, transactionHash: tx.hash, blockNumber: confirmed.blockNumber,
      gasUsed: confirmed.gasUsed, gasCostWei, details });
    return confirmed;
  }
  function event(receipt: TransactionReceipt, name: string) {
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== dexAddress.toLowerCase()) continue;
      const parsed = dex.interface.parseLog(log);
      if (parsed?.name === name) return parsed.args;
    }
    throw Error(`Missing ${name} event`);
  }
  async function deadline() {
    const block = await ethers.provider.getBlock("latest");
    if (!block) throw Error("Latest block unavailable");
    return block.timestamp + 600;
  }
  async function approve(index: number, token: typeof a, amount: bigint) {
    const allowance = await token.allowance(addresses[index]!, dexAddress);
    if (allowance >= amount) return;
    if (allowance > 0n) await note("setup", "resetApproval", addresses[index]!, await token.connect(users[index]!).approve(dexAddress, 0));
    const cap = e("1000") > amount ? e("1000") : amount;
    await note("setup", "approve", addresses[index]!, await token.connect(users[index]!).approve(dexAddress, cap), { token: await token.getAddress(), cap });
  }
  async function balances(index: number) {
    return Promise.all([a.balanceOf(addresses[index]!), b.balanceOf(addresses[index]!)]);
  }
  async function add(index: number, desiredA: bigint, desiredB: bigint, phase: Phase) {
    const before = await balances(index), quote = await dex.previewAddLiquidity(1, desiredA, desiredB);
    await approve(index, a, desiredA); await approve(index, b, desiredB);
    const receipt = await note(phase, "add", addresses[index]!,
      await dex.connect(users[index]!).addLiquidity(1, desiredA, desiredB, minimum(quote.amountA), minimum(quote.amountB), minimum(quote.shares), await deadline()),
      { desiredA, desiredB, actualA: quote.amountA, actualB: quote.amountB, shares: quote.shares });
    const added = event(receipt, "LiquidityAdded");
    check(added.amountA === quote.amountA && added.amountB === quote.amountB && added.shares === quote.shares, "add differs from preview");
    if (shares === 0n) shares = 1000n;
    reserveA += added.amountA; reserveB += added.amountB; shares += added.shares;
    positions.set(added.tokenId, { owner: addresses[index]!, shares: added.shares, redeemed: false });
    journal.at(-1)!.details.tokenId = added.tokenId;
    const after = await balances(index);
    check(before[0]! - after[0]! === added.amountA && before[1]! - after[1]! === added.amountB, "deposit wallet deltas");
  }
  async function swap(index: number) {
    const aToB = random() < 0.5, token = aToB ? a : b, before = await balances(index);
    const availableBalance = aToB ? before[0]! : before[1]!;
    const wanted = e(String(1 + choose(10))), amount = wanted < availableBalance / 5n ? wanted : availableBalance / 5n;
    check(amount > 0n, "trader has no input tokens");
    const inReserve = aToB ? reserveA : reserveB, outReserve = aToB ? reserveB : reserveA;
    const expected = amount * 9970n * outReserve / (inReserve * 10_000n + amount * 9970n);
    const quote = await dex.quoteSwap(1, await token.getAddress(), amount);
    check(quote.amountOut === expected && expected > 0n, "swap formula or output invalid");
    const oldK = reserveA * reserveB;
    await approve(index, token, amount);
    const receipt = await note("random", "swap", addresses[index]!, await dex.connect(users[index]!).swap(1, await token.getAddress(), amount, minimum(expected), await deadline()),
      { direction: aToB ? "A_TO_B" : "B_TO_A", amountIn: amount, amountOut: expected, fee: quote.feeAmount });
    const traded = event(receipt, "Swapped"); check(traded.amountOut === expected, "swap event amount");
    if (aToB) { reserveA += amount; reserveB -= expected; } else { reserveB += amount; reserveA -= expected; }
    check(reserveA * reserveB >= oldK, "k decreased during a swap");
    const after = await balances(index);
    check(aToB ? before[0]! - after[0]! === amount && after[1]! - before[1]! === expected
      : before[1]! - after[1]! === amount && after[0]! - before[0]! === expected, "swap wallet deltas");
  }
  async function remove(index: number, id: bigint) {
    const position = positions.get(id)!;
    const expectedA = reserveA * position.shares / shares, expectedB = reserveB * position.shares / shares;
    const quote = await dex.previewRemoveLiquidity(id), before = await balances(index);
    check(quote.amountA === expectedA && quote.amountB === expectedB, "withdrawal formula");
    const receipt = await note("random", "remove", addresses[index]!, await dex.connect(users[index]!).removeLiquidity(id, minimum(expectedA), minimum(expectedB), await deadline()),
      { tokenId: id, amountA: expectedA, amountB: expectedB, shares: position.shares });
    const removed = event(receipt, "LiquidityRemoved"); check(removed.amountA === expectedA && removed.amountB === expectedB, "withdrawal event");
    reserveA -= expectedA; reserveB -= expectedB; shares -= position.shares; position.redeemed = true;
    const after = await balances(index);
    check(after[0]! - before[0]! === expectedA && after[1]! - before[1]! === expectedB, "withdrawal wallet deltas");
  }
  async function audit(full: boolean) {
    const blockTag = await ethers.provider.getBlockNumber(), options = { blockTag };
    const [pool, actualA, actualB, supply, nfts, minted] = await Promise.all([
      dex.getPool(1, options), a.balanceOf(dexAddress, options), b.balanceOf(dexAddress, options),
      dex.totalShares(1, options), dex.totalSupply(options), dex.positionCount(options),
    ]);
    check(pool.reserveA === reserveA && pool.reserveB === reserveB, "reserves differ from transaction ledger");
    check(actualA === reserveA && actualB === reserveB, "stored reserves differ from actual assets");
    check(supply === shares, "total shares differ from ledger");
    const active = [...positions.entries()].filter(([, p]) => !p.redeemed);
    check(nfts === BigInt(active.length) && minted === BigInt(positions.size), "NFT count mismatch");
    check(active.reduce((sum, [, p]) => sum + p.shares, shares === 0n ? 0n : 1000n) === shares, "active plus locked shares mismatch");
    auditCounts.core++;
    if (full) {
      const walletValues = await Promise.all(addresses.map(async address => {
        const [balanceA, balanceB, count] = await Promise.all([a.balanceOf(address, options), b.balanceOf(address, options), dex.balanceOf(address, options)]);
        const row = statsByAddress.get(address.toLowerCase())!;
        row.balanceAWei = balanceA; row.balanceBWei = balanceB; row.activeNFTs = Number(count);
        const owned: bigint[] = [];
        for (let offset = 0; offset < Number(count); offset += 100) owned.push(...await dex.getOwnerPositionIds(address, offset, 100, options));
        const expected = active.filter(([, p]) => p.owner.toLowerCase() === address.toLowerCase()).map(([id]) => id);
        check(owned.length === expected.length && new Set(owned.map(String)).size === owned.length && expected.every(id => owned.includes(id)), "owner enumeration mismatch");
        return { balanceA, balanceB };
      }));
      const [supplyA, supplyB] = await Promise.all([a.totalSupply(options), b.totalSupply(options)]);
      check(walletValues.reduce((sum, value) => sum + value.balanceA, actualA) === supplyA, "Token A conservation");
      check(walletValues.reduce((sum, value) => sum + value.balanceB, actualB) === supplyB, "Token B conservation");
      check(supplyA === e("1000") * BigInt(config.users) && supplyB === supplyA, "unexpected token mint or burn");
      await Promise.all([...positions.entries()].map(async ([id, expected]) => {
        const [position, time, by] = await Promise.all([dex.positions(id, options), dex.redeemedAt(id, options), dex.redeemedBy(id, options)]);
        check(position.shares === expected.shares && position.poolId === 1n, "position details mismatch");
        if (expected.redeemed) check(time > 0n && by.toLowerCase() === expected.owner.toLowerCase(), "redemption history mismatch");
        else check(time === 0n && (await dex.ownerOf(id, options)).toLowerCase() === expected.owner.toLowerCase(), "NFT owner mismatch");
      }));
      const sourceIds: bigint[] = [];
      for (let offset = 0; offset < positions.size; offset += 100) sourceIds.push(...await dex.getPoolPositionIds(1, offset, 100, options));
      check(sourceIds.length === positions.size && sourceIds.every((id, i) => id === BigInt(i + 1)), "pool source history mismatch");
      auditCounts.full++;
    }
    const block = await ethers.provider.getBlock(blockTag);
    return { blockNumber: blockTag, chainTimestamp: block!.timestamp, wallElapsedSeconds: Math.round((Date.now() - started) / 1000),
      reserveA: ethers.formatEther(reserveA), reserveB: ethers.formatEther(reserveB),
      priceBPerA: ethers.formatEther(reserveA === 0n ? 0n : reserveB * e("1") / reserveA),
      totalShares: shares, activeNFTs: active.length, mintedNFTs: positions.size, redeemedNFTs: positions.size - active.length,
      chainElapsedSeconds: block!.timestamp - startChainBlock!.timestamp };
  }
  try {
    await persist();
    for (const contract of [tokenA, tokenB, dex]) {
      await note("setup", "deploy", addresses[0]!, contract.deploymentTransaction()!);
    }
    for (let index = 0; index < users.length; index++) {
      for (const token of [a, b]) {
        await note("setup", "claim", addresses[index]!, await token.connect(users[index]!).claim(), { token: await token.getAddress() });
        await approve(index, token, e("1000"));
      }
    }
    await note("setup", "createPool", addresses[0]!, await dex.createPool(addressA, addressB));
    for (let index = 0; index < users.length; index++) { await add(index, e("100"), e("100"), "warmup"); await audit(false); }
    snapshots.push({ round: 0, ...await audit(true) }); await persist();
    console.log(JSON.stringify({ stage: "initialized", users: config.users, pool: 1, report: reportPath }));
    for (let round = 1; round <= config.rounds; round++) {
      const order = users.map((_, index) => index);
      for (let i = order.length - 1; i > 0; i--) { const j = choose(i + 1); [order[i], order[j]] = [order[j]!, order[i]!]; }
      for (const index of order) {
        const roll = random();
        const owned = [...positions.entries()].filter(([, p]) => !p.redeemed && p.owner.toLowerCase() === addresses[index]!.toLowerCase());
        if (roll < 0.55) await swap(index);
        else if (roll >= 0.85 && owned.length) await remove(index, owned[choose(owned.length)]![0]);
        else {
          const balance = await balances(index), wantA = e(String(1 + choose(20))), wantB = e(String(1 + choose(20)));
          await add(index, wantA < balance[0]! / 4n ? wantA : balance[0]! / 4n, wantB < balance[1]! / 4n ? wantB : balance[1]! / 4n, "random");
        }
        await audit(false);
        if (config.intervalMs) await new Promise(resolve => setTimeout(resolve, config.intervalMs));
      }
      completedRounds = round;
      const snapshot = { round, ...await audit(true) }; snapshots.push(snapshot); await persist();
      console.log(JSON.stringify({ stage: "round", round, total: config.rounds, operations: counters.randomOperations,
        swaps: counters.swap, adds: counters.add, removals: counters.remove, activeNFTs: snapshot.activeNFTs, elapsedSeconds: snapshot.wallElapsedSeconds }));
    }
    check(stats.every(row => row.randomOperations === config.rounds), "a user did not participate in every round");
    check(counters.swap > 0 && counters.add > 0 && counters.remove > 0, "missing required operation category");
    state = "passed"; completedAt = new Date().toISOString(); await persist();
    console.log(JSON.stringify({ status: state, users: config.users, counters, audits: auditCounts,
      elapsedSeconds: Math.round((Date.now() - started) / 1000), report: reportPath }));
  } catch (reason) {
    state = "failed"; counters.unexpectedFailures++; error = reason instanceof Error ? reason.message : String(reason);
    completedAt = new Date().toISOString(); await persist(); throw reason;
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
