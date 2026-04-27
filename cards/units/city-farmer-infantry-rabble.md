---
type: unit
id: city-farmer-infantry-rabble
name: City Farmer Infantry — Rabble
role: infantry
environment: city
curiosity: farmers
cost: 1
stats:
  hp: 40
  damage: 6
  attack_rate: 1.2
  range: 0.8
  speed: 8.0
  armor: 0
bin:
  hp: 80
  garrison_cap: 4
  spawn_cadence: continuous
rage:
  capacity: 50
  attack:
    shape: cone
    damage: 25
    range: 2
    notes: "stomp ahead, brief slow on hit"
visual:
  silhouette: thin-tall
  color: charcoal
  item: pitchfork
---

# Notes

Cost-1 placeholder to demonstrate the schema. Numbers TBD in balance pass.
Plays into City + Farmers diagonal: cheap, plentiful, crowd-damage-scaling.
