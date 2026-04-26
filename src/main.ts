/**
 * ragingyoons entry — RH, Z-up world. The whole stack assumes:
 *   World:     right-handed, Z-up. Track is on the XY plane, CCW.
 *   Character: right-handed, X-forward, Y-left, Z-up.
 */
import "@babylonjs/core/Engines/Extensions/engine.uniformBuffer";
import "@babylonjs/core/Materials/standardMaterial";
import "@babylonjs/core/Meshes/Builders/discBuilder";
import "@babylonjs/core/Meshes/Builders/linesBuilder";
import "@babylonjs/core/Meshes/Builders/planeBuilder";
import "@babylonjs/core/Rendering/edgesRenderer";

import { ArcRotateCamera, Color3, Engine, Scene, Vector3 } from "@babylonjs/core";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";

import type { Unit } from "./character/generator";
import { generateTeams, type Roster, type Team } from "./character/teams";
import { buildCharacter, type CharacterMesh } from "./character/mesh";
import {
  asRaccoon,
  buildBodyBands,
  defaultRaccoonSpec,
  RACCOON_DEFAULTS,
  specFromUnit,
  type RaccoonSpec,
} from "./character/raccoon";
import { GAITS } from "./walker/gait";
import { MOOD_AXES, type MoodAxis, PRESETS, presetMood } from "./walker/mood";
import { makeDriverState, updateDriver } from "./walker/driver";
import { makeLookState, stepLook } from "./walker/look";
import { applyInkEdges, applyVellum, applyWorldBounds } from "./render/vellum";
import { createAxes } from "./render/axes";
import { FootprintTrail } from "./render/footprints";
import {
  attachFurShells,
  DEFAULT_FUR_LENGTH,
  DEFAULT_NOISE_FREQ,
  detachFurShells,
  type FurState,
  updateFurParams,
} from "./render/furShells";
import { InstancedBoidsField } from "./sim/instancedBoids";
import { WORLD_R_BABYLON } from "./scale";

async function createEngine(canvas: HTMLCanvasElement): Promise<Engine | WebGPUEngine> {
  const supportsWebGPU = await WebGPUEngine.IsSupportedAsync;
  if (!supportsWebGPU) {
    throw new Error(
      "WebGPU not supported in this browser. Try Chrome, Edge, or Safari Technology Preview.",
    );
  }
  const engine = new WebGPUEngine(canvas, { antialias: true, stencil: true });
  await engine.initAsync();
  return engine;
}

function showBootError(msg: string): void {
  const el = document.getElementById("boot-error");
  if (!el) return;
  el.textContent = msg;
  el.classList.add("visible");
}

function setupCamera(scene: Scene): ArcRotateCamera {
  // Z-up: camera orbits around +Z. alpha is the heading around +Z;
  // beta is the angle from +Z (β = π/2 → horizon, β = 0 → straight down).
  const cam = new ArcRotateCamera(
    "cam",
    -Math.PI / 2,         // looking from -Y toward origin
    Math.PI / 2.6,        // ~21° above horizon
    WORLD_R_BABYLON * 2.6,
    new Vector3(0, 0, WORLD_R_BABYLON * 0.05),
    scene,
  );
  cam.upVector = new Vector3(0, 0, 1);
  cam.lowerRadiusLimit = WORLD_R_BABYLON * 0.6;
  cam.upperRadiusLimit = 400;          // far enough to frame the full boid flock
  cam.lowerBetaLimit = 0.15;
  cam.upperBetaLimit = Math.PI / 2.05;
  cam.attachControl(true);
  cam.wheelDeltaPercentage = 0.05;     // ~5% per scroll tick, scales w/ current zoom
  cam.pinchDeltaPercentage = 0.05;
  cam.panningSensibility = 0;
  return cam;
}

function statsLine(stats: { hp: number; atk: number; mag: number }): string {
  return `<span>HP</span><b>${stats.hp}</b><span>ATK</span><b>${stats.atk}</b><span>MAG</span><b>${stats.mag}</b>`;
}

function updateCharacterCard(unit: Unit): void {
  const $ = (id: string) => document.getElementById(id);
  const cName = $("cName");
  const cEpithet = $("cEpithet");
  const cMeta = $("cMeta");
  const cStats = $("cStats");
  if (cName) cName.textContent = unit.name;
  if (cEpithet) cEpithet.textContent = unit.epithet;
  if (cMeta) {
    const teamLabel = unit.teamIndex === 0 ? "Team A" : "Team B";
    const gaits = unit.availableGaits.join("/");
    cMeta.textContent = `${teamLabel} · ${unit.archetype} · ${unit.faction} · ${unit.personality} · ${gaits} · ${unit.formationRole}`;
  }
  if (cStats) cStats.innerHTML = statsLine(unit.stats);
}

