/* ============================================================
   MAR SUM Offline — Mekanik submit + Create + Approval (incl. Override)
   Prinsip: CACHE → ANTRE → SINKRON. Server selalu benar.
   Adaptasi SUM: tanpa section/scope, tanpa job katalog, part_type wajib,
   MTBF mati, foreman create-only, override L1/L2 (parity web).
   ============================================================ */

var CONFIG = { API_URL: 'https://script.google.com/macros/s/AKfycbzB5EUJlpGRaDTFvfr3bl117hd_Oa2k4seCecTYy4Ct8_oYRefu8U9BqG6zu3M-BoFS/exec' };
var APP_VERSION = 'sum-v32'; // cadangan; nilai sebenarnya dibaca dari CACHE sw.js (syncVersionFromCache)
var S = { mechTab:'assigned', token:null, me:null, role:null, wos:[], refs:null, refsAt:null, pending:[], active:[], approved:[], outbox:[], lastSync:null, syncing:false, tab:'wos', appSub:'pending', showOutbox:false, timerStates:{} };
// Referensi kecil (komponen/unit/mekanik) — tarik ulang maks 1x/12 jam.
// Katalog SUM kecil (±148 komponen, 47 unit) — menariknya murah, jadi tak perlu
// ditahan lama. Angka 12 jam dulu ikut terbawa dari KMB yang katalognya ±1.400
// pekerjaan. Akibatnya perubahan target_hours di spreadsheet baru terlihat di HP
// setengah hari kemudian — padahal target_hours menentukan faktor ketepatan
// waktu, yang menentukan poin dan rupiah.
var REFS_TTL_MS = 15*60*1000;
function refsStale() { return !S.refs || !S.refsAt || (Date.now() - new Date(S.refsAt).getTime() > REFS_TTL_MS); }
var db = null;
// Urutan enqueue dalam sesi — jaminan FIFO saat flush (override HARUS sebelum approve).
var _enqSeq = 0;

/* ── Live Timer Engine (Parity MAR-SUM-v2) ── */
var _liveTimerTicker = null;
function getTimerState(woId) {
  if (!S.timerStates) S.timerStates = {};
  if (!S.timerStates[woId]) {
    S.timerStates[woId] = { state: 'idle', start_epoch: 0, elapsed_ms: 0 };
  }
  return S.timerStates[woId];
}
function saveTimerState(woId, state) {
  if (!S.timerStates) S.timerStates = {};
  S.timerStates[woId] = state;
  kvSet('timer_states', S.timerStates);
}
/**
 * Jeda semua WO lain yang masih berjalan milik orang ini.
 * JALUR UANG: tanpa ini, dua timer bisa jalan bersamaan → jam kerja dobel-hitung
 * → poin & rupiah salah. Waktu WO yang dijeda tetap tersimpan utuh.
 * @return {Array} daftar woId yang barusan dijeda
 */
function pauseOtherRunningTimers(currentWoId) {
  var paused = [];
  if (!S.timerStates) return paused;
  for (var id in S.timerStates) {
    if (!S.timerStates.hasOwnProperty(id)) continue;
    if (String(id) === String(currentWoId)) continue;
    var st = S.timerStates[id];
    if (!st || st.state !== 'running') continue;
    st.elapsed_ms = (parseFloat(st.elapsed_ms) || 0) + (Date.now() - (parseFloat(st.start_epoch) || Date.now()));
    st.state = 'paused';
    st.start_epoch = 0;
    S.timerStates[id] = st;
    paused.push(id);
  }
  if (paused.length) kvSet('timer_states', S.timerStates);
  return paused;
}

function startLiveTimer(woId) {
  var autoPaused = pauseOtherRunningTimers(woId);   // hanya SATU WO boleh berjalan
  var st = getTimerState(woId);
  st.state = 'running';
  st.start_epoch = Date.now();
  saveTimerState(woId, st);
  startTimerTicker();
  renderAll();
  if (autoPaused.length) toast('⏸ ' + autoPaused.length + ' WO lain otomatis dijeda (waktunya tersimpan)');
}
function pauseLiveTimer(woId) {
  var st = getTimerState(woId);
  if (st.state !== 'running') return;
  st.state = 'paused';
  st.elapsed_ms += (Date.now() - st.start_epoch);
  st.start_epoch = 0;
  saveTimerState(woId, st);
  renderAll();
}
/**
 * Hentikan timer TANPA menghapus waktunya.
 * PENTING (jalur uang): dulu elapsed langsung di-nol-kan di sini, jadi kalau mekanik
 * menutup form tanpa submit, jam kerjanya HILANG. Sekarang waktu disimpan sebagai
 * 'paused' dan baru benar-benar dibersihkan setelah submit masuk antrean
 * (lihat clearTimerAfterSubmit).
 */
function stopLiveTimer(woId) {
  var st = getTimerState(woId);
  var totalMs = (parseFloat(st.elapsed_ms) || 0);
  if (st.state === 'running') totalMs += (Date.now() - (parseFloat(st.start_epoch) || Date.now()));
  st.state = 'paused';
  st.elapsed_ms = totalMs;   // ← waktu DIPERTAHANKAN
  st.start_epoch = 0;
  saveTimerState(woId, st);
  renderAll();
  return totalMs;
}

/** Bersihkan timer HANYA setelah pekerjaan benar-benar masuk antrean kirim. */
function clearTimerAfterSubmit(woId) {
  saveTimerState(woId, { state: 'idle', start_epoch: 0, elapsed_ms: 0 });
  renderAll();
}

/** Ringkasan durasi (jam & menit) — ditampilkan setelah Stop. */
function msToJamMenit(ms) {
  var tot = Math.round((parseFloat(ms) || 0) / 60000);
  var j = Math.floor(tot / 60), m = tot % 60;
  if (j > 0 && m > 0) return j + ' jam ' + m + ' menit';
  if (j > 0) return j + ' jam';
  return m + ' menit';
}

/** Tampilkan kotak kesimpulan waktu pengerjaan di modal isi kerja. */
function showTimerSummary(totalMs, startD, endD) {
  var box = document.getElementById('fTimerSummary');
  if (!box) return;
  if (!totalMs || totalMs <= 0) { box.style.display = 'none'; box.innerHTML = ''; return; }
  box.style.display = 'block';
  box.innerHTML = '✅ Total waktu pengerjaan: <b>' + msToJamMenit(totalMs) + '</b>' +
    '<div style="font-weight:600;font-size:11px;margin-top:3px;opacity:.85">' +
    formatToDatetimeLocal(startD).replace('T', ' ') + ' → ' + formatToDatetimeLocal(endD).replace('T', ' ') + '</div>';
}
function formatMsToHms(ms) {
  if (!ms || ms < 0) return '00:00:00';
  var sec = Math.floor(ms / 1000);
  var hr = Math.floor(sec / 3600);
  var min = Math.floor((sec - (hr * 3600)) / 60);
  sec = sec - (hr * 3600) - (min * 60);
  if (hr < 10) hr = '0' + hr;
  if (min < 10) min = '0' + min;
  if (sec < 10) sec = '0' + sec;
  return hr + ':' + min + ':' + sec;
}
function formatToDatetimeLocal(date) {
  var pad = function(n) { return (n < 10 ? '0' : '') + n; };
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) +
    'T' + pad(date.getHours()) + ':' + pad(date.getMinutes());
}
function startTimerTicker() {
  if (_liveTimerTicker) return;
  _liveTimerTicker = setInterval(function() {
    var hasRunning = false;
    if (S.timerStates) {
      for (var id in S.timerStates) {
        if (S.timerStates[id] && S.timerStates[id].state === 'running') {
          hasRunning = true;
          break;
        }
      }
    }
    if (hasRunning) updateActiveTimerDisplays();
  }, 1000);
}
function updateActiveTimerDisplays() {
  if (S.timerStates) {
    for (var woId in S.timerStates) {
      var st = S.timerStates[woId];
      if (!st) continue;
      var curMs = st.elapsed_ms + (st.state === 'running' ? (Date.now() - st.start_epoch) : 0);
      var cardDisp = document.getElementById('timer-clock-' + woId);
      if (cardDisp) cardDisp.textContent = formatMsToHms(curMs);
      if (activeWo && String(activeWo.id) === String(woId)) {
        var mDisp = document.getElementById('modalTimerDisplay');
        if (mDisp) mDisp.textContent = formatMsToHms(curMs);
      }
    }
  }
}
function updateModalTimerUI() {
  if (!activeWo) return;
  var st = getTimerState(activeWo.id);
  var disp = document.getElementById('modalTimerDisplay');
  var bStart = document.getElementById('modalBtnStart');
  var bPause = document.getElementById('modalBtnPause');
  var bStop = document.getElementById('modalBtnStop');
  if (!disp) return;

  var curMs = st.elapsed_ms + (st.state === 'running' ? (Date.now() - st.start_epoch) : 0);
  disp.textContent = formatMsToHms(curMs);

  if (st.state === 'idle') {
    bStart.style.display = 'inline-block'; bStart.textContent = '▶ Start';
    bPause.style.display = 'none';
    bStop.style.display = 'none';
  } else if (st.state === 'running') {
    bStart.style.display = 'none';
    bPause.style.display = 'inline-block';
    bStop.style.display = 'inline-block';
  } else if (st.state === 'paused') {
    bStart.style.display = 'inline-block'; bStart.textContent = '▶ Resume';
    bPause.style.display = 'none';
    bStop.style.display = 'inline-block';
  }
}
function modalTimerStart() {
  if (!activeWo) return;
  startLiveTimer(activeWo.id);
  updateModalTimerUI();
}
function modalTimerPause() {
  if (!activeWo) return;
  pauseLiveTimer(activeWo.id);
  updateModalTimerUI();
}
function modalTimerStop() {
  if (!activeWo) return;
  var cur = getTimerState(activeWo.id);
  var preview = (parseFloat(cur.elapsed_ms) || 0) + (cur.state === 'running' ? (Date.now() - cur.start_epoch) : 0);
  if (preview > 0 && preview < 60000 &&
      !confirm('Durasi kerja baru ' + msToJamMenit(preview) + '.\nYakin hentikan timer dan pakai durasi ini?')) return;
  var totalMs = stopLiveTimer(activeWo.id);
  if (totalMs > 0) {
    var now = new Date();
    var start = new Date(now.getTime() - totalMs);
    document.getElementById('fStart').value = formatToDatetimeLocal(start);
    document.getElementById('fEnd').value = formatToDatetimeLocal(now);
    showTimerSummary(totalMs, start, now);   // kesimpulan: X jam Y menit
  }
  updateModalTimerUI();
}
function openSubmitWithTimer(woId) {
  var totalMs = stopLiveTimer(woId);
  openSubmitForm(woId);
  if (totalMs > 0) {
    var now = new Date();
    var start = new Date(now.getTime() - totalMs);
    document.getElementById('fStart').value = formatToDatetimeLocal(start);
    document.getElementById('fEnd').value = formatToDatetimeLocal(now);
    showTimerSummary(totalMs, start, now);
  }
}

