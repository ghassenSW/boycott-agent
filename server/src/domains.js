// What kind of site a URL is on. Shared by both agents: the link verifier turns it into
// a credibility base, the brand check into how much one search result counts.
// Extend the lists with the outlets your audience reads.

const MAJOR_NEWS = ['reuters.com','apnews.com','bbc.com','bbc.co.uk','aljazeera.com','theguardian.com','nytimes.com','washingtonpost.com','ft.com','bloomberg.com','cnn.com','npr.org','economist.com','wsj.com','lemonde.fr','dw.com','france24.com','abcnews.go.com','cbsnews.com','nbcnews.com','independent.co.uk','telegraph.co.uk','haaretz.com','middleeasteye.net','thenational.ae','timesofindia.indiatimes.com','scmp.com','time.com','forbes.com'];
const NGO_WATCHDOG = ['hrw.org','amnesty.org','transparency.org','oxfam.org','greenpeace.org','globalwitness.org','cleanclothes.org','business-humanrights.org','somo.nl'];
const ADVOCACY = ['bdsmovement.net','ethicalconsumer.org','sumofus.org'];
const REFERENCE = ['wikipedia.org','britannica.com'];
const BLOG_HOSTS = ['medium.com','substack.com','blogspot.com','wordpress.com','tumblr.com','blogger.com'];
const SOCIAL = ['x.com','twitter.com','facebook.com','reddit.com','tiktok.com','instagram.com','youtube.com','threads.net','threads.com','t.me','linkedin.com','quora.com'];

export function classifyDomain(domain) {
  const hits = (list) => list.some((d) => domain === d || domain.endsWith(`.${d}`));
  const official =
    /\.(gov|edu|int)$/.test(domain) ||
    /\.gov\.[a-z]{2}$/.test(domain) ||
    /\.ac\.[a-z]{2}$/.test(domain) ||
    ['un.org', 'who.int', 'europa.eu', 'ilo.org'].some((d) => domain === d || domain.endsWith(`.${d}`));

  if (official) return { domain_tier: 'official', domain_score: 40 };
  if (hits(MAJOR_NEWS)) return { domain_tier: 'major_news', domain_score: 40 };
  if (hits(NGO_WATCHDOG)) return { domain_tier: 'ngo', domain_score: 35 };
  if (hits(ADVOCACY)) return { domain_tier: 'advocacy', domain_score: 28 };
  if (hits(REFERENCE)) return { domain_tier: 'reference', domain_score: 25 };
  if (hits(BLOG_HOSTS)) return { domain_tier: 'blog', domain_score: 12 };
  if (hits(SOCIAL)) return { domain_tier: 'social', domain_score: 8 };
  return { domain_tier: 'unknown', domain_score: 20 };
}

/** "https://www.bbc.com/news/x" -> "bbc.com". No URL global needed. */
export function domainOf(url) {
  const m = String(url).match(/^[a-z][a-z0-9+.\-]*:\/\/([^/?#\s]+)/i);
  return m ? m[1].split('@').pop().split(':')[0].toLowerCase().replace(/^www\./, '') : '';
}
