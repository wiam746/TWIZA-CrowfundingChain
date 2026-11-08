
import { expect } from "chai";
import { network } from "hardhat";

const { ethers } = await network.create();

describe("Crowdfunding Integration", function () {

  it("Should execute the complete crowdfunding and DAO workflow", async function () {

    // 1. Préparation des comptes
    const [
      admin,
      owner1,
      owner2,
      owner3,
      creator,
      beneficiary,
      voter1,
      voter2,
    ] = await ethers.getSigners();

    const goal = ethers.parseEther("2");
    const contribution = ethers.parseEther("1");
    const withdrawalAmount = ethers.parseEther("1.5");

    // 2. Déploiement du token
    const token = await ethers.deployContract("CFDToken", [
      admin.address,
    ]);

    // 3. Déploiement de la trésorerie
    const treasury = await ethers.deployContract("Treasury", [
      [owner1.address, owner2.address, owner3.address],
      admin.address,
      ethers.parseEther("1"),
    ]);

    // 4. Déploiement du crowdfunding
    const crowdfunding = await ethers.deployContract("Crowdfunding", [
      await token.getAddress(),
      await treasury.getAddress(),
      admin.address,
    ]);

    // 5. Déploiement de la gouvernance
    const governance = await ethers.deployContract("Governance", [
      await token.getAddress(),
      await crowdfunding.getAddress(),
    ]);

    // 6. Attribution des rôles
    await token.grantRole(
      await token.MINTER_ROLE(),
      await crowdfunding.getAddress()
    );

    await treasury.grantRole(
      await treasury.CROWDFUNDING_ROLE(),
      await crowdfunding.getAddress()
    );

    await crowdfunding.grantRole(
      await crowdfunding.GOVERNANCE_ROLE(),
      await governance.getAddress()
    );

    // 7. Création d'une campagne
    await crowdfunding.connect(creator).createCampaign(
      goal,
      3600,
      beneficiary.address,
      "QmIntegrationTest"
    );

    expect(await crowdfunding.campaignCount()).to.equal(1n);

    // 8. Contributions des deux participants
    await crowdfunding.connect(voter1).contribute(1, {
      value: contribution,
    });

    await crowdfunding.connect(voter2).contribute(1, {
      value: contribution,
    });

    const campaignAfterContributions =
      await crowdfunding.getCampaign(1);

    expect(campaignAfterContributions.raised).to.equal(goal);

    expect(await token.balanceOf(voter1.address)).to.equal(
      ethers.parseEther("100")
    );

    expect(await token.balanceOf(voter2.address)).to.equal(
      ethers.parseEther("100")
    );

    // 9. Création d'une proposition DAO
    await governance.connect(voter1).createProposal(
      1,
      0 // ApproveWithdrawal
    );

    const proposalId = await governance.proposalCount();

    const proposal = await governance.getProposal(proposalId);

    expect(proposal.campaignId).to.equal(1n);
    expect(proposal.proposer).to.equal(voter1.address);

    // 10. Début de la période de vote
    await ethers.provider.send("evm_mine", []);
    await ethers.provider.send("evm_mine", []);

    // 11. Votes des participants
    await governance.connect(voter1).castVote(proposalId, true);
    await governance.connect(voter2).castVote(proposalId, true);

    const proposalAfterVoting =
      await governance.getProposal(proposalId);

    expect(proposalAfterVoting.forVotes).to.equal(
      ethers.parseEther("200")
    );

    // 12. Attendre la fin de la période de vote
    for (let i = 0; i < 22; i++) {
      await ethers.provider.send("evm_mine", []);
    }

    // 13. Exécution et approbation de la proposition
    await governance.executeProposal(proposalId);

    const campaignAfterApproval =
      await crowdfunding.getCampaign(1);

    expect(campaignAfterApproval.withdrawalApproved).to.equal(true);

    // 14. Transfert des fonds vers la trésorerie
    await crowdfunding.connect(beneficiary).withdrawFunds(1);

    expect(await treasury.campaignBalances(1)).to.equal(goal);

    // 15. Création d'une demande de retrait multisignature
    const beneficiaryBalanceBefore =
      await ethers.provider.getBalance(beneficiary.address);

    await treasury.connect(owner1).submitCampaignWithdrawal(
      1,
      beneficiary.address,
      withdrawalAmount
    );

    expect(await treasury.getRequiredApprovals(1)).to.equal(2n);

    // 16. Deuxième signature
    await treasury.connect(owner2).approveTransaction(1);

    const transactionAfterApproval =
      await treasury.transactions(1);

    expect(transactionAfterApproval.approvals).to.equal(2n);

    // 17. Exécution du paiement
    await treasury.connect(owner1).executeTransaction(1);

    const transactionAfterExecution =
      await treasury.transactions(1);

    expect(transactionAfterExecution.executed).to.equal(true);

    // 18. Vérifications finales
    const beneficiaryBalanceAfter =
      await ethers.provider.getBalance(beneficiary.address);

    expect(
      beneficiaryBalanceAfter - beneficiaryBalanceBefore
    ).to.equal(withdrawalAmount);

    expect(await treasury.campaignBalances(1)).to.equal(
      ethers.parseEther("0.5")
    );

    console.log("Integration test completed successfully!");
  });

});
