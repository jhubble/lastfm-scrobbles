const params = new URLSearchParams(location.search);
const username = params.get('username') || '';
let scrobbles = [];
let itemLimit = 25;
let categoryFilter = 'all';
let activeRange = { start: new Date(Date.now() - 30 * 86400000), end: new Date(), label: 'Last 30 days' };

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

function countItems(tracks, type) {
  const counts = new Map();
  for (const track of tracks) {
    const artist = textOf(track.artist, 'Unknown artist');
    const title = textOf(track.name, 'Unknown track');
    let label;
    if (type === 'tracks') label = `${artist}\u0000${title}`;
    else if (type === 'albums') {
      const album = textOf(track.album);
      if (!album) continue;
      label = `${artist}\u0000${album}`;
    } else label = artist;
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  return [...counts.entries()].map(([key, count]) => {
    const parts = key.split('\u0000');
    return { primary: type === 'artists' ? parts[0] : parts[1], secondary: type === 'artists' ? '' : parts[0], count };
  }).sort((a, b) => b.count - a.count || a.primary.localeCompare(b.primary));
}

function itemCounts(tracks, type) {
  const counts = new Map();
  for (const track of tracks) {
    const artist = textOf(track.artist, 'Unknown artist');
    const title = textOf(track.name, 'Unknown track');
    let key;
    if (type === 'tracks') key = `${artist}\u0000${title}`;
    else if (type === 'albums') {
      const album = textOf(track.album);
      if (!album) continue;
      key = `${artist}\u0000${album}`;
    } else key = artist;
    const item = counts.get(key) || { key, artist, name: type === 'tracks' ? title : type === 'albums' ? textOf(track.album) : artist, count: 0 };
    item.count++;
    counts.set(key, item);
  }
  return counts;
}

function detailHref(type, name, artist = '') {
  const query = new URLSearchParams({ username, type, name, artist, category: categoryFilter });
  return `detail.html?${query.toString()}`;
}

function renderInsights(containerId, groups, emptyMessage) {
  const container = document.getElementById(containerId);
  container.replaceChildren();
  const types = [['tracks', 'Tracks'], ['albums', 'Albums'], ['artists', 'Artists']];
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
        name.textContent = type === 'artists' ? item.name : `${item.name} — ${item.artist}`;
        const plays = document.createElement('span'); plays.className = 'plays'; plays.textContent = `${item.count} plays`;
        row.append(name, plays); list.append(row);
      });
    }
    section.append(list); container.append(section);
  }
}

function updateInsights(currentTracks) {
  const categoryScopedScrobbles = categoryFilter === 'all'
    ? scrobbles
    : scrobbles.filter(track => ScrobbleCategories.includesCategory(ScrobbleCategories.category(username, track), categoryFilter));
  const dated = categoryScopedScrobbles.map(track => ({ track, date: scrobbleDate(track) })).filter(item => item.date);
  const currentIds = {};
  const historyIds = {};
  const previousIds = {};
  const currentStart = activeRange.start.getTime();
  const currentEnd = activeRange.end.getTime();
  const duration = currentEnd - currentStart + 1;
  const previousStart = currentStart - duration;
  const previousEnd = currentStart - 1;
  for (const type of ['tracks', 'albums', 'artists']) {
    currentIds[type] = itemCounts(currentTracks, type);
    historyIds[type] = itemCounts(dated.map(item => item.track), type);
    previousIds[type] = itemCounts(dated.filter(item => item.date.getTime() >= previousStart && item.date.getTime() <= previousEnd).map(item => item.track), type);
  }

  const newHits = {}, lostFriends = {}, justNow = {};
  for (const type of ['tracks', 'albums', 'artists']) {
    newHits[type] = activeRange.label === 'All time'
      ? []
      : [...currentIds[type].values()].filter(item => !previousIds[type].has(item.key));
    lostFriends[type] = [...historyIds[type].values()].filter(item => !currentIds[type].has(item.key));
    justNow[type] = [...currentIds[type].values()].filter(item => {
      const total = historyIds[type].get(item.key);
      return total && total.count === item.count;
    });
  }
  const noPreviousRange = activeRange.label === 'All time';
  renderInsights('newHitsLists', newHits, noPreviousRange ? 'No preceding range to compare.' : 'No new items in this range.');
  renderInsights('lostFriendsLists', lostFriends, 'No absent items found.');
  renderInsights('justNowLists', justNow, 'No items unique to this range.');
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
    name.textContent = item.primary;
    if (item.secondary) {
      const detail = document.createElement('span'); detail.className = 'muted';
      detail.textContent = ` — ${item.secondary}`; name.append(detail);
    }
    const plays = document.createElement('span'); plays.className = 'plays';
    plays.textContent = `${item.count} ${item.count === 1 ? 'play' : 'plays'}`;
    row.append(name, plays); list.append(row);
    const entityType = id === 'tracks' ? 'track' : id === 'albums' ? 'album' : 'artist';
    const entity = { type: entityType, artist: id === 'artists' ? '' : item.secondary || '', name: item.primary };
    const control = document.createElement('select');
    control.className = 'category-select';
    control.setAttribute('aria-label', `Category for ${item.primary}`);
    const selectedCategory = ScrobbleCategories.entityCategory(entityType, entity.artist, entity.name, scrobbles);
    const explicitCategory = ScrobbleCategories.entityOverride(entityType, entity.artist, entity.name);
    for (const [value, label] of [['music', 'Music'], ['audiobook', 'Audiobook'], ['both', 'Both'], ['auto', 'Automatic']]) {
      const option = document.createElement('option'); option.value = value; option.textContent = label;
      option.selected = value === 'auto' ? !explicitCategory : selectedCategory === value;
      control.append(option);
    }
    control.addEventListener('change', async () => {
      control.disabled = true;
      try {
        await ScrobbleCategories.setCategory(username, entity, control.value);
        updateAnalysis();
      } catch (error) {
        alert(error.message);
        updateAnalysis();
      }
    });
    row.append(control);
  }
}

