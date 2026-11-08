
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface ICFDVotes {
    function getPastVotes(address account, uint256 timepoint)
        external
        view
        returns (uint256);

    function getPastTotalSupply(uint256 timepoint)
        external
        view
        returns (uint256);
}

interface ICrowdfundingGovernance {
    function approveWithdrawal(uint256 id) external;
    function freezeCampaign(uint256 id) external;
    function campaignCreator(uint256 id) external view returns (address);
    function campaignState(uint256 id)
        external
        view
        returns (
            uint8 status,
            bool frozen,
            bool withdrawalApproved,
            bool withdrawn
        );
}

contract Governance is ReentrancyGuard {
    uint256 public constant VOTING_DELAY = 1;
    uint256 public constant VOTING_PERIOD = 20;
    uint256 public constant QUORUM_BPS = 2000;

    enum ProposalType {
        ApproveWithdrawal,
        FreezeCampaign
    }

    struct Proposal {
        uint256 id;
        uint256 campaignId;
        address proposer;
        ProposalType proposalType;
        uint256 snapshotBlock;
        uint256 startBlock;
        uint256 endBlock;
        uint256 forVotes;
        uint256 againstVotes;
        bool executed;
    }

    ICFDVotes public immutable token;
    ICrowdfundingGovernance public immutable crowdfunding;

    uint256 public proposalCount;

    mapping(uint256 => Proposal) public proposals;
    mapping(uint256 => mapping(address => bool)) public hasVoted;
    mapping(uint256 => uint256) private proposalQuorumThresholds;

    event ProposalCreated(
        uint256 indexed proposalId,
        uint256 indexed campaignId,
        ProposalType proposalType,
        address proposer,
        uint256 snapshotBlock,
        uint256 endBlock
    );

    event VoteCast(
        uint256 indexed proposalId,
        address indexed voter,
        bool support,
        uint256 weight
    );

    event ProposalExecuted(uint256 indexed proposalId);
    event ProposalExecutionFailed(uint256 indexed proposalId);

    constructor(address tokenAddress, address crowdfundingAddress) {
        require(tokenAddress != address(0), "Invalid token");
        require(crowdfundingAddress != address(0), "Invalid crowdfunding");

        token = ICFDVotes(tokenAddress);
        crowdfunding = ICrowdfundingGovernance(crowdfundingAddress);
    }

    function createProposal(
        uint256 campaignId,
        ProposalType proposalType
    ) external returns (uint256) {
        // Statuts de Crowdfunding.Status : 0 = Active, 1 = Successful
        (
            uint8 status,
            bool frozen,
            bool approved,
            bool withdrawn
        ) = crowdfunding.campaignState(campaignId);

        require(!frozen && !withdrawn, "Campaign closed");

        if (proposalType == ProposalType.ApproveWithdrawal) {
            require(status == 1 && !approved, "Campaign not eligible");
            require(
                msg.sender != crowdfunding.campaignCreator(campaignId),
                "Creator cannot propose withdrawal"
            );
        } else {
            require(status == 0 || status == 1, "Cannot freeze campaign");
        }

        require(block.number > 1, "Block too low");

        uint256 snapshot = block.number - 1;
        uint256 quorumThreshold =
            (token.getPastTotalSupply(snapshot) * QUORUM_BPS) / 10000;

        require(
            token.getPastVotes(msg.sender, snapshot) > 0,
            "No voting power"
        );

        proposalCount++;

        uint256 id = proposalCount;
        uint256 start = block.number + VOTING_DELAY;
        uint256 end = start + VOTING_PERIOD;

        proposals[id] = Proposal({
            id: id,
            campaignId: campaignId,
            proposer: msg.sender,
            proposalType: proposalType,
            snapshotBlock: snapshot,
            startBlock: start,
            endBlock: end,
            forVotes: 0,
            againstVotes: 0,
            executed: false
        });
        proposalQuorumThresholds[id] = quorumThreshold;

        emit ProposalCreated(
            id,
            campaignId,
            proposalType,
            msg.sender,
            snapshot,
            end
        );

        return id;
    }

    function castVote(uint256 proposalId, bool support) external {
        Proposal storage proposal = proposals[proposalId];

        require(proposalId > 0 && proposalId <= proposalCount, "Proposal not found");
        require(
            block.number >= proposal.startBlock,
            "Voting not started"
        );
        require(
            block.number <= proposal.endBlock,
            "Voting ended"
        );
        require(!hasVoted[proposalId][msg.sender], "Already voted");
        if (proposal.proposalType == ProposalType.ApproveWithdrawal) {
            require(
                msg.sender != crowdfunding.campaignCreator(proposal.campaignId),
                "Creator cannot vote on withdrawal"
            );
        }

        uint256 weight = token.getPastVotes(
            msg.sender,
            proposal.snapshotBlock
        );

        require(weight > 0, "No voting power at snapshot");

        hasVoted[proposalId][msg.sender] = true;

        if (support) {
            proposal.forVotes += weight;
        } else {
            proposal.againstVotes += weight;
        }

        emit VoteCast(proposalId, msg.sender, support, weight);
    }

    function quorum(uint256 proposalId)
        public
        view
        returns (uint256)
    {
        require(proposalId > 0 && proposalId <= proposalCount, "Proposal not found");

        return proposalQuorumThresholds[proposalId];
    }

    function proposalSucceeded(uint256 proposalId)
        public
        view
        returns (bool)
    {
        require(proposalId > 0 && proposalId <= proposalCount, "Proposal not found");

        Proposal storage proposal = proposals[proposalId];

        uint256 totalVotes =
            proposal.forVotes + proposal.againstVotes;

        return (
            totalVotes >= quorum(proposalId) &&
            proposal.forVotes > proposal.againstVotes
        );
    }

    function executeProposal(uint256 proposalId) external nonReentrant {
        _execute(proposalId);
    }

    function _execute(uint256 proposalId) internal {
        require(proposalId > 0 && proposalId <= proposalCount, "Proposal not found");

        Proposal storage proposal = proposals[proposalId];

        require(
            block.number > proposal.endBlock,
            "Voting period not finished"
        );
        require(!proposal.executed, "Already executed");
        require(proposalSucceeded(proposalId), "Proposal not approved");

        // Effects avant interaction externe.
        proposal.executed = true;

        bool ok = false;
        if (proposal.proposalType == ProposalType.ApproveWithdrawal) {
            try crowdfunding.approveWithdrawal(proposal.campaignId) {
                ok = true;
            } catch {}
        } else {
            try crowdfunding.freezeCampaign(proposal.campaignId) {
                ok = true;
            } catch {}
        }

        if (ok) emit ProposalExecuted(proposalId);
        else emit ProposalExecutionFailed(proposalId);
    }

    function checkUpkeep(bytes calldata)
        external
        view
        returns (bool upkeepNeeded, bytes memory performData)
    {
        for (uint256 i = 1; i <= proposalCount; i++) {
            Proposal storage p = proposals[i];
            if (
                !p.executed &&
                block.number > p.endBlock &&
                proposalSucceeded(i)
            ) {
                return (true, abi.encode(i));
            }
        }
        return (false, "");
    }

    function performUpkeep(bytes calldata performData) external nonReentrant {
        _execute(abi.decode(performData, (uint256)));
    }

    function getProposal(uint256 proposalId)
        external
        view
        returns (Proposal memory)
    {
        require(proposalId > 0 && proposalId <= proposalCount, "Proposal not found");

        return proposals[proposalId];
    }
}
