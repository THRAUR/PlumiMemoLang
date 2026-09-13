/* Job polling. Jobs live in memory only: a restart during an AI call loses the
   progress text, not the result (those are written to their own document). */
import { Router } from 'express';
import { getJob } from '../jobs.js';

const r = Router();

r.get('/jobs/:id', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'No such job. It may have finished a while ago.' });
  res.json(job);
});

export default r;
