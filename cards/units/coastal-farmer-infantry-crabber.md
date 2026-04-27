---
type: unit
id: coastal-farmer-infantry-crabber
name: Crabber
role: infantry
environment: coastal
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
    shape: cleave
    damage: 36
    range: 1.5
    notes: "claw-pinch wide cleave, applies wet"
    apply: [wet]
visual:
  silhouette: thin-tall
  color: blue
  item: pitchfork
---

# Notes

Coastal infantry with a brawler kit. Wet on cleave shuts down clumped enemies'
movement.
