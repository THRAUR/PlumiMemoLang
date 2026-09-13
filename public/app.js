/* Entry. Nothing may import this file. Order matters: state first (views
   read settings while rendering), then the shell, then the router. */
import { initState, on, stats, settings } from './js/state.js';
import { initRouter } from './js/router.js';
import { h, pixelIcon, initXpPops, toast } from './js/ui.js';

function statChips() {
  const s = stats;
  const streak = h('span', { class: `streak${s?.streak?.activeToday ? '' : ' is-cold'}`, title: 'Day streak' }, pixelIcon('flame', 2), String(s?.streak?.current ?? 0));
  const xp = h('span', { class: 'xp', title: 'XP today / daily goal' }, h('b', null, String(s?.xpToday ?? 0)), `/ ${s?.goal ?? settings?.dailyGoalXp ?? 30} XP`);
  return [streak, xp];
}
function renderStats() {
  for (const id of ['topbarStats', 'railStats']) {
    const box = document.getElementById(id);
    if (box) box.replaceChildren(...statChips());
  }
}
function markNav(id) {
  const key = id === 'challenge' ? 'challenge' : id;
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('is-active', a.dataset.nav === key));
}
function themeButton() {
  const btn = document.getElementById('themeBtn');
  const label = document.getElementById('themeLabel');
  const paint = () => {
    const dark = window.PlumiTheme.resolved() === 'dark';
    label.textContent = dark ? 'Light' : 'Dark';
    const px = btn.querySelector('.px');
    px.replaceChildren(); px.dataset.art = dark ? 'sun' : 'moon'; window.PlumiPixel.render(px);
  };
  btn.addEventListener('click', () => { window.PlumiTheme.toggle(); paint(); });
  paint();
}

async function main() {
  await initState();
  renderStats();
  on('stats', renderStats);
  on('settings', renderStats);
  on('route', ({ id }) => { markNav(id); document.getElementById('topbarTitle').textContent = ''; });
  initXpPops();
  themeButton();
  await initRouter(document.getElementById('view'));
  // The boot wink runs once; drop the class so a re-render never replays it.
  setTimeout(() => document.body.classList.remove('pl-boot'), 900);
}
main().catch((e) => { console.error(e); toast(e.message, 'bad', 6000); });

