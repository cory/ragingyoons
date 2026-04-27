---
type: comp
id: test-leuctra-stack
name: Test — Leuctra Stack (heavy left wing)
synergies:
  - Suburban 2 — bin HP +20%
  - Barbarians 2 — raccoon HP +20%, Barbarians 3 — +2 armor
bins:
  # Bottom row (bins 0,1 → y = -15): WEAK FLANK (the "refused" wing).
  # Two squishy archers, no tank cover.
  - id: park-tinkerer-archer-glowfly
    count: 2
  # Top row (bins 2,3 → y = +15): STRONG WING.
  # Two tanks in arrowhead — the "Theban left" that should crush the
  # opposing top wing, then turn inward.
  - id: suburban-barbarian-tank-warden
    count: 2
    formation: tank-arrowhead
---

# Notes

Tests the Leuctra concentration thesis: stack force on one wing, refuse
the other. If the strong wing crushes the opposing wing FAST and then
helps the refused wing, this comp should beat a balanced opponent
despite identical total force.

Pair against `test-leuctra-even` (same total cost, evenly distributed)
to see if asymmetric concentration produces the historical outcome.
