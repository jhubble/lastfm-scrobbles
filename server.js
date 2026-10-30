import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import {
  initMusicBrainz,
  getMusicBrainzStatus,
  getMusicBrainzData,
  startMusicBrainzJob,
  pauseMusicBrainzJob,
  registerMbSseClient,
  removeMbSseClient,
} from './musicbrainz.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Logging Helper ---
function formatLog(level, category, message, meta) {
  const timestamp = new Date().toISOString();
  let metaStr = '';
  if (meta !== undefined) {
    if (meta instanceof Error) {
      metaStr = ` | ${meta.stack || meta.message}`;
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
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.LASTFM_API_KEY;
const BASE_URL = 'http://ws.audioscrobbler.com/2.0/';
const DATA_DIR = path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');

// --- Active Download State & SSE Management ---
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
    // Keep SSE connections from flooding request finished logs while streaming
    const logLevel = statusCode >= 500 ? 'error' : statusCode >= 400 ? 'warn' : 'info';
    logger[logLevel]('HTTP', `${method} ${originalUrl} ${statusCode} - ${duration}ms`);
  });

  next();
});

app.use(express.json());
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
  initMusicBrainz({ dataDir: DATA_DIR, logger });
  logger.info('Storage', `Data directory initialized at ${DATA_DIR}`);
} catch (err) {
  logger.error('Storage', `Failed to initialize data directory: ${err.message}`, err);
}

const getDataFilePath = (username) => path.join(DATA_DIR, `${username.toLowerCase().trim()}_scrobbles.json`);
const getProgressFilePath = (username) => path.join(DATA_DIR, `${username.toLowerCase().trim()}_download_progress.json`);

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
    } else {
      logger.warn('Storage', `Failed reading scrobbles file for user "${username}": ${err.message}`);
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
  return cleanList;
}

// Read download progress metadata
async function loadDownloadProgress(username) {
  const filePath = getProgressFilePath(username);
  try {
    const data = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(data);
  } catch (err) {
    return null;
  }
}

// Save download progress metadata
async function saveDownloadProgress(username, progress) {
  const filePath = getProgressFilePath(username);
  await fs.writeFile(filePath, JSON.stringify(progress, null, 2));
}

// Fetch single page from Last.fm
async function fetchLastFmPage(username, page = 1, limit = 200) {
  if (!API_KEY || API_KEY === 'YOUR_LASTFM_API_KEY_HERE') {
    logger.error('LastFM', 'API key missing or unconfigured in .env');
    throw new Error('Missing or unconfigured LASTFM_API_KEY in .env file');
  }

  const url = `${BASE_URL}?method=user.getRecentTracks&user=${encodeURIComponent(username)}&api_key=${API_KEY}&format=json&page=${page}&limit=${limit}`;
  const startTime = Date.now();
  logger.debug('LastFM', `Fetching page ${page} (limit ${limit}) for user "${username}"`);

  let res;
  try {
    res = await fetch(url);
  } catch (err) {
    logger.error('LastFM', `Network error fetching page ${page} for "${username}": ${err.message}`, err);
    throw new Error(`Network error calling Last.fm: ${err.message}`);
  }

  const duration = Date.now() - startTime;
  if (!res.ok) {
    logger.warn('LastFM', `Last.fm returned HTTP ${res.status} (${duration}ms) for page ${page}`);
  }

  const data = await res.json();
  if (data.error) {
    logger.error('LastFM', `API error for user "${username}" on page ${page}: [Code ${data.error}] ${data.message}`);
    throw new Error(data.message);
  }

  logger.debug('LastFM', `Received page ${page} in ${duration}ms`);
  return data.recenttracks;
}

// Helper to normalize tracks array from Last.fm API response
function extractTracks(recenttracks) {
  if (!recenttracks || !recenttracks.track) return [];
  const raw = Array.isArray(recenttracks.track) ? recenttracks.track : [recenttracks.track];
  return raw.filter(t => t && t.date && t.date.uts);
}

