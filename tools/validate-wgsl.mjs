#!/usr/bin/env node
/**
 * Local WGSL validator — extracts the /* wgsl *\/ template strings out
 * of a Babylon ShaderMaterial source file, translates Babylon's pseudo-
 * WGSL (attribute / varying / uniform / vertexInputs.* / uniforms.* /
 * vertexOutputs.* / fragmentInputs.* / fragmentOutputs.*) into the
 * actual WGSL that Babylon's preprocessor would emit, then pipes each
 * stage through `naga validate`.
 *
 * Usage:
 *   node tools/validate-wgsl.mjs src/render/fur.ts
 *
 * This catches WGSL *syntax* and *type* errors without spinning up a
 * browser. It does NOT catch Babylon-specific issues that depend on
 * runtime context (e.g., bones declarations injected by the
 * ShaderMaterial when it sees a skeleton). For those, a separate
 * headless-Playwright harness is needed.
 */
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const NAGA = `${process.env.HOME}/.cargo/bin/naga`;

if (process.argv.length < 3) {
  console.error("usage: validate-wgsl.mjs <file.ts>");
  process.exit(2);
}

const srcPath = process.argv[2];
const src = readFileSync(srcPath, "utf8");

// Pull out every `/* wgsl */ ` ... ` ` template-literal.
const blockRe = /\/\*\s*wgsl\s*\*\/\s*`([\s\S]*?)`/g;
const blocks = [];
let m;
while ((m = blockRe.exec(src)) !== null) blocks.push(m[1]);

if (blocks.length === 0) {
  console.error(`no /* wgsl */ blocks found in ${srcPath}`);
  process.exit(2);
}

const tmp = mkdtempSync(join(tmpdir(), "wgsl-validate-"));
console.log(`scratch dir: ${tmp}`);

let allOk = true;

for (let i = 0; i < blocks.length; i++) {
  const raw = blocks[i];
  const isVertex = /@vertex\b/.test(raw);
  const isFragment = /@fragment\b/.test(raw);
  if (!isVertex && !isFragment) continue;
  const stage = isVertex ? "vertex" : "fragment";

  const translated = translate(raw, stage);
  const outPath = join(tmp, `${stage}_${i}.wgsl`);
  writeFileSync(outPath, translated);
  console.log(`\n=== block ${i} (${stage}) → ${outPath} ===`);

  try {
    // naga without output args = validation-only mode
    execSync(`${NAGA} ${outPath}`, { stdio: "inherit" });
    console.log(`  ✓ ${stage} valid`);
  } catch {
    allOk = false;
    console.error(`  ✗ ${stage} FAILED — see error above`);
    console.error(`  source: ${outPath}`);
  }
}

process.exit(allOk ? 0 : 1);

/**
 * Translate Babylon's pseudo-WGSL into raw WGSL that naga can validate.
 *
 * Babylon's preprocessor (webgpuShaderProcessorsWGSL.js) takes top-level
 * `attribute X : T;`, `varying X : T;`, `uniform X : T;` declarations
 * and bundles them into structs, then rewrites accesses like
 * `vertexInputs.X` / `uniforms.X` / `vertexOutputs.X` to read/write
 * those structs. We approximate that here.
 */
function translate(src, stage) {
  const lines = src.split("\n");

  const attributes = []; // { name, type }
  const varyings = [];   // { name, type }
  const uniforms = [];   // { name, type }
  const fnLines = [];

  let inFn = false;
  for (const line of lines) {
    if (!inFn) {
      const a = line.match(/^\s*attribute\s+(\w+)\s*:\s*([^;]+);/);
      const v = line.match(/^\s*varying\s+(\w+)\s*:\s*([^;]+);/);
      const u = line.match(/^\s*uniform\s+(\w+)\s*:\s*([^;]+);/);
      if (a) { attributes.push({ name: a[1], type: a[2].trim() }); continue; }
      if (v) { varyings.push({ name: v[1], type: v[2].trim() }); continue; }
      if (u) { uniforms.push({ name: u[1], type: u[2].trim() }); continue; }
    }
    if (/^@vertex\b|^@fragment\b/.test(line.trim())) inFn = true;
    fnLines.push(line);
  }

  // Build the wrapped shader.
  const out = [];

  // Uniforms struct (always emit one — naga doesn't mind an empty).
  if (uniforms.length > 0) {
    out.push("struct Uniforms {");
    for (const u of uniforms) out.push(`  ${u.name}: ${u.type},`);
    out.push("};");
    out.push("@group(0) @binding(0) var<uniform> uniforms: Uniforms;");
  }

  // VertexInputs / FragmentInputs / FragmentOutputs structs.
  if (stage === "vertex") {
    out.push("struct VertexInputs {");
    attributes.forEach((a, i) => out.push(`  @location(${i}) ${a.name}: ${a.type},`));
    out.push("};");

    out.push("struct FragmentInputs {");
    out.push("  @builtin(position) position: vec4f,");
    varyings.forEach((v, i) => out.push(`  @location(${i}) ${v.name}: ${v.type},`));
    out.push("};");
  } else {
    out.push("struct FragmentInputs {");
    out.push("  @builtin(position) position: vec4f,");
    varyings.forEach((v, i) => out.push(`  @location(${i}) ${v.name}: ${v.type},`));
    out.push("};");

    out.push("struct FragmentOutputs {");
    out.push("  @location(0) color: vec4f,");
    out.push("};");
  }

  // Function body — rewrite the entry sig and the * Inputs/Outputs aliases.
  let body = fnLines.join("\n");

  if (stage === "vertex") {
    body = body
      // entry sig: `fn main(input : VertexInputs) -> FragmentInputs {`
      .replace(
        /fn\s+main\s*\(\s*input\s*:\s*VertexInputs\s*\)\s*->\s*FragmentInputs\s*\{/,
        "fn main(vertexInputs: VertexInputs) -> FragmentInputs {\n  var vertexOutputs: FragmentInputs;",
      )
      // Replace return at end — Babylon writes vertexOutputs.* fields then implicitly returns.
      // We append `return vertexOutputs;` before the function's closing brace.
      .replace(/\}\s*$/, "  return vertexOutputs;\n}");
  } else {
    body = body
      .replace(
        /fn\s+main\s*\(\s*input\s*:\s*FragmentInputs\s*\)\s*->\s*FragmentOutputs\s*\{/,
        "fn main(fragmentInputs: FragmentInputs) -> FragmentOutputs {\n  var fragmentOutputs: FragmentOutputs;",
      )
      .replace(/\}\s*$/, "  return fragmentOutputs;\n}");
  }

  out.push(body);
  return out.join("\n");
}
