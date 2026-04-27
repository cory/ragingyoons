---
type: unit
id: coastal-tinkerer-cavalry-undertow
name: Coastal Tinkerer Cavalry — Undertow
role: cavalry
environment: coastal
curiosity: tinkerers
cost: 3
stats:
  hp: 55
  damage: 18
  attack_rate: 1.5
  range: 0.9
  speed: 13.0
  armor: 0
bin:
  hp: 115
  garrison_cap: 3
  spawn_cadence: continuous
rage:
  capacity: 40
  attack:
    shape: wave-pass
    damage: 55
    range: 5.0
    notes: "surges in a line through the enemy formation, dealing damage and slowing every unit passed through for 2s; exits the other side"
visual:
  silhouette: tall-wider
  color: seafoam blue
  item: sparky thing (gadget on a stick)
---

# Notes

Cost-3 disruptor that punches through the backline. Cavalry rage fills per second spent
attacking; Undertow harasses enemies until the meter pops, then threads through the
entire formation. With Tinkerer 3 active, the wave-pass slow gains extra range — the
slow zone trails behind it like a wake, locking enemies in place for Buzzwire follow-up.
