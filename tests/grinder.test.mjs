import test from 'node:test';
import assert from 'node:assert/strict';
import {parseGrind,grinderStatus,clickSetting} from '../static/grinder.js';
import {reconcileSyncedState} from '../static/core.js';

test('extracts an explicit grinder and preserves reference point',() => {
  assert.deepEqual(parseGrind('Timemore C3S · 17 klików od zera'),{name:'Timemore C3S',setting:'17 klików od zera'});
  assert.deepEqual(parseGrind('Timemore C3S 17 klików od zera'),{name:'Timemore C3S',setting:'17 klików od zera'});
  assert.deepEqual(parseGrind('Comandante: 22 kliki'),{name:'Comandante',setting:'22 kliki'});
  for (const value of ['',null,'17 klików','średnio','Timemore C3S']) assert.equal(parseGrind(value),null);
});
test('only reports matching settings for the same grinder and reference',() => {
  const items=[{name:' timemore   c3s ',setting:'17 klikow od zera'}];
  assert.equal(grinderStatus('Timemore C3S · 17 klików od zera',items).kind,'ok');
  assert.equal(grinderStatus('Timemore C3S · 18 klików od zera',items).kind,'warning');
  assert.equal(grinderStatus('Timemore C3S · 17 klików od pierwszego oporu',items).kind,'warning');
  assert.equal(grinderStatus('Timemore C3S · 17 klików',items).kind,'warning');
  assert.equal(grinderStatus('Inny młynek · 17 klików od zera',items).kind,'unknown');
  assert.equal(grinderStatus('17 klików',items).kind,'unknown');
});
test('stepper preserves units and avoids interpreting generic dial scales',() => {
  assert.deepEqual(clickSetting('17 klików od zera'),{value:17,suffix:' klików od zera'});
  for (const value of ['2.5 obrotu','średnio','1500 klików','17–19 klików']) assert.equal(clickSetting(value),null);
});
test('grinder sync acknowledgement retains changes made during a save',() => {
  const sent={grinders:[{name:'C3S',setting:'17'}],revision:'a',dirty:true,changeId:'first'};
  const newer={...sent,grinders:[{name:'C3S',setting:'18'}],changeId:'second'};
  const result=reconcileSyncedState(newer,sent,{grinders:sent.grinders,revision:'b'});
  assert.equal(result.grinders[0].setting,'18');
  assert.equal(result.dirty,true);assert.equal(result.revision,'b');
  assert.equal(reconcileSyncedState(null,sent,{revision:'b'}),null);
});
