// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {BaseV2} from "./BaseV2.t.sol";
import {VerifierAllowlist} from "../../src/VerifierAllowlist.sol";
import {EmissionsClaimRegistry} from "../../src/EmissionsClaimRegistry.sol";
import {VerifierAllowlistV2} from "../../src/v2/VerifierAllowlistV2.sol";
import {EmissionsClaimRegistryV2} from "../../src/v2/EmissionsClaimRegistryV2.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

/// @notice CR1 (docs/SECURITY.md §4.2, T10) against the deployed V1 code: a stolen allowlist
/// owner key moves body L1 to the thief's address and revokes all of L1's reports in the same
/// block. The attack succeeds; only the off-chain verifier's 30-day tenure rule flags it.
contract CR1AttackV1Test is Test {
    function test_CR1_V1_stolenOwnerKey_rotatesAndRevokesAtOnce() public {
        vm.warp(1790000000);
        address owner = makeAddr("owner");
        address v1 = makeAddr("verifier1");
        address thief = makeAddr("thief");
        address supplier = makeAddr("supplier");
        bytes32 L1 = keccak256("ZZZZ00EUVERIFDEMO152");
        bytes32 AID = keccak256("EAuditorA-demo-aid");

        VerifierAllowlist allowlist = new VerifierAllowlist(owner, makeAddr("watcher"));
        EmissionsClaimRegistry registry = new EmissionsClaimRegistry(allowlist);
        vm.startPrank(owner);
        allowlist.addVerifier(VerifierAllowlist.VerifierInput(L1, v1, keccak256("LE"), keccak256("ACC"), 1924905600));
        allowlist.addAuditor(VerifierAllowlist.AuditorInput(AID, L1, keccak256("ECR")));
        vm.stopPrank();

        bytes32[3] memory keys;
        for (uint256 i = 0; i < 3; i++) {
            keys[i] = keccak256(abi.encode("report", i));
            vm.prank(v1);
            registry.registerReport(
                EmissionsClaimRegistry.ReportInput({
                    reportKey: keys[i],
                    reportIdHash: keccak256(abi.encode("rid", i)),
                    reportScopeKey: keccak256(abi.encode("P", i)),
                    credScopeKey: keccak256(abi.encode("Q", i)),
                    auditorAidHash: AID,
                    kelSeq: 3,
                    supplier: supplier,
                    supplierCommit: bytes32(0),
                    installationCommit: bytes32(0),
                    verifiedKg: 1000,
                    validUntil: 1830211200,
                    supersedes: bytes32(0)
                })
            );
        }
        vm.warp(block.timestamp + 365 days); // the body has held its address for a year

        // Attack, one block, no second key: owner key rotates, the thief revokes everything.
        vm.prank(owner);
        allowlist.rotateVerifierAddress(L1, thief);
        for (uint256 i = 0; i < 3; i++) {
            vm.prank(thief);
            registry.revokeReport(keys[i]);
            assertFalse(registry.isValidAt(keys[i], 1790000000 + 1), "V1: revoked retroactively");
        }
        // The body's own key can no longer act, and nothing can undo a revocation.
        assertFalse(allowlist.isVerifierActiveAt(v1, uint64(block.timestamp)));
    }
}

