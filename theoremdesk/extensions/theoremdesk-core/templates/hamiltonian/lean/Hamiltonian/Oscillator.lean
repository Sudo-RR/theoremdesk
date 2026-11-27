import Physlib.ClassicalMechanics.HarmonicOscillator.Basic

/-!
# Simple harmonic oscillator

Physlib already formalises the oscillator, so this project builds on it rather
than restating it. The manuscript cites the results below. Put your cursor on
a `#check` line to see the full statement in the infoview.

Status: **proven** (in Physlib).
-/

open ClassicalMechanics

-- Energy is constant along any smooth solution of the equation of motion.
#check @HarmonicOscillator.energy_conservation_of_equationOfMotion'

-- The same, stated as the time derivative of the energy vanishing.
#check @HarmonicOscillator.energy_conservation_of_equationOfMotion
