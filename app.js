import fs from 'fs';
import readline from 'readline';
import dotenv from 'dotenv';

dotenv.config();

// --- CONFIGURATION ---
// Get your free Last.fm API key from: https://www.last.fm/api/account/create
const API_KEY = process.env.LASTFM_API_KEY || 'YOUR_LASTFM_API_KEY_HERE';
const BASE_URL = 'http://ws.audioscrobbler.com/2.0/';

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const question = (query) => new Promise((resolve) => rl.question(query, resolve));

// Helper: Delay to respect API rate limits
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Throttling state: default to 1000ms (1 req/sec) or configured LASTFM_THROTTLE_MS
const THROTTLE_MS = Math.max(100, parseInt(process.env.LASTFM_THROTTLE_MS || '1000', 10));
let lastRequestTime = 0;

async function waitForThrottle(ms = THROTTLE_MS) {
    const now = Date.now();
    const elapsed = now - lastRequestTime;
    if (elapsed < ms) {
        await sleep(ms - elapsed);
    }
    lastRequestTime = Date.now();
}

// Extract specific network error diagnostics from error chain
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

    let friendly = 'Network Connection Error';
    if (lower.includes('etimedout') || lower.includes('und_err_connect_timeout') || lower.includes('timeout')) {
        friendly = 'Connection Timeout (Last.fm took too long to respond)';
    } else if (lower.includes('econnreset') || lower.includes('socket hung up')) {
        friendly = 'Connection Reset (connection was abruptly dropped by Last.fm)';
    } else if (lower.includes('econnrefused')) {
        friendly = 'Connection Refused (Last.fm rejected connection)';
    } else if (lower.includes('enotfound') || lower.includes('eai_again')) {
        friendly = 'DNS Lookup Failed (check internet connection)';
    }

    return `${friendly}${codeStr ? ` [Code: ${codeStr}]` : ''}${rawMsg ? ` - ${rawMsg}` : ''}`;
}

// Helper: Get filename for user data
const getFilename = (username) => `${username.toLowerCase()}_scrobbles.json`;
const getProgressFilename = (username) => `${username.toLowerCase()}_download_progress.json`;

const loadProgressData = (username) => {
    const filename = getProgressFilename(username);
    if (fs.existsSync(filename)) {
        try {
            return JSON.parse(fs.readFileSync(filename, 'utf8'));
        } catch (err) {
            return null;
        }
    }
    return null;
};

const saveProgressData = (username, progress) => {
    const filename = getProgressFilename(username);
    fs.writeFileSync(filename, JSON.stringify(progress, null, 2));
};

// Load local scrobbles if they exist
const loadLocalData = (username) => {
    const filename = getFilename(username);
    if (fs.existsSync(filename)) {
        try {
            const data = fs.readFileSync(filename, 'utf8');
            return JSON.parse(data);
        } catch (err) {
            console.error('Error reading local data file:', err.message);
        }
    }
    return [];
};

// Save scrobbles to local file (sorted by timestamp ascending)
const saveLocalData = (username, scrobbles) => {
    // Sort chronologically (oldest to newest)
    scrobbles.sort((a, b) => Number(a.date.uts) - Number(b.date.uts));
    // Remove duplicates based on artist + track name + timestamp (uts)
    const uniqueScrobbles = Array.from(
        new Map(scrobbles.map(s => [`${s.artist['#text']}_${s.name}_${s.date.uts}`, s])).values()
    );
    
    const filename = getFilename(username);
    fs.writeFileSync(filename, JSON.stringify(uniqueScrobbles, null, 2));
    console.log(`Saved ${uniqueScrobbles.length} scrobbles to ${filename}`);
};

