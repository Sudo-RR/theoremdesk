"""Turn tests/local_ai.js's JSON into tab-separated lines for test_offline.sh:
<True|False> <TAB> <name> <TAB> <detail>

Usage: report_steps.py <result.json> <stderr file> <expected number of steps>
A missing or short result is reported as a failure: a test that stops
early must never look like a pass.
"""

import json
import sys

# Passages contain mathematics, which the Windows console code page can't print.
sys.stdout.reconfigure(encoding="utf-8")


def line(ok: bool, name: str, detail: str) -> None:
    print(f"{ok}\t{name}\t" + str(detail).replace("\t", " ").replace("\r", "").replace("\n", " | "))


def main() -> None:
    result_file, err_file, expected = sys.argv[1], sys.argv[2], int(sys.argv[3])
    try:
        with open(result_file, encoding="utf-8") as f:
            result = json.load(f)
    except Exception as error:
        try:
            with open(err_file, encoding="utf-8", errors="replace") as f:
                err = f.read()[-1500:]
        except OSError:
            err = ""
        line(False, "the local AI test runs", f"{error}: {err}")
        return
    steps = result.get("steps", [])
    for step in steps:
        line(bool(step.get("ok")), step.get("name", "?"), step.get("detail", ""))
    if len(steps) < expected:
        line(False, "all local AI checks ran", f"only {len(steps)} of {expected} reported")


if __name__ == "__main__":
    main()
