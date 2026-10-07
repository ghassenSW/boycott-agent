// Server-side client for the Boycott Agent API. Use it ONLY from server code
// (route handlers, server actions, server components). The key stays on the server:
// Next.js never sends env variables without the NEXT_PUBLIC_ prefix to the browser.
//
// .env.local:
//   BOYCOTT_API_URL=http://127.0.0.1:3100
//   BOYCOTT_API_KEY=the key printed by deploy/setup.sh

// ---------------------------------------------------------------- response types

export type Source = {
  title: string;
  url: string;
  date: string | null;
  timing: 'current' | 'past' | 'unclear';
};

export type BrandCheck = {
  brand: string;
  status: 'active_boycott' | 'unclear' | 'no_evidence';
  confidence: number; // 0-100: how strongly the evidence shows an active boycott exists
  reason: string;
  sources: Source[];
  checked_at: string;
  served_from: 'live' | 'cache';
};

export type LinkCheck = {
  url: string;
  product: string;
  cause: string;
  verdict: 'verified' | 'weak_support' | 'unrelated' | 'contradicts_claim' | 'unreachable';
  support_strength: number; // 0-100: does THIS page back THIS product + THIS cause?
  credibility: number; // 0-100: how trustworthy the source is
  summary: string;
  evidence: string[]; // quotes found word for word on the page
  checked_at: string;
  served_from: 'live' | 'cache';
};

export type BrandReport = {
  brand: string;
  status: BrandCheck['status'];
  confidence: number;
  reason: string;
  evidence_score: number; // 0-100: how well the sources hold up once checked one by one
  sources_checked: number;
  sources_verified: number;
  sources: { url: string; title: string; verdict: LinkCheck['verdict']; support_strength: number; credibility: number }[];
  checked_at: string;
};

// ---------------------------------------------------------------- errors

export class BoycottApiError extends Error {
  constructor(
    message: string,
    public status: number, // HTTP status from the API (0 = could not reach it)
    public type: string, // BadRequest | Unauthorized | RateLimited | UpstreamError | BudgetExceeded | ...
    public retryAfterSeconds?: number
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------- calls

async function call<T>(path: string, body: unknown, timeoutMs: number): Promise<T> {
  const base = process.env.BOYCOTT_API_URL;
  const key = process.env.BOYCOTT_API_KEY;
  if (!base || !key) throw new BoycottApiError('BOYCOTT_API_URL or BOYCOTT_API_KEY is not set', 0, 'Config');

  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store', // the API caches answers itself
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new BoycottApiError(`Could not reach the Boycott API: ${(err as Error).message}`, 0, 'Unreachable');
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const retry = Number(res.headers.get('retry-after'));
    throw new BoycottApiError(data.error ?? `HTTP ${res.status}`, res.status, data.type ?? 'Unknown', retry || undefined);
  }
  return data as T;
}

/** Is this brand the target of a consumer boycott right now? (5–30 s the first time, instant after) */
export const checkBrand = (brand: string) => call<BrandCheck>('/v1/boycott-check', { brand }, 120_000);

/** Does this web page really support "boycott PRODUCT because of CAUSE"? */
export const verifyLink = (url: string, product: string, cause: string) =>
  call<LinkCheck>('/v1/verify-link', { url, product, cause }, 120_000);

/** Brand check, then each source checked one by one (slow: up to a few minutes). */
export const brandReport = (brand: string, maxSources = 3) =>
  call<BrandReport>('/v1/brand-report', { brand, max_sources: maxSources }, 240_000);

/** A short message you can show to visitors for any API error. */
export function friendlyMessage(err: unknown): string {
  if (!(err instanceof BoycottApiError)) return 'Something went wrong. Please try again.';
  switch (err.type) {
    case 'BadRequest':
      return err.message; // e.g. "Missing brand" or "url does not look like a valid URL"
    case 'BudgetExceeded':
      return 'New checks are paused until tomorrow. Brands already checked still work.';
    case 'RateLimited':
    case 'UpstreamError':
      return 'The service is busy right now. Please try again in a minute.';
    default:
      return 'The boycott checker is unavailable right now. Please try again later.';
  }
}
