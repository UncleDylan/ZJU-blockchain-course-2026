import hre from "hardhat";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export async function deployApp(withBonus = false) {
  const { ethers } = await hre.network.create();
  const tokenA = await ethers.deployContract("TestToken", ["Token A", "TKA"]);
  const tokenB = await ethers.deployContract("TestToken", ["Token B", "TKB"]);
  await Promise.all([tokenA.waitForDeployment(), tokenB.waitForDeployment()]);
  const miniDEX = await ethers.deployContract("MiniDEX");
  await miniDEX.waitForDeployment();
  const secondDEX = withBonus ? await ethers.deployContract("MiniDEX") : undefined;
  if (secondDEX) await secondDEX.waitForDeployment();
  const arbitrage = secondDEX ? await ethers.deployContract("AtomicArbitrage", [await miniDEX.getAddress(), await secondDEX.getAddress()]) : undefined;
  if (arbitrage) await arbitrage.waitForDeployment();

  const network = await ethers.provider.getNetwork();
  const tokenArtifact = await hre.artifacts.readArtifact("TestToken");
  const deployment = {
    chainId: Number(network.chainId),
    deployedAt: new Date().toISOString(),
    miniDEX: await miniDEX.getAddress(),
    dexAbi: (await hre.artifacts.readArtifact("MiniDEX")).abi,
    exchanges: [
      { name: "DEX 1", address: await miniDEX.getAddress() },
      ...(secondDEX ? [{ name: "DEX 2", address: await secondDEX.getAddress() }] : []),
    ],
    arbitrage: arbitrage ? await arbitrage.getAddress() : undefined,
    arbitrageAbi: arbitrage ? (await hre.artifacts.readArtifact("AtomicArbitrage")).abi : undefined,
    tokens: [
      { name: "Token A", symbol: "TKA", address: await tokenA.getAddress() },
      { name: "Token B", symbol: "TKB", address: await tokenB.getAddress() },
    ],
    tokenAbi: tokenArtifact.abi,
  };
  const outputDir = fileURLToPath(new URL("../../../frontend/public/", import.meta.url));
  await mkdir(outputDir, { recursive: true });
  await writeFile(`${outputDir}/deployment.json`, `${JSON.stringify(deployment, null, 2)}\n`);
  return { ethers, tokenA, tokenB, miniDEX, secondDEX, arbitrage, deployment };
}
