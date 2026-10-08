// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ValidationRegistry} from "./ValidationRegistry.sol";
import {ChallengeMarket} from "./ChallengeMarket.sol";

/// @title ReputationRegistry
/// @notice Feedback is derived only from *final* validation outcomes — a quorum result whose challenge
///         window elapsed unchallenged, or whose challenge has been resolved. Nobody can post a score for a
///         self-reported claim; anyone can post the outcome of a final validation exactly once.
contract ReputationRegistry {
    struct Summary {
        uint64 count;
        uint64 passed;
        uint256 scoreSum;
    }

    ValidationRegistry public immutable registry;
    ChallengeMarket public immutable market;

    mapping(uint256 agentId => Summary) private _summaries;
    mapping(bytes32 requestHash => bool) public posted;

    /// @dev Name mirrors the ERC-8004 Reputation Registry event.
    event NewFeedback(uint256 indexed agentId, bytes32 indexed requestHash, uint8 score, bool passed);

    error AlreadyPosted();
    error NotFinal();

    constructor(ValidationRegistry registry_, ChallengeMarket market_) {
        registry = registry_;
        market = market_;
    }

    function postOutcome(bytes32 requestHash) external {
        if (posted[requestHash]) revert AlreadyPosted();
        if (!market.isFinal(requestHash)) revert NotFinal();
        posted[requestHash] = true;

        (, bool passed) = registry.outcome(requestHash);
        uint256 agentId = registry.getRequest(requestHash).agentId;
        uint8 score = passed ? 100 : 0;
        Summary storage s = _summaries[agentId];
        s.count++;
        s.scoreSum += score;
        if (passed) s.passed++;
        emit NewFeedback(agentId, requestHash, score, passed);
    }

    /// @return count number of final outcomes
    /// @return averageScoreBps average score scaled by 100 (e.g. 9820 = 98.20)
    function getSummary(uint256 agentId) external view returns (uint64 count, uint256 averageScoreBps) {
        Summary storage s = _summaries[agentId];
        count = s.count;
        averageScoreBps = count == 0 ? 0 : (s.scoreSum * 100) / count;
    }
}
