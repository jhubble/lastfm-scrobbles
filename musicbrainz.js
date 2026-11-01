import fs from 'fs/promises';
import path from 'path';

// --- CONFIGURATION ---
// MusicBrainz requests 1 request per second and a meaningful User-Agent
const MUSICBRAINZ_BASE_URL = 'https://musicbrainz.org/ws/2/';
const DEFAULT_USER_AGENT = 'LastFMScrobbleManager/1.0.0 ( https://github.com/user/lastfm-scrobbles )';
const MIN_RATE_LIMIT_DELAY_MS = 1100;
const MAX_RATE_LIMIT_DELAY_MS = 60000;
let rateLimitDelayMs = Math.min(MAX_RATE_LIMIT_DELAY_MS, Math.max(MIN_RATE_LIMIT_DELAY_MS, Number.parseInt(process.env.MUSICBRAINZ_THROTTLE_MS || '1100', 10) || 1100));

let dataDir = null;
let logger = console;

// Active job state per user
// username -> { abortController, aborted: boolean, progress: Object, timeoutId: any }
const activeJobs = new Map();

// SSE clients per user
// username -> Set<res>
const sseClients = new Map();

// Rate limiter state: timestamp of the last request to MusicBrainz
let lastRequestTime = 0;
let rateLimitQueue = Promise.resolve();

export async function initMusicBrainz(options = {}) {
  dataDir = options.dataDir;
  if (options.logger) {
    logger = options.logger;
  }
  try {
    const settings = JSON.parse(await fs.readFile(path.join(dataDir, 'musicbrainz_settings.json'), 'utf8'));
    const savedDelay = Number(settings.throttleMs);
    if (Number.isInteger(savedDelay) && savedDelay >= MIN_RATE_LIMIT_DELAY_MS && savedDelay <= MAX_RATE_LIMIT_DELAY_MS) {
      rateLimitDelayMs = savedDelay;
    }
  } catch (err) {
    if (err.code !== 'ENOENT') logger.warn('MusicBrainz', `Could not load saved throttle setting: ${err.message}`);
  }
}

export function getMusicBrainzThrottle() {
  return { throttleMs: rateLimitDelayMs, minThrottleMs: MIN_RATE_LIMIT_DELAY_MS, maxThrottleMs: MAX_RATE_LIMIT_DELAY_MS };
}

export async function setMusicBrainzThrottle(throttleMs) {
  if (!Number.isInteger(throttleMs) || throttleMs < MIN_RATE_LIMIT_DELAY_MS || throttleMs > MAX_RATE_LIMIT_DELAY_MS) {
    throw new Error(`throttleMs must be an integer from ${MIN_RATE_LIMIT_DELAY_MS} to ${MAX_RATE_LIMIT_DELAY_MS}.`);
  }
  if (!dataDir) throw new Error('MusicBrainz storage is not initialized.');
  const settingsPath = path.join(dataDir, 'musicbrainz_settings.json');
  const temporaryPath = `${settingsPath}.tmp`;
  await fs.writeFile(temporaryPath, JSON.stringify({ throttleMs }, null, 2));
  await fs.rename(temporaryPath, settingsPath);
  rateLimitDelayMs = throttleMs;
  return getMusicBrainzThrottle();
}

export function getUserAgent() {
  return process.env.MUSICBRAINZ_USER_AGENT || DEFAULT_USER_AGENT;
}

export function getMbFilePath(username) {
  return path.join(dataDir, `${username.toLowerCase().trim()}_musicbrainz.json`);
}

export function getScrobblesFilePath(username) {
  return path.join(dataDir, `${username.toLowerCase().trim()}_scrobbles.json`);
}

// Helper: Escape reserved characters for MusicBrainz Lucene query syntax
export function escapeLucene(str) {
  if (!str) return '';
  return str.replace(/([+\-!(){}\[\]^"~*?:\\\/]|&&|\|\|)/g, '\\$1');
}

// Helper: Normalize string for comparison (removes accents, punctuation, extra spaces)
export function normalizeText(str) {
  return (str || '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Helper: Extract 4-digit year from date or text string
export function parseYear(val) {
  if (!val) return null;
  const match = String(val).match(/\b(19\d\d|20\d\d)\b/);
  return match ? parseInt(match[1], 10) : null;
}

// Helper: Clean remaster / live / deluxe / bonus / feat strings from track titles for fallback search
export function cleanTrackTitle(title) {
  if (!title) return '';
  return title
    .replace(/\s*[-–—]\s*(?:\d{4}\s+)?(?:remaster(?:ed)?|live|mono|stereo|bonus(?:\s+track)?|deluxe|radio\s+edit|single\s+version|album\s+version|original\s+mix|mix|acoustic|anniversary|edit|version).*$/i, '')
    .replace(/\s*\((?:\d{4}\s+)?(?:remaster(?:ed)?|live|mono|stereo|bonus(?:\s+track)?|deluxe|radio\s+edit|single\s+version|album\s+version|original\s+mix|mix|acoustic|anniversary|edit|version|feat\.?[^)]*|with[^)]*)[^)]*\)/i, '')
    .replace(/\s*\[(?:\d{4}\s+)?(?:remaster(?:ed)?|live|mono|stereo|bonus(?:\s+track)?|deluxe|radio\s+edit|single\s+version|album\s+version|original\s+mix|mix|acoustic|anniversary|edit|version|feat\.?[^\]]*|with[^\]]*)[^\]]*\]/i, '')
    .trim();
}

// Helper: Create unique canonical key for a song
export function makeSongKey(artist, title) {
  return `${normalizeText(artist)}:::${normalizeText(title)}`;
}

// Helper: Sleep
const sleep = (ms, abortSignal) => new Promise((resolve, reject) => {
  if (abortSignal?.aborted) return reject(new Error('Aborted'));
  const timer = setTimeout(done, ms);
  function done() {
    abortSignal?.removeEventListener('abort', abort);
    resolve();
  }
  function abort() {
    clearTimeout(timer);
    abortSignal?.removeEventListener('abort', abort);
    reject(new Error('Aborted'));
  }
  abortSignal?.addEventListener('abort', abort, { once: true });
});

async function reserveRateLimitSlot(abortSignal) {
  const previous = rateLimitQueue;
  let release;
  rateLimitQueue = new Promise((resolve) => { release = resolve; });
  await previous;
  try {
    const waitTime = Math.max(0, rateLimitDelayMs - (Date.now() - lastRequestTime));
    if (waitTime > 0) await sleep(waitTime, abortSignal);
    if (abortSignal?.aborted) throw new Error('Aborted');
    lastRequestTime = Date.now();
  } finally {
    release();
  }
}

