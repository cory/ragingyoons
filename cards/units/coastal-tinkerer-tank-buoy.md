---
type: unit
id: coastal-tinkerer-tank-buoy
name: Buoy
role: tank
environment: coastal
curiosity: tinkerers
cost: 2
stats:
  hp: 80
  damage: 8
  attack_rate: 0.8
  range: 0.6
  speed: 1.5
  armor: 4
bin:
  hp: 110
  garrison_cap: 3
  spawn_cadence: continuous
rage:
  capacity: 50
  attack:
    shape: pulse
    damage: 18
    range: 2.0
    notes: "shock pulse, slow + applies wet to all hit"
    apply: [wet]
visual:
  silhouette: big-all
  color: blue
  item: gadget
---

# Notes

Tinkerer-flavored tank: rage attack is an AOE shock. Wet application chains
with Tinkerers-2 slow for a control-heavy frontline.
