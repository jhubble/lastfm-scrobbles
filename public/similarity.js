const query = new URLSearchParams(location.search);
const username = query.get('username') || '';
const status = document.getElementById('status');
document.getElementById('analysisLink').href = `analysis.html?username=${encodeURIComponent(username)}`;

const sectionDefinitions = [
  { id: 'merged', title: 'Selected duplicates', description: 'Variants that are currently merged under the selected name.' },
  { id: 'unselected', title: 'Unselected', description: 'Detected groups that do not have a saved decision yet.' },
  { id: 'ignore', title: 'Intentionally unselected', description: 'Groups you have chosen not to merge and do not want to review again.' },
  { id: 'separate', title: 'Keep different', description: 'Groups that should remain separate for now.' },
];
const typeLabels = { artists: 'Artist', albums: 'Album', tracks: 'Track' };
const variantScrobbleIndex = { artists: new Map(), albums: new Map(), tracks: new Map() };
const scrobbleText = value => typeof value === 'string' ? value : value?.['#text'] || value?.name || '';
const indexAdd = (map, key, track) => {
  const items = map.get(key) || [];
  items.push(track);
  map.set(key, items);
};

function indexVariantScrobbles(scrobbles) {
  for (const track of scrobbles) {
    const rawArtist = scrobbleText(track.artist) || 'Unknown artist';
    const artist = window.ScrobbleVariants.resolveArtist(rawArtist);
    const album = scrobbleText(track.album);
    const title = scrobbleText(track.name) || 'Unknown track';
    indexAdd(variantScrobbleIndex.artists, rawArtist, track);
    if (album) indexAdd(variantScrobbleIndex.albums, `${artist}\u0000${album}`, track);
    indexAdd(variantScrobbleIndex.tracks, `${artist}\u0000${title}`, track);
  }
}

function scrobblesForVariant(candidate, type, value) {
  if (type === 'artists') return variantScrobbleIndex.artists.get(value) || [];
  const artist = window.ScrobbleVariants.resolveArtist(candidate.artist);
  const key = `${artist}\u0000${value}`;
  return (type === 'albums' ? variantScrobbleIndex.albums : variantScrobbleIndex.tracks).get(key) || [];
}

function renderScrobbleBatch(container, tracks, start = 0) {
  const end = Math.min(start + 50, tracks.length);
  let table = container.querySelector('table');
  if (!table) {
    table = document.createElement('table');
    const thead = document.createElement('thead');
    const heading = document.createElement('tr');
    for (const label of ['Played at', 'Track', 'Artist', 'Album']) {
      const cell = document.createElement('th'); cell.textContent = label; heading.append(cell);
    }
    thead.append(heading); table.append(thead, document.createElement('tbody')); container.append(table);
  }
  const body = table.tBodies[0];
  for (const track of tracks.slice(start, end)) {
    const row = document.createElement('tr');
    const uts = Number(track?.date?.uts);
    const values = [Number.isFinite(uts) ? new Date(uts * 1000).toLocaleString() : 'Date unavailable', scrobbleText(track.name) || 'Unknown track', scrobbleText(track.artist) || 'Unknown artist', scrobbleText(track.album) || '—'];
    for (const value of values) { const cell = document.createElement('td'); cell.textContent = value; row.append(cell); }
    body.append(row);
  }
  container.querySelector('.more')?.remove();
  const footer = document.createElement('div'); footer.className = 'muted';
  footer.textContent = `Showing ${end.toLocaleString()} of ${tracks.length.toLocaleString()} scrobbles`;
  container.append(footer);
  if (end < tracks.length) {
    const more = document.createElement('button'); more.type = 'button'; more.className = 'more'; more.textContent = 'Load 50 more';
    more.addEventListener('click', () => { footer.remove(); renderScrobbleBatch(container, tracks, end); });
    container.append(more);
  }
}

function groupMatches(saved, candidate, type) {
  return (saved.variants || []).some(value => candidate.variants.includes(value))
    && (type === 'artists' || window.ScrobbleVariants.rawKey(saved.artist) === window.ScrobbleVariants.rawKey(candidate.artist));
}

async function saveCandidate(candidate, type, decision, canonical, candidates, variants) {
  const groups = structuredClone(variants.groups);
  const decisions = structuredClone(variants.decisions);
  const matches = item => groupMatches(item, candidate, type);
  const existingMerges = groups[type].filter(matches);
  const existingDecisions = decisions[type].filter(matches);
  groups[type] = groups[type].filter(item => !matches(item));
  decisions[type] = decisions[type].filter(item => !matches(item));
  const artist = type === 'artists' ? '' : window.ScrobbleVariants.resolveArtist(candidate.artist);
  const mergedVariants = [...new Set([...existingMerges.flatMap(group => group.variants || []), ...existingDecisions.flatMap(group => group.variants || []), ...candidate.variants])];
  if (decision === 'merged') {
    groups[type].push({ ...(type === 'artists' ? {} : { artist }), canonical, variants: mergedVariants });
  } else if (decision !== 'unselected') {
    decisions[type].push({ ...(type === 'artists' ? {} : { artist }), status: decision, variants: mergedVariants });
  }
  status.textContent = 'Saving your decision…';
  document.querySelectorAll('#groups button, #groups input').forEach(control => { control.disabled = true; });
  try {
    const saved = await window.ScrobbleVariants.save(username, groups, decisions);
    variants.groups = saved.groups;
    variants.decisions = saved.decisions;
    const refreshed = window.ScrobbleVariants.detect(window.__similarityScrobbles);
    status.textContent = 'Decision saved to this account. Reports will apply merged variants automatically.';
    renderCandidates(refreshed, variants);
  } catch (error) {
    status.textContent = `Could not save this decision: ${error.message}`;
    document.querySelectorAll('#groups button, #groups input').forEach(control => { control.disabled = false; });
  }
}