/* ── IndexedDB ── */
function openDb() {
  return new Promise(function(res,rej) {
    var r = indexedDB.open('mar_sum_v1',1);
    r.onupgradeneeded = function(e) {
      var d = e.target.result;
      if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
      if (!d.objectStoreNames.contains('outbox')) d.createObjectStore('outbox',{keyPath:'op_id'});
    };
    r.onsuccess = function() { db = r.result; res(); };
    r.onerror = function() { rej(r.error); };
  });
}
function idbReq(store,mode,fn) {
  return new Promise(function(res,rej) {
    var tx = db.transaction(store,mode);
    var rq = fn(tx.objectStore(store));
    rq.onsuccess = function() { res(rq.result); };
    rq.onerror = function() { rej(rq.error); };
  });
}
function kvGet(k) { return idbReq('kv','readonly',function(s){return s.get(k);}); }
function kvSet(k,v) { return idbReq('kv','readwrite',function(s){return s.put(v,k);}); }
function obAll() { return idbReq('outbox','readonly',function(s){return s.getAll();}); }
function obPut(item) { return idbReq('outbox','readwrite',function(s){return s.put(item);}); }
function obDel(opId) { return idbReq('outbox','readwrite',function(s){return s.delete(opId);}); }
function uuid() { return (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : 'op-' + Date.now() + '-' + Math.random().toString(36).slice(2,10); }

/* ── API ── */
/** Token dicabut/kadaluwarsa di server → kembalikan user ke layar login. */
function handleTokenRejected() {
  toast('🔒 Token tidak berlaku lagi — silakan masuk ulang');
  S.token = null;
  kvSet('token', null);
  setLoginLoading(false);
  showScreen('login');
}

function api(action,data,opId) {
  var body = JSON.stringify({token:S.token, action:action, data:data||{}, op_id:opId||undefined});
  return fetch(CONFIG.API_URL, {method:'POST', headers:{'Content-Type':'text/plain'}, body:body})
    .then(function(r){return r.json();})
    .then(function(j){
      if (j && j.success === false && typeof j.error === 'string' && /token tidak dikenal|token tidak berlaku|nonaktif/i.test(j.error)) {
        handleTokenRejected();
      }
      return j;
    });
}

/* ── Install PWA ── */
var IS_IOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
var IS_STANDALONE = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
var _installPrompt = null;
window.addEventListener('beforeinstallprompt', function(e) {
  e.preventDefault();
  _installPrompt = e;
  var b = document.getElementById('installBtn'); if (b) b.style.display = '';
});
window.addEventListener('appinstalled', function() {
  _installPrompt = null;
  var b = document.getElementById('installBtn'); if (b) b.style.display = 'none';
  toast('✅ Terinstal! Buka dari ikon MAR SUM di layar utama.');
});
function doInstall() {
  if (IS_IOS) { showModal('iosModal'); return; }
  if (!_installPrompt) { toast('Buka menu Chrome ⋮ → "Instal aplikasi" / "Tambahkan ke layar utama"'); return; }
  _installPrompt.prompt();
  _installPrompt.userChoice.then(function(){ _installPrompt = null; });
}

/* ── Notifikasi ── */
function requestNotifPermission() {
  try { if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission(); } catch (e) {}
}
function notifyLocal(body) {
  try {
    if ('Notification' in window && Notification.permission === 'granted' && 'serviceWorker' in navigator) {
      navigator.serviceWorker.ready.then(function(reg){ return reg.showNotification('MAR SUM', {body: body, icon: './icon-192.png', badge: './icon-192.png', tag: 'mar-info'}); }).catch(function(){});
    }
  } catch (e) {}
}
function requestPeriodicSync() {
  try {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.ready.then(function(reg) {
        if ('periodicSync' in reg) return reg.periodicSync.register('mar-check', {minInterval: 60 * 60 * 1000});
      }).catch(function(){});
    }
  } catch (e) {}
}

/* ── Web Push: daftarkan "alamat pos" HP ini ke server (idempotent).
   Aktif hanya bila server sudah expose get_vapid_key (PushService). ── */
