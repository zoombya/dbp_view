use wasm_bindgen::prelude::*;
use std::f64::consts::PI;

// ─── A. Forna NAView-style radial layout ─────────────────────────────────────
//
// Port of JS `fornaRadialPositions` from app.js.
//
// `pair_table` is 1-indexed (length N+1):
//   pair_table[0] = N
//   pair_table[i] = 1-indexed partner of position i (0 if unpaired)
//
// The rotation mapping is already baked into pair_table by the JS caller.
// Returns flat [x0, y0, x1, y1, ...] for N nodes in walk order.

#[wasm_bindgen]
#[allow(unused)]
pub fn forna_radial_positions(pair_table: &[i32], n: usize, bd: f64, _rot_node: usize) -> Vec<f64> {
    let half_pi = PI / 2.0;

    // g[i] accumulates the turn angle for position i (1-indexed walk positions)
    let mut g = vec![0.0f64; n + 5];

    // Work stack: (start, end) — using 1-indexed positions matching pair_table
    // start=0 means the outermost "before first" sentinel; end=N+1 means "after last"
    let mut work_stack: Vec<(usize, usize)> = vec![(0, n + 1)];

    let mut lp: usize = 0;
    let mut stk: usize = 0;
    // lSz and stL only needed for bookkeeping; we match the JS structure
    let cap = 16 + n / 5 + 2;
    let mut l_sz = vec![0i32; cap];
    let mut _st_l = vec![0i32; cap];

    while let Some((start, end_in)) = work_stack.pop() {
        let mut n_slots: usize = 2;
        let mut pair_idx: usize = 0;
        let mut n_unpaired: usize = 0;
        // pArr is 1-indexed; pArr[0] unused (we store pairs at indices 1..)
        let mut p_arr: Vec<usize> = vec![0usize; 1]; // pArr[0] = 0 (unused)
        let prev = if start == 0 { 0usize } else { start - 1 };
        let end = end_in + 1; // make end exclusive (same sentinel trick as JS)

        let mut i = start;
        while i != end {
            // pair_table is 1-indexed; index 0 holds N
            let partner = if i == 0 || i > n { 0 } else { pair_table[i] as usize };
            if partner != 0 && i != 0 && partner < end {
                // Paired position — not a pseudoknot crossing
                n_slots += 2;
                pair_idx += 1;
                p_arr.push(i);      // pArr[pair_idx*2 - 1] = i  (5' end)
                pair_idx += 1;
                p_arr.push(partner); // pArr[pair_idx*2]     = partner (3' end)

                // Walk inward to find stem length
                let y = i;
                let v = partner;
                let mut x = i;
                let mut a = partner;
                let mut z: usize = 0;
                loop {
                    x += 1;
                    if a == 0 { break; }
                    a -= 1;
                    z += 1;
                    if !(x < a && (pair_table[x] as usize) == a) {
                        break;
                    }
                }

                // Apply stem angle contributions
                let t = if z >= 2 { z - 2 } else { 0 };
                if z >= 2 {
                    // inner end
                    if y + 1 + t < g.len() { g[y + 1 + t] += half_pi; }
                    if v >= 1 + t          { g[v - 1 - t] += half_pi; }
                    // outer end
                    g[y] += half_pi;
                    g[v] += half_pi;
                    // straight interior
                    if z > 2 {
                        let mut tt = z - 2; // t was z-2; count down from t to 1
                        while tt >= 1 {
                            if y + tt < g.len() { g[y + tt] = PI; }
                            if v >= tt          { g[v - tt] = PI; }
                            if tt == 0 { break; }
                            tt -= 1;
                        }
                    }
                }
                stk += 1;
                if stk < _st_l.len() { _st_l[stk] = z as i32; }

                // Schedule inner loop (the region between the innermost stem pair)
                work_stack.push((x, a));
                i = partner + 1;
            } else {
                i += 1;
                n_slots += 1;
                n_unpaired += 1;
            }
        }

        // Distribute polygon interior angle across loop positions
        let poly_angle = PI * (n_slots as f64 - 2.0) / n_slots as f64;
        p_arr.push(end); // final sentinel
        pair_idx += 1;

        let mut seg_start = if prev == 0 { 0usize } else { prev };
        let mut u = 1usize;
        while u <= pair_idx {
            let target = p_arr[u];
            let span = if target >= seg_start { target - seg_start } else { 0 };
            for t in 0..=span {
                let idx = seg_start + t;
                if idx < g.len() {
                    g[idx] += poly_angle;
                }
            }
            if u >= pair_idx {
                break;
            }
            u += 1;
            seg_start = p_arr[u];
            u += 1;
        }

        lp += 1;
        if lp < l_sz.len() { l_sz[lp] = n_unpaired as i32; }
    }

    // Compensate for virtual entry/exit of outermost loop
    if lp >= 1 && 1 < l_sz.len() { l_sz[1] -= 2; }

    // Walk the backbone: turn by (π − accumulated angle) at each step
    let mut positions: Vec<(f64, f64)> = Vec::with_capacity(n);
    let mut angle = 0.0f64;
    let mut px = 0.0f64;
    let mut py = 0.0f64;
    positions.push((px, py));
    for i in 1..n {
        px += bd * angle.cos();
        py += bd * angle.sin();
        positions.push((px, py));
        let g_idx = i + 1;
        let g_val = if g_idx < g.len() { g[g_idx] } else { 0.0 };
        angle += PI - g_val;
    }

    // Flatten to [x0, y0, x1, y1, ...]
    let mut out = Vec::with_capacity(n * 2);
    for (x, y) in &positions {
        out.push(*x);
        out.push(*y);
    }
    out
}

