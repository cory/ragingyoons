---
type: unit
id: city-tinkerer-archer-tagger
name: Tagger
role: archer
environment: city
curiosity: tinkerers
cost: 1
tier3_form: swarm
stats:
  hp: 30
  damage: 9
  attack_rate: 1.0
  range: 35.0
  speed: 8.0
  armor: 0
bin:
  hp: 85
  garrison_cap: 4
  spawn_cadence: continuous
rage:
  capacity: 50
  attack:
    shape: single-target
    damage: 18
    range: 5
    notes: "spray-can dart, applies smelly + small slow"
    apply: [smelly]
visual:
  silhouette: tiny-all
  color: charcoal
  item: gadget
---

# Notes

Cheap status applicator. Whole job is layering smelly stacks on backline targets.
