(() => {
  const STRAND_COLORS = [
    "#0f766e","#2563eb","#9333ea","#b45309","#be123c",
    "#4d7c0f","#0ea5e9","#7c3aed","#059669","#dc2626"
  ];

  // Element-type palette (RiboGraphViz-inspired): stem / hairpin / internal loop / junction / external
  const ELEMENT_COLORS = {
    stem:     "#4f46e5",
    hairpin:  "#ea580c",
    internal: "#16a34a",
    junction: "#dc2626",
    external: "#9ca3af"
  };

  const BRACKET_FAMILIES = [
    ["(", ")"], ["[", "]"], ["{", "}"], ["<", ">"],
    ["A", "a"], ["B", "b"], ["C", "c"], ["D", "d"], ["E", "e"], ["F", "f"],
    ["G", "g"], ["H", "h"], ["I", "i"], ["J", "j"], ["K", "k"], ["L", "l"],
    ["M", "m"], ["N", "n"], ["O", "o"], ["P", "p"], ["Q", "q"], ["R", "r"],
    ["S", "s"], ["T", "t"], ["U", "u"], ["V", "v"], ["W", "w"], ["X", "x"],
    ["Y", "y"], ["Z", "z"]
  ];
  const OPENERS = new Set(BRACKET_FAMILIES.map(x => x[0]));
  const CLOSERS = new Map(BRACKET_FAMILIES.map(x => [x[1], x[0]]));

  const el = id => document.getElementById(id);

  let width = 1200, height = 900;
  let simulation = null;
  let graph = null;
  let model = emptyModel();
  let currentJobId = 0;
  let cancelRequested = false;
  let selectedNodes = new Set();
  let features = null;
  let classification = null;
  let wasDragged = false;
  let dragGroupStart = null;
  let liveSim = null;

  function emptyModel() {
    return { title:"", sequenceStrands:[], structure:"", importedFormat:"", notes:[] };
  }

  // ─── THREE.JS RENDERER ───────────────────────────────────────────────────────
  const _glCanvas = document.getElementById('glcanvas');
  const _ovCanvas = document.getElementById('overlaycanvas');
  const _ovCtx    = _ovCanvas.getContext('2d');

  const glRenderer = new THREE.WebGLRenderer({ canvas: _glCanvas, antialias: true });
  glRenderer.setClearColor(0xf3f4f6, 1);

  const glScene  = new THREE.Scene();
  // OrthographicCamera: world space = graph pixel space, Y-up (negate Y vs screen Y)
  const glCamera = new THREE.OrthographicCamera(-600, 600, 450, -450, -100, 100);
  glCamera.position.set(0, 0, 10);

  // Camera state: zoom factor + pan in WORLD units
  let glZoom = 1, glPanX = 0, glPanY = 0;

  // Three.js objects (rebuilt on each renderGraph)
  let nodeInstMesh = null, backboneLines = null, pairLines = null;

  // Pre-allocated reusables (avoid GC in ticked)
  const _dummy   = new THREE.Object3D();
  const _c3      = new THREE.Color();
  const _strandC = STRAND_COLORS.map(s => new THREE.Color(s));
  const _elemC   = Object.fromEntries(Object.entries(ELEMENT_COLORS).map(([k,v]) => [k, new THREE.Color(v)]));
  const _pairC   = new THREE.Color('#1d4ed8');
  const _backboneC = STRAND_COLORS.map(s => new THREE.Color(s)); // same as strand

  function graphToWorld(gx, gy)  { return [gx - width/2, height/2 - gy]; }
  function worldToGraph(wx, wy)  { return [wx + width/2, height/2 - wy]; }
  function screenToWorld(sx, sy) { return [(sx - width/2) / glZoom + glPanX,  -(sy - height/2) / glZoom + glPanY]; }
  function worldToScreen(wx, wy) { return [(wx - glPanX) * glZoom + width/2, -(wy - glPanY) * glZoom + height/2]; }
  function screenToGraph(sx, sy) { const [wx,wy] = screenToWorld(sx,sy); return worldToGraph(wx,wy); }

  function updateCamera() {
    const hw = width  / 2 / glZoom;
    const hh = height / 2 / glZoom;
    glCamera.left   = glPanX - hw;  glCamera.right  = glPanX + hw;
    glCamera.top    = glPanY + hh;  glCamera.bottom = glPanY - hh;
    glCamera.updateProjectionMatrix();
  }

  function updateStatusZoom() {
    const scalePct = Math.round(glZoom * 100);
    const badge    = el("progressBadge").textContent;
    el("status").innerHTML = `<strong>${badge}</strong><br>zoom ${scalePct}%`;
  }

  function animateCameraTo(tPanX, tPanY, tZoom, duration) {
    const s0x = glPanX, s0y = glPanY, s0z = glZoom;
    const t0  = performance.now();
    (function step(now) {
      const t    = Math.min(1, (now - t0) / Math.max(1, duration));
      const ease = 1 - Math.pow(1 - t, 3);
      glPanX = s0x + (tPanX - s0x) * ease;
      glPanY = s0y + (tPanY - s0y) * ease;
      glZoom = s0z + (tZoom  - s0z) * ease;
      updateCamera();
      if (!liveSim) ticked();
      updateStatusZoom();
      if (t < 1) requestAnimationFrame(step);
    })(t0);
  }

  function resize() {
    const r = document.querySelector(".viewer").getBoundingClientRect();
    width  = r.width;
    height = r.height;
    glRenderer.setPixelRatio(window.devicePixelRatio);
    glRenderer.setSize(width, height, false);
    _ovCanvas.width  = width  * window.devicePixelRatio;
    _ovCanvas.height = height * window.devicePixelRatio;
    _ovCanvas.style.width  = width  + 'px';
    _ovCanvas.style.height = height + 'px';
    _ovCtx.scale(window.devicePixelRatio, window.devicePixelRatio);
    updateCamera();
    if (graph) ticked();
  }
  window.addEventListener("resize", resize);
  resize();

  // ─── AUTO-CENTERING ───────────────────────────────────────────────────────

  function centerView(duration = 200) {
    if (!graph || !graph.nodes.length) return;
    const xs = graph.nodes.map(d => d.x), ys = graph.nodes.map(d => d.y);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    const [tpx, tpy] = graphToWorld(cx, cy);
    animateCameraTo(tpx, tpy, glZoom, duration);
  }

  // ─── PROGRESS / BUSY ──────────────────────────────────────────────────────

  function setProgress(state, title, value, text, errorText = "") {
    el("progressTitle").textContent = title;
    el("progressFill").style.width = `${Math.max(0, Math.min(100, value))}%`;
    el("progressText").textContent = text || "";
    const badge = el("progressBadge");
    badge.className = "badge";
    if (state === "busy") { badge.classList.add("badge-busy"); badge.textContent = "BUSY"; }
    else if (state === "ok") { badge.classList.add("badge-ok"); badge.textContent = "DONE"; }
    else if (state === "error") { badge.classList.add("badge-err"); badge.textContent = "FAILED"; }
    else { badge.classList.add("badge-idle"); badge.textContent = "IDLE"; }

    const box = el("errorBox");
    if (errorText) { box.style.display = "block"; box.textContent = errorText; }
    else { box.style.display = "none"; box.textContent = ""; }

    el("status").innerHTML = `<strong>${badge.textContent}</strong><br>${text || "zoom 100%"}`;
  }

  function setBusy(flag) {
    el("cancelBtn").disabled = !flag;
    el("importBtn").disabled = flag;
    el("renderBtn").disabled = flag;
    el("relaxBtn").disabled = flag;
  }

  // ─── PARSING HELPERS ──────────────────────────────────────────────────────

  function stripWs(s) { return (s || "").replace(/\r/g, "").trim(); }
  function cleanSequence(s) { return stripWs(s).replace(/\s+/g, "").replace(/-/g, ""); }
  function placeholderBase() { return "N"; }

  function isLikelyDbLine(line) {
    return /^[.\+\(\)\[\]\{\}<>A-Za-z]+$/.test(line) && /[.()\[\]{}<>A-Za-z]/.test(line);
  }

  function parseFASTA(text) {
    const lines = text.replace(/\r/g, "").split("\n");
    const records = [];
    let title = "", seq = [];
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith(">")) {
        if (title || seq.length) records.push({title, seq:seq.join("")});
        title = line.slice(1).trim(); seq = [];
      } else seq.push(line);
    }
    if (title || seq.length) records.push({title, seq:seq.join("")});
    return { title:records[0]?.title || "", sequenceStrands:records.map(r => cleanSequence(r.seq)), importedFormat:"fasta" };
  }

  function parseSEQ(text) {
    const lines = text.replace(/\r/g, "").split("\n");
    let i = 0;
    while (i < lines.length && lines[i].trim().startsWith(";")) i++;
    const title = (lines[i] || "").trim();
    i++;
    const seq = lines.slice(i).join("").replace(/\s+/g, "").replace(/1\s*$/, "");
    return { title, sequenceStrands:[seq], importedFormat:"seq" };
  }

  function parseRawStructure(text) {
    const structure = stripWs(text).replace(/\s+/g, "");
    return {
      title:"Raw structure input",
      sequenceStrands:sequenceFromStructure(structure).split("+"),
      structure,
      importedFormat:"raw-structure",
      notes:["No sequence was provided. Inserted placeholder bases."]
    };
  }

  function parseDBN(text) {
    const lines = text.replace(/\r/g, "").split("\n").filter(x => x.trim() !== "");
    if (lines.length === 1 && isLikelyDbLine(lines[0])) return parseRawStructure(lines[0]);
    let title = "", seqLine, structLine;
    if (lines[0]?.startsWith(">")) {
      title = lines[0].slice(1).trim();
      seqLine   = lines[1] || "";
      structLine = lines[2] || "";
    } else {
      // No title line — line 0 is sequence, line 1 is structure
      seqLine   = lines[0] || "";
      structLine = lines[1] || "";
    }
    const sequence = cleanSequence(seqLine);
    const structure = stripWs(structLine).replace(/\s+/g, "");
    return { title, sequenceStrands:[sequence], structure, importedFormat:"dbn" };
  }

  function parseCT(text, which = 1) {
    const lines = text.replace(/\r/g, "").split("\n").filter(x => x.trim() !== "");
    const structures = [];
    let i = 0;
    while (i < lines.length) {
      const header = lines[i].trim();
      // Title is optional; energy annotations like "ENERGY = -10.5" are stripped
      const m = header.match(/^(\d+)(?:\s+(.*))?$/);
      if (!m) break;
      const n = parseInt(m[1], 10);
      const rawTitle = (m[2] || "").replace(/^(ENERGY|dG|dGinit)\s*=\s*[-\d.e+]+\s*(kcal\/mol)?\s*/i, "").trim();
      const rows = [];
      for (let k = 0; k < n && i + 1 + k < lines.length; k++) rows.push(lines[i + 1 + k].trim().split(/\s+/));
      if (rows.length < n) break;
      structures.push({title: rawTitle, rows});
      i += n + 1;
    }
    const idx = Math.max(1, Math.min(which, structures.length)) - 1;
    const chosen = structures[idx] || {title:"", rows:[]};
    const rows = chosen.rows;

    // Detect strand breaks: a nick exists after row j when the next-pointer of row j
    // doesn't equal the position recorded in row j+1 (or is 0 = end of strand).
    const nicks = new Set();
    for (let j = 0; j < rows.length - 1; j++) {
      const nextPtr = parseInt(rows[j][3] || "0", 10);
      const nextPos = parseInt(rows[j + 1][0] || "0", 10);
      if (nextPtr === 0 || nextPtr !== nextPos) nicks.add(j);
    }

    // Build per-strand sequences and a node-index map keyed by CT position number
    const strands = [];
    const posToNode = new Map(); // 1-indexed CT position → 0-indexed node index
    let cur = [], nodeIdx = 0;
    for (let j = 0; j < rows.length; j++) {
      posToNode.set(parseInt(rows[j][0], 10), nodeIdx++);
      cur.push(rows[j][1] || placeholderBase());
      if (nicks.has(j)) { strands.push(cur.join("")); cur = []; }
    }
    if (cur.length) strands.push(cur.join(""));

    // Build pair list using the node-index map
    const pairs = [];
    for (let j = 0; j < rows.length; j++) {
      const p1 = parseInt(rows[j][4] || "0", 10);
      if (p1 > 0) {
        const pi = posToNode.get(p1);
        if (pi !== undefined && pi > j) pairs.push([j, pi]);
      }
    }

    // Build flat bracket string then re-insert strand separators
    const flatBracket = pairsToBracketString(rows.length, pairs);
    let structure = "", pos = 0;
    for (let si = 0; si < strands.length; si++) {
      if (si > 0) structure += "+";
      structure += flatBracket.slice(pos, pos + strands[si].length);
      pos += strands[si].length;
    }

    const notes = structures.length > 1
      ? [`CT contained ${structures.length} structures; loaded structure ${idx + 1}.`] : [];
    if (nicks.size > 0) notes.push(`Detected ${strands.length} strands from backbone connectivity.`);

    return { title: chosen.title, sequenceStrands: strands, structure, importedFormat:"ct", notes };
  }

  function autoDetectFormat(text) {
    const t = text.replace(/\r/g, "").trim();
    const lines = t.split("\n").map(x => x.trim()).filter(Boolean);
    if (!lines.length) return "auto";
    if (lines.length === 1 && /^[.\+\(\)\[\]\{\}<>A-Za-z]+$/.test(lines[0])) return "raw-structure";
    if (lines[0].startsWith(">")) {
      if (lines.length >= 3 && isLikelyDbLine(lines[2].replace(/\s+/g, ""))) return "dbn";
      return "fasta";
    }
    if (lines[0].startsWith(";")) return "seq";
    // CT: data rows have ≥5 fields — idx nuc prev next pair [natural]
    if (/^\d+\s+\S+\s+\d+\s+\d+\s+\d+/.test(lines[1] || "")) return "ct";
    if (lines.every(x => /^[.\+\(\)\[\]\{\}<>A-Za-z]+$/.test(x))) return "dbn";
    return "raw-structure";
  }

  function pairsToBracketString(n, pairs) {
    const chars = Array(n).fill(".");
    const placed = []; // {a, b, fi}
    for (const [a, b] of pairs.sort((x, y) => (x[0] - y[0]) || (y[1] - x[1]))) {
      // Determine which bracket families are forbidden due to crossing pairs
      const forbidden = new Set();
      for (const p of placed) {
        if ((p.a < a && a < p.b && p.b < b) || (a < p.a && p.a < b && b < p.b))
          forbidden.add(p.fi);
      }
      let fi = 0;
      for (; fi < BRACKET_FAMILIES.length; fi++) if (!forbidden.has(fi)) break;
      const [op, cl] = BRACKET_FAMILIES[fi] || BRACKET_FAMILIES[0];
      chars[a] = op; chars[b] = cl;
      placed.push({a, b, fi});
    }
    return chars.join("");
  }

  function sequenceFromStructure(structure) {
    const base = placeholderBase();
    return structure.split("+").map(x => base.repeat(x.length)).join("+");
  }

  function normalizeModel() {
    const seq = stripWs(el("sequenceText").value).replace(/\s+/g, "");
    const dbp = stripWs(el("structureText").value).replace(/\s+/g, "");
    model.sequenceStrands = seq ? seq.split("+").map(s => cleanSequence(s)) : [];
    model.structure = dbp || "";
    if (!model.sequenceStrands.length && model.structure) model.sequenceStrands = sequenceFromStructure(model.structure).split("+");
    if (!model.structure && model.sequenceStrands.length) model.structure = model.sequenceStrands.map(s => ".".repeat(s.length)).join("+");
    const seqLen = model.sequenceStrands.reduce((a, s) => a + s.length, 0);
    const structLen = model.structure.replace(/\+/g, "").length;
    if (seqLen && structLen && seqLen !== structLen) model.notes.push(`Sequence length ${seqLen} and structure length ${structLen} differ.`);
    if (!model.structure || structLen === 0) throw new Error("No structure was parsed from the input.");
  }

  // ─── GRAPH BUILDING ───────────────────────────────────────────────────────

  function parseDotBracketPlus(sequencePlus, structurePlus) {
    const seqChars = sequencePlus.replace(/\+/g, "").split("");
    const nodes = [], pairLinks = [], backboneLinks = [];
    const stacks = new Map(), pairByNode = new Map(), structureIndexToNode = new Map();
    const nickAfterNode = new Set(), strandNodeIds = [], errors = [];
    let strand = 0, prevNode = null, seqIndex = 0;

    for (let i = 0; i < structurePlus.length; i++) {
      const ch = structurePlus[i];
      if (ch === "+") {
        if (prevNode) nickAfterNode.add(prevNode.id);
        strand += 1; prevNode = null; continue;
      }

      const node = {
        id:nodes.length, strand, structureIndex:i, seq:seqChars[seqIndex] || placeholderBase(),
        label:seqChars[seqIndex] || String(nodes.length + 1),
        x:0, y:0, vx:0, vy:0, fx:null, fy:null
      };
      nodes.push(node);
      if (!strandNodeIds[strand]) strandNodeIds[strand] = [];
      strandNodeIds[strand].push(node.id);
      structureIndexToNode.set(i, node.id);

      if (prevNode && prevNode.strand === node.strand) backboneLinks.push({source:prevNode.id, target:node.id, kind:"backbone"});
      prevNode = node;
      seqIndex++;

      if (OPENERS.has(ch)) {
        if (!stacks.has(ch)) stacks.set(ch, []);
        stacks.get(ch).push(i);
      } else if (CLOSERS.has(ch)) {
        const opener = CLOSERS.get(ch);
        const arr = stacks.get(opener) || [];
        const left = arr.pop();
        if (left == null) errors.push(`Unmatched ${ch} at structure index ${i}.`);
        else {
          const a = structureIndexToNode.get(left), b = node.id;
          pairLinks.push({source:a, target:b, kind:"pair"});
          pairByNode.set(a, b); pairByNode.set(b, a);
        }
      } else if (ch !== ".") errors.push(`Unsupported structure symbol "${ch}" at index ${i}.`);
    }

    for (const [op, arr] of stacks.entries()) {
      for (const idx of arr) errors.push(`Unmatched ${op} at structure index ${idx}.`);
    }

    const stems = buildStems(pairLinks);
    return { nodes, pairLinks, backboneLinks, pairByNode, nickAfterNode, strandNodeIds, errors, stems };
  }

  function buildStems(pairLinks) {
    const pairMap = new Map();
    for (const p of pairLinks) {
      const a = Math.min(p.source, p.target), b = Math.max(p.source, p.target);
      pairMap.set(`${a}:${b}`, {a, b, used:false});
    }
    const ordered = [...pairMap.values()].sort((u, v) => (u.a - v.a) || (v.b - u.b));
    const stems = [];
    for (const p of ordered) {
      if (p.used) continue;
      const stem = [{a:p.a, b:p.b}];
      p.used = true;
      let a = p.a, b = p.b;
      while (pairMap.has(`${a + 1}:${b - 1}`) && !pairMap.get(`${a + 1}:${b - 1}`).used) {
        const q = pairMap.get(`${a + 1}:${b - 1}`);
        q.used = true;
        stem.push({a:q.a, b:q.b});
        a = q.a; b = q.b;
      }
      stems.push(stem);
    }
    return stems;
  }

  function buildStructuralFeatures(graph) {
    const N = graph.nodes.length;
    const pb = graph.pairByNode;
    const nodeToStem = new Map();
    const nodeToLoop = new Map();
    const loops = [];

    graph.stems.forEach((stem, si) => {
      for (const p of stem) { nodeToStem.set(p.a, si); nodeToStem.set(p.b, si); }
    });

    function processRegion(lo, hi) {
      const loopId = loops.length;
      loops.push({ nodeIds: [] });
      let i = lo;
      while (i <= hi) {
        const partner = pb.get(i);
        if (partner !== undefined && partner > i && partner <= hi) {
          let a = i, b = partner;
          while (a < b && pb.get(a) === b) { a++; b--; }
          processRegion(a, b);
          i = partner + 1;
        } else if (partner !== undefined && partner < lo) {
          i++;
        } else {
          nodeToLoop.set(i, loopId);
          loops[loopId].nodeIds.push(i);
          i++;
        }
      }
    }

    processRegion(0, N - 1);
    return { nodeToStem, nodeToLoop, loops };
  }

  // ─── STRUCTURAL CLASSIFICATION (RiboGraphViz-inspired) ────────────────────
  // Classifies each stem's inner region as hairpin / internal loop / n-way junction
  // and computes MLD (Maximum Ladder Distance: longest chain of stacked base pairs).
  function classifyStructure(graph) {
    const stems = graph.stems;
    if (!stems.length) return null;
    const N = graph.nodes.length;

    // Sort stems outermost-first (largest span first)
    const sm = stems.map((s, i) => ({ i, a: s[0].a, b: s[0].b, len: s.length }))
      .sort((x, y) => (x.a - y.a) || (y.b - x.b));

    // Build immediate-parent / children relationships via nesting containment
    const parent   = new Int32Array(sm.length).fill(-1);
    const children = sm.map(() => []);
    for (let i = 0; i < sm.length; i++) {
      for (let j = i - 1; j >= 0; j--) {
        if (sm[j].a < sm[i].a && sm[j].b > sm[i].b) {
          parent[i] = j; children[j].push(i); break;
        }
      }
    }

    // MLD: longest path of cumulative stem-pair depth
    const depth = new Float64Array(sm.length);
    let mld = 0;
    for (let i = 0; i < sm.length; i++) {
      const d = depth[i] + sm[i].len;
      if (d > mld) mld = d;
      for (const c of children[i]) if (depth[c] < d) depth[c] = d;
    }

    // Loop classification by stem's inner region child count
    let hairpins = 0, internalLoops = 0;
    const junctions = {};
    for (let i = 0; i < sm.length; i++) {
      const nc = children[i].length;
      if      (nc === 0) hairpins++;
      else if (nc === 1) internalLoops++;
      else { const n = nc + 1; junctions[n] = (junctions[n] || 0) + 1; }
    }

    // Per-node element type
    const elementType = new Array(N).fill("external");
    for (const s of sm) {
      for (const { a, b } of stems[s.i]) {
        elementType[a] = "stem";
        elementType[b] = "stem";
      }
    }
    for (let id = 0; id < N; id++) {
      if (elementType[id] === "stem") continue;
      let best = -1;
      for (let i = 0; i < sm.length; i++) {
        if (sm[i].a < id && sm[i].b > id && (best < 0 || sm[i].a > sm[best].a)) best = i;
      }
      if (best < 0) continue;
      const nc = children[best].length;
      elementType[id] = nc === 0 ? "hairpin" : nc === 1 ? "internal" : "junction";
    }

    return { hairpins, internalLoops, junctions, mld, elementType };
  }

  // Rotate all nodes so the structure's principal axis is horizontal (PCA),
  // then flip if the 5′ end ends up on the right.
  function alignCanonical(graph) {
    const nodes = graph.nodes;
    const N = nodes.length;
    if (N < 2) return;
    let mx = 0, my = 0;
    for (const n of nodes) { mx += n.x; my += n.y; }
    mx /= N; my /= N;
    let cxx = 0, cxy = 0, cyy = 0;
    for (const n of nodes) {
      const dx = n.x - mx, dy = n.y - my;
      cxx += dx * dx; cxy += dx * dy; cyy += dy * dy;
    }
    // Closed-form principal-axis angle from 2×2 symmetric covariance matrix
    const angle = Math.atan2(2 * cxy, cxx - cyy) / 2;
    const cosA = Math.cos(-angle), sinA = Math.sin(-angle);
    for (const n of nodes) {
      const dx = n.x - mx, dy = n.y - my;
      n.x = mx + dx * cosA - dy * sinA;
      n.y = my + dx * sinA + dy * cosA;
    }
    // Keep 5′ end on the left
    if (nodes[0] && nodes[0].x > mx) {
      for (const n of nodes) n.x = 2 * mx - n.x;
    }
  }

  function connectedComponents(n, edges) {
    const adj = Array.from({length:n}, () => []);
    for (const e of edges) {
      adj[e.source].push(e.target);
      adj[e.target].push(e.source);
    }
    const seen = Array(n).fill(false), comps = [];
    for (let i = 0; i < n; i++) {
      if (seen[i]) continue;
      const q = [i], comp = [];
      seen[i] = true;
      while (q.length) {
        const u = q.shift();
        comp.push(u);
        for (const v of adj[u]) if (!seen[v]) { seen[v] = true; q.push(v); }
      }
      comps.push(comp);
    }
    return comps;
  }

  // ─── STATIC LAYOUT ALGORITHMS ────────────────────────────────────────────

  function getLayoutMode() { return el("layoutMode").value; }
  function getBaseSpacing() { return Math.max(6, +el("baseSpacing").value || 16); }

  function layoutCircular(graph) {
    const N = graph.nodes.length;
    if (!N) return;
    const BD = getBaseSpacing();
    const nicks = graph.nickAfterNode;
    const NICK_FRAC = nicks.size > 0 ? 0.025 : 0;
    const nickAngle = nicks.size * NICK_FRAC * 2 * Math.PI;
    const availAngle = 2 * Math.PI - nickAngle;
    const anglePerBase = availAngle / Math.max(N, 1);
    const radius = Math.max(60, N * BD / (2 * Math.PI));
    const cx = width / 2, cy = height / 2;
    let a = -Math.PI / 2;
    for (let i = 0; i < N; i++) {
      graph.nodes[i].x = cx + radius * Math.cos(a);
      graph.nodes[i].y = cy + radius * Math.sin(a);
      graph.nodes[i].vx = graph.nodes[i].vy = 0;
      a += anglePerBase;
      if (nicks.has(i)) a += NICK_FRAC * 2 * Math.PI;
    }
  }

  function layoutLinear(graph) {
    const BD = getBaseSpacing();
    const NICK_GAP = 3;
    const nicks = graph.nickAfterNode;
    const N = graph.nodes.length;
    const totalWidth = (N - 1) * BD + nicks.size * NICK_GAP * BD;
    const startX = (width - totalWidth) / 2;
    const y = height * 0.68;
    let x = startX;
    for (let i = 0; i < N; i++) {
      graph.nodes[i].x = x;
      graph.nodes[i].y = y;
      graph.nodes[i].vx = graph.nodes[i].vy = 0;
      x += BD;
      if (nicks.has(i)) x += NICK_GAP * BD;
    }
  }

  // ─── FORNA NAView-style radial layout ───────────────────────────────────
  // Port of simple_xy_coordinates from ViennaRNA/forna (Apache-2.0).
  // Each loop is modelled as a regular polygon; stems get π/2 turns at
  // entry/exit and π (straight) in their interior.  Positions are computed
  // by walking the backbone and accumulating turn angles.

  function fornaRadialPositions(pairByNode, N, BD) {
    // Build 1-indexed pair table (forna convention: pt[0] = length)
    const pt = new Array(N + 1);
    pt[0] = N;
    for (let i = 1; i <= N; i++) pt[i] = 0;
    for (const [i, j] of pairByNode) {
      pt[i + 1] = j + 1;
    }

    const g   = new Float64Array(N + 5);           // angle accumulator
    const lSz = new Array(16 + Math.floor(N / 5)).fill(0); // unpaired counts
    const stL = new Array(16 + Math.floor(N / 5)).fill(0); // stem lengths
    let lp = 0, stk = 0;
    const HALF_PI = Math.PI / 2;

    // Iterative loop decomposition — avoids JS call-stack overflow on deeply
    // nested / pseudoknotted structures (recursive version exceeded ~100k frames).
    // All g-array writes are additive (+=) except stem-interior assignments
    // (= Math.PI) which never overlap with any loop's polyAngle segments, so
    // pre-order processing produces identical results to post-order recursion.
    const workStack = [{start: 0, end: N + 1}];
    while (workStack.length > 0) {
      let { start, end } = workStack.pop();
      let nSlots = 2, pairIdx = 0, nUnpaired = 0;
      const pArr = [0]; // 1-indexed; pArr[0] unused
      const prev = start - 1;
      end++;            // make end exclusive

      let i = start;
      while (i !== end) {
        const partner = pt[i];
        if (partner && i !== 0 && partner < end) { // paired → stem (skip pseudoknot crossings)
          nSlots += 2;
          pArr[++pairIdx] = i;
          pArr[++pairIdx] = partner;

          // walk inward to find stem length
          const y = i, v = partner;
          let x = i, a = partner, z = 0;
          do { x++; a--; z++; } while (x < a && pt[x] === a);

          let t = z - 2;
          if (z >= 2) {
            g[y + 1 + t] += HALF_PI;   // inner end, 5′ side
            g[v - 1 - t] += HALF_PI;   // inner end, 3′ side
            g[y]         += HALF_PI;   // outer end, 5′ side
            g[v]         += HALF_PI;   // outer end, 3′ side
            if (z > 2) {
              for (; t >= 1; t--) {
                g[y + t] = Math.PI;    // straight through interior
                g[v - t] = Math.PI;
              }
            }
          }
          stL[++stk] = z;
          workStack.push({start: x, end: a}); // schedule inner loop
          i = partner + 1;
        } else {
          i++; nSlots++; nUnpaired++;
        }
      }

      // Distribute polygon interior angle across loop positions
      const polyAngle = Math.PI * (nSlots - 2) / nSlots;
      pArr[++pairIdx] = end;

      let segStart = prev < 0 ? 0 : prev;
      for (let u = 1; u <= pairIdx; u++) {
        const span = pArr[u] - segStart;
        for (let t = 0; t <= span; t++) g[segStart + t] += polyAngle;
        if (u >= pairIdx) break;
        segStart = pArr[++u];
      }
      lSz[++lp] = nUnpaired;
    }
    lSz[1] -= 2; // compensate for virtual entry/exit of the outermost loop (always lp index 1)

    // Walk backbone, turning by (π − accumulated angle) at each step
    const positions = new Array(N);
    let angle = 0, px = 0, py = 0;
    positions[0] = [px, py];
    for (let i = 1; i < N; i++) {
      px += BD * Math.cos(angle);
      py += BD * Math.sin(angle);
      positions[i] = [px, py];
      angle += Math.PI - g[i + 1];
    }
    return positions;
  }

  // Pull unpaired loop bases toward the midpoint of their backbone neighbors.
  // Paired bases and strand-end bases are anchors and stay fixed.
  // Multiple passes propagate the tension through long unpaired runs.
  function applyLoopTension(graph, tension) {
    if (tension <= 0) return;
    const nodes  = graph.nodes;
    const pb     = graph.pairByNode;
    const prevOf = new Int32Array(nodes.length).fill(-1);
    const nextOf = new Int32Array(nodes.length).fill(-1);
    for (const lk of graph.backboneLinks) {
      nextOf[lk.source] = lk.target;
      prevOf[lk.target] = lk.source;
    }
    const factor = tension * 0.5;
    for (let pass = 0; pass < 20; pass++) {
      for (let id = 0; id < nodes.length; id++) {
        if (pb.has(id)) continue;           // paired base → anchor
        const p = prevOf[id], n = nextOf[id];
        if (p < 0 || n < 0) continue;      // strand end → skip
        nodes[id].x += ((nodes[p].x + nodes[n].x) / 2 - nodes[id].x) * factor;
        nodes[id].y += ((nodes[p].y + nodes[n].y) / 2 - nodes[id].y) * factor;
      }
    }
  }

  function layoutRadial(graph) {
    const BD      = getBaseSpacing();
    const tension = Math.max(0, Math.min(1, +el("loopTension").value || 0));
    const nodes   = graph.nodes;
    const N       = nodes.length;
    if (!N) return;

    const pos = fornaRadialPositions(graph.pairByNode, N, BD);

    // Centre on viewport
    let sx = 0, sy = 0;
    for (let i = 0; i < N; i++) { sx += pos[i][0]; sy += pos[i][1]; }
    const ox = width  / 2 - sx / N;
    const oy = height / 2 - sy / N;

    for (let i = 0; i < N; i++) {
      nodes[i].x  = pos[i][0] + ox;
      nodes[i].y  = pos[i][1] + oy;
      nodes[i].vx = nodes[i].vy = 0;
    }
    applyLoopTension(graph, tension);
  }

  function layoutRadialFromHints(graph) {
    const BD    = getBaseSpacing();
    const nodes = graph.nodes;
    const N     = nodes.length;
    if (!N) return;

    // Capture current positions as hints
    const hx = nodes.map(n => n.x);
    const hy = nodes.map(n => n.y);
    let gcx = 0, gcy = 0;
    hx.forEach(x => gcx += x); gcx /= N;
    hy.forEach(y => gcy += y); gcy /= N;
    const spread = Math.max(...hx.map((x, i) => Math.hypot(x - gcx, hy[i] - gcy)));
    if (spread < 8) { layoutRadial(graph); return; }

    // Compute fresh forna positions
    const pos = fornaRadialPositions(graph.pairByNode, N, BD);
    let fx = 0, fy = 0;
    for (let i = 0; i < N; i++) { fx += pos[i][0]; fy += pos[i][1]; }
    fx /= N; fy /= N;

    // Optimal rotation to align with hints (Procrustes)
    let sinSum = 0, cosSum = 0;
    for (let i = 0; i < N; i++) {
      const dx = pos[i][0] - fx, dy = pos[i][1] - fy;
      const hxn = hx[i] - gcx,  hyn = hy[i] - gcy;
      cosSum += dx * hxn + dy * hyn;
      sinSum += dx * hyn - dy * hxn;
    }
    const bestAngle = Math.atan2(sinSum, cosSum);
    const cosA = Math.cos(bestAngle), sinA = Math.sin(bestAngle);

    const tension = Math.max(0, Math.min(1, +el("loopTension").value || 0));
    for (let i = 0; i < N; i++) {
      const dx = pos[i][0] - fx, dy = pos[i][1] - fy;
      nodes[i].x  = gcx + dx * cosA - dy * sinA;
      nodes[i].y  = gcy + dx * sinA + dy * cosA;
      nodes[i].vx = nodes[i].vy = 0;
    }
    applyLoopTension(graph, tension);
  }

  // ─── THREE.JS RENDER FUNCTIONS ────────────────────────────────────────────

  function applyNodeColors() {
    if (!nodeInstMesh || !graph) return;
    const nodes  = graph.nodes;
    const byElem = el("colorByElement").checked && classification;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      const base = byElem
        ? (_elemC[classification.elementType[i]] || _strandC[n.strand % _strandC.length])
        : _strandC[n.strand % _strandC.length];
      if (selectedNodes.has(i)) _c3.set(0xf59e0b); else _c3.copy(base);
      nodeInstMesh.setColorAt(i, _c3);
    }
    if (nodeInstMesh.instanceColor) nodeInstMesh.instanceColor.needsUpdate = true;
  }

  function ticked() {
    if (!nodeInstMesh || !graph) return;
    const nodes  = graph.nodes;
    const N      = nodes.length;
    const mode   = getLayoutMode();
    const BEZIER_SEGS = 12;

    // ── nodes ──
    for (let i = 0; i < N; i++) {
      const n = nodes[i];
      const [wx, wy] = graphToWorld(n.x, n.y);
      _dummy.position.set(wx, wy, 0);
      _dummy.updateMatrix();
      nodeInstMesh.setMatrixAt(i, _dummy.matrix);
    }
    nodeInstMesh.instanceMatrix.needsUpdate = true;
    applyNodeColors();

    // ── backbone ──
    {
      const bPos = backboneLines.geometry.attributes.position.array;
      const bCol = backboneLines.geometry.attributes.color.array;
      const BL   = graph.backboneLinks;
      for (let i = 0; i < BL.length; i++) {
        const s = nodes[BL[i].source], t = nodes[BL[i].target];
        const [sx,sy] = graphToWorld(s.x, s.y);
        const [tx,ty] = graphToWorld(t.x, t.y);
        const ci = i * 6;
        bPos[ci]=sx; bPos[ci+1]=sy; bPos[ci+2]=0;
        bPos[ci+3]=tx; bPos[ci+4]=ty; bPos[ci+5]=0;
        const c = _strandC[s.strand % _strandC.length];
        bCol[ci]=c.r; bCol[ci+1]=c.g; bCol[ci+2]=c.b;
        bCol[ci+3]=c.r; bCol[ci+4]=c.g; bCol[ci+5]=c.b;
      }
      backboneLines.geometry.attributes.position.needsUpdate = true;
      backboneLines.geometry.attributes.color.needsUpdate    = true;
      backboneLines.geometry.setDrawRange(0, BL.length * 2);
    }

    // ── pairs ──
    {
      const pPos = pairLines.geometry.attributes.position.array;
      const pCol = pairLines.geometry.attributes.color.array;
      const PL   = graph.pairLinks;
      let vi = 0;
      for (const lk of PL) {
        const src = nodes[lk.source], tgt = nodes[lk.target];
        if (mode === 'linear') {
          const mx   = (src.x + tgt.x) / 2;
          const span = Math.abs(tgt.x - src.x);
          const h    = Math.max(10, span * 0.5);
          const cpx  = mx, cpy = src.y - h;
          for (let s = 0; s < BEZIER_SEGS; s++) {
            const t0 = s / BEZIER_SEGS, t1 = (s + 1) / BEZIER_SEGS;
            for (const tt of [t0, t1]) {
              const ot = 1 - tt;
              const gx = ot*ot*src.x + 2*ot*tt*cpx + tt*tt*tgt.x;
              const gy = ot*ot*src.y + 2*ot*tt*cpy + tt*tt*tgt.y;
              const [wx,wy] = graphToWorld(gx, gy);
              pPos[vi*3]=wx; pPos[vi*3+1]=wy; pPos[vi*3+2]=0;
              pCol[vi*3]=_pairC.r; pCol[vi*3+1]=_pairC.g; pCol[vi*3+2]=_pairC.b;
              vi++;
            }
          }
        } else {
          const [sx,sy] = graphToWorld(src.x, src.y);
          const [tx,ty] = graphToWorld(tgt.x, tgt.y);
          pPos[vi*3]=sx; pPos[vi*3+1]=sy; pPos[vi*3+2]=0;
          pCol[vi*3]=_pairC.r; pCol[vi*3+1]=_pairC.g; pCol[vi*3+2]=_pairC.b; vi++;
          pPos[vi*3]=tx; pPos[vi*3+1]=ty; pPos[vi*3+2]=0;
          pCol[vi*3]=_pairC.r; pCol[vi*3+1]=_pairC.g; pCol[vi*3+2]=_pairC.b; vi++;
        }
      }
      pairLines.geometry.attributes.position.needsUpdate = true;
      pairLines.geometry.attributes.color.needsUpdate    = true;
      pairLines.geometry.setDrawRange(0, vi);
    }

    glRenderer.render(glScene, glCamera);
    drawOverlay();
  }

  function drawOverlay() {
    if (!graph) return;
    const ctx = _ovCtx;
    const dpr = window.devicePixelRatio || 1;
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const nodeR = 6 * glZoom;

    // Labels
    if (el("showLabels").checked) {
      const fs = Math.max(4, 7 * glZoom);
      ctx.font = `700 ${fs}px system-ui,Arial,sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillStyle = '#fff';
      for (const n of graph.nodes) {
        const [sx, sy] = worldToScreen(...graphToWorld(n.x, n.y));
        if (sx < -20 || sx > width + 20 || sy < -20 || sy > height + 20) continue;
        ctx.fillText(n.seq || String(n.id + 1), sx, sy);
      }
    }

    // Selection rings
    if (selectedNodes.size > 0) {
      const ringR = 6 * glZoom + 2.5;
      ctx.strokeStyle = '#f59e0b';
      ctx.lineWidth   = 2.5;
      ctx.shadowColor = '#f59e0b88';
      ctx.shadowBlur  = 6;
      for (const id of selectedNodes) {
        const n = graph.nodes[id];
        if (!n) continue;
        const [sx, sy] = worldToScreen(...graphToWorld(n.x, n.y));
        if (sx < -20 || sx > width + 20 || sy < -20 || sy > height + 20) continue;
        ctx.beginPath();
        ctx.arc(sx, sy, ringR, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.shadowBlur = 0;
    }

    // End markers (5′ / 3′)
    if (el("showEndMarkers").checked) {
      const OFFSET = 14;
      const fs = Math.max(6, 9 * glZoom);
      ctx.font = `700 ${fs}px system-ui,Arial,sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      graph.strandNodeIds.forEach((ids, si) => {
        if (!ids || !ids.length) return;
        ctx.fillStyle   = STRAND_COLORS[si % STRAND_COLORS.length];
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 3 * glZoom;
        for (const [nodeId, adjId, text] of [
          [ids[0],            ids.length > 1 ? ids[1]              : null, "5\u2032"],
          [ids[ids.length-1], ids.length > 1 ? ids[ids.length - 2] : null, "3\u2032"]
        ]) {
          const n = graph.nodes[nodeId];
          let mx = n.x, my = n.y;
          if (adjId != null) {
            const a = graph.nodes[adjId];
            const dx = n.x - a.x, dy = n.y - a.y, len = Math.hypot(dx, dy) || 1;
            mx += (dx / len) * OFFSET; my += (dy / len) * OFFSET;
          } else { my -= OFFSET; }
          const [sx, sy] = worldToScreen(...graphToWorld(mx, my));
          ctx.strokeText(text, sx, sy);
          ctx.fillText(text, sx, sy);
        }
      });
    }

    ctx.restore();
  }

  function disposeThreeObjects() {
    for (const obj of [nodeInstMesh, backboneLines, pairLines]) {
      if (!obj) continue;
      glScene.remove(obj);
      obj.geometry?.dispose();
      if (Array.isArray(obj.material)) obj.material.forEach(m => m.dispose());
      else obj.material?.dispose();
    }
    nodeInstMesh = backboneLines = pairLines = null;
  }

  function buildThreeObjects(graph) {
    disposeThreeObjects();
    const N  = graph.nodes.length;
    const BL = graph.backboneLinks.length;
    const PL = graph.pairLinks.length;
    const BEZIER_SEGS = 12;

    // Nodes
    const nGeo = new THREE.CircleGeometry(6, 16);
    const nMat = new THREE.MeshBasicMaterial({ vertexColors: true });
    nodeInstMesh = new THREE.InstancedMesh(nGeo, nMat, N);
    nodeInstMesh.frustumCulled = false;
    glScene.add(nodeInstMesh);

    // Backbone
    const bPos = new Float32Array(BL * 6);
    const bCol = new Float32Array(BL * 6);
    const bGeo = new THREE.BufferGeometry();
    bGeo.setAttribute('position', new THREE.BufferAttribute(bPos, 3).setUsage(THREE.DynamicDrawUsage));
    bGeo.setAttribute('color',    new THREE.BufferAttribute(bCol, 3).setUsage(THREE.DynamicDrawUsage));
    backboneLines = new THREE.LineSegments(bGeo, new THREE.LineBasicMaterial({ vertexColors: true }));
    backboneLines.frustumCulled = false;
    backboneLines.visible = el("showBackbone").checked;
    glScene.add(backboneLines);

    // Pairs — allocate for worst-case Bezier
    const segsPerPair = BEZIER_SEGS; // always allocate for linear mode
    const pPos = new Float32Array(PL * segsPerPair * 2 * 3);
    const pCol = new Float32Array(PL * segsPerPair * 2 * 3);
    const pGeo = new THREE.BufferGeometry();
    pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3).setUsage(THREE.DynamicDrawUsage));
    pGeo.setAttribute('color',    new THREE.BufferAttribute(pCol, 3).setUsage(THREE.DynamicDrawUsage));
    pairLines = new THREE.LineSegments(pGeo, new THREE.LineBasicMaterial({ vertexColors: true, opacity: 0.95, transparent: true }));
    pairLines.frustumCulled = false;
    pairLines.visible = el("showPairs").checked;
    glScene.add(pairLines);
  }

  function fitView() {
    if (!graph || !graph.nodes.length) return;
    const xs = graph.nodes.map(d => d.x), ys = graph.nodes.map(d => d.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const pad  = 60;
    const gw   = maxX - minX + 2 * pad, gh = maxY - minY + 2 * pad;
    const zoom = Math.min(30, 0.94 / Math.max(gw / width, gh / height));
    const [tpx, tpy] = graphToWorld((minX + maxX) / 2, (minY + maxY) / 2);
    animateCameraTo(tpx, tpy, zoom, 250);
  }

  function resetZoom() { animateCameraTo(0, 0, 1, 250); }

  // ─── SELECTION ─────────────────────────────────────────────────────────────

  function updateSelectionVisuals() {
    if (!nodeInstMesh || !graph) return;
    applyNodeColors();
    glRenderer.render(glScene, glCamera);
    drawOverlay();
  }

  // ─── CANVAS INTERACTION ───────────────────────────────────────────────────────

  function pickNode(wx, wy) {
    if (!graph) return null;
    const R2 = 7 ** 2; // node world-space radius = 6 (CircleGeometry), +1 margin
    let best = null, bestD = Infinity;
    for (const n of graph.nodes) {
      const [nwx, nwy] = graphToWorld(n.x, n.y);
      const d = (nwx-wx)**2 + (nwy-wy)**2;
      if (d < R2 && d < bestD) { best = n; bestD = d; }
    }
    return best;
  }

  let _isPanning = false, _panSX = 0, _panSY = 0, _panPX = 0, _panPY = 0;
  let _isDragging = false;

  _glCanvas.addEventListener("wheel", e => {
    e.preventDefault();
    const factor = e.deltaY > 0 ? 0.85 : 1 / 0.85;
    const [wx, wy] = screenToWorld(e.offsetX, e.offsetY);
    const nz = Math.max(0.03, Math.min(30, glZoom * factor));
    glPanX = wx - (wx - glPanX) * (glZoom / nz);
    glPanY = wy - (wy - glPanY) * (glZoom / nz);
    glZoom = nz;
    updateCamera();
    if (!liveSim) ticked();
    updateStatusZoom();
  }, { passive: false });

  _glCanvas.addEventListener("pointerdown", e => {
    if (e.button !== 0) return;
    wasDragged = false;
    const [wx, wy] = screenToWorld(e.offsetX, e.offsetY);
    const node = pickNode(wx, wy);
    if (node) {
      // Node drag
      _isDragging = true;
      const [gx, gy] = worldToGraph(wx, wy);
      const group = selectedNodes.has(node.id) ? [...selectedNodes] : [node.id];
      dragGroupStart = {
        initX: gx, initY: gy,
        positions: new Map(group.map(id => [id, { x: graph.nodes[id].x, y: graph.nodes[id].y }]))
      };
      for (const id of dragGroupStart.positions.keys()) {
        graph.nodes[id].fx = graph.nodes[id].x;
        graph.nodes[id].fy = graph.nodes[id].y;
      }
      if (liveSim) {
        liveSim.sim.alpha(Math.max(liveSim.sim.alpha(), 0.5));
        liveSim.pinnedVNodes.clear();
        for (const id of dragGroupStart.positions.keys()) {
          const si = liveSim.vg.stemOfNode.get(id);
          const vi = si !== undefined ? liveSim.vg.stemVN[si] : liveSim.vg.loopVN.get(id);
          if (vi !== undefined) {
            liveSim.pinnedVNodes.add(vi);
            liveSim.vg.vNodes[vi].fx = liveSim.vg.vNodes[vi].x;
            liveSim.vg.vNodes[vi].fy = liveSim.vg.vNodes[vi].y;
          }
        }
      } else if (simulation) {
        simulation.alphaTarget(0.18).restart();
      }
      _glCanvas.style.cursor = 'grabbing';
    } else {
      // Pan
      _isPanning = true;
      _panSX = e.offsetX; _panSY = e.offsetY;
      _panPX = glPanX;    _panPY = glPanY;
      _glCanvas.style.cursor = 'grabbing';
    }
    _glCanvas.setPointerCapture(e.pointerId);
  });

  _glCanvas.addEventListener("pointermove", e => {
    if (_isPanning) {
      const dx = e.offsetX - _panSX, dy = e.offsetY - _panSY;
      glPanX = _panPX - dx / glZoom;
      glPanY = _panPY + dy / glZoom;
      updateCamera();
      ticked();
      return;
    }
    if (_isDragging && dragGroupStart) {
      wasDragged = true;
      const [gx, gy] = screenToGraph(e.offsetX, e.offsetY);
      const dx = gx - dragGroupStart.initX, dy = gy - dragGroupStart.initY;
      for (const [id, pos] of dragGroupStart.positions) {
        graph.nodes[id].fx = pos.x + dx;
        graph.nodes[id].fy = pos.y + dy;
        graph.nodes[id].x  = graph.nodes[id].fx;
        graph.nodes[id].y  = graph.nodes[id].fy;
      }
      if (liveSim) {
        for (const vi of liveSim.pinnedVNodes) {
          const vn = liveSim.vg.vNodes[vi];
          if (vn.isStem) {
            const stem = graph.stems[vn.stemIndex];
            let cx = 0, cy = 0;
            for (const p of stem) { cx += graph.nodes[p.a].x + graph.nodes[p.b].x; cy += graph.nodes[p.a].y + graph.nodes[p.b].y; }
            vn.fx = cx / (stem.length * 2); vn.fy = cy / (stem.length * 2);
          } else {
            vn.fx = graph.nodes[vn.nodeId].x; vn.fy = graph.nodes[vn.nodeId].y;
          }
        }
      }
      ticked();
    }
  });

  _glCanvas.addEventListener("pointerup", e => {
    if (_isPanning) { _isPanning = false; _glCanvas.style.cursor = 'grab'; }
    if (_isDragging) {
      _isDragging = false;
      _glCanvas.style.cursor = 'grab';
      if (dragGroupStart) {
        for (const id of dragGroupStart.positions.keys()) {
          graph.nodes[id].fx = null; graph.nodes[id].fy = null;
        }
        if (liveSim) {
          for (const vi of liveSim.pinnedVNodes) {
            liveSim.vg.vNodes[vi].fx = null; liveSim.vg.vNodes[vi].fy = null;
          }
          liveSim.pinnedVNodes.clear();
        } else if (simulation) {
          simulation.alphaTarget(0);
        }
        dragGroupStart = null;
      }
    }
    _glCanvas.releasePointerCapture(e.pointerId);
  });

  _glCanvas.addEventListener("click", e => {
    if (wasDragged) { wasDragged = false; return; }
    const [wx, wy] = screenToWorld(e.offsetX, e.offsetY);
    const node = pickNode(wx, wy);
    if (!node) {
      if (!e.shiftKey) { selectedNodes.clear(); updateSelectionVisuals(); }
      return;
    }
    const scope = el("selectScope").value;
    let ids = [node.id];
    if (scope === 'stem') {
      const si = features ? features.nodeToStem.get(node.id) : undefined;
      if (si !== undefined) ids = graph.stems[si].flatMap(p => [p.a, p.b]);
    } else if (scope === 'loop') {
      const li = features ? features.nodeToLoop.get(node.id) : undefined;
      if (li !== undefined) ids = features.loops[li].nodeIds.slice();
    } else if (scope === 'strand') {
      ids = graph.strandNodeIds[node.strand] || ids;
    }
    if (!e.shiftKey) selectedNodes.clear();
    for (const id of ids) {
      if (e.shiftKey && selectedNodes.has(id)) selectedNodes.delete(id);
      else selectedNodes.add(id);
    }
    updateSelectionVisuals();
  });

  // ─── STEM RIGIDITY ───────────────────────────────────────────────────────

  function buildStemRigidConfigs(stems, nodes) {
    return stems.map(stem => {
      const len = stem.length;
      if (!len) return { pairDist: 16, backboneDist: 16 };

      let sumPair = 0;
      for (const p of stem)
        sumPair += Math.hypot(nodes[p.b].x - nodes[p.a].x, nodes[p.b].y - nodes[p.a].y);

      let sumBack = 0, nBack = 0;
      for (let i = 1; i < len; i++) {
        const m0x = (nodes[stem[i-1].a].x + nodes[stem[i-1].b].x) / 2;
        const m0y = (nodes[stem[i-1].a].y + nodes[stem[i-1].b].y) / 2;
        const m1x = (nodes[stem[i].a].x + nodes[stem[i].b].x) / 2;
        const m1y = (nodes[stem[i].a].y + nodes[stem[i].b].y) / 2;
        sumBack += Math.hypot(m1x - m0x, m1y - m0y);
        nBack++;
      }
      return {
        pairDist: sumPair / len,
        backboneDist: nBack > 0 ? sumBack / nBack : sumPair / len
      };
    });
  }

  function enforceStemRigidity(stems, nodes, configs) {
    stems.forEach((stem, si) => {
      const len = stem.length;
      if (!len) return;
      const { pairDist, backboneDist } = configs[si];

      let cx = 0, cy = 0;
      for (const p of stem) { cx += nodes[p.a].x + nodes[p.b].x; cy += nodes[p.a].y + nodes[p.b].y; }
      cx /= len * 2; cy /= len * 2;

      const m0x = (nodes[stem[0].a].x + nodes[stem[0].b].x) / 2;
      const m0y = (nodes[stem[0].a].y + nodes[stem[0].b].y) / 2;
      const mNx = (nodes[stem[len-1].a].x + nodes[stem[len-1].b].x) / 2;
      const mNy = (nodes[stem[len-1].a].y + nodes[stem[len-1].b].y) / 2;
      let dx = mNx - m0x, dy = mNy - m0y;
      const axLen = Math.hypot(dx, dy);

      if (axLen < 1e-6) {
        let pdx = 0, pdy = 0;
        for (const p of stem) { pdx += nodes[p.b].x - nodes[p.a].x; pdy += nodes[p.b].y - nodes[p.a].y; }
        const pl = Math.hypot(pdx, pdy) || 1;
        dx = -pdy / pl; dy = pdx / pl;
      } else { dx /= axLen; dy /= axLen; }

      let dot = 0;
      for (const p of stem)
        dot += (nodes[p.b].x - nodes[p.a].x) * (-dy) + (nodes[p.b].y - nodes[p.a].y) * dx;
      const s = dot >= 0 ? 1 : -1;
      const pX = -dy * s, pY = dx * s;

      stem.forEach((p, i) => {
        const along = (i - (len - 1) / 2) * backboneDist;
        const midX = cx + along * dx, midY = cy + along * dy;
        nodes[p.a].x = midX - pairDist / 2 * pX;  nodes[p.a].y = midY - pairDist / 2 * pY;
        nodes[p.b].x = midX + pairDist / 2 * pX;  nodes[p.b].y = midY + pairDist / 2 * pY;
      });
    });
  }

  // ─── RADIAL RIGID-BODY REFINEMENT ────────────────────────────────────────

  function buildStemVirtualGraph(graph) {
    const nodes = graph.nodes;
    const stems = graph.stems;
    const BD = getBaseSpacing();
    const PD = BD * 1.1;

    const stemOfNode = new Map();
    stems.forEach((stem, si) => {
      for (const p of stem) { stemOfNode.set(p.a, si); stemOfNode.set(p.b, si); }
    });

    const vNodes = [];

    const stemVN = [];
    stems.forEach((stem, si) => {
      let cx = 0, cy = 0, count = 0;
      for (const p of stem) {
        cx += nodes[p.a].x + nodes[p.b].x;
        cy += nodes[p.a].y + nodes[p.b].y;
        count += 2;
      }
      stemVN[si] = vNodes.length;
      const halfLen = stem.length * BD / 2;
      vNodes.push({ x: cx / count, y: cy / count, vx: 0, vy: 0,
                    isStem: true, stemIndex: si,
                    cr: Math.hypot(halfLen, PD / 2) + BD * 0.8 });
    });

    const loopVN = new Map();
    nodes.forEach((node, id) => {
      if (!stemOfNode.has(id)) {
        loopVN.set(id, vNodes.length);
        vNodes.push({ x: node.x, y: node.y, vx: 0, vy: 0,
                      isStem: false, nodeId: id, cr: BD * 0.55 });
      }
    });

    const seen = new Set();
    const vLinks = [];
    const stemConns = stems.map(() => []);
    for (const link of graph.backboneLinks) {
      const u = typeof link.source === 'number' ? link.source : link.source.id;
      const v = typeof link.target === 'number' ? link.target : link.target.id;
      const su = stemOfNode.get(u), sv = stemOfNode.get(v);
      if (su !== undefined && su !== sv) stemConns[su].push({ stemNodeId: u, otherNodeId: v });
      if (sv !== undefined && sv !== su) stemConns[sv].push({ stemNodeId: v, otherNodeId: u });
      const vu = su !== undefined ? stemVN[su] : loopVN.get(u);
      const vv = sv !== undefined ? stemVN[sv] : loopVN.get(v);
      if (vu === undefined || vv === undefined || vu === vv) continue;
      const key = vu < vv ? `${vu}:${vv}` : `${vv}:${vu}`;
      if (seen.has(key)) continue;
      seen.add(key);
      vLinks.push({ source: vu, target: vv });
    }

    return { vNodes, vLinks, stemVN, loopVN, stemConns, stemOfNode,
             prevX: stemVN.map(vi => vNodes[vi].x),
             prevY: stemVN.map(vi => vNodes[vi].y) };
  }

  function syncVirtualTick(vg, configs, omega) {
    graph.stems.forEach((stem, si) => {
      const vn = vg.vNodes[vg.stemVN[si]];
      const dx = vn.x - vg.prevX[si], dy = vn.y - vg.prevY[si];
      for (const p of stem) {
        graph.nodes[p.a].x += dx; graph.nodes[p.a].y += dy;
        graph.nodes[p.b].x += dx; graph.nodes[p.b].y += dy;
      }
    });
    vg.loopVN.forEach((vi, nodeId) => {
      graph.nodes[nodeId].x = vg.vNodes[vi].x;
      graph.nodes[nodeId].y = vg.vNodes[vi].y;
    });
    graph.stems.forEach((stem, si) => {
      const conns = vg.stemConns[si];
      if (!conns.length) return;
      let cx = 0, cy = 0;
      for (const p of stem) {
        cx += graph.nodes[p.a].x + graph.nodes[p.b].x;
        cy += graph.nodes[p.a].y + graph.nodes[p.b].y;
      }
      cx /= stem.length * 2; cy /= stem.length * 2;
      let moi = 0;
      for (const p of stem) {
        const dxa = graph.nodes[p.a].x - cx, dya = graph.nodes[p.a].y - cy;
        const dxb = graph.nodes[p.b].x - cx, dyb = graph.nodes[p.b].y - cy;
        moi += dxa * dxa + dya * dya + dxb * dxb + dyb * dyb;
      }
      moi = Math.max(moi, 1);
      let torque = 0;
      for (const c of conns) {
        const sn = graph.nodes[c.stemNodeId], on = graph.nodes[c.otherNodeId];
        const rx = sn.x - cx, ry = sn.y - cy;
        const fx = on.x - sn.x, fy = on.y - sn.y;
        torque += rx * fy - ry * fx;
      }
      omega[si] += torque * 0.0025 / moi;
      omega[si] *= 0.82;
      const angle = omega[si];
      if (Math.abs(angle) > 1e-9) {
        const cosA = Math.cos(angle), sinA = Math.sin(angle);
        for (const p of stem) {
          for (const id of [p.a, p.b]) {
            const dx = graph.nodes[id].x - cx, dy = graph.nodes[id].y - cy;
            graph.nodes[id].x = cx + dx * cosA - dy * sinA;
            graph.nodes[id].y = cy + dx * sinA + dy * cosA;
          }
        }
      }
    });
    enforceStemRigidity(graph.stems, graph.nodes, configs);
    graph.stems.forEach((stem, si) => {
      let cx = 0, cy = 0;
      for (const p of stem) {
        cx += graph.nodes[p.a].x + graph.nodes[p.b].x;
        cy += graph.nodes[p.a].y + graph.nodes[p.b].y;
      }
      cx /= stem.length * 2; cy /= stem.length * 2;
      const vn = vg.vNodes[vg.stemVN[si]];
      vn.x = cx; vn.y = cy;
      vg.prevX[si] = cx; vg.prevY[si] = cy;
    });
  }

  async function relaxRadial(jobId) {
    const ticks = Math.max(0, +el("radialTicks").value || 350);
    if (!ticks) return;
    setProgress("busy", "Radial polish", 35, "Rigid-body overlap removal…");

    const BD      = getBaseSpacing();
    const charge  = +el("radialCharge").value        || -55;
    const aDecay  = +el("radialAlphaDecay").value    || 0.018;
    const vDecay  = +el("radialVelocityDecay").value || 0.42;
    const bStr    = +el("radialBackboneStr").value   || 0.88;
    const chunk   = Math.max(1, +el("chunkSize").value || 40);

    const vg = buildStemVirtualGraph(graph);

    const sim = d3.forceSimulation(vg.vNodes)
      .alpha(0.85).alphaDecay(aDecay).velocityDecay(vDecay)
      .force("charge",    d3.forceManyBody().strength(charge))
      .force("collision", d3.forceCollide(d => d.cr).strength(0.85))
      .force("backbone",  d3.forceLink(vg.vLinks).distance(BD * 1.5).strength(bStr))
      .force("center",    d3.forceCenter(width / 2, height / 2).strength(0.03))
      .stop();

    simulation = sim;
    const rigidConfigs = buildStemRigidConfigs(graph.stems, graph.nodes);
    const omega = graph.stems.map(() => 0);

    let done = 0;
    while (done < ticks) {
      if (jobId !== currentJobId || cancelRequested) throw new Error("Operation cancelled.");
      const n = Math.min(chunk, ticks - done);

      for (let i = 0; i < n; i++) {
        sim.tick();
        syncVirtualTick(vg, rigidConfigs, omega);
      }

      done += n;
      ticked();
      setProgress("busy", "Radial polish", 35 + 60 * done / ticks,
                  `${done}/${ticks} ticks  α=${sim.alpha().toFixed(3)}`);
      await new Promise(requestAnimationFrame);
    }

    sim.alpha(0); ticked();
  }

  function animateTransition(nodes, targetPos, duration, jobId) {
    return new Promise(resolve => {
      const startTime = performance.now();
      const startPos = nodes.map(n => ({ x: n.x, y: n.y }));
      function step(now) {
        if (jobId !== currentJobId) { resolve(); return; }
        const t = Math.min((now - startTime) / duration, 1);
        const e = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
        nodes.forEach((n, i) => {
          n.x = startPos[i].x + (targetPos[i].x - startPos[i].x) * e;
          n.y = startPos[i].y + (targetPos[i].y - startPos[i].y) * e;
        });
        ticked();
        if (t < 1) requestAnimationFrame(step); else resolve();
      }
      requestAnimationFrame(step);
    });
  }

  // ─── HIGH-LEVEL ACTIONS ───────────────────────────────────────────────────

  async function relayoutGraph() {
    if (!graph) return;
    const jobId = ++currentJobId;
    cancelRequested = false;
    stopLiveSim();
    if (simulation) simulation.stop();
    setBusy(true);
    setProgress("busy", "Layout", 10, "Computing target positions…");
    try {
      const newMode = getLayoutMode();
      const oldPos = graph.nodes.map(n => ({ x: n.x, y: n.y }));

      if (newMode === 'circular') layoutCircular(graph);
      else if (newMode === 'linear') layoutLinear(graph);
      else if (newMode === 'radial') layoutRadialFromHints(graph);
      const targetPos = graph.nodes.map(n => ({ x: n.x, y: n.y }));

      graph.nodes.forEach((n, i) => { n.x = oldPos[i].x; n.y = oldPos[i].y; });
      setProgress("busy", "Layout", 40, `Animating to ${newMode} layout…`);
      await animateTransition(graph.nodes, targetPos, 420, jobId);

      if (newMode === 'radial' && el("radialAutoPolish").checked) {
        if (jobId !== currentJobId || cancelRequested) return;
        await relaxRadial(jobId);
      }

      if (jobId !== currentJobId || cancelRequested) return;
      if (el("autoFit").checked) fitView(); else centerView();
      setProgress("ok", "Layout applied", 100, `${newMode} layout.`);
      if (el("continuousSim").checked) startLiveSim();
    } catch (err) {
      if (err.message !== "Operation cancelled.")
        setProgress("error", "Layout failed", 100, "", String(err.message || err));
    } finally { setBusy(false); }
  }

  async function importText() {
    const jobId = ++currentJobId;
    cancelRequested = false;
    setBusy(true);
    setProgress("busy", "Importing", 5, "Reading input...");
    try {
      const text = el("inputText").value.trim();
      let format = el("importFormat").value;
      await new Promise(requestAnimationFrame);
      if (!text) throw new Error("Input is empty.");
      if (format === "auto") {
        setProgress("busy", "Importing", 15, "Detecting format...");
        format = autoDetectFormat(text);
      }

      let parsed = emptyModel();
      setProgress("busy", "Importing", 30, `Parsing as ${format}...`);
      if (format === "fasta") parsed = parseFASTA(text);
      else if (format === "seq") parsed = parseSEQ(text);
      else if (format === "ct") parsed = parseCT(text, parseInt(el("ctIndex").value || "1", 10));
      else if (format === "raw-structure") parsed = parseRawStructure(text);
      else parsed = parseDBN(text);

      if (jobId !== currentJobId || cancelRequested) throw new Error("Operation cancelled.");

      model = { ...emptyModel(), ...parsed, notes:[...(parsed.notes || [])] };
      if (model.sequenceStrands.length) el("sequenceText").value = model.sequenceStrands.join("+");
      if (model.structure) el("structureText").value = model.structure;
      else if (model.sequenceStrands.length) el("structureText").value = model.sequenceStrands.map(s => ".".repeat(s.length)).join("+");

      updateStats();
      setProgress("ok", "Import complete", 100, `Loaded format: ${format}`);
      // Close input panel and render immediately
      document.querySelectorAll(".panel").forEach(p => p.classList.remove("open"));
      el("tbInput").classList.remove("active");
      el("tbSettings").classList.remove("active");
      setBusy(false);
      await renderGraph();
      return;
    } catch (err) {
      setProgress("error", "Import failed", 100, "Import aborted.", String(err.message || err));
    } finally { setBusy(false); }
  }

  async function renderGraph() {
    const jobId = ++currentJobId;
    cancelRequested = false;
    setBusy(true);
    setProgress("busy", "Preparing", 5, "Normalizing model...");
    try {
      model.notes = [];
      normalizeModel();
      const sequencePlus = model.sequenceStrands.join("+");
      const structurePlus = model.structure || model.sequenceStrands.map(s => ".".repeat(s.length)).join("+");
      el("sequenceText").value = sequencePlus;
      el("structureText").value = structurePlus;

      stopLiveSim();
      if (simulation) simulation.stop();

      setProgress("busy", "Preparing", 18, "Parsing structure...");
      graph = parseDotBracketPlus(sequencePlus, structurePlus);
      classification = null;

      const layoutMode = getLayoutMode();
      setProgress("busy", "Preparing", 28, `Applying ${layoutMode} layout...`);
      if (layoutMode === 'circular') {
        layoutCircular(graph);
      } else if (layoutMode === 'linear') {
        layoutLinear(graph);
      } else if (layoutMode === 'radial') {
        layoutRadial(graph);
      }
      if (el("alignCanonical").checked) alignCanonical(graph);

      // Structural classification (RiboGraphViz-style) — needed for coloring + stats
      features = buildStructuralFeatures(graph);
      classification = classifyStructure(graph);

      buildThreeObjects(graph);
      ticked();

      updateStats();
      selectedNodes.clear();
      updateSelectionVisuals();
      if (layoutMode === 'radial' && el("radialAutoPolish").checked) {
        await relaxRadial(jobId);
        if (jobId !== currentJobId || cancelRequested) throw new Error("Operation cancelled.");
      }
      if (el("autoFit").checked) fitView(); else centerView();
      setProgress("ok", "Render complete", 100, `Finished.\nNodes ${graph.nodes.length}, pairs ${graph.pairLinks.length}`);
      if (el("continuousSim").checked) startLiveSim();
    } catch (err) {
      setProgress("error", "Render failed", 100, "Rendering aborted.", String(err.message || err));
    } finally { setBusy(false); }
  }

  async function relaxAgain() {
    if (!graph) return;
    stopLiveSim();
    const jobId = ++currentJobId;
    cancelRequested = false;
    setBusy(true);
    try {
      await relaxRadial(jobId);
      centerView();
      setProgress("ok", "Relax complete", 100, "Additional relaxation complete.");
      if (el("continuousSim").checked) startLiveSim();
    } catch (err) {
      setProgress("error", "Relax failed", 100, "Relaxation aborted.", String(err.message || err));
    } finally { setBusy(false); }
  }

  function updateStats() {
    const seqLen = model.sequenceStrands.reduce((a, s) => a + s.length, 0);
    const lines = [
      `format: ${model.importedFormat || "manual"}`,
      `title: ${model.title || "-"}`,
      `bases: ${seqLen}`,
      `strands: ${model.sequenceStrands.length}`,
      `pairs: ${graph ? graph.pairLinks.length : 0}`
    ];
    if (classification) {
      lines.push(`stems: ${graph.stems.length}   MLD: ${classification.mld}`);
      lines.push(`hairpins: ${classification.hairpins}   internal loops: ${classification.internalLoops}`);
      const jKeys = Object.keys(classification.junctions).sort((a, b) => +a - +b);
      if (jKeys.length) {
        lines.push("junctions: " + jKeys.map(n => `${n}-way ×${classification.junctions[n]}`).join("   "));
      }
    }
    if (graph?.errors.length) lines.push("errors:\n- " + graph.errors.join("\n- "));
    if (model.notes.length) lines.push("notes:\n- " + model.notes.join("\n- "));
    el("stats").textContent = lines.join("\n");
  }

  // ─── CONTINUOUS SIMULATION ────────────────────────────────────────────────

  function startLiveSim() {
    stopLiveSim();
    if (!graph || !graph.stems.length) return;
    const BD     = getBaseSpacing();
    const charge = +el("radialCharge").value        || -55;
    const vDecay = +el("radialVelocityDecay").value || 0.42;
    const bStr   = +el("radialBackboneStr").value   || 0.88;
    const vg      = buildStemVirtualGraph(graph);
    const configs = buildStemRigidConfigs(graph.stems, graph.nodes);
    const omega   = graph.stems.map(() => 0);
    const sim = d3.forceSimulation(vg.vNodes)
      .alpha(0.3).alphaDecay(0.008).alphaTarget(0.04).velocityDecay(vDecay)
      .force("charge",    d3.forceManyBody().strength(charge))
      .force("collision", d3.forceCollide(d => d.cr).strength(0.85))
      .force("backbone",  d3.forceLink(vg.vLinks).distance(BD * 1.5).strength(bStr))
      .force("center",    d3.forceCenter(width / 2, height / 2).strength(0.02))
      .stop();
    simulation = sim;
    liveSim = { vg, sim, configs, omega, rafId: null, pinnedVNodes: new Set() };
    setProgress("busy", "Continuous", 50, "Live simulation running\u2026");
    function loop() {
      if (!liveSim) return;
      liveSim.sim.tick();
      syncVirtualTick(liveSim.vg, liveSim.configs, liveSim.omega);
      ticked();
      liveSim.rafId = requestAnimationFrame(loop);
    }
    liveSim.rafId = requestAnimationFrame(loop);
  }

  function stopLiveSim() {
    if (!liveSim) return;
    if (liveSim.rafId) cancelAnimationFrame(liveSim.rafId);
    liveSim.sim.stop();
    liveSim = null;
    simulation = null;
  }

  // ─── EVENT WIRING ────────────────────────────────────────────────────────

  el("cancelBtn").addEventListener("click", () => {
    cancelRequested = true;
    currentJobId += 1;
    stopLiveSim();
    el("continuousSim").checked = false;
    if (simulation) simulation.stop();
    setProgress("error", "Cancelled", 100, "Operation cancelled by user.");
    setBusy(false);
  });

  el("importBtn").addEventListener("click", importText);
  el("renderBtn").addEventListener("click", renderGraph);
  el("relaxBtn").addEventListener("click", relaxAgain);
  el("fitBtn").addEventListener("click", fitView);
  el("resetBtn").addEventListener("click", resetZoom);

  el("layoutMode").addEventListener("change", () => {
    el("radialDetails").style.display = getLayoutMode() === 'radial' ? null : "none";
    if (graph) relayoutGraph();
  });

  el("clearSelBtn").addEventListener("click", () => { selectedNodes.clear(); updateSelectionVisuals(); });

  el("showLabels").addEventListener("change",     () => { if (graph) ticked(); });
  el("showPairs").addEventListener("change",      () => { if (pairLines)     { pairLines.visible     = el("showPairs").checked;     glRenderer.render(glScene, glCamera); } });
  el("showBackbone").addEventListener("change",   () => { if (backboneLines) { backboneLines.visible  = el("showBackbone").checked;  glRenderer.render(glScene, glCamera); } });
  el("showEndMarkers").addEventListener("change", () => { if (graph) drawOverlay(); });
  el("colorByElement").addEventListener("change", () => {
    el("elementLegend").style.display = el("colorByElement").checked ? "" : "none";
    if (graph) { applyNodeColors(); glRenderer.render(glScene, glCamera); drawOverlay(); }
  });

  el("continuousSim").addEventListener("change", () => {
    if (el("continuousSim").checked) startLiveSim();
    else { stopLiveSim(); setProgress("ok", "Stopped", 100, "Continuous simulation stopped."); }
    el("tbLive").classList.toggle("active", el("continuousSim").checked);
  });
  el("inputText").value = `>tRNA-like example (multi-branch loop)
GCGGAUUUAGCUCAGUUGGGAGAGCGCCAGACUGAAGAUCUGGAGGUCCUGUGUUCGAUCCACAGAAUUCGCACCA
(((((((..((((........)))).(((((.......))))).....(((((.......))))))))))))....`;
  { el("radialDetails").style.display = getLayoutMode() === 'radial' ? null : "none"; }
  setProgress("idle", "Status", 0, "Ready.");

  // ─── TOOLBAR PANEL & BUTTON WIRING ────────────────────────────────────────

  function togglePanel(panelId, btnId) {
    const panel = el(panelId);
    const isOpen = panel.classList.contains("open");
    document.querySelectorAll(".panel").forEach(p => p.classList.remove("open"));
    el("tbInput").classList.remove("active");
    el("tbSettings").classList.remove("active");
    if (!isOpen) {
      panel.classList.add("open");
      el(btnId).classList.add("active");
    }
  }

  el("tbInput").addEventListener("click", () => togglePanel("inputPanel", "tbInput"));
  el("tbSettings").addEventListener("click", () => togglePanel("settingsPanel", "tbSettings"));

  document.addEventListener("click", e => {
    if (!e.target.closest(".panel") && !e.target.closest(".toolbar")) {
      document.querySelectorAll(".panel").forEach(p => p.classList.remove("open"));
      el("tbInput").classList.remove("active");
      el("tbSettings").classList.remove("active");
    }
  });

  const layoutModes = ["radial", "circular", "linear"];
  const layoutLabels = { radial: "Radial", circular: "Circular", linear: "Linear" };
  el("tbLayout").addEventListener("click", () => {
    const cur = el("layoutMode").value;
    const next = layoutModes[(layoutModes.indexOf(cur) + 1) % layoutModes.length];
    el("layoutMode").value = next;
    el("layoutMode").dispatchEvent(new Event("change"));
    el("tbLayout").title = `Layout: ${layoutLabels[next]}`;
  });
  el("layoutMode").addEventListener("change", () => {
    el("tbLayout").title = `Layout: ${layoutLabels[el("layoutMode").value] || el("layoutMode").value}`;
  });

  el("tbLive").addEventListener("click", () => {
    const cb = el("continuousSim");
    cb.checked = !cb.checked;
    cb.dispatchEvent(new Event("change"));
  });

  el("cancelBtn").addEventListener("click", () => {
    el("tbLive").classList.remove("active");
  });

  // ─── URL parameters ────────────────────────────────────────────────────────
  {
    const params = new URLSearchParams(location.search);
    const layoutParam = params.get("layout");
    if (layoutParam && ["radial","circular","linear"].includes(layoutParam)) {
      el("layoutMode").value = layoutParam;
      el("layoutMode").dispatchEvent(new Event("change"));
    }
  }

  // ─── Keyboard shortcuts ────────────────────────────────────────────────────
  document.addEventListener("keydown", e => {
    // Ignore when focus is inside a text input or textarea
    if (e.target.matches("input, textarea, select")) return;
    if (e.key === "m" || e.key === "M") {
      document.body.classList.toggle("ui-hidden");
    } else if (e.key === "1") {
      el("selectScope").value = "node";
    } else if (e.key === "2") {
      el("selectScope").value = "stem";
    } else if (e.key === "3") {
      el("selectScope").value = "loop";
    }
  });

  // Hide UI by default when embedded in an iframe
  if (window.self !== window.top) {
    document.body.classList.add("ui-hidden");
  }

  // ─── Drag-and-drop file loading ────────────────────────────────────────────
  const dropOverlay = el("dropOverlay");
  let dragCounter = 0; // track nested dragenter/dragleave pairs

  document.addEventListener("dragenter", e => {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    if (++dragCounter === 1) dropOverlay.classList.add("active");
  });
  document.addEventListener("dragover", e => {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
  });
  document.addEventListener("dragleave", e => {
    if (--dragCounter <= 0) { dragCounter = 0; dropOverlay.classList.remove("active"); }
  });
  document.addEventListener("drop", e => {
    e.preventDefault();
    dragCounter = 0;
    dropOverlay.classList.remove("active");
    const file = e.dataTransfer.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      el("inputText").value = ev.target.result;
      importText();
    };
    reader.readAsText(file);
  });
})();