function renderCard(candidate, type, variants, candidates) {
  const card = document.createElement('section'); card.className = 'variant-card';
  const title = document.createElement('h3');
  title.textContent = `${typeLabels[type]}${type === 'artists' ? '' : ` · ${candidate.artist}`} · ${candidate.plays.toLocaleString()} plays affected`;
  card.append(title);
  for (const value of candidate.variants) {
    const row = document.createElement('div'); row.className = 'variant-choice';
    const label = document.createElement('label');
    const radio = document.createElement('input'); radio.type = 'radio'; radio.name = `variant-${type}-${candidate.variants.join('|')}`;
    radio.checked = candidate.status === 'merged' && value === candidate.canonical;
    const name = document.createElement('span'); name.textContent = value;
    label.append(radio, name);
    const count = document.createElement('span'); count.className = 'count muted';
    count.textContent = `${Number(candidate.counts[value] || 0).toLocaleString()} plays`;
    const plays = scrobblesForVariant(candidate, type, value);
    const view = document.createElement('button'); view.type = 'button'; view.textContent = `View scrobbles (${plays.length.toLocaleString()})`;
    const results = document.createElement('div'); results.className = 'scrobble-results'; results.hidden = true;
    view.addEventListener('click', () => {
      results.hidden = !results.hidden;
      view.textContent = `${results.hidden ? 'View' : 'Hide'} scrobbles (${plays.length.toLocaleString()})`;
      if (!results.hidden && !results.hasChildNodes()) renderScrobbleBatch(results, [...plays].reverse());
    });
    row.append(label, count, view, results); card.append(row);
    radio.addEventListener('change', () => saveCandidate(candidate, type, 'merged', value, candidates, variants));
  }
  const actions = document.createElement('div'); actions.className = 'variant-actions';
  for (const [decision, label] of [['ignore', 'Intentionally unselected'], ['separate', 'Keep different'], ['unselected', 'Clear decision']]) {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
    button.disabled = candidate.status === decision || (decision === 'unselected' && candidate.status === 'unselected');
    button.addEventListener('click', () => saveCandidate(candidate, type, decision, null, candidates, variants));
    actions.append(button);
  }
  card.append(actions);
  return card;
}

function renderCandidates(candidates, variants) {
  const root = document.getElementById('groups');
  root.replaceChildren();
  const buckets = { merged: [], unselected: [], ignore: [], separate: [] };
  for (const type of ['artists', 'albums', 'tracks']) {
    for (const candidate of candidates[type]) buckets[candidate.status]?.push({ candidate, type });
  }
  for (const section of sectionDefinitions) {
    const items = buckets[section.id].sort((a, b) => b.candidate.plays - a.candidate.plays
      || a.candidate.variants.join('').localeCompare(b.candidate.variants.join('')));
    const sectionElement = document.createElement('section'); sectionElement.id = section.id; sectionElement.className = 'decision-section';
    const heading = document.createElement('h2'); heading.textContent = `${section.title} (${items.length})`;
    sectionElement.append(heading);
    const description = document.createElement('p'); description.className = 'muted'; description.textContent = section.description; sectionElement.append(description);
    if (!items.length) {
      const empty = document.createElement('div'); empty.className = 'empty'; empty.textContent = 'No groups in this section.'; sectionElement.append(empty); root.append(sectionElement); continue;
    }
    for (const { candidate, type } of items) sectionElement.append(renderCard(candidate, type, variants, candidates));
    root.append(sectionElement);
  }
}

async function loadPage() {
  if (!username) throw new Error('Open Similarity Detection from Listening Analysis so the Last.fm username is included.');
  let scrobbles = [];
  try { scrobbles = JSON.parse(sessionStorage.getItem(`lastfm_scrobbles_${username.toLowerCase()}`) || '[]'); } catch {}
  if (!scrobbles.length) {
    const response = await fetch(`/api/scrobbles/${encodeURIComponent(username)}`);
    if (!response.ok) throw new Error(`Could not load scrobbles (HTTP ${response.status}).`);
    const data = await response.json();
    scrobbles = Array.isArray(data.scrobbles) ? data.scrobbles : [];
    try { sessionStorage.setItem(`lastfm_scrobbles_${username.toLowerCase()}`, JSON.stringify(scrobbles)); } catch {}
  }
  window.__similarityScrobbles = scrobbles;
  const variants = await window.ScrobbleVariants.load(username);
  indexVariantScrobbles(scrobbles);
  const candidates = window.ScrobbleVariants.detect(scrobbles);
  const count = Object.values(candidates).reduce((total, groups) => total + groups.length, 0);
  status.textContent = `Reviewed ${scrobbles.length.toLocaleString()} scrobbles and found ${count.toLocaleString()} variation groups. Choose a canonical name to merge; other decisions are saved separately.`;
  renderCandidates(candidates, variants);
}

loadPage().catch(error => { status.textContent = error.message; });
