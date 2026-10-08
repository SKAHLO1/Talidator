// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IdentityRegistry} from "./IdentityRegistry.sol";

/// @title ValidatorStaking
/// @notice Validators bond native currency to become eligible for quorums. The ChallengeMarket (the
///         `slasher`) slashes the bond of any validator whose vote is overturned by a successful challenge.
///         Withdrawal goes through an unbonding period so a validator cannot exit ahead of a challenge.
contract ValidatorStaking is Ownable, ReentrancyGuard {
    struct Stake {
        uint256 agentId;
        uint256 amount;
        uint256 slashedTotal;
        uint64 unbondAt;
        bool active;
    }

    IdentityRegistry public immutable identity;
    uint256 public immutable minBond;
    uint64 public immutable unbondingPeriod;
    address public slasher;

    mapping(address validator => Stake) private _stakes;
    address[] private _validators;

    event Bonded(address indexed validator, uint256 indexed agentId, uint256 amount, uint256 total);
    event UnbondingStarted(address indexed validator, uint64 unlockAt);
    event Withdrawn(address indexed validator, uint256 amount);
    event Slashed(address indexed validator, uint256 amount, address indexed recipient);
    event SlasherSet(address slasher);

    error NotValidatorIdentity();
    error AgentMismatch();
    error BelowMinBond();
    error AlreadyUnbonding();
    error NotActive();
    error StillLocked(uint64 unlockAt);
    error NotSlasher();
    error SlasherAlreadySet();
    error TransferFailed();

    constructor(IdentityRegistry identity_, uint256 minBond_, uint64 unbondingPeriod_) Ownable(msg.sender) {
        identity = identity_;
        minBond = minBond_;
        unbondingPeriod = unbondingPeriod_;
    }

    function setSlasher(address slasher_) external onlyOwner {
        if (slasher != address(0)) revert SlasherAlreadySet();
        slasher = slasher_;
        emit SlasherSet(slasher_);
    }

    /// @notice Bond (or top up) stake. Must be called from the validator identity's agent wallet.
    function bond(uint256 agentId) external payable {
        Stake storage s = _stakes[msg.sender];
        if (s.agentId == 0) {
            if (identity.roleOf(agentId) != IdentityRegistry.Role.Validator || identity.agentWallet(agentId) != msg.sender) {
                revert NotValidatorIdentity();
            }
            s.agentId = agentId;
            _validators.push(msg.sender);
        } else if (s.agentId != agentId) {
            revert AgentMismatch();
        }
        if (s.unbondAt != 0) revert AlreadyUnbonding();

        s.amount += msg.value;
        if (s.amount < minBond) revert BelowMinBond();
        s.active = true;
        emit Bonded(msg.sender, agentId, msg.value, s.amount);
    }

    function beginUnbonding() external {
        Stake storage s = _stakes[msg.sender];
        if (!s.active) revert NotActive();
        s.active = false;
        s.unbondAt = uint64(block.timestamp) + unbondingPeriod;
        emit UnbondingStarted(msg.sender, s.unbondAt);
    }

    function withdraw() external nonReentrant {
        Stake storage s = _stakes[msg.sender];
        if (s.unbondAt == 0) revert NotActive();
        if (block.timestamp < s.unbondAt) revert StillLocked(s.unbondAt);
        uint256 amount = s.amount;
        s.amount = 0;
        s.unbondAt = 0;
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Withdrawn(msg.sender, amount);
    }

    /// @notice Slash `bps` basis points of a validator's bond and send it to `recipient`.
    function slash(address validator, uint16 bps, address recipient) external nonReentrant returns (uint256 amount) {
        if (msg.sender != slasher) revert NotSlasher();
        Stake storage s = _stakes[validator];
        amount = (s.amount * bps) / 10_000;
        if (amount == 0) return 0;
        s.amount -= amount;
        s.slashedTotal += amount;
        if (s.active && s.amount < minBond) s.active = false;
        (bool ok,) = recipient.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Slashed(validator, amount, recipient);
    }

    function isActive(address validator) public view returns (bool) {
        Stake storage s = _stakes[validator];
        return s.active && s.amount >= minBond;
    }

    function getStake(address validator) external view returns (Stake memory) {
        return _stakes[validator];
    }

    function getValidators() external view returns (address[] memory) {
        return _validators;
    }

    function validatorCount() external view returns (uint256) {
        return _validators.length;
    }

    function validatorAt(uint256 i) external view returns (address) {
        return _validators[i];
    }
}
