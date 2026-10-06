// Runs the brand check against eval/brands.json and reports how often it's right.
//
//   npm run eval:brands
//   npm run eval:brands -- --model gemini-3.8-flash
//   npm run eval:brands -- --only nike
//
// Reads saved searches from eval/searches/ (see brand-snapshot.js), never the live web,
// never the database. The model is pinned so two runs differ only by our code.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boycottCheck, normalizeInput } from '../src/agents/boycott-check.js';
import { pool } from '../src/db.js';
import { sleep } from '../src/clients.js';
import { searchFile, depthArg } from './snapshot-path.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const model = arg('model', 'gemini-3.5-flash-lite');
const only = (arg('only', '') || '').toLowerCase();
const delayMs = Number(arg('delay', 4000));

const cases = JSON.parse(await fs.readFile(path.join(here, 'brands.json'), 'utf8')).filter((c) =>
  c.brand.toLowerCase().includes(only)
);

async function run(c, saved) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await boycottCheck(
        { brand: c.brand },
        { useCache: false, save: false, search: async () => saved.response, models: [model], now: new Date(saved.fetched_at) }
      );
    } catch (err) {
      if (attempt === 3) return { error: err.message };
      console.log('      (model busy, retrying in 20s)');
      await sleep(20_000);
    }
  }
}

const depth = depthArg();
console.log(`=== brand check · model: ${model} · searches: ${depth} · ${cases.length} brands ===`);
const rows = [];
let unlabelledTotal = 0;
for (const c of cases) {
  const saved = JSON.parse(await fs.readFile(searchFile(c.brand, depth), 'utf8'));
  // Source labels were made on the "advanced" results (by index). Translate them to URLs,
  // so they still apply when a "basic" search returns some of the same pages.
  const labelled = JSON.parse(await fs.readFile(searchFile(c.brand, 'advanced'), 'utf8')).response.results ?? [];
  const labelledUrls = new Set(labelled.map((r) => r.url));
  const relevantUrls = new Set(c.relevant.map((i) => labelled[i - 1]?.url).filter(Boolean));

  const r = await run(c, saved);
  if (r.error) {
    console.log(`  ?    ${c.brand.padEnd(20)} ERROR ${r.error.slice(0, 120)}`);
    rows.push({ brand: c.brand, error: true });
    continue;
  }
  const listed = r.sources ?? [];
  // Only judge sources we have a label for; pages the advanced search never returned are counted apart.
  const unlabelled = listed.filter((s) => !labelledUrls.has(s.url)).length;
  unlabelledTotal += unlabelled;
  const noise = listed.filter((s) => labelledUrls.has(s.url) && !relevantUrls.has(s.url));
  const row = {
    brand: c.brand,
    ideal: c.ideal,
    status: r.status,
    confidence: r.confidence,
    pass: c.accept.includes(r.status),
    exact: r.status === c.ideal,
    falseActive: r.status === 'active_boycott' && !c.accept.includes('active_boycott'),
    missedActive: c.ideal === 'active_boycott' && !c.accept.includes(r.status),
    listed: listed.length,
    noise: noise.length,
    shouldBeActive: c.ideal === 'active_boycott',
  };
  rows.push(row);
  const mark = row.pass ? 'PASS' : row.falseActive ? 'FALSE+' : 'FAIL';
  console.log(
    `${mark.padEnd(6)} ${c.brand.padEnd(20)} got ${r.status.padEnd(15)} want ${c.ideal.padEnd(15)} confidence ${String(r.confidence).padStart(3)}   sources listed ${String(listed.length).padStart(2)}, not about this brand's boycott ${noise.length}`
  );
  for (const s of noise.slice(0, 3)) console.log(`         noise: ${String(s.title).slice(0, 90)}`);
  await sleep(delayMs);
}

// Spelling variants must land on the same stored answer.
const variants = [['McDonald\'s', 'McDonalds', 'mcdonalds', 'MCDONALD’S'], ['Coca-Cola', 'coca cola', 'CocaCola']];
const variantOk = variants.map((group) => {
  const keys = new Set(group.map((b) => normalizeInput({ brand: b }).brand_normalized));
  return { group, ok: keys.size === 1, keys: [...keys] };
});

const scored = rows.filter((r) => !r.error);
const avg = (xs) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0);
const listedTotal = scored.reduce((n, r) => n + r.listed, 0);
const noiseTotal = scored.reduce((n, r) => n + r.noise, 0);

console.log('\n=== summary ===');
console.log(`correct status          ${scored.filter((r) => r.pass).length}/${scored.length}   (exact ${scored.filter((r) => r.exact).length}/${scored.length})`);
console.log(`FALSE active boycott    ${scored.filter((r) => r.falseActive).length}   <- must be 0: a brand accused without current evidence`);
console.log(`missed active boycott   ${scored.filter((r) => r.missedActive).length}`);
console.log(`listed sources that are not about this brand's boycott: ${noiseTotal}/${listedTotal - unlabelledTotal} labelled` + (unlabelledTotal ? ` (+${unlabelledTotal} not labelled: pages only this search depth returned)` : ''));
console.log(`avg confidence when a boycott IS active:     ${avg(scored.filter((r) => r.shouldBeActive).map((r) => r.confidence))}`);
console.log(`avg confidence when it is NOT (or unclear):  ${avg(scored.filter((r) => !r.shouldBeActive).map((r) => r.confidence))}`);
console.log(`non-active brands scored 50+:                ${scored.filter((r) => !r.shouldBeActive && r.confidence >= 50).map((r) => r.brand).join(', ') || 'none'}`);
for (const v of variantOk) console.log(`spelling variants ${v.ok ? 'merge' : 'DO NOT merge'}: ${v.group.join(' / ')}  -> ${v.keys.join(' | ')}`);
if (rows.some((r) => r.error)) console.log(`errors (model unavailable): ${rows.filter((r) => r.error).length}`);

await fs.mkdir(path.join(here, 'results'), { recursive: true });
await fs.writeFile(
  path.join(here, 'results', `brands-${new Date().toISOString().replace(/[:.]/g, '-')}.json`),
  JSON.stringify({ model, rows }, null, 2)
);
await pool.end();
