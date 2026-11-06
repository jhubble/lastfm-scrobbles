import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { loadPreprocessingRules, savePreprocessingRules, detectAudiobookLayouts, preprocessScrobbles } from './preprocessing.js';
import { processScrobbles as normalizeScrobbles, normalizeScrobbleItems } from './normalizeScrobbles.js';
import {
  initMusicBrainz,
  getMusicBrainzStatus,
  getMusicBrainzData,
  getMusicBrainzClassifications,
  getMusicBrainzEntityDetails,
  getMusicBrainzThrottle,
  setMusicBrainzThrottle,
  startMusicBrainzJob,
  pauseMusicBrainzJob,
  pauseAllMusicBrainzJobs,
  registerMbSseClient,
  removeMbSseClient,
} from './musicbrainz.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Configuration ---------------------------------------------------------
const REQUEST_TIMEOUT_MS = parseInt(process.env.LASTFM_TIMEOUT_MS || '30000', 10);
const DEFAULT_MAX_RETRIES = 3;
const PORT = parseInt(process.env.PORT, 10) || 3000;
const FALLBACK_PORT = 3001;
const API_KEY = process.env.LASTFM_API_KEY;
const BASE_URL = 'http://ws.audioscrobbler.com/2.0/';
const DATA_DIR = path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const NORMALIZATION_CONFIG_PATH = path.join(DATA_DIR, 'scrobble_normalization_rules.json');
const LEGACY_NORMALIZATION_CONFIG_PATH = path.join(__dirname, 'config.json');

// --- Logging Helper ---------------------------------------------------------
function formatLog(level, category, message, meta) {
  const timestamp = new Date().toISOString();
  let metaStr = '';
  if (meta !== undefined) {
    if (meta instanceof Error) {
      const codeStr = meta.code ? ` [Code: ${meta.code}]` : '';
      const causeStr = meta.cause
        ? ` [Cause: ${meta.cause.code ? `${meta.cause.code} - ` : ''}${meta.cause.message || meta.cause}]`
        : '';
      const statusStr = meta.status ? ` [HTTP ${meta.status}]` : '';
      metaStr = ` | ${meta.message}${statusStr}${codeStr}${causeStr}${meta.stack ? `\n${meta.stack}` : ''}`;
    } else if (typeof meta === 'object') {
      try {
        metaStr = ` | ${JSON.stringify(meta)}`;
      } catch {
        metaStr = ` | [Object]`;
      }
    } else {
      metaStr = ` | ${meta}`;
    }
  }
  return `[${timestamp}] [${level}] [${category}] ${message}${metaStr}`;
}

const logger = {
  info: (cat, msg, meta) => console.log(formatLog('INFO', cat, msg, meta)),
  warn: (cat, msg, meta) => console.warn(formatLog('WARN', cat, msg, meta)),
  error: (cat, msg, meta) => console.error(formatLog('ERROR', cat, msg, meta)),
  debug: (cat, msg, meta) => console.debug(formatLog('DEBUG', cat, msg, meta)),
};

const app = express();

// --- Server start with fallback port ----------------------------------------
let server;
try {
  server = app.listen(PORT, () => {
    logger.info('Server', `Listening on port ${PORT}`);
  });
} catch (e) {
  if (e.code === 'EADDRINUSE') {
    logger.warn('Server', `Port ${PORT} in use, falling back to ${FALLBACK_PORT}`);
    server = app.listen(FALLBACK_PORT, () => {
      logger.info('Server', `Listening on fallback port ${FALLBACK_PORT}`);
    });
  } else {
    logger.error('Server', `Failed to start: ${e.message}`, e);
    process.exit(1);
  }
}

const openSockets = new Set();
server.on('connection', socket => {
  openSockets.add(socket);
  socket.on('close', () => openSockets.delete(socket));
});

// --- Graceful shutdown ------------------------------------------------------
let shutdownStarted = false;
async function shutdown() {
  if (shutdownStarted) return;
  shutdownStarted = true;
  logger.info('Server', 'Shutting down…');
  logger.info('Server', 'aborting downloads');
  for (const [, job] of activeDownloads) {
    if (job.abortController) {
      logger.info('Server', 'aborting job');
      job.abortController.abort();
    }
  }

  logger.info('Server', 'Stopping MusicBrainz enrichment and saving progress');
  await pauseAllMusicBrainzJobs();

  // EventSource connections stay open for the lifetime of the page and would
  // otherwise keep server.close() waiting indefinitely.
  for (const clients of sseClients.values()) {
    for (const client of clients) client.end();
  }

  server.close(() => {
    logger.info('Server', 'Closed HTTP server');
    process.exit(0);
  });
  // Stop keep-alive and other active HTTP connections so Ctrl-C can finish
  // even when a browser still has the dashboard open.
  server.closeAllConnections?.();
  for (const socket of openSockets) socket.destroy();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// --- Unhandled promise rejections -------------------------------------------
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Uncaught', 'Unhandled promise rejection', { reason, promise });
});

// Validate essential configuration
if (!API_KEY) {
  logger.error('Config', 'LASTFM_API_KEY environment variable is missing. Exiting.');
  process.exit(1);
}

// --- Active Download State & SSE Management ---------------------------------
// username (lowercase) -> { abortController, aborted: boolean, progress: Object }
const activeDownloads = new Map();
// username (lowercase) -> Set<res>
const sseClients = new Map();

