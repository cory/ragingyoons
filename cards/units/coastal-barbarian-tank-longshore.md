---
type: unit
id: coastal-barbarian-tank-longshore
name: Longshore
role: tank
environment: coastal
curiosity: barbarians
cost: 4
tier3_form: swarm
stats:
  hp: 130
  damage: 12
  attack_rate: 0.8
  range: 0.6
  speed: 5.5
  armor: 7
bin:
  hp: 160
  garrison_cap: 2
  spawn_cadence: continuous
rage:
  capacity: 50
  attack:
    shape: pulse
    damage: 45
    range: 2.5
    notes: "anchor-slam pulse, knocks back, applies sandy + wet to all hit"
    apply: [sandy, wet]
visual:
  silhouette: big-all
  color: blue
  item: none
---

# Notes

Cost-4 mega-tank. Both Coastal statuses on rage = total ranged shutdown
for 3s. Anchor the lateline.
