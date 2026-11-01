// Conservative metadata heuristics plus per-user, per-track manual overrides.
(() => {
  const text = value => typeof value === 'string' ? value : value?.['#text'] || value?.name || '';
  const normalized = value => String(value || '').trim().toLocaleLowerCase();
  const identity = track => `${normalized(text(track.artist))}\u0000${normalized(track.name)}`;
  let overrides = {};
  let musicBrainzClassifications = {};
  let burstAlbums = new Set();
  let trackPlayCounts = new Map();
  let preparedEntityCategories = new Map();
  let preparedAutomaticEntityCategories = new Map();
  // Require some repeat evidence before using ambiguous title/album/listening-pattern clues.
  const MIN_HEURISTIC_TRACK_PLAYS = 5;
  const load = async (username, options = {}) => {
    const params = new URLSearchParams();
    if (options.artist) {
      const artists = window.ScrobbleVariants?.variantsFor('artists', '', options.artist);
      for (const artist of artists?.length ? artists : [options.artist]) params.append('artist', artist);
    }
    const query = params.size ? `?${params}` : '';
    const response = await fetch(`/api/scrobbles/${encodeURIComponent(username)}/categories${query}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not load audiobook categories.');
    overrides = data.categories || {};
    musicBrainzClassifications = data.musicBrainzClassifications || {};
  };
  const audiobookPattern = /\b(audiobook|audio book|unabridged|abridged|narrated by|chapter\s*\d+|audible)\b/i;
  const audiobookPartPattern = /\bpart\s*\d+\b/i;
  const albumIdentity = track => `${normalized(text(track.artist))}\u0000${normalized(text(track.album))}`;
  const entityKey = (type, artist, name) => `${type}\u0000${normalized(artist)}\u0000${normalized(name)}`;
  const musicBrainzKey = track => [text(track.artist), track.name].map(value => String(value || '')
    .normalize('NFKD').toLowerCase().replace(/\p{M}/gu, '').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim()).join(':::');
  const prepare = scrobbles => {
    const albums = new Map();
    trackPlayCounts = new Map();
    for (const track of scrobbles) {
      const trackKey = identity(track);
      trackPlayCounts.set(trackKey, (trackPlayCounts.get(trackKey) || 0) + 1);
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

    // Cache category aggregates by normalized entity identity. Analysis renders up
    // to 500 rows per list; scanning the complete history for each row made that
    // render quadratic in the number of scrobbles.
    preparedEntityCategories = new Map();
    preparedAutomaticEntityCategories = new Map();
    const addCategory = (cache, type, artist, name, value) => {
      const key = entityKey(type, artist, name);
      const values = cache.get(key) || new Set();
      values.add(value);
      cache.set(key, values);
    };
    for (const track of scrobbles) {
      const rawArtist = text(track.artist);
      const artist = window.ScrobbleVariants?.resolveArtist(rawArtist) || rawArtist;
      const title = window.ScrobbleVariants?.resolveTrack(rawArtist, track.name) || track.name;
      const album = window.ScrobbleVariants?.resolveAlbum(rawArtist, text(track.album)) || text(track.album);
      const selectedCategory = category('', track);
      const automatic = automaticCategory(track);
      addCategory(preparedEntityCategories, 'artist', '', artist, selectedCategory);
      addCategory(preparedAutomaticEntityCategories, 'artist', '', artist, automatic);
      addCategory(preparedEntityCategories, 'track', artist, title, selectedCategory);
      addCategory(preparedAutomaticEntityCategories, 'track', artist, title, automatic);
      if (album) {
        addCategory(preparedEntityCategories, 'album', artist, album, selectedCategory);
        addCategory(preparedAutomaticEntityCategories, 'album', artist, album, automatic);
      }
    }
  };
  const guess = track => {
    const title = normalized(track.name);
    const album = normalized(text(track.album));
    if (audiobookPattern.test([text(track.artist), track.name, text(track.album)].join(' '))) return 'audiobook';
    const hasEnoughPlays = (trackPlayCounts.get(identity(track)) || 0) >= MIN_HEURISTIC_TRACK_PLAYS;
    if (hasEnoughPlays && ((title && album && title === album) || burstAlbums.has(albumIdentity(track)) || audiobookPartPattern.test([track.name, text(track.album)].join(' ')))) return 'audiobook';
    return 'music';
  };
  const musicBrainzCategory = (_username, track) => musicBrainzClassifications[musicBrainzKey(track)] || 'unknown';
  const automaticCategory = track => {
    const fromMusicBrainz = musicBrainzCategory('', track);
    return fromMusicBrainz !== 'unknown' ? fromMusicBrainz : guess(track);
  };
  const category = (username, track) => {
    const variants = window.ScrobbleVariants;
    const rawArtist = text(track.artist);
    const artist = variants?.resolveArtist(rawArtist) || rawArtist;
    const title = variants?.resolveTrack(rawArtist, track.name) || track.name;
    const album = variants?.resolveAlbum(rawArtist, text(track.album)) || text(track.album);
    const artistCategory = overrides[entityKey('artist', '', artist)] || overrides[entityKey('artist', '', rawArtist)];
    if (artistCategory === 'music' || artistCategory === 'audiobook') return artistCategory;
    return overrides[entityKey('track', artist, title)] || overrides[entityKey('track', rawArtist, track.name)] || overrides[identity(track)] || overrides[entityKey('album', artist, album)] || overrides[entityKey('album', rawArtist, text(track.album))] || automaticCategory(track);
  };
  const includesCategory = (value, filter) => value === filter || value === 'both';
  const entityOverride = (type, artist, name) => {
    const direct = overrides[entityKey(type, artist, name)];
    if (direct) return direct;
    const variants = window.ScrobbleVariants;
    if (!variants) return null;
    const artists = type === 'artist' ? [''] : variants.variantsFor('artists', '', artist);
    const names = type === 'artist' ? variants.variantsFor('artists', '', name)
      : type === 'album' ? variants.variantsFor('albums', artist, name)
        : variants.variantsFor('tracks', artist, name);
    for (const artistName of artists.length ? artists : [artist]) {
      for (const entityName of names.length ? names : [name]) {
        const value = overrides[entityKey(type, artistName, entityName)];
        if (value) return value;
      }
    }
    return null;
  };
  const entityCategory = (type, artist, name, scrobbles) => {
    const explicit = entityOverride(type, artist, name);
    if (type !== 'artist') {
      const artistCategory = entityOverride('artist', '', artist);
      if (artistCategory === 'music' || artistCategory === 'audiobook') return artistCategory;
    }
    if (explicit) return explicit;
    const prepared = preparedEntityCategories.get(entityKey(type, artist, name));
    if (prepared) return combinedCategory(prepared);
    const variants = window.ScrobbleVariants;
    const selected = scrobbles.filter(track => type === 'artist'
      ? normalized(variants?.resolveArtist(text(track.artist)) || text(track.artist)) === normalized(name)
      : type === 'album'
        ? normalized(variants?.resolveArtist(text(track.artist)) || text(track.artist)) === normalized(artist) && normalized(variants?.resolveAlbum(text(track.artist), text(track.album)) || text(track.album)) === normalized(name)
        : normalized(variants?.resolveArtist(text(track.artist)) || text(track.artist)) === normalized(artist) && normalized(variants?.resolveTrack(text(track.artist), track.name) || track.name) === normalized(name));
    return combinedCategory(selected.map(track => category('', track)));
  };
  const inheritedArtistCategory = artist => {
    const value = entityOverride('artist', '', artist);
    return value === 'music' || value === 'audiobook' ? value : null;
  };
  const automaticEntityCategory = (type, artist, name, scrobbles) => {
    const prepared = preparedAutomaticEntityCategories.get(entityKey(type, artist, name));
    if (prepared) return combinedCategory(prepared);
    const variants = window.ScrobbleVariants;
    const selected = scrobbles.filter(track => type === 'artist'
      ? normalized(variants?.resolveArtist(text(track.artist)) || text(track.artist)) === normalized(name)
      : type === 'album'
        ? normalized(variants?.resolveArtist(text(track.artist)) || text(track.artist)) === normalized(artist) && normalized(variants?.resolveAlbum(text(track.artist), text(track.album)) || text(track.album)) === normalized(name)
        : normalized(variants?.resolveArtist(text(track.artist)) || text(track.artist)) === normalized(artist) && normalized(variants?.resolveTrack(text(track.artist), track.name) || track.name) === normalized(name));
    return combinedCategory(selected.map(automaticCategory));
  };
  const combinedCategory = values => {
    const categories = new Set(values);
    if (categories.has('both') || (categories.has('music') && categories.has('audiobook'))) return 'both';
    return categories.values().next().value || 'music';
  };
  const setCategory = async (username, entity, value, scrobbles = []) => {
    const variants = window.ScrobbleVariants;
    const relatedEntityAliases = [];
    if (variants) {
      const artists = entity.type === 'artist' ? [''] : variants.variantsFor('artists', '', entity.artist);
      const names = entity.type === 'artist' ? variants.variantsFor('artists', '', entity.name)
        : entity.type === 'album' ? variants.variantsFor('albums', entity.artist, entity.name)
          : variants.variantsFor('tracks', entity.artist, entity.name);
      for (const artist of artists.length ? artists : [entity.artist]) {
        for (const name of names.length ? names : [entity.name]) relatedEntityAliases.push({ artist, name });
      }
    }
    const sameAlbumTracks = entity.type === 'album' && value === 'audiobook'
      ? [...new Set(scrobbles.filter(track => normalized(variants?.resolveArtist(text(track.artist)) || text(track.artist)) === normalized(entity.artist)
        && normalized(variants?.resolveAlbum(text(track.artist), text(track.album)) || text(track.album)) === normalized(entity.name))
        .map(track => variants?.resolveTrack(text(track.artist), track.name) || String(track.name || '').trim()).filter(Boolean))]
      : [];
    const response = await fetch(`/api/scrobbles/${encodeURIComponent(username)}/categories`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...entity, category: value === 'auto' ? 'auto' : value, relatedTrackNames: sameAlbumTracks, relatedEntityAliases }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not save audiobook category.');
    overrides = data.categories || {};
  };
  window.ScrobbleCategories = { load, prepare, category, musicBrainzCategory, includesCategory, entityCategory, automaticEntityCategory, entityOverride, inheritedArtistCategory, setCategory, guess };
})();
