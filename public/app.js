let currentEventSource = null;
let statusCheckTimeout = null;
let selectedThrottleMs = 1000;
let activityLogCount = 0;
let loadedScrobbles = [];

const setStatus = (msg) => {
  const el = document.getElementById('status');
  if (el) el.innerText = msg;
};

function openAnalysis() {
  const username = document.getElementById('username')?.value.trim();
  if (!username) return alert('Please enter a Last.fm username and load scrobbles first.');
  if (!window.loadedScrobbles?.length) return alert('Load this user’s scrobbles before opening analysis.');
  window.location.href = `analysis.html?username=${encodeURIComponent(username)}`;
}

// Activity Log Helper
function addActivityLog(message, type = 'info') {
  // Log to console for debugging
  console.log('Activity Log:', message, type);
  const logEl = document.getElementById('activityLog');
  const countEl = document.getElementById('logCounter');
  if (!logEl) return;

  const timeStr = new Date().toLocaleTimeString();
  const line = document.createElement('div');
  line.className = `log-line log-line-${type}`;
  line.innerText = `[${timeStr}] ${message}`;

  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;

  activityLogCount++;
  if (countEl) countEl.innerText = `${activityLogCount} events`;
}


function clearActivityLog() {
  const logEl = document.getElementById('activityLog');
  const countEl = document.getElementById('logCounter');
  if (logEl) logEl.innerHTML = '';
  activityLogCount = 0;
  if (countEl) countEl.innerText = '0 events';
}

document.addEventListener('DOMContentLoaded', () => {
  // Global error handler
  window.addEventListener('error', e => {
    console.error('Global error caught:', e.error);
  });
});
function getSelectedThrottleMs() {
  return selectedThrottleMs || 1000;
}

function updateThrottleUI(ms) {
  selectedThrottleMs = ms;
  const selectEl = document.getElementById('throttleSelect');
  const badgeEl = document.getElementById('throttleBadge');
  const customWrap = document.getElementById('customThrottleWrap');
  const customInput = document.getElementById('customThrottleInput');
  const progressThrottle = document.getElementById('progressThrottle');

  const formattedSec = (ms / 1000).toFixed(1);
  const reqPerSec = (1000 / ms).toFixed(1);
  const badgeText = `${formattedSec}s / req (${reqPerSec} req/s)`;

  if (badgeEl) badgeEl.innerText = badgeText;
  if (progressThrottle) progressThrottle.innerText = `⏱️ ${formattedSec}s delay`;

  if (selectEl) {
    const knownValues = ['200', '500', '1000', '1500', '2000'];
    if (knownValues.includes(String(ms))) {
      selectEl.value = String(ms);
      if (customWrap) customWrap.style.display = 'none';
    } else {
      selectEl.value = 'custom';
      if (customWrap) customWrap.style.display = 'inline-flex';
      if (customInput) customInput.value = ms;
    }
  }
}

async function updateThrottleServer(ms) {
  updateThrottleUI(ms);
  localStorage.setItem('lastfm_throttle_ms', String(ms));
  try {
    const res = await fetch('/api/scrobbles/throttle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ throttleMs: ms })
    });
    const data = await res.json();
    addActivityLog(`⏱️ Throttle updated to ${ms}ms (${(1000 / ms).toFixed(2)} req/sec)`, 'info');
  } catch (err) {
    console.warn('Could not update throttle on server:', err.message);
  }
}

function handleThrottleSelectChange(val) {
  const customWrap = document.getElementById('customThrottleWrap');
  if (val === 'custom') {
    if (customWrap) customWrap.style.display = 'inline-flex';
    const customInput = document.getElementById('customThrottleInput');
    if (customInput && !customInput.value) customInput.value = selectedThrottleMs;
  } else {
    if (customWrap) customWrap.style.display = 'none';
    const ms = parseInt(val, 10);
    if (!isNaN(ms) && ms >= 100) {
      updateThrottleServer(ms);
    }
  }
}

function applyCustomThrottle() {
  const customInput = document.getElementById('customThrottleInput');
  if (!customInput) return;
  const ms = parseInt(customInput.value, 10);
  if (isNaN(ms) || ms < 100) {
    alert('Please enter a valid throttle duration in milliseconds (at least 100ms).');
    return;
  }
  updateThrottleServer(ms);
}

