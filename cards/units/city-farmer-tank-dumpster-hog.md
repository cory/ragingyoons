---
type: unit
id: city-farmer-tank-dumpster-hog
name: City Farmer Tank — Dumpster Hog
role: tank
environment: city
curiosity: farmers
cost: 3
tier3_form: swarm
stats:
  hp: 120
  damage: 7
  attack_rate: 0.7
  range: 0.9
  speed: 5.0
  armor: 8
bin:
  hp: 150
  garrison_cap: 2
  spawn_cadence: continuous
rage:
  capacity: 60
  attack:
    shape: radial-slam
    damage: 50
    range: 2.0
    notes: "heaves bin lid overhead and slams it down; AoE around self; heavy knockback on all hit targets"
visual:
  silhouette: big
  color: charcoal
  item: pitchfork
---

# Notes

Cost-3 anchor for the City + Farmers swarm. Rage fills per damage taken — Dumpster Hog
wants to sit in the scrum and soak hits until the lid comes down. Radial slam clears
space for the swarm behind it and synergizes with City density: more allies nearby
means the cleared zone refills with friendlies instantly.
