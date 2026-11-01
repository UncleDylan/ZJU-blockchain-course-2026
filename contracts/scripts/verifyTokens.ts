import hre from "hardhat";
import { readFile } from "node:fs/promises";

async function main() {
  const { ethers } = await hre.network.create();
  const deployment = JSON.parse(await readFile(new URL("../../frontend/public/deployment.json", import.meta.url), "utf8"));
  const network = await ethers.provider.getNetwork();
  if (network.chainId !== 31337n || Number(network.chainId) !== deployment.chainId) {
    throw new Error("This verification sends test transactions and only supports the local 31337 chain.");
  }
  const signers = await ethers.getSigners();
  if (signers.length < 4) throw new Error("At least four unlocked local test accounts are required.");
  const users = signers.slice(-3);
  // Use the same JSON-RPC error decoding as the browser's ethers provider.
  const rpc = new ethers.JsonRpcProvider(process.env.LOCAL_RPC_URL ?? "http://127.0.0.1:8545");
  try {
    for (const info of deployment.tokens) {
      const token = await ethers.getContractAt("TestToken", info.address);
      if (await token.symbol() !== info.symbol) throw new Error("Deployment is stale.");
      const amount = await token.FAUCET_AMOUNT();
      for (const user of users) {
        const before = await token.balanceOf(user.address);
        const receipt = await (await token.connect(user).claim()).wait();
        const after = await token.balanceOf(user.address);
        if (after - before !== amount || receipt?.status !== 1) throw new Error("Claim verification failed.");
        let rejected = false;
        const reader = new ethers.Contract(info.address, token.interface, rpc);
        try { await reader.claim.staticCall({ from: user.address }); }
        catch (error) {
          if (ethers.isError(error, "CALL_EXCEPTION") && error.data) {
            rejected = token.interface.parseError(error.data)?.name === "FaucetCooldown";
          }
        }
        if (!rejected) throw new Error("Early repeat claim was not rejected with FaucetCooldown.");
        console.log(JSON.stringify({ token: info.symbol, user: user.address,
          balance: ethers.formatEther(after), transactionHash: receipt.hash, repeatClaimRejected: rejected }));
      }
    }
  } finally { rpc.destroy(); }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
