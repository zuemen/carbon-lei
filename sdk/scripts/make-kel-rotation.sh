#!/usr/bin/env bash
# Produces the test KEL in sdk/test/fixtures/kel-rotation/ with keripy's own `kli`: a TEST identifier
# (not the demo auditor) incepts with witnesses [wan, wil], interacts, rotates its key while cutting wil
# and adding wes, then anchors a test SAID in an interaction event. Witnesses: keripy's local
# `kli witness demo` (127.0.0.1:5632-5647), started here and stopped at the end. Nothing leaves the machine.
#
# Usage: KLI=/path/to/venv/bin/kli sdk/scripts/make-kel-rotation.sh [out-dir]
#   KLI         kli of keripy 1.2.13 (pip install keri==1.2.13)
#   SODIUM_LIB  directory holding libsodium, if the loader does not find it (macOS drops
#               DYLD_LIBRARY_PATH on the way into bash, so it is passed under this name)
#   out-dir     default sdk/test/fixtures/kel-rotation
# All keystores live in a temporary HOME, removed at the end.
set -euo pipefail

KLI="${KLI:-kli}"
if [ -n "${SODIUM_LIB:-}" ]; then export DYLD_LIBRARY_PATH="$SODIUM_LIB" LD_LIBRARY_PATH="$SODIUM_LIB"; fi
HERE="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$(mkdir -p "${1:-$HERE/test/fixtures/kel-rotation}" && cd "${1:-$HERE/test/fixtures/kel-rotation}" && pwd)"
"$KLI" version | grep -q "1.2.13" || { echo "need keripy 1.2.13, got: $("$KLI" version)" >&2; exit 1; }

