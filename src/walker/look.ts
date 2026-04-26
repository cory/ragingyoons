/**
 * Independent head yaw — gives the character a head that drifts off
 * heading. Three modes blended by `lookMix`:
 *   idle      — small random saccades around forward (boredom)
 *   camera    — track the viewer's camera (engagement)
 *   influence — follow an "interesting point" provided by the caller
 *               (a flock neighbor, a goal, a sound source, …)
 *
 * Returns body-local yaw in radians: +Z = look left, -Z = look right
 * (matches RH Z-up, X-forward, Y-left).
 */

export type LookMode = "idle" | "camera" | "influence";

export interface LookMix {
  idle: number;
  camera: number;
  influence: number;
}

export interface LookState {
  yaw: number;
  yawVel: number;
  yawTarget: number;
  mode: LookMode;
  modeTimer: number;   // s until next mode pick
  glanceTimer: number; // s until next target pick within current mode
}

export interface LookCtx {
  /** Character world position (XY plane). */
  cx: number;
  cy: number;
  /** Character heading in world frame (yaw around +Z). */
  heading: number;
  /** Optional camera world position. Required when 'camera' weight > 0. */
  camX?: number;
  camY?: number;
  /** Optional "interesting point" world position. */
  influenceX?: number;
  influenceY?: number;
  /** Behavior weights. Need not be normalized. */
  mix: LookMix;
  /** Maximum yaw away from forward, radians. */
  maxYaw?: number;
}

const DEFAULT_MAX_YAW = Math.PI * 0.55;
// Spring tuning — ~critically damped, ~0.4s settle time.
const STIFFNESS = 32;
const DAMPING = 11;

export function makeLookState(): LookState {
  return {
    yaw: 0,
    yawVel: 0,
    yawTarget: 0,
    mode: "idle",
    modeTimer: 0.4,
    glanceTimer: 0.2,
  };
}

function wrapAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

function pickMode(mix: LookMix): LookMode {
  const total = Math.max(1e-6, mix.idle + mix.camera + mix.influence);
  let r = Math.random() * total;
  if ((r -= mix.idle) < 0) return "idle";
  if ((r -= mix.camera) < 0) return "camera";
  return "influence";
}

function targetFromCtx(ctx: LookCtx, mode: LookMode, maxYaw: number): number {
  if (mode === "idle") {
    // Random saccade in [-0.7, 0.7] of maxYaw, slightly biased toward 0.
    const u = (Math.random() + Math.random()) * 0.5 - 0.5; // triangle [-0.5, 0.5]
    return clamp(u * 1.4 * maxYaw, -maxYaw, maxYaw);
  }
  if (mode === "camera" && ctx.camX !== undefined && ctx.camY !== undefined) {
    const dx = ctx.camX - ctx.cx;
    const dy = ctx.camY - ctx.cy;
    if (dx * dx + dy * dy < 1e-6) return 0;
    const worldAng = Math.atan2(dy, dx);
    return clamp(wrapAngle(worldAng - ctx.heading), -maxYaw, maxYaw);
  }
  if (mode === "influence" && ctx.influenceX !== undefined && ctx.influenceY !== undefined) {
    const dx = ctx.influenceX - ctx.cx;
    const dy = ctx.influenceY - ctx.cy;
    if (dx * dx + dy * dy < 1e-6) return 0;
    const worldAng = Math.atan2(dy, dx);
    return clamp(wrapAngle(worldAng - ctx.heading), -maxYaw, maxYaw);
  }
  return 0;
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

export function stepLook(state: LookState, ctx: LookCtx, dt: number): number {
  const total = ctx.mix.idle + ctx.mix.camera + ctx.mix.influence;
  if (total <= 1e-6) {
    // No look behavior — relax toward 0.
    state.yawTarget = 0;
  } else {
    state.modeTimer -= dt;
    if (state.modeTimer <= 0) {
      state.mode = pickMode(ctx.mix);
      // Mode dwell varies by mode: idle = short, camera/influence = longer.
      state.modeTimer = state.mode === "idle" ? rand(1.0, 2.4) : rand(1.6, 3.2);
      state.glanceTimer = 0; // force immediate target re-pick
    }
    state.glanceTimer -= dt;
    if (state.glanceTimer <= 0) {
      const maxYaw = ctx.maxYaw ?? DEFAULT_MAX_YAW;
      state.yawTarget = targetFromCtx(ctx, state.mode, maxYaw);
      // idle saccades flicker more often than tracking modes.
      state.glanceTimer = state.mode === "idle" ? rand(0.45, 1.1) : rand(0.25, 0.6);
    }
  }
  // Spring step toward yawTarget.
  const dy = wrapAngle(state.yawTarget - state.yaw);
  const acc = STIFFNESS * dy - DAMPING * state.yawVel;
  state.yawVel += acc * dt;
  state.yaw += state.yawVel * dt;
  return state.yaw;
}

function rand(lo: number, hi: number): number {
  return lo + Math.random() * (hi - lo);
}
