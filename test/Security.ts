import { expect } from "chai";
import { network } from "hardhat";

const { ethers } = await network.create();

/**
 * Tests de sécurité exigés par la section 5 du sujet :
 *  - anti-reentrance (attaque simulée + preuve d'échec)
 *  - anti-manipulation de la gouvernance (snapshot)
 *  - contrôle d'accès et circuit breaker
 *  - gel d'une campagne par la DAO
 */
describe("Security", function () {
  async function deployAll() {
    const [admin, owner1, owner2, owner3, creator, beneficiary, voter1, voter2, attacker, outsider] =
      await ethers.getSigners();

    const token = await ethers.deployContract("CFDToken", [admin.address]);
    const treasury = await ethers.deployContract("Treasury", [
      [owner1.address, owner2.address, owner3.address],
      admin.address,
      ethers.parseEther("1"),
    ]);
    const crowdfunding = await ethers.deployContract("Crowdfunding", [
      await token.getAddress(),
      await treasury.getAddress(),
      admin.address,
    ]);
    const governance = await ethers.deployContract("Governance", [
      await token.getAddress(),
      await crowdfunding.getAddress(),
    ]);

    await token.grantRole(await token.MINTER_ROLE(), await crowdfunding.getAddress());
    await treasury.grantRole(await treasury.CROWDFUNDING_ROLE(), await crowdfunding.getAddress());
    await crowdfunding.grantRole(await crowdfunding.GOVERNANCE_ROLE(), await governance.getAddress());

    // Campagne 1 : objectif 1 ETH, atteint par voter1 (100 CFD)
    await crowdfunding.connect(creator).createCampaign(ethers.parseEther("1"), 3600, beneficiary.address, "QmSec1");
    await crowdfunding.connect(voter1).contribute(1, { value: ethers.parseEther("1") });
    // Campagne 2 : objectif 10 ETH, voter2 apporte 1 ETH (100 CFD)
    await crowdfunding.connect(creator).createCampaign(ethers.parseEther("10"), 3600, beneficiary.address, "QmSec2");
    await crowdfunding.connect(voter2).contribute(2, { value: ethers.parseEther("1") });

    return { admin, owner1, creator, beneficiary, voter1, voter2, attacker, outsider, token, treasury, crowdfunding, governance };
  }

  async function mine(n: number) {
    for (let i = 0; i < n; i++) await ethers.provider.send("evm_mine", []);
  }

  async function increaseTime(seconds: number) {
    await ethers.provider.send("evm_increaseTime", [seconds]);
    await ethers.provider.send("evm_mine", []);
  }

  // Proposition -> vote -> fin de la période -> exécution
  async function passProposal(governance: any, proposer: any, voters: any[], campaignId: number, type: number) {
    await governance.connect(proposer).createProposal(campaignId, type);
    const id = await governance.proposalCount();
    await mine(2); // VOTING_DELAY
    for (const v of voters) await governance.connect(v).castVote(id, true);
    await mine(22); // VOTING_PERIOD
    await governance.executeProposal(id);
    return id;
  }

  describe("Reentrancy protection", function () {
    it("CONTRAST: a vulnerable vault is drained by the attacker", async function () {
      const { voter1, attacker } = await deployAll();

      const bank = await ethers.deployContract("VulnerableBank");
      const evil = await ethers.deployContract("ReentrancyAttacker");

      await bank.connect(voter1).deposit({ value: ethers.parseEther("5") }); // fonds de la victime
      await evil.connect(attacker).attackBank(await bank.getAddress(), { value: ethers.parseEther("1") });

      expect(await ethers.provider.getBalance(await bank.getAddress())).to.equal(0n); // tout est volé
      expect(await ethers.provider.getBalance(await evil.getAddress())).to.equal(ethers.parseEther("6"));
    });

    it("Crowdfunding.refund() rejects the re-entrant call and the attacker only recovers its own money", async function () {
      const { creator, beneficiary, voter1, voter2, token, crowdfunding } = await deployAll();

      // Campagne 3 : objectif inatteignable ; deux victimes + l'attaquant (contrat) contribuent 1 ETH chacun
      await crowdfunding
        .connect(creator)
        .createCampaign(ethers.parseEther("100"), 60, beneficiary.address, "QmAttack");
      await crowdfunding.connect(voter1).contribute(3, { value: ethers.parseEther("1") });
      await crowdfunding.connect(voter2).contribute(3, { value: ethers.parseEther("1") });

      const evil = await ethers.deployContract("ReentrancyAttacker");
      const evilAddr = await evil.getAddress();
      const cfAddr = await crowdfunding.getAddress();

      await evil.contributeTo(cfAddr, 3, { value: ethers.parseEther("1") });
      await evil.approveBurn(await token.getAddress(), cfAddr, ethers.parseEther("100"));

      await increaseTime(61);
      await crowdfunding.finalizeCampaign(3); // Échouée

      const cfBefore = await ethers.provider.getBalance(cfAddr);
      await evil.attackRefund(cfAddr, 3);

      expect(await evil.reentrancyAttempts()).to.equal(1n); // il a tenté de ré-entrer...
      expect(await evil.reentrancyBlocked()).to.equal(1n); // ...et le contrat a rejeté l'appel
      expect(await ethers.provider.getBalance(evilAddr)).to.equal(ethers.parseEther("1")); // sa mise, rien de plus
      expect(cfBefore - (await ethers.provider.getBalance(cfAddr))).to.equal(ethers.parseEther("1"));
      expect(await crowdfunding.contributions(3, evilAddr)).to.equal(0n);
      expect(await crowdfunding.refunded(3, evilAddr)).to.equal(true);
    });
  });

  describe("Governance snapshot (anti flash-takeover)", function () {
    it("CFD obtained AFTER the proposal creation have no voting power", async function () {
      const { voter1, attacker, token, crowdfunding, governance } = await deployAll();

      await governance.connect(voter1).createProposal(1, 0);
      const id = await governance.proposalCount();

      // L'attaquant contribue 100 ETH (= 10 000 CFD, 50x toute l'offre) APRÈS la création de la proposition
      await crowdfunding.connect(attacker).contribute(2, { value: ethers.parseEther("100") });
      expect(await token.getVotes(attacker.address)).to.equal(ethers.parseEther("10000")); // pouvoir courant énorme...

      await mine(2);
      await expect(governance.connect(attacker).castVote(id, false)).to.be.revert(ethers); // ...mais nul au snapshot

      const p = await governance.getProposal(id);
      expect(p.againstVotes).to.equal(0n);
      expect(await governance.hasVoted(id, attacker.address)).to.equal(false);
    });

    it("tokens transferred after the proposal give no extra vote and cannot be counted twice", async function () {
      const { voter1, attacker, token, governance } = await deployAll();

      await governance.connect(voter1).createProposal(1, 0);
      const id = await governance.proposalCount();

      // voter1 « vend » tous ses CFD à l'attaquant après la création de la proposition
      await token.connect(voter1).transfer(attacker.address, ethers.parseEther("100"));
      await token.connect(attacker).delegate(attacker.address);
      expect(await token.getVotes(attacker.address)).to.equal(ethers.parseEther("100"));

      await mine(2);
      await expect(governance.connect(attacker).castVote(id, false)).to.be.revert(ethers);

      // voter1 vote avec son pouvoir figé au snapshot : une seule fois, 100 CFD
      await governance.connect(voter1).castVote(id, true);
      const p = await governance.getProposal(id);
      expect(p.forVotes).to.equal(ethers.parseEther("100"));
      expect(p.againstVotes).to.equal(0n);
    });

    it("an account without CFD at the snapshot cannot create a proposal", async function () {
      const { outsider, governance } = await deployAll();
      await expect(governance.connect(outsider).createProposal(1, 0)).to.be.revert(ethers);
    });

    it("voting is impossible after the voting period", async function () {
      const { voter1, governance } = await deployAll();
      await governance.connect(voter1).createProposal(1, 0);
      const id = await governance.proposalCount();

      await mine(2);
      await mine(25); // au-delà de endBlock (début + 20 blocs)
      await expect(governance.connect(voter1).castVote(id, true)).to.be.revert(ethers);
    });

    it("a proposal that fails the quorum or the majority cannot be executed", async function () {
      const { voter1, voter2, governance } = await deployAll();
      await governance.connect(voter1).createProposal(1, 0);
      const id = await governance.proposalCount();
      await mine(2);
      await governance.connect(voter1).castVote(id, false); // 100 contre
      await governance.connect(voter2).castVote(id, true); // 100 pour : égalité => rejetée
      await mine(22);
      await expect(governance.executeProposal(id)).to.be.revert(ethers);
    });
  });

  describe("Access control", function () {
    it("approveWithdrawal and freezeCampaign are reserved to the Governance role", async function () {
      const { outsider, admin, crowdfunding } = await deployAll();
      await expect(crowdfunding.connect(outsider).approveWithdrawal(1)).to.be.revert(ethers);
      await expect(crowdfunding.connect(outsider).freezeCampaign(1)).to.be.revert(ethers);
      // l'admin n'a pas non plus le droit de débloquer : seule la DAO le peut
      await expect(crowdfunding.connect(admin).approveWithdrawal(1)).to.be.revert(ethers);
    });

    it("only the beneficiary can withdraw, and only after the DAO approval", async function () {
      const { beneficiary, outsider, voter1, crowdfunding, governance } = await deployAll();
      await expect(crowdfunding.connect(beneficiary).withdrawFunds(1)).to.be.revert(ethers); // pas encore approuvé

      await passProposal(governance, voter1, [voter1], 1, 0);

      await expect(crowdfunding.connect(outsider).withdrawFunds(1)).to.be.revert(ethers);
      await crowdfunding.connect(beneficiary).withdrawFunds(1);
      await expect(crowdfunding.connect(beneficiary).withdrawFunds(1)).to.be.revert(ethers); // une seule fois
    });

    it("only the Crowdfunding contract can mint CFD", async function () {
      const { outsider, token } = await deployAll();
      await expect(token.connect(outsider).mint(outsider.address, 1n)).to.be.revert(ethers);
    });

    it("KNOWN RISK: while the admin keeps DEFAULT_ADMIN_ROLE, it can bypass the DAO", async function () {
      const { admin, crowdfunding } = await deployAll();
      await crowdfunding.connect(admin).grantRole(await crowdfunding.GOVERNANCE_ROLE(), admin.address);
      await crowdfunding.connect(admin).approveWithdrawal(1); // contournement de la gouvernance
      expect((await crowdfunding.getCampaign(1)).withdrawalApproved).to.equal(true);
    });

    it("MITIGATION: after the admin renounces DEFAULT_ADMIN_ROLE, nobody can grant roles anymore", async function () {
      const { admin, outsider, crowdfunding, token } = await deployAll();
      const adminRole = await crowdfunding.DEFAULT_ADMIN_ROLE();
      await crowdfunding.connect(admin).renounceRole(adminRole, admin.address);
      await token.connect(admin).renounceRole(await token.DEFAULT_ADMIN_ROLE(), admin.address);

      await expect(
        crowdfunding.connect(admin).grantRole(await crowdfunding.GOVERNANCE_ROLE(), admin.address)
      ).to.be.revert(ethers);
      await expect(token.connect(admin).grantRole(await token.MINTER_ROLE(), admin.address)).to.be.revert(ethers);
      await expect(
        crowdfunding.connect(outsider).grantRole(await crowdfunding.GOVERNANCE_ROLE(), outsider.address)
      ).to.be.revert(ethers);

      // Le circuit breaker reste utilisable grâce au PAUSER_ROLE séparé
      await crowdfunding.connect(admin).pause();
      expect(await crowdfunding.paused()).to.equal(true);
      await crowdfunding.connect(admin).unpause();
      expect(await crowdfunding.paused()).to.equal(false);
    });
  });

  describe("Circuit breaker (Pausable)", function () {
    it("only the admin can pause and unpause", async function () {
      const { admin, outsider, crowdfunding } = await deployAll();
      await expect(crowdfunding.connect(outsider).pause()).to.be.revert(ethers);
      await crowdfunding.connect(admin).pause();
      expect(await crowdfunding.paused()).to.equal(true);
      await expect(crowdfunding.connect(outsider).unpause()).to.be.revert(ethers);
      await crowdfunding.connect(admin).unpause();
      expect(await crowdfunding.paused()).to.equal(false);
    });

    it("pause suspends creation, contributions, refunds and withdrawals, then service resumes", async function () {
      const { admin, creator, beneficiary, voter1, voter2, token, crowdfunding, governance } = await deployAll();

      await passProposal(governance, voter1, [voter1], 1, 0); // campagne 1 : retrait approuvé

      // campagne 3 qui va échouer, pour tester le remboursement
      await crowdfunding
        .connect(creator)
        .createCampaign(ethers.parseEther("50"), 60, beneficiary.address, "QmPause");
      await crowdfunding.connect(voter2).contribute(3, { value: ethers.parseEther("1") });
      await increaseTime(61);
      await crowdfunding.finalizeCampaign(3);
      await token.connect(voter2).approve(await crowdfunding.getAddress(), ethers.parseEther("1000"));

      await crowdfunding.connect(admin).pause();

      await expect(
        crowdfunding.connect(creator).createCampaign(ethers.parseEther("1"), 3600, beneficiary.address, "Qm")
      ).to.be.revert(ethers);
      await expect(crowdfunding.connect(voter2).contribute(2, { value: 1n })).to.be.revert(ethers);
      await expect(crowdfunding.connect(voter2).refund(3)).to.be.revert(ethers);
      await expect(crowdfunding.connect(beneficiary).withdrawFunds(1)).to.be.revert(ethers);

      await crowdfunding.connect(admin).unpause();

      await crowdfunding.connect(voter2).refund(3); // reprise normale
      await crowdfunding.connect(beneficiary).withdrawFunds(1);
    });
  });

  describe("DAO freeze of a suspicious campaign", function () {
    it("a successful freeze vote cancels the campaign, blocks withdrawal and opens refunds", async function () {
      const { beneficiary, voter1, token, crowdfunding, governance } = await deployAll();

      await passProposal(governance, voter1, [voter1], 1, 1); // 1 = FreezeCampaign

      const c = await crowdfunding.getCampaign(1);
      expect(c.frozen).to.equal(true);
      expect(c.status).to.equal(3n); // Cancelled

      await expect(crowdfunding.connect(beneficiary).withdrawFunds(1)).to.be.revert(ethers);
      await expect(crowdfunding.connect(voter1).contribute(1, { value: 1n })).to.be.revert(ethers);

      // remboursement du contributeur (après approbation de la destruction des CFD)
      await token.connect(voter1).approve(await crowdfunding.getAddress(), ethers.parseEther("100"));
      await crowdfunding.connect(voter1).refund(1);

      expect(await crowdfunding.contributions(1, voter1.address)).to.equal(0n);
      expect(await token.balanceOf(voter1.address)).to.equal(0n);
      expect(await crowdfunding.refunded(1, voter1.address)).to.equal(true);
    });
  });
});
