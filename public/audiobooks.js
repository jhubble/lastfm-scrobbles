// Conservative metadata heuristics plus per-user, per-track manual overrides.
(() => {
  const text = value => typeof value === 'string' ? value : value?.['#text'] || value?.name || '';
  const normalized = value => String(value || '').trim().toLocaleLowerCase();
  const identity = track => `${normalized(text(track.artist))}\u0000${normalized(track.name)}`;
  let accountId = '';
  let overrides = {};
  let burstAlbums = new Set();
  const load = async username => {
    const response = await fetch(`/api/scrobbles/${encodeURIComponent(username)}/categories`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not load audiobook categories.');
    accountId = data.accountId;
    overrides = data.categories || {};
  };
  const audiobookPattern = /\b(audiobook|audio book|unabridged|abridged|narrated by|chapter\s*\d+|part\s*\d+|audible)\b/i;
  const albumIdentity = track => `${normalized(text(track.artist))}\u0000${normalized(text(track.album))}`;
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
  const category = (_username, track) => overrides[identity(track)] || guess(track);
  const setCategory = async (username, track, value) => {
    const response = await fetch(`/api/scrobbles/${encodeURIComponent(username)}/categories`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ artist: text(track.artist), title: track.name, category: value === guess(track) ? 'auto' : value }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not save audiobook category.');
    accountId = data.accountId;
    overrides = data.categories || {};
  };
  window.ScrobbleCategories = { load, prepare, category, setCategory, guess, get accountId() { return accountId; } };
})();
