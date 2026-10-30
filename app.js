import fs from 'fs';
import readline from 'readline';

// --- CONFIGURATION ---
// Get your free Last.fm API key from: https://www.last.fm/api/account/create
const API_KEY = 'YOUR_LASTFM_API_KEY_HERE';
const BASE_URL = 'http://ws.audioscrobbler.com/2.0/';

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const question = (query) => new Promise((resolve) => rl.question(query, resolve));

// Helper: Delay to respect API rate limits
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Helper: Get filename for user data
const getFilename = (username) => `${username.toLowerCase()}_scrobbles.json`;

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

// Fetch a single page from Last.fm API
const fetchPage = async (username, page, limit = 200) => {
    const url = `${BASE_URL}?method=user.getRecentTracks&user=${encodeURIComponent(username)}&api_key=${API_KEY}&format=json&page=${page}&limit=${limit}`;
    try {
        const response = await fetch(url);
        const data = await response.json();
        if (data.error) {
            throw new Error(data.message);
        }
        return data.recenttracks;
    } catch (err) {
        console.error(`Error fetching page ${page}:`, err.message);
        return null;
    }
};

// --- FUNCTION 1: Download ALL scrobbles ---
async function downloadAllScrobbles(username) {
    console.log(`\nInitializing full download for user: ${username}...`);
    
    // Fetch page 1 to get total pages and total tracks count
    const initialData = await fetchPage(username, 1, 200);
    if (!initialData) return;

    const totalPages = parseInt(initialData['@attr'].totalPages, 10);
    const totalTracks = parseInt(initialData['@attr'].total, 10);

    console.log(`Found ${totalTracks} total scrobbles across ${totalPages} pages.`);

    let allTracks = [];
    // Filter out currently playing track if it has no date yet
    const tracksOnPage1 = initialData.track.filter(t => t.date && t.date.uts);
    allTracks.push(...tracksOnPage1);

    for (let page = 2; page <= totalPages; page++) {
        process.stdout.write(`Downloading page ${page} of ${totalPages}...\r`);
        const pageData = await fetchPage(username, page, 200);
        if (pageData && pageData.track) {
            const validTracks = pageData.track.filter(t => t.date && t.date.uts);
            allTracks.push(...validTracks);
        }
        // Be nice to Last.fm API limits
        await sleep(250);
    }

    console.log(`\nDownload complete! Total valid scrobbles fetched: ${allTracks.length}`);
    saveLocalData(username, allTracks);
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
        await sleep(250);
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
            :
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
