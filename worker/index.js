// 城市与地铁：账号与云端同步 API（Cloudflare Workers + D1 + R2）
// 静态游戏资源由 Workers Static Assets 提供；只有 /api/* 进入此脚本。
const SESSION_COOKIE = 'cm_sid';
const OAUTH_COOKIE = 'cm_oauth';
const SESSION_DAYS = 180;
const MAX_BLOB = 48 * 1024 * 1024;        // 单个压缩存档上限
const MAX_USER_BYTES = 1024 * 1024 * 1024; // 每个账号云端存档总量上限
const MAX_STATE = 1500 * 1024;            // 索引与设置 JSON 上限
const BLOB_KEY = /^cm1\.slot\.[A-Za-z0-9_.\-]{1,180}$/;
const GC_GRACE_MS = 60 * 60 * 1000;       // 未被索引引用的存档保留 1 小时，避免与其他设备的上传竞争

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      return await route(request, env, ctx, url);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: '服务器错误' }, 500);
    }
  },
};

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function route(request, env, ctx, url) {
  const p = url.pathname, m = request.method;
  if (m !== 'GET' && m !== 'HEAD') checkCsrf(request, url);
  if (p === '/api/auth/login' && m === 'GET') return login(request, env, url);
  if (p === '/api/auth/callback' && m === 'GET') return callback(request, env, url);
  if (p === '/api/auth/done' && m === 'GET') return done(url);
  if (p === '/api/auth/logout' && m === 'POST') return logout(request, env);
  if (p === '/api/me' && m === 'GET') {
    const user = await currentUser(request, env);
    return json({ user: user ? publicUser(user) : null, configured: !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) });
  }
  const user = await currentUser(request, env);
  if (!user) throw new HttpError(401, '未登录');
  if (p === '/api/sync' && m === 'GET') return getState(env, user);
  if (p === '/api/sync' && m === 'PUT') return putState(request, env, ctx, user);
  if (p === '/api/sync' && m === 'DELETE') return wipe(env, user);
  if (p.startsWith('/api/blob/')) {
    const key = decodeURIComponent(p.slice('/api/blob/'.length));
    if (!BLOB_KEY.test(key)) throw new HttpError(400, '存档键无效');
    if (m === 'GET') return getBlob(env, user, key);
    if (m === 'PUT') return putBlob(request, env, user, key);
  }
  throw new HttpError(404, '接口不存在');
}

