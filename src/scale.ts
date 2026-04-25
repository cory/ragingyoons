/**
 * Single source of truth for world-scale constants. Importers must NEVER
 * redefine these locally — duplicating leads to character/track mismatch
 * when the values change.
 */

export const UNIT_SCALE = 0.0133;          // walker units → babylon meters
export const WORLD_R_WALKER = 420;          // track radius in walker units
export const WORLD_R_BABYLON = WORLD_R_WALKER * UNIT_SCALE;
