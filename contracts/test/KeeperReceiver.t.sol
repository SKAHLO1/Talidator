// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Base} from "./Base.t.sol";
import {Escrow} from "../src/Escrow.sol";
import {KeeperReceiver} from "../src/KeeperReceiver.sol";

contract KeeperReceiverTest is Base {
    KeeperReceiver internal keeper;
    address internal forwarder = makeAddr("creForwarder");
    bytes32 constant H_PASS = keccak256("pass");
    bytes32 constant H_FAIL = keccak256("fail");

    function setUp() public override {
        super.setUp();
        address[] memory fwd = new address[](1);
        fwd[0] = forwarder;
        vm.prank(admin);
        keeper = new KeeperReceiver(registry, escrow, market, reputation, fwd);
    }

    function _pendingContains(uint8 action, bytes32 h) internal view returns (bool) {
        (uint8[] memory a, bytes32[] memory hs) = keeper.pendingActions(25);
        for (uint256 i; i < a.length; ++i) if (a[i] == action && hs[i] == h) return true;
        return false;
    }

    function _report(uint8[] memory a, bytes32[] memory h) internal {
        vm.prank(forwarder);
        keeper.onReport("", abi.encode(a, h));
    }

    function test_DiscoversAndExecutesUpkeep() public {
        _request(trader, traderId, H_PASS, 1 ether);
        _voteAll(H_PASS, true, true, true);
        _request(liar, liarId, H_FAIL, 1 ether);
        _voteAll(H_FAIL, false, false, false);

        // Failed result: refund is due immediately; passed result waits for its challenge window.
        assertTrue(_pendingContains(uint8(KeeperReceiver.Action.Refund), H_FAIL));
        assertFalse(_pendingContains(uint8(KeeperReceiver.Action.Release), H_PASS));

        vm.warp(block.timestamp + CHALLENGE_WINDOW + 1);
        assertTrue(_pendingContains(uint8(KeeperReceiver.Action.Release), H_PASS));
        assertTrue(_pendingContains(uint8(KeeperReceiver.Action.PostReputation), H_PASS));
        assertTrue(_pendingContains(uint8(KeeperReceiver.Action.PostReputation), H_FAIL));

        (uint8[] memory a, bytes32[] memory h) = keeper.pendingActions(25);
        uint256 traderBefore = trader.balance;
        _report(a, h);

        assertEq(trader.balance - traderBefore, 1 ether, "escrow released to trader");
        assertEq(uint8(escrow.getDeal(H_FAIL).state), uint8(Escrow.State.Refunded));
        assertTrue(reputation.posted(H_PASS) && reputation.posted(H_FAIL));
        (a,) = keeper.pendingActions(25);
        assertEq(a.length, 0, "nothing left to do");
    }

    function test_FinalizesAfterDeadline() public {
        _request(trader, traderId, H_PASS, 1 ether);
        vm.prank(validators[0]);
        registry.submitVote(H_PASS, true, bytes32(0));
        vm.warp(block.timestamp + VOTING_PERIOD + 1);
        assertTrue(_pendingContains(uint8(KeeperReceiver.Action.Finalize), H_PASS));
        uint8[] memory a = new uint8[](1);
        bytes32[] memory h = new bytes32[](1);
        (a[0], h[0]) = (uint8(KeeperReceiver.Action.Finalize), H_PASS);
        _report(a, h);
        (bool finalized,) = registry.outcome(H_PASS);
        assertTrue(finalized);
    }

    function test_StaleActionDoesNotBlockBatch() public {
        _request(liar, liarId, H_FAIL, 1 ether);
        _voteAll(H_FAIL, false, false, false);
        uint8[] memory a = new uint8[](2);
        bytes32[] memory h = new bytes32[](2);
        (a[0], h[0]) = (uint8(KeeperReceiver.Action.Release), H_FAIL); // invalid: result failed
        (a[1], h[1]) = (uint8(KeeperReceiver.Action.Refund), H_FAIL);
        _report(a, h);
        assertEq(uint8(escrow.getDeal(H_FAIL).state), uint8(Escrow.State.Refunded));
    }

    function test_RevertWhen_NotForwarder() public {
        vm.expectRevert(abi.encodeWithSelector(KeeperReceiver.UnauthorizedForwarder.selector, address(this)));
        keeper.onReport("", abi.encode(new uint8[](0), new bytes32[](0)));
    }

    function test_ExpectedWorkflowOwnerEnforced() public {
        address wfOwner = makeAddr("workflowOwner");
        vm.prank(admin);
        keeper.setExpectedWorkflowOwner(wfOwner);
        bytes memory good = abi.encodePacked(bytes32(uint256(1)), bytes10("talidator"), wfOwner);
        bytes memory bad = abi.encodePacked(bytes32(uint256(1)), bytes10("talidator"), makeAddr("someoneElse"));
        bytes memory empty = abi.encode(new uint8[](0), new bytes32[](0));

        vm.prank(forwarder);
        keeper.onReport(good, empty);
        vm.prank(forwarder);
        vm.expectRevert(abi.encodeWithSelector(KeeperReceiver.UnexpectedWorkflowOwner.selector, makeAddr("someoneElse")));
        keeper.onReport(bad, empty);
    }

    function test_SupportsIReceiver() public view {
        assertTrue(keeper.supportsInterface(0x01ffc9a7)); // IERC165
    }
}
