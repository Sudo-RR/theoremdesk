# The Hamiltonian mechanics reference project

```text
hamiltonian-mechanics/
├── notebooks/
│   ├── 01_oscillator.ipynb   SymPy equations of motion, SciPy trajectories
│   └── 02_pendulum.ipynb     period against amplitude, exact vs numerical
├── lean/                     Lean 4 project on Physlib and Mathlib
│   └── Hamiltonian/
│       ├── Oscillator.lean   energy conservation (proved in Physlib)
│       └── Pendulum.lean     energy conservation (stated, still to prove)
├── manuscript/
│   ├── main.tex              includes what the notebooks generate
│   └── references.bib
└── requirements.txt
```

The notebooks write equations into `manuscript/generated/` and figures into `manuscript/figures/`. Re-run a notebook and rebuild the paper to update it.

Every result says how it's supported: **proven** in Lean, **computed** symbolically, or **numerical**.
