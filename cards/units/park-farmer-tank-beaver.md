---
type: unit
id: park-farmer-tank-beaver
name: Beaver
role: tank
environment: park
curiosity: farmers
cost: 2
stats:
  hp: 80
  damage: 8
  attack_rate: 0.8
  range: 0.6
  speed: 6.0
  armor: 4
bin:
  hp: 110
  garrison_cap: 3
  spawn_cadence: continuous
rage:
  capacity: 50
  attack:
    shape: spawn-obstacle
    damage: 0
    range: 2.0
    notes: "drops a 2m-radius dam (impassable) for 4s, blocks enemy lanes"
visual:
  silhouette: big-all
  color: green
  item: pitchfork
---

# Notes

Terrain-altering tank — temporary obstacle reshapes the battlefield. Good
counter to flanking comps.
