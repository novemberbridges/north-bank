// North Bank collector. Runs on a GitHub Actions schedule (Node 20+, no dependencies).
// Reads each source, keeps Arsenal men's stories, saves encrypted files for the app in OUT_DIR.
// Env: READER_PASSCODE (required), GUARDIAN_KEY (optional), SITE_URL (previous deploy, for reuse),
//      OUT_DIR (default site/data), UPSTREAM_MAP (tests only).
import { webcrypto as crypto } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { gzipSync, gunzipSync } from 'node:zlib';

const PASSCODE = process.env.READER_PASSCODE;
const GUARDIAN_KEY = process.env.GUARDIAN_KEY || 'test';
const SITE_URL = (process.env.SITE_URL || '').replace(/\/$/, '');
const OUT = process.env.OUT_DIR || 'site/data';
const UA = 'NorthBankReader/1.0 (personal news reader)';
const MAX_PER_SOURCE = 40;
const PAGE_VERSION = 2;
const COMMENT_REFRESH_DAYS = 4;
const CONCURRENCY = 4;
const MAP = process.env.UPSTREAM_MAP ? JSON.parse(process.env.UPSTREAM_MAP) : null;

if (!PASSCODE) { console.error('READER_PASSCODE is not set. Add it under Settings > Secrets and variables > Actions.'); process.exit(1); }

/* ---------- Text helpers ---------- */
const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', pound: '£', euro: '€', eacute: 'é', oslash: 'ø', Oslash: 'Ø' };
export const decode = s => String(s || '').replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
  if (e[0] === '#') { const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); try { return String.fromCodePoint(n); } catch { return ''; } }
  return NAMED[e] ?? m;
});
const tidy = s => s.replace(/[ \t\f\v ]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
export const strip = html => tidy(decode(String(html || '')
  .replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, '')
  .replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n\n').replace(/<[^>]+>/g, '')));
const oneLine = s => strip(s).replace(/\s+/g, ' ').trim();
const safeUrl = u => { try { const x = new URL(decode(u)); return x.protocol === 'https:' ? x.href : null; } catch { return null; } };
const attr = (tag, name) => { const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(tag); return m ? (m[2] ?? m[3]) : null; };

// Converts article or comment HTML into plain blocks. The app never renders source HTML.
export function htmlToBlocks(html) {
  const clean = String(html || '').replace(/<(script|style|iframe|noscript|aside|form|svg)\b[\s\S]*?<\/\1>/gi, '').replace(/<!--[\s\S]*?-->/g, '');
  const out = [];
  const re = /<(h2|h3|blockquote|p|li)\b[^>]*>([\s\S]*?)<\/\1>|<img\b[^>]*>/gi;
  let m;
  while ((m = re.exec(clean))) {
    if (!m[1]) {
      const src = safeUrl(attr(m[0], 'src') || attr(m[0], 'data-src') || '');
      if (src && !/\.gif($|\?)|gravatar|emoji|pixel|smilies/i.test(src)) out.push({ t: 'img', src, alt: oneLine(attr(m[0], 'alt') || '') });
      continue;
    }
    if (m[1] !== 'blockquote' && /<img\b/i.test(m[2])) out.push(...htmlToBlocks(m[2].match(/<img\b[^>]*>/gi).join('')));
    const text = strip(m[2]);
    if (!text) continue;
    const t = { h2: 'h', h3: 'h', blockquote: 'q', p: 'p', li: 'li' }[m[1].toLowerCase()];
    out.push({ t, text });
  }
  if (!out.length) { const text = strip(clean); if (text) out.push({ t: 'p', text }); }
  return out.filter(b => !(b.text && /^(the post .* appeared first on|related topics?$|copyright |share this|sign up|advertisement$)/i.test(b.text)));
}

/* ---------- Fetching ---------- */
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function get(url, { type = 'text', retries = 1, headers = {} } = {}) {
  let real = url;
  if (MAP) for (const [from, to] of Object.entries(MAP)) if (real.startsWith(from)) real = to + real.slice(from.length);
  for (let i = 0; ; i++) {
    try {
      const res = await fetch(real, { headers: { 'User-Agent': UA, Accept: '*/*', ...headers }, signal: AbortSignal.timeout(20000), redirect: 'follow' });
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
      const body = type === 'json' ? await res.json() : await res.text();
      return { body, res };
    } catch (e) {
      if (i >= retries || (e.status && e.status < 500 && e.status !== 429)) throw e;
      await sleep(1500);
    }
  }
}
async function pool(list, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, list.length) }, async () => {
    while (i < list.length) { const k = i++; await fn(list[k], k); }
  }));
}

