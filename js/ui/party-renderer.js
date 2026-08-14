export class PartyRenderer {
  constructor({ root, battle }) {
    this.root = root;
    this.battle = battle;
    this.selectedSlot = 0;
    this.selectedMove = null;
    this.bound = false;
    this.els = {
      turn: root.querySelector('#turnLabel'),
      field: root.querySelector('#fieldLabel'),
      allyRow: root.querySelector('#partyAllyRow'),
      enemyRow: root.querySelector('#partyEnemyRow'),
      panel: root.querySelector('#partyMovePanel'),
      hint: root.querySelector('#partyCommandHint'),
      log: root.querySelector('#battleLog')
    };
  }

  esc(v) { return String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c])); }
  bind() { if (this.bound) return; this.bound = true; this.battle.onUpdate = () => this.render(); this.render(); }
  isPending(memberId, slot) { const key = `${memberId}:${slot}`; return this.battle.pendingPartyActions?.has(key) || this.battle.pendingIds?.has(key); }
  hpBar(p) {
    const max=Math.max(1,Number(p?.maxHP??p?.hp??1)); const hp=Math.max(0,Number(p?.hp??0)); const pct=Math.max(0,Math.min(100,hp/max*100)); const tone=pct<=25?'danger':pct<=50?'warn':'ok';
    return `<div class="v4-hp"><div class="v4-hp-track"><span class="v4-hp-fill ${tone}" style="width:${pct}%"></span></div><span class="v4-hp-text">${hp}/${max}</span></div>`;
  }
  sprite(p, side) { return side==='alpha' ? (p?.sprites?.back||p?.sprites?.front||'') : (p?.sprites?.front||p?.sprites?.back||''); }

  render(){ this.renderHeader(); this.renderSide('beta',this.els.enemyRow); this.renderSide('alpha',this.els.allyRow); this.renderPanel(); this.renderLog(); }
  renderHeader(){
    const totalActive=(Number(this.battle.battleSize)||1)*(Number(this.battle.teamSize)||1);
    if(this.els.turn) this.els.turn.textContent=`Turn ${this.battle.turn} · ${totalActive} active/side`;
    if(this.els.field) this.els.field.textContent=this.battle.field?`${this.battle.field}${this.battle.fieldTurns?` · ${this.battle.fieldTurns}T`:''}`:'No Field';
  }

  renderSide(side,container){
    if(!container) return;
    const members=this.battle.getMembersBySide(side);
    container.innerHTML=members.map(member=>{
      const local=member.id===this.battle.localMemberId;
      const slots=Array.from({length:this.battle.battleSize},(_,slot)=>{
        const p=this.battle.activeMember(member.id,slot);
        if(!p) return `<div class="v4-party-unit"><span class="v4-slot">${slot+1}</span></div>`;
        const pending=this.isPending(member.id,slot);
        const selected=local && slot===this.selectedSlot && p.canBattle();
        const target=this.selectedMove&&this.battle.getTargetsFor?.(this.battle.localMemberId,this.selectedMove,this.selectedSlot)?.some(t=>t.memberId===member.id&&Number(t.slot)===slot);
        const faint=!p.canBattle();
        const cls=['v4-party-unit',selected?'is-selected':'',pending?'is-locked':'',target?'is-targetable':'',this.selectedMove&&!target?'is-dimmed':'',faint?'is-fainted':''].filter(Boolean).join(' ');
        const status=p.status?`<span class="v4-status">${this.esc(String(p.status).replace(/-/g,' '))}</span>`:'';
        const types=(p.types||[]).slice(0,2).map(t=>`<span class="v4-type">${this.esc(t)}</span>`).join('');
        return `<button type="button" class="${cls}" data-member-id="${this.esc(member.id)}" data-slot="${slot}">
          <div class="v4-mon-hud"><div class="v4-name-line"><strong>${this.esc(p.name)}</strong><span>Lv.${p.level??50}</span></div>${this.hpBar(p)}<div class="v4-type-line">${types}${status}</div></div>
          <div class="v4-mon-stage"><span class="v4-shadow"></span><img class="v4-mon-sprite" src="${this.esc(this.sprite(p,side))}" alt="${this.esc(p.name)}" draggable="false"></div>
          <span class="v4-slot">${slot+1}</span>${pending?'<span class="v4-ready">✓</span>':''}
        </button>`;
      }).join('');
      return `<section class="v4-member-block"><div class="v4-member-label"><strong>${this.esc(member.name||'Trainer')}</strong><span>${local?'YOU':'OPPONENT'}</span></div><div class="v4-party-grid">${slots}</div></section>`;
    }).join('');
    container.querySelectorAll('.v4-party-unit').forEach(btn=>btn.addEventListener('click',()=>this.handleFieldClick(btn)));
  }

  handleFieldClick(btn){
    const memberId=btn.dataset.memberId; const slot=Number(btn.dataset.slot); const local=this.battle.getLocalMember?.(); if(!local) return;
    if(this.selectedMove){ this.targetMember(memberId,slot); return; }
    if(memberId===local.id && this.battle.activeMember(memberId,slot)?.canBattle()){ this.selectedSlot=slot; this.selectedMove=null; this.render(); }
  }

  firstUnsubmittedSlot(){
    const local=this.battle.getLocalMember?.(); if(!local) return 0;
    for(let slot=0;slot<this.battle.battleSize;slot+=1){ const p=this.battle.activeMember(local.id,slot); if(p?.canBattle()&&!this.isPending(local.id,slot)) return slot; }
    return 0;
  }
  canSwitchFromCurrent(current){ return !!current?.canBattle() && !(current.volatile?.trapTurns>0) && !(this.battle.getStatusDef?.(current)?.statusEffect?.switchBlock); }

  renderPanel(){
    const local=this.battle.getLocalMember?.(); if(!local||!this.els.panel) return;
    const active=Array.from({length:this.battle.battleSize},(_,slot)=>({slot,pokemon:this.battle.activeMember(local.id,slot)}));
    const alive=active.filter(s=>s.pokemon?.canBattle()).length; const pending=active.filter(s=>this.isPending(local.id,s.slot)).length;
    if(!active.some(s=>s.pokemon?.canBattle())){this.els.panel.innerHTML='<div class="v4-wait">Waiting for your field to update…</div>';return;}
    if(!active[this.selectedSlot]?.pokemon?.canBattle()||this.isPending(local.id,this.selectedSlot)) this.selectedSlot=this.firstUnsubmittedSlot();
    if(pending>=alive){this.els.panel.innerHTML='<div class="v4-wait"><strong>All your actions are locked in.</strong><span>Waiting for the other trainers…</span></div>'; if(this.els.hint)this.els.hint.innerHTML='<span class="v4-live-dot"></span><span>All of your active Pokémon have chosen.</span>';return;}
    const current=active[this.selectedSlot].pokemon;
    const moves=this.battle.getAvailableMovesForMember(local.id,this.selectedSlot)||[];
    const bench=this.battle.getBenchOptions?.(local.id,this.selectedSlot)||[];
    const switchAllowed=this.canSwitchFromCurrent(current)&&bench.length&&!this.isPending(local.id,this.selectedSlot);
    const movesHTML=moves.map(m=>`<button type="button" class="v4-move ${this.selectedMove?.id===m.id?'is-selected':''}" data-move="${this.esc(m.id)}"><strong>${this.esc(m.name)}</strong><span>${this.esc((m.types||[]).join('/'))} · ${this.esc(m.category||'Move')}</span><small>${m.pp??'—'} PP</small></button>`).join('');
    const switches=switchAllowed?bench.map(({pokemon,teamIndex})=>`<button type="button" class="v4-switch" data-switch-index="${teamIndex}"><img src="${this.esc(pokemon.sprites?.front||'')}" alt=""><span>${this.esc(pokemon.name)}</span><small>${pokemon.hp}/${pokemon.maxHP??pokemon.hp}</small></button>`).join(''):'<span class="v4-empty-text">No healthy bench Pokémon available.</span>';
    this.els.panel.innerHTML=`<div class="v4-command-top"><div><div class="v4-eyebrow">WHAT WILL ${this.esc(current.name.toUpperCase())} DO?</div><h2>${this.esc(current.name)}</h2></div><span class="v4-ready-count">${pending}/${alive} ready</span></div><div class="v4-action-grid">${movesHTML}</div><div class="v4-switch-wrap"><div class="v4-section-title">SWITCH</div><div class="v4-switch-grid">${switches}</div></div>`;
    this.els.panel.querySelectorAll('[data-move]').forEach(b=>b.addEventListener('click',()=>this.selectMove(b.dataset.move)));
    this.els.panel.querySelectorAll('[data-switch-index]').forEach(b=>b.addEventListener('click',()=>this.selectSwitch(Number(b.dataset.switchIndex))));
    if(this.els.hint)this.els.hint.innerHTML=`<span class="v4-live-dot"></span><span>${this.selectedMove?`Click a highlighted target for <strong>${this.esc(this.selectedMove.name)}</strong>.`:'Select one of your active Pokémon, choose a move or switch.'}</span>`;
  }

  selectMove(moveId){
    const local=this.battle.getLocalMember?.(); const p=local?this.battle.activeMember(local.id,this.selectedSlot):null; const move=p?.moves?.find(m=>m.id===moveId); if(!move)return; this.selectedMove=move; this.render();
  }
  selectSwitch(teamIndex){
    const local=this.battle.getLocalMember?.(); if(!local)return; const current=this.battle.activeMember(local.id,this.selectedSlot); if(!this.canSwitchFromCurrent(current)||!this.battle.submitPartySwitch)return;
    if(this.battle.submitPartySwitch(local.id,this.selectedSlot,Number(teamIndex))){this.selectedMove=null;this.selectedSlot=this.firstUnsubmittedSlot();this.render();}
  }
  targetMember(memberId,slot){
    if(!this.selectedMove)return; const local=this.battle.getLocalMember?.(); if(!local)return;
    const allowed=this.battle.getTargetsFor?.(local.id,this.selectedMove,this.selectedSlot)?.some(t=>t.memberId===memberId&&Number(t.slot)===Number(slot));
    if(!allowed)return;
    if(this.battle.submitPartyAction?.(local.id,this.selectedSlot,this.selectedMove.id,memberId,Number(slot))){this.selectedMove=null;this.selectedSlot=this.firstUnsubmittedSlot();this.render();}
  }
  renderLog(){ if(!this.els.log)return; const lines=Array.isArray(this.battle.log)?this.battle.log.slice(-100):[]; this.els.log.innerHTML=lines.map(x=>`<div class="v4-log-entry">${this.esc(x)}</div>`).join('')||'<div class="v4-empty-text">Battle log will appear here.</div>'; this.els.log.scrollTop=this.els.log.scrollHeight; }
}
