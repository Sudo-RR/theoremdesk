"""Generate a project from a TheoremDesk template, the way the app does.

Usage: python generate_template.py <template dir> <output dir> [NAME=value ...]

Fills {{NAME}} placeholders from template.json's variables and the given
values, and renames dot-* files to .*, like src/generator.ts.
"""

import json
import pathlib
import re
import sys

src, dst = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
manifest = json.loads((src / "template.json").read_text(encoding="utf-8"))
values = {
    **manifest.get("variables", {}),
    "PROJECT_NAME": dst.name,
    "PROJECT_TITLE": manifest.get("defaultTitle", dst.name),
}
for pair in sys.argv[3:]:
    key, _, value = pair.partition("=")
    values[key] = value

for path in src.rglob("*"):
    if path.is_dir() or path.relative_to(src) == pathlib.Path("template.json"):
        continue
    rel = path.relative_to(src)
    out = dst.joinpath(*[("." + p[4:]) if p.startswith("dot-") else p for p in rel.parts])
    out.parent.mkdir(parents=True, exist_ok=True)
    text = path.read_text(encoding="utf-8")
    out.write_text(
        re.sub(r"\{\{([A-Z_]+)\}\}", lambda m: values.get(m.group(1), m.group(0)), text),
        encoding="utf-8",
    )
