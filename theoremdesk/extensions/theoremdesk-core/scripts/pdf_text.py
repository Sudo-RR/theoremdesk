"""Print the text of a PDF, page by page, as JSON: {"pages": [...]}.

Used by the literature database (src/library.ts) with TheoremDesk's bundled
Python, which includes pypdf. Run isolated (python -I) on downloaded files.
"""

import json
import sys


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: pdf_text.py <file.pdf>", file=sys.stderr)
        return 2
    try:
        from pypdf import PdfReader
    except ImportError:
        print("pypdf is not installed in this Python", file=sys.stderr)
        return 3
    try:
        reader = PdfReader(sys.argv[1])
        if reader.is_encrypted:
            reader.decrypt("")  # many papers are "encrypted" with an empty password
        pages = []
        for page in reader.pages:
            try:
                pages.append(page.extract_text() or "")
            except Exception:  # one bad page shouldn't lose the paper
                pages.append("")
    except Exception as error:
        print(f"couldn't read the PDF: {error}", file=sys.stderr)
        return 1
    # ASCII escapes: safe whatever the console encoding (Windows).
    json.dump({"pages": pages}, sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