// Network / Download Error Alert Display
function showDownloadError(errorData) {
  const alertBox = document.getElementById('downloadErrorAlert');
  const alertTitle = document.getElementById('errorAlertTitle');
  const alertBody = document.getElementById('errorAlertBody');
  const pagePill = document.getElementById('errorPagePill');
  const codePill = document.getElementById('errorCodePill');
  const timePill = document.getElementById('errorTimePill');
  const btnResume = document.getElementById('btnErrorResume');

  // Keep the complete server/browser error payload in DevTools, even when the
  // UI only displays a short description.
  const consoleDetails = {
    timestamp: new Date().toISOString(),
    ...errorData,
  };
  let consoleDetailsText;
  try {
    consoleDetailsText = JSON.stringify(consoleDetails, null, 2);
  } catch (err) {
    consoleDetailsText = String(errorData?.errorDescription || errorData?.error || errorData?.message || err);
  }
  console.error(`[Download Error]\n${consoleDetailsText}`);

  if (!alertBox) return;

  const title = errorData.errorCategory || 'Last.fm Download Error';
  const desc = errorData.errorDescription || errorData.error || errorData.message || 'An error occurred during Last.fm communication.';
  const failedPage = errorData.failedPage || errorData.currentPage || errorData.lastPageFetched || '--';
  const code = errorData.errorCode || errorData.code || 'NETWORK_ERROR';
  const timeStr = errorData.updatedAt
    ? new Date(errorData.updatedAt).toLocaleTimeString()
    : new Date().toLocaleTimeString();

  if (alertTitle) alertTitle.innerText = `⚠️ ${title}`;
  if (alertBody) alertBody.innerText = desc;
  if (pagePill) pagePill.innerText = `Failed Page: ${failedPage}`;
  if (codePill) codePill.innerText = `Code: ${code}`;
  if (timePill) timePill.innerText = `Time: ${timeStr}`;

  if (btnResume) {
    btnResume.innerText = `🔄 Resume Download (Page ${failedPage})`;
    btnResume.onclick = () => downloadAll({ resume: true });
  }

  alertBox.style.display = 'flex';
}

function dismissDownloadError() {
  const alertBox = document.getElementById('downloadErrorAlert');
  if (alertBox) alertBox.style.display = 'none';
}

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

    // Check if previous download ended in an error
    if (data.progress && data.progress.status === 'error') {
      showDownloadError(data.progress);
      if (resumeBanner) resumeBanner.style.display = 'none';
      if (btnDownload) btnDownload.innerText = 'Resume Download';
      if (btnRestart) btnRestart.style.display = 'inline-block';
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
  const progressThrottle = document.getElementById('progressThrottle');

  if (progressBox) progressBox.style.display = 'block';

  const es = new EventSource(`/api/scrobbles/download-stream?username=${encodeURIComponent(username)}`);
  currentEventSource = es;

  const handleUpdate = (payload) => {
    const data = typeof payload === 'string' ? JSON.parse(payload) : payload;
    const percent = Math.min(100, Math.max(0, data.percent || 0));

    if (data.throttleMs) {
      updateThrottleUI(data.throttleMs);
    }

    // Handle retry state during transient network error
    if (data.isRetrying) {
      if (progressBadge) {
        progressBadge.innerText = `⚠️ Retry ${data.retryAttempt}/${data.retryMax}`;
        progressBadge.style.background = '#d97706';
      }
      if (progressTitle) {
        progressTitle.innerText = `Network glitch on page ${data.currentPage || '?'}: ${data.retryError || 'Retrying...'}`;
      }
      if (progressDetails) {
        progressDetails.innerText = `Waiting ${data.retryWaitSeconds || 2}s before retry attempt ${data.retryAttempt} of ${data.retryMax}...`;
      }
      addActivityLog(`⚠️ Retrying page ${data.currentPage} (${data.retryAttempt}/${data.retryMax}): ${data.retryError || 'Network timeout/drop'}`, 'warn');
      return;
    }

    if (progressBadge) {
      progressBadge.innerText = `${percent}%`;
      progressBadge.style.background = '#e5151f';
    }
    if (progressBarFill) progressBarFill.style.width = `${percent}%`;
    if (progressTitle) progressTitle.innerText = data.message || `Downloading page ${data.currentPage || 1} of ${data.totalPages || 1}`;

    const tracksSaved = (data.savedTracksCount || 0).toLocaleString();
    if (progressDetails) {
      progressDetails.innerText = `Page ${data.currentPage || data.lastPageFetched || 0} of ${data.totalPages || 0} • ${tracksSaved} tracks saved to disk`;
    }

    if (progressThrottle && data.throttleMs) {
      progressThrottle.innerText = `⏱️ ${(data.throttleMs / 1000).toFixed(1)}s delay`;
    }

    // Live update total scrobbles stat card while downloading
    const stTotal = document.getElementById('stTotal');
    if (stTotal && data.savedTracksCount) {
      stTotal.innerText = tracksSaved;
    }

    const curPage = data.currentPage || data.lastPageFetched || 0;
    if (curPage % 5 === 0 || curPage === 1 || percent === 100) {
      addActivityLog(`Page ${curPage}/${data.totalPages || 1} (${percent}%) - ${tracksSaved} tracks saved (throttle: ${data.throttleMs || selectedThrottleMs}ms)`, 'info');
    }
  };

  es.addEventListener('progress', (e) => {
    handleUpdate(e.data);
  });

  es.addEventListener('complete', (e) => {
    const data = JSON.parse(e.data);
    handleUpdate(data);
    dismissDownloadError();
    setStatus(`Download completed! Total scrobbles saved: ${data.savedTracksCount}`);
    addActivityLog(`✅ Download completed! Total scrobbles saved: ${data.savedTracksCount.toLocaleString()}`, 'info');
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
    addActivityLog(`⏸️ Download paused at page ${data.currentPage || data.lastPageFetched}`, 'warn');
    setButtonsBusy(false);
    es.close();
    currentEventSource = null;
    checkUserStatus(username, true);
  });

  es.addEventListener('error', (e) => {
    let errorHandled = false;
    if (e.data) {
      try {
        const data = JSON.parse(e.data);
        showDownloadError(data);
        setStatus(`Download stopped: ${data.error || data.message}`);
        addActivityLog(`❌ Error on page ${data.failedPage || '?'}: ${data.errorDescription || data.error}`, 'error');
        errorHandled = true;
      } catch (err) {
        // Fall through
      }
    }

    if (!errorHandled) {
      setStatus('Disconnected from download stream or error occurred.');
      addActivityLog('⚠️ EventSource stream closed or network interrupted.', 'warn');
    }

    setButtonsBusy(false);
    es.close();
    currentEventSource = null;
    checkUserStatus(username, true);
  });
}

