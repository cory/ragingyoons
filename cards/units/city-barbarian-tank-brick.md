---
type: unit
id: city-barbarian-tank-brick
name: Brick
role: tank
environment: city
curiosity: barbarians
cost: 2
tier3_form: swarm
stats:
  hp: 90
  damage: 8
  attack_rate: 0.8
  range: 0.6
  speed: 6.0
  armor: 5
bin:
  hp: 110
  garrison_cap: 3
  spawn_cadence: continuous
rage:
  capacity: 50
  attack:
    shape: knockback
    damage: 22
    range: 1.0
    notes: "headbutt — knock back + applies traffic"
    apply: [traffic]
visual:
  silhouette: big-all
  color: charcoal
  item: none
---

# Notes

Off-curve tanky (HP 90 vs baseline 80) — the immovable City brawler. Traffic
on rage = lock down a key flank.