// ─── B. Loop tension relaxation ──────────────────────────────────────────────
//
// Port of JS `applyLoopTension` from app.js.
//
// Modifies xs/ys in-place for `passes` iterations.
// pair_by_node[i] = j if node i is paired to j, else -1.
// prev_of[i] / next_of[i] are backbone neighbour IDs (-1 if none).

#[wasm_bindgen]
pub fn apply_loop_tension(
    xs: &mut [f64],
    ys: &mut [f64],
    pair_by_node: &[i32],
    prev_of: &[i32],
    next_of: &[i32],
    tension: f64,
    passes: u32,
) {
    if tension <= 0.0 {
        return;
    }
    let n = xs.len();
    let factor = tension * 0.5;
    for _ in 0..passes {
        for id in 0..n {
            if id < pair_by_node.len() && pair_by_node[id] >= 0 {
                continue; // paired base → anchor
            }
            let p = if id < prev_of.len() { prev_of[id] } else { -1 };
            let nxt = if id < next_of.len() { next_of[id] } else { -1 };
            if p < 0 || nxt < 0 {
                continue; // strand end → skip
            }
            let pi = p as usize;
            let ni = nxt as usize;
            if pi < n && ni < n {
                xs[id] += ((xs[pi] + xs[ni]) / 2.0 - xs[id]) * factor;
                ys[id] += ((ys[pi] + ys[ni]) / 2.0 - ys[id]) * factor;
            }
        }
    }
}

// ─── C1. classify_element_types ──────────────────────────────────────────────
//
// Port of the per-node element-type assignment in JS `classifyStructure`.
//
// pair_by_node[i] = paired partner of node i (or -1).
// stems_flat encodes all stems as flat pairs: [a0, b0, a1, b1, ...] for each stem
// concatenated together; stem_offsets[si..si+1] gives the flat slice for stem si
// (in units of i32 elements, so each pair takes 2 slots).
//
// Returns element types (i32) of length n:
//   0 = external, 1 = stem, 2 = hairpin, 3 = internal loop, 4 = junction

