// POST /api/boycott/verify   body: { "url": "...", "product": "...", "cause": "..." }
// The browser calls THIS route; this route calls the Boycott API with the secret key.

import { NextResponse } from 'next/server';
import { verifyLink, friendlyMessage, BoycottApiError } from '@/lib/boycott';

export async function POST(request: Request) {
  const { url, product, cause } = await request.json().catch(() => ({}));
  for (const [name, value] of Object.entries({ url, product, cause })) {
    if (typeof value !== 'string' || !value.trim() || value.length > 2000) {
      return NextResponse.json({ error: `Please fill in "${name}".` }, { status: 400 });
    }
  }

  try {
    return NextResponse.json(await verifyLink(url.trim(), product.trim(), cause.trim()));
  } catch (err) {
    console.error('[boycott] link check failed:', err);
    const status = err instanceof BoycottApiError && err.status >= 400 ? err.status : 502;
    return NextResponse.json({ error: friendlyMessage(err) }, { status });
  }
}
