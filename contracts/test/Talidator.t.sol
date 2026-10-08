// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Base} from "./Base.t.sol";
import {IdentityRegistry} from "../src/IdentityRegistry.sol";
import {ValidatorStaking} from "../src/ValidatorStaking.sol";
import {ValidationRegistry} from "../src/ValidationRegistry.sol";
import {Escrow} from "../src/Escrow.sol";
import {ChallengeMarket} from "../src/ChallengeMarket.sol";
import {ReputationRegistry} from "../src/ReputationRegistry.sol";

/// @notice End-to-end scenarios from the PRD's "Catch the Liar" demo.
contract DemoScenarioTest is Base {
    bytes32 constant H = keccak256("trade-8432");

    function test_HonestTrade_QuorumPasses_PaymentReleased() public {
        _request(trader, traderId, H, 1 ether);
        _voteAll(H, true, true, false); // 2-of-3

        (bool finalized, bool passed) = registry.outcome(H);
        assertTrue(finalized);
        assertTrue(passed);

        uint256 before = trader.balance;
        escrow.release(H);
        assertEq(trader.balance - before, 1 ether);
        assertEq(uint8(escrow.getDeal(H).state), uint8(Escrow.State.Released));
    }

    function test_CatchTheLiar_QuorumFails_PaymentRefused() public {
        _request(liar, liarId, H, 1 ether);
        _voteAll(H, false, false, false);

        (bool finalized, bool passed) = registry.outcome(H);
        assertTrue(finalized);
        assertFalse(passed);

        vm.expectRevert(Escrow.NotPassed.selector);
        escrow.release(H);

        uint256 before = client.balance;
        escrow.refund(H);
        assertEq(client.balance - before, 1 ether);
    }

    function test_Collusion_ChallengeUpheld_SlashesValidatorsAndPaysChallenger() public {
        // Liar's fabricated trade; validators 0 and 1 collude and pass it, validator 2 is honest.
        _request(liar, liarId, H, 1 ether);
        _voteAll(H, true, true, false);
        (, bool passed) = registry.outcome(H);
        assertTrue(passed);

        vm.prank(challenger);
        uint256 id = market.challenge{value: CHALLENGE_BOND}(H);
        ChallengeMarket.Challenge memory c = market.getChallenge(id);
        assertEq(c.reviewers.length, 3);
        for (uint256 i; i < 3; ++i) {
            // fresh quorum never includes the original validators
            assertTrue(c.reviewers[i] != validators[0] && c.reviewers[i] != validators[1] && c.reviewers[i] != validators[2]);
        }

        uint256 challengerBefore = challenger.balance;
        uint256 treasuryBefore = treasury.balance;
        _reviewAll(id, true);

        c = market.getChallenge(id);
        assertEq(uint8(c.status), uint8(ChallengeMarket.Status.Upheld));
        uint256 slashEach = (5 ether * uint256(SLASH_BPS)) / 10_000;
        assertEq(c.slashedTotal, 2 * slashEach);
        assertEq(c.challengerPayout, c.slashedTotal * CHALLENGER_CUT_BPS / 10_000);
        assertEq(challenger.balance - challengerBefore, CHALLENGE_BOND + c.challengerPayout);
        assertEq(treasury.balance - treasuryBefore, c.slashedTotal - c.challengerPayout);

        // colluders slashed, honest dissenter untouched
        assertEq(staking.getStake(validators[0]).amount, 5 ether - slashEach);
        assertEq(staking.getStake(validators[1]).amount, 5 ether - slashEach);
        assertEq(staking.getStake(validators[2]).amount, 5 ether);

        (, passed) = registry.outcome(H);
        assertFalse(passed, "result overturned");
    }

    function test_OverturnedBeforeRelease_EscrowRefundsPayer() public {
        _request(liar, liarId, H, 1 ether);
        _voteAll(H, true, true, true);
        vm.prank(challenger);
        uint256 id = market.challenge{value: CHALLENGE_BOND}(H);
        _reviewAll(id, true);

        vm.expectRevert(Escrow.NotPassed.selector);
        escrow.release(H);
        uint256 before = client.balance;
        escrow.refund(H);
        assertEq(client.balance - before, 1 ether);
    }

    function test_ChallengeRejected_BondForfeitedToTreasury() public {
        _request(trader, traderId, H, 1 ether);
        _voteAll(H, true, true, true);

        vm.prank(challenger);
        uint256 id = market.challenge{value: CHALLENGE_BOND}(H);
        uint256 treasuryBefore = treasury.balance;
        _reviewAll(id, false);

        assertEq(uint8(market.getChallenge(id).status), uint8(ChallengeMarket.Status.Rejected));
        assertEq(treasury.balance - treasuryBefore, CHALLENGE_BOND);
        assertEq(staking.getStake(validators[0]).amount, 5 ether);
        (, bool passed) = registry.outcome(H);
        assertTrue(passed);
    }

    function test_FailedResultCanBeChallengedToo() public {
        // Honest trade wrongly failed by two validators → challenger gets it overturned to PASS.
        _request(trader, traderId, H, 1 ether);
        _voteAll(H, false, false, true);
        vm.prank(challenger);
        uint256 id = market.challenge{value: CHALLENGE_BOND}(H);
        _reviewAll(id, true);

        (, bool passed) = registry.outcome(H);
        assertTrue(passed);
        assertEq(staking.getStake(validators[2]).amount, 5 ether);
        assertLt(staking.getStake(validators[0]).amount, 5 ether);
        escrow.release(H); // payment now flows
    }
}

