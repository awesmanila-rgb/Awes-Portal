  // =====================================================================
  // Warehouse movements — the four-step screen (From > To > Items > Review)
  //
  // Receive, Issue, Return and Transfer share one layout:
  //   1 From   2 To   3 Items   4 Review & confirm
  // with a stepper, a live "From > To > n items" line, drawn warehouse tiles (each sign
  // carries that warehouse's own code), and a review that says what will change.
  // The person doing the movement is ALWAYS the signed-in account — it is shown as a badge,
  // never asked for.
  //
  // It is a layer over the existing forms: the real fields (selects, line editors, buttons)
  // are MOVED into the steps and keep their ids, so every posting rule is unchanged, and the
  // last step's button presses the original Post button. Nothing here talks to the database.
  // =====================================================================

  const IT = (function(){
    const G = '#0F5A40', G2 = '#17714F', Y = '#F2B84B', YD = '#7A4B00', B = '#1F5FAE', BD = '#17488A', SK = '#FDE3C8', SH = '#D5E2DA', AM = '#B9770A';
    const S = (w, inner)=> '<svg width="' + w + '" viewBox="0 0 160 110" aria-hidden="true" focusable="false" style="display:block;margin:0 auto;max-width:100%;height:auto">' + inner + '</svg>';
    const person = (x, body, dark)=> '<rect x="' + (x - 9) + '" y="80" width="8" height="18" fill="' + dark + '"/><rect x="' + (x + 1) + '" y="80" width="8" height="18" fill="' + dark + '"/>' +
      '<rect x="' + (x - 16) + '" y="46" width="32" height="38" rx="8" fill="' + body + '" stroke="' + dark + '" stroke-width="3"/><path d="M' + (x - 6) + ' 46V84M' + (x + 6) + ' 46V84" stroke="' + Y + '" stroke-width="4"/>' +
      '<circle cx="' + x + '" cy="31" r="11" fill="' + SK + '" stroke="' + YD + '" stroke-width="2.5"/><path d="M' + (x - 13) + ' 29A13 13 0 0 1 ' + (x + 13) + ' 29Z" fill="' + Y + '" stroke="' + YD + '" stroke-width="2.5" stroke-linejoin="round"/><path d="M' + (x - 15) + ' 29H' + (x + 15) + '" stroke="' + YD + '" stroke-width="3" stroke-linecap="round"/>';
    const esc = (t)=> String(t == null ? '' : t).replace(/[&<>"]/g, c=> ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[c]));
    const art = {
      // the warehouse, with its own code on the sign
      wh(code, w){
        const t = String(code || '').slice(0, 8), big = t.length <= 2, sw = big ? 40 : Math.min(76, 24 + t.length * 8), lx = 80 - sw / 2, fs = t.length > 6 ? 11 : 13;
        return S(w || 128, '<ellipse cx="80" cy="102" rx="70" ry="5" fill="' + SH + '"/><rect x="18" y="46" width="124" height="54" fill="#fff" stroke="' + G + '" stroke-width="3"/><path d="M8 50L80 14L152 50Z" fill="' + G2 + '" stroke="' + G + '" stroke-width="3" stroke-linejoin="round"/><path d="M26 47L80 20" stroke="#fff" stroke-width="2" stroke-opacity=".5"/>' +
          '<rect x="' + lx + '" y="27" width="' + sw + '" height="21" rx="4" fill="' + Y + '" stroke="' + G + '" stroke-width="2.5"/><text x="80" y="42" text-anchor="middle" font-size="' + fs + '" font-weight="500" fill="#2A1D00">' + esc(t) + '</text>' +
          '<rect x="30" y="62" width="44" height="38" fill="#DCE8E0" stroke="' + G + '" stroke-width="2.5"/><rect x="86" y="62" width="44" height="38" fill="#DCE8E0" stroke="' + G + '" stroke-width="2.5"/>' +
          '<path d="M30 70H74M30 78H74M30 86H74M30 94H74M86 70H130M86 78H130M86 86H130M86 94H130" stroke="' + G + '" stroke-width="1.8"/><rect x="142" y="86" width="15" height="14" fill="' + Y + '" stroke="' + YD + '" stroke-width="2"/><path d="M142 93H157" stroke="' + YD + '" stroke-width="1.5"/>');
      },
      project(w){
        return S(w || 128, '<ellipse cx="80" cy="102" rx="70" ry="5" fill="' + SH + '"/><rect x="14" y="38" width="62" height="62" fill="#EAF1FB" stroke="' + B + '" stroke-width="3"/><path d="M14 56H76M14 74H76M14 92H76" stroke="' + B + '" stroke-width="3"/><path d="M34 38V100M56 38V100" stroke="' + B + '" stroke-width="2"/><rect x="18" y="78" width="14" height="12" fill="' + B + '" fill-opacity=".25"/>' +
          '<rect x="100" y="12" width="7" height="88" fill="' + Y + '" stroke="' + YD + '" stroke-width="2.5"/><path d="M100 24L107 34M100 44L107 54M100 64L107 74M100 84L107 94" stroke="' + YD + '" stroke-width="2"/><path d="M62 16H152" stroke="' + YD + '" stroke-width="5" stroke-linecap="round"/><rect x="138" y="17" width="12" height="9" fill="' + YD + '"/><path d="M126 18V56" stroke="#444441" stroke-width="2"/><rect x="116" y="56" width="20" height="14" fill="' + Y + '" stroke="' + YD + '" stroke-width="2.5"/><path d="M142 100L148 86L154 100Z" fill="#E8742A" stroke="#7A3A0A" stroke-width="2" stroke-linejoin="round"/>');
      },
      custody(w){
        return S(w || 128, '<ellipse cx="80" cy="102" rx="40" ry="5" fill="' + SH + '"/>' + person(80, B, BD) + '<path d="M66 56L52 70M94 56L108 70" stroke="' + BD + '" stroke-width="7" stroke-linecap="round"/><rect x="46" y="64" width="68" height="32" fill="#E9B15A" stroke="' + YD + '" stroke-width="3"/><path d="M80 64V96M46 76H114" stroke="' + YD + '" stroke-width="2"/>');
      },
      // a delivery truck (supplier / purchase order)
      truck(w){
        return S(w || 128, '<ellipse cx="80" cy="102" rx="68" ry="5" fill="' + SH + '"/><rect x="14" y="34" width="86" height="54" fill="#fff" stroke="' + AM + '" stroke-width="3"/><path d="M100 50H128L146 68V88H100Z" fill="#FDF1DC" stroke="' + AM + '" stroke-width="3" stroke-linejoin="round"/><path d="M108 56H126L138 68H108Z" fill="#EAF1FB" stroke="' + AM + '" stroke-width="2"/>' +
          '<rect x="26" y="46" width="22" height="18" fill="' + Y + '" stroke="' + YD + '" stroke-width="2.5"/><rect x="52" y="46" width="22" height="18" fill="' + Y + '" stroke="' + YD + '" stroke-width="2.5"/><rect x="39" y="64" width="22" height="18" fill="#E9B15A" stroke="' + YD + '" stroke-width="2.5"/>' +
          '<circle cx="42" cy="90" r="9" fill="#444441" stroke="#2C2C2A" stroke-width="2"/><circle cx="42" cy="90" r="3" fill="#B4B2A9"/><circle cx="122" cy="90" r="9" fill="#444441" stroke="#2C2C2A" stroke-width="2"/><circle cx="122" cy="90" r="3" fill="#B4B2A9"/>');
      },
      // a purchase-order paper
      po(w){
        return S(w || 128, '<ellipse cx="80" cy="102" rx="50" ry="5" fill="' + SH + '"/><rect x="42" y="12" width="76" height="88" rx="4" fill="#fff" stroke="' + AM + '" stroke-width="3"/><path d="M54 30H106M54 42H106M54 54H92M54 66H106" stroke="' + AM + '" stroke-width="2.5" stroke-linecap="round"/><circle cx="98" cy="84" r="12" fill="' + Y + '" stroke="' + YD + '" stroke-width="2.5"/><path d="M92 84L97 89L105 79" fill="none" stroke="#2A1D00" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>');
      },
      box(w){
        return S(w || 128, '<ellipse cx="80" cy="102" rx="48" ry="5" fill="' + SH + '"/><path d="M34 38L80 22L126 38V84L80 100L34 84Z" fill="#E9B15A" stroke="' + YD + '" stroke-width="3" stroke-linejoin="round"/><path d="M34 38L80 54L126 38M80 54V100" fill="none" stroke="' + YD + '" stroke-width="2.5" stroke-linejoin="round"/><path d="M58 30L104 46V58L58 42Z" fill="#fff" fill-opacity=".55" stroke="' + YD + '" stroke-width="1.5"/>');
      },
      // an approved request (clipboard with a tick)
      request(w){
        return S(w || 128, '<ellipse cx="80" cy="102" rx="46" ry="5" fill="' + SH + '"/><rect x="44" y="16" width="72" height="84" rx="5" fill="#fff" stroke="' + G + '" stroke-width="3"/><rect x="64" y="8" width="32" height="14" rx="4" fill="' + Y + '" stroke="' + YD + '" stroke-width="2.5"/><path d="M56 40H70M56 58H70M56 76H70" stroke="' + G + '" stroke-width="3" stroke-linecap="round"/><path d="M78 40H104M78 58H104M78 76H98" stroke="#B4B2A9" stroke-width="3" stroke-linecap="round"/><path d="M92 82L99 89L112 72" fill="none" stroke="' + G2 + '" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>');
      }
    };

    // ---------- the selects that become drawn tiles ----------
    const WH_SELECTS = ['invRcvWh', 'invIssWh', 'invRetWh', 'invTrfFrom', 'invTrfTo'];
    const optInfo = (o)=> { const parts = String(o.textContent || '').split(' \u00B7 '); return { value:o.value, code:(parts[0] || '').trim(), name:(parts.slice(1).join(' \u00B7 ') || parts[0] || '').trim() }; };

    function renderTiles(id){
      const sel = $(id); if(!sel) return;
      let host = sel.parentNode.querySelector('[data-tiles-for="' + id + '"]');
      if(!host){
        host = document.createElement('div'); host.className = 'inv-tiles'; host.setAttribute('data-tiles-for', id); host.setAttribute('role', 'group');
        sel.insertAdjacentElement('afterend', host);
        sel.setAttribute('data-tiled', '1');
      }
      const opts = Array.from(sel.options).filter(o=> o.value);
      host.setAttribute('aria-label', (sel.parentNode.querySelector('label') || {}).textContent || 'Warehouse');
      if(!opts.length){ host.innerHTML = '<div class="inv-tiles-empty">No warehouse to choose from.</div>'; return; }
      host.innerHTML = opts.map(o=>{
        const i = optInfo(o), on = o.value === sel.value;
        return '<button type="button" class="inv-tile' + (on ? ' on' : '') + '" data-v="' + esc(i.value) + '" aria-pressed="' + (on ? 'true' : 'false') + '" aria-label="Warehouse ' + esc(i.code) + (i.name && i.name !== i.code ? ', ' + esc(i.name) : '') + '">' +
          '<span class="inv-art">' + art.wh(i.code, 104) + '</span><span class="inv-tile-t">' + esc(i.code) + '</span>' + (i.name && i.name !== i.code ? '<span class="inv-tile-s">' + esc(i.name) + '</span>' : '') +
          (on ? '<span class="inv-ck" aria-hidden="true">\u2713</span>' : '') + '</button>';
      }).join('');
    }
    // ---------- the "Source" buttons get a drawing ----------
    const MODE_ART = { invRcvMode:{ po:'po', free:'box' }, invIssMode:{ mrf:'request', free:'box' } };
    function decorateModes(){
      Object.keys(MODE_ART).forEach(id=>{
        const grp = $(id); if(!grp) return;
        grp.classList.add('inv-modes');
        grp.querySelectorAll('button[data-m]').forEach(b=>{
          if(b.querySelector('.inv-mode-art')) return;
          const k = MODE_ART[id][b.getAttribute('data-m')];
          if(k) b.insertAdjacentHTML('afterbegin', '<span class="inv-mode-art">' + art[k](72) + '</span>');
        });
      });
    }

    // ---------- the four-step wizard over the existing forms ----------
    const CFG = {
      receive:  { panel:'purchPanel_receive',   role:'Receiver',   verb:'Receive',  post:'invRcvPost', le:'rcv',
        steps:[ { n:'From',  q:'Where is it coming from?',            h:'Choose the kind of delivery.' },
                { n:'To',    q:'Where is it going?',                  h:'Pick the warehouse that receives it. Any warehouse will do.' },
                { n:'Items', q:'Which items arrived?',                h:'Enter what actually arrived.' } ] },
      issue:    { panel:'purchPanel_issue',     role:'Issuer',     verb:'Issue',    post:'invIssPost', le:'iss',
        steps:[ { n:'From',  q:'Which warehouse is it leaving from?', h:'You can only take stock out of your own warehouses.' },
                { n:'To',    q:'Who gets it?',                        h:'The worker signs for it on their phone.' },
                { n:'Items', q:'Which items, and how many?',          h:'Only what is in stock can be issued.' } ] },
      returns:  { panel:'purchPanel_returns',   role:'Returner',   verb:'Return',   post:'invRetPost',
        steps:[ { n:'From',  q:'Whose custody is it in?',             h:'Pick the worker who is returning the materials.' },
                { n:'To',    q:'Which warehouse takes it back?',      h:'Good items go back into stock.' },
                { n:'Items', q:'What is being returned?',             h:'Only what the worker holds is listed.' } ] },
      transfer: { panel:'purchPanel_transfers', role:'Transferer', verb:'Transfer', post:'invTrfPost', le:'trf',
        steps:[ { n:'From',  q:'Which warehouse is it leaving?',      h:'You can only take stock out of your own warehouses.' },
                { n:'To',    q:'Which warehouse is it going to?',     h:'It goes into that warehouse\u2019s stock.' },
                { n:'Items', q:'Which items, and how many?',          h:'You can only move what is in stock.' } ] }
    };
    // which real fields live in which step (and how wide): [id, columns of 12]
    const LAYOUT = {
      issue:    [ [['invIssWh', 12], ['invIssMode', 12], ['invIssMrWrap', 12]],
                  [['invIssWorker', 12, 'recipient'], ['invIssProject', 6], ['invIssJob', 6], ['invIssNote', 12]] ],
      receive:  [ [['invRcvMode', 12], ['invRcvPoWrap', 6], ['invRcvSupWrap', 6], ['invRcvRef', 6]],
                  [['invRcvWh', 12], ['invRcvDirectWrap', 12], ['invRcvProjWrap', 6], ['invRcvJobWrap', 6], ['invRcvNote', 12]] ],
      returns:  [ [['invRetWorker', 12, 'recipient']],
                  [['invRetWh', 12], ['invRetNote', 12]] ],
      transfer: [ [['invTrfFrom', 12]],
                  [['invTrfTo', 12], ['invTrfNote', 12]] ]
    };
    const LABELS = { invIssWh:'From warehouse', invIssWorker:'Worker who gets it', invRetWorker:'Worker whose custody it is in', invRetWh:'Into warehouse', invRcvWh:'Receiving warehouse', invTrfFrom:'From warehouse', invTrfTo:'To warehouse', invRcvMode:'Kind of delivery', invIssMode:'Based on' };
    const wz = {};   // per screen: { el, step }
    const fieldOf = (id)=> { const e = $(id); return e ? (e.closest('.field') || e) : null; };
    const selText = (id)=> { const s = $(id); if(!s || !s.value) return ''; const o = s.options && s.options[s.selectedIndex]; return o ? String(o.textContent || '').trim() : ''; };
    const whName = (id)=> { const t = selText(id); return t ? 'Warehouse ' + t.split(' \u00B7 ')[0].trim() : ''; };
    const mode = (id)=> { const b = $(id) && $(id).querySelector('button.on[data-m]'); return b ? b.getAttribute('data-m') : ''; };
    const initials = (n)=> String(n || '?').trim().split(/\s+/).slice(0, 2).map(w=> w[0]).join('').toUpperCase() || '?';

    function build(key){
      const cfg = CFG[key], panel = $(cfg.panel); if(!panel || wz[key]) return;
      const body = panel.querySelector('.card-body'), top = body && body.querySelector('.po-ed-top'); if(!top) return;
      const sections = Array.from(body.querySelectorAll(':scope > section.po-sec'));
      const itemsSec = sections[1], actions = body.querySelector(':scope > .po-actions');
      const el = document.createElement('div'); el.className = 'wz'; el.id = 'wz-' + key;
      el.innerHTML =
        '<div class="wz-head"><div class="wz-acct" title="The person doing this is always the signed-in account"><span class="wz-av"></span><span class="wz-who"><b></b><i></i></span></div></div>' +
        '<ol class="wz-steps">' + cfg.steps.concat([{ n:'Review' }]).map((s, i)=> '<li><button type="button" class="wz-stp" data-go="' + i + '"><span class="wz-dot">' + (i + 1) + '</span><span class="wz-sl">' + s.n + '</span></button></li>').join('') + '</ol>' +
        '<div class="wz-bar" aria-live="polite"></div>' +
        cfg.steps.concat([{ q:'Check and confirm', h:'Nothing is posted until you confirm.' }]).map((s, i)=> '<section class="wz-step" data-s="' + i + '"><h3 class="wz-q">' + s.q + '</h3><p class="wz-help">' + s.h + '</p><div class="wz-body"></div></section>').join('') +
        '<div class="wz-err" role="alert"></div>' +
        '<div class="wz-foot"><button type="button" class="btn btn-secondary wz-back">Back</button><button type="button" class="btn btn-primary wz-next">Next</button></div>';
      top.insertAdjacentElement('afterend', el);
      const bodies = el.querySelectorAll('.wz-body');
      // move the real fields into steps 1 and 2
      LAYOUT[key].forEach((fields, si)=>{
        const grid = document.createElement('div'); grid.className = 'po-grid wz-grid'; bodies[si].appendChild(grid);
        fields.forEach(([id, span, kind])=>{
          const f = fieldOf(id); if(!f) return;
          f.classList.remove('po-c3', 'po-c6', 'po-c12'); f.classList.add('po-c' + span);
          if(LABELS[id]){ const l = f.querySelector('label'); if(l && l.firstChild) l.firstChild.textContent = LABELS[id] + ' '; }
          if(kind === 'recipient'){
            const wrap = document.createElement('div'); wrap.className = 'wz-recipient po-c12'; wrap.innerHTML = '<span class="wz-recipient-art">' + art.custody(96) + '</span>';
            wrap.appendChild(f); f.className = 'field wz-recipient-f'; grid.appendChild(wrap);
          }else grid.appendChild(f);
        });
      });
      // the items section moves whole into step 3; its title is replaced by the step heading
      if(itemsSec){ itemsSec.classList.add('wz-items'); bodies[2].appendChild(itemsSec); }
      // the original first section and Post button stay in the page, hidden
      sections.forEach(s=>{ if(s !== itemsSec) s.classList.add('wz-legacy'); });
      if(actions) actions.classList.add('wz-legacy');
      wz[key] = { el, step:0 };
      el.addEventListener('click', (ev)=>{
        const go = ev.target.closest('.wz-stp'); if(go){ const g = Number(go.dataset.go); if(g < wz[key].step) show(key, g); return; }
        if(ev.target.closest('.wz-back')){ show(key, Math.max(0, wz[key].step - 1)); return; }
        if(ev.target.closest('.wz-next')) next(key);
      });
    }

    // ---------- the items, as the real forms hold them ----------
    function readItems(key){
      const out = { rows:[], err:'' };
      const unit = (m)=> m ? m.unit : '';
      if(key === 'receive' && mode('invRcvMode') === 'po'){
        for(const i of (typeof invRcvPoLines !== 'undefined' ? invRcvPoLines : [])){
          if(!String(i.now == null ? '' : i.now).trim()) continue;
          const q = spParseMoney(i.now), rem = Number(i.qty) - Number(i.qty_received);
          if(q == null || Number.isNaN(q) || q <= 0){ out.err = i.description + ': enter a quantity above 0'; return out; }
          if(q > rem){ out.err = i.description + ': only ' + invQty(rem) + ' ' + i.unit + ' left on this PO'; return out; }
          if(!i.map){ out.err = i.description + ': choose which catalog item it is'; return out; }
          out.rows.push({ name:i.description, qty:q, unit:i.unit });
        }
        if(!out.rows.length) out.err = 'Enter what was received.';
        return out;
      }
      if(key === 'returns'){
        for(const h of invRetHold){
          if(!String(h.ret).trim()) continue;
          const q = spParseMoney(h.ret), m = invX.catById.get(h.material_id);
          if(q == null || Number.isNaN(q) || q <= 0){ out.err = (m ? m.code : 'Item') + ': enter a quantity above 0'; return out; }
          if(q > Number(h.holding)){ out.err = (m ? m.code : 'Item') + ': they only hold ' + invQty(h.holding); return out; }
          out.rows.push({ name:m ? m.name : 'Item', qty:q, unit:unit(m), note:h.cond === 'damaged' ? 'damaged' : '' });
        }
        if(!out.rows.length) out.err = 'Enter what is being returned.';
        return out;
      }
      const lines = invLECollect(CFG[key].le);
      if(typeof lines === 'string'){ out.err = lines; return out; }
      if(!lines.length){ out.err = 'Add at least one item.'; return out; }
      const whId = key === 'issue' ? $('invIssWh').value : key === 'transfer' ? $('invTrfFrom').value : '';
      for(const l of lines){
        const m = invX.catById.get(l.material_id);
        if(whId && l.qty > invAvail(whId, l.material_id)){ out.err = 'Not enough stock in ' + whName(key === 'issue' ? 'invIssWh' : 'invTrfFrom').replace('Warehouse ', '') + ' for ' + (m ? m.code : 'an item') + '.'; return out; }
        out.rows.push({ name:m ? m.name : 'Item', qty:l.qty, unit:unit(m) });
      }
      return out;
    }
    // what each step needs before it can move on ('' = fine)
    function check(key, s){
      if(key === 'issue'){
        if(s === 0){ if(!$('invIssWh').value) return 'Choose the warehouse.'; if(mode('invIssMode') === 'mrf' && !$('invIssMr').value) return 'Choose the request, or switch to Direct.'; }
        if(s === 1 && !$('invIssWorker').value) return 'Choose who gets it.';
      }
      if(key === 'receive'){
        if(s === 0 && mode('invRcvMode') === 'po' && !$('invRcvPo').value) return 'Choose the purchase order.';
        if(s === 1){ if(!$('invRcvWh').value) return 'Choose the warehouse.'; if($('invRcvDirect').checked && !$('invRcvProject').value && !$('invRcvJob').value) return 'Choose the project or job order it is charged to.'; }
      }
      if(key === 'returns'){ if(s === 0 && !$('invRetWorker').value) return 'Choose the worker.'; if(s === 1 && !$('invRetWh').value) return 'Choose the warehouse.'; }
      if(key === 'transfer'){
        if(s === 0 && !$('invTrfFrom').value) return 'Choose the warehouse it is leaving.';
        if(s === 1){ if(!$('invTrfTo').value) return 'Choose the warehouse it is going to.'; if($('invTrfTo').value === $('invTrfFrom').value) return 'Choose a different warehouse.'; }
      }
      if(s === 2) return readItems(key).err;
      return '';
    }

    // ---------- the live line under the stepper ----------
    function ends(key){
      if(key === 'issue') return [whName('invIssWh'), selText('invIssWorker')];
      if(key === 'returns') return [selText('invRetWorker'), whName('invRetWh')];
      if(key === 'transfer') return [whName('invTrfFrom'), whName('invTrfTo')];
      const po = mode('invRcvMode') === 'po';
      return [po ? (selText('invRcvPo') || 'Purchase order') : 'Delivery without a PO', $('invRcvDirect') && $('invRcvDirect').checked ? 'Direct to project' : whName('invRcvWh')];
    }
    function countItems(key){
      if(key === 'receive' && mode('invRcvMode') === 'po') return (typeof invRcvPoLines !== 'undefined' ? invRcvPoLines : []).filter(i=> String(i.now == null ? '' : i.now).trim()).length;
      if(key === 'returns') return invRetHold.filter(h=> String(h.ret).trim()).length;
      return invLE[CFG[key].le] ? invLE[CFG[key].le].lines.filter(l=> l.material_id && String(l.qty).trim()).length : 0;
    }
    function renderBar(key){
      const w = wz[key]; if(!w) return;
      const [f, t] = ends(key), n = countItems(key);
      w.el.querySelector('.wz-bar').innerHTML =
        '<span class="wz-chip' + (f ? ' set' : '') + '">' + esc(f || 'From') + '</span><span class="wz-arr" aria-hidden="true">\u2192</span>' +
        '<span class="wz-chip' + (t ? ' set' : '') + '">' + esc(t || 'To') + '</span>' +
        (n ? '<span class="wz-chip">' + n + ' item' + (n === 1 ? '' : 's') + '</span>' : '');
    }
    // ---------- the review ----------
    function effects(key){
      const [f, t] = ends(key), row = (cls, sym, x)=> '<div><span class="wz-ico ' + cls + '" aria-hidden="true">' + sym + '</span><span>' + esc(x) + '</span></div>';
      const up = (x)=> row('', '+', x), down = (x)=> row('down', '\u2212', x), ok = (x)=> row('', '\u2713', x);
      if(key === 'issue') return down('Stock in ' + f + ' goes down') + ok(t + ' is asked to sign on their phone');
      if(key === 'receive') return ($('invRcvDirect').checked ? ok('The cost is charged to the project and the goods do not stay in stock') : up('Stock in ' + t + ' goes up')) +
        (mode('invRcvMode') === 'po' ? ok('The purchase order shows what has arrived') : ok('Recorded without a purchase order'));
      if(key === 'returns') return up('Good items go back into ' + t) + down(f + ' no longer holds them') + (readItems(key).rows.some(r=> r.note) ? row('warn', '!', 'Damaged items are recorded but not put back in stock') : '');
      return down('Stock in ' + f + ' goes down') + up('Stock in ' + t + ' goes up by the same amount');
    }
    function buildReview(key){
      const cfg = CFG[key], it = readItems(key), [f, t] = ends(key), me = (typeof currentUser !== 'undefined' && currentUser && currentUser.name) || 'You';
      const extra = [];
      if(key === 'issue'){ const p = selText('invIssProject'), j = selText('invIssJob'); if($('invIssProject').value) extra.push(['Project', p]); if($('invIssJob').value) extra.push(['Job order', j]); if(mode('invIssMode') === 'mrf' && $('invIssMr').value) extra.push(['Request', selText('invIssMr')]); }
      if(key === 'receive'){ if($('invRcvRef').value.trim()) extra.push(['Delivery receipt', $('invRcvRef').value.trim()]); if($('invRcvDirect').checked){ const p = $('invRcvProject').value ? selText('invRcvProject') : selText('invRcvJob'); if(p) extra.push(['Charged to', p]); } }
      const noteId = { issue:'invIssNote', receive:'invRcvNote', returns:'invRetNote', transfer:'invTrfNote' }[key];
      if($(noteId) && $(noteId).value.trim()) extra.push(['Note', $(noteId).value.trim()]);
      const rows = it.rows.map(r=> '<div class="wz-li"><span>' + esc(r.name) + (r.note ? ' <em>' + esc(r.note) + '</em>' : '') + '</span><b>' + esc(invQty(r.qty)) + ' ' + esc(r.unit) + '</b></div>').join('');
      wz[key].el.querySelector('.wz-step[data-s="3"] .wz-body').innerHTML =
        '<dl class="wz-sum"><dt>From</dt><dd>' + esc(f) + '</dd><dt>To</dt><dd>' + esc(t) + '</dd><dt>' + cfg.role + '</dt><dd>You \u2014 ' + esc(me) + '</dd>' + extra.map(e=> '<dt>' + esc(e[0]) + '</dt><dd>' + esc(e[1]) + '</dd>').join('') + '</dl>' +
        '<div class="wz-lines">' + rows + '</div><div class="wz-what">What happens</div><div class="wz-eff">' + effects(key) + '</div>';
      return it.rows.length;
    }

    // ---------- moving between steps ----------
    function show(key, s){
      const w = wz[key]; if(!w) return;
      w.step = s; const cfg = CFG[key];
      w.el.querySelectorAll('.wz-step').forEach(x=> x.classList.toggle('on', Number(x.dataset.s) === s));
      w.el.querySelectorAll('.wz-stp').forEach((b, i)=>{
        const li = b.closest('li'); li.className = i < s ? 'done' : i === s ? 'cur' : '';
        b.querySelector('.wz-dot').textContent = i < s ? '\u2713' : String(i + 1);
        b.setAttribute('aria-current', i === s ? 'step' : 'false'); b.disabled = i > s;
      });
      w.el.querySelector('.wz-err').textContent = '';
      w.el.querySelector('.wz-back').style.visibility = s === 0 ? 'hidden' : '';
      let label = 'Next: ' + (s === 0 ? 'to' : s === 1 ? 'items' : 'review');
      if(s === 3){ const n = buildReview(key); label = cfg.verb + ' ' + n + ' item' + (n === 1 ? '' : 's'); }
      w.el.querySelector('.wz-next').textContent = label;
      renderBar(key);
      if(w.el.scrollIntoView && s > 0) w.el.scrollIntoView({ block:'nearest' });
    }
    function next(key){
      const w = wz[key], s = w.step, err = check(key, s);
      if(err){ w.el.querySelector('.wz-err').textContent = err; return; }
      if(s < 3){ show(key, s + 1); return; }
      // last step: re-check everything, then press the real Post button (the review was the confirmation)
      for(let i = 0; i < 3; i++){ const e = check(key, i); if(e){ show(key, i); w.el.querySelector('.wz-err').textContent = e; return; } }
      invWz.skipConfirm = true;
      try{ $(CFG[key].post).click(); } finally { invWz.skipConfirm = false; }
    }
    function onEnter(){
      const me = (typeof currentUser !== 'undefined' && currentUser && currentUser.name) || '';
      Object.keys(CFG).forEach(key=>{
        build(key); const w = wz[key]; if(!w) return;
        w.el.querySelector('.wz-av').textContent = initials(me);
        w.el.querySelector('.wz-who b').textContent = me || 'Signed in';
        w.el.querySelector('.wz-who i').textContent = CFG[key].role + ' \u00B7 signed in';
        show(key, 0);
      });
    }
    function syncAll(){
      WH_SELECTS.forEach(renderTiles);
      decorateModes();
      Object.keys(wz).forEach(key=>{ renderBar(key); if(wz[key].step === 3) buildReview(key); });
    }
    return { art, syncAll, onEnter, renderTiles, WH_SELECTS, wz, show, readItems };
  })();

  // the posting handlers ask "are you sure?" — the review step already did, so it skips the second question
  const invWz = { skipConfirm:false };
  function invAsk(msg){ if(invWz.skipConfirm){ invWz.skipConfirm = false; return Promise.resolve(true); } return uiConfirm(msg); }

  // a tile tap sets the real select and tells the page, exactly as if the person had used the drop-down
  document.addEventListener('click', (ev)=>{
    const t = ev.target.closest && ev.target.closest('.inv-tile[data-v]'); if(!t) return;
    const host = t.closest('[data-tiles-for]'), sel = host && $(host.getAttribute('data-tiles-for')); if(!sel) return;
    sel.value = t.getAttribute('data-v');
    sel.dispatchEvent(new Event('change', { bubbles:true }));
    IT.syncAll();
  });
  // anything that changes a choice on these screens refreshes the pictures and the line under the stepper
  document.addEventListener('change', (ev)=>{ const id = ev.target && ev.target.id; if(id && /^(invRcv|invIss|invRet|invTrf)/.test(id)) IT.syncAll(); });
  document.addEventListener('input', (ev)=>{ if(ev.target && ev.target.closest && ev.target.closest('.wz')) IT.syncAll(); });
  document.addEventListener('click', (ev)=>{
    if(ev.target.closest && ev.target.closest('#invRcvMode, #invIssMode, #invRcvDirect')) setTimeout(()=> IT.syncAll(), 0);
  });
  (function(){
    const mo = new MutationObserver(()=>{ if(!mo._busy){ mo._busy = true; Promise.resolve().then(()=>{ try{ IT.syncAll(); }finally{ mo._busy = false; } }); } });
    IT.WH_SELECTS.concat(['invRcvPo', 'invRcvSupplier', 'invIssWorker', 'invRetWorker', 'invIssProject', 'invIssJob', 'invRcvProject', 'invRcvJob', 'invIssMr']).forEach(id=>{ const s = document.getElementById(id); if(s) mo.observe(s, { childList:true }); });
    ['invRcvLines', 'invIssLines', 'invRetLines', 'invTrfLines'].forEach(id=>{ const s = document.getElementById(id); if(s) mo.observe(s, { childList:true }); });
    IT.onEnter();
  })();
