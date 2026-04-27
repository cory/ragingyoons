---
type: comp
id: test-leuctra-even
name: Test — Leuctra Even (balanced line)
synergies:
  - Suburban 2 — bin HP +20%
  - Barbarians 2 — raccoon HP +20%, Barbarians 3 — +2 armor
bins:
  # Even distribution: one tank + one archer per row. Same total cost
  # as test-leuctra-stack (2 tanks + 2 archers) but spread across both
  # wings symmetrically.
  - id: suburban-barbarian-tank-warden
    count: 1
  - id: park-tinkerer-archer-glowfly
    count: 1
  - id: suburban-barbarian-tank-warden
    count: 1
  - id: park-tinkerer-archer-glowfly
    count: 1
---

# Notes

Balanced control comp for the Leuctra test. Same units as
test-leuctra-stack but evenly distributed: tank-archer pair on each
wing. If concentration matters, this should LOSE to the stacked comp
even though they have identical raw force.
