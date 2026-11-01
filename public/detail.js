const query = new URLSearchParams(location.search);
const username = query.get('username') || '';
const type = query.get('type') || '';
const name = query.get('name') || '';
const artist = query.get('artist') || '';
const categoryFilter = query.get('category') || 'all';
const yieldToBrowser = () => new Promise(resolve => requestAnimationFrame(resolve));
function updateLoadingStep(step, message) {
  document.querySelectorAll('[data-loading-step]').forEach(item => {
    const itemStep = Number(item.dataset.loadingStep);
    const complete = itemStep < step;
    const active = itemStep === step;
    item.classList.toggle('is-complete', complete);
    item.classList.toggle('is-active', active);
    item.querySelector('.loading-step-icon').textContent = complete ? '✓' : active ? '●' : '○';
  });
  document.getElementById('loadingMessage').textContent = message;
}
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

function renderTrackScrobbleHistory(scrobbles) {
  const section = document.getElementById('trackScrobbleHistory');
  const content = document.getElementById('trackScrobbleHistoryContent');
  if (!section || !content) return;
  section.hidden = type !== 'track';
  content.replaceChildren();
  if (type !== 'track') return;

  const plays = scrobbles
    .filter(matches)
    .map((track, index) => {
      const date = dateOf(track);
      return { track, date: date && Number.isFinite(date.getTime()) ? date : null, index };
    });
  document.getElementById('trackScrobbleHistoryHeading').textContent = `All scrobbles for this track (${plays.length.toLocaleString()})`;

  if (!plays.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No scrobbles found for this track.';
    content.append(empty);
    return;
  }

  const wrap = document.createElement('div');
  wrap.className = 'scrobble-history';
  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const header = document.createElement('tr');
  const columns = [
    { key: 'time', label: 'Played at' },
    { key: 'title', label: 'Track' },
    { key: 'artist', label: 'Artist' },
    { key: 'album', label: 'Album' },
  ];
  const sortState = { key: 'time', direction: 'asc' };
  const body = document.createElement('tbody');
  const renderRows = () => {
    const sorted = [...plays].sort((a, b) => {
      let comparison;
      if (sortState.key === 'time') {
        const aTime = a.date?.getTime();
        const bTime = b.date?.getTime();
        if (aTime == null || bTime == null) {
          if (aTime == null && bTime == null) return a.index - b.index;
          return aTime == null ? 1 : -1;
        }
        comparison = aTime - bTime;
      } else {
        const aValue = sortState.key === 'title' ? titleOf(a.track) : sortState.key === 'artist' ? artistOf(a.track) : albumOf(a.track);
        const bValue = sortState.key === 'title' ? titleOf(b.track) : sortState.key === 'artist' ? artistOf(b.track) : albumOf(b.track);
        comparison = aValue.localeCompare(bValue, undefined, { sensitivity: 'base' });
      }
      if (comparison === 0) return a.index - b.index;
      return sortState.direction === 'asc' ? comparison : -comparison;
    });
    body.replaceChildren();
    for (const { track, date } of sorted) {
      const row = document.createElement('tr');
      const cells = [
        date ? date.toLocaleString() : 'Date unavailable',
        titleOf(track),
        artistOf(track),
        albumOf(track) || '—',
      ];
      for (const value of cells) {
        const cell = document.createElement('td');
        cell.textContent = value;
        row.append(cell);
      }
      body.append(row);
    }
  };
  columns.forEach(column => {
    const th = document.createElement('th');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'sort-button';
    button.addEventListener('click', () => {
      sortState.direction = sortState.key === column.key && sortState.direction === 'asc' ? 'desc' : 'asc';
      sortState.key = column.key;
      columns.forEach((entry, index) => {
        const head = header.children[index];
        const active = entry.key === sortState.key;
        head.setAttribute('aria-sort', active ? (sortState.direction === 'asc' ? 'ascending' : 'descending') : 'none');
        head.firstChild.textContent = `${entry.label}${active ? sortState.direction === 'asc' ? ' ↑' : ' ↓' : ''}`;
      });
      renderRows();
    });
    button.textContent = `${column.label}${column.key === sortState.key ? ' ↑' : ''}`;
    th.append(button);
    th.setAttribute('aria-sort', column.key === sortState.key ? 'ascending' : 'none');
    header.append(th);
  });
  thead.append(header);
  table.append(thead, body);
  renderRows();
  wrap.append(table);
  content.append(wrap);
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

function buildRelatedTable(title, records, kind, emptyText, itemHeading, relatedHeading, categoryScrobbles = null) {
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
    ...(kind === 'album' && categoryScrobbles ? [{ key: 'category', label: 'Category' }] : []),
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
      if (kind === 'album' && categoryScrobbles) {
        const categoryCell = document.createElement('td');
        const entity = { type: 'album', artist: record.artist || '', name: record.linkName || record.label };
        const control = document.createElement('select');
        control.className = 'category-select';
        control.setAttribute('aria-label', `Category for album ${entity.name}`);
        const currentCategory = ScrobbleCategories.entityCategory('album', entity.artist, entity.name, categoryScrobbles);
        const automaticCategory = ScrobbleCategories.automaticEntityCategory('album', entity.artist, entity.name, categoryScrobbles);
        const automaticLabel = automaticCategory === 'both' ? 'Music and audiobook' : automaticCategory === 'audiobook' ? 'Audiobook' : 'Music';
        const explicitCategory = ScrobbleCategories.entityOverride('album', entity.artist, entity.name);
        for (const [value, label] of [['music', 'Music'], ['audiobook', 'Audiobook'], ['both', 'Both'], ['auto', 'Automatic']]) {
          const option = document.createElement('option'); option.value = value;
          option.textContent = value === 'auto' ? `Automatic · ${automaticLabel}` : label;
          option.selected = value === 'auto' ? !explicitCategory : currentCategory === value;
          control.append(option);
        }
        control.addEventListener('change', async () => {
          control.disabled = true;
          try {
            await ScrobbleCategories.setCategory(username, entity, control.value, categoryScrobbles);
            render(scrobbles);
          } catch (error) {
            alert(error.message);
            render(scrobbles);
          }
        });
        categoryCell.append(control);
        row.append(itemCell, categoryCell);
      } else row.append(itemCell);
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
      row.append(relatedCell, countCell, firstCell, lastCell); body.append(row);
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
  const automaticCategory = ScrobbleCategories.automaticEntityCategory(type, entity.artist, name, scrobbles);
  const explicitCategory = ScrobbleCategories.entityOverride(type, entity.artist, name);
  const automaticLabel = automaticCategory === 'both' ? 'Music and audiobook' : automaticCategory === 'audiobook' ? 'Audiobook' : 'Music';
  for (const [value, label] of [['music', 'Music'], ['audiobook', 'Audiobook'], ['both', 'Both'], ['auto', 'Automatic']]) {
    const option = document.createElement('option'); option.value = value;
    option.textContent = value === 'auto' ? `Automatic · ${automaticLabel}` : label;
    option.selected = value === 'auto' ? !explicitCategory : currentCategory === value;
    categoryControl.append(option);
  }
  categoryControl.onchange = async () => {
    categoryControl.disabled = true;
    try {
      await ScrobbleCategories.setCategory(username, entity, categoryControl.value, scrobbles);
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
      buildRelatedTable('Albums by this artist', albums, 'album', 'No album tags found.', 'Album', 'Artist', selected),
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
  renderTrackScrobbleHistory(scrobbles);
}

async function loadMusicBrainzEntityDetails() {
  const params = new URLSearchParams({ type, name, artist });
  try {
    const response = await fetch(`/api/musicbrainz/entity/${encodeURIComponent(username)}?${params}`);
    if (!response.ok) return;
    const data = await response.json();
    if (!Array.isArray(data.items) || data.items.length === 0) return;

    const section = document.getElementById('musicbrainzDetails');
    const content = document.getElementById('musicbrainzContent');
    const table = document.createElement('table');
    const thead = document.createElement('thead');
    const heading = document.createElement('tr');
    for (const label of ['Track', 'Classification', 'Earliest release', 'Release groups', 'Tags and genres', 'MusicBrainz']) {
      const th = document.createElement('th'); th.textContent = label; heading.append(th);
    }
    thead.append(heading); table.append(thead);
    const tbody = document.createElement('tbody');

    for (const item of data.items) {
      const row = document.createElement('tr');
      const trackCell = document.createElement('td');
      const trackLink = document.createElement('a');
      trackLink.href = detailUrl('track', item.title, item.artist);
      trackLink.textContent = item.title;
      trackCell.append(trackLink);
      const credits = (item.musicbrainzDetails?.artistCredits || []).map(credit => credit.name).filter(Boolean).join(', ');
      const disambiguation = item.musicbrainzDetails?.disambiguation;
      if (credits || disambiguation) {
        const meta = document.createElement('div'); meta.className = 'muted';
        meta.style.fontSize = '12px';
        meta.textContent = [credits, disambiguation].filter(Boolean).join(' · ');
        trackCell.append(meta);
      }
      row.append(trackCell);

      const category = item.musicbrainzCategory === 'audiobook' ? 'Audiobook' : item.musicbrainzCategory === 'music' ? 'Music' : 'Unknown';
      const year = item.earliestReleaseYear || item.earliestReleaseDate;
      const earliest = [item.earliestReleaseTitle, year].filter(Boolean).join(' · ') || '—';
      const groups = (item.musicbrainzDetails?.releaseGroups || []).map(group => {
        const types = [group.primaryType, ...(group.secondaryTypes || [])].filter(Boolean).join(', ');
        return [group.title, group.firstReleaseDate, types].filter(Boolean).join(' · ');
      });
      const tags = (item.musicbrainzDetails?.tags || []).map(tag => tag.name).filter(Boolean);
      const genres = (item.musicbrainzDetails?.genres || []).map(genre => genre.name).filter(Boolean);
      const values = [category, earliest, groups.join(' / ') || '—', [...new Set([...tags, ...genres])].join(', ') || '—'];
      for (const value of values) {
        const cell = document.createElement('td'); cell.textContent = value; row.append(cell);
      }

      const linkCell = document.createElement('td');
      const mbid = item.musicbrainzUrl || (item.mbid ? `https://musicbrainz.org/recording/${encodeURIComponent(item.mbid)}` : '');
      if (mbid) {
        const link = document.createElement('a'); link.href = mbid; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = 'Open ↗';
        linkCell.append(link);
      } else linkCell.textContent = item.mbStatus || '—';
      row.append(linkCell);
      tbody.append(row);
    }

    table.append(tbody);
    content.replaceChildren(table);
    section.hidden = false;
  } catch (error) {
    console.warn('Could not load cached MusicBrainz details:', error.message);
  }
}

async function load() {
  updateLoadingStep(1, 'Checking this listening detail…');
  await yieldToBrowser();
  if (!username || !['artist', 'album', 'track'].includes(type) || !name) throw new Error('This detail link is incomplete. Open the item again from Listening Analysis.');
  const back = document.getElementById('backLink');
  back.href = `analysis.html?username=${encodeURIComponent(username)}`;
  const directLinkButton = document.getElementById('copyDetailLink');
  directLinkButton.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      directLinkButton.textContent = 'Link copied';
      setTimeout(() => { directLinkButton.textContent = 'Copy direct link'; }, 1800);
    } catch {
      directLinkButton.textContent = location.href;
    }
  });

  updateLoadingStep(2, 'Loading saved scrobbles…');
  await yieldToBrowser();
  let scrobbles = [];
  try { scrobbles = JSON.parse(sessionStorage.getItem(`lastfm_scrobbles_${username.toLowerCase()}`) || '[]'); } catch {}
  if (!scrobbles.length) {
    const response = await fetch(`/api/scrobbles/${encodeURIComponent(username)}`);
    if (!response.ok) throw new Error(`Could not load scrobbles (HTTP ${response.status}).`);
    const data = await response.json();
    if (!Array.isArray(data.scrobbles)) throw new Error('No local scrobble data found for this user.');
    scrobbles = data.scrobbles;
  }

  updateLoadingStep(3, 'Loading saved categories and MusicBrainz classifications…');
  await yieldToBrowser();
  try { await ScrobbleCategories.load(username, { artist: type === 'artist' ? name : artist }); }
  catch (error) { console.warn('Could not load saved audiobook categories:', error.message); }

  updateLoadingStep(4, `Building listening history from ${scrobbles.length.toLocaleString()} scrobbles…`);
  await yieldToBrowser();
  ScrobbleCategories.prepare(scrobbles);
  render(scrobbles);

  updateLoadingStep(5, 'Loading cached MusicBrainz details…');
  await yieldToBrowser();
  await loadMusicBrainzEntityDetails();
  document.querySelectorAll('[data-loading-step]').forEach(item => {
    item.classList.remove('is-active');
    item.classList.add('is-complete');
    item.querySelector('.loading-step-icon').textContent = '✓';
  });
  document.getElementById('loading').setAttribute('aria-busy', 'false');
  document.getElementById('content').hidden = false;
  document.getElementById('loading').hidden = true;
}

load().catch(error => {
  const loading = document.getElementById('loading');
  loading.dataset.state = 'error';
  loading.setAttribute('aria-busy', 'false');
  document.getElementById('loadingSpinner').hidden = true;
  document.getElementById('loadingMessage').textContent = error.message;
});
