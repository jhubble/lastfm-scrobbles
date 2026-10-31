const query = new URLSearchParams(location.search);
const username = query.get('username') || '';
const type = query.get('type') || '';
const name = query.get('name') || '';
const artist = query.get('artist') || '';
const categoryFilter = query.get('category') || 'all';
const norm = value => String(value || '').trim().toLocaleLowerCase();
const textOf = (value, fallback = '') => {
  if (typeof value === 'string') return value.trim() || fallback;
  return String(value?.['#text'] || value?.name || fallback).trim();
};
const artistOf = track => textOf(track.artist, 'Unknown artist');
const titleOf = track => textOf(track.name, 'Unknown track');
const albumOf = track => textOf(track.album);
const dateOf = track => {
  const uts = Number(track?.date?.uts);
  return Number.isFinite(uts) ? new Date(uts * 1000) : null;
};
const formatDate = date => date ? date.toLocaleDateString() : '—';

function matches(track) {
  if (type === 'artist') return norm(artistOf(track)) === norm(name);
  if (type === 'album') return norm(albumOf(track)) === norm(name) && norm(artistOf(track)) === norm(artist);
  return norm(titleOf(track)) === norm(name) && norm(artistOf(track)) === norm(artist);
}

function aggregate(tracks, keyFn, labelFn) {
  const map = new Map();
  for (const track of tracks) {
    const key = keyFn(track);
    if (!key) continue;
    const record = map.get(key) || { key, label: labelFn(track), count: 0, first: null, last: null };
    const date = dateOf(track);
    record.count++;
    if (date && (!record.first || date < record.first)) record.first = date;
    if (date && (!record.last || date > record.last)) record.last = date;
    map.set(key, record);
  }
  return [...map.values()];
}

function rankFor(targetKey, entries) {
  const sorted = [...entries].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  const index = sorted.findIndex(entry => entry.key === targetKey);
  return index < 0 ? '—' : `#${index + 1}`;
}

function entityEntries(tracks, entityType) {
  if (entityType === 'artist') return aggregate(tracks, track => norm(artistOf(track)), artistOf);
  if (entityType === 'album') return aggregate(tracks.filter(track => albumOf(track)), track => `${norm(artistOf(track))}\u0000${norm(albumOf(track))}`, track => `${albumOf(track)} — ${artistOf(track)}`);
  return aggregate(tracks, track => `${norm(artistOf(track))}\u0000${norm(titleOf(track))}`, track => `${titleOf(track)} — ${artistOf(track)}`);
}

function detailUrl(kind, label, entityArtist = '') {
  const params = new URLSearchParams({ username, type: kind, name: label, artist: entityArtist, category: categoryFilter });
  return `detail.html?${params.toString()}`;
}

function appendStat(label, value) {
  const box = document.createElement('div'); box.className = 'stat';
  const title = document.createElement('span'); title.textContent = label;
  const val = document.createElement('strong'); val.textContent = value;
  box.append(title, val); document.getElementById('stats').append(box);
}

function relatedEntities(tracks, kind) {
  const found = new Map();
  for (const track of tracks) {
    const relatedName = kind === 'artist' ? artistOf(track) : kind === 'album' ? albumOf(track) : titleOf(track);
    if (!relatedName) continue;
    const relatedArtist = kind === 'artist' ? '' : artistOf(track);
    const key = kind === 'artist' ? norm(relatedName) : `${norm(relatedArtist)}\u0000${norm(relatedName)}`;
    if (!found.has(key)) found.set(key, {
      label: relatedName,
      kind,
      name: relatedName,
      artist: relatedArtist,
    });
  }
  return [...found.values()].sort((a, b) => a.label.localeCompare(b.label));
}

function attachRelated(records, sourceTracks, groupingKey, relatedKind) {
  const grouped = new Map();
  for (const track of sourceTracks) {
    const key = groupingKey(track);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(track);
  }
  return records.map(record => ({ ...record, related: relatedEntities(grouped.get(record.key) || [], relatedKind) }));
}

