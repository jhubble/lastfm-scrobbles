/**
 * Normalizes text strings using config-driven rules, diacritic folding,
 * token removal, and regular expression patterns.
 */
export function cleanText(text, config, type = 'general') {
  if (!text) return '';

  let processed = text;

  // 1. Normalize Unicode characters and strip diacritics/accents (e.g., Björk -> Bjork)
  processed = processed.normalize('NFD').replace(/[\u0300-\u036f]/g, '');

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
    processed = processed.replace(/[^\w\s]/gi, ' ');
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
        variationsFound: new Set()
      });
    }

    const group = groupedMap.get(signature);
    group.scrobbleCount += 1;
    
    if (item.date?.uts) {
      group.timestamps.push(item.date.uts);
    }

    // Retain distinct raw metadata variations for tracking/auditing
    group.variationsFound.add(JSON.stringify({
      artist: rawArtist,
      track: rawTrack,
      album: rawAlbum
    }));
  });

  // Apply minimum scrobble threshold filtering
  const minThreshold = config.minScrobbleThreshold || 1;

  const results = Array.from(groupedMap.values())
    .filter(group => group.scrobbleCount >= minThreshold)
    .map((group) => ({
      canonical: {
        artist: group.canonicalArtist,
        track: group.canonicalTrack,
        album: group.canonicalAlbum
      },
      scrobbleCount: group.scrobbleCount,
      timestamps: group.timestamps,
      variationsCount: group.variationsFound.size,
      variations: Array.from(group.variationsFound).map(v => JSON.parse(v))
    }));

  return results;
}

// Execute the cleanup pipeline
// This module is used by the web application. It does not read or write files
// on import; the server supplies the selected user's compact scrobble data.
