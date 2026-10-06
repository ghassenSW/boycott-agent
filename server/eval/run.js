// Runs the link verifier against eval/cases.json and reports how often it's right.
//
//   npm run eval                          both modes, compared side by side
//   npm run eval -- --mode passages       just one mode
//   npm run eval -- --model gemini-3.8-flash
//   npm run eval -- --only bbc            only cases whose id contains "bbc"
//
// Reads pages from eval/pages/ (see snapshot.js), never the live web, and never
// touches the database. The model is pinned so two runs differ only by our code.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyLink } from '../src/agents/verify-link.js';
import { pool } from '../src/db.js';
import { sleep } from '../src/clients.js';
import { pageFile, depthArg } from './snapshot-path.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};

const modes = arg('mode', 'both') === 'both' ? ['full', 'passages'] : [arg('mode')];
const model = arg('model', 'gemini-3.5-flash-lite');
const only = arg('only', '');
const delayMs = Number(arg('delay', 4000)); // free-tier requests-per-minute limit

const cases = JSON.parse(await fs.readFile(path.join(here, 'cases.json'), 'utf8')).filter((c) =>
  c.id.includes(only)
);

const depth = depthArg();

async function fromSnapshot(url) {
  const file = pageFile(url, depth);
  const saved = await fs.readFile(file, 'utf8').catch(() => null);
  if (!saved) throw new Error(`No ${depth} snapshot for ${url} — run: npm run eval:snapshot -- --depth ${depth}`);
  return JSON.parse(saved).response;
}

async function runOne(c, contextMode) {
  // A busy free-tier model is not a wrong answer: wait and retry rather than score it.
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await verifyLink(c, {
        useCache: false,
        save: false,
        extract: fromSnapshot,
        contextMode,
        models: [model],
      });
    } catch (err) {
      if (attempt === 3) return { error: err.message };
      console.log(`      (model busy, retrying in 20s)`);
      await sleep(20_000);
    }
  }
}

const runs = {};
for (const mode of modes) {
  console.log(`\n=== mode: ${mode} · model: ${model} · pages: ${depth} · ${cases.length} cases ===`);
  const rows = [];
  for (const c of cases) {
    const r = await runOne(c, mode);
    const verdict = r.error ? 'ERROR' : r.verdict;
    const row = {
      id: c.id,
      ideal: c.ideal,
      verdict,
      support: r.support_strength,
      evidence: r.evidence?.length ?? 0,
      pass: c.accept.includes(verdict),
      exact: verdict === c.ideal,
      falseVerified: verdict === 'verified' && !c.accept.includes('verified'),
      missed: c.ideal === 'verified' && !r.error && !c.accept.includes(verdict),
      error: r.error,
    };
    rows.push(row);
    const mark = row.error ? '  ? ' : row.pass ? 'PASS' : row.falseVerified ? 'FALSE+' : 'FAIL';
    console.log(
      `${mark.padEnd(6)} ${c.id.padEnd(40)} got ${String(verdict).padEnd(17)} want ${c.ideal.padEnd(17)} support ${String(row.support ?? '-').padStart(3)}  quotes ${row.evidence}`
    );
    if (r.error) console.log(`       ${r.error.slice(0, 160)}`);
    // Unreachable pages never call the model, so they don't need the pause.
    if (!r.error && r.verdict !== 'unreachable') await sleep(delayMs);
  }
  runs[mode] = rows;
}

const summarize = (rows) => {
  const scored = rows.filter((r) => !r.error);
  return {
    scored: scored.length,
    errors: rows.length - scored.length,
    pass: scored.filter((r) => r.pass).length,
    exact: scored.filter((r) => r.exact).length,
    falseVerified: scored.filter((r) => r.falseVerified).length,
    missed: scored.filter((r) => r.missed).length,
    quotes: scored.reduce((n, r) => n + r.evidence, 0),
  };
};

console.log('\n=== summary ===');
console.log('mode        correct     exact match   FALSE verified   missed real support   verified quotes   errors');
for (const [mode, rows] of Object.entries(runs)) {
  const s = summarize(rows);
  console.log(
    `${mode.padEnd(11)} ${`${s.pass}/${s.scored}`.padEnd(11)} ${`${s.exact}/${s.scored}`.padEnd(13)} ${String(s.falseVerified).padEnd(16)} ${String(s.missed).padEnd(21)} ${String(s.quotes).padEnd(17)} ${s.errors}`
  );
}
if (runs.full && runs.passages) {
  const changed = runs.passages.filter((r, i) => r.pass !== runs.full[i].pass);
  for (const r of changed) console.log(`  ${r.pass ? 'fixed  ' : 'BROKEN '} ${r.id}`);
}

await fs.mkdir(path.join(here, 'results'), { recursive: true });
const out = path.join(here, 'results', `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
await fs.writeFile(out, JSON.stringify({ model, runs }, null, 2));
console.log(`\nfull results: ${path.relative(process.cwd(), out)}`);
await pool.end();
