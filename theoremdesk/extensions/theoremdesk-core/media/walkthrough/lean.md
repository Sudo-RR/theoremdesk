# Lean, Mathlib and Physlib

**Install Lean** installs elan, which downloads whichever Lean version a project asks for in its `lean-toolchain` file.

The project's `lean/` folder pins the Lean version that Physlib needs. In a terminal there:

```bash
lake exe cache get   # download prebuilt Mathlib (several GB, once per Mathlib version)
lake build           # build the project and the Physlib files it uses
```

Then open `lean/Hamiltonian/Oscillator.lean`. The infoview shows the proof state next to your cursor.