#[wasm_bindgen]
pub fn classify_element_types(
    _pair_by_node: &[i32],
    n: usize,
    stems_flat: &[i32],
    stem_offsets: &[i32],
) -> Vec<i32> {
    let stem_count = if stem_offsets.len() >= 1 { stem_offsets.len() - 1 } else { 0 };

    // Build sorted stem metadata: (a, b, len, original_index)
    // Each stem is represented by its outermost pair (first pair in stems_flat slice).
    struct StemMeta {
        a: i32,
        b: i32,
        len: usize,
        orig: usize,
    }

    let mut sm: Vec<StemMeta> = Vec::with_capacity(stem_count);
    for si in 0..stem_count {
        let off_start = stem_offsets[si] as usize;
        let off_end   = stem_offsets[si + 1] as usize;
        if off_start + 1 < stems_flat.len() && off_end <= stems_flat.len() && off_start < off_end {
            let a = stems_flat[off_start];
            let b = stems_flat[off_start + 1];
            let pair_count = (off_end - off_start) / 2;
            sm.push(StemMeta { a, b, len: pair_count, orig: si });
        }
    }
    // Sort: outermost first (smallest a, then largest b)
    sm.sort_by(|x, y| x.a.cmp(&y.a).then(y.b.cmp(&x.b)));

    // Build parent/children nesting
    let ns = sm.len();
    let mut children: Vec<Vec<usize>> = vec![vec![]; ns];
    let mut parent = vec![-1i32; ns];
    for i in 0..ns {
        for j in (0..i).rev() {
            if sm[j].a < sm[i].a && sm[j].b > sm[i].b {
                parent[i] = j as i32;
                children[j].push(i);
                break;
            }
        }
    }

    // Per-node element type (default: external = 0)
    let mut element_type = vec![0i32; n];

    // Mark stem nodes as 1
    for s in &sm {
        let off_start = stem_offsets[s.orig] as usize;
        let off_end   = stem_offsets[s.orig + 1] as usize;
        let mut k = off_start;
        while k + 1 < off_end && k + 1 < stems_flat.len() {
            let a = stems_flat[k] as usize;
            let b = stems_flat[k + 1] as usize;
            if a < n { element_type[a] = 1; }
            if b < n { element_type[b] = 1; }
            k += 2;
        }
    }

    // For non-stem nodes: find innermost containing stem, classify by child count
    for id in 0..n {
        if element_type[id] == 1 {
            continue;
        }
        let id_i = id as i32;
        let mut best: i32 = -1;
        for i in 0..ns {
            if sm[i].a < id_i && sm[i].b > id_i {
                if best < 0 || sm[i].a > sm[best as usize].a {
                    best = i as i32;
                }
            }
        }
        if best < 0 {
            // no containing stem → external (already 0)
            continue;
        }
        let nc = children[best as usize].len();
        element_type[id] = match nc {
            0 => 2, // hairpin
            1 => 3, // internal loop
            _ => 4, // junction
        };
    }

    element_type
}

// ─── C2. compute_mld ─────────────────────────────────────────────────────────
//
// Port of the MLD (maximum ladder distance) computation in JS `classifyStructure`.
// Same stems_flat / stem_offsets encoding as classify_element_types.

#[wasm_bindgen]
pub fn compute_mld(stems_flat: &[i32], stem_offsets: &[i32]) -> f64 {
    let stem_count = if stem_offsets.len() >= 1 { stem_offsets.len() - 1 } else { 0 };

    struct StemMeta {
        a: i32,
        b: i32,
        len: usize,
    }

    let mut sm: Vec<StemMeta> = Vec::with_capacity(stem_count);
    for si in 0..stem_count {
        let off_start = stem_offsets[si] as usize;
        let off_end   = stem_offsets[si + 1] as usize;
        if off_start + 1 < stems_flat.len() && off_end <= stems_flat.len() && off_start < off_end {
            let a = stems_flat[off_start];
            let b = stems_flat[off_start + 1];
            let pair_count = (off_end - off_start) / 2;
            sm.push(StemMeta { a, b, len: pair_count });
        }
    }
    sm.sort_by(|x, y| x.a.cmp(&y.a).then(y.b.cmp(&x.b)));

    let ns = sm.len();
    let mut children: Vec<Vec<usize>> = vec![vec![]; ns];
    for i in 0..ns {
        for j in (0..i).rev() {
            if sm[j].a < sm[i].a && sm[j].b > sm[i].b {
                children[j].push(i);
                break;
            }
        }
    }

    let mut depth = vec![0.0f64; ns];
    let mut mld = 0.0f64;
    for i in 0..ns {
        let d = depth[i] + sm[i].len as f64;
        if d > mld { mld = d; }
        for &c in &children[i] {
            if depth[c] < d { depth[c] = d; }
        }
    }
    mld
}
