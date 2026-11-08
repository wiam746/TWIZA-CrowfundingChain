import { expect } from "chai";
import { network } from "hardhat";

const { ethers } = await network.create();

/**
 * Scénario de FUZZING (exigence de la section 4).
 *
 * On exécute des centaines d'opérations aléatoires (contributions de montants aléatoires par des comptes
 * aléatoires, avancée du temps, remboursements) avec un générateur pseudo-aléatoire à graine (reproductible),
 * et on vérifie des INVARIANTS après chaque opération :
 *
 *   I1  solde ETH du contrat Crowdfunding == somme des contributions non remboursées
 *   I2  offre totale de CFD == CFD_PER_ETH x somme des contributions non remboursées
 *   I3  un remboursement fait sortir du contrat exactement le montant contribué
 *
 * Pour rejouer : FUZZ_SEED=123 FUZZ_RUNS=500 npx hardhat test test/Fuzz.ts
 */

// mulberry32 : petit PRNG déterministe
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("Fuzzing - Crowdfunding invariants", function () {
  this.timeout(600000);

  const SEED = Number(process.env.FUZZ_SEED ?? 20261103);
  const RUNS = Number(process.env.FUZZ_RUNS ?? 300);

  it(`keeps the invariants over ${RUNS} random operations`, async function () {
    const signers = await ethers.getSigners();
    const [admin, owner1, owner2, owner3, creator, beneficiary, ...rest] = signers;
    const users = rest.slice(0, 4);

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
    await token.grantRole(await token.MINTER_ROLE(), await crowdfunding.getAddress());
    await treasury.grantRole(await treasury.CROWDFUNDING_ROLE(), await crowdfunding.getAddress());

    const cfAddr = await crowdfunding.getAddress();
    const RATE: bigint = await crowdfunding.CFD_PER_ETH();

    // 3 campagnes à objectif inatteignable : elles échouent toutes à la date limite (=> remboursables)
    const ids = [1n, 2n, 3n];
    for (let i = 0; i < 3; i++) {
      await crowdfunding
        .connect(creator)
        .createCampaign(ethers.parseEther("1000000"), 3600, beneficiary.address, `QmFuzz${i}`);
    }

    // Modèle de référence : id -> adresse -> wei non remboursés
    const owed = new Map<bigint, Map<string, bigint>>();
    for (const id of ids) owed.set(id, new Map(users.map((u) => [u.address, 0n])));

    const rnd = prng(SEED);
    let ended = false;

    async function checkInvariants(step: number) {
      let sum = 0n;
      for (const m of owed.values()) for (const v of m.values()) sum += v;
      expect(await ethers.provider.getBalance(cfAddr), `I1 au pas ${step}`).to.equal(sum);
      expect(await token.totalSupply(), `I2 au pas ${step}`).to.equal(sum * RATE);
    }

    async function refundIfOwed(id: bigint, user: any) {
      const amount = owed.get(id)!.get(user.address)!;
      if (amount === 0n) {
        await expect(crowdfunding.connect(user).refund(id)).to.be.revert(ethers);
        return;
      }
      await token.connect(user).approve(cfAddr, amount * RATE);
      const before = await ethers.provider.getBalance(cfAddr);
      await crowdfunding.connect(user).refund(id);
      const after = await ethers.provider.getBalance(cfAddr);
      expect(before - after, "I3").to.equal(amount);
      owed.get(id)!.set(user.address, 0n);
    }

    for (let step = 0; step < RUNS; step++) {
      const id = ids[Math.floor(rnd() * ids.length)];
      const user = users[Math.floor(rnd() * users.length)];
      const action = rnd();

      if (!ended && action < 0.7) {
        // contribution : tantôt minuscule (1 à 1000 wei), tantôt jusqu'à ~5 ETH
        const amount =
          rnd() < 0.2 ? BigInt(1 + Math.floor(rnd() * 1000)) : BigInt(Math.floor(rnd() * 5e18)) + 1n;
        await crowdfunding.connect(user).contribute(id, { value: amount });
        owed.get(id)!.set(user.address, owed.get(id)!.get(user.address)! + amount);
      } else if (!ended && action < 0.78) {
        await ethers.provider.send("evm_increaseTime", [3601]);
        await ethers.provider.send("evm_mine", []);
        for (const cid of ids) await crowdfunding.finalizeCampaign(cid);
        ended = true;
      } else if (ended) {
        await refundIfOwed(id, user);
      }

      await checkInvariants(step);
    }

    // Fin de scénario : tout le monde se fait rembourser => contrat vide et aucune offre de CFD
    if (!ended) {
      await ethers.provider.send("evm_increaseTime", [3601]);
      await ethers.provider.send("evm_mine", []);
      for (const cid of ids) await crowdfunding.finalizeCampaign(cid);
    }
    for (const id of ids) for (const u of users) if (owed.get(id)!.get(u.address)! > 0n) await refundIfOwed(id, u);

    expect(await ethers.provider.getBalance(cfAddr)).to.equal(0n);
    expect(await token.totalSupply()).to.equal(0n);
  });
});
