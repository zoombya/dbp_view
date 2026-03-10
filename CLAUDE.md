# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A browser-based RNA/DNA secondary structure viewer. Open `index.html` in any browser — no build step or server required. D3 v7 and Bootstrap Icons are loaded from CDN.

## File Structure

- `index.html` — Slim HTML shell: viewer SVG, floating toolbar with Bootstrap Icon `<i>` elements, input/settings panels, CDN links, loads `app.js`
- `style.css` — All CSS: layout, toolbar island, panels, SVG element classes, badges
- `app.js` — All application logic in a single IIFE: parsing, graph building, layout algorithms, rendering, simulation, event wiring

## Architecture

**Data flow:**
1. **Parse** — Raw text input is parsed into `model` (`{title, sequenceStrands[], structure, importedFormat, notes[]}`). Supported formats: FASTA, SEQ, CT, DBN (dot-bracket notation), and raw structure strings. Auto-detection via `autoDetectFormat()`.
2. **Graph construction** — `parseDotBracketPlus()` builds `graph` with `{nodes[], pairLinks[], backboneLinks[], pairByNode, nickAfterNode, strandNodeIds[], stems[]}`.
3. **Layout** — Three modes, selected via toolbar cycle button or settings dropdown:
   - **Radial** (default): `buildRadialTree()` recursively parses nested pairs into a loop tree. `layoutRadial()` → `placeRadialStem()` + `placeRadialLoop()` radiate stems outward from loop circles.
   - **Circular**: All N nodes evenly on a circle (with angular gaps at strand breaks). Pairs render as chords.
   - **Linear**: Nodes on a horizontal line. Pairs render as quadratic Bézier arcs above.
4. **Refinement** — `relaxRadial()` builds a virtual rigid-body graph (`buildStemVirtualGraph`) where each stem is a single virtual node. D3 force simulation resolves overlaps while `enforceStemRigidity()` + torque-based rotation preserves stem geometry. `forceCenter` gently pulls toward viewport center.
5. **Render** — D3 selections update SVG layers: `pairLayer`, `backboneLayer`, `nodeLayer`, `labelLayer`, `markerLayer`. Pairs are `<path>` elements; `pairPathD()` switches between arc and line based on layout mode.
6. **Continuous simulation** — `startLiveSim()` / `stopLiveSim()` run the rigid-body sim in a `requestAnimationFrame` loop with low alpha decay and a `forceCenter` for auto-centering.

**Key data structures:**
- `stems` — consecutive base-pair runs extracted from `pairLinks`; used for rigid-body grouping
- `features` — `{nodeToStem, nodeToLoop, loops[]}` built by `buildStructuralFeatures()` for selection scoping
- Bracket families support extended dot-bracket: `()[]{}<>` and `Aa`–`Zz` letter pairs for pseudoknots

**Auto-centering:**
- `centerView(duration)` — pans camera (preserving zoom scale) so structure centroid sits at viewport center
- Both `relaxRadial` and `startLiveSim` include `d3.forceCenter` with low strength (0.02–0.03)

**UI pattern:** Floating island toolbar at bottom center. `tbInput` / `tbSettings` toggle slide-up panels. `tbLayout` cycles layout modes. `tbLive` toggles continuous simulation. All toolbar buttons use Bootstrap Icons (`<i class="bi bi-...">`).

**Job cancellation:** `currentJobId` is incremented on each new operation; async loops check `jobId !== currentJobId || cancelRequested` before each chunk.
