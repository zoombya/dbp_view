# DotBracketVibe — Rust/WASM Module

This directory contains a Rust crate that compiles to WebAssembly to accelerate
the CPU-intensive layout and classification algorithms in `app.js`.

## Accelerated functions

| Rust export | JS equivalent | Complexity |
|---|---|---|
| `forna_radial_positions` | `fornaRadialPositions` | O(N) |
| `apply_loop_tension` | `applyLoopTension` | O(N × passes) |
| `classify_element_types` | `classifyStructure` (element types) | O(S²) |
| `compute_mld` | `classifyStructure` (MLD) | O(S²) |

The WASM module is **optional** — `app.js` falls back to the pure-JS
implementations when the module is unavailable (e.g. during local development
without a build step).

## Prerequisites

1. **Rust toolchain** — install via [rustup](https://rustup.rs/):

   ```bash
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
   rustup target add wasm32-unknown-unknown
   ```

2. **wasm-pack** — install via:

   ```bash
   cargo install wasm-pack
   # or via the installer:
   curl https://rustwasm.github.io/wasm-pack/installer/init.sh -sSf | sh
   ```

## Building

From the repository root:

```bash
wasm/build.sh
```

Or from inside the `wasm/` directory:

```bash
./build.sh
```

This runs:

```bash
wasm-pack build --target web --out-dir ../pkg --no-typescript
```

The output lands in `pkg/` at the repository root:

- `pkg/dbv_wasm.js` — ES module glue (committed to the repo)
- `pkg/dbv_wasm_bg.wasm` — compiled WASM binary (excluded from git via `.gitignore`)

## Loading in the browser

`app.js` dynamically imports `./pkg/dbv_wasm.js` and calls `mod.default()` to
initialise the WASM instance.  If the import fails (e.g. the file is absent),
the app silently continues with the JS fallback.

## Development notes

- After editing `src/lib.rs`, re-run `wasm/build.sh` and reload the browser.
- The `pkg/` directory is re-generated on every build; do not hand-edit its contents.
- All exported functions use `#[wasm_bindgen]`.  Slice parameters (`&[T]`) become
  `TypedArray` views in JS; `Vec<f64>` returns become `Float64Array`.