function updateAnalysis() {
  const filtered = scrobbles.filter(track => {
    const date = scrobbleDate(track);
    return date && date >= activeRange.start && date <= activeRange.end && (categoryFilter === 'all' || ScrobbleCategories.includesCategory(ScrobbleCategories.category(username, track), categoryFilter));
  });
  document.getElementById('summary').textContent = `${activeRange.label} · ${filtered.length.toLocaleString()} scrobbles`;
  renderList('tracks', countItems(filtered, 'tracks'));
  renderList('albums', countItems(filtered, 'albums'));
  renderList('artists', countItems(filtered, 'artists'));
  updateInsights(filtered);
  document.querySelectorAll('[data-range]').forEach(button => button.classList.toggle('active', button.dataset.range === activeRange.label));
}

document.getElementById('categoryFilter').addEventListener('change', event => { categoryFilter = event.target.value; updateAnalysis(); });

function setRollingRange(days, label) {
  const end = new Date();
  activeRange = { start: new Date(end.getTime() - days * 86400000), end, label };
  updateAnalysis();
}

function addShortcut(container, label, onClick) {
  const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
  button.dataset.range = label; button.addEventListener('click', onClick); container.append(button);
}

function buildShortcuts() {
  const quick = document.getElementById('quickLinks');
  const presets = [['Last 30 days', 30], ['Last 90 days', 90], ['Last week', 7], ['Last 24 hours', 1], ['Last year', 365]];
  for (const [label, days] of presets) addShortcut(quick, label, () => setRollingRange(days, label));
  addShortcut(quick, 'All time', () => {
    activeRange = { start: new Date(0), end: new Date(), label: 'All time' }; updateAnalysis();
  });

  const dates = scrobbles.map(scrobbleDate).filter(Boolean).sort((a, b) => b - a);
  const months = [...new Set(dates.map(date => keyForDate(date, 'month')))].slice(0, 12);
  const years = [...new Set(dates.map(date => keyForDate(date, 'year')))].slice(0, 10);
  const monthWrap = document.getElementById('monthLinks');
  if (months.length) {
    const heading = document.createElement('strong'); heading.textContent = 'Months'; monthWrap.append(heading);
    months.forEach(key => {
      const [year, month] = key.split('-').map(Number);
      const date = new Date(year, month - 1, 1);
      const label = date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
      addShortcut(monthWrap, label, () => {
        activeRange = { start: new Date(year, month - 1, 1), end: new Date(year, month, 1), label };
        activeRange.end.setMilliseconds(-1); updateAnalysis();
      });
    });
  }
  const yearWrap = document.getElementById('yearLinks');
  if (years.length) {
    const heading = document.createElement('strong'); heading.textContent = 'Years'; yearWrap.append(heading);
    years.forEach(year => addShortcut(yearWrap, year, () => {
      activeRange = { start: new Date(Number(year), 0, 1), end: new Date(Number(year) + 1, 0, 1), label: year };
      activeRange.end.setMilliseconds(-1); updateAnalysis();
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
  const value = Number(document.getElementById('itemLimit').value);
  if (!Number.isInteger(value) || value < 1 || value > 500) return alert('Choose between 1 and 500 items.');
  itemLimit = value; updateAnalysis();
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
  if (loadingMessage) loadingMessage.textContent = 'Preparing rankings and time period shortcuts…';
  try { await ScrobbleCategories.load(username); }
  catch (error) { console.warn('Could not load saved audiobook categories:', error.message); }
  ScrobbleCategories.prepare(scrobbles);
  await new Promise(resolve => requestAnimationFrame(resolve));
  buildShortcuts(); updateAnalysis();
  if (loading) loading.style.display = 'none';
}

loadScrobbles().catch(error => {
  const loading = document.getElementById('loadingIndicator');
  if (loading) loading.style.display = 'none';
  document.getElementById('summary').textContent = error.message;
  document.getElementById('summary').classList.add('empty');
});
