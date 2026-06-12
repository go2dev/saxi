// Scratch benchmark (not for upstream): why are GC pauses 50-800ms during a plot?
//
// Reproduces the server's heap layout during a plot and measures, on this
// machine (the same one the live telemetry numbers came from):
//   1. how big the live heap is in each retention mode,
//   2. how long a full GC takes over that heap,
//   3. what GC activity the per-command streaming churn causes.
//
// Modes (env MODE=):
//   current - what the server does today: retain raw JSON.parse'd body
//             (currentPlan) AND the Plan.deserialize object graph
//   string  - retain the body as a string instead of an object graph
//   none    - retain only the deserialized Plan
//
// Usage: node --expose-gc tools/gc-bench.mjs <file.svg> [churnCommands]

import { readFileSync } from "node:fs";
import { PerformanceObserver, constants as perfConstants } from "node:perf_hooks";
import { flattenSVG } from "flatten-svg";
import { createSVGWindow } from "svgdom";
import { replan } from "../dist/server/massager.js";
import { PaperSize } from "../dist/server/paper-size.js";
import { Plan, defaultPlanOptions } from "../dist/server/planning.js";

if (typeof global.gc !== "function") {
  console.error("run with --expose-gc");
  process.exit(1);
}

const file = process.argv[2];
const churnCommands = Number(process.argv[3] ?? 300_000);
const mode = process.env.MODE || "current";

function heapMB() {
  return process.memoryUsage().heapUsed / 1048576;
}

/** Time a few forced full GCs (approximates the atomic cost of a major GC over the current live set). */
function timeFullGC(label) {
  const times = [];
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    global.gc();
    times.push(performance.now() - t0);
  }
  const sorted = times.slice().sort((a, b) => a - b);
  console.log(
    `[full-gc] ${label}: median ${sorted[2].toFixed(1)}ms (min ${sorted[0].toFixed(1)}, max ${sorted[4].toFixed(1)}) | live heap ${heapMB().toFixed(1)} MB`,
  );
}

// ---- 1. Build the plan exactly like the app does (browser side) ----
// (block scope so the svgdom DOM, polylines and built plan are dead before the
// server-side measurements begin — the real server never holds these.)
let bodyString;
let blockCount;
{
  const svg = readFileSync(file, "utf8");
  const window_ = createSVGWindow();
  window_.document.documentElement.innerHTML = svg;
  const lines = flattenSVG(window_.document.documentElement, {});
  const planOptions = { ...defaultPlanOptions, layerMode: "all", paperSize: PaperSize.standard.ArchA.landscape };
  const built = replan(lines, planOptions);
  blockCount = 0;
  for (const m of built.motions) if (m.blocks) blockCount += m.blocks.length;
  // The browser POSTs the serialized plan as JSON:
  bodyString = JSON.stringify(built.serialize());
}
console.log(`plan: ${blockCount} blocks (mode=${mode}) | POST body: ${(bodyString.length / 1048576).toFixed(1)} MB of JSON`);

// Drop the construction garbage so it doesn't pollute the measurements.
global.gc();
timeFullGC("baseline (server before /plot: no plan held)");

// ---- 2. Server side: express parses the body, /plot deserializes it ----
let t0 = performance.now();
let body = JSON.parse(bodyString); // express.json()
const parseMs = performance.now() - t0;

t0 = performance.now();
const plan = Plan.deserialize(body); // /plot handler
const deserializeMs = performance.now() - t0;
console.log(`JSON.parse: ${parseMs.toFixed(0)}ms | Plan.deserialize: ${deserializeMs.toFixed(0)}ms`);

// What a new websocket client connection costs mid-plot (server re-stringifies currentPlan):
t0 = performance.now();
const resent = JSON.stringify({ c: "plan", p: { plan: body } });
console.log(`re-JSON.stringify currentPlan for a new ws client: ${(performance.now() - t0).toFixed(0)}ms (${(resent.length / 1048576).toFixed(1)} MB)`);

// ---- 3. Retention modes ----
const retained = { plan }; // the executing plan is always live
if (mode === "current") retained.currentPlan = body;
if (mode === "string") retained.currentPlanString = bodyString;
body = null;
bodyString = null;
global.gc();
timeFullGC(`plot running, retention mode "${mode}"`);

// ---- 4. Streaming churn: allocate like ebb.ts does per command ----
const gcEvents = [];
const kindName = {
  [perfConstants.NODE_PERFORMANCE_GC_MAJOR]: "major",
  [perfConstants.NODE_PERFORMANCE_GC_MINOR]: "minor",
  [perfConstants.NODE_PERFORMANCE_GC_INCREMENTAL]: "incremental",
  [perfConstants.NODE_PERFORMANCE_GC_WEAKCB]: "weakcb",
};
const obs = new PerformanceObserver((list) => {
  for (const e of list.getEntries()) gcEvents.push({ kind: kindName[e.detail?.kind] ?? "?", duration: e.duration });
});
obs.observe({ entryTypes: ["gc"] });

function* commandGen() {
  const line = yield;
  return line;
}

// Mirrors EBB.write() + EBB.run() + axisRate/modf allocations per LM command.
function simulateCommand(i) {
  const [initialRate1, deltaR1] = [Math.round(i * 85899.34), Math.round(i % 977)];
  const [initialRate2, deltaR2] = [Math.round(i * 42949.67), Math.round(i % 487)];
  const str = `LM,${initialRate1},${i % 300},${deltaR1},${initialRate2},${i % 280},${deltaR2}\r`;
  const encoder = new TextEncoder(); // ebb.ts allocates one per write
  const bytes = encoder.encode(str);
  const g = commandGen();
  g.next();
  const p = new Promise((resolve, reject) => {
    g.resolve = resolve;
    g.reject = reject;
  });
  const d = g.next(bytes.length > 0 ? "OK" : "ERR");
  if (d.done) g.resolve(d.value);
  return p;
}

console.log(`churning ${churnCommands} simulated LM command cycles...`);
t0 = performance.now();
for (let i = 0; i < churnCommands; i++) {
  await simulateCommand(i);
}
const churnMs = performance.now() - t0;
// GC entries are delivered asynchronously; let them flush before disconnecting.
await new Promise((resolve) => setTimeout(resolve, 100));
obs.disconnect();

const byKind = {};
for (const e of gcEvents) {
  (byKind[e.kind] ??= []).push(e.duration);
}
console.log(`churn done in ${(churnMs / 1000).toFixed(1)}s (${(churnCommands / (churnMs / 1000) / 1000).toFixed(0)}k cmd/s)`);
for (const [kind, durs] of Object.entries(byKind)) {
  durs.sort((a, b) => a - b);
  const sum = durs.reduce((a, b) => a + b, 0);
  console.log(
    `  gc ${kind}: ${durs.length}x, total ${sum.toFixed(0)}ms, p50 ${durs[Math.floor(durs.length / 2)].toFixed(1)}ms, max ${durs[durs.length - 1].toFixed(1)}ms`,
  );
}

timeFullGC("after churn");
// Keep the retained graph alive to the very end so the optimizer can't drop it.
console.log(`(retained: ${Object.keys(retained).join(", ")}; plan motions: ${retained.plan.motions.length})`);
