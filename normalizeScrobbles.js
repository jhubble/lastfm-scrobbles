/**
 * Normalizes text strings using config-driven rules, diacritic folding,
 * token removal, and regular expression patterns.
 */
export function cleanText(text, config, type = 'general') {
  if (!text) return '';

  let processed = text;

  // Fold accents on Latin text (e.g., Björk -> Bjork) while preserving marks
  // that are meaningful in other writing systems.
  processed = processed.normalize('NFD').replace(/(\p{Script=Latin})\p{M}+/gu, '$1');

  // 2. Lowercase normalization
  if (config.lowercaseNormalization) {
    processed = processed.toLowerCase();
  }

  // 3. Normalize ampersands if enabled (" and " -> " & ")
  if (config.normalizeAmpersands) {
    processed = processed.replace(/\s+and\s+/gi, ' & ');
  }

  if (config.stripFeaturingArtists) {
    processed = processed.replace(/\s+(?:feat(?:uring)?|ft)\.?\s+.+$/i, '');
  }

  // 4. Remove platform/video streaming garbage tags
  if (config.removeVideoTags && config.removeVideoTags.length > 0) {
    const videoTagRegex = new RegExp(`\\b(${config.removeVideoTags.join('|')})\\b`, 'gi');
    processed = processed.replace(videoTagRegex, '');
  }

  // 5. Remove specified metadata tokens and optional trailing 4-digit years (e.g., remastered 2025)
  if (config.removeTokens && config.removeTokens.length > 0) {
    const tokenRegex = new RegExp(`\\b(${config.removeTokens.join('|')})(\\s+\\d{4})?\\b`, 'gi');
    processed = processed.replace(tokenRegex, '');
  }

  // 6. Remove complex regex patterns (disc numbers, featuring artist tags, etc.)
  if (config.removePatterns && config.removePatterns.length > 0) {
    config.removePatterns.forEach(pattern => {
      const regex = new RegExp(pattern, 'gi');
      processed = processed.replace(regex, '');
    });
  }

  // 7. Strip punctuation if enabled
  if (config.stripPunctuation) {
    // Keep symbols (including emoji) in the grouping key; remove punctuation only.
    processed = processed.replace(/\p{P}/gu, ' ');
  }

  // 8. Collapse extra whitespace
  processed = processed.replace(/\s+/g, ' ').trim();

  // 9. Apply manual alias overrides defined in config
  if (type === 'artist' && config.artistAliases && config.artistAliases[processed]) {
    processed = config.artistAliases[processed];
  } else if (type === 'track' && config.trackAliases && config.trackAliases[processed]) {
    processed = config.trackAliases[processed];
  } else if (type === 'album' && config.albumAliases && config.albumAliases[processed]) {
    processed = config.albumAliases[processed];
  }

  return processed;
}

/**
 * Main processing function to filter, group, and aggregate duplicate scrobbles.
 */
