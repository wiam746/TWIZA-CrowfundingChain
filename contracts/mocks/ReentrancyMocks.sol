// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

/**
 * CONTRATS DE TEST UNIQUEMENT - NE JAMAIS LES DÉPLOYER EN PRODUCTION.
 *
 * Ils servent à prouver l'efficacité de la protection anti-reentrance (section 5 du sujet) :
 *  - VulnerableBank     : coffre volontairement vulnérable (appel externe AVANT la mise à jour de l'état, sans garde).
 *  - ReentrancyAttacker : rappelle la fonction de retrait depuis receive().
 * Le test montre que l'attaque vide VulnerableBank mais échoue contre Crowdfunding.refund().
 */
interface ICrowdfundingAttack {
    function contribute(uint256 id) external payable;
    function refund(uint256 id) external;
}

interface ITokenAttack {
    function approve(address spender, uint256 value) external returns (bool);
}

interface IVulnerableBank {
    function deposit() external payable;
    function withdraw() external;
}

contract VulnerableBank {
    mapping(address => uint256) public balances;

    function deposit() external payable {
        balances[msg.sender] += msg.value;
    }

    // Vulnérable : l'ETH est envoyé avant que le solde soit remis à zéro.
    function withdraw() external {
        uint256 bal = balances[msg.sender];
        require(bal > 0, "no balance");
        (bool ok, ) = msg.sender.call{value: bal}("");
        require(ok, "transfer failed");
        balances[msg.sender] = 0;
    }
}

contract ReentrancyAttacker {
    enum Mode {
        None,
        Refund,
        Bank
    }

    Mode public mode;
    address public target;
    uint256 public campaignId;
    uint256 public stake;

    uint256 public reentrancyAttempts; // nombre de tentatives de ré-entrée
    uint256 public reentrancyBlocked; // nombre de tentatives rejetées par la cible

    function contributeTo(address crowdfunding, uint256 id) external payable {
        ICrowdfundingAttack(crowdfunding).contribute{value: msg.value}(id);
    }

    // Crowdfunding.refund() détruit des CFD via burnFrom : il faut donc une allowance.
    function approveBurn(address token, address spender, uint256 amount) external {
        ITokenAttack(token).approve(spender, amount);
    }

    function attackRefund(address crowdfunding, uint256 id) external {
        mode = Mode.Refund;
        target = crowdfunding;
        campaignId = id;
        ICrowdfundingAttack(crowdfunding).refund(id);
    }

    function attackBank(address bank) external payable {
        mode = Mode.Bank;
        target = bank;
        stake = msg.value;
        IVulnerableBank(bank).deposit{value: msg.value}();
        IVulnerableBank(bank).withdraw();
    }

    receive() external payable {
        if (mode == Mode.Refund) {
            reentrancyAttempts++;
            try ICrowdfundingAttack(target).refund(campaignId) {} catch {
                reentrancyBlocked++;
            }
        } else if (mode == Mode.Bank) {
            if (target.balance >= stake) {
                reentrancyAttempts++;
                IVulnerableBank(target).withdraw();
            }
        }
    }
}
