#!/usr/bin/env bash
# Recomputes the V7 credential-core SAID with keripy (the KERI reference implementation)
# and compares it with the SDK value in fixtures/vectors.json. Needs Docker.
set -euo pipefail
cd "$(dirname "$0")/../.."
mkdir -p .cache
node -e "const fs=require('fs'); const v=JSON.parse(fs.readFileSync('fixtures/vectors.json','utf8')); fs.writeFileSync('.cache/core.json', v.V7.coreJson)"
mount="$(pwd -W 2>/dev/null || pwd)/.cache"
MSYS_NO_PATHCONV=1 docker run --rm -v "$mount:/w" --entrypoint python weboftrust/keri:1.2.13 -c "
import json
from keri.core.coring import Saider, MtrDex
sad = json.load(open('/w/core.json', encoding='utf-8'))
saider, _ = Saider.saidify(sad=dict(sad), code=MtrDex.Blake3_256, label='d')
print('keripy', saider.qb64); print('sdk   ', sad['d'])
raise SystemExit(0 if saider.qb64 == sad['d'] else 1)
" 2>&1 | grep -E '^(keripy|sdk)'
