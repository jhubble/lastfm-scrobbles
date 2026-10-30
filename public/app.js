const setStatus = (msg) => document.getElementById('status').innerText = msg;

async function fetchLocalData() {
  const username = document.getElementById('username').value.trim();
  if (!username) return alert('Please enter a username');

  setStatus('Loading local data...');
  try {
    const res = await fetch(`/api/scrobbles/${encodeURIComponent(username)}`);
    const data = await res.json();

    if (!data.stats) {
      setStatus('No local data found for this user. Click "Download All" to fetch.');
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

    setStatus('Data loaded successfully.');
  } catch (err) {
    setStatus('Error: ' + err.message);
  }
}

async function downloadAll() {
  const username = document.getElementById('username').value.trim();
  if (!username) return alert('Please enter a username');

  setStatus('Downloading all scrobbles from Last.fm... This may take a while.');
  try {
    const res = await fetch('/api/scrobbles/download-all', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username })
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    
    setStatus(`Download complete! Saved ${data.count} scrobbles.`);
    fetchLocalData();
  } catch (err) {
    setStatus('Error during download: ' + err.message);
  }
}

async function syncNewer() {
  const username = document.getElementById('username').value.trim();
  if (!username) return alert('Please enter a username');

  setStatus('Checking for newer scrobbles...');
  try {
    const res = await fetch('/api/scrobbles/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username })
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    setStatus(`Sync complete! Added ${data.added} new scrobbles.`);
    fetchLocalData();
  } catch (err) {
    setStatus('Error during sync: ' + err.message);
  }
}
