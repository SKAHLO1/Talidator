// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IdentityRegistry} from "../src/IdentityRegistry.sol";
import {ValidatorStaking} from "../src/ValidatorStaking.sol";
import {ValidationRegistry} from "../src/ValidationRegistry.sol";
import {Escrow} from "../src/Escrow.sol";
import {ChallengeMarket} from "../src/ChallengeMarket.sol";
import {ReputationRegistry} from "../src/ReputationRegistry.sol";

abstract contract Base is Test {
    uint256 internal constant MIN_BOND = 1 ether;
    uint256 internal constant CHALLENGE_BOND = 0.5 ether;
    uint64 internal constant VOTING_PERIOD = 30 minutes;
    uint64 internal constant CHALLENGE_WINDOW = 10 minutes;
    uint64 internal constant REVIEW_PERIOD = 5 minutes;
    uint64 internal constant UNBONDING = 1 days;
    uint16 internal constant SLASH_BPS = 3_000; // 30%
    uint16 internal constant CHALLENGER_CUT_BPS = 5_000; // 50%

    IdentityRegistry internal identity;
    ValidatorStaking internal staking;
    ValidationRegistry internal registry;
    Escrow internal escrow;
    ChallengeMarket internal market;
    ReputationRegistry internal reputation;

    address internal admin = makeAddr("admin");
    address internal treasury = makeAddr("treasury");
    address internal arbiter = makeAddr("arbiter");
    address internal client = makeAddr("client");
    address internal trader = makeAddr("trader");
    address internal liar = makeAddr("liar");
    address internal challenger = makeAddr("challenger");

    uint256 internal traderId;
    uint256 internal liarId;
    address[] internal validators;
    uint256[] internal validatorKeys;

    function setUp() public virtual {
        vm.startPrank(admin);
        identity = new IdentityRegistry();
        staking = new ValidatorStaking(identity, MIN_BOND, UNBONDING);
        registry = new ValidationRegistry(identity, staking, VOTING_PERIOD);
        escrow = new Escrow(registry);
        market = new ChallengeMarket(
            registry,
            staking,
            ChallengeMarket.Params({
                treasury: treasury,
                arbiter: arbiter,
                challengeBond: CHALLENGE_BOND,
                challengeWindow: CHALLENGE_WINDOW,
                reviewPeriod: REVIEW_PERIOD,
                slashBps: SLASH_BPS,
                challengerCutBps: CHALLENGER_CUT_BPS,
                reviewQuorumSize: 3
            })
        );
        reputation = new ReputationRegistry(registry, market);
        staking.setSlasher(address(market));
        registry.setChallengeMarket(address(market));
        vm.stopPrank();

        vm.prank(trader);
        traderId = identity.register("ipfs://trader", IdentityRegistry.Role.Trader, trader);
        vm.prank(liar);
        liarId = identity.register("ipfs://liar", IdentityRegistry.Role.Trader, liar);

        _addValidators(6);

        vm.deal(client, 100 ether);
        vm.deal(challenger, 10 ether);
    }

    function _addValidators(uint256 n) internal {
        for (uint256 i; i < n; ++i) {
            (address v, uint256 key) = makeAddrAndKey(string.concat("validator", vm.toString(i)));
            vm.deal(v, 10 ether);
            vm.startPrank(v);
            uint256 id = identity.register("ipfs://validator", IdentityRegistry.Role.Validator, v);
            staking.bond{value: 5 ether}(id);
            vm.stopPrank();
            validators.push(v);
            validatorKeys.push(key);
        }
    }

    function _set3() internal view returns (address[] memory set) {
        set = new address[](3);
        set[0] = validators[0];
        set[1] = validators[1];
        set[2] = validators[2];
    }

    /// @dev client escrows `amount` for `payee`, then the trader agent posts the validation request.
    function _request(address from, uint256 agentId, bytes32 h, uint256 amount) internal {
        vm.prank(client);
        escrow.deposit{value: amount}(h, from);
        vm.prank(from);
        registry.validationRequest(_set3(), agentId, "data:application/json,{}", h);
    }

    function _voteAll(bytes32 h, bool a, bool b, bool c) internal {
        vm.prank(validators[0]);
        registry.submitVote(h, a, keccak256("e0"));
        vm.prank(validators[1]);
        registry.submitVote(h, b, keccak256("e1"));
        vm.prank(validators[2]);
        registry.submitVote(h, c, keccak256("e2"));
    }

    /// @dev Every reviewer on challenge `id` votes `uphold` until it resolves.
    function _reviewAll(uint256 id, bool uphold) internal {
        address[] memory reviewers = market.getChallenge(id).reviewers;
        for (uint256 i; i < reviewers.length; ++i) {
            if (market.getChallenge(id).status != ChallengeMarket.Status.Open) break;
            vm.prank(reviewers[i]);
            market.submitReview(id, uphold);
        }
    }
}
