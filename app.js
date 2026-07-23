/* ============================================================
   MAR SUM Offline — Mekanik submit + Create + Approval (incl. Override)
   Prinsip: CACHE → ANTRE → SINKRON. Server selalu benar.
   Adaptasi SUM: tanpa section/scope, tanpa job katalog, part_type wajib,
   MTBF mati, foreman create-only, override L1/L2 (parity web).
   ============================================================ */

var CONFIG = { API_URL: 'https://script.google.com/macros/s/AKfycbzB5EUJlpGRaDTFvfr3bl117hd_Oa2k4seCecTYy4Ct8_oYRefu8U9BqG6zu3M-BoFS/exec' };
var APP_VERSION = 'sum-v4'; // samakan dgn CACHE 'mar-sum-v4' di sw.js tiap rilis
var S = { token:null, me:null, role:null, wos:[], refs:null, refsAt:null, pending:[], active:[], approved:[], outbox:[], lastSync:null, syncing:false, tab:'wos', appSub:'pending', showOutbox:false, timerStates:{} };
// Referensi kecil (komponen/unit/mekanik) — tarik ulang maks 1x/12 jam.
var REFS_TTL_MS = 12*60*60*1000;
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
function startLiveTimer(woId) {
  var st = getTimerState(woId);
  st.state = 'running';
  st.start_epoch = Date.now();
  saveTimerState(woId, st);
  startTimerTicker();
  renderAll();
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
function stopLiveTimer(woId) {
  var st = getTimerState(woId);
  var totalMs = st.elapsed_ms;
  if (st.state === 'running') {
    totalMs += (Date.now() - st.start_epoch);
  }
  st.state = 'idle';
  st.elapsed_ms = 0;
  st.start_epoch = 0;
  saveTimerState(woId, st);
  renderAll();
  return totalMs;
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
  var totalMs = stopLiveTimer(activeWo.id);
  if (totalMs > 0) {
    var now = new Date();
    var start = new Date(now.getTime() - totalMs);
    document.getElementById('fStart').value = formatToDatetimeLocal(start);
    document.getElementById('fEnd').value = formatToDatetimeLocal(now);
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
function uuid() { return crypto.randomUUID ? crypto.randomUUID() : 'op-'+Date.now()+'-'+Math.random().toString(36).slice(2,10); }

/* ── API ── */
function api(action,data,opId) {
  var body = JSON.stringify({token:S.token, action:action, data:data||{}, op_id:opId||undefined});
  return fetch(CONFIG.API_URL, {method:'POST', headers:{'Content-Type':'text/plain'}, body:body})
    .then(function(r){return r.json();});
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
function syncNow(manual) {
  if (S.syncing) return Promise.resolve();
  if (manual) requestNotifPermission();
  if (!navigator.onLine) { requestBgSync(); if (manual) toast('📴 Offline — data aman di antrean, terkirim otomatis saat ada sinyal'); renderAll(); return Promise.resolve(); }
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
        if (S.role === 'supervisor' || S.role === 'superintendent') { tasks.push(pullPending()); tasks.push(pullActive()); }
        if (refsStale()) tasks.push(pullRefs());
      }
      return Promise.all(tasks);
    })
    .then(function() { S.lastSync = new Date().toISOString(); subscribePush(); return kvSet('last_sync',S.lastSync); })
    .catch(function(e) { requestBgSync(); toast('⚠️ Sync gagal: '+e.message); })
    .then(function() { S.syncing = false; return refreshOutbox(); })
    .then(renderAll);
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
    var chain = Promise.resolve();
    queue.forEach(function(it) {
      chain = chain.then(function() {
        return api(it.action, it.payload, it.op_id).then(function(r) {
          if (r.success) { it.status='done'; it.result=r.result; sent++; }
          else { it.status='failed'; it.error=(typeof r.error==='string')?r.error:JSON.stringify(r.error); }
          return obPut(it);
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
function pullRefs() {
  return api('pull_create_refs').then(function(r) {
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
function doLogin() {
  var t = document.getElementById('tokenInput').value.trim();
  if (!t) { toast('Isi token dulu'); return; }
  requestNotifPermission(); requestPeriodicSync();
  S.token = t;
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
      } else { toast('❌ '+(r.error||'Token ditolak')); S.token=null; }
    }).catch(function() { saveTokenOffline(t); });
  } else { saveTokenOffline(t); }
}
function saveTokenOffline(t) {
  kvSet('token',t).then(function() { toast('📴 Token disimpan — verifikasi saat ada sinyal'); showScreen('main'); renderAll(); });
}
function doLogout() {
  var pend = S.outbox.filter(function(o){return o.status==='queued'||o.status==='failed_retry';}).length;
  var msg = pend > 0
    ? '⚠️ PERHATIAN: masih ada '+pend+' operasi BELUM TERKIRIM di antrean.\nLogout akan MENGHAPUS antrean itu PERMANEN (laporan/approval hilang).\n\nSaran: batal, cari sinyal, tekan 🔄 Sync sampai antrean kosong, baru logout.\n\nTetap logout dan hapus antrean?'
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
function switchTab(tab) { S.tab = tab; renderAll(); }

/* ── Submit form (mekanik) ── */
var activeWo = null;
function openSubmitForm(woId) {
  activeWo = null;
  for (var i=0;i<S.wos.length;i++) if (String(S.wos[i].id)===String(woId)) activeWo=S.wos[i];
  if (!activeWo) return;
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
  var op = { op_id:uuid(), seq:(_enqSeq++), action:'submit_work', wo_id:activeWo.id, wo_number:activeWo.wo_number,
    payload:{wo_id:activeWo.id, start_time:new Date(st).toISOString(), end_time:new Date(en).toISOString(), hour_meter:hm, kilometers:km, part_type:part},
    status:'queued', created_at:new Date().toISOString() };
  obPut(op).then(refreshOutbox).then(function() {
    closeModal('submitModal'); renderAll();
    toast(navigator.onLine?'📮 Mengirim...':'📮 Tersimpan! Terkirim saat ada sinyal');
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
  document.getElementById('trAppDesc').innerHTML = 'WO: <b>' + esc(wo.wo_number) + '</b><br>Diminta oleh: <b>' + esc(wo.transfer_requested_by_name || wo.transfer_requested_by || wo.created_by_name || '-') + '</b>' +
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

/* ── Create WO form (SUM: component/unit/kondisi/others/team) ── */
function openCreateForm() {
  if (!S.refs) {
    if (navigator.onLine) {
      toast('⏳ Memuat data referensi...');
      pullRefs().then(function(){ if (S.refs) openCreateForm(); else toast('❌ Gagal memuat referensi'); })
        .catch(function(){ toast('❌ Gagal memuat referensi'); });
    } else { toast('📴 Sync dulu saat ada sinyal untuk memuat referensi'); }
    return;
  }
  if (navigator.onLine && (refsStale() || !(S.refs.work_conditions && S.refs.work_conditions.length))) { pullRefs().catch(function(){}); }
  // Pekerjaan (komponen + Others)
  var cSel = document.getElementById('cComp');
  cSel.innerHTML = '<option value="">-- Pilih Pekerjaan --</option>';
  var comps = S.refs.components || [];
  for (var ci=0;ci<comps.length;ci++) {
    if (String(comps[ci].component_no) === 'COM-OTHERS') continue; // Others jadi opsi terpisah di bawah
    cSel.innerHTML += '<option value="'+esc(comps[ci].component_no)+'">'+esc(comps[ci].component_name)+'</option>';
  }
  cSel.innerHTML += '<option value="COM-OTHERS">✏️ Others (job manual)</option>';
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
      toast(navigator.onLine?'📮 Mengirim...':'📮 Tersimpan! Terkirim saat ada sinyal');
    }
    syncNow(false);
  });
}
function resetCreateFieldsForNext(){
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
    (a.created_by_name ? '<br>👤 Pembuat: '+esc(a.created_by_name) : (a.created_by ? '<br>👤 Pembuat: '+esc(a.created_by) : ''))+
    (a.submitted_by_name ? '<br>✍️ Disubmit oleh: '+esc(a.submitted_by_name) : (a.submitted_by ? '<br>✍️ Disubmit oleh: '+esc(a.submitted_by) : ''))+
    (a.keterangan ? '<br>📝 '+esc(a.keterangan) : '');
  document.getElementById('aTeam').textContent = 'Tim: '+(a.team||[]).map(function(t){return t.name;}).join(', ');
  document.getElementById('aStatus').textContent = 'Status: '+a.status;
  var isL2 = (a.status === 'pending_superintendent');
  document.getElementById('aBtnL1').style.display = isL2 ? 'none' : 'block';
  document.getElementById('aBtnL2').style.display = isL2 ? 'block' : 'none';
  document.getElementById('aNotes').value='';
  document.getElementById('aSafety').checked = false;
  document.getElementById('aOvBp').value='';
  document.getElementById('aOvTh').value='';
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

function queueOverride() {
  var bp = document.getElementById('aOvBp').value.trim();
  var th = document.getElementById('aOvTh').value.trim();
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
  if (bp==='' && th==='' && !teamChanged) { toast('Tidak ada perubahan override'); return; }
  var payload = { wo_id:activeApproval.id };
  if (bp!=='') payload.base_points = parseFloat(bp);
  if (th!=='') payload.target_hours = parseFloat(th);
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
function showScreen(nm) {
  document.getElementById('screen-login').style.display = nm==='login'?'block':'none';
  document.getElementById('screen-main').style.display = nm==='main'?'block':'none';
}
function esc(s) { return String(s).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];}); }
function toast(msg) {
  var t=document.getElementById('toast'); t.textContent=msg; t.style.display='block';
  clearTimeout(t._h); t._h=setTimeout(function(){t.style.display='none';},3500);
}
function toggleOutboxDetail(){ S.showOutbox = !S.showOutbox; renderAll(); }
function opLabel(o){
  var names = {submit_work:'Submit', create_wo:'Buat WO', approve_l1:'L1', approve_l2:'L2', reject:'Reject', save_override:'Override', cancel_wo:'Batal', request_transfer:'Transfer WO', approve_transfer:'Approve Transfer', reject_transfer:'Reject Transfer'};
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
  document.getElementById('syncBtn').textContent=S.syncing?'⏳':'🔄 Sync';
  document.getElementById('lastSync').textContent=(S.lastSync?'Sync: '+new Date(S.lastSync).toLocaleString('id-ID'):'Belum sync')+' · '+APP_VERSION;
  document.getElementById('meName').textContent=S.me?(S.me.name||S.me.mechanic_id):'';
  // Peran → tab: mekanik=WO Saya; foreman=Buat WO; L1/L2=Buat WO + Approval
  var isMechanic = (S.role==='mechanic');
  var isApprover = (S.role==='supervisor' || S.role==='superintendent');
  var isForeman = (S.role==='foreman');
  var isCreator = !isMechanic; // foreman + approver
  if (isMechanic) S.tab='wos';
  else if (isForeman && S.tab!=='create') S.tab='create';
  else if (isApprover && S.tab==='wos') S.tab='approval';
  document.getElementById('tabBar').style.display = isCreator ? 'flex' : 'none';
  document.getElementById('tabWos').style.display = 'none'; // WO Saya hanya mekanik (tanpa tabBar)
  document.getElementById('tabCreate').style.display = isCreator ? '' : 'none';
  document.getElementById('tabApproval').style.display = isApprover ? '' : 'none';
  document.getElementById('tabCreate').className = 'tab'+(S.tab==='create'?' active':'');
  document.getElementById('tabApproval').className = 'tab'+(S.tab==='approval'?' active':'');
  // outbox info
  var queued = S.outbox.filter(function(o){return o.status==='queued'||o.status==='failed_retry';});
  var oi = document.getElementById('outboxInfo');
  oi.textContent = queued.length ? ('📮 '+queued.length+' menunggu sinyal '+(S.showOutbox?'▲':'▼')) : '';
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
  else if (S.tab==='approval' && isApprover) { renderApprovalTab(content); }
  else { renderCreateTab(content); }
}
function renderWos(el) {
  var opByWo={};
  S.outbox.forEach(function(o){if(o.wo_id&&(!opByWo[o.wo_id]||o.created_at>opByWo[o.wo_id].created_at))opByWo[o.wo_id]=o;});
  if (!S.wos.length) { el.innerHTML='<div class="empty">Belum ada kartu WO.<br>Tekan 🔄 Sync saat ada sinyal.</div>'; return; }
  var html='';
  S.wos.forEach(function(wo) {
    var op=opByWo[wo.id]; var b=badgeFor(wo,op);
    var canFill=String(wo.status)==='pending_mechanic_work'&&(!op||op.status==='failed'||op.status==='done');

    // Live Timer Widget
    var st = getTimerState(wo.id);
    var curMs = st.elapsed_ms + (st.state === 'running' ? (Date.now() - st.start_epoch) : 0);
    var timerControls = '';
    if (canFill) {
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

    html+='<div class="card"><div class="cardTop"><b>'+esc(wo.wo_number)+'</b><span class="badge" style="background:'+b[1]+'">'+b[0]+'</span>'+
      (wo.is_others?'<span class="badge" style="background:#0ea5e9">OTHERS</span>':'')+'</div>'+
      '<div class="cardBody"><b>'+esc(wo.component_name||'-')+'</b>'+(wo.unit_name?' · '+esc(wo.unit_name):'')+(wo.target_hours?' · Target: '+fmtJamMenit(wo.target_hours):'')+'<br>'+
      '📍 '+esc(locLabel(wo.location))+' · Kondisi: '+esc(wcLabel(wo.work_condition))+'</div>'+
      (wo.keterangan?'<div class="ket">📝 '+esc(wo.keterangan)+'</div>':'')+
      timerControls+
      (canFill?'<div style="display:flex;gap:6px;margin-top:10px">'+
        '<button class="big" style="margin-top:0;flex:1" onclick="openSubmitForm(\''+esc(String(wo.id))+'\')">✍️ Isi & Kirim</button>'+
        '<button class="big btnTransfer" style="margin-top:0;flex:1" onclick="openTransferModal(\''+esc(String(wo.id))+'\')">🔀 Transfer WO</button>'+
        '</div>':'')+
      '</div>';
  });
  el.innerHTML=html;
}
function renderCreateTab(el) {
  if (!S.refs) { el.innerHTML='<div class="empty">Tekan 🔄 Sync untuk memuat data referensi.</div>'; return; }
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
      return wo.status === 'pending_supervisor' || wo.status === 'pending_transfer';
    });
  } else if (S.role === 'superintendent') {
    filteredPending = S.pending.filter(function(wo) {
      return wo.status === 'pending_superintendent';
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
  if (sub==='approved' && !S.approved.length && navigator.onLine) { toast('⏳ Memuat approved...'); pullApproved().then(renderAll).catch(function(){}); }
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
function teamStr(team){ return (team||[]).map(function(t){ return esc(t.name||t.mechanic_name||t.mechanic_id||t)+(t.email?' <span class="sub" style="display:inline;margin:0">('+esc(t.email)+')</span>':''); }).join(', '); }
function ovBadges(wo){ return (wo.has_override_spv?'<span class="badge" style="background:#4338ca">SPV override</span>':'')+(wo.has_override_supt?'<span class="badge" style="background:#7c3aed">SUPT override</span>':''); }
function cancelBtn(wo){ return '<button class="big secondary" onclick="openCancelForm(\''+esc(String(wo.id))+'\',\''+esc(String(wo.wo_number))+'\')">🗑 Batalkan WO</button>'; }
function renderPendingList(list){
  var pendingList = list || S.pending;
  if (!pendingList.length) return '<div class="empty">Tidak ada WO menunggu approval.</div>';
  var html='<div class="sub">'+pendingList.length+' WO menunggu approval</div>';
  pendingList.forEach(function(wo){
    var isTransfer = (wo.status === 'pending_transfer');
    var isL2 = wo.status==='pending_superintendent';
    var othersBadge = wo.is_others ? '<span class="badge" style="background:#0ea5e9">OTHERS</span>' : '';
    var tl = wo.timeliness;
    var tlBadge = tl ? '<span class="badge" style="background:'+(tl.status==='on_time'?'#15803d':tl.status==='late'?'#b45309':'#b91c1c')+'">⏱️ '+esc(tl.label)+' ×'+tl.factor+'</span>' : '';
    var statusBadge = isTransfer
      ? '<span class="badge" style="background:#4f46e5">🔀 Pending Transfer</span>'
      : '<span class="badge" style="background:'+(isL2?'#b45309':'#7c3aed')+'">'+(isL2?'⏳ L2':'⏳ L1')+'</span>';

    var transferInfo = isTransfer
      ? '<br><b>🔀 Permintaan Transfer:</b>' +
        (wo.transfer_requested_by_name || wo.transfer_requested_by ? '<br>Diminta oleh: ' + esc(wo.transfer_requested_by_name || wo.transfer_requested_by) : '') +
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
      (wo.created_by_name?'👤 Pembuat: '+esc(wo.created_by_name)+'<br>':'')+
      (wo.submitted_by_name?'✍️ Disubmit: '+esc(wo.submitted_by_name)+'<br>':'')+
      '👥 Tim: '+teamStr(wo.team)+
      transferInfo +
      '</div>'+
      (wo.keterangan?'<div class="ket">📝 '+esc(wo.keterangan)+'</div>':'')+
      (function(){
        var q=queuedOpFor(wo.id);
        if (q) return queuedNote(q);
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
      'Kondisi: '+esc(wcLabel(wo.work_condition))+((wo.created_by_name||wo.created_by)?' · Pembuat: '+esc(wo.created_by_name||wo.created_by):'')+'<br>'+
      '👥 Tim: '+(teamNames||[]).map(function(n){return esc(n);}).join(', ')+'</div>'+
      (wo.keterangan?'<div class="ket">📝 '+esc(wo.keterangan)+'</div>':'')+
      (function(){ var q=queuedOpFor(wo.id); return q ? queuedNote(q) : cancelBtn(wo); })()+'</div>';
  });
  return html;
}
function renderApprovedList(){
  if (!S.approved.length) return '<div class="empty">Belum ada WO approved.<br>Tekan 🔄 Sync saat online.</div>';
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
    navigator.serviceWorker.register('./sw.js');
    var _swReloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', function() {
      if (_swReloaded) return; _swReloaded = true; window.location.reload();
    });
  }
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
});
