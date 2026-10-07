#!/usr/bin/env bash
# NEGATIVE-TEST material for check 6 (sdk/test/vlei.test.ts), in sdk/test/fixtures/kel-states/: two TEST
# identifiers (not the demo auditor, no witnesses) whose KERI state allows no interaction event, made with
# keripy's own `kli`, and for each an interaction event keripy refuses to make, built by changing fields of
# a real event and signed with the identifier's current key by `kli sign`:
#   - eo:        an establishment-only inception (`c: ["EO"]`); the event is an ixn at #1;
#   - abandoned: an inception, then a rotation with no next key (`kli rotate --next-count 0`); the event is
#                an ixn at #2.
# Each crafted event is event #3 of sdk/test/fixtures/kel-rotation/kel.cesr (a keripy event anchoring the
# test credential SAID) with `i`, `s` and `p` changed, and `d` and the size recomputed by keripy. keripy
# 1.2.13 then processes it against the exported KEL and its rejection is recorded. Nothing leaves the machine.
#
# Usage: KLI=/path/to/venv/bin/kli sdk/scripts/make-kel-states.sh [out-dir]
#   KLI         kli of keripy 1.2.13 (pip install keri==1.2.13); its venv's python is used too
#   SODIUM_LIB  directory holding libsodium, if the loader does not find it
#   out-dir     default sdk/test/fixtures/kel-states
# All keystores live in a temporary HOME, removed at the end.
set -euo pipefail

KLI="${KLI:-kli}"
PY="$(dirname "$KLI")/python"
if [ -n "${SODIUM_LIB:-}" ]; then export DYLD_LIBRARY_PATH="$SODIUM_LIB" LD_LIBRARY_PATH="$SODIUM_LIB"; fi
HERE="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$(mkdir -p "${1:-$HERE/test/fixtures/kel-states}" && cd "${1:-$HERE/test/fixtures/kel-states}" && pwd)"
SRC="$HERE/test/fixtures/kel-rotation/kel.cesr"
"$KLI" version | grep -q "1.2.13" || { echo "need keripy 1.2.13, got: $("$KLI" version)" >&2; exit 1; }

WORK="$(mktemp -d)"
export HOME="$WORK/home"
mkdir -p "$HOME"
cd "$WORK"
trap 'rm -rf "$WORK"' EXIT

N=test-kel-states
# Fixed salt so the test AIDs are the same on every run (b"test-kel-states!" as a qb64 salt).
"$KLI" init --name $N --nopasscode --salt 0AB0ZXN0LWtlbC1zdGF0ZXMh
echo '{"transferable": true, "wits": [], "toad": 0, "icount": 1, "ncount": 1, "isith": "1", "nsith": "1", "estOnly": true}' > eo.json
echo '{"transferable": true, "wits": [], "toad": 0, "icount": 1, "ncount": 1, "isith": "1", "nsith": "1"}' > ab.json
"$KLI" incept --name $N --alias eo --file eo.json                     # eo #0: icp, c ["EO"]
"$KLI" incept --name $N --alias abandoned --file ab.json              # abandoned #0: icp
"$KLI" rotate --name $N --alias abandoned --next-count 0 --nsith 0    # abandoned #1: rot, n [] (abandonment)
"$KLI" export --name $N --alias eo > "$OUT/eo.cesr"
"$KLI" export --name $N --alias abandoned > "$OUT/abandoned.cesr"

# The crafted interaction events, from event #3 of the keripy rotation KEL.
"$PY" - "$SRC" "$OUT" <<'PY'
import json, sys
from keri.core import serdering
src, out = sys.argv[1], sys.argv[2]
def events(path):
    ims = open(path).read()
    res, i = [], 0
    while (j := ims.find('{"v":"KERI10JSON', i)) >= 0:
        size = int(ims[j + 16:j + 22], 16)
        res.append(json.loads(ims[j:j + size])); i = j + size
    return res
ev3 = events(src)[3]
for name in ("eo", "abandoned"):
    kel = events(f"{out}/{name}.cesr")
    sad = dict(ev3, i=kel[0]["i"], s=format(len(kel), "x"), p=kel[-1]["d"])
    serder = serdering.SerderKERI(sad=sad, makify=True)
    open(f"{name}-ixn.json", "wb").write(serder.raw)
PY
for name in eo abandoned; do
  "$KLI" sign --name $N --alias $name --text @$name-ixn.json | sed -n 's/^1\. //p' > $name-ixn.sig
done

# keripy's verdict on each crafted event, against the exported KEL, and the fixture file.
"$PY" - "$OUT" <<'PY'
import json, sys
from keri.core import eventing, indexing, parsing, serdering
from keri.db import basing
out = sys.argv[1]
fixture = {
    "note": "NEGATIVE TEST material (sdk/scripts/make-kel-states.sh): interaction events keripy refuses to make, each built from event #3 of kel-rotation/kel.cesr with i, s and p changed, signed by kli sign with the TEST identifier's current key. Never evidence.",
    "credSAID": None,
}
for name in ("eo", "abandoned"):
    raw = open(f"{name}-ixn.json", "rb").read()
    sig = open(f"{name}-ixn.sig").read().strip()
    serder = serdering.SerderKERI(raw=bytearray(raw))
    with basing.openDB(name=f"verdict-{name}", temp=True) as db:
        kvy = eventing.Kevery(db=db, lax=False, local=False)
        parsing.Parser(kvy=kvy).parse(ims=bytearray(open(f"{out}/{name}.cesr", "rb").read()))
        kever = kvy.kevers[serder.pre]
        assert kever.verfers[0].verify(indexing.Siger(qb64=sig).raw, raw), "kli sign did not sign the exact bytes"
        try:
            kvy.processEvent(serder=serder, sigers=[indexing.Siger(qb64=sig, verfer=kever.verfers[0])])
            verdict = "accepted"
        except Exception as e:
            verdict = f"{type(e).__name__}: {e}"
    fixture["credSAID"] = serder.sad["a"][0]["d"]
    fixture[name] = {"aid": serder.pre, "sn": serder.sn, "raw": raw.decode(), "signature": sig, "keripy": verdict}
json.dump(fixture, open(f"{out}/crafted.json", "w"), indent=2)
open(f"{out}/crafted.json", "a").write("\n")
print(json.dumps({k: v["keripy"] for k, v in fixture.items() if isinstance(v, dict)}, indent=2))
PY
