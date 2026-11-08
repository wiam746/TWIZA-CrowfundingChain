
import { network } from "hardhat";

const { ethers } = await network.create();

async function main() {
  const signers = await ethers.getSigners();
  const admin = signers[0];
  if (!admin) {
    throw new Error("Aucun compte de déploiement n'est disponible");
  }

  console.log("Deploying with:", admin.address);
  const adminBalance = await ethers.provider.getBalance(admin.address);
  console.log("Balance:", ethers.formatEther(adminBalance), "ETH");
  console.log("Network chain ID:", (await ethers.provider.getNetwork()).chainId);

  if (process.env.CHECK_DEPLOYER_ONLY === "true") {
    console.log("Vérification seule : aucun contrat ne sera déployé.");
    return;
  }

  const configuredOwners =
    signers.length >= 4
      ? [signers[1].address, signers[2].address, signers[3].address]
      : [
          process.env.OWNER1 ?? "",
          process.env.OWNER2 ?? "",
          process.env.OWNER3 ?? "",
        ];

  if (configuredOwners.some((owner) => !ethers.isAddress(owner))) {
    throw new Error(
      "OWNER1, OWNER2 et OWNER3 doivent être des adresses valides"
    );
  }
  if (
    new Set(configuredOwners.map((owner) => owner.toLowerCase())).size !== 3
  ) {
    throw new Error("Les trois propriétaires doivent être distincts");
  }
  const owners = configuredOwners.map((owner) => ethers.getAddress(owner));
  const threshold = ethers.parseEther(process.env.THRESHOLD_ETH ?? "0.01");

  console.log("Déploiement des contrats...\n");

  // 1. Déploiement de CFDToken
  const token = await ethers.deployContract("CFDToken", [
    admin.address,
  ]);
  await token.waitForDeployment();

  console.log("CFDToken :", await token.getAddress());

  // 2. Déploiement de Treasury
  const treasury = await ethers.deployContract("Treasury", [
    owners,
    admin.address,
    threshold,
  ]);
  await treasury.waitForDeployment();

  console.log("Treasury :", await treasury.getAddress());

  // 3. Déploiement de Crowdfunding
  const crowdfunding = await ethers.deployContract("Crowdfunding", [
    await token.getAddress(),
    await treasury.getAddress(),
    admin.address,
  ]);
  await crowdfunding.waitForDeployment();

  console.log("Crowdfunding :", await crowdfunding.getAddress());

  // 4. Déploiement de Governance
  const governance = await ethers.deployContract("Governance", [
    await token.getAddress(),
    await crowdfunding.getAddress(),
  ]);
  await governance.waitForDeployment();

  console.log("Governance :", await governance.getAddress());

  // 5. Attribution des rôles
  const minterRole = await token.MINTER_ROLE();
  const treasuryRole = await treasury.CROWDFUNDING_ROLE();
  const governanceRole = await crowdfunding.GOVERNANCE_ROLE();

  await token.grantRole(
    minterRole,
    await crowdfunding.getAddress()
  );

  await treasury.grantRole(
    treasuryRole,
    await crowdfunding.getAddress()
  );

  await crowdfunding.grantRole(
    governanceRole,
    await governance.getAddress()
  );

  console.log("\nRôles attribués avec succès.");
  
  // Sécurisation : l'administrateur renonce à DEFAULT_ADMIN_ROLE sur les trois contrats.
  // Sans cela, il pourrait s'attribuer MINTER_ROLE (frapper des CFD à volonté) ou        GOVERNANCE_ROLE
  // (débloquer ou geler des campagnes) et contourner entièrement la DAO.
  // Il conserve uniquement PAUSER_ROLE (circuit breaker) sur Crowdfunding et Treasury.
  await (await token.renounceRole(await token.DEFAULT_ADMIN_ROLE(), admin.address)).wait();
  await (await crowdfunding.renounceRole(await crowdfunding.DEFAULT_ADMIN_ROLE(), admin.address)).wait();
  await (await treasury.renounceRole(await treasury.DEFAULT_ADMIN_ROLE(), admin.address)).wait();

  console.log("Droits d'administration retirés : plus aucun compte ne peut attribuer de rôles.");

  console.log("\nAdministrateur :", admin.address);
  console.log("Propriétaire 1 :", owners[0]);
  console.log("Propriétaire 2 :", owners[1]);
  console.log("Propriétaire 3 :", owners[2]);
  console.log("Seuil multisig :", ethers.formatEther(threshold), "ETH");

  console.log("\nDéploiement terminé avec succès !");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