contract ValidationRegistryTest is Base {
    bytes32 constant H = keccak256("trade");

    function test_RelayerSubmitsSignedVote() public {
        _request(trader, traderId, H, 1 ether);
        bytes32 digest = registry.voteDigest(H, true, keccak256("evidence"));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(validatorKeys[0], digest);

        address relayer = makeAddr("relayer");
        vm.prank(relayer);
        registry.submitVoteBySig(H, validators[0], true, keccak256("evidence"), abi.encodePacked(r, s, v));

        ValidationRegistry.Vote memory vote = registry.getVote(H, validators[0]);
        assertEq(uint8(vote.choice), uint8(ValidationRegistry.Choice.Pass));
        assertEq(vote.evidenceHash, keccak256("evidence"));
    }

    /// Monad supports EIP-7702: a delegated EOA has code (0xef0100 ‖ delegate) but still signs with its key.
    function test_RelayerAcceptsSignatureFromEip7702DelegatedValidator() public {
        vm.etch(validators[0], abi.encodePacked(hex"ef0100", address(0xBEEF)));
        _request(trader, traderId, H, 1 ether);
        bytes32 digest = registry.voteDigest(H, true, bytes32(0));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(validatorKeys[0], digest);
        registry.submitVoteBySig(H, validators[0], true, bytes32(0), abi.encodePacked(r, s, v));
        assertEq(uint8(registry.getVote(H, validators[0]).choice), uint8(ValidationRegistry.Choice.Pass));
    }

    function test_RevertWhen_SignatureFromWrongKey() public {
        _request(trader, traderId, H, 1 ether);
        bytes32 digest = registry.voteDigest(H, true, bytes32(0));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(validatorKeys[1], digest);
        vm.expectRevert(ValidationRegistry.BadSignature.selector);
        registry.submitVoteBySig(H, validators[0], true, bytes32(0), abi.encodePacked(r, s, v));
    }

    function test_FinalizeAfterDeadline_MissingVotesDoNotPass() public {
        _request(trader, traderId, H, 1 ether);
        vm.prank(validators[0]);
        registry.submitVote(H, true, bytes32(0));

        vm.expectRevert(ValidationRegistry.NotFinalizable.selector);
        registry.finalize(H);

        vm.warp(block.timestamp + VOTING_PERIOD + 1);
        vm.prank(validators[1]);
        vm.expectRevert(ValidationRegistry.VotingClosed.selector);
        registry.submitVote(H, true, bytes32(0));

        registry.finalize(H);
        (bool finalized, bool passed) = registry.outcome(H);
        assertTrue(finalized);
        assertFalse(passed); // 1 pass < 2 threshold
    }

    function test_ExplicitThreshold_3of3() public {
        vm.prank(trader);
        registry.validationRequestWithThreshold(_set3(), traderId, "uri", H, 3);
        _voteAll(H, true, true, false);
        (, bool passed) = registry.outcome(H);
        assertFalse(passed);
    }

    function test_ValidatorStatsTrackAgreement() public {
        _request(trader, traderId, H, 1 ether);
        _voteAll(H, true, true, false);
        (uint64 assigned, uint64 cast, uint64 agreed) = registry.validatorStats(validators[2]);
        assertEq(assigned, 1);
        assertEq(cast, 1);
        assertEq(agreed, 0);
        (,, agreed) = registry.validatorStats(validators[0]);
        assertEq(agreed, 1);
    }

    function test_RequestHashesPagedNewestFirst() public {
        _request(trader, traderId, keccak256("a"), 1 ether);
        _request(trader, traderId, keccak256("b"), 1 ether);
        bytes32[] memory page = registry.getRequestHashes(0, 10);
        assertEq(page.length, 2);
        assertEq(page[0], keccak256("b"));
        assertEq(registry.getRequestHashes(1, 10)[0], keccak256("a"));
    }

    function test_RevertWhen_UnassignedValidatorVotes() public {
        _request(trader, traderId, H, 1 ether);
        vm.prank(validators[4]);
        vm.expectRevert(ValidationRegistry.NotAssigned.selector);
        registry.submitVote(H, true, bytes32(0));
    }

    function test_RevertWhen_DoubleVote() public {
        _request(trader, traderId, H, 1 ether);
        vm.startPrank(validators[0]);
        registry.submitVote(H, true, bytes32(0));
        vm.expectRevert(ValidationRegistry.AlreadyVoted.selector);
        registry.submitVote(H, false, bytes32(0));
        vm.stopPrank();
    }

    function test_RevertWhen_RequesterNotAuthorizedForAgent() public {
        vm.prank(liar);
        vm.expectRevert(ValidationRegistry.NotAuthorizedForAgent.selector);
        registry.validationRequest(_set3(), traderId, "uri", H);
    }

    function test_RevertWhen_DuplicateRequestHash() public {
        _request(trader, traderId, H, 1 ether);
        vm.prank(trader);
        vm.expectRevert(ValidationRegistry.AlreadyRequested.selector);
        registry.validationRequest(_set3(), traderId, "uri", H);
    }

    function test_RevertWhen_ValidatorNotBonded() public {
        address[] memory set = _set3();
        set[2] = makeAddr("nobody");
        vm.prank(trader);
        vm.expectRevert(abi.encodeWithSelector(ValidationRegistry.ValidatorNotActive.selector, set[2]));
        registry.validationRequest(set, traderId, "uri", H);
    }

    function test_RevertWhen_DuplicateValidator() public {
        address[] memory set = _set3();
        set[2] = set[0];
        vm.prank(trader);
        vm.expectRevert(abi.encodeWithSelector(ValidationRegistry.DuplicateValidator.selector, set[0]));
        registry.validationRequest(set, traderId, "uri", H);
    }

    function test_RevertWhen_ValidatorIdentityRequestsValidation() public {
        vm.prank(validators[0]);
        vm.expectRevert(ValidationRegistry.NotAuthorizedForAgent.selector);
        registry.validationRequest(_set3(), traderId, "uri", H);
    }

    function test_RevertWhen_NonMarketOverturns() public {
        _request(trader, traderId, H, 1 ether);
        _voteAll(H, true, true, true);
        vm.expectRevert(ValidationRegistry.NotChallengeMarket.selector);
        registry.overturn(H);
    }
}

