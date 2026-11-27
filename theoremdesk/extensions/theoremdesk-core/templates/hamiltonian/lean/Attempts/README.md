# Proof attempts

Put each attempt at proving a statement from `Hamiltonian/` here, one file per attempt, for example `Attempts/Pendulum.lean`.

An attempt restates the same definitions and theorem as the statement file, with a real proof in place of `sorry`. To prove `Hamiltonian.Pendulum.energy_conserved`, copy `Hamiltonian/Pendulum.lean` here, keep its `namespace Hamiltonian.Pendulum`, and replace the `sorry`.

Then run **Check Proof Against Statement** from the Run button on a Lean file. It confirms the attempt proves exactly the statement you wrote, adds no axioms, and is accepted by all six kernels.

Attempts aren't part of the default build. A broken or untrusted attempt can't affect `lake build` or `lake check`.
