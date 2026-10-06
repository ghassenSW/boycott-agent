// Picks the parts of a page worth showing the model: the headline, the opening, and
// every paragraph that names the product or the cause (plus its neighbours, for
// context). Free-tier models judge much better on 4k focused characters than on
// 12k characters that are mostly sidebars, related links and cookie banners.

const BUDGET = 5000;
const STOPWORDS = new Set(
  'the a an and or of to in on for over with by from its it is are was were be been as at that this these those their his her our your about against into than then them they not no but has have had who which what when where why how boycott boycotts boycotting consumer consumers'.split(
    ' '
  )
);

const norm = (s) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // accents: "Israël" -> "israel"
    .replace(/[’'`´]/g, '');

/** "McDonald's" -> ["mcdonalds"], "Coca-Cola" -> ["coca-cola", "coca cola", "cocacola"]. */
function productTerms(product) {
  const p = norm(product).trim();
  const terms = new Set([p, p.replace(/[-.]/g, ' '), p.replace(/[\s\-.]/g, '')]);
  return [...terms].filter((t) => t.length >= 2);
}

/** Content words of the cause, cut to a 5-letter stem so "soldiers" matches "soldier", "Israeli" matches "Israel". */
function causeStems(cause) {
  return [
    ...new Set(
      norm(cause)
        .split(/[^\p{L}\p{N}]+/u)
        .filter((w) => w.length >= 4 && !STOPWORDS.has(w))
        .map((w) => w.slice(0, 5))
    ),
  ];
}

export function selectPassages(content, product, cause, budget = BUDGET) {
  // Drop exact repeats first: menus and banners are often rendered twice.
  const seen = new Set();
  const lines = content.split('\n').filter((l) => {
    const key = l.trim();
    if (!key) return false;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const deduped = lines.join('\n');
  if (deduped.length <= budget) return { text: deduped, mode: 'whole_page' };

  const pTerms = productTerms(product);
  const cStems = causeStems(cause);

  const scored = lines.map((line, i) => {
    // Bulleted lines are mostly "related articles" teasers: headlines of OTHER
    // stories. They often name the product and cause, which is exactly why they
    // must not be picked as evidence for this page. They can still come in as
    // neighbours of a real paragraph.
    if (/^\s*[*\-•]\s/.test(line)) return { i, line, score: 0 };
    const l = norm(line);
    const hasProduct = pTerms.some((t) => l.includes(t));
    const causeHits = cStems.filter((s) => l.includes(s)).length;
    let score = (hasProduct ? 3 : 0) + causeHits;
    if (hasProduct && causeHits) score += 3;
    return { i, line, score };
  });

  const keep = new Set();
  // Headline and opening paragraphs give the model the page's own framing.
  // "Opening" means the first paragraphs after the headline, not the site's tagline.
  const title = scored.find((s) => /^#\s/.test(s.line));
  if (title) keep.add(title.i);
  scored
    .filter((s) => s.i > (title?.i ?? -1) && s.line.length >= 60 && s.score >= 0 && !/^\s*[*\-•]\s/.test(s.line))
    .slice(0, 2)
    .forEach((s) => keep.add(s.i));

  let used = [...keep].reduce((n, i) => n + lines[i].length, 0);
  const ranked = scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score || a.i - b.i);
  for (const s of ranked) {
    for (const j of [s.i, s.i - 1, s.i + 1]) {
      if (j < 0 || j >= lines.length || keep.has(j)) continue;
      if (used + lines[j].length > budget) continue;
      keep.add(j);
      used += lines[j].length;
    }
    if (used >= budget) break;
  }

  // Almost nothing matched — e.g. the page is in Arabic and the product was typed in
  // Latin letters. Better to show the start of the page than a handful of fragments.
  const matched = ranked.length > 0 && used > 600;
  if (!matched) return { text: deduped.slice(0, budget * 2), mode: 'page_start' };

  const order = [...keep].sort((a, b) => a - b);
  const parts = [];
  order.forEach((idx, k) => {
    if (k > 0 && idx !== order[k - 1] + 1) parts.push('[…]');
    parts.push(lines[idx]);
  });
  return { text: parts.join('\n'), mode: 'passages' };
}