function _urlB64ToUint8(b64) {
  var pad = new Array((4 - (b64.length % 4)) % 4 + 1).join('=');
  var base = (b64 + pad).replace(/-/g, '+').replace(/_/g, '/');
  var raw = atob(base);
  var arr = new Uint8Array(raw.length);
  for (var i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}
function subscribePush() {
  try {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    if (!S.token) return;
    navigator.serviceWorker.ready.then(function(reg) {
      return reg.pushManager.getSubscription().then(function(sub) {
        if (sub) return sub;
        return api('get_vapid_key').then(function(r) {
          if (!r.success || !r.result || !r.result.key) return null;
          return reg.pushManager.subscribe({userVisibleOnly: true, applicationServerKey: _urlB64ToUint8(r.result.key)});
        });
      });
    }).then(function(sub) {
      if (!sub) return;
      var j = sub.toJSON();
      return kvGet('push_saved').then(function(saved) {
        if (saved === j.endpoint) return;
        return api('save_push_sub', {endpoint: j.endpoint, p256dh: (j.keys && j.keys.p256dh) || '', auth: (j.keys && j.keys.auth) || ''})
          .then(function(r2) { if (r2.success) return kvSet('push_saved', j.endpoint); });
      });
    }).catch(function(){});
  } catch (e) {}
}

/* ── Background Sync ── */
function requestBgSync() {
  try {
    if ('serviceWorker' in navigator && 'SyncManager' in window) {
      navigator.serviceWorker.ready.then(function(reg){ return reg.sync.register('mar-outbox'); }).catch(function(){});
    }
  } catch (e) {}
}

/* ── Sync ── */
/** Indikator progres pengiriman antrean, mis. "📤 Mengirim 2/5 · L2 WO-123". */
function showSendProgress(idx, total, op) {
  var el = document.getElementById('outboxInfo');
  if (!el) return;
  var label = op ? (opLabel(op) || '') : '';
  el.textContent = '📤 Mengirim ' + idx + '/' + total + (label ? ' · ' + label : '') + '…';
  el.style.color = '#1e40af';
}

var _syncAgain = false;   // ada permintaan sync yang datang saat sync sedang jalan
function syncNow(manual) {
  // JANGAN buang permintaan ini (dulu: langsung return → approve ke-2 dst menggantung
  // sampai user menekan Sync manual). Tandai, lalu jalankan otomatis setelah selesai.
  if (S.syncing) { _syncAgain = true; return Promise.resolve(); }
  if (manual) requestNotifPermission();
  if (!navigator.onLine) { requestBgSync(); if (manual) toast('📴 Offline — tersimpan, Mengirim… otomatis saat ada sinyal'); renderAll(); return Promise.resolve(); }
  S.syncing = true; renderAll();
  return flushOutbox()
    .then(function(sent) {
      if (sent > 0) {
        toast('✅ '+sent+' operasi terkirim — tidak lagi antre');
        if (document.hidden) notifyLocal('✅ '+sent+' operasi terkirim — tidak lagi antre');
      }
      var tasks = [];
      if (S.role === 'mechanic') { tasks.push(pullWos()); }
      else {
        // approver (L1/L2) perlu antrean approval + aktif; foreman cukup refs utk Buat WO
        // pullApproved ikut sinkron sejak daftarnya dibatasi bulan berjalan (puluhan
        // baris, bukan ribuan lagi). Tanpa ini daftar Approved tak pernah diperbarui:
        // dulu hanya ditarik saat sub-tab dibuka DAN daftarnya kosong, jadi salinan
        // lama di IndexedDB bertahan selamanya walau server sudah menyaring.
        if (S.role === 'supervisor' || S.role === 'superintendent' || S.role === 'foreman_approver') { tasks.push(pullPending()); tasks.push(pullActive()); tasks.push(pullApproved()); }
        else if (S.role === 'foreman') { tasks.push(pullActive()); }   // foreman: pantau WO aktif
        // Sync yang DITEKAN pemakai selalu menarik katalog & daftar mekanik, tanpa
        // peduli TTL — menekan Sync berarti "ambil yang terbaru", dan itu satu-satunya
        // cara pemakai memaksa perubahan spreadsheet turun ke HP-nya.
        if (manual) tasks.push(pullRefs(true));
        else if (refsStale()) tasks.push(pullRefs());
      }
      return Promise.all(tasks);
    })
    .then(function() { S.lastSync = new Date().toISOString(); subscribePush(); return kvSet('last_sync',S.lastSync); })
    .catch(function(e) { requestBgSync(); toast('⚠️ Sync gagal: '+e.message); })
    .then(function() { S.syncing = false; return refreshOutbox(); })
    .then(function() {
      renderAll();
      if (_syncAgain) { _syncAgain = false; return syncNow(false); }   // kirim sisa antrean
    });
}
function flushOutbox() {
  var sent = 0;
  return obAll().then(function(items) {
    var queue = items.filter(function(it){return it.status==='queued'||it.status==='failed_retry';});
    // FIFO: getAll IndexedDB terurut op_id (acak uuid) — sortir manual agar override
    // selalu terkirim SEBELUM approve WO yang sama (kalau tidak, L2 award nilai lama).
    queue.sort(function(a,b){
      var ca=String(a.created_at||''), cb=String(b.created_at||'');
      if (ca<cb) return -1; if (ca>cb) return 1;
      return (a.seq||0)-(b.seq||0);
    });
    var _total = queue.length, _idx = 0;
    var chain = Promise.resolve();
    queue.forEach(function(it) {
      chain = chain.then(function() {
        _idx++;
        showSendProgress(_idx, _total, it);   // "Mengirim 2/5 · L2 WO-xxx"
        return api(it.action, it.payload, it.op_id).then(function(r) {
          if (r.success) {
            it.status='done'; it.result=r.result; sent++;
            majukanStatusLokal(it);   // badge langsung ke tahap berikutnya
          }
          else { it.status='failed'; it.error=(typeof r.error==='string')?r.error:JSON.stringify(r.error); }
          return obPut(it).then(function(){ return refreshOutbox(); }).then(function(){ renderAll(); });
        }).catch(function() { return obPut(it).then(function(){throw new Error('koneksi terputus');}); });
      });
    });
    return chain.then(function(){ return sent; });
  });
}
function pullWos() {
  return api('pull_my_wos').then(function(r) {
    if (!r.success) return;
    S.wos = (r.result && r.result.wos) || [];
    return kvSet('wos', S.wos);
  });
}
/**
 * @param {boolean} paksaSegar - true saat Sync DITEKAN pemakai: server diminta
 *   membuang cache konfigurasinya dulu, sehingga perubahan base_points /
 *   target_hours / daftar mekanik yang baru diketik di spreadsheet ikut terbawa.
 *   Sync otomatis memakai jalur biasa supaya tetap ringan.
 */
function pullRefs(paksaSegar) {
  return api('pull_create_refs', paksaSegar ? {fresh: 1} : {}).then(function(r) {
    if (!r.success) return;
    S.refs = r.result.refs;
    S.refsAt = new Date().toISOString();
    return kvSet('refs', S.refs).then(function(){ return kvSet('refs_at', S.refsAt); });
  });
}
function pullPending() {
  return api('pull_pending').then(function(r) {
    if (!r.success) return;
    S.pending = (r.result && r.result.pending) || [];
    return kvSet('pending', S.pending);
  });
}
function pullActive() {
  return api('pull_active').then(function(r) {
    if (!r.success) return;
    S.active = (r.result && r.result.active) || [];
    return kvSet('active', S.active);
  });
}
function pullApproved() {
  return api('pull_approved').then(function(r) {
    if (!r.success) return;
    S.approved = (r.result && r.result.approved) || [];
    return kvSet('approved', S.approved);
  });
}
function refreshOutbox() { return obAll().then(function(o){S.outbox=o||[];}); }

/* ── Login ── */
function setLoginLoading(on) {
  var b = document.getElementById('btnLogin'), l = document.getElementById('loginLoading');
  if (b) { b.disabled = !!on; b.textContent = on ? 'Memeriksa…' : 'Masuk'; }
  if (l) l.style.display = on ? 'block' : 'none';
}

function doLogin() {
  var t = document.getElementById('tokenInput').value.trim();
  if (!t) { toast('Isi token dulu'); return; }
  requestNotifPermission(); requestPeriodicSync();
  S.token = t;
  setLoginLoading(true);
  if (navigator.onLine) {
    api('ping').then(function(r) {
      if (r.success) {
        S.me = r.result;
        S.role = (r.result && r.result.role) ? r.result.role : 'mechanic';
        return kvSet('token',t).then(function() { return kvSet('me',S.me); })
          .then(function() { return kvSet('role',S.role); })
          .then(function() {
            // Non-mekanik (foreman/approver) perlu refs utk Buat WO.
            if (S.role !== 'mechanic') return pullRefs().catch(function(){});
          })
          .then(function() { showScreen('main'); syncNow(false); });
      } else { setLoginLoading(false); toast('❌ '+(r.error||'Token ditolak')); S.token=null; }
    }).catch(function() { setLoginLoading(false); saveTokenOffline(t); });
  } else { setLoginLoading(false); saveTokenOffline(t); }
}
function saveTokenOffline(t) {
  kvSet('token',t).then(function() { toast('📴 Token disimpan — verifikasi saat ada sinyal'); showScreen('main'); renderAll(); });
}
function doLogout() {
  var pend = S.outbox.filter(function(o){return o.status==='queued'||o.status==='failed_retry';}).length;
  var msg = pend > 0
    ? '⚠️ PERHATIAN: masih ada '+pend+' operasi BELUM TERKIRIM di antrean.\nLogout akan MENGHAPUS antrean itu PERMANEN (laporan/approval hilang).\n\nSaran: batal, cari sinyal, tekan 🔄 Refresh sampai antrean kosong, baru logout.\n\nTetap logout dan hapus antrean?'
    : 'Logout? Data lokal akan dihapus.';
  if (!confirm(msg)) return;
  var tx = db.transaction(['kv','outbox'],'readwrite');
  tx.objectStore('kv').clear();
  tx.objectStore('outbox').clear();
  tx.oncomplete = function() {
    S = { token:null, me:null, role:null, wos:[], refs:null, refsAt:null, pending:[], active:[], approved:[], outbox:[], lastSync:null, syncing:false, tab:'wos', appSub:'pending', showOutbox:false };
    showScreen('login');
  };
}

/* ── Tab ── */
function switchTab(tab) {
  S.tab = tab;
  renderAll();
  // Tab WO Aktif: kalau datanya belum ada (mis. foreman baru login), tarik sekarang
  if (tab === 'active' && navigator.onLine && (!S.active || !S.active.length)) {
    toast('⏳ Memuat WO aktif…');
    pullActive().then(function(){ renderAll(); }).catch(function(){ toast('⚠️ Gagal memuat WO aktif'); });
  }
}

/* ── Submit form (mekanik) ── */
var activeWo = null;
function openSubmitForm(woId) {
  activeWo = null;
  for (var i=0;i<S.wos.length;i++) if (String(S.wos[i].id)===String(woId)) activeWo=S.wos[i];
  if (!activeWo) return;
  // Kesimpulan durasi milik WO sebelumnya jangan ikut terbawa
  var _sum = document.getElementById('fTimerSummary');
  if (_sum) { _sum.style.display = 'none'; _sum.innerHTML = ''; }
  document.getElementById('fTitle').textContent = activeWo.wo_number;
  document.getElementById('fDesc').innerHTML = '<b>'+esc(activeWo.component_name||'')+'</b>'+(activeWo.unit_name?' · '+esc(activeWo.unit_name):'')+
    '<br>📍 '+esc(locLabel(activeWo.location))+' · Kondisi: '+esc(wcLabel(activeWo.work_condition))+
    (activeWo.target_hours?' · Target: '+fmtJamMenit(activeWo.target_hours):'');
  document.getElementById('fKet').textContent = activeWo.keterangan ? '📝 '+activeWo.keterangan : '';
  document.getElementById('fKet').style.display = activeWo.keterangan ? 'block' : 'none';
  document.getElementById('fStart').value=''; document.getElementById('fEnd').value='';
  document.getElementById('fHm').value=''; document.getElementById('fKm').value='';
  document.getElementById('fPart').value='';
  updateModalTimerUI();
  showModal('submitModal');
}
function queueSubmit() {
  var st=document.getElementById('fStart').value, en=document.getElementById('fEnd').value;
  var hm=parseFloat(document.getElementById('fHm').value), km=parseFloat(document.getElementById('fKm').value);
  var part=document.getElementById('fPart').value;
  if (!st||!en) { toast('Jam mulai & selesai wajib'); return; }
  if (new Date(en)<=new Date(st)) { toast('Jam selesai harus setelah mulai'); return; }
  if (isNaN(hm)||hm<=0) { toast('Hour Meter wajib > 0'); return; }
  if (isNaN(km)||km<=0) { toast('Kilometer wajib > 0'); return; }
  if (!part) { toast('Jenis part wajib dipilih'); return; } // SUM: part_type WAJIB
  // Jangan biarkan satu WO diantre dua kali. Tekanan kedua memakai op_id baru,
  // lolos dedup server, lalu ditolak karena statusnya sudah pindah.
  var _sudahAntre = (S.outbox || []).some(function(o) {
    return o.action === 'submit_work' && String(o.wo_id) === String(activeWo.id) &&
           (o.status === 'queued' || o.status === 'failed_retry');
  });
  if (_sudahAntre) {
    closeModal('submitModal');
    toast('✓ Sudah dalam antrean — tak perlu dikirim ulang');
    renderAll();
    return;
  }
  var op = { op_id:uuid(), seq:(_enqSeq++), action:'submit_work', wo_id:activeWo.id, wo_number:activeWo.wo_number,
    payload:{wo_id:activeWo.id, start_time:new Date(st).toISOString(), end_time:new Date(en).toISOString(), hour_meter:hm, kilometers:km, part_type:part},
    status:'queued', created_at:new Date().toISOString() };
  // Umpan balik SEKETIKA — jangan tunggu IndexedDB/jaringan, supaya layar tak terasa "stuck".
  closeModal('submitModal');
  toast(navigator.onLine ? '📤 Mengirim…' : '📴 Tersimpan — terkirim otomatis saat ada sinyal');
  obPut(op).then(refreshOutbox).then(function() {
    clearTimerAfterSubmit(op.wo_id);   // waktu baru dihapus SETELAH masuk antrean
    renderAll();
    syncNow(false);
  });
}

/* ── Transfer WO (Mekanik & Approver) ── */
var activeTransferWo = null;
function openTransferModal(woId) {
  activeTransferWo = null;
  for (var i=0;i<S.wos.length;i++) if (String(S.wos[i].id)===String(woId)) activeTransferWo=S.wos[i];
  if (!activeTransferWo) return;
  document.getElementById('trDesc').innerHTML = '<b>'+esc(activeTransferWo.wo_number)+'</b> — '+esc(activeTransferWo.component_name||'');
  document.getElementById('trNote').value = '';
  showModal('transferModal');
}

function queueRequestTransfer() {
  if (!activeTransferWo) return;
  var note = document.getElementById('trNote').value.trim();
  var woId = activeTransferWo.id;
  var st = getTimerState(woId);

  var sessionStart = null;
  if (st.state === 'running' || st.state === 'paused') {
    var startMs = (st.state === 'running') ? st.start_epoch : (Date.now() - st.elapsed_ms);
    sessionStart = new Date(startMs).toISOString();
    st.state = 'idle'; st.elapsed_ms = 0; st.start_epoch = 0;
    saveTimerState(woId, st);
  }

  var payload = {
    wo_id: woId,
    transfer_note: note,
    session_start_time: sessionStart
  };

  var op = {
    op_id: uuid(), seq: (_enqSeq++), action: 'request_transfer', wo_id: woId, wo_number: activeTransferWo.wo_number,
    payload: payload, status: 'queued', created_at: new Date().toISOString(), label: 'Transfer ' + activeTransferWo.wo_number
  };

  activeTransferWo.status = 'pending_transfer';

  obPut(op).then(refreshOutbox).then(function() {
    closeModal('transferModal');
    renderAll();
    toast(navigator.onLine ? '📮 Permintaan transfer dikirim...' : '📮 Permintaan transfer tersimpan di antrean!');
    syncNow(false);
  });
}

var activeTransferApproval = null;
function openApproveTransferModal(woId) {
  activeTransferApproval = null;
  for (var i = 0; i < S.pending.length; i++) {
    if (String(S.pending[i].id) === String(woId)) activeTransferApproval = S.pending[i];
  }
  if (!activeTransferApproval) return;
  var wo = activeTransferApproval;
  document.getElementById('trAppDesc').innerHTML = 'WO: <b>' + esc(wo.wo_number) + '</b><br>Diminta oleh: <b>' + esc(namaOrang(wo.transfer_requested_by_name || wo.created_by_name, wo.transfer_requested_by)) + '</b>' +
    (wo.transfer_note ? '<br>Catatan: <i>' + esc(wo.transfer_note) + '</i>' : '');
  
  var list = document.getElementById('trRecipientsList');
  list.innerHTML = '';
  addTransferRecipientRow();
  showModal('approveTransferModal');
}

function _trRecipientRow() {
  var div = document.createElement('div'); div.className = 'teamRow';
  var mechs = (S.refs && S.refs.mechanics) || [];
  var opts = '<option value="">-- Pilih Mekanik Penerima --</option>';
  for (var m = 0; m < mechs.length; m++) {
    opts += '<option value="' + esc(mechs[m].mechanic_id) + '">' + esc(mechs[m].mechanic_name) + '</option>';
  }
  div.innerHTML = '<select class="trSel inp">' + opts + '</select><button type="button" class="mini gray" onclick="this.parentNode.remove()">✕</button>';
  return div;
}

function addTransferRecipientRow() {
  var list = document.getElementById('trRecipientsList');
  if (list) list.appendChild(_trRecipientRow());
}

function queueApproveTransfer() {
  if (!activeTransferApproval) return;
  var sels = document.querySelectorAll('.trSel');
  var recipientIds = [], seen = {};
  for (var i = 0; i < sels.length; i++) {
    var val = sels[i].value;
    if (val) {
      if (seen[val]) { toast('Mekanik penerima duplikat'); return; }
      seen[val] = true;
      recipientIds.push(val);
    }
  }
  if (recipientIds.length === 0) { toast('Pilih minimal 1 mekanik penerima'); return; }

  var op = {
    op_id: uuid(), seq: (_enqSeq++), action: 'approve_transfer', wo_id: activeTransferApproval.id, wo_number: activeTransferApproval.wo_number,
    payload: { wo_id: activeTransferApproval.id, target_mechanic_ids: recipientIds },
    status: 'queued', created_at: new Date().toISOString(), label: 'Approve Transfer ' + activeTransferApproval.wo_number
  };

  obPut(op).then(refreshOutbox).then(function() {
    closeModal('approveTransferModal'); closeModal('approveModal'); renderAll();
    toast(navigator.onLine ? '📮 Approve transfer dikirim...' : '📮 Approve transfer tersimpan!');
    syncNow(false);
  });
}

function queueRejectTransfer(woId) {
  var reason = prompt('Masukkan alasan penolakan transfer:');
  if (reason === null) return;
  if (!reason.trim()) { toast('Alasan reject transfer wajib diisi'); return; }

  var wo = null;
  for (var i = 0; i < S.pending.length; i++) {
    if (String(S.pending[i].id) === String(woId)) wo = S.pending[i];
  }

  var op = {
    op_id: uuid(), seq: (_enqSeq++), action: 'reject_transfer', wo_id: woId, wo_number: wo ? wo.wo_number : woId,
    payload: { wo_id: woId, rejection_reason: reason.trim() },
    status: 'queued', created_at: new Date().toISOString(), label: 'Reject Transfer ' + (wo ? wo.wo_number : woId)
  };

  obPut(op).then(refreshOutbox).then(function() {
    closeModal('approveModal'); renderAll();
    toast(navigator.onLine ? '📮 Reject transfer dikirim...' : '📮 Reject transfer tersimpan!');
    syncNow(false);
  });
}

function queueReopenExpired(woId) {
  var wo = null;
  for (var i = 0; i < S.pending.length; i++) {
    if (String(S.pending[i].id) === String(woId)) wo = S.pending[i];
  }
  var op = {
    op_id: uuid(), seq: (_enqSeq++), action: 'reopen_expired', wo_id: woId, wo_number: wo ? wo.wo_number : woId,
    payload: { wo_id: woId },
    status: 'queued', created_at: new Date().toISOString(), label: 'Reopen Expired ' + (wo ? wo.wo_number : woId)
  };

  obPut(op).then(refreshOutbox).then(function() {
    renderAll();
    toast(navigator.onLine ? '📮 Reopen expired dikirim...' : '📮 Reopen expired tersimpan!');
    syncNow(false);
  });
}

function queueReportExpired(woId) {
  var wo = null;
  for (var i = 0; i < S.wos.length; i++) {
    if (String(S.wos[i].id) === String(woId)) wo = S.wos[i];
  }
  var op = {
    op_id: uuid(), seq: (_enqSeq++), action: 'report_expired', wo_id: woId, wo_number: wo ? wo.wo_number : woId,
    payload: { wo_id: woId },
    status: 'queued', created_at: new Date().toISOString(), label: 'Lapor Expired ' + (wo ? wo.wo_number : woId)
  };

  if (wo) wo.is_reported_expired = true;

  obPut(op).then(refreshOutbox).then(function() {
    renderAll();
    toast(navigator.onLine ? '📮 Laporan WO expired dikirim...' : '📮 Laporan WO expired tersimpan!');
    syncNow(false);
  });
}

/* ── Create WO form (SUM: component/unit/kondisi/others/team) ── */
function openCreateForm() {
  if (!S.refs) {
    if (navigator.onLine) {
      toast('⏳ Memuat data referensi...');
      pullRefs().then(function(){ if (S.refs) openCreateForm(); else toast('❌ Gagal memuat referensi'); })
        .catch(function(){ toast('❌ Gagal memuat referensi'); });
    } else { toast('📴 Refresh dulu saat ada sinyal untuk memuat referensi'); }
    return;
  }
  // Saat form Buat WO dibuka, katalog SELALU disegarkan bila ada sinyal — inilah
  // saat base_points & target_hours benar-benar menentukan uang, jadi tak boleh
  // memakai salinan lama. Dropdown diisi ulang setelah data tiba.
  if (navigator.onLine) {
    pullRefs().then(function() {
      var cat = document.getElementById('cCat');
      var catLama = cat ? cat.value : '';
      fillCategoryOptions();
      if (cat && catLama) { cat.value = catLama; onCatChange(); }
    }).catch(function(){});
  }
  // Pekerjaan: KATEGORI dulu → komponen ter-filter (cascading, sama seperti web).
  // Komponen bisa ratusan; memilih kategori dulu membuat daftar jauh lebih ringkas.
  fillCategoryOptions();
  document.getElementById('cCat').value = '';
  document.getElementById('cComp').innerHTML = '<option value="">-- Pilih Kategori Dulu --</option>';
  // Unit
  var uSel = document.getElementById('cUnit');
  uSel.innerHTML = '<option value="">-- Pilih Unit --</option>';
  var units = S.refs.units || [];
  for (var ui=0;ui<units.length;ui++) uSel.innerHTML += '<option value="'+esc(units[ui].unit_id)+'">'+esc(units[ui].unit_name)+' ('+esc(units[ui].unit_type)+')</option>';
  // Work condition (fallback label SUM)
  var wcEl = document.getElementById('cWc'); wcEl.innerHTML='';
  var wcs = (S.refs && S.refs.work_conditions && S.refs.work_conditions.length)
    ? S.refs.work_conditions
    : [{key:'normal',label:'Normal'},{key:'difficult',label:'Malam/Hujan'},{key:'extreme',label:'Resiko Tinggi'}];
  for (var wi=0;wi<wcs.length;wi++) wcEl.innerHTML += '<option value="'+esc(wcs[wi].key||wcs[wi].value||wcs[wi])+'">'+esc(wcs[wi].label||wcs[wi])+'</option>';
  // reset
  document.getElementById('cLoc').value='workshop';
  document.getElementById('cKet').value='';
  ['cOthersDesc','cOthersBp','cOthersTh','cOthersUf'].forEach(function(id){ var el=document.getElementById(id); if(el) el.value=''; });
  document.getElementById('cOthersWrap').style.display='none';
  document.getElementById('cUnitWrap').style.display='block';
  document.getElementById('cTeamList').innerHTML='';
  addTeamMember();
  document.getElementById('cPreview').style.display='none';
  showModal('createModal');
}
/** Isi dropdown KATEGORI (dedup dari Config_Components) + opsi Others. */
function fillCategoryOptions() {
  var sel = document.getElementById('cCat');
  if (!sel) return;
  var comps = (S.refs && S.refs.components) || [];
  var cats = [], hasOthers = false;
  for (var i = 0; i < comps.length; i++) {
    if (String(comps[i].component_no) === 'COM-OTHERS') { hasOthers = true; continue; }
    var c = String(comps[i].category || 'General').trim();
    if (cats.indexOf(c) === -1) cats.push(c);
  }
  cats.sort();
  var html = '<option value="">-- Pilih Kategori Pekerjaan --</option>';
  for (var k = 0; k < cats.length; k++) html += '<option value="'+esc(cats[k])+'">'+esc(cats[k])+'</option>';
  if (hasOthers) html += '<option value="OTHERS">━━━ OTHERS / Custom Job ━━━</option>';
  sel.innerHTML = html;
}

/** Kategori dipilih → isi dropdown komponen sesuai kategori itu (cascading, 1:1 web). */
function onCatChange() {
  var cat = document.getElementById('cCat').value;
  var sel = document.getElementById('cComp');
  var comps = (S.refs && S.refs.components) || [];
  var html = '<option value="">-- Pilih Component / Pekerjaan --</option>';
  if (cat === 'OTHERS') {
    html += '<option value="COM-OTHERS">OTHERS - Custom Job</option>';
  } else if (cat) {
    for (var i = 0; i < comps.length; i++) {
      var c = comps[i];
      if (String(c.component_no) === 'COM-OTHERS') continue;
      if (String(c.category || 'General').trim().toLowerCase() !== cat.toLowerCase()) continue;
      html += '<option value="'+esc(c.component_no)+'">('+esc(c.component_no)+') '+esc(c.component_name)+'</option>';
    }
  }
  sel.innerHTML = html;
  onCompChange();
}

function onCompChange() {
  var isOthers = document.getElementById('cComp').value === 'COM-OTHERS';
  document.getElementById('cOthersWrap').style.display = isOthers ? 'block' : 'none';
  document.getElementById('cUnitWrap').style.display = isOthers ? 'none' : 'block';
  updateCreatePreview();
}
function updateCreatePreview(){
  var box=document.getElementById('cPreview'); if(!box) return;
  var isOthers = document.getElementById('cComp').value === 'COM-OTHERS';
  var bp=null, ph=null, uf=1.0, name='';
  if (isOthers) {
    bp=parseFloat(document.getElementById('cOthersBp').value)||0;
    ph=parseFloat(document.getElementById('cOthersTh').value)||0;
    uf=parseFloat(document.getElementById('cOthersUf').value)||0;
    name=document.getElementById('cOthersDesc').value||'Others';
  } else {
    var cv=document.getElementById('cComp').value;
    var comps=(S.refs&&S.refs.components)||[];
    for(var i=0;i<comps.length;i++){ if(String(comps[i].component_no)===cv){ bp=parseFloat(comps[i].base_points)||0; ph=parseFloat(comps[i].target_hours)||0; name=comps[i].component_name; break; } }
    var uv=document.getElementById('cUnit').value; var units=(S.refs&&S.refs.units)||[];
    for(var u=0;u<units.length;u++){ if(String(units[u].unit_id)===uv){ uf=parseFloat(units[u].unit_factor)||1.0; break; } }
  }
  if (bp===null && ph===null) { box.style.display='none'; return; }
  var wcSel=document.getElementById('cWc'); var wcOpt=wcSel.options[wcSel.selectedIndex];
  document.getElementById('cPreviewBody').innerHTML =
    '<b>'+esc(name||'-')+'</b><br>Base Points: '+(bp||0)+' · Target: '+(ph||0)+' jam<br>Unit Factor: '+(uf||1)+' 🔒 · Kondisi: '+esc(wcOpt?wcOpt.textContent:'-');
  box.style.display='block';
}
function refreshCreateMechanics() {
  var mechs = S.refs ? (S.refs.mechanics||[]) : [];
  var rows = document.querySelectorAll('.cTeamSel');
  for (var r=0;r<rows.length;r++) {
    var cur = rows[r].value;
    rows[r].innerHTML = '<option value="">-- Pilih Mekanik --</option>';
    for (var m=0;m<mechs.length;m++) {
      var jab = mechs[m].jabatan_aktual ? (' · '+mechs[m].jabatan_aktual) : '';
      rows[r].innerHTML += '<option value="'+esc(mechs[m].mechanic_id)+'">'+esc(mechs[m].mechanic_name)+esc(jab)+'</option>';
    }
    rows[r].value = cur;
  }
}
function addTeamMember() {
  var div = document.createElement('div'); div.className = 'teamRow';
  div.innerHTML = '<select class="cTeamSel inp"></select><button type="button" class="mini gray" onclick="this.parentNode.remove()">✕</button>';
  document.getElementById('cTeamList').appendChild(div);
  refreshCreateMechanics();
}
function queueCreate(keepOpen) {
  var comp = document.getElementById('cComp').value;
  var wc = document.getElementById('cWc').value;
  if (!comp) { toast('Pilih pekerjaan'); return; }
  if (!wc) { toast('Pilih work condition'); return; }
  var payload = { work_condition:wc, keterangan:document.getElementById('cKet').value.trim(), location:document.getElementById('cLoc').value||'workshop' };
  if (comp === 'COM-OTHERS') {
    var odesc = document.getElementById('cOthersDesc').value.trim();
    var obp = parseFloat(document.getElementById('cOthersBp').value);
    var oth = parseFloat(document.getElementById('cOthersTh').value);
    var ouf = parseFloat(document.getElementById('cOthersUf').value);
    if (!odesc) { toast('Deskripsi job Others wajib diisi'); return; }
    if (isNaN(obp) || obp <= 0) { toast('Base points Others wajib > 0'); return; }
    if (isNaN(oth) || oth <= 0) { toast('Target hours Others wajib > 0'); return; }
    if (isNaN(ouf) || ouf <= 0) { toast('Unit factor Others wajib > 0'); return; }
    payload.component_id = 'COM-OTHERS';
    payload.others_description = odesc; payload.others_base_points = obp; payload.others_target_hours = oth; payload.others_unit_factor = ouf;
  } else {
    var unit = document.getElementById('cUnit').value;
    if (!unit) { toast('Pilih unit'); return; }
    payload.component_id = comp; payload.unit_id = unit;
  }
  var sels = document.querySelectorAll('.cTeamSel');
  var team=[],seen={};
  for (var i=0;i<sels.length;i++) {
    var mid = sels[i].value;
    if (!mid) continue;
    if (seen[mid]) { toast('Mekanik duplikat'); return; }
    seen[mid]=true; team.push({mechanic_id:mid});
  }
  if (!team.length) { toast('Tambah minimal 1 mekanik'); return; }
  payload.team = team;
  var op = { op_id:uuid(), seq:(_enqSeq++), action:'create_wo', payload:payload, status:'queued', created_at:new Date().toISOString(), label:'Buat WO' };
  obPut(op).then(refreshOutbox).then(function() {
    renderAll();
    if (keepOpen) {
      resetCreateFieldsForNext();
      toast('📮 WO diantre — isi WO berikutnya (kondisi & lokasi dipertahankan)');
    } else {
      closeModal('createModal');
      toast(navigator.onLine?'📮 Mengirim...':'📮 Mengirim…');
    }
    syncNow(false);
  });
}
function resetCreateFieldsForNext(){
  document.getElementById('cCat').value='';
  document.getElementById('cComp').innerHTML='<option value="">-- Pilih Kategori Dulu --</option>';
  document.getElementById('cComp').value='';
  document.getElementById('cKet').value='';
  ['cOthersDesc','cOthersBp','cOthersTh','cOthersUf'].forEach(function(id){ var el=document.getElementById(id); if(el) el.value=''; });
  document.getElementById('cOthersWrap').style.display='none';
  document.getElementById('cUnitWrap').style.display='block';
  document.getElementById('cUnit').value='';
  document.getElementById('cTeamList').innerHTML='';
  addTeamMember();
  document.getElementById('cPreview').style.display='none';
}

/* ── Approval + Override + Cancel ── */
var activeApproval = null;
var cancelWoId = null;
function openCancelForm(woId, woNumber){
  cancelWoId = woId;
  document.getElementById('cxDesc').textContent = woNumber || woId;
  document.getElementById('cxReason').value = '';
  showModal('cancelModal');
}
function queueCancel(){
  var reason = document.getElementById('cxReason').value.trim();
  if (!reason) { toast('Isi alasan pembatalan'); return; }
  var woNum = document.getElementById('cxDesc').textContent;
  var op = { op_id:uuid(), seq:(_enqSeq++), action:'cancel_wo', wo_id:cancelWoId, wo_number:woNum,
    payload:{ wo_id:cancelWoId, reason:reason }, status:'queued', created_at:new Date().toISOString(), label:'Batal '+woNum };
  obPut(op).then(refreshOutbox).then(function(){
    closeModal('cancelModal'); closeModal('approveModal'); renderAll();
    toast(navigator.onLine?'📮 Mengirim...':'📮 Tersimpan!');
    syncNow(false);
  });
}
function openApproveForm(woId) {
  activeApproval = null;
  for (var i=0;i<S.pending.length;i++) if (String(S.pending[i].id)===String(woId)) activeApproval=S.pending[i];
  if (!activeApproval) return;
  var a = activeApproval;
  document.getElementById('aTitle').textContent = a.wo_number;
  var atl = a.timeliness;
  document.getElementById('aDesc').innerHTML = '<b>'+esc(a.component_name||'-')+'</b>'+(a.is_others?' <span class="badge" style="background:#0ea5e9">OTHERS</span>':'')+'<br>'+
    (a.unit_name?'🚜 '+esc(a.unit_name)+'<br>':'')+
    '📍 Lokasi: '+esc(locLabel(a.location))+'<br>'+
    'Kondisi: '+esc(wcLabel(a.work_condition))+'<br>'+
    'Base Points: '+(a.base_points||0)+' pts<br>'+
    'Target: '+fmtJamMenit(a.target_hours)+' · Aktual: '+fmtJamMenit(a.actual_hours)+
    (atl ? ' ('+esc(atl.label)+' ×'+atl.factor+')' : '')+'<br>'+
    'Unit Factor: '+(a.unit_factor||1)+' 🔒<br>'+
    '🔧 Part: '+esc(partLabel(a.part_type))+
    (a.hour_meter ? '<br>HM: '+esc(a.hour_meter) : '')+(a.kilometers ? ' · KM: '+esc(a.kilometers) : '')+
    ((a.created_by_name||a.created_by) ? '<br>👤 Pembuat: '+esc(namaOrang(a.created_by_name, a.created_by)) : '')+
    ((a.submitted_by_name||a.submitted_by) ? '<br>✍️ Disubmit oleh: '+esc(namaOrang(a.submitted_by_name, a.submitted_by)) : '')+
    (a.keterangan ? '<br>📝 '+esc(a.keterangan) : '');
  document.getElementById('aTeam').textContent = 'Tim: '+(a.team||[]).map(function(t){return t.name;}).join(', ');
  document.getElementById('aStatus').textContent = 'Status: '+a.status;
  var isL2 = (a.status === 'pending_superintendent');
  document.getElementById('aBtnL1').style.display = isL2 ? 'none' : 'block';
  document.getElementById('aBtnL2').style.display = isL2 ? 'block' : 'none';
  document.getElementById('aNotes').value='';
  document.getElementById('aSafety').checked = false;
  document.getElementById('aOvBp').value='';
  // Override WAKTU KERJA: prefill dari jam aktual WO (hasil timer mekanik)
  document.getElementById('aOvStart').value = toDtLocal(a.start_time);
  document.getElementById('aOvEnd').value = toDtLocal(a.end_time);
  var _actNow = document.getElementById('aOvActualNow');
  if (_actNow) _actNow.value = a.actual_hours ? fmtJamMenit(a.actual_hours) : '-';
  aOvHitungDurasi();
  var _ovB = document.getElementById('ovBody'); if (_ovB) _ovB.style.display = 'none';
  var _ovA = document.getElementById('ovArrow'); if (_ovA) _ovA.textContent = '▸';
  renderOverrideLog(a);                        // riwayat override (siapa & apa)
  aOvRenderTeam(a.team || []); // editor tim override — prefilled tim saat ini
  document.getElementById('aReason').value='';
  document.getElementById('aRejectSection').style.display='none';
  showModal('approveModal');
}
function toggleRejectSection() {
  var el = document.getElementById('aRejectSection');
  el.style.display = el.style.display==='none' ? 'block' : 'none';
}
// Editor tim override: prefilled tim saat ini; bisa tambah/kurang mekanik.
function _aOvRow(selId, selName) {
  var div = document.createElement('div'); div.className = 'teamRow';
  var mechs = (S.refs && S.refs.mechanics) || [];
  var found = false;
  var opts = '<option value="">-- Pilih Mekanik --</option>';
  for (var m=0;m<mechs.length;m++) {
    var sel = (String(mechs[m].mechanic_id)===String(selId)) ? ' selected' : '';
    if (sel) found = true;
    opts += '<option value="'+esc(mechs[m].mechanic_id)+'"'+sel+'>'+esc(mechs[m].mechanic_name)+'</option>';
  }
  // fallback: anggota tim yg tak ada di daftar refs tetap terjaga (jangan hilang senyap)
  if (selId && !found) opts = '<option value="'+esc(selId)+'" selected>'+esc(selName||selId)+'</option>' + opts;
  div.innerHTML = '<select class="aOvSel inp">'+opts+'</select><button type="button" class="mini gray" onclick="this.parentNode.remove()">✕</button>';
  return div;
}
function aOvRenderTeam(team) {
  var box = document.getElementById('aOvTeam'); box.innerHTML='';
  (team||[]).forEach(function(t){ box.appendChild(_aOvRow(t.mechanic_id, t.name)); });
}
function aOvAddMember() { document.getElementById('aOvTeam').appendChild(_aOvRow('', '')); }

/** Hitung & tampilkan durasi dari input override waktu kerja (jam & menit). */
function aOvHitungDurasi() {
  var s = document.getElementById('aOvStart').value, e = document.getElementById('aOvEnd').value;
  var box = document.getElementById('aOvDurBox'), txt = document.getElementById('aOvDurText');
  if (!txt) return;
  if (!s || !e) { txt.textContent = '-'; box.style.background='#EFF6FF'; box.style.borderColor='#BFDBFE'; box.style.color='#1e40af'; return; }
  var ms = new Date(e).getTime() - new Date(s).getTime();
  if (isNaN(ms) || ms <= 0) {
    txt.textContent = '⚠️ Waktu selesai harus setelah waktu mulai';
    box.style.background='#FEF2F2'; box.style.borderColor='#FCA5A5'; box.style.color='#991B1B';
    return;
  }
  txt.textContent = msToJamMenit(ms) + ' (' + (Math.round((ms/3600000)*100)/100) + ' jam)';
  box.style.background='#EFF6FF'; box.style.borderColor='#BFDBFE'; box.style.color='#1e40af';
}

/** ISO → nilai <input type="datetime-local"> (waktu lokal). */
function toDtLocal(v) {
  if (!v) return '';
  var d = new Date(v);
  if (isNaN(d.getTime())) return '';
  function p(n){ return (n<10?'0':'')+n; }
  return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())+'T'+p(d.getHours())+':'+p(d.getMinutes());
}

