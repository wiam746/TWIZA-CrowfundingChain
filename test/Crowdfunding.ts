
import { expect } from "chai";
import { network } from "hardhat";

const { ethers } = await network.create();

describe("Crowdfunding", function () {
  async function deployFixture() {
    const [
      admin,
      owner1,
      owner2,
      owner3,
      creator,
      beneficiary,
      contributor,
    ] = await ethers.getSigners();

    // Déploiement du token
    const Token = await ethers.getContractFactory("CFDToken");
    const token = await Token.deploy(admin.address);
    await token.waitForDeployment();

    // Déploiement de la trésorerie
    const Treasury = await ethers.getContractFactory("Treasury");
    const treasury = await Treasury.deploy(
      [owner1.address, owner2.address, owner3.address],
      admin.address,
      ethers.parseEther("1")
    );
    await treasury.waitForDeployment();

    // Déploiement du crowdfunding
    const Crowdfunding = await ethers.getContractFactory("Crowdfunding");
    const crowdfunding = await Crowdfunding.deploy(
      await token.getAddress(),
      await treasury.getAddress(),
      admin.address
    );
    await crowdfunding.waitForDeployment();

    // Attribution des rôles nécessaires
    const minterRole = ethers.keccak256(
      ethers.toUtf8Bytes("MINTER_ROLE")
    );

    const treasuryRole = ethers.keccak256(
      ethers.toUtf8Bytes("CROWDFUNDING_ROLE")
    );

    const governanceRole = ethers.keccak256(
      ethers.toUtf8Bytes("GOVERNANCE_ROLE")
    );

    await token.grantRole(minterRole, await crowdfunding.getAddress());

    await treasury.grantRole(
      treasuryRole,
      await crowdfunding.getAddress()
    );

    await crowdfunding.grantRole(governanceRole, admin.address);

    return {
      admin,
      creator,
      beneficiary,
      contributor,
      token,
      treasury,
      crowdfunding,
    };
  }

  describe("Campaign creation", function () {
    it("Should create a campaign successfully", async function () {
      const { crowdfunding, creator, beneficiary } =
        await deployFixture();

      await crowdfunding.connect(creator).createCampaign(
        ethers.parseEther("1"),
        3600,
        beneficiary.address,
        "QmTestHash"
      );

      expect(await crowdfunding.campaignCount()).to.equal(1n);

      const campaign = await crowdfunding.getCampaign(1);

      expect(campaign.creator).to.equal(creator.address);
      expect(campaign.beneficiary).to.equal(beneficiary.address);
      expect(campaign.goal).to.equal(ethers.parseEther("1"));
    });

    it("Should reject a campaign with a zero goal", async function () {
      const { crowdfunding, creator, beneficiary } =
        await deployFixture();

      await expect(
        crowdfunding.connect(creator).createCampaign(
          0,
          3600,
          beneficiary.address,
          "QmTestHash"
        )
      ).to.be.revert(ethers);
    });

    it("Should return the campaign state", async function () {
      const { crowdfunding, creator, beneficiary } =
        await deployFixture();

      await crowdfunding.connect(creator).createCampaign(
        ethers.parseEther("1"),
        3600,
        beneficiary.address,
        "QmTestHash"
      );

      const [status, frozen, withdrawalApproved, withdrawn] =
        await crowdfunding.campaignState(1);

      expect(status).to.equal(0n);
      expect(frozen).to.equal(false);
      expect(withdrawalApproved).to.equal(false);
      expect(withdrawn).to.equal(false);
      await expect(crowdfunding.campaignState(0)).to.be.revert(ethers);
    });
  });

  describe("Contributions", function () {
    it("Should accept contributions and mint CFD tokens", async function () {
      const { crowdfunding, creator, beneficiary, contributor, token } =
        await deployFixture();

      const amount = ethers.parseEther("1");

      await crowdfunding.connect(creator).createCampaign(
        amount,
        3600,
        beneficiary.address,
        "QmTestHash"
      );

      await crowdfunding.connect(contributor).contribute(1, {
        value: amount,
      });

      const campaign = await crowdfunding.getCampaign(1);

      expect(campaign.raised).to.equal(amount);
      expect(campaign.status).to.equal(1n);
      expect(await token.balanceOf(contributor.address)).to.equal(
        amount * 100n
      );
    });
  });

  describe("Refunds", function () {
    it("Should refund a contribution to a failed campaign", async function () {
      const { crowdfunding, creator, beneficiary, contributor, token } =
        await deployFixture();

      const amount = ethers.parseEther("1");
      const tokensToBurn = amount * 100n;

      await crowdfunding.connect(creator).createCampaign(
        ethers.parseEther("2"),
        60,
        beneficiary.address,
        "QmTestHash"
      );

      await crowdfunding.connect(contributor).contribute(1, {
        value: amount,
      });

      // Attendre la fin de la campagne
      await ethers.provider.send("evm_increaseTime", [61]);
      await ethers.provider.send("evm_mine", []);

      await crowdfunding.finalizeCampaign(1);

      // Autoriser le crowdfunding à brûler les tokens du contributeur
      await token.connect(contributor).approve(
        await crowdfunding.getAddress(),
        tokensToBurn
      );

      await crowdfunding.connect(contributor).refund(1);

      expect(await token.balanceOf(contributor.address)).to.equal(0n);
      expect(await crowdfunding.refunded(1, contributor.address)).to.equal(
        true
      );
    });
  });

  describe("Withdrawals", function () {
    it("Should transfer successful campaign funds to the treasury", async function () {
      const { admin, crowdfunding, creator, beneficiary, contributor, treasury } =
        await deployFixture();

      const amount = ethers.parseEther("1");

      await crowdfunding.connect(creator).createCampaign(
        amount,
        3600,
        beneficiary.address,
        "QmTestHash"
      );

      await crowdfunding.connect(contributor).contribute(1, {
        value: amount,
      });

      await crowdfunding.connect(admin).approveWithdrawal(1);

      await crowdfunding.connect(beneficiary).withdrawFunds(1);

      expect(await treasury.campaignBalances(1)).to.equal(amount);
    });
  });
});
