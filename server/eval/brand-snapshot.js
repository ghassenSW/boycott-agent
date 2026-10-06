// Saves the web search results for each brand in eval/brands.json to eval/searches/,
// using the exact query the API would send today. The brand eval then always judges
// the same results, so scores only move when our code or the model changes.
//
//   node eval/brand-snapshot.js           search brands that have no snapshot yet
//   node eval/brand-snapshot.js --force   search everything again
//   node eval/brand-snapshot.js --show    also print what was found (for labelling)
//   node eval/brand-snapshot.js --depth basic   use Tavily's cheaper "basic" search (saved separately)

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tavilySearch } from '../src/clients.js';
import { normalizeInput, SEARCH_OPTIONS } from '../src/agents/boycott-check.js';
import { pool } from '../src/db.js';
import { searchFile, depthArg } from './snapshot-path.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const force = process.argv.includes('--force');
const show = process.argv.includes('--show');
const depth = depthArg();

const cases = JSON.parse(await fs.readFile(path.join(here, 'brands.json'), 'utf8'));
await fs.mkdir(path.dirname(searchFile('x', depth)), { recursive: true });

for (const { brand } of cases) {
  const file = searchFile(brand, depth);
  let saved = force ? null : await fs.readFile(file, 'utf8').catch(() => null);
  if (saved) {
    saved = JSON.parse(saved);
  } else {
    const { searchQuery } = normalizeInput({ brand });
    const response = await tavilySearch(searchQuery, { ...SEARCH_OPTIONS, search_depth: depth });
    saved = { brand, depth, query: searchQuery, fetched_at: new Date().toISOString(), response };
    await fs.writeFile(file, JSON.stringify(saved, null, 2));
  }
  const results = saved.response.results ?? [];
  console.log(`\n### ${brand}  (${results.length} results)  query: ${saved.query}`);
  if (!show) continue;
  results.forEach((r, i) => {
    const text = String(r.content ?? '').replace(/\s+/g, ' ').slice(0, 260);
    console.log(`[${i + 1}] ${r.title}\n    ${r.url}  (${r.published_date ?? 'no date'})\n    ${text}`);
  });
}
await pool.end();
