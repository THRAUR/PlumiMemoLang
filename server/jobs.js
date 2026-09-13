/* In-memory jobs for AI work that takes longer than a phone will hold a request
   open. A route returns { jobId }; the client polls GET /api/jobs/:id. Results
   that matter are also written to their own document (a note's draft, the
   day's suggestions), so a restart loses only the progress text. */
import { newId } from './store.js';

const jobs = new Map();
const KEEP = 50;

export function createJob(kind, runner) {
  const job = {
    id: newId(), kind, status: 'queued', progress: '', result: null, error: null,
    createdAt: new Date().toISOString(), finishedAt: null,
  };
  jobs.set(job.id, job);
  if (jobs.size > KEEP) jobs.delete(jobs.keys().next().value);
  queueMicrotask(async () => {
    job.status = 'running';
    try {
      job.result = await runner(job);
      job.status = 'done';
    } catch (e) {
      job.status = 'error';
      job.error = e?.message || String(e);
      console.error(`[job ${kind} ${job.id}]`, job.error);
    } finally {
      job.finishedAt = new Date().toISOString();
    }
  });
  return job;
}

export function getJob(id) { return jobs.get(id) || null; }
export function setProgress(job, text) { if (job) job.progress = text; }
