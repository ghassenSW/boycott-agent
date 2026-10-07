'use client';

// A ready-to-use search box: type a brand, see whether it's being boycotted, and why.
// Unstyled on purpose (plain inline styles): restyle it to match the site.
//
//   import BoycottChecker from '@/components/BoycottChecker';
//   <BoycottChecker />

import { useState } from 'react';

type Source = { title: string; url: string; date: string | null; timing: string };
type Result = {
  brand: string;
  status: 'active_boycott' | 'unclear' | 'no_evidence';
  confidence: number;
  reason: string;
  sources: Source[];
  checked_at: string;
};

const LABELS: Record<Result['status'], { text: string; color: string }> = {
  active_boycott: { text: 'Active boycott', color: '#b42318' },
  unclear: { text: 'Unclear', color: '#b54708' },
  no_evidence: { text: 'No current boycott found', color: '#027a48' },
};

export default function BoycottChecker() {
  const [brand, setBrand] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!brand.trim()) return;
    setLoading(true);
    setError('');
    setResult(null);
    try {
      const res = await fetch('/api/boycott/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ brand }),
      });
      const data = await res.json();
      if (!res.ok) setError(data.error ?? 'Something went wrong.');
      else setResult(data);
    } catch {
      setError('Could not reach the server. Check your connection.');
    } finally {
      setLoading(false);
    }
  }

  const label = result ? LABELS[result.status] : null;

  return (
    <div style={{ maxWidth: 640 }}>
      <form onSubmit={onSubmit} style={{ display: 'flex', gap: 8 }}>
        <input
          value={brand}
          onChange={(e) => setBrand(e.target.value)}
          placeholder="Brand name, e.g. Adidas"
          aria-label="Brand name"
          style={{ flex: 1, padding: 8 }}
        />
        <button type="submit" disabled={loading} style={{ padding: '8px 16px' }}>
          {loading ? 'Checking…' : 'Check'}
        </button>
      </form>

      {loading && <p>Searching recent news. The first check of a brand can take up to a minute.</p>}
      {error && <p role="alert" style={{ color: '#b42318' }}>{error}</p>}

      {result && label && (
        <section style={{ marginTop: 16 }}>
          <h3 style={{ color: label.color, margin: 0 }}>
            {result.brand}: {label.text}
          </h3>
          <p style={{ margin: '4px 0' }}>Confidence: {result.confidence}/100</p>
          {result.reason && <p>{result.reason}</p>}

          {result.sources.length > 0 && (
            <>
              <p style={{ marginBottom: 4 }}>Sources:</p>
              <ul>
                {result.sources.map((s) => (
                  <li key={s.url}>
                    <a href={s.url} target="_blank" rel="noopener noreferrer">{s.title}</a>
                    {s.timing === 'past' && ' (past boycott)'}
                  </li>
                ))}
              </ul>
            </>
          )}

          <p style={{ fontSize: 13, color: '#667085' }}>
            Based on the sources found online on {new Date(result.checked_at).toLocaleDateString()}. The confidence
            score reflects how much evidence exists, not how many people take part.
          </p>
        </section>
      )}
    </div>
  );
}
