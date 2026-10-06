// Tavily returns pages as markdown, including every menu, footer and language switcher.
// On a typical news page that's half the text, and it pushes the article itself past
// the slice we can afford to send to a free-tier model. This keeps the prose.

const IMAGE = /!\[[^\]]*\]\([^)]*\)/g;
const LINK = /\[([^\]]*)\]\((?:[^()]|\([^)]*\))*\)/g; // [text](url "title") -> text
const BARE_URL = /https?:\/\/\S+/g;

/** A line that's only navigation: a bulleted link, a row of links, a lone short label. */
function isNavLine(original, cleaned) {
  const text = cleaned.replace(/[*#>|_\-\s]+/g, ' ').trim();
  if (!text) return true;
  const links = (original.match(LINK) || []).length;
  if (links === 0) return false;
  // Lots of links and few words outside them -> a menu row.
  const outside = original.replace(LINK, '').replace(/[*#>|_\-\s]+/g, ' ').trim();
  if (outside.length < 15) return text.split(' ').length <= 12 || links >= 3;
  return false;
}

export function cleanPageText(raw = '') {
  const out = [];
  let blank = 0;
  for (const original of String(raw).split('\n')) {
    const line = original.replace(IMAGE, '').replace(LINK, '$1').replace(BARE_URL, '').trimEnd();
    if (isNavLine(original.replace(IMAGE, ''), line)) continue;
    if (!line.trim()) {
      if (blank++ < 1) out.push('');
      continue;
    }
    blank = 0;
    out.push(line);
  }
  return out.join('\n').trim();
}