function renderRoster(roster: Roster, activeIdx: number, onPick: (i: number) => void): void {
  const root = document.getElementById("roster");
  if (!root) return;
  root.innerHTML = "";
  let globalIdx = 0;
  for (const team of roster.teams) {
    const block = document.createElement("div");
    block.className = "team-block";
    const header = document.createElement("div");
    header.className = "team-header";
    const teamColor = `hsl(${team.baseHue} 60% 55%)`;
    header.innerHTML = `
      <span class="team-stripe" style="background: ${teamColor}"></span>
      <span class="team-name">Team ${team.index === 0 ? "A" : "B"} · ${team.name}</span>
      <span class="team-meta">${team.factions.join(" · ")}</span>
    `;
    block.appendChild(header);
    const grid = document.createElement("div");
    grid.className = "team-grid";
    for (const unit of team.units) {
      const tile = document.createElement("div");
      tile.className = "roster-tile" + (globalIdx === activeIdx ? " active" : "");
      tile.dataset.idx = String(globalIdx);
      tile.innerHTML = `
        <div class="tile-stripe" style="background: ${unit.palette.primary}"></div>
        <div class="tile-name">${unit.name}</div>
        <div class="tile-meta">${unit.archetype} · ${unit.personality}</div>
      `;
      const idxCapture = globalIdx;
      tile.addEventListener("click", () => onPick(idxCapture));
      grid.appendChild(tile);
      globalIdx++;
    }
    block.appendChild(grid);
    root.appendChild(block);
  }
}

function setRosterActive(activeIdx: number): void {
  const root = document.getElementById("roster");
  if (!root) return;
  for (const tile of root.querySelectorAll<HTMLElement>(".roster-tile")) {
    const idx = Number(tile.dataset.idx);
    tile.classList.toggle("active", idx === activeIdx);
  }
}

function buildButtonRow(
  containerId: string,
  items: readonly string[],
  initial: string,
  onClick: (name: string) => void,
): (active: string) => void {
  const root = document.getElementById(containerId);
  if (!root) return () => {};
  root.innerHTML = "";
  const buttons: HTMLButtonElement[] = [];
  for (const name of items) {
    const b = document.createElement("button");
    b.textContent = name;
    b.dataset.name = name;
    if (name === initial) b.classList.add("active");
    b.addEventListener("click", () => onClick(name));
    root.appendChild(b);
    buttons.push(b);
  }
  return (active: string) => {
    for (const b of buttons) {
      b.classList.toggle("active", b.dataset.name === active);
    }
  };
}

