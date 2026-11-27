"""Run every code cell of a Jupyter notebook in order, like Run All, without Jupyter.

Usage: python run_notebook.py <notebook.ipynb>

Runs in the notebook's folder. Set MPLBACKEND=Agg and PLOTLY_RENDERER=json to
keep figures off the screen.
"""

import json
import os
import sys

path = os.path.abspath(sys.argv[1])
os.chdir(os.path.dirname(path))
with open(path, encoding="utf-8") as f:
    cells = json.load(f)["cells"]

namespace = {"__name__": "__main__"}
for i, cell in enumerate(cells):
    if cell["cell_type"] != "code":
        continue
    source = "".join(cell["source"])
    try:
        exec(compile(source, f"{os.path.basename(path)}[cell {i}]", "exec"), namespace)
    except Exception:
        print(f"FAILED in cell {i}:\n{source}", file=sys.stderr)
        raise
print(f"ran {os.path.basename(path)}")
