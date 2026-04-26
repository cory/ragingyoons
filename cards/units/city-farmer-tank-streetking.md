---
type: unit
id: city-farmer-tank-streetking
name: Streetking
role: tank
environment: city
curiosity: farmers
cost: 3
stats:
  hp: 105
  damage: 10
  attack_rate: 0.8
  range: 0.6
  speed: 1.5
  armor: 5
bin:
  hp: 135
  garrison_cap: 2
  spawn_cadence: continuous
rage:
  capacity: 50
  attack:
    shape: pulse
    damage: 30
    range: 1.5
    notes: "ground-stomp pulse, applies traffic to all hit"
    apply: [traffic]
visual:
  silhouette: big-all
  color: charcoal
  item: pitchfork
---

# Notes

Anchor tank for City+Farmers. Pulse rage glues a flank in place for 0.6s,
giving the swarm a chance to crash into stuck enemies.