// Fetch a single page from Last.fm API with throttling, timeout, and network diagnostics
const fetchPage = async (username, page, limit = 200, maxRetries = 3) => {
    const url = `${BASE_URL}?method=user.getRecentTracks&user=${encodeURIComponent(username)}&api_key=${API_KEY}&format=json&page=${page}&limit=${limit}`;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        await waitForThrottle();

        const startTime = Date.now();
        let response;
        try {
            response = await fetch(url, { signal: AbortSignal.timeout ? AbortSignal.timeout(30000) : undefined });
        } catch (err) {
            const diag = extractNetworkErrorDetails(err);
            const duration = Date.now() - startTime;
            if (attempt < maxRetries) {
                const waitMs = Math.min(10000, 2000 * Math.pow(1.5, attempt));
                console.warn(`\n[WARN] Network error on page ${page} (${duration}ms): ${diag}. Retrying attempt ${attempt + 1}/${maxRetries} in ${(waitMs / 1000).toFixed(1)}s...`);
                await sleep(waitMs);
                continue;
            }
            console.error(`\n[ERROR] Network failure fetching page ${page} after ${attempt + 1} attempts (${duration}ms): ${diag}`);
            return null;
        }

        const duration = Date.now() - startTime;
        let bodyText = '';
        let data = null;

        try {
            bodyText = await response.text();
            if (bodyText.trim().startsWith('{')) {
                data = JSON.parse(bodyText);
            }
        } catch (parseErr) {
            console.warn(`\n[WARN] Could not parse JSON response on page ${page} (HTTP ${response.status})`);
        }

        if (!response.ok) {
            const isTransient = response.status === 429 || response.status === 502 || response.status === 503 || response.status === 504;
            const msg = data?.message || (bodyText.length > 120 ? bodyText.slice(0, 120) : bodyText);
            if (isTransient && attempt < maxRetries) {
                const waitMs = 2000 * (attempt + 1);
                console.warn(`\n[WARN] HTTP ${response.status} on page ${page} (${msg || 'server busy'}). Retrying in ${(waitMs / 1000).toFixed(1)}s...`);
                await sleep(waitMs);
                continue;
            }
            console.error(`\n[ERROR] Last.fm returned HTTP ${response.status} on page ${page}: ${msg}`);
            return null;
        }

        if (data && data.error) {
            console.error(`\n[ERROR] Last.fm API error on page ${page} [Code ${data.error}]: ${data.message}`);
            return null;
        }

        if (!data || !data.recenttracks) {
            console.error(`\n[ERROR] Unexpected response format on page ${page}`);
            return null;
        }

        return data.recenttracks;
    }

    return null;
};

// --- FUNCTION 1: Download ALL scrobbles (with incremental saves and resume) ---
async function downloadAllScrobbles(username) {
    console.log(`\nChecking download status for user: ${username}...`);
    
    let existingProgress = loadProgressData(username);
    let localScrobbles = loadLocalData(username);
    let startPage = 1;
    let totalPages = 1;
    let totalTracks = 0;

    const canResume = existingProgress &&
        existingProgress.status !== 'completed' &&
        existingProgress.lastPageFetched > 0;

    if (canResume) {
        const ans = await question(`Found partially completed download at page ${existingProgress.lastPageFetched} of ${existingProgress.totalPages} (${localScrobbles.length} tracks saved). Resume? (Y/n): `);
        if (ans.trim().toLowerCase() !== 'n') {
            startPage = existingProgress.lastPageFetched + 1;
            totalPages = existingProgress.totalPages || 1;
            totalTracks = existingProgress.totalTracks || 0;
            console.log(`Resuming download from page ${startPage} of ${totalPages}...`);
        } else {
            console.log('Restarting download from page 1...');
            localScrobbles = [];
            startPage = 1;
        }
    }

    if (startPage === 1) {
        // Fetch page 1 to get total pages and total tracks count
        const initialData = await fetchPage(username, 1, 200);
        if (!initialData) return;

        totalPages = parseInt(initialData['@attr']?.totalPages || '1', 10);
        totalTracks = parseInt(initialData['@attr']?.total || '0', 10);

        console.log(`Found ${totalTracks} total scrobbles across ${totalPages} pages.`);

        const raw = Array.isArray(initialData.track) ? initialData.track : (initialData.track ? [initialData.track] : []);
        const page1Tracks = raw.filter(t => t && t.date && t.date.uts);
        localScrobbles = page1Tracks;

        // Incremental save of page 1
        saveLocalData(username, localScrobbles);
        saveProgressData(username, {
            username,
            status: totalPages <= 1 ? 'completed' : 'in_progress',
            lastPageFetched: 1,
            totalPages,
            totalTracks,
            savedTracksCount: localScrobbles.length,
            updatedAt: new Date().toISOString()
        });

        if (totalPages <= 1) {
            console.log(`\nDownload complete! Total valid scrobbles fetched: ${localScrobbles.length}`);
            return;
        }

        startPage = 2;
    }

    for (let page = startPage; page <= totalPages; page++) {
        process.stdout.write(`Downloading page ${page} of ${totalPages}...\r`);
        const pageData = await fetchPage(username, page, 200);
        if (pageData && pageData.track) {
            const raw = Array.isArray(pageData.track) ? pageData.track : [pageData.track];
            const validTracks = raw.filter(t => t && t.date && t.date.uts);
            if (validTracks.length > 0) {
                localScrobbles.push(...validTracks);
                // Incremental save to disk after every page
                saveLocalData(username, localScrobbles);
            }
        }

        const isComplete = page >= totalPages;
        saveProgressData(username, {
            username,
            status: isComplete ? 'completed' : 'in_progress',
            lastPageFetched: page,
            totalPages,
            totalTracks,
            savedTracksCount: localScrobbles.length,
            updatedAt: new Date().toISOString()
        });

        // Throttled delay to respect Last.fm rate limits
        await waitForThrottle();
    }

    console.log(`\nDownload complete! Total valid scrobbles fetched: ${localScrobbles.length}`);
}

