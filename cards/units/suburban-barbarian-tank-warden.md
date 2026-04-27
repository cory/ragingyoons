---
type: unit
id: suburban-barbarian-tank-warden
name: Warden
role: tank
environment: suburban
curiosity: barbarians
cost: 3
stats:
  hp: 105
  damage: 10
  attack_rate: 0.8
  range: 0.6
  speed: 6.0
  armor: 5
bin:
  hp: 135
  garrison_cap: 2
  spawn_cadence: continuous
rage:
  capacity: 50
  attack:
    shape: aura
    damage: 0
    range: 2.0
    notes: "battle howl — allies in 2m radius gain +30% armor for 4s, applies bored to enemies in radius"
    apply: [bored]
visual:
  silhouette: big-all
  color: tan
  item: none
---

# Notes

Flagship Suburban+Barbarians tank. Rage aura buffs allies AND debuffs enemies —
true homefield-defender feel.
