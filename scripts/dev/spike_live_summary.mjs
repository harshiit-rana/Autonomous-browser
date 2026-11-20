// Prints a markdown table from a spike_live_view.mjs results file:  node scripts/dev/spike_live_summary.mjs <results.json> [more.json ...]
// Several files (repetitions) are listed one row per (cell, N, rep).
import fs from 'node:fs';
const rows = [];
for (const f of process.argv.slice(2)) { const r = JSON.parse(fs.readFileSync(f, 'utf8')); for (const c of r.cells) rows.push({ ...c, file: f.split(/[\\/]/).pop() }); }
const f = (x) => (x == null ? '-' : x);
console.log('| cell | N | rep | fps/tile (mean/min) | frame interval p95 ms | capture latency p50/p95 ms | capture timeouts | main(Browser) CPU % | GPU CPU % | renderer(Tab) CPU % | total CPU % | WS MB | page rAF/s | page timer/s | distinct frames (min tile) | KB/frame |');
console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const c of rows) {
  if (c.error) { console.log(`| ${c.cell} | ${c.N} | ${c.rep} | ERROR ${String(c.error).split('\n')[0]} |`); continue; }
  const t = c.cpuPctOfOneCoreByType || {};
  console.log(`| ${c.cell} | ${c.N} | ${c.rep} | ${f(c.fpsPerTileMean)}/${f(c.fpsPerTileMin)} | ${f(c.frameIntervalMsP95)} | ${f(c.captureLatencyMsP50)}/${f(c.captureLatencyMsP95)} | ${c.captureTimeouts} | ${f(t.Browser)} | ${f(t.GPU)} | ${f(t.Tab)} | ${f(c.totalCpuPctOfOneCore)} | ${c.workingSetMBTotal} | ${f(c.pageRafPerSecMean)} | ${f(c.pageTimerPerSecMean)} | ${f(c.distinctFramesMin)} | ${f(c.kBPerFrame)} |`);
}