// --- FUNCTION 2: Fetch NEWER scrobbles ---
async function fetchNewerScrobbles(username) {
    let localScrobbles = loadLocalData(username);
    if (localScrobbles.length === 0) {
        console.log('No local data found. Please run option 1 (Download all scrobbles) first.');
        return;
    }

    // Find the latest timestamp stored locally
    const latestStoredUts = Math.max(...localScrobbles.map(s => Number(s.date.uts)));
    console.log(`\nLatest local scrobble date: ${new Date(latestStoredUts * 1000).toLocaleString()}`);
    console.log('Checking for newer scrobbles...');

    let page = 1;
    let newTracksFound = [];
    let stopFetching = false;

    while (!stopFetching) {
        const pageData = await fetchPage(username, page, 200);
        if (!pageData || !pageData.track || pageData.track.length === 0) break;

        const totalPages = parseInt(pageData['@attr'].totalPages, 10);

        for (const track of pageData.track) {
            // Skip currently playing track
            if (!track.date || !track.date.uts) continue;

            const trackUts = Number(track.date.uts);
            if (trackUts > latestStoredUts) {
                newTracksFound.push(track);
            } else {
                stopFetching = true;
                break;
            }
        }

        if (page >= totalPages || stopFetching) {
            break;
        }

        page++;
        await waitForThrottle();
    }

    if (newTracksFound.length > 0) {
        console.log(`Found ${newTracksFound.length} new scrobbles! Updating local database...`);
        const combined = [...localScrobbles, ...newTracksFound];
        saveLocalData(username, combined);
    } else {
        console.log('Your local database is already up to date!');
    }
}

// --- FUNCTION 3: Show Overall Stats ---
function showOverallStats(username) {
    const scrobbles = loadLocalData(username);
    if (scrobbles.length === 0) {
        console.log('No local data found for this user. Download scrobbles first.');
        return;
    }

    const totalScrobbles = scrobbles.length;
    const firstScrobbleUts = Number(scrobbles[0].date.uts);
    const lastScrobbleUts = Number(scrobbles[scrobbles.length - 1].date.uts);

    const firstDate = new Date(firstScrobbleUts * 1000);
    const lastDate = new Date(lastScrobbleUts * 1000);

    // Calculate span in months
    const diffTime = Math.abs(lastDate - firstDate);
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    const diffMonths = diffDays / 30.4375; // Average month length

    const scrobblesPerMonth = diffMonths > 0 ? (totalScrobbles / diffMonths).toFixed(2) : totalScrobbles;

    // Breakdown per month (YYYY-MM)
    const monthlyBreakdown = {};
    scrobbles.forEach(s => {
        const date = new Date(Number(s.date.uts) * 1000);
        const yearMonth = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
        monthlyBreakdown[yearMonth] = (monthlyBreakdown[yearMonth] || 0) + 1;
    });

    console.log('\n========================================');
    console.log(`📊 LAST.FM STATS FOR: ${username.toUpperCase()}`);
    console.log('========================================');
    console.log(`🎵 Total Scrobbles:    ${totalScrobbles.toLocaleString()}`);
    console.log(`📅 First Scrobble:     ${firstDate.toUTCString()}`);
    console.log(`🕒 Last Scrobble:      ${lastDate.toUTCString()}`);
    console.log(`📈 Avg Scrobbles/Mo:   ${scrobblesPerMonth}`);
    console.log(`🗓️  Total Months Active: ${diffMonths.toFixed(1)} months`);
    console.log('----------------------------------------');
    console.log('Top 5 Most Active Months:');
    
    const sortedMonths = Object.entries(monthlyBreakdown)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5);
    
    sortedMonths.forEach(([month, count], index) => {
        console.log(`  ${index + 1}. ${month}: ${count} scrobbles`);
    });
    console.log('========================================\n');
}

// --- CLI MENU ---
async function main() {
    if (API_KEY === 'YOUR_LASTFM_API_KEY_HERE') {
        console.log('⚠️  Please insert your Last.fm API key into the `API_KEY` variable in `app.js` before running the app.');
        rl.close();
        return;
    }

    while (true) {
        console.log('\n--- Last.fm Scrobble Manager ---');
        console.log('1. Download ALL scrobbles for a user');
        console.log('2. Fetch NEWER scrobbles');
        console.log('3. View overall stats');
        console.log('4. Exit');
        
        const choice = await question('\nSelect an option (1-4): ');

        if (choice === '4') {
            console.log('Goodbye!');
            rl.close();
            break;
        }

        const username = await question('Enter Last.fm Username: ');
        if (!username.trim()) {
            console.log('Invalid username.');
            continue;
        }

        switch (choice) {
            case '1':
                await downloadAllScrobbles(username.trim());
                break;
            case '2':
                await fetchNewerScrobbles(username.trim());
                break;
            case '3':
                showOverallStats(username.trim());
                break;
            default:
                console.log('Invalid choice. Please choose 1, 2, 3, or 4.');
        }
    }
}

main();
