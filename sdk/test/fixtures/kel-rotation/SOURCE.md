# Test KEL with a key rotation

A **test identifier** made for the check 6 tests. It is not the demo auditor (`EGHjZo9v…DwHE`), it holds no
credential, and nothing about it is on Sepolia. The events and signatures were produced by keripy, not written by hand.

- Generator: keripy 1.2.13 (`pip install keri==1.2.13`, Python 3.14, libsodium 1.0.20), its `kli` command line
- Script: [`sdk/scripts/make-kel-rotation.sh`](../../../scripts/make-kel-rotation.sh), run on 2026-10-07
- Witnesses: keripy's local `kli witness demo` (wan, wil, wes on 127.0.0.1:5642-5644, keripy's
  `scripts/keri/cf/main` configuration), started by the script and stopped at the end
- Keystore: `kli init --name test-kel-rotation --nopasscode --salt 0AB0ZXN0LWtlbC1yb3RhdGUh`, alias `test-auditor`,
  in a temporary `HOME` that the script deletes
- AID: `EPRzFfKvTjXrAO8YiHF7vPl_6AfKvHFXTqH2ZRf8QSJL`

## Commands (in the script's order)

```
kli witness demo &
kli init --name test-kel-rotation --nopasscode --salt 0AB0ZXN0LWtlbC1yb3RhdGUh
kli oobi resolve --name test-kel-rotation --oobi-alias {wan,wil,wes} --oobi http://127.0.0.1:564{2,3,4}/oobi/<witness>/controller
kli saidify --file seal1.json; kli saidify --file seal2.json
kli incept   --name test-kel-rotation --alias test-auditor --file incept.json    # #0 icp, b [wan, wil], bt 2
kli interact --name test-kel-rotation --alias test-auditor --data @data1.json    # #1 ixn
kli rotate   --name test-kel-rotation --alias test-auditor --witness-cut <wil> --witness-add <wes> --toad 2   # #2 rot
kli interact --name test-kel-rotation --alias test-auditor --data @data2.json    # #3 ixn, seal { d: credSAID }
kli export   --name test-kel-rotation --alias test-auditor > kel.cesr
kli sign --name test-kel-rotation --alias test-auditor --text @event3.json      # keystore copied before #2
kli sign --name wil --alias wil --text @event3.json                              # witness wil's keystore
```

## Files

| File | Content | sha256 |
|---|---|---|
| `kel.cesr` | `kli export` output: events #0-#3 with controller signatures, witness receipts and first-seen times | `1899bd4cc21b95aac91eb4a2d63f8232b0c296d00bceabcdb0df442ce07e39ca` |
| `counter-examples.json` | the two test SAIDs, the witness AIDs, and two `kli sign` signatures over the exact bytes of event #3: by the key that #2 rotated out, and by witness wil, which #2 removed | `add0b2adc2754dc81cc89a2ce745df78734d6b676dd1fe8eb1078466555fafa6` |

A rerun gives the same events, signatures and `counter-examples.json`; only the first-seen date-times in
`kel.cesr` (`-E` groups) differ. The script uses a local keripy install, not Docker.