async function main(): Promise<void> {
  const canvas = document.getElementById("canvas") as HTMLCanvasElement;
  let engine: Engine | WebGPUEngine;
  try {
    engine = await createEngine(canvas);
  } catch (err) {
    showBootError((err as Error).message);
    return;
  }

  const scene = new Scene(engine);
  scene.useRightHandedSystem = true;
  scene.clearColor.set(0.937, 0.914, 0.863, 1);
  scene.ambientColor = new Color3(1, 1, 1);

  setupCamera(scene);
  applyVellum(scene, { worldR: WORLD_R_BABYLON });

  // World/sim bounds.
  const WORLD_HALF_EXTENT = 25;
  applyWorldBounds(scene, WORLD_HALF_EXTENT);

  let current: CharacterMesh | null = null;
  let roster: Roster = { teams: [null as unknown as Team, null as unknown as Team], units: [] };
  let activeIdx = 0;
  const driver = makeDriverState("walk", presetMood("neutral"));
  const lookState = makeLookState();

  // ── Raccoon shape controls ───────────────────────────────────────
  // Sliders edit the global recipe; activateUnit rebuilds the active
  // mesh whenever a knob moves. Each roster pick keeps its palette and
  // personality from the base unit; the mesh shape is slider-driven.
  interface RaccoonControls {
    bodyScale: number;
    bodyLength: number;  // x-axis (forward) stretch on body bands
    bodyWidth: number;   // y-axis (lateral) stretch on body bands
    bodyOverlap: number; // 0..0.85 — band ellipsoid overlap
    bodyPeak: number;    // 0.15..0.85 — pear↔apple bulge position
    headScale: number;
    earSize: number;
    earSpread: number;
    eyeSpread: number;
    mask: number;
    armLength: number;
    armRadius: number;
    armDroop: number;
  }
  const raccoonControls: RaccoonControls = {
    bodyScale: 1.0,
    bodyLength: 1.0,
    bodyWidth: 1.0,
    bodyOverlap: 0.65,
    bodyPeak: 0.5,
    headScale: 1.0,
    earSize: 1.0,
    earSpread: 1.0,
    eyeSpread: 1.0,
    mask: 0.55,
    armLength: 1.0,
    armRadius: 1.0,
    armDroop: 0.45,
  };
  /** Build the slider-driven base spec. Per-unit biases (archetype, tier,
   *  personality) are layered on top by specFromUnit at activation time. */
  function baseSpecFromControls(c: RaccoonControls): RaccoonSpec {
    const spec = defaultRaccoonSpec();
    const thicknesses = RACCOON_DEFAULTS.bodyThick.map((t) => t * c.bodyScale);
    spec.body = buildBodyBands(
      thicknesses,
      c.bodyPeak,
      c.bodyOverlap,
      RACCOON_DEFAULTS.baseRx,
      c.bodyScale * c.bodyLength,
      c.bodyScale * c.bodyWidth,
    );
    for (const b of spec.head) {
      b.rx *= c.headScale;
      b.ry *= c.headScale;
      b.thickness *= c.headScale;
    }
    spec.ears.size *= c.earSize;
    spec.ears.spread *= c.earSpread;
    spec.arms.length *= c.armLength;
    spec.arms.radius *= c.armRadius;
    spec.arms.droop = c.armDroop;
    spec.eyes.spread *= c.eyeSpread;
    spec.maskStrength = c.mask;
    spec.bodyOverlap = c.bodyOverlap;
    spec.bodyPeak = c.bodyPeak;
    return spec;
  }

  type ViewMode = "track" | "boids";
  let viewMode: ViewMode = "track";
  const boidsField = new InstancedBoidsField(scene, { bounds: WORLD_HALF_EXTENT });
  let boidCount = 60;

  /** Build the unit list passed to the boid field. Each roster unit is
   *  wrapped as a raccoon (per-unit biases applied) so the boid mesh
   *  builder finds `unit.raccoon` populated. */
  function raccoonifiedUnits(): Unit[] {
    const baseSpec = baseSpecFromControls(raccoonControls);
    return roster.units.map((u) => asRaccoon(u, specFromUnit(u, baseSpec)));
  }

  function activateUnit(idx: number): void {
    if (idx < 0 || idx >= roster.units.length) return;
    if (current) {
      // Fur shells are children of current.root and the fur materials
      // are root.material — both get disposed by the recursive +
      // material-disposing dispose() below. Only the original (pre-fur)
      // StandardMaterial we stashed in furState is orphaned, so dispose
      // it explicitly to avoid leaking GPU buffers across activations.
      if (furState) {
        furState.originalMaterial?.dispose();
        furState = null;
      }
      current.root.dispose(false, true);
      current.rig.skeleton.dispose();
      current = null;
    }
    activeIdx = idx;
    const baseUnit = roster.units[idx];
    const baseSpec = baseSpecFromControls(raccoonControls);
    const unit = asRaccoon(baseUnit, specFromUnit(baseUnit, baseSpec));
    updateCharacterCard(unit);
    setRosterActive(activeIdx);
    if (viewMode === "track") {
      const ch = buildCharacter(unit, scene);
      if (inkOn) applyInkEdges(ch);
      current = ch;
      attachWalkerAxes();
      if (furOn) furState = attachFurShells(ch, scene, { furLength, noiseFreq: furDensity });
    }
  }

  function rerollRoster(seed: string): void {
    roster = generateTeams(seed);
    renderRoster(roster, 0, activateUnit);
    activateUnit(0);
    if (viewMode === "boids") {
      boidsField.dispose();
      boidsField.setCount(boidCount, raccoonifiedUnits());
      const insp = document.getElementById("boidInspector");
      if (insp) insp.style.display = "none";
    }
  }

  function setViewMode(mode: ViewMode): void {
    if (mode === viewMode) return;
    viewMode = mode;
    setViewModeActive(mode);
    const flockPanel = document.getElementById("flockPanel");
    if (flockPanel) flockPanel.style.display = mode === "boids" ? "" : "none";
    const insp = document.getElementById("boidInspector");
    if (insp) insp.style.display = "none";
    if (mode === "track") {
      boidsField.dispose();
      activateUnit(activeIdx);
    } else {
      if (current) {
        if (furState) {
          furState.originalMaterial?.dispose();
          furState = null;
        }
        current.root.dispose(false, true);
        current.rig.skeleton.dispose();
        current = null;
      }
      walkerAxes?.dispose();
      walkerAxes = null;
      boidsField.setCount(boidCount, raccoonifiedUnits());
    }
  }

  let seedCounter = Date.now();

  // Axes — world-frame at origin, walker-frame parented to character.
  const worldAxes = createAxes(scene, WORLD_R_BABYLON * 0.4);
  worldAxes.setVisible(false);
  let walkerAxes: ReturnType<typeof createAxes> | null = null;
  function attachWalkerAxes(): void {
    if (!current) return;
    walkerAxes?.dispose();
    walkerAxes = createAxes(scene, current.height * 0.7, current.root, 1.0);
    walkerAxes.setVisible(axesOn);
  }
  let axesOn = false;
  function setAxes(on: boolean): void {
    axesOn = on;
    worldAxes.setVisible(on);
    walkerAxes?.setVisible(on);
    const btn = document.getElementById("btnAxes");
    if (btn) btn.classList.toggle("active", on);
  }

  // Footprint trail (off by default).
  const footprints = new FootprintTrail(scene);
  let printsOn = false;
  footprints.setVisible(false);
  function setPrints(on: boolean): void {
    printsOn = on;
    footprints.setVisible(on);
    if (!on) footprints.clear();
    const btn = document.getElementById("btnPrints");
    if (btn) btn.classList.toggle("active", on);
  }

  // Ink edges (off by default — the smooth blending reads better without them).
  let inkOn = false;
  function setInk(on: boolean): void {
    inkOn = on;
    if (current) {
      if (on) applyInkEdges(current);
      else current.root.disableEdgesRendering();
    }
    const btn = document.getElementById("btnInk");
    if (btn) btn.classList.toggle("active", on);
  }

  // Pause: freezes both walker and boid sim updates. We also skip
  // scene.render() itself on paused frames unless something changed —
  // otherwise JS submits GPU command buffers at full RAF speed (no
  // CPU sim work to pace it), the WebGPU command queue floods past
  // what the GPU can drain, and the OS compositor stalls. The result
  // is the whole machine crawling at 5 fps even though Babylon's JS
  // FPS counter happily reports 85+.
  let paused = false;
  let pausedNeedsRender = true;
  function markPausedDirty(): void { pausedNeedsRender = true; }
  function setPaused(on: boolean): void {
    paused = on;
    pausedNeedsRender = true; // render the pause-moment frame at least
    const btn = document.getElementById("btnPause");
    if (btn) {
      btn.classList.toggle("active", on);
      btn.textContent = on ? "play" : "pause";
    }
  }

  // Shell fur (off by default). Track-mode only; boids rebuild their
  // own decomposed meshes via the instanced field. Length + density
  // are tunable via sliders; the values are kept in scope so re-attach
  // (after roster switch / view-mode change) preserves the user's pick.
  let furOn = false;
  let furState: FurState | null = null;
  let furLength = DEFAULT_FUR_LENGTH;
  let furDensity = DEFAULT_NOISE_FREQ;
  // Boid-mode shell count is tunable from the UI: shell fur is
  // fillrate-bound, and at large flock counts every shell costs real
  // frame time. Default is conservative (4); user can dial up for
  // smaller flocks or down to find the perf knee.
  let boidShellCount = 4;
  function boidFurOpts(): { furLength: number; noiseFreq: number; shellCount: number } {
    return { furLength, noiseFreq: furDensity, shellCount: boidShellCount };
  }
  function setFur(on: boolean): void {
    furOn = on;
    if (current && viewMode === "track") {
      if (on && !furState) {
        furState = attachFurShells(current, scene, { furLength, noiseFreq: furDensity });
      } else if (!on && furState) {
        detachFurShells(current, furState);
        furState = null;
      }
    }
    // Boids manage their own per-source fur state internally; we just
    // tell the field to flip. Works in both view modes — even when the
    // user is in track mode, the field remembers the flag and applies
    // it the moment we enter boids.
    boidsField.setFur(on, boidFurOpts());
    const btn = document.getElementById("btnFur");
    if (btn) btn.classList.toggle("active", on);
  }
  function setFurLength(v: number): void {
    furLength = v;
    if (furState) updateFurParams(furState, { furLength: v });
    boidsField.updateFurParams({ furLength: v });
  }
  function setFurDensity(v: number): void {
    furDensity = v;
    if (furState) updateFurParams(furState, { noiseFreq: v });
    boidsField.updateFurParams({ noiseFreq: v });
  }
  function setBoidShellCount(v: number): void {
    boidShellCount = Math.max(1, Math.min(16, Math.round(v)));
    // Shell count changes require rebuilding the shell stack (clones
    // = shellCount-1). Force a re-attach via setFur.
    if (furOn) {
      boidsField.setFur(true, boidFurOpts());
      // While paused, no stepAnimate runs to populate the new shells'
      // per-LOD counts — kick a single zero-dt step so the rebuilt
      // shells get sorted+counted right away.
      if (paused && viewMode === "boids") boidsField.stepAnimate(0);
    }
  }
  // Fur LOD distance window — same babylon-meter scale used elsewhere.
  let furLodNear = 6.0;
  let furLodFar = 20.0;
  function setFurLodNear(v: number): void {
    furLodNear = v;
    if (furLodFar <= furLodNear) furLodFar = furLodNear + 0.5;
    boidsField.setFurLodRange(furLodNear, furLodFar);
    // While paused, the boid step is skipped so LOD wouldn't otherwise
    // refresh. Run a single zero-dt step here to re-sort the matrix
    // buffers and update per-shell counts so the new range takes
    // effect immediately.
    if (paused && viewMode === "boids") boidsField.stepAnimate(0);
  }
  function setFurLodFar(v: number): void {
    furLodFar = Math.max(v, furLodNear + 0.5);
    boidsField.setFurLodRange(furLodNear, furLodFar);
    if (paused && viewMode === "boids") boidsField.stepAnimate(0);
  }
  boidsField.setFurLodRange(furLodNear, furLodFar);

  // Initial roster — generated AFTER the axes plumbing so attachWalkerAxes
  // can find the freshly-built character.
  rerollRoster(String(seedCounter));

  const setGaitActive = buildButtonRow("gaitRow", Object.keys(GAITS), driver.gaitName, (name) => {
    driver.gaitName = name as keyof typeof GAITS;
    setGaitActive(name);
  });

  // Mood: preset buttons + axis sliders, kept in sync.
  const sliders = new Map<MoodAxis, { input: HTMLInputElement; val: HTMLElement }>();
  function buildMoodSliders(): void {
    const root = document.getElementById("moodSliders");
    if (!root) return;
    root.innerHTML = "";
    for (const axis of MOOD_AXES) {
      const row = document.createElement("div");
      row.className = "slider-row";
      row.innerHTML = `
        <span class="slider-label">${axis}</span>
        <input type="range" min="-100" max="100" value="0" data-axis="${axis}" />
        <span class="slider-val">+0.00</span>
      `;
      root.appendChild(row);
      const input = row.querySelector("input") as HTMLInputElement;
      const val = row.querySelector(".slider-val") as HTMLElement;
      sliders.set(axis, { input, val });
      input.addEventListener("input", () => {
        const v = parseFloat(input.value) / 100;
        driver.mood[axis] = v;
        val.textContent = (v >= 0 ? "+" : "") + v.toFixed(2);
        // Free-form sliders deactivate any preset highlight.
        const moodRow = document.getElementById("moodRow");
        moodRow?.querySelectorAll<HTMLElement>("button").forEach((b) =>
          b.classList.remove("active"),
        );
      });
    }
  }
  buildMoodSliders();

  function syncSlidersFromMood(): void {
    for (const axis of MOOD_AXES) {
      const e = sliders.get(axis);
      if (!e) continue;
      const v = driver.mood[axis];
      e.input.value = String(Math.round(v * 100));
      e.val.textContent = (v >= 0 ? "+" : "") + v.toFixed(2);
    }
  }

  const setMoodActive = buildButtonRow(
    "moodRow",
    Object.keys(PRESETS),
    "neutral",
    (name) => {
      driver.mood = presetMood(name as keyof typeof PRESETS);
      syncSlidersFromMood();
      setMoodActive(name);
    },
  );
  syncSlidersFromMood();

  const reroll = document.getElementById("btnReroll");
  if (reroll) {
    reroll.addEventListener("click", () => {
      seedCounter += 1;
      rerollRoster(String(seedCounter));
    });
  }

  // ── Raccoon controls ─────────────────────────────────────────────
  interface SliderDef {
    key: keyof RaccoonControls;
    label: string;
    min: number;
    max: number;
    step: number;
  }
  const RACCOON_SLIDERS: SliderDef[] = [
    { key: "bodyScale",     label: "body",     min: 0.6, max: 1.6, step: 0.01 },
    { key: "bodyLength",    label: "body x",   min: 0.6, max: 1.6, step: 0.01 },
    { key: "bodyWidth",     label: "body y",   min: 0.6, max: 1.6, step: 0.01 },
    { key: "bodyOverlap",   label: "overlap",  min: 0.0, max: 0.85, step: 0.01 },
    { key: "bodyPeak",      label: "pear↔apple", min: 0.15, max: 0.85, step: 0.01 },
    { key: "headScale",     label: "head",     min: 0.6, max: 1.6, step: 0.01 },
    { key: "earSize",       label: "ears",     min: 0.0, max: 2.0, step: 0.01 },
    { key: "earSpread",     label: "ear sep",  min: 0.4, max: 1.6, step: 0.01 },
    { key: "armLength",     label: "arm len",  min: 0.0, max: 2.0, step: 0.01 },
    { key: "armRadius",     label: "arm fat",  min: 0.3, max: 2.0, step: 0.01 },
    { key: "armDroop",      label: "arm droop",min: 0.0, max: 1.4, step: 0.01 },
    { key: "eyeSpread",     label: "eye sep",  min: 0.3, max: 1.6, step: 0.01 },
    { key: "mask",          label: "mask",     min: 0.0, max: 1.0, step: 0.01 },
  ];
  const raccoonSliderEls = new Map<keyof RaccoonControls, { input: HTMLInputElement; val: HTMLElement }>();

  function buildRaccoonSliders(): void {
    const root = document.getElementById("raccoonSliders");
    if (!root) return;
    root.innerHTML = "";
    for (const def of RACCOON_SLIDERS) {
      const row = document.createElement("div");
      row.className = "slider-row";
      row.innerHTML = `
        <span class="slider-label">${def.label}</span>
        <input type="range" min="${def.min}" max="${def.max}" step="${def.step}" />
        <span class="slider-val"></span>
      `;
      root.appendChild(row);
      const input = row.querySelector("input") as HTMLInputElement;
      const val = row.querySelector(".slider-val") as HTMLElement;
      input.value = String(raccoonControls[def.key]);
      val.textContent = raccoonControls[def.key].toFixed(2);
      raccoonSliderEls.set(def.key, { input, val });
      input.addEventListener("input", () => {
        const v = parseFloat(input.value);
        raccoonControls[def.key] = v;
        val.textContent = v.toFixed(2);
        if (viewMode === "track") activateUnit(activeIdx);
      });
    }
  }
  function syncRaccoonSliders(): void {
    for (const def of RACCOON_SLIDERS) {
      const e = raccoonSliderEls.get(def.key);
      if (!e) continue;
      const v = raccoonControls[def.key];
      e.input.value = String(v);
      e.val.textContent = v.toFixed(2);
    }
  }
  buildRaccoonSliders();

  const raccoonResetBtn = document.getElementById("btnRaccoonReset");
  if (raccoonResetBtn) {
    raccoonResetBtn.addEventListener("click", () => {
      raccoonControls.bodyScale = 1.0;
      raccoonControls.bodyLength = 1.0;
      raccoonControls.bodyWidth = 1.0;
      raccoonControls.bodyOverlap = 0.65;
      raccoonControls.bodyPeak = 0.5;
      raccoonControls.headScale = 1.0;
      raccoonControls.earSize = 1.0;
      raccoonControls.earSpread = 1.0;
      raccoonControls.eyeSpread = 1.0;
      raccoonControls.mask = 0.55;
      raccoonControls.armLength = 1.0;
      raccoonControls.armRadius = 1.0;
      raccoonControls.armDroop = 0.45;
      syncRaccoonSliders();
      if (viewMode === "track") activateUnit(activeIdx);
    });
  }

  const axesBtn = document.getElementById("btnAxes");
  if (axesBtn) {
    axesBtn.addEventListener("click", () => setAxes(!axesOn));
  }

  const printsBtn = document.getElementById("btnPrints");
  if (printsBtn) {
    printsBtn.addEventListener("click", () => setPrints(!printsOn));
  }

  // View mode (track / boids).
  const setViewModeActive = buildButtonRow(
    "viewModeRow",
    ["track", "boids"] as const,
    viewMode,
    (name) => setViewMode(name as ViewMode),
  );

  // Flock count slider.
  const boidSlider = document.getElementById("boidCount") as HTMLInputElement | null;
  const boidVal = document.getElementById("boidCountVal");
  if (boidSlider && boidVal) {
    boidSlider.addEventListener("input", () => {
      boidCount = parseInt(boidSlider.value, 10);
      boidVal.textContent = String(boidCount);
      if (viewMode === "boids") boidsField.setCount(boidCount, raccoonifiedUnits());
    });
  }

  const inkBtn = document.getElementById("btnInk");
  if (inkBtn) {
    inkBtn.addEventListener("click", () => setInk(!inkOn));
  }

  const furBtn = document.getElementById("btnFur");
  if (furBtn) {
    furBtn.addEventListener("click", () => setFur(!furOn));
  }

  const pauseBtn = document.getElementById("btnPause");
  if (pauseBtn) {
    pauseBtn.addEventListener("click", () => setPaused(!paused));
  }
  // Spacebar also toggles pause — handy during stress-testing without
  // hunting for the button in the sidebar.
  window.addEventListener("keydown", (e) => {
    if (e.code === "Space" && e.target === document.body) {
      e.preventDefault();
      setPaused(!paused);
    }
  });

  // Fur sliders — length is shown in mm for legibility (×1000), density
  // is the raw noise frequency. Both update live when fur is on, and
  // the values persist across toggles / roster switches.
  const furLenInput = document.getElementById("furLength") as HTMLInputElement | null;
  const furLenVal = document.getElementById("furLengthVal");
  if (furLenInput && furLenVal) {
    furLenInput.value = String(furLength);
    furLenVal.textContent = (furLength * 1000).toFixed(0) + " mm";
    furLenInput.addEventListener("input", () => {
      const v = parseFloat(furLenInput.value);
      setFurLength(v);
      furLenVal.textContent = (v * 1000).toFixed(0) + " mm";
    });
  }
  const furDenInput = document.getElementById("furDensity") as HTMLInputElement | null;
  const furDenVal = document.getElementById("furDensityVal");
  if (furDenInput && furDenVal) {
    furDenInput.value = String(furDensity);
    furDenVal.textContent = furDensity.toFixed(0);
    furDenInput.addEventListener("input", () => {
      const v = parseFloat(furDenInput.value);
      setFurDensity(v);
      furDenVal.textContent = v.toFixed(0);
    });
  }
  // Boid shell count — perf knob. Use "change" not "input" so the user
  // commits the value (a rebuild fires per change; firing every "input"
  // event would thrash through dozens of detach/attach cycles in a
  // single drag).
  const furShellInput = document.getElementById("furShells") as HTMLInputElement | null;
  const furShellVal = document.getElementById("furShellsVal");
  if (furShellInput && furShellVal) {
    furShellInput.value = String(boidShellCount);
    furShellVal.textContent = String(boidShellCount);
    furShellInput.addEventListener("input", () => {
      furShellVal.textContent = furShellInput.value;
    });
    furShellInput.addEventListener("change", () => {
      const v = parseInt(furShellInput.value, 10);
      setBoidShellCount(v);
    });
  }
  const furNearInput = document.getElementById("furLodNear") as HTMLInputElement | null;
  const furNearVal = document.getElementById("furLodNearVal");
  if (furNearInput && furNearVal) {
    furNearInput.value = String(furLodNear);
    furNearVal.textContent = furLodNear.toFixed(1) + " m";
    furNearInput.addEventListener("input", () => {
      const v = parseFloat(furNearInput.value);
      setFurLodNear(v);
      furNearVal.textContent = v.toFixed(1) + " m";
    });
  }
  const furFarInput = document.getElementById("furLodFar") as HTMLInputElement | null;
  const furFarVal = document.getElementById("furLodFarVal");
  if (furFarInput && furFarVal) {
    furFarInput.value = String(furLodFar);
    furFarVal.textContent = furLodFar.toFixed(1) + " m";
    furFarInput.addEventListener("input", () => {
      const v = parseFloat(furFarInput.value);
      setFurLodFar(v);
      furFarVal.textContent = furLodFar.toFixed(1) + " m";
    });
  }

  // Debug overlay: per-boid separation-radius rings.
  let radiiOn = false;
  function setRadii(on: boolean): void {
    radiiOn = on;
    boidsField.setRadiiVisible(on);
    const btn = document.getElementById("btnRadii");
    if (btn) btn.classList.toggle("active", on);
  }
  const radiiBtn = document.getElementById("btnRadii");
  if (radiiBtn) {
    radiiBtn.addEventListener("click", () => setRadii(!radiiOn));
  }

  // ── Click-to-inspect a boid ──
  // Pointerdown picks the nearest boid under the cursor (z=0 plane raycast,
  // O(n) over boids). Drag-then-release shouldn't pick — only treat as a
  // click if the pointer didn't move much between down and up.
  const inspectorEl = document.getElementById("boidInspector");
  const biName = document.getElementById("biName");
  const biGrid = document.getElementById("biGrid");
  let downX = 0, downY = 0, downT = 0;
  canvas.addEventListener("pointerdown", (e) => {
    downX = e.clientX;
    downY = e.clientY;
    downT = performance.now();
  });
  canvas.addEventListener("pointerup", (e) => {
    if (viewMode !== "boids") return;
    const dx = e.clientX - downX;
    const dy = e.clientY - downY;
    if (dx * dx + dy * dy > 25) return;             // moved too far → drag
    if (performance.now() - downT > 400) return;    // held too long → drag
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const picked = boidsField.pickAt(x, y);
    boidsField.setSelected(picked);
    if (inspectorEl) inspectorEl.style.display = picked ? "" : "none";
  });

  function updateInspector(): void {
    const b = boidsField.selected;
    if (!b || !biName || !biGrid) return;
    const speed = Math.hypot(b.vel.x, b.vel.y);
    const headingDeg = (b.heading * 180 / Math.PI).toFixed(0);
    const ctxStr = b.context === b.pendingContext
      ? b.context
      : `${b.context}→${b.pendingContext} (${b.pendingFrames})`;
    biName.textContent = `${b.unit.name} · T${b.unit.teamIndex === 0 ? "A" : "B"}`;
    biGrid.innerHTML =
      `<span>arch</span><b>${b.archetype}</b>` +
      `<span>faction</span><b>${b.factionKey}</b>` +
      `<span>person</span><b>${b.unit.personality}</b>` +
      `<span>context</span><b>${ctxStr}</b>` +
      `<span>gait</span><b>${b.currentGait}</b>` +
      `<span>mood</span><b>${b.targetMood}</b>` +
      `<span>speed</span><b>${speed.toFixed(2)} / ${(b.traits.maxSpeed * b.unitSpeedMul).toFixed(2)}</b>` +
      `<span>heading</span><b>${headingDeg}°</b>` +
      `<span>pos</span><b>${b.pos.x.toFixed(1)}, ${b.pos.y.toFixed(1)}</b>` +
      `<span>sepR</span><b>${b.separateR.toFixed(2)}</b>`;
  }

  const cam = scene.activeCamera as ArcRotateCamera;
  // Camera input while paused needs to drive a redraw — but
  // Camera.onViewMatrixChangedObservable only fires from inside
  // scene.render(), so it's a deadlock if we use it as the redraw
  // trigger. Hook the actual canvas DOM events instead. Pointer drag
  // (rotate / pan), wheel (dolly), and key events all mark dirty so
  // the next paused frame submits a render.
  const markDirtyHandler = (): void => markPausedDirty();
  canvas.addEventListener("pointerdown", markDirtyHandler);
  canvas.addEventListener("pointermove", markDirtyHandler);
  canvas.addEventListener("wheel", markDirtyHandler, { passive: true });
  canvas.addEventListener("keydown", markDirtyHandler);
  // Any sidebar input or button click can change visible state
  // (sliders alter material uniforms or instance counts, buttons
  // toggle modes/overlays).
  const panelEl = document.getElementById("panel");
  if (panelEl) {
    panelEl.addEventListener("input", markDirtyHandler);
    panelEl.addEventListener("click", markDirtyHandler);
  }

  // Frame-time HUD with split metrics:
  //   total  — rolling 60-frame interval (drives fps + slow)
  //   sim    — CPU time spent in our per-frame logic (driver / boids step)
  //   draw   — CPU time spent inside scene.render() (Babylon submission)
  //   gpu    — GPU time from Babylon's perf counter (WebGPU timestamp queries)
  const FPS_BUFFER = 60;
  const totalMsBuf = new Float32Array(FPS_BUFFER);
  const flockMsBuf = new Float32Array(FPS_BUFFER);
  const animMsBuf = new Float32Array(FPS_BUFFER);
  const drawMsBuf = new Float32Array(FPS_BUFFER);
  let frameIdx = 0;
  let frameFilled = 0;
  let perfTick = 0;
  const perfEl = document.getElementById("perf");

  // Enable GPU frame-time capture. The setter is exposed as a method on
  // some Babylon versions, so we call it via a permissive cast.
  const eng = engine as unknown as {
    captureGPUFrameTime?: ((v: boolean) => void) | boolean;
  };
  if (typeof eng.captureGPUFrameTime === "function") {
    eng.captureGPUFrameTime(true);
  } else {
    eng.captureGPUFrameTime = true;
  }

  let last = performance.now();
  engine.runRenderLoop(() => {
    const now = performance.now();
    const rawDt = (now - last) / 1000;
    // Pause freezes sim/animation but lets render continue so the
    // camera still works. We also clamp `last` to now so the dt on
    // resume isn't a giant catch-up step.
    const dt = paused ? 0 : Math.min(0.064, rawDt);
    last = now;
    let flockMs = 0;
    let animMs = 0;
    if (paused) {
      // Sim/animation updates skipped. LOD-driven fur counts are
      // re-evaluated only when the user changes a slider that affects
      // them (the slider handlers call boidsField.stepAnimate(0)
      // directly). Running a zero-dt step every paused frame would
      // burn CPU repacking unchanged matrices.
    } else if (viewMode === "track") {
      const t0 = performance.now();
      if (current) {
        const lookMix = current.unit.raccoon?.lookMix ?? {
          idle: 0.5, camera: 0.25, influence: 0.25,
        };
        const camPos = cam.globalPosition;
        const headYaw = stepLook(
          lookState,
          {
            cx: current.root.position.x,
            cy: current.root.position.y,
            heading: current.root.rotation.z,
            camX: camPos.x,
            camY: camPos.y,
            influenceX: 0,
            influenceY: 0,
            mix: lookMix,
          },
          dt,
        );
        updateDriver(current, driver, dt, {
          onPlant: printsOn
            ? (side, x, y, h) => footprints.addPrint(side, x, y, h)
            : undefined,
          headYaw,
        });
      }
      animMs = performance.now() - t0;
    } else {
      const t0 = performance.now();
      boidsField.stepFlock(dt);
      const t1 = performance.now();
      boidsField.stepAnimate(dt);
      const t2 = performance.now();
      flockMs = t1 - t0;
      animMs = t2 - t1;
    }
    if (viewMode === "boids" && boidsField.selected) updateInspector();
    if (printsOn && viewMode === "track") footprints.update(dt);
    if (axesOn) {
      worldAxes.update(cam);
      walkerAxes?.update(cam);
    }
    const drawStart = performance.now();
    // When paused, only redraw if the user changed something visible
    // (camera, slider, fur toggle). Otherwise the GPU command queue
    // floods and the system stalls.
    if (!paused || pausedNeedsRender) {
      scene.render();
      pausedNeedsRender = false;
    }
    const drawEnd = performance.now();

    totalMsBuf[frameIdx] = rawDt * 1000;
    flockMsBuf[frameIdx] = flockMs;
    animMsBuf[frameIdx] = animMs;
    drawMsBuf[frameIdx] = drawEnd - drawStart;
    frameIdx = (frameIdx + 1) % FPS_BUFFER;
    if (frameFilled < FPS_BUFFER) frameFilled++;

    // Update perf HUD every ~10 frames so the readout doesn't flicker.
    perfTick++;
    if (perfEl && perfTick % 10 === 0) {
      let totalSum = 0, totalMax = 0;
      let flockSum = 0, animSum = 0, drawSum = 0;
      for (let i = 0; i < frameFilled; i++) {
        const t = totalMsBuf[i];
        totalSum += t;
        if (t > totalMax) totalMax = t;
        flockSum += flockMsBuf[i];
        animSum += animMsBuf[i];
        drawSum += drawMsBuf[i];
      }
      const totalAvg = totalSum / frameFilled;
      const flockAvg = flockSum / frameFilled;
      const animAvg = animSum / frameFilled;
      const drawAvg = drawSum / frameFilled;
      const fps = 1000 / totalAvg;

      const gpuCounter = (engine as { gpuFrameTimeCounter?: { lastSecAverage: number } })
        .gpuFrameTimeCounter;
      const gpuMs = gpuCounter && typeof gpuCounter.lastSecAverage === "number"
        ? gpuCounter.lastSecAverage / 1_000_000
        : -1;

      const count = viewMode === "boids" ? boidsField.count() : current ? 1 : 0;
      const gpuStr = gpuMs >= 0 ? `${gpuMs.toFixed(1)}` : "--";
      perfEl.textContent =
        `${fps.toFixed(0)}fps · flock ${flockAvg.toFixed(1)} · ` +
        `anim ${animAvg.toFixed(1)} · draw ${drawAvg.toFixed(1)} · ` +
        `gpu ${gpuStr}ms · slow ${totalMax.toFixed(0)}ms · n=${count}`;
    }
  });

  window.addEventListener("resize", () => engine.resize());
}

main().catch((err) => {
  console.error(err);
  showBootError(String((err as Error).message ?? err));
});

void MOOD_AXES;
