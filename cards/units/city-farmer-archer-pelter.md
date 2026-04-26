---
type: unit
id: city-farmer-archer-pelter
name: Pelter
role: archer
environment: city
curiosity: farmers
cost: 2
stats:
  hp: 42
  damage: 13
  attack_rate: 1.0
  range: 5.0
  speed: 2.0
  armor: 0
bin:
  hp: 110
  garrison_cap: 3
  spawn_cadence: continuous
rage:
  capacity: 50
  attack:
    shape: piercing-line
    damage: 30
    range: 6
    notes: "thrown bricks line shot, applies smelly to all hit"
    apply: [smelly]
visual:
  silhouette: tiny-all
  color: charcoal
  item: pitchfork
---

# Notes

City swarm's ranged support. Smelly application chips down enemy DPS for the
infantry to mop up.
