/**
 * Projectiles (currently archer arrows).
 *
 * Each tick:
 *   1. Advance every alive projectile by (vx, vy) × dt.
 *   2. Swept-segment collision against alive racs (skip the source) and
 *      alive bins. *Friendly fire is on* — the first body in the way
 *      eats the arrow regardless of side. That's the design point: a
 *      tank in front of an archer blocks the shot, so positions matter.
 *   3. On hit: apply damage via combat.ts handlers, mark proj dead,
 *      emit `proj_hit`.
 *   4. On TTL expiry (no hit before max range): mark dead, emit
 *      `proj_expire`.
 *
 * Determinism: alive projectiles are visited in row-index order, and
 * each one's collision pool (racs then bins) is scanned in row-index
 * order. The earliest segment-t hit wins; ties broken by lower row.
 *
 * Cost is O(P × N) where P = projectiles in flight, N = alive entities.
 * Will need a spatial broadphase (grid query along the segment) when P
 * × N gets fat; not yet.
 */

import type { ContentBundle } from "../content.js";
import { ROLE_ARCHER } from "../content.js";
import type { Logger } from "../log.js";
import {
  SECONDS_PER_TICK,
  type BattleState,
  findRacRowById,
} from "../state.js";
import { applyBinDamage, applyRacDamage, gainRage } from "./combat.js";

const RAGE_PER_ARROW_LANDED = 5;

/** Speed of an archer arrow (m/s). Fast enough to feel arrow-y on a
 *  100m field, slow enough that a sprinting cavalry can outpace a long
 *  shot — making "shot dodged" a real outcome. */
export const ARROW_SPEED = 30;

/** Hit radius of a raccoon body (meters). Roughly the cylinder radius
 *  per the design memo. Combined with arrow's geometric thickness this
 *  is the swept-segment closest-approach threshold for rac collision. */
export const RAC_HIT_RADIUS = 0.5;

/** Hit radius of a bin (trashbin is bigger than a rac). */
export const BIN_HIT_RADIUS = 1.5;

/** Spawn a projectile aimed at (tgtX, tgtY) at fire-time. Dumb-fire:
 *  the arrow does not home if the target moves. Speed is fixed at
 *  ARROW_SPEED. TTL = maxRange / ARROW_SPEED so the arrow auto-expires
 *  after traveling the source's effective range. */
export function spawnProjectile(
  state: BattleState,
  log: Logger,
  srcRow: number,
  srcX: number,
  srcY: number,
  tgtX: number,
  tgtY: number,
  damage: number,
  maxRange: number,
): void {
  const dx = tgtX - srcX;
  const dy = tgtY - srcY;
  const d = Math.hypot(dx, dy);
  if (d < 1e-6) return; // degenerate, skip
  const vx = (dx / d) * ARROW_SPEED;
  const vy = (dy / d) * ARROW_SPEED;
  // Find a free slot — scan the active range first; grow if all are
  // alive. With MAX_ATKS = 1024 and typical in-flight counts in the
  // low hundreds, the linear scan is cheap enough.
  let slot = -1;
  for (let i = 0; i < state.atk.count; i++) {
    if (!state.atk.alive[i]) {
      slot = i;
      break;
    }
  }
  if (slot < 0) {
    if (state.atk.count >= state.atk.id.length) return; // table full, drop
    slot = state.atk.count;
    state.atk.count = slot + 1;
  }
  const id = state.nextAtkId++;
  state.atk.id[slot] = id;
  state.atk.sourceRacId[slot] = state.rac.id[srcRow];
  state.atk.sourceOwner[slot] = state.rac.owner[srcRow];
  state.atk.kindIdx[slot] = 0; // 0 = arrow
  state.atk.damage[slot] = damage;
  state.atk.appliesStatusIds[slot] = [];
  state.atk.x[slot] = srcX;
  state.atk.y[slot] = srcY;
  state.atk.vx[slot] = vx;
  state.atk.vy[slot] = vy;
  state.atk.radius[slot] = 0; // arrow has zero own radius; entity radii cover it
  state.atk.ttl[slot] = maxRange / ARROW_SPEED;
  state.atk.alive[slot] = 1;
  log.emit("proj_fire", {
    proj_id: id,
    src_rac: state.rac.id[srcRow],
    src_owner: state.rac.owner[srcRow],
    src_x: srcX,
    src_y: srcY,
    tgt_x: tgtX,
    tgt_y: tgtY,
    damage,
    max_range: maxRange,
  });
}