// Helper: Rate-limited fetch for MusicBrainz API
async function rateLimitedFetch(url, abortSignal, attempt = 1) {
  await reserveRateLimitSlot(abortSignal);

  if (abortSignal && abortSignal.aborted) {
    throw new Error('Aborted');
  }

  const userAgent = getUserAgent();
  try {
    const res = await fetch(url, {
      signal: abortSignal,
      headers: {
        'User-Agent': userAgent,
        'Accept': 'application/json',
      },
    });

    if (res.status === 429 || res.status === 503) {
      if (attempt <= 3) {
        const retryAfter = parseInt(res.headers.get('retry-after') || '10', 10);
        logger.warn('MusicBrainz', `Rate limited (HTTP ${res.status}). Waiting ${retryAfter}s before retry ${attempt}...`);
        await sleep(retryAfter * 1000, abortSignal);
        return rateLimitedFetch(url, abortSignal, attempt + 1);
      }
      throw new Error(`MusicBrainz rate limit exceeded (HTTP ${res.status})`);
    }

    if (!res.ok) {
      let responseDetail = '';
      try {
        const body = (await res.text()).replace(/\s+/g, ' ').trim();
        if (body) responseDetail = `; response: ${body.slice(0, 300)}`;
      } catch {}
      throw new Error(`MusicBrainz API returned HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}${responseDetail}`);
    }

    const data = await res.json();
    return data;
  } catch (err) {
    if (abortSignal && abortSignal.aborted) {
      throw new Error('Aborted');
    }
    throw err;
  }
}

// Load scrobbles for user
export async function loadUserScrobbles(username) {
  const filePath = getScrobblesFilePath(username);
  try {
    const data = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(data);
  } catch {
    return [];
  }
}

// Load stored MusicBrainz results
export async function loadMbData(username) {
  const filePath = getMbFilePath(username);
  try {
    const data = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(data);
  } catch {
    return {
      username: username.toLowerCase().trim(),
      updatedAt: null,
      status: 'idle',
      progress: {
        totalUniqueSongs: 0,
        processedCount: 0,
        foundCount: 0,
        notFoundCount: 0,
        percent: 0,
        message: 'Ready',
      },
      songs: {},
    };
  }
}

// Save stored MusicBrainz results
export async function saveMbData(username, data) {
  const filePath = getMbFilePath(username);
  data.updatedAt = new Date().toISOString();
  const temporaryPath = `${filePath}.tmp`;
  await fs.writeFile(temporaryPath, JSON.stringify(data, null, 2));
  await fs.rename(temporaryPath, filePath);
}

// Extract unique songs from scrobbles, recording details from the FIRST time each song was scrobbled
export function extractUniqueSongsFromScrobbles(scrobbles) {
  const songMap = new Map();

  for (const track of scrobbles) {
    if (!track.date || !track.date.uts) continue;

    const artistName = track.artist?.['#text'] || track.artist?.name || track.artist || 'Unknown Artist';
    const trackName = track.name || 'Unknown Track';
    const key = makeSongKey(artistName, trackName);

    if (songMap.has(key)) {
      const existing = songMap.get(key);
      existing.scrobbleCount += 1;
      // If this scrobble is earlier than the recorded first scrobble, update it
      const scrobbleUts = Number(track.date.uts);
      if (scrobbleUts > existing.lastScrobbledUts) existing.lastScrobbledUts = scrobbleUts;
      if (scrobbleUts < existing.firstScrobbledUts) {
        existing.firstScrobbledUts = scrobbleUts;
        existing.firstScrobbledDate = track.date?.['#text'] || new Date(scrobbleUts * 1000).toISOString();
        existing.firstScrobbledAlbum = normalizeAlbumTitle(track.album);
        existing.firstScrobbledAlbumMbid = track.album?.mbid || null;
      }
    } else {
      const scrobbleUts = Number(track.date.uts);
      songMap.set(key, {
        songKey: key,
        artist: artistName,
        title: trackName,
        trackMbid: track.mbid || null,
        artistMbid: track.artist?.mbid || null,
        firstScrobbledUts: scrobbleUts,
        lastScrobbledUts: scrobbleUts,
        firstScrobbledDate: track.date?.['#text'] || new Date(scrobbleUts * 1000).toISOString(),
        firstScrobbledAlbum: normalizeAlbumTitle(track.album),
        firstScrobbledAlbumMbid: track.album?.mbid || null,
        scrobbleCount: 1,
      });
    }
  }

  // Prioritize tracks with the most scrobbles; break ties by first discovery.
  const list = Array.from(songMap.values());
  list.sort((a, b) =>
    (b.scrobbleCount - a.scrobbleCount) ||
    (a.firstScrobbledUts - b.firstScrobbledUts) ||
    a.songKey.localeCompare(b.songKey)
  );
  return list;
}

