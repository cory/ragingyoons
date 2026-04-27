---
type: unit
id: park-farmer-infantry-possum
name: Possum
role: infantry
environment: park
curiosity: farmers
cost: 3
tier3_form: swarm
stats:
  hp: 79
  damage: 15
  attack_rate: 1.0
  range: 0.8
  speed: 8.0
  armor: 1
bin:
  hp: 135
  garrison_cap: 2
  spawn_cadence: continuous
rage:
  capacity: 50
  attack:
    shape: feign-death
    damage: 50
    range: 1.0
    notes: "play dead 1s, then explode for 50 dmg + applies hungry"
    apply: [hungry]
visual:
  silhouette: thin-tall
  color: green
  item: pitchfork
---

# Notes

Premium infantry with a trickster rage. Eats incoming damage during the feign
window, then bursts. Fun read for spectators.
