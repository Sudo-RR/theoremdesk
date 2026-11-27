# Building the manuscript

TheoremDesk edits and previews LaTeX with LaTeX Workshop, which needs a TeX distribution:

- **Windows:** MiKTeX. The Environment view installs it with winget.
- **macOS:** MacTeX
- **Linux:** TeX Live from your package manager

Restart TheoremDesk after installing, then open `manuscript/main.tex` and run **Build Manuscript**. Projects use the `pdflatex -> bibtex -> pdflatex * 2` recipe, so you don't need Perl or `latexmk`. MiKTeX may ask to install missing LaTeX packages the first time.

Equations and figures come from the notebooks. Until you run them, the paper shows a note saying which notebook to run.
