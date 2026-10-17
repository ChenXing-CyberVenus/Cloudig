"""Outline the accepted Reader slogan; build-time only, never a runtime font dependency.

Optional tooling: pip install --target artifacts/tooling/font-outline 'fonttools[woff]' uharfbuzz
Run with --check to compare without writing. The source WOFF2/OFL stay unchanged.
"""
import argparse
import hashlib
import io
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "artifacts/tooling/font-outline"))
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
import uharfbuzz as hb

SOURCE = ROOT / "src/ui/shell/fonts/bodoni-moda"
OUTPUT = ROOT / "src/ui/assets/reader/Reader-Welcome-Home-English.svg"
LINES = ("Welcome Home,", "OUR Clouds.")
SIZE, WIDTH, LINE_HEIGHT = 56, 480, 56 * 1.22


def build():
    source = json.loads((SOURCE / "source.json").read_text(encoding="utf-8"))
    raw = (SOURCE / source["file"]).read_bytes()
    assert hashlib.sha256(raw).hexdigest() == source["sha256"]
    font = TTFont(io.BytesIO(raw))
    font.flavor = None
    sfnt = io.BytesIO()
    font.save(sfnt)
    face = hb.Face(sfnt.getvalue())
    shaped = hb.Font(face)
    shaped.scale = (face.upem, face.upem)
    glyphs = font.getGlyphSet()
    scale = SIZE / face.upem
    metrics = font["hhea"]
    baseline = (LINE_HEIGHT - (metrics.ascent - metrics.descent) * scale) / 2 + metrics.ascent * scale
    paths = []
    for row, text in enumerate(LINES):
        buf = hb.Buffer()
        buf.add_str(text)
        buf.guess_segment_properties()
        hb.shape(shaped, buf)
        advance = sum(p.x_advance for p in buf.glyph_positions) * scale
        assert 0 < advance < WIDTH - 2
        x = (WIDTH - advance) / 2
        pen = SVGPathPen(glyphs, ntos=lambda n: f"{n:.4f}".rstrip("0").rstrip(".") if n else "0")
        for info, pos in zip(buf.glyph_infos, buf.glyph_positions):
            transformed = TransformPen(pen, (scale, 0, 0, -scale, x + pos.x_offset * scale, baseline + row * LINE_HEIGHT - pos.y_offset * scale))
            glyphs[font.getGlyphName(info.codepoint)].draw(transformed)
            x += pos.x_advance * scale
        paths.append(f'    <path data-line="{row + 1}" d="{pen.getCommands()}"/>')
    return '\n'.join([
        '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="136.64" viewBox="0 0 480 136.64" role="img" aria-labelledby="title">',
        '  <title id="title">Welcome Home, / OUR Clouds.</title>',
        '  <!-- Bodoni Moda Black 900, optical size 60, rendered at 56px. Outlined from the bundled OFL-1.1 source; see fonts/bodoni-moda/source.json and OFL.txt. -->',
        '  <g fill="#000" stroke="#000" stroke-width="0.4" stroke-linejoin="round">',
        *paths, '  </g>', '</svg>', ''
    ])


if __name__ == "__main__":
    args = argparse.ArgumentParser()
    args.add_argument("--check", action="store_true")
    options = args.parse_args()
    result = build().encode("utf-8")
    if options.check:
        assert OUTPUT.read_bytes() == result, "Reader welcome SVG differs from the source font"
    else:
        OUTPUT.write_bytes(result)
    print(json.dumps({"file": str(OUTPUT.relative_to(ROOT)), "bytes": len(result), "sha256": hashlib.sha256(result).hexdigest(), "check": options.check}))
