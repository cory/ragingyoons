---
type: comp
id: test-phalanx-wall
name: Test — Phalanx Wall
synergies:
  - Suburban 2 — bin HP +20%
  - Barbarians 2 — raccoon HP +20%, Barbarians 3 — +2 armor
bins:
  - id: suburban-barbarian-tank-bouncer
    count: 1
  - id: suburban-barbarian-infantry-smasher
    count: 2
    formation: infantry-phalanx
  - id: suburban-barbarian-archer-eave-watcher
    count: 1
    formation: archer-two-line
---

# Notes

Tests the phalanx formation override on infantry. Tightly-packed
infantry block, tank in front, two-line archers behind. Compares
against test-suburban-wall (default formations) for design value
of the phalanx override.