async function fetchLocalData(silent = false) {
  console.log('fetchLocalData called with silent=', silent);

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

    loadedScrobbles = Array.isArray(data.scrobbles) ? data.scrobbles : [];
    window.loadedScrobbles = loadedScrobbles;
    try {
      sessionStorage.setItem(`lastfm_scrobbles_${username.toLowerCase()}`, JSON.stringify(loadedScrobbles));
    } catch (err) {
      console.warn('Could not cache scrobbles for analysis:', err.message);
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
      const artist = typeof track.artist === 'string'
        ? track.artist
        : track.artist?.['#text'] || track.artist?.name || 'Unknown artist';
      const album = typeof track.album === 'string'
        ? track.album
        : track.album?.['#text'] || track.album?.name || 'Unknown album';
      const main = document.createElement('div');
      main.className = 'scrobble-main';
      const title = document.createElement('strong');
      title.className = 'scrobble-track';
      title.textContent = `${artist} — ${track.name || 'Unknown track'}`;
      const albumLabel = document.createElement('span');
      albumLabel.className = 'scrobble-album';
      albumLabel.textContent = `Album: ${album}`;
      const dateLabel = document.createElement('time');
      dateLabel.className = 'scrobble-date';
      dateLabel.dateTime = new Date(Number(track.date.uts) * 1000).toISOString();
      dateLabel.textContent = date;
      main.append(title, albumLabel);
      li.append(main, dateLabel);
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

  dismissDownloadError();
  const restart = !!options.restart;
  const throttleMs = getSelectedThrottleMs();

  setStatus(restart ? 'Starting full download from page 1...' : 'Starting download...');
  addActivityLog(`🚀 Starting download for "${username}" (throttle: ${throttleMs}ms, ${restart ? 'restart from page 1' : 'resuming if partial'})...`, 'info');

  setButtonsBusy(true);

  const progressBox = document.getElementById('progressBox');
  if (progressBox) progressBox.style.display = 'block';

  try {
    const res = await fetch('/api/scrobbles/download-all', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, restart, throttleMs })
    });
    const responseText = await res.text();
    let data;
    try {
      data = responseText ? JSON.parse(responseText) : {};
    } catch (parseError) {
      const error = new Error(`Download request returned non-JSON response (HTTP ${res.status}): ${responseText.slice(0, 1000)}`);
      error.details = {
        httpStatus: res.status,
        statusText: res.statusText,
        contentType: res.headers.get('content-type'),
        responseBody: responseText.slice(0, 1000),
        parseError: parseError.message,
        request: { username, restart, throttleMs },
      };
      throw error;
    }
    if (!res.ok || data.error) {
      const error = new Error(data.errorDescription || data.description || data.error || `Request failed with HTTP ${res.status}`);
      error.details = {
        httpStatus: res.status,
        statusText: res.statusText,
        response: data,
        request: { username, restart, throttleMs },
      };
      throw error;
    }

    setStatus(data.message || 'Download in progress...');
    connectProgressStream(username);
  } catch (err) {
    showDownloadError({
      errorCategory: 'Download Initiation Error',
      errorDescription: err.message,
      errorCode: 'INIT_ERROR',
      ...(err.details || {}),
      stack: err.stack,
    });
    setStatus('Error starting download: ' + err.message);
    addActivityLog(`❌ Error starting download: ${err.message}`, 'error');
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
  addActivityLog('⏸️ Pausing download...', 'info');
  try {
    const res = await fetch('/api/scrobbles/download-cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username })
    });
    const responseText = await res.text();
    let data;
    try {
      data = responseText ? JSON.parse(responseText) : {};
    } catch (parseError) {
      throw new Error(`Pause request returned non-JSON response (HTTP ${res.status}): ${responseText.slice(0, 1000)}; ${parseError.message}`);
    }
    if (!res.ok || data.error) {
      throw new Error(data.errorDescription || data.error || `Pause request failed with HTTP ${res.status}`);
    }
    setStatus(data.message || 'Pause requested');
  } catch (err) {
    console.error('[Download Pause Error]', {
      timestamp: new Date().toISOString(),
      username,
      message: err.message,
      stack: err.stack,
    });
    setStatus('Error pausing download: ' + err.message);
  }
}

