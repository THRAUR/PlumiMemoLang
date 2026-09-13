/* The Today numbers and the AI spend log. */
import { Router } from 'express';
import { coll } from '../store.js';
import { getStats, usageTotals } from '../stats.js';

const r = Router();

r.get('/stats', (req, res) => res.json(getStats()));

r.get('/usage', (req, res) => {
  // Newest first, capped: the log is append-only and the learner only ever
  // looks at the recent calls.
  const entries = [...coll('usage').all()].sort((a, b) => String(b.at || '').localeCompare(String(a.at || ''))).slice(0, 200);
  res.json({ entries, totals: usageTotals() });
});

export default r;
