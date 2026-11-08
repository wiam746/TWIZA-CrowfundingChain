
import { expect } from "chai";
import { network } from "hardhat";

const { ethers } = await network.create();

describe("Treasury", function () {
  async function deployFixture() {
    const [admin, owner1, owner2, owner3, beneficiary, unauthorized] =
      await ethers.getSigners();

    const threshold = ethers.parseEther("1");

    const treasury = await ethers.deployContract("Treasury", [
      [owner1.address, owner2.address, owner3.address],
      admin.address,
      threshold,
    ]);

    const crowdfundingRole = await treasury.CROWDFUNDING_ROLE();

    await treasury.grantRole(crowdfundingRole, admin.address);

    // Dépôt initial pour la campagne 1
    await treasury.connect(admin).depositForCampaign(
      1,
      beneficiary.address,
      owner3.address,
      { value: ethers.parseEther("2") }
    );

    return {
      admin,
      owner1,
      owner2,
      owner3,
      beneficiary,
      unauthorized,
      treasury,
      threshold,
    };
  }

  describe("Deposits", function () {
    it("Should accept deposits from an authorized account", async function () {
      const { treasury, beneficiary } = await deployFixture();

      expect(await treasury.campaignBalances(1)).to.equal(
        ethers.parseEther("2")
      );

      expect(await treasury.campaignBeneficiaries(1)).to.equal(
        beneficiary.address
      );
    });

    it("Should reject deposits from an unauthorized account", async function () {
      const { treasury, beneficiary, unauthorized } =
        await deployFixture();

      await expect(
        treasury.connect(unauthorized).depositForCampaign(
          2,
          beneficiary.address,
          unauthorized.address,
          { value: ethers.parseEther("1") }
        )
      ).to.be.revert(ethers);
    });
  });

  describe("Withdrawal requests", function () {
    it("Should allow an owner to submit a withdrawal request", async function () {
      const { treasury, owner1, beneficiary } = await deployFixture();

      await treasury.connect(owner1).submitCampaignWithdrawal(
        1,
        beneficiary.address,
        ethers.parseEther("0.5")
      );

      expect(await treasury.transactionCount()).to.equal(1n);

      const transaction = await treasury.transactions(1);

      expect(transaction.recipient).to.equal(beneficiary.address);
      expect(transaction.amount).to.equal(ethers.parseEther("0.5"));
      expect(transaction.approvals).to.equal(1n);
      expect(transaction.requiredApprovals).to.equal(1n);
    });

    it("Should reject a withdrawal request from a non-owner", async function () {
      const { treasury, unauthorized, beneficiary } =
        await deployFixture();

      await expect(
        treasury.connect(unauthorized).submitCampaignWithdrawal(
          1,
          beneficiary.address,
          ethers.parseEther("0.5")
        )
      ).to.be.revert(ethers);
    });

    it("Should prevent a campaign creator from managing its Treasury withdrawal", async function () {
      const { treasury, owner1, owner2, owner3, beneficiary } =
        await deployFixture();

      await expect(
        treasury.connect(owner3).submitCampaignWithdrawal(
          1,
          beneficiary.address,
          ethers.parseEther("1.5")
        )
      ).to.be.revert(ethers);

      await treasury.connect(owner1).submitCampaignWithdrawal(
        1,
        beneficiary.address,
        ethers.parseEther("1.5")
      );

      await expect(treasury.connect(owner3).approveTransaction(1)).to.be.revert(
        ethers
      );

      await treasury.connect(owner2).approveTransaction(1);
      await expect(treasury.connect(owner3).executeTransaction(1)).to.be.revert(
        ethers
      );
      await treasury.connect(owner1).executeTransaction(1);

      expect((await treasury.transactions(1)).executed).to.equal(true);
    });
  });

  describe("Multisignature approvals", function () {
    it("Should require two approvals for an amount above the threshold", async function () {
      const { treasury, owner1, owner2, beneficiary } =
        await deployFixture();

      await treasury.connect(owner1).submitCampaignWithdrawal(
        1,
        beneficiary.address,
        ethers.parseEther("1.5")
      );

      expect(await treasury.getRequiredApprovals(1)).to.equal(2n);
      expect((await treasury.transactions(1)).requiredApprovals).to.equal(2n);

      await treasury.connect(owner2).approveTransaction(1);

      const transaction = await treasury.transactions(1);

      expect(transaction.approvals).to.equal(2n);
    });

    it("Should reject a duplicate approval", async function () {
      const { treasury, owner1, beneficiary } = await deployFixture();

      await treasury.connect(owner1).submitCampaignWithdrawal(
        1,
        beneficiary.address,
        ethers.parseEther("1.5")
      );

      await expect(
        treasury.connect(owner1).approveTransaction(1)
      ).to.be.revert(ethers);
    });

    it("Should require two approvals when cumulative requests exceed the threshold", async function () {
      const { treasury, owner1, owner2, beneficiary } = await deployFixture();

      await treasury.connect(owner1).submitCampaignWithdrawal(
        1,
        beneficiary.address,
        ethers.parseEther("0.6")
      );
      await treasury.connect(owner1).submitCampaignWithdrawal(
        1,
        beneficiary.address,
        ethers.parseEther("0.6")
      );

      expect(await treasury.campaignRequested(1)).to.equal(
        ethers.parseEther("1.2")
      );
      expect(await treasury.getRequiredApprovals(1)).to.equal(2n);
      expect(await treasury.getRequiredApprovals(2)).to.equal(2n);

      await expect(
        treasury.connect(owner1).executeTransaction(1)
      ).to.be.revert(ethers);
      await expect(
        treasury.connect(owner1).executeTransaction(2)
      ).to.be.revert(ethers);

      await treasury.connect(owner2).approveTransaction(1);
      await treasury.connect(owner2).approveTransaction(2);
      await treasury.connect(owner1).executeTransaction(1);
      await treasury.connect(owner1).executeTransaction(2);

      expect((await treasury.transactions(1)).executed).to.equal(true);
      expect((await treasury.transactions(2)).executed).to.equal(true);
    });
  });

  describe("Transaction execution", function () {
    it("Should execute a withdrawal after the required approvals", async function () {
      const { treasury, owner1, owner2, beneficiary } =
        await deployFixture();

      const amount = ethers.parseEther("1.5");

      await treasury.connect(owner1).submitCampaignWithdrawal(
        1,
        beneficiary.address,
        amount
      );

      await treasury.connect(owner2).approveTransaction(1);

      await treasury.connect(owner1).executeTransaction(1);

      const transaction = await treasury.transactions(1);

      expect(transaction.executed).to.equal(true);
      expect(await treasury.campaignBalances(1)).to.equal(
        ethers.parseEther("0.5")
      );
    });

    it("Should execute a withdrawal below the threshold with one approval", async function () {
      const { treasury, owner1, beneficiary } = await deployFixture();

      const amount = ethers.parseEther("0.5");

      await treasury.connect(owner1).submitCampaignWithdrawal(
        1,
        beneficiary.address,
        amount
      );

      await treasury.connect(owner1).executeTransaction(1);

      const transaction = await treasury.transactions(1);

      expect(transaction.executed).to.equal(true);
      expect(await treasury.campaignBalances(1)).to.equal(
        ethers.parseEther("1.5")
      );
    });
  });
});