export function processScrobbles(items, config) {
  const groupedMap = new Map();
  const ignoredArtists = new Set(config.ignoreArtists || []);

  items.forEach((item) => {
    const rawArtist = item.artist?.['#text'] || '';
    const rawTrack = item.name || '';
    const rawAlbum = item.album?.['#text'] || '';

    // Skip ignored artists/compilations if specified in config
    if (ignoredArtists.has(rawArtist)) {
      return;
    }

    // Generate normalized signature keys
    const normArtist = cleanText(rawArtist, config, 'artist');
    const normTrack = cleanText(rawTrack, config, 'track');
    const normAlbum = cleanText(rawAlbum, config, 'album');

    // Composite unique signature for deduplication grouping
    const signature = `${normArtist}___${normTrack}___${normAlbum}`;

    if (!groupedMap.has(signature)) {
      groupedMap.set(signature, {
        canonicalTrack: rawTrack,
        canonicalArtist: rawArtist,
        canonicalAlbum: rawAlbum,
        normalizedKeys: {
          artist: normArtist,
          track: normTrack,
          album: normAlbum
        },
        scrobbleCount: 0,
        timestamps: [],
        variationsFound: new Map()
      });
    }

    const group = groupedMap.get(signature);
    group.scrobbleCount += 1;
    
    if (item.date?.uts) {
      group.timestamps.push(item.date.uts);
    }

    // Retain distinct raw metadata variations for tracking/auditing
    const variationKey = JSON.stringify({
      artist: rawArtist,
      track: rawTrack,
      album: rawAlbum
    });
    const variation = group.variationsFound.get(variationKey) || {
      artist: rawArtist, track: rawTrack, album: rawAlbum, scrobbleCount: 0,
      firstTimestamp: Number(item.date?.uts || Number.MAX_SAFE_INTEGER),
    };
    variation.scrobbleCount += 1;
    variation.firstTimestamp = Math.min(variation.firstTimestamp, Number(item.date?.uts || Number.MAX_SAFE_INTEGER));
    group.variationsFound.set(variationKey, variation);
  });

  // Apply minimum scrobble threshold filtering
  const minThreshold = config.minScrobbleThreshold || 1;

  const results = Array.from(groupedMap.values())
    .filter(group => group.scrobbleCount >= minThreshold)
    .map((group) => {
      const variations = Array.from(group.variationsFound.values())
        .sort((a, b) => b.scrobbleCount - a.scrobbleCount || a.firstTimestamp - b.firstTimestamp);
      const preferred = variations[0];
      return {
        canonical: { artist: preferred.artist, track: preferred.track, album: preferred.album },
        normalizedKeys: group.normalizedKeys,
        scrobbleCount: group.scrobbleCount,
        timestamps: group.timestamps,
        variationsCount: variations.length,
        variations: variations.map(({ firstTimestamp, ...variation }, index) => ({ ...variation, preferred: index === 0 }))
      };
    });

  return results;
}

/**
 * Normalize metadata on each scrobble while preserving its timestamp and IDs.
 * The full scrobble export remains the untouched source of truth.
 */
export function normalizeScrobbleItems(items, config) {
  const groups = processScrobbles(items, config);
  const canonicalByKey = new Map(groups.map(group => [
    JSON.stringify([group.normalizedKeys.artist, group.normalizedKeys.track, group.normalizedKeys.album]),
    group.canonical,
  ]));
  const ignoredArtists = new Set(config.ignoreArtists || []);
  const minThreshold = config.minScrobbleThreshold || 1;
  const normalizedCounts = new Map();
  const itemKeys = items.map(item => {
    const artist = item.artist?.['#text'] || '';
    const track = item.name || '';
    const album = item.album?.['#text'] || '';
    const key = JSON.stringify([
      cleanText(artist, config, 'artist'),
      cleanText(track, config, 'track'),
      cleanText(album, config, 'album'),
    ]);
    if (!ignoredArtists.has(artist)) normalizedCounts.set(key, (normalizedCounts.get(key) || 0) + 1);
    return { key, artist };
  });

  return items.flatMap((item, index) => {
    const { key, artist } = itemKeys[index];
    const count = normalizedCounts.get(key) || 0;
    if (ignoredArtists.has(artist) || count < minThreshold) return [];
    const canonical = canonicalByKey.get(key);
    if (!canonical) return [item];
    const normalized = { ...item, name: canonical.track };
    if (item.artist && typeof item.artist === 'object') {
      normalized.artist = { ...item.artist, '#text': canonical.artist };
    } else {
      normalized.artist = canonical.artist;
    }
    if (item.album && typeof item.album === 'object') {
      normalized.album = { ...item.album, '#text': canonical.album };
    } else if (item.album) {
      normalized.album = canonical.album;
    }
    return [normalized];
  });
}

// Execute the cleanup pipeline
// This module is used by the web application. It does not read or write files
// on import; the server supplies the selected user's compact scrobble data.
