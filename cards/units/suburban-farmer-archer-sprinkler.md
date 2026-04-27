---
type: unit
id: suburban-farmer-archer-sprinkler
name: Sprinkler
role: archer
environment: suburban
curiosity: farmers
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
    shape: cone
    damage: 16
    range: 4
    notes: "wide spray cone — applies wet to all hit (yes, wet, even in suburbs)"
    apply: [wet]
visual:
  silhouette: tiny-all
  color: tan
  item: pitchfork
---

# Notes

A weird off-axis: Suburban unit that applies a Coastal status because the
yard sprinkler is the lawn's seafront. Cheap and silly.
