// Conservative metadata heuristics plus per-user, per-track manual overrides.
(() => {
  const text = value => typeof value === 'string' ? value : value?.['#text'] || value?.name || '';
  const normalized = value => String(value || '').trim().toLocaleLowerCase();
  const identity = track => `${normalized(text(track.artist))}\u0000${normalized(track.name)}`;
  let overrides = {};
  let musicBrainzClassifications = {};
  let burstAlbums = new Set();
  const load = async username => {
    const response = await fetch(`/api/scrobbles/${encodeURIComponent(username)}/categories`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not load audiobook categories.');
    overrides = data.categories || {};
    musicBrainzClassifications = data.musicBrainzClassifications || {};
  };
  const audiobookPattern = /\b(audiobook|audio book|unabridged|abridged|narrated by|chapter\s*\d+|part\s*\d+|audible)\b/i;
  const albumIdentity = track => `${normalized(text(track.artist))}\u0000${normalized(text(track.album))}`;
  const entityKey = (type, artist, name) => `${type}\u0000${normalized(artist)}\u0000${normalized(name)}`;
  const musicBrainzKey = track => [text(track.artist), track.name].map(value => String(value || '')
    .normalize('NFKD').toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim()).join(':::');
  const prepare = scrobbles => {
    const albums = new Map();
    for (const track of scrobbles) {
      const album = text(track.album);
      const uts = Number(track?.date?.uts);
      if (!album || !Number.isFinite(uts)) continue;
      const key = albumIdentity(track);
      const dates = albums.get(key) || [];
      dates.push(uts);
      albums.set(key, dates);
    }
    burstAlbums = new Set([...albums].filter(([, dates]) => {
      if (dates.length < 8) return false;
      let earliest = Infinity;
      let latest = -Infinity;
      for (const date of dates) { earliest = Math.min(earliest, date); latest = Math.max(latest, date); }
      return latest - earliest <= 30 * 86400;
    }).map(([key]) => key));
  };
  const guess = track => {
    const title = normalized(track.name);
    const album = normalized(text(track.album));
    if (audiobookPattern.test([text(track.artist), track.name, text(track.album)].join(' ')) || (title && album && title === album) || burstAlbums.has(albumIdentity(track))) return 'audiobook';
    return 'music';
  };
  const musicBrainzCategory = (_username, track) => musicBrainzClassifications[musicBrainzKey(track)] || 'unknown';
  const category = (username, track) => overrides[entityKey('track', text(track.artist), track.name)] || overrides[identity(track)] || overrides[entityKey('album', text(track.artist), text(track.album))] || overrides[entityKey('artist', '', text(track.artist))] || (musicBrainzCategory(username, track) !== 'unknown' ? musicBrainzCategory(username, track) : guess(track));
  const includesCategory = (value, filter) => value === filter || value === 'both';
  const entityOverride = (type, artist, name) => overrides[entityKey(type, artist, name)] || null;
  const entityCategory = (type, artist, name, scrobbles) => {
    const explicit = entityOverride(type, artist, name);
    if (explicit) return explicit;
    const selected = scrobbles.filter(track => type === 'artist'
      ? normalized(text(track.artist)) === normalized(name)
      : type === 'album'
        ? normalized(text(track.artist)) === normalized(artist) && normalized(text(track.album)) === normalized(name)
        : normalized(text(track.artist)) === normalized(artist) && normalized(track.name) === normalized(name));
    const categories = new Set(selected.map(track => category('', track)));
    if (categories.has('both') || (categories.has('music') && categories.has('audiobook'))) return 'both';
    return categories.values().next().value || 'music';
  };
  const setCategory = async (username, entity, value) => {
    const response = await fetch(`/api/scrobbles/${encodeURIComponent(username)}/categories`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...entity, category: value === 'auto' ? 'auto' : value }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not save audiobook category.');
    overrides = data.categories || {};
  };
  window.ScrobbleCategories = { load, prepare, category, musicBrainzCategory, includesCategory, entityCategory, entityOverride, setCategory, guess };
})();
