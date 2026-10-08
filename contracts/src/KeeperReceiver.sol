// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {ValidationRegistry} from "./ValidationRegistry.sol";
import {Escrow} from "./Escrow.sol";
import {ChallengeMarket} from "./ChallengeMarket.sol";
import {ReputationRegistry} from "./ReputationRegistry.sol";

/// @notice Chainlink CRE receiver interface (reports are delivered by the CRE Forwarder).
interface IReceiver is IERC165 {
    function onReport(bytes calldata metadata, bytes calldata report) external;
}

/// @title KeeperReceiver
/// @notice Lets a Chainlink CRE workflow act as Talidator's keeper. The workflow reads `pendingActions()`,
///         orchestrates off-chain checks (e.g. the AI auditor's verdict), and delivers a signed report through the
///         CRE Forwarder. Each report is a batch of permissionless upkeep actions — finalize after the voting
///         deadline, release / refund escrow, post reputation — executed with try/catch so one stale action can't
///         block the rest.
contract KeeperReceiver is IReceiver, Ownable {
    enum Action {
        None,
        Finalize,
        Release,
        Refund,
        PostReputation
    }

    ValidationRegistry public immutable registry;
    Escrow public immutable escrow;
    ChallengeMarket public immutable market;
    ReputationRegistry public immutable reputation;

    /// @dev CRE forwarders allowed to deliver reports (simulation MockForwarder and/or the production Forwarder).
    mapping(address forwarder => bool) public isForwarder;
    /// @dev Optional: only accept reports from workflows owned by this address (0 = any owner).
    address public expectedWorkflowOwner;

    event ForwarderSet(address indexed forwarder, bool allowed);
    event ExpectedWorkflowOwnerSet(address indexed owner);
    event KeeperAction(Action indexed action, bytes32 indexed requestHash, bool ok);
    event ReportProcessed(uint256 actions, uint256 succeeded);

    error UnauthorizedForwarder(address sender);
    error UnexpectedWorkflowOwner(address owner);
    error LengthMismatch();

    constructor(
        ValidationRegistry registry_,
        Escrow escrow_,
        ChallengeMarket market_,
        ReputationRegistry reputation_,
        address[] memory forwarders
    ) Ownable(msg.sender) {
        registry = registry_;
        escrow = escrow_;
        market = market_;
        reputation = reputation_;
        for (uint256 i; i < forwarders.length; ++i) {
            isForwarder[forwarders[i]] = true;
            emit ForwarderSet(forwarders[i], true);
        }
    }

    function setForwarder(address forwarder, bool allowed) external onlyOwner {
        isForwarder[forwarder] = allowed;
        emit ForwarderSet(forwarder, allowed);
    }

    function setExpectedWorkflowOwner(address owner_) external onlyOwner {
        expectedWorkflowOwner = owner_;
        emit ExpectedWorkflowOwnerSet(owner_);
    }

    // ───────────────────────────── CRE entry point ─────────────────────────────

    /// @param metadata CRE report metadata: workflowId (32) ‖ workflowName (10) ‖ workflowOwner (20)
    /// @param report   abi.encode(uint8[] actions, bytes32[] requestHashes)
    function onReport(bytes calldata metadata, bytes calldata report) external override {
        if (!isForwarder[msg.sender]) revert UnauthorizedForwarder(msg.sender);
        if (expectedWorkflowOwner != address(0)) {
            address owner_ = _workflowOwner(metadata);
            if (owner_ != expectedWorkflowOwner) revert UnexpectedWorkflowOwner(owner_);
        }

        (uint8[] memory actions, bytes32[] memory hashes) = abi.decode(report, (uint8[], bytes32[]));
        if (actions.length != hashes.length) revert LengthMismatch();

        uint256 ok;
        for (uint256 i; i < actions.length; ++i) {
            bool success = _execute(Action(actions[i]), hashes[i]);
            if (success) ++ok;
            emit KeeperAction(Action(actions[i]), hashes[i], success);
        }
        emit ReportProcessed(actions.length, ok);
    }

    function supportsInterface(bytes4 interfaceId) external pure override returns (bool) {
        return interfaceId == type(IReceiver).interfaceId || interfaceId == type(IERC165).interfaceId;
    }

    // ───────────────────────────── upkeep discovery ─────────────────────────────

    /// @notice Upkeep due among the `limit` most recent requests — one read for the CRE workflow.
    function pendingActions(uint256 limit) external view returns (uint8[] memory actions, bytes32[] memory hashes) {
        bytes32[] memory recent = registry.getRequestHashes(0, limit);
        uint8[] memory a = new uint8[](recent.length * 2);
        bytes32[] memory h = new bytes32[](recent.length * 2);
        uint256 n;
        for (uint256 i; i < recent.length; ++i) {
            bytes32 rh = recent[i];
            ValidationRegistry.Request memory r = registry.getRequest(rh);
            if (r.status == ValidationRegistry.Status.Pending) {
                if (block.timestamp > r.deadline) (a[n], h[n++]) = (uint8(Action.Finalize), rh);
                continue;
            }
            (bool finalized, bool passed) = registry.outcome(rh);
            if (!finalized) continue;
            bool isFinal = market.isFinal(rh);
            if (escrow.getDeal(rh).state == Escrow.State.Funded) {
                // Refund failures at once; release passes only once the result can no longer be challenged.
                if (!passed) (a[n], h[n++]) = (uint8(Action.Refund), rh);
                else if (isFinal) (a[n], h[n++]) = (uint8(Action.Release), rh);
            }
            if (isFinal && !reputation.posted(rh)) (a[n], h[n++]) = (uint8(Action.PostReputation), rh);
        }
        actions = new uint8[](n);
        hashes = new bytes32[](n);
        for (uint256 i; i < n; ++i) (actions[i], hashes[i]) = (a[i], h[i]);
    }

    // ───────────────────────────── internals ─────────────────────────────

    function _execute(Action action, bytes32 rh) private returns (bool) {
        if (action == Action.Finalize) {
            try registry.finalize(rh) { return true; } catch { return false; }
        }
        if (action == Action.Release) {
            try escrow.release(rh) { return true; } catch { return false; }
        }
        if (action == Action.Refund) {
            try escrow.refund(rh) { return true; } catch { return false; }
        }
        if (action == Action.PostReputation) {
            try reputation.postOutcome(rh) { return true; } catch { return false; }
        }
        return false;
    }

    function _workflowOwner(bytes calldata metadata) private pure returns (address owner_) {
        // workflowId (32 bytes) ‖ workflowName (10 bytes) ‖ workflowOwner (20 bytes)
        if (metadata.length < 62) return address(0);
        owner_ = address(bytes20(metadata[42:62]));
    }
}
