---
type: unit
id: park-lockpicker-archer-twiglet
name: Twiglet
role: archer
environment: park
curiosity: lockpickers
cost: 2
stats:
  hp: 42
  damage: 13
  attack_rate: 1.0
  range: 45.0
  speed: 9.0
  armor: 0
bin:
  hp: 110
  garrison_cap: 3
  spawn_cadence: continuous
rage:
  capacity: 50
  attack:
    shape: piercing-line
    damage: 32
    range: 7
    notes: "long-bow line shot, applies hungry to first hit"
    apply: [hungry]
visual:
  silhouette: tiny-all
  color: green
  item: stick
---

# Notes

Sneaky long-range chip. Slightly faster than archer baseline (off-curve)
to fit Park's mobility theme.
