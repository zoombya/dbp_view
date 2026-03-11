#!/bin/bash
set -e
cd "$(dirname "$0")"
wasm-pack build --target web --out-dir ../pkg --no-typescript
echo "Built. Commit pkg/dbv_wasm.js and pkg/dbv_wasm_bg.wasm"
