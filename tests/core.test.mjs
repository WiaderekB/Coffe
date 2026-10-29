import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseImport,mergeImport,recipe} from '../static/core.js';
const json = readFileSync(new URL('../examples/parallel-12.json',import.meta.url),'utf8');
const md = readFileSync(new URL('../examples/parallel-12.md',import.meta.url),'utf8');

test('JSON and readable Markdown describe exactly the same coffee',() => {
  assert.deepEqual(parseImport(json),parseImport(md));
  assert.equal(parseImport(md)[0].recipes[0].grind,'Timemore C3S · 17 klików od zera');
});
test('Markdown allows several coffees, volumes and selected coffee imports',() => {
  const variant = '\n## Przepis: 250 ml\nKawa: 15 g\nTemperatura: 92 °C\nMielenie: C3S · 18 klików\n';
  const result = parseImport(md+variant+'\n# Kawa: Inna kawa\n'+variant);
  assert.equal(result.length,2);
  assert.equal(result[0].recipes.length,2);
  assert.equal(result[1].recipes[0].volume,250);
  assert.equal(parseImport(variant,'Wybrana')[0].name,'Wybrana');
  assert.throws(() => parseImport(variant),/zaczynać się/);
});
test('supports direct JSON, fenced JSON and recipe-only JSON',() => {
  const coffee = parseImport(json)[0];
  assert.deepEqual(parseImport(JSON.stringify(coffee)),[coffee]);
  assert.deepEqual(parseImport('Opis\n```json\n'+json+'\n```'),[coffee]);
  assert.deepEqual(parseImport(JSON.stringify({recipes:coffee.recipes}),'Parallel 12')[0].recipes,coffee.recipes);
  assert.throws(() => parseImport(JSON.stringify({recipes:coffee.recipes})),/Otwórz kawę/);
});
test('import is additive and idempotent, retains existing descriptions',() => {
  const incoming = parseImport(json);
  const first = mergeImport([],incoming);
  assert.deepEqual(first.summary,{coffees:1,recipes:1,skipped:0});
  const existing = structuredClone(first.coffees);existing[0].description = 'Mój opis';
  const second = mergeImport(existing,incoming);
  assert.deepEqual(second.summary,{coffees:0,recipes:0,skipped:1});
  assert.deepEqual(second.coffees,existing);
  incoming[0].name = 'PARALLEL 12';incoming[0].recipes[0].grind = '18 klików';
  const third = mergeImport(existing,incoming);
  assert.equal(third.coffees.length,1);assert.equal(third.coffees[0].recipes.length,2);
  assert.equal(third.coffees[0].description,'Mój opis');
});
test('rejects malformed, oversized and incomplete imports',() => {
  for (const bad of ['{oops}', '{}', '[]', '# Kawa: X\n## Przepis: 500 ml\nKawa: 30', '[null]', 'null', '<script>alert(1)</script>']) assert.throws(() => parseImport(bad));
  assert.throws(() => parseImport('x'.repeat(1500001)),/1,5 MB/);
  assert.throws(() => parseImport('# Kawa: X\n## Przepis: 250 ml\nKawa: 15\nTemperatura: 90\nMielnie: 17'),/Nieznane pole/);
});
test('recipe validation rejects invalid numbers and mismatching pours',() => {
  const source = parseImport(json)[0].recipes[0];
  for (const change of [{volume:NaN},{dose:0},{temperature:101},{temperature:'91'},{pours:[{time:'0:00',amount:10}]},{pours:[null]},{steps:'oops'}]) assert.throws(() => recipe({...source,...change}));
  assert.equal(recipe({...source,pours:[]}).pours.length,0);
});
test('Polish decimal comma is supported in Markdown',() => {
  const result = parseImport('# Kawa: Test\n## Przepis: 250 ml\nKawa: 15,5 g\nTemperatura: 91 °C\n### Zalania\n| Czas | Dolej (g) |\n| --- | --- |\n| 0:00 | 250 |');
  assert.equal(result[0].recipes[0].dose,15.5);
});
test('literal HTML remains data and is never evaluated by parser',() => {
  const result = parseImport(JSON.stringify({name:'<script>x</script>',recipes:[]}));
  assert.equal(result[0].name,'<script>x</script>');
});
