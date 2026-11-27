import Mathlib

/-!
# Nonlinear pendulum

A pendulum of mass `m` on a rod of length `L` under gravity `g`, with angle `θ`
from the downward vertical and conjugate momentum `p`:

  H(θ, p) = p² / (2 m L²) - m g L cos θ

Status: energy conservation is **stated, not yet proved**. Replace the `sorry`
yourself, or ask the research agent to try.
-/

namespace Hamiltonian.Pendulum

/-- Mass, length and gravitational acceleration, all positive. -/
structure Params where
  m : ℝ
  L : ℝ
  g : ℝ
  m_pos : 0 < m
  L_pos : 0 < L
  g_pos : 0 < g

/-- The pendulum Hamiltonian. -/
noncomputable def hamiltonian (P : Params) (θ p : ℝ) : ℝ :=
  p ^ 2 / (2 * P.m * P.L ^ 2) - P.m * P.g * P.L * Real.cos θ

/-- `(θ, p)` solves Hamilton's equations: `θ' = ∂H/∂p` and `p' = -∂H/∂θ`. -/
def IsSolution (P : Params) (θ p : ℝ → ℝ) : Prop :=
  ∀ t, HasDerivAt θ (p t / (P.m * P.L ^ 2)) t ∧
    HasDerivAt p (-(P.m * P.g * P.L * Real.sin (θ t))) t

/-- Energy is constant along every solution of Hamilton's equations. -/
theorem energy_conserved (P : Params) (θ p : ℝ → ℝ) (h : IsSolution P θ p) (t : ℝ) :
    hamiltonian P (θ t) (p t) = hamiltonian P (θ 0) (p 0) := by
  sorry

end Hamiltonian.Pendulum