async function syncNewer() {
  const username = document.getElementById('username').value.trim();
  if (!username) return alert('Please enter a username');

  dismissDownloadError();
  const throttleMs = getSelectedThrottleMs();

  setStatus('Checking for newer scrobbles...');
  addActivityLog(`🔄 Checking for newer scrobbles (throttle: ${throttleMs}ms)...`, 'info');
  setButtonsBusy(true);
  try {
    const res = await fetch('/api/scrobbles/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, throttleMs })
    });
    const data = await res.json();
    if (data.error) {
      showDownloadError({
        errorCategory: data.errorCategory || 'Sync Error',
        errorDescription: data.description || data.error,
        errorCode: data.errorCode || 'SYNC_ERROR'
      });
      throw new Error(data.error);
    }

    setStatus(`Sync complete! Added ${data.added} new scrobbles.`);
    addActivityLog(`✅ Sync complete! Added ${data.added} new scrobbles (total: ${data.total}).`, 'info');
    fetchLocalData(true);
  } catch (err) {
    setStatus('Error during sync: ' + err.message);
    addActivityLog(`❌ Error during sync: ${err.message}`, 'error');
  } finally {
    setButtonsBusy(false);
  }
}

const usernameInput = document.getElementById('username');
if (usernameInput) {
  usernameInput.addEventListener('input', (e) => {
    clearTimeout(statusCheckTimeout);
    statusCheckTimeout = setTimeout(() => {
      const u = e.target.value.trim();
      checkUserStatus(u, true);
      if (mbSectionVisible && u) {
        refreshMusicBrainzView();
      }
    }, 400);
  });

  usernameInput.addEventListener('change', (e) => {
    const u = e.target.value.trim();
    checkUserStatus(u, true);
    if (mbSectionVisible && u) {
      refreshMusicBrainzView();
    }
  });
}

// ==========================================
// --- MUSICBRAINZ SECTION FUNCTIONALITY ---
// ==========================================

let mbEventSource = null;
let mbEventSourceUsername = null;
let mbCurrentPage = 1;
let mbTotalPages = 1;
let mbSearchQuery = '';
let mbSearchTimeout = null;
let mbFilterValue = 'all';
let mbSortValue = 'firstScrobbledAsc';
let mbLimitValue = 50;
let mbSectionVisible = false;

function setMbStatus(msg) {
  const el = document.getElementById('mbStatus');
  if (el) el.innerText = msg;
}

function setMbButtonsBusy(isBusy) {
  const btnMbStart = document.getElementById('btnMbStart');
  const btnMbPause = document.getElementById('btnMbPause');
  const btnMbRestart = document.getElementById('btnMbRestart');

  if (btnMbStart) {
    btnMbStart.disabled = isBusy;
    btnMbStart.style.display = isBusy ? 'none' : 'inline-block';
  }
  if (btnMbPause) {
    btnMbPause.style.display = isBusy ? 'inline-block' : 'none';
  }
  if (btnMbRestart) {
    btnMbRestart.disabled = isBusy;
  }
}

function toggleMusicBrainzSection(forceState) {
  const section = document.getElementById('musicbrainzSection');
  const btnToggle = document.getElementById('btnToggleMusicBrainz');
  if (!section) return;

  if (typeof forceState === 'boolean') {
    mbSectionVisible = forceState;
  } else {
    mbSectionVisible = section.style.display === 'none' || !section.style.display;
  }

  section.style.display = mbSectionVisible ? 'block' : 'none';
  if (btnToggle) {
    btnToggle.innerText = mbSectionVisible ? '🧠 Hide MusicBrainz Section' : '🧠 MusicBrainz Release Years';
  }

  if (mbSectionVisible) {
    refreshMusicBrainzView();
  }
}

