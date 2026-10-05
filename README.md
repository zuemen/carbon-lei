# CarbonLEI

**Checkable carbon-border (CBAM) emissions reports: who signed, were they authorised, and has each verified tonne already been claimed? vLEI credentials plus an Ethereum Sepolia ledger.**

> Work in progress for the IEEE ClimateChain Global Hackathon 2026, track **Sustainable Supply Chains**
> (see [HACKATHON.md](HACKATHON.md)). This page lists only what is built and tested today; it grows as parts land.

All companies, people and LEIs in this repository are fictional. All emissions values are illustrative — not official CBAM methodology.

## What exists now

| Part | Status | Where |
|---|---|---|
| `VerifierAllowlist` contract: accredited verification bodies keyed by LEI hash, auditors per body, address rotation, suspension by a separate watcher key | built, tested | [`contracts/src/VerifierAllowlist.sol`](contracts/src/VerifierAllowlist.sol) |
| `EmissionsClaimRegistry` contract: one credential per installation, CN code, route and period; one verification report per installation and period; revisions; a claimable-tonnage ledger shared by all importers | built, tested | [`contracts/src/EmissionsClaimRegistry.sol`](contracts/src/EmissionsClaimRegistry.sol) |
| Contract tests: unit, scenario and invariant fuzz tests | 277 tests | [`contracts/test/`](contracts/test) |
| SDK: credential model, self-addressing ID (SAID), selective disclosure, commitments, EIP-712 signature, verification of a supplier's proof against the chain | built, tested | [`sdk/`](sdk) |
| Cross-language test vectors: the same keys, commitments and EIP-712 digest computed in Solidity and TypeScript; the SAID cross-checked with keripy | passing | [`fixtures/vectors.json`](fixtures/vectors.json) |
| Sepolia deployment with source verified on Etherscan | deployed 2026-10-05 | [On Sepolia](#on-sepolia) |
| Hosted demo (read-only, no wallet): verification of a supplier's proof against Sepolia, three attacks, trust chain, on-chain proof | live | [zuemen.github.io/carbon-lei](https://zuemen.github.io/carbon-lei/) |
| vLEI: local KERI stack, credential chain, KERI anchor of the credential, checks 6–7 on exported evidence; rule-based check 8 | built, tested | [`verifier/`](verifier), [`sdk/vlei.ts`](sdk/vlei.ts), [`sdk/consistency.ts`](sdk/consistency.ts) |
| Documentation (architecture, security, climate impact, adoption, PACT mapping) | planned | — |

## On Sepolia

Ethereum Sepolia (chain ID 11155111), a proof-of-stake test network. Source code verified on Etherscan.
Deployment record with transaction hashes, blocks and the commit it was built from: [`contracts/deployments/11155111.json`](contracts/deployments/11155111.json). An earlier deployment of the same code (before the demo credential carried its reconciliation proof) is kept in [`contracts/deployments/archive/`](contracts/deployments/archive).

| Contract | Address |
|---|---|
| VerifierAllowlist | [`0xF7AD0cbe867eb9CE4847Af3717C2d27f6434Ea5C`](https://sepolia.etherscan.io/address/0xF7AD0cbe867eb9CE4847Af3717C2d27f6434Ea5C#code) |
| EmissionsClaimRegistry | [`0xEA52a50d3753bACD835DCd47892754b65a90ca19`](https://sepolia.etherscan.io/address/0xEA52a50d3753bACD835DCd47892754b65a90ca19#code) |

## Run the tests

Requirements: Foundry 1.7.1 and Node.js 22.

```bash
git clone --recursive https://github.com/zuemen/carbon-lei
cd carbon-lei
forge test            # contracts: unit, scenario and invariant tests
npm ci
forge build && npm test -w sdk   # SDK, including end-to-end checks on a local anvil chain
```

## License

MIT — see [LICENSE](LICENSE). Dependencies: OpenZeppelin Contracts 5.4.0 (MIT), forge-std (MIT/Apache-2.0), viem (MIT), @noble/hashes and @noble/curves (MIT).

## AI usage disclosure

Parts of this project are developed with an AI coding assistant (Claude). All code is reviewed and owned by the team.
