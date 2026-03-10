"""Jupyter notebook widget for DotBracketVibe."""

import html as _html
import json
import uuid
from pathlib import Path

try:
    from IPython.display import display
except ImportError:
    display = None

_PACKAGE_DIR = Path(__file__).resolve().parent
_REPO_DIR = _PACKAGE_DIR.parent


def _read_asset(name):
    """Read a static asset, trying repo root first, then package directory."""
    for base in [_REPO_DIR, _PACKAGE_DIR]:
        path = base / name
        if path.exists():
            return path.read_text(encoding="utf-8")
    raise FileNotFoundError(
        f"Asset '{name}' not found. "
        "Install with 'pip install -e .' from the repository root."
    )


def _extract_body(html_text):
    """Extract <body> inner content from index.html, excluding script tags."""
    start = html_text.index("<body>") + len("<body>")
    end = html_text.index("</body>")
    body = html_text[start:end]
    body = body.replace('<script src="app.js"></script>', "")
    return body.strip()


class Viewer:
    """Interactive RNA/DNA secondary structure viewer for Jupyter notebooks.

    Parameters
    ----------
    structure : str, optional
        Dot-bracket structure string (e.g. ``"(((...)))"``) or raw structure
        with ``+`` strand delimiters.
    sequence : str, optional
        Nucleotide sequence.  When given together with *structure*, a DBN-
        format input (``>title / sequence / structure``) is built
        automatically.
    text : str, optional
        Raw text input in any supported format (DBN, FASTA, SEQ, CT).
        Takes precedence over *structure* / *sequence*.
    format : str
        Import-format hint passed to the viewer's auto-detection:
        ``"auto"`` (default), ``"dbn"``, ``"fasta"``, ``"seq"``, ``"ct"``,
        or ``"raw-structure"``.
    layout : str
        Layout algorithm: ``"radial"`` (default), ``"circular"``, or
        ``"linear"``.
    width : int or str
        Widget width.  An ``int`` is pixels; a ``str`` (e.g. ``"100%"``)
        is used verbatim.  Default ``"100%"``.
    height : int
        Widget height in pixels.  Default ``500``.
    show_ui : bool
        Show the floating toolbar and panels.  Default ``False`` (clean
        visualisation suitable for notebooks).
    """

    def __init__(
        self,
        structure=None,
        sequence=None,
        *,
        text=None,
        format="auto",
        layout="radial",
        width="100%",
        height=500,
        show_ui=False,
    ):
        self.structure = structure
        self.sequence = sequence
        self.text = text
        self.format = format
        self.layout = layout
        self.width = width
        self.height = height
        self.show_ui = show_ui

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _input_text(self):
        """Build the viewer input text from the supplied parameters."""
        if self.text is not None:
            return self.text
        if self.structure is None:
            return ""
        if self.sequence:
            return f">structure\n{self.sequence}\n{self.structure}"
        return self.structure

    def _build_html(self):
        """Return a self-contained HTML document string for the viewer."""
        css = _read_asset("style.css")
        js = _read_asset("app.js")
        index_html = _read_asset("index.html")
        body = _extract_body(index_html)

        input_js = json.dumps(self._input_text())
        show_ui_js = "true" if self.show_ui else "false"
        layout_js = json.dumps(self.layout)
        format_js = json.dumps(self.format)

        # This script runs *after* the IIFE in app.js, so all DOM elements
        # and event handlers are already wired up.
        auto_script = (
            "(function(){"
            f"var t={input_js};"
            f"if({show_ui_js})document.body.classList.remove('ui-hidden');"
            "document.getElementById('autoFit').checked=true;"
            f"if({format_js}!=='auto')"
            f"document.getElementById('importFormat').value={format_js};"
            f"document.getElementById('layoutMode').value={layout_js};"
            "document.getElementById('layoutMode').dispatchEvent(new Event('change'));"
            "if(t){"
            "document.getElementById('inputText').value=t;"
            "document.getElementById('importBtn').click();"
            "}"
            "})();"
        )

        return (
            "<!DOCTYPE html>"
            '<html lang="en"><head><meta charset="UTF-8"/>'
            '<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/'
            'bootstrap-icons@1.11.3/font/bootstrap-icons.min.css">'
            f"<style>{css}</style>"
            '<script src="https://d3js.org/d3.v7.min.js"></script>'
            f"</head><body>{body}"
            f"<script>{js}</script>"
            f"<script>{auto_script}</script>"
            "</body></html>"
        )

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def _repr_html_(self):
        """Return an iframe HTML string for Jupyter rich display."""
        escaped = _html.escape(self._build_html(), quote=True)
        w = self.width if isinstance(self.width, str) else f"{self.width}px"
        uid = uuid.uuid4().hex[:8]
        return (
            f'<iframe id="dbv-{uid}" srcdoc="{escaped}" '
            f'width="{w}" height="{self.height}" '
            f'style="border:1px solid #ddd;border-radius:8px;" '
            f"allowfullscreen></iframe>"
        )

    def show(self):
        """Display the viewer in the current Jupyter notebook cell."""
        if display is None:
            raise ImportError(
                "IPython is required for notebook display. "
                "Install with: pip install ipython"
            )
        display(self)


def show(structure=None, sequence=None, **kwargs):
    """Display an RNA/DNA secondary structure in the current notebook cell.

    This is a convenience wrapper around :class:`Viewer`.  All keyword
    arguments are forwarded to the constructor.

    Examples
    --------
    >>> import dotbracketvibe as dbv
    >>> dbv.show("(((...)))")
    >>> dbv.show("(((...)))", sequence="ACGUACGUA", layout="circular")
    >>> dbv.show(text=">tRNA\\nACGU...\\n((..))")
    """
    viewer = Viewer(structure, sequence, **kwargs)
    viewer.show()
