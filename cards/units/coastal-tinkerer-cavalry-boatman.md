---
type: unit
id: coastal-tinkerer-cavalry-boatman
name: Boatman
role: cavalry
environment: coastal
curiosity: tinkerers
cost: 3
tier3_form: swarm
stats:
  hp: 64
  damage: 26
  attack_rate: 1.2
  range: 2.0
  speed: 13.5
  armor: 0
bin:
  hp: 135
  garrison_cap: 2
  spawn_cadence: continuous
rage:
  capacity: 50
  attack:
    shape: cone
    damage: 40
    range: 3
    notes: "harpoon-rush cone, applies sandy to all hit"
    apply: [sandy]
visual:
  silhouette: tall-wider
  color: blue
  item: gadget
---

# Notes

Cavalry that closes range and shuts down enemy archers via Sandy
(reduces their range -25%).
