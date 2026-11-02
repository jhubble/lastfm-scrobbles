const params = new URLSearchParams(location.search);
const username = params.get('username') || '';
// Link back to similarity page (fixed string interpolation)
document.getElementById('similarityLink').href = `similarity.html?username=${encodeURIComponent(username)}`;
let scrobbles = [];
let visibleScrobbles = [];
let itemLimit = 25;
let categoryFilter = 'all';
let viewMode = 'all';
let activeRange = { start: new Date(Date.now() - 30 * 86400000), end: new Date(), label: 'Last 30 days' };
let analysisUpdateId = 0;
const nextAnalysisFrame = () => new Promise(resolve => requestAnimationFrame(resolve));

function setAnalysisLoading(message) {
  const indicator = document.getElementById('loadingIndicator');
  if (!indicator) return;
  indicator.style.display = 'flex';
  indicator.setAttribute('aria-busy', 'true');
  document.getElementById('loadingMessage').textContent = message;
}

function finishAnalysisLoading(updateId) {
  if (updateId !== analysisUpdateId) return;
  const indicator = document.getElementById('loadingIndicator');
  if (!indicator) return;
  indicator.style.display = 'none';
  indicator.setAttribute('aria-busy', 'false');
}

function markAnalysisStale() {
  analysisUpdateId++;
  const indicator = document.getElementById('loadingIndicator');
  if (indicator) {
    indicator.style.display = 'none';
    indicator.setAttribute('aria-busy', 'false');
  }
  const notice = document.getElementById('analysisStale');
  if (notice) notice.hidden = false;
}

function clearAnalysisStale() {
  const notice = document.getElementById('analysisStale');
  if (notice) notice.hidden = true;
}

function syncAnalysisUrl() {
  const url = new URL(location.href);
  url.searchParams.set('view', viewMode);
  url.searchParams.set('category', categoryFilter);
  url.searchParams.set('limit', String(itemLimit));
  url.searchParams.set('start', String(activeRange.start.getTime()));
  url.searchParams.set('end', String(activeRange.end.getTime()));
  history.replaceState(null, '', url);
}

function restoreAnalysisFilters() {
  const validValue = (id, value) => [...document.getElementById(id).options].some(option => option.value === value);
  const requestedView = params.get('view');
  if (requestedView && validValue('viewFilter', requestedView)) viewMode = requestedView;
  const requestedCategory = params.get('category');
  if (requestedCategory && validValue('categoryFilter', requestedCategory)) categoryFilter = requestedCategory;
  const requestedLimit = Number(params.get('limit'));
  if (Number.isInteger(requestedLimit) && requestedLimit >= 1 && requestedLimit <= 500) itemLimit = requestedLimit;
  const start = Number(params.get('start'));
  const end = Number(params.get('end'));
  const hasValidRange = params.has('start') && params.has('end') && Number.isFinite(start) && Number.isFinite(end) && start >= 0 && start <= end;
  if (hasValidRange) {
    activeRange = { start: new Date(start), end: new Date(end), label: `${new Date(start).toLocaleDateString()} – ${new Date(end).toLocaleDateString()}` };
  }
  document.getElementById('viewFilter').value = viewMode;
  document.getElementById('categoryFilter').value = categoryFilter;
  document.getElementById('itemLimit').value = itemLimit;
  if (hasValidRange) {
    document.getElementById('startDate').value = localDateInputValue(new Date(start));
    document.getElementById('endDate').value = localDateInputValue(new Date(end));
  }
}

function localDateInputValue(date) {
  const pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function textOf(value, fallback = '') {
  if (typeof value === 'string') return value.trim() || fallback;
  return String(value?.['#text'] || value?.name || fallback).trim();
}

function scrobbleDate(track) {
  const uts = Number(track?.date?.uts);
  return Number.isFinite(uts) ? new Date(uts * 1000) : null;
}

function keyForDate(date, granularity) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  return granularity === 'month' ? `${y}-${m}` : String(y);
}

