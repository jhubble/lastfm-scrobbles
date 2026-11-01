(() => {
  let saved = { version: 1, groups: { artists: [], albums: [], tracks: [] }, decisions: { artists: [], albums: [], tracks: [] } };
  let indexes = { artists: new Map(), albums: new Map(), tracks: new Map() };
  const rawKey = value => String(value || '').normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase();
  const text = value => typeof value === 'string' ? value : value?.['#text'] || value?.name || '';
  const clean = value => String(value || '').normalize('NFKD').replace(/\p{M}/gu, '')
    .replace(/[\u00ad\u034f\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/gu, '')
    .toLocaleLowerCase()
    .replace(/\s*[([]\s*(?:(?:19|20)\d{2}\s+)?(?:live|mono|stereo|(?:super\s+)?deluxe(?:\s+edition)?|expanded(?:\s+edition)?|anniversary(?:\s+edition)?|remaster(?:ed)?|reissue|bonus\s+tracks?)[^\])]*[)\]]\s*$/u, '')
    .replace(/\s+[-–—]\s*(?:(?:19|20)\d{2}\s+)?(?:live|mono|stereo|(?:super\s+)?deluxe(?:\s+edition)?|expanded(?:\s+edition)?|anniversary(?:\s+edition)?|remaster(?:ed)?|reissue|bonus\s+tracks?).*$/u, '')
    .replace(/&/g, ' and ').replace(/\b(feat\.?|ft\.?)\b/gu, ' featuring ')
    .replace(/[’‘`´]/g, "'").replace(/[‐‑‒–—―]/g, '-')
    .replace(/^the\s+/u, '')
    .replace(/[^\p{L}\p{N}]/gu, '');
  const groupKey = (type, artist, name) => type === 'artists'
    ? clean(name)
    : `${clean(resolveArtist(artist))}\u0000${clean(name)}`;
  const resolveArtist = name => {
    const group = findGroup('artists', '', name);
    return group?.canonical || name;
  };
  const resolveAlbum = (artist, album) => {
    const group = findGroup('albums', artist, album);
    return group?.canonical || album;
  };
  const resolveTrack = (artist, title) => {
    const group = findGroup('tracks', artist, title);
    return group?.canonical || title;
  };
  const findGroup = (type, artist, name) => indexes[type].get(groupKey(type, artist, name)) || null;
  const rebuildIndexes = () => {
    indexes = { artists: new Map(), albums: new Map(), tracks: new Map() };
    for (const type of ['artists', 'albums', 'tracks']) {
      for (const group of saved.groups[type] || []) {
        for (const value of new Set([group.canonical, ...(group.variants || [])])) {
          indexes[type].set(groupKey(type, group.artist || '', value), group);
        }
      }
    }
  };
  const variantsFor = (type, artist, name) => {
    const group = findGroup(type, artist, name);
    return group ? [...new Set([group.canonical, ...(group.variants || [])])] : [];
  };
  const load = async username => {
    const response = await fetch(`/api/scrobbles/${encodeURIComponent(username)}/variants`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not load saved variants.');
    saved = data.variants || saved;
    saved.groups ||= { artists: [], albums: [], tracks: [] };
    saved.decisions ||= { artists: [], albums: [], tracks: [] };
    rebuildIndexes();
    return saved;
  };
  const save = async (username, groups, decisions) => {
    const response = await fetch(`/api/scrobbles/${encodeURIComponent(username)}/variants`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        groups: { artists: groups.artists || [], albums: groups.albums || [], tracks: groups.tracks || [] },
        decisions: { artists: decisions.artists || [], albums: decisions.albums || [], tracks: decisions.tracks || [] },
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not save variants.');
    saved = data.variants;
    rebuildIndexes();
    return saved;
  };
  const detect = scrobbles => {
    const tables = { artists: new Map(), albums: new Map(), tracks: new Map() };
    for (const track of scrobbles) {
      const artist = text(track.artist) || 'Unknown artist';
      const album = text(track.album);
      const title = text(track.name) || 'Unknown track';
      const add = (type, name, parent = '') => {
        if (!name) return;
        const signature = groupKey(type, parent, name);
        const key = signature;
        const group = tables[type].get(key) || { artist: type === 'artists' ? '' : resolveArtist(parent), signature, counts: new Map() };
        const value = group.counts.get(name) || 0;
        group.counts.set(name, value + 1);
        tables[type].set(key, group);
      };
      add('artists', artist);
      add('albums', album, artist);
      add('tracks', title, artist);
    }
    return Object.fromEntries(Object.entries(tables).map(([type, table]) => [type, [...table.values()]
      .filter(group => group.counts.size > 1)
      .map(group => {
        const variants = [...group.counts.keys()].sort((a, b) => a.localeCompare(b));
        const matches = item => item.variants?.some(value => variants.includes(value))
          && (type === 'artists' || clean(item.artist) === clean(group.artist));
        const existing = (saved.groups[type] || []).find(matches);
        const decision = (saved.decisions[type] || []).find(matches);
        const canonical = variants.includes(existing?.canonical) ? existing.canonical
          : [...group.counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
        const plays = [...group.counts.values()].reduce((total, count) => total + count, 0);
        return { artist: group.artist, variants, canonical, saved: Boolean(existing), status: existing ? 'merged' : decision?.status || 'unselected', counts: Object.fromEntries(group.counts), plays };
      })]));
  };
  rebuildIndexes();
  window.ScrobbleVariants = { load, save, detect, resolveArtist, resolveAlbum, resolveTrack, variantsFor, rawKey };
})();