/** Render riwayat override (siapa mengubah apa) di modal approval. */
/** Buka/tutup panel Override (default tertutup supaya tampilan approval rapi). */
function toggleOverride() {
  var b = document.getElementById('ovBody'), a = document.getElementById('ovArrow');
  if (!b) return;
  var open = b.style.display !== 'none';
  b.style.display = open ? 'none' : 'block';
  if (a) a.textContent = open ? '▸' : '▾';
}

function renderOverrideLog(wo) {
  var box = document.getElementById('aOvLog');
  if (!box) return;
  var list = (wo && wo.override_summary) || [];
  if (!list.length) { box.style.display='none'; box.innerHTML=''; return; }
  var html = '<div class="ovLogTitle">✏️ Riwayat Override</div>';
  for (var i=0;i<list.length;i++) {
    var ov = list[i];
    html += '<div class="ovLogItem"><span class="ovTag '+(ov.level==='spv'?'l1':'l2')+'">'+(ov.level==='spv'?'L1':'L2')+'</span>' +
      '<span class="ovLogWho">'+esc(namaOrang(ov.by_name, ov.by))+'</span>' +
      (ov.at?'<span class="ovLogTime">'+esc(fmtDateTime(ov.at))+'</span>':'') + '<ul class="ovLogList">';
    for (var c=0;c<(ov.changes||[]).length;c++) {
      var ch = ov.changes[c];
      html += '<li><b>'+esc(ch.label)+'</b>: ' + (ch.from?'<span style="text-decoration:line-through;color:#9CA3AF">'+esc(ch.from)+'</span> → ':'') +
              '<span style="color:#B45309;font-weight:700">'+esc(ch.to)+'</span></li>';
    }
    html += '</ul></div>';
  }
  box.innerHTML = html;
  box.style.display = 'block';
}

