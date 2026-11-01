const query = new URLSearchParams(location.search);
const username = query.get('username') || '';
const status = document.getElementById('status');
document.getElementById('analysisLink').href = `analysis.html?username=${encodeURIComponent(username)}`;

function renderCandidates(candidates, variants) {
  const root = document.getElementById('groups');
  root.replaceChildren();
  const labels = { artists: 'Artist variations', albums: 'Album variations', tracks: 'Track variations' };
  let id = 0;
  for (const type of ['artists', 'albums', 'tracks']) {
    const heading = document.createElement('h2');
    heading.textContent = `${labels[type]} (${candidates[type].length})`;
    root.append(heading);
    if (!candidates[type].length) {
      const empty = document.createElement('div'); empty.className = 'empty'; empty.textContent = 'No variations found.'; root.append(empty); continue;
    }
    for (const candidate of candidates[type]) {
      const card = document.createElement('section'); card.className = 'variant-card';
      const title = document.createElement('h3');
      title.textContent = type === 'artists' ? 'Choose the artist name to use' : `${candidate.artist} · Choose the ${type === 'albums' ? 'album' : 'track'} name to use`;
      card.append(title);
      for (const value of candidate.variants) {
        const row = document.createElement('div'); row.className = 'variant-choice';
        const label = document.createElement('label');
        const radio = document.createElement('input'); radio.type = 'radio'; radio.name = `variant-${id}`;
        radio.checked = candidate.saved && value === candidate.canonical;
        const name = document.createElement('span'); name.textContent = value;
        label.append(radio, name);
        const playCount = document.createElement('span'); playCount.className = 'count muted';
        playCount.textContent = `${Number(candidate.counts[value] || 0).toLocaleString()} plays`;
        const saveState = document.createElement('span'); saveState.className = 'muted'; saveState.textContent = candidate.saved && value === candidate.canonical ? 'Saved canonical' : '';
        row.append(label, playCount, saveState); card.append(row);
        radio.addEventListener('change', async () => {
          const selected = value;
          const savedGroups = structuredClone(variants.groups);
          const destination = savedGroups[type];
          const artist = type === 'artists' ? '' : window.ScrobbleVariants.resolveArtist(candidate.artist);
          const matching = destination.filter(group => (group.variants || []).some(variant => candidate.variants.includes(variant))
            && (type === 'artists' || window.ScrobbleVariants.rawKey(group.artist) === window.ScrobbleVariants.rawKey(artist)));
          const kept = destination.filter(group => !matching.includes(group));
          const allVariants = [...new Set([...matching.flatMap(group => group.variants || []), ...candidate.variants])];
          const saved = { ...(type === 'artists' ? {} : { artist }), canonical: selected, variants: allVariants };
          kept.push(saved);
          savedGroups[type] = kept;
          status.textContent = 'Saving variant selection…';
          root.querySelectorAll('input[type="radio"]').forEach(input => { input.disabled = true; });
          try {
            await window.ScrobbleVariants.save(username, savedGroups);
            variants.groups = savedGroups;
            candidate.canonical = selected;
            for (const choice of card.querySelectorAll('.variant-choice')) {
              choice.lastElementChild.textContent = choice.querySelector('input').checked ? 'Saved canonical' : '';
            }
            status.textContent = 'Saved. These names will be rolled up together in reports and detail pages.';
          } catch (error) {
            radio.checked = false;
            status.textContent = `Could not save this selection: ${error.message}`;
          } finally {
            root.querySelectorAll('input[type="radio"]').forEach(input => { input.disabled = false; });
          }
        });
      }
      id++;
      root.append(card);
    }
  }
}

async function loadPage() {
  if (!username) throw new Error('Open Similarity Detection from Listening Analysis so the Last.fm username is included.');
  let scrobbles = [];
  try { scrobbles = JSON.parse(sessionStorage.getItem(`lastfm_scrobbles_${username.toLowerCase()}`) || '[]'); } catch {}
  if (!scrobbles.length) {
    const response = await fetch(`/api/scrobbles/${encodeURIComponent(username)}`);
    if (!response.ok) throw new Error(`Could not load scrobbles (HTTP ${response.status}).`);
    const data = await response.json();
    scrobbles = Array.isArray(data.scrobbles) ? data.scrobbles : [];
    try { sessionStorage.setItem(`lastfm_scrobbles_${username.toLowerCase()}`, JSON.stringify(scrobbles)); } catch {}
  }
  const variants = await window.ScrobbleVariants.load(username);
  const candidates = window.ScrobbleVariants.detect(scrobbles);
  status.textContent = `Reviewed ${scrobbles.length.toLocaleString()} scrobbles. Select a canonical name in any detected group; selections save immediately.`;
  renderCandidates(candidates, variants);
}

loadPage().catch(error => { status.textContent = error.message; });