async function fetchMusicBrainzStatus() {
  const username = document.getElementById('username')?.value.trim();
  if (!username) return;

  try {
    const res = await fetch(`/api/musicbrainz/status/${encodeURIComponent(username)}`);
    if (!res.ok) return;
    const data = await res.json();

    const stTotal = document.getElementById('mbStatTotal');
    const stEnriched = document.getElementById('mbStatEnriched');
    const stOldest = document.getElementById('mbStatOldestYear');
    const stLater = document.getElementById('mbStatLaterCount');
    const stAudiobooks = document.getElementById('mbStatAudiobooks');
    const stClassification = document.getElementById('mbStatClassification');
    const stToLookup = document.getElementById('mbStatToLookup');
    const stRemaining = document.getElementById('mbStatRemaining');
    const btnRestart = document.getElementById('btnMbRestart');

    if (stTotal) stTotal.innerText = (data.stats.totalUniqueSongs || 0).toLocaleString();
    if (stEnriched) {
      stEnriched.innerHTML = `${(data.stats.foundCount || 0).toLocaleString()} <small style="font-size: 13px; color: #a8a8b3;">(${data.stats.percentComplete || 0}%)</small>`;
    }
    if (stOldest) stOldest.innerText = data.stats.oldestReleaseYear || '-';
    if (stLater) stLater.innerText = (data.stats.laterReleaseCount || 0).toLocaleString();
    if (stAudiobooks) stAudiobooks.innerText = (data.stats.audiobookCount || 0).toLocaleString();
    if (stClassification) stClassification.innerText = `${(data.stats.musicCount || 0).toLocaleString()} music · ${(data.stats.unknownClassificationCount || 0).toLocaleString()} unknown`;
    const hasResumableQueue = data.isRunning || data.status === 'paused';
    const toLookup = hasResumableQueue ? data.progress?.totalToLookup ?? data.stats.pendingSongs ?? 0 : data.stats.pendingSongs ?? 0;
    const remaining = hasResumableQueue ? data.progress?.remainingCount ?? data.stats.pendingSongs ?? 0 : data.stats.pendingSongs ?? 0;
    if (stToLookup) stToLookup.innerText = toLookup.toLocaleString();
    if (stRemaining) stRemaining.innerText = remaining.toLocaleString();

    const progress = data.progress || {};
    const hasSavedProgress = data.isRunning || data.status === 'paused' || (progress.remainingCount > 0 && progress.processedCount > 0);
    const progressBox = document.getElementById('mbProgressBox');
    if (progressBox && hasSavedProgress) {
      progressBox.style.display = 'block';
      const percent = Math.min(100, Math.max(0, progress.percent || 0));
      document.getElementById('mbProgressBadge').innerText = `${percent}%`;
      document.getElementById('mbProgressBarFill').style.width = `${percent}%`;
      document.getElementById('mbProgressTitle').innerText = progress.currentSong
        ? `Looking up: ${progress.currentSong.artist} - ${progress.currentSong.title}`
        : progress.message || 'MusicBrainz progress saved';
      document.getElementById('mbProgressDetails').innerText = `${toLookup.toLocaleString()} items to look up · ${remaining.toLocaleString()} remaining`;
    }

    if (btnRestart) {
      btnRestart.style.display = (data.stats.processedSongs > 0) ? 'inline-block' : 'none';
    }

    if (data.isRunning) {
      setMbButtonsBusy(true);
      connectMusicBrainzStream(username);
    } else {
      setMbButtonsBusy(false);
      setMbStatus(data.status === 'paused' ? data.progress?.message || 'Stopped with progress saved. Resume when ready.' : data.progress?.message || 'Ready');
    }
  } catch (err) {
    console.warn('Error fetching MusicBrainz status:', err.message);
  }
}

function displayMusicBrainzThrottle(throttleMs) {
  const select = document.getElementById('mbThrottle');
  if (select) {
    if (![...select.options].some(option => Number(option.value) === Number(throttleMs))) {
      const custom = document.createElement('option');
      custom.value = String(throttleMs);
      custom.textContent = `${(Number(throttleMs) / 1000).toFixed(1)} seconds`;
      select.insertBefore(custom, select.firstChild);
    }
    select.value = String(throttleMs);
  }
  const indicator = document.getElementById('mbRateIndicator');
  if (indicator) indicator.textContent = `⚡ 1 request / ${(Number(throttleMs) / 1000).toFixed(1)}s`;
}

async function loadMusicBrainzThrottle() {
  try {
    const response = await fetch('/api/musicbrainz/throttle');
    if (response.ok) displayMusicBrainzThrottle((await response.json()).throttleMs);
  } catch (error) {
    console.warn('Could not load MusicBrainz request interval:', error.message);
  }
}

async function updateMusicBrainzThrottle(value) {
  const select = document.getElementById('mbThrottle');
  if (!select) return;
  select.disabled = true;
  try {
    const response = await fetch('/api/musicbrainz/throttle', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ throttleMs: Number(value) }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not save request interval.');
    displayMusicBrainzThrottle(data.throttleMs);
    setMbStatus(`MusicBrainz request interval saved: ${(data.throttleMs / 1000).toFixed(1)} seconds.`);
  } catch (error) {
    setMbStatus(`Could not change request interval: ${error.message}`);
    await loadMusicBrainzThrottle();
  } finally {
    select.disabled = false;
  }
}