function queueOverride() {
  var bp = document.getElementById('aOvBp').value.trim();
  var ovS = document.getElementById('aOvStart').value;
  var ovE = document.getElementById('aOvEnd').value;
  if ((ovS && !ovE) || (!ovS && ovE)) { toast('Isi waktu Mulai DAN Selesai'); return; }
  if (ovS && ovE && new Date(ovE).getTime() <= new Date(ovS).getTime()) { toast('Waktu selesai harus setelah mulai'); return; }
  // kirim hanya bila BERUBAH dari nilai WO saat ini
  var timeChanged = false;
  if (ovS && ovE) {
    timeChanged = (ovS !== toDtLocal(activeApproval.start_time)) || (ovE !== toDtLocal(activeApproval.end_time));
  }
  // tim dari editor
  var sels = document.querySelectorAll('.aOvSel');
  var team=[], seen={};
  for (var i=0;i<sels.length;i++) {
    var mid = sels[i].value;
    if (!mid) continue;
    if (seen[mid]) { toast('Mekanik duplikat di tim override'); return; }
    seen[mid]=true; team.push({mechanic_id:mid, percentage:100}); // SUM full-point
  }
  var origIds = (activeApproval.team||[]).map(function(t){return String(t.mechanic_id);}).sort().join(',');
  var newIds = team.map(function(t){return String(t.mechanic_id);}).sort().join(',');
  var teamChanged = (newIds !== origIds);
  if (teamChanged && team.length===0) { toast('Tim override minimal 1 mekanik'); return; }
  if (bp==='' && !timeChanged && !teamChanged) { toast('Tidak ada perubahan override'); return; }
  var payload = { wo_id:activeApproval.id };
  if (bp!=='') payload.base_points = parseFloat(bp);
  if (timeChanged) {
    payload.start_time = new Date(ovS).toISOString();
    payload.end_time = new Date(ovE).toISOString();
  }
  if (teamChanged) payload.team = team;
  var op = { op_id:uuid(), seq:(_enqSeq++), action:'save_override', wo_id:activeApproval.id, wo_number:activeApproval.wo_number,
    payload:payload, status:'queued', created_at:new Date().toISOString(), label:'Override '+activeApproval.wo_number };
  obPut(op).then(refreshOutbox).then(function() {
    renderAll();
    toast(navigator.onLine?'📮 Override dikirim — lanjut Approve':'📮 Override tersimpan (terkirim sebelum approve)');
    syncNow(false);
  });
}
function queueApprove(level) {
  var action = level===1 ? 'approve_l1' : 'approve_l2';
  var op = { op_id:uuid(), seq:(_enqSeq++), action:action, wo_id:activeApproval.id, wo_number:activeApproval.wo_number,
    payload:{ wo_id:activeApproval.id, notes:document.getElementById('aNotes').value, safety_incident:document.getElementById('aSafety').checked },
    status:'queued', created_at:new Date().toISOString(), label:(level===1?'L1':'L2')+' '+activeApproval.wo_number };
  obPut(op).then(refreshOutbox).then(function() {
    closeModal('approveModal'); renderAll();
    toast(navigator.onLine?'📮 Mengirim...':'📮 Tersimpan!');
    syncNow(false);
  });
}
function queueReject() {
  var reason = document.getElementById('aReason').value.trim();
  if (!reason) { toast('Isi alasan reject'); return; }
  var stage = activeApproval.status==='pending_superintendent' ? 'superintendent' : 'supervisor';
  var op = { op_id:uuid(), seq:(_enqSeq++), action:'reject', wo_id:activeApproval.id, wo_number:activeApproval.wo_number,
    payload:{ wo_id:activeApproval.id, stage:stage, reason:reason },
    status:'queued', created_at:new Date().toISOString(), label:'Reject '+activeApproval.wo_number };
  obPut(op).then(refreshOutbox).then(function() {
    closeModal('approveModal'); renderAll();
    toast(navigator.onLine?'📮 Mengirim...':'📮 Tersimpan!');
    syncNow(false);
  });
}

/* ── Outbox management ── */
function retryOp(opId) {
  obAll().then(function(items) {
    for (var i=0;i<items.length;i++) { if (items[i].op_id===opId) { items[i].status='failed_retry'; return obPut(items[i]); } }
  }).then(function() { syncNow(true); });
}
function discardOp(opId) {
  if (!confirm('Buang kiriman ini?')) return;
  obDel(opId).then(refreshOutbox).then(renderAll);
}

/* ── Modal ── */
function showModal(id) { document.getElementById(id).style.display='flex'; }
function closeModal(id) { document.getElementById(id).style.display='none'; }

/* ── Render ── */
// == PEMBARUAN VERSI =========================================================
// sw.js sudah skipWaiting()+clients.claim(), jadi versi baru mengambil alih
// begitu TERUNDUH. Yang mudah hilang: PEMICUNYA. register() hanya mengecek saat
// halaman dimuat, sedangkan PWA di HP bisa berhari-hari tak pernah dinavigasi
// ulang - pemakainya tertinggal di versi lama tanpa tanda apa pun.
var _swReg = null;
var _swReloaded = false;
var _swLastCheck = 0;
var SW_CHECK_MIN_MS = 10 * 60 * 1000;   // sw.js di GitHub Pages max-age=600

/* PEMBAGIAN TUGAS DUA TOMBOL - jangan dicampur lagi:
     Refresh (syncNow)  -> menarik DATA terbaru: WO, approval, katalog, mekanik.
     Versi (bukaCekVersi) -> mengambil APLIKASI terbaru: fitur & perbaikan.
   Pembaruan aplikasi tetap datang SENDIRI lewat pemicu otomatis di bawah
   (aplikasi dibuka, kembali terlihat, sinyal kembali). Tombol Versi hanya cara
   memastikannya sekarang juga - bukan satu-satunya jalan. */

/** Minta browser mengecek sw.js baru. Dibatasi agar tak boros kuota. */
function cekPembaruan(paksa) {
  if (!_swReg || !navigator.onLine) return;
  var now = Date.now();
  if (!paksa && (now - _swLastCheck) < SW_CHECK_MIN_MS) return;
  _swLastCheck = now;
  try { _swReg.update(); } catch (e) {}
}