function normalizeAlbumTitle(album) {
  if (typeof album === 'string') return album.trim();
  if (!album || typeof album !== 'object') return '';
  for (const value of [album['#text'], album.name, album.title]) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function categoryOverrideKey(type, artist, name) {
  return `${type}\u0000${String(artist || '').trim().toLocaleLowerCase()}\u0000${String(name || '').trim().toLocaleLowerCase()}`;
}

function lookupCategoryText(value) {
  return String(value || '').trim().toLocaleLowerCase();
}

function combineCategories(categories) {
  if (categories.has('both') || (categories.has('music') && categories.has('audiobook'))) return 'both';
  return categories.values().next().value || null;
}

function getMusicBrainzLookupCategories(scrobbles, uniqueSongs, manualOverrides, mbSongs) {
  const songCategories = new Map();
  const directTrackCategories = new Map();
  const forcedArtistCategories = new Map();
  const albumDates = new Map();

  for (const track of scrobbles) {
    if (!track.date?.uts) continue;
    const artist = track.artist?.['#text'] || track.artist?.name || track.artist || 'Unknown Artist';
    const title = track.name || 'Unknown Track';
    const album = normalizeAlbumTitle(track.album);
    const songKey = makeSongKey(artist, title);
    const directTrackCategory = manualOverrides[categoryOverrideKey('track', artist, title)] || manualOverrides[`${lookupCategoryText(artist)}\u0000${lookupCategoryText(title)}`];
    const artistCategory = manualOverrides[categoryOverrideKey('artist', '', artist)];
    if (artistCategory === 'music' || artistCategory === 'audiobook') forcedArtistCategories.set(songKey, artistCategory);
    if (directTrackCategory) directTrackCategories.set(songKey, directTrackCategory);
    else {
      const albumCategory = album && manualOverrides[categoryOverrideKey('album', artist, album)];
      const inheritedCategory = albumCategory || (artistCategory === 'music' || artistCategory === 'audiobook' ? artistCategory : null);
      if (inheritedCategory) {
        const categories = songCategories.get(songKey) || new Set();
        categories.add(inheritedCategory);
        songCategories.set(songKey, categories);
      }
    }

    const uts = Number(track.date.uts);
    if (album && Number.isFinite(uts)) {
      const albumKey = `${lookupCategoryText(artist)}\u0000${lookupCategoryText(album)}`;
      const dates = albumDates.get(albumKey) || [];
      dates.push(uts);
      albumDates.set(albumKey, dates);
    }
  }

  const burstAlbums = new Set([...albumDates].filter(([, dates]) => {
    if (dates.length < 8) return false;
    let earliest = Infinity;
    let latest = -Infinity;
    for (const date of dates) { earliest = Math.min(earliest, date); latest = Math.max(latest, date); }
    return latest - earliest <= 30 * 86400;
  }).map(([key]) => key));
  const playCounts = new Map(uniqueSongs.map(song => [song.songKey, song.scrobbleCount]));
  const obviousAudiobookPattern = /\b(audiobook|audio book|unabridged|abridged|narrated by|chapter\s*\d+|audible)\b/i;
  const audiobookPartPattern = /\bpart\s*\d+\b/i;
  const autoCategories = new Map();

  for (const track of scrobbles) {
    if (!track.date?.uts) continue;
    const artist = track.artist?.['#text'] || track.artist?.name || track.artist || 'Unknown Artist';
    const title = track.name || 'Unknown Track';
    const album = normalizeAlbumTitle(track.album);
    const songKey = makeSongKey(artist, title);
    const musicBrainzCategory = mbSongs?.[songKey]?.musicbrainzCategory;
    let category = ['music', 'audiobook'].includes(musicBrainzCategory) ? musicBrainzCategory : null;
    if (!category) {
      if (obviousAudiobookPattern.test([artist, title, album].join(' '))) category = 'audiobook';
      else {
        const enoughPlays = (playCounts.get(songKey) || 0) >= 5;
        const isTitleAlbumMatch = lookupCategoryText(title) && lookupCategoryText(title) === lookupCategoryText(album);
        const albumKey = `${lookupCategoryText(artist)}\u0000${lookupCategoryText(album)}`;
        if (enoughPlays && (isTitleAlbumMatch || burstAlbums.has(albumKey) || audiobookPartPattern.test(`${title} ${album}`))) category = 'audiobook';
        else category = 'music';
      }
    }
    const categories = autoCategories.get(songKey) || new Set();
    categories.add(category);
    autoCategories.set(songKey, categories);
  }

  const result = new Map();
  for (const song of uniqueSongs) {
    const manualCategory = forcedArtistCategories.get(song.songKey) || (directTrackCategories.has(song.songKey)
      ? directTrackCategories.get(song.songKey)
      : combineCategories(songCategories.get(song.songKey) || new Set()));
    const automaticCategory = combineCategories(autoCategories.get(song.songKey) || new Set());
    result.set(song.songKey, { manualCategory, automaticCategory });
  }
  return result;
}

function isReleaseDateAfterScrobble(releaseDate, firstScrobbledUts) {
  const match = String(releaseDate || '').match(/^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?/);
  const uts = Number(firstScrobbledUts);
  if (!match || !Number.isFinite(uts)) return false;

  const scrobbleDate = new Date(uts * 1000);
  const releaseParts = [Number(match[1]), match[2] ? Number(match[2]) : null, match[3] ? Number(match[3]) : null];
  const scrobbleParts = [scrobbleDate.getUTCFullYear(), scrobbleDate.getUTCMonth() + 1, scrobbleDate.getUTCDate()];
  for (let i = 0; i < releaseParts.length; i++) {
    if (releaseParts[i] === null) return false;
    if (releaseParts[i] !== scrobbleParts[i]) return releaseParts[i] > scrobbleParts[i];
  }
  return false;
}

function isImprobableSong(song, enrichment) {
  if (!enrichment || enrichment.mbStatus !== 'found') return false;
  return isReleaseDateAfterScrobble(
    enrichment.earliestReleaseDate || enrichment.earliestReleaseYear,
    song.firstScrobbledUts
  );
}

// Analyze recording to find the earliest date and match against the scrobbled album
export function parseRecordingDetails(recording, scrobbledAlbum, scrobbledTrackTitle) {
  let earliestDate = recording['first-release-date'] || null;
  let earliestYear = parseYear(earliestDate);
  let earliestReleaseTitle = null;

  const releases = Array.isArray(recording.releases) ? recording.releases : [];

  // 1. Scan all releases associated with this recording to find the absolute earliest release date
  for (const rel of releases) {
    const relDate = rel.date || rel['release-group']?.['first-release-date'];
    const relYear = parseYear(relDate);
    if (relYear) {
      if (!earliestYear || relYear < earliestYear) {
        earliestYear = relYear;
        earliestDate = relDate;
        earliestReleaseTitle = rel.title || rel['release-group']?.title || null;
      }
    }
  }

  // If earliestReleaseTitle is still null, pick the release matching earliestDate or first release
  if (!earliestReleaseTitle && releases.length > 0) {
    const matchingRel = releases.find((r) => r.date === earliestDate) || releases[0];
    earliestReleaseTitle = matchingRel?.title || null;
  }

  // 2. Identify the scrobbled release (album) date
  let scrobbledReleaseDate = null;
  let scrobbledReleaseYear = null;
  let scrobbledReleaseTitle = null;

  const normScrobbledAlbum = normalizeText(scrobbledAlbum);
  if (normScrobbledAlbum) {
    // Exact match in releases
    let matchedRel = releases.find((r) => normalizeText(r.title) === normScrobbledAlbum);
    // Partial / substring match
    if (!matchedRel) {
      matchedRel = releases.find((r) => {
        const nr = normalizeText(r.title);
        return nr && (nr.includes(normScrobbledAlbum) || normScrobbledAlbum.includes(nr));
      });
    }

    if (matchedRel) {
      scrobbledReleaseTitle = matchedRel.title;
      scrobbledReleaseDate = matchedRel.date || matchedRel['release-group']?.['first-release-date'] || null;
      scrobbledReleaseYear = parseYear(scrobbledReleaseDate);
    }
  }

  // Fallback: check if the scrobbled album name or track title contains a 4-digit year (e.g. "Remaster 2011", "[2004 Remaster]")
  if (!scrobbledReleaseYear) {
    const albumYear = parseYear(scrobbledAlbum);
    const trackYear = parseYear(scrobbledTrackTitle);
    if (albumYear && (!earliestYear || albumYear >= earliestYear)) {
      scrobbledReleaseYear = albumYear;
      scrobbledReleaseDate = String(albumYear);
      scrobbledReleaseTitle = scrobbledAlbum;
    } else if (trackYear && (!earliestYear || trackYear >= earliestYear)) {
      scrobbledReleaseYear = trackYear;
      scrobbledReleaseDate = String(trackYear);
    }
  }

  const hasLaterReleaseKeyword = Boolean(
    normScrobbledAlbum &&
    /(greatest hits|best of|anthology|remaster|anniversary|deluxe|edition|collection|essential|ultimate|retrospective|singles 19|singles 20)/i.test(
      scrobbledAlbum
    )
  );

  const isLaterRelease = Boolean(
    (scrobbledReleaseYear && earliestYear && scrobbledReleaseYear > earliestYear) ||
    (hasLaterReleaseKeyword && (!scrobbledReleaseYear || (earliestYear && scrobbledReleaseYear >= earliestYear)))
  );

  const yearDifference =
    scrobbledReleaseYear && earliestYear && scrobbledReleaseYear > earliestYear
      ? scrobbledReleaseYear - earliestYear
      : 0;

  const releaseGroups = new Map();
  const releaseDetails = releases.map((rel) => {
    const group = rel['release-group'] || {};
    if (group.id) {
      releaseGroups.set(group.id, {
        id: group.id,
        title: group.title || null,
        firstReleaseDate: group['first-release-date'] || null,
        primaryType: group['primary-type'] || null,
        secondaryTypes: Array.isArray(group['secondary-types']) ? group['secondary-types'] : [],
        tags: Array.isArray(group.tags) ? group.tags.map((tag) => tag.name).filter(Boolean) : [],
      });
    }
    return {
      id: rel.id || null,
      title: rel.title || null,
      date: rel.date || null,
      country: rel.country || null,
      status: rel.status || null,
      barcode: rel.barcode || null,
      formats: (rel.media || []).map((medium) => medium.format).filter(Boolean),
      releaseGroupId: group.id || null,
    };
  });
  for (const group of recording['release-groups'] || []) {
    if (!group.id) continue;
    releaseGroups.set(group.id, {
      id: group.id,
      title: group.title || null,
      firstReleaseDate: group['first-release-date'] || null,
      primaryType: group['primary-type'] || null,
      secondaryTypes: Array.isArray(group['secondary-types']) ? group['secondary-types'] : [],
      tags: Array.isArray(group.tags) ? group.tags.map((tag) => tag.name).filter(Boolean) : [],
    });
  }
  const groupList = [...releaseGroups.values()];
  const secondaryTypes = [...new Set(groupList.flatMap((group) => group.secondaryTypes.map((type) => String(type).toLowerCase())))];
  const primaryTypes = [...new Set(groupList.map((group) => String(group.primaryType || '').toLowerCase()).filter(Boolean))];
  const musicPrimaryTypes = new Set(['album', 'single', 'ep']);
  const musicSecondaryTypes = new Set(['compilation', 'dj-mix', 'live', 'mixtape/street', 'remix', 'soundtrack']);
  const tags = (recording.tags || []).map((tag) => ({ name: tag.name, count: tag.count || 0 }));
  const genres = (recording.genres || []).map((genre) => ({ name: genre.name, count: genre.count || 0 }));
  const audiobookTag = [...tags.map((tag) => tag.name), ...groupList.flatMap((group) => group.tags || [])]
    .some((tag) => ['audiobook', 'audio book', 'audiobooks'].includes(String(tag).trim().toLowerCase()));
  const musicbrainzCategory = secondaryTypes.includes('audiobook') || audiobookTag
    ? 'audiobook'
    : primaryTypes.some((type) => musicPrimaryTypes.has(type)) || secondaryTypes.some((type) => musicSecondaryTypes.has(type))
      ? 'music'
      : 'unknown';
  const artistCredits = (recording['artist-credit'] || []).map((credit) => ({
    name: credit.name || credit.artist?.name || null,
    joinPhrase: credit.joinphrase || '',
    artistId: credit.artist?.id || null,
    artistName: credit.artist?.name || null,
  }));
  return {
    recordingId: recording.id,
    recordingTitle: recording.title,
    earliestDate,
    earliestYear,
    earliestReleaseTitle: earliestReleaseTitle || null,
    scrobbledReleaseTitle: scrobbledReleaseTitle || scrobbledAlbum || null,
    scrobbledReleaseDate,
    scrobbledReleaseYear,
    isLaterRelease,
    hasLaterReleaseKeyword,
    yearDifference,
    totalReleasesInMB: releases.length,
    musicbrainzCategory,
    musicbrainzDetails: {
      recordingId: recording.id,
      recordingTitle: recording.title,
      disambiguation: recording.disambiguation || null,
      artistCredits,
      releaseGroups: groupList,
      releases: releaseDetails,
      tags,
      genres,
    },
    musicbrainzUrl: `https://musicbrainz.org/recording/${recording.id}`,
  };
}

async function fetchRecordingDetails(recordingId, scrobbledAlbum, title, abortSignal, fallback = null, artist = '') {
  const url = `${MUSICBRAINZ_BASE_URL}recording/${recordingId}?inc=releases+artist-credits+release-groups+tags+genres&fmt=json`;
  try {
    const recording = await rateLimitedFetch(url, abortSignal);
    if (recording?.id) return {
      ...parseRecordingDetails(recording, scrobbledAlbum, title),
      musicbrainzDetailsComplete: true,
    };
  } catch (err) {
    if (abortSignal?.aborted) throw err;
    logger.debug('MusicBrainz', `Detailed recording lookup failed: artist="${artist || 'unknown'}", track="${title}", album="${scrobbledAlbum || 'unknown'}", recordingId=${recordingId}, request=${url}, error=${err.message}`);
  }
  return fallback ? {
    ...parseRecordingDetails(fallback, scrobbledAlbum, title),
    musicbrainzDetailsComplete: false,
  } : null;
}

function chooseBestRecording(recordings, artist, title) {
  const expectedArtist = normalizeText(artist);
  const expectedTitle = normalizeText(title);
  let candidates = recordings || [];

  const exactTitles = candidates.filter((recording) => normalizeText(recording.title) === expectedTitle);
  if (exactTitles.length) candidates = exactTitles;

  const exactArtists = candidates.filter((recording) => {
    const credits = (recording['artist-credit'] || []).map((credit) => normalizeText(credit.name || credit.artist?.name));
    return credits.includes(expectedArtist);
  });
  if (exactArtists.length) candidates = exactArtists;

  return [...candidates].sort((a, b) => {
    const dateA = a['first-release-date'] || '9999';
    const dateB = b['first-release-date'] || '9999';
    return dateA.localeCompare(dateB) || Number(b.score || 0) - Number(a.score || 0);
  })[0] || null;
}

// Query MusicBrainz for a recording
export async function lookupSongInMusicBrainz(song, abortSignal) {
  const { artist, title, firstScrobbledAlbum, trackMbid } = song;

  // 1. If we have a track MBID from Last.fm, we can try direct recording lookup first
  if (trackMbid && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trackMbid)) {
    try {
      const details = await fetchRecordingDetails(trackMbid, firstScrobbledAlbum, title, abortSignal, null, artist);
      if (details) {
        return {
          status: 'found',
          source: 'mbid',
          ...details,
        };
      }
    } catch (err) {
      if (abortSignal && abortSignal.aborted) throw err;
      logger.debug('MusicBrainz', `Direct MBID lookup failed: artist="${artist}", track="${title}", album="${firstScrobbledAlbum || 'unknown'}", recordingId=${trackMbid}, error=${err.message}. Falling back to search.`);
    }
  }

  // 2. Primary Lucene search: exact recording and artist
  const escapedArtist = escapeLucene(artist);
  const escapedTitle = escapeLucene(title);

  let searchUrl = `${MUSICBRAINZ_BASE_URL}recording?query=recording:"${escapedTitle}"%20AND%20artist:"${escapedArtist}"&fmt=json&limit=25`;
  let result = null;

  try {
    result = await rateLimitedFetch(searchUrl, abortSignal);
  } catch (err) {
    if (abortSignal && abortSignal.aborted) throw err;
    logger.warn('MusicBrainz', `Search failed for "${artist} - ${title}": ${err.message}`);
  }

  // 3. Fallback: If no recordings found, clean title (remove "(Remastered 2011)", "- Live", etc.)
  if (!result || !result.recordings || result.recordings.length === 0) {
    const cleaned = cleanTrackTitle(title);
    if (cleaned && cleaned.toLowerCase() !== title.toLowerCase()) {
      logger.debug('MusicBrainz', `Retrying with cleaned title: "${cleaned}"`);
      const escapedCleaned = escapeLucene(cleaned);
      const fallbackUrl = `${MUSICBRAINZ_BASE_URL}recording?query=recording:"${escapedCleaned}"%20AND%20artist:"${escapedArtist}"&fmt=json&limit=25`;
      try {
        result = await rateLimitedFetch(fallbackUrl, abortSignal);
      } catch (err) {
        if (abortSignal && abortSignal.aborted) throw err;
      }
    }
  }

  // 4. Fallback: unquoted search if still no result
  if (!result || !result.recordings || result.recordings.length === 0) {
    const cleaned = cleanTrackTitle(title);
    const unquotedUrl = `${MUSICBRAINZ_BASE_URL}recording?query=recording:${escapeLucene(cleaned)}%20AND%20artist:${escapeLucene(artist)}&fmt=json&limit=25`;
    try {
      result = await rateLimitedFetch(unquotedUrl, abortSignal);
    } catch (err) {
      if (abortSignal && abortSignal.aborted) throw err;
    }
  }

  if (result && result.recordings && result.recordings.length > 0) {
    // Prefer exact title/artist candidates, then the earliest known recording date.
    const bestMatch = chooseBestRecording(result.recordings, artist, title);
    const details = await fetchRecordingDetails(bestMatch.id, firstScrobbledAlbum, title, abortSignal, bestMatch, artist);
    return {
      status: 'found',
      source: 'search',
      ...details,
    };
  }

  // If not found in MusicBrainz
  return {
    status: 'not_found',
    musicbrainzCategory: 'unknown',
    musicbrainzDetails: null,
    earliestDate: null,
    earliestYear: null,
    earliestReleaseTitle: null,
    scrobbledReleaseTitle: firstScrobbledAlbum || null,
    scrobbledReleaseDate: null,
    scrobbledReleaseYear: parseYear(firstScrobbledAlbum),
    isLaterRelease: false,
    hasLaterReleaseKeyword: false,
    yearDifference: 0,
    musicbrainzUrl: null,
  };
}

