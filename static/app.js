'use strict';
const app = document.querySelector('#app');
const dialog = document.querySelector('#editor');
const editor = document.querySelector('#editor-body');
let coffees = [];
let loading = true;
let loadError = '';
let toastTimeout;
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const fmt = number => new Intl.NumberFormat('pl-PL', {maximumFractionDigits: 1}).format(number);
const lines = text => text.split('\n').map(line => line.trim()).filter(Boolean);
const button = (label, action, cls = 'subtle') => `<button class="button ${cls}" data-action="${action}">${label}</button>`;
const plural = (n, one, few, many) => n === 1 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? few : many;

function toast(message) {
  const element = document.querySelector('#toast');
  element.textContent = message;
  element.classList.add('visible');
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => element.classList.remove('visible'), 4000);
}

async function api(path, method = 'GET', data) {
  const response = await fetch(path, {method, ...(method !== 'GET' ? {headers: {'Content-Type':'application/json'}, body: JSON.stringify(data ?? {})} : {})});
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'Nie udało się wykonać operacji.');
  return body;
}

async function refresh() {
  coffees = await api('/api/coffees');
  loadError = '';
}

function selection() {
  const match = location.hash.match(/^#coffee\/(\d+)(?:\/(\d+))?$/);
  const coffee = match && coffees.find(item => item.id === Number(match[1]));
  const recipe = coffee && (coffee.recipes.find(item => item.id === Number(match[2])) || coffee.recipes[0]);
  return {coffee, recipe};
}

function render() {
  if (loading) return;
  if (loadError) {
    app.innerHTML = `<div class="empty"><h2>Nie udało się otworzyć przepiśnika</h2><p>${esc(loadError)}</p>${button('Spróbuj ponownie', 'retry')}</div>`;
    return;
  }
  const {coffee, recipe} = selection();
  document.title = coffee ? `${coffee.name} — Moja kawa` : 'Moja kawa — mały przepiśnik';
  if (!coffee) return renderHome();
  app.innerHTML = `
    <a href="#" class="back">← Wszystkie kawy</a>
    <div class="detail-heading"><div><span class="eyebrow">TWOJA KAWA</span><h1>${esc(coffee.name)}</h1><p class="intro">${esc(coffee.description)}</p></div><div class="actions">${button('Edytuj kawę', 'edit-coffee')}</div></div>
    <section class="volume-area" aria-label="Wybór przepisu"><span class="volume-title">Ile wody chcesz użyć?</span><div class="volume-options">${coffee.recipes.map(r => `<button class="volume ${recipe?.id === r.id ? 'selected' : ''}" data-recipe="${r.id}" aria-pressed="${recipe?.id === r.id}">${fmt(r.volume)} ml${coffee.recipes.filter(other => other.volume === r.volume).length > 1 ? `<small>${esc(r.method || r.dripper || 'Wariant')} · #${r.id}</small>` : ''}</button>`).join('')}<button class="volume add" data-action="add-recipe">+ Dodaj wariant</button></div></section>
    ${recipe ? recipeView(recipe) : `<div class="empty"><h2>Pierwszy przepis czeka na Ciebie.</h2><p>Dodaj porcję i zapisz swój sposób parzenia.</p>${button('+ Dodaj przepis', 'add-recipe', '')}</div>`}`;
}

function renderHome() {
  app.innerHTML = `
    <section class="hero"><div><span class="eyebrow">TWÓJ CODZIENNY RYTUAŁ</span><h1>Dobra kawa.<br><em>Po Twojemu.</em></h1><p class="intro">Sprawdzone przepisy, zawsze pod ręką.<br>Wybierz kawę, dopasuj porcję i zaparz coś dobrego.</p></div><div class="coffee-art" aria-hidden="true"><svg viewBox="0 0 150 150" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M37 45h76L94 95H56zM48 58h54M58 45l8 50M77 45v50M96 45l-9 50M50 99h51M57 104l-4 23h50l-5-23M54 127h48M70 24c-8-9 9-10 2-20M85 28c-8-9 9-10 2-20"/><path d="M104 109c24-3 23 18-2 13"/></svg></div></section>
    <div class="section-heading"><h2>Twoje kawy <span class="count">${coffees.length.toString().padStart(2, '0')}</span></h2>${button('+ Dodaj kawę', 'add-coffee', '')}</div>
    ${coffees.length ? `<div class="grid">${coffees.map(coffee => `<a class="coffee-card" href="#coffee/${coffee.id}"><span class="card-symbol" aria-hidden="true">✳</span><h2>${esc(coffee.name)}</h2><p>${esc(coffee.description || 'Twój kolejny dobry napar.')}</p><div class="card-bottom"><span>${coffee.recipes.length} ${plural(coffee.recipes.length, 'przepis', 'przepisy', 'przepisów')}${coffee.recipes.length ? ' · ' + [...new Set(coffee.recipes.map(r => fmt(r.volume) + ' ml'))].join(', ') : ''}</span><span class="arrow" aria-hidden="true">↗</span></div></a>`).join('')}</div>` : '<div class="empty">Zacznij od dodania swojej pierwszej kawy.</div>'}
    <p class="collection-note">Każda kawa ma swoje miejsce. Każda porcja — swój przepis.</p>`;
}

function recipeView(r) {
  let total = 0;
  return `<section aria-label="Przepis na ${fmt(r.volume)} ml">
    <div class="recipe-top"><h2>Twój przepis ${r.method ? `<span class="tag">METODA ${esc(r.method)}</span>` : ''}</h2>${button('Edytuj przepis', 'edit-recipe')}</div>
    <div class="stats"><div class="stat"><span>KAWA</span><strong>${fmt(r.dose)} <small>g</small></strong></div><div class="stat"><span>WODA</span><strong>${fmt(r.volume)} <small>g</small></strong></div><div class="stat"><span>TEMPERATURA</span><strong>${fmt(r.temperature)}<small> °C</small></strong></div><div class="stat"><span>PROPORCJA</span><strong>1<small> : </small>${fmt(r.volume / r.dose)}</strong></div></div>
    <div class="equipment">${[['Mielenie',r.grind],['Dripper',r.dripper],['Docelowy czas',r.duration],['Gotowy napar',r.yield]].filter(([,value]) => value).map(([key,value]) => `<span>${key}: <b>${esc(value)}</b></span>`).join('')}</div>
    <div class="recipe-columns"><section><h2>Plan zalewania</h2>${r.pours.length ? `<table><thead><tr><th scope="col">CZAS</th><th scope="col">DOLEJ</th><th scope="col">ŁĄCZNIE</th></tr></thead><tbody>${r.pours.map(pour => { total += pour.amount; return `<tr><td>${esc(pour.time)}</td><td>${fmt(pour.amount)} g</td><td>${fmt(total)} g</td></tr>`; }).join('')}${r.duration ? `<tr class="finish"><td>${esc(r.duration)}</td><td colspan="2">Zakończ parzenie</td></tr>` : ''}</tbody></table>` : '<p class="intro">Brak zapisanych zalań. Szczegóły znajdziesz w przygotowaniu.</p>'}</section><section><h2>Przygotowanie</h2>${r.steps.length ? `<ol class="steps">${r.steps.map(step => `<li>${esc(step)}</li>`).join('')}</ol>` : '<p class="intro">Nie dodano jeszcze kroków przygotowania.</p>'}</section></div>
    ${r.notes ? `<aside class="notes"><strong>WARTO WIEDZIEĆ</strong>${esc(r.notes)}</aside>` : ''}
    </section>`;
}

function openEditor(content) {
  editor.innerHTML = content;
  dialog.showModal();
}
function field(label, name, value = '', options = '') {
  return `<label>${label}<input name="${name}" value="${esc(value)}" ${options}></label>`;
}
function formEnd(isEdit, entity) {
  return `<p class="error" id="form-error" role="alert"></p><div class="form-actions">${isEdit ? `<button type="button" class="button danger" data-delete="${entity}">Usuń</button>` : ''}<button type="button" class="button subtle" data-action="cancel">Anuluj</button><button class="button" type="submit">Zapisz ${entity === 'coffee' ? 'kawę' : 'przepis'}</button></div></form>`;
}

function coffeeEditor(coffee) {
  openEditor(`<h2>${coffee ? 'Edytuj kawę' : 'Nowa kawa'}</h2><p class="intro">Najpierw kawa. Potem jej przepisy.</p><form id="coffee-form">${field('Nazwa kawy *', 'name', coffee?.name, 'required maxlength="120" placeholder="np. Parallel 12"')}<label class="form-section">Krótki opis<textarea name="description" maxlength="1000" placeholder="Smak, palarnia lub Twoje uwagi…">${esc(coffee?.description)}</textarea></label>${formEnd(!!coffee, 'coffee')}`);
  document.querySelector('#coffee-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    await save(form, async () => {
      const data = Object.fromEntries(new FormData(form));
      await api(coffee ? `/api/coffees/${coffee.id}` : '/api/coffees', coffee ? 'PUT' : 'POST', data);
      await refresh();
      dialog.close();
      render();
      toast(coffee ? 'Zmiany zapisane.' : 'Kawa dodana. Teraz możesz dodać przepis.');
    });
  });
  if (coffee) editor.querySelector('[data-delete]').onclick = () => confirmDelete('coffee', coffee.id);
}

