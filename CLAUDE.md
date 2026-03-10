# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A single-file HTML/JS application for visualizing RNA secondary structures. Open `rna_secondary_structure_viewer_hulls.html` directly in a browser — no build step or server required.

## Architecture

The entire application lives in one file (~1028 lines): CSS in `<style>`, HTML layout, and a self-executing JS module in `<script>`. D3 v7 is loaded from CDN.

**Data flow:**
1. **Parse** — Raw text input is parsed into `model` (`{title, sequenceStrands[], structure, importedFormat, notes[]}`). Supported formats: FASTA, SEQ, CT, DBN (dot-bracket notation), and raw structure strings.
2. **Graph construction** — `parseDotBracketPlus()` builds `graph` with `{nodes[], pairLinks[], backboneLinks[], pairByNode, nickAfterNode, strandNodeIds[], stems[], strandGraph}`.
3. **Layout** — Four modes, selected via the "Layout mode" dropdown:
   - **Radial** (default): `buildRadialTree()` recursively parses the nested pair structure into a loop tree (stems + interior loops). `layoutRadial()` → `placeRadialStem()` + `placeRadialLoop()` place nodes by radiating stems outward from loop circles. The exterior loop is laid on a large circle; child stems branch outward; inner loops are circles whose radius is `(n+2)*BD/(2π)`. Loop circle center is offset by its own radius to avoid stem overlap.
   - **Circular**: All N nodes evenly on a circle (with angular gaps at strand breaks). Pairs render as chords (straight lines).
   - **Linear**: All nodes on a horizontal line. Pairs render as quadratic Bézier arcs above the line (arc height ∝ sequence span).
   - **Force-directed**: Hull-based initialization + D3 force simulation with custom forces (stem laddering, loop centring, hull collision, strand repulsion). Only this mode runs `relaxStrandByStrand()`.
4. **Render** — D3 selections update SVG layers: `interactionLayer`, `hullLayer`, `pairLayer`, `backboneLayer`, `nodeLayer`, `labelLayer`. Pairs are always `<path>` elements; `pairPathD()` computes `d` attribute based on layout mode.

**Key data structures:**
- `graph.strandGraph` — per-strand metadata including hull radius, neighbor counts, and computed centers `{cx, cy}`
- `stems` — consecutive base-pair runs extracted from `pairLinks`, used by `stemForce` to nudge pairs into ladder geometry
- Bracket families support extended dot-bracket: `()[]{}` and `Aa`–`Zz` letter pairs for pseudoknots

**Custom D3 forces:**
- `stemForce` — aligns base-pair rungs along a stem axis
- `loopForce` — pulls unpaired loop nodes toward the midpoint of their backbone neighbors
- `strandRepelForce` — pairwise repulsion between nodes on different strands
- `hullCollisionForce` — pushes hull centers apart when they overlap

**Job cancellation:** `currentJobId` is incremented on each new operation; async loops check `jobId !== currentJobId || cancelRequested` before each chunk.