function incrementRankingCounts(counts, track, selectedType = 'all') {
  const rawArtist = textOf(track.artist, 'Unknown artist');
  const artist = ScrobbleVariants.resolveArtist(rawArtist);
  const title = ScrobbleVariants.resolveTrack(rawArtist, textOf(track.name, 'Unknown track'));
  const album = ScrobbleVariants.resolveAlbum(rawArtist, textOf(track.album));
  const values = [
    ['tracks', `${artist}\u0000${title}`, title, artist],
    ...(album ? [['albums', `${artist}\u0000${album}`, album, artist]] : []),
    ['artists', artist, artist, ''],
  ];
  for (const [type, key, primary, secondary] of values) {
    if (selectedType !== 'all' && type !== selectedType) continue;
    const item = counts[type].get(key) || { primary, secondary, count: 0 };
    item.count++;
    counts[type].set(key, item);
  }
}

function finishRankingCounts(counts) {
  return Object.fromEntries(Object.entries(counts).map(([type, values]) => [
    type,
    [...values.values()].sort((a, b) => b.count - a.count || a.primary.localeCompare(b.primary)),
  ]));
}

function detailHref(type, name, artist = '') {
  // Build link to detail page without filter criteria.
  // Category filter is intentionally omitted to show all data.
  const query = new URLSearchParams({ username, type, name, artist });
  return `detail.html?${query.toString()}`;
}

function renderInsights(containerId, groups, emptyMessage) {
  const container = document.getElementById(containerId);
  container.replaceChildren();
  const allTypes = [['tracks', 'Tracks'], ['albums', 'Albums'], ['artists', 'Artists']];
  const types = viewMode === 'all' ? allTypes : allTypes.filter(([type]) => type === viewMode);
  for (const [type, title] of types) {
    const section = document.createElement('div'); section.className = 'insight-group';
    const heading = document.createElement('h3'); heading.textContent = title; section.append(heading);
    const list = document.createElement('ol');
    const entries = groups[type] || [];
    if (!entries.length) {
      const empty = document.createElement('li'); empty.className = 'empty'; empty.textContent = emptyMessage; list.append(empty);
    } else {
      entries.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).slice(0, itemLimit).forEach(item => {
        const row = document.createElement('li');
        const name = document.createElement('a'); name.className = 'name';
        name.href = detailHref(type === 'artists' ? 'artist' : type === 'albums' ? 'album' : 'track', item.name, item.artist);
        name.target = '_blank';
        name.textContent = type === 'artists' ? item.name : `${item.name} — ${item.artist}`;
        const plays = document.createElement('button');
        plays.type = 'button';
        plays.className = 'plays';
        plays.textContent = `${item.count} plays`;
        // Store data for toggling
        plays.dataset.type = type;
        plays.dataset.name = item.name;
        plays.dataset.artist = item.artist || '';
        plays.addEventListener('click', () => toggleScrobbleList(plays, item, type));
        row.append(name, plays);
        list.append(row);
      });
    }
    section.append(list); container.append(section);
  }
}

function toggleScrobbleList(button, item, type) {
  // Find existing inline list sibling
  const existing = button.parentElement.querySelector('.inline-scrobble-list');
  if (existing) {
    existing.remove();
    button.setAttribute('aria-expanded', 'false');
    return;
  }
  // Create list container
  const listDiv = document.createElement('div');
  listDiv.className = 'inline-scrobble-list';
  listDiv.style.marginTop = '0.5em';
  const ul = document.createElement('ul');
  // Filter scrobbles matching the item
  const matches = scrobbles.filter(s => {
    const rawArtist = textOf(s.artist, 'Unknown artist');
    const artist = ScrobbleVariants.resolveArtist(rawArtist);
    if (type === 'artists') return artist === item.name;
    const title = ScrobbleVariants.resolveTrack(rawArtist, textOf(s.name, ''));
    const album = ScrobbleVariants.resolveAlbum(rawArtist, textOf(s.album));
    if (type === 'tracks') return `${artist}\u0000${title}` === `${artist}\u0000${item.name}`;
    if (type === 'albums') return album && `${artist}\u0000${album}` === `${artist}\u0000${item.name}`;
    return false;
  });
  matches.forEach(s => {
    const li = document.createElement('li');
    const date = scrobbleDate(s);
    const dateStr = date ? date.toLocaleDateString() : '';
    const rawArtist = textOf(s.artist, '');
    const artist = ScrobbleVariants.resolveArtist(rawArtist);
    const title = ScrobbleVariants.resolveTrack(rawArtist, textOf(s.name, ''));
    const album = ScrobbleVariants.resolveAlbum(rawArtist, textOf(s.album));
    li.textContent = `${dateStr}: ${title}${album ? ' — ' + album : ''} (${artist})`;
    ul.append(li);
  });
  if (!matches.length) {
    const empty = document.createElement('p');
    empty.textContent = 'No scrobbles found.';
    listDiv.append(empty);
  } else {
    listDiv.append(ul);
  }
  button.parentElement.append(listDiv);
  button.setAttribute('aria-expanded', 'true');
}