/* ---------- Filters ---------- */
const WOMEN = /\b(women|women[’']?s|womens|wsl|awfc|lionesses|barclays wsl)\b|womens-football|womensfootball|\/arsenal-women/i;
const ARSENAL = /\b(arsenal|gunners|arteta|saka|[oø]degaard|saliba|declan rice)\b/i;
export const isWomens = (it, extra = '') => WOMEN.test(`${it.title} ${it.url} ${extra}`);

/* ---------- RSS ---------- */
function tag(block, name) {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(block);
  if (!m) return '';
  const c = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(m[1]);
  return c ? c[1] : m[1];
}
export function parseRSS(xml) {
  return (xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || []).map(b => {
    const desc = tag(b, 'description'), content = tag(b, 'content:encoded');
    const cats = (b.match(/<category[^>]*>[\s\S]*?<\/category>/gi) || []).map(c => oneLine(tag(c, 'category'))).join(' ');
    const imgTag = /<media:thumbnail\b[^>]*>|<media:content\b[^>]*>|<enclosure\b[^>]*>/i.exec(b);
    const inline = /<img\b[^>]*>/i.exec(decode(desc) + content);
    const count = parseInt(tag(b, 'slash:comments'), 10);
    const date = new Date(tag(b, 'pubDate') || tag(b, 'dc:date'));
    const guid = decode(tag(b, 'guid'));
    return {
      title: oneLine(decode(tag(b, 'title'))),
      url: safeUrl(oneLine(tag(b, 'link'))) || safeUrl(guid),
      date: isNaN(date) ? null : date.toISOString(),
      byline: oneLine(tag(b, 'dc:creator')) || null,
      trail: oneLine(decode(desc)).replace(/\s*(The post .*|Continue reading.*)$/i, '').slice(0, 260),
      image: safeUrl((imgTag && attr(imgTag[0], 'url')) || (inline && attr(inline[0], 'src')) || ''),
      comments: Number.isFinite(count) ? count : null,
      pid: (/[?&]p=(\d+)/.exec(guid) || [])[1] || null,
      cats, content,
    };
  }).filter(i => i.title && i.url);
}
const googleNews = q => `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-GB&gl=GB&ceid=GB:en`;

/* ---------- Sources ---------- */
async function readFeeds(feeds, status) {
  const results = await Promise.allSettled(feeds.map(f => get(f.url)));
  const items = [], problems = [];
  results.forEach((r, i) => {
    if (r.status === 'rejected') { problems.push(`${new URL(feeds[i].url).host}: ${r.reason.message}`); return; }
    for (const it of parseRSS(r.value.body)) {
      if (feeds[i].arsenalOnly && !ARSENAL.test(`${it.title} ${it.url} ${it.cats}`)) continue;
      if (feeds[i].google) { it.title = it.title.replace(/\s+-\s+[^-]+$/, ''); it.trail = ''; }
      items.push(it);
    }
  });
  status.problems = problems;
  status.feedsOk = results.filter(r => r.status === 'fulfilled').length;
  return items;
}
const prep = (items, source) => {
  const seen = new Set(), out = [];
  for (const it of items.sort((a, b) => (b.date || '').localeCompare(a.date || ''))) {
    const key = it.title.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (seen.has(key) || isWomens(it, it.cats)) continue;
    seen.add(key);
    out.push({ ...it, url: source === 'bbc' ? it.url.split('?')[0] : it.url, source });
  }
  return out.slice(0, MAX_PER_SOURCE);
};
async function guardianFeed(status) {
  const url = `https://content.guardianapis.com/search?tag=football/arsenal,-football/womensfootball&page-size=${MAX_PER_SOURCE}&order-by=newest&show-fields=trailText,byline,thumbnail,shortUrl,commentable&api-key=${GUARDIAN_KEY}`;
  try {
    const { body } = await get(url, { type: 'json' });
    const list = body.response.results.map(r => ({
      title: oneLine(r.webTitle), url: safeUrl(r.webUrl), date: r.webPublicationDate,
      byline: oneLine(r.fields?.byline) || null, trail: oneLine(r.fields?.trailText).slice(0, 260),
      image: safeUrl(r.fields?.thumbnail || ''), comments: null, cats: r.sectionName || '',
      apiPath: r.id, shortPath: (/\/p\/[a-z0-9]+/i.exec(r.fields?.shortUrl || '') || [])[0] || null,
      commentable: r.fields?.commentable === 'true',
    })).filter(i => i.url);
    const shorts = list.map(i => i.shortPath).filter(Boolean);
    if (shorts.length) {
      try {
        const { body: counts } = await get(`https://discussion.theguardian.com/discussion-api/getCommentCounts?short-urls=${shorts.join(',')}`, { type: 'json' });
        list.forEach(i => { if (i.shortPath && counts[i.shortPath] != null) { i.comments = counts[i.shortPath]; i.commentable = true; } });
      } catch (e) { status.problems = [`Guardian comment counts: ${e.message}`]; }
    }
    status.feedsOk = 1;
    return list;
  } catch (e) {
    const rss = await readFeeds([{ url: 'https://www.theguardian.com/football/arsenal/rss' }], status);
    status.problems.push(`Guardian API: ${e.message}, using RSS`);
    return rss.map(i => ({ ...i, content: '' }));
  }
}
const SOURCES = {
  arseblog: { name: 'Arseblog', inApp: true, load: s => readFeeds([{ url: 'https://arseblog.news/feed/' }, { url: 'https://arseblog.com/feed' }], s) },
  guardian: { name: 'The Guardian', inApp: true, load: guardianFeed },
  telegraph: { name: 'The Telegraph', inApp: false, load: s => readFeeds([
    { url: 'https://www.telegraph.co.uk/football/rss.xml', arsenalOnly: true },
    { url: googleNews('arsenal site:telegraph.co.uk/football when:14d'), arsenalOnly: true, google: true }], s) },
  athletic: { name: 'The Athletic', inApp: false, load: s => readFeeds([
    { url: 'https://www.nytimes.com/athletic/rss/football/', arsenalOnly: true },
    { url: googleNews('arsenal site:nytimes.com/athletic when:14d'), arsenalOnly: true, google: true }], s) },
  bbc: { name: 'BBC Sport', inApp: true, load: s => readFeeds([{ url: 'https://feeds.bbci.co.uk/sport/football/teams/arsenal/rss.xml' }], s) },
};

/* ---------- Article text ---------- */
export function pageBlocks(html) {
  // Prefer structured article text when the page offers it.
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const j = JSON.parse(m[1]);
      for (const n of [].concat(j, j['@graph'] || [])) {
        if (typeof n?.articleBody === 'string' && n.articleBody.length > 300)
          return n.articleBody.split(/\n{1,}/).map(t => ({ t: 'p', text: oneLine(t) })).filter(b => b.text);
      }
    } catch { /* not valid JSON, keep looking */ }
  }
  let scope = html.replace(/<(script|style|noscript|nav|footer|aside)\b[\s\S]*?<\/\1>/gi, '');
  const cut = scope.search(/id=["'](?:comments|wpdcom|respond)["']|class=["'][^"']*wpd-(?:thread|comment)/i);
  if (cut > 0) scope = scope.slice(0, cut);
  const area = /<article\b[\s\S]*?(?:<\/article>|$)/i.exec(scope)?.[0] || /<main\b[\s\S]*?(?:<\/main>|$)/i.exec(scope)?.[0] || scope;
  return htmlToBlocks(area.slice(0, 400000)).filter(b => b.t === 'img' || b.text.length > 1);
}
async function readArticle(it) {
  if (it.source === 'guardian' && it.apiPath) {
    const { body } = await get(`https://content.guardianapis.com/${it.apiPath}?show-fields=body,main&api-key=${GUARDIAN_KEY}`, { type: 'json' });
    return htmlToBlocks(body.response.content.fields.body);
  }
  if (it.content) return htmlToBlocks(it.content);
  const { body } = await get(it.url);
  if (it.source === 'guardian') {
    it.shortPath ||= (/"shortUrlId":"(\/p\/[a-z0-9]+)"/i.exec(body) || [])[1] || null;
    const open = /"commentable":(true|false)/i.exec(body);
    if (open) it.commentable = open[1] === 'true';
  }
  return pageBlocks(body);
}

/* ---------- Comments ---------- */
const tree = flat => {
  const byId = new Map(flat.map(c => [String(c.id), { ...c, replies: [] }])), roots = [];
  for (const c of byId.values()) {
    const p = c.parent && byId.get(String(c.parent));
    (p ? p.replies : roots).push(c);
    delete c.parent;
  }
  return roots;
};
async function guardianComments(it) {
  if (!it.shortPath || it.commentable === false) return { comments: [], total: 0, state: it.commentable === false ? 'closed' : 'none' };
  const all = [];
  let pages = 1, total = 0;
  const map = c => ({ id: c.id, author: oneLine(c.userProfile?.displayName) || 'Reader', date: c.isoDateTime || c.date, votes: c.numRecommends || 0, blocks: htmlToBlocks(c.body).filter(b => b.t !== 'img'), replies: (c.responses || []).map(map), more: Math.max(0, (c.numResponses || 0) - (c.responses || []).length) });
  for (let page = 1; page <= pages && page <= 5; page++) {
    let body;
    try {
      ({ body } = await get(`https://discussion.theguardian.com/discussion-api/discussion/${it.shortPath}?api-key=dotcom-rendering&orderBy=newest&pageSize=100&page=${page}&displayThreads=true&maxResponses=20`, { type: 'json' }));
    } catch (e) {
      // The Guardian answers 404 for articles that never opened comments.
      if (e.status === 404 && page === 1) return { comments: [], total: 0, state: 'closed' };
      throw e;
    }
    pages = body.pages || 1;
    total = body.discussion?.commentCount ?? total;
    all.push(...(body.discussion?.comments || []).map(map));
  }
  return { comments: all, total, state: 'ok' };
}
function wpDiscuzComments(html) {
  const parts = html.split(/(?=<div\b[^>]*\bid=["']wpd-comm-\d+_\d+["'])/i).slice(1);
  return parts.map(p => {
    const ids = /id=["']wpd-comm-(\d+)_(\d+)["']/i.exec(p);
    const text = /class=["'][^"']*wpd-comment-text[^"']*["'][^>]*>([\s\S]*?)<\/div>/i.exec(p);
    const author = /class=["'][^"']*wpd-comment-author[^"']*["'][^>]*>([\s\S]*?)<\/div>/i.exec(p);
    const date = /class=["'][^"']*wpd-comment-date[^"']*["'][^>]*?(?:title=["']([^"']*)["'])?[^>]*>([\s\S]*?)<\/div>/i.exec(p);
    const votes = /class=["'][^"']*wpd-vote-result[^"']*["'][^>]*>([\s\S]*?)<\/div>/i.exec(p);
    const d = date ? new Date(decode(date[1] || oneLine(date[2]))) : null;
    return { id: ids[1], parent: ids[2] === '0' ? null : ids[2], author: oneLine(author?.[1] || '') || 'Reader', date: d && !isNaN(d) ? d.toISOString() : null, dateText: date ? oneLine(date[2]) : null, votes: parseInt(oneLine(votes?.[1] || ''), 10) || 0, blocks: htmlToBlocks(text?.[1] || '').filter(b => b.t !== 'img') };
  }).filter(c => c.blocks.length);
}
async function wpComments(it) {
  const origin = new URL(it.url).origin;
  if (it.pid) {
    try {
      const flat = [];
      let pages = 1, total = 0;
      for (let page = 1; page <= pages && page <= 5; page++) {
        const { body, res } = await get(`${origin}/wp-json/wp/v2/comments?post=${it.pid}&per_page=100&page=${page}&order=desc`, { type: 'json', retries: 0 });
        pages = parseInt(res.headers.get('x-wp-totalpages'), 10) || 1;
        total = parseInt(res.headers.get('x-wp-total'), 10) || body.length;
        flat.push(...body.map(c => ({ id: c.id, parent: c.parent || null, author: oneLine(c.author_name) || 'Reader', date: c.date_gmt ? c.date_gmt + 'Z' : c.date, votes: 0, blocks: htmlToBlocks(c.content?.rendered).filter(b => b.t !== 'img') })));
      }
      if (flat.length) return { comments: tree(flat), total, state: 'ok' };
    } catch { /* fall through to the page */ }
  }
  const { body } = await get(it.url);
  const flat = wpDiscuzComments(body);
  if (flat.length) return { comments: tree(flat), total: Math.max(flat.length, it.comments || 0), state: 'ok' };
  try {
    const { body: feed } = await get(it.url.replace(/\/?$/, '/feed/'), { retries: 0 });
    const list = parseRSS(feed).map((c, i) => ({ id: i, author: oneLine(c.title.replace(/^by:?\s*/i, '').replace(/^comment on .* by /i, '')) || c.byline || 'Reader', date: c.date, votes: 0, blocks: htmlToBlocks(c.content || c.trail).filter(b => b.t !== 'img') }));
    if (list.length) return { comments: list, total: Math.max(list.length, it.comments || 0), state: 'ok' };
  } catch { /* no feed */ }
  return { comments: [], total: it.comments || 0, state: it.comments ? 'unavailable' : 'none' };
}

/* ---------- Encryption: PBKDF2 passcode > AES-GCM, gzip first ---------- */
const enc = new TextEncoder();
let aesKey, salt;
export async function deriveKey(pass, s, iterations = 200000) {
  const base = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: s, iterations, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function seal(obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, gzipSync(JSON.stringify(obj)));
  return Buffer.concat([iv, Buffer.from(data)]);
}
async function open(buf) {
  const u = new Uint8Array(buf);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: u.slice(0, 12) }, aesKey, u.slice(12));
  return JSON.parse(gunzipSync(Buffer.from(plain)).toString());
}
const idOf = async url => Buffer.from(await crypto.subtle.digest('SHA-256', enc.encode(url))).toString('hex').slice(0, 16);

// Reuses the last deploy, so unchanged articles aren't requested from the source again.
async function previous(file) {
  if (!SITE_URL) return null;
  try {
    const res = await fetch(`${SITE_URL}/data/${file}?t=${Date.now()}`, { signal: AbortSignal.timeout(20000) });
    return res.ok ? Buffer.from(await res.arrayBuffer()) : null;
  } catch { return null; }
}

/* ---------- Run ---------- */
async function main() {
  await mkdir(`${OUT}/a`, { recursive: true });
  let prevKeyFile = null;
  const prevRaw = await previous('key.json');
  if (prevRaw) { try { prevKeyFile = JSON.parse(prevRaw.toString()); } catch { /* start fresh */ } }
  salt = prevKeyFile?.salt ? Buffer.from(prevKeyFile.salt, 'base64') : crypto.getRandomValues(new Uint8Array(16));
  aesKey = await deriveKey(PASSCODE, salt);
  const check = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: new Uint8Array(12) }, aesKey, enc.encode('north-bank'));
  await writeFile(`${OUT}/key.json`, JSON.stringify({ v: 1, iterations: 200000, salt: Buffer.from(salt).toString('base64'), check: Buffer.from(check).toString('base64') }));

  let prevFeed = null;
  const raw = await previous('feed.bin');
  if (raw) { try { prevFeed = await open(raw); } catch { console.log('Previous data unreadable, collecting everything again.'); } }
  const prevById = new Map((prevFeed?.items || []).map(i => [i.id, i]));

  const statuses = {}, items = [];
  for (const [key, src] of Object.entries(SOURCES)) {
    const status = { name: src.name, problems: [], feedsOk: 0 };
    statuses[key] = status;
    const got = prep(await src.load(status), key);
    status.count = got.length;
    status.withComments = 0;
    status.ok = status.feedsOk > 0;
    if (!got.length && !status.ok) {
      // A failed source keeps its previous stories rather than vanishing.
      for (const p of prevById.values()) if (p.source === key) items.push({ ...p, _keep: true });
    }
    for (const it of got) items.push({ ...it, id: await idOf(it.url) });
    console.log(`${src.name}: ${got.length} stories${status.problems.length ? ' | ' + status.problems.join('; ') : ''}`);
  }

  const counters = { read: 0, readFail: 0, comments: 0, commentFail: 0, reused: 0 };
  const now = Date.now();
  await pool(items, CONCURRENCY, async it => {
    const old = prevById.get(it.id);
    const prevFile = old ? await previous(`a/${it.id}.bin`) : null;
    let saved = null;
    if (prevFile) { try { saved = await open(prevFile); } catch { /* collect again */ } }
    if (saved?.v !== PAGE_VERSION) saved = null;
    if (saved?.shortPath && !it.shortPath) it.shortPath = saved.shortPath;
    if (saved?.commentable != null && it.commentable == null) it.commentable = saved.commentable;
    const inApp = SOURCES[it.source].inApp;
    const page = { v: PAGE_VERSION, id: it.id, blocks: saved?.blocks || [], comments: saved?.comments || [], commentTotal: saved?.commentTotal ?? (it.comments || 0), commentState: saved?.commentState || (inApp && it.source !== 'bbc' ? 'none' : 'offsite') };
    const fresh = now - new Date(it.date || 0).getTime() < COMMENT_REFRESH_DAYS * 864e5;
    if (it._keep) { counters.reused++; }
    else {
      if (inApp && !page.blocks.length) {
        try { page.blocks = await readArticle(it); counters.read++; }
        catch (e) { counters.readFail++; console.log(`Text failed: ${it.url} (${e.message})`); }
      } else if (inApp) counters.reused++;
      const changed = !saved || it.comments == null || it.comments !== old?.comments;
      if ((it.source === 'arseblog' || it.source === 'guardian') && (!saved || (fresh && changed))) {
        try {
          const c = it.source === 'guardian' ? await guardianComments(it) : await wpComments(it);
          page.comments = c.comments; page.commentTotal = c.total; page.commentState = c.state; counters.comments++;
          if (it.comments == null && c.state === 'ok') it.comments = c.total;
        } catch (e) { counters.commentFail++; console.log(`Comments failed: ${it.url} (${e.message})`); if (!saved) page.commentState = 'unavailable'; }
      }
    }
    if (it.comments == null && page.commentTotal) it.comments = page.commentTotal;
    if (page.comments.length) statuses[it.source].withComments++;
    statuses[it.source].texts = (statuses[it.source].texts || 0) + (page.blocks.length ? 1 : 0);
    if (it.shortPath) page.shortPath = it.shortPath;
    if (it.commentable != null) page.commentable = it.commentable;
    it.hasText = page.blocks.filter(b => b.t !== 'img').length >= 2;
    await writeFile(`${OUT}/a/${it.id}.bin`, await seal(page));
    delete it.content; delete it.cats; delete it._keep;
  });

  items.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const feed = { updated: new Date().toISOString(), statuses, items };
  await writeFile(`${OUT}/feed.bin`, await seal(feed));
  await writeFile(`${OUT}/status.json`, JSON.stringify({ updated: feed.updated, counters, sources: Object.fromEntries(Object.entries(statuses).map(([k, s]) => [k, { ok: s.ok, count: s.count, texts: s.texts || 0, withComments: s.withComments || 0, problems: s.problems }])) }, null, 1));
  console.log(`Total ${items.length} stories.`, counters, JSON.stringify(Object.fromEntries(Object.entries(statuses).map(([k, s]) => [k, [s.count, s.texts || 0, s.withComments || 0, s.problems]]))));
  // Only fail the run when nothing could be collected, so the last good site stays live.
  if (!items.length) { console.error('No stories collected.'); process.exit(1); }
}
if (import.meta.url === `file://${process.argv[1]}`) main().catch(e => { console.error(e); process.exit(1); });