// --- Download Job Runner with Incremental Writes and Resume Support ---
async function runDownloadJob(username, { restart = false } = {}) {
  const key = username.toLowerCase().trim();

  if (activeDownloads.has(key)) {
    logger.warn('DownloadJob', `Download already in progress for "${key}"`);
    return { alreadyRunning: true };
  }

  const abortController = new AbortController();
  const jobState = {
    abortController,
    aborted: false,
    progress: null,
  };
  activeDownloads.set(key, jobState);

  // Execute asynchronously in background
  (async () => {
    try {
      let existingProgress = restart ? null : await loadDownloadProgress(key);
      let localScrobbles = restart ? [] : await loadScrobbles(key);

      let startPage = 1;
      let totalPages = 1;
      let totalTracks = 0;

      const canResume = !restart &&
        existingProgress &&
        existingProgress.status !== 'completed' &&
        typeof existingProgress.lastPageFetched === 'number' &&
        existingProgress.lastPageFetched > 0;

      if (canResume) {
        startPage = existingProgress.lastPageFetched + 1;
        totalPages = existingProgress.totalPages || 1;
        totalTracks = existingProgress.totalTracks || 0;
        logger.info('DownloadJob', `[${key}] Resuming download from page ${startPage} of ${totalPages} (${localScrobbles.length} tracks already saved)`);
      } else {
        logger.info('DownloadJob', `[${key}] Starting fresh download from page 1`);
      }

      // If starting fresh or starting at page 1, fetch page 1 to establish totalPages and totalTracks
      if (startPage === 1) {
        const initialData = await fetchLastFmPage(key, 1, 200);
        totalPages = parseInt(initialData?.['@attr']?.totalPages || '1', 10);
        totalTracks = parseInt(initialData?.['@attr']?.total || '0', 10);

        const page1Tracks = extractTracks(initialData);
        // Incremental save of page 1 to disk
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
          message: isComplete
            ? `Download completed: ${localScrobbles.length} scrobbles saved`
            : `Downloaded page 1 of ${totalPages} (${localScrobbles.length} tracks saved)`,
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

      // If resuming and all pages were already fetched
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
          message: `All ${totalPages} pages already downloaded (${localScrobbles.length} tracks saved)`,
          updatedAt: new Date().toISOString(),
        };
        jobState.progress = progress;
        await saveDownloadProgress(key, progress);
        broadcastDownloadEvent(key, 'complete', progress);
        activeDownloads.delete(key);
        return;
      }

      // Fetch subsequent pages with incremental write after each page
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
            message: `Download paused at page ${pausedPage} of ${totalPages} (${localScrobbles.length} tracks saved)`,
            updatedAt: new Date().toISOString(),
          };
          jobState.progress = progress;
          await saveDownloadProgress(key, progress);
          broadcastDownloadEvent(key, 'paused', progress);
          activeDownloads.delete(key);
          return;
        }

        const pageData = await fetchLastFmPage(key, page, 200);

        if (pageData?.['@attr']?.totalPages) {
          totalPages = parseInt(pageData['@attr'].totalPages, 10);
        }
        if (pageData?.['@attr']?.total) {
          totalTracks = parseInt(pageData['@attr'].total, 10);
        }

        const newTracks = extractTracks(pageData);
        if (newTracks.length > 0) {
          // Incrementally update and save scrobbles to disk
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
          message: isComplete
            ? `Download completed: ${localScrobbles.length} scrobbles saved!`
            : `Downloaded page ${page} of ${totalPages} (${localScrobbles.length} tracks saved)`,
          updatedAt: new Date().toISOString(),
        };

        jobState.progress = progress;
        // Incrementally save progress state to disk
        await saveDownloadProgress(key, progress);
        broadcastDownloadEvent(key, isComplete ? 'complete' : 'progress', progress);

        if (page % 5 === 0 || isComplete) {
          logger.info('DownloadJob', `[${key}] Page ${page}/${totalPages} (${percent}%) - ${localScrobbles.length} tracks on disk`);
        }

        if (!isComplete) {
          await new Promise(r => setTimeout(r, 200)); // Rate limit buffer
        }
      }

      logger.info('DownloadJob', `[${key}] Full download finished. Total saved: ${localScrobbles.length}`);
      activeDownloads.delete(key);
    } catch (err) {
      logger.error('DownloadJob', `[${key}] Failed during download: ${err.message}`, err);
      const currentProgress = jobState.progress || {};
      const errorProgress = {
        ...currentProgress,
        username: key,
        status: 'error',
        error: err.message,
        message: `Download error: ${err.message}. You can resume download where it stopped.`,
        updatedAt: new Date().toISOString(),
      };
      await saveDownloadProgress(key, errorProgress);
      broadcastDownloadEvent(key, 'error', errorProgress);
      activeDownloads.delete(key);
    }
  })();

  return { started: true };
}

