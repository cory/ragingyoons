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
import { dirname, join, resolve } from "node:path";

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
while ((m = blockRe.exec(src)) !== null) blocks.push(substituteTemplateExprs(m[1], srcPath));

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
 * Resolve `${IDENT}` expressions inside a WGSL template literal by
 * looking up `const IDENT = ...` declarations in the source file and,
 * if needed, walking imports to resolve referenced identifiers.
 *
 * Handles: numeric literals, simple `IDENT + N` / `IDENT - N` arithmetic.
 * Anything more complex is left alone (and naga will surface the
 * resulting parse error).
 */
function substituteTemplateExprs(wgsl, srcPath) {
  return wgsl.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, ident) => {
    const v = resolveIdent(srcPath, ident);
    return v === undefined ? whole : String(v);
  });
}

function resolveIdent(filePath, ident, seen = new Set()) {
  const key = `${filePath}::${ident}`;
  if (seen.has(key)) return undefined;
  seen.add(key);

  const fileSrc = readFileSync(filePath, "utf8");
  // `const IDENT = NUMBER;` — direct numeric literal.
  const litRe = new RegExp(`(?:export\\s+)?const\\s+${ident}\\s*=\\s*(-?\\d+(?:\\.\\d+)?)\\s*;`);
  const lit = litRe.exec(fileSrc);
  if (lit) return Number(lit[1]);

  // `const IDENT = OTHER (+|-) NUMBER;` — simple arithmetic on another ident.
  const exprRe = new RegExp(`(?:export\\s+)?const\\s+${ident}\\s*=\\s*([A-Za-z_]\\w*)\\s*([+\\-])\\s*(\\d+)\\s*;`);
  const expr = exprRe.exec(fileSrc);
  if (expr) {
    const other = resolveIdent(filePath, expr[1], seen) ?? resolveImported(filePath, expr[1], seen);
    if (other === undefined) return undefined;
    const n = Number(expr[3]);
    return expr[2] === "+" ? other + n : other - n;
  }
  return undefined;
}

function resolveImported(filePath, ident, seen) {
  const fileSrc = readFileSync(filePath, "utf8");
  // `import { ..., IDENT, ... } from "PATH";` — find PATH then resolve.
  const importRe = new RegExp(`import\\s*\\{[^}]*\\b${ident}\\b[^}]*\\}\\s*from\\s*["']([^"']+)["']`);
  const im = importRe.exec(fileSrc);
  if (!im) return undefined;
  const rel = im[1];
  const candidate = resolve(dirname(filePath), rel + (rel.endsWith(".ts") ? "" : ".ts"));
  return resolveIdent(candidate, ident, seen);
}

/**
 * Translate Babylon's pseudo-WGSL into raw WGSL that naga can validate.
 *
 * Babylon's preprocessor (webgpuShaderProcessorsWGSL.js) takes top-level
 * `attribute X : T;`, `varying X : T;`, `uniform X : T;` declarations
 * and bundles them into structs, then rewrites accesses like
 * `vertexInputs.X` / `uniforms.X` / `vertexOutputs.X` to read/write
 * those structs. We approximate that here.
 */
/**
 * Strip `#ifdef`/`#ifndef`/`#else`/`#endif`/`#if defined(...)` blocks
 * by treating every named symbol as defined — that's the runtime path
 * we actually exercise (instanced + VAT in our shaders today). The
 * non-defined branches are left untested at file level; runtime would
 * hit them only in edge cases like a pre-pass with no instances.
 */
function preprocessConditionals(src) {
  const lines = src.split("\n");
  const stack = []; // each entry: include?: boolean
  const out = [];
  for (const line of lines) {
    const t = line.trim();
    if (/^#ifdef\s+\w+/.test(t)) { stack.push(true); continue; }
    if (/^#ifndef\s+\w+/.test(t)) { stack.push(false); continue; }
    if (/^#if\b/.test(t)) {
      // Default include unless the expression is explicitly negated.
      stack.push(!t.includes("!defined"));
      continue;
    }
    if (/^#else\b/.test(t)) {
      if (stack.length) stack[stack.length - 1] = !stack[stack.length - 1];
      continue;
    }
    if (/^#endif\b/.test(t)) { stack.pop(); continue; }
    if (stack.every((v) => v)) out.push(line);
  }
  return out.join("\n");
}

function translate(srcRaw, stage) {
  const src = preprocessConditionals(srcRaw);
  const lines = src.split("\n");

  const attributes = []; // { name, type }
  const varyings = [];   // { name, type }
  const uniforms = [];   // { name, type }
  const textures = [];   // { name, type } — `var X: texture_*<...>;`
  const fnLines = [];

  let inFn = false;
  for (const line of lines) {
    if (!inFn) {
      const a = line.match(/^\s*attribute\s+(\w+)\s*:\s*([^;]+);/);
      const v = line.match(/^\s*varying\s+(\w+)\s*:\s*([^;]+);/);
      const u = line.match(/^\s*uniform\s+(\w+)\s*:\s*([^;]+);/);
      const t = line.match(/^\s*var\s+(\w+)\s*:\s*(texture_\w+(?:<[^>]+>)?)\s*;/);
      if (a) { attributes.push({ name: a[1], type: a[2].trim() }); continue; }
      if (v) { varyings.push({ name: v[1], type: v[2].trim() }); continue; }
      if (u) { uniforms.push({ name: u[1], type: u[2].trim() }); continue; }
      if (t) { textures.push({ name: t[1], type: t[2].trim() }); continue; }
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

  // Textures: each gets its own binding after the uniforms slot.
  textures.forEach((t, i) => {
    out.push(`@group(0) @binding(${i + 1}) var ${t.name}: ${t.type};`);
  });

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