function buildRelatedTable(title, records, kind, emptyText, itemHeading, relatedHeading) {
  const section = document.createElement('section'); section.className = 'card related';
  const heading = document.createElement('h2'); heading.textContent = title; section.append(heading);
  if (!records.length) {
    const empty = document.createElement('div'); empty.className = 'empty'; empty.textContent = emptyText; section.append(empty);
    return section;
  }
  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const header = document.createElement('tr');
  const columns = [
    { key: 'label', label: itemHeading },
    { key: 'related', label: relatedHeading },
    { key: 'count', label: 'Listens' },
    { key: 'first', label: 'First listened' },
    { key: 'last', label: 'Last listened' },
  ];
  const sortState = { key: null, direction: 'asc' };
  const body = document.createElement('tbody');
  const renderRows = rows => {
    body.replaceChildren();
    rows.forEach(record => {
      const row = document.createElement('tr');
      const itemCell = document.createElement('td');
      if (kind) {
        const link = document.createElement('a'); link.href = detailUrl(kind, record.linkName || record.label, record.artist || ''); link.textContent = record.label; itemCell.append(link);
      } else itemCell.textContent = record.label;
      const relatedCell = document.createElement('td');
      if (record.related?.length) {
        relatedCell.className = 'related-items';
        record.related.forEach(entity => {
          const link = document.createElement('a'); link.href = detailUrl(entity.kind, entity.name, entity.artist); link.textContent = entity.label;
          relatedCell.append(link);
        });
      } else relatedCell.textContent = '—';
      const countCell = document.createElement('td'); countCell.className = 'count'; countCell.textContent = record.count.toLocaleString();
      const firstCell = document.createElement('td'); firstCell.textContent = formatDate(record.first);
      const lastCell = document.createElement('td'); lastCell.textContent = formatDate(record.last);
      row.append(itemCell, relatedCell, countCell, firstCell, lastCell); body.append(row);
    });
  };
  columns.forEach(column => {
    const th = document.createElement('th');
    const button = document.createElement('button'); button.type = 'button'; button.className = 'sort-button'; button.textContent = column.label;
    button.addEventListener('click', () => {
      const direction = sortState.key === column.key && sortState.direction === 'asc' ? 'desc' : 'asc';
      sortState.key = column.key; sortState.direction = direction;
      columns.forEach((entry, index) => {
        const head = header.children[index];
        head.setAttribute('aria-sort', entry.key === column.key ? (direction === 'asc' ? 'ascending' : 'descending') : 'none');
        head.firstChild.textContent = `${entry.label}${entry.key === column.key ? direction === 'asc' ? ' ↑' : ' ↓' : ''}`;
      });
      const sorted = [...records].sort((a, b) => {
        let comparison;
        if (column.key === 'count') comparison = a.count - b.count;
        else if (column.key === 'first' || column.key === 'last') {
          const aTime = a[column.key]?.getTime() ?? (direction === 'asc' ? Infinity : -Infinity);
          const bTime = b[column.key]?.getTime() ?? (direction === 'asc' ? Infinity : -Infinity);
          comparison = aTime - bTime;
        } else if (column.key === 'related') {
          const aRelated = (a.related || []).map(entity => entity.label).join(', ');
          const bRelated = (b.related || []).map(entity => entity.label).join(', ');
          comparison = aRelated.localeCompare(bRelated, undefined, { sensitivity: 'base' });
        } else comparison = a.label.localeCompare(b.label, undefined, { sensitivity: 'base' });
        return direction === 'asc' ? comparison : -comparison;
      });
      renderRows(sorted);
    });
    th.append(button); th.setAttribute('aria-sort', 'none'); header.append(th);
  });
  thead.append(header); table.append(thead);
  renderRows([...records].sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' })));
  table.append(body); section.append(table); return section;
}

function render(scrobbles) {
  const scoped = scrobbles.filter(track => categoryFilter === 'all' || ScrobbleCategories.includesCategory(ScrobbleCategories.category(username, track), categoryFilter));
  const selected = scoped.filter(matches);
  if (!selected.length) throw new Error('No listening history was found for this item.');
  const allEntries = entityEntries(scoped, type);
  const currentYear = new Date().getFullYear();
  const yearTracks = scoped.filter(track => dateOf(track)?.getFullYear() === currentYear);
  const currentYearEntries = entityEntries(yearTracks, type);
  const targetKey = type === 'artist' ? norm(name) : `${norm(artist)}\u0000${norm(name)}`;
  const selectedDates = selected.map(dateOf).filter(Boolean);
  const yearCounts = new Map();
  const monthCounts = new Map();
  for (const date of selectedDates) {
    const year = String(date.getFullYear());
    const month = `${year}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    yearCounts.set(year, (yearCounts.get(year) || 0) + 1);
    monthCounts.set(month, (monthCounts.get(month) || 0) + 1);
  }
  const peak = counts => [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0].localeCompare(a[0]))[0];
  const peakYear = peak(yearCounts);
  const peakMonth = peak(monthCounts);
  const displayName = type === 'artist' ? name : name;
  document.title = `${displayName} · Listening Details`;
  document.getElementById('kindLabel').textContent = type[0].toUpperCase() + type.slice(1);
  document.getElementById('title').textContent = displayName;
  document.getElementById('subtitle').textContent = type === 'artist' ? '' : `by ${artist}`;
  document.getElementById('stats').replaceChildren();
  const entity = { type, artist: type === 'artist' ? '' : artist, name };
  const entityTracks = scrobbles.filter(track => matches(track));
  const foundCategories = new Set(entityTracks.flatMap(track => {
    const value = ScrobbleCategories.category(username, track);
    return value === 'both' ? ['music', 'audiobook'] : [value];
  }));
  const categoryLabel = foundCategories.size > 1 ? 'Music and audiobook' : foundCategories.has('audiobook') ? 'Audiobook' : 'Music';
  appendStat('Category', categoryLabel);
  const categoryControl = document.getElementById('entityCategory');
  categoryControl.replaceChildren();
  const currentCategory = ScrobbleCategories.entityCategory(type, entity.artist, name, scrobbles);
  const explicitCategory = ScrobbleCategories.entityOverride(type, entity.artist, name);
  for (const [value, label] of [['music', 'Music'], ['audiobook', 'Audiobook'], ['both', 'Both'], ['auto', 'Automatic']]) {
    const option = document.createElement('option'); option.value = value; option.textContent = label;
    option.selected = value === 'auto' ? !explicitCategory : currentCategory === value;
    categoryControl.append(option);
  }
  categoryControl.onchange = async () => {
    categoryControl.disabled = true;
    try {
      await ScrobbleCategories.setCategory(username, entity, categoryControl.value);
      render(scrobbles);
    } catch (error) {
      alert(error.message);
      render(scrobbles);
    }
  };
  appendStat('Total listens', selected.length.toLocaleString());
  const firstListened = selectedDates.reduce((first, date) => !first || date < first ? date : first, null);
  const lastListened = selectedDates.reduce((last, date) => !last || date > last ? date : last, null);
  appendStat('First listened', formatDate(firstListened));
  appendStat('Last listened', formatDate(lastListened));
  appendStat('Peak year', peakYear ? `${peakYear[0]} (${peakYear[1].toLocaleString()})` : '—');
  appendStat('Peak month', peakMonth ? `${new Date(`${peakMonth[0]}-01T00:00:00`).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })} (${peakMonth[1].toLocaleString()})` : '—');
  appendStat('Overall rank', rankFor(targetKey, allEntries));
  appendStat(`${currentYear} rank`, rankFor(targetKey, currentYearEntries));

  const related = document.getElementById('related'); related.replaceChildren();
  if (type === 'artist') {
    const albumTracks = selected.filter(track => albumOf(track));
    const albums = attachRelated(aggregate(albumTracks, track => norm(albumOf(track)), track => albumOf(track)), albumTracks, track => norm(albumOf(track)), 'artist')
      .map(record => ({ ...record, linkName: record.label, artist: name }));
    const tracks = attachRelated(aggregate(selected, track => norm(titleOf(track)), titleOf), selected, track => norm(titleOf(track)), 'album')
      .map(record => ({ ...record, linkName: record.label, artist: name }));
    related.append(
      buildRelatedTable('Albums by this artist', albums, 'album', 'No album tags found.', 'Album', 'Artist'),
      buildRelatedTable('Tracks by this artist', tracks, 'track', 'No tracks found.', 'Track', 'Album'),
    );
  } else if (type === 'album') {
    const albumScrobbles = scoped.filter(track => norm(albumOf(track)) === norm(name));
    const artists = attachRelated(aggregate(albumScrobbles, track => norm(artistOf(track)), artistOf), albumScrobbles, track => norm(artistOf(track)), 'track')
      .map(record => ({ ...record, linkName: record.label }));
    const trackKey = track => `${norm(artistOf(track))}\u0000${norm(titleOf(track))}`;
    const tracks = attachRelated(aggregate(albumScrobbles, trackKey, titleOf), albumScrobbles, trackKey, 'artist').map(record => {
      const sample = albumScrobbles.find(track => norm(titleOf(track)) === record.key.split('\u0000')[1] && norm(artistOf(track)) === record.key.split('\u0000')[0]);
      return { ...record, linkName: record.label, artist: sample ? artistOf(sample) : '' };
    });
    related.append(
      buildRelatedTable('Artists on this album', artists, 'artist', 'No artists found.', 'Artist', 'Track'),
      buildRelatedTable('Tracks on this album', tracks, 'track', 'No tracks found.', 'Track', 'Artist'),
    );
  } else {
    const sameTitle = scoped.filter(track => norm(titleOf(track)) === norm(name));
    const albumKey = track => `${norm(artistOf(track))}\u0000${norm(albumOf(track))}`;
    const albumTracks = sameTitle.filter(track => albumOf(track));
    const albums = attachRelated(aggregate(albumTracks, albumKey, track => albumOf(track)), albumTracks, albumKey, 'artist').map(record => {
      const sample = sameTitle.find(track => norm(albumOf(track)) === record.key.split('\u0000')[1] && norm(artistOf(track)) === record.key.split('\u0000')[0]);
      return { ...record, linkName: record.label, artist: sample ? artistOf(sample) : '' };
    });
    const artists = attachRelated(aggregate(sameTitle, track => norm(artistOf(track)), artistOf), sameTitle, track => norm(artistOf(track)), 'album')
      .map(record => ({ ...record, linkName: record.label }));
    related.append(
      buildRelatedTable('Albums containing this track', albums, 'album', 'No album tags found.', 'Album', 'Artist'),
      buildRelatedTable('Artists for this track', artists, 'artist', 'No artists found.', 'Artist', 'Album'),
    );
  }
  document.getElementById('content').hidden = false;
  document.getElementById('loading').hidden = true;
}

async function load() {
  if (!username || !['artist', 'album', 'track'].includes(type) || !name) throw new Error('This detail link is incomplete. Open the item again from Listening Analysis.');
  const back = document.getElementById('backLink');
  back.href = `analysis.html?username=${encodeURIComponent(username)}`;
  let scrobbles = [];
  try { scrobbles = JSON.parse(sessionStorage.getItem(`lastfm_scrobbles_${username.toLowerCase()}`) || '[]'); } catch {}
  if (!scrobbles.length) {
    const response = await fetch(`/api/scrobbles/${encodeURIComponent(username)}`);
    if (!response.ok) throw new Error(`Could not load scrobbles (HTTP ${response.status}).`);
    const data = await response.json();
    if (!Array.isArray(data.scrobbles)) throw new Error('No local scrobble data found for this user.');
    scrobbles = data.scrobbles;
  }
  try { await ScrobbleCategories.load(username); }
  catch (error) { console.warn('Could not load saved audiobook categories:', error.message); }
  ScrobbleCategories.prepare(scrobbles);
  render(scrobbles);
}

load().catch(error => {
  const loading = document.getElementById('loading');
  loading.textContent = error.message;
  loading.classList.add('muted');
});
