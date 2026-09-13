/* Hash router. #/today is home. A view module exports
   default { id, title, render(root, params), unmount?() }. */
import { emit } from './state.js';

const ROUTES = [
  ['/today', () => import('./views/today.js')],
  ['/lessons/:id', () => import('./views/lessons.js')],
  ['/lessons', () => import('./views/lessons.js')],
  ['/review', () => import('./views/review.js')],
  ['/words/:id', () => import('./views/words.js')],
  ['/words', () => import('./views/words.js')],
  ['/challenge', () => import('./views/challenge.js')],
  ['/notes/:id', () => import('./views/notes.js')],
  ['/notes', () => import('./views/notes.js')],
  ['/settings', () => import('./views/settings.js')],
];

let root = null;
let active = null;       // { view, params }
let seq = 0;

export function parseHash(hash = location.hash) {
  const raw = (hash || '').replace(/^#/, '') || '/today';
  const [pathPart, queryPart = ''] = raw.split('?');
  const path = pathPart.startsWith('/') ? pathPart : '/' + pathPart;
  return { path, query: Object.fromEntries(new URLSearchParams(queryPart)) };
}

function match(path) {
  for (const [pattern, load] of ROUTES) {
    const pp = pattern.split('/'), sp = path.split('/');
    if (pp.length !== sp.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < pp.length; i++) {
      if (pp[i].startsWith(':')) params[pp[i].slice(1)] = decodeURIComponent(sp[i]);
      else if (pp[i] !== sp[i]) { ok = false; break; }
    }
    if (ok) return { pattern, load, params };
  }
  return null;
}

export function navigate(path, { replace = false } = {}) {
  const target = '#' + (path.startsWith('/') ? path : '/' + path);
  if (replace) history.replaceState(null, '', target); else location.hash = target;
  if (replace) run();
}
export function current() { return active ? { id: active.view.id, params: active.params } : null; }

async function run() {
  const my = ++seq;
  const { path, query } = parseHash();
  const m = match(path);
  if (!m) { navigate('/today', { replace: true }); return; }
  try { active?.view?.unmount?.(); } catch (e) { console.error(e); }
  const mod = await m.load();
  if (my !== seq) return;                       // a newer navigation won
  const view = mod.default;
  const params = { ...m.params, query };
  root.replaceChildren();
  root.scrollTop = 0; window.scrollTo(0, 0);
  document.body.dataset.view = view.id;
  active = { view, params };
  emit('route', { id: view.id, path, params });
  try {
    await view.render(root, params);
  } catch (e) {
    console.error(e);
    root.replaceChildren(errorBlock(e));
  }
  document.title = view.title ? `${view.title} · PlumiMemoLang` : 'PlumiMemoLang';
}

function errorBlock(e) {
  const d = document.createElement('div');
  d.className = 'empty';
  const t = document.createElement('p');
  t.className = 'h3'; t.textContent = 'This screen could not load.';
  const m = document.createElement('p');
  m.textContent = e?.message || String(e);
  d.append(t, m);
  return d;
}

export function initRouter(container) {
  root = container;
  window.addEventListener('hashchange', run);
  return run();
}