contract ChallengeMarketTest is Base {
    bytes32 constant H = keccak256("trade");

    function _passed() internal {
        _request(trader, traderId, H, 1 ether);
        _voteAll(H, true, true, true);
    }

    function test_RevertWhen_ChallengeAfterWindow() public {
        _passed();
        vm.warp(block.timestamp + CHALLENGE_WINDOW + 1);
        vm.prank(challenger);
        vm.expectRevert(ChallengeMarket.WindowClosed.selector);
        market.challenge{value: CHALLENGE_BOND}(H);
    }

    function test_RevertWhen_ChallengeBeforeFinalized() public {
        _request(trader, traderId, H, 1 ether);
        vm.prank(challenger);
        vm.expectRevert(ChallengeMarket.NotFinalized.selector);
        market.challenge{value: CHALLENGE_BOND}(H);
    }

    function test_RevertWhen_WrongBond() public {
        _passed();
        vm.prank(challenger);
        vm.expectRevert(ChallengeMarket.WrongBond.selector);
        market.challenge{value: 0.1 ether}(H);
    }

    function test_RevertWhen_ChallengedTwice() public {
        _passed();
        vm.prank(challenger);
        market.challenge{value: CHALLENGE_BOND}(H);
        vm.prank(challenger);
        vm.expectRevert(ChallengeMarket.AlreadyChallenged.selector);
        market.challenge{value: CHALLENGE_BOND}(H);
    }

    function test_RevertWhen_NonReviewerReviews() public {
        _passed();
        vm.prank(challenger);
        uint256 id = market.challenge{value: CHALLENGE_BOND}(H);
        vm.prank(validators[0]); // original validator, excluded from review
        vm.expectRevert(ChallengeMarket.NotReviewer.selector);
        market.submitReview(id, false);
    }

    function test_ArbiterOnlyAfterReviewDeadline() public {
        _passed();
        vm.prank(challenger);
        uint256 id = market.challenge{value: CHALLENGE_BOND}(H);

        vm.prank(arbiter);
        vm.expectRevert(ChallengeMarket.ArbiterNotAllowedYet.selector);
        market.resolveByArbiter(id, true);

        vm.warp(block.timestamp + REVIEW_PERIOD + 1);
        vm.prank(makeAddr("rando"));
        vm.expectRevert(ChallengeMarket.NotArbiter.selector);
        market.resolveByArbiter(id, true);

        vm.prank(arbiter);
        market.resolveByArbiter(id, true);
        assertEq(uint8(market.getChallenge(id).status), uint8(ChallengeMarket.Status.Upheld));
    }

    function test_FinalizeReviewWithPartialVotes() public {
        _passed();
        vm.prank(challenger);
        uint256 id = market.challenge{value: CHALLENGE_BOND}(H);
        vm.prank(market.getChallenge(id).reviewers[0]);
        market.submitReview(id, false);

        vm.expectRevert(ChallengeMarket.ReviewStillOpen.selector);
        market.finalizeReview(id);
        vm.warp(block.timestamp + REVIEW_PERIOD + 1);
        market.finalizeReview(id);
        assertEq(uint8(market.getChallenge(id).status), uint8(ChallengeMarket.Status.Rejected));
    }

    function test_IsFinal() public {
        _passed();
        assertFalse(market.isFinal(H));
        vm.warp(block.timestamp + CHALLENGE_WINDOW + 1);
        assertTrue(market.isFinal(H));
    }

    function test_IsFinal_FalseWhileChallengeOpen() public {
        _passed();
        vm.prank(challenger);
        uint256 id = market.challenge{value: CHALLENGE_BOND}(H);
        vm.warp(block.timestamp + CHALLENGE_WINDOW + 1);
        assertFalse(market.isFinal(H));
        vm.prank(arbiter); // review deadline has passed with no votes → arbiter fallback
        market.resolveByArbiter(id, false);
        assertTrue(market.isFinal(H));
    }

    function test_FailedPushBecomesClaimableCredit() public {
        RejectingChallenger rc = new RejectingChallenger(market);
        vm.deal(address(rc), 1 ether);
        _request(liar, liarId, H, 1 ether);
        _voteAll(H, true, true, true);
        uint256 id = rc.challenge{value: 0}(H, CHALLENGE_BOND);
        _reviewAll(id, true);
        uint256 credit = market.credits(address(rc));
        assertGt(credit, CHALLENGE_BOND);
        rc.enableReceive();
        rc.withdraw();
        assertEq(market.credits(address(rc)), 0);
    }
}