async function updateInsights(categoryScopedScrobbles, updateId) {
  const types = viewMode === 'all' ? ['tracks', 'albums', 'artists'] : [viewMode];
  const counts = Object.fromEntries(types.map(type => [type, { current: new Map(), history: new Map(), previous: new Map() }]));
  const currentStart = activeRange.start.getTime();
  const currentEnd = activeRange.end.getTime();
  const duration = currentEnd - currentStart + 1;
  const previousStart = currentStart - duration;
  const previousEnd = currentStart - 1;

  const addCount = (map, key, artist, itemName) => {
    const item = map.get(key) || { key, artist, name: itemName, count: 0 };
    item.count++;
    map.set(key, item);
  };
  for (let start = 0; start < categoryScopedScrobbles.length; start += 5000) {
    const end = Math.min(start + 5000, categoryScopedScrobbles.length);
    for (let i = start; i < end; i++) {
      const track = categoryScopedScrobbles[i];
      const date = scrobbleDate(track);
      if (!date) continue;
      const time = date.getTime();
      const current = time >= currentStart && time <= currentEnd;
      const previous = time >= previousStart && time <= previousEnd;
      const rawArtist = textOf(track.artist, 'Unknown artist');
      const artist = ScrobbleVariants.resolveArtist(rawArtist);
      const title = ScrobbleVariants.resolveTrack(rawArtist, textOf(track.name, 'Unknown track'));
      const album = ScrobbleVariants.resolveAlbum(rawArtist, textOf(track.album));
      const values = {
        tracks: [`${artist}\u0000${title}`, artist, title],
        albums: album ? [`${artist}\u0000${album}`, artist, album] : null,
        artists: [artist, artist, artist],
      };
      for (const type of types) {
        const entry = values[type];
        if (!entry) continue;
        const [key, itemArtist, itemName] = entry;
        addCount(counts[type].history, key, itemArtist, itemName);
        if (current) addCount(counts[type].current, key, itemArtist, itemName);
        if (previous) addCount(counts[type].previous, key, itemArtist, itemName);
      }
    }
    if (updateId !== analysisUpdateId) return false;
    if (end < categoryScopedScrobbles.length) {
      setAnalysisLoading(`Comparing listening patterns… ${end.toLocaleString()} of ${categoryScopedScrobbles.length.toLocaleString()} scrobbles`);
      await nextAnalysisFrame();
      if (updateId !== analysisUpdateId) return false;
    }
  }

  const newHits = {}, lostFriends = {}, justNow = {};
  for (const type of types) {
    const { current, history, previous } = counts[type];
    newHits[type] = activeRange.label === 'All time'
      ? []
      : [...current.values()].filter(item => !previous.has(item.key));
    lostFriends[type] = [...history.values()].filter(item => !current.has(item.key));
    justNow[type] = [...current.values()].filter(item => {
      const total = history.get(item.key);
      return total && total.count === item.count;
    });
  }
  const noPreviousRange = activeRange.label === 'All time';
  renderInsights('newHitsLists', newHits, noPreviousRange ? 'No preceding range to compare.' : 'No new items in this range.');
  renderInsights('lostFriendsLists', lostFriends, 'No absent items found.');
  renderInsights('justNowLists', justNow, 'No items unique to this range.');
  return true;
}

