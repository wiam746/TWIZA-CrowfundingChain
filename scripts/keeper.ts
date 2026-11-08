import { network } from "hardhat";

const LOCAL_GOVERNANCE_ADDRESS =
  "0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9";
const POLL_INTERVAL_MS = Number(process.env.KEEPER_POLL_INTERVAL_MS ?? 5_000);

async function main() {
  const governanceAddress = process.env.GOVERNANCE_ADDRESS
    ? process.env.GOVERNANCE_ADDRESS
    : LOCAL_GOVERNANCE_ADDRESS;

  if (!Number.isSafeInteger(POLL_INTERVAL_MS) || POLL_INTERVAL_MS <= 0) {
    throw new Error("KEEPER_POLL_INTERVAL_MS must be a positive integer");
  }

  const { ethers } = await network.create();
  const governance = await ethers.getContractAt(
    "Governance",
    ethers.getAddress(governanceAddress)
  );
  const code = await ethers.provider.getCode(governanceAddress);
  if (code === "0x") {
    throw new Error(`No Governance contract found at ${governanceAddress}`);
  }

  console.log(`Watching Governance at ${governanceAddress}`);
  console.log(`Polling every ${POLL_INTERVAL_MS} ms; press Ctrl+C to stop.`);

  while (true) {
    try {
      const [upkeepNeeded, performData] =
        await governance.checkUpkeep("0x");

      if (upkeepNeeded) {
        const tx = await governance.performUpkeep(performData);
        console.log(`Submitted upkeep transaction: ${tx.hash}`);
        const receipt = await tx.wait();
        if (!receipt || receipt.status !== 1) {
          throw new Error(`Upkeep transaction failed: ${tx.hash}`);
        }
        console.log(`Upkeep confirmed: ${tx.hash}`);
      }
    } catch (error) {
      console.error("Keeper : erreur, nouvelle tentative", error);
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

main().catch((error: unknown) => {
  console.error("Keeper stopped:", error);
  process.exitCode = 1;
});
