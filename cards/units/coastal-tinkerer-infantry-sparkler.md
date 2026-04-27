---
type: unit
id: coastal-tinkerer-infantry-sparkler
name: Sparkler
role: infantry
environment: coastal
curiosity: tinkerers
cost: 1
stats:
  hp: 43
  damage: 9
  attack_rate: 1.0
  range: 0.8
  speed: 8.0
  armor: 0
bin:
  hp: 85
  garrison_cap: 4
  spawn_cadence: continuous
rage:
  capacity: 50
  attack:
    shape: arc
    damage: 16
    range: 1.5
    notes: "static arc to a second target, applies wet"
    apply: [wet]
visual:
  silhouette: thin-tall
  color: blue
  item: gadget
---

# Notes

Cheap chain-zapper. Combos with Tinkerers-2 for slow stacking on every chain.