contract StakingAndIdentityTest is Base {
    function test_UnbondingLocksStakeThenWithdraws() public {
        address v = validators[5];
        vm.startPrank(v);
        staking.beginUnbonding();
        assertFalse(staking.isActive(v));
        vm.expectRevert();
        staking.withdraw();
        vm.warp(block.timestamp + UNBONDING);
        uint256 before = v.balance;
        staking.withdraw();
        vm.stopPrank();
        assertEq(v.balance - before, 5 ether);
    }

    function test_RevertWhen_NonSlasherSlashes() public {
        vm.expectRevert(ValidatorStaking.NotSlasher.selector);
        staking.slash(validators[0], 1000, address(this));
    }

    function test_RevertWhen_BondBelowMinimum() public {
        address v = makeAddr("smallValidator");
        vm.deal(v, 1 ether);
        vm.startPrank(v);
        uint256 id = identity.register("uri", IdentityRegistry.Role.Validator, v);
        vm.expectRevert(ValidatorStaking.BelowMinBond.selector);
        staking.bond{value: 0.5 ether}(id);
        vm.stopPrank();
    }

    function test_RevertWhen_TraderIdentityBonds() public {
        vm.deal(trader, 5 ether);
        vm.prank(trader);
        vm.expectRevert(ValidatorStaking.NotValidatorIdentity.selector);
        staking.bond{value: 2 ether}(traderId);
    }

    function test_SlashBelowMinBondDeactivates() public {
        address v = makeAddr("thinValidator");
        vm.deal(v, 2 ether);
        vm.startPrank(v);
        uint256 id = identity.register("uri", IdentityRegistry.Role.Validator, v);
        staking.bond{value: 1 ether}(id);
        vm.stopPrank();
        vm.prank(address(market));
        staking.slash(v, SLASH_BPS, treasury);
        assertFalse(staking.isActive(v));
    }

    function test_IdentityRegisterAndAuthorize() public {
        address owner = makeAddr("operator");
        address hot = makeAddr("hot");
        vm.prank(owner);
        uint256 id = identity.register("ipfs://x", IdentityRegistry.Role.Trader, hot);
        assertEq(identity.ownerOf(id), owner);
        assertTrue(identity.isAuthorized(id, owner));
        assertTrue(identity.isAuthorized(id, hot));
        assertFalse(identity.isAuthorized(id, trader));
        assertEq(identity.tokenURI(id), "ipfs://x");

        vm.expectRevert(abi.encodeWithSelector(IdentityRegistry.WalletAlreadyRegistered.selector, hot));
        identity.register("ipfs://y", IdentityRegistry.Role.Trader, hot);
    }
}