function pourRow(pour = {}) {
  return `<div class="pour-row">${field('Czas', 'pour-time', pour.time, 'required maxlength="100" placeholder="0:00–0:15"')}${field('Dolej (g)', 'pour-amount', pour.amount, 'type="number" required min="0.1" max="10000" step="0.1" placeholder="75"')}<button class="icon-button" type="button" data-remove-pour aria-label="Usuń zalanie">×</button></div>`;
}
function recipeEditor(coffee, recipe) {
  const r = recipe || {};
  openEditor(`<h2>${recipe ? 'Edytuj przepis' : 'Nowy wariant'}</h2><p class="intro">${esc(coffee.name)} · Przepis dla konkretnej porcji.</p><form id="recipe-form"><div class="form-grid">${field('Woda (g / ml) *', 'volume', r.volume, 'type="number" min="1" max="10000" step="0.1" required placeholder="500"')}${field('Kawa (g) *', 'dose', r.dose, 'type="number" min="0.1" max="1000" step="0.1" required placeholder="30"')}${field('Temperatura (°C) *', 'temperature', r.temperature, 'type="number" min="1" max="100" step="0.1" required placeholder="91"')}${field('Metoda', 'method', r.method, 'maxlength="300" placeholder="np. 4:6"')}${field('Młynek i ustawienie', 'grind', r.grind, 'maxlength="300" placeholder="Timemore C3S · 17 klików"')}${field('Dripper', 'dripper', r.dripper, 'maxlength="300" placeholder="Hario V60 02"')}${field('Docelowy czas', 'duration', r.duration, 'maxlength="300" placeholder="4:00–4:40"')}${field('Gotowy napar', 'yield', r.yield, 'maxlength="300" placeholder="440–450 ml"')}</div>
    <h3 class="form-section">Plan zalewania</h3><p class="help">Wpisz ilość dolewanej wody. Suma obliczy się sama.</p><div id="pours">${(r.pours || []).map(pourRow).join('')}</div><button class="button subtle" type="button" id="add-pour">+ Dodaj zalanie</button><p class="help" id="pour-total"></p>
    <label class="form-section">Przygotowanie<textarea name="steps" rows="6" placeholder="Każdy krok w osobnej linii">${esc((r.steps || []).join('\n'))}</textarea></label><p class="help">Każda linia stanie się kolejnym krokiem przepisu.</p>
    <label class="form-section">Uwagi<textarea name="notes" maxlength="10000" rows="3" placeholder="Co wpływa na smak? Na co zwrócić uwagę?">${esc(r.notes)}</textarea></label>${formEnd(!!recipe, 'recipe')}`);
  const form = document.querySelector('#recipe-form');
  const updateTotal = () => {
    const sum = [...form.querySelectorAll('[name="pour-amount"]')].reduce((total, input) => total + Number(input.value || 0), 0);
    document.querySelector('#pour-total').textContent = `Suma zalań: ${fmt(sum)} g / ${fmt(Number(form.elements.volume.value || 0))} g wody`;
  };
  document.querySelector('#add-pour').onclick = () => {
    if (form.querySelectorAll('.pour-row').length >= 50) return toast('Możesz dodać maksymalnie 50 zalań.');
    document.querySelector('#pours').insertAdjacentHTML('beforeend', pourRow());
    updateTotal();
  };
  form.addEventListener('input', updateTotal);
  form.addEventListener('click', event => {
    if (event.target.closest('[data-remove-pour]')) {
      event.target.closest('.pour-row').remove();
      updateTotal();
    }
  });
  updateTotal();
  form.addEventListener('submit', async event => {
    event.preventDefault();
    await save(form, async () => {
      const data = Object.fromEntries(new FormData(form));
      for (const key of ['volume','dose','temperature']) data[key] = Number(data[key]);
      delete data['pour-time']; delete data['pour-amount'];
      data.pours = [...form.querySelectorAll('.pour-row')].map(row => ({time: row.querySelector('[name="pour-time"]').value, amount: Number(row.querySelector('[name="pour-amount"]').value)}));
      data.steps = lines(data.steps);
      await api(recipe ? `/api/recipes/${recipe.id}` : `/api/coffees/${coffee.id}/recipes`, recipe ? 'PUT' : 'POST', data);
      await refresh();
      const updated = coffees.find(c => c.id === coffee.id);
      const selected = recipe ? recipe.id : Math.max(...updated.recipes.map(item => item.id));
      location.hash = `coffee/${coffee.id}/${selected}`;
      dialog.close();
      render();
      toast('Przepis zapisany. Miłego parzenia!');
    });
  });
  if (recipe) editor.querySelector('[data-delete]').onclick = () => confirmDelete('recipe', recipe.id);
}

