import {grinderKey} from './grinder.js';
import {coffeeInfo, defaultAccent, reconcileSyncedState} from './core.js';
const database = new Promise((resolve, reject) => {
  const request = indexedDB.open('moja-kawa', 1);
  request.onupgradeneeded = () => request.result.createObjectStore('app');
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(Error('Nie można otworzyć pamięci urządzenia. Wyłącz tryb prywatny lub zezwól na dane witryny.'));
});
const channel = 'BroadcastChannel' in globalThis ? new BroadcastChannel('moja-kawa') : null;
export let state = null;
export let grinderMemory = null;
export let grinderSyncStatus = 'loading';
let grinderRunning = false;
export let status = 'loading';
export let access = 'checking';
export let auth = {required:false,authenticated:false,username:''};
let generation = 0;
let running = false;
let stoppedForConflict = false;
let change = () => {};
export function subscribe(fn) { change = fn; }
function signal() { change(); }
async function transaction(update,key='state') {
  const db = await database;
  return new Promise((resolve, reject) => {
    const tx = db.transaction('app', update ? 'readwrite' : 'readonly');
    const store = tx.objectStore('app');
    const req = store.get(key);
    let result;
    req.onsuccess = () => {
      try { result = update ? update(req.result) : req.result; if (update) { if (result === null) store.delete(key); else store.put(result,key); } }
      catch (err) { tx.abort(); reject(err); }
    };
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(Error('Nie udało się zapisać danych na urządzeniu. Zwolnij miejsce i spróbuj ponownie.'));
    tx.onabort = () => reject(Error('Zapis przerwany. Zmiany nie zostały zapisane.'));
  });
}
async function request(path, body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(),8000);
  try {
    const response = await fetch(path,{cache:'no-store',signal:controller.signal,...(body ? {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)} : {})});
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      const error = Error(data.error || (response.status === 401 ? 'Zaloguj się ponownie, aby zsynchronizować dane.' : 'Serwer nie przyjął zmian.'));
      error.status = response.status;
      error.data = data;
      throw error;
    }
    return response.json();
  } finally { clearTimeout(timeout); }
}
export async function init() {
  const local = await transaction();
  state = local;
  access = 'checking';
  let onlineAuth = false;
  try {
    auth = await request('/api/auth');
    onlineAuth = true;
  } catch (error) {
    if (error.status || !local?.offlineAccess) throw error;
  }
  if (onlineAuth && auth.required && !auth.authenticated) {
    access = 'login'; status = 'auth'; signal(); return;
  }
  if (!state) {
    const remote = await request('/api/state');
    state = await transaction(old => old || {...remote,dirty:false,changeId:crypto.randomUUID(),schemaVersion:2,offlineAccess:true,username:auth.username,authRequired:auth.required});
  } else if (state.schemaVersion !== 2) {
    // Keep old offline edits. A matching legacy revision permits a safe schema-only rebase.
    const remote = onlineAuth ? await request('/api/state') : null;
    state = await transaction(current => {
      if (!current) return null;
      if (!current.dirty && remote) return {...remote,dirty:false,changeId:crypto.randomUUID(),schemaVersion:2,offlineAccess:true,username:auth.username,authRequired:auth.required};
      return {...current,coffees:current.coffees.map(c => ({...c,...coffeeInfo({...remote?.coffees.find(item => item.id === c.id),...c,accent:c.accent ?? remote?.coffees.find(item => item.id === c.id)?.accent ?? defaultAccent(c.id)})})),
        revision:remote && current.revision === remote.legacyRevision ? remote.revision : current.revision,
        schemaVersion:2,offlineAccess:true,username:auth.username,authRequired:auth.required};
    });
  } else if (onlineAuth) {
    state = await transaction(current => current ? {...current,offlineAccess:true,username:auth.username,authRequired:auth.required} : null);
  }
  if (!state) {access = 'login';status = 'auth';signal();return;}
  if (!onlineAuth) auth = {required:state.authRequired ?? true,authenticated:true,username:state.username || ''};
  access = 'ready';
  grinderMemory = await transaction(undefined,'grinders');
  grinderSyncStatus = grinderMemory?.conflict ? 'conflict' : grinderMemory?.dirty ? 'pending' : onlineAuth ? 'saved' : 'offline';
  status = state.dirty ? 'pending' : onlineAuth ? 'saved' : 'offline';
  signal();
  void sync();
}
export async function login(username,password) {
  auth = await request('/api/login',{username,password});
  generation++;
  await init();
}
export async function logout() {
  // A server-confirmed logout revokes the HttpOnly session as well as local access.
  await request('/api/logout',{});
  generation++;
  state = await transaction(() => null);
  grinderMemory = await transaction(() => null,'grinders');
  grinderSyncStatus = 'loading';
  auth = {...auth,authenticated:false,username:''};
  access = 'login'; status = 'auth'; stoppedForConflict = false;
  channel?.postMessage('logout'); signal();
}

