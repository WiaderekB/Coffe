export const ACCENTS = {rose:'Różowy',lime:'Pistacjowy',sky:'Błękitny',honey:'Miodowy',lavender:'Lawendowy'};
export const COFFEE_FIELDS = {roaster:'Palarnia',country:'Kraj pochodzenia',region:'Region',variety:'Odmiana',process:'Obróbka',roast:'Stopień palenia',tasting_notes:'Nuty smakowe'};
export function defaultAccent(coffeeId = 1) { return Object.keys(ACCENTS)[(coffeeId-1) % Object.keys(ACCENTS).length] || 'rose'; }
export function coffeeInfo(data) {
  const accent = data.accent ?? 'rose';
  if (!Object.hasOwn(ACCENTS,accent)) throw Error('Wybierz kolor z dostępnej palety.');
  return {name:text(data.name,'Nazwa kawy',true,120),description:text(data.description ?? '','Opis',false,1000),accent,
    ...Object.fromEntries(Object.entries(COFFEE_FIELDS).map(([key,label]) => [key,text(data[key] ?? '',label,false,300)]))};
}
// Shared validation for the form, import and offline storage. No HTML is rendered from imports.
export function text(value, label, required = false, max = 300) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw Error(`Sprawdź pole: ${label}.`);
  return value.trim();
}
function number(value, label, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw Error(`${label}: podaj liczbę od ${min} do ${max}.`);
  return value;
}
export function recipe(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw Error('Nieprawidłowy przepis.');
  const result = {volume:number(data.volume,'Woda',1,10000),dose:number(data.dose,'Kawa',.1,1000),temperature:number(data.temperature,'Temperatura',1,100)};
  for (const key of ['grind','dripper','method','duration','yield','notes']) result[key] = text(data[key] ?? '',key,false,key === 'notes' ? 10000 : 300);
  if (!Array.isArray(data.pours ?? []) || (data.pours?.length ?? 0) > 50) throw Error('Maksymalnie 50 zalań.');
  result.pours = (data.pours ?? []).map(p => ({time:text(p?.time,'Czas zalania',true,100),amount:number(p?.amount,'Dolej',.1,10000)}));
  if (result.pours.length && Math.abs(result.pours.reduce((sum,p) => sum+p.amount,0)-result.volume) > .01) throw Error('Suma zalań musi być równa ilości wody.');
  if (!Array.isArray(data.steps ?? []) || (data.steps?.length ?? 0) > 100) throw Error('Maksymalnie 100 kroków.');
  result.steps = (data.steps ?? []).map(s => text(s,'Krok',true,3000));
  return result;
}
export function coffee(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw Error('Nieprawidłowa kawa.');
  if (!Array.isArray(data.recipes ?? []) || (data.recipes?.length ?? 0) > 100) throw Error('Maksymalnie 100 przepisów na kawę.');
  return {...coffeeInfo(data),recipes:(data.recipes ?? []).map(recipe)};
}
export function parseImport(source, selectedName = '') {
  if (typeof source !== 'string' || new TextEncoder().encode(source).length > 1500000) throw Error('Plik może mieć najwyżej 1,5 MB.');
  let value;
  const fenced = source.match(/```json\s*\n([\s\S]*?)\n```/i);
  if (fenced || /^[\s]*[\[{]/.test(source)) {
    try { value = JSON.parse(fenced ? fenced[1] : source); } catch { throw Error('Niepoprawny JSON. Sprawdź przecinki i cudzysłowy.'); }
  } else value = parseMarkdown(source, selectedName);
  if (Array.isArray(value)) value = {coffees:value};
  if (value && Array.isArray(value.recipes) && !value.name && !value.coffees) {
    if (!selectedName) throw Error('Otwórz kawę, do której chcesz dodać przepisy, albo podaj obiekt coffees.');
    value = {coffees:[{name:selectedName,recipes:value.recipes}]};
  } else if (value?.name) value = {coffees:[value]};
  if (!Array.isArray(value?.coffees) || !value.coffees.length || value.coffees.length > 1000) throw Error('Podaj niepustą tablicę coffees.');
  return value.coffees.map(coffee);
}
function parseMarkdown(source, selectedName) {
  const coffees = [];
  let current, r, section = '';
  const numeric = value => Number(value.replace(',','.').replace(/\s*(?:g|ml|°c)\s*$/i,''));
  const coffeeFields = {'opis':'description','kolor':'accent','palarnia':'roaster','kraj':'country','kraj pochodzenia':'country','region':'region','odmiana':'variety','obróbka':'process','palenie':'roast','stopień palenia':'roast','nuty':'tasting_notes','nuty smakowe':'tasting_notes'};
  const fields = {'kawa':'dose','temperatura':'temperature','mielenie':'grind','dripper':'dripper','metoda':'method','czas':'duration','napar':'yield'};
  for (let raw of source.replace(/\r/g,'').split('\n')) {
    const line = raw.trim();
    if (!line || /^<!--.*-->$/.test(line)) continue;
    let match;
    if ((match = line.match(/^# Kawa:\s*(.+)$/i))) { current = {name:match[1],description:'',recipes:[]}; coffees.push(current); r = null; section = ''; }
    else if ((match = line.match(/^## Przepis:\s*([\d.,]+)\s*ml$/i))) {
      if (!current && selectedName) { current = {name:selectedName,description:'',recipes:[]}; coffees.push(current); }
      if (!current) throw Error('Markdown musi zaczynać się od # Kawa: nazwa.');
      r = {volume:numeric(match[1]),pours:[],steps:[],notes:''}; current.recipes.push(r); section = '';
    } else if ((match = line.match(/^### (Zalania|Przygotowanie|Uwagi)$/i))) section = match[1].toLowerCase();
    else if (current && !r && (match = line.match(/^([^:]+):\s*(.*)$/))) {
      const key = coffeeFields[match[1].toLowerCase()];
      if (!key) throw Error(`Nieznane pole kawy: ${match[1]}.`);
      current[key] = match[2];
    }
    else if (r && section === 'zalania') {
      if (/^\|?\s*(Czas|:?-{2,})/i.test(line)) continue;
      const cells = line.replace(/^\|/,'').replace(/\|$/,'').split('|').map(c => c.trim());
      if (cells.length !== 2) throw Error('Zalania: użyj tabeli Czas | Dolej (g).');
      r.pours.push({time:cells[0],amount:numeric(cells[1])});
    } else if (r && section === 'przygotowanie') r.steps.push(line.replace(/^(?:\d+[.)]|[-*])\s+/,''));
    else if (r && section === 'uwagi') r.notes += (r.notes ? '\n' : '') + line;
    else if (r && (match = line.match(/^([^:]+):\s*(.*)$/))) {
      const key = fields[match[1].toLowerCase()];
      if (!key) throw Error(`Nieznane pole Markdown: ${match[1]}.`);
      r[key] = ['dose','temperature'].includes(key) ? numeric(match[2]) : match[2];
    } else throw Error(`Nieznana linia Markdown: ${line.slice(0,70)}`);
  }
  return {coffees};
}
export function id() { const bytes = crypto.getRandomValues(new Uint32Array(2)); return bytes[0] * 65536 + (bytes[1] & 65535) || 1; }
export function mergeImport(existing, incoming) {
  const result = structuredClone(existing);
  const summary = {coffees:0,recipes:0,skipped:0,updated:0};
  for (const item of incoming) {
    let target = result.find(c => c.name.toLocaleLowerCase('pl') === item.name.toLocaleLowerCase('pl'));
    if (!target) { target = {...coffeeInfo(item),id:id(),recipes:[]}; result.push(target); summary.coffees++; }
    else {
      let updated = false;
      // Imports fill missing facts, never replace a chosen accent or existing facts.
      for (const key of ['description',...Object.keys(COFFEE_FIELDS)]) {
        if (!target[key] && item[key]) { target[key] = item[key]; updated = true; }
      }
      if (updated) summary.updated++;
    }
    for (const r of item.recipes) {
      if (target.recipes.some(old => JSON.stringify(recipe(old)) === JSON.stringify(r))) { summary.skipped++; continue; }
      target.recipes.push({...r,id:id()}); summary.recipes++;
    }
  }
  if (result.length > 1000 || result.some(c => c.recipes.length > 100)) throw Error('Limit: 1000 kaw i 100 przepisów na kawę.');
  return {coffees:result,summary};
}
