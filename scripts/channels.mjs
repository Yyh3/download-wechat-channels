import { readFile, writeFile, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function parseJSON(raw) {
  // Match complete JSON strings first so digits inside quoted data stay untouched.
  const safe = raw.replace(/"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g, token => {
    if (token[0] === '"' || !/^-?\d+$/.test(token)) return token;
    return Number.isSafeInteger(Number(token)) ? token : JSON.stringify(token);
  });
  return JSON.parse(safe);
}

export function createClient({ base = 'http://127.0.0.1:2025', token = process.env.WX_CHANNEL_TOKEN || '', timeoutMs = 65000, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const origin = new URL(base);
  if (origin.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(origin.hostname)) throw new Error('API must be an HTTP literal loopback origin');
  if (origin.username || origin.password) throw new Error('API credentials in URL are forbidden');
  if (origin.pathname !== '/' || origin.search || origin.hash) throw new Error('API base must be an origin, without a path');
  let nativePacing = Promise.resolve();
  return {
    async request(route, { query = {}, body } = {}) {
      if (!route.startsWith('/') || route.startsWith('//')) throw new Error('Invalid local API route');
      const url = new URL(route, origin);
      if (url.origin !== origin.origin) throw new Error('API route must remain on the configured loopback origin');
      for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
      if (url.pathname.startsWith('/api/channels/')) {
        // Serialize start slots even when callers request multiple profiles concurrently.
        const slot = nativePacing.then(() => wait(1000));
        nativePacing = slot.catch(() => {});
        await slot;
      }
      let res;
      try {
        res = await fetch(url, { method: body === undefined ? 'GET' : 'POST', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs), headers: { ...(token ? { 'X-Local-Auth': token } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
      } catch { throw new Error('Local API connection failed or timed out; check the already-running service and native WeChat page'); }
      if (!res.ok) throw new Error(`Local API HTTP ${res.status}${res.status >= 300 && res.status < 400 ? ' redirect blocked' : ''}`);
      let value;
      try { value = parseJSON(await res.text()); } catch { throw new Error('Local API returned invalid JSON'); }
      if (value.success === false || (value.code !== undefined && value.code !== 0)) throw new Error(`Local API rejected request (code ${value.code ?? 'error'})`);
      value = value.data ?? value;
      if (value.errCode !== undefined && value.errCode !== 0) throw new Error(`Upstream API error ${value.errCode}`);
      return value;
    }
  };
}

export async function checkStatus(client) {
  const status = await client.request('/api/channels/status');
  return { connected: status.connected === true, searchReady: Number(status.search_ready_clients) > 0, feedReady: Number(status.feed_ready_clients) > 0, profileReady: Number(status.profile_ready_clients) > 0 };
}

const routes = { accounts: '/api/channels/contact/search', videos: '/api/channels/feed/search', creator: '/api/channels/contact/feed/list' };
function getPageData(value) { return value.data ?? value; }
function getList(data, mode) {
  const keys = mode === 'accounts' ? ['infoList', 'contactList'] : mode === 'videos' ? ['objectList', 'object'] : ['object', 'objectList'];
  for (const key of keys) if (Array.isArray(data[key])) return data[key];
  throw new Error('Unknown upstream list shape; collection completeness cannot be established');
}
function videoMetadata(entry) {
  const item = entry.object ?? entry;
  if (!item.id) throw new Error('Video list item has no ID');
  return { id: String(item.id), nonceId: String(item.objectNonceId ?? item.nonceId ?? ''), title: item.objectDesc?.description ?? '', author: item.contact?.nickname ?? '', username: item.contact?.username ?? '', createTime: String(item.createtime ?? '') };
}
export async function collect(client, { mode, keyword, username, maxPages = 100 } = {}) {
  if (!routes[mode]) throw new Error('Unknown collection mode');
  if (mode === 'creator' ? !username : !keyword) throw new Error('Collection requires username or keyword');
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 10000) throw new Error('maxPages must be 1..10000');
  const items = [], ids = new Set(), cursors = new Set();
  let cursor = '';
  for (let page = 1; page <= maxPages; page++) {
    const result = await client.request(routes[mode], { query: { ...(mode === 'creator' ? { username } : { keyword }), next_marker: encodeURIComponent(cursor) } });
    const data = getPageData(result), list = getList(data, mode);
    for (const entry of list) {
      const contact = entry.contact ?? entry;
      const item = mode === 'accounts' ? { username: String(contact.username ?? ''), nickname: contact.nickname ?? '' } : videoMetadata(entry);
      const id = mode === 'accounts' ? item.username : item.id;
      if (!id) throw new Error('Account item has no username');
      if (!ids.has(id)) { ids.add(id); items.push(item); }
    }
    const next = String(data.lastBuffer ?? data.lastBuff ?? '');
    const more = data.continueFlag;
    if (more === 0 || more === false || (!next && more !== 1 && more !== true)) return { mode, complete: true, pages: page, items };
    let reason;
    if (!next) reason = 'missing cursor while continuation requested';
    else if (cursors.has(next)) reason = 'repeated cursor';
    else if (page === maxPages) reason = 'page limit reached';
    if (reason) return { mode, complete: false, reason, pages: page, nextMarker: next, items };
    cursors.add(next); cursor = next;
  }
}

async function taskForVideo(client, metadata) {
  const profile = await client.request('/api/channels/feed/profile', { query: { object_id: String(metadata.id), nonce_id: metadata.nonceId || '' } });
  const item = getPageData(profile).object;
  if (!item || String(item.id) !== String(metadata.id)) throw new Error('Profile ID mismatch or unsupported profile shape');
  if (item.objectDesc?.mediaType !== undefined && item.objectDesc.mediaType !== 4) throw new Error('Only ordinary video mediaType=4 is supported');
  const media = item.objectDesc?.media?.[0];
  if (!media?.url || !/^https?:\/\//i.test(media.url)) throw new Error('No downloadable media URL in profile');
  const suffix = media.urlToken ?? media.url_token ?? media.urltoken ?? '';
  return { id: String(item.id), title: item.objectDesc.description || '无标题', author: item.contact?.nickname || metadata.author || '', url: joinMediaURL(media.url, suffix), key: String(media.decodeKey ?? media.decryptKey ?? ''), pageSource: 'batch_console' };
}
export function joinMediaURL(base, token) {
  base = String(base || '').trim(); token = String(token || '').trim();
  if (!token) return base;
  if (/^https?:\/\//i.test(token)) return token;
  token = token.replace(/%26/gi, '&').replace(/%3d/gi, '=').replace(/%3f/gi, '?');
  let fragment = '';
  const hash = base.indexOf('#');
  if (hash >= 0) { fragment = base.slice(hash); base = base.slice(0, hash); }
  const query = token.replace(/^[?&]+/, '');
  if (!query) return base + fragment;
  const separator = /[?&]$/.test(base) ? '' : base.includes('?') ? '&' : '?';
  return base + separator + query + fragment;
}
function batchTasks(progress) {
  // Upstream declares a nil Go slice for the initial empty batch.
  if (progress.tasks === null && progress.total === 0) return [];
  if (!Array.isArray(progress.tasks)) throw new Error('Unknown batch tasks shape; expected an array');
  return progress.tasks;
}
export async function submitBatch(client, videos) {
  if (!Array.isArray(videos) || videos.length === 0 || videos.length > 500) throw new Error('Batch needs 1..500 videos');
  const unique = [...new Map(videos.map(v => [String(v.id), v])).values()];
  if (unique.some(v => !v.id || (typeof v.id === 'number' && !Number.isSafeInteger(v.id)))) throw new Error('Each video needs an exact string ID');
  const progress = await client.request('/__wx_channels_api/batch_progress');
  if (batchTasks(progress).some(t => ['pending', 'downloading'].includes(t.status))) throw new Error('Existing batch is active or busy; do not replace it');
  const tasks = [];
  for (const video of unique) tasks.push(await taskForVideo(client, video));
  await client.request('/__wx_channels_api/batch_start', { body: { videos: tasks, forceRedownload: false, pageSource: 'batch_console' } });
  return { state: 'submitted', submittedAt: new Date().toISOString(), ids: tasks.map(t => t.id), count: tasks.length };
}

export async function verifyFile(file) {
  if (!file || typeof file !== 'string') return { verified: false, reason: 'missing file path' };
  let info;
  try { info = await stat(file); } catch { return { verified: false, file, reason: 'file not found' }; }
  if (!info.isFile() || info.size <= 0) return { verified: false, file, bytes: info.size, reason: 'file is empty or not regular' };
  const probe = spawnSync('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_entries', 'format=duration,format_name:stream=codec_type', '-of', 'json', file], { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024, windowsHide: true });
  if (probe.error?.code === 'ENOENT') return { verified: false, file, bytes: info.size, probe: 'unavailable', reason: 'size-only evidence; ffprobe unavailable' };
  let data;
  try { data = JSON.parse(probe.stdout); } catch { /* invalid files are unverified */ }
  const valid = probe.status === 0 && data?.streams?.some(s => s.codec_type === 'video') && Number(data?.format?.duration) > 0 && /mp4|mov/.test(data?.format?.format_name ?? '');
  return { verified: Boolean(valid), file, bytes: info.size, probe: valid ? 'passed' : 'failed', ...(valid ? { duration: Number(data.format.duration) } : { reason: 'ffprobe did not confirm a playable MP4 video' }) };
}
async function downloadRecords(client) {
  const records = [];
  for (let page = 1; page <= 1000; page++) {
    const data = await client.request('/api/downloads', { query: { page, pageSize: 100 } });
    if (!Array.isArray(data.items)) throw new Error('Unknown download records shape');
    records.push(...data.items);
    if (records.length >= Number(data.total) || data.items.length < 100) return records;
  }
  throw new Error('Download records pagination limit exceeded');
}
export async function waitAndVerify(client, ids, { timeoutMs = 600000, intervalMs = 2000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let tasks = [];
  while (true) {
    const progress = await client.request('/__wx_channels_api/batch_progress');
    tasks = progress.tasks ?? [];
    if (ids.every(id => tasks.some(t => String(t.id) === String(id) && ['done', 'failed'].includes(t.status)))) break;
    if (Date.now() >= deadline) return { complete: false, reason: 'timeout or task IDs not present in current batch; backend tasks were not cancelled', items: ids.map(id => ({ id, state: 'pending_or_unknown' })) };
    await new Promise(r => setTimeout(r, Math.min(intervalMs, Math.max(1, deadline - Date.now()))));
  }
  const records = await downloadRecords(client), items = [];
  for (const id of ids) {
    const task = tasks.find(t => String(t.id) === String(id));
    if (task.status === 'failed') { items.push({ id, state: 'download_failed' }); continue; }
    const candidates = records.filter(r => String(r.videoId) === String(id) && r.status === 'completed');
    let evidence = { verified: false, reason: 'no completed download record with exact ID' };
    for (const record of candidates) { evidence = await verifyFile(record.filePath); if (evidence.verified) break; }
    items.push({ id, state: evidence.verified ? 'verified' : 'verification_failed', ...evidence });
  }
  return { complete: items.every(i => i.verified), items };
}

const HELP = `download-wechat-channels — Node.js 22+, existing local wx_channel service required
  node scripts/channels.mjs status [--base http://127.0.0.1:2025]
  node scripts/channels.mjs batch-status [--base http://127.0.0.1:2025]
  node scripts/channels.mjs search-accounts --keyword 青苗 [--max-pages 5] [--out accounts.json]
  node scripts/channels.mjs search-videos --keyword 青苗 [--max-pages 5] [--out videos.json]
  node scripts/channels.mjs collect --username EXACT_USERNAME [--max-pages 100] --out videos.json
  node scripts/channels.mjs download --manifest videos.json --out receipt.json
  node scripts/channels.mjs verify --receipt receipt.json [--timeout-seconds 600] [--out verification.json]
Auth: optional WX_CHANNEL_TOKEN environment variable; never put tokens in command arguments.
Download only submits a batch. Verify polls and checks files. No proxy/certificate/WeChat setup is performed.
Output files are created exclusively; choose a new path if it already exists. Exit 2 means incomplete/unverified.`;
export async function main(argv = process.argv.slice(2)) {
  if (!argv.length || argv.includes('--help')) { console.log(HELP); return; }
  const [command, ...rest] = argv, options = {};
  const allowed = new Set(['base', 'keyword', 'username', 'max-pages', 'out', 'manifest', 'receipt', 'timeout-seconds']);
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i]?.replace(/^--/, '');
    if (!rest[i]?.startsWith('--') || !allowed.has(key) || !rest[i + 1] || rest[i + 1].startsWith('--')) throw new Error('Invalid command arguments; use --help');
    options[key] = rest[i + 1];
  }
  if (!['status', 'batch-status', 'search-accounts', 'search-videos', 'collect', 'download', 'verify'].includes(command)) throw new Error('Unknown command; use --help');
  const client = createClient({ base: options.base });
  let result;
  if (command === 'status') result = await checkStatus(client);
  else if (command === 'batch-status') {
    const batch = await client.request('/__wx_channels_api/batch_progress');
    result = { tasks: batchTasks(batch).map(t => ({ id: String(t.id), status: t.status, title: t.title ?? '' })) };
  }
  else if (['search-accounts', 'search-videos', 'collect'].includes(command)) {
    const ready = await checkStatus(client), capability = command === 'collect' ? ready.feedReady : ready.searchReady;
    if (!capability) throw new Error('No proven ready native WeChat page for this operation. Ask the user to open the supported Channels page; do not change proxy/certificates');
    result = await collect(client, { mode: command === 'collect' ? 'creator' : command === 'search-accounts' ? 'accounts' : 'videos', keyword: options.keyword, username: options.username, maxPages: options['max-pages'] ? Number(options['max-pages']) : 100 });
  } else if (command === 'download') {
    if (!options.manifest || !options.out) throw new Error('download requires --manifest and --out receipt path');
    const manifest = parseJSON(await readFile(options.manifest, 'utf8'));
    if (!(await checkStatus(client)).profileReady) throw new Error('No proven ready native WeChat page for video profiles');
    // Reserve receipt path before causing an external mutation.
    await writeFile(options.out, JSON.stringify({ state: 'preparing', ids: manifest.items?.map(v => v.id) ?? [] }, null, 2), { flag: 'wx' });
    result = await submitBatch(client, manifest.items);
    await writeFile(options.out, JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2)); return;
  } else {
    if (!options.receipt) throw new Error('verify requires --receipt');
    const receipt = parseJSON(await readFile(options.receipt, 'utf8'));
    if (receipt.state !== 'submitted') throw new Error('verify requires a submitted receipt, not a preparing or failed attempt');
    if (!Array.isArray(receipt.ids) || !receipt.ids.length) throw new Error('Receipt has no IDs');
    const seconds = Number(options['timeout-seconds'] ?? 600);
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 86400) throw new Error('timeout-seconds must be >0 and <=86400');
    result = await waitAndVerify(client, receipt.ids, { timeoutMs: seconds * 1000 });
  }
  if (options.out) await writeFile(options.out, JSON.stringify(result, null, 2), { flag: 'wx' });
  console.log(JSON.stringify(result, null, 2));
  if (result.complete === false) process.exitCode = 2;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
