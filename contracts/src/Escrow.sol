// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ValidationRegistry} from "./ValidationRegistry.sol";

/// @title Escrow
/// @notice Payment gating: a payer locks funds against a validation `requestHash`. Funds go to the payee
///         only once the ValidationRegistry records a passing quorum result, and back to the payer if the
///         result fails (or is overturned before release). Release / refund are permissionless so any
///         keeper can settle.
contract Escrow is ReentrancyGuard {
    enum State {
        None,
        Funded,
        Released,
        Refunded
    }

    struct Deal {
        address payer;
        address payee;
        uint256 amount;
        uint64 fundedAt;
        State state;
    }

    /// @notice A deposit whose request was never posted can be reclaimed after this long.
    uint64 public constant UNUSED_DEPOSIT_TIMEOUT = 1 days;

    ValidationRegistry public immutable registry;
    mapping(bytes32 requestHash => Deal) private _deals;

    event Deposited(bytes32 indexed requestHash, address indexed payer, address indexed payee, uint256 amount);
    event Released(bytes32 indexed requestHash, address indexed payee, uint256 amount);
    event Refunded(bytes32 indexed requestHash, address indexed payer, uint256 amount);

    error AlreadyFunded();
    error ZeroAmount();
    error ZeroPayee();
    error NotFunded();
    error NotPassed();
    error NotRefundable();
    error TransferFailed();

    constructor(ValidationRegistry registry_) {
        registry = registry_;
    }

    function deposit(bytes32 requestHash, address payee) external payable {
        if (msg.value == 0) revert ZeroAmount();
        if (payee == address(0)) revert ZeroPayee();
        Deal storage d = _deals[requestHash];
        if (d.state != State.None) revert AlreadyFunded();
        _deals[requestHash] = Deal(msg.sender, payee, msg.value, uint64(block.timestamp), State.Funded);
        emit Deposited(requestHash, msg.sender, payee, msg.value);
    }

    function release(bytes32 requestHash) external nonReentrant {
        Deal storage d = _deals[requestHash];
        if (d.state != State.Funded) revert NotFunded();
        (bool finalized, bool passed) = registry.outcome(requestHash);
        if (!finalized || !passed) revert NotPassed();
        d.state = State.Released;
        _send(d.payee, d.amount);
        emit Released(requestHash, d.payee, d.amount);
    }

    function refund(bytes32 requestHash) external nonReentrant {
        Deal storage d = _deals[requestHash];
        if (d.state != State.Funded) revert NotFunded();
        (bool finalized, bool passed) = registry.outcome(requestHash);
        bool failed = finalized && !passed;
        bool neverRequested = registry.getRequest(requestHash).status == ValidationRegistry.Status.None
            && block.timestamp > d.fundedAt + UNUSED_DEPOSIT_TIMEOUT;
        if (!failed && !neverRequested) revert NotRefundable();
        d.state = State.Refunded;
        _send(d.payer, d.amount);
        emit Refunded(requestHash, d.payer, d.amount);
    }

    function getDeal(bytes32 requestHash) external view returns (Deal memory) {
        return _deals[requestHash];
    }

    function _send(address to, uint256 amount) private {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
