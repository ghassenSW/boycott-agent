// Saves each page in eval/cases.json, exactly as Tavily returned it.
// The eval then always reads the same text: a page edited next month, or a site
// that goes down, can't change the score — only a change to our code or model can.
//
//   node eval/snapshot.js                 fetch pages that don't have a snapshot yet
//   node eval/snapshot.js --force         re-fetch everything
//   node eval/snapshot.js --depth basic   use Tavily's cheaper "basic" extraction (saved separately)

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tavilyExtract } from '../src/clients.js';
import { pool } from '../src/db.js';
import { BudgetExceeded } from '../src/errors.js';
import { pageFile, depthArg } from './snapshot-path.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const force = process.argv.includes('--force');
const depth = depthArg();

const cases = JSON.parse(await fs.readFile(path.join(here, 'cases.json'), 'utf8'));
const urls = [...new Set(cases.map((c) => c.url))];
await fs.mkdir(path.dirname(pageFile(urls[0], depth)), { recursive: true });

for (const url of urls) {
  const file = pageFile(url, depth);
  if (!force && (await fs.stat(file).catch(() => null))) {
    console.log('kept   ', url);
    continue;
  }
  let response;
  try {
    response = await tavilyExtract(url, depth);
  } catch (err) {
    if (err instanceof BudgetExceeded) throw err; // a spent budget is not a dead page
    response = { error: err.message };
  }
  await fs.writeFile(file, JSON.stringify({ url, depth, fetched_at: new Date().toISOString(), response }, null, 2));
  const len = response.results?.[0]?.raw_content?.length ?? 0;
  console.log('fetched', url, `(${depth}, ${len} chars${response.failed_results?.length ? ', FAILED' : ''})`);
}
await pool.end();
