---
type: unit
id: coastal-lockpicker-cavalry-smuggler
name: Smuggler
role: cavalry
environment: coastal
curiosity: lockpickers
cost: 2
stats:
  hp: 50
  damage: 20
  attack_rate: 1.2
  range: 2.0
  speed: 14.0
  armor: 0
bin:
  hp: 110
  garrison_cap: 3
  spawn_cadence: continuous
rage:
  capacity: 50
  attack:
    shape: leap
    damage: 38
    range: 4
    notes: "boarding-rush leap, +50% dmg vs bins, applies sandy"
    apply: [sandy]
visual:
  silhouette: tall-wider
  color: blue
  item: stick
---

# Notes

Cost-2 bin-sniper. Sandy reduces enemy ranged retaliation as Smuggler dives in.
