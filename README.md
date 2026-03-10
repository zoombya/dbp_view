# DotBracketVibe

A browser-based RNA/DNA secondary structure viewer. Paste a dot-bracket string and get an interactive 2D diagram — no server, no build step.

## Features

- **Multiple input formats** — dot-bracket (DBN), FASTA, SEQ, CT, or raw structure strings; auto-detection included
- **Three layout modes** — radial (default), circular, and linear/arc
- **Rigid-body refinement** — force-based overlap removal that preserves stem geometry, with configurable physics parameters
- **Continuous simulation** — optional always-on live physics for interactive exploration
- **Auto-centering** — camera gently tracks the structure centroid during simulation; fit-to-view after render
- **Multi-strand support** — strand breaks via `+` delimiter, per-strand coloring, 5′/3′ end markers
- **Selection** — click to select individual bases, stems, loops, or entire strands; shift-click to extend; drag to reposition
- **Pseudoknot support** — extended dot-bracket alphabet (`()`, `[]`, `{}`, `<>`, `Aa`–`Zz`)

## Quick Start

Open `index.html` in any modern browser. That's it.

The default input area is pre-loaded with a tRNA example. Click **Render** (▶) to visualize it, or paste your own structure.

## File Structure

```
index.html   — HTML shell: viewer, toolbar (Bootstrap Icons), panels
style.css    — All styles (layout, toolbar, panels, SVG classes)
app.js       — Application logic (parsing, layout, rendering, simulation)
```

External dependencies (loaded via CDN):
- [D3.js v7](https://d3js.org/) — SVG rendering and force simulation
- [Bootstrap Icons](https://icons.getbootstrap.com/) — toolbar icon font

## Supported Formats

| Format | Description |
|--------|-------------|
| **DBN** | `>title` / `sequence` / `structure` (3-line dot-bracket) |
| **Raw structure** | Bare dot-bracket string, e.g. `(((...)))` |
| **FASTA** | Standard FASTA (sequence only, no structure) |
| **SEQ** | Semicolon-header format |
| **CT** | Connect table (multi-structure files supported) |

## License

[MIT](LICENSE) © Michael Matthies
