---
type: unit
id: city-farmer-infantry-mob
name: Mob
role: infantry
environment: city
curiosity: farmers
cost: 2
tier3_form: swarm
stats:
  hp: 61
  damage: 12
  attack_rate: 1.0
  range: 0.8
  speed: 8.0
  armor: 0
bin:
  hp: 110
  garrison_cap: 3
  spawn_cadence: continuous
rage:
  capacity: 50
  attack:
    shape: cone
    damage: 35
    range: 2
    notes: "rallying surge — short cone in front; +20% ally damage for 2s"
visual:
  silhouette: thin-tall
  color: charcoal
  item: pitchfork
---

# Notes

Cost-2 backbone of the City+Farmers swarm. Two raccoons per spawn already,
three at synergy-3.
