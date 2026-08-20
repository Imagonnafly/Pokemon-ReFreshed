export function renderBuilder(root, data, callbacks) {
  root.innerHTML = `<div class="builder"><div class="builder-card"><div class="eyebrow">NEW ENGINE</div><h1>Pokémon ReFreshed</h1><p>A clean, soft-coded battle project. Official Pokémon types. No turn-resolution deadlock.</p>
    <div class="builder-grid"><label>Battle size<select id="battleSize">${data.config.battle.allowedSizes.map(n=>`<option value="${n}">${n}v${n}</option>`).join('')}</select></label>
    <label>Player team<select id="playerTeam">${Object.keys(data.teams).filter(k=>k==='player').map(k=>`<option value="${k}">Demo team</option>`).join('')}</select></label>
    </div>
    <button class="primary" id="start">Start Battle</button><div class="notes"><span>Official types: ${data.types.types.join(', ')}</span><span>Battle sizes: ${data.config.battle.allowedSizes.join(', ')}</span></div>
  </div></div>`;
  root.querySelector('#start').addEventListener('click',()=>callbacks.onStart({battleSize:Number(root.querySelector('#battleSize').value),playerTeam:data.teams.player,opponentTeam:data.teams.opponent}));
}
