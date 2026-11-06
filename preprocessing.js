import fs from 'fs/promises';
import path from 'path';

const text = value => typeof value === 'string' ? value.trim() : String(value?.['#text'] || value?.name || '').trim();
const key = value => text(value).normalize('NFKC').replace(/\s+/gu, ' ').toLocaleLowerCase();
const chapterLike = value => /\b(?:chapter|ch\.?|part|track)\s*\d+\b/i.test(value) || /^\d{1,3}(?:[.: -].+)?$/.test(value.trim());
const configPath = (dir, user) => path.join(dir, `scrobble_preprocessing_${encodeURIComponent(String(user).trim().toLocaleLowerCase())}.json`);

export async function loadPreprocessingRules(dir, user) {
  try {
    const value = JSON.parse(await fs.readFile(configPath(dir, user), 'utf8'));
    return { version: 1, rules: Array.isArray(value?.rules) ? value.rules.filter(rule => rule?.type === 'audiobook-swapped-fields') : [] };
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, rules: [] };
    throw error;
  }
}

export async function savePreprocessingRules(dir, user, rules) {
  const config = { version: 1, rules: rules.filter(rule => rule?.type === 'audiobook-swapped-fields'
    && typeof rule.book === 'string' && rule.book.trim() && typeof rule.author === 'string' && rule.author.trim()
    && Array.isArray(rule.chapters) && rule.chapters.length > 0)
    .map(rule => ({ id: String(rule.id || `${key(rule.book)}::${key(rule.author)}`), type: 'audiobook-swapped-fields', book: rule.book.trim(), author: rule.author.trim(), chapters: [...new Set(rule.chapters.map(String).map(value => value.trim()).filter(Boolean))], enabled: rule.enabled !== false })) };
  const file = configPath(dir, user);
  const temporary = `${file}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(config, null, 2));
  await fs.rename(temporary, file);
  return config;
}

export function detectAudiobookLayouts(scrobbles) {
  const groups = new Map();
  for (const item of scrobbles) {
    const book = text(item.name), author = text(item.album), chapter = text(item.artist);
    if (!book || !author || !chapter || !chapterLike(chapter)) continue;
    const id = `${key(book)}\u0000${key(author)}`;
    const group = groups.get(id) || { id, type: 'audiobook-swapped-fields', book, author, chapters: [], plays: 0 };
    group.plays++;
    if (!group.chapters.includes(chapter)) group.chapters.push(chapter);
    groups.set(id, group);
  }
  return [...groups.values()].filter(group => group.chapters.length >= 2).sort((a, b) => b.plays - a.plays);
}

export function preprocessScrobbles(scrobbles, config) {
  const rules = (config?.rules || []).filter(rule => rule.enabled !== false);
  return scrobbles.map(item => {
    const book = text(item.name), author = text(item.album), chapter = text(item.artist);
    const rule = rules.find(candidate => key(candidate.book) === key(book) && key(candidate.author) === key(author)
      && candidate.chapters.some(value => key(value) === key(chapter)));
    if (!rule) return item;
    const normalized = { ...item, name: chapter };
    normalized.artist = typeof item.album === 'object' && item.album !== null
      ? { ...item.album, '#text': author, name: author } : author;
    normalized.album = typeof item.name === 'object' && item.name !== null
      ? { ...item.name, '#text': book, name: book } : book;
    normalized.preprocessing = { ruleId: rule.id, original: { name: item.name, artist: item.artist, album: item.album } };
    return normalized;
  });
}