function renderList(id, entries) {
  const list = document.getElementById(id);
  list.replaceChildren();
  if (!entries.length) {
    const empty = document.createElement('li');
    empty.className = 'empty'; empty.textContent = 'No scrobbles in this range.';
    list.append(empty); return;
  }
  for (const item of entries.slice(0, itemLimit)) {
    const row = document.createElement('li');
    const name = document.createElement('a'); name.className = 'name';
    name.href = detailHref(id === 'tracks' ? 'track' : id === 'albums' ? 'album' : 'artist', item.primary, item.secondary || '');
    name.target = '_blank';
    name.textContent = item.primary;
    if (item.secondary) {
      const detail = document.createElement('span'); detail.className = 'muted';
      detail.textContent = ` — ${item.secondary}`; name.append(detail);
    }
    const plays = document.createElement('button');
    plays.type = 'button';
    plays.className = 'plays';
    plays.textContent = `${item.count.toLocaleString()} ${item.count === 1 ? 'play' : 'plays'}`;
    plays.setAttribute('aria-expanded', 'false');
    plays.addEventListener('click', () => toggleRankingScrobbles(plays, id, item));
    row.append(name, plays); list.append(row);
    const entityType = id === 'tracks' ? 'track' : id === 'albums' ? 'album' : 'artist';
    const entity = { type: entityType, artist: id === 'artists' ? '' : item.secondary || '', name: item.primary };
    const control = document.createElement('select');
    control.className = 'category-select';
    control.setAttribute('aria-label', `Category for ${item.primary}`);
    control.dataset.entityType = entityType;
    control.dataset.entityArtist = entity.artist;
    control.dataset.entityName = entity.name;
    const selectedCategory = ScrobbleCategories.entityCategory(entityType, entity.artist, entity.name, scrobbles);
    const automaticCategory = ScrobbleCategories.automaticEntityCategory(entityType, entity.artist, entity.name, scrobbles);
    const automaticLabel = automaticCategory === 'both' ? 'Music and audiobook' : automaticCategory === 'audiobook' ? 'Audiobook' : 'Music';
    const explicitCategory = ScrobbleCategories.entityOverride(entityType, entity.artist, entity.name);
    const inheritedCategory = entityType === 'artist' ? null : ScrobbleCategories.inheritedArtistCategory(entity.artist);
    for (const [value, label] of [['music', 'Music'], ['audiobook', 'Audiobook'], ['both', 'Both'], ['auto', 'Automatic']]) {
      const option = document.createElement('option'); option.value = value;
      option.textContent = value === 'auto' ? `Automatic · ${automaticLabel}` : label;
      option.selected = inheritedCategory ? value === inheritedCategory : value === 'auto' ? !explicitCategory : selectedCategory === value;
      control.append(option);
    }
    control.disabled = Boolean(inheritedCategory);
    if (inheritedCategory) control.title = `Inherited from artist classification: ${inheritedCategory}`;
    control.addEventListener('change', async () => {
      const previousSelection = explicitCategory || 'auto';
      control.disabled = true;
      try {
        await ScrobbleCategories.setCategory(username, entity, control.value, scrobbles);
      } catch (error) {
        alert(error.message);
        control.value = previousSelection;
        control.disabled = false;
        return;
      }
      if (categoryFilter === 'all') {
        control.disabled = false;
        return;
      }
      control.disabled = false;
      markAnalysisStale();
    });
    row.append(control);
  }
}

function toggleRankingScrobbles(button, type, item) {
  const existing = button.parentElement.querySelector('.inline-scrobble-list');
  if (existing) {
    existing.remove();
    button.setAttribute('aria-expanded', 'false');
    button.textContent = `${item.count.toLocaleString()} ${item.count === 1 ? 'play' : 'plays'}`;
    return;
  }
  const artistKey = ScrobbleVariants.resolveArtist(item.secondary || item.primary);
  const matches = visibleScrobbles.filter(track => {
    const rawArtist = textOf(track.artist, 'Unknown artist');
    const artist = ScrobbleVariants.resolveArtist(rawArtist);
    if (type === 'artists') return artist === artistKey;
    if (artist !== ScrobbleVariants.resolveArtist(item.secondary || '')) return false;
    if (type === 'tracks') return ScrobbleVariants.resolveTrack(rawArtist, textOf(track.name)) === item.primary;
    return ScrobbleVariants.resolveAlbum(rawArtist, textOf(track.album)) === item.primary;
  }).reverse();
  const panel = document.createElement('div'); panel.className = 'inline-scrobble-list';
  renderScrobbleBatch(panel, matches);
  button.parentElement.append(panel);
  button.setAttribute('aria-expanded', 'true');
  button.textContent = `Hide ${item.count.toLocaleString()} ${item.count === 1 ? 'play' : 'plays'}`;
}

