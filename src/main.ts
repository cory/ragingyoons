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

import { generateRoster, type Unit } from "./character/generator";
import { buildCharacter, type CharacterMesh } from "./character/mesh";
import { GAITS } from "./walker/gait";
import { MOOD_AXES, type MoodAxis, PRESETS, presetMood } from "./walker/mood";
import { makeDriverState, updateDriver } from "./walker/driver";
import { applyInkEdges, applyVellum } from "./render/vellum";
import { createAxes } from "./render/axes";
import { FootprintTrail } from "./render/footprints";
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
  cam.upperRadiusLimit = WORLD_R_BABYLON * 5.0;
  cam.lowerBetaLimit = 0.15;
  cam.upperBetaLimit = Math.PI / 2.05;
  cam.attachControl(true);
  cam.wheelPrecision = 30;
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
  if (cMeta) cMeta.textContent = `${unit.archetype} · ${unit.faction} · T${unit.tier} · ${unit.paletteMode}`;
  if (cStats) cStats.innerHTML = statsLine(unit.stats);
}

function renderRoster(roster: Unit[], activeIdx: number, onPick: (i: number) => void): void {
  const root = document.getElementById("roster");
  if (!root) return;
  root.innerHTML = "";
  for (let i = 0; i < roster.length; i++) {
    const unit = roster[i];
    const tile = document.createElement("div");
    tile.className = "roster-tile" + (i === activeIdx ? " active" : "");
    tile.dataset.idx = String(i);
    tile.innerHTML = `
      <div class="tile-stripe" style="background: ${unit.palette.primary}"></div>
      <div class="tile-name">${unit.name}</div>
      <div class="tile-meta">${unit.archetype} · T${unit.tier}</div>
    `;
    tile.addEventListener("click", () => onPick(i));
    root.appendChild(tile);
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

  let current: CharacterMesh | null = null;
  let roster: Unit[] = [];
  let activeIdx = 0;
  const driver = makeDriverState("walk", presetMood("neutral"));

  function activateUnit(idx: number): void {
    if (idx < 0 || idx >= roster.length) return;
    if (current) {
      current.root.dispose(false, true);
      current.rig.skeleton.dispose();
      current = null;
    }
    activeIdx = idx;
    const unit = roster[idx];
    const ch = buildCharacter(unit, scene);
    if (inkOn) applyInkEdges(ch);
    current = ch;
    updateCharacterCard(unit);
    setRosterActive(activeIdx);
    attachWalkerAxes();
  }

  function rerollRoster(seed: string): void {
    roster = generateRoster(seed, 8);
    renderRoster(roster, 0, activateUnit);
    activateUnit(0);
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

  const inkBtn = document.getElementById("btnInk");
  if (inkBtn) {
    inkBtn.addEventListener("click", () => setInk(!inkOn));
  }

  const cam = scene.activeCamera as ArcRotateCamera;
  let last = performance.now();
  engine.runRenderLoop(() => {
    const now = performance.now();
    const dt = Math.min(0.064, (now - last) / 1000);
    last = now;
    if (current) {
      updateDriver(current, driver, dt, {
        onPlant: printsOn
          ? (side, x, y, h) => footprints.addPrint(side, x, y, h)
          : undefined,
      });
    }
    if (printsOn) footprints.update(dt);
    if (axesOn) {
      worldAxes.update(cam);
      walkerAxes?.update(cam);
    }
    scene.render();
  });

  window.addEventListener("resize", () => engine.resize());
}

main().catch((err) => {
  console.error(err);
  showBootError(String((err as Error).message ?? err));
});

void MOOD_AXES;