async function save(form, operation) {
  const error = document.querySelector('#form-error');
  error.textContent = '';
  const buttons = form.querySelectorAll('button');
  buttons.forEach(b => b.disabled = true);
  try {
    if (!navigator.onLine) throw new Error('Jesteś offline. Połącz się z internetem, aby zapisać zmiany.');
    await operation();
  } catch (err) {
    error.textContent = err instanceof TypeError ? 'Brak połączenia z serwerem. Twoje zmiany są nadal w formularzu.' : err.message;
  } finally { buttons.forEach(b => b.disabled = false); }
}

function confirmDelete(type, id) {
  const {coffee, recipe} = selection();
  openEditor(`<h2>${type === 'coffee' ? 'Usunąć kawę?' : 'Usunąć ten przepis?'}</h2><p class="intro">${type === 'coffee' ? `Kawa „${esc(coffee.name)}” i wszystkie jej przepisy zostaną usunięte.` : `Przepis na ${fmt(recipe.volume)} ml zostanie usunięty.`} Tej operacji nie można cofnąć.</p><form id="delete-form"><p id="form-error" class="error" role="alert"></p><div class="form-actions">${button('Anuluj', 'cancel')}<button class="button danger" type="submit">Tak, usuń</button></div></form>`);
  document.querySelector('#delete-form').onsubmit = async event => {
    event.preventDefault();
    await save(event.currentTarget, async () => {
      await api(`/api/${type === 'coffee' ? 'coffees' : 'recipes'}/${id}`, 'DELETE', {});
      await refresh();
      dialog.close();
      location.hash = type === 'coffee' ? '' : `coffee/${coffee.id}`;
      render();
      toast('Usunięto.');
    });
  };
}

