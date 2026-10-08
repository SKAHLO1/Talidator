// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {ValidationRegistry} from "../src/ValidationRegistry.sol";
import {Escrow} from "../src/Escrow.sol";
import {ChallengeMarket} from "../src/ChallengeMarket.sol";
import {ReputationRegistry} from "../src/ReputationRegistry.sol";
import {KeeperReceiver} from "../src/KeeperReceiver.sol";

/// @notice Deploys the Chainlink CRE KeeperReceiver against an existing Talidator deployment
///         (reads deployments/<chainId>.json) and writes deployments/keeper-<chainId>.json.
///
///   forge script script/DeployKeeper.s.sol --rpc-url monad_testnet --broadcast --private-key $PRIVATE_KEY
///
/// Forwarders default to Monad testnet's CRE simulation MockForwarder and production KeystoneForwarder;
/// override with CRE_FORWARDERS="0x..,0x..".
contract DeployKeeper is Script {
    function run() external {
        string memory path = string.concat(vm.projectRoot(), "/deployments/", vm.toString(block.chainid), ".json");
        string memory json = vm.readFile(path);

        address[] memory defaults = new address[](2);
        defaults[0] = 0xB9F79d863261869B234c481D1f9A7af84AeAd192; // Monad testnet — CRE simulation (MockKeystoneForwarder)
        defaults[1] = 0xF8344CFd5c43616a4366C34E3EEE75af79a74482; // Monad testnet — CRE production (KeystoneForwarder)
        address[] memory forwarders = vm.envOr("CRE_FORWARDERS", ",", defaults);

        vm.startBroadcast();
        KeeperReceiver keeper = new KeeperReceiver(
            ValidationRegistry(vm.parseJsonAddress(json, ".ValidationRegistry")),
            Escrow(payable(vm.parseJsonAddress(json, ".Escrow"))),
            ChallengeMarket(payable(vm.parseJsonAddress(json, ".ChallengeMarket"))),
            ReputationRegistry(vm.parseJsonAddress(json, ".ReputationRegistry")),
            forwarders
        );
        vm.stopBroadcast();

        string memory k = "keeper";
        vm.serializeUint(k, "chainId", block.chainid);
        string memory out = vm.serializeAddress(k, "KeeperReceiver", address(keeper));
        vm.writeJson(out, string.concat(vm.projectRoot(), "/deployments/keeper-", vm.toString(block.chainid), ".json"));
        console.log("KeeperReceiver", address(keeper));
    }
}