function sendSSE(res, eventName, data) {
  try {
    res.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch (err) {
    logger.warn('SSE', `Failed to send SSE event: ${err.message}`);
  }
}

function broadcastDownloadEvent(username, eventName, data) {
  const key = username.toLowerCase().trim();
  const clients = sseClients.get(key);
  if (clients && clients.size > 0) {
    for (const client of clients) {
      sendSSE(client, eventName, data);
    }
  }
}

// HTTP Request Logger Middleware
app.use((req, res, next) => {
  const startTime = Date.now();
  const { method, originalUrl } = req;

  res.on('finish', () => {
    const duration = Date.now() - startTime;
    const { statusCode } = res;
    const logLevel = statusCode >= 500 ? 'error' : statusCode >= 400 ? 'warn' : 'info';
    logger[logLevel]('HTTP', `${method} ${originalUrl} ${statusCode} - ${duration}ms`);
  });

  next();
});

app.use(express.json());
// This endpoint exposes only a non-secret convenience setting to the UI.
app.get('/api/config', (req, res) => {
  res.json({
    defaultLastFmUsername: process.env.LASTFM_USERNAME || '',
    autoLoadScrobbles: process.env.AUTO_LOAD_SCROBBLES === 'true',
    autoFetchNewerScrobbles: process.env.AUTO_FETCH_NEWER_SCROBBLES === 'true',
  });
});
app.get('/api/normalization/config', async (req, res) => {
  try { return res.json(JSON.parse(await fs.readFile(NORMALIZATION_CONFIG_PATH, 'utf8'))); }
  catch (err) { return res.status(500).json({ error: `Could not read normalization config: ${err.message}` }); }
});
app.put('/api/normalization/config', async (req, res) => {
  const config = req.body?.config;
  if (!config || typeof config !== 'object' || Array.isArray(config)) return res.status(400).json({ error: 'Config must be a JSON object.' });
  try {
    // Validate all regex patterns before persisting rules used by preview/normalization.
    if (config.removePatterns != null && !Array.isArray(config.removePatterns)) throw new Error('removePatterns must be a list.');
    for (const pattern of config.removePatterns || []) {
      if (typeof pattern !== 'string') throw new Error('Regex patterns must be strings.');
      new RegExp(pattern, 'gi');
    }
    for (const list of [config.removeTokens || [], config.removeVideoTags || [], config.ignoreArtists || []]) {
      if (!Array.isArray(list) || list.some(value => typeof value !== 'string')) throw new Error('Rule lists must contain strings.');
    }
    for (const aliases of [config.artistAliases, config.trackAliases, config.albumAliases]) {
      if (aliases != null && (typeof aliases !== 'object' || Array.isArray(aliases) || Object.values(aliases).some(value => typeof value !== 'string'))) throw new Error('Alias rules must map strings to strings.');
    }
    if (config.minScrobbleThreshold != null && (!Number.isInteger(config.minScrobbleThreshold) || config.minScrobbleThreshold < 1)) throw new Error('minScrobbleThreshold must be a positive integer.');
    const temporary = `${NORMALIZATION_CONFIG_PATH}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(config, null, 2));
    await fs.rename(temporary, NORMALIZATION_CONFIG_PATH);
    await rebuildAllCompactScrobbles();
    return res.json({ config });
  } catch (err) { return res.status(400).json({ error: `Invalid normalization config: ${err.message}` }); }
});
app.post('/api/scrobbles/:username/normalization-preview', async (req, res) => {
  try {
    const [items, savedConfig] = await Promise.all([
      loadScrobbles(req.params.username.trim()),
      fs.readFile(NORMALIZATION_CONFIG_PATH, 'utf8').then(JSON.parse),
    ]);
    const config = req.body?.config || savedConfig;
    const groups = normalizeScrobbles(items, config);
    const groupedPlays = groups.reduce((sum, group) => sum + group.scrobbleCount, 0);
    const examples = groups.filter(group => group.variationsCount > 1).sort((a, b) => b.scrobbleCount - a.scrobbleCount);
    return res.json({ username: req.params.username.trim(), sourceScrobbles: items.length, groupCount: groups.length, groupedPlays,
      ignoredScrobbles: items.length - groupedPlays,
      exampleCount: examples.length, examples });
  } catch (err) { return res.status(500).json({ error: `Could not preview normalization: ${err.message}` }); }
});
app.use(express.static(PUBLIC_DIR));

// Explicit route for root serving index.html
app.get('/', (req, res) => {
  const indexPath = path.join(PUBLIC_DIR, 'index.html');
  logger.debug('Static', `Serving root index file: ${indexPath}`);
  res.sendFile(indexPath);
});

// Ensure data directory exists
try {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    await fs.access(NORMALIZATION_CONFIG_PATH);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    // Migrate the former project-root config once, preserving its rules.
    try {
      const legacyConfig = await fs.readFile(LEGACY_NORMALIZATION_CONFIG_PATH, 'utf8');
      await fs.writeFile(NORMALIZATION_CONFIG_PATH, legacyConfig);
      logger.info('Storage', `Migrated normalization rules to ${NORMALIZATION_CONFIG_PATH}`);
    } catch (legacyErr) {
      if (legacyErr.code !== 'ENOENT') throw legacyErr;
    }
  }
  await initMusicBrainz({ dataDir: DATA_DIR, logger });
  logger.info('Storage', `Data directory initialized at ${DATA_DIR}`);
} catch (err) {
  logger.error('Storage', `Failed to initialize data directory: ${err.message}`, err);
}

const getDataFilePath = (username) => path.join(DATA_DIR, `${username.toLowerCase().trim()}_scrobbles.json`);
const getCompactDataFilePath = (username) => path.join(DATA_DIR, `${username.toLowerCase().trim()}_scrobbles_small.json`);
const getProgressFilePath = (username) => path.join(DATA_DIR, `${username.toLowerCase().trim()}_download_progress.json`);
function getCategoryFilePath(username) {
  const localUserKey = String(username || '').trim().toLocaleLowerCase();
  if (!localUserKey) throw new Error('A Last.fm username is required.');
  return path.join(DATA_DIR, `audiobook_categories_${encodeURIComponent(localUserKey)}.json`);
}
function getVariantFilePath(username) {
  const localUserKey = String(username || '').trim().toLocaleLowerCase();
  if (!localUserKey) throw new Error('A Last.fm username is required.');
  return path.join(DATA_DIR, `scrobble_variants_${encodeURIComponent(localUserKey)}.json`);
}

async function loadVariants(username) {
  try {
    const parsed = JSON.parse(await fs.readFile(getVariantFilePath(username), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? { version: 1, groups: { artists: [], albums: [], tracks: [], ...(parsed.groups || {}) }, decisions: { artists: [], albums: [], tracks: [], ...(parsed.decisions || {}) } }
      : { version: 1, groups: { artists: [], albums: [], tracks: [] }, decisions: { artists: [], albums: [], tracks: [] } };
  } catch (err) {
    if (err.code === 'ENOENT') return { version: 1, groups: { artists: [], albums: [], tracks: [] }, decisions: { artists: [], albums: [], tracks: [] } };
    throw err;
  }
}

async function saveVariants(username, variants) {
  const filePath = getVariantFilePath(username);
  const temporaryPath = `${filePath}.tmp`;
  await fs.writeFile(temporaryPath, JSON.stringify(variants, null, 2));
  await fs.rename(temporaryPath, filePath);
}

async function loadCategories(username) {
  const filePath = getCategoryFilePath(username);
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    if (err instanceof SyntaxError) {
      const backupPath = `${filePath}.corrupt.${Date.now()}`;
      try {
        await fs.rename(filePath, backupPath);
        logger.error('Categories', `Corrupted category file for "${username}" moved to ${backupPath}; starting with empty categories`, err);
        return {};
      } catch (renameErr) {
        logger.error('Categories', `Could not preserve corrupted category file for "${username}": ${renameErr.message}`, renameErr);
      }
    }
    throw err;
  }
}

async function saveCategories(username, categories) {
  const filePath = getCategoryFilePath(username);
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  await fs.writeFile(temporaryPath, JSON.stringify(categories, null, 2));
  await fs.rename(temporaryPath, filePath);
}

// Read scrobbles from file
async function loadScrobbles(username) {
  const filePath = getDataFilePath(username);
  try {
    const data = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(data);
    logger.debug('Storage', `Loaded ${parsed.length} scrobbles for user "${username}" from ${filePath}`);
    return parsed;
  } catch (err) {
    if (err.code === 'ENOENT') {
      logger.debug('Storage', `No local cache found for user "${username}" (${filePath})`);
    } else if (err.name === 'SyntaxError' || err.message.includes('JSON')) {
      // Corrupted JSON file – move it aside and start fresh
      const backupPath = `${filePath}.corrupt.${Date.now()}`;
      try {
        await fs.rename(filePath, backupPath);
        logger.error('Storage', `Corrupted scrobbles file for user "${username}" moved to ${backupPath}`);
      } catch (renameErr) {
        logger.error('Storage', `Failed to rename corrupted scrobbles file for user "${username}": ${renameErr.message}`, renameErr);
      }
    } else {
      logger.warn('Storage', `Failed reading scrobbles file for user "${username}": ${err.message}`, err);
    }
    return [];
  }
}

// Save scrobbles to file sorted chronologically and deduplicated
async function saveScrobbles(username, scrobbles) {
  const filePath = getDataFilePath(username);
  const uniqueMap = new Map();
  for (const track of scrobbles) {
    if (track.date && track.date.uts) {
      const artistName = track.artist?.['#text'] || track.artist?.name || track.artist || 'Unknown Artist';
      const trackName = track.name || 'Unknown Track';
      const key = `${artistName}_${trackName}_${track.date.uts}`;
      uniqueMap.set(key, track);
    }
  }
  const cleanList = Array.from(uniqueMap.values());
  cleanList.sort((a, b) => Number(a.date.uts) - Number(b.date.uts));
  await fs.writeFile(filePath, JSON.stringify(cleanList, null, 2));
  await saveCompactScrobbles(username, cleanList);
  return cleanList;
}

async function saveCompactScrobbles(username, scrobbles) {
  const normalizationConfig = JSON.parse(await fs.readFile(NORMALIZATION_CONFIG_PATH, 'utf8'));
  const compactList = normalizeScrobbleItems(scrobbles, normalizationConfig)
    .map(({ name, artist, album, date, mbid }) => ({ name, artist, album, date, ...(mbid ? { mbid } : {}) }));
  const compactPath = getCompactDataFilePath(username);
  const temporaryPath = `${compactPath}.${randomUUID()}.tmp`;
  await fs.writeFile(temporaryPath, JSON.stringify(compactList));
  await fs.rename(temporaryPath, compactPath);
  return compactList;
}

async function rebuildAllCompactScrobbles() {
  const files = await fs.readdir(DATA_DIR);
  const sourceFiles = files.filter(file => file.endsWith('_scrobbles.json'));
  for (const file of sourceFiles) {
    const username = file.slice(0, -'_scrobbles.json'.length);
    try {
      const scrobbles = JSON.parse(await fs.readFile(path.join(DATA_DIR, file), 'utf8'));
      if (!Array.isArray(scrobbles)) throw new Error('Scrobble source must be a JSON array.');
      await saveCompactScrobbles(username, scrobbles);
    } catch (err) {
      logger.warn('Normalization', `Could not rebuild compact scrobbles for ${username}: ${err.message}`, err);
    }
  }
}

async function loadAnalysisScrobbles(username) {
  try {
    return JSON.parse(await fs.readFile(getCompactDataFilePath(username), 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    // Create the compact cache for users with an older full export.
    return saveCompactScrobbles(username, await loadScrobbles(username));
  }
}

// Upgrade existing compact caches with the active normalization rules.
await rebuildAllCompactScrobbles();

// Read download progress metadata
async function loadDownloadProgress(username) {
  const filePath = getProgressFilePath(username);
  try {
    const data = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(data);
  } catch {
    return null;
  }
}

// Save download progress metadata
async function saveDownloadProgress(username, progress) {
  const filePath = getProgressFilePath(username);
  await fs.writeFile(filePath, JSON.stringify(progress, null, 2));
}

// Helper: Sleep
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- Last.fm API Throttling & Network Error Utilities ------------------------
let lastFmLastRequestTime = 0;
let currentLastFmThrottleMs = Math.max(100, parseInt(process.env.LASTFM_THROTTLE_MS || '1000', 10));

function getThrottleMs() {
  return currentLastFmThrottleMs;
}

function setThrottleMs(ms) {
  const parsed = parseInt(ms, 10);
  if (!isNaN(parsed) && parsed >= 100) {
    currentLastFmThrottleMs = parsed;
    logger.info('LastFM', `Throttle rate set to ${parsed}ms (${(1000 / parsed).toFixed(2)} req/sec)`);
    return currentLastFmThrottleMs;
  }
  return currentLastFmThrottleMs;
}

async function throttleLastFm(customThrottleMs = null, abortSignal = null) {
  const delay = typeof customThrottleMs === 'number' && customThrottleMs >= 0 ? customThrottleMs : currentLastFmThrottleMs;
  if (delay <= 0) return;
  const now = Date.now();
  const elapsed = now - lastFmLastRequestTime;
  if (elapsed < delay) {
    const wait = delay - elapsed;
    logger.debug('LastFM', `Throttling: waiting ${wait}ms before next request (delay: ${delay}ms)`);
    if (abortSignal) {
      await new Promise((resolve, reject) => {
        if (abortSignal.aborted) return reject(new Error('Download aborted by user'));
        const timer = setTimeout(resolve, wait);
        const onAbort = () => {
          clearTimeout(timer);
          reject(new Error('Download aborted by user'));
        };
        abortSignal.addEventListener('abort', onAbort, { once: true });
      });
    } else {
      await sleep(wait);
    }
  }
  lastFmLastRequestTime = Date.now();
}

function extractNetworkErrorDetails(err) {
  const codes = [];
  const messages = [];
  let curr = err;
  let depth = 0;
  while (curr && depth < 5) {
    if (curr.code && !codes.includes(curr.code)) codes.push(curr.code);
    if (curr.name && curr.name !== 'TypeError' && curr.name !== 'Error' && !codes.includes(curr.name)) {
      codes.push(curr.name);
    }
    if (curr.syscall && !codes.includes(`syscall:${curr.syscall}`)) {
      codes.push(`syscall:${curr.syscall}`);
    }
    if (curr.message && curr.message !== 'fetch failed' && !messages.includes(curr.message)) {
      messages.push(curr.message);
    }
    curr = curr.cause;
    depth++;
  }
  const codeStr = codes.join(' / ');
  const rawMsg = messages.join('; ') || err.message;
  const lower = `${codeStr} ${rawMsg}`.toLowerCase();
  let friendlyCategory = 'Network Connection Error';
  let friendlyDescription = rawMsg;
  if (lower.includes('etimedout') || lower.includes('und_err_connect_timeout') || lower.includes('time out') || lower.includes('timeout')) {
    friendlyCategory = 'Connection Timeout';
    friendlyDescription = 'Last.fm took too long to connect or respond. This usually indicates high Last.fm server load or packet loss.';
  } else if (lower.includes('econnreset') || lower.includes('socket hung up')) {
    friendlyCategory = 'Connection Reset';
    friendlyDescription = 'The connection was abruptly terminated or reset by the Last.fm server.';
  } else if (lower.includes('econnrefused')) {
    friendlyCategory = 'Connection Refused';
    friendlyDescription = 'The Last.fm server refused the connection.';
  } else if (lower.includes('enotfound') || lower.includes('eai_again')) {
    friendlyCategory = 'DNS Lookup Failed';
    friendlyDescription = 'Could not resolve ws.audioscrobbler.com. Please verify your internet connection and DNS.';
  } else if (lower.includes('aborterror') || lower.includes('aborted')) {
    friendlyCategory = 'Request Aborted';
    friendlyDescription = 'The request was aborted or cancelled.';
  } else if (lower.includes('cert_') || lower.includes('ssl') || lower.includes('tls')) {
    friendlyCategory = 'SSL/TLS Handshake Error';
    friendlyDescription = 'Failed to establish secure TLS/SSL connection with Last.fm.';
  }
  return {
    category: friendlyCategory,
    code: codeStr || (err.name !== 'TypeError' ? err.name : 'NETWORK_ERROR'),
    description: friendlyDescription,
    rawMessage: rawMsg,
    summary: `${friendlyCategory}: ${friendlyDescription}${codeStr ? ` [Code: ${codeStr}]` : ''}`,
  };
}

async function fetchLastFmPage(username, page = 1, limit = 200, options = {}) {
  const {
    throttleMs = currentLastFmThrottleMs,
    abortSignal = null,
    maxRetries = DEFAULT_MAX_RETRIES,
    onRetry = null,
  } = options;

  if (!API_KEY || API_KEY === 'YOUR_LASTFM_API_KEY_HERE') {
    logger.error('LastFM', 'API key missing or unconfigured in .env');
    throw new Error('Missing or unconfigured LASTFM_API_KEY in .env file');
  }

  const url = `${BASE_URL}?method=user.getRecentTracks&user=${encodeURIComponent(username)}&api_key=${API_KEY}&format=json&page=${page}&limit=${limit}`;

  let attempt = 0;
  while (attempt <= maxRetries) {
    if (abortSignal?.aborted) throw new Error('Download aborted by user');

    await throttleLastFm(throttleMs, abortSignal);

    const startTime = Date.now();
    logger.debug('LastFM', `[${username}] Fetching page ${page} (limit ${limit}, throttle ${throttleMs}ms, attempt ${attempt + 1})`);

    let res;
    let requestError = null;
    try {
      const timeoutSignal = AbortSignal.timeout ? AbortSignal.timeout(REQUEST_TIMEOUT_MS) : null;
      let effectiveSignal = abortSignal;
      if (abortSignal && timeoutSignal && AbortSignal.any) {
        effectiveSignal = AbortSignal.any([abortSignal, timeoutSignal]);
      } else if (!abortSignal && timeoutSignal) {
        effectiveSignal = timeoutSignal;
      }
      res = await fetch(url, { signal: effectiveSignal });
    } catch (err) {
      requestError = err;
    }

    const duration = Date.now() - startTime;

    if (requestError) {
      if (abortSignal?.aborted) throw new Error('Download aborted by user');
      const info = extractNetworkErrorDetails(requestError);
      const retryable = attempt < maxRetries;
      logger.error('LastFM', `[${username}] Network error on page ${page} (attempt ${attempt + 1}/${maxRetries + 1}, ${duration}ms): ${info.summary}`, {
        page,
        durationMs: duration,
        code: info.code,
        category: info.category,
        cause: requestError.cause?.message || requestError.message,
      });
      if (retryable) {
        attempt++;
        const backoffMs = Math.min(10000, 1500 * Math.pow(1.5, attempt));
        logger.warn('LastFM', `[${username}] Retrying page ${page} in ${(backoffMs / 1000).toFixed(1)}s (attempt ${attempt}/${maxRetries})...`);
        if (typeof onRetry === 'function') {
          onRetry({ page, attempt, maxRetries, backoffMs, error: info.summary, category: info.category, code: info.code });
        }
        await sleep(backoffMs);
        continue;
      }
      throw requestError;
    }

    let bodyText = '';
    let data = null;
    try {
      bodyText = await res.text();
      if (bodyText.trim().startsWith('{')) {
        data = JSON.parse(bodyText);
      }
    } catch (parseErr) {
      logger.warn('LastFM', `[${username}] Non-JSON response received on page ${page} (HTTP ${res.status}): ${parseErr.message}`);
    }

    if (!res.ok) {
      const isTransientHttp = [429, 502, 503, 504].includes(res.status);
      const apiMsg = data?.message || '';
      const snippet = apiMsg || (bodyText.length > 200 ? `${bodyText.slice(0, 200).replace(/\s+/g, ' ')}...` : bodyText.replace(/\s+/g, ' '));
      const httpErrorSummary = `HTTP ${res.status} ${res.statusText || ''}${snippet ? ` - ${snippet}` : ''}`;
      logger.error('LastFM', `[${username}] HTTP error on page ${page} (${duration}ms): ${httpErrorSummary}`, {
        status: res.status,
        statusText: res.statusText,
        page,
        durationMs: duration,
      });
      if (isTransientHttp && attempt < maxRetries) {
        attempt++;
        const retryAfter = parseInt(res.headers.get('retry-after') || '2', 10);
        const backoffMs = Math.max(retryAfter * 1000, 2000 * attempt);
        logger.warn('LastFM', `[${username}] Transient HTTP ${res.status} on page ${page}. Waiting ${(backoffMs / 1000).toFixed(1)}s before retry ${attempt}/${maxRetries}...`);
        if (typeof onRetry === 'function') {
          onRetry({ page, attempt, maxRetries, backoffMs, error: httpErrorSummary, category: `HTTP ${res.status}`, code: `HTTP_${res.status}` });
        }
        await sleep(backoffMs);
        continue;
      }
      const httpErr = new Error(`Last.fm returned ${httpErrorSummary}`);
      httpErr.status = res.status;
      httpErr.code = `HTTP_${res.status}`;
      httpErr.category = res.status === 429 ? 'Rate Limited' : `HTTP Server Error (${res.status})`;
      httpErr.page = page;
      httpErr.isHttpError = true;
      httpErr.description = isTransientHttp
        ? `Last.fm service temporarily unavailable or rate limited (HTTP ${res.status}).`
        : `Last.fm request failed with HTTP ${res.status}.`;
      throw httpErr;
    }

    if (data && data.error) {
      logger.error('LastFM', `[${username}] API Error [Code ${data.error}] on page ${page}: ${data.message}`, {
        errorCode: data.error,
        errorMessage: data.message,
        page,
      });
      const apiErr = new Error(`Last.fm API Error: ${data.message} (code ${data.error})`);
      apiErr.code = `LASTFM_API_${data.error}`;
      apiErr.category = 'Last.fm API Error';
      apiErr.page = page;
      apiErr.isApiError = true;
      apiErr.description = data.message;
      throw apiErr;
    }

    if (!data || !data.recenttracks) {
      const err = new Error(`Invalid response structure from Last.fm on page ${page}`);
      err.code = 'INVALID_RESPONSE';
      err.category = 'Response Format Error';
      err.page = page;
      err.description = 'Last.fm returned unexpected response data.';
      throw err;
    }

    logger.debug('LastFM', `[${username}] Page ${page} received in ${duration}ms (${data.recenttracks.track?.length || 0} items)`);
    return data.recenttracks;
  }
}

function extractTracks(recenttracks) {
  if (!recenttracks || !recenttracks.track) return [];
  const raw = Array.isArray(recenttracks.track) ? recenttracks.track : [recenttracks.track];
  return raw.filter((t) => t && t.date && t.date.uts);
}

// --- Download Job Runner -----------------------------------------------------
async function runDownloadJob(username, { restart = false, throttleMs = null } = {}) {
  const key = username.toLowerCase().trim();

  if (activeDownloads.has(key)) {
    logger.warn('DownloadJob', `[${key}] Download already in progress`);
    return { alreadyRunning: true };
  }

  const effectiveThrottle = typeof throttleMs === 'number' && throttleMs >= 100 ? throttleMs : currentLastFmThrottleMs;
  const abortController = new AbortController();
  const jobId = randomUUID();
  const jobState = {
    id: jobId,
    username: key,
    abortController,
    aborted: false,
    throttleMs: effectiveThrottle,
    progress: null,
  };
  activeDownloads.set(key, jobState);
  logger.info('DownloadJob', `[${jobId}] Started for ${key}`, { jobId, username: key });

  (async () => {
    try {
      let existingProgress = restart ? null : await loadDownloadProgress(key);
      let localScrobbles = restart ? [] : await loadScrobbles(key);

      let startPage = 1;
      let totalPages = 1;
      let totalTracks = 0;

      const canResume = !restart && existingProgress && existingProgress.status !== 'completed' && typeof existingProgress.lastPageFetched === 'number' && existingProgress.lastPageFetched > 0;
      if (canResume) {
        startPage = existingProgress.lastPageFetched + 1;
        totalPages = existingProgress.totalPages || 1;
        totalTracks = existingProgress.totalTracks || 0;
        logger.info('DownloadJob', `[${key}] Resuming download from page ${startPage} of ${totalPages} (${localScrobbles.length} tracks already saved, throttle: ${jobState.throttleMs}ms)`);
      } else {
        logger.info('DownloadJob', `[${key}] Starting fresh download from page 1 (throttle: ${jobState.throttleMs}ms)`);
      }

      const createRetryHandler = () => (retryInfo) => {
        logger.warn('DownloadJob', `[${key}] Retry ${retryInfo.attempt}/${retryInfo.maxRetries} for page ${retryInfo.page}: ${retryInfo.error}`);
        const retryProgress = {
          ...(jobState.progress || {}),
          username: key,
          currentPage: retryInfo.page,
          isRetrying: true,
          retryAttempt: retryInfo.attempt,
          retryMax: retryInfo.maxRetries,
          retryError: retryInfo.error,
          retryWaitSeconds: Math.round(retryInfo.backoffMs / 1000),
          throttleMs: jobState.throttleMs,
          message: `Network glitch on page ${retryInfo.page}. Retrying attempt ${retryInfo.attempt} of ${retryInfo.maxRetries}...`,
          updatedAt: new Date().toISOString(),
        };
        jobState.progress = retryProgress;
        broadcastDownloadEvent(key, 'progress', retryProgress);
      };

      if (startPage === 1) {
        const initialData = await fetchLastFmPage(key, 1, 200, {
          throttleMs: jobState.throttleMs,
          abortSignal: jobState.abortController.signal,
          onRetry: createRetryHandler(),
          maxRetries: DEFAULT_MAX_RETRIES,
        });
        totalPages = parseInt(initialData?.['@attr']?.totalPages || '1', 10);
        totalTracks = parseInt(initialData?.['@attr']?.total || '0', 10);
        const page1Tracks = extractTracks(initialData);
        localScrobbles = await saveScrobbles(key, page1Tracks);
        const isComplete = totalPages <= 1;
        const progress = {
          username: key,
          status: isComplete ? 'completed' : 'in_progress',
          currentPage: 1,
          lastPageFetched: 1,
          totalPages,
          totalTracks,
          savedTracksCount: localScrobbles.length,
          percent: isComplete ? 100 : Math.min(100, Math.round((1 / totalPages) * 100)),
          throttleMs: jobState.throttleMs,
          message: isComplete ? `Download completed: ${localScrobbles.length} scrobbles saved` : `Downloaded page 1 of ${totalPages} (${localScrobbles.length} tracks saved)`,
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        jobState.progress = progress;
        await saveDownloadProgress(key, progress);
        broadcastDownloadEvent(key, isComplete ? 'complete' : 'progress', progress);
        if (isComplete) {
          activeDownloads.delete(key);
          return;
        }
        startPage = 2;
      }

      if (startPage > totalPages) {
        const progress = {
          username: key,
          status: 'completed',
          currentPage: totalPages,
          lastPageFetched: totalPages,
          totalPages,
          totalTracks,
          savedTracksCount: localScrobbles.length,
          percent: 100,
          throttleMs: jobState.throttleMs,
          message: `All ${totalPages} pages already downloaded (${localScrobbles.length} tracks saved)`,
          updatedAt: new Date().toISOString(),
        };
        jobState.progress = progress;
        await saveDownloadProgress(key, progress);
        broadcastDownloadEvent(key, 'complete', progress);
        activeDownloads.delete(key);
        return;
      }

      for (let page = startPage; page <= totalPages; page++) {
        if (jobState.aborted) {
          const pausedPage = page - 1;
          logger.info('DownloadJob', `[${key}] Download paused at page ${pausedPage}`);
          const progress = {
            username: key,
            status: 'paused',
            currentPage: pausedPage,
            lastPageFetched: pausedPage,
            totalPages,
            totalTracks,
            savedTracksCount: localScrobbles.length,
            percent: Math.min(100, Math.round((pausedPage / totalPages) * 100)),
            throttleMs: jobState.throttleMs,
            message: `Download paused at page ${pausedPage} of ${totalPages} (${localScrobbles.length} tracks saved)`,
            updatedAt: new Date().toISOString(),
          };
          jobState.progress = progress;
          await saveDownloadProgress(key, progress);
          broadcastDownloadEvent(key, 'paused', progress);
          activeDownloads.delete(key);
          return;
        }
        const pageData = await fetchLastFmPage(key, page, 200, {
          throttleMs: jobState.throttleMs,
          abortSignal: jobState.abortController.signal,
          onRetry: createRetryHandler(),
          maxRetries: DEFAULT_MAX_RETRIES,
        });
        if (pageData?.['@attr']?.totalPages) {
          totalPages = parseInt(pageData['@attr'].totalPages, 10);
        }
        if (pageData?.['@attr']?.total) {
          totalTracks = parseInt(pageData['@attr'].total, 10);
        }
        const newTracks = extractTracks(pageData);
        if (newTracks.length > 0) {
          localScrobbles = await saveScrobbles(key, [...localScrobbles, ...newTracks]);
        }
        const isComplete = page >= totalPages;
        const percent = Math.min(100, Math.round((page / totalPages) * 100));
        const progress = {
          username: key,
          status: isComplete ? 'completed' : 'in_progress',
          currentPage: page,
          lastPageFetched: page,
          totalPages,
          totalTracks,
          savedTracksCount: localScrobbles.length,
          percent,
          throttleMs: jobState.throttleMs,
          message: isComplete ? `Download completed: ${localScrobbles.length} scrobbles saved!` : `Downloaded page ${page} of ${totalPages} (${localScrobbles.length} tracks saved)`,
          updatedAt: new Date().toISOString(),
        };
        jobState.progress = progress;
        await saveDownloadProgress(key, progress);
        broadcastDownloadEvent(key, isComplete ? 'complete' : 'progress', progress);
        if (page % 5 === 0 || isComplete) {
          logger.info('DownloadJob', `[${key}] Page ${page}/${totalPages} (${percent}%) - ${localScrobbles.length} tracks on disk (throttle: ${jobState.throttleMs}ms)`);
        }
      }
      logger.info('DownloadJob', `[${key}] Full download finished. Total saved: ${localScrobbles.length}`);
      activeDownloads.delete(key);
    } catch (err) {
      const failedPage = err.page || jobState.progress?.currentPage || 1;
      logger.error('DownloadJob', `[${key}] Failed during download at page ${failedPage}: ${err.message}`, err);
      const currentProgress = jobState.progress || {};
      const errorProgress = {
        ...currentProgress,
        username: key,
        status: 'error',
        failedPage,
        error: err.message,
        errorCategory: err.category || (err.isHttpError ? 'HTTP Error' : 'Network Error'),
        errorCode: err.code || 'NETWORK_ERROR',
        errorDescription: err.description || err.message,
        throttleMs: jobState.throttleMs,
        message: `Download stopped on page ${failedPage}: ${err.description || err.message}. You can resume download where it stopped.`,
        updatedAt: new Date().toISOString(),
      };
      jobState.progress = errorProgress;
      await saveDownloadProgress(key, errorProgress);
      broadcastDownloadEvent(key, 'error', errorProgress);
      activeDownloads.delete(key);
    }
  })();

  return { started: true };
}

// API: Fetch any scrobbles newer than the latest locally stored entry.
app.post('/api/scrobbles/sync', async (req, res) => {
  const { username, throttleMs = null } = req.body || {};
  if (typeof username !== 'string' || !username.trim()) {
    return res.status(400).json({ error: 'A username is required to sync scrobbles.' });
  }

  const key = username.trim();
  const localScrobbles = await loadScrobbles(key);
  if (localScrobbles.length === 0) {
    return res.status(400).json({ error: 'No local scrobbles found. Download scrobbles first.' });
  }

  try {
    const latestStoredUts = localScrobbles.reduce(
      (latest, track) => Math.max(latest, Number(track.date?.uts || 0)),
      0,
    );
    const newTracks = [];
    const effectiveThrottle = typeof throttleMs === 'number' && throttleMs >= 100
      ? throttleMs
      : currentLastFmThrottleMs;
    let page = 1;
    let totalPages = 1;
    let reachedExistingTrack = false;

    do {
      const pageData = await fetchLastFmPage(key, page, 200, {
        throttleMs: effectiveThrottle,
        maxRetries: DEFAULT_MAX_RETRIES,
      });
      totalPages = parseInt(pageData?.['@attr']?.totalPages || '1', 10);
      for (const track of extractTracks(pageData)) {
        if (Number(track.date.uts) > latestStoredUts) {
          newTracks.push(track);
        } else {
          reachedExistingTrack = true;
          break;
        }
      }
      page += 1;
    } while (page <= totalPages && !reachedExistingTrack);

    const combined = newTracks.length > 0
      ? await saveScrobbles(key, localScrobbles.concat(newTracks))
      : localScrobbles;
    logger.info('ScrobbleSync', `[${key}] Sync finished`, {
      added: newTracks.length,
      total: combined.length,
      pagesFetched: page - 1,
    });
    return res.json({ added: newTracks.length, total: combined.length });
  } catch (err) {
    logger.error('ScrobbleSync', `[${key}] Sync failed: ${err.message}`, err);
    return res.status(502).json({
      error: err.message,
      description: err.description || err.message,
      errorCategory: err.category || 'Sync Error',
      errorCode: err.code || 'SYNC_ERROR',
    });
  }
});

// API: Download status & progress check
app.get('/api/scrobbles/status/:username', async (req, res) => {
  const key = req.params.username.toLowerCase().trim();
  const activeJob = activeDownloads.get(key);
  const progress = activeJob?.progress || await loadDownloadProgress(key);
  const localScrobbles = await loadScrobbles(key);

  const isDownloading = !!activeJob;
  const canResume = !isDownloading && progress && progress.status !== 'completed' && typeof progress.lastPageFetched === 'number' && progress.lastPageFetched > 0 && progress.lastPageFetched < (progress.totalPages || Infinity);

  res.json({
    username: key,
    isDownloading,
    canResume,
    progress: progress || { status: 'idle', lastPageFetched: 0, totalPages: 0, savedTracksCount: localScrobbles.length, percent: 0 },
    localCount: localScrobbles.length,
  });
});

// API: Real-time SSE download progress stream
app.get('/api/scrobbles/download-stream', async (req, res) => {
  const username = req.query.username;
  if (!username) {
    return res.status(400).send('Query parameter "username" is required');
  }
  const key = username.toLowerCase().trim();
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  if (!sseClients.has(key)) {
    sseClients.set(key, new Set());
  }
  sseClients.get(key).add(res);

  const activeJob = activeDownloads.get(key);
  const currentProgress = activeJob?.progress || await loadDownloadProgress(key);
  if (currentProgress) {
    sendSSE(res, currentProgress.status === 'completed' ? 'complete' : 'progress', currentProgress);
  } else {
    sendSSE(res, 'status', { status: 'idle', message: 'Ready' });
  }

  req.on('close', () => {
    const clients = sseClients.get(key);
    if (clients) {
      clients.delete(res);
      if (clients.size === 0) {
        sseClients.delete(key);
      }
    }
  });
});

// API: Get or Set Last.fm throttle speed
app.get('/api/scrobbles/throttle', (req, res) => {
  res.json({
    throttleMs: currentLastFmThrottleMs,
    reqPerSec: (1000 / currentLastFmThrottleMs).toFixed(2),
  });
});

// Keep this parameterized route after specific one-segment routes such as
// /download-stream and /throttle so it cannot intercept them.
app.get('/api/scrobbles/:username/categories', async (req, res) => {
  try {
    const username = req.params.username.trim();
    const [categories, musicBrainzClassifications] = await Promise.all([
      loadCategories(username),
      getMusicBrainzClassifications(username, req.query.artist || ''),
    ]);
    return res.json({ username, categories, musicBrainzClassifications });
  } catch (err) {
    logger.error('Categories', `Could not load local categories for ${req.params.username}: ${err.message}`, err);
    return res.status(500).json({ error: err.message });
  }
});

app.get('/api/scrobbles/:username/variants', async (req, res) => {
  try {
    return res.json({ username: req.params.username.trim(), variants: await loadVariants(req.params.username) });
  } catch (err) {
    logger.error('Variants', `Could not load saved variants for ${req.params.username}: ${err.message}`, err);
    return res.status(500).json({ error: err.message });
  }
});

app.put('/api/scrobbles/:username/variants', async (req, res) => {
  const groups = req.body?.groups;
  if (!groups || typeof groups !== 'object' || !['artists', 'albums', 'tracks'].every(key => Array.isArray(groups[key]))) {
    return res.status(400).json({ error: 'Artist, album, and track variant groups are required.' });
  }
  const decisions = req.body?.decisions || { artists: [], albums: [], tracks: [] };
  if (!decisions || typeof decisions !== 'object' || !['artists', 'albums', 'tracks'].every(key => Array.isArray(decisions[key]))) {
    return res.status(400).json({ error: 'Artist, album, and track variant decisions are required.' });
  }
  try {
    const variants = { version: 1, groups, decisions };
    await saveVariants(req.params.username, variants);
    return res.json({ username: req.params.username.trim(), variants });
  } catch (err) {
    logger.error('Variants', `Could not save variants for ${req.params.username}: ${err.message}`, err);
    return res.status(500).json({ error: err.message });
  }
});

app.get('/api/scrobbles/:username/preprocessing', async (req, res) => {
  try {
    const [config, scrobbles] = await Promise.all([loadPreprocessingRules(DATA_DIR, req.params.username), loadScrobbles(req.params.username)]);
    const candidates = detectAudiobookLayouts(scrobbles);
    return res.json({ username: req.params.username.trim(), config, candidates });
  } catch (err) {
    logger.error('Preprocessing', `Could not load preprocessing rules for ${req.params.username}: ${err.message}`, err);
    return res.status(500).json({ error: err.message });
  }
});

app.put('/api/scrobbles/:username/preprocessing', async (req, res) => {
  if (!Array.isArray(req.body?.rules) || req.body.rules.length > 1000) return res.status(400).json({ error: 'A valid preprocessing rules list is required.' });
  try {
    const config = await savePreprocessingRules(DATA_DIR, req.params.username, req.body.rules);
    return res.json({ username: req.params.username.trim(), config });
  } catch (err) {
    logger.error('Preprocessing', `Could not save preprocessing rules for ${req.params.username}: ${err.message}`, err);
    return res.status(500).json({ error: err.message });
  }
});

app.put('/api/scrobbles/:username/categories', async (req, res) => {
  const { type, artist = '', name, category, relatedTrackNames = [], relatedEntityAliases = [] } = req.body || {};
  if (!['track', 'album', 'artist'].includes(type) || typeof name !== 'string' || !name.trim() || (type !== 'artist' && (typeof artist !== 'string' || !artist.trim())) || !['music', 'audiobook', 'both', 'auto'].includes(category)) {
    return res.status(400).json({ error: 'A valid type, name, and category are required.' });
  }
  try {
    const username = req.params.username.trim();
    const categories = await loadCategories(username);
    const itemKey = `${type}\u0000${artist.trim().toLocaleLowerCase()}\u0000${name.trim().toLocaleLowerCase()}`;
    if (category === 'auto') delete categories[itemKey];
    else categories[itemKey] = category;
    if (Array.isArray(relatedEntityAliases)) {
      for (const alias of relatedEntityAliases) {
        if (typeof alias?.name !== 'string' || !alias.name.trim() || typeof alias.artist !== 'string') continue;
        const aliasKey = `${type}\u0000${alias.artist.trim().toLocaleLowerCase()}\u0000${alias.name.trim().toLocaleLowerCase()}`;
        if (category === 'auto') delete categories[aliasKey];
        else categories[aliasKey] = category;
      }
    }
    if (type === 'album' && category === 'audiobook' && Array.isArray(relatedTrackNames)) {
      for (const trackName of relatedTrackNames) {
        if (typeof trackName !== 'string' || !trackName.trim()) continue;
        const trackKey = `track\u0000${artist.trim().toLocaleLowerCase()}\u0000${trackName.trim().toLocaleLowerCase()}`;
        categories[trackKey] = 'audiobook';
      }
    }
    await saveCategories(username, categories);
    return res.json({ username, categories });
  } catch (err) {
    logger.error('Categories', `Could not save local category for ${req.params.username}: ${err.message}`, err);
    return res.status(500).json({ error: err.message });
  }
});

app.put('/api/scrobbles/:username/categories/bulk', async (req, res) => {
  const { entities, category } = req.body || {};
  const requestedEntities = Array.isArray(entities) ? entities : [];
  const typeCounts = requestedEntities.reduce((counts, entity) => {
    const type = entity?.type || 'invalid';
    counts[type] = (counts[type] || 0) + 1;
    return counts;
  }, {});
  logger.info('Categories', `Bulk category request for ${req.params.username}`, {
    category,
    entityCount: requestedEntities.length,
    typeCounts,
    sampleEntities: requestedEntities.slice(0, 25).map(entity => ({
      type: entity?.type,
      artist: entity?.artist,
      name: entity?.name,
    })),
    omittedEntityCount: Math.max(0, requestedEntities.length - 25),
  });
  if (!Array.isArray(entities) || !entities.length || entities.length > 1500 || !['music', 'audiobook', 'both', 'auto'].includes(category)) {
    return res.status(400).json({ error: 'Provide 1 to 1500 entities and a valid category.' });
  }
  if (entities.some(entity => !['track', 'album', 'artist'].includes(entity?.type)
    || typeof entity.name !== 'string' || !entity.name.trim()
    || (entity.type !== 'artist' && (typeof entity.artist !== 'string' || !entity.artist.trim())))) {
    return res.status(400).json({ error: 'Every entity must have a valid type, name, and artist where required.' });
  }
  try {
    const username = req.params.username.trim();
    const categories = await loadCategories(username);
    let changed = 0;
    for (const entity of entities) {
      const key = `${entity.type}\u0000${String(entity.artist || '').trim().toLocaleLowerCase()}\u0000${entity.name.trim().toLocaleLowerCase()}`;
      if (category === 'auto') {
        if (Object.hasOwn(categories, key)) {
          delete categories[key];
          changed++;
        }
      } else if (categories[key] !== category) {
        categories[key] = category;
        changed++;
      }
    }
    await saveCategories(username, categories);
    logger.info('Categories', `Bulk category request for ${username} applied`, {
      category,
      entityCount: entities.length,
      changed,
      unchanged: entities.length - changed,
    });
    return res.json({ username, categories, category, updated: entities.length, changed });
  } catch (err) {
    logger.error('Categories', `Could not bulk-save local categories for ${req.params.username}: ${err.message}`, err);
    return res.status(500).json({ error: err.message });
  }
});

app.get('/api/scrobbles/:username', async (req, res) => {
  const username = req.params.username.trim();
  const rawScrobbles = await loadAnalysisScrobbles(username);
  const config = await loadPreprocessingRules(DATA_DIR, username);
  const scrobbles = preprocessScrobbles(rawScrobbles, config);
  if (scrobbles.length === 0) {
    return res.json({ username, scrobbles: [] });
  }

  const firstUts = Number(scrobbles[0]?.date?.uts || 0);
  const lastUts = Number(scrobbles[scrobbles.length - 1]?.date?.uts || firstUts);
  const spanMonths = Math.ceil(Math.max(0, lastUts - firstUts) / 86400) / 30.4375;
  return res.json({
    username,
    scrobbles,
    stats: {
      totalScrobbles: scrobbles.length,
      firstScrobble: new Date(firstUts * 1000).toISOString(),
      lastScrobble: new Date(lastUts * 1000).toISOString(),
      scrobblesPerMonth: spanMonths > 0 ? (scrobbles.length / spanMonths).toFixed(2) : scrobbles.length,
    },
  });
});

app.post('/api/scrobbles/throttle', (req, res) => {
  const { throttleMs } = req.body;
  const parsed = parseInt(throttleMs, 10);
  if (isNaN(parsed) || parsed < 100) {
    return res.status(400).json({ error: 'throttleMs must be a positive integer >= 100 (ms)' });
  }
  const updated = setThrottleMs(parsed);
  // Dynamically update active jobs
  for (const [userKey, job] of activeDownloads.entries()) {
    job.throttleMs = updated;
    logger.info('DownloadJob', `[${userKey}] Dynamically adjusted active download throttle to ${updated}ms`);
  }
  res.json({ throttleMs: updated });
});

// API: Start or resume a scrobble download.
app.post('/api/scrobbles/download-all', async (req, res) => {
  const { username, restart = false, throttleMs = null } = req.body || {};
  if (typeof username !== 'string' || !username.trim()) {
    logger.warn('DownloadRequest', 'Rejected download request with missing username', {
      method: req.method,
      path: req.originalUrl,
      body: req.body,
    });
    return res.status(400).json({ error: 'A username is required to start a download.' });
  }

  const normalizedUsername = username.trim();
  logger.info('DownloadRequest', 'Received download request', {
    username: normalizedUsername,
    restart: Boolean(restart),
    throttleMs,
    method: req.method,
    path: req.originalUrl,
  });

  try {
    const result = await runDownloadJob(normalizedUsername, {
      restart: Boolean(restart),
      throttleMs: typeof throttleMs === 'number' ? throttleMs : null,
    });
    return res.json({
      message: result.alreadyRunning ? 'A download is already running for this user.' : 'Download started.',
      ...result,
    });
  } catch (err) {
    logger.error('DownloadRequest', 'Failed to start download', {
      username: normalizedUsername,
      restart: Boolean(restart),
      throttleMs,
      message: err.message,
      stack: err.stack,
    });
    return res.status(500).json({
      error: err.message || 'Failed to start download.',
      errorCategory: 'Download Initiation Error',
      errorCode: err.code || 'INIT_ERROR',
      errorDescription: err.message || 'Failed to start download.',
    });
  }
});

// API: Request a download pause after the current page finishes.
app.post('/api/scrobbles/download-cancel', (req, res) => {
  const { username } = req.body || {};
  if (typeof username !== 'string' || !username.trim()) {
    logger.warn('DownloadPause', 'Rejected pause request with missing username', {
      method: req.method,
      path: req.originalUrl,
      body: req.body,
    });
    return res.status(400).json({ error: 'A username is required to pause a download.' });
  }

  const key = username.trim().toLowerCase();
  const job = activeDownloads.get(key);
  if (!job) {
    logger.info('DownloadPause', `No active download found for ${key}`);
    return res.json({ message: 'No active download to pause.', paused: false });
  }

  // Let the current page finish so its progress can be saved before pausing.
  job.aborted = true;
  logger.info('DownloadPause', `Pause requested for ${key}`, {
    jobId: job.id,
    currentPage: job.progress?.currentPage || null,
  });
  return res.json({ message: 'Pause requested; the current page will finish first.', paused: true });
});

// API: MusicBrainz enrichment status and paginated results.
app.get('/api/musicbrainz/throttle', (req, res) => {
  return res.json(getMusicBrainzThrottle());
});

app.post('/api/musicbrainz/throttle', async (req, res) => {
  const throttleMs = Number(req.body?.throttleMs);
  try {
    return res.json(await setMusicBrainzThrottle(throttleMs));
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

app.get('/api/musicbrainz/status/:username', async (req, res) => {
  try {
    return res.json(await getMusicBrainzStatus(req.params.username));
  } catch (err) {
    logger.error('MusicBrainzAPI', `Status lookup failed for ${req.params.username}: ${err.message}`, err);
    return res.status(500).json({ error: err.message });
  }
});

app.get('/api/musicbrainz/data/:username', async (req, res) => {
  try {
    return res.json(await getMusicBrainzData(req.params.username, req.query));
  } catch (err) {
    logger.error('MusicBrainzAPI', `Data lookup failed for ${req.params.username}: ${err.message}`, err);
    return res.status(500).json({ error: err.message });
  }
});

app.get('/api/musicbrainz/entity/:username', async (req, res) => {
  const { type, name, artist = '' } = req.query;
  if (!['artist', 'album', 'track'].includes(type) || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'Entity type and name are required.' });
  }
  try {
    return res.json({ items: await getMusicBrainzEntityDetails(req.params.username, { type, name, artist }) });
  } catch (err) {
    logger.error('MusicBrainzAPI', `Entity detail lookup failed for ${req.params.username}: ${err.message}`, err);
    return res.status(500).json({ error: err.message });
  }
});

// API: Start or resume MusicBrainz enrichment.
app.post('/api/musicbrainz/start', async (req, res) => {
  const { username, restart = false, improbableOnly = false } = req.body || {};
  if (typeof username !== 'string' || !username.trim()) {
    return res.status(400).json({ error: 'A username is required to start MusicBrainz enrichment.' });
  }

  try {
    const manualCategories = await loadCategories(username.trim());
    const result = await startMusicBrainzJob(username.trim(), {
      restart: Boolean(restart),
      improbableOnly: Boolean(improbableOnly),
      manualCategories,
    });
    return res.json({
      message: result.message || (result.alreadyRunning ? 'MusicBrainz enrichment is already running.' : 'MusicBrainz enrichment started.'),
      ...result,
    });
  } catch (err) {
    logger.error('MusicBrainzAPI', `Could not start enrichment for ${username.trim()}: ${err.message}`, err);
    return res.status(400).json({ error: err.message });
  }
});

// API: Pause active MusicBrainz enrichment.
app.post('/api/musicbrainz/pause', (req, res) => {
  const { username } = req.body || {};
  if (typeof username !== 'string' || !username.trim()) {
    return res.status(400).json({ error: 'A username is required to pause MusicBrainz enrichment.' });
  }
  return res.json(pauseMusicBrainzJob(username.trim()));
});

// API: MusicBrainz job event stream.
app.get('/api/musicbrainz/stream', async (req, res) => {
  const username = typeof req.query.username === 'string' ? req.query.username.trim() : '';
  if (!username) {
    return res.status(400).json({ error: 'Query parameter "username" is required.' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  registerMbSseClient(username, res);

  try {
    const status = await getMusicBrainzStatus(username);
    sendSSE(res, 'mb-status', { progress: status.progress, status: status.status });
  } catch (err) {
    logger.error('MusicBrainzAPI', `Could not initialize event stream for ${username}: ${err.message}`, err);
    sendSSE(res, 'mb-error', { error: err.message });
  }

  req.on('close', () => removeMbSseClient(username, res));
});
