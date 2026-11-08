
import { expect } from "chai";
import { network } from "hardhat";

const { ethers } = await network.create();

describe("CFDToken", function () {
  async function deployToken() {
    const [admin, minter, user, unauthorized] = await ethers.getSigners();

    const token = await ethers.deployContract("CFDToken", [admin.address]);

    return { token, admin, minter, user, unauthorized };
  }

  it("Should have the correct name and symbol", async function () {
    const { token } = await deployToken();

    expect(await token.name()).to.equal("Crowdfunding Token");
    expect(await token.symbol()).to.equal("CFD");
  });

  it("Should assign the admin role to the deployer", async function () {
    const { token, admin } = await deployToken();

    const adminRole = await token.DEFAULT_ADMIN_ROLE();

    expect(await token.hasRole(adminRole, admin.address)).to.equal(true);
  });

  it("Should allow an authorized minter to create tokens", async function () {
    const { token, admin, minter, user } = await deployToken();

    const minterRole = await token.MINTER_ROLE();

    await token.connect(admin).grantRole(minterRole, minter.address);
    await token.connect(minter).mint(user.address, 100n);

    expect(await token.balanceOf(user.address)).to.equal(100n);
  });

  it("Should reject token creation by an unauthorized account", async function () {
    const { token, unauthorized, user } = await deployToken();

    await expect(
      token.connect(unauthorized).mint(user.address, 100n)
    ).to.be.revert(ethers);
  });

  it("Should automatically activate voting power after minting", async function () {
    const { token, admin, minter, user } = await deployToken();

    const minterRole = await token.MINTER_ROLE();

    await token.connect(admin).grantRole(minterRole, minter.address);
    await token.connect(minter).mint(user.address, 100n);

    expect(await token.getVotes(user.address)).to.equal(100n);
    expect(await token.delegates(user.address)).to.equal(user.address);
  });
});