function renderScrobbleBatch(container, tracks, start = 0) {
  const end = Math.min(start + 50, tracks.length);
  let table = container.querySelector('table');
  if (!table) {
    table = document.createElement('table');
    const head = document.createElement('thead');
    const row = document.createElement('tr');
    for (const label of ['Played at', 'Track', 'Artist', 'Album']) { const th = document.createElement('th'); th.textContent = label; row.append(th); }
    head.append(row); table.append(head, document.createElement('tbody')); container.append(table);
  }
  const body = table.tBodies[0];
  for (const track of tracks.slice(start, end)) {
    const row = document.createElement('tr');
    const uts = Number(track?.date?.uts);
    const cells = [Number.isFinite(uts) ? new Date(uts * 1000).toLocaleString() : 'Date unavailable', textOf(track.name, 'Unknown track'), textOf(track.artist, 'Unknown artist'), textOf(track.album, '—')];
    for (const value of cells) { const td = document.createElement('td'); td.textContent = value; row.append(td); }
    body.append(row);
  }
  container.querySelector('.scrobble-footer')?.remove();
  container.querySelector('.scrobble-more')?.remove();
  const footer = document.createElement('div'); footer.className = 'muted scrobble-footer'; footer.textContent = `Showing ${end.toLocaleString()} of ${tracks.length.toLocaleString()} scrobbles`; container.append(footer);
  if (end < tracks.length) {
    const more = document.createElement('button'); more.type = 'button'; more.className = 'scrobble-more'; more.textContent = 'Load 50 more';
    more.addEventListener('click', () => renderScrobbleBatch(container, tracks, end)); container.append(more);
  }
}

async function updateAnalysis() {
  syncAnalysisUrl();
  const updateId = ++analysisUpdateId;
  clearAnalysisStale();
  setAnalysisLoading('Filtering scrobbles for the selected time range…');
  await nextAnalysisFrame();
  const filtered = [];
  const categoryScoped = [];
  const rankingCounts = { tracks: new Map(), albums: new Map(), artists: new Map() };
  for (let start = 0; start < scrobbles.length; start += 5000) {
    const end = Math.min(start + 5000, scrobbles.length);
    for (let i = start; i < end; i++) {
      const track = scrobbles[i];
      if (categoryFilter !== 'all') {
        const classification = ScrobbleCategories.classification(username, track);
        const isAudiobook = ScrobbleCategories.includesCategory(classification.category, 'audiobook');
        const isMusic = ScrobbleCategories.includesCategory(classification.category, 'music');
        const matches = categoryFilter === 'music'
          ? isMusic
          : categoryFilter === 'audiobook'
            ? isAudiobook
            : categoryFilter === 'automatic_audiobook'
              ? isAudiobook && classification.source === 'automatic'
              : categoryFilter === 'automatic_music'
                ? isMusic && classification.source === 'automatic'
              : categoryFilter === 'all_automatic'
                ? classification.source === 'automatic' && (isMusic || isAudiobook)
                : isAudiobook && classification.source === 'manual';
        if (!matches) continue;
      }
      categoryScoped.push(track);
      const date = scrobbleDate(track);
      if (date && date >= activeRange.start && date <= activeRange.end) {
        filtered.push(track);
        incrementRankingCounts(rankingCounts, track, viewMode);
      }
    }
    if (updateId !== analysisUpdateId) return;
    if (end < scrobbles.length) {
      setAnalysisLoading(`Filtering scrobbles and counting rankings… ${end.toLocaleString()} of ${scrobbles.length.toLocaleString()} scrobbles`);
      await nextAnalysisFrame();
      if (updateId !== analysisUpdateId) return;
    }
  }
  document.getElementById('summary').textContent = `${activeRange.label} · ${filtered.length.toLocaleString()} scrobbles`;
  visibleScrobbles = filtered;
  const rankings = finishRankingCounts(rankingCounts);
  document.querySelectorAll('[data-ranking]').forEach(section => { section.hidden = viewMode !== 'all' && section.dataset.ranking !== viewMode; });
  renderList('tracks', rankings.tracks);
  renderList('albums', rankings.albums);
  renderList('artists', rankings.artists);
  setAnalysisLoading('Comparing this period with your listening history…');
  await nextAnalysisFrame();
  if (updateId !== analysisUpdateId) return;
  const insightsUpdated = await updateInsights(categoryScoped, updateId);
  if (!insightsUpdated || updateId !== analysisUpdateId) return;
  document.querySelectorAll('[data-range]').forEach(button => button.classList.toggle('active', button.dataset.range === activeRange.label));
  finishAnalysisLoading(updateId);
}