// ---------------- 工具 ----------------
function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers } });
}
function checkCsrf(request, url) {
  // 修改类请求只接受本站脚本发出的请求：必须带自定义头，且来源一致。
  if (request.headers.get('X-CM-Client') !== '1') throw new HttpError(403, '请求来源无效');
  const origin = request.headers.get('Origin');
  if (origin && origin !== url.origin) throw new HttpError(403, '请求来源无效');
}
function cookies(request) {
  const out = {};
  for (const part of (request.headers.get('Cookie') || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function setCookie(name, value, maxAge, path = '/') {
  return `${name}=${encodeURIComponent(value)}; Path=${path}; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}
function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function randomToken(n = 32) { return b64url(crypto.getRandomValues(new Uint8Array(n))); }
async function sha256(text) { return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))); }
function publicUser(u) { return { id: u.id, email: u.email, name: u.name, picture: u.picture }; }

// ---------------- Google 登录（授权码 + PKCE） ----------------
async function login(request, env, url) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) throw new HttpError(503, '登录服务尚未配置');
  const state = randomToken(16), verifier = randomToken(48);
  const challenge = await sha256(verifier);
  const popup = url.searchParams.get('popup') === '1';
  const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  auth.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: url.origin + '/api/auth/callback',
    response_type: 'code',
    scope: 'openid email profile',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  }).toString();
  return new Response(null, { status: 302, headers: {
    Location: auth.toString(),
    'Set-Cookie': setCookie(OAUTH_COOKIE, JSON.stringify({ state, verifier, popup }), 600, '/api/auth/'),
    'Cache-Control': 'no-store',
  } });
}

async function callback(request, env, url) {
  let saved;
  try { saved = JSON.parse(cookies(request)[OAUTH_COOKIE] || 'null'); } catch (e) { saved = null; }
  const popup = !!(saved && saved.popup);
  const fail = (msg) => new Response(null, { status: 302, headers: { Location: popup ? '/api/auth/done?error=' + encodeURIComponent(msg) : '/?login_error=' + encodeURIComponent(msg), 'Set-Cookie': setCookie(OAUTH_COOKIE, '', 0, '/api/auth/'), 'Cache-Control': 'no-store' } });
  if (url.searchParams.get('error')) return fail('已取消登录');
  const code = url.searchParams.get('code'), state = url.searchParams.get('state');
  if (!saved || !code || !state || state !== saved.state) return fail('登录请求已过期，请重试');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: url.origin + '/api/auth/callback', grant_type: 'authorization_code', code_verifier: saved.verifier,
    }),
  });
  if (!res.ok) { console.error('token exchange failed', res.status, await res.text()); return fail('Google 登录失败'); }
  const tok = await res.json();
  // id_token 直接由 Google 令牌端点通过 TLS 返回，按 OIDC 规范可不验签，但仍校验签发者、受众与有效期。
  const claims = decodeJwt(tok.id_token);
  const now = Math.floor(Date.now() / 1000);
  if (!claims || !['https://accounts.google.com', 'accounts.google.com'].includes(claims.iss) || claims.aud !== env.GOOGLE_CLIENT_ID || !(claims.exp > now) || !claims.sub) return fail('Google 身份验证失败');
  if (claims.email && claims.email_verified === false) return fail('Google 账号邮箱尚未验证');
  const ts = Date.now();
  let user = await env.DB.prepare('SELECT * FROM users WHERE google_sub = ?').bind(claims.sub).first();
  if (user) {
    await env.DB.prepare('UPDATE users SET email = ?, name = ?, picture = ?, last_login = ? WHERE id = ?').bind(claims.email || null, claims.name || null, claims.picture || null, ts, user.id).run();
  } else {
    user = { id: crypto.randomUUID() };
    await env.DB.prepare('INSERT INTO users (id, google_sub, email, name, picture, created_at, last_login) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(user.id, claims.sub, claims.email || null, claims.name || null, claims.picture || null, ts, ts).run();
  }
  const token = randomToken(32);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND expires_at < ?').bind(user.id, ts),
    env.DB.prepare('INSERT INTO sessions (id_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').bind(await sha256(token), user.id, ts, ts + SESSION_DAYS * 864e5),
  ]);
  const headers = new Headers({ Location: popup ? '/api/auth/done' : '/?login=1', 'Cache-Control': 'no-store' });
  headers.append('Set-Cookie', setCookie(SESSION_COOKIE, token, SESSION_DAYS * 86400));
  headers.append('Set-Cookie', setCookie(OAUTH_COOKIE, '', 0, '/api/auth/'));
  return new Response(null, { status: 302, headers });
}

// 弹出窗口登录结束：通知游戏页面（Google 登录页的 COOP 可能切断 window.opener，故改用同源广播）并尝试关闭。
function done(url) {
  const error = (url.searchParams.get('error') || '').slice(0, 200);
  const msg = JSON.stringify({ cm: 'login', error: error || null }).replace(/</g, '\\u003c');
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>城市与地铁</title>
<body style="font:15px system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;text-align:center;color:#334"><div><p>${error ? '登录失败' : '登录成功'}</p><p style="color:#778">可以关闭此窗口返回游戏。</p><p><a href="/">返回游戏</a></p></div>
<script>var m=${msg};try{new BroadcastChannel('cm-login').postMessage(m);}catch(e){}
try{localStorage.setItem('cm1.cloud.loginEvent',JSON.stringify({t:Date.now(),error:m.error}));}catch(e){}
try{if(window.opener)window.opener.postMessage(m,location.origin);}catch(e){}
setTimeout(function(){window.close();},150);</script></body></html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

function decodeJwt(t) {
  try {
    const part = t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(part + '='.repeat((4 - part.length % 4) % 4));
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0))));
  } catch (e) { return null; }
}

async function currentUser(request, env) {
  const token = cookies(request)[SESSION_COOKIE];
  if (!token || token.length > 100) return null;
  return env.DB.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = ? AND s.expires_at > ?').bind(await sha256(token), Date.now()).first();
}

async function logout(request, env) {
  const token = cookies(request)[SESSION_COOKIE];
  if (token) await env.DB.prepare('DELETE FROM sessions WHERE id_hash = ?').bind(await sha256(token)).run();
  return json({ ok: true }, 200, { 'Set-Cookie': setCookie(SESSION_COOKIE, '', 0) });
}

// ---------------- 同步状态 ----------------
const emptyState = () => ({ index: { games: {}, slots: {} }, tomb: {}, settings: null, settingsAt: 0, prefs: {} });

async function getState(env, user) {
  const row = await env.DB.prepare('SELECT rev, data, updated_at FROM sync_state WHERE user_id = ?').bind(user.id).first();
  const usage = await env.DB.prepare('SELECT COALESCE(SUM(size), 0) AS bytes FROM blobs WHERE user_id = ?').bind(user.id).first();
  return json({ rev: row ? row.rev : 0, updatedAt: row ? row.updated_at : 0, state: row ? JSON.parse(row.data) : emptyState(), bytes: usage.bytes });
}

function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }

async function putState(request, env, ctx, user) {
  const text = await request.text();
  if (text.length > MAX_STATE) throw new HttpError(413, '同步数据过大');
  let body;
  try { body = JSON.parse(text); } catch (e) { throw new HttpError(400, '同步数据格式无效'); }
  const st = body && body.state;
  if (!Number.isSafeInteger(body.baseRev) || !isObj(st) || !isObj(st.index) || !isObj(st.index.games) || !isObj(st.index.slots) || !isObj(st.tomb) || (st.settings !== null && !isObj(st.settings)) || !Number.isFinite(st.settingsAt)) {
    throw new HttpError(400, '同步数据格式无效');
  }
  const keys = new Set();
  for (const [id, s] of Object.entries(st.index.slots)) {
    if (!isObj(s) || s.slotId !== id || typeof s.key !== 'string' || !BLOB_KEY.test(s.key)) throw new HttpError(400, '存档索引无效');
    delete s.store;
    keys.add(s.key);
  }
  // 索引引用的每个存档都必须已上传，避免其他设备拿到无法下载的条目。
  const have = new Set((await env.DB.prepare('SELECT key FROM blobs WHERE user_id = ?').bind(user.id).all()).results.map(r => r.key));
  const missing = [...keys].filter(k => !have.has(k));
  if (missing.length) return json({ error: '部分存档尚未上传', missing }, 422);
  const ts = Date.now();
  const data = JSON.stringify(st);
  const res = body.baseRev === 0
    ? await env.DB.prepare('INSERT INTO sync_state (user_id, rev, data, updated_at) VALUES (?, 1, ?, ?) ON CONFLICT(user_id) DO NOTHING').bind(user.id, data, ts).run()
    : await env.DB.prepare('UPDATE sync_state SET rev = rev + 1, data = ?, updated_at = ? WHERE user_id = ? AND rev = ?').bind(data, ts, user.id, body.baseRev).run();
  if (!res.meta.changes) return json({ error: '云端数据已被其他设备更新' }, 409);
  ctx.waitUntil(collectGarbage(env, user.id, keys, ts));
  return json({ ok: true, rev: body.baseRev + 1, updatedAt: ts });
}

async function collectGarbage(env, userId, keep, now) {
  const rows = (await env.DB.prepare('SELECT key, created_at FROM blobs WHERE user_id = ?').bind(userId).all()).results;
  const stale = rows.filter(r => !keep.has(r.key) && r.created_at < now - GC_GRACE_MS).map(r => r.key);
  if (!stale.length) return;
  // 防止竞态：删除前再次确认最新索引仍未引用这些存档。
  const row = await env.DB.prepare('SELECT data FROM sync_state WHERE user_id = ?').bind(userId).first();
  const latest = new Set(Object.values(JSON.parse(row.data).index.slots).map(s => s.key));
  const drop = stale.filter(k => !latest.has(k));
  for (let i = 0; i < drop.length; i += 50) {
    const part = drop.slice(i, i + 50);
    await env.SAVES.delete(part.map(k => `u/${userId}/${k}`));
    await env.DB.batch(part.map(k => env.DB.prepare('DELETE FROM blobs WHERE user_id = ? AND key = ?').bind(userId, k)));
  }
}

async function wipe(env, user) {
  const rows = (await env.DB.prepare('SELECT key FROM blobs WHERE user_id = ?').bind(user.id).all()).results.map(r => `u/${user.id}/${r.key}`);
  for (let i = 0; i < rows.length; i += 500) await env.SAVES.delete(rows.slice(i, i + 500));
  await env.DB.batch([
    env.DB.prepare('DELETE FROM blobs WHERE user_id = ?').bind(user.id),
    env.DB.prepare('DELETE FROM sync_state WHERE user_id = ?').bind(user.id),
  ]);
  return json({ ok: true });
}

// ---------------- 存档内容（gzip 压缩、按键不可变） ----------------
async function getBlob(env, user, key) {
  const obj = await env.SAVES.get(`u/${user.id}/${key}`);
  if (!obj) throw new HttpError(404, '云端存档不存在');
  return new Response(obj.body, { headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'private, max-age=31536000, immutable', 'X-CM-Encoding': 'gzip' } });
}

async function putBlob(request, env, user, key) {
  const len = Number(request.headers.get('Content-Length'));
  if (!Number.isFinite(len) || len <= 0) throw new HttpError(411, '缺少内容长度');
  if (len > MAX_BLOB) throw new HttpError(413, '存档过大');
  const existing = await env.DB.prepare('SELECT size FROM blobs WHERE user_id = ? AND key = ?').bind(user.id, key).first();
  if (existing) return json({ ok: true, existed: true });
  const usage = await env.DB.prepare('SELECT COALESCE(SUM(size), 0) AS bytes FROM blobs WHERE user_id = ?').bind(user.id).first();
  if (usage.bytes + len > MAX_USER_BYTES) throw new HttpError(507, '云端存储空间已满，请删除部分旧存档');
  await env.SAVES.put(`u/${user.id}/${key}`, request.body, { httpMetadata: { contentType: 'application/octet-stream' } });
  await env.DB.prepare('INSERT OR REPLACE INTO blobs (user_id, key, size, created_at) VALUES (?, ?, ?, ?)').bind(user.id, key, len, Date.now()).run();
  return json({ ok: true });
}
