const username = new URLSearchParams(location.search).get('username') || '';
const editor = document.getElementById('config');
const status = document.getElementById('status');
let currentExamples = [];
let visibleCount = 100;
document.getElementById('back').href = `/?username=${encodeURIComponent(username)}`;
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));

async function request(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Request failed.');
  return data;
}
async function loadConfig() {
  const config = await request('/api/normalization/config');
  editor.value = JSON.stringify(config, null, 2);
  status.textContent = 'Rules loaded.';
}
async function saveConfig() {
  let config;
  try { config = JSON.parse(editor.value); } catch (error) { throw new Error(`Config JSON is invalid: ${error.message}`); }
  const result = await request('/api/normalization/config', { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({config}) });
  editor.value = JSON.stringify(result.config, null, 2);
}
async function preview() {
  if (!username) throw new Error('Open this screen from the dashboard with a Last.fm username.');
  let config;
  try { config = JSON.parse(editor.value); } catch (error) { throw new Error(`Config JSON is invalid: ${error.message}`); }
  const data = await request(`/api/scrobbles/${encodeURIComponent(username)}/normalization-preview`, {
    method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({config}),
  });
  document.getElementById('stats').innerHTML = [
    ['Account', esc(data.username)], ['Saved scrobbles', data.sourceScrobbles.toLocaleString()],
    ['Normalized groups', data.groupCount.toLocaleString()], ['Plays retained', data.groupedPlays.toLocaleString()],
    ['Filtered by rules', data.ignoredScrobbles.toLocaleString()],
    ['Groups combining variants', data.exampleCount.toLocaleString()],
  ].map(([label,value]) => `<div class="stat">${label}<strong>${value}</strong></div>`).join('');
  currentExamples = data.examples || []; visibleCount = 100; renderExamples();
  status.textContent = `Preview for ${data.username} uses saved compact scrobbles.`;
}
function renderExamples() {
  const query = document.getElementById('search').value.trim().toLocaleLowerCase();
  const matching = currentExamples.filter(group => {
    const haystack = [group.canonical.artist, group.canonical.track, group.canonical.album,
      ...group.variations.flatMap(v => [v.artist, v.track, v.album])].join(' ').toLocaleLowerCase();
    return haystack.includes(query);
  });
  const body = document.getElementById('examples'); body.replaceChildren();
  for (const group of matching.slice(0, visibleCount)) {
    const tr = document.createElement('tr');
    const values = group.variations.map(value => `${value.preferred ? '★ ' : ''}${value.artist} — ${value.track}${value.album ? ` [${value.album}]` : ''} · ${value.scrobbleCount}`).join('<br>');
    tr.innerHTML = `<td>${esc(group.canonical.artist)}<br>${esc(group.canonical.track)}<br><span class="muted">${esc(group.canonical.album)}</span></td><td>${group.scrobbleCount}</td><td>${group.variationsCount}</td><td>${values.split('<br>').map(esc).join('<br>')}</td>`;
    body.append(tr);
  }
  if (!matching.length) body.innerHTML = `<tr><td colspan="4" class="muted">${currentExamples.length ? 'No matching groups.' : 'No groups currently combine distinct metadata variations.'}</td></tr>`;
  document.getElementById('resultCount').textContent = `Showing ${Math.min(visibleCount, matching.length).toLocaleString()} of ${matching.length.toLocaleString()} matching groups`;
  const more = document.getElementById('showMore'); more.style.display = matching.length > visibleCount ? '' : 'none';
}
document.getElementById('save').addEventListener('click', async () => { try { status.textContent = 'Saving…'; await saveConfig(); status.textContent = 'Rules saved.'; } catch (error) { status.textContent = error.message; } });
document.getElementById('preview').addEventListener('click', async () => { try { status.textContent = 'Calculating preview…'; await preview(); } catch (error) { status.textContent = error.message; } });
document.getElementById('search').addEventListener('input', () => { visibleCount = 100; renderExamples(); });
document.getElementById('showMore').addEventListener('click', () => { visibleCount += 100; renderExamples(); });
loadConfig().then(preview).catch(error => { status.textContent = error.message; });