/** Muat ulang sekali saja - dipanggil saat SW baru mengambil alih. */
function _lakukanReloadSW() {
  if (_swReloaded) return;
  _swReloaded = true;
  window.location.reload();
}

/**
 * Versi di server dibaca dari sw.js itu sendiri (var CACHE = 'mar-sum-vNN'),
 * dengan pembatal cache. Jadi tak perlu berkas versi terpisah yang bisa lupa
 * dinaikkan lalu berbohong diam-diam.
 */
function bacaVersiServer() {
  var url = './sw.js?cek=' + Date.now();
  return fetch(url, {cache: 'no-store'}).then(function(r){ return r.text(); }).then(function(t) {
    var m = t.match(/var CACHE = '(mar-sum-v\d+)'/);
    return m ? m[1].replace('mar-', '') : null;
  });
}

function _setVStatus(teks, bg, fg) {
  var el = document.getElementById('vStatus');
  if (!el) return;
  el.textContent = teks; el.style.background = bg; el.style.color = fg;
}

function bukaCekVersi() {
  document.getElementById('vTerpasang').textContent = APP_VERSION;
  document.getElementById('vServer').textContent = 'mengecek...';
  document.getElementById('vBtnUpdate').style.display = 'none';
  document.getElementById('vCatatan').style.display = 'none';
  _setVStatus('\u23f3 Mengecek...', '#F3F4F6', '#374151');
  showModal('versiModal');

  if (!navigator.onLine) {
    document.getElementById('vServer').textContent = '-';
    _setVStatus('\ud83d\udcf4 Tidak ada sinyal - sambungkan dulu untuk cek versi', '#FEF2F2', '#991B1B');
    return;
  }
  bacaVersiServer().then(function(v) {
    document.getElementById('vServer').textContent = v || '?';
    if (!v) { _setVStatus('\u26a0\ufe0f Gagal membaca versi server', '#FEF2F2', '#991B1B'); return; }
    if (v === APP_VERSION) {
      _setVStatus('\u2705 Sudah versi terbaru', '#ECFDF5', '#065F46');
    } else {
      _setVStatus('\u2b06\ufe0f Versi baru tersedia: ' + v, '#FFFBEB', '#92400E');
      document.getElementById('vBtnUpdate').style.display = 'block';
      document.getElementById('vCatatan').style.display = 'block';
    }
  }).catch(function() {
    document.getElementById('vServer').textContent = '?';
    _setVStatus('\u26a0\ufe0f Gagal menghubungi server', '#FEF2F2', '#991B1B');
  });
}

/**
 * Perbarui paksa: hapus SELURUH cache aplikasi lalu muat ulang.
 * AMAN untuk antrean - outbox ada di IndexedDB, bukan Cache Storage; yang
 * dihapus hanya berkas aplikasi (html/js/ikon) yang toh diunduh ulang.
 * Karena itu wajib online: menghapus cache saat offline membuat aplikasi tak
 * bisa dibuka sama sekali.
 */
function perbaruiSekarang() {
  if (!navigator.onLine) { toast('\ud83d\udcf4 Perlu sinyal untuk memperbarui'); return; }
  var btn = document.getElementById('vBtnUpdate');
  btn.disabled = true; btn.textContent = '\u23f3 Memperbarui...';
  _setVStatus('\u23f3 Mengunduh versi baru...', '#FFFBEB', '#92400E');

  var langkah = Promise.resolve();
  if (window.caches && caches.keys) {
    langkah = caches.keys().then(function(keys) {
      return Promise.all(keys.map(function(k){ return caches.delete(k); }));
    }).catch(function(){});
  }
  langkah.then(function() {
    if (_swReg && _swReg.update) { try { return _swReg.update(); } catch (e) {} }
  }).then(function() {
    // Tak perlu menunggu controllerchange - cache sudah kosong, jadi berkas
    // pasti diambil dari jaringan.
    _swReloaded = true;
    setTimeout(function(){ window.location.reload(); }, 600);
  }).catch(function() {
    btn.disabled = false; btn.textContent = '\u2b07\ufe0f Perbarui Sekarang';
    _setVStatus('\u26a0\ufe0f Gagal memperbarui - coba lagi', '#FEF2F2', '#991B1B');
  });
}

/**
 * Baca versi dari nama cache SW yang BENAR-BENAR aktif, supaya angka yang
 * tampil selalu jujur. Tanpa ini APP_VERSION di app.js bisa tertinggal dari
 * CACHE di sw.js dan layar menampilkan versi yang salah.
 */
function syncVersionFromCache() {
  try {
    if (typeof caches === 'undefined' || !caches.keys) return Promise.resolve();
    return caches.keys().then(function(keys) {
      for (var i = 0; i < keys.length; i++) {
        var m = /^mar-(sum-v\d+)$/.exec(keys[i]);
        if (m) { APP_VERSION = m[1]; break; }
      }
    }).catch(function(){});
  } catch (e) { return Promise.resolve(); }
}

/**
 * Apakah ada isian yang belum tersimpan di layar yang sedang terlihat?
 * Dipakai untuk memutuskan boleh-tidaknya memuat ulang otomatis saat versi baru
 * datang. Hanya memeriksa kolom yang BENAR-BENAR terlihat (offsetParent) — kolom
 * di layar tersembunyi tak boleh menahan pembaruan.
 */
function adaIsianBelumTersimpan() {
  try {
    var kolom = document.querySelectorAll('input, textarea, select');
    for (var i = 0; i < kolom.length; i++) {
      var k = kolom[i];
      if (k.offsetParent === null) continue;          // tak terlihat
      if (k.disabled || k.readOnly) continue;
      if (k.type === 'hidden' || k.type === 'button' || k.type === 'submit') continue;
      if (k.tagName === 'SELECT') { if (k.selectedIndex > 0) return true; continue; }
      if (String(k.value || '').trim() !== '') return true;
    }
  } catch (e) {}
  return false;
}

/** Pita ajakan muat ulang — muncul hanya bila pembaruan ditunda demi isian. */
function tampilkanPitaVersiBaru() {
  if (document.getElementById('pitaVersiBaru')) return;
  var p = document.createElement('div');
  p.id = 'pitaVersiBaru';
  p.style.cssText = 'position:fixed;left:12px;right:12px;bottom:12px;z-index:9999;' +
    'background:#1e40af;color:#fff;border-radius:12px;padding:12px 14px;' +
    'box-shadow:0 6px 20px rgba(0,0,0,.28);display:flex;align-items:center;gap:10px;' +
    'font-size:14px;line-height:1.35';
  p.innerHTML = '<div style="flex:1">✨ <b>Versi baru siap.</b><br>' +
    '<span style="opacity:.85;font-size:13px">Selesaikan isian dulu, lalu muat ulang.</span></div>' +
    '<button id="pitaMuatUlang" style="background:#fff;color:#1e40af;border:0;border-radius:8px;' +
    'padding:9px 14px;font-weight:800;font-size:14px">Muat Ulang</button>';
  document.body.appendChild(p);
  document.getElementById('pitaMuatUlang').onclick = function(){ _lakukanReloadSW(); };
}

