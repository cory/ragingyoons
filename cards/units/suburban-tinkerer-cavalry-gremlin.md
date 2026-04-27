---
type: unit
id: suburban-tinkerer-cavalry-gremlin
name: Gremlin
role: cavalry
environment: suburban
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
    shape: dash
    damage: 42
    range: 4
    notes: "garage-tools dash — applies bored on impact"
    apply: [bored]
visual:
  silhouette: tall-wider
  color: tan
  item: gadget
---

# Notes

Cavalry-status hybrid. Bored on dash = enemy attack-rate cratered while your
front line eats their meat.
