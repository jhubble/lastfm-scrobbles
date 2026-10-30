let currentEventSource = null;
let statusCheckTimeout = null;

const setStatus = (msg) => {
  const el = document.getElementById('status');
  if (el) el.innerText = msg;
};

function setButtonsBusy(isBusy) {
  const btnFetch = document.getElementById('btnFetch');
  const btnDownload = document.getElementById('btnDownload');
  const btnSync = document.getElementById('btnSync');
  const btnRestart = document.getElementById('btnRestart');
  const btnPause = document.getElementById('btnPause');

  if (btnFetch) btnFetch.disabled = isBusy;
  if (btnDownload) btnDownload.disabled = isBusy;
  if (btnSync) btnSync.disabled = isBusy;
  if (btnRestart) btnRestart.disabled = isBusy;

  if (btnPause) {
    btnPause.style.display = isBusy ? 'inline-block' : 'none';
  }
}

// Check on-disk and active status for user
async function checkUserStatus(username, silent = false) {
  if (!username) return;
  const trimmed = username.trim();
  if (!trimmed) return;

  try {
    const res = await fetch(`/api/scrobbles/status/${encodeURIComponent(trimmed)}`);
    if (!res.ok) return;
    const data = await res.json();

    const resumeBanner = document.getElementById('resumeBanner');
    const resumeText = document.getElementById('resumeText');
    const btnDownload = document.getElementById('btnDownload');
    const btnRestart = document.getElementById('btnRestart');

    if (data.isDownloading) {
      setButtonsBusy(true);
      connectProgressStream(trimmed);
      return;
    }

    if (data.canResume) {
      if (resumeBanner) resumeBanner.style.display = 'flex';
      if (resumeText) {
        resumeText.innerHTML = `⚠️ <strong>Partially completed download detected:</strong> Page <strong>${data.progress.lastPageFetched}</strong> of <strong>${data.progress.totalPages}</strong> (${data.progress.savedTracksCount.toLocaleString()} tracks saved to disk). You can resume or restart.`;
      }
      if (btnDownload) btnDownload.innerText = 'Resume Download';
      if (btnRestart) btnRestart.style.display = 'inline-block';
    } else {
      if (resumeBanner) resumeBanner.style.display = 'none';
      if (btnDownload) btnDownload.innerText = 'Download All';
      if (data.localCount > 0) {
        if (btnRestart) btnRestart.style.display = 'inline-block';
      } else {
        if (btnRestart) btnRestart.style.display = 'none';
      }
    }
  } catch (err) {
    if (!silent) console.warn('Could not check user status:', err.message);
  }
}

// Connect to Server-Sent Events stream for real-time progress
function connectProgressStream(username) {
  if (currentEventSource) {
    currentEventSource.close();
    currentEventSource = null;
  }

  const progressBox = document.getElementById('progressBox');
  const progressTitle = document.getElementById('progressTitle');
  const progressBadge = document.getElementById('progressBadge');
  const progressBarFill = document.getElementById('progressBarFill');
  const progressDetails = document.getElementById('progressDetails');

  if (progressBox) progressBox.style.display = 'block';

  const es = new EventSource(`/api/scrobbles/download-stream?username=${encodeURIComponent(username)}`);
  currentEventSource = es;

  const handleUpdate = (payload) => {
    const data = typeof payload === 'string' ? JSON.parse(payload) : payload;
    const percent = Math.min(100, Math.max(0, data.percent || 0));

    if (progressBadge) progressBadge.innerText = `${percent}%`;
    if (progressBarFill) progressBarFill.style.width = `${percent}%`;
    if (progressTitle) progressTitle.innerText = data.message || `Downloading page ${data.currentPage || 1} of ${data.totalPages || 1}`;

    const tracksSaved = (data.savedTracksCount || 0).toLocaleString();
    if (progressDetails) {
      progressDetails.innerText = `Page ${data.currentPage || data.lastPageFetched || 0} of ${data.totalPages || 0} • ${tracksSaved} tracks saved to disk`;
    }

    // Live update total scrobbles stat card while downloading
    const stTotal = document.getElementById('stTotal');
    if (stTotal && data.savedTracksCount) {
      stTotal.innerText = tracksSaved;
    }
  };

  es.addEventListener('progress', (e) => {
    handleUpdate(e.data);
  });

  es.addEventListener('complete', (e) => {
    const data = JSON.parse(e.data);
    handleUpdate(data);
    setStatus(`Download completed! Total scrobbles saved: ${data.savedTracksCount}`);
    setButtonsBusy(false);

    const resumeBanner = document.getElementById('resumeBanner');
    if (resumeBanner) resumeBanner.style.display = 'none';
    const btnDownload = document.getElementById('btnDownload');
    if (btnDownload) btnDownload.innerText = 'Download All';

    fetchLocalData(true);
    es.close();
    currentEventSource = null;

    setTimeout(() => {
      if (progressBox && !currentEventSource) {
        progressBox.style.display = 'none';
      }
    }, 3000);
  });

  es.addEventListener('paused', (e) => {
    const data = JSON.parse(e.data);
    handleUpdate(data);
    setStatus(data.message || 'Download paused.');
    setButtonsBusy(false);
    es.close();
    currentEventSource = null;
    checkUserStatus(username, true);
  });

  es.addEventListener('error', (e) => {
    try {
      const data = JSON.parse(e.data);
      setStatus(`Download error: ${data.error || data.message}`);
    } catch {
      setStatus('Disconnected from download stream or error occurred.');
    }
    setButtonsBusy(false);
    es.close();
    currentEventSource = null;
    checkUserStatus(username, true);
  });
}

