  // =====================================================================
  // Inventory — Phase 1 (migration 20260923_07_inventory_foundation.sql)
  //
  //   Stock on Hand   admin: qty + average cost + value per warehouse,
  //                   opening balances, item history, count adjustments
  //   Warehouses      admin: add / edit / deactivate
  //   Projects        admin: big jobs grouping job orders; material cost
  //   Warehouse Stock storekeeper: quantities only, own warehouses only
  //   Users & Roles   the Storekeeper setting = warehouse assignments
  //
  // The DATABASE keeps balances and average cost (trigger on every
  // stock_movements insert), refuses negative stock, and never lets a
  // movement be edited or deleted. Storekeepers read *_qty views that
  // carry no money at all.
  // =====================================================================

  const INV_TYPE_LABEL = { opening:'Opening', adjustment:'Adjustment', receipt:'Received', issue:'Issued', 'return':'Returned',
    transfer_out:'Transfer out', transfer_in:'Transfer in', write_off:'Written off' };
  const INV_PRJ_STATUS = { planning:'Planning', active:'Active', on_hold:'On hold', completed:'Completed', cancelled:'Cancelled' };

  let invWarehouses = [];
  let invBalances = [];          // stock_balances rows
  let invProfileNames = new Map();

  function invMoney(n){ return '₱' + poFmt(n); }
  function invQty(n){ return poQtyFmt(n); }
  function invWh(id){ return invWarehouses.find(w=> w.id === id); }
  function invWhLabel(id){ const w = invWh(id); return w ? w.code + ' · ' + w.name : '—'; }
  function invMissingTables(e){ return /42P01|does not exist|schema cache/.test(describeCloudError(e)); }
  const INV_MIGRATION_MSG = 'The inventory tables aren\u2019t in the database yet — run migration 20260923_07_inventory_foundation.sql in Supabase first.';

  async function invLoadWarehouses(){
    const { data, error } = await db.from('warehouses').select('*').order('code');
    if(error) throw error;
    invWarehouses = data || [];
    return invWarehouses;
  }
  async function invLoadNames(ids){
    const need = Array.from(new Set(ids.filter(id=> id && !invProfileNames.has(id))));
    if(!need.length) return;
    try{
      const { data } = await db.from('profiles').select('id, name').in('id', need);
      (data || []).forEach(p=> invProfileNames.set(p.id, p.name || ''));
    }catch(e){}
  }

  // =====================================================================
  // STOCK ON HAND (admin)
  // =====================================================================
  let invItemOpen = null;   // material being viewed
  function invStockView(which){
    $('invStockListView').style.display = which === 'list' ? '' : 'none';
    $('invOpeningView').style.display = which === 'opening' ? '' : 'none';
    $('invItemView').style.display = which === 'item' ? '' : 'none';
    $('purchasingView').classList.toggle('po-wide', which !== 'list');
    if(which !== 'item') invItemOpen = null;
    window.scrollTo({ top:0 });
  }
  async function invShowStock(){
    invStockView('list');
    await invLoadStock();
  }
  async function invLoadStock(opts){
    const silent = !!(opts && opts.silent);
    const list = $('invStockList');
    if(!silent) list.innerHTML = '<div class="empty-state">Loading…</div>';
    if(!(await ensureCloud())){ if(!silent) list.innerHTML = '<div class="empty-state">Not connected.</div>'; return false; }
    try{
      const [, b] = await Promise.all([invLoadWarehouses(), db.from('stock_balances').select('*'), mtLoad({ silent:true })]);
      if(b.error) throw b.error;
      invBalances = b.data || [];
      const whSel = $('invStockWh'), keep = whSel.value;
      whSel.innerHTML = '<option value="">All warehouses</option>' + invWarehouses.map(w=> '<option value="' + escapeHtml(w.id) + '">' + escapeHtml(w.code + ' · ' + w.name) + (w.is_active ? '' : ' (inactive)') + '</option>').join('');
      whSel.value = keep;
      const cat = $('invStockCat');
      if(cat.options.length <= 1) PURCH_CAT_ALL.forEach(c=>{ const o = document.createElement('option'); o.value = c; o.textContent = c; cat.appendChild(o); });
      invRenderStock();
      return true;
    }catch(e){
      console.error('load stock failed', describeCloudError(e));
      if(!silent) list.innerHTML = '<div class="empty-state">' + (purchIsAuthError(e) ? PURCH_EXPIRED_HTML : invMissingTables(e) ? INV_MIGRATION_MSG : 'Couldn\u2019t load stock: ' + escapeHtml(describeCloudError(e))) + '</div>';
      return false;
    }
  }
  function invStockRows(){
    const wh = $('invStockWh').value, cat = $('invStockCat').value, showZero = $('invStockZero').checked;
    const words = ($('invStockSearch').value || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
    const byMat = new Map();
    invBalances.forEach(b=>{
      if(wh && b.warehouse_id !== wh) return;
      const e = byMat.get(b.material_id) || { qty:0, value:0, per:[] };
      const q = Number(b.qty_on_hand), v = q * Number(b.avg_cost);
      e.qty += q; e.value += v; e.per.push(b);
      byMat.set(b.material_id, e);
    });
    const mats = showZero ? mtCache.filter(m=> m.isActive || byMat.has(m.id)) : mtCache.filter(m=> byMat.has(m.id) && byMat.get(m.id).qty > 0);
    return mats.filter(m=>{
      if(cat && m.category !== cat) return false;
      if(!words.length) return true;
      const hay = [m.code, m.name, m.family, m.brand, mtSpecText(m.specs)].join(' ').toLowerCase();
      return words.every(w=> hay.includes(w));
    }).map(m=> ({ m, s: byMat.get(m.id) || { qty:0, value:0, per:[] } }))
      .sort((a, b)=> a.m.category.localeCompare(b.m.category) || a.m.name.localeCompare(b.m.name, undefined, { numeric:true }));
  }
  function invRenderStock(){
    const rows = invStockRows();
    const wh = $('invStockWh').value;
    const inStock = rows.filter(r=> r.s.qty > 0);
    const value = rows.reduce((a, r)=> a + r.s.value, 0);
    $('invStockSummary').innerHTML =
      '<div class="tile"><div class="k">Items in stock</div><div class="v">' + inStock.length + '</div></div>' +
      '<div class="tile"><div class="k">Stock value' + (wh ? ' — ' + escapeHtml(invWh(wh) ? invWh(wh).code : '') : '') + '</div><div class="v">' + invMoney(value) + '</div></div>' +
      '<div class="tile"><div class="k">Warehouses</div><div class="v">' + invWarehouses.filter(w=> w.is_active).length + '</div></div>';
    $('invStockCount').textContent = inStock.length ? inStock.length + ' items · ' + invMoney(value) : '';
    const list = $('invStockList');
    if(!invWarehouses.length){ list.innerHTML = '<div class="empty-state">Add a warehouse first — <b>Inventory › Warehouses</b>.</div>'; return; }
    if(!rows.length){ list.innerHTML = '<div class="empty-state">' + (invBalances.length ? 'Nothing matches.' : 'No stock recorded yet. Tap <b>+ Opening Balance</b> to enter what you have now.') + '</div>'; return; }
    let html = '', lastCat = null;
    rows.forEach(({ m, s })=>{
      if(m.category !== lastCat){ lastCat = m.category; html += '<div class="mt-group-head">' + escapeHtml(m.category) + '</div>'; }
      const chips = !wh && s.per.length > 1 ? '<div class="inv-wh-chips">' + s.per.filter(b=> Number(b.qty_on_hand) > 0).map(b=>
        '<span class="sp-tag muted">' + escapeHtml(invWh(b.warehouse_id) ? invWh(b.warehouse_id).code : '?') + ': ' + invQty(b.qty_on_hand) + '</span>').join('') + '</div>' : '';
      const avg = s.qty > 0 ? s.value / s.qty : 0;
      html += '<button type="button" class="mt-row" data-id="' + escapeHtml(m.id) + '"><div class="mt-row-main">' +
        '<div class="mt-row-title"><span class="mt-code">' + escapeHtml(m.code) + '</span>' + escapeHtml(m.name) + '</div>' +
        '<div class="sp-row-sub">' + (s.qty > 0 ? 'avg ' + invMoney(avg) + ' / ' + escapeHtml(m.unit) : 'no stock') + '</div>' + chips + '</div>' +
        '<div class="mt-row-price"><span class="inv-qty' + (s.qty > 0 ? '' : ' zero') + '">' + invQty(s.qty) + ' ' + escapeHtml(m.unit) + '</span>' +
        '<div class="sp-row-sub">' + invMoney(s.value) + '</div></div></button>';
    });
    list.innerHTML = html;
  }
  ['invStockSearch'].forEach(id=> $(id).addEventListener('input', invRenderStock));
  ['invStockWh', 'invStockCat', 'invStockZero'].forEach(id=> $(id).addEventListener('change', invRenderStock));
  $('invStockList').addEventListener('click', (e)=>{
    if(e.target.closest('[data-purch-reauth]')){ purchReauth().then(ok=>{ if(ok) invShowStock(); }); return; }
    const r = e.target.closest('.mt-row'); if(r) invOpenItem(r.dataset.id);
  });
  $('invStockExportBtn').addEventListener('click', ()=>{
    const wh = $('invStockWh').value;
    const lines = [['warehouse','code','item','unit','qty_on_hand','avg_cost','value'].join(',')];
    invBalances.filter(b=> (!wh || b.warehouse_id === wh) && Number(b.qty_on_hand) !== 0).forEach(b=>{
      const m = mtCache.find(x=> x.id === b.material_id) || {};
      lines.push([invWh(b.warehouse_id) ? invWh(b.warehouse_id).code : '', m.code, m.name, m.unit, Number(b.qty_on_hand), Number(b.avg_cost), (Number(b.qty_on_hand) * Number(b.avg_cost)).toFixed(2)].map(spCsvCell).join(','));
    });
    const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type:'text/csv;charset=utf-8' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = 'stock-on-hand-' + poToday() + '.csv'; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(()=> URL.revokeObjectURL(a.href), 2000);
    toast('Exported ' + (lines.length - 1) + ' stock line' + (lines.length === 2 ? '' : 's'));
  });

  // ---------- item detail: per-warehouse + history + adjust ----------
  async function invOpenItem(materialId){
    const m = mtCache.find(x=> x.id === materialId);
    if(!m) return;
    invItemOpen = m;
    $('invItemTitle').innerHTML = '<span class="mt-code">' + escapeHtml(m.code) + '</span> ' + escapeHtml(m.name);
    invStockView('item');
    invItemOpen = m;
    await invRenderItem();
  }
  async function invRenderItem(){
    const m = invItemOpen; if(!m) return;
    const bal = invBalances.filter(b=> b.material_id === m.id);
    $('invItemCards').innerHTML = invWarehouses.filter(w=> w.is_active || bal.some(b=> b.warehouse_id === w.id)).map(w=>{
      const b = bal.find(x=> x.warehouse_id === w.id) || { qty_on_hand:0, avg_cost:0 };
      const q = Number(b.qty_on_hand);
      return '<div class="tile"><div class="k">' + escapeHtml(w.code + ' · ' + w.name) + '</div>' +
        '<div class="v">' + invQty(q) + ' ' + escapeHtml(m.unit) + '</div>' +
        '<div class="s">' + (q ? 'avg ' + invMoney(b.avg_cost) + ' · ' + invMoney(q * Number(b.avg_cost)) : 'none') + '</div>' +
        '<button type="button" class="btn btn-secondary mt-small-btn" style="margin-top:8px;" data-adjust="' + escapeHtml(w.id) + '">Adjust count</button></div>';
    }).join('');
    const hist = $('invItemHistory');
    hist.innerHTML = '<tbody><tr><td>Loading…</td></tr></tbody>';
    try{
      const { data, error } = await db.from('stock_movements').select('*').eq('material_id', m.id).order('created_at', { ascending:false }).limit(300);
      if(error) throw error;
      const rows = data || [];
      await invLoadNames(rows.map(r=> r.created_by).concat(rows.map(r=> r.worker_id)));
      if(!rows.length){ hist.innerHTML = '<tbody><tr><td style="color:var(--text-muted);">No movements yet.</td></tr></tbody>'; return; }
      hist.innerHTML = '<thead><tr><th>When</th><th>Warehouse</th><th>Type</th><th>Reference</th><th class="num">Qty</th><th class="num">Balance</th><th class="num">Unit cost</th><th class="num">Value</th><th>By</th></tr></thead><tbody>' +
        rows.map(r=> '<tr><td>' + escapeHtml(mrWhen(r.created_at)) + '</td><td>' + escapeHtml(invWh(r.warehouse_id) ? invWh(r.warehouse_id).code : '') + '</td>' +
          '<td>' + escapeHtml(INV_TYPE_LABEL[r.doc_type] || r.doc_type) + '</td><td>' + escapeHtml([r.doc_ref, r.note].filter(Boolean).join(' — ')) + '</td>' +
          '<td class="num ' + (Number(r.qty) > 0 ? 'inv-in' : 'inv-out') + '">' + (Number(r.qty) > 0 ? '+' : '−') + invQty(Math.abs(r.qty)) + '</td>' +
          '<td class="num">' + invQty(r.balance_after) + '</td><td class="num">' + invMoney(r.unit_cost) + '</td><td class="num">' + invMoney(r.value) + '</td>' +
          '<td>' + escapeHtml(invProfileNames.get(r.created_by) || '') + '</td></tr>').join('') + '</tbody>';
    }catch(e){ hist.innerHTML = '<tbody><tr><td>Couldn\u2019t load history: ' + escapeHtml(describeCloudError(e)) + '</td></tr></tbody>'; }
  }
  $('invItemBack').addEventListener('click', ()=>{ invStockView('list'); invRenderStock(); });
  $('invItemCards').addEventListener('click', async (e)=>{
    const b = e.target.closest('[data-adjust]'); if(!b || !invItemOpen) return;
    const w = invWh(b.dataset.adjust), m = invItemOpen;
    const bal = invBalances.find(x=> x.material_id === m.id && x.warehouse_id === w.id);
    const cur = bal ? Number(bal.qty_on_hand) : 0;
    const raw = await uiPrompt('Physical count of ' + m.name + ' in ' + w.code + '\n\nSystem shows ' + invQty(cur) + ' ' + m.unit + '. Enter the actual quantity counted:', String(cur));
    if(raw === null) return;
    const counted = spParseMoney(raw);
    if(counted == null || Number.isNaN(counted)){ toast('Enter a number'); return; }
    const diff = Math.round((counted - cur) * 1000) / 1000;
    if(diff === 0){ toast('No change — count matches'); return; }
    const reason = await uiPrompt('Reason for the ' + (diff > 0 ? '+' : '−') + invQty(Math.abs(diff)) + ' ' + m.unit + ' adjustment (e.g. recount, damaged, found):');
    if(reason === null) return;
    if(!reason.trim()){ toast('A reason is required'); return; }
    if(!(await purchEnsureSession())) return;
    try{
      const { error } = await db.from('stock_movements').insert({ doc_type:'adjustment', doc_ref:'Count ' + poToday(), warehouse_id: w.id, material_id: m.id, qty: diff, note: reason.trim() });
      if(error) throw error;
      toast('Adjusted ' + m.code + ' in ' + w.code + ' to ' + invQty(counted) + ' ' + m.unit);
      await invLoadStock({ silent:true });
      await invRenderItem();
    }catch(err){ purchFail('Couldn\u2019t post the adjustment: ', err); }
  });

  // ---------- opening balance ----------
  let invOpLines = [], invOpKey = 0;
  function invOpBlank(){ return { key: ++invOpKey, material_id:null, code:'', description:'', unit:'', qty:'', unit_cost:'' }; }
  $('invOpeningBtn').addEventListener('click', async ()=>{
    if(!invWarehouses.filter(w=> w.is_active).length){ toast('Add a warehouse first'); return; }
    $('invOpWh').innerHTML = invWarehouses.filter(w=> w.is_active).map(w=> '<option value="' + escapeHtml(w.id) + '">' + escapeHtml(w.code + ' · ' + w.name) + '</option>').join('');
    if($('invStockWh').value && invWh($('invStockWh').value) && invWh($('invStockWh').value).is_active) $('invOpWh').value = $('invStockWh').value;
    $('invOpNote').value = '';
    invOpLines = [invOpBlank()];
    invRenderOpLines();
    invStockView('opening');
  });
  $('invOpeningBack').addEventListener('click', async ()=>{
    if(invOpLines.some(l=> l.material_id) && !await uiConfirm('Discard this opening balance?')) return;
    invStockView('list'); invRenderStock();
  });
  function invRenderOpLines(){
    $('invOpItems').innerHTML = invOpLines.map((l, i)=>{
      const val = poRound2((Number(l.qty) || 0) * (Number(l.unit_cost) || 0));
      return '<div class="po-item inv-op-item" data-key="' + l.key + '"><div class="po-no">' + (i + 1) + '</div>' +
        '<div class="po-item-desc"><input type="text" data-f="description" value="' + escapeHtml(l.description) + '" placeholder="Search the materials list…" autocomplete="off">' +
        '<div class="po-item-code">' + (l.material_id ? escapeHtml(l.code) : (l.description ? 'pick an item from the list' : '')) + '</div></div>' +
        '<input type="text" class="num po-qty" data-f="qty" inputmode="decimal" placeholder="Qty" value="' + escapeHtml(String(l.qty)) + '">' +
        '<input type="text" class="po-unit" value="' + escapeHtml(l.unit) + '" disabled placeholder="Unit">' +
        '<input type="text" class="num po-price" data-f="unit_cost" inputmode="decimal" placeholder="Unit cost" value="' + escapeHtml(String(l.unit_cost)) + '">' +
        '<div class="po-amt">' + invMoney(val) + '</div>' +
        '<button type="button" class="po-rm" data-rm="1" title="Remove">&minus;</button></div>';
    }).join('');
    invOpTotal();
  }
  function invOpTotal(){
    const t = invOpLines.reduce((a, l)=> a + poRound2((Number(l.qty) || 0) * (Number(l.unit_cost) || 0)), 0);
    const n = invOpLines.filter(l=> l.material_id).length;
    $('invOpTotal').textContent = n ? n + ' item' + (n === 1 ? '' : 's') + ' · total value ' + invMoney(t) : '';
  }
  function invOpLine(el){ const r = el.closest('.po-item'); return r ? invOpLines.find(x=> String(x.key) === r.dataset.key) : null; }
  $('invOpItems').addEventListener('input', (e)=>{
    const l = invOpLine(e.target), f = e.target.dataset.f; if(!l || !f) return;
    if(f === 'description'){
      l.description = e.target.value;
      if(l.material_id){ const m = mtCache.find(x=> x.id === l.material_id); if(!m || m.name !== l.description){ l.material_id = null; l.code = ''; l.unit = ''; } }
      mrCatalog = mtCache.filter(m=> m.isActive);
      mrSuggest(e.target, (mid)=>{
        const m = mtCache.find(x=> x.id === mid); if(!m) return;
        if(invOpLines.some(x=> x !== l && x.material_id === m.id)){ toast(m.code + ' is already on this list'); return; }
        Object.assign(l, { material_id:m.id, code:m.code, description:m.name, unit:m.unit, unit_cost: m.standardCost != null ? m.standardCost : '' });
        invRenderOpLines();
        const q = $('invOpItems').querySelector('.po-item[data-key="' + l.key + '"] [data-f="qty"]'); if(q) q.focus();
      });
    }else{
      l[f] = e.target.value.trim();
      const row = e.target.closest('.po-item');
      row.querySelector('.po-amt').textContent = invMoney(poRound2((Number(l.qty) || 0) * (Number(l.unit_cost) || 0)));
      invOpTotal();
    }
  });
  $('invOpItems').addEventListener('click', (e)=>{
    if(!e.target.closest('[data-rm]')) return;
    const l = invOpLine(e.target);
    invOpLines = invOpLines.filter(x=> x !== l);
    if(!invOpLines.length) invOpLines.push(invOpBlank());
    invRenderOpLines();
  });
  // keyboard: ↑/↓ to move through suggestions, Enter to pick, Esc to close
  $('invOpItems').addEventListener('keydown', (e)=>{
    const box = e.target.closest('.po-item-desc') && e.target.closest('.po-item-desc').querySelector('.po-suggest');
    if(!box) return;
    const btns = Array.from(box.querySelectorAll('[data-pick]'));
    let i = btns.findIndex(b=> b.classList.contains('hl'));
    if(e.key === 'ArrowDown' || e.key === 'ArrowUp'){ e.preventDefault(); if(i >= 0) btns[i].classList.remove('hl'); i = e.key === 'ArrowDown' ? Math.min(btns.length - 1, i + 1) : Math.max(0, i - 1); if(btns[i]) btns[i].classList.add('hl'); }
    else if(e.key === 'Enter' && i >= 0){ e.preventDefault(); btns[i].click(); }
    else if(e.key === 'Escape') box.remove();
  });
  $('invOpItems').addEventListener('focusout', (e)=>{
    setTimeout(()=>{ const d = e.target.closest && e.target.closest('.po-item-desc'); if(d && !d.contains(document.activeElement)){ const b = d.querySelector('.po-suggest'); if(b) b.remove(); } }, 180);
  });
  $('invOpAdd').addEventListener('click', ()=>{
    invOpLines.push(invOpBlank()); invRenderOpLines();
    const all = $('invOpItems').querySelectorAll('[data-f="description"]'); if(all.length) all[all.length - 1].focus();
  });
  $('invOpImport').addEventListener('click', ()=>{ $('invOpFile').value = ''; $('invOpFile').click(); });
  $('invOpFile').addEventListener('change', async ()=>{
    const f = $('invOpFile').files && $('invOpFile').files[0]; if(!f) return;
    const rows = spParseCsv(await f.text());
    if(rows.length < 2){ toast('The CSV has no data rows'); return; }
    const head = rows[0].map(h=> h.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_'));
    const ci = (k)=> head.indexOf(k);
    if(ci('code') < 0 || ci('qty') < 0){ toast('CSV needs columns: code, qty (and optionally unit_cost)'); return; }
    const skipped = [];
    const lines = [];
    rows.slice(1).forEach((r, i)=>{
      const code = mtNormCode(r[ci('code')]), m = mtCache.find(x=> x.code === code);
      const qty = spParseMoney(r[ci('qty')]);
      const cost = ci('unit_cost') >= 0 && String(r[ci('unit_cost')] || '').trim() !== '' ? spParseMoney(r[ci('unit_cost')]) : (m && m.standardCost != null ? m.standardCost : null);
      if(!m){ skipped.push('row ' + (i + 2) + ': unknown code ' + code); return; }
      if(qty == null || Number.isNaN(qty) || qty <= 0){ skipped.push('row ' + (i + 2) + ': bad qty'); return; }
      if(cost == null || Number.isNaN(cost)){ skipped.push('row ' + (i + 2) + ': no unit cost'); return; }
      if(lines.some(l=> l.material_id === m.id)){ skipped.push('row ' + (i + 2) + ': ' + code + ' repeated'); return; }
      lines.push({ key: ++invOpKey, material_id:m.id, code:m.code, description:m.name, unit:m.unit, qty, unit_cost:cost });
    });
    invOpLines = lines.length ? lines : [invOpBlank()];
    invRenderOpLines();
    toast('Loaded ' + lines.length + ' item' + (lines.length === 1 ? '' : 's') + (skipped.length ? ' — skipped ' + skipped.length + ': ' + skipped.slice(0, 2).join('; ') : ''));
  });
  $('invOpPost').addEventListener('click', async ()=>{
    const wh = invWh($('invOpWh').value);
    if(!wh){ toast('Choose a warehouse'); return; }
    const lines = invOpLines.filter(l=> l.material_id || String(l.description || '').trim());
    if(!lines.length){ toast('Add at least one item'); return; }
    for(let i = 0; i < lines.length; i++){
      const l = lines[i];
      if(!l.material_id){ toast('Item ' + (i + 1) + ': pick it from the materials list'); return; }
      const q = spParseMoney(l.qty), c = spParseMoney(l.unit_cost);
      if(q == null || Number.isNaN(q) || q <= 0){ toast(l.code + ': enter a quantity above 0'); return; }
      if(c == null || Number.isNaN(c)){ toast(l.code + ': enter the unit cost (0 is allowed)'); return; }
    }
    const total = lines.reduce((a, l)=> a + poRound2(spParseMoney(l.qty) * spParseMoney(l.unit_cost)), 0);
    if(!await uiConfirm('Post opening balance to ' + wh.code + ' · ' + wh.name + '?\n\n' + lines.length + ' item' + (lines.length === 1 ? '' : 's') + ', total value ' + invMoney(total) +
      '\n\nStock movements can\u2019t be edited afterwards — mistakes are corrected with an adjustment.')) return;
    if(!(await purchEnsureSession())) return;
    const btn = $('invOpPost'); btn.disabled = true;
    try{
      const ref = 'Opening ' + poToday();
      const { error } = await db.from('stock_movements').insert(lines.map(l=> ({
        doc_type:'opening', doc_ref: ref, warehouse_id: wh.id, material_id: l.material_id,
        qty: spParseMoney(l.qty), unit_cost: spParseMoney(l.unit_cost), note: $('invOpNote').value.trim()
      })));
      if(error) throw error;
      toast('Opening balance posted to ' + wh.code);
      invOpLines = [];
      await invShowStock();
    }catch(e){ purchFail('Couldn\u2019t post the opening balance: ', e); }
    finally{ btn.disabled = false; }
  });

  // =====================================================================
  // WAREHOUSES (admin)
  // =====================================================================
  async function invShowWarehouses(opts){
    const list = $('invWhList');
    if(!(opts && opts.silent)) list.innerHTML = '<div class="empty-state">Loading…</div>';
    if(!(await ensureCloud())){ list.innerHTML = '<div class="empty-state">Not connected.</div>'; return; }
    try{
      const [, k, b] = await Promise.all([invLoadWarehouses(), db.from('warehouse_storekeepers').select('*'), db.from('stock_balances').select('warehouse_id, qty_on_hand, avg_cost')]);
      if(k.error) throw k.error; if(b.error) throw b.error;
      await invLoadNames((k.data || []).map(x=> x.user_id));
      if(!invWarehouses.length){ list.innerHTML = '<div class="empty-state">No warehouses yet. Tap <b>+ Add Warehouse</b>.</div>'; return; }
      list.innerHTML = invWarehouses.map(w=>{
        const keepers = (k.data || []).filter(x=> x.warehouse_id === w.id).map(x=> invProfileNames.get(x.user_id) || 'Staff');
        const bs = (b.data || []).filter(x=> x.warehouse_id === w.id && Number(x.qty_on_hand) > 0);
        const val = bs.reduce((a, x)=> a + Number(x.qty_on_hand) * Number(x.avg_cost), 0);
        return '<div class="sp-row' + (w.is_active ? '' : ' inactive') + '" data-id="' + escapeHtml(w.id) + '"' + (w.is_active ? '' : ' style="opacity:.6;"') + '><div class="sp-row-top"><div style="min-width:0;">' +
          '<div class="sp-row-title"><span class="mt-code">' + escapeHtml(w.code) + '</span> ' + escapeHtml(w.name) + (w.is_active ? '' : ' <span class="sp-tag danger">Inactive</span>') + '</div>' +
          '<div class="sp-row-sub">' + escapeHtml(w.address || 'No address') + '</div>' +
          '<div class="sp-row-sub">Storekeeper' + (keepers.length === 1 ? '' : 's') + ': ' + (keepers.length ? escapeHtml(keepers.join(', ')) : '<span style="color:#9A6212;">none assigned</span>') + '</div></div>' +
          '<div class="mt-row-price">' + invMoney(val) + '<div class="sp-row-sub">' + bs.length + ' item' + (bs.length === 1 ? '' : 's') + ' in stock</div></div></div>' +
          '<div class="user-card-actions"><button type="button" class="primary" data-wh-edit="1">Edit</button></div></div>';
      }).join('');
    }catch(e){
      list.innerHTML = '<div class="empty-state">' + (purchIsAuthError(e) ? PURCH_EXPIRED_HTML : invMissingTables(e) ? INV_MIGRATION_MSG : 'Couldn\u2019t load warehouses: ' + escapeHtml(describeCloudError(e))) + '</div>';
    }
  }
  function invWhOpenForm(w){
    $('invWhForm').style.display = '';
    $('invWhFormTitle').textContent = w ? 'Edit ' + w.code : 'New Warehouse';
    $('invWhId').value = w ? w.id : '';
    $('invWhCode').value = w ? w.code : 'WH-' + String(invWarehouses.length + 1).padStart(2, '0');
    $('invWhName').value = w ? w.name : '';
    $('invWhAddress').value = w ? w.address : '';
    $('invWhActive').value = w ? String(w.is_active) : 'true';
    $('invWhName').focus();
  }
  $('invWhAddBtn').addEventListener('click', ()=> invWhOpenForm(null));
  $('invWhCancel').addEventListener('click', ()=>{ $('invWhForm').style.display = 'none'; });
  $('invWhList').addEventListener('click', (e)=>{
    if(e.target.closest('[data-purch-reauth]')){ purchReauth().then(ok=>{ if(ok) invShowWarehouses(); }); return; }
    if(!e.target.closest('[data-wh-edit]')) return;
    invWhOpenForm(invWh(e.target.closest('.sp-row').dataset.id));
    window.scrollTo({ top:0 });
  });
  $('invWhSave').addEventListener('click', async ()=>{
    const id = $('invWhId').value;
    const row = { code: mtNormCode($('invWhCode').value), name: $('invWhName').value.trim(), address: $('invWhAddress').value.trim(), is_active: $('invWhActive').value === 'true' };
    if(!row.code){ toast('Enter a code, e.g. WH-01'); return; }
    if(!row.name){ toast('Enter the warehouse name'); return; }
    if(invWarehouses.some(w=> w.code === row.code && w.id !== id)){ toast('Code ' + row.code + ' is already used'); return; }
    if(!(await purchEnsureSession())) return;
    try{
      const res = id ? await db.from('warehouses').update(row).eq('id', id) : await db.from('warehouses').insert(row);
      if(res.error) throw res.error;
      toast(id ? 'Warehouse updated' : row.code + ' added');
      $('invWhForm').style.display = 'none';
      invShowWarehouses();
    }catch(e){ purchFail('Couldn\u2019t save the warehouse: ', e); }
  });

  // =====================================================================
  // PROJECTS (admin)
  // =====================================================================
  let invProjects = [], invPrjLinks = [], invPrjOpen = null, invJobsAll = [];
  function invPrjView(which){
    $('invPrjListView').style.display = which === 'list' ? '' : 'none';
    $('invPrjEditView').style.display = which === 'edit' ? '' : 'none';
    $('purchasingView').classList.toggle('po-wide', which === 'edit');
    if(which === 'list') invPrjOpen = null;
    window.scrollTo({ top:0 });
  }
  // Material cost per project: issues minus returns (and write-offs), for
  // the project itself or any of its job orders. Movement values are
  // negative when stock goes out, so cost = −sum(value).
  function invProjectCost(p, moves){
    const jobs = new Set(invPrjLinks.filter(l=> l.project_id === p.id).map(l=> l.job_order_id));
    return moves.filter(m=> m.project_id === p.id || (m.job_order_id && jobs.has(m.job_order_id)))
      .reduce((a, m)=> a - Number(m.value || 0), 0);
  }
  let invPrjMoves = [];
  async function invShowProjects(opts){
    if(!(opts && opts.keepView)) invPrjView('list');
    const list = $('invPrjList');
    if(!(opts && opts.silent)) list.innerHTML = '<div class="empty-state">Loading…</div>';
    if(!(await ensureCloud())){ list.innerHTML = '<div class="empty-state">Not connected.</div>'; return; }
    try{
      const [p, l, mv] = await Promise.all([
        db.from('projects').select('*').order('created_at', { ascending:false }),
        db.from('project_job_orders').select('*'),
        db.from('stock_movements').select('project_id, job_order_id, value, doc_type').in('doc_type', ['issue', 'return', 'write_off'])
      ]);
      if(p.error) throw p.error; if(l.error) throw l.error; if(mv.error) throw mv.error;
      invProjects = p.data || []; invPrjLinks = l.data || []; invPrjMoves = mv.data || [];
      invRenderProjects();
    }catch(e){
      list.innerHTML = '<div class="empty-state">' + (purchIsAuthError(e) ? PURCH_EXPIRED_HTML : invMissingTables(e) ? INV_MIGRATION_MSG : 'Couldn\u2019t load projects: ' + escapeHtml(describeCloudError(e))) + '</div>';
    }
  }
  function invRenderProjects(){
    const st = $('invPrjStatus').value, q = ($('invPrjSearch').value || '').trim().toLowerCase();
    const rows = invProjects.filter(p=> (st === 'open' ? ['planning', 'active', 'on_hold'].includes(p.status) : !st || p.status === st) &&
      (!q || [p.project_no, p.name, p.customer_name, p.site_address].join(' ').toLowerCase().includes(q)));
    const active = invProjects.filter(p=> p.status === 'active').length;
    $('invPrjCount').textContent = active ? active + ' active' : '';
    const list = $('invPrjList');
    if(!rows.length){ list.innerHTML = '<div class="empty-state">' + (invProjects.length ? 'Nothing matches.' : 'No projects yet. Tap <b>+ New Project</b>.') + '</div>'; return; }
    list.innerHTML = rows.map(p=>{
      const jobs = invPrjLinks.filter(l=> l.project_id === p.id).length;
      const cost = invProjectCost(p, invPrjMoves);
      const pct = p.budget ? Math.round(cost / Number(p.budget) * 100) : null;
      return '<button type="button" class="mt-row' + (p.status === 'cancelled' ? ' inactive' : '') + '" data-id="' + escapeHtml(p.id) + '"><div class="mt-row-main">' +
        '<div class="mt-row-title"><span class="mt-code">' + escapeHtml(p.project_no) + '</span>' + escapeHtml(p.name) + ' <span class="po-status ' + (p.status === 'active' ? 'approved' : p.status === 'completed' ? 'fulfilled' : p.status === 'cancelled' ? 'rejected' : 'draft') + '">' + escapeHtml(INV_PRJ_STATUS[p.status]) + '</span></div>' +
        '<div class="sp-row-sub">' + escapeHtml([p.customer_name, p.site_address].filter(Boolean).join(' · ') || 'No customer set') + ' · ' + jobs + ' job order' + (jobs === 1 ? '' : 's') + '</div></div>' +
        '<div class="mt-row-price">' + invMoney(cost) + '<div class="sp-row-sub">' + (p.budget ? pct + '% of ' + invMoney(p.budget) : 'material cost') + '</div></div></button>';
    }).join('');
  }
  $('invPrjSearch').addEventListener('input', invRenderProjects);
  $('invPrjStatus').addEventListener('change', invRenderProjects);
  $('invPrjList').addEventListener('click', (e)=>{
    if(e.target.closest('[data-purch-reauth]')){ purchReauth().then(ok=>{ if(ok) invShowProjects(); }); return; }
    const r = e.target.closest('.mt-row'); if(r) invOpenProject(invProjects.find(p=> p.id === r.dataset.id));
  });
  $('invPrjAddBtn').addEventListener('click', ()=> invOpenProject(null));
  $('invPrjBack').addEventListener('click', ()=>{ invPrjView('list'); invRenderProjects(); });

  async function invOpenProject(p){
    invPrjOpen = p;
    $('invPrjTitle').textContent = p ? p.project_no : 'New Project';
    $('invPrjStatusPill').className = 'po-status ' + (p ? (p.status === 'active' ? 'approved' : p.status === 'completed' ? 'fulfilled' : p.status === 'cancelled' ? 'rejected' : 'draft') : 'draft');
    $('invPrjStatusPill').textContent = p ? INV_PRJ_STATUS[p.status] : 'unsaved';
    $('invPrjName').value = p ? p.name : ''; $('invPrjCustomer').value = p ? p.customer_name : '';
    $('invPrjSite').value = p ? p.site_address : ''; $('invPrjBudget').value = p && p.budget != null ? String(p.budget) : '';
    $('invPrjStart').value = p && p.start_date ? p.start_date : ''; $('invPrjEnd').value = p && p.end_date ? p.end_date : '';
    $('invPrjStatusSel').value = p ? p.status : 'active'; $('invPrjNotes').value = p ? p.notes : '';
    $('invPrjJobsSec').style.display = p ? '' : 'none';
    $('invPrjCostSec').style.display = p ? '' : 'none';
    invPrjView('edit');
    invPrjOpen = p;
    if(p){ invRenderPrjCost(); await invRenderPrjJobs(); }
  }
  function invRenderPrjCost(){
    const p = invPrjOpen; if(!p) return;
    const cost = invProjectCost(p, invPrjMoves);
    const budget = p.budget != null ? Number(p.budget) : null;
    const pct = budget ? cost / budget * 100 : 0;
    $('invPrjCost').innerHTML = '<div class="inv-summary">' +
      '<div class="tile"><div class="k">Materials issued (net of returns)</div><div class="v">' + invMoney(cost) + '</div></div>' +
      (budget != null ? '<div class="tile"><div class="k">Budget</div><div class="v">' + invMoney(budget) + '</div></div>' +
        '<div class="tile"><div class="k">Remaining</div><div class="v" style="color:' + (budget - cost < 0 ? 'var(--danger)' : 'var(--green-dark)') + ';">' + invMoney(budget - cost) + '</div></div>' : '') + '</div>' +
      (budget ? '<div class="inv-budget-bar' + (pct >= 100 ? ' over' : pct >= 80 ? ' warn' : '') + '"><span style="width:' + Math.min(100, pct).toFixed(1) + '%"></span></div><div class="po-hint">' + pct.toFixed(1) + '% of budget used</div>' : '') +
      (cost === 0 ? '<div class="po-hint">No materials issued yet. Issue slips (next phase) will add up here automatically — for the project and all its job orders.</div>' : '');
  }
  async function invRenderPrjJobs(){
    const p = invPrjOpen; if(!p) return;
    if(!invJobsAll.length && typeof dtListAll === 'function'){ try{ invJobsAll = await dtListAll(); }catch(e){ invJobsAll = []; } }
    const mine = invPrjLinks.filter(l=> l.project_id === p.id);
    const jobInfo = (id)=> invJobsAll.find(j=> j.id === id);
    $('invPrjJobs').innerHTML = mine.length ? mine.map(l=>{
      const j = jobInfo(l.job_order_id);
      return '<div class="sp-row" data-jo="' + escapeHtml(l.job_order_id) + '"><div class="sp-row-top"><div><div class="sp-row-title">' + escapeHtml(l.job_order_id) + '</div>' +
        '<div class="sp-row-sub">' + escapeHtml(j ? [j.custName, j.siteAddress].filter(Boolean).join(' · ') : '') + '</div></div>' +
        '<div class="user-card-actions" style="margin:0;"><button type="button" class="danger" data-jo-rm="1">Remove</button></div></div></div>';
    }).join('') : '<div class="empty-state" style="padding:12px;">No job orders linked yet.</div>';
    const taken = new Set(invPrjLinks.map(l=> l.job_order_id));
    const free = invJobsAll.filter(j=> !taken.has(j.id)).slice(0, 300);
    $('invPrjJobPick').innerHTML = '<option value="">' + (free.length ? 'Choose a job order to add…' : 'No unlinked job orders') + '</option>' +
      free.map(j=> '<option value="' + escapeHtml(j.id) + '">' + escapeHtml(j.id + (j.custName ? ' — ' + j.custName : '')) + '</option>').join('');
  }
  $('invPrjJobAdd').addEventListener('click', async ()=>{
    const jo = $('invPrjJobPick').value; if(!jo || !invPrjOpen) return;
    if(!(await purchEnsureSession())) return;
    try{
      const { error } = await db.from('project_job_orders').insert({ project_id: invPrjOpen.id, job_order_id: jo });
      if(error) throw error;
      invPrjLinks.push({ project_id: invPrjOpen.id, job_order_id: jo });
      toast(jo + ' added to ' + invPrjOpen.project_no);
      invRenderPrjJobs(); invRenderPrjCost();
    }catch(e){ purchFail(/23505/.test(describeCloudError(e)) ? 'That job order is already in another project: ' : 'Couldn\u2019t add the job order: ', e); }
  });
  $('invPrjJobs').addEventListener('click', async (e)=>{
    if(!e.target.closest('[data-jo-rm]') || !invPrjOpen) return;
    const jo = e.target.closest('[data-jo]').dataset.jo;
    if(!await uiConfirm('Remove ' + jo + ' from ' + invPrjOpen.project_no + '? Its material cost will no longer count toward this project.')) return;
    try{
      const { error } = await db.from('project_job_orders').delete().eq('project_id', invPrjOpen.id).eq('job_order_id', jo);
      if(error) throw error;
      invPrjLinks = invPrjLinks.filter(l=> !(l.project_id === invPrjOpen.id && l.job_order_id === jo));
      invRenderPrjJobs(); invRenderPrjCost();
    }catch(err){ purchFail('Couldn\u2019t remove it: ', err); }
  });
  $('invPrjSave').addEventListener('click', async ()=>{
    const budget = spParseMoney($('invPrjBudget').value);
    if(Number.isNaN(budget)){ toast('Budget must be a number'); return; }
    const row = { name: $('invPrjName').value.trim(), customer_name: $('invPrjCustomer').value.trim(), site_address: $('invPrjSite').value.trim(),
      budget, start_date: $('invPrjStart').value || null, end_date: $('invPrjEnd').value || null, status: $('invPrjStatusSel').value, notes: $('invPrjNotes').value.trim() };
    if(!row.name){ toast('Enter the project name'); $('invPrjName').focus(); return; }
    if(row.start_date && row.end_date && row.end_date < row.start_date){ toast('Target end is before the start'); return; }
    if(!(await purchEnsureSession())) return;
    const btn = $('invPrjSave'); btn.disabled = true;
    try{
      const res = invPrjOpen ? await db.from('projects').update(row).eq('id', invPrjOpen.id).select('*').single()
                             : await db.from('projects').insert(row).select('*').single();
      if(res.error) throw res.error;
      const saved = res.data, wasNew = !invPrjOpen;
      const i = invProjects.findIndex(p=> p.id === saved.id);
      if(i >= 0) invProjects[i] = saved; else invProjects.unshift(saved);
      toast(wasNew ? saved.project_no + ' created — add its job orders below' : 'Project saved');
      await invOpenProject(saved);
    }catch(e){ purchFail('Couldn\u2019t save the project: ', e); }
    finally{ btn.disabled = false; }
  });

  // =====================================================================
  // STOREKEEPER: Warehouse Stock (quantities only)
  // =====================================================================
  let invMyWh = [], invMyStock = [], invMyMats = [];
  let invSkCheckedAt = 0, invSkIs = false;
  // Show the home tile only to staff with at least one warehouse assigned.
  async function invRefreshStorekeeperTile(){
    const tile = document.getElementById('techQaStock');
    if(!tile || !currentUser || currentUser.role === 'admin' || currentUser.role === 'customer'){ if(tile) tile.style.display = 'none'; return; }
    if(Date.now() - invSkCheckedAt < 60000){ tile.style.display = invSkIs ? '' : 'none'; return; }
    try{
      if(!(await ensureCloud())) return;
      const { data, error } = await db.from('warehouse_storekeepers').select('warehouse_id').eq('user_id', currentUser.id);
      if(error) throw error;
      invSkIs = !!(data && data.length); invSkCheckedAt = Date.now();
    }catch(e){ invSkIs = false; }
    tile.style.display = invSkIs ? '' : 'none';
  }
  async function invShowMyStock(){
    $('invMyItemView').style.display = 'none'; $('invMyListView').style.display = '';
    const list = $('invMyList');
    list.innerHTML = '<div class="empty-state">Loading…</div>';
    if(!(await ensureCloud())){ list.innerHTML = '<div class="empty-state">Not connected.</div>'; return; }
    try{
      const k = await db.from('warehouse_storekeepers').select('warehouse_id').eq('user_id', currentUser.id);
      if(k.error) throw k.error;
      const ids = (k.data || []).map(x=> x.warehouse_id);
      if(!ids.length){ list.innerHTML = '<div class="empty-state">You aren\u2019t assigned to a warehouse. Ask the admin to set you as a Storekeeper in Users &amp; Roles.</div>'; return; }
      const [w, s, m] = await Promise.all([
        db.from('warehouses').select('*').in('id', ids).order('code'),
        db.from('stock_on_hand_qty').select('*').in('warehouse_id', ids),
        db.from('materials').select('id, code, name, unit, category, family, specs, brand').eq('is_active', true)
      ]);
      if(w.error) throw w.error; if(s.error) throw s.error; if(m.error) throw m.error;
      invMyWh = w.data || []; invMyStock = s.data || []; invMyMats = m.data || [];
      const sel = $('invMyWh'), keep = sel.value;
      sel.innerHTML = invMyWh.map(x=> '<option value="' + escapeHtml(x.id) + '">' + escapeHtml(x.code + ' · ' + x.name) + '</option>').join('');
      if(keep && invMyWh.some(x=> x.id === keep)) sel.value = keep;
      sel.style.display = invMyWh.length > 1 ? '' : 'none';
      invRenderMyStock();
    }catch(e){
      list.innerHTML = '<div class="empty-state">' + (purchIsAuthError(e) ? PURCH_EXPIRED_HTML : invMissingTables(e) ? 'Inventory isn\u2019t set up yet.' : 'Couldn\u2019t load stock: ' + escapeHtml(describeCloudError(e))) + '</div>';
    }
  }
  function invRenderMyStock(){
    const wh = $('invMyWh').value || (invMyWh[0] && invMyWh[0].id);
    const words = ($('invMySearch').value || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
    const rows = invMyStock.filter(s=> s.warehouse_id === wh && Number(s.qty_on_hand) > 0).map(s=> ({ s, m: invMyMats.find(x=> x.id === s.material_id) }))
      .filter(r=> r.m && (!words.length || words.every(w=> [r.m.code, r.m.name, r.m.family].join(' ').toLowerCase().includes(w))))
      .sort((a, b)=> a.m.name.localeCompare(b.m.name, undefined, { numeric:true }));
    $('invMyList').innerHTML = rows.length ? rows.map(({ s, m })=>
      '<button type="button" class="mt-row" data-id="' + escapeHtml(m.id) + '"><div class="mt-row-main"><div class="mt-row-title"><span class="mt-code">' + escapeHtml(m.code) + '</span>' + escapeHtml(m.name) + '</div>' +
      '<div class="sp-row-sub">' + escapeHtml(m.category) + '</div></div><div class="mt-row-price"><span class="inv-qty">' + invQty(s.qty_on_hand) + ' ' + escapeHtml(m.unit) + '</span></div></button>').join('')
      : '<div class="empty-state">' + (invMyStock.some(s=> s.warehouse_id === wh) ? 'Nothing matches.' : 'No stock recorded in this warehouse yet.') + '</div>';
  }
  $('invMySearch').addEventListener('input', invRenderMyStock);
  $('invMyWh').addEventListener('change', invRenderMyStock);
  $('invMyList').addEventListener('click', async (e)=>{
    if(e.target.closest('[data-purch-reauth]')){ purchReauth().then(ok=>{ if(ok) invShowMyStock(); }); return; }
    const r = e.target.closest('.mt-row'); if(!r) return;
    const m = invMyMats.find(x=> x.id === r.dataset.id), wh = $('invMyWh').value || invMyWh[0].id;
    $('invMyItemTitle').innerHTML = '<span class="mt-code">' + escapeHtml(m.code) + '</span> ' + escapeHtml(m.name);
    $('invMyListView').style.display = 'none'; $('invMyItemView').style.display = '';
    const t = $('invMyItemHistory');
    t.innerHTML = '<tbody><tr><td>Loading…</td></tr></tbody>';
    try{
      const { data, error } = await db.from('stock_movements_qty').select('*').eq('material_id', m.id).eq('warehouse_id', wh).order('created_at', { ascending:false }).limit(200);
      if(error) throw error;
      t.innerHTML = (data || []).length ? '<thead><tr><th>When</th><th>Type</th><th>Reference</th><th class="num">Qty</th><th class="num">Balance</th></tr></thead><tbody>' +
        data.map(x=> '<tr><td>' + escapeHtml(mrWhen(x.created_at)) + '</td><td>' + escapeHtml(INV_TYPE_LABEL[x.doc_type] || x.doc_type) + '</td><td>' + escapeHtml([x.doc_ref, x.note].filter(Boolean).join(' — ')) + '</td>' +
          '<td class="num ' + (Number(x.qty) > 0 ? 'inv-in' : 'inv-out') + '">' + (Number(x.qty) > 0 ? '+' : '−') + invQty(Math.abs(x.qty)) + '</td><td class="num">' + invQty(x.balance_after) + '</td></tr>').join('') + '</tbody>'
        : '<tbody><tr><td>No movements yet.</td></tr></tbody>';
    }catch(err){ t.innerHTML = '<tbody><tr><td>Couldn\u2019t load history.</td></tr></tbody>'; }
  });
  $('invMyItemBack').addEventListener('click', ()=>{ $('invMyItemView').style.display = 'none'; $('invMyListView').style.display = ''; });
  $('techQaStock').addEventListener('click', ()=> showPurchasingView('myStock'));

  // =====================================================================
  // USERS & ROLES hooks — the Storekeeper setting (called from admin.js)
  // =====================================================================
  // Returns null when the inventory tables aren't installed yet, so Users &
  // Roles keeps working exactly as before.
  async function invLoadUsersContext(){
    try{
      const [w, k] = await Promise.all([db.from('warehouses').select('id, code, name, is_active').order('code'), db.from('warehouse_storekeepers').select('*')]);
      if(w.error || k.error) return null;
      const byUser = new Map();
      (k.data || []).forEach(x=>{ if(!byUser.has(x.user_id)) byUser.set(x.user_id, new Set()); byUser.get(x.user_id).add(x.warehouse_id); });
      return { warehouses: w.data || [], byUser };
    }catch(e){ return null; }
  }
  function invUserStatusLine(ctx, userId){
    if(!ctx) return '';
    const mine = ctx.byUser.get(userId);
    if(!mine || !mine.size) return '';
    return '<div class="u-status" style="color:var(--green-dark); font-weight:700;">Storekeeper: ' +
      escapeHtml(ctx.warehouses.filter(w=> mine.has(w.id)).map(w=> w.code).join(', ')) + '</div>';
  }
  function invUserPanelHtml(ctx, userId){
    if(!ctx) return '';
    const mine = ctx.byUser.get(userId) || new Set();
    const body = ctx.warehouses.length ? ctx.warehouses.filter(w=> w.is_active || mine.has(w.id)).map(w=>
      '<label class="restrict-row"><input type="checkbox" data-inv-wh="' + escapeHtml(w.id) + '"' + (mine.has(w.id) ? ' checked' : '') + '>' +
      '<span class="rtxt"><span class="rt-title">' + escapeHtml(w.code + ' · ' + w.name) + '</span></span></label>').join('')
      : '<div style="padding:6px 0; font-size:11.5px; color:var(--text-muted);">Add a warehouse first in <b>Inventory › Warehouses</b>.</div>';
    return '<div class="restrict-group inv-sk-group"><h5>Storekeeper</h5>' +
      '<div style="margin:-2px 0 6px; font-size:11.5px; color:var(--text-muted); line-height:1.4;">Tick the warehouses this person keeps. They\u2019ll see those warehouses\u2019 stock (quantities only — no costs) and, in the next phase, issue and receive for them.</div>' + body + '</div>';
  }
  function invUserPanelReset(ctx, userId, panel){
    if(!ctx) return;
    const mine = ctx.byUser.get(userId) || new Set();
    panel.querySelectorAll('[data-inv-wh]').forEach(c=>{ c.checked = mine.has(c.dataset.invWh); });
  }
  async function invSaveUserWarehouses(ctx, userId, panel){
    if(!ctx) return true;
    const want = new Set(Array.from(panel.querySelectorAll('[data-inv-wh]')).filter(c=> c.checked).map(c=> c.dataset.invWh));
    const have = ctx.byUser.get(userId) || new Set();
    const add = Array.from(want).filter(id=> !have.has(id)), del = Array.from(have).filter(id=> !want.has(id));
    try{
      if(add.length){ const r = await db.from('warehouse_storekeepers').insert(add.map(id=> ({ warehouse_id:id, user_id:userId }))); if(r.error) throw r.error; }
      for(const id of del){ const r = await db.from('warehouse_storekeepers').delete().eq('warehouse_id', id).eq('user_id', userId); if(r.error) throw r.error; }
      return true;
    }catch(e){ console.error('storekeeper save failed', describeCloudError(e)); return false; }
  }