// SSE helper: Broadcast event to all connected clients for a user
function sendSSE(res, eventName, data) {
  try {
    res.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch (err) {
    logger.warn('MusicBrainzSSE', `Failed to send SSE event: ${err.message}`);
  }
}

export function broadcastMbEvent(username, eventName, data) {
  const key = username.toLowerCase().trim();
  const clients = sseClients.get(key);
  if (clients && clients.size > 0) {
    for (const client of clients) {
      sendSSE(client, eventName, data);
    }
  }
}

export function registerMbSseClient(username, res) {
  const key = username.toLowerCase().trim();
  if (!sseClients.has(key)) {
    sseClients.set(key, new Set());
  }
  sseClients.get(key).add(res);
}

export function removeMbSseClient(username, res) {
  const key = username.toLowerCase().trim();
  const clients = sseClients.get(key);
  if (clients) {
    clients.delete(res);
    if (clients.size === 0) {
      sseClients.delete(key);
    }
  }
}

// Start or Resume MusicBrainz Job
export async function startMusicBrainzJob(username, options = {}) {
  const key = username.toLowerCase().trim();
  const restart = Boolean(options.restart);
  const improbableOnly = Boolean(options.improbableOnly) && !restart;

  if (activeJobs.has(key)) {
    logger.warn('MusicBrainzJob', `Job already running for user "${key}"`);
    return { alreadyRunning: true };
  }

  const scrobbles = await loadUserScrobbles(key);
  if (scrobbles.length === 0) {
    throw new Error('No local scrobbles found for this user. Please download scrobbles first.');
  }

  const uniqueSongs = extractUniqueSongsFromScrobbles(scrobbles);
  let mbData = restart ? null : await loadMbData(key);

  if (!mbData || restart) {
    mbData = {
      username: key,
      updatedAt: new Date().toISOString(),
      status: 'idle',
      progress: {
        totalUniqueSongs: uniqueSongs.length,
        processedCount: 0,
        foundCount: 0,
        notFoundCount: 0,
        percent: 0,
        message: 'Starting fresh enrichment...',
      },
      songs: {},
    };
  }

  const lookupCategories = getMusicBrainzLookupCategories(
    scrobbles,
    uniqueSongs,
    options.manualCategories || {},
    mbData.songs || {}
  );

  // Determine pending songs (incremental: only look up songs not yet enriched)
  const pendingSongs = uniqueSongs.filter((s) => {
    if (lookupCategories.get(s.songKey)?.manualCategory === 'audiobook') return false;
    const existing = mbData.songs[s.songKey];
    if (improbableOnly) return isImprobableSong(s, existing);
    if (!existing) return true;
    if (existing.musicbrainzSchemaVersion !== 2) return true;
    if (existing.mbStatus === 'error') return true;
    return false;
  });
  const lookupPriority = new Map(pendingSongs.map(song => {
    const classification = lookupCategories.get(song.songKey) || {};
    const effectiveCategory = classification.manualCategory || classification.automaticCategory;
    let priority = 3;
    if (effectiveCategory === 'music') {
      const lastYear = new Date(song.lastScrobbledUts * 1000).getUTCFullYear();
      if (lastYear > 2000) priority = 0;
      else if (lastYear < 2000) priority = 1;
    } else if (!classification.manualCategory && classification.automaticCategory === 'audiobook') {
      priority = 2;
    }
    return [song.songKey, priority];
  }));
  pendingSongs.sort((a, b) =>
      (lookupPriority.get(a.songKey) - lookupPriority.get(b.songKey)) ||
      (b.scrobbleCount - a.scrobbleCount) ||
      (a.firstScrobbledUts - b.firstScrobbledUts) ||
      a.songKey.localeCompare(b.songKey)
  );

  if (pendingSongs.length === 0) {
    return {
      noItems: true,
      message: improbableOnly ? 'No improbable release dates need refreshing.' : 'No MusicBrainz items need looking up.',
    };
  }

  const abortController = new AbortController();
  const jobState = {
    abortController,
    aborted: false,
    progress: mbData.progress,
    totalToLookup: pendingSongs.length,
    completion: null,
  };
  activeJobs.set(key, jobState);

  logger.info(
    'MusicBrainzJob',
    `[${key}] Starting MusicBrainz enrichment: ${uniqueSongs.length} total unique songs, ${pendingSongs.length} pending lookup`
  );

  // Run in background asynchronously
  jobState.completion = (async () => {
    let processedThisRun = 0;
    const totalSongs = uniqueSongs.length;
    let alreadyDoneCount = totalSongs - pendingSongs.length;

    try {
      mbData.status = 'running';
      mbData.progress = {
        totalUniqueSongs: totalSongs,
        totalToLookup: pendingSongs.length,
        processedCount: alreadyDoneCount,
        remainingCount: pendingSongs.length,
        percent: totalSongs ? Math.round((alreadyDoneCount / totalSongs) * 100) : 100,
        message: `${pendingSongs.length} songs queued for MusicBrainz lookup.`,
      };
      jobState.progress = mbData.progress;
      await saveMbData(key, mbData);
      broadcastMbEvent(key, 'mb-progress', mbData.progress);

      for (let i = 0; i < pendingSongs.length; i++) {
        if (jobState.aborted) {
          logger.info('MusicBrainzJob', `[${key}] Enrichment paused by user request`);
          mbData.status = 'paused';
          mbData.progress = {
            ...mbData.progress,
            currentSong: null,
            processedCount: alreadyDoneCount + processedThisRun,
            remainingCount: pendingSongs.length - processedThisRun,
            message: `Enrichment stopped and saved. ${pendingSongs.length - processedThisRun} songs remain.`,
          };
          jobState.progress = mbData.progress;
          await saveMbData(key, mbData);
          broadcastMbEvent(key, 'mb-paused', mbData.progress);
          activeJobs.delete(key);
          return;
        }

        const song = pendingSongs[i];
        const currentNum = alreadyDoneCount + processedThisRun + 1;
        const percent = Math.min(100, Math.round((currentNum / totalSongs) * 100));

        const progressUpdate = {
          totalUniqueSongs: totalSongs,
          totalToLookup: pendingSongs.length,
          processedCount: currentNum,
          remainingCount: pendingSongs.length - processedThisRun,
          percent,
          currentSong: {
            artist: song.artist,
            title: song.title,
            album: song.firstScrobbledAlbum,
          },
          message: `Looking up (${currentNum}/${totalSongs}): ${song.artist} - ${song.title}`,
        };

        mbData.progress = progressUpdate;
        jobState.progress = progressUpdate;
        broadcastMbEvent(key, 'mb-progress', progressUpdate);

        let mbResult;
        try {
          mbResult = await lookupSongInMusicBrainz(song, abortController.signal);
        } catch (err) {
          if (jobState.aborted) {
            mbData.status = 'paused';
            mbData.progress = {
              ...mbData.progress,
              currentSong: null,
              processedCount: alreadyDoneCount + processedThisRun,
              remainingCount: pendingSongs.length - processedThisRun,
              message: `Enrichment stopped and saved. ${pendingSongs.length - processedThisRun} songs remain.`,
            };
            jobState.progress = mbData.progress;
            await saveMbData(key, mbData);
            broadcastMbEvent(key, 'mb-paused', mbData.progress);
            activeJobs.delete(key);
            return;
          }
          logger.warn('MusicBrainzJob', `Lookup error for "${song.artist} - ${song.title}": ${err.message}`);
          mbResult = {
            status: 'error',
            error: err.message,
            musicbrainzCategory: 'unknown',
            musicbrainzDetails: null,
            earliestDate: null,
            earliestYear: null,
            scrobbledReleaseYear: parseYear(song.firstScrobbledAlbum),
          };
        }

        // Store result for this unique song
        const storedSong = {
          songKey: song.songKey,
          artist: song.artist,
          title: song.title,
          firstScrobbledUts: song.firstScrobbledUts,
          firstScrobbledDate: song.firstScrobbledDate,
          firstScrobbledAlbum: song.firstScrobbledAlbum,
          scrobbleCount: song.scrobbleCount,
          mbStatus: mbResult.status,
          musicbrainzSchemaVersion: mbResult.status === 'not_found' || mbResult.musicbrainzDetailsComplete ? 2 : 1,
          musicbrainzDetailsComplete: Boolean(mbResult.musicbrainzDetailsComplete),
          musicbrainzCategory: mbResult.musicbrainzCategory || 'unknown',
          musicbrainzTypes: mbResult.musicbrainzDetails ? {
            primary: [...new Set(mbResult.musicbrainzDetails.releaseGroups.map((group) => group.primaryType).filter(Boolean))],
            secondary: [...new Set(mbResult.musicbrainzDetails.releaseGroups.flatMap((group) => group.secondaryTypes || []))],
          } : { primary: [], secondary: [] },
          musicbrainzDetails: mbResult.musicbrainzDetails || null,
          mbid: mbResult.recordingId || null,
          mbTitle: mbResult.recordingTitle || null,
          earliestReleaseYear: mbResult.earliestYear || null,
          earliestReleaseDate: mbResult.earliestDate || null,
          earliestReleaseTitle: mbResult.earliestReleaseTitle || null,
          scrobbledReleaseDate: mbResult.scrobbledReleaseDate || null,
          scrobbledReleaseYear: mbResult.scrobbledReleaseYear || null,
          scrobbledReleaseTitle: mbResult.scrobbledReleaseTitle || song.firstScrobbledAlbum || null,
          isLaterRelease: Boolean(mbResult.isLaterRelease),
          hasLaterReleaseKeyword: Boolean(mbResult.hasLaterReleaseKeyword),
          yearDifference: mbResult.yearDifference || 0,
          musicbrainzUrl: mbResult.musicbrainzUrl || null,
          lookupTimestamp: new Date().toISOString(),
        };

        mbData.songs[song.songKey] = storedSong;
        processedThisRun++;
        mbData.progress = {
          ...progressUpdate,
          currentSong: null,
          processedCount: alreadyDoneCount + processedThisRun,
          remainingCount: pendingSongs.length - processedThisRun,
          percent: Math.min(100, Math.round(((alreadyDoneCount + processedThisRun) / totalSongs) * 100)),
          message: `${pendingSongs.length - processedThisRun} songs remain in this lookup queue.`,
        };
        jobState.progress = mbData.progress;
        await saveMbData(key, mbData);

        // Broadcast enriched track event
        broadcastMbEvent(key, 'mb-track', storedSong);
        broadcastMbEvent(key, 'mb-progress', mbData.progress);
      }

      // Complete!
      mbData.status = 'completed';
      mbData.progress = {
        totalUniqueSongs: totalSongs,
        totalToLookup: pendingSongs.length,
        processedCount: totalSongs,
        remainingCount: 0,
        percent: 100,
        message: `MusicBrainz enrichment complete! All ${totalSongs} songs processed.`,
      };
      jobState.progress = mbData.progress;
      await saveMbData(key, mbData);
      broadcastMbEvent(key, 'mb-complete', mbData.progress);
      activeJobs.delete(key);
      logger.info('MusicBrainzJob', `[${key}] Enrichment successfully completed for all ${totalSongs} songs.`);
    } catch (err) {
      logger.error('MusicBrainzJob', `[${key}] Unexpected error during job: ${err.message}`, err);
      mbData.status = 'error';
      mbData.progress.message = `Enrichment stopped with error: ${err.message}`;
      await saveMbData(key, mbData);
      broadcastMbEvent(key, 'mb-error', { error: err.message });
      activeJobs.delete(key);
    }
  })();

  return { started: true, total: uniqueSongs.length, pending: pendingSongs.length };
}

// Pause active MusicBrainz job
export function pauseMusicBrainzJob(username) {
  const key = username.toLowerCase().trim();
  const jobState = activeJobs.get(key);
  if (!jobState) {
    return { paused: false, message: 'No active lookup. Saved progress is ready to resume.' };
  }

  jobState.aborted = true;
  jobState.abortController.abort();
  logger.info('MusicBrainzJob', `[${key}] Requested job pause`);
  return { paused: true, message: 'Stop requested. The active lookup will be saved and remaining items can be resumed.' };
}

export async function pauseAllMusicBrainzJobs() {
  const jobs = [...activeJobs.values()];
  for (const job of jobs) {
    job.aborted = true;
    job.abortController.abort();
  }
  await Promise.allSettled(jobs.map((job) => job.completion).filter(Boolean));
}

// Get user's MusicBrainz summary and status
export async function getMusicBrainzStatus(username) {
  const key = username.toLowerCase().trim();
  const activeJob = activeJobs.get(key);
  const mbData = await loadMbData(key);
  const scrobbles = await loadUserScrobbles(key);
  const uniqueSongs = extractUniqueSongsFromScrobbles(scrobbles);

  const songsArray = Object.values(mbData.songs || {});
  const currentSongs = uniqueSongs.map((song) => mbData.songs?.[song.songKey]).filter(Boolean);
  const foundCount = currentSongs.filter((s) => s.musicbrainzSchemaVersion === 2 && s.mbStatus === 'found').length;
  const notFoundCount = currentSongs.filter((s) => s.musicbrainzSchemaVersion === 2 && s.mbStatus === 'not_found').length;
  const laterReleaseCount = currentSongs.filter((s) => s.isLaterRelease).length;
  const audiobookCount = uniqueSongs.filter((s) => mbData.songs?.[s.songKey]?.musicbrainzCategory === 'audiobook').length;
  const musicCount = uniqueSongs.filter((s) => mbData.songs?.[s.songKey]?.musicbrainzCategory === 'music').length;
  const unknownClassificationCount = Math.max(0, uniqueSongs.length - audiobookCount - musicCount);
  const improbableCount = uniqueSongs.filter((song) => isImprobableSong(song, mbData.songs?.[song.songKey])).length;

  // Find oldest release year discovered
  const years = songsArray
    .map((s) => s.earliestReleaseYear)
    .filter((y) => typeof y === 'number' && y > 1900 && y <= new Date().getFullYear());
  const oldestYear = years.length > 0 ? Math.min(...years) : null;

  const totalUnique = uniqueSongs.length;
  const processed = uniqueSongs.filter((song) => mbData.songs?.[song.songKey]?.musicbrainzSchemaVersion === 2).length;
  const pending = Math.max(0, totalUnique - processed);

  return {
    username: key,
    isRunning: Boolean(activeJob),
    status: activeJob ? 'running' : mbData.status === 'running' ? 'paused' : mbData.status || 'idle',
    progress: activeJob?.progress || mbData.progress || { percent: 0 },
    stats: {
      totalUniqueSongs: totalUnique,
      processedSongs: processed,
      pendingSongs: pending,
      foundCount,
      notFoundCount,
      laterReleaseCount,
      audiobookCount,
      musicCount,
      unknownClassificationCount,
      improbableCount,
      oldestReleaseYear: oldestYear,
      percentComplete: totalUnique > 0 ? Math.min(100, Math.round((processed / totalUnique) * 100)) : 0,
    },
  };
}

// Return cached MusicBrainz classifications for local scrobbles; this never makes network requests.
export async function getMusicBrainzClassifications(username, artist = '') {
  const key = username.toLowerCase().trim();
  const mbData = await loadMbData(key);
  const artistPrefixes = (Array.isArray(artist) ? artist : artist ? [artist] : []).map(value => `${normalizeText(value)}:::`);
  return Object.fromEntries(Object.entries(mbData.songs || {}).flatMap(([songKey, song]) => {
    if (artistPrefixes.length && !artistPrefixes.some(prefix => songKey.startsWith(prefix))) return [];
    const classification = song?.musicbrainzCategory;
    return ['music', 'audiobook'].includes(classification) ? [[songKey, classification]] : [];
  }));
}

// Return locally cached MusicBrainz details for tracks belonging to a detail-page entity.
export async function getMusicBrainzEntityDetails(username, { type, name, artist = '' } = {}) {
  const key = username.toLowerCase().trim();
  const [mbData, scrobbles] = await Promise.all([loadMbData(key), loadUserScrobbles(key)]);
  const currentSongs = new Map(extractUniqueSongsFromScrobbles(scrobbles).map((song) => [song.songKey, song]));
  const matchingSongKeys = new Set();
  let variantGroups = { artists: [], albums: [], tracks: [] };
  try {
    const localUserKey = String(username || '').trim().toLocaleLowerCase();
    const savedVariants = JSON.parse(await fs.readFile(path.join(dataDir, `scrobble_variants_${encodeURIComponent(localUserKey)}.json`), 'utf8'));
    variantGroups = { ...variantGroups, ...(savedVariants.groups || {}) };
  } catch (err) { if (err.code !== 'ENOENT' && err.name !== 'SyntaxError') throw err; }
  const groupValues = (groups, target, parent = '') => {
    const group = groups.find(item => normalizeText(item.canonical) === normalizeText(target)
      || (item.variants || []).some(value => normalizeText(value) === normalizeText(target)));
    if (!group || (parent && normalizeText(group.artist) !== normalizeText(parent))) return new Set([target]);
    return new Set([group.canonical, ...(group.variants || [])]);
  };
  const artistNames = type === 'artist' ? groupValues(variantGroups.artists, name) : groupValues(variantGroups.artists, artist);
  const entityNames = type === 'album' ? groupValues(variantGroups.albums, name, artist)
    : type === 'track' ? groupValues(variantGroups.tracks, name, artist) : new Set([name]);
  for (const track of scrobbles) {
    const rawArtist = typeof track.artist === 'string' ? track.artist : track.artist?.['#text'] || track.artist?.name || '';
    const artistMatches = [...artistNames].some(value => normalizeText(value) === normalizeText(rawArtist));
    const itemName = type === 'album' ? normalizeAlbumTitle(track.album) : track.name;
    const itemMatches = [...entityNames].some(value => normalizeText(value) === normalizeText(itemName));
    if ((type === 'artist' && artistMatches) || (type !== 'artist' && artistMatches && itemMatches)) {
      matchingSongKeys.add(makeSongKey(rawArtist, track.name));
    }
  }

  return [...matchingSongKeys].map((songKey) => {
    const entry = mbData.songs?.[songKey];
    if (!entry) return null;
    const currentSong = currentSongs.get(songKey);
    return {
      artist: currentSong?.artist || entry.artist || artist,
      title: currentSong?.title || entry.title || name,
      scrobbleCount: currentSong?.scrobbleCount || entry.scrobbleCount || 0,
      mbStatus: entry.mbStatus || 'pending',
      musicbrainzCategory: entry.musicbrainzCategory || 'unknown',
      mbid: entry.mbid || entry.musicbrainzDetails?.recordingId || null,
      musicbrainzUrl: entry.musicbrainzUrl || null,
      earliestReleaseYear: entry.earliestReleaseYear || null,
      earliestReleaseDate: entry.earliestReleaseDate || null,
      earliestReleaseTitle: entry.earliestReleaseTitle || null,
      musicbrainzDetails: entry.musicbrainzDetails || null,
    };
  }).filter(Boolean).sort((a, b) => b.scrobbleCount - a.scrobbleCount || a.title.localeCompare(b.title));
}

// Get paginated / filtered MusicBrainz songs data
export async function getMusicBrainzData(username, params = {}) {
  const key = username.toLowerCase().trim();
  const mbData = await loadMbData(key);
  const scrobbles = await loadUserScrobbles(key);
  const uniqueSongs = extractUniqueSongsFromScrobbles(scrobbles);

  const search = (params.search || '').toLowerCase().trim();
  const filter = params.filter || 'all'; // all, later_releases, found, not_found, pending, music, audiobook, classification_unknown
  const sortBy = params.sortBy || 'firstScrobbledAsc'; // firstScrobbledAsc, firstScrobbledDesc, earliestYearAsc, earliestYearDesc, yearDiffDesc, playCountDesc, artistAsc, titleAsc
  const page = Math.max(1, parseInt(params.page || '1', 10));
  const limit = Math.min(200, Math.max(1, parseInt(params.limit || '50', 10)));

  // Combine unique songs with enriched mbData
  let combined = uniqueSongs.map((us) => {
    const enriched = mbData.songs[us.songKey];
    if (enriched) {
      return {
        ...us,
        ...enriched,
        firstScrobbledAlbum: normalizeAlbumTitle(enriched.firstScrobbledAlbum) || us.firstScrobbledAlbum,
        isImprobable: isImprobableSong(us, enriched),
        musicbrainzCategory: enriched.musicbrainzCategory || 'unknown',
      };
    }
    return {
      ...us,
      mbStatus: 'pending',
      isImprobable: false,
      musicbrainzCategory: 'unknown',
      earliestReleaseYear: null,
      earliestReleaseDate: null,
      earliestReleaseTitle: null,
      scrobbledReleaseDate: null,
      scrobbledReleaseYear: parseYear(us.firstScrobbledAlbum),
      isLaterRelease: false,
      yearDifference: 0,
      musicbrainzUrl: null,
    };
  });

  // Apply search query
  if (search) {
    combined = combined.filter((s) => {
      const a = (s.artist || '').toLowerCase();
      const t = (s.title || '').toLowerCase();
      const alb = (s.firstScrobbledAlbum || '').toLowerCase();
      const mbAlb = (s.earliestReleaseTitle || '').toLowerCase();
      return a.includes(search) || t.includes(search) || alb.includes(search) || mbAlb.includes(search);
    });
  }

  // Apply filter
  if (filter === 'later_releases') {
    combined = combined.filter((s) => s.isLaterRelease);
  } else if (filter === 'found') {
    combined = combined.filter((s) => s.mbStatus === 'found');
  } else if (filter === 'not_found') {
    combined = combined.filter((s) => s.mbStatus === 'not_found');
  } else if (filter === 'pending') {
    combined = combined.filter((s) => s.mbStatus === 'pending');
  } else if (filter === 'music') {
    combined = combined.filter((s) => s.musicbrainzCategory === 'music');
  } else if (filter === 'audiobook') {
    combined = combined.filter((s) => s.musicbrainzCategory === 'audiobook');
  } else if (filter === 'classification_unknown') {
    combined = combined.filter((s) => !['music', 'audiobook'].includes(s.musicbrainzCategory));
  } else if (filter === 'improbable') {
    combined = combined.filter((s) => s.isImprobable);
  }

  // Apply sorting
  combined.sort((a, b) => {
    const textSorts = {
      title: [a.title, b.title],
      artist: [a.artist, b.artist],
      classification: [a.musicbrainzCategory, b.musicbrainzCategory],
      mbStatus: [a.mbStatus, b.mbStatus],
    };
    const numberSorts = {
      playCount: [a.scrobbleCount, b.scrobbleCount],
      firstScrobbled: [a.firstScrobbledUts, b.firstScrobbledUts],
      scrobbledRelease: [a.scrobbledReleaseYear || parseYear(a.firstScrobbledAlbum), b.scrobbledReleaseYear || parseYear(b.firstScrobbledAlbum)],
      earliestYear: [a.earliestReleaseYear, b.earliestReleaseYear],
      yearDiff: [a.yearDifference, b.yearDifference],
    };
    const match = sortBy.match(/^(title|artist|classification|mbStatus|playCount|firstScrobbled|scrobbledRelease|earliestYear|yearDiff)(Asc|Desc)$/);
    if (!match) return (a.firstScrobbledUts || 0) - (b.firstScrobbledUts || 0);

    const [, field, order] = match;
    const values = textSorts[field] || numberSorts[field];
    const [left, right] = values;
    const direction = order === 'Desc' ? -1 : 1;
    const leftMissing = left === null || left === undefined || left === '';
    const rightMissing = right === null || right === undefined || right === '';
    if (leftMissing !== rightMissing) return leftMissing ? 1 : -1;
    if (leftMissing) return 0;
    const comparison = textSorts[field]
      ? String(left).localeCompare(String(right), undefined, { sensitivity: 'base' })
      : Number(left) - Number(right);
    return comparison * direction;
  });

  const totalFiltered = combined.length;
  const totalPages = Math.ceil(totalFiltered / limit) || 1;
  const startIndex = (page - 1) * limit;
  const paginatedItems = combined.slice(startIndex, startIndex + limit);

  return {
    items: paginatedItems,
    pagination: {
      page,
      limit,
      totalItems: totalFiltered,
      totalPages,
    },
  };
}
