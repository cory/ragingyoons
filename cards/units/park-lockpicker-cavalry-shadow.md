---
type: unit
id: park-lockpicker-cavalry-shadow
name: Shadow
role: cavalry
environment: park
curiosity: lockpickers
cost: 3
stats:
  hp: 64
  damage: 26
  attack_rate: 1.2
  range: 0.6
  speed: 14.0
  armor: 0
bin:
  hp: 135
  garrison_cap: 2
  spawn_cadence: continuous
rage:
  capacity: 50
  attack:
    shape: leap
    damage: 50
    range: 4
    notes: "vault attack onto bin priority target, +60% dmg vs bins, applies hungry"
    apply: [hungry]
visual:
  silhouette: tall-wider
  color: green
  item: stick
---

# Notes

Flagship Park+Lockpickers assassin. Speed 4 (off-curve fast), bin-priority
targeting, hungry DoT keeps the pressure on after they retreat.
