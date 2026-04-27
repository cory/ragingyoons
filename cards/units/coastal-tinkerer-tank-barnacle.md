---
type: unit
id: coastal-tinkerer-tank-barnacle
name: Coastal Tinkerer Tank — Barnacle
role: tank
environment: coastal
curiosity: tinkerers
cost: 2
tier3_form: swarm
stats:
  hp: 115
  damage: 5
  attack_rate: 0.7
  range: 1.0
  speed: 4.5
  armor: 10
bin:
  hp: 140
  garrison_cap: 2
  spawn_cadence: continuous
rage:
  capacity: 50
  attack:
    shape: anchor-slam
    damage: 35
    range: 2.2
    notes: "heaves an imaginary anchor overhead and crashes it down; AoE around self; slows all hit enemies for 2s"
visual:
  silhouette: big
  color: seafoam blue
  item: sparky thing (gadget on a stick)
---

# Notes

Cost-2 frontliner that creates a slow zone for Buzzwires to shoot into. Tinkerer 2-threshold
already slows on rage hits; Barnacle's anchor slam doubles the slow coverage in melee range.
Coastal 3 splash on basic attacks means even its auto-attacks punish clumping when the
archers' AoE comes online.
