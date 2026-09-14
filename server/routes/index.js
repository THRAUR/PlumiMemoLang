/* Mounts every router. Each file exports `default router` (an express.Router)
   and is mounted at /api. A router that fails to import is reported and skipped
   so the rest of the app keeps working while one module is being rewritten. */
export const ROUTERS = ['health', 'settings', 'stats', 'words', 'lessons', 'notes', 'materials', 'review', 'challenge', 'suggestions', 'jobs', 'backup'];

export async function mountRoutes(app) {
  for (const name of ROUTERS) {
    try {
      const mod = await import(`./${name}.js`);
      app.use('/api', mod.default);
    } catch (e) {
      if (e.code === 'ERR_MODULE_NOT_FOUND' && String(e.message).includes(`${name}.js`)) {
        console.warn(`[routes] ${name}.js is missing — its endpoints are unavailable`);
      } else {
        console.error(`[routes] ${name}.js failed to load:`, e);
      }
    }
  }
}