function showScreen(nm) {
  var lv = document.getElementById('loginVersion');
  if (lv) { lv.style.cursor = 'pointer'; lv.title = 'Ketuk untuk cek versi'; lv.onclick = bukaCekVersi; }
  if (lv) lv.textContent = APP_VERSION;
  if (nm !== 'login') setLoginLoading(false);
  // 'flex' (bukan 'block') — layar login memakai flexbox agar isinya benar-benar
  // di tengah layar; inline style 'block' akan mengalahkan display:flex dari CSS.
  document.getElementById('screen-login').style.display = nm==='login'?'flex':'none';
  document.getElementById('screen-main').style.display = nm==='main'?'block':'none';
}
function esc(s) { return String(s).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];}); }
function toast(msg) {
  var t=document.getElementById('toast'); t.textContent=msg; t.style.display='block';
  clearTimeout(t._h); t._h=setTimeout(function(){t.style.display='none';},3500);
}
function toggleOutboxDetail(){ S.showOutbox = !S.showOutbox; renderAll(); }
function opLabel(o){
  var names = {submit_work:'Submit', create_wo:'Buat WO', approve_l1:'L1', approve_l2:'L2', reject:'Reject', save_override:'Override', cancel_wo:'Batal', request_transfer:'Transfer WO', approve_transfer:'Approve Transfer', reject_transfer:'Reject Transfer', report_expired:'Lapor Expired', reopen_expired:'Reopen Expired'};
  var base = o.label || names[o.action] || o.action;
  if (o.wo_number && String(base).indexOf(o.wo_number)===-1) base += ' '+o.wo_number;
  return base;
}
function fmtDateTime(iso){
  if(!iso) return '-';
  var d = new Date(iso);
  if(isNaN(d.getTime())) return '-';
  return d.toLocaleString('id-ID',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'});
}
/**
 * Majukan status WO di salinan LOKAL segera setelah operasinya berhasil.
 *
 * Tanpa ini ada jeda buruk: begitu antrean selesai, badge "Antre" hilang tapi
 * S.wos masih menyimpan status lama, sehingga kartu sempat menampilkan
 * "Perlu diisi" lagi sampai pull_my_wos tiba. Mekanik mengira kirimannya batal,
 * lalu menekan Kirim sekali lagi -- dan dari situlah alarm Gagal Kirim lahir.
 *
 * Ini hanya menyegarkan TAMPILAN. Server tetap pemegang kebenaran; sinkron
 * berikutnya akan menimpanya dengan status sebenarnya.
 */
function majukanStatusLokal(op) {
  if (!op || !op.wo_id) return;
  var lanjut = {
    submit_work: 'pending_supervisor',
    approve_l1:  'pending_superintendent',
    approve_l2:  'approved',
    reject:      'rejected',
    cancel_wo:   'cancelled'
  };
  var baru = lanjut[op.action];
  if (!baru) return;
  for (var i = 0; i < S.wos.length; i++) {
    if (String(S.wos[i].id) === String(op.wo_id)) { S.wos[i].status = baru; break; }
  }
}

function badgeFor(wo,pendingOp) {
  if (pendingOp) {
    if (pendingOp.status==='queued') return ['📮 Antre','#b45309'];
    if (pendingOp.status==='failed') return ['⚠️ Gagal Kirim','#b91c1c'];
  }
  var s=String(wo.status||'');
  if (s==='pending_mechanic_work') return ['📝 Perlu diisi','#1d4ed8'];
  if (s==='pending_transfer') return ['🔀 Pending Transfer','#4f46e5'];
  if (s==='pending_supervisor') return ['⏳ L1','#7c3aed'];
  if (s==='pending_superintendent') return ['⏳ L2','#7c3aed'];
  if (s==='approved') return ['✅ Approved','#15803d'];
  return [s||'-','#475569'];
}
function renderAll() {
  var on=navigator.onLine;
  document.getElementById('netDot').style.background=on?'#22c55e':'#ef4444';
  document.getElementById('netText').textContent=on?'Online':'Offline';
  document.getElementById('syncBtn').innerHTML = S.syncing ? '<span class="spin"></span>Sync…' : '🔄 Refresh';
  document.getElementById('lastSync').textContent=(S.lastSync?'Diperbarui: '+new Date(S.lastSync).toLocaleString('id-ID'):'Belum sync')+' · '+APP_VERSION;
  document.getElementById('meName').textContent=S.me?(S.me.name||S.me.mechanic_id):'';
  // Peran → tab: mekanik=WO Saya; foreman=Buat WO; L1/L2=Buat WO + Approval
  var isMechanic = (S.role==='mechanic');
  var isApprover = (S.role==='supervisor' || S.role==='superintendent' || S.role==='foreman_approver');
  var isForeman = (S.role==='foreman');
  var isCreator = !isMechanic; // foreman + approver
  if (isMechanic) S.tab='wos';
  // Foreman boleh berada di tab 'create' ATAU 'active' (dulu selalu dipaksa balik ke
  // 'create', sehingga tab WO Aktif terasa "tidak bisa diklik").
  else if (isForeman && S.tab!=='create' && S.tab!=='active') S.tab='create';
  else if (isApprover && (S.tab==='wos' || S.tab==='active')) S.tab='approval';
  document.getElementById('tabBar').style.display = isCreator ? 'flex' : 'none';
  // Tab khusus mekanik: Assigned | Pending | Done
  var mtb = document.getElementById('mechTabBar');
  if (mtb) {
    mtb.style.display = isMechanic ? 'flex' : 'none';
    var mm = {assigned:'mtabAssigned', pending:'mtabPending', done:'mtabDone'};
    for (var mk in mm) {
      var mel = document.getElementById(mm[mk]);
      if (mel) mel.className = 'tab' + (S.mechTab === mk ? ' active' : '');
    }
  }
  document.getElementById('tabWos').style.display = 'none'; // WO Saya hanya mekanik (tanpa tabBar)
  document.getElementById('tabCreate').style.display = isCreator ? '' : 'none';
  var tActive = document.getElementById('tabActive');
  if (tActive) {
    // HANYA foreman. Approver sudah punya daftar WO aktif di sub-tab Approval
    // (Pending | Aktif | Approved), jadi tab atas ini cuma mengulang. Foreman
    // TIDAK punya menu Approval sama sekali — baginya ini satu-satunya jalan,
    // jadi tak boleh ikut dihapus.
    tActive.style.display = isForeman ? '' : 'none';
    tActive.className = 'tab' + (S.tab === 'active' ? ' active' : '');
  }
  document.getElementById('tabApproval').style.display = isApprover ? '' : 'none';
  document.getElementById('tabCreate').className = 'tab'+(S.tab==='create'?' active':'');
  document.getElementById('tabApproval').className = 'tab'+(S.tab==='approval'?' active':'');
  // outbox info
  var queued = S.outbox.filter(function(o){return o.status==='queued'||o.status==='failed_retry';});
  var oi = document.getElementById('outboxInfo');
  oi.textContent = queued.length ? ('📮 '+queued.length+' Mengirim… '+(S.showOutbox?'▲':'▼')) : '';
  var od = document.getElementById('outboxDetail');
  if (queued.length && S.showOutbox) {
    od.style.display='block';
    od.innerHTML = queued.map(function(o){
      return '<div class="card" style="padding:10px;margin-bottom:6px">'+
        '<b>'+esc(opLabel(o))+'</b>'+
        '<div class="sub" style="margin:2px 0 0">🕒 Masuk antrean: '+esc(fmtDateTime(o.created_at))+'</div>'+
        '</div>';
    }).join('');
  } else { od.style.display='none'; od.innerHTML=''; }
  // failed outbox
  var failHtml = '';
  S.outbox.filter(function(o){return o.status==='failed';}).forEach(function(o) {
    failHtml += '<div class="card err"><b>'+esc(opLabel(o))+'</b><br>'+esc(o.error||'-')+
      '<br><button class="mini" onclick="retryOp(\''+o.op_id+'\')">🔁 Coba lagi</button> '+
      '<button class="mini gray" onclick="discardOp(\''+o.op_id+'\')">🗑 Buang</button></div>';
  });
  document.getElementById('failedOps').innerHTML = failHtml;
  // content
  var content = document.getElementById('content');
  if (isMechanic) { renderWos(content); }
  else if (S.tab==='active') { content.innerHTML = '<div class="sub">WO yang sudah dibuat tapi belum di-submit mekanik</div>' + renderActiveList(); }
  else if (S.tab==='approval' && isApprover) { renderApprovalTab(content); }
  else { renderCreateTab(content); }
}
/** Tab mekanik: Assigned | Pending | Done */
function switchMechTab(t) { S.mechTab = t; renderAll(); }

/** Kelompokkan status WO ke tab mekanik. */
function mechGroupOf(wo) {
  var st = String(wo.status || '');
  if (st === 'approved') return 'done';
  if (st === 'rejected' || st === 'cancelled') return 'done';
  if (st === 'pending_supervisor' || st === 'pending_superintendent') return 'pending';
  return 'assigned';   // pending_mechanic_work / in_progress / pending_transfer / created
}

function renderWos(el) {
  var opByWo={};
  S.outbox.forEach(function(o){if(o.wo_id&&(!opByWo[o.wo_id]||o.created_at>opByWo[o.wo_id].created_at))opByWo[o.wo_id]=o;});
  if (!S.wos.length) { el.innerHTML='<div class="empty">Belum ada kartu WO.<br>Tekan 🔄 Refresh saat ada sinyal.</div>'; return; }
  // Filter sesuai tab mekanik (Assigned / Pending / Done)
  var listWos = S.wos.filter(function(w){ return mechGroupOf(w) === S.mechTab; });
  if (!listWos.length) {
    var lbl = S.mechTab==='assigned' ? 'Belum ada WO yang perlu dikerjakan.'
            : S.mechTab==='pending'  ? 'Tidak ada WO yang sedang menunggu approval.'
            : 'Belum ada WO selesai.';
    el.innerHTML = '<div class="empty">'+lbl+'</div>';
    return;
  }
  var html='';
  listWos.forEach(function(wo) {
    var op=opByWo[wo.id]; var b=badgeFor(wo,op);
    var isReportedExp = (wo.is_reported_expired === true);
    var refTime = wo.reopened_at || wo.created_at;
    var isExpiredTime = false;
    if (refTime) {
      var t = new Date(refTime).getTime();
      if (!isNaN(t) && (Date.now() - t > 12 * 60 * 60 * 1000)) isExpiredTime = true;
    }
    var canFill=String(wo.status)==='pending_mechanic_work'&&!isReportedExp&&(!op||op.status==='failed'||op.status==='done');

    // Live Timer Widget
    var st = getTimerState(wo.id);
    var curMs = st.elapsed_ms + (st.state === 'running' ? (Date.now() - st.start_epoch) : 0);
    var timerControls = '';
    if (canFill && !isExpiredTime) {
      var isRunning = (st.state === 'running');
      var isPaused = (st.state === 'paused');
      timerControls = '<div class="timerPill">' +
        '<div style="font-size:11px;font-weight:700;color:#6b7280;margin-bottom:2px">⏱️ LIVE TIMER</div>' +
        '<div class="timerClock" id="timer-clock-' + esc(String(wo.id)) + '">' + formatMsToHms(curMs) + '</div>' +
        '<div class="timerBtns">' +
          (isRunning ? '' : '<button type="button" class="timerBtn btnStart" onclick="startLiveTimer(\'' + esc(String(wo.id)) + '\')">▶ ' + (isPaused ? 'Resume' : 'Start') + '</button>') +
          (isRunning ? '<button type="button" class="timerBtn btnPause" onclick="pauseLiveTimer(\'' + esc(String(wo.id)) + '\')">⏸ Pause</button>' : '') +
          (st.state !== 'idle' ? '<button type="button" class="timerBtn btnStop" onclick="openSubmitWithTimer(\'' + esc(String(wo.id)) + '\')">⏹ Stop & Isi</button>' : '') +
        '</div>' +
      '</div>';
    }

    var expiredNotice = '';
    if (isReportedExp) {
      expiredNotice = '<div class="ket" style="background:#FEF2F2;color:#991B1B;margin-top:8px">⏰ WO ini telah dilaporkan expired ke L2. Mohon tunggu L2 me-reopen WO ini.</div>';
    } else if (isExpiredTime && canFill) {
      expiredNotice = '<div class="ket" style="background:#FEF2F2;color:#991B1B;margin-top:8px">⚠️ WO ini telah expired (>12 jam). Silakan laporkan ke Pengawas (L2) untuk dibuka kembali.</div>' +
        '<button class="big danger" style="margin-top:8px" onclick="queueReportExpired(\'' + esc(String(wo.id)) + '\')">⚠️ Laporkan Expired ke L2</button>';
    }

    html+='<div class="card"><div class="cardTop"><b>'+esc(wo.wo_number)+'</b>'+
      (isReportedExp ? '<span class="badge" style="background:#dc2626">⏰ Expired Reported</span>' : (isExpiredTime ? '<span class="badge" style="background:#dc2626">⏰ Expired (>12j)</span>' : '<span class="badge" style="background:'+b[1]+'">'+b[0]+'</span>'))+
      (wo.is_others?'<span class="badge" style="background:#0ea5e9">OTHERS</span>':'')+'</div>'+
      '<div class="cardBody"><b>'+esc(wo.component_name||'-')+'</b>'+(wo.unit_name?' · '+esc(wo.unit_name):'')+(wo.target_hours?' · Target: '+fmtJamMenit(wo.target_hours):'')+'<br>'+
      '📍 '+esc(locLabel(wo.location))+' · Kondisi: '+esc(wcLabel(wo.work_condition))+
      (wo.created_at?'<br>📅 Dibuat: '+esc(fmtDateTime(wo.created_at)):'')+
      ((parseFloat(wo.partial_hours)||0)>0?'<br>📥 Lintas shift: '+wo.partial_hours+' jam dari shift sebelumnya':'')+'</div>'+
      (wo.keterangan?'<div class="ket">📝 '+esc(wo.keterangan)+'</div>':'')+
      // Tab Done: cukup status disetujui — poin/rupiah SENGAJA tidak ditampilkan
      // di PWA (keputusan Gabriel); rincian uang dilihat lewat laporan payroll.
      (String(wo.status)==='approved'
        ? '<div style="margin-top:8px;background:#ECFDF5;border:1px solid #A7F3D0;border-radius:10px;padding:8px 11px;font-size:12px;color:#065F46;font-weight:700">✅ Sudah disetujui'+
          (wo.safety_incident?' · <span style="color:#B91C1C">⚠️ Safety incident</span>':'')+'</div>'
        : '')+
      timerControls+
      expiredNotice+
      (canFill && !isExpiredTime ?'<div style="display:flex;gap:6px;margin-top:10px">'+
        '<button class="big" style="margin-top:0;flex:1" onclick="openSubmitForm(\''+esc(String(wo.id))+'\')">✍️ Isi & Kirim</button>'+
        '<button class="big btnTransfer" style="margin-top:0;flex:1" onclick="openTransferModal(\''+esc(String(wo.id))+'\')">🔀 Transfer WO</button>'+
        '</div>':'')+
      '</div>';
  });
  el.innerHTML=html;
}
function renderCreateTab(el) {
  if (!S.refs) { el.innerHTML='<div class="empty">Tekan 🔄 Refresh untuk memuat data referensi.</div>'; return; }
  el.innerHTML='<button class="big" onclick="openCreateForm()" style="margin-bottom:12px">➕ Buat Work Order Baru</button>'+
    '<div class="sub">Referensi: '+((S.refs.components||[]).length)+' pekerjaan · '+((S.refs.units||[]).length)+' unit · '+((S.refs.mechanics||[]).length)+' mekanik</div>';
}
function wcLabel(wc){ return wc==='normal'?'Normal':wc==='difficult'?'Malam/Hujan':wc==='extreme'?'Resiko Tinggi':(wc||'-'); }
function partLabel(p){ return p==='baru'?'🆕 Baru':p==='repair'?'🔧 Repair':p==='canibal'?'♻️ Canibal':(p||'-'); }
function locLabel(l){ return l==='field'?'Lapangan':l==='workshop'?'Bengkel':(l||'-'); }
function fmtJamMenit(h){
  h=parseFloat(h)||0;
  if(h<=0) return '-';
  var j=Math.floor(h), m=Math.round((h-j)*60);
  if(m===60){ j++; m=0; }
  if(j>0&&m>0) return j+' jam '+m+' menit';
  if(j>0) return j+' jam';
  return m+' menit';
}
function renderApprovalTab(el) {
  var filteredPending = S.pending;
  if (S.role === 'supervisor') {
    filteredPending = S.pending.filter(function(wo) {
      return wo.status === 'pending_supervisor' || wo.status === 'pending_transfer' || wo.is_reported_expired === true;
    });
  } else if (S.role === 'superintendent') {
    filteredPending = S.pending.filter(function(wo) {
      return wo.status === 'pending_superintendent' || wo.is_reported_expired === true;
    });
  }

  var subs = [['pending','✅ Pending',filteredPending.length],['active','⏳ Aktif',S.active.length],['approved','🏆 Approved',S.approved.length]];
  var bar = '<div class="tabBar" style="display:flex;margin-bottom:12px">'+subs.map(function(s){
    return '<button class="tab'+(S.appSub===s[0]?' active':'')+'" onclick="switchAppSub(\''+s[0]+'\')">'+s[1]+' ('+s[2]+')</button>';
  }).join('')+'</div>';
  var body = S.appSub==='active' ? renderActiveList() : (S.appSub==='approved' ? renderApprovedList() : renderPendingList(filteredPending));
  el.innerHTML = bar + body;
}
function switchAppSub(sub){
  S.appSub = sub;
  // Selalu tarik ulang saat sub-tab dibuka (bukan hanya saat kosong) — supaya WO
  // yang baru disahkan langsung terlihat tanpa menunggu sinkron berikutnya.
  if (sub==='approved' && navigator.onLine) { pullApproved().then(renderAll).catch(function(){}); }
  renderAll();
}
function fmtIdr(n){ n=parseFloat(n)||0; return n.toLocaleString('id-ID'); }
function queuedOpFor(woId){
  for (var i=0;i<S.outbox.length;i++){
    var o=S.outbox[i];
    if (String(o.wo_id)===String(woId) && (o.status==='queued'||o.status==='failed_retry')) return o;
  }
  return null;
}
function queuedNote(qop){ return '<div class="obinfo">📮 '+esc(opLabel(qop))+' — menunggu sinyal (tombol dikunci)</div>'; }
// Email TIDAK ditampilkan — yang dikenali orang di lapangan adalah nama.
// Sama dengan web (Approval.html: baris email anggota tim sudah dihapus).
/**
 * Nama orang untuk DITAMPILKAN. Tidak pernah mengembalikan alamat email utuh.
 * Sama persis dengan namaOrang() di UIHelpers.gs sisi web - satu aturan, dua kanal.
 */
function namaOrang(nama, email) {
  var n = (nama === null || nama === undefined) ? '' : String(nama).trim();
  if (n && n.indexOf('@') === -1) return n;
  var e = (email === null || email === undefined) ? '' : String(email).trim();
  if (!e) return n || '-';
  var at = e.indexOf('@');
  return at > 0 ? e.substring(0, at) : e;
}

function teamStr(team){ return (team||[]).map(function(t){ return esc(t.name||t.mechanic_name||t.mechanic_id||t); }).join(', '); }
function ovBadges(wo){ return (wo.has_override_spv?'<span class="badge" style="background:#4338ca">SPV override</span>':'')+(wo.has_override_supt?'<span class="badge" style="background:#7c3aed">SUPT override</span>':''); }
function cancelBtn(wo){ return '<button class="big secondary" onclick="openCancelForm(\''+esc(String(wo.id))+'\',\''+esc(String(wo.wo_number))+'\')">🗑 Batalkan WO</button>'; }
function renderPendingList(list){
  var pendingList = list || S.pending;
  if (!pendingList.length) return '<div class="empty">Tidak ada WO menunggu approval.</div>';
  var html='<div class="sub">'+pendingList.length+' WO menunggu approval</div>';
  pendingList.forEach(function(wo){
    var isTransfer = (wo.status === 'pending_transfer');
    var isExpiredReported = (wo.is_reported_expired === true);
    var isL2 = wo.status==='pending_superintendent';
    var othersBadge = wo.is_others ? '<span class="badge" style="background:#0ea5e9">OTHERS</span>' : '';
    var tl = wo.timeliness;
    var tlBadge = tl ? '<span class="badge" style="background:'+(tl.status==='on_time'?'#15803d':tl.status==='late'?'#b45309':'#b91c1c')+'">⏱️ '+esc(tl.label)+' ×'+tl.factor+'</span>' : '';
    var statusBadge = isExpiredReported
      ? '<span class="badge" style="background:#dc2626">⏰ Expired Reported</span>'
      : (isTransfer
        ? '<span class="badge" style="background:#4f46e5">🔀 Pending Transfer</span>'
        : '<span class="badge" style="background:'+(isL2?'#b45309':'#7c3aed')+'">'+(isL2?'⏳ L2':'⏳ L1')+'</span>');

    var transferInfo = isTransfer
      ? '<br><b>🔀 Permintaan Transfer:</b>' +
        (wo.transfer_requested_by_name || wo.transfer_requested_by ? '<br>Diminta oleh: ' + esc(namaOrang(wo.transfer_requested_by_name, wo.transfer_requested_by)) : '') +
        (wo.transfer_note ? '<br>Catatan: <i>' + esc(wo.transfer_note) + '</i>' : '')
      : '';

    html+='<div class="card"><div class="cardTop"><b>'+esc(wo.wo_number)+'</b>'+statusBadge+
      othersBadge+tlBadge+ovBadges(wo)+'</div>'+
      '<div class="cardBody"><b>'+esc(wo.component_name||'-')+'</b>'+(wo.unit_name?' · '+esc(wo.unit_name):'')+'<br>'+
      '📍 Lokasi: '+esc(locLabel(wo.location))+'<br>'+
      'Kondisi: '+esc(wcLabel(wo.work_condition))+' · Target: '+fmtJamMenit(wo.target_hours)+
      (wo.actual_hours ? ' · Aktual: '+fmtJamMenit(wo.actual_hours) : '')+'<br>'+
      'Base: '+(wo.base_points||0)+' pts · Unit Factor: '+(wo.unit_factor||1)+' 🔒<br>'+
      (wo.part_type ? '🔧 Part: '+esc(partLabel(wo.part_type))+'<br>' : '')+
      ((wo.created_by_name||wo.created_by)?'👤 Pembuat: '+esc(namaOrang(wo.created_by_name, wo.created_by))+'<br>':'')+
      ((wo.submitted_by_name||wo.submitted_by)?'✍️ Disubmit: '+esc(namaOrang(wo.submitted_by_name, wo.submitted_by))+'<br>':'')+
      '👥 Tim: '+teamStr(wo.team)+
      transferInfo +
      '</div>'+
      (wo.keterangan?'<div class="ket">📝 '+esc(wo.keterangan)+'</div>':'')+
      (function(){
        var q=queuedOpFor(wo.id);
        if (q) return queuedNote(q);
        if (isExpiredReported) {
          return '<button class="big" style="background:#0284c7" onclick="queueReopenExpired(\''+esc(String(wo.id))+'\')">🔓 Buka Kembali (Re-open WO)</button>';
        }
        if (isTransfer) {
          return '<div style="display:flex;gap:6px;margin-top:10px">'+
            '<button class="big" style="margin-top:0;flex:1;background:#10b981" onclick="openApproveTransferModal(\''+esc(String(wo.id))+'\')">🔀 Setujui Transfer</button>'+
            '<button class="big secondary" style="margin-top:0;flex:1;color:#dc2626;border-color:#fca5a5" onclick="queueRejectTransfer(\''+esc(String(wo.id))+'\')">❌ Tolak Transfer</button>'+
            '</div>';
        }
        return '<button class="big" onclick="openApproveForm(\''+esc(String(wo.id))+'\')">📋 Review & Approve</button>'+cancelBtn(wo);
      })()+'</div>';
  });
  return html;
}
function renderActiveList(){
  if (!S.active.length) return '<div class="empty">Tidak ada WO aktif (belum di-submit mekanik).</div>';
  var html='<div class="sub">'+S.active.length+' WO aktif — belum di-submit mekanik</div>';
  S.active.forEach(function(wo){
    var othersBadge = wo.is_others ? '<span class="badge" style="background:#0ea5e9">OTHERS</span>' : '';
    var teamNames = wo.team_names || (wo.team ? wo.team.map(function(t){return t.name||t.mechanic_name||t;}) : []);
    html+='<div class="card"><div class="cardTop"><b>'+esc(wo.wo_number)+'</b><span class="badge" style="background:#1d4ed8">📝 Belum diisi</span>'+othersBadge+'</div>'+
      '<div class="cardBody"><b>'+esc(wo.component_name||'-')+'</b><br>'+
      '📍 Lokasi: '+esc(locLabel(wo.location))+'<br>'+
      'Kondisi: '+esc(wcLabel(wo.work_condition))+((wo.created_by_name||wo.created_by)?' · Pembuat: '+esc(namaOrang(wo.created_by_name, wo.created_by)):'')+'<br>'+
      '👥 Tim: '+(teamNames||[]).map(function(n){return esc(n);}).join(', ')+'</div>'+
      (wo.keterangan?'<div class="ket">📝 '+esc(wo.keterangan)+'</div>':'')+
      (function(){ var q=queuedOpFor(wo.id); return q ? queuedNote(q) : cancelBtn(wo); })()+'</div>';
  });
  return html;
}
function renderApprovedList(){
  if (!S.approved.length) return '<div class="empty">Belum ada WO approved.<br>Tekan 🔄 Refresh saat online.</div>';
  var html='<div class="sub">'+S.approved.length+' WO approved (terbaru)</div>';
  S.approved.forEach(function(wo){
    var othersBadge = wo.is_others ? '<span class="badge" style="background:#0ea5e9">OTHERS</span>' : '';
    var safety = wo.safety_incident ? '<span class="badge" style="background:#b91c1c">SAFETY</span>' : '';
    var teamNames = wo.team_names || (wo.team ? wo.team.map(function(t){return t.name||t.mechanic_name||t;}) : []);
    var part = wo.part_type || wo.part_category || '';
    html+='<div class="card"><div class="cardTop"><b>'+esc(wo.wo_number)+'</b><span class="badge" style="background:#15803d">✅ Approved</span>'+othersBadge+safety+'</div>'+
      '<div class="cardBody"><b>'+esc(wo.component_name||'-')+'</b><br>'+
      '📍 Lokasi: '+esc(locLabel(wo.location))+'<br>'+
      'Poin: '+(wo.final_points||wo.points||0)+' · Rp '+fmtIdr(wo.final_idr||wo.idr_value||0)+'<br>'+
      'Aktual: '+fmtJamMenit(wo.actual_hours)+(part?' · 🔧 '+esc(partLabel(part)):'')+
      (wo.created_at_str?' · '+esc(wo.created_at_str):'')+'<br>'+
      '👥 Tim: '+(teamNames||[]).map(function(n){return esc(n);}).join(', ')+'</div>'+
      (wo.keterangan?'<div class="ket">📝 '+esc(wo.keterangan)+'</div>':'')+
      (function(){ var q=queuedOpFor(wo.id); return q ? queuedNote(q) : cancelBtn(wo); })()+'</div>';
  });
  return html;
}

/* ── Init ── */
window.addEventListener('online',function(){renderAll(); syncNow(false);});
window.addEventListener('offline',renderAll);
openDb().then(function() {
  return Promise.all([kvGet('token'),kvGet('me'),kvGet('wos'),kvGet('refs'),kvGet('pending'),kvGet('last_sync'),kvGet('role'),kvGet('refs_at'),kvGet('active'),kvGet('approved'),kvGet('timer_states')]);
}).then(function(v) {
  S.token=v[0]||null; S.me=v[1]||null; S.wos=v[2]||[]; S.refs=v[3]||null; S.pending=v[4]||[]; S.lastSync=v[5]||null; S.role=v[6]||'mechanic'; S.refsAt=v[7]||null; S.active=v[8]||[]; S.approved=v[9]||[]; S.timerStates=v[10]||{};
  startTimerTicker();
  return refreshOutbox();
}).then(function() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').then(function(reg) {
      _swReg = reg;
      cekPembaruan();                       // cek sekali saat aplikasi dibuka
    }).catch(function(){});

    navigator.serviceWorker.addEventListener('controllerchange', function() {
      if (_swReloaded) return;
      // Versi baru siap. Kalau layar sedang KOSONG dari isian, muat ulang diam-diam —
      // pemakai tak perlu tahu apa-apa. Tapi kalau mekanik sedang mengetik jam kerja /
      // HM / KM, memuat ulang akan MENGHAPUS ketikannya. Untuk itu tunda, tampilkan
      // pita, biar dia yang memilih waktunya.
      if (adaIsianBelumTersimpan()) { tampilkanPitaVersiBaru(); return; }
      _lakukanReloadSW();
    });

    // PWA sering dibiarkan terbuka berhari-hari tanpa pernah dinavigasi ulang.
    // Tanpa dua pemicu ini, pengecekan versi tak pernah jalan dan HP tetap di
    // versi lama tanpa tanda apa pun.
    document.addEventListener('visibilitychange', function() {
      if (document.visibilityState === 'visible') cekPembaruan();
    });
    window.addEventListener('online', function(){ cekPembaruan(); });
  }
  // Angka versi diambil dari nama cache SW yang benar-benar aktif, lalu layar
  // digambar ulang — supaya yang tampil bukan tebakan dari konstanta di berkas ini.
  syncVersionFromCache().then(function(){ renderAll(); });
  showScreen(S.token?'main':'login');
  if (S.token) requestPeriodicSync();
  if (IS_IOS && !IS_STANDALONE) { var _ib = document.getElementById('installBtn'); if (_ib) _ib.style.display = ''; }
  renderAll();
  if (S.token && navigator.onLine) {
    api('ping').then(function(r){
      if (r.success && r.result && r.result.role && r.result.role !== S.role) {
        S.role = r.result.role; kvSet('role', S.role); renderAll();
      }
    }).catch(function(){});
    syncNow(false);
  }
  setTimeout(function() {
    var splash = document.getElementById('splashScreen');
    if (splash) splash.classList.add('splash-hidden');
  }, 1200);
});
