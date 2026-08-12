import fs from 'fs';
import path from 'path';
const battle = fs.readFileSync(new URL('../js/engine/battle.js', import.meta.url), 'utf8');
if (battle.includes('typeStatusChance') || battle.includes('defaultStatusChance')) {
  throw new Error('Generic type-status chance is still enabled in battle.js');
}
if (battle.includes('def.field') && battle.includes('afflicted')) {
  throw new Error('Status -> field coupling still appears in battle.js');
}
console.log('Type status/field separation checks passed.');
