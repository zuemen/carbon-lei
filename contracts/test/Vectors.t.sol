// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

/// @notice Cross-language vectors (C24): the SDK computes keys, commitments and the EIP-712
/// digest in TypeScript and writes fixtures/vectors.json; this test recomputes them with
/// abi.encode and keccak256 and must get the same bytes.
contract VectorsTest is Test {
    string internal json;

    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 internal constant CREDENTIAL_TYPEHASH =
        keccak256("EmissionsCredential(string credSAID,bytes32 supplierCommit,uint96 verifiedKg,uint64 validUntil)");

    function setUp() public {
        json = vm.readFile(string.concat(vm.projectRoot(), "/fixtures/vectors.json"));
    }

    function _s(string memory key) internal view returns (string memory) {
        return vm.parseJsonString(json, key);
    }

    function _b(string memory key) internal view returns (bytes32) {
        return vm.parseJsonBytes32(json, key);
    }

    function test_C24_V1_commitments() public view {
        bytes32 idSalt = _b(".inputs.idSalt");
        assertEq(keccak256(abi.encode(_s(".inputs.supplierLEI"), idSalt)), _b(".V1.supplierCommit"));
        assertEq(keccak256(abi.encode(_s(".inputs.installationId"), idSalt)), _b(".V1.installationCommit"));
    }

    function test_C24_V2_V3_commitmentsChange() public view {
        bytes32 idSalt = _b(".inputs.idSalt");
        assertTrue(_b(".V2.supplierCommitTamperedLei") != _b(".V1.supplierCommit"));
        assertEq(
            keccak256(abi.encode(_s(".inputs.supplierLEI"), _b(".inputs.idSalt2"))), _b(".V3.supplierCommitOtherSalt")
        );
        assertTrue(_b(".V3.supplierCommitOtherSalt") != keccak256(abi.encode(_s(".inputs.supplierLEI"), idSalt)));
    }

    function test_C24_V4_batchKey() public view {
        bytes32 reportKey = keccak256(bytes(_s(".V7.d")));
        assertEq(reportKey, _b(".V4.reportKey"));
        assertEq(keccak256(abi.encode(reportKey, _s(".inputs.batchId"), _b(".inputs.batchSalt"))), _b(".V4.batchKey"));
    }

    function test_C24_V5_importerCommits() public view {
        bytes32 salt = _b(".inputs.importerSalt");
        assertEq(keccak256(abi.encode(_s(".inputs.importerEORI1"), salt)), _b(".V5.importerCommit1"));
        assertEq(keccak256(abi.encode(_s(".inputs.importerEORI2"), salt)), _b(".V5.importerCommit2"));
        assertTrue(_b(".V5.importerCommit1") != _b(".V5.importerCommit2"));
    }

    function test_C24_V6_scopeKeys() public view {
        string memory inst = _s(".inputs.installationId");
        string memory period = _s(".inputs.reportingPeriod");
        string memory cn = _s(".inputs.cnCode");
        assertEq(keccak256(abi.encode(inst, period)), _b(".V6.reportScopeKey"));
        assertEq(keccak256(abi.encode(inst, cn, "C", period)), _b(".V6.credScopeKeyRouteC"));
        assertEq(keccak256(abi.encode(inst, cn, "E", period)), _b(".V6.credScopeKeyRouteE"));
        assertTrue(_b(".V6.credScopeKeyRouteC") != _b(".V6.credScopeKeyRouteE"));
    }

    function test_C24_V17_stringHashes() public view {
        assertEq(keccak256(bytes(_s(".V7.d"))), _b(".V17.reportKey"));
        assertEq(keccak256(bytes(_s(".inputs.verificationReportId"))), _b(".V17.reportIdHash"));
        assertEq(keccak256(bytes(_s(".inputs.auditorAID"))), _b(".V17.auditorAidHash"));
        assertEq(keccak256(bytes(_s(".inputs.verifierLEI"))), _b(".V17.verifierLeiHash"));
    }

    function test_C24_V10_eip712DigestAndSigner() public view {
        bytes32 domainSeparator = keccak256(
            abi.encode(
                DOMAIN_TYPEHASH,
                keccak256("CarbonLEI"),
                keccak256("1"),
                vm.parseJsonUint(json, ".V10.chainId"),
                vm.parseJsonAddress(json, ".V10.registry")
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                CREDENTIAL_TYPEHASH,
                keccak256(bytes(_s(".V10.credSAID"))),
                _b(".V10.supplierCommit"),
                uint96(vm.parseUint(_s(".V10.verifiedKg"))),
                uint64(vm.parseUint(_s(".V10.validUntil")))
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
        assertEq(digest, _b(".V10.typedDataHash"));

        bytes memory sig = vm.parseJsonBytes(json, ".V10.signature");
        assertEq(_recover(digest, sig), vm.parseJsonAddress(json, ".V10.signer"));
        bytes memory other = vm.parseJsonBytes(json, ".V11.otherSignature");
        assertTrue(_recover(digest, other) != vm.parseJsonAddress(json, ".V10.signer"));
    }

    function _recover(bytes32 digest, bytes memory sig) internal pure returns (address) {
        require(sig.length == 65, "signature length");
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(sig, 32))
            s := mload(add(sig, 64))
            v := byte(0, mload(add(sig, 96)))
        }
        return ecrecover(digest, v, r, s);
    }
}
