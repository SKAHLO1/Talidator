// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {IdentityRegistry} from "../src/IdentityRegistry.sol";
import {ValidatorStaking} from "../src/ValidatorStaking.sol";
import {ValidationRegistry} from "../src/ValidationRegistry.sol";
import {Escrow} from "../src/Escrow.sol";
import {ChallengeMarket} from "../src/ChallengeMarket.sol";
import {ReputationRegistry} from "../src/ReputationRegistry.sol";

/// @notice Deploys and wires all Talidator contracts, then writes deployments/<chainId>.json.
///
///   forge script script/Deploy.s.sol --rpc-url local --broadcast --private-key $PRIVATE_KEY
///   forge script script/Deploy.s.sol --rpc-url monad_testnet --broadcast --private-key $PRIVATE_KEY
///
/// Every parameter can be overridden with an env var of the same name (values in wei / seconds / bps).
contract Deploy is Script {
    struct Deployed {
        IdentityRegistry identity;
        ValidatorStaking staking;
        ValidationRegistry registry;
        Escrow escrow;
        ChallengeMarket market;
        ReputationRegistry reputation;
    }

    function run() external {
        vm.startBroadcast();
        address deployer = msg.sender;
        uint256 startBlock = block.number;

        Deployed memory d;
        d.identity = new IdentityRegistry();
        d.staking = new ValidatorStaking(
            d.identity, vm.envOr("MIN_BOND", uint256(0.1 ether)), uint64(vm.envOr("UNBONDING_PERIOD", uint256(1 days)))
        );
        d.registry = new ValidationRegistry(d.identity, d.staking, uint64(vm.envOr("VOTING_PERIOD", uint256(30 minutes))));
        d.escrow = new Escrow(d.registry);
        d.market = new ChallengeMarket(d.registry, d.staking, _marketParams(deployer));
        d.reputation = new ReputationRegistry(d.registry, d.market);

        d.staking.setSlasher(address(d.market));
        d.registry.setChallengeMarket(address(d.market));
        vm.stopBroadcast();

        _write(d, deployer, startBlock);
    }

    function _marketParams(address deployer) internal view returns (ChallengeMarket.Params memory) {
        return ChallengeMarket.Params({
            treasury: vm.envOr("TREASURY", deployer),
            arbiter: vm.envOr("ARBITER", deployer),
            challengeBond: vm.envOr("CHALLENGE_BOND", uint256(0.05 ether)),
            challengeWindow: uint64(vm.envOr("CHALLENGE_WINDOW", uint256(10 minutes))),
            reviewPeriod: uint64(vm.envOr("REVIEW_PERIOD", uint256(5 minutes))),
            slashBps: uint16(vm.envOr("SLASH_BPS", uint256(3_000))),
            challengerCutBps: uint16(vm.envOr("CHALLENGER_CUT_BPS", uint256(5_000))),
            reviewQuorumSize: 3
        });
    }

    function _write(Deployed memory d, address deployer, uint256 startBlock) internal {
        string memory k = "deployment";
        vm.serializeUint(k, "chainId", block.chainid);
        vm.serializeUint(k, "startBlock", startBlock);
        vm.serializeAddress(k, "deployer", deployer);
        vm.serializeAddress(k, "IdentityRegistry", address(d.identity));
        vm.serializeAddress(k, "ValidatorStaking", address(d.staking));
        vm.serializeAddress(k, "ValidationRegistry", address(d.registry));
        vm.serializeAddress(k, "Escrow", address(d.escrow));
        vm.serializeAddress(k, "ChallengeMarket", address(d.market));
        string memory json = vm.serializeAddress(k, "ReputationRegistry", address(d.reputation));
        string memory path = string.concat(vm.projectRoot(), "/deployments/", vm.toString(block.chainid), ".json");
        vm.writeJson(json, path);

        console.log("IdentityRegistry  ", address(d.identity));
        console.log("ValidatorStaking  ", address(d.staking));
        console.log("ValidationRegistry", address(d.registry));
        console.log("Escrow            ", address(d.escrow));
        console.log("ChallengeMarket   ", address(d.market));
        console.log("ReputationRegistry", address(d.reputation));
        console.log("Wrote", path);
    }
}
