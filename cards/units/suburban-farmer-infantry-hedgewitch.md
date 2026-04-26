---
type: unit
id: suburban-farmer-infantry-hedgewitch
name: Hedgewitch
role: infantry
environment: suburban
curiosity: farmers
cost: 2
stats:
  hp: 61
  damage: 12
  attack_rate: 1.0
  range: 0.8
  speed: 2.0
  armor: 0
bin:
  hp: 110
  garrison_cap: 3
  spawn_cadence: continuous
rage:
  capacity: 50
  attack:
    shape: aura
    damage: 0
    range: 2.0
    notes: "compost burst — heals allies in 2m for 25 HP, applies bored to enemies in radius"
    apply: [bored]
visual:
  silhouette: thin-tall
  color: tan
  item: pitchfork
---

# Notes

Suburban+Farmers — turtle-with-numbers. Rage is dual-purpose heal+debuff.
