// Recipe text stays compatible with existing imports. Only compare explicit model + setting.
export function grinderKey(name) {
  return name.normalize('NFKC').trim().replace(/\s+/gu,' ').toLocaleLowerCase('pl');
}
export function parseGrind(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  let match = value.trim().match(/^(.+?)\s*[·:]\s*(.+)$/u);
  if (!match) match = value.trim().match(/^(.+?)\s+(\d+(?:[.,]\d+)?\s+klik(?:ów|ow|i)?\b.*)$/iu);
  if (!match || !match[1].trim() || !match[2].trim()) return null;
  return {name:match[1].trim(),setting:match[2].trim()};
}
export function clickSetting(setting) {
  const match = setting.match(/^(\d+)\s+(klik(?:ów|ow|i)?)(\b.*)$/iu);
  if (!match || Number(match[1]) > 1000) return null;
  return {value:Number(match[1]),suffix:' '+match[2]+match[3]};
}
function settingKey(value) {
  return value.normalize('NFKC').toLocaleLowerCase('pl').normalize('NFD').replace(/\p{Diacritic}/gu,'')
    .replace(/\bklik(?:ow|i)?\b/gu,'klik').replace(/\s+/gu,' ').trim().replace(/^(\d+)/u,n => String(Number(n)));
}
export function grinderStatus(grind,items=[]) {
  const target = parseGrind(grind);
  if (!target) return {kind:'unknown',target:null,current:null};
  const current = items.find(item => grinderKey(item.name) === grinderKey(target.name));
  if (!current) return {kind:'unknown',target,current:null};
  return {kind:settingKey(current.setting) === settingKey(target.setting) ? 'ok' : 'warning',target,current};
}
