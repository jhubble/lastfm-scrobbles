const params = new URLSearchParams(location.search);
const username = params.get('username') || '';
const status = document.getElementById('status');
const root = document.getElementById('rules');
document.getElementById('back').href = `/?username=${encodeURIComponent(username)}`;
let config = { version: 1, rules: [] };
let candidates = [];

const idFor = candidate => `${candidate.book.normalize('NFKC').trim().toLocaleLowerCase()}::${candidate.author.normalize('NFKC').trim().toLocaleLowerCase()}`;
async function save() {
  const response = await fetch(`/api/scrobbles/${encodeURIComponent(username)}/preprocessing`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rules: config.rules }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Could not save preprocessing rules.');
  config = data.config;
}
function render() {
  root.replaceChildren();
  if (!candidates.length) {
    const empty = document.createElement('section'); empty.className = 'card muted';
    empty.textContent = 'No likely chapter and author patterns found. Detection currently looks for repeated books with at least two distinct chapter-like artist values.';
    root.append(empty);
  }
  for (const candidate of candidates) {
    const id = idFor(candidate);
    const saved = config.rules.find(rule => rule.id === id);
    const card = document.createElement('section'); card.className = 'card';
    const title = document.createElement('h2'); title.textContent = candidate.book;
    const meta = document.createElement('p'); meta.className = 'muted';
    meta.textContent = `${candidate.plays.toLocaleString()} scrobbles · author: ${candidate.author}`;
    const detail = document.createElement('p'); detail.textContent = `Chapter values: ${candidate.chapters.join(' · ')}`;
    const label = document.createElement('label'); label.className = 'row';
    const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = Boolean(saved?.enabled);
    const text = document.createElement('span'); text.textContent = 'Normalize this book’s scrobbles';
    label.append(checkbox, text);
    const note = document.createElement('p'); note.className = 'muted'; note.textContent = saved?.enabled ? 'Rule is active. Reload analysis pages to see normalized fields.' : 'Review the values above before enabling.';
    checkbox.addEventListener('change', async () => {
      checkbox.disabled = true;
      const nextRule = { id, type: 'audiobook-swapped-fields', book: candidate.book, author: candidate.author, chapters: candidate.chapters, enabled: checkbox.checked };
      config.rules = [...config.rules.filter(rule => rule.id !== id), nextRule];
      try { await save(); status.textContent = 'Preprocessing rules saved.'; render(); }
      catch (error) { status.textContent = error.message; checkbox.checked = !checkbox.checked; checkbox.disabled = false; }
    });
    card.append(title, meta, detail, label, note); root.append(card);
  }
  const orphaned = config.rules.filter(rule => !candidates.some(candidate => idFor(candidate) === rule.id));
  if (orphaned.length) {
    const card = document.createElement('section'); card.className = 'card';
    const heading = document.createElement('h2'); heading.textContent = 'Saved rules'; card.append(heading);
    for (const rule of orphaned) {
      const row = document.createElement('div'); row.className = 'rule row';
      const label = document.createElement('span'); label.textContent = `${rule.book} — ${rule.author}${rule.enabled ? ' (active)' : ' (paused)'}`;
      const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'Remove';
      remove.addEventListener('click', async () => { config.rules = config.rules.filter(value => value.id !== rule.id); try { await save(); render(); status.textContent = 'Rule removed.'; } catch (error) { status.textContent = error.message; } });
      row.append(label, remove); card.append(row);
    }
    root.append(card);
  }
}
async function load() {
  if (!username) throw new Error('Open preprocessing from the dashboard with a Last.fm username.');
  const response = await fetch(`/api/scrobbles/${encodeURIComponent(username)}/preprocessing`);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Could not load preprocessing data.');
  config = data.config || config; candidates = data.candidates || [];
  status.textContent = `Found ${candidates.length.toLocaleString()} likely audiobook layout${candidates.length === 1 ? '' : 's'} for ${username}.`;
  render();
}
load().catch(error => { status.textContent = error.message; });
