/* Cross-cutting client state. Modules read the live bindings and write
   through the setters, which notify listeners. */
import { api } from './api.js';

export let settings = null;
export let stats = null;

const listeners = new Map();
export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => listeners.get(event)?.delete(fn);
}
export function emit(event, data) {
  for (const fn of listeners.get(event) || []) { try { fn(data); } catch (e) { console.error(e); } }
}

export function setSettings(s) { settings = s; emit('settings', s); }
export function setStats(s) {
  const prev = stats;
  stats = s;
  emit('stats', s);
  if (prev && s && s.xpToday > prev.xpToday) emit('xp', { amount: s.xpToday - prev.xpToday });
}
export async function refreshStats() {
  try { setStats(await api.get('/api/stats')); } catch (e) { console.warn('stats:', e.message); }
  return stats;
}
export async function refreshSettings() {
  try { setSettings(await api.get('/api/settings')); } catch (e) { console.warn('settings:', e.message); }
  return settings;
}
export async function initState() {
  await Promise.all([refreshSettings(), refreshStats()]);
}