async function loadMusicBrainzTable(page = 1) {
  const username = document.getElementById('username')?.value.trim();
  if (!username) return;

  mbCurrentPage = page;
  const tbody = document.getElementById('mbTableBody');
  if (tbody) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: #a8a8b3; padding: 25px;">Loading songs...</td></tr>`;
  }

  try {
    const query = new URLSearchParams({
      page: mbCurrentPage,
      limit: mbLimitValue,
      search: mbSearchQuery,
      filter: mbFilterValue,
      sortBy: mbSortValue,
    });

    const res = await fetch(`/api/musicbrainz/data/${encodeURIComponent(username)}?${query.toString()}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    mbTotalPages = data.pagination?.totalPages || 1;
    const totalItems = data.pagination?.totalItems || 0;

    renderMusicBrainzRows(data.items);
    updateMbPagination(totalItems);
  } catch (err) {
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: #f87171; padding: 25px;">Error loading data: ${err.message}</td></tr>`;
    }
  }
}

function renderMusicBrainzRows(items) {
  const tbody = document.getElementById('mbTableBody');
  if (!tbody) return;

  if (!items || items.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: #a8a8b3; padding: 30px;">No songs match the current filter or search criteria.</td></tr>`;
    return;
  }

  tbody.innerHTML = '';
  for (const item of items) {
    const tr = document.createElement('tr');

    // 1. Song & Artist
    const playsBadge = item.scrobbleCount > 1
      ? `<span style="font-size: 11px; background: #29292e; color: #bbb; padding: 1px 5px; border-radius: 4px; margin-left: 6px;">${item.scrobbleCount} plays</span>`
      : '';
    const songCell = `
      <div>
        <strong style="color: #fff;">${escapeHtml(item.title)}</strong>${playsBadge}
        <div style="color: #a8a8b3; font-size: 12px; margin-top: 2px;">${escapeHtml(item.artist)}</div>
      </div>
    `;

    // 2. First Scrobbled
    const firstDateStr = item.firstScrobbledDate
      ? new Date(item.firstScrobbledDate).toLocaleDateString()
      : (item.firstScrobbledUts ? new Date(item.firstScrobbledUts * 1000).toLocaleDateString() : '-');
    const firstAlbumStr = item.firstScrobbledAlbum ? escapeHtml(item.firstScrobbledAlbum) : '<em style="color: #666;">No Album Tag</em>';
    const firstCell = `
      <div>
        <span>${firstDateStr}</span>
        <div style="font-size: 12px; color: #9ca3af; margin-top: 2px;" title="${escapeHtml(item.firstScrobbledAlbum || '')}">${firstAlbumStr}</div>
      </div>
    `;

    // 3. Scrobbled Release Year
    const scrobYear = item.scrobbledReleaseYear || '-';
    let scrobCell = `<span>${scrobYear}</span>`;
    if (item.isLaterRelease && item.yearDifference > 0) {
      scrobCell = `
        <div>
          <span style="font-weight: bold; color: #f59e0b;">${scrobYear}</span>
          <div style="font-size: 11px; color: #d97706;">+${item.yearDifference} yrs later</div>
        </div>
      `;
    }

    // 4. Earliest Release Year & Title
    let earliestCell = '-';
    if (item.earliestReleaseYear) {
      const earTitle = item.earliestReleaseTitle ? `("${escapeHtml(item.earliestReleaseTitle)}")` : '';
      earliestCell = `
        <div>
          <strong style="color: #4ade80; font-size: 14px;">${item.earliestReleaseYear}</strong>
          <div style="font-size: 12px; color: #9ca3af; margin-top: 2px;" title="${escapeHtml(item.earliestReleaseTitle || '')}">${earTitle}</div>
        </div>
      `;
    } else if (item.mbStatus === 'pending') {
      earliestCell = `<span style="color: #71717a;">Pending...</span>`;
    } else {
      earliestCell = `<span style="color: #71717a;">Unknown</span>`;
    }

    // 5. MusicBrainz Status & Link
    let statusBadge = '';
    if (item.mbStatus === 'found') {
      if (item.isLaterRelease) {
        statusBadge = `<span class="tag-later">⚠️ Remaster / Later</span>`;
      } else {
        statusBadge = `<span class="tag-original">✓ Original Release</span>`;
      }
    } else if (item.mbStatus === 'not_found') {
      statusBadge = `<span class="tag-notfound">✕ Not in MB</span>`;
    } else if (item.mbStatus === 'error') {
      statusBadge = `<span class="tag-notfound" style="color: #f87171;">⚠️ Error</span>`;
    } else {
      statusBadge = `<span class="tag-pending">⏳ Pending</span>`;
    }

    const mbLink = item.musicbrainzUrl
      ? `<a href="${item.musicbrainzUrl}" target="_blank" class="mb-link" title="View on MusicBrainz" style="margin-left: 8px; font-size: 12px;">Link ↗</a>`
      : '';

    const statusCell = `
      <div style="display: flex; align-items: center; flex-wrap: wrap; gap: 4px;">
        ${statusBadge}
        ${mbLink}
      </div>
    `;

    const classification = item.musicbrainzCategory || 'unknown';
    const mbTypes = item.musicbrainzTypes || { primary: [], secondary: [] };
    const typeSummary = [...(mbTypes.primary || []), ...(mbTypes.secondary || [])].join(', ');
    const classificationLabel = classification === 'audiobook' ? '📚 Audiobook' : classification === 'music' ? '🎵 Music' : 'Unknown';
    const classificationColor = classification === 'audiobook' ? '#c084fc' : classification === 'music' ? '#4ade80' : '#a8a8b3';

    tr.innerHTML = `
      <td>${songCell}</td>
      <td>${firstCell}</td>
      <td>${scrobCell}</td>
      <td>${earliestCell}</td>
      <td><span style="color: ${classificationColor};" title="${escapeHtml(typeSummary || 'No release-group type data')}">${classificationLabel}</span></td>
      <td>${statusCell}</td>
    `;
    tbody.appendChild(tr);
  }
}

