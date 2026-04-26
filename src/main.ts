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
import { GAITS } from "./walker/gait";
import { MOOD_AXES, type MoodAxis, PRESETS, presetMood } from "./walker/mood";
import { makeDriverState, updateDriver } from "./walker/driver";
import { applyInkEdges, applyVellum, applyWorldBounds } from "./render/vellum";
import { createAxes } from "./render/axes";
import { FootprintTrail } from "./render/footprints";
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

  type ViewMode = "track" | "boids";
  let viewMode: ViewMode = "track";
  const boidsField = new InstancedBoidsField(scene, { bounds: WORLD_HALF_EXTENT });
  let boidCount = 60;

  function activateUnit(idx: number): void {
    if (idx < 0 || idx >= roster.units.length) return;
    if (current) {
      current.root.dispose(false, true);
      current.rig.skeleton.dispose();
      current = null;
    }
    activeIdx = idx;
    const unit = roster.units[idx];
    updateCharacterCard(unit);
    setRosterActive(activeIdx);
    if (viewMode === "track") {
      const ch = buildCharacter(unit, scene);
      if (inkOn) applyInkEdges(ch);
      current = ch;
      attachWalkerAxes();
    }
  }

  function rerollRoster(seed: string): void {
    roster = generateTeams(seed);
    renderRoster(roster, 0, activateUnit);
    activateUnit(0);
    if (viewMode === "boids") {
      boidsField.dispose();
      boidsField.setCount(boidCount, roster.units);
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
        current.root.dispose(false, true);
        current.rig.skeleton.dispose();
        current = null;
      }
      walkerAxes?.dispose();
      walkerAxes = null;
      boidsField.setCount(boidCount, roster.units);
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
      if (viewMode === "boids") boidsField.setCount(boidCount, roster.units);
    });
  }

  const inkBtn = document.getElementById("btnInk");
  if (inkBtn) {
    inkBtn.addEventListener("click", () => setInk(!inkOn));
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
    const dt = Math.min(0.064, rawDt);
    last = now;
    let flockMs = 0;
    let animMs = 0;
    if (viewMode === "track") {
      const t0 = performance.now();
      if (current) {
        updateDriver(current, driver, dt, {
          onPlant: printsOn
            ? (side, x, y, h) => footprints.addPrint(side, x, y, h)
            : undefined,
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
    scene.render();
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
