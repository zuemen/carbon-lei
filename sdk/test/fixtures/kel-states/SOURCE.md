# Negative-test KELs: establishment-only and abandoned

**Negative-test material only.** Two **test identifiers** made for the check 6 tests in `sdk/test/vlei.test.ts`.
They are not the demo auditor, hold no credential, have no witnesses, and nothing about them is on Sepolia.

- Generator: keripy 1.2.13 (`pip install keri==1.2.13`), its `kli` command line and its Python API
- Script: [`sdk/scripts/make-kel-states.sh`](../../../scripts/make-kel-states.sh), run on 2026-10-07
- Keystore: `kli init --name test-kel-states --nopasscode --salt 0AB0ZXN0LWtlbC1zdGF0ZXMh`, in a temporary `HOME`
  that the script deletes

| Identifier | KEL (`kli export`) | AID |
|---|---|---|
| `eo` | #0 icp with `c: ["EO"]` (establishment-only) | `ECIU5NcJprtXA4Q2bc_m9dNMpb8r_QmF-rO3JMoAy_7g` |
| `abandoned` | #0 icp, #1 rot with `n: []`, `nt: "0"` (`kli rotate --next-count 0 --nsith 0`, an abandonment) | `EPB5bAny3-nfIz3iLuDlc3gXz0_OjRmFUMt6Ayvs0hwV` |

`kli interact` refuses to add an interaction event to either KEL ("Improper Habitat interaction").
`crafted.json` holds, for each, the interaction event the tests present as an anchor: event #3 of
`../kel-rotation/kel.cesr` (a keripy event anchoring the test credential SAID) with `i`, `s` and `p` changed
and `d` and the size recomputed by keripy (`SerderKERI(makify=True)`), signed with the identifier's current key
by `kli sign`. The script then has keripy's `Kevery` process each event against the exported KEL and records
its verdict in `keripy`: `Unexpected non-establishment event` for `eo`, `nontransferable or abandoned state`
for `abandoned`. Check 6 must reject both for the same reasons.

| File | sha256 |
|---|---|
| `eo.cesr` | `2b4f1dd4090206fde78ac40d3678023dbf3ec07823e9ee3d3cd8936d0b9e17a1` |
| `abandoned.cesr` | `ec297e6e52f2335727f1367231fa6ff0b4f07dc1729ad47d27ba489a2424fff5` |
| `crafted.json` | `e4c01da3c928f9550024e14e35a9d719ef848ceef2dc0efa7f5549e0226a9abc` |

A rerun gives the same events and signatures; only the first-seen date-times in the `.cesr` files (`-E` groups)
differ. The script uses a local keripy install, not Docker.