export async function readCoffees() {
  if (access !== 'ready') throw Error('Zaloguj się przed otwarciem przepiśnika.');
  state = await transaction();
  if (!state) throw Error('Przepiśnik został wylogowany w innej karcie.');
  signal();
  return structuredClone(state.coffees);
}
export async function getHistory(versionId) { return request(versionId ? `/api/history/${versionId}` : '/api/history'); }
export async function edit(mutator,label = 'Zmieniono przepisy') {
  if (access !== 'ready') throw Error('Zaloguj się przed zmianą przepisów.');
  state = await transaction(old => {
    if (!old) throw Error('Najpierw otwórz aplikację z dostępem do serwera.');
    const next = structuredClone(old);
    mutator(next.coffees);
    if (next.coffees.length > 1000 || next.coffees.some(c => c.recipes.length > 100)) throw Error('Limit: 1000 kaw i 100 przepisów na kawę.');
    if (new TextEncoder().encode(JSON.stringify(next.coffees)).length > 1800000) throw Error('Kolekcja przekracza limit 1,8 MB. Pobierz kopię i skróć notatki.');
    return {...next,dirty:true,changeId:crypto.randomUUID(),pendingLabel:label};
  });
  status = stoppedForConflict ? 'conflict' : 'pending';
  channel?.postMessage('changed');
  signal();
  void sync();
}
export async function sync() {
  void syncGrinders();
  if (running || stoppedForConflict || !state || access !== 'ready') return;
  if (!navigator.onLine) { status = state.dirty ? 'pending' : 'offline'; signal(); return; }
  running = true;
  let repeat = false;
  const requestGeneration = generation;
  try {
    state = await transaction();
    if (!state || access !== 'ready') return;
    const sent = structuredClone(state);
    status = 'syncing'; signal();
    const remote = sent.dirty ? await request('/api/sync', {coffees:sent.coffees,revision:sent.revision,label:sent.pendingLabel || 'Zmieniono przepisy'}) : await request('/api/state');
    if (requestGeneration !== generation) return;
    state = await transaction(current => reconcileSyncedState(current,sent,remote));
    if (!state) return;
    status = state.dirty ? 'pending' : 'saved';
    repeat = state.dirty;
    channel?.postMessage('synced');
  } catch (error) {
    if (requestGeneration !== generation) return;
    if (error.status === 409) { stoppedForConflict = true; status = 'conflict'; }
    else if (error.status === 401) { status = 'auth'; access = 'login'; auth = {...auth,authenticated:false}; }
    else if (error.status) status = 'rejected';
    else status = state?.dirty ? 'pending' : 'offline';
  } finally { running = false; signal(); if (repeat) void sync(); }
}
export async function useServer() {
  if (running) throw Error('Poczekaj na zakończenie synchronizacji.');
  const remote = await request('/api/state');
  state = await transaction(() => ({...remote,dirty:false,changeId:crypto.randomUUID(),schemaVersion:2,offlineAccess:true,username:auth.username,authRequired:auth.required}));
  stoppedForConflict = false; status = 'saved'; channel?.postMessage('synced'); signal();
}
channel?.addEventListener('message', async event => {
  state = await transaction();
  grinderMemory = await transaction(undefined,'grinders');
  if (grinderMemory?.conflict) grinderSyncStatus = 'conflict';
  else if (grinderMemory?.dirty) grinderSyncStatus = 'pending';
  else if (event.data === 'grinders-synced') grinderSyncStatus = 'saved';
  if (event.data === 'logout' || !state) {generation++;access = 'login';status = 'auth';auth = {...auth,authenticated:false};}
  signal();
});
window.addEventListener('online', () => void sync());
window.addEventListener('offline', () => { if (!stoppedForConflict) status = state?.dirty ? 'pending' : 'offline'; signal(); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void sync(); });
setInterval(() => { if (document.visibilityState === 'visible') void sync(); }, 30000);