document.addEventListener('click', event => {
  const action = event.target.closest('[data-action]')?.dataset.action;
  const {coffee, recipe} = selection();
  if (action === 'add-coffee') coffeeEditor();
  if (action === 'edit-coffee' && coffee) coffeeEditor(coffee);
  if (action === 'add-recipe' && coffee) recipeEditor(coffee);
  if (action === 'edit-recipe' && recipe) recipeEditor(coffee, recipe);
  if (action === 'cancel') { event.preventDefault(); dialog.close(); }
  if (action === 'retry') boot();
  const recipeId = event.target.closest('[data-recipe]')?.dataset.recipe;
  if (recipeId && coffee) location.hash = `coffee/${coffee.id}/${recipeId}`;
});
document.querySelector('#close-dialog').onclick = () => dialog.close();
window.addEventListener('hashchange', () => { if (dialog.open) dialog.close(); render(); window.scrollTo(0,0); });
function connection() {
  document.querySelector('#connection').textContent = navigator.onLine ? 'Prosto, jak lubisz.' : 'Offline · zapisane przepisy są pod ręką';
}
window.addEventListener('online', async () => { connection(); try { await refresh(); render(); } catch { /* Keep the loaded data. */ } });
window.addEventListener('offline', connection);
let installPrompt;
window.addEventListener('beforeinstallprompt', event => {
  event.preventDefault(); installPrompt = event; document.querySelector('#install').hidden = false;
});
document.querySelector('#install').onclick = async () => {
  if (installPrompt) { await installPrompt.prompt(); installPrompt = null; document.querySelector('#install').hidden = true; }
};
window.addEventListener('appinstalled', () => { document.querySelector('#install').hidden = true; });
async function boot() {
  try { await refresh(); } catch { loadError = 'Sprawdź połączenie z serwerem i spróbuj ponownie.'; }
  loading = false;
  render(); connection();
}
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
boot();