/// @notice The same attack against V2 (§13.1). Each test states what stops it, or what is left.
contract CR1AttackV2Test is BaseV2 {
    bytes32[3] internal keys;

    function setUp() public override {
        super.setUp();
        for (uint256 i = 0; i < 3; i++) {
            keys[i] = _regL1(v1, i + 1, 1000);
        }
        vm.warp(START + 365 days);
    }

    function _allValid() internal view returns (bool) {
        for (uint256 i = 0; i < 3; i++) {
            if (!registry.isValid(keys[i])) return false;
        }
        return true;
    }

    /// @dev Stolen owner key alone, same block: there is no one-step rotation; the thief's
    /// address is not bound, so it cannot revoke.
    function test_CR1_V2_sameBlockAttack_blocked() public {
        _propose(L1, thief);
        vm.prank(owner);
        vm.expectRevert();
        allowlist.executeRotationSigned(L1, hex"00");
        vm.prank(thief);
        vm.expectRevert(abi.encodeWithSelector(EmissionsClaimRegistryV2.NotActiveVerifier.selector, thief));
        registry.revokeReport(keys[0], 0);
        assertTrue(_allValid());
    }

    /// @dev The body watches `RotationProposed` and cancels with its current key. The thief
    /// can re-propose (griefing) but never complete without the delay passing uncancelled.
    function test_CR1_V2_bodyCancelsDuringDelay_blocked() public {
        for (uint256 round = 0; round < 3; round++) {
            _propose(L1, thief);
            vm.warp(block.timestamp + DELAY - 1);
            vm.prank(v1);
            allowlist.cancelRotation(L1);
            vm.warp(block.timestamp + 1);
            vm.expectRevert(abi.encodeWithSelector(VerifierAllowlistV2.NoPendingRotation.selector, L1));
            allowlist.executeRotation(L1);
        }
        (address cur,,,,,,) = allowlist.institutions(L1);
        assertEq(cur, v1);
        assertTrue(_allValid());
    }

    /// @dev The body misses the rotation; the thief's revocations are held because its
    /// address is fresh, and the watcher cancels them and suspends the body.
    function test_CR1_V2_rotationMissed_watcherCancelsHeldRevocations() public {
        _rotateDelayed(L1, thief);
        for (uint256 i = 0; i < 3; i++) {
            vm.prank(thief);
            registry.revokeReport(keys[i], 0);
        }
        assertTrue(_allValid(), "held, not applied");
        vm.startPrank(watcher);
        for (uint256 i = 0; i < 3; i++) {
            registry.cancelRevocation(keys[i]);
        }
        allowlist.suspendVerifier(L1);
        vm.stopPrank();
        vm.warp(block.timestamp + HOLD);
        for (uint256 i = 0; i < 3; i++) {
            vm.expectRevert(abi.encodeWithSelector(EmissionsClaimRegistryV2.NoPendingRevocation.selector, keys[i]));
            registry.executeRevocation(keys[i]);
            vm.prank(thief);
            vm.expectRevert(abi.encodeWithSelector(EmissionsClaimRegistryV2.NotActiveVerifier.selector, thief));
            registry.revokeReport(keys[i], 0);
        }
        assertTrue(_allValid());
    }

    /// @dev Residual risk: if neither the body nor the watcher reacts, the attack completes,
    /// but no earlier than ROTATION_DELAY + REVOKE_HOLD after the first visible event.
    function test_CR1_V2_residual_nobodyWatches_completesAfterBothDelays() public {
        uint64 t0 = START + 365 days; // literal: via-IR may re-read TIMESTAMP after vm.warp
        _rotateDelayed(L1, thief);
        vm.prank(thief);
        registry.revokeReport(keys[0], 0);
        vm.warp(block.timestamp + HOLD);
        registry.executeRevocation(keys[0]);
        assertFalse(registry.isValid(keys[0]));
        assertGe(_revokedAt(keys[0]), t0 + DELAY + HOLD);
    }

    /// @dev Residual risk: the owner administers WATCHER_ROLE, and role changes are not delayed
    /// in the contract. A stolen owner key that is not behind a timelock can remove the watcher;
    /// then only the body's own reaction during ROTATION_DELAY stops the attack.
    function test_CR1_V2_residual_ownerKeyAlsoRemovesWatcher() public {
        bytes32 role = allowlist.WATCHER_ROLE();
        vm.prank(owner);
        allowlist.revokeRole(role, watcher);
        _rotateDelayed(L1, thief);
        vm.prank(thief);
        registry.revokeReport(keys[0], 0);
        vm.prank(watcher);
        vm.expectRevert(abi.encodeWithSelector(EmissionsClaimRegistryV2.NotAllowedToCancel.selector, watcher));
        registry.cancelRevocation(keys[0]);
        vm.warp(block.timestamp + HOLD);
        registry.executeRevocation(keys[0]);
        assertFalse(registry.isValid(keys[0]));
    }

    /// @dev Residual risk outside CR1's scope (CR1a, T13): a stolen key that the body itself
    /// has held for longer than REVOKE_HOLD revokes at once, as in V1.
    function test_CR1a_V2_residual_longHeldBodyKey_revokesAtOnce() public {
        vm.prank(v1);
        registry.revokeReport(keys[0], 0);
        assertEq(_revokedAt(keys[0]), uint64(block.timestamp));
    }
}

