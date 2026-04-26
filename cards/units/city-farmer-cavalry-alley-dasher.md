---
type: unit
id: city-farmer-cavalry-alley-dasher
name: City Farmer Cavalry — Alley Dasher
role: cavalry
environment: city
curiosity: farmers
cost: 2
stats:
  hp: 45
  damage: 12
  attack_rate: 1.4
  range: 0.8
  speed: 3.0
  armor: 0
bin:
  hp: 90
  garrison_cap: 3
  spawn_cadence: continuous
rage:
  capacity: 35
  attack:
    shape: leap-behind
    damage: 40
    range: 4.0
    notes: "vaults over target, lands behind them, knocks back in the direction of travel"
visual:
  silhouette: tall-wider
  color: charcoal
  item: pitchfork
---

# Notes

Cost-2 flanker in the City + Farmers swarm. Cavalry rage fills per second spent attacking,
so Alley Dasher wants to lock onto a target and keep swinging. The vault-behind rage
repositions it to the dangerous side of a tank or bin and opens up Cavalry's natural
flank-damage bonus.