// API: Download status & progress check
app.get('/api/scrobbles/status/:username', async (req, res) => {
  const key = req.params.username.toLowerCase().trim();
  const activeJob = activeDownloads.get(key);
  const progress = activeJob?.progress || await loadDownloadProgress(key);
  const localScrobbles = await loadScrobbles(key);

  const isDownloading = !!activeJob;
  const canResume = !isDownloading &&
    progress &&
    progress.status !== 'completed' &&
    typeof progress.lastPageFetched === 'number' &&
    progress.lastPageFetched > 0 &&
    progress.lastPageFetched < (progress.totalPages || Infinity);

  res.json({
    username: key,
    isDownloading,
    canResume,
    progress: progress || {
      status: 'idle',
      lastPageFetched: 0,
      totalPages: 0,
      savedTracksCount: localScrobbles.length,
      percent: 0,
    },
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

  // Send initial status event on connection
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

// API: Download ALL scrobbles (supports resume or restart)
app.post('/api/scrobbles/download-all', async (req, res) => {
  const { username, restart = false } = req.body;
  if (!username) {
    logger.warn('DownloadAll', 'Rejected request: missing username');
    return res.status(400).json({ error: 'Username is required' });
  }

  const trimmedUsername = username.trim();
  const key = trimmedUsername.toLowerCase();

  const activeJob = activeDownloads.get(key);
  if (activeJob) {
    return res.json({
      message: 'Download already in progress',
      inProgress: true,
      progress: activeJob.progress,
    });
  }

  const existingProgress = restart ? null : await loadDownloadProgress(key);
  const isResuming = !restart &&
    existingProgress &&
    existingProgress.status !== 'completed' &&
    existingProgress.lastPageFetched > 0;

  await runDownloadJob(trimmedUsername, { restart: !!restart });

  res.json({
    message: isResuming
      ? `Resuming download from page ${existingProgress.lastPageFetched + 1}`
      : 'Download started',
    started: true,
    resuming: isResuming,
  });
});

// API: Pause / cancel an active download
app.post('/api/scrobbles/download-cancel', async (req, res) => {
  const { username } = req.body;
  if (!username) {
    return res.status(400).json({ error: 'Username is required' });
  }

  const key = username.toLowerCase().trim();
  const activeJob = activeDownloads.get(key);

  if (!activeJob) {
    return res.json({ message: 'No active download running for this user' });
  }

  activeJob.aborted = true;
  activeJob.abortController.abort();
  logger.info('DownloadJob', `[${key}] User requested download pause/cancel`);
  res.json({ message: 'Download pause requested' });
});

// API: Sync NEWER scrobbles
app.post('/api/scrobbles/sync', async (req, res, next) => {
  const { username } = req.body;
  if (!username) {
    logger.warn('Sync', 'Rejected request: missing username');
    return res.status(400).json({ error: 'Username is required' });
  }

  const trimmedUsername = username.trim();
  logger.info('Sync', `Starting sync for user: "${trimmedUsername}"`);

  try {
    const local = await loadScrobbles(trimmedUsername);
    if (local.length === 0) {
      logger.warn('Sync', `Sync failed for "${trimmedUsername}": no local history found`);
      return res.status(400).json({ error: 'No local history found. Perform a full download first.' });
    }

    const latestUts = Math.max(...local.map(s => Number(s.date.uts)));
    logger.info('Sync', `[${trimmedUsername}] Local latest scrobble: ${new Date(latestUts * 1000).toISOString()}`);

    let page = 1;
    let newTracks = [];
    let done = false;

    while (!done) {
      logger.debug('Sync', `[${trimmedUsername}] Fetching page ${page} to check for newer scrobbles`);
      const pageData = await fetchLastFmPage(trimmedUsername, page, 200);
      const pageTracks = extractTracks(pageData);

      if (pageTracks.length === 0) {
        logger.debug('Sync', `[${trimmedUsername}] No tracks returned on page ${page}; ending sync`);
        break;
      }

      for (const track of pageTracks) {
        const trackUts = Number(track.date.uts);
        if (trackUts > latestUts) {
          newTracks.push(track);
        } else {
          done = true;
          break;
        }
      }

      const totalPages = parseInt(pageData?.['@attr']?.totalPages || '1', 10);
      if (page >= totalPages || done) {
        break;
      }

      page++;
      await new Promise(r => setTimeout(r, 200));
    }

    logger.info('Sync', `[${trimmedUsername}] Sync complete. Found ${newTracks.length} new scrobbles.`);
    const updated = await saveScrobbles(trimmedUsername, [...local, ...newTracks]);
    res.json({ message: 'Sync complete', added: newTracks.length, total: updated.length });
  } catch (err) {
    logger.error('Sync', `Sync failed for "${trimmedUsername}": ${err.message}`, err);
    res.status(500).json({ error: err.message });
  }
});

// API: Get Local Scrobbles & Computed Stats
app.get('/api/scrobbles/:username', async (req, res, next) => {
  const username = req.params.username.trim();
  logger.info('Stats', `Fetching stats and local scrobbles for user: "${username}"`);

  try {
    const scrobbles = await loadScrobbles(username);
    if (scrobbles.length === 0) {
      logger.info('Stats', `No local scrobbles found for user "${username}"`);
      return res.json({ scrobbles: [], stats: null });
    }

    const totalScrobbles = scrobbles.length;
    const firstDate = new Date(Number(scrobbles[0].date.uts) * 1000);
    const lastDate = new Date(Number(scrobbles[scrobbles.length - 1].date.uts) * 1000);

    const diffDays = Math.max(1, Math.ceil((lastDate - firstDate) / (1000 * 60 * 60 * 24)));
    const diffMonths = diffDays / 30.4375;
    const perMonth = diffMonths > 0 ? (totalScrobbles / diffMonths).toFixed(1) : totalScrobbles;

    // Monthly breakdown map
    const monthlyMap = {};
    scrobbles.forEach(s => {
      const d = new Date(Number(s.date.uts) * 1000);
      const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      monthlyMap[ym] = (monthlyMap[ym] || 0) + 1;
    });

    logger.info('Stats', `Calculated stats for "${username}": ${totalScrobbles} tracks, ~${perMonth}/mo from ${firstDate.toISOString().slice(0, 10)} to ${lastDate.toISOString().slice(0, 10)}`);

    res.json({
      scrobbles,
      stats: {
        totalScrobbles,
        firstScrobble: firstDate.toISOString(),
        lastScrobble: lastDate.toISOString(),
        scrobblesPerMonth: parseFloat(perMonth),
        monthlyBreakdown: monthlyMap,
      },
    });
  } catch (err) {
    logger.error('Stats', `Failed computing stats for "${username}": ${err.message}`, err);
    res.status(500).json({ error: err.message });
  }
});

// --- MusicBrainz Enrichment API Routes ---

// API: MusicBrainz Status & Summary Stats
app.get('/api/musicbrainz/status/:username', async (req, res, next) => {
  const username = req.params.username?.trim();
  if (!username) {
    return res.status(400).json({ error: 'Username is required' });
  }

  try {
    const statusData = await getMusicBrainzStatus(username);
    res.json(statusData);
  } catch (err) {
    logger.error('MusicBrainz', `Failed fetching status for "${username}": ${err.message}`, err);
    res.status(500).json({ error: err.message });
  }
});

// API: MusicBrainz Real-time SSE Progress Stream
app.get('/api/musicbrainz/stream', async (req, res) => {
  const username = req.query.username;
  if (!username) {
    return res.status(400).send('Query parameter "username" is required');
  }

  const key = username.toLowerCase().trim();

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  registerMbSseClient(key, res);

  try {
    const currentStatus = await getMusicBrainzStatus(key);
    res.write(`event: mb-status\ndata: ${JSON.stringify(currentStatus)}\n\n`);
  } catch (err) {
    logger.warn('MusicBrainzSSE', `Error sending initial SSE status: ${err.message}`);
  }

  req.on('close', () => {
    removeMbSseClient(key, res);
  });
});

// API: MusicBrainz Paginated & Filtered Data
app.get('/api/musicbrainz/data/:username', async (req, res, next) => {
  const username = req.params.username?.trim();
  if (!username) {
    return res.status(400).json({ error: 'Username is required' });
  }

  try {
    const data = await getMusicBrainzData(username, req.query);
    res.json(data);
  } catch (err) {
    logger.error('MusicBrainz', `Failed fetching MB data for "${username}": ${err.message}`, err);
    res.status(500).json({ error: err.message });
  }
});

// API: Start or Resume MusicBrainz Lookup Job
app.post('/api/musicbrainz/start', async (req, res, next) => {
  const { username, restart = false } = req.body;
  if (!username) {
    return res.status(400).json({ error: 'Username is required' });
  }

  try {
    const result = await startMusicBrainzJob(username, { restart });
    res.json({
      message: result.alreadyRunning
        ? 'MusicBrainz lookup is already running'
        : 'MusicBrainz enrichment started',
      ...result,
    });
  } catch (err) {
    logger.error('MusicBrainz', `Failed starting MB job for "${username}": ${err.message}`, err);
    res.status(500).json({ error: err.message });
  }
});

// API: Pause MusicBrainz Lookup Job
app.post('/api/musicbrainz/pause', async (req, res, next) => {
  const { username } = req.body;
  if (!username) {
    return res.status(400).json({ error: 'Username is required' });
  }

  try {
    const result = pauseMusicBrainzJob(username);
    res.json(result);
  } catch (err) {
    logger.error('MusicBrainz', `Failed pausing MB job for "${username}": ${err.message}`, err);
    res.status(500).json({ error: err.message });
  }
});

// 404 Handler for undefined routes
app.use((req, res) => {
  logger.warn('Router', `404 Not Found: ${req.method} ${req.originalUrl}`);
  res.status(404).json({ error: `Route not found: ${req.method} ${req.originalUrl}` });
});

// Centralized error-handling middleware
app.use((err, req, res, next) => {
  logger.error('Unhandled', `Internal error processing ${req.method} ${req.originalUrl}: ${err.message}`, err);
  res.status(500).json({ error: 'Internal server error', details: err.message });
});

app.listen(PORT, () => {
  logger.info('Server', `==============================================`);
  logger.info('Server', `Last.fm Scrobble Manager backend running`);
  logger.info('Server', `Local address:    http://localhost:${PORT}`);
  logger.info('Server', `Data directory:   ${DATA_DIR}`);
  logger.info('Server', `Public directory: ${PUBLIC_DIR}`);
  logger.info('Server', `Last.fm API Key:  ${API_KEY ? 'Configured (' + API_KEY.slice(0, 4) + '...' + API_KEY.slice(-4) + ')' : 'NOT SET'}`);
  logger.info('Server', `==============================================`);
});
