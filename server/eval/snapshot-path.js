import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// Snapshots taken with Tavily's "advanced" depth live in pages/ and searches/;
// "basic" ones in pages-basic/ and searches-basic/, so the two can be compared.
const dir = (name, depth) => path.join(here, depth === 'basic' ? `${name}-basic` : name);

/** Where a URL's saved page lives. Shared by snapshot.js and run.js. */
export const pageFile = (url, depth = 'advanced') =>
  path.join(dir('pages', depth), url.replace(/^https?:\/\//, '').replace(/[^a-z0-9]+/gi, '_').slice(0, 120) + '.json');

/** Where a brand's saved search results live. Shared by brand-snapshot.js and run-brands.js. */
export const searchFile = (brand, depth = 'advanced') =>
  path.join(dir('searches', depth), brand.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') + '.json');

/** "--depth basic" on the command line, or "advanced". */
export const depthArg = () => {
  const i = process.argv.indexOf('--depth');
  return i > -1 && process.argv[i + 1] === 'basic' ? 'basic' : 'advanced';
};
