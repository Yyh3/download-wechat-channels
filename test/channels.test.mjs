import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
const lib = await import('../scripts/channels.mjs').catch(() => ({}));
function fn(name) { assert.equal(typeof lib[name], 'function', `${name} is not implemented`); return lib[name]; }
async function server(handler, run) {
  const s = http.createServer(handler); await new Promise(r => s.listen(0, '127.0.0.1', r));
  try { await run(`http://127.0.0.1:${s.address().port}`); }
  finally { s.closeAllConnections(); await new Promise(r => s.close(r)); }
}
const ok = (res, data, legacy = false) => res.end(JSON.stringify(legacy ? { success: true, data } : { code: 0, data }));
function cli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/channels.mjs', ...args], { windowsHide: true });
    let stdout = '', stderr = ''; child.stdout.on('data', b => stdout += b); child.stderr.on('data', b => stderr += b);
    child.on('error', reject); child.on('close', status => resolve({ status, stdout, stderr }));
  });
}
test('CLI batch-status is read-only and omits raw task secrets', async () => {
  await server((req, res) => {
    assert.equal(req.method, 'GET'); assert.equal(req.url, '/__wx_channels_api/batch_progress');
    ok(res, { tasks: [{ id: '9', status: 'done', title: 'sample', error: 'sensitive-token' }] });
  }, async base => {
    const result = await cli(['batch-status', '--base', base]);
    assert.equal(result.status, 0); assert.deepEqual(JSON.parse(result.stdout).tasks, [{ id: '9', status: 'done', title: 'sample' }]);
    assert.ok(!result.stdout.includes('sensitive-token'));
  });
});
test('CLI recognizes the upstream null-tasks zero-total empty batch contract', async () => {
  await server((req, res) => ok(res, { tasks: null, total: 0 }), async base => {
    const result = await cli(['batch-status', '--base', base]);
    assert.equal(result.status, 0); assert.deepEqual(JSON.parse(result.stdout), { tasks: [] });
  });
});
test('native Channels requests reserve serialized one-second pacing slots', async () => {
  const waits = [], received = [];
  await server((req, res) => { received.push(req.url); ok(res, {}); }, async base => {
    const client = fn('createClient')({ base, wait: async ms => { waits.push(ms); } });
    await Promise.all([client.request('/api/channels/feed/profile'), client.request('/api/channels/contact/search')]);
    await client.request('/__wx_channels_api/batch_progress');
    assert.deepEqual(waits, [1000, 1000]);
    assert.equal(received.length, 3);
  });
});
test('missing or malformed batch task lists fail closed before submission', async () => {
  for (const tasks of [undefined, {}, 'bad', null]) {
    await server((req, res) => {
      assert.equal(req.url, '/__wx_channels_api/batch_progress');
      ok(res, tasks === undefined ? {} : { tasks, total: 1 });
    }, async base => {
      await assert.rejects(fn('submitBatch')(fn('createClient')({ base }), [{ id: '9' }]), /batch.*tasks|tasks.*array/i);
      const result = await cli(['batch-status', '--base', base]);
      assert.notEqual(result.status, 0); assert.match(result.stderr, /batch.*tasks|tasks.*array/i);
    });
  }
});
test('preserves unsafe integer literals without changing strings or decimals', () => {
  const data = fn('parseJSON')('{"id":18934567890123456789,"n":3,"s":"18934567890123456789","x":1.25}');
  assert.deepEqual(data, { id: '18934567890123456789', n: 3, s: '18934567890123456789', x: 1.25 });
});
test('rejects external, credentialed, and non-http API addresses', () => {
  for (const url of ['http://example.com', 'http://127.0.0.1.evil.test', 'http://user:pw@127.0.0.1', 'file:///tmp/a', 'http://127.0.0.1/api']) {
    assert.throws(() => fn('createClient')({ base: url }), /loopback|origin|credentials|HTTP/i);
  }
});
test('blocks redirects and sends auth only to configured loopback', async () => {
  await server((req, res) => { assert.equal(req.headers['x-local-auth'], 'test-only'); res.writeHead(302, { location: 'http://example.com' }); res.end(); }, async base => {
    await assert.rejects(fn('createClient')({ base, token: 'test-only' }).request('/api/status'), /redirect|302/i);
  });
});
test('unwraps both response formats and rejects upstream error envelopes', async () => {
  await server((req, res) => req.url === '/good' ? ok(res, { id: '7' }, true) : ok(res, { errCode: 5, errMsg: 'private upstream error' }), async base => {
    const client = fn('createClient')({ base });
    assert.deepEqual(await client.request('/good'), { id: '7' });
    await assert.rejects(client.request('/bad'), /upstream.*5/i);
  });
});
test('connection alone does not imply ready search capability', async () => {
  await server((req, res) => ok(res, { connected: true, ready_clients: 0 }), async base => {
    assert.deepEqual(await fn('checkStatus')(fn('createClient')({ base })), { connected: true, searchReady: false, feedReady: false, profileReady: false });
  });
});
test('paginates opaque markers, deduplicates IDs and strips secrets', async () => {
  const markers = [];
  await server((req, res) => {
    const u = new URL(req.url, 'http://local'); markers.push(u.searchParams.get('next_marker'));
    assert.equal(u.pathname, '/api/channels/contact/feed/list');
    assert.equal(u.searchParams.get('username'), 'creator');
    ok(res, { errCode: 0, data: markers.length === 1 ? { object: [{ id: '1', objectNonceId: 'n1', objectDesc: { description: 'One', media: [{ url: 'secret' }] } }], lastBuffer: 'a+b%2F=', continueFlag: 1 } : { object: [{ id: '1' }, { id: '2', objectDesc: { description: 'Two' } }], lastBuffer: '', continueFlag: 0 } });
  }, async base => {
    const result = await fn('collect')(fn('createClient')({ base }), { mode: 'creator', username: 'creator', maxPages: 5 });
    assert.equal(result.complete, true); assert.equal(result.items.length, 2);
    // The injected upstream API calls decodeURIComponent once after HTTP query decoding.
    assert.deepEqual(markers, ['', 'a%2Bb%252F%3D']); assert.ok(!JSON.stringify(result).includes('secret'));
    assert.equal(result.items[0].nonceId, 'n1');
  });
});
test('collects account and video search using their real endpoint and shape', async () => {
  await server((req, res) => {
    const u = new URL(req.url, 'http://local'); assert.equal(u.searchParams.get('keyword'), '青苗');
    if (u.pathname === '/api/channels/contact/search') ok(res, { errCode: 0, data: { infoList: [{ contact: { username: 'u', nickname: '青苗' } }], lastBuffer: '' } });
    else { assert.equal(u.pathname, '/api/channels/feed/search'); ok(res, { errCode: 0, data: { objectList: [{ object: { id: 'v', objectDesc: { description: '视频' } } }], lastBuffer: '' } }); }
  }, async base => {
    const client = fn('createClient')({ base });
    const accounts = await fn('collect')(client, { mode: 'accounts', keyword: '青苗' });
    assert.deepEqual(accounts.items, [{ username: 'u', nickname: '青苗' }]);
    assert.equal((await fn('collect')(client, { mode: 'videos', keyword: '青苗' })).items[0].id, 'v');
  });
});
test('marks max-page, repeated cursor and missing cursor as incomplete', async () => {
  for (const variant of ['limit', 'repeat', 'missing']) {
    let n = 0;
    await server((req, res) => ok(res, { errCode: 0, data: { object: [{ id: String(++n) }], continueFlag: 1, lastBuffer: variant === 'missing' ? '' : 'same' } }), async base => {
      const result = await fn('collect')(fn('createClient')({ base }), { mode: 'creator', username: 'u', maxPages: variant === 'limit' ? 1 : 4 });
      assert.equal(result.complete, false); assert.match(result.reason, /limit|cursor/i);
      assert.ok(n <= 2);
    });
  }
});
test('refuses unknown list shape instead of calling it empty and complete', async () => {
  await server((req, res) => ok(res, { errCode: 0, data: { surprise: [] } }), async base => {
    await assert.rejects(fn('collect')(fn('createClient')({ base }), { mode: 'creator', username: 'u' }), /shape/i);
  });
});
test('batch submission maps profile media and refuses active competing batch', async () => {
  let started = false, active = false;
  await server(async (req, res) => {
    if (req.url.startsWith('/api/channels/feed/profile')) ok(res, { errCode: 0, data: { object: { id: '9', contact: { nickname: 'A' }, objectDesc: { description: 'T', mediaType: 4, media: [{ url: 'https://video.test/a?', urlToken: 'token=x', decodeKey: '1234' }] } } } });
    else if (req.url === '/__wx_channels_api/batch_progress') ok(res, { tasks: active ? [{ id: 'other', status: 'pending' }] : null, total: active ? 1 : 0 });
    else { assert.equal(req.url, '/__wx_channels_api/batch_start'); const chunks = []; for await (const chunk of req) chunks.push(chunk); const body = JSON.parse(Buffer.concat(chunks)); assert.equal(body.videos[0].url, 'https://video.test/a?token=x'); assert.equal(body.videos[0].key, '1234'); assert.equal(body.forceRedownload, false); started = true; ok(res, { total: 1 }); }
  }, async base => {
    const client = fn('createClient')({ base });
    const result = await fn('submitBatch')(client, [{ id: '9', nonceId: 'n' }]);
    assert.equal(started, true); assert.equal(result.state, 'submitted'); assert.ok(!JSON.stringify(result).includes('token=x'));
    active = true; await assert.rejects(fn('submitBatch')(client, [{ id: '9' }]), /active|busy/i);
  });
});
test('joins media tokens without corrupting encoded signatures', () => {
  const join = fn('joinMediaURL');
  assert.equal(join('https://video.test/a', '%3Ftoken%3Da%2Fb%26x%3D1'), 'https://video.test/a?token=a%2Fb&x=1');
  assert.equal(join('https://video.test/a?q=1#part', '&token=x'), 'https://video.test/a?q=1&token=x#part');
  assert.equal(join('https://video.test/a', 'https://video.test/complete?x=1'), 'https://video.test/complete?x=1');
});
test('does not let route parsing escape loopback', async () => {
  await server((req, res) => ok(res, { unexpected: true }), async base => {
    const client = fn('createClient')({ base: 'http://127.0.0.1:1' });
    await assert.rejects(client.request('/\\' + new URL(base).host), /route|origin|loopback/i);
  });
});
test('verify refuses a preparing receipt before contacting service', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'channels-'));
  try {
    const file = path.join(dir, 'receipt.json'); await writeFile(file, '{"state":"preparing","ids":["9"]}');
    const result = spawnSync(process.execPath, ['scripts/channels.mjs', 'verify', '--receipt', file], { encoding: 'utf8' });
    assert.notEqual(result.status, 0); assert.match(result.stderr, /submitted receipt/i);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('done is not verified when file missing, zero length or undecodable', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'channels-'));
  try {
    const empty = path.join(dir, 'empty.mp4'), bad = path.join(dir, 'bad.mp4');
    await writeFile(empty, ''); await writeFile(bad, 'not video');
    for (const file of [path.join(dir, 'missing.mp4'), empty, bad]) {
      const result = await fn('verifyFile')(file); assert.equal(result.verified, false);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('verification uses real ffprobe when available and labels unavailable probe honestly', async t => {
  if (spawnSync('ffmpeg', ['-version']).error) return t.skip('ffmpeg unavailable for synthetic MP4');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'channels-'));
  try {
    const file = path.join(dir, 'sample.mp4');
    const generated = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=16x16:d=0.2', '-c:v', 'mpeg4', file]);
    assert.equal(generated.status, 0);
    const result = await fn('verifyFile')(file);
    if (result.probe === 'unavailable') assert.equal(result.verified, false);
    else { assert.equal(result.verified, true); assert.equal(result.probe, 'passed'); assert.ok(result.bytes > 0); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('wait correlates exact IDs and returns missing-file failure without changing backend tasks', async () => {
  await server((req, res) => {
    if (req.url === '/__wx_channels_api/batch_progress') ok(res, { tasks: [{ id: '9', status: 'done' }] });
    else { assert.match(req.url, /^\/api\/downloads\?/); ok(res, { items: [{ videoId: '9', status: 'completed', filePath: 'Z:/does-not-exist/no.mp4' }], total: 1 }, true); }
  }, async base => {
    const result = await fn('waitAndVerify')(fn('createClient')({ base }), ['9'], { timeoutMs: 100, intervalMs: 1 });
    assert.equal(result.complete, false); assert.equal(result.items[0].state, 'verification_failed');
  });
});
test('CLI help works without network and unknown commands fail safely', () => {
  const help = spawnSync(process.execPath, ['scripts/channels.mjs', '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0); assert.match(help.stdout, /status|collect/);
  const bad = spawnSync(process.execPath, ['scripts/channels.mjs', 'install-cert'], { encoding: 'utf8' });
  assert.notEqual(bad.status, 0);
});