export function projectileTick(state: BattleState, content: ContentBundle, log: Logger): void {
  const dt = SECONDS_PER_TICK;
  const halfW = state.bounds.w * 0.5;
  const halfH = state.bounds.h * 0.5;

  for (let p = 0; p < state.atk.count; p++) {
    if (!state.atk.alive[p]) continue;
    const px = state.atk.x[p];
    const py = state.atk.y[p];
    const vx = state.atk.vx[p];
    const vy = state.atk.vy[p];
    const nx = px + vx * dt;
    const ny = py + vy * dt;
    const srcRacId = state.atk.sourceRacId[p];

    // Swept-segment closest-approach test against every alive rac (skip
    // source) and every alive bin. We track the earliest in-segment hit.
    let bestT = Infinity;
    let bestKind = 0; // 1 = rac, 2 = bin
    let bestRow = -1;

    const segDx = nx - px;
    const segDy = ny - py;
    const segLen2 = segDx * segDx + segDy * segDy;
    if (segLen2 < 1e-12) {
      // Stationary — just expire.
      state.atk.alive[p] = 0;
      log.emit("proj_expire", { proj_id: state.atk.id[p], reason: "degenerate", x: px, y: py });
      continue;
    }

    // racs — friendly racs are skipped: arrows pass through allies
    // rather than killing them. Without this, a back-rank archer
    // shooting forward could spear the front-rank archer beside them
    // (or worse, a tank between them and the enemy).
    const srcOwner = state.atk.sourceOwner[p];
    for (let i = 0; i < state.rac.count; i++) {
      if (!state.rac.alive[i]) continue;
      if (state.rac.id[i] === srcRacId) continue; // never self-hit
      if (state.rac.owner[i] === srcOwner) continue; // no friendly fire
      const cx = state.rac.x[i];
      const cy = state.rac.y[i];
      // Closest approach t along segment: t = ((c-p) · seg) / |seg|², clamped [0,1].
      let t = ((cx - px) * segDx + (cy - py) * segDy) / segLen2;
      if (t < 0) t = 0;
      else if (t > 1) t = 1;
      const ax = px + segDx * t;
      const ay = py + segDy * t;
      const dxh = cx - ax;
      const dyh = cy - ay;
      const d2 = dxh * dxh + dyh * dyh;
      if (d2 <= RAC_HIT_RADIUS * RAC_HIT_RADIUS && t < bestT) {
        bestT = t;
        bestKind = 1;
        bestRow = i;
      }
    }
    // bins — same friendly-fire rule. Arrows pass over our own bins.
    for (let k = 0; k < state.bin.count; k++) {
      if (!state.bin.alive[k]) continue;
      if (state.bin.owner[k] === srcOwner) continue;
      const cx = state.bin.x[k];
      const cy = state.bin.y[k];
      let t = ((cx - px) * segDx + (cy - py) * segDy) / segLen2;
      if (t < 0) t = 0;
      else if (t > 1) t = 1;
      const ax = px + segDx * t;
      const ay = py + segDy * t;
      const dxh = cx - ax;
      const dyh = cy - ay;
      const d2 = dxh * dxh + dyh * dyh;
      if (d2 <= BIN_HIT_RADIUS * BIN_HIT_RADIUS && t < bestT) {
        bestT = t;
        bestKind = 2;
        bestRow = k;
      }
    }

    if (bestRow >= 0) {
      const hitX = px + segDx * bestT;
      const hitY = py + segDy * bestT;
      const dmg = state.atk.damage[p];
      // Source row may not exist anymore (shooter died mid-flight). We
      // attribute by id lookup; -1 means "killed by arrow whose shooter
      // is gone" which damage_apply tolerates.
      const srcRow = findRacRowById(state, srcRacId);
      const isFriendly =
        bestKind === 1
          ? state.rac.owner[bestRow] === state.atk.sourceOwner[p]
          : state.bin.owner[bestRow] === state.atk.sourceOwner[p];
      log.emit("proj_hit", {
        proj_id: state.atk.id[p],
        src_rac: srcRacId,
        src_owner: state.atk.sourceOwner[p],
        hit_kind: bestKind === 1 ? "rac" : "bin",
        hit_id: bestKind === 1 ? state.rac.id[bestRow] : state.bin.id[bestRow],
        hit_owner: bestKind === 1 ? state.rac.owner[bestRow] : state.bin.owner[bestRow],
        friendly_fire: isFriendly ? 1 : 0,
        x: hitX,
        y: hitY,
        damage: dmg,
      });
      if (bestKind === 1) {
        applyRacDamage(state, content, log, srcRow, bestRow, dmg, null, "projectile");
      } else {
        applyBinDamage(state, content, log, srcRow, bestRow, dmg);
      }
      // Archer rage on landed shot (matches the old "per attack landed"
      // rule which used to apply at attack time pre-projectiles).
      if (srcRow >= 0 && state.rac.role[srcRow] === ROLE_ARCHER) {
        gainRage(state, srcRow, RAGE_PER_ARROW_LANDED);
      }
      state.atk.alive[p] = 0;
      continue;
    }

    // No hit — advance and decrement TTL.
    state.atk.x[p] = nx;
    state.atk.y[p] = ny;
    state.atk.ttl[p] = state.atk.ttl[p] - dt;
    // Out-of-bounds also expires (shouldn't happen with TTL = range/speed,
    // but defensive against fast-moving projectiles).
    if (
      state.atk.ttl[p] <= 0 ||
      nx > halfW ||
      nx < -halfW ||
      ny > halfH ||
      ny < -halfH
    ) {
      state.atk.alive[p] = 0;
      log.emit("proj_expire", {
        proj_id: state.atk.id[p],
        reason: state.atk.ttl[p] <= 0 ? "ttl" : "oob",
        x: nx,
        y: ny,
      });
    }
  }
}
