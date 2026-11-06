const username = new URLSearchParams(location.search).get('username') || '';
const editor = document.getElementById('config');
const status = document.getElementById('status');
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
    ['Normalized groups', data.groups.length.toLocaleString()], ['Plays retained', data.groupedPlays.toLocaleString()],
    ['Filtered by rules', data.ignoredScrobbles.toLocaleString()],
    ['Groups combining variants', data.examples.length.toLocaleString()],
  ].map(([label,value]) => `<div class="stat">${label}<strong>${value}</strong></div>`).join('');
  const body = document.getElementById('examples'); body.replaceChildren();
  for (const group of data.examples) {
    const tr = document.createElement('tr');
    const values = group.variations.map(value => `${value.artist} — ${value.track}${value.album ? ` [${value.album}]` : ''}`).join('\n');
    tr.innerHTML = `<td>${esc(group.canonical.artist)}<br>${esc(group.canonical.track)}<br><span class="muted">${esc(group.canonical.album)}</span></td><td>${group.scrobbleCount}</td><td>${group.variationsCount}</td><td>${esc(values)}</td>`;
    body.append(tr);
  }
  if (!data.examples.length) body.innerHTML = '<tr><td colspan="4" class="muted">No groups currently combine distinct metadata variations.</td></tr>';
  status.textContent = `Preview for ${data.username} uses saved compact scrobbles.`;
}
document.getElementById('save').addEventListener('click', async () => { try { status.textContent = 'Saving…'; await saveConfig(); status.textContent = 'Rules saved.'; } catch (error) { status.textContent = error.message; } });
document.getElementById('preview').addEventListener('click', async () => { try { status.textContent = 'Calculating preview…'; await preview(); } catch (error) { status.textContent = error.message; } });
loadConfig().then(preview).catch(error => { status.textContent = error.message; });