WORK="$(mktemp -d)"
export HOME="$WORK/home"
mkdir -p "$HOME" "$WORK/scripts/keri/cf/main"
cd "$WORK"
WITPID=""
cleanup() {
  [ -n "$WITPID" ] && kill "$WITPID" 2>/dev/null && wait "$WITPID" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

# Witness configuration of keripy 1.2.13 (scripts/keri/cf/main/{wan,wil,wes}.json).
port=2
for w in wan wil wes; do
  cat > "scripts/keri/cf/main/$w.json" <<EOF
{"dt": "2022-01-20T12:57:59.823350+00:00", "$w": {"dt": "2022-01-20T12:57:59.823350+00:00", "curls": ["tcp://127.0.0.1:563$port/", "http://127.0.0.1:564$port/"]}, "iurls": []}
EOF
  port=$((port + 1))
done
WAN=BBilc4-L3tFUnfM_wJr4S4OJanAv_VmF_dJNN6vkf2Ha
WIL=BLskRTInXnMxWaGqcpSyMgo0nYbalW99cGZESrz3zapM
WES=BIKKuvBwpmDVA4Ds-EpL5bt9OqPzWPja2LigFYZN2YfX

"$KLI" witness demo > "$WORK/witness.log" 2>&1 &
WITPID=$!
for _ in $(seq 1 60); do
  curl -sf "http://127.0.0.1:5644/oobi/$WES/controller" > /dev/null 2>&1 && break
  sleep 0.5
done

N=test-kel-rotation
A=test-auditor
# Fixed salt so the test AID is the same on every run (b"test-kel-rotate!" as a qb64 salt).
SALT=0AB0ZXN0LWtlbC1yb3RhdGUh
"$KLI" init --name $N --nopasscode --salt $SALT
"$KLI" oobi resolve --name $N --oobi-alias wan --oobi "http://127.0.0.1:5642/oobi/$WAN/controller"
"$KLI" oobi resolve --name $N --oobi-alias wil --oobi "http://127.0.0.1:5643/oobi/$WIL/controller"
"$KLI" oobi resolve --name $N --oobi-alias wes --oobi "http://127.0.0.1:5644/oobi/$WES/controller"

cat > incept.json <<EOF
{"transferable": true, "wits": ["$WAN", "$WIL"], "toad": 2, "icount": 1, "ncount": 1, "isith": "1", "nsith": "1"}
EOF
# Test SAIDs to anchor (kli saidify): one before the rotation, one after (the "credential" of the tests).
echo '{"d": "", "note": "carbonlei test seal before rotation"}' > seal1.json
echo '{"d": "", "note": "carbonlei test credential anchored after rotation"}' > seal2.json
"$KLI" saidify --file seal1.json
"$KLI" saidify --file seal2.json
S1=$(python3 -c 'import json,sys;print(json.load(open("seal1.json"))["d"])')
S2=$(python3 -c 'import json,sys;print(json.load(open("seal2.json"))["d"])')
echo "[{\"d\": \"$S1\"}]" > data1.json
echo "[{\"d\": \"$S2\"}]" > data2.json

"$KLI" incept --name $N --alias $A --file incept.json   # event #0: icp, witnesses [wan, wil], bt 2
"$KLI" interact --name $N --alias $A --data @data1.json  # event #1: ixn
cp -R "$HOME/.keri" "$WORK/keri-before-rotation"         # keystore holding the key that is rotated out
"$KLI" rotate --name $N --alias $A --witness-cut $WIL --witness-add $WES --toad 2  # event #2: rot
"$KLI" interact --name $N --alias $A --data @data2.json  # event #3: ixn anchoring S2
"$KLI" export --name $N --alias $A > "$OUT/kel.cesr"
"$KLI" status --name $N --alias $A > "$WORK/status.txt"

kill "$WITPID"; wait "$WITPID" 2>/dev/null || true; WITPID=""

# Counter-examples, signed by keripy over the exact bytes of event #3:
#   - by the key that event #2 rotated out (the keystore copy from before the rotation);
#   - by witness wil, which event #2 removed from the witness list.
python3 - "$OUT/kel.cesr" "$WORK/anchor.json" <<'EOF'
import json, re, sys
s = open(sys.argv[1]).read()
pos = [m.start() for m in re.finditer(r'\{"v":"KERI10JSON', s)]
raw = None
for p in pos:
    size = int(s[p + 16:p + 22], 16)
    ked = json.loads(s[p:p + size])
    if ked["t"] == "ixn" and ked["s"] == "3":
        raw = s[p:p + size]
open(sys.argv[2], "w").write(raw)
EOF
HOME_NOW="$HOME"
export HOME="$WORK/old"; mkdir -p "$HOME"; cp -R "$WORK/keri-before-rotation" "$HOME/.keri"
OLDSIG=$("$KLI" sign --name $N --alias $A --text @"$WORK/anchor.json" | sed -n 's/^1\. //p')
export HOME="$HOME_NOW"
WILSIG=$("$KLI" sign --name wil --alias wil --text @"$WORK/anchor.json" | sed -n 's/^1\. //p')

python3 - "$OUT" "$S1" "$S2" "$OLDSIG" "$WILSIG" <<'EOF'
import json, sys
out, s1, s2, oldsig, wilsig = sys.argv[1:]
json.dump({
    "note": "TEST identifier produced by keripy 1.2.13 (sdk/scripts/make-kel-rotation.sh); not the demo auditor.",
    "sealBeforeRotation": s1,
    "credSAID": s2,
    "witnesses": {"wan": "BBilc4-L3tFUnfM_wJr4S4OJanAv_VmF_dJNN6vkf2Ha", "wil": "BLskRTInXnMxWaGqcpSyMgo0nYbalW99cGZESrz3zapM", "wes": "BIKKuvBwpmDVA4Ds-EpL5bt9OqPzWPja2LigFYZN2YfX"},
    "oldKeySignatureOnEvent3": oldsig,
    "removedWitnessWilSignatureOnEvent3": wilsig,
}, open(f"{out}/counter-examples.json", "w"), indent=2)
open(f"{out}/counter-examples.json", "a").write("\n")
EOF
cat "$WORK/status.txt"
( cd "$OUT" && shasum -a 256 kel.cesr counter-examples.json )