function updateMbPagination(totalItems) {
  const info = document.getElementById('mbPaginationInfo');
  const pageIndicator = document.getElementById('mbPageIndicator');
  const btnPrev = document.getElementById('btnMbPrev');
  const btnNext = document.getElementById('btnMbNext');

  const start = totalItems > 0 ? (mbCurrentPage - 1) * mbLimitValue + 1 : 0;
  const end = Math.min(totalItems, mbCurrentPage * mbLimitValue);

  if (info) info.innerText = `Showing ${start.toLocaleString()} - ${end.toLocaleString()} of ${totalItems.toLocaleString()} songs`;
  if (pageIndicator) pageIndicator.innerText = `Page ${mbCurrentPage} of ${mbTotalPages || 1}`;

  if (btnPrev) btnPrev.disabled = mbCurrentPage <= 1;
  if (btnNext) btnNext.disabled = mbCurrentPage >= mbTotalPages;
}

function changeMbPage(delta) {
  const newPage = mbCurrentPage + delta;
  if (newPage >= 1 && newPage <= mbTotalPages) {
    loadMusicBrainzTable(newPage);
  }
}

function onMbSearchInput(val) {
  clearTimeout(mbSearchTimeout);
  mbSearchTimeout = setTimeout(() => {
    mbSearchQuery = (val || '').trim();
    loadMusicBrainzTable(1);
  }, 300);
}

function onMbFilterChange(val) {
  mbFilterValue = val;
  loadMusicBrainzTable(1);
}

function onMbSortChange(val) {
  mbSortValue = val;
  loadMusicBrainzTable(1);
}

function onMbLimitChange(val) {
  mbLimitValue = parseInt(val, 10) || 50;
  loadMusicBrainzTable(1);
}

function refreshMusicBrainzView() {
  fetchMusicBrainzStatus();
  loadMusicBrainzTable(mbCurrentPage);
}

// Connect to MusicBrainz Server-Sent Events stream
function connectMusicBrainzStream(username) {
  const normalizedUsername = username.trim().toLowerCase();
  if (mbEventSource && mbEventSourceUsername === normalizedUsername && mbEventSource.readyState !== EventSource.CLOSED) {
    return;
  }

  if (mbEventSource) {
    mbEventSource.close();
    mbEventSource = null;
  }

  const progressBox = document.getElementById('mbProgressBox');
  const progressTitle = document.getElementById('mbProgressTitle');
  const progressBadge = document.getElementById('mbProgressBadge');
  const progressBarFill = document.getElementById('mbProgressBarFill');
  const progressDetails = document.getElementById('mbProgressDetails');

  if (progressBox) progressBox.style.display = 'block';

  const es = new EventSource(`/api/musicbrainz/stream?username=${encodeURIComponent(username)}`);
  mbEventSource = es;
  mbEventSourceUsername = normalizedUsername;

  const handleProgress = (data) => {
    const percent = Math.min(100, Math.max(0, data.percent || 0));
    if (progressBadge) progressBadge.innerText = `${percent}%`;
    if (progressBarFill) progressBarFill.style.width = `${percent}%`;
    if (progressTitle) {
      progressTitle.innerText = data.currentSong
        ? `Looking up: ${data.currentSong.artist} - ${data.currentSong.title}`
        : data.message || 'Enriching songs with MusicBrainz...';
    }
    if (progressDetails) {
      const queued = data.totalToLookup ?? data.totalUniqueSongs ?? 0;
      const remaining = data.remainingCount ?? Math.max(0, queued - (data.processedCount || 0));
      progressDetails.innerText = `${queued.toLocaleString()} items to look up · ${remaining.toLocaleString()} remaining · ${percent}% of library`;
    }
    setMbStatus(data.message || 'Enrichment running...');
  };

  es.addEventListener('mb-status', (e) => {
    try {
      const data = JSON.parse(e.data);
      if (data.progress) handleProgress(data.progress);
      if (data.status && data.status !== 'running') {
        setMbButtonsBusy(false);
        if (data.status === 'paused') setMbStatus(data.progress?.message || 'Stopped with progress saved. Resume when ready.');
        if (data.status === 'completed') setMbStatus(data.progress?.message || 'MusicBrainz enrichment complete.');
        es.close();
        if (mbEventSource === es) {
          mbEventSource = null;
          mbEventSourceUsername = null;
        }
        refreshMusicBrainzView();
      }
    } catch {}
  });

  es.addEventListener('mb-progress', (e) => {
    try {
      const data = JSON.parse(e.data);
      handleProgress(data);
    } catch {}
  });

  es.addEventListener('mb-complete', (e) => {
    try {
      const data = JSON.parse(e.data);
      handleProgress(data);
    } catch {}
    setMbStatus('MusicBrainz enrichment complete!');
    setMbButtonsBusy(false);
    es.close();
    if (mbEventSource === es) {
      mbEventSource = null;
      mbEventSourceUsername = null;
    }
    refreshMusicBrainzView();
  });

  es.addEventListener('mb-paused', (e) => {
    try {
      const data = JSON.parse(e.data);
      handleProgress(data);
    } catch {}
    setMbStatus('MusicBrainz enrichment paused.');
    setMbButtonsBusy(false);
    es.close();
    if (mbEventSource === es) {
      mbEventSource = null;
      mbEventSourceUsername = null;
    }
    refreshMusicBrainzView();
  });

  es.addEventListener('mb-error', (e) => {
    try {
      const data = JSON.parse(e.data);
      setMbStatus(`MusicBrainz error: ${data.error || 'Unknown error'}`);
    } catch {
      setMbStatus('MusicBrainz stream error occurred.');
    }
    setMbButtonsBusy(false);
    es.close();
    if (mbEventSource === es) {
      mbEventSource = null;
      mbEventSourceUsername = null;
    }
    refreshMusicBrainzView();
  });
}

