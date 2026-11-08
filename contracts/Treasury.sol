
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract Treasury is AccessControl, Pausable, ReentrancyGuard {
    bytes32 public constant CROWDFUNDING_ROLE =
        keccak256("CROWDFUNDING_ROLE");

    // Rôle séparé pour la pause d'urgence : permet à l'admin de renoncer à DEFAULT_ADMIN_ROLE
    // sans perdre le circuit breaker.
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    struct Transaction {
        uint256 campaignId;
        address recipient;
        uint256 amount;
        uint256 approvals;
        uint256 requiredApprovals;
        bool executed;
    }

    mapping(uint256 => address) public campaignBeneficiaries;
    mapping(uint256 => address) public campaignCreators;

    address[3] public owners;
    mapping(address => bool) public isOwner;

    uint256 public immutable threshold;
    uint256 public transactionCount;

    mapping(uint256 => Transaction) public transactions;
    mapping(uint256 => mapping(address => bool)) public approved;
    mapping(uint256 => uint256) public campaignBalances;
    mapping(uint256 => uint256) public campaignRequested;
    mapping(uint256 => bool) public campaignRequiresMultisig;

    event CampaignDeposit(
        uint256 indexed campaignId,
        uint256 amount
    );

    event TransactionSubmitted(
        uint256 indexed transactionId,
        uint256 indexed campaignId,
        address indexed recipient,
        uint256 amount
    );

    event TransactionApproved(
        uint256 indexed transactionId,
        address indexed owner
    );

    event TransactionExecuted(
        uint256 indexed transactionId,
        uint256 indexed campaignId,
        address recipient,
        uint256 amount
    );

    modifier onlyOwner() {
        require(isOwner[msg.sender], "Not an owner");
        _;
    }

    constructor(
        address[3] memory initialOwners,
        address admin,
        uint256 initialThreshold
    ) {
        require(admin != address(0), "Invalid admin");
        require(initialThreshold > 0, "Invalid threshold");

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);

        for (uint256 i = 0; i < 3; i++) {
            address owner = initialOwners[i];

            require(owner != address(0), "Invalid owner");
            require(!isOwner[owner], "Duplicate owner");

            owners[i] = owner;
            isOwner[owner] = true;
        }

        threshold = initialThreshold;
    }

    function depositForCampaign(
         uint256 campaignId,
         address beneficiary,
         address creator
    ) external payable onlyRole(CROWDFUNDING_ROLE) {
         require(campaignId > 0, "Invalid campaign");
         require(beneficiary != address(0), "Invalid beneficiary");
         require(creator != address(0), "Invalid creator");
         require(msg.value > 0, "Invalid deposit");

         address existingBeneficiary = campaignBeneficiaries[campaignId];

         if (existingBeneficiary == address(0)) {
             campaignBeneficiaries[campaignId] = beneficiary;
             campaignCreators[campaignId] = creator;
         } else {
              require(
                  existingBeneficiary == beneficiary,
                  "Beneficiary mismatch"
              );
              require(
                  campaignCreators[campaignId] == creator,
                  "Creator mismatch"
              );
         }

         campaignBalances[campaignId] += msg.value;

         emit CampaignDeposit(campaignId, msg.value);
    }

    function submitCampaignWithdrawal(
        uint256 campaignId,
        address recipient,
        uint256 amount
    ) external onlyOwner returns (uint256) {
        require(campaignId > 0, "Invalid campaign");
        require(
            msg.sender != campaignCreators[campaignId],
            "Campaign creator cannot manage withdrawal"
        );
        require(recipient != address(0), "Invalid recipient");
        require(amount > 0, "Invalid amount");
        require(
            recipient == campaignBeneficiaries[campaignId],
            "Invalid campaign beneficiary"
        );

        require(
            amount <= campaignBalances[campaignId],
            "Insufficient campaign balance"
        );

        campaignRequested[campaignId] += amount;
        if (campaignRequested[campaignId] > threshold) {
            campaignRequiresMultisig[campaignId] = true;
        }
        uint256 required =
            campaignRequiresMultisig[campaignId] ? 2 : 1;

        transactionCount++;

        uint256 id = transactionCount;

        transactions[id] = Transaction({
            campaignId: campaignId,
            recipient: recipient,
            amount: amount,
            approvals: 1,
            requiredApprovals: required,
            executed: false
        });

        approved[id][msg.sender] = true;

        emit TransactionSubmitted(
            id,
            campaignId,
            recipient,
            amount
        );

        emit TransactionApproved(id, msg.sender);

        return id;
    }

    function approveTransaction(uint256 transactionId)
        external
        onlyOwner
    {
        require(
            transactionId > 0 && transactionId <= transactionCount,
            "Transaction not found"
        );

        Transaction storage transaction = transactions[transactionId];

        require(
            msg.sender != campaignCreators[transaction.campaignId],
            "Campaign creator cannot manage withdrawal"
        );
        require(!transaction.executed, "Already executed");
        require(!approved[transactionId][msg.sender], "Already approved");

        approved[transactionId][msg.sender] = true;
        transaction.approvals++;

        emit TransactionApproved(transactionId, msg.sender);
    }

    function executeTransaction(uint256 transactionId)
        external
        onlyOwner
        whenNotPaused
        nonReentrant
    {
        require(
            transactionId > 0 && transactionId <= transactionCount,
            "Transaction not found"
        );

        Transaction storage transaction = transactions[transactionId];

        require(
            msg.sender != campaignCreators[transaction.campaignId],
            "Campaign creator cannot manage withdrawal"
        );
        require(!transaction.executed, "Already executed");

        uint256 requiredApprovals =
            campaignRequiresMultisig[transaction.campaignId]
                ? 2
                : transaction.requiredApprovals;
        require(
            transaction.approvals >= requiredApprovals,
            "Insufficient approvals"
        );

        require(
            campaignBalances[transaction.campaignId] >= transaction.amount,
            "Insufficient campaign balance"
        );

        // Checks-Effects-Interactions.
        transaction.executed = true;
        campaignBalances[transaction.campaignId] -= transaction.amount;

        (bool success, ) = payable(transaction.recipient).call{
            value: transaction.amount
        }("");

        require(success, "Transfer failed");

        emit TransactionExecuted(
            transactionId,
            transaction.campaignId,
            transaction.recipient,
            transaction.amount
        );
    }

    function getRequiredApprovals(uint256 transactionId)
        external
        view
        returns (uint256)
    {
        require(
            transactionId > 0 && transactionId <= transactionCount,
            "Transaction not found"
        );

        Transaction storage transaction = transactions[transactionId];
        return campaignRequiresMultisig[transaction.campaignId]
            ? 2
            : transaction.requiredApprovals;
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }
}