document.getElementById('categoryFilter').addEventListener('change', event => { categoryFilter = event.target.value; updateAnalysis(); });
document.getElementById('viewFilter').addEventListener('change', event => { viewMode = event.target.value; updateAnalysis(); });
document.querySelectorAll('.ranking h2 [data-view]').forEach(button => button.addEventListener('click', () => {
  viewMode = viewMode === button.dataset.view ? 'all' : button.dataset.view;
  document.getElementById('viewFilter').value = viewMode;
  updateAnalysis();
}));
document.getElementById('updateAnalysisView').addEventListener('click', () => updateAnalysis());
document.getElementById('applyBulkCategory').addEventListener('click', async event => {
  const button = event.currentTarget;
  const controls = [...document.querySelectorAll('[data-ranking]:not([hidden]) .category-select')];
  const entities = controls.map(control => ({
    type: control.dataset.entityType,
    artist: control.dataset.entityArtist,
    name: control.dataset.entityName,
  }));
  if (!entities.length) return alert('There are no visible results to classify.');

  let category = document.getElementById('bulkCategory').value;
  let entitiesToUpdate = entities;

  // Helper to filter to automatically‑classified items
  const filterAuto = ents => ents.filter(e => {
    const track = { artist: e.artist };
    if (e.type === 'album') track.album = e.name;
    else if (e.type === 'track') track.name = e.name;
    const classification = ScrobbleCategories.classification(username, track);
    return classification.source === 'automatic';
  });

  if (category === 'auto_only') { entitiesToUpdate = filterAuto(entities); category = 'auto'; }
  else if (category === 'auto_music') { entitiesToUpdate = filterAuto(entities); category = 'music'; }
  else if (category === 'auto_audiobook') { entitiesToUpdate = filterAuto(entities); category = 'audiobook'; }

  if (!entitiesToUpdate.length) {
    return alert('No automatically‑classified items matched the selected bulk operation.');
  }

  if (!confirm(`Apply ${category === 'auto' ? 'Automatic' : category} classification to ${entitiesToUpdate.length} items?`)) return;
  button.disabled = true;
  try {
    await ScrobbleCategories.setCategories(username, entitiesToUpdate, category);
    ScrobbleCategories.prepare(scrobbles);
    await updateAnalysis();
  } catch (error) {
    alert(error.message);
  } finally {
    button.disabled = false;
  }
});

function setRollingRange(days, label) {
  const end = new Date();
  activeRange = { start: new Date(end.getTime() - days * 86400000), end, label };
  updateAnalysis();
}

function addShortcut(container, label, onClick) {
  const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
  button.dataset.range = label;
  button.addEventListener('click', () => {
    if (!applyItemsPerList()) return;
    onClick();
  });
  container.append(button);
}

function applyItemsPerList() {
  const value = Number(document.getElementById('itemLimit').value);
  if (!Number.isInteger(value) || value < 1 || value > 500) {
    alert('Choose between 1 and 500 items.');
    return false;
  }
  itemLimit = value;
  return true;
}

