---
type: unit
id: suburban-barbarian-tank-bouncer
name: Bouncer
role: tank
environment: suburban
curiosity: barbarians
cost: 1
tier3_form: swarm
stats:
  hp: 55
  damage: 6
  attack_rate: 0.8
  range: 0.6
  speed: 6.0
  armor: 3
bin:
  hp: 85
  garrison_cap: 4
  spawn_cadence: continuous
rage:
  capacity: 50
  attack:
    shape: knockback
    damage: 12
    range: 1.0
    notes: "shoves attackers back 1.5m, stuns 0.3s"
visual:
  silhouette: big-all
  color: tan
  item: none
---

# Notes

Cheap entry tank for Suburban turtle. Bounces threats away from the bin.
Garrison 4 means a wall of bouncers per bin.
