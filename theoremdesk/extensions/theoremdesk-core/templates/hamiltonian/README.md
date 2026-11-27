# {{PROJECT_TITLE}}

A TheoremDesk research project: the simple harmonic oscillator and the nonlinear pendulum, from Hamiltonian to paper.

| Folder | What's in it |
|---|---|
| `notebooks/` | SymPy derivations and SciPy simulations. They write equations to `manuscript/generated/` and figures to `manuscript/figures/`. |
| `lean/` | A Lean 4 project on Physlib (`{{PHYSLIB_REV}}`) and Mathlib. |
| `manuscript/` | The paper. It includes whatever the notebooks last generated. |

## 1. Python

Run **Python: Create Environment** from the Command Palette, choose **Venv**, and tick `requirements.txt`. Then open `notebooks/01_oscillator.ipynb`, pick the `.venv` kernel, and **Run All**. Do the same for `02_pendulum.ipynb`.

## 2. Lean

You need elan (the walkthrough's **Install Lean** button installs it). In a terminal:

```bash
cd lean
lake exe cache get   # prebuilt Mathlib, several GB the first time
lake build
```

Open `lean/Hamiltonian/Pendulum.lean`. `energy_conserved` ends in `sorry`: it is stated but not yet proved.

## 3. Manuscript

Install a TeX distribution (MiKTeX or TeX Live), open `manuscript/main.tex`, and run **LaTeX Workshop: Build LaTeX project**. The PDF is written to `manuscript/build/`.

## Evidence

| Claim | Status | Where |
|---|---|---|
| Oscillator equations of motion | computed | `notebooks/01_oscillator.ipynb` |
| Oscillator energy conservation | **proven** | Physlib, `HarmonicOscillator.energy_conservation_of_equationOfMotion'` |
| Oscillator energy drift | numerical | `notebooks/01_oscillator.ipynb` |
| Pendulum equations of motion | computed | `notebooks/02_pendulum.ipynb` |
| Pendulum period formula | numerical check | `notebooks/02_pendulum.ipynb` |
| Pendulum energy conservation | stated, not proved | `lean/Hamiltonian/Pendulum.lean` |
