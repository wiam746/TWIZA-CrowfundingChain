
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface ICFDToken {
    function mint(address to, uint256 amount) external;
    function burnFrom(address account, uint256 amount) external;
    function balanceOf(address account) external view returns (uint256);
}

interface ITreasury {
    function depositForCampaign(
        uint256 campaignId,
        address beneficiary,
        address creator
    ) external payable;
}

contract Crowdfunding is AccessControl, Pausable, ReentrancyGuard {
    bytes32 public constant GOVERNANCE_ROLE =
        keccak256("GOVERNANCE_ROLE");

    // Rôle séparé pour la pause d'urgence : permet à l'admin de renoncer à DEFAULT_ADMIN_ROLE
    // sans perdre le circuit breaker.
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    uint256 public constant CFD_PER_ETH = 100;

    enum Status {
        Active,
        Successful,
        Failed,
        Cancelled
    }

    struct Campaign {
        uint256 id;
        address creator;
        address beneficiary;
        uint256 goal;
        uint256 raised;
        uint256 deadline;
        Status status;
        bool frozen;
        bool withdrawalApproved;
        bool withdrawn;
        string ipfsHash;
    }

    ICFDToken public immutable token;
    ITreasury public immutable treasury;

    uint256 public campaignCount;

    mapping(uint256 => Campaign) public campaigns;
    mapping(uint256 => mapping(address => uint256)) public contributions;
    mapping(uint256 => mapping(address => bool)) public refunded;

    event CampaignCreated(
        uint256 indexed id,
        address indexed creator,
        address indexed beneficiary,
        uint256 goal,
        uint256 deadline,
        string ipfsHash
    );

    event ContributionReceived(
        uint256 indexed id,
        address indexed contributor,
        uint256 amount,
        uint256 tokensMinted
    );

    event CampaignFinalized(uint256 indexed id, Status status);

    event RefundIssued(
        uint256 indexed id,
        address indexed contributor,
        uint256 amount
    );

    event WithdrawalApproved(uint256 indexed id);

    event FundsTransferredToTreasury(
        uint256 indexed id,
        address indexed beneficiary,
        uint256 amount
    );

    event CampaignFrozen(uint256 indexed id);

    constructor(
        address tokenAddress,
        address treasuryAddress,
        address admin
    ) {
        require(tokenAddress != address(0), "Invalid token");
        require(treasuryAddress != address(0), "Invalid treasury");
        require(admin != address(0), "Invalid admin");

        token = ICFDToken(tokenAddress);
        treasury = ITreasury(treasuryAddress);

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);
    }

    function createCampaign(
        uint256 goal,
        uint256 duration,
        address beneficiary,
        string calldata ipfsHash
    ) external whenNotPaused returns (uint256) {
        require(goal > 0, "Invalid goal");
        require(duration > 0, "Invalid duration");
        require(beneficiary != address(0), "Invalid beneficiary");
        require(bytes(ipfsHash).length > 0, "Missing IPFS hash");

        campaignCount++;

        uint256 id = campaignCount;

        campaigns[id] = Campaign({
            id: id,
            creator: msg.sender,
            beneficiary: beneficiary,
            goal: goal,
            raised: 0,
            deadline: block.timestamp + duration,
            status: Status.Active,
            frozen: false,
            withdrawalApproved: false,
            withdrawn: false,
            ipfsHash: ipfsHash
        });

        emit CampaignCreated(
            id,
            msg.sender,
            beneficiary,
            goal,
            block.timestamp + duration,
            ipfsHash
        );

        return id;
    }

    function contribute(uint256 id)
        external
        payable
        whenNotPaused
        nonReentrant
    {
        require(id > 0 && id <= campaignCount, "Campaign not found");

        Campaign storage campaign = campaigns[id];

        require(campaign.status == Status.Active, "Campaign not active");
        require(!campaign.frozen, "Campaign frozen");
        require(block.timestamp < campaign.deadline, "Deadline reached");
        require(msg.value > 0, "Invalid contribution");

        campaign.raised += msg.value;
        contributions[id][msg.sender] += msg.value;

        uint256 tokensToMint = msg.value * CFD_PER_ETH;

        if (campaign.raised >= campaign.goal) {
            campaign.status = Status.Successful;
            emit CampaignFinalized(id, Status.Successful);
        }

        token.mint(msg.sender, tokensToMint);

        emit ContributionReceived(
            id,
            msg.sender,
            msg.value,
            tokensToMint
        );
    }

    function finalizeCampaign(uint256 id) external {
        require(id > 0 && id <= campaignCount, "Campaign not found");

        Campaign storage campaign = campaigns[id];

        require(campaign.status == Status.Active, "Invalid status");
        require(block.timestamp >= campaign.deadline, "Deadline not reached");

        if (campaign.raised >= campaign.goal) {
            campaign.status = Status.Successful;
        } else {
            campaign.status = Status.Failed;
        }

        emit CampaignFinalized(id, campaign.status);
    }

    function refund(uint256 id)
        external
        whenNotPaused
        nonReentrant
    {
        require(id > 0 && id <= campaignCount, "Campaign not found");

        Campaign storage campaign = campaigns[id];

        require(
            campaign.status == Status.Failed ||
            campaign.status == Status.Cancelled,
            "Refund unavailable"
        );

        require(!refunded[id][msg.sender], "Already refunded");

        uint256 amount = contributions[id][msg.sender];

        require(amount > 0, "No contribution");

        uint256 tokensToBurn = amount * CFD_PER_ETH;

        // Effects avant les interactions externes.
        refunded[id][msg.sender] = true;
        contributions[id][msg.sender] = 0;
        campaign.raised -= amount;

        require(
            token.balanceOf(msg.sender) >= tokensToBurn,
            "Insufficient CFD for refund"
        );

        token.burnFrom(msg.sender, tokensToBurn);

        (bool success, ) = payable(msg.sender).call{value: amount}("");
        require(success, "Refund transfer failed");

        emit RefundIssued(id, msg.sender, amount);
    }

    function approveWithdrawal(uint256 id)
        external
        onlyRole(GOVERNANCE_ROLE)
    {
        require(id > 0 && id <= campaignCount, "Campaign not found");

        Campaign storage campaign = campaigns[id];

        require(campaign.status == Status.Successful, "Campaign not successful");
        require(!campaign.frozen, "Campaign frozen");
        require(!campaign.withdrawn, "Already withdrawn");
        require(!campaign.withdrawalApproved, "Already approved");

        campaign.withdrawalApproved = true;

        emit WithdrawalApproved(id);
    }

    function withdrawFunds(uint256 id)
        external
        whenNotPaused
        nonReentrant
    {
        require(id > 0 && id <= campaignCount, "Campaign not found");

        Campaign storage campaign = campaigns[id];

        require(msg.sender == campaign.beneficiary, "Not beneficiary");
        require(campaign.status == Status.Successful, "Campaign not successful");
        require(campaign.withdrawalApproved, "DAO approval required");
        require(!campaign.frozen, "Campaign frozen");
        require(!campaign.withdrawn, "Already withdrawn");

        uint256 amount = campaign.raised;

        campaign.withdrawn = true;

        treasury.depositForCampaign{value: amount}(
            id,
            campaign.beneficiary,
            campaign.creator
        );
        emit FundsTransferredToTreasury(
            id,
            campaign.beneficiary,
            amount
        );
    }

    function freezeCampaign(uint256 id)
        external
        onlyRole(GOVERNANCE_ROLE)
    {
        require(id > 0 && id <= campaignCount, "Campaign not found");

        Campaign storage campaign = campaigns[id];

        require(!campaign.withdrawn, "Already withdrawn");
        require(!campaign.frozen, "Already frozen");
        require(
            campaign.status == Status.Active ||
            campaign.status == Status.Successful,
            "Cannot freeze campaign"
        );

        campaign.frozen = true;
        campaign.status = Status.Cancelled;

        emit CampaignFrozen(id);
        emit CampaignFinalized(id, Status.Cancelled);
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    function getCampaign(uint256 id)
        external
        view
        returns (Campaign memory)
    {
        require(id > 0 && id <= campaignCount, "Campaign not found");
        return campaigns[id];
    }

    function campaignState(uint256 id)
        external
        view
        returns (
            uint8 status,
            bool frozen,
            bool withdrawalApproved,
            bool withdrawn
        )
    {
        require(id > 0 && id <= campaignCount, "Campaign not found");
        Campaign storage c = campaigns[id];
        return (
            uint8(c.status),
            c.frozen,
            c.withdrawalApproved,
            c.withdrawn
        );
    }

    function campaignCreator(uint256 id) external view returns (address) {
        require(id > 0 && id <= campaignCount, "Campaign not found");
        return campaigns[id].creator;
    }
}
