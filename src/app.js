import { loadGameData } from './engine/data.js';
import { Battle } from './engine/battle.js';
import { makeAiTurn } from './engine/ai.js';
import { Renderer } from './ui/renderer.js';
import { renderBuilder } from './ui/builder.js';

const app = document.querySelector('#app');

boot().catch(error => {
  console.error(error);
  app.innerHTML = `<div class="builder"><div class="builder-card error"><h1>Could not load game</h1><pre>${escapeHtml(error.stack || error.message)}</pre></div></div>`;
});

async function boot() {
  const data = await loadGameData();
  renderBuilder(app, data, { onStart: payload => startBattle(data, payload) });
}

function startBattle(data, payload) {
  let battle;
  try {
    battle = new Battle({ data, ...payload });
  } catch (error) {
    console.error(error);
    app.innerHTML = `<div class="builder"><div class="builder-card error"><h1>Battle setup failed</h1><pre>${escapeHtml(error.stack || error.message)}</pre></div></div>`;
    return;
  }
  const renderer = new Renderer(app, data, battle, {
    onMove: (moveId, preferredSlot = null) => {
      const activeCount = battle.getActive('player').length;
      for (let slot=0; slot<activeCount; slot++) {
        const p=battle.getActive('player')[slot];
        const firstSlot = preferredSlot != null && !battle.getSide('player').choices[preferredSlot] ? preferredSlot : slot;
        const chosenPokemon = battle.getActive('player')[firstSlot];
        if (chosenPokemon?.hp>0 && !battle.getSide('player').choices[firstSlot]) { battle.chooseMove('player',firstSlot,moveId,0); break; }
      }
      if (battle.phase==='resolving') setTimeout(()=>makeAiTurn(battle),0);
    },
    onSwitch: (teamIndex) => {
      const activeCount=battle.getActive('player').length;
      for(let slot=0;slot<activeCount;slot++){ if(!battle.getSide('player').choices[slot]) { battle.chooseSwitch('player',slot,teamIndex); break; } }
      if (battle.phase==='resolving') setTimeout(()=>makeAiTurn(battle),0);
    },
    onRestart: () => renderBuilder(app,data,{onStart:p=>startBattle(data,p)})
  });
  renderer.mount();
  // Opponent choices are made after the player's current choice set is complete.
  // The engine never waits on a remote promise; both sides enter the same resolver.
  const originalChooseMove = battle.chooseMove.bind(battle);
  battle.chooseMove = (...args) => { const r=originalChooseMove(...args); if(args[0]==='player' && battle.allChoicesReady('player') && battle.phase==='choosing') makeAiTurn(battle); return r; };
  const originalChooseSwitch = battle.chooseSwitch.bind(battle);
  battle.chooseSwitch = (...args) => { const r=originalChooseSwitch(...args); if(args[0]==='player' && battle.allChoicesReady('player') && battle.phase==='choosing') makeAiTurn(battle); return r; };
}
function escapeHtml(s){return String(s).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));}