contract ReputationTest is Base {
    function test_OnlyFinalOutcomesPosted() public {
        bytes32 h1 = keccak256("r1");
        bytes32 h2 = keccak256("r2");
        _request(trader, traderId, h1, 1 ether);
        _voteAll(h1, true, true, true);
        _request(trader, traderId, h2, 1 ether);
        _voteAll(h2, false, false, true);

        vm.expectRevert(ReputationRegistry.NotFinal.selector);
        reputation.postOutcome(h1);

        vm.warp(block.timestamp + CHALLENGE_WINDOW + 1);
        reputation.postOutcome(h1);
        reputation.postOutcome(h2);
        vm.expectRevert(ReputationRegistry.AlreadyPosted.selector);
        reputation.postOutcome(h1);

        (uint64 count, uint256 avg) = reputation.getSummary(traderId);
        assertEq(count, 2);
        assertEq(avg, 5000); // 50.00
    }
}

contract RejectingChallenger {
    ChallengeMarket immutable market;
    bool accept;

    constructor(ChallengeMarket m) {
        market = m;
    }

    function challenge(bytes32 h, uint256 bond) external payable returns (uint256) {
        return market.challenge{value: bond}(h);
    }

    function enableReceive() external {
        accept = true;
    }

    function withdraw() external {
        market.withdrawCredits();
    }

    receive() external payable {
        require(accept, "no");
    }
}
