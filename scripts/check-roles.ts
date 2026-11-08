
import { network } from "hardhat";

const { ethers } = await network.create();

async function main() {
  const [admin] = await ethers.getSigners();

  const token = await ethers.getContractAt(
    "CFDToken",
    "0x5FbDB2315678afecb367f032d93F642f64180aa3"
  );

  const treasury = await ethers.getContractAt(
    "Treasury",
    "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512"
  );

  const crowdfunding = await ethers.getContractAt(
    "Crowdfunding",
    "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0"
  );

  const governance = await ethers.getContractAt(
    "Governance",
    "0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9"
  );

  const minterRole = await token.MINTER_ROLE();
  const treasuryRole = await treasury.CROWDFUNDING_ROLE();
  const governanceRole = await crowdfunding.GOVERNANCE_ROLE();

  console.log("\n--- Vérification des rôles ---");

  console.log(
    "MINTER_ROLE :",
    await token.hasRole(minterRole, await crowdfunding.getAddress())
  );

  console.log(
    "CROWDFUNDING_ROLE :",
    await treasury.hasRole(treasuryRole, await crowdfunding.getAddress())
  );

  console.log(
    "GOVERNANCE_ROLE :",
    await crowdfunding.hasRole(governanceRole, await governance.getAddress())
  );

  console.log(
    "\nAdministrateur :",
    await token.hasRole(await token.DEFAULT_ADMIN_ROLE(), admin.address)
  );
}

main().catch(console.error);
