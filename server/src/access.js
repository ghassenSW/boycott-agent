// Who may call the API, and how much.
//
// Every integrating website gets its own named key (API_KEYS="site-a:key1,site-b:key2"),
// sent from its SERVER as "Authorization: Bearer <key>". A key can be revoked by
// removing it from API_KEYS and restarting.
//
// Limits are counted in "units" that roughly track what a request costs in free
// Tavily/Gemini quota: one unit per check, and 1 + max_sources for a brand report.
// Counters live in memory, so they reset when the server restarts.

import crypto from 'node:crypto';
import { config } from './config.js';

const sha = (s) => crypto.createHash('sha256').update(s).digest();
// Hash both sides so timingSafeEqual always compares equal-length buffers.
const keys = config.access.apiKeys.map(({ name, key }) => ({ name, hash: sha(key) }));

function findClient(presented) {
  if (!presented) return null;
  const h = sha(presented);
  return keys.find((k) => crypto.timingSafeEqual(k.hash, h)) ?? null;
}

function presentedKey(req) {
  const auth = req.get('authorization') ?? '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return (m ? m[1] : req.get('x-api-key') ?? '').trim();
}

export function requireApiKey(req, res, next) {
  const client = findClient(presentedKey(req));
  if (!client) {
    return res
      .status(401)
      .json({ error: 'Missing or invalid API key. Send it as "Authorization: Bearer <key>".', type: 'Unauthorized' });
  }
  req.client = client.name;
  next();
}

// ---------------------------------------------------------------- limits

const minuteWindows = new Map(); // client -> { start, used }
const dayWindows = new Map();

function take(map, client, windowMs, limit, cost) {
  const now = Date.now();
  let w = map.get(client);
  if (!w || now - w.start >= windowMs) {
    w = { start: now, used: 0 };
    map.set(client, w);
  }
  if (w.used + cost > limit) return { ok: false, retryAfterS: Math.ceil((w.start + windowMs - now) / 1000) };
  w.used += cost;
  return { ok: true, remaining: limit - w.used };
}

/** cost(req) -> units this request will use. */
export const rateLimit = (cost) => (req, res, next) => {
  const units = cost(req);
  const { perMinute, perDay } = config.access;

  const day = take(dayWindows, req.client, 86_400_000, perDay, units);
  if (!day.ok) return tooMany(res, day.retryAfterS, `Daily limit of ${perDay} units reached for this key.`);

  const minute = take(minuteWindows, req.client, 60_000, perMinute, units);
  if (!minute.ok) {
    dayWindows.get(req.client).used -= units; // refused, so don't charge the day either
    return tooMany(res, minute.retryAfterS, `Limit of ${perMinute} units per minute reached for this key.`);
  }

  res.set('X-Units-Used', String(units));
  res.set('X-Units-Remaining-Minute', String(minute.remaining));
  res.set('X-Units-Remaining-Day', String(day.remaining));
  next();
};

function tooMany(res, retryAfterS, message) {
  res.set('Retry-After', String(retryAfterS));
  res.status(429).json({ error: `${message} Retry in ${retryAfterS}s.`, type: 'RateLimited' });
}
