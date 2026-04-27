---
type: unit
id: park-tinkerer-archer-glowfly
name: Glowfly
role: archer
environment: park
curiosity: tinkerers
cost: 4
stats:
  hp: 66
  damage: 21
  attack_rate: 1.1
  range: 65.0
  speed: 9.0
  armor: 0
bin:
  hp: 160
  garrison_cap: 2
  spawn_cadence: continuous
rage:
  capacity: 50
  attack:
    shape: aoe-circle
    damage: 60
    range: 8
    notes: "flare round — 2m AOE, applies buggy + small wet"
    apply: [buggy, wet]
visual:
  silhouette: tiny-all
  color: green
  item: gadget
---

# Notes

Cost-4 premium archer. Massive range, AOE rage with two status applies.
Anchors a control comp.
