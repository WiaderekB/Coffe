import {grinderKey, parseGrind, clickSetting, grinderStatus} from './grinder.js';
import * as Store from './store.js';
import {recipe as validateRecipe, coffee as validateCoffee, parseImport, mergeImport, id, ACCENTS, COFFEE_FIELDS, coffeeInfo, coffeeKey, removeCoffee} from './core.js';
const app = document.querySelector('#app');
const dialog = document.querySelector('#editor');
const editor = document.querySelector('#editor-body');
let coffees = [], loading = true, loadError = '', search = '', toastTimeout, installPrompt, registration;
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt = n => new Intl.NumberFormat('pl-PL',{maximumFractionDigits:1}).format(n);
const lines = s => s.split('\n').map(s => s.trim()).filter(Boolean);
const button = (label, action, cls = 'subtle') => `<button type="button" class="button ${cls}" data-action="${action}">${label}</button>`;
const coffeePlural = n => n === 1 ? 'kawa' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? 'kawy' : 'kaw';
const icon = name => `<svg class="ui-icon" width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><use href="/icons.svg#${name}"></use></svg>`;
const menuButton = (label,action,name,cls='subtle') => button(`${icon(name)}<span>${esc(label)}</span>`,action,cls);
const plural = n => n === 1 ? 'przepis' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? 'przepisy' : 'przepisów';
function toast(message) {
  const element = document.querySelector('#toast'); element.textContent = message; element.classList.add('visible');
  clearTimeout(toastTimeout); toastTimeout = setTimeout(() => element.classList.remove('visible'),4000);
}
function selection() {
  const match = location.hash.match(/^#coffee\/(\d+)(?:\/(\d+))?$/);
  const coffee = match && coffees.find(c => c.id === Number(match[1]));
  return {coffee, recipe:coffee && (coffee.recipes.find(r => r.id === Number(match[2])) || coffee.recipes[0])};
}
function connection() {
  const labels = {loading:'Otwieram…',saved:'Zapisano',syncing:'Synchronizuję',pending:'Zmiany na urządzeniu',offline:'Offline',conflict:'Dwie wersje',auth:'Wymagane logowanie',rejected:'Sprawdź synchronizację'};
  const priorities = ['auth','conflict','rejected','pending','syncing','offline','loading','saved'];
  const combined = priorities.find(value => value === Store.status || value === Store.grinderSyncStatus) || Store.status;
  const status = document.querySelector('#connection'); status.textContent = labels[combined]; status.dataset.status = combined;
  status.setAttribute('aria-label',`Synchronizacja: ${labels[combined]}. Pokaż szczegóły`);
}
function coffeeTone(coffee) { return `coffee-accent-${Object.hasOwn(ACCENTS,coffee.accent) ? coffee.accent : 'rose'}`; }
function render() {
  const inlineFocus = document.activeElement?.closest('.grinder-inline') ? {id:document.activeElement.id,action:document.activeElement.dataset.action} : null;
  connection();
  document.querySelector('.bottom-nav').hidden = loading || !!loadError || Store.access !== 'ready';
  document.querySelector('#connection').hidden = Store.access !== 'ready';
  if (loading) return;
  if (Store.access === 'login') {dialog.close();renderLogin();return;}
  if (loadError) { app.innerHTML = `<div class="empty"><h2>Otwórz przepiśnik online</h2><p>${esc(loadError)}</p>${button('Spróbuj ponownie','retry','')}</div>`; return; }
  const {coffee,recipe} = selection();
  document.title = coffee ? `${coffee.name} · Moja kawa` : 'Moja kawa';
  if (!coffee) return renderHome();
  app.innerHTML = `<div class="detail-content ${coffeeTone(coffee)}"><a href="#" class="back">← Twoje kawy</a>
    <section class="coffee-heading"><span class="eyebrow">TWOJA KAWA</span><h1>${esc(coffee.name)}</h1>${coffee.description ? `<p class="coffee-description">${esc(coffee.description)}</p>` : ''}<img src="/cup.svg" alt="" width="177" height="200"><button class="heading-edit" data-action="edit-coffee" aria-label="Edytuj kawę">✎</button></section>
    ${coffeeFacts(coffee)}
    <section class="volume-area" aria-label="Wybierz ilość wody"><div class="volume-options">${coffee.recipes.map(r => `<button class="volume ${recipe?.id === r.id ? 'selected' : ''}" data-recipe="${r.id}" aria-pressed="${recipe?.id === r.id}">${fmt(r.volume)} ml${coffee.recipes.filter(other => other.volume === r.volume).length > 1 ? `<small>${esc(r.method || 'Wariant')} · ${coffee.recipes.indexOf(r)+1}</small>` : ''}</button>`).join('')}<button class="volume add" data-action="add-recipe" aria-label="Dodaj wariant">＋</button></div></section>
    ${recipe ? recipeView(recipe) : `<div class="empty">Brak przepisów. ${button('+ Dodaj przepis','add-recipe','')}</div>`}
    <div class="detail-actions">${button('＋ Nowy wariant','add-recipe')}${button('↥ Import do tej kawy','import')}</div></div>`;
  if (inlineFocus) {
    const control = inlineFocus.id ? document.getElementById(inlineFocus.id) : app.querySelector(`[data-action="${inlineFocus.action}"]`);
    control?.focus({preventScroll:true});
  }
}
function renderHome() {
  app.innerHTML = `<div class="home-layout"><section class="hero"><span class="eyebrow">TWÓJ PRZEPIŚNIK</span><h1>Twoja kawa.<br>Twój sposób.</h1><p>Zapisz. Wybierz porcję. Zaparz.</p><img src="/cup.svg" width="193" height="218" alt=""></section><section>
    ${coffees.length > 4 ? `<div class="search"><label><span class="eyebrow">SZUKAJ KAWY</span><input id="search" type="search" value="${esc(search)}" placeholder="Nazwa kawy…" autocomplete="off"></label></div>` : ''}
    <div class="section-heading"><h2>Twoje kawy <span class="count">${coffees.length.toString().padStart(2,'0')}</span></h2>${button('＋ Dodaj','add-coffee','small')}</div><div id="coffee-grid"></div></section></div>`;
  renderCards();
  document.querySelector('#search')?.addEventListener('input', event => { search = event.target.value; renderCards(); });
}
function renderCards() {
  const filtered = coffees.filter(c => c.name.toLocaleLowerCase('pl').includes(search.toLocaleLowerCase('pl')));
  document.querySelector('#coffee-grid').innerHTML = filtered.length ? `<div class="grid">${filtered.map(c => `<a class="coffee-card ${coffeeTone(c)}" href="#coffee/${c.id}"><h2>${esc(c.name)}</h2><p class="card-description">${esc([c.roaster,c.country].filter(Boolean).join(' · ') || c.description || 'Twój przepis na dobrą kawę.')}</p><div class="cup-wrap"><img src="/cup.svg" alt="" width="168" height="190"></div><div class="card-bottom"><span>${c.recipes.length} ${plural(c.recipes.length)}</span><span class="arrow" aria-hidden="true">↗</span></div></a>`).join('')}</div>` : `<div class="empty">${search ? 'Nie znaleziono kawy.' : 'Dodaj swoją pierwszą kawę lub zaimportuj przepisy.'}</div>`;
}
function recipeView(r) {
  let total = 0;
  return `<section data-recipe-view aria-label="Przepis na ${fmt(r.volume)} ml"><div class="recipe-top"><h2>Przepis${r.method ? `<span class="tag">${esc(r.method)}</span>` : ''}</h2><button class="edit-recipe" data-action="edit-recipe">Edytuj przepis ↗</button></div>
    ${grinderCard(r)}
    <div class="stats"><div class="stat"><span>KAWA</span><strong>${fmt(r.dose)}<small> g</small></strong></div><div class="stat"><span>WODA</span><strong>${fmt(r.volume)}<small> g</small></strong></div><div class="stat"><span>TEMP.</span><strong>${fmt(r.temperature)}<small> °C</small></strong></div><div class="stat"><span>PROPORCJA</span><strong>1:${fmt(r.volume/r.dose)}</strong></div></div>
    <div class="equipment">${[['Dripper',r.dripper],['Czas',r.duration],['Napar',r.yield]].filter(([,v]) => v).map(([k,v]) => `<span>${k}: <b>${esc(v)}</b></span>`).join('')}</div>
    <div class="recipe-columns"><section class="panel"><h2>Zalania</h2>${r.pours.length ? `<table><thead><tr><th scope="col">CZAS</th><th scope="col">DOLEJ</th><th scope="col">SUMA</th></tr></thead><tbody>${r.pours.map(p => {total += p.amount; return `<tr><td>${esc(p.time)}</td><td>${fmt(p.amount)} g</td><td>${fmt(total)} g</td></tr>`;}).join('')}${r.duration ? `<tr class="finish"><td>${esc(r.duration)}</td><td colspan="2">Koniec parzenia</td></tr>` : ''}</tbody></table>` : '<p class="intro">Bez podziału na zalania.</p>'}</section><div class="instructions">${r.steps.length ? `<details class="panel"><summary>Przygotowanie <small>${r.steps.length} kroków</small></summary><ol class="steps">${r.steps.map(s => `<li>${esc(s)}</li>`).join('')}</ol></details>` : ''}${r.notes ? `<details class="panel"><summary>Uwagi</summary><div class="notes">${esc(r.notes)}</div></details>` : ''}</div></div></section>`;
}
function grinderSyncLabel() {
  return {loading:'Odczytuję pamięć…',saved:'Pamięć młynka zsynchronizowana.',syncing:'Synchronizuję ustawienie…',pending:'Zapisano na urządzeniu. Czeka na synchronizację.',offline:'Ostatnie zapamiętane ustawienie · offline.',conflict:'Dwa urządzenia zapisały różne ustawienia.',auth:'Zaloguj się ponownie, aby wysłać ustawienie.',rejected:'Nie udało się zsynchronizować ustawienia. Spróbuj ponownie.'}[Store.grinderSyncStatus] || '';
}
let inlineGrinderDraft = null;
let inlineGrinderSaving = false;
function grinderCard(recipe) {
  const status = grinderStatus(recipe.grind,Store.grinderMemory?.grinders);
  const conflict = Store.grinderSyncStatus === 'conflict';
  const kind = conflict ? 'warning' : status.kind;
  const label = conflict ? 'Porównaj' : kind === 'ok' ? 'Zgodne' : kind === 'warning' ? 'Przestaw' : 'Sprawdź';
  const numeric = status.target && clickSetting(status.current?.setting || status.target.setting);
  const targetClicks = status.target && clickSetting(status.target.setting);
  const draftKey = `${recipe.id}:${status.target?.name}`;
  const draft = inlineGrinderDraft?.key === draftKey ? inlineGrinderDraft : null;
  const sameScale = numeric && targetClicks && numeric.suffix === targetClicks.suffix;
  const comparison = status.current && sameScale ? `Teraz ${numeric.value} · przepis ${status.target.setting}` :
    status.target ? `${status.current ? 'Teraz '+status.current.setting : 'Nie zapamiętano'} · przepis ${status.target.setting}` : recipe.grind ? 'Dodaj model i ustawienie w edycji przepisu' : 'Dodaj ustawienie w przepisie';
  const syncNote = {pending:'Zapis na urządzeniu',offline:'Offline',conflict:'Sprawdź zapis z drugiego urządzenia',auth:'Zaloguj się ponownie',rejected:'Sprawdź synchronizację'}[Store.grinderSyncStatus];
  return `<section class="grinder grinder-memory grinder-${kind}" aria-label="Ustawienie młynka"><button type="button" class="grinder-summary" data-action="grinder" aria-label="${esc(status.target?.name || 'Młynek')}. ${esc(comparison)}. ${label}. Zmień ustawienie"><span class="grinder-symbol">${icon('grinder')}</span><span class="grinder-copy"><span class="grinder-title"><strong>${esc(status.target?.name || recipe.grind || 'Młynek')}</strong><span class="grinder-result">${kind === 'ok' ? '✓' : kind === 'warning' ? '!' : '○'} ${label}</span></span><span class="grinder-comparison">${esc(comparison)}</span>${syncNote ? `<span class="grinder-sync-note">${esc(syncNote)}</span>` : ''}</span><span class="grinder-chevron" aria-hidden="true">↗</span></button><div class="grinder-inline">${numeric && !conflict ? `<form id="inline-grinder-form" data-dirty="${!!draft}" aria-label="Zmień zapamiętane ustawienie"><label for="inline-grinder-value">Teraz ustawione</label><div class="inline-grinder-dial"><button type="button" class="dial-button" data-action="grinder-minus" aria-label="Zmniejsz o jeden klik" ${inlineGrinderSaving || (!status.current && !draft) ? 'disabled' : ''}>−</button><input id="inline-grinder-value" aria-label="Aktualna liczba klików" type="number" inputmode="numeric" min="0" max="1000" step="1" required value="${esc(draft ? draft.value : status.current ? numeric.value : '')}" placeholder="—"><button type="button" class="dial-button" data-action="grinder-plus" aria-label="Zwiększ o jeden klik" ${inlineGrinderSaving || (!status.current && !draft) ? 'disabled' : ''}>+</button><button class="button small inline-grinder-save" type="submit" ${inlineGrinderSaving ? 'disabled' : ''}>Zapisz</button></div><div class="inline-grinder-footer"><small>${esc(numeric.suffix.trim())}</small>${kind !== 'ok' && targetClicks ? `<button type="button" data-action="grinder-match" ${inlineGrinderSaving ? 'disabled' : ''}>Ustaw ${targetClicks.value} ↗</button>` : '<span class="inline-grinder-hint">Zmieniaj po przestawieniu młynka</span>'}</div></form>` : button(conflict ? 'Porównaj ustawienia' : 'Zapisz ustawienie','grinder','subtle small')}</div></section>`;
}
async function setInlineGrinder(action) {
  if (inlineGrinderSaving) return;
  const {recipe} = selection();
  if (!recipe) return;
  const status = grinderStatus(recipe.grind,Store.grinderMemory?.grinders);
  if (!status.target || Store.grinderMemory?.conflict) return grinderEditor();
  const numeric = clickSetting(status.current?.setting || status.target.setting);
  if (!numeric) return grinderEditor();
  const input = document.querySelector('#inline-grinder-value');
  let setting = status.target.setting;
  if (action !== 'match') {
    if (!input?.reportValidity()) return;
    const value = Number(input.value) + (action === 'minus' ? -1 : action === 'plus' ? 1 : 0);
    if (!Number.isInteger(value) || value < 0 || value > 1000) return;
    setting = value + numeric.suffix;
  }
  const focus = document.activeElement?.id || document.activeElement?.dataset.action;
  inlineGrinderSaving = true;
  try {
    await Store.saveGrinder(status.target.name,setting);
    inlineGrinderDraft = null;
  } catch (error) {toast(error.message);}
  finally {
    inlineGrinderSaving = false;render();
    const control = focus === 'inline-grinder-value' ? document.getElementById(focus) : app.querySelector(`[data-action="${focus}"]`);
    control?.focus({preventScroll:true});
  }
}

function refreshGrinderDialog() {
  const label = editor.querySelector('[data-grinder-sync]');
  if (!label) return;
  label.textContent = grinderSyncLabel();
  const conflict = editor.querySelector('[data-grinder-conflict]');
  conflict.hidden = !Store.grinderMemory?.conflict;
  if (!conflict.hidden) {
    const remote = Store.grinderMemory.conflict.grinders || [];
    conflict.querySelector('[data-remote-grinders]').textContent = remote.map(item => `${item.name}: ${item.setting}`).join(' · ') || 'Brak ustawień na serwerze.';
    conflict.querySelector('[data-local-grinders]').textContent = (Store.grinderMemory.grinders || []).map(item => `${item.name}: ${item.setting}`).join(' · ');
  }
  editor.querySelector('#grinder-save').disabled = !conflict.hidden;
}
function grinderEditor() {
  const target = parseGrind(selection().recipe?.grind);
  const known = new Map();
  for (const item of [...(Store.grinderMemory?.grinders || []),...coffees.flatMap(c => c.recipes.map(r => parseGrind(r.grind)).filter(Boolean))]) {
    if (!known.has(grinderKey(item.name))) known.set(grinderKey(item.name),item.name);
  }
  const name = target?.name || known.values().next().value || '';
  openEditor(`<h2>Pamięć młynka</h2><p class="intro">Przestaw młynek, a potem zapisz jego aktualne ustawienie.</p><form id="grinder-form">${field('Młynek','grinder-name',name,'required maxlength="120" list="grinder-names" placeholder="np. Timemore C3S" autocomplete="off"')}<datalist id="grinder-names">${[...known.values()].map(name => `<option value="${esc(name)}"></option>`).join('')}</datalist><div id="grinder-control"></div><p class="help" data-grinder-sync role="status"></p><div class="warning grinder-conflict" data-grinder-conflict hidden><strong>Sprawdź fizyczne ustawienie młynka</strong><p>To urządzenie: <span data-local-grinders></span></p><p>Serwer: <span data-remote-grinders></span></p><div class="form-actions">${button('Wczytaj z serwera','grinder-server')}${button('Zachowaj zapis z tego urządzenia','grinder-local','')}</div></div><p class="error" role="alert"></p><div class="form-actions">${button('Anuluj','cancel')}<button class="button" id="grinder-save" type="submit">Zapisz ustawienie</button></div></form>`);
  const form = editor.querySelector('#grinder-form');
  const nameInput = form.elements['grinder-name'];
  let suffix = '';
  const loadSetting = () => {
    const current = Store.grinderMemory?.grinders.find(item => grinderKey(item.name) === grinderKey(nameInput.value));
    const expected = target && grinderKey(target.name) === grinderKey(nameInput.value) ? target : null;
    const numeric = clickSetting(current?.setting || expected?.setting || '');
    suffix = numeric?.suffix || '';
    const value = current?.setting || '';
    editor.querySelector('#grinder-control').innerHTML = `${numeric ? `<label class="grinder-setting-label" for="grinder-value">Aktualne ustawienie</label><div class="grinder-dial"><button type="button" class="dial-button" data-dial="-1" aria-label="Zmniejsz o jeden klik">−</button><input id="grinder-value" name="grinder-setting" aria-label="Aktualna liczba klików" type="number" inputmode="numeric" min="0" max="1000" step="1" required value="${current ? numeric.value : ''}" placeholder="—"><button type="button" class="dial-button" data-dial="1" aria-label="Zwiększ o jeden klik">+</button></div><p class="dial-unit">${esc(suffix.trim())}</p>` : field('Aktualne ustawienie','grinder-setting',value,'id="grinder-value" required maxlength="180" placeholder="np. 17 klików od zera"')}<div class="grinder-target">${expected ? `<span>Ten przepis wymaga <strong>${esc(expected.setting)}</strong></span><button class="button subtle small" type="button" id="use-recipe-setting">Ustaw ${esc(expected.setting)}</button>` : '<span>Zapamiętane ustawienie będzie wspólne dla przepisów tego młynka.</span>'}</div>`;
    editor.querySelector('#use-recipe-setting')?.addEventListener('click',() => {
      const input = form.elements['grinder-setting'];
      input.value = numeric ? clickSetting(expected.setting)?.value ?? '' : expected.setting;
      // Keep the recipe's reference point when explicitly selecting its setting.
      if (numeric && clickSetting(expected.setting)) suffix = clickSetting(expected.setting).suffix;
      const unit = editor.querySelector('.dial-unit'); if (unit) unit.textContent = suffix.trim();
    });
  };
  nameInput.addEventListener('change',loadSetting);
  form.addEventListener('click',event => {
    const step = event.target.closest('[data-dial]')?.dataset.dial;
    if (!step) return;
    const input = form.elements['grinder-setting'];
    input.value = Math.max(0,Math.min(1000,Number(input.value || 0) + Number(step)));
  });
  loadSetting(); refreshGrinderDialog();
  form.onsubmit = async event => {
    event.preventDefault();
    await save(form,async () => {
      const setting = form.elements['grinder-setting'].value.trim();
      await Store.saveGrinder(nameInput.value,setting + suffix);
      dialog.close();render();toast('Zapamiętano ustawienie młynka.');
    });
    refreshGrinderDialog();
  };
  for (const [action,keep] of [['grinder-server',false],['grinder-local',true]]) {
    form.querySelector(`[data-action="${action}"]`).onclick = async () => {
      await save(form,async () => {await Store.resolveGrinders(keep);loadSetting();refreshGrinderDialog();});
      refreshGrinderDialog();
    };
  }
  void Store.syncGrinders();
}

function openEditor(content) {
  editor.innerHTML = content;
  const heading = editor.querySelector('h2'); if (heading) heading.id = 'dialog-title';
  if (!dialog.open) dialog.showModal();
  dialog.scrollTop = 0;
}
function field(label,name,value='',options='') { return `<label>${label}<input name="${name}" value="${esc(value)}" ${options}></label>`; }
function formEnd(isEdit,entity) {
  return `<p class="error" id="form-error" role="alert"></p><div class="form-actions">${isEdit ? `<button type="button" class="button danger" data-delete="${entity}">Usuń</button>` : ''}${button('Anuluj','cancel')}<button class="button" type="submit">Zapisz</button></div></form>`;
}
async function save(form,operation) {
  const error = form.querySelector('.error'); error.textContent = '';
  const buttons = form.querySelectorAll('button'); buttons.forEach(b => b.disabled = true);
  try { await operation(); } catch (err) { error.textContent = err.message; }
  finally { buttons.forEach(b => b.disabled = false); }
}
function messageSaved() { toast(Store.status === 'saved' ? 'Zapisano.' : 'Zapisano na urządzeniu. Synchronizacja po połączeniu.'); }
function requireCoffee(all,coffeeId) { const c = all.find(c => c.id === coffeeId); if (!c) throw Error('Ta kawa została usunięta w innej karcie.'); return c; }
function coffeeEditor(coffee) {
  const current = coffee || {accent:'rose'};
  openEditor(`<h2>${coffee ? 'Edytuj kawę' : 'Nowa kawa'}</h2><form id="coffee-form">${field('Nazwa kawy *','name',coffee?.name,'required maxlength="120" placeholder="np. Parallel 12"')}
    <fieldset class="accent-picker"><legend>Kolor kawy</legend><div class="accent-options">${Object.entries(ACCENTS).map(([key,label]) => `<label class="accent-choice coffee-accent-${key}"><input type="radio" name="accent" value="${key}" ${current.accent === key ? 'checked' : ''} required><span class="accent-swatch" aria-hidden="true"></span><span>${label}</span></label>`).join('')}</div></fieldset>
    <details class="form-extra" ${coffee ? '' : 'open'}><summary>Informacje o kawie</summary><div class="form-grid">${Object.entries(COFFEE_FIELDS).map(([key,label]) => `<div class="${key === 'tasting_notes' ? 'full' : ''}">${field(label,key,coffee?.[key],'maxlength="300"')}</div>`).join('')}</div></details>
    <label class="form-section">Opis<textarea name="description" maxlength="1000" rows="2" placeholder="Dodatkowe uwagi o kawie…">${esc(coffee?.description)}</textarea></label>${formEnd(!!coffee,'coffee')}`);
  document.querySelector('#coffee-form').onsubmit = async event => {
    event.preventDefault();
    await save(event.currentTarget,async () => {
      const data = validateCoffee(Object.fromEntries(new FormData(event.currentTarget)));
      const newId = coffee?.id || id();
      await Store.edit(all => {
        if (all.some(c => c.id !== newId && coffeeKey(c.name) === coffeeKey(data.name))) throw Error('Ta kawa już istnieje. Otwórz ją i dodaj do niej kolejny wariant przepisu.');
        if (coffee) Object.assign(requireCoffee(all,coffee.id),coffeeInfo(data));
        else all.push({...data,id:newId});
      },coffee ? 'Edytowano kawę' : 'Dodano kawę');
      dialog.close(); location.hash = `coffee/${newId}`; render(); messageSaved();
    });
  };
  if (coffee) editor.querySelector('[data-delete]').onclick = () => confirmDelete('coffee',coffee.id);
}
function coffeeFacts(coffee) {
  const entries = Object.entries(COFFEE_FIELDS).filter(([key]) => coffee[key]);
  if (!entries.length) return '';
  return `<details class="panel coffee-info"><summary>O kawie <small>${esc([coffee.roaster,coffee.country].filter(Boolean).join(' · '))}</small></summary><dl>${entries.map(([key,label]) => `<div><dt>${label}</dt><dd>${esc(coffee[key])}</dd></div>`).join('')}</dl></details>`;
}
function renderLogin() {
  document.title = 'Zaloguj się · Moja kawa';
  app.innerHTML = `<section class="login-screen"><div class="login-card"><img class="login-logo" src="/logo.svg" alt="" width="72" height="72"><span class="eyebrow">TWÓJ PRZEPIŚNIK</span><h1>Twoja kawa.<br>W Twoim rytmie.</h1><p class="intro">Zaloguj się, aby otworzyć swoje przepisy.</p><form id="login-form">${field('Login','username',Store.state?.username || '','required autocomplete="username" maxlength="300" autocapitalize="none" spellcheck="false"')}${field('Hasło','password','','type="password" required autocomplete="current-password" maxlength="1000"')}<p class="error" role="alert"></p><button class="button login-submit" type="submit">Zaloguj się →</button></form><p class="help">Po zalogowaniu przepisy działają też offline na tym urządzeniu.</p>${registration?.waiting ? button('Aktualizuj aplikację','update','subtle small') : ''}</div></section>`;
  document.querySelector('#login-form').onsubmit = async event => {
    event.preventDefault();
    const form = event.currentTarget;
    await save(form,async () => {
      const data = new FormData(form);
      try {await Store.login(data.get('username').trim(),data.get('password'));}
      catch (error) {if (error instanceof TypeError || error.name === 'AbortError') throw Error('Połącz się z serwerem, aby się zalogować.');throw error;}
      render();
    });
  };
}
function logoutEditor() {
  openEditor(`<h2>Wylogować się?</h2><p class="${Store.state?.dirty || Store.grinderMemory?.dirty ? 'warning' : 'intro'}">${Store.state?.dirty ? 'Masz niewysłane przepisy. Pobierz kopię, zanim się wylogujesz. ' : ''}${Store.grinderMemory?.dirty ? 'Ustawienie młynka czeka na wysłanie — zsynchronizuj je lub zanotuj przed wylogowaniem. ' : ''}Wylogowanie usuwa przepisy i pamięć młynków z tego urządzenia. Dane zapisane na serwerze pozostaną.</p><form id="logout-form"><p class="error" role="alert"></p><div class="form-actions">${Store.state?.dirty ? button('Pobierz kopię JSON','export') : ''}${button('Anuluj','cancel')}<button class="button danger" type="submit">Wyloguj się</button></div></form>`);
  document.querySelector('#logout-form').onsubmit = async event => {
    event.preventDefault();
    await save(event.currentTarget,async () => {
      try {await Store.logout();}
      catch (error) {if (error instanceof TypeError || error.name === 'AbortError') throw Error('Połącz się z serwerem, aby zakończyć sesję i wylogować się.');throw error;}
      dialog.close(); search = ''; location.hash = ''; render();
    });
  };
}
function pourRow(p={}) {
  return `<div class="pour-row">${field('Czas','pour-time',p.time,'required maxlength="100" placeholder="0:00–0:15"')}${field('Dolej (g)','pour-amount',p.amount,'type="number" inputmode="decimal" required min="0.1" max="10000" step="0.1" placeholder="75"')}<button class="icon-button" type="button" data-remove-pour aria-label="Usuń zalanie">×</button></div>`;
}
function recipeEditor(coffee,r) {
  const recipe = r || {};
  openEditor(`<h2>${r ? 'Edytuj przepis' : 'Nowy przepis'}</h2><p class="intro">${esc(coffee.name)}</p><form id="recipe-form"><div class="form-grid">${field('Woda (g / ml) *','volume',recipe.volume,'type="number" inputmode="decimal" min="1" max="10000" step="0.1" required placeholder="500"')}${field('Kawa (g) *','dose',recipe.dose,'type="number" inputmode="decimal" min="0.1" max="1000" step="0.1" required placeholder="30"')}${field('Temperatura (°C) *','temperature',recipe.temperature,'type="number" inputmode="decimal" min="1" max="100" step="0.1" required placeholder="91"')}${field('Metoda','method',recipe.method,'maxlength="300" placeholder="4:6"')}<div class="full">${field('Młynek i ustawienie','grind',recipe.grind,'maxlength="300" placeholder="Timemore C3S · 17 klików od zera"')}</div></div>
    <details class="form-extra"><summary>Dripper, czas i ilość naparu</summary><div class="form-grid">${field('Dripper','dripper',recipe.dripper,'maxlength="300" placeholder="Hario V60 02"')}${field('Docelowy czas','duration',recipe.duration,'maxlength="300" placeholder="4:00–4:40"')}${field('Gotowy napar','yield',recipe.yield,'maxlength="300" placeholder="440–450 ml"')}</div></details>
    <h3 class="form-section">Zalania</h3><div id="pours">${(recipe.pours || []).map(pourRow).join('')}</div><button class="button subtle small" type="button" id="add-pour">＋ Zalanie</button><p class="help" id="pour-total"></p>
    <label class="form-section">Przygotowanie<textarea name="steps" rows="4" placeholder="Każdy krok w osobnej linii">${esc((recipe.steps || []).join('\n'))}</textarea></label>
    <label class="form-section">Uwagi<textarea name="notes" maxlength="10000" rows="2">${esc(recipe.notes)}</textarea></label>${formEnd(!!r,'recipe')}`);
  const form = document.querySelector('#recipe-form');
  const updateTotal = () => {
    const sum = [...form.querySelectorAll('[name="pour-amount"]')].reduce((n,input) => n+Number(input.value || 0),0);
    document.querySelector('#pour-total').textContent = `Suma: ${fmt(sum)} / ${fmt(Number(form.elements.volume.value || 0))} g`;
  };
  document.querySelector('#add-pour').onclick = () => {
    if (form.querySelectorAll('.pour-row').length >= 50) return toast('Maksymalnie 50 zalań.');
    document.querySelector('#pours').insertAdjacentHTML('beforeend',pourRow()); updateTotal();
  };
  form.addEventListener('input',updateTotal);
  form.addEventListener('click',event => { if (event.target.closest('[data-remove-pour]')) {event.target.closest('.pour-row').remove();updateTotal();} });
  updateTotal();
  form.onsubmit = async event => {
    event.preventDefault();
    await save(form,async () => {
      const data = Object.fromEntries(new FormData(form));
      for (const key of ['volume','dose','temperature']) data[key] = Number(data[key]);
      data.pours = [...form.querySelectorAll('.pour-row')].map(row => ({time:row.querySelector('[name="pour-time"]').value,amount:Number(row.querySelector('[name="pour-amount"]').value)}));
      data.steps = lines(data.steps);
      const clean = validateRecipe(data), recipeId = r?.id || id();
      await Store.edit(all => {
        const target = requireCoffee(all,coffee.id);
        if (r) { const index = target.recipes.findIndex(item => item.id === r.id); if (index < 0) throw Error('Ten przepis został usunięty w innej karcie.'); target.recipes[index] = {...clean,id:recipeId}; }
        else target.recipes.push({...clean,id:recipeId});
      },r ? 'Edytowano przepis' : 'Dodano przepis');
      dialog.close(); location.hash = `coffee/${coffee.id}/${recipeId}`; render(); messageSaved();
    });
  };
  if (r) editor.querySelector('[data-delete]').onclick = () => confirmDelete('recipe',r.id);
}
function confirmDelete(type,entityId) {
  const {coffee,recipe} = selection();
  const duplicates = type === 'coffee' ? coffees.filter(c => coffeeKey(c.name) === coffeeKey(coffee.name)).length : 0;
  openEditor(`<h2>${type === 'coffee' ? 'Usunąć kawę?' : 'Usunąć przepis?'}</h2><p class="intro">${type === 'coffee' ? `${esc(coffee.name)} i wszystkie jej przepisy.` : `${esc(coffee.name)} · ${fmt(recipe.volume)} ml.`} ${duplicates > 1 ? `Znaleziono ${duplicates} wpisy o tej samej nazwie. Usuniemy je razem z ich przepisami. ` : ''}Poprzednią zapisaną wersję znajdziesz w historii.</p><form id="delete-form"><p class="error" role="alert"></p><div class="form-actions">${button('Anuluj','cancel')}<button class="button danger" type="submit">Usuń</button></div></form>`);
  document.querySelector('#delete-form').onsubmit = async event => {
    event.preventDefault(); await save(event.currentTarget,async () => {
      await Store.edit(all => {
        if (type === 'coffee') removeCoffee(all,entityId);
        else { const c = requireCoffee(all,coffee.id); c.recipes = c.recipes.filter(r => r.id !== entityId); }
      },type === 'coffee' ? 'Usunięto kawę i jej przepisy' : 'Usunięto przepis');
      dialog.close(); location.hash = type === 'coffee' ? '' : `coffee/${coffee.id}`; render(); messageSaved();
    });
  };
}
function download(name,body,type='application/json') {
  const url = URL.createObjectURL(new Blob([body],{type}));
  const anchor = document.createElement('a');anchor.href = url;anchor.download = name;anchor.click();setTimeout(() => URL.revokeObjectURL(url),5000);
}
function exportData() {
  download('moja-kawa.json',JSON.stringify({version:2,coffees:coffees.map(({id,...c}) => ({...c,recipes:c.recipes.map(({id,...r}) => r)}))},null,2));
  toast('Pobrano kopię JSON.');
}
function importEditor() {
  const selected = selection().coffee;
  openEditor(`<h2>Import przepisów</h2><p class="intro">${selected ? `Do kawy <strong>${esc(selected.name)}</strong> lub do nowych kaw z pliku.` : 'Wklej JSON lub Markdown. Możesz też wybrać plik.'}</p><form id="import-form"><label>Dane<textarea class="import-text" name="source" required spellcheck="false" placeholder="Wklej JSON lub Markdown…"></textarea></label><div class="import-actions"><label class="button subtle small file-label">↥ Wybierz plik<input id="import-file" type="file" accept=".json,.md,.markdown,.txt,application/json,text/markdown,text/plain" aria-label="Wybierz plik JSON lub Markdown"></label>${button('Instrukcja dla AI','ai','subtle small')}</div><p class="error" role="alert"></p><div class="form-actions"><button class="button" type="submit">Sprawdź i pokaż podgląd →</button></div></form>`);
  const form = document.querySelector('#import-form');
  form.querySelector('[data-action="ai"]').onclick = event => { event.stopPropagation(); aiEditor(form.elements.source.value); };
  document.querySelector('#import-file').onchange = async event => {
    const file = event.target.files[0]; if (!file) return;
    const error = form.querySelector('.error'); error.textContent = '';
    if (file.size > 1500000) {error.textContent = 'Plik może mieć najwyżej 1,5 MB.';return;}
    try { form.elements.source.value = await file.text(); } catch {error.textContent = 'Nie udało się odczytać pliku.';}
  };
  form.onsubmit = async event => {
    event.preventDefault();
    await save(form,async () => {
      const source = form.elements.source.value;
      const incoming = parseImport(source,selected?.name);
      // Re-read IndexedDB: another tab may have just deleted this coffee.
      const current = await Store.readCoffees();
      const merged = mergeImport(current,incoming);
      importPreview(incoming,merged.summary,source);
    });
  };
}
function importPreview(incoming,summary,source) {
  openEditor(`<h2>Podgląd importu</h2><p class="intro">Nowe kawy: ${summary.coffees} · Nowe przepisy: ${summary.recipes} · Pominięte duplikaty: ${summary.skipped} · Uzupełnione kawy: ${summary.updated}</p>${incoming.map(c => `<div class="preview-item"><strong>${esc(c.name)}</strong><span>${esc([c.roaster,c.country,c.process,c.tasting_notes].filter(Boolean).join(' · '))}${[c.roaster,c.country,c.process,c.tasting_notes].some(Boolean) ? '<br>' : ''}Kolor: ${esc(ACCENTS[c.accent])}<br>${c.recipes.map(r => `${fmt(r.volume)} ml · ${esc(r.grind || 'brak ustawienia młynka')}`).join('<br>') || 'Kawa bez przepisów'}</span></div>`).join('')}<p class="help">Ta sama nazwa łączy przepisy i uzupełnia puste informacje. Istniejące wartości i kolor pozostają bez zmian.</p><form id="import-confirm"><p class="error" role="alert"></p><div class="form-actions"><button class="button subtle" type="button" id="import-back">Wróć</button><button class="button" type="submit" ${summary.coffees+summary.recipes+summary.updated ? '' : 'disabled'}>Dodaj do przepiśnika</button></div></form>`);
  document.querySelector('#import-back').onclick = () => {importEditor();document.querySelector('[name="source"]').value = source;};
  document.querySelector('#import-confirm').onsubmit = async event => {
    event.preventDefault(); await save(event.currentTarget,async () => {
      await Store.edit(all => {const merged = mergeImport(all,incoming);all.splice(0,all.length,...merged.coffees);},'Zaimportowano kawy i przepisy');
      dialog.close(); render(); messageSaved();
    });
  };
}
async function aiEditor(source='') {
  openEditor(`<h2>Instrukcja dla AI</h2><p class="intro">Skopiuj i dołącz do wiadomości z przepisem.</p><pre id="ai-content">Wczytuję…</pre><p id="ai-error" class="error" role="alert"></p><div class="form-actions"><button class="button subtle" id="ai-back">Wróć do importu</button><button class="button" id="copy-ai" disabled>Kopiuj instrukcję</button></div>`);
  document.querySelector('#ai-back').onclick = () => {importEditor();document.querySelector('[name="source"]').value = source;};
  try {
    const response = await fetch('/ai-instructions.md'); if (!response.ok) throw Error('Nie można wczytać instrukcji.');
    const instructions = await response.text();
    const content = document.querySelector('#ai-content'); if (!content) return;
    content.textContent = instructions;
    const copy = document.querySelector('#copy-ai'); copy.disabled = false;
    copy.onclick = async () => {
      try { await navigator.clipboard.writeText(instructions); toast('Instrukcja skopiowana.'); }
      catch {document.querySelector('#ai-error').textContent = 'Nie można skopiować automatycznie. Zaznacz tekst instrukcji i skopiuj ręcznie.';}
    };
  } catch (err) { const target = document.querySelector('#ai-content');if (target) target.textContent = err.message; }
}
function settingsEditor() {
  const labels = {saved:'Kawy i przepisy zapisane na serwerze.',syncing:'Trwa synchronizacja z serwerem.',pending:'Zmiany zapisane na urządzeniu. Wyślemy je, gdy serwer będzie dostępny.',offline:'Przeglądasz dane zapisane na tym urządzeniu.',conflict:'Inne urządzenie zmieniło przepisy. Twoje zmiany pozostały tutaj. Pobierz kopię JSON i porównaj ją z wersją serwera.',auth:'Zaloguj się ponownie. Lokalne zmiany pozostają na urządzeniu.',rejected:'Serwer odrzucił synchronizację. Pobierz kopię JSON. Sprawdź, czy serwer i aplikacja mają tę samą wersję.'};
  openEditor(`<h2>Twój przepiśnik</h2><p class="${Store.status === 'conflict' ? 'warning' : 'intro'}">${esc(labels[Store.status] || 'Otwieram…')}</p><p class="intro">${esc(grinderSyncLabel())}</p><div class="settings-list">${menuButton('Ustawienie młynka','grinder','grinder')}${menuButton('Synchronizuj teraz','sync-now','refresh')}${menuButton('Historia wersji','history','history')}${menuButton('Pobierz kopię JSON','export','download')}${menuButton('Import JSON / Markdown','import','upload')}${menuButton('Instrukcja dla AI','ai','file')}${menuButton('Zainstaluj aplikację','install','install')}${menuButton('Zachowuj dane offline','persist','offline')}${registration?.waiting ? menuButton('Aktualizuj aplikację','update','refresh','') : ''}${Store.status === 'conflict' ? menuButton('Wczytaj wersję z serwera…','resolve','server','danger') : ''}${Store.auth.required ? menuButton('Wyloguj się','logout','logout','danger') : ''}</div><p class="export-note top-spacer">Przepisy i zmiany są zapisywane na urządzeniu. Usunięcie danych witryny usuwa lokalną kopię. Kopia JSON pozwala zachować przepisy poza przeglądarką.</p>`);
}
const versionDate = value => new Intl.DateTimeFormat('pl-PL',{dateStyle:'short',timeStyle:'short'}).format(new Date(value));
async function historyEditor() {
  openEditor('<h2>Historia wersji</h2><p class="intro">Ostatnie 20 zapisanych wersji na serwerze.</p><div id="version-list"><p class="loading">Wczytuję…</p></div>');
  try {
    const versions = await Store.getHistory();
    const list = editor.querySelector('#version-list'); if (!list) return;
    list.innerHTML = versions.length ? versions.map(v => `<button type="button" class="version-row" data-version="${v.id}"><span><strong>${esc(v.label)}</strong><small>${esc(versionDate(v.created_at))} · ${v.coffee_count} ${coffeePlural(v.coffee_count)} · ${v.recipe_count} ${plural(v.recipe_count)}</small></span><span aria-hidden="true">↗</span></button>`).join('') : '<p class="intro">Nie ma jeszcze zapisanych wersji.</p>';
    list.querySelectorAll('[data-version]').forEach(b => b.onclick = () => void versionPreview(Number(b.dataset.version)));
  } catch (error) {
    const list = editor.querySelector('#version-list');
    if (list) list.innerHTML = `<p class="error">${esc(error instanceof TypeError || error.name === 'AbortError' ? 'Połącz się z serwerem, aby otworzyć historię.' : error.message)}</p>`;
  }
}
async function versionPreview(versionId) {
  openEditor('<h2>Podgląd wersji</h2><div id="version-preview"><p class="loading">Wczytuję…</p></div>');
  try {
    const version = await Store.getHistory(versionId);
    const target = editor.querySelector('#version-preview'); if (!target) return;
    target.innerHTML = `<p class="intro">${esc(versionDate(version.created_at))} · ${esc(version.label)}</p><div class="version-coffees">${version.coffees.map(c => `<div class="preview-item"><strong>${esc(c.name)}</strong><span>${c.recipes.length} ${plural(c.recipes.length)}${c.recipes.length ? ' · '+c.recipes.map(r => fmt(r.volume)+' ml').join(', ') : ''}</span></div>`).join('') || '<p class="intro">Pusty przepiśnik.</p>'}</div><p class="warning">Przywrócenie zastąpi aktualne kawy i przepisy na tym urządzeniu, także niewysłane zmiany. Powstanie nowa wersja historii po synchronizacji.</p><form id="restore-form"><p class="error" role="alert"></p><div class="form-actions">${button('Pobierz obecną kopię','export')}${button('Wróć','history')}<button class="button" type="submit">Przywróć tę wersję</button></div></form>`;
    const form = editor.querySelector('#restore-form');
    form.onsubmit = async event => {
      event.preventDefault();
      await save(form,async () => {
        await Store.edit(all => all.splice(0,all.length,...structuredClone(version.coffees)),`Przywrócono wersję #${version.id}`);
        dialog.close(); location.hash = ''; render(); messageSaved();
      });
    };
  } catch (error) {
    const target = editor.querySelector('#version-preview');
    if (target) target.innerHTML = `<p class="error">${esc(error instanceof TypeError || error.name === 'AbortError' ? 'Połącz się z serwerem, aby otworzyć wersję.' : error.message)}</p>${button('Wróć','history')}`;
  }
}

function resolveEditor() {
  openEditor(`<h2>Wersja z serwera</h2><p class="warning">Zastąpi lokalne przepisy i niewysłane zmiany. Najpierw pobierz swoją kopię. Potem możesz zaimportować z niej brakujące przepisy.</p><div class="form-actions">${button('Pobierz moją kopię','export','')}${button('Anuluj','cancel')}<button class="button danger" id="use-server">Zastąp lokalną wersję</button></div><p class="error" role="alert"></p>`);
  document.querySelector('#use-server').onclick = async event => {
    event.target.disabled = true;
    try {await Store.useServer();dialog.close();render();toast('Wczytano wersję z serwera.');}
    catch (err) {editor.querySelector('.error').textContent = err.message;event.target.disabled = false;}
  };
}
async function install() {
  if (installPrompt) {await installPrompt.prompt();installPrompt = null;return;}
  openEditor(`<h2>Zawsze pod ręką</h2><p class="intro">iPhone / iPad: w Safari wybierz <strong>Udostępnij → Dodaj do ekranu początkowego</strong>.</p><p class="intro">Android / komputer: w menu przeglądarki wybierz <strong>Zainstaluj aplikację</strong> lub <strong>Dodaj do ekranu głównego</strong>.</p><p class="help">Jeśli aplikacja jest już zainstalowana, otwórz ją z ekranu głównego. Do instalacji potrzebujesz HTTPS lub localhost.</p>`);
}
document.addEventListener('click',async event => {
  const action = event.target.closest('[data-action]')?.dataset.action;
  const {coffee,recipe} = selection();
  if (action === 'add-coffee' && Store.state) coffeeEditor();
  if (action === 'edit-coffee' && coffee) coffeeEditor(coffee);
  if (action === 'add-recipe' && coffee) recipeEditor(coffee);
  if (action === 'grinder' && Store.access === 'ready') grinderEditor();
  if (['grinder-minus','grinder-plus','grinder-match'].includes(action)) await setInlineGrinder(action.replace('grinder-',''));
  if (action === 'edit-recipe' && recipe) recipeEditor(coffee,recipe);
  if (action === 'cancel') dialog.close();
  if (action === 'retry') await boot();
  if (action === 'import' && Store.state) importEditor();
  if (action === 'ai') void aiEditor();
  if ((action === 'settings' || action === 'sync') && Store.access === 'ready') settingsEditor();
  if (action === 'logout') logoutEditor();
  if (action === 'history' && Store.access === 'ready') void historyEditor();
  if (action === 'sync-now') {await Promise.all([Store.sync(),Store.syncGrinders()]);if (Store.access === 'ready') settingsEditor();}
  if (action === 'export') exportData();
  if (action === 'install') await install();
  if (action === 'resolve') resolveEditor();
  if (action === 'persist') {
    try { const persisted = await navigator.storage?.persist?.();toast(persisted ? 'Przeglądarka przyznała trwałą pamięć.' : 'Dane są zapisane. Przeglądarka zarządza ich trwałością — zachowaj też kopię JSON.'); }
    catch {toast('Nie można zmienić ustawienia pamięci. Możesz pobrać kopię JSON.');}
  }
  if (action === 'update' && registration?.waiting) { updateRequested = true; registration.waiting.postMessage({type:'SKIP_WAITING'}); }
  const recipeId = event.target.closest('[data-recipe]')?.dataset.recipe;
  if (recipeId && coffee) location.hash = `coffee/${coffee.id}/${recipeId}`;
});
document.addEventListener('input',event => {
  if (event.target.id !== 'inline-grinder-value') return;
  const {recipe} = selection();
  const target = parseGrind(recipe?.grind);
  inlineGrinderDraft = {key:`${recipe.id}:${target?.name}`,value:event.target.value};
  event.target.closest('form').dataset.dirty = 'true';
  const controls = event.target.closest('form').querySelectorAll('[data-action="grinder-minus"],[data-action="grinder-plus"]');
  controls.forEach(control => control.disabled = inlineGrinderSaving || !event.target.validity.valid);
});
document.addEventListener('submit',event => {
  if (event.target.id !== 'inline-grinder-form') return;
  event.preventDefault();void setInlineGrinder('save');
});
document.querySelector('#close-dialog').onclick = () => dialog.close();
let previousRoute = location.hash;
window.addEventListener('hashchange',() => {
  const previousCoffee = previousRoute.match(/^#coffee\/(\d+)/)?.[1];
  const currentCoffee = location.hash.match(/^#coffee\/(\d+)/)?.[1];
  const changingRecipe = !!currentCoffee && currentCoffee === previousCoffee;
  previousRoute = location.hash;
  dialog.close();
  inlineGrinderDraft = null;
  render();
  if (!changingRecipe) window.scrollTo(0,0);
  const target = changingRecipe ? app.querySelector('[data-recipe-view]') : app;
  // Only navigation animates; background synchronisation leaves the page still.
  if (!target?.animate || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  target.getAnimations().forEach(animation => animation.cancel());
  const from = changingRecipe ? 'translateY(6px)' : `translateX(${currentCoffee ? 12 : -12}px)`;
  target.animate([{opacity:0,transform:from},{opacity:1,transform:'none'}], {
    duration:changingRecipe ? 140 : 200,easing:'cubic-bezier(.2,.7,.3,1)',
  });
});
window.addEventListener('beforeinstallprompt',event => {event.preventDefault();installPrompt = event;});
window.addEventListener('appinstalled',() => {installPrompt = null;toast('Aplikacja zainstalowana.');});
let lastContent = '', lastAccess = Store.access;
Store.subscribe(() => {
  coffees = structuredClone(Store.state?.coffees || []).sort((a,b) => a.name.localeCompare(b.name,'pl'));
  coffees.forEach(c => c.recipes.sort((a,b) => a.volume-b.volume || a.id-b.id));
  const content = JSON.stringify([coffees,Store.grinderMemory,Store.grinderSyncStatus]);
  if (document.activeElement?.id === 'inline-grinder-value' && Store.access === 'ready') {refreshGrinderDialog();connection();return;}
  refreshGrinderDialog();
  if (content !== lastContent || lastAccess !== Store.access) { lastContent = content; lastAccess = Store.access; render(); } else connection();
});
async function boot() {
  loadError = ''; loading = true;
  try {await Store.init();} catch (err) {loadError = err instanceof TypeError || err.name === 'AbortError' ? 'Połącz się z serwerem podczas pierwszego uruchomienia. Potem przepisy będą dostępne offline.' : err.message;}
  loading = false; render();
}
let updateRequested = false;
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('controllerchange',() => {if (updateRequested) location.reload();});
  navigator.serviceWorker.register('/sw.js').then(reg => {
    registration = reg;
    reg.addEventListener('updatefound',() => {reg.installing?.addEventListener('statechange',() => {if (reg.waiting && navigator.serviceWorker.controller) {toast('Nowa wersja jest gotowa.');if (Store.access === 'login') render();}});});
  }).catch(() => toast('Nie można przygotować PWA. Sprawdź HTTPS i ustawienia przeglądarki.'));
}
void boot();
