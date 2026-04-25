/**
 * Coordinate-axis gizmo. Lines are parented to the (optional) parent;
 * labels are unparented and manually positioned/oriented per frame, since
 * Babylon's billboard mode misbehaves under parented transforms.
 *
 * Call gizmo.update() once per frame after the character pose updates.
 */
import {
  Color3,
  DynamicTexture,
  type LinesMesh,
  Mesh,
  MeshBuilder,
  type Scene,
  StandardMaterial,
  TransformNode,
  Vector3,
} from "@babylonjs/core";

const AXIS_X = new Color3(0.78, 0.18, 0.18);
const AXIS_Y = new Color3(0.18, 0.55, 0.22);
const AXIS_Z = new Color3(0.18, 0.32, 0.7);

function color3ToCss(c: Color3): string {
  const r = Math.round(c.r * 255);
  const g = Math.round(c.g * 255);
  const b = Math.round(c.b * 255);
  return `rgb(${r},${g},${b})`;
}

function createLabelMesh(
  scene: Scene,
  text: string,
  color: Color3,
  size: number,
): Mesh {
  const plane = MeshBuilder.CreatePlane(`lbl_${text}`, { size }, scene);
  plane.isPickable = false;
  plane.renderingGroupId = 1;

  const tex = new DynamicTexture(
    `lbl_tex_${text}`,
    { width: 64, height: 64 },
    scene,
    false,
  );
  tex.hasAlpha = true;
  const ctx = tex.getContext() as CanvasRenderingContext2D;
  ctx.clearRect(0, 0, 64, 64);
  ctx.font = "bold 48px 'JetBrains Mono', monospace";
  ctx.fillStyle = color3ToCss(color);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, 32, 34);
  tex.update();

  const mat = new StandardMaterial(`lbl_mat_${text}`, scene);
  mat.diffuseTexture = tex;
  mat.opacityTexture = tex;
  mat.disableLighting = true;
  mat.emissiveColor = new Color3(1, 1, 1);
  mat.specularColor = new Color3(0, 0, 0);
  mat.backFaceCulling = false;
  plane.material = mat;
  return plane;
}

export interface AxesGizmo {
  root: TransformNode;
  setVisible(v: boolean): void;
  update(camera: { position: Vector3 }): void;
  dispose(): void;
}

export function createAxes(
  scene: Scene,
  length: number,
  parent?: TransformNode,
  alpha = 1.0,
): AxesGizmo {
  const root = new TransformNode("axes", scene);
  if (parent) root.parent = parent;
  const lines: LinesMesh[] = [];
  const labels: { mesh: Mesh; localEnd: Vector3 }[] = [];

  function axis(end: Vector3, color: Color3, label: string): void {
    const mesh = MeshBuilder.CreateLines(
      `axis_${label}`,
      { points: [Vector3.Zero(), end] },
      scene,
    );
    mesh.color = color;
    mesh.alpha = alpha;
    mesh.parent = root;
    mesh.isPickable = false;
    mesh.renderingGroupId = 1;
    lines.push(mesh);

    const labelSize = Math.max(0.18, length * 0.14);
    const labelOffset = end.normalizeToNew().scale(labelSize * 0.7);
    const localEnd = end.add(labelOffset);
    const labelMesh = createLabelMesh(scene, label, color, labelSize);
    labels.push({ mesh: labelMesh, localEnd });
  }

  axis(new Vector3(length, 0, 0), AXIS_X, "X");
  axis(new Vector3(0, length, 0), AXIS_Y, "Y");
  axis(new Vector3(0, 0, length), AXIS_Z, "Z");

  let visible = true;

  return {
    root,
    setVisible(v: boolean): void {
      if (v === visible) return;
      visible = v;
      for (const m of lines) m.isVisible = v;
      for (const l of labels) l.mesh.isVisible = v;
    },
    update(camera): void {
      if (!visible) return;
      const worldM = root.getWorldMatrix();
      for (const { mesh, localEnd } of labels) {
        const worldPos = Vector3.TransformCoordinates(localEnd, worldM);
        mesh.position.copyFrom(worldPos);
        // Plane's default normal is +Z; lookAt orients +Z toward camera.
        mesh.lookAt(camera.position);
      }
    },
    dispose(): void {
      for (const m of lines) m.dispose();
      for (const l of labels) l.mesh.dispose();
      root.dispose();
    },
  };
}