function buildShortcuts() {
  const quick = document.getElementById('quickLinks');
  const presets = [['Last 30 days', 30], ['Last 90 days', 90], ['Last week', 7], ['Last 24 hours', 1], ['Last year', 365]];
  for (const [label, days] of presets) addShortcut(quick, label, () => setRollingRange(days, label));
  addShortcut(quick, 'All time', () => { activeRange = { start: new Date(0), end: new Date(), label: 'All time' }; updateAnalysis(); });

  const monthSet = new Set();
  const yearSet = new Set();
  for (const track of scrobbles) {
    const date = scrobbleDate(track);
    if (!date || !Number.isFinite(date.getTime())) continue;
    monthSet.add(keyForDate(date, 'month'));
    yearSet.add(keyForDate(date, 'year'));
  }
  const months = [...monthSet].sort((a, b) => b.localeCompare(a)).slice(0, 12);
  const years = [...yearSet].sort((a, b) => Number(b) - Number(a)).slice(0, 10);
  const monthWrap = document.getElementById('monthLinks');
  if (months.length) {
    const heading = document.createElement('strong'); heading.textContent = 'Months'; monthWrap.append(heading);
    months.forEach(key => {
      const [year, month] = key.split('-').map(Number);
      const date = new Date(year, month - 1, 1);
      const label = date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
      addShortcut(monthWrap, label, () => {
        activeRange = { start: new Date(year, month - 1, 1), end: new Date(year, month, 1), label };
        activeRange.end.setMilliseconds(-1);
        updateAnalysis();
      });
    });
  }
  const yearWrap = document.getElementById('yearLinks');
  if (years.length) {
    const heading = document.createElement('strong'); heading.textContent = 'Years'; yearWrap.append(heading);
    years.forEach(year => addShortcut(yearWrap, year, () => {
      activeRange = { start: new Date(Number(year), 0, 1), end: new Date(Number(year) + 1, 0, 1), label: year };
      activeRange.end.setMilliseconds(-1);
      updateAnalysis();
    }));
  }
}

document.getElementById('applyRange').addEventListener('click', () => {
  const startValue = document.getElementById('startDate').value;
  const endValue = document.getElementById('endDate').value;
  if (!startValue || !endValue) return alert('Choose both a start and end date.');
  const start = new Date(`${startValue}T00:00:00`);
  const end = new Date(`${endValue}T23:59:59.999`);
  if (start > end) return alert('The start date must be on or before the end date.');
  activeRange = { start, end, label: `${start.toLocaleDateString()} – ${end.toLocaleDateString()}` };
  updateAnalysis();
});

document.getElementById('applyLimit').addEventListener('click', () => {
  if (applyItemsPerList()) updateAnalysis();
});

async function loadScrobbles() {
  const loading = document.getElementById('loadingIndicator');
  const loadingMessage = document.getElementById('loadingMessage');
  if (loading) loading.style.display = 'flex';
  if (!username) throw new Error('No username was provided. Return to the dashboard and load a user first.');
  const cached = sessionStorage.getItem(`lastfm_scrobbles_${username.toLowerCase()}`);
  if (cached) {
    try { scrobbles = JSON.parse(cached); } catch { scrobbles = []; }
  }
  if (!scrobbles.length) {
    if (loadingMessage) loadingMessage.textContent = 'Fetching locally stored scrobbles…';
    const response = await fetch(`/api/scrobbles/${encodeURIComponent(username)}`);
    if (!response.ok) throw new Error(`Could not load scrobbles (HTTP ${response.status}).`);
    const data = await response.json();
    if (!Array.isArray(data.scrobbles)) throw new Error('No local scrobble data found for this user.');
    scrobbles = data.scrobbles;
    try { sessionStorage.setItem(`lastfm_scrobbles_${username.toLowerCase()}`, JSON.stringify(scrobbles)); } catch {}
  }
  if (loadingMessage) loadingMessage.textContent = 'Loading saved categories and MusicBrainz classifications…';
  try { await ScrobbleVariants.load(username); }
  catch (error) { console.warn('Could not load saved scrobble variants:', error.message); }
  try { await ScrobbleCategories.load(username); }
  catch (error) { console.warn('Could not load saved audiobook categories:', error.message); }
  ScrobbleCategories.prepare(scrobbles);
  if (loadingMessage) loadingMessage.textContent = 'Preparing time range shortcuts…';
  await new Promise(resolve => requestAnimationFrame(resolve));
  buildShortcuts();
  await updateAnalysis();
}

restoreAnalysisFilters();
loadScrobbles().catch(error => {
  const loading = document.getElementById('loadingIndicator');
  if (loading) loading.style.display = 'none';
  document.getElementById('summary').textContent = error.message;
  document.getElementById('summary').classList.add('empty');
});