async function startMusicBrainz(options = {}) {
  const username = document.getElementById('username')?.value.trim();
  if (!username) return alert('Please enter a Last.fm username');

  const restart = Boolean(options.restart);
  setMbStatus(restart ? 'Starting full fresh enrichment...' : 'Starting enrichment...');
  setMbButtonsBusy(true);

  const progressBox = document.getElementById('mbProgressBox');
  if (progressBox) progressBox.style.display = 'block';

  try {
    const res = await fetch('/api/musicbrainz/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, restart }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    setMbStatus(data.message || 'Enrichment started');
    connectMusicBrainzStream(username);
  } catch (err) {
    setMbStatus(`Error starting enrichment: ${err.message}`);
    setMbButtonsBusy(false);
  }
}

async function pauseMusicBrainz() {
  const username = document.getElementById('username')?.value.trim();
  if (!username) return;

  setMbStatus('Stopping MusicBrainz lookup and saving progress...');
  try {
    const res = await fetch('/api/musicbrainz/pause', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username }),
    });
    const data = await res.json();
    setMbStatus(data.message || 'Stop requested; saving current progress');
  } catch (err) {
    setMbStatus(`Error stopping: ${err.message}`);
  }
}

async function restartMusicBrainz() {
  const username = document.getElementById('username')?.value.trim();
  if (!username) return alert('Please enter a Last.fm username');

  if (confirm(`Restart MusicBrainz lookups from scratch for "${username}"? Existing stored release dates will be reset.`)) {
    await startMusicBrainz({ restart: true });
  }
}

// Utility: HTML escape helper
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Initial initialization on page load
document.addEventListener('DOMContentLoaded', async () => {
  // Pre-fill the optional server-configured account without initiating a Last.fm request.
  const usernameInput = document.getElementById('username');
  if (usernameInput && !usernameInput.value.trim()) {
    try {
      const configResponse = await fetch('/api/config');
      if (configResponse.ok) {
        const config = await configResponse.json();
        if (!usernameInput.value.trim() && config.defaultLastFmUsername) {
          usernameInput.value = config.defaultLastFmUsername;
        }
      }
    } catch (err) {
      console.debug('Could not load default Last.fm username');
    }
  }

  loadMusicBrainzThrottle();
  // Restore saved throttle preference or fetch from server
  const savedThrottle = localStorage.getItem('lastfm_throttle_ms');
  if (savedThrottle) {
    const parsed = parseInt(savedThrottle, 10);
    if (!isNaN(parsed) && parsed >= 100) {
      updateThrottleUI(parsed);
      updateThrottleServer(parsed);
    }
  } else {
    try {
      const res = await fetch('/api/scrobbles/throttle');
      if (res.ok) {
        const data = await res.json();
        if (data.throttleMs) {
          updateThrottleUI(data.throttleMs);
        }
      }
    } catch (err) {
      console.debug('Using default 1000ms throttle');
    }
  }

  // Handle enter key on custom throttle input
  const customInput = document.getElementById('customThrottleInput');
  if (customInput) {
    customInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        applyCustomThrottle();
      }
    });
  }
});

