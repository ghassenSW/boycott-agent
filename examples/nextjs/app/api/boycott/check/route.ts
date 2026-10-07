// POST /api/boycott/check   body: { "brand": "Adidas" }
// The browser calls THIS route; this route calls the Boycott API with the secret key.

import { NextResponse } from 'next/server';
import { checkBrand, friendlyMessage, BoycottApiError } from '@/lib/boycott';

export async function POST(request: Request) {
  const { brand } = await request.json().catch(() => ({}));
  if (typeof brand !== 'string' || !brand.trim() || brand.length > 100) {
    return NextResponse.json({ error: 'Please type a brand name.' }, { status: 400 });
  }

  try {
    return NextResponse.json(await checkBrand(brand.trim()));
  } catch (err) {
    console.error('[boycott] brand check failed:', err);
    const status = err instanceof BoycottApiError && err.status >= 400 ? err.status : 502;
    return NextResponse.json({ error: friendlyMessage(err) }, { status });
  }
}
