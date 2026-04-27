---
type: unit
id: suburban-barbarian-archer-eave-watcher
name: Suburban Barbarian Archer — Eave Watcher
role: archer
environment: suburban
curiosity: barbarians
cost: 3
tier3_form: swarm
stats:
  hp: 70
  damage: 8
  attack_rate: 0.8
  range: 30.0
  speed: 6.5
  armor: 5
bin:
  hp: 130
  garrison_cap: 2
  spawn_cadence: continuous
rage:
  capacity: 30
  attack:
    shape: pinpoint-bolt
    damage: 60
    range: 5.5
    notes: "fires a single heavy shot at lowest-HP enemy; stuns for 1s; cannot be blocked by frontliners"
visual:
  silhouette: tiny
  color: warm tan
  item: none
---

# Notes

Cost-3 finisher perched at the back of the turtle. Archer rage fills per attack landed —
Eave Watcher accumulates quickly behind the Lawn Knight wall. The pinpoint bolt targets
lowest-HP enemies and bypasses formation, letting the turtle delete wounded units that
would otherwise limp away and stall the round.
