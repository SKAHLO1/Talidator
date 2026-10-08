// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IdentityRegistry} from "./IdentityRegistry.sol";
import {ValidatorStaking} from "./ValidatorStaking.sol";

/// @title ValidationRegistry
/// @notice ERC-8004 Validation Registry extended from a single validator to an N-of-M quorum.
///         A trader agent calls `validationRequest(validatorSet, agentId, requestURI, requestHash)`; each
///         bonded validator re-executes the claim and votes pass/fail with an evidence hash (directly or
///         via a relayer using an EIP-712 signature). Once every vote is in — or the voting deadline
///         passes — the tally against the threshold is recorded as the result.
contract ValidationRegistry is Ownable, EIP712 {
    enum Status {
        None,
        Pending,
        Passed,
        Failed
    }

    enum Choice {
        None,
        Pass,
        Fail
    }

    struct Request {
        uint256 agentId;
        address requester;
        uint8 threshold;
        uint8 passVotes;
        uint8 failVotes;
        Status status;
        bool overturned;
        uint64 createdAt;
        uint64 deadline;
        uint64 finalizedAt;
        string requestURI;
        address[] validators;
    }

    struct Vote {
        Choice choice;
        bytes32 evidenceHash;
        uint64 at;
    }

    struct ValidatorStats {
        uint64 assigned;
        uint64 votesCast;
        uint64 agreedWithOutcome;
    }

    uint8 public constant MAX_VALIDATORS = 15;
    bytes32 public constant VOTE_TYPEHASH = keccak256("Vote(bytes32 requestHash,bool pass,bytes32 evidenceHash)");

    IdentityRegistry public immutable identity;
    ValidatorStaking public immutable staking;
    uint64 public votingPeriod;
    address public challengeMarket;

    mapping(bytes32 requestHash => Request) private _requests;
    mapping(bytes32 requestHash => mapping(address validator => Vote)) private _votes;
    mapping(address validator => ValidatorStats) public validatorStats;
    bytes32[] private _requestHashes;

    event ValidationRequested(
        bytes32 indexed requestHash,
        uint256 indexed agentId,
        address indexed requester,
        address[] validators,
        uint8 threshold,
        string requestURI,
        uint64 deadline
    );
    event VoteSubmitted(bytes32 indexed requestHash, address indexed validator, bool pass, bytes32 evidenceHash);
    event ValidationFinalized(bytes32 indexed requestHash, bool passed, uint8 passVotes, uint8 failVotes);
    event ResultOverturned(bytes32 indexed requestHash, bool passed);
    event ChallengeMarketSet(address market);
    event VotingPeriodSet(uint64 votingPeriod);

    error NotAuthorizedForAgent();
    error NotTrader();
    error EmptyHash();
    error AlreadyRequested();
    error BadValidatorSet();
    error BadThreshold();
    error ValidatorNotActive(address validator);
    error DuplicateValidator(address validator);
    error SelfValidation();
    error NotPending();
    error VotingClosed();
    error NotAssigned();
    error AlreadyVoted();
    error BadSignature();
    error NotFinalizable();
    error NotChallengeMarket();
    error NotFinalized();
    error AlreadyOverturned();
    error MarketAlreadySet();

    constructor(IdentityRegistry identity_, ValidatorStaking staking_, uint64 votingPeriod_)
        Ownable(msg.sender)
        EIP712("Talidator ValidationRegistry", "1")
    {
        identity = identity_;
        staking = staking_;
        votingPeriod = votingPeriod_;
    }

    // ───────────────────────────── admin ─────────────────────────────

    function setChallengeMarket(address market) external onlyOwner {
        if (challengeMarket != address(0)) revert MarketAlreadySet();
        challengeMarket = market;
        emit ChallengeMarketSet(market);
    }

    function setVotingPeriod(uint64 votingPeriod_) external onlyOwner {
        votingPeriod = votingPeriod_;
        emit VotingPeriodSet(votingPeriod_);
    }

    // ───────────────────────────── requests ─────────────────────────────

    /// @notice ERC-8004 signature, with a simple-majority threshold over `validatorSet`.
    function validationRequest(address[] calldata validatorSet, uint256 agentId, string calldata requestURI, bytes32 requestHash)
        external
    {
        _request(validatorSet, agentId, requestURI, requestHash, uint8(validatorSet.length / 2 + 1));
    }

    /// @notice Same as `validationRequest` with an explicit N-of-M threshold.
    function validationRequestWithThreshold(
        address[] calldata validatorSet,
        uint256 agentId,
        string calldata requestURI,
        bytes32 requestHash,
        uint8 threshold
    ) external {
        _request(validatorSet, agentId, requestURI, requestHash, threshold);
    }

    function _request(
        address[] calldata validatorSet,
        uint256 agentId,
        string calldata requestURI,
        bytes32 requestHash,
        uint8 threshold
    ) private {
        if (!identity.isAuthorized(agentId, msg.sender)) revert NotAuthorizedForAgent();
        if (identity.roleOf(agentId) != IdentityRegistry.Role.Trader) revert NotTrader();
        if (requestHash == bytes32(0)) revert EmptyHash();
        if (_requests[requestHash].status != Status.None) revert AlreadyRequested();
        uint256 n = validatorSet.length;
        if (n == 0 || n > MAX_VALIDATORS) revert BadValidatorSet();
        if (threshold == 0 || threshold > n) revert BadThreshold();

        address traderWallet = identity.agentWallet(agentId);
        for (uint256 i; i < n; ++i) {
            address v = validatorSet[i];
            if (!staking.isActive(v)) revert ValidatorNotActive(v);
            if (v == msg.sender || v == traderWallet) revert SelfValidation();
            for (uint256 j; j < i; ++j) {
                if (validatorSet[j] == v) revert DuplicateValidator(v);
            }
            validatorStats[v].assigned++;
        }

        Request storage r = _requests[requestHash];
        r.agentId = agentId;
        r.requester = msg.sender;
        r.threshold = threshold;
        r.status = Status.Pending;
        r.createdAt = uint64(block.timestamp);
        r.deadline = uint64(block.timestamp) + votingPeriod;
        r.requestURI = requestURI;
        r.validators = validatorSet;
        _requestHashes.push(requestHash);

        emit ValidationRequested(requestHash, agentId, msg.sender, validatorSet, threshold, requestURI, r.deadline);
    }

    // ───────────────────────────── voting ─────────────────────────────

    function submitVote(bytes32 requestHash, bool pass, bytes32 evidenceHash) external {
        _vote(requestHash, msg.sender, pass, evidenceHash);
    }

    /// @notice Relayer path: anyone may submit a vote the validator signed off-chain (EIP-712).
    function submitVoteBySig(bytes32 requestHash, address validator, bool pass, bytes32 evidenceHash, bytes calldata signature)
        external
    {
        bytes32 digest = voteDigest(requestHash, pass, evidenceHash);
        // ECDSA first: EIP-7702-delegated EOAs (common on Monad) have code, which would otherwise route
        // SignatureChecker to ERC-1271 and reject a perfectly valid EOA signature. Contract signers still
        // work through the ERC-1271 fallback.
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, signature);
        bool valid = err == ECDSA.RecoverError.NoError && recovered == validator;
        if (!valid && !SignatureChecker.isValidERC1271SignatureNow(validator, digest, signature)) revert BadSignature();
        _vote(requestHash, validator, pass, evidenceHash);
    }

    function voteDigest(bytes32 requestHash, bool pass, bytes32 evidenceHash) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(VOTE_TYPEHASH, requestHash, pass, evidenceHash)));
    }

    function _vote(bytes32 requestHash, address validator, bool pass, bytes32 evidenceHash) private {
        Request storage r = _requests[requestHash];
        if (r.status != Status.Pending) revert NotPending();
        if (block.timestamp > r.deadline) revert VotingClosed();
        if (!_isAssigned(r, validator)) revert NotAssigned();
        Vote storage v = _votes[requestHash][validator];
        if (v.choice != Choice.None) revert AlreadyVoted();

        v.choice = pass ? Choice.Pass : Choice.Fail;
        v.evidenceHash = evidenceHash;
        v.at = uint64(block.timestamp);
        if (pass) r.passVotes++;
        else r.failVotes++;
        validatorStats[validator].votesCast++;
        emit VoteSubmitted(requestHash, validator, pass, evidenceHash);

        if (r.passVotes + r.failVotes == r.validators.length) _finalize(requestHash, r);
    }

    /// @notice Finalize after the deadline with whatever votes arrived (missing votes count as not-pass).
    function finalize(bytes32 requestHash) external {
        Request storage r = _requests[requestHash];
        if (r.status != Status.Pending || block.timestamp <= r.deadline) revert NotFinalizable();
        _finalize(requestHash, r);
    }

    function _finalize(bytes32 requestHash, Request storage r) private {
        bool passed = r.passVotes >= r.threshold;
        r.status = passed ? Status.Passed : Status.Failed;
        r.finalizedAt = uint64(block.timestamp);
        Choice result = passed ? Choice.Pass : Choice.Fail;
        for (uint256 i; i < r.validators.length; ++i) {
            if (_votes[requestHash][r.validators[i]].choice == result) validatorStats[r.validators[i]].agreedWithOutcome++;
        }
        emit ValidationFinalized(requestHash, passed, r.passVotes, r.failVotes);
    }

    // ───────────────────────────── challenges ─────────────────────────────

    /// @notice Called by the ChallengeMarket when a fresh quorum upholds a challenge.
    function overturn(bytes32 requestHash) external {
        if (msg.sender != challengeMarket) revert NotChallengeMarket();
        Request storage r = _requests[requestHash];
        if (r.status != Status.Passed && r.status != Status.Failed) revert NotFinalized();
        if (r.overturned) revert AlreadyOverturned();
        r.overturned = true;
        emit ResultOverturned(requestHash, r.status == Status.Failed);
    }

    // ───────────────────────────── views ─────────────────────────────

    /// @notice Effective outcome, accounting for overturned results.
    function outcome(bytes32 requestHash) public view returns (bool finalized, bool passed) {
        Request storage r = _requests[requestHash];
        finalized = r.status == Status.Passed || r.status == Status.Failed;
        passed = finalized && ((r.status == Status.Passed) != r.overturned);
    }

    /// @notice ERC-8004-style response: 100 for a (effective) pass, 0 for a fail, 0 while pending.
    function getValidationStatus(bytes32 requestHash)
        external
        view
        returns (uint256 agentId, uint8 response, bool finalized, uint64 finalizedAt)
    {
        Request storage r = _requests[requestHash];
        bool passed;
        (finalized, passed) = outcome(requestHash);
        return (r.agentId, passed ? 100 : 0, finalized, r.finalizedAt);
    }

    function getRequest(bytes32 requestHash) external view returns (Request memory) {
        return _requests[requestHash];
    }

    function getVote(bytes32 requestHash, address validator) external view returns (Vote memory) {
        return _votes[requestHash][validator];
    }

    function getValidators(bytes32 requestHash) external view returns (address[] memory) {
        return _requests[requestHash].validators;
    }

    function requestCount() external view returns (uint256) {
        return _requestHashes.length;
    }

    /// @notice Page through request hashes, newest first.
    function getRequestHashes(uint256 offset, uint256 limit) external view returns (bytes32[] memory page) {
        uint256 total = _requestHashes.length;
        if (offset >= total) return new bytes32[](0);
        uint256 n = total - offset < limit ? total - offset : limit;
        page = new bytes32[](n);
        for (uint256 i; i < n; ++i) {
            page[i] = _requestHashes[total - 1 - offset - i];
        }
    }

    function _isAssigned(Request storage r, address validator) private view returns (bool) {
        for (uint256 i; i < r.validators.length; ++i) {
            if (r.validators[i] == validator) return true;
        }
        return false;
    }
}
