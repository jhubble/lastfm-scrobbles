import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.LASTFM_API_KEY;
const BASE_URL = 'http://ws.audioscrobbler.com/2.0/';
const DATA_DIR = path.join(__dirname, 'data');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Ensure data directory exists
await fs.mkdir(DATA_DIR, { recursive: true });

const getDataFilePath = (username) => path.join(DATA_DIR, `${username.toLowerCase().trim()}_scrobbles.json`);

// Read scrobbles from file
async function loadScrobbles(username) {
  try {
    const data = await fs.readFile(getDataFilePath(username), 'utf-8');
    return JSON.parse(data);
  } catch (err) {
    return [];
  }
}

// Save scrobbles to file sorted chronologically and deduplicated
async function saveScrobbles(username, scrobbles) {
  const uniqueMap = new Map();
  for (const track of scrobbles) {
    if (track.date && track.date.uts) {
      const key = `${track.artist['#text']}_${track.name}_${track.date.uts}`;
      uniqueMap.set(key, track);
    }
  }
  const cleanList = Array.from(uniqueMap.values());
  cleanList.sort((a, b) => Number(a.date.uts) - Number(b.date.uts));

  await fs.writeFile(getDataFilePath(username), JSON.stringify(cleanList, null, 2));
  return cleanList;
}

// Fetch single page from Last.fm
async function fetchLastFmPage(username, page = 1, limit = 200) {
  if (!API_KEY || API_KEY === 'YOUR_LASTFM_API_KEY_HERE') {
    throw new Error('Missing or unconfigured LASTFM_API_KEY in .env file');
  }
  const url = `${BASE_URL}?method=user.getRecentTracks&user=${encodeURIComponent(username)}&api_key=${API_KEY}&format=json&page=${page}&limit=${limit}`;
  const res = await fetch(url);
  const data = await res.json();

  if (data.error) throw new Error(data.message);
  return data.recenttracks;
}

// API: Download ALL scrobbles
app.post('/api/scrobbles/download-all', async (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'Username is required' });

  try {
    const initialData = await fetchLastFmPage(username, 1, 200);
    const totalPages = parseInt(initialData['@attr'].totalPages, 10);
    let allTracks = initialData.track.filter(t => t.date && t.date.uts);

    for (let page = 2; page <= totalPages; page++) {
      const pageData = await fetchLastFmPage(username, page, 200);
      if (pageData && pageData.track) {
        allTracks.push(...pageData.track.filter(t => t.date && t.date.uts));
      }
      await new Promise(r => setTimeout(r, 200)); // Rate limit buffer
    }

    const saved = await saveScrobbles(username, allTracks);
    res.json({ message: 'Full download completed', count: saved.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: Sync NEWER scrobbles
app.post('/api/scrobbles/sync', async (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'Username is required' });

  try {
    const local = await loadScrobbles(username);
    if (local.length === 0) {
      return res.status(400).json({ error: 'No local history found. Perform a full download first.' });
    }

    const latestUts = Math.max(...local.map(s => Number(s.date.uts)));
    let page = 1;
    let newTracks = [];
    let done = false;

    while (!done) {
      const pageData = await fetchLastFmPage(username, page, 200);
      if (!pageData || !pageData.track || pageData.track.length === 0) break;

      for (const track of pageData.track) {
        if (!track.date || !track.date.uts) continue;
        const trackUts = Number(track.date.uts);

        if (trackUts > latestUts) {
          newTracks.push(track);
        } else {
          done = true;
          break;
        }
      }

      if (page >= parseInt(pageData['@attr'].totalPages, 10) || done) break;
      page++;
      await new Promise(r => setTimeout(r, 200));
    }

    const updated = await saveScrobbles(username, [...local, ...newTracks]);
    res.json({ message: 'Sync complete', added: newTracks.length, total: updated.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: Get Local Scrobbles & Computed Stats
app.get('/api/scrobbles/:username', async (req, res) => {
  try {
    const scrobbles = await loadScrobbles(req.params.username);
    if (scrobbles.length === 0) {
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

    res.json({
      scrobbles,
      stats: {
        totalScrobbles,
        firstScrobble: firstDate.toISOString(),
        lastScrobble: lastDate.toISOString(),
        scrobblesPerMonth: parseFloat(perMonth),
        monthlyBreakdown: monthlyMap
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
