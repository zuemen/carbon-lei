// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {VerifierAllowlist} from "../src/VerifierAllowlist.sol";
import {EmissionsClaimRegistry} from "../src/EmissionsClaimRegistry.sol";

/// @notice Deploys the allowlist (owner = deployer, separate watcher key) and the registry.
/// Sepolia only. Keys come from `.env`; run `node scripts/record-deployment.mjs` afterwards
/// to write `contracts/deployments/11155111.json` from the broadcast receipts.
contract Deploy is Script {
    function run() external returns (VerifierAllowlist allowlist, EmissionsClaimRegistry registry) {
        require(block.chainid == 11155111, "Sepolia only");
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address watcher = vm.envAddress("WATCHER_ADDRESS");
        address deployer = vm.addr(deployerKey);
        require(watcher != deployer, "watcher must be a separate key");

        vm.startBroadcast(deployerKey);
        allowlist = new VerifierAllowlist(deployer, watcher);
        registry = new EmissionsClaimRegistry(allowlist);
        vm.stopBroadcast();
    }
}
