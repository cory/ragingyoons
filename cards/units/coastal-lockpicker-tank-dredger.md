---
type: unit
id: coastal-lockpicker-tank-dredger
name: Dredger
role: tank
environment: coastal
curiosity: lockpickers
cost: 4
stats:
  hp: 130
  damage: 12
  attack_rate: 0.8
  range: 0.6
  speed: 6.0
  armor: 6
bin:
  hp: 160
  garrison_cap: 2
  spawn_cadence: continuous
rage:
  capacity: 50
  attack:
    shape: pull
    damage: 30
    range: 4
    notes: "winch-pull — yanks the enemy bin toward Dredger, applies wet"
    apply: [wet]
visual:
  silhouette: big-all
  color: blue
  item: stick
---

# Notes

Premium anti-bin tank: pulls bins out of position into your DPS. Wild
mechanic that may need rebalancing — flag for playtest.
