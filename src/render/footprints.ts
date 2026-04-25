/**
 * Fading footprint trail. Drops a small mark on the ground each time a
 * foot transitions from lifted to grounded; ages prints over a fixed
 * lifetime and disposes them.
 *
 * Useful for verifying the no-slip gait math — at constant gait, prints
 * should land at even angular spacing on the track. Slipping looks like
 * uneven spacing or smeared prints.
 */
import {
  Color3,
  Mesh,
  MeshBuilder,
  type Scene,
  StandardMaterial,
} from "@babylonjs/core";

interface Print {
  mesh: Mesh;
  age: number;
}

export class FootprintTrail {
  private prints: Print[] = [];
  private matL: StandardMaterial;
  private matR: StandardMaterial;
  private visible = true;

  constructor(
    private scene: Scene,
    private maxAge = 4.0,
    private maxCount = 80,
    private size = 0.07,
  ) {
    this.matL = this.makeMat("fpMatL", new Color3(0.18, 0.32, 0.7));
    this.matR = this.makeMat("fpMatR", new Color3(0.78, 0.18, 0.18));
  }

  private makeMat(name: string, color: Color3): StandardMaterial {
    const m = new StandardMaterial(name, this.scene);
    m.disableLighting = true;
    m.emissiveColor = color;
    m.specularColor = new Color3(0, 0, 0);
    m.backFaceCulling = false;
    return m;
  }

  addPrint(side: "L" | "R", x: number, y: number, headingZ: number): void {
    if (!this.visible) return;
    if (this.prints.length >= this.maxCount) {
      const old = this.prints.shift();
      old?.mesh.dispose();
    }
    const disc = MeshBuilder.CreateDisc(
      `fp_${side}`,
      { radius: this.size, tessellation: 14 },
      this.scene,
    );
    disc.material = side === "L" ? this.matL : this.matR;
    disc.position.set(x, y, 0.003);
    disc.rotation.set(0, 0, headingZ);
    disc.scaling.set(1.4, 0.6, 1);  // elliptical, long-axis along foot heading
    disc.isPickable = false;
    disc.renderingGroupId = 0;
    this.prints.push({ mesh: disc, age: 0 });
  }

  update(dt: number): void {
    for (let i = this.prints.length - 1; i >= 0; i--) {
      const p = this.prints[i];
      p.age += dt;
      if (p.age >= this.maxAge) {
        p.mesh.dispose();
        this.prints.splice(i, 1);
      } else {
        p.mesh.visibility = 1 - p.age / this.maxAge;
      }
    }
  }

  setVisible(v: boolean): void {
    this.visible = v;
    for (const p of this.prints) p.mesh.isVisible = v;
  }

  clear(): void {
    for (const p of this.prints) p.mesh.dispose();
    this.prints.length = 0;
  }
}
