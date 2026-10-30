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
let mbCurrentPage = 1;
let mbTotalPages = 1;
let mbSearchQuery = '';
let mbSearchTimeout = null;
let mbFilterValue = 'all';
let mbSortValue = 'firstScrobbledAsc';
let mbLimitValue = 50;
let mbSectionVisible = false;
let mbLastTableRefreshTime = 0;

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
    const btnRestart = document.getElementById('btnMbRestart');

    if (stTotal) stTotal.innerText = (data.stats.totalUniqueSongs || 0).toLocaleString();
    if (stEnriched) {
      stEnriched.innerHTML = `${(data.stats.foundCount || 0).toLocaleString()} <small style="font-size: 13px; color: #a8a8b3;">(${data.stats.percentComplete || 0}%)</small>`;
    }
    if (stOldest) stOldest.innerText = data.stats.oldestReleaseYear || '-';
    if (stLater) stLater.innerText = (data.stats.laterReleaseCount || 0).toLocaleString();

    if (btnRestart) {
      btnRestart.style.display = (data.stats.processedSongs > 0) ? 'inline-block' : 'none';
    }

    if (data.isRunning) {
      setMbButtonsBusy(true);
      connectMusicBrainzStream(username);
    } else {
      setMbButtonsBusy(false);
      setMbStatus(data.progress?.message || 'Ready');
    }
  } catch (err) {
    console.warn('Error fetching MusicBrainz status:', err.message);
  }
}

async function loadMusicBrainzTable(page = 1) {
  const username = document.getElementById('username')?.value.trim();
  if (!username) return;

  mbCurrentPage = page;
  const tbody = document.getElementById('mbTableBody');
  if (tbody) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: #a8a8b3; padding: 25px;">Loading songs...</td></tr>`;
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
      tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: #f87171; padding: 25px;">Error loading data: ${err.message}</td></tr>`;
    }
  }
}

function renderMusicBrainzRows(items) {
  const tbody = document.getElementById('mbTableBody');
  if (!tbody) return;

  if (!items || items.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: #a8a8b3; padding: 30px;">No songs match the current filter or search criteria.</td></tr>`;
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

    tr.innerHTML = `
      <td>${songCell}</td>
      <td>${firstCell}</td>
      <td>${scrobCell}</td>
      <td>${earliestCell}</td>
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
      progressDetails.innerText = `Processed ${data.processedCount || 0} of ${data.totalUniqueSongs || 0} unique songs (${percent}%)`;
    }
    setMbStatus(data.message || 'Enrichment running...');
  };

  es.addEventListener('mb-status', (e) => {
    try {
      const data = JSON.parse(e.data);
      if (data.progress) handleProgress(data.progress);
    } catch {}
  });

  es.addEventListener('mb-progress', (e) => {
    try {
      const data = JSON.parse(e.data);
      handleProgress(data);
    } catch {}
  });

  es.addEventListener('mb-track', (e) => {
    // Throttle table reload during live stream to avoid hammering the DOM
    const now = Date.now();
    if (now - mbLastTableRefreshTime > 4000) {
      mbLastTableRefreshTime = now;
      fetchMusicBrainzStatus();
      if (mbCurrentPage === 1 && !mbSearchQuery && mbFilterValue === 'all') {
        loadMusicBrainzTable(1);
      }
    }
  });

  es.addEventListener('mb-complete', (e) => {
    try {
      const data = JSON.parse(e.data);
      handleProgress(data);
    } catch {}
    setMbStatus('MusicBrainz enrichment complete!');
    setMbButtonsBusy(false);
    es.close();
    mbEventSource = null;
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
    mbEventSource = null;
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
    mbEventSource = null;
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

  setMbStatus('Requesting pause...');
  try {
    const res = await fetch('/api/musicbrainz/pause', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username }),
    });
    const data = await res.json();
    setMbStatus(data.message || 'Pause requested');
  } catch (err) {
    setMbStatus(`Error pausing: ${err.message}`);
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

