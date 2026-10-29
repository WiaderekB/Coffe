const database = new Promise((resolve, reject) => {
  const request = indexedDB.open('moja-kawa', 1);
  request.onupgradeneeded = () => request.result.createObjectStore('app');
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(Error('Nie można otworzyć pamięci urządzenia. Wyłącz tryb prywatny lub zezwól na dane witryny.'));
});
const channel = 'BroadcastChannel' in globalThis ? new BroadcastChannel('moja-kawa') : null;
export let state = null;
export let status = 'loading';
let running = false;
let stoppedForConflict = false;
let change = () => {};
export function subscribe(fn) { change = fn; }
function signal() { change(); }
async function transaction(update) {
  const db = await database;
  return new Promise((resolve, reject) => {
    const tx = db.transaction('app', update ? 'readwrite' : 'readonly');
    const store = tx.objectStore('app');
    const req = store.get('state');
    let result;
    req.onsuccess = () => {
      try { result = update ? update(req.result) : req.result; if (update) store.put(result,'state'); }
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
      throw error;
    }
    return response.json();
  } finally { clearTimeout(timeout); }
}
export async function init() {
  state = await transaction();
  if (!state) {
    const remote = await request('/api/state');
    state = await transaction(old => old || {...remote,dirty:false,changeId:crypto.randomUUID()});
  }
  status = state.dirty ? 'pending' : navigator.onLine ? 'saved' : 'offline';
  signal();
  void sync();
}
export async function edit(mutator) {
  state = await transaction(old => {
    if (!old) throw Error('Najpierw otwórz aplikację z dostępem do serwera.');
    const next = structuredClone(old);
    mutator(next.coffees);
    if (next.coffees.length > 1000 || next.coffees.some(c => c.recipes.length > 100)) throw Error('Limit: 1000 kaw i 100 przepisów na kawę.');
    if (new TextEncoder().encode(JSON.stringify(next.coffees)).length > 1800000) throw Error('Kolekcja przekracza limit 1,8 MB. Pobierz kopię i skróć notatki.');
    return {...next,dirty:true,changeId:crypto.randomUUID()};
  });
  status = stoppedForConflict ? 'conflict' : 'pending';
  channel?.postMessage('changed');
  signal();
  void sync();
}
export async function sync() {
  if (running || stoppedForConflict || !state) return;
  if (!navigator.onLine) { status = state.dirty ? 'pending' : 'offline'; signal(); return; }
  running = true;
  let repeat = false;
  try {
    state = await transaction();
    const sent = structuredClone(state);
    status = 'syncing'; signal();
    const remote = sent.dirty ? await request('/api/sync', {coffees:sent.coffees,revision:sent.revision}) : await request('/api/state');
    state = await transaction(current => {
      if (current.changeId === sent.changeId) return {...remote,dirty:false,changeId:crypto.randomUUID()};
      // Edits made while this request was in flight are retained and sent next.
      return sent.dirty ? {...current,revision:remote.revision} : current;
    });
    status = state.dirty ? 'pending' : 'saved';
    repeat = state.dirty;
    channel?.postMessage('synced');
  } catch (error) {
    if (error.status === 409) { stoppedForConflict = true; status = 'conflict'; }
    else if (error.status === 401) status = 'auth';
    else if (error.status) status = 'rejected';
    else status = state?.dirty ? 'pending' : 'offline';
  } finally { running = false; signal(); if (repeat) void sync(); }
}
export async function useServer() {
  if (running) throw Error('Poczekaj na zakończenie synchronizacji.');
  const remote = await request('/api/state');
  state = await transaction(() => ({...remote,dirty:false,changeId:crypto.randomUUID()}));
  stoppedForConflict = false; status = 'saved'; channel?.postMessage('synced'); signal();
}
channel?.addEventListener('message', async () => { state = await transaction(); signal(); });
window.addEventListener('online', () => void sync());
window.addEventListener('offline', () => { if (!stoppedForConflict) status = state?.dirty ? 'pending' : 'offline'; signal(); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void sync(); });
setInterval(() => { if (document.visibilityState === 'visible') void sync(); }, 30000);
