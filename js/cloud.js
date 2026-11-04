'use strict';
// 云端同步（可选）：使用 Google 账号登录后，设置与全部存档在设备之间自动同步并备份到云端。
// 不登录时游戏行为与纯本地版本完全一致；本地仍是主存储，云端只做合并与备份。
// 合并规则：同一存档槽取保存时间较新的版本；删除以墓碑记录，晚于墓碑的保存才会保留；设置整体按修改时间取新。
(function (CM) {
  const U = CM.U, h = U.h, ic = function (n, s) { return CM.icon(n, s); };
  const LS = {
    user: 'cm1.cloud.user', settingsAt: 'cm1.cloud.settingsAt', last: 'cm1.cloud.lastSync',
  };
  // 直接打开 index.html（file://）时没有服务器，云端功能隐藏。
  const supported = /^https?:$/.test(location.protocol) && typeof fetch === 'function';
  const lsGet = function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const lsSet = function (k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { /* ignore */ } };

  const state = {
    user: (function () { try { return JSON.parse(lsGet(LS.user) || 'null'); } catch (e) { return null; } })(),
    configured: true, status: 'idle', error: '', last: +lsGet(LS.last) || 0, bytes: 0, checked: false,
  };
  const subs = new Set();
  function emit() { for (const f of subs) { try { f(state); } catch (e) { console.error(e); } } }
  function setStatus(s, err) { state.status = s; state.error = err || ''; emit(); }

  class ApiError extends Error { constructor(status, msg, body) { super(msg); this.status = status; this.body = body; } }
  async function api(method, path, body, raw) {
    const opts = { method: method, credentials: 'same-origin', headers: { 'X-CM-Client': '1' } };
    if (body !== undefined) {
      if (raw) opts.body = body;
      else { opts.body = JSON.stringify(body); opts.headers['Content-Type'] = 'application/json'; }
    }
    const res = await fetch('/api' + path, opts);
    if (res.status === 401) { signedOut(); throw new ApiError(401, '登录已失效，请重新登录'); }
    if (!res.ok) {
      let b = null; try { b = await res.json(); } catch (e) { /* ignore */ }
      throw new ApiError(res.status, (b && b.error) || ('HTTP ' + res.status), b);
    }
    return res;
  }

  // ---------------- 压缩 ----------------
  async function gzip(text) {
    if (typeof CompressionStream !== 'function') throw new Error('浏览器不支持压缩，无法上传存档');
    return new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))).blob();
  }
  async function gunzip(blob) {
    return new Response(blob.stream().pipeThrough(new DecompressionStream('gzip'))).text();
  }

  // ---------------- 合并 ----------------
  const TOMB_KEEP = 365 * 864e5;
  function mergeTomb(a, b) {
    const out = {}, floor = Date.now() - TOMB_KEEP;
    for (const t of [a || {}, b || {}]) for (const id in t) if (Number.isFinite(t[id]) && t[id] > floor) out[id] = Math.max(out[id] || 0, t[id]);
    return out;
  }
  // local 的条目保留本机 store 字段；来自云端的新版本需要下载后才有。
  function mergeIndex(local, remote, tomb) {
    const slots = {}, games = {};
    const ids = new Set(Object.keys(local.slots).concat(Object.keys(remote.slots)));
    for (const id of ids) {
      const a = local.slots[id], b = remote.slots[id];
      const pick = !a ? b : !b ? a : (b.key !== a.key && (b.savedAt || 0) > (a.savedAt || 0) ? b : a);
      if (!pick || typeof pick.key !== 'string') continue;
      if (tomb[id] && tomb[id] >= (pick.savedAt || 0)) continue;
      const s = Object.assign({}, pick);
      if (pick !== a) delete s.store;
      slots[id] = s;
    }
    for (const s of Object.values(slots)) {
      const g = s.gameId;
      if (games[g]) continue;
      const ga = local.games[g], gb = remote.games[g];
      const base = ga && gb ? ((gb.nameAt || 0) > (ga.nameAt || 0) ? gb : ga) : (ga || gb || { gameId: g, name: s.name, mode: s.mode, map: s.map, createdAt: s.savedAt, updatedAt: s.savedAt });
      games[g] = Object.assign({}, base, { updatedAt: Math.max((ga && ga.updatedAt) || 0, (gb && gb.updatedAt) || 0, base.updatedAt || 0) });
    }
    for (const s of Object.values(slots)) if (games[s.gameId] && typeof games[s.gameId].name === 'string') s.name = games[s.gameId].name;
    return { games: games, slots: slots };
  }
  function stripIndex(idx) {
    const slots = {};
    for (const id in idx.slots) { const s = Object.assign({}, idx.slots[id]); delete s.store; slots[id] = s; }
    return { games: idx.games, slots: slots };
  }

  // ---------------- 设置 ----------------
  let applyingRemote = false;
  function localSettingsAt() { return +lsGet(LS.settingsAt) || 0; }
  function applySettings(remote) {
    applyingRemote = true;
    try {
      const S = CM.Settings, cur = S.all();
      for (const k of Object.keys(S.DEF)) if (remote[k] !== undefined && JSON.stringify(remote[k]) !== JSON.stringify(cur[k])) S.set(k, remote[k]);
    } finally { applyingRemote = false; }
  }

  // ---------------- 同步 ----------------
  let running = null, again = false, timer = 0;
  async function syncOnce() {
    const C = CM.Save._cloud;
    const res = await (await api('GET', '/sync')).json();
    const remote = res.state || {};
    remote.index = remote.index || { games: {}, slots: {} };
    let incomingSettings = null, report = { down: 0, up: 0 };
    const sAt = localSettingsAt();
    let pushSettings, pushAt;
    if (remote.settings && (remote.settingsAt > sAt || sAt === 0)) { incomingSettings = remote.settings; pushSettings = remote.settings; pushAt = remote.settingsAt || 1; }
    else { pushSettings = CM.Settings.all(); pushAt = sAt || Date.now(); }
    const out = await C.queueWrite(async function () {
      const L = C.readIndex(true);
      let tomb = mergeTomb(remote.tomb, C.readTomb());
      const M = mergeIndex(L, remote.index, tomb);
      const remoteKeys = new Set(Object.values(remote.index.slots).map(function (s) { return s.key; }));
      // 下载云端较新的存档
      for (const s of Object.values(M.slots)) {
        const a = L.slots[s.slotId];
        if (a && a.key === s.key) continue;
        const blob = await (await api('GET', '/blob/' + encodeURIComponent(s.key))).blob();
        const text = await gunzip(blob);
        const where = await C.store.put(s.key, text);
        if ((await C.store.get(s.key, where)) !== text) throw new Error('云端存档写入本机后校验失败');
        s.store = where; report.down++;
      }
      // 上传本机独有的存档
      for (const s of Object.values(M.slots)) {
        if (remoteKeys.has(s.key)) continue;
        const text = await C.store.get(s.key, s.store);
        if (!text) { delete M.slots[s.slotId]; continue; }   // 本机数据已丢失：不把无法下载的条目推到云端
        await api('PUT', '/blob/' + encodeURIComponent(s.key), await gzip(text), true);
        report.up++;
      }
      // 上传期间玩家可能删除或改名（同步执行、不经队列）：以最新本机索引再合并一次。
      const L2 = C.readIndex(true), localTomb = C.readTomb();
      tomb = mergeTomb(remote.tomb, localTomb);
      const F = mergeIndex(L2, M, tomb);
      for (const id in F.slots) if (!F.slots[id].store) { const m = M.slots[id]; if (m && m.key === F.slots[id].key && m.store) F.slots[id].store = m.store; }
      C.writeIndex(F);
      // 被云端删除或被新版本替换的本机数据
      const keep = new Set(Object.values(F.slots).map(function (s) { return s.key; }));
      for (const s of Object.values(L2.slots)) if (!keep.has(s.key)) C.store.del(s.key, s.store);
      return { index: F, tomb: tomb, localTomb: localTomb };
    });
    const r = await (await api('PUT', '/sync', { baseRev: res.rev, state: { index: stripIndex(out.index), tomb: out.tomb, settings: pushSettings, settingsAt: pushAt, prefs: remote.prefs || {} } })).json();
    C.clearTomb(out.localTomb);
    if (incomingSettings) { applySettings(incomingSettings); lsSet(LS.settingsAt, String(pushAt)); }
    else if (!sAt) lsSet(LS.settingsAt, String(pushAt));
    state.bytes = res.bytes || 0;
    state.last = r.updatedAt || Date.now(); lsSet(LS.last, String(state.last));
    return report;
  }
  async function runSync() {
    let report = { down: 0, up: 0 };
    for (let attempt = 0; ; attempt++) {
      try { const r = await syncOnce(); report.down += r.down; report.up += r.up; return report; }
      catch (e) {
        // 其他设备同时提交（409）或存档刚被清理（422）：重新拉取后再合并
        if (e instanceof ApiError && (e.status === 409 || e.status === 422) && attempt < 4) { await new Promise(function (r) { setTimeout(r, 400 + Math.random() * 800 * (attempt + 1)); }); continue; }
        throw e;
      }
    }
  }
  function sync() {
    if (!supported || !state.user) return Promise.resolve(null);
    if (running) { again = true; return running; }
    clearTimeout(timer); timer = 0;
    setStatus('syncing');
    running = runSync().then(function (report) {
      setStatus('idle');
      afterSync(report);
      return report;
    }, function (e) {
      if (!state.user) { setStatus('idle'); return null; }
      const offline = navigator.onLine === false || e instanceof TypeError;
      setStatus(offline ? 'offline' : 'error', offline ? '' : (e && e.message) || String(e));
      console.warn('[cloud] sync failed', e);
      schedule(offline ? 30000 : 60000);
      return null;
    }).finally(function () {
      running = null;
      if (again) { again = false; schedule(1500); }
    });
    return running;
  }
  let lastRun = 0;
  function schedule(delay) {
    if (!state.user) return;
    // 自动保存可能很频繁：至少间隔 20 秒同步一次，期间的变更合并到下一次。
    const at = Math.max(Date.now() + (delay || 0), lastRun + 20000);
    if (timer && timer <= at) return;
    clearTimeout(timer);
    timer = setTimeout(function () { timer = 0; lastRun = Date.now(); sync(); }, at - Date.now());
  }
  function afterSync(report) {
    const ui = CM.ui;
    if (!ui || !report) return;
    // 主菜单上「继续游戏」需要反映刚下载的存档
    if (report.down && !CM.game && document.querySelector('.start-root')) ui.showStart();
    else if (report.down && ui.screenRefresh) { try { ui.screenRefresh(); } catch (e) { /* ignore */ } }
    if (report.down && firstSync) ui.toast('已从云端同步 ' + report.down + ' 个存档', 'good');
    firstSync = false;
  }
  let firstSync = true;

  // ---------------- 登录 ----------------
  function signedIn(user) {
    const changed = !state.user || state.user.id !== user.id;
    state.user = user; lsSet(LS.user, JSON.stringify(user));
    if (changed) { lsSet(LS.last, null); state.last = 0; }
    emit();
  }
  function signedOut() {
    state.user = null; state.bytes = 0; lsSet(LS.user, null); lsSet(LS.last, null); state.last = 0;
    clearTimeout(timer); timer = 0;
    emit();
  }
  async function refreshMe() {
    const r = await (await fetch('/api/me', { credentials: 'same-origin' })).json();
    state.configured = !!r.configured; state.checked = true;
    if (r.user) signedIn(r.user); else signedOut();
    return r.user;
  }
  let loginWin = null;
  function login() {
    if (!state.configured) { if (CM.ui) CM.ui.toast('登录服务尚未配置', 'warn'); return; }
    const w = 480, ht = 640;
    const left = Math.max(0, (screen.width - w) / 2), top = Math.max(0, (screen.height - ht) / 2);
    // 弹出窗口登录，不离开当前进度；被拦截时整页跳转（返回后重新载入）。
    loginWin = window.open('/api/auth/login?popup=1', 'cm-login', 'popup=yes,width=' + w + ',height=' + ht + ',left=' + left + ',top=' + top);
    if (!loginWin) {
      if (CM.game && CM.ui) CM.ui.confirm('离开页面登录？', '浏览器拦截了登录窗口。整页跳转登录会离开当前地图，未保存的进度将丢失；建议先手动保存。', '前往登录', function () { location.href = '/api/auth/login'; }, false, 'cloud');
      else location.href = '/api/auth/login';
    }
  }
  // 登录窗口通过 postMessage、BroadcastChannel 或 localStorage 事件通知结果（可能重复，按状态去重）
  function onLoginEvent(data) {
    if (!data || !loginWin) return;
    loginWin = null;
    if (data.error) { if (CM.ui) CM.ui.toast(data.error, 'bad'); return; }
    firstSync = true;
    refreshMe().then(function (u) { if (u) { if (CM.ui) CM.ui.toast('已登录 ' + (u.email || u.name || ''), 'good'); sync(); } }).catch(function () { /* ignore */ });
  }
  window.addEventListener('message', function (e) { if (e.origin === location.origin && e.data && e.data.cm === 'login') onLoginEvent(e.data); });
  try { new BroadcastChannel('cm-login').onmessage = function (e) { if (e.data && e.data.cm === 'login') onLoginEvent(e.data); }; } catch (e) { /* ignore */ }
  window.addEventListener('storage', function (e) { if (e.key === 'cm1.cloud.loginEvent' && e.newValue) { try { onLoginEvent(JSON.parse(e.newValue)); } catch (x) { /* ignore */ } } });
  // 窗口被关闭但没收到通知（例如用户直接关掉）：回到游戏时查询一次登录状态
  window.addEventListener('focus', function () {
    if (!loginWin) return;
    setTimeout(function () { if (loginWin && loginWin.closed) { loginWin = null; refreshMe().then(function (u) { if (u) { firstSync = true; sync(); } }).catch(function () { /* ignore */ }); } }, 800);
  });
  function logout() {
    return api('POST', '/auth/logout', {}).catch(function () { /* ignore */ }).then(function () { signedOut(); setStatus('idle'); });
  }
  function wipeCloud() {
    return api('DELETE', '/sync').then(function () { return logout(); });
  }

  // ---------------- 启动 ----------------
  function boot() {
    // 整页跳转登录返回后：提示结果并清理网址参数
    const q = new URLSearchParams(location.search);
    const err = q.get('login_error'), justIn = q.has('login');
    if (err || justIn) { q.delete('login_error'); q.delete('login'); history.replaceState(null, '', location.pathname + (q.toString() ? '?' + q : '') + location.hash); }
    refreshMe().then(function (u) {
      if (err && CM.ui) CM.ui.toast(err, 'bad');
      if (u) { if (justIn && CM.ui) CM.ui.toast('已登录 ' + (u.email || u.name || ''), 'good'); return sync(); }
    }, function () { state.checked = true; if (state.user) setStatus('offline'); emit(); });
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible' && Date.now() - state.last > 60000) schedule(500); });
    window.addEventListener('online', function () { schedule(500); });
    setInterval(function () { if (document.visibilityState === 'visible') schedule(0); }, 5 * 60000);
  }

  const Cloud = {
    supported: supported,
    state: state,
    on: function (f) { subs.add(f); return function () { subs.delete(f); }; },
    login: login, logout: logout, wipe: wipeCloud, sync: sync,
    // 本地存档索引或设置变更后调用（save.js / settings 订阅）
    localChanged: function (kind) {
      if (kind === 'settings') { if (applyingRemote) return; lsSet(LS.settingsAt, String(Date.now())); if (state.user) schedule(3000); return; }
      if (state.user) schedule(8000);
    },
  };
  CM.Cloud = Cloud;
  if (!supported) return;

  // 设置变更（不含来自云端的应用）
  if (CM.Settings) CM.Settings.on(function () { Cloud.localChanged('settings'); });

  // ---------------- 界面 ----------------
  const UI = CM.UI;
  function ago(t) {
    if (!t) return '';
    const s = Math.round((Date.now() - t) / 1000);
    if (s < 60) return '刚刚';
    if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
    if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
    return new Date(t).toLocaleString('zh-CN');
  }
  function statusText() {
    if (state.status === 'syncing') return '正在同步…';
    if (state.status === 'offline') return '离线，恢复网络后自动同步';
    if (state.status === 'error') return '同步失败：' + state.error;
    return state.last ? '已同步 · ' + ago(state.last) : '等待同步';
  }
  function avatar(size) {
    const u = state.user;
    if (u && u.picture) return h('img', { class: 'cloud-avatar', src: u.picture, alt: '', referrerpolicy: 'no-referrer', width: size, height: size });
    return h('span', { class: 'cloud-avatar ph' }, ic('user', Math.round(size * 0.6)));
  }
  function accountPanel() {
    const box = h('div', { class: 'cloud-panel' });
    const row = function (icon, title, ctl, desc) { return h('div', { class: 'set-row' }, h('span', { class: 'set-ico' }, icon), h('div', { class: 'grow' }, h('div', { class: 'set-t' }, title), desc ? h('div', { class: 'set-d' }, desc) : null), ctl); };
    const draw = function () {
      if (!document.contains(box) && box.childNodes.length) { off(); return; }
      const ui = CM.ui, u = state.user;
      const kids = [h('div', { class: 'set-group' }, '云端同步')];
      if (!u) {
        kids.push(row(ic('cloud'), '使用 Google 账号登录',
          h('button', { class: 'btn sm primary', disabled: state.configured ? null : true, onclick: login }, '登录'),
          state.configured ? '登录后，设置与全部存档自动在所有设备间同步，并备份到云端' : '登录服务尚未配置'));
      } else {
        kids.push(row(avatar(28), h('span', { 'data-no-i18n': true }, u.name || u.email || ''),
          h('button', { class: 'btn sm', disabled: state.status === 'syncing' ? true : null, onclick: function () { sync().then(function (r) { if (r && ui) ui.toast('同步完成', 'good'); }); } }, '立即同步'),
          h('span', null, h('span', { 'data-no-i18n': true }, u.email ? u.email + ' · ' : ''), statusText())));
        kids.push(row(ic('save'), '云端占用', h('span', { class: 'set-val' }, (state.bytes / 1024 / 1024).toFixed(1) + ' MB'), '存档压缩后保存；被删除或覆盖的旧存档会自动清理'));
        kids.push(h('div', { class: 'set-row' }, h('span', { class: 'grow' }),
          h('button', { class: 'btn sm ghost danger', onclick: function () {
            ui.confirm('删除云端数据？', '将删除云端保存的全部设置与存档并退出登录。本机存档不受影响。此操作无法撤销。', '删除', function () {
              wipeCloud().then(function () { ui.toast('已删除云端数据', 'info'); }, function (e) { ui.toast('删除失败：' + e.message, 'bad'); });
            }, true, 'trash');
          } }, '删除云端数据'),
          h('button', { class: 'btn sm ghost', onclick: function () {
            ui.confirm('退出登录？', '退出后，本机的设置与存档会保留，但不再同步。在共用设备上，可在存档管理中删除本机存档。', '退出登录', function () { logout().then(function () { ui.toast('已退出登录', 'info'); }); }, false, 'user');
          } }, '退出登录')));
      }
      box.replaceChildren.apply(box, kids);
    };
    const off = Cloud.on(draw);
    draw();
    return box;
  }
  if (UI && UI.settingsExtra) UI.settingsExtra.data.unshift(accountPanel);

  // 主菜单右上角：账号按钮（未登录显示云图标，已登录显示头像）
  if (UI && UI.prototype.showStart) {
    const orig = UI.prototype.showStart;
    UI.prototype.showStart = function () {
      const r = orig.apply(this, arguments);
      const self = this, corner = document.querySelector('.start-corner');
      if (corner) {
        const label = state.user ? '账号与云端同步' : '登录以同步存档';
        const btn = h('button', { class: 'corner-btn cloud-btn', 'data-tip': label, 'aria-label': label, onclick: function () { self.showSettings('data'); } });
        const paint = function () {
          if (!document.contains(btn) && btn.childNodes.length) { off(); return; }
          btn.classList.toggle('signed', !!state.user);
          btn.classList.toggle('busy', state.status === 'syncing');
          btn.classList.toggle('err', !!state.user && state.status === 'error');
          btn.replaceChildren(state.user ? avatar(26) : ic('cloud'));
        };
        const off = Cloud.on(paint);
        paint();
        corner.insertBefore(btn, corner.firstChild);
      }
      return r;
    };
  }

  // 等主程序完成初始化后再启动，避免与首屏渲染争抢
  if (document.readyState === 'complete') setTimeout(boot, 0);
  else window.addEventListener('load', function () { setTimeout(boot, 0); });
})(window.CM);