/// @notice Deployment shape §13.1 recommends: the allowlist owner is a TimelockController
/// whose proposer is a multisig (modelled here as one address) and whose canceller is a
/// separate guardian. Every owner action, including role changes, waits the timelock delay.
contract CR1TimelockOwnerTest is BaseV2 {
    TimelockController internal timelock;
    address internal proposer = makeAddr("multisig-proposer");
    address internal guardian = makeAddr("guardian-canceller");
    uint64 internal constant TL_DELAY = 2 days;

    function setUp() public override {
        super.setUp();
        address[] memory proposers = new address[](1);
        proposers[0] = proposer;
        address[] memory executors = new address[](1);
        executors[0] = address(0); // anyone may execute once ready
        timelock = new TimelockController(TL_DELAY, proposers, executors, address(0));
        // The timelock administers itself: it gives CANCELLER_ROLE to the guardian only.
        vm.startPrank(address(timelock));
        timelock.grantRole(timelock.CANCELLER_ROLE(), guardian);
        timelock.revokeRole(timelock.CANCELLER_ROLE(), proposer);
        vm.stopPrank();

        vm.prank(owner);
        allowlist.transferOwnership(address(timelock));
        _tlExecute(abi.encodeCall(allowlist.acceptOwnership, ()), bytes32("accept"));
        assertEq(allowlist.owner(), address(timelock));
    }

    function _tlSchedule(bytes memory data, bytes32 salt) internal returns (bytes32 id) {
        vm.prank(proposer);
        timelock.schedule(address(allowlist), 0, data, bytes32(0), salt, TL_DELAY);
        id = timelock.hashOperation(address(allowlist), 0, data, bytes32(0), salt);
    }

    function _tlExecute(bytes memory data, bytes32 salt) internal {
        _tlSchedule(data, salt);
        vm.warp(block.timestamp + TL_DELAY);
        timelock.execute(address(allowlist), 0, data, bytes32(0), salt);
    }

    /// @dev The former single-key owner (now stolen) has no power left.
    function test_timelockOwner_formerOwnerKeyPowerless() public {
        vm.prank(owner);
        vm.expectRevert();
        allowlist.proposeRotation(L1, thief);
        bytes32 role = allowlist.WATCHER_ROLE();
        vm.prank(owner);
        vm.expectRevert();
        allowlist.revokeRole(role, watcher);
    }

    /// @dev A stolen proposer key schedules removing the watcher and a hostile rotation; both
    /// are visible for TL_DELAY and the guardian cancels them.
    function test_timelockOwner_stolenProposer_guardianCancels() public {
        bytes memory rmWatcher = abi.encodeCall(allowlist.revokeRole, (allowlist.WATCHER_ROLE(), watcher));
        bytes memory rotate = abi.encodeCall(allowlist.proposeRotation, (L1, thief));
        bytes32 id1 = _tlSchedule(rmWatcher, "rm");
        bytes32 id2 = _tlSchedule(rotate, "rot");
        vm.startPrank(guardian);
        timelock.cancel(id1);
        timelock.cancel(id2);
        vm.stopPrank();
        vm.warp(block.timestamp + TL_DELAY);
        vm.expectRevert();
        timelock.execute(address(allowlist), 0, rotate, bytes32(0), "rot");
        assertTrue(allowlist.hasRole(allowlist.WATCHER_ROLE(), watcher));
    }

    /// @dev Total time a hostile rotation is visible before it can take effect.
    function test_timelockOwner_rotationTakesTimelockPlusRotationDelay() public {
        uint64 t0 = START + 1 hours + TL_DELAY; // after setUp's accept; literal (via-IR, see above)
        _tlExecute(abi.encodeCall(allowlist.proposeRotation, (L1, v1n)), "rot");
        vm.expectRevert();
        allowlist.executeRotation(L1);
        vm.warp(block.timestamp + DELAY);
        allowlist.executeRotation(L1);
        assertGe(_boundAt(v1n), t0 + TL_DELAY + DELAY);
    }
}
