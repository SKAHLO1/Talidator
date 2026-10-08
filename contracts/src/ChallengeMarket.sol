// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ValidationRegistry} from "./ValidationRegistry.sol";
import {ValidatorStaking} from "./ValidatorStaking.sol";

/// @title ChallengeMarket
/// @notice Within `challengeWindow` of a finalized validation, anyone can stake `challengeBond` to dispute
///         it. A fresh review quorum — bonded validators outside the original set — re-checks the claim.
///         If the challenge is upheld the result is overturned, every original validator who voted with the
///         wrong outcome is slashed, and the challenger gets their bond back plus a cut of the slashed stake.
///         If rejected, the bond is forfeited to the treasury. When no reviewers are available, or the review
///         deadline passes without a majority, the designated arbiter decides (PRD "admin-arbiter fallback").
contract ChallengeMarket is Ownable, ReentrancyGuard {
    enum Status {
        None,
        Open,
        Upheld,
        Rejected
    }

    struct Challenge {
        bytes32 requestHash;
        address challenger;
        uint256 bond;
        uint64 openedAt;
        uint64 reviewDeadline;
        bool originalPassed;
        uint8 upholdVotes;
        uint8 rejectVotes;
        Status status;
        uint256 slashedTotal;
        uint256 challengerPayout;
        address[] reviewers;
    }

    ValidationRegistry public immutable registry;
    ValidatorStaking public immutable staking;

    address public treasury;
    address public arbiter;
    uint256 public challengeBond;
    uint64 public challengeWindow;
    uint64 public reviewPeriod;
    uint16 public slashBps;
    uint16 public challengerCutBps;
    uint8 public reviewQuorumSize;

    Challenge[] private _challenges;
    mapping(bytes32 requestHash => uint256 challengeId) public challengeOf; // 1-based
    mapping(uint256 challengeId => mapping(address reviewer => uint8)) public reviewVote; // 0 none, 1 uphold, 2 reject
    mapping(address account => uint256) public credits; // failed pushes, claimable

    event ChallengeOpened(
        uint256 indexed challengeId, bytes32 indexed requestHash, address indexed challenger, uint256 bond, address[] reviewers
    );
    event ReviewSubmitted(uint256 indexed challengeId, address indexed reviewer, bool uphold);
    event ChallengeResolved(
        uint256 indexed challengeId, bytes32 indexed requestHash, bool upheld, uint256 slashedTotal, uint256 challengerPayout
    );
    event ParamsUpdated();
    event CreditWithdrawn(address indexed account, uint256 amount);

    error NotFinalized();
    error WindowClosed();
    error AlreadyChallenged();
    error WrongBond();
    error NotOpen();
    error NotReviewer();
    error AlreadyReviewed();
    error ReviewClosed();
    error NotArbiter();
    error ArbiterNotAllowedYet();
    error ReviewStillOpen();
    error BadParams();
    error NothingToWithdraw();
    error TransferFailed();
    error UnexpectedSender();

    struct Params {
        address treasury;
        address arbiter;
        uint256 challengeBond;
        uint64 challengeWindow;
        uint64 reviewPeriod;
        uint16 slashBps;
        uint16 challengerCutBps;
        uint8 reviewQuorumSize;
    }

    constructor(ValidationRegistry registry_, ValidatorStaking staking_, Params memory p) Ownable(msg.sender) {
        registry = registry_;
        staking = staking_;
        _setParams(p);
    }

    receive() external payable {
        if (msg.sender != address(staking)) revert UnexpectedSender();
    }

    function setParams(Params calldata p) external onlyOwner {
        _setParams(p);
    }

    function _setParams(Params memory p) private {
        if (p.slashBps > 10_000 || p.challengerCutBps > 10_000 || p.treasury == address(0) || p.arbiter == address(0)) {
            revert BadParams();
        }
        treasury = p.treasury;
        arbiter = p.arbiter;
        challengeBond = p.challengeBond;
        challengeWindow = p.challengeWindow;
        reviewPeriod = p.reviewPeriod;
        slashBps = p.slashBps;
        challengerCutBps = p.challengerCutBps;
        reviewQuorumSize = p.reviewQuorumSize;
        emit ParamsUpdated();
    }

    // ───────────────────────────── challenge lifecycle ─────────────────────────────

    function challenge(bytes32 requestHash) external payable returns (uint256 id) {
        (bool finalized, bool passed) = registry.outcome(requestHash);
        if (!finalized) revert NotFinalized();
        if (block.timestamp > challengeDeadline(requestHash)) revert WindowClosed();
        if (challengeOf[requestHash] != 0) revert AlreadyChallenged();
        if (msg.value != challengeBond) revert WrongBond();

        address[] memory reviewers = _pickReviewers(requestHash, msg.sender);
        _challenges.push();
        id = _challenges.length;
        Challenge storage c = _challenges[id - 1];
        c.requestHash = requestHash;
        c.challenger = msg.sender;
        c.bond = msg.value;
        c.openedAt = uint64(block.timestamp);
        c.reviewDeadline = uint64(block.timestamp) + reviewPeriod;
        c.originalPassed = passed;
        c.status = Status.Open;
        c.reviewers = reviewers;
        challengeOf[requestHash] = id;

        emit ChallengeOpened(id, requestHash, msg.sender, msg.value, reviewers);
    }

    /// @notice A fresh-quorum reviewer re-checks the original claim. `uphold` = the challenger is right.
    function submitReview(uint256 id, bool uphold) external {
        Challenge storage c = _get(id);
        if (c.status != Status.Open) revert NotOpen();
        if (block.timestamp > c.reviewDeadline) revert ReviewClosed();
        if (!_contains(c.reviewers, msg.sender)) revert NotReviewer();
        if (reviewVote[id][msg.sender] != 0) revert AlreadyReviewed();

        reviewVote[id][msg.sender] = uphold ? 1 : 2;
        if (uphold) c.upholdVotes++;
        else c.rejectVotes++;
        emit ReviewSubmitted(id, msg.sender, uphold);

        uint256 majority = c.reviewers.length / 2 + 1;
        if (c.upholdVotes >= majority) _resolve(id, c, true);
        else if (c.rejectVotes >= majority) _resolve(id, c, false);
    }

    /// @notice After the review deadline, settle on the votes cast. Ties (incl. no votes) need the arbiter.
    function finalizeReview(uint256 id) external {
        Challenge storage c = _get(id);
        if (c.status != Status.Open) revert NotOpen();
        if (block.timestamp <= c.reviewDeadline) revert ReviewStillOpen();
        if (c.upholdVotes == c.rejectVotes) revert ArbiterNotAllowedYet();
        _resolve(id, c, c.upholdVotes > c.rejectVotes);
    }

    /// @notice Arbiter fallback: allowed when no reviewers were available, or the review deadline has passed.
    function resolveByArbiter(uint256 id, bool uphold) external {
        if (msg.sender != arbiter) revert NotArbiter();
        Challenge storage c = _get(id);
        if (c.status != Status.Open) revert NotOpen();
        if (c.reviewers.length != 0 && block.timestamp <= c.reviewDeadline) revert ArbiterNotAllowedYet();
        _resolve(id, c, uphold);
    }

    function _resolve(uint256 id, Challenge storage c, bool upheld) private nonReentrant {
        if (upheld) {
            c.status = Status.Upheld;
            registry.overturn(c.requestHash);

            ValidationRegistry.Choice wrong = c.originalPassed ? ValidationRegistry.Choice.Pass : ValidationRegistry.Choice.Fail;
            address[] memory validators = registry.getValidators(c.requestHash);
            uint256 slashed;
            for (uint256 i; i < validators.length; ++i) {
                if (registry.getVote(c.requestHash, validators[i]).choice == wrong) {
                    slashed += staking.slash(validators[i], slashBps, address(this));
                }
            }
            uint256 cut = (slashed * challengerCutBps) / 10_000;
            c.slashedTotal = slashed;
            c.challengerPayout = cut;
            _pay(c.challenger, c.bond + cut);
            if (slashed > cut) _pay(treasury, slashed - cut);
        } else {
            c.status = Status.Rejected;
            _pay(treasury, c.bond);
        }
        emit ChallengeResolved(id, c.requestHash, upheld, c.slashedTotal, c.challengerPayout);
    }

    function withdrawCredits() external nonReentrant {
        uint256 amount = credits[msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        credits[msg.sender] = 0;
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit CreditWithdrawn(msg.sender, amount);
    }

    // ───────────────────────────── views ─────────────────────────────

    function challengeDeadline(bytes32 requestHash) public view returns (uint64) {
        return registry.getRequest(requestHash).finalizedAt + challengeWindow;
    }

    /// @notice A result is final once its challenge window has elapsed unchallenged, or its challenge resolved.
    function isFinal(bytes32 requestHash) external view returns (bool) {
        (bool finalized,) = registry.outcome(requestHash);
        if (!finalized) return false;
        uint256 id = challengeOf[requestHash];
        if (id != 0) return _challenges[id - 1].status != Status.Open;
        return block.timestamp > challengeDeadline(requestHash);
    }

    function getChallenge(uint256 id) external view returns (Challenge memory) {
        return _get(id);
    }

    function challengeCount() external view returns (uint256) {
        return _challenges.length;
    }

    // ───────────────────────────── internals ─────────────────────────────

    function _get(uint256 id) private view returns (Challenge storage) {
        if (id == 0 || id > _challenges.length) revert NotOpen();
        return _challenges[id - 1];
    }

    /// @dev Pseudo-random walk over bonded validators, skipping the original set and the challenger.
    ///      Good enough for a testnet demo; production would use a VRF.
    function _pickReviewers(bytes32 requestHash, address challenger) private view returns (address[] memory picked) {
        address[] memory all = staking.getValidators();
        address[] memory original = registry.getValidators(requestHash);
        picked = new address[](reviewQuorumSize);
        uint256 count;
        uint256 n = all.length;
        if (n == 0) return new address[](0);
        uint256 start = uint256(keccak256(abi.encode(block.prevrandao, requestHash, challenger))) % n;
        for (uint256 k; k < n && count < reviewQuorumSize; ++k) {
            address v = all[(start + k) % n];
            if (v == challenger || !staking.isActive(v) || _contains(original, v)) continue;
            picked[count++] = v;
        }
        assembly {
            mstore(picked, count)
        }
    }

    function _contains(address[] memory list, address a) private pure returns (bool) {
        for (uint256 i; i < list.length; ++i) {
            if (list[i] == a) return true;
        }
        return false;
    }

    function _pay(address to, uint256 amount) private {
        if (amount == 0) return;
        (bool ok,) = to.call{value: amount, gas: 50_000}("");
        if (!ok) credits[to] += amount;
    }
}
