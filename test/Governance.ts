
import { expect } from "chai";
import { network } from "hardhat";

const { ethers } = await network.create();

describe("Governance", function () {
  async function deployFixture() {
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

    // Déploiement du token
    const token = await ethers.deployContract("CFDToken", [admin.address]);

    // Déploiement de la trésorerie
    const treasury = await ethers.deployContract("Treasury", [
      [owner1.address, owner2.address, owner3.address],
      admin.address,
      ethers.parseEther("1"),
    ]);

    // Déploiement du crowdfunding
    const crowdfunding = await ethers.deployContract("Crowdfunding", [
      await token.getAddress(),
      await treasury.getAddress(),
      admin.address,
    ]);

    // Déploiement de la gouvernance
    const governance = await ethers.deployContract("Governance", [
      await token.getAddress(),
      await crowdfunding.getAddress(),
    ]);

    // Attribution des rôles
    const minterRole = await token.MINTER_ROLE();
    const treasuryRole = await treasury.CROWDFUNDING_ROLE();
    const governanceRole = await crowdfunding.GOVERNANCE_ROLE();

    await token.grantRole(minterRole, await crowdfunding.getAddress());

    await treasury.grantRole(
      treasuryRole,
      await crowdfunding.getAddress()
    );

    await crowdfunding.grantRole(
      governanceRole,
      await governance.getAddress()
    );

    // Création d'une campagne réussie
    const goal = ethers.parseEther("1");

    await crowdfunding.connect(creator).createCampaign(
      goal,
      3600,
      beneficiary.address,
      "QmGovernanceTest"
    );

    await crowdfunding.connect(voter1).contribute(1, {
      value: ethers.parseEther("1"),
    });

    // Donner également du pouvoir de vote au deuxième votant
    await crowdfunding.connect(creator).createCampaign(
      ethers.parseEther("10"),
      3600,
      beneficiary.address,
      "QmSecondCampaign"
    );

    await crowdfunding.connect(voter2).contribute(2, {
      value: ethers.parseEther("1"),
    });

    return {
      admin,
      creator,
      beneficiary,
      voter1,
      voter2,
      token,
      crowdfunding,
      governance,
    };
  }

  async function createProposal(governance: any, voter: any) {
    const tx = await governance.connect(voter).createProposal(
      1,
      0 // ApproveWithdrawal
    );
    await tx.wait();

    return await governance.proposalCount();
  }

  async function startVoting(governance: any) {
    // Avancer jusqu'au début de la période de vote
    await ethers.provider.send("evm_mine", []);
    await ethers.provider.send("evm_mine", []);
  }

  describe("Proposal creation", function () {
    it("Should create a proposal with the correct information", async function () {
      const { governance, voter1 } = await deployFixture();

      const proposalId = await createProposal(governance, voter1);
      const proposal = await governance.getProposal(proposalId);

      expect(proposal.campaignId).to.equal(1n);
      expect(proposal.proposer).to.equal(voter1.address);
      expect(proposal.proposalType).to.equal(0n);
    });

    it("Should reject a proposal from an account without voting power", async function () {
      const { governance, admin } = await deployFixture();

      await expect(
        governance.connect(admin).createProposal(1, 0)
      ).to.be.revert(ethers);
    });

    it("Should reject a withdrawal proposal for an active campaign", async function () {
      const { governance, voter2 } = await deployFixture();

      await expect(
        governance.connect(voter2).createProposal(2, 0)
      ).to.be.revert(ethers);
    });

    it("Should prevent a campaign creator from proposing or voting to approve its withdrawal", async function () {
      const { governance, crowdfunding, creator, voter1 } =
        await deployFixture();

      await crowdfunding.connect(creator).createCampaign(
        ethers.parseEther("1"),
        3600,
        voter1.address,
        "QmCreatorCampaign"
      );
      await crowdfunding.connect(creator).contribute(3, {
        value: ethers.parseEther("1"),
      });

      await expect(
        governance.connect(creator).createProposal(3, 0)
      ).to.be.revert(ethers);

      await governance.connect(voter1).createProposal(3, 0);
      const proposalId = await governance.proposalCount();
      await startVoting(governance);

      await expect(
        governance.connect(creator).castVote(proposalId, true)
      ).to.be.revert(ethers);
    });
  });

  describe("Voting", function () {
    it("Should record votes using CFD token voting power", async function () {
      const { governance, voter1, voter2 } = await deployFixture();

      const proposalId = await createProposal(governance, voter1);

      await startVoting(governance);

      await governance.connect(voter1).castVote(proposalId, true);
      await governance.connect(voter2).castVote(proposalId, true);

      const proposal = await governance.getProposal(proposalId);

      expect(proposal.forVotes).to.equal(
        ethers.parseEther("200")
      );
      expect(await governance.hasVoted(proposalId, voter1.address)).to.equal(
        true
      );
    });

    it("Should reject a second vote from the same account", async function () {
      const { governance, voter1 } = await deployFixture();

      const proposalId = await createProposal(governance, voter1);

      await startVoting(governance);

      await governance.connect(voter1).castVote(proposalId, true);

      await expect(
        governance.connect(voter1).castVote(proposalId, false)
      ).to.be.revert(ethers);
    });
  });

  describe("Quorum and execution", function () {
    it("Should calculate the quorum correctly", async function () {
      const { governance, crowdfunding, voter1, voter2 } = await deployFixture();

      const proposalId = await createProposal(governance, voter1);

      expect(await governance.quorum(proposalId)).to.equal(
        ethers.parseEther("40")
      );

      await crowdfunding.connect(voter2).contribute(2, {
        value: ethers.parseEther("100"),
      });
      expect(await governance.quorum(proposalId)).to.equal(
        ethers.parseEther("40")
      );
    });

    it("Should execute an approved withdrawal proposal", async function () {
      const { governance, crowdfunding, voter1, beneficiary } =
        await deployFixture();

      const proposalId = await createProposal(governance, voter1);

      await startVoting(governance);

      await governance.connect(voter1).castVote(proposalId, true);

      // Attendre la fin de la période de vote
      for (let i = 0; i < 22; i++) {
        await ethers.provider.send("evm_mine", []);
      }

      await governance.executeProposal(proposalId);

      const campaign = await crowdfunding.getCampaign(1);

      expect(campaign.withdrawalApproved).to.equal(true);
      expect(campaign.withdrawn).to.equal(false);
    });

    it("Should execute an eligible proposal through upkeep", async function () {
      const { governance, crowdfunding, voter1 } = await deployFixture();

      const proposalId = await createProposal(governance, voter1);
      await startVoting(governance);
      await governance.connect(voter1).castVote(proposalId, true);

      const [upkeepBeforeVotingEnds] = await governance.checkUpkeep("0x");
      expect(upkeepBeforeVotingEnds).to.equal(false);

      for (let i = 0; i < 22; i++) {
        await ethers.provider.send("evm_mine", []);
      }

      const [upkeepNeeded, performData] = await governance.checkUpkeep("0x");
      expect(upkeepNeeded).to.equal(true);
      expect(ethers.AbiCoder.defaultAbiCoder().decode(["uint256"], performData)[0])
        .to.equal(proposalId);

      await governance.performUpkeep(performData);
      expect((await crowdfunding.getCampaign(1)).withdrawalApproved).to.equal(
        true
      );
    });
  });
});