async function fetchLocalData(silent = false) {
  const username = document.getElementById('username').value.trim();
  if (!username) return alert('Please enter a username');

  if (!silent) setStatus('Loading local data...');
  try {
    const res = await fetch(`/api/scrobbles/${encodeURIComponent(username)}`);
    const data = await res.json();

    if (!data.stats) {
      if (!silent) setStatus('No local data found for this user. Click "Download All" to fetch.');
      checkUserStatus(username, true);
      return;
    }

    document.getElementById('stTotal').innerText = data.stats.totalScrobbles.toLocaleString();
    document.getElementById('stFirst').innerText = new Date(data.stats.firstScrobble).toLocaleDateString();
    document.getElementById('stLast').innerText = new Date(data.stats.lastScrobble).toLocaleDateString();
    document.getElementById('stRate').innerText = data.stats.scrobblesPerMonth;

    const list = document.getElementById('scrobbleList');
    list.innerHTML = '';
    data.scrobbles.slice(-20).reverse().forEach(track => {
      const li = document.createElement('li');
      const date = new Date(Number(track.date.uts) * 1000).toLocaleString();
      li.innerHTML = `<span><strong>${track.artist['#text']}</strong> - ${track.name}</span><small>${date}</small>`;
      list.appendChild(li);
    });

    if (!silent) setStatus('Data loaded successfully.');
    checkUserStatus(username, true);
  } catch (err) {
    if (!silent) setStatus('Error: ' + err.message);
  }
}

async function downloadAll(options = {}) {
  const username = document.getElementById('username').value.trim();
  if (!username) return alert('Please enter a username');

  const restart = !!options.restart;
  setStatus(restart ? 'Starting full download from page 1...' : 'Starting download...');

  setButtonsBusy(true);

  const progressBox = document.getElementById('progressBox');
  if (progressBox) progressBox.style.display = 'block';

  try {
    const res = await fetch('/api/scrobbles/download-all', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, restart })
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    setStatus(data.message || 'Download in progress...');
    connectProgressStream(username);
  } catch (err) {
    setStatus('Error starting download: ' + err.message);
    setButtonsBusy(false);
  }
}

async function restartDownload() {
  const username = document.getElementById('username').value.trim();
  if (!username) return alert('Please enter a username');

  if (confirm(`Restart download for "${username}" from page 1? Existing progress will be reset.`)) {
    await downloadAll({ restart: true });
  }
}

async function pauseDownload() {
  const username = document.getElementById('username').value.trim();
  if (!username) return;

  setStatus('Requesting pause...');
  try {
    const res = await fetch('/api/scrobbles/download-cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username })
    });
    const data = await res.json();
    setStatus(data.message || 'Pause requested');
  } catch (err) {
    setStatus('Error pausing download: ' + err.message);
  }
}

async function syncNewer() {
  const username = document.getElementById('username').value.trim();
  if (!username) return alert('Please enter a username');

  setStatus('Checking for newer scrobbles...');
  setButtonsBusy(true);
  try {
    const res = await fetch('/api/scrobbles/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username })
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    setStatus(`Sync complete! Added ${data.added} new scrobbles.`);
    fetchLocalData(true);
  } catch (err) {
    setStatus('Error during sync: ' + err.message);
  } finally {
    setButtonsBusy(false);
  }
}

// Auto-check status when username changes
const usernameInput = document.getElementById('username');
if (usernameInput) {
  usernameInput.addEventListener('input', (e) => {
    clearTimeout(statusCheckTimeout);
    statusCheckTimeout = setTimeout(() => {
      checkUserStatus(e.target.value.trim(), true);
    }, 400);
  });

  usernameInput.addEventListener('change', (e) => {
    checkUserStatus(e.target.value.trim(), true);
  });
}