export async function saveGrinder(name,setting) {
  name = name.trim(); setting = setting.trim();
  if (!name || name.length > 120 || !setting || setting.length > 180) throw Error('Podaj nazwę młynka i jego ustawienie.');
  if (access !== 'ready') throw Error('Najpierw zaloguj się w aplikacji.');
  grinderMemory = await transaction(old => {
    const next = structuredClone(old || {grinders:[],revision:null});
    if (next.conflict) throw Error('Najpierw porównaj ustawienia z drugim urządzeniem.');
    const item = next.grinders.find(item => grinderKey(item.name) === grinderKey(name));
    if (item) item.setting = setting;
    else next.grinders.push({name,setting});
    if (next.grinders.length > 20) throw Error('Maksymalnie 20 młynków.');
    return {...next,dirty:true,changeId:crypto.randomUUID()};
  },'grinders');
  grinderSyncStatus = 'pending'; signal(); channel?.postMessage('grinders-changed');
  void syncGrinders();
}
export async function syncGrinders() {
  if (grinderRunning || access !== 'ready') return;
  if (!navigator.onLine) {grinderSyncStatus = grinderMemory?.dirty ? 'pending' : 'offline';signal();return;}
  grinderRunning = true;
  const requestGeneration = generation;
  let repeat = false;
  try {
    grinderMemory = await transaction(old => old || {grinders:[],revision:null,dirty:false,changeId:crypto.randomUUID()},'grinders');
    if (grinderMemory.conflict) {grinderSyncStatus = 'conflict';return;}
    const sent = structuredClone(grinderMemory);
    grinderSyncStatus = 'syncing'; signal();
    const remote = sent.dirty ? await request('/api/grinders',{grinders:sent.grinders,revision:sent.revision}) : await request('/api/grinders');
    if (generation !== requestGeneration || access !== 'ready') return;
    grinderMemory = await transaction(current => reconcileSyncedState(current,sent,remote),'grinders');
    if (!grinderMemory) return;
    grinderSyncStatus = grinderMemory.dirty ? 'pending' : 'saved';
    repeat = grinderMemory.dirty;
    channel?.postMessage('grinders-synced');
  } catch (error) {
    if (generation !== requestGeneration) return;
    if (error.status === 409) {
      grinderMemory = await transaction(current => current ? {...current,conflict:error.data} : null,'grinders');
      grinderSyncStatus = 'conflict'; channel?.postMessage('grinders-conflict');
    } else if (error.status === 401) {
      grinderSyncStatus = 'auth'; status = 'auth'; access = 'login'; auth = {...auth,authenticated:false};
    } else grinderSyncStatus = error.status ? 'rejected' : grinderMemory?.dirty ? 'pending' : 'offline';
  } finally {grinderRunning = false;signal();if (repeat) void syncGrinders();}
}
export async function resolveGrinders(keepLocal=false) {
  if (access !== 'ready') throw Error('Najpierw zaloguj się w aplikacji.');
  if (grinderRunning) throw Error('Poczekaj na zakończenie synchronizacji.');
  const requestGeneration = generation;
  const remote = await request('/api/grinders');
  if (generation !== requestGeneration || access !== 'ready') return;
  grinderMemory = await transaction(current => {
    if (!current) return null;
    return {...current,...remote,grinders:keepLocal ? current.grinders : remote.grinders,
      conflict:null,dirty:keepLocal,changeId:crypto.randomUUID()};
  },'grinders');
  grinderSyncStatus = keepLocal ? 'pending' : 'saved';
  signal();channel?.postMessage('grinders-changed');
  void syncGrinders();
}
