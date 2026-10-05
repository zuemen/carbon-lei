// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {VerifierAllowlist} from "../../src/VerifierAllowlist.sol";
import {EmissionsClaimRegistry} from "../../src/EmissionsClaimRegistry.sol";
import {Handler} from "./Handler.sol";
import {console2} from "forge-std/console2.sol";

/// @notice Ledger, key-layer and allowlist invariants under random call sequences
/// (interface spec §8: I1–I14, I17, I18, I21–I24; tests C23, C37–C46, C69, C85, C86).
contract InvariantsTest is StdInvariant, Test {
    VerifierAllowlist internal allowlist;
    EmissionsClaimRegistry internal registry;
    Handler internal handler;

    function setUp() public {
        vm.warp(1790000000);
        address owner = makeAddr("inv-owner");
        address watcher = makeAddr("inv-watcher");
        allowlist = new VerifierAllowlist(owner, watcher);
        registry = new EmissionsClaimRegistry(allowlist);
        handler = new Handler(allowlist, registry, owner, watcher);

        handler.seedBody(keccak256("inv-L1"), makeAddr("inv-v1"), uint64(block.timestamp + 5 * 365 days));
        handler.seedBody(keccak256("inv-L2"), makeAddr("inv-v2"), uint64(block.timestamp + 5 * 365 days));
        handler.seedBody(keccak256("inv-L3"), makeAddr("inv-v3"), uint64(block.timestamp + 200 days));

        bytes4[] memory selectors = new bytes4[](11);
        selectors[0] = Handler.register.selector;
        selectors[1] = Handler.claim.selector;
        selectors[2] = Handler.revoke.selector;
        selectors[3] = Handler.warp.selector;
        selectors[4] = Handler.suspend.selector;
        selectors[5] = Handler.lift.selector;
        selectors[6] = Handler.revokeAuditor.selector;
        selectors[7] = Handler.rotate.selector;
        selectors[8] = Handler.addAuditor.selector;
        selectors[9] = Handler.addVerifier.selector;
        selectors[10] = Handler.registerAndClaim.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    // ------------------------------------------------------------ ledger

    /// @dev I1 (C23): every credential layer's cumulative claim fits its latest credential.
    /// I2 (C37): the cumulative claim equals the sum of successful claims on that layer.
    function invariant_I1_I2_ledger() public view {
        for (uint256 i = 0; i < handler.layerCount(); i++) {
            bytes32 layer = handler.credLayers(i);
            (uint96 claimedKg, bytes32 latest) = registry.credScopes(handler.scopeOfLayer(layer), layer);
            assertEq(uint256(claimedKg), handler.ghostClaimedSum(layer), "I2 claimed sum");
            if (latest != bytes32(0)) {
                assertLe(claimedKg, handler.report(latest).verifiedKg, "I1 claimed <= verified");
            } else {
                assertEq(claimedKg, 0, "I1 empty layer has no claims");
            }
        }
    }

    /// @dev I3 (C38): a bound report scope never unbinds and keeps its first boundAt.
    /// I7 (C42): layer and scope pointers point back to themselves.
    function invariant_I3_I7_scopes() public view {
        for (uint256 i = 0; i < handler.scopeCount(); i++) {
            bytes32 scope = handler.scopes(i);
            (bytes32 currentId, bytes32 latest, uint64 boundAt) = registry.reportScopes(scope);
            uint64 ghostBound = handler.ghostScopeBound(scope);
            if (ghostBound != 0) {
                assertTrue(currentId != bytes32(0), "I3 never unbinds");
                assertEq(boundAt, ghostBound, "I3 boundAt fixed");
                EmissionsClaimRegistry.ReportRecord memory r = handler.report(latest);
                assertEq(r.reportScopeKey, scope, "I7 scope latest belongs to scope");
                assertEq(r.reportIdHash, currentId, "I7 scope latest carries current id");
            }
        }
        for (uint256 i = 0; i < handler.layerCount(); i++) {
            bytes32 layer = handler.credLayers(i);
            (, bytes32 latest) = registry.credScopes(handler.scopeOfLayer(layer), layer);
            if (latest != bytes32(0)) {
                assertEq(handler.report(latest).credScopeKey, layer, "I7 layer latest belongs to layer");
            }
        }
    }

    /// @dev I4 (C39): supersede chain is consistent. I5 (C40): revocation sticks.
    /// I22 (C86): issuer is the body the registering address was bound to.
    /// I24: a `supersedes` link not mirrored by `supersededBy` is a report-scope takeover.
    function invariant_I4_I5_I22_I24_reports() public view {
        uint256 n = handler.reportCount();
        for (uint256 i = 0; i < n; i++) {
            bytes32 k = handler.reportKeys(i);
            EmissionsClaimRegistry.ReportRecord memory r = handler.report(k);
            if (r.supersededBy != bytes32(0)) {
                EmissionsClaimRegistry.ReportRecord memory nxt = handler.report(r.supersededBy);
                assertEq(nxt.supersedes, k, "I4 back link");
                assertEq(nxt.credScopeKey, r.credScopeKey, "I4 same layer");
                assertFalse(registry.isValid(k), "I4 superseded is invalid");
            }
            if (r.revokedAt != 0) {
                assertEq(r.revokedAt, handler.ghostReportRevokedAt(k), "I5 revokedAt fixed");
                assertFalse(registry.isValid(k), "I5 revoked invalid now");
                assertFalse(registry.isValidAt(k, r.registeredAt), "I5 revoked invalid at registration");
            }
            (bytes32 boundLei,,) = allowlist.leiOfAddress(r.verifier);
            assertEq(r.issuerLeiHash, boundLei, "I22 issuer = binding of registering address");
            if (r.supersedes != bytes32(0)) {
                EmissionsClaimRegistry.ReportRecord memory prev = handler.report(r.supersedes);
                if (prev.supersededBy != k) {
                    assertTrue(prev.credScopeKey != r.credScopeKey, "I24 takeover crosses layers");
                    assertEq(prev.reportScopeKey, r.reportScopeKey, "I24 takeover same scope");
                    assertTrue(prev.reportIdHash != r.reportIdHash, "I24 takeover changes id");
                }
            }
        }
    }

    /// @dev I8 (C43): within one report scope, every valid credential has the same report ID.
    /// I23: every credential under the scope's current ID was issued by the current holder.
    function invariant_I8_I23_wholeReport() public view {
        uint256 n = handler.reportCount();
        for (uint256 i = 0; i < n; i++) {
            bytes32 k = handler.reportKeys(i);
            EmissionsClaimRegistry.ReportRecord memory r = handler.report(k);
            (bytes32 currentId, bytes32 latest,) = registry.reportScopes(r.reportScopeKey);
            if (registry.isValid(k)) assertEq(r.reportIdHash, currentId, "I8 valid => current id");
            if (r.reportIdHash == currentId) {
                assertEq(r.issuerLeiHash, handler.report(latest).issuerLeiHash, "I23 one holder per id");
            }
        }
    }

    /// @dev I6 (C41): shipments keep a positive quantity and lose validity only through revocation.
    /// I11 (C46): covered by I2 (ghost sum only grows) and the append-only batch list.
    function invariant_I6_shipments() public view {
        uint256 n = handler.batchCount();
        for (uint256 i = 0; i < n; i++) {
            (bytes32 k, uint96 qty,,, uint64 claimedAt, bool reportValid) = registry.shipmentStatus(handler.batches(i));
            assertGt(qty, 0, "I6 qty > 0");
            assertGt(claimedAt, 0, "I6 recorded");
            assertEq(reportValid, handler.report(k).revokedAt == 0, "I6 only revocation invalidates");
        }
    }

    /// @dev I18 (C79, C80): a report ID moved off a scope never comes back to that scope.
    function invariant_I18_noReuse() public view {
        for (uint256 i = 0; i < handler.retiredCount(); i++) {
            bytes32 scope = handler.retiredScope(i);
            bytes32 id = handler.retiredId(i);
            assertGt(registry.reportIdUnboundAt(scope, id), 0, "I18 retired recorded");
            (bytes32 currentId,,) = registry.reportScopes(scope);
            assertTrue(currentId != id, "I18 retired id not current");
        }
    }

    // --------------------------------------------------------- allowlist

    /// @dev I9 (C44): write-once fields. I13 (C73, C83): a suspension covers every address.
    /// I21 (C85): exactly one live address per body, equal to currentAddress.
    function invariant_I9_I13_I21_allowlist() public view {
        uint64 nowTs = uint64(block.timestamp);
        for (uint256 b = 0; b < handler.bodyCount(); b++) {
            bytes32 lei = handler.bodies(b);
            (address current,,,, uint64 addedAt, uint64 suspendedAt, uint64 liftedAt) = allowlist.institutions(lei);
            assertEq(addedAt, handler.ghostBodyAddedAt(lei), "I9 addedAt fixed");
            bool suspendedNow = suspendedAt != 0 && liftedAt == 0;
            address[] memory addrs = handler.addressesOf(lei);
            uint256 live;
            for (uint256 a = 0; a < addrs.length; a++) {
                (bytes32 boundLei, uint64 boundAt, uint64 unboundAt) = allowlist.leiOfAddress(addrs[a]);
                (uint64 gBound, uint64 gUnbound) = handler.ghosts(addrs[a]);
                assertEq(boundLei, lei, "I21 binding never changes body");
                assertEq(boundAt, gBound, "I9 boundAt fixed");
                assertEq(unboundAt, gUnbound, "I9 unboundAt fixed");
                if (unboundAt == 0) {
                    live++;
                    assertEq(addrs[a], current, "I21 live address is current");
                } else {
                    assertFalse(allowlist.isVerifierActiveAt(addrs[a], nowTs), "I9 rotated-away address inactive");
                }
                if (suspendedNow) assertFalse(allowlist.isVerifierActiveAt(addrs[a], nowTs), "I13 suspension");
            }
            assertEq(live, 1, "I21 exactly one live address");
            bytes32[] memory aids = handler.auditorsOf(lei);
            for (uint256 j = 0; j < aids.length; j++) {
                (, uint64 aAdded, uint64 aRevoked) = allowlist.auditors(aids[j], lei);
                (uint64 gAdded, uint64 gRevoked) = handler.ghostAuditor(aids[j], lei);
                assertEq(aAdded, gAdded, "I9 auditor addedAt fixed");
                assertEq(aRevoked, gRevoked, "I9 auditor revokedAt fixed");
                if (aRevoked != 0) {
                    assertFalse(allowlist.isAuthorizedAt(aids[j], current, nowTs), "I9 revoked auditor");
                }
            }
        }
    }

    /// @dev I14 (C74): every successful revocation came from an active current address of the issuer.
    function invariant_I14_revokeAuthority() public view {
        assertFalse(handler.ghostViolation(), handler.ghostViolationReason());
    }

    /// @dev Prints how many calls of each kind succeeded in the last run (non-vacuity check, -vvv).
    function afterInvariant() external view {
        console2.log("registerNew", handler.successes("registerNew"));
        console2.log("revise", handler.successes("revise"));
        console2.log("reviseOtherBody", handler.successes("reviseOtherBody"));
        console2.log("takeover", handler.successes("takeover"));
        console2.log("takeoverOtherBody", handler.successes("takeoverOtherBody"));
        console2.log("claim", handler.successes("claim"));
        console2.log("revoke", handler.successes("revoke"));
        console2.log("rotate", handler.successes("rotate"));
    }

    /// @dev C69: the handler can reach every branch, including a cross-body takeover
    /// through an empty layer and a cross-body revision after the issuer is suspended.
    function test_C69_handlerReachesEveryBranch() public {
        // L1 registers layer 0 of scope 0 and claims against it
        handler.register(0, 0, 500_000, 0, 1 << 24 | 300 days << 24);
        handler.claim(0, 100_000);
        // L1 adds a second credential under the same report id in layer 1
        handler.register(0, 1, 200_000, 0, uint256(1) << 40);
        // L1 revises layer 0 under a fresh id
        handler.register(0, 0, 400_000, 1, 0);
        // suspend L1; L2 takes over the scope through empty layer 2 with a fresh id
        handler.suspend(0); // seed 0 % 4 == 0 acts
        handler.register(1, 2, 1_000, 2, uint256(1) << 48);
        // L2 revises L1's frozen layer 1 (issuer L1 still suspended)
        handler.register(1, 1, 300_000, 1, uint256(1) << 40);
        handler.lift(0);
        handler.revoke(0, 1, 0);
        handler.rotate(0); // seed 0 acts
        handler.addAuditor(0);
        handler.revokeAuditor(0, 0); // seed 0 acts
        handler.warp(1 days);
        handler.addVerifier(90 days);
        assertGt(handler.successes("registerNew"), 0, "registerNew");
        assertGt(handler.successes("claim"), 0, "claim");
        assertGt(handler.successes("revise"), 0, "revise");
        assertGt(handler.successes("takeover"), 0, "takeover");
        assertGt(handler.successes("takeoverOtherBody"), 0, "takeoverOtherBody");
        assertGt(handler.successes("reviseOtherBody"), 0, "reviseOtherBody");
        assertGt(handler.successes("revoke"), 0, "revoke");
        assertGt(handler.successes("suspend"), 0, "suspend");
        assertGt(handler.successes("lift"), 0, "lift");
        assertGt(handler.successes("rotate"), 0, "rotate");
        assertGt(handler.successes("addAuditor"), 0, "addAuditor");
        assertGt(handler.successes("revokeAuditor"), 0, "revokeAuditor");
        assertGt(handler.successes("addVerifier"), 0, "addVerifier");
        invariant_I1_I2_ledger();
        invariant_I3_I7_scopes();
        invariant_I4_I5_I22_I24_reports();
        invariant_I8_I23_wholeReport();
        invariant_I6_shipments();
        invariant_I18_noReuse();
        invariant_I9_I13_I21_allowlist();
        invariant_I14_revokeAuthority();
    }
}
