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

import { generateUnit } from "./character/generator";
import { makeRNG } from "./character/rng";
import { buildCharacter, type CharacterMesh } from "./character/mesh";
import { GAITS } from "./walker/gait";
import { MOOD_AXES, PRESETS, presetMood } from "./walker/mood";
import { makeDriverState, updateDriver, WORLD_R_WALKER } from "./walker/driver";
import { applyInkEdges, applyVellum } from "./render/vellum";
import { createAxes } from "./render/axes";

const UNIT_SCALE = 0.04;
const WORLD_R_BABYLON = WORLD_R_WALKER * UNIT_SCALE;

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

function updateCharacterCard(unit: ReturnType<typeof generateUnit>): void {
  const $ = (id: string) => document.getElementById(id);
  const cName = $("cName");
  const cEpithet = $("cEpithet");
  const cMeta = $("cMeta");
  const cStats = $("cStats");
  if (cName) cName.textContent = unit.name;
  if (cEpithet) cEpithet.textContent = unit.epithet;
  if (cMeta) cMeta.textContent = `${unit.archetype} · ${unit.faction} · TIER ${unit.tier}`;
  if (cStats) cStats.innerHTML = statsLine(unit.stats);
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
  const driver = makeDriverState("walk", presetMood("neutral"));

  function setCharacter(seed: string): void {
    if (current) {
      current.root.dispose(false, true);
      current.rig.skeleton.dispose();
      current = null;
    }
    const rng = makeRNG(seed);
    const unit = generateUnit(rng);
    const ch = buildCharacter(unit, scene);
    applyInkEdges(ch);
    current = ch;
    updateCharacterCard(unit);
  }

  let seedCounter = Date.now();
  setCharacter(String(seedCounter));

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
  attachWalkerAxes();

  const setGaitActive = buildButtonRow("gaitRow", Object.keys(GAITS), driver.gaitName, (name) => {
    driver.gaitName = name as keyof typeof GAITS;
    setGaitActive(name);
  });

  const setMoodActive = buildButtonRow(
    "moodRow",
    Object.keys(PRESETS),
    "neutral",
    (name) => {
      driver.mood = presetMood(name as keyof typeof PRESETS);
      setMoodActive(name);
    },
  );

  const reroll = document.getElementById("btnReroll");
  if (reroll) {
    reroll.addEventListener("click", () => {
      seedCounter += 1;
      setCharacter(String(seedCounter));
      attachWalkerAxes();
    });
  }

  const axesBtn = document.getElementById("btnAxes");
  if (axesBtn) {
    axesBtn.addEventListener("click", () => setAxes(!axesOn));
  }

  const cam = scene.activeCamera as ArcRotateCamera;
  let last = performance.now();
  engine.runRenderLoop(() => {
    const now = performance.now();
    const dt = Math.min(0.064, (now - last) / 1000);
    last = now;
    if (current) {
      updateDriver(current, driver, dt);
    }
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
