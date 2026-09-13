/* JSON fetch that throws the SERVER'S message. Callers show err.message
   verbatim: the routes explain exactly why they refused. */
async function req(method, url, body) {
  const opt = { method, headers: {}, cache: 'no-store' };
  if (body !== undefined && body !== null) {
    opt.headers['Content-Type'] = 'application/json';
    opt.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(url, opt);
  } catch (e) {
    throw new Error('The app server is not reachable. Is `npm start` running?');
  }
  const ct = res.headers.get('content-type') || '';
  let data = null;
  if (ct.includes('application/json')) { try { data = await res.json(); } catch { data = null; } }
  if (!res.ok) throw new Error((data && data.error) || `${res.status} ${res.statusText}`);
  return data;
}

export const api = {
  get: (url) => req('GET', url),
  post: (url, body = {}) => req('POST', url, body),
  put: (url, body = {}) => req('PUT', url, body),
  del: (url) => req('DELETE', url),
  /* Poll a job until it settles. Resolves with job.result, rejects with job.error. */
  job(jobId, { onProgress, intervalMs = 1500, timeoutMs = 10 * 60 * 1000 } = {}) {
    const started = Date.now();
    return new Promise((resolve, reject) => {
      const tick = async () => {
        let job;
        try { job = await req('GET', `/api/jobs/${jobId}`); } catch (e) { return reject(e); }
        if (onProgress && job.progress) onProgress(job.progress, job);
        if (job.status === 'done') return resolve(job.result);
        if (job.status === 'error') return reject(new Error(job.error || 'The job failed.'));
        if (Date.now() - started > timeoutMs) return reject(new Error('Gave up waiting for the job.'));
        setTimeout(tick, document.hidden ? intervalMs * 3 : intervalMs);
      };
      tick();
    });
  },
};
