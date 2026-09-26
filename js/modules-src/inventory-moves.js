  // =====================================================================
  // Inventory — Phase 2 screens (migration 20260923_08_inventory_movements.sql)
  //
  //   Receive / Issue / Return / Transfer — admins (sidebar) and
  //   storekeepers (Warehouse Stock hub). Every post is ONE call to an
  //   inv_post_* database function, which validates, costs and writes the
  //   document + ledger atomically. The screens send quantities only.
  //   Slips & History — every document, with PDF.
  //   My Materials — technicians: slips to sign for, and what they hold.
  // =====================================================================

  const INV_SLIP_KIND = {
    rcv: { label:'Receipt', title:'RECEIVING REPORT', table:'stock_receipts', items:'stock_receipt_items', fk:'receipt_id', no:'receipt_no' },
    iss: { label:'Issue', title:'MATERIALS ISSUE SLIP', table:'issue_slips', items:'issue_slip_items', fk:'slip_id', no:'slip_no' },
    ret: { label:'Return', title:'MATERIALS RETURN SLIP', table:'return_slips', items:'return_slip_items', fk:'return_id', no:'return_no' },
    trf: { label:'Transfer', title:'STOCK TRANSFER', table:'stock_transfers', items:'stock_transfer_items', fk:'transfer_id', no:'transfer_no' }
  };
  // isAdmin: Super Admin. allWh: works across every warehouse (admin, or
  // department staff). money: may enter/see peso values (admin, or staff
  // with "See peso values"). direct: may receive straight to a project.
  const invX = { cat:[], catById:new Map(), whs:[], mine:[], avail:new Map(), workers:[], projects:[], jobs:[], isAdmin:false, allWh:false, money:false, direct:false };
  const invAvailKey = (wh, m)=> wh + '|' + m;
  function invAvail(wh, m){ return invX.avail.get(invAvailKey(wh, m)) || 0; }
  function invIsAdmin(){ return !!(currentUser && currentUser.role === 'admin'); }

  // One load of everything the movement screens need. Quantities only —
  // stock_on_hand_qty works the same for admins and storekeepers.
  async function invLoadCtx(){
    invX.isAdmin = invIsAdmin();
    invX.allWh = invX.isAdmin || isStaffUser();
    invX.money = staffSeesCosts();
    invX.direct = invX.isAdmin || (isStaffUser() && can('inv.receive', 'edit'));
    const [cat, whs, keep, av, wk, pr, jobs] = await Promise.all([
      db.from('materials').select('id, code, name, unit, pack_unit, pack_qty, category, family, specs, brand').eq('is_active', true).order('name'),
      db.from('warehouses').select('*').order('code'),
      invX.allWh ? Promise.resolve({ data:null }) : db.from('warehouse_storekeepers').select('warehouse_id').eq('user_id', currentUser.id),
      db.from('stock_on_hand_qty').select('*'),
      db.from('profiles').select('id, name').eq('role', 'technician').eq('active', true).order('name'),
      db.from('projects').select('id, project_no, name, status').in('status', ['planning', 'active', 'on_hold']).order('project_no', { ascending:false }),
      db.rpc('inv_open_job_orders')
    ]);
    for(const r of [cat, whs, av, wk, pr]) if(r.error) throw r.error;
    invX.cat = (cat.data || []).map(m=> Object.assign({}, m, { specs: m.specs || {} }));
    invX.catById = new Map(invX.cat.map(m=> [m.id, m]));
    invX.whs = whs.data || [];
    const keepIds = keep.data ? new Set(keep.data.map(k=> k.warehouse_id)) : null;
    invX.mine = invX.whs.filter(w=> w.is_active && (!keepIds || keepIds.has(w.id)));
    invX.avail = new Map((av.data || []).map(b=> [invAvailKey(b.warehouse_id, b.material_id), Number(b.qty_on_hand)]));
    invX.workers = wk.data || [];
    invX.projects = pr.data || [];
    invX.jobs = jobs.error ? [] : (jobs.data || []);
  }
  function invOpts(list, val, label, empty){
    return (empty != null ? '<option value="">' + escapeHtml(empty) + '</option>' : '') + list.map(x=> '<option value="' + escapeHtml(val(x)) + '">' + escapeHtml(label(x)) + '</option>').join('');
  }
  function invFillCommon(prefix){
    const whOpts = invOpts(invX.mine, w=> w.id, w=> w.code + ' · ' + w.name);
    return whOpts;
  }
  function invFillProjJob(projSel, jobSel){
    $(projSel).innerHTML = invOpts(invX.projects, p=> p.id, p=> p.project_no + ' — ' + p.name, '— none —');
    $(jobSel).innerHTML = invOpts(invX.jobs, j=> j.id, j=> j.id + (j.cust_name ? ' — ' + j.cust_name : ''), '— none —');
  }
  async function invEnter(render){
    const host = $('purchasingView');
    if(!(await ensureCloud())){ toast('Not connected'); return false; }
    try{ await invLoadCtx(); }
    catch(e){
      purchFail(invMissingTables(e) ? 'Run migration 20260923_08_inventory_movements.sql first: ' : 'Couldn\u2019t load inventory: ', e);
      return false;
    }
    if(!invX.mine.length){ toast(invX.allWh ? 'Add an active warehouse first' : 'You aren\u2019t assigned to a warehouse'); return false; }
    host.classList.add('po-wide');
    render();
    return true;
  }
  // storekeeper hub navigation
  $('purchasingView').addEventListener('click', (e)=>{
    const go = e.target.closest('[data-inv-go]');
    if(go){ showPurchasingView(go.dataset.invGo); return; }
    if(e.target.closest('[data-inv-hub]')) showPurchasingView('myStock');
  });

  // ---------------------------------------------------------------------
  // Shared line editor (issue / transfer / receive-without-PO)
  //   lines: {key, material_id, qty, unit_cost, mr_item_id, max, locked}
  // ---------------------------------------------------------------------
  const invLE = {};
  let invLEKey = 0;
  function invLEBlank(){ return { key: ++invLEKey, material_id:null, qty:'', unit_cost:'', mr_item_id:null, max:null, locked:false, text:'' }; }
  function invLERender(id){
    const st = invLE[id], m = (x)=> x.material_id ? invX.catById.get(x.material_id) : null;
    const wh = st.wh ? $(st.wh).value : '';
    const lastCol = st.cost ? 'Unit cost (₱)' : st.avail ? 'On hand' : '';
    $(st.host).innerHTML = '<div class="inv-ln-head"><span>#</span><span>Item</span><span>Qty</span><span>Unit</span><span>' + lastCol + '</span><span></span></div>' +
      st.lines.map((l, i)=>{
        const it = m(l), have = it && wh ? invAvail(wh, it.id) : null;
        const low = st.avail && it && Number(l.qty) > have;
        const last = st.cost ? '<input type="text" class="num" data-f="unit_cost" inputmode="decimal" placeholder="avg" value="' + escapeHtml(String(l.unit_cost)) + '">'
          : st.avail ? '<div class="inv-av' + (low ? ' low' : '') + '">' + (it ? invQty(have) + (low ? ' — short' : '') : '') + '</div>' : '<span></span>';
        return '<div class="inv-ln" data-key="' + l.key + '"><div class="po-no">' + (i + 1) + '</div>' +
          '<div class="po-item-desc"><input type="text" data-f="text" value="' + escapeHtml(it ? it.name : l.text) + '" placeholder="Search item…" autocomplete="off"' + (l.locked ? ' disabled' : '') + '>' +
          '<div class="po-item-code">' + (it ? escapeHtml(it.code) : '') + (l.max != null ? ' · up to ' + invQty(l.max) : '') + '</div></div>' +
          '<input type="text" class="num inv-q" data-f="qty" inputmode="decimal" placeholder="Qty" value="' + escapeHtml(String(l.qty)) + '">' +
          '<div class="inv-unit">' + escapeHtml(it ? it.unit : '') + '</div>' + last +
          (l.locked ? '<span></span>' : '<button type="button" class="po-rm" data-rm="1" title="Remove">&minus;</button>') + '</div>';
      }).join('');
  }
  function invLEBind(id, host, opts){
    invLE[id] = Object.assign({ host, lines:[invLEBlank()] }, opts);
    const el = $(host);
    const lineOf = (t)=>{ const r = t.closest('.inv-ln'); return r ? invLE[id].lines.find(x=> String(x.key) === r.dataset.key) : null; };
    el.addEventListener('input', (e)=>{
      const l = lineOf(e.target), f = e.target.dataset.f; if(!l || !f) return;
      if(f === 'text'){
        l.text = e.target.value; l.material_id = null;
        e.target.closest('.inv-ln').querySelector('.po-item-code').textContent = '';
        mrCatalog = invX.cat;
        mrSuggest(e.target, (mid)=>{
          if(invLE[id].lines.some(x=> x !== l && x.material_id === mid)){ toast('That item is already on the list'); return; }
          l.material_id = mid; l.text = '';
          invLERender(id);
          const q = el.querySelector('.inv-ln[data-key="' + l.key + '"] [data-f="qty"]'); if(q) q.focus();
        });
      }else{
        l[f] = e.target.value.trim();
        if(f === 'qty' && invLE[id].avail) invLEAvailCell(id, l);
      }
    });
    el.addEventListener('keydown', (e)=>{
      const box = e.target.closest('.po-item-desc') && e.target.closest('.po-item-desc').querySelector('.po-suggest');
      if(!box) return;
      const btns = Array.from(box.querySelectorAll('[data-pick]')); let i = btns.findIndex(b=> b.classList.contains('hl'));
      if(e.key === 'ArrowDown' || e.key === 'ArrowUp'){ e.preventDefault(); if(i >= 0) btns[i].classList.remove('hl'); i = e.key === 'ArrowDown' ? Math.min(btns.length - 1, i + 1) : Math.max(0, i - 1); if(btns[i]) btns[i].classList.add('hl'); }
      else if(e.key === 'Enter' && i >= 0){ e.preventDefault(); btns[i].click(); }
      else if(e.key === 'Escape') box.remove();
    });
    el.addEventListener('focusout', (e)=>{ setTimeout(()=>{ const d = e.target.closest && e.target.closest('.po-item-desc'); if(d && !d.contains(document.activeElement)){ const b = d.querySelector('.po-suggest'); if(b) b.remove(); } }, 180); });
    el.addEventListener('click', (e)=>{
      if(!e.target.closest('[data-rm]')) return;
      const l = lineOf(e.target); invLE[id].lines = invLE[id].lines.filter(x=> x !== l);
      if(!invLE[id].lines.length) invLE[id].lines.push(invLEBlank());
      invLERender(id);
    });
  }
  function invLEAvailCell(id, l){
    const st = invLE[id], it = invX.catById.get(l.material_id), row = $(st.host).querySelector('.inv-ln[data-key="' + l.key + '"] .inv-av');
    if(!row || !it) return;
    const have = invAvail($(st.wh).value, it.id), low = Number(l.qty) > have;
    row.className = 'inv-av' + (low ? ' low' : ''); row.textContent = invQty(have) + (low ? ' — short' : '');
  }
  // validated payload lines, or a message
  function invLECollect(id, needCostIgnored){
    const out = [];
    const lines = invLE[id].lines.filter(l=> l.material_id || String(l.text || '').trim() || String(l.qty).trim());
    for(let i = 0; i < lines.length; i++){
      const l = lines[i];
      if(!l.material_id) return 'Line ' + (i + 1) + ': pick the item from the list';
      const q = spParseMoney(l.qty);
      if(q == null || Number.isNaN(q) || q <= 0) return invX.catById.get(l.material_id).code + ': enter a quantity above 0';
      if(l.max != null && q > l.max) return invX.catById.get(l.material_id).code + ': at most ' + invQty(l.max) + ' on this request';
      const row = { material_id: l.material_id, qty: q };
      if(l.mr_item_id) row.mr_item_id = l.mr_item_id;
      if(invLE[id].cost && String(l.unit_cost).trim() !== ''){
        const c = spParseMoney(l.unit_cost);
        if(Number.isNaN(c)) return invX.catById.get(l.material_id).code + ': unit cost must be a number';
        row.unit_cost = c;
      }
      out.push(row);
    }
    if(!out.length) return 'Add at least one item';
    return out;
  }
  async function invRpc(fn, payload){
    if(!(await purchEnsureSession())) return null;
    const { data, error } = await db.rpc(fn, { p: payload });
    if(error) throw error;
    return data;
  }

  // =====================================================================
  // RECEIVE
  // =====================================================================
  let invRcvMode = 'po', invRcvPos = [], invRcvPoLines = [];
  async function invShowReceive(){
    await invEnter(async ()=>{
      $('invRcvWh').innerHTML = invFillCommon();
      let sup = await db.from('suppliers_directory').select('id, display_name').order('display_name');
      $('invRcvSupplier').innerHTML = invOpts(sup.data || [], s=> s.id, s=> s.display_name, '— not specified —');
      invFillProjJob('invRcvProject', 'invRcvJob');
      $('invRcvRef').value = ''; $('invRcvNote').value = ''; $('invRcvDirect').checked = false;
      invLEBind('rcv', 'invRcvLines', { cost: invX.money, avail:false, wh:'invRcvWh' });
      await invRcvLoadPos();
      invRcvSetMode('po');
    });
  }
  async function invRcvLoadPos(){
    const { data, error } = await db.rpc('inv_pos_to_receive');
    invRcvPos = error ? [] : (data || []);
    $('invRcvPo').innerHTML = '<option value="">' + (invRcvPos.length ? 'Choose an issued PO…' : 'No issued POs waiting for delivery') + '</option>' +
      invRcvPos.map(p=> '<option value="' + escapeHtml(p.id) + '">' + escapeHtml(p.po_no + ' — ' + (p.supplier || 'no supplier') + (p.reference ? ' · ' + p.reference : '')) + '</option>').join('');
  }
  function invRcvSetMode(m){
    invRcvMode = m;
    $$('#invRcvMode [data-m]').forEach(b=> b.classList.toggle('on', b.dataset.m === m));
    $('invRcvPoWrap').style.display = m === 'po' ? '' : 'none';
    $('invRcvSupWrap').style.display = m === 'free' ? '' : 'none';
    $('invRcvAdd').style.display = m === 'free' ? '' : 'none';
    $('invRcvHint').textContent = m === 'free'
      ? (invX.money ? 'Leave unit cost blank to value it at the current average cost.' : 'Received stock is valued at the current average cost (admins can set a cost).')
      : 'Enter what arrived now. Partial deliveries are fine — the rest stays open on the PO.';
    if(m === 'po') invRcvRenderPo(); else { invLE.rcv.lines = [invLEBlank()]; invLERender('rcv'); }
  }
  $('invRcvMode').addEventListener('click', (e)=>{ const b = e.target.closest('[data-m]'); if(b) invRcvSetMode(b.dataset.m); });
  $('invRcvAdd').addEventListener('click', ()=>{ invLE.rcv.lines.push(invLEBlank()); invLERender('rcv'); });
  $('invRcvPo').addEventListener('change', invRcvRenderPo);
  $('invRcvDirect').addEventListener('change', ()=>{
    const on = $('invRcvDirect').checked;
    $('invRcvProjWrap').style.display = on ? '' : 'none'; $('invRcvJobWrap').style.display = on ? '' : 'none';
  });
  function invRcvRenderPo(){
    if(invRcvMode !== 'po') return;
    const po = invRcvPos.find(p=> p.id === $('invRcvPo').value);
    if(!po){ $('invRcvLines').innerHTML = '<div class="empty-state" style="padding:12px;">Choose the PO this delivery is for.</div>'; invRcvPoLines = []; return; }
    invRcvPoLines = (po.items || []).filter(i=> Number(i.qty_received) < Number(i.qty)).map(i=> Object.assign({ now:'', map:i.material_id }, i));
    $('invRcvLines').innerHTML = '<div class="inv-ln-head"><span>#</span><span>Item</span><span>Receive now</span><span>Unit</span><span>Ordered / in</span><span></span></div>' +
      invRcvPoLines.map((i, n)=>{
        const m = i.map ? invX.catById.get(i.map) : null;
        const remaining = Number(i.qty) - Number(i.qty_received);
        const mapper = i.material_id ? '' : '<select data-map="1" style="margin-top:4px;"><option value="">Which catalog item is this?</option>' +
          invX.cat.map(c=> '<option value="' + escapeHtml(c.id) + '"' + (i.map === c.id ? ' selected' : '') + '>' + escapeHtml(c.code + ' — ' + c.name) + '</option>').join('') + '</select>';
        return '<div class="inv-ln" data-poi="' + escapeHtml(i.id) + '"><div class="po-no">' + (n + 1) + '</div>' +
          '<div class="inv-desc"><b>' + escapeHtml(i.description) + '</b><div class="po-item-code">' + escapeHtml(i.code || (m ? m.code : 'not in catalog')) + '</div>' + mapper + '</div>' +
          '<input type="text" class="num inv-q" data-poq="1" inputmode="decimal" placeholder="' + escapeHtml(invQty(remaining)) + '">' +
          '<div class="inv-unit">' + escapeHtml(i.unit) + '</div>' +
          '<div class="inv-av">' + invQty(i.qty) + ' / ' + invQty(i.qty_received) + '</div><span></span>' +
          '<div class="inv-conv" data-conv="1"></div></div>';
      }).join('') +
      '<button type="button" class="btn btn-secondary mt-small-btn" id="invRcvAll" style="margin-top:8px;">Fill in: everything remaining</button>';
  }
  function invRcvConv(i, qty){
    const m = invX.catById.get(i.map);
    if(!m || !(Number(m.pack_qty) > 0) || String(i.unit).trim().toLowerCase() !== String(m.pack_unit || '').trim().toLowerCase()) return '';
    return qty ? '= ' + invQty(qty * Number(m.pack_qty)) + ' ' + m.unit + ' into stock' : '1 ' + i.unit + ' = ' + invQty(m.pack_qty) + ' ' + m.unit;
  }
  $('invRcvLines').addEventListener('input', (e)=>{
    if(!e.target.dataset.poq) return;
    const row = e.target.closest('[data-poi]'), i = invRcvPoLines.find(x=> x.id === row.dataset.poi);
    i.now = e.target.value.trim();
    row.querySelector('[data-conv]').textContent = invRcvConv(i, spParseMoney(i.now));
  });
  $('invRcvLines').addEventListener('change', (e)=>{
    if(!e.target.dataset.map) return;
    const row = e.target.closest('[data-poi]'), i = invRcvPoLines.find(x=> x.id === row.dataset.poi);
    i.map = e.target.value || null;
    row.querySelector('[data-conv]').textContent = invRcvConv(i, spParseMoney(i.now));
  });
  $('invRcvLines').addEventListener('click', (e)=>{
    if(e.target.id !== 'invRcvAll') return;
    invRcvPoLines.forEach(i=>{ i.now = String(Number(i.qty) - Number(i.qty_received)); });
    $$('#invRcvLines [data-poi]').forEach(row=>{
      const i = invRcvPoLines.find(x=> x.id === row.dataset.poi);
      row.querySelector('[data-poq]').value = i.now; row.querySelector('[data-conv]').textContent = invRcvConv(i, Number(i.now));
    });
  });
  $('invRcvPost').addEventListener('click', async ()=>{
    const wh = invX.mine.find(w=> w.id === $('invRcvWh').value);
    const payload = { warehouse_id: wh.id, supplier_ref: $('invRcvRef').value.trim(), note: $('invRcvNote').value.trim() };
    let summary;
    if(invRcvMode === 'po'){
      const po = invRcvPos.find(p=> p.id === $('invRcvPo').value);
      if(!po){ toast('Choose the PO'); return; }
      const lines = [];
      for(const i of invRcvPoLines){
        if(!String(i.now).trim()) continue;
        const q = spParseMoney(i.now), rem = Number(i.qty) - Number(i.qty_received);
        if(q == null || Number.isNaN(q) || q <= 0){ toast(i.description + ': enter a quantity above 0'); return; }
        if(q > rem){ toast(i.description + ': only ' + invQty(rem) + ' ' + i.unit + ' left on ' + po.po_no); return; }
        if(!i.map){ toast(i.description + ': choose which catalog item it is'); return; }
        lines.push(Object.assign({ po_item_id: i.id, qty: q }, i.material_id ? {} : { material_id: i.map }));
      }
      if(!lines.length){ toast('Enter what was received'); return; }
      Object.assign(payload, { po_id: po.id, lines });
      summary = lines.length + ' line' + (lines.length === 1 ? '' : 's') + ' from ' + po.po_no;
    }else{
      const lines = invLECollect('rcv');
      if(typeof lines === 'string'){ toast(lines); return; }
      Object.assign(payload, { supplier_id: $('invRcvSupplier').value || null, lines });
      summary = lines.length + ' item' + (lines.length === 1 ? '' : 's') + ' without a PO';
    }
    const direct = invX.direct && $('invRcvDirect').checked;
    if(direct){
      payload.direct_project_id = $('invRcvProject').value || null; payload.direct_job_order_id = $('invRcvJob').value || null;
      if(!payload.direct_project_id && !payload.direct_job_order_id){ toast('Choose the project or job order it was delivered to'); return; }
    }
    if(!await uiConfirm('Receive ' + summary + ' into ' + wh.code + '?' + (direct ? '\n\nDelivered straight to site: charged to the project, not kept in stock.' : ''))) return;
    const btn = $('invRcvPost'); btn.disabled = true;
    try{
      const r = await invRpc('inv_post_receipt', payload); if(!r) return;
      toast(r.receipt_no + ' posted');
      invAfterPost('rcv', r.id);
    }catch(e){ purchFail('Couldn\u2019t post the receipt: ', e); }
    finally{ btn.disabled = false; }
  });

  // =====================================================================
  // ISSUE
  // =====================================================================
  let invIssMode = 'mrf', invIssMrs = [];
  async function invShowIssue(){
    await invEnter(async ()=>{
      $('invIssWh').innerHTML = invFillCommon();
      $('invIssWorker').innerHTML = invOpts(invX.workers, w=> w.id, w=> w.name, 'Choose a person…');
      invFillProjJob('invIssProject', 'invIssJob');
      $('invIssNote').value = '';
      invLEBind('iss', 'invIssLines', { cost:false, avail:true, wh:'invIssWh' });
      const r = await db.from('material_requisitions').select('id, mrf_no, requested_by, requester_name, job_order_id, job_order, urgency, material_requisition_items(*)')
        .eq('status', 'approved').order('created_at', { ascending:false });
      invIssMrs = (r.data || []).map(m=> Object.assign(m, { open: (m.material_requisition_items || []).filter(i=>
        i.material_id && !i.po_id && i.fulfilled_by !== 'tech_buy' && Number(i.qty_approved != null ? i.qty_approved : i.qty_requested) - Number(i.qty_issued || 0) > 0) })).filter(m=> m.open.length);
      $('invIssMr').innerHTML = '<option value="">' + (invIssMrs.length ? 'Choose an approved request…' : 'No approved requests with items to issue') + '</option>' +
        invIssMrs.map(m=> '<option value="' + escapeHtml(m.id) + '">' + escapeHtml(m.mrf_no + ' — ' + (m.requester_name || '') + (m.job_order ? ' · ' + m.job_order.id : '') + ' · ' + m.open.length + ' item' + (m.open.length === 1 ? '' : 's')) + '</option>').join('');
      invIssSetMode(invIssMrs.length ? 'mrf' : 'free');
    });
  }
  function invIssSetMode(m){
    invIssMode = m;
    $$('#invIssMode [data-m]').forEach(b=> b.classList.toggle('on', b.dataset.m === m));
    $('invIssMrWrap').style.display = m === 'mrf' ? '' : 'none';
    $('invIssAdd').style.display = m === 'free' ? '' : 'none';
    invLE.iss.lines = [invLEBlank()];
    if(m === 'mrf') invIssFromMr(); else invLERender('iss');
  }
  $('invIssMode').addEventListener('click', (e)=>{ const b = e.target.closest('[data-m]'); if(b) invIssSetMode(b.dataset.m); });
  $('invIssAdd').addEventListener('click', ()=>{ invLE.iss.lines.push(invLEBlank()); invLERender('iss'); });
  $('invIssMr').addEventListener('change', invIssFromMr);
  $('invIssWh').addEventListener('change', ()=> invLERender('iss'));
  function invIssFromMr(){
    const m = invIssMrs.find(x=> x.id === $('invIssMr').value);
    if(!m){ invLE.iss.lines = [invLEBlank()]; invLERender('iss'); return; }
    $('invIssWorker').value = m.requested_by || '';
    $('invIssJob').value = m.job_order_id && invX.jobs.some(j=> j.id === m.job_order_id) ? m.job_order_id : '';
    invLE.iss.lines = m.open.map(i=>{
      const left = Number(i.qty_approved != null ? i.qty_approved : i.qty_requested) - Number(i.qty_issued || 0);
      return { key: ++invLEKey, material_id: i.material_id, qty: String(left), unit_cost:'', mr_item_id: i.id, max: left, locked:true, text:'' };
    });
    invLERender('iss');
  }
  $('invIssPost').addEventListener('click', async ()=>{
    const wh = invX.mine.find(w=> w.id === $('invIssWh').value), worker = invX.workers.find(w=> w.id === $('invIssWorker').value);
    if(!worker){ toast('Choose who the materials are issued to'); return; }
    const lines = invLECollect('iss');
    if(typeof lines === 'string'){ toast(lines); return; }
    const short = lines.filter(l=> l.qty > invAvail(wh.id, l.material_id));
    if(short.length){ toast('Not enough stock in ' + wh.code + ' for ' + short.map(l=> invX.catById.get(l.material_id).code).join(', ')); return; }
    const mr = invIssMode === 'mrf' ? invIssMrs.find(x=> x.id === $('invIssMr').value) : null;
    if(invIssMode === 'mrf' && !mr){ toast('Choose the request'); return; }
    if(!await uiConfirm('Issue ' + lines.length + ' item' + (lines.length === 1 ? '' : 's') + ' from ' + wh.code + ' to ' + worker.name + (mr ? ' for ' + mr.mrf_no : '') + '?')) return;
    const btn = $('invIssPost'); btn.disabled = true;
    try{
      const r = await invRpc('inv_post_issue', { warehouse_id: wh.id, worker_id: worker.id, mr_id: mr ? mr.id : null,
        project_id: $('invIssProject').value || null, job_order_id: $('invIssJob').value || null, note: $('invIssNote').value.trim(), lines });
      if(!r) return;
      notifyUser(worker.id, 'Materials issued to you', r.slip_no + ' — ' + lines.length + ' item' + (lines.length === 1 ? '' : 's') + '. Please open My Materials and sign to acknowledge.', 'iss-' + r.id);
      toast(r.slip_no + ' posted — ' + worker.name + ' has been asked to acknowledge');
      invAfterPost('iss', r.id);
    }catch(e){ purchFail('Couldn\u2019t post the issue: ', e); }
    finally{ btn.disabled = false; }
  });

  // =====================================================================
  // RETURN — from what the worker currently holds
  // =====================================================================
  let invRetHold = [];
  async function invShowReturns(){
    await invEnter(()=>{
      $('invRetWh').innerHTML = invFillCommon();
      $('invRetWorker').innerHTML = invOpts(invX.workers, w=> w.id, w=> w.name, 'Choose a person…');
      $('invRetNote').value = ''; invRetHold = [];
      $('invRetLines').innerHTML = '<div class="empty-state" style="padding:12px;">Choose who is returning materials.</div>';
    });
  }
  function invPrjLabel(pid, job){
    const p = invX.projects.find(x=> x.id === pid);
    return [p ? p.project_no + ' — ' + p.name : '', job].filter(Boolean).join(' · ') || 'No project / job order';
  }
  $('invRetWorker').addEventListener('change', async ()=>{
    const wid = $('invRetWorker').value; invRetHold = [];
    if(!wid){ $('invRetLines').innerHTML = ''; return; }
    try{
      const { data, error } = await db.rpc('inv_worker_holdings', { p_worker: wid });
      if(error) throw error;
      invRetHold = (data || []).map(h=> Object.assign({ ret:'', cond:'good' }, h));
    }catch(e){ purchFail('Couldn\u2019t load what they hold: ', e); return; }
    if(!invRetHold.length){ $('invRetLines').innerHTML = '<div class="empty-state" style="padding:12px;">This person isn\u2019t holding any issued materials.</div>'; return; }
    let html = '', last = null;
    invRetHold.forEach((h, n)=>{
      const g = (h.project_id || '') + '|' + (h.job_order_id || '');
      if(g !== last){ last = g; html += '<div class="inv-hold-grp">' + escapeHtml(invPrjLabel(h.project_id, h.job_order_id)) + '</div>'; }
      const m = invX.catById.get(h.material_id) || { code:'?', name:'(inactive item)', unit:'' };
      html += '<div class="inv-ln" data-h="' + n + '"><div class="po-no">' + (n + 1) + '</div>' +
        '<div class="inv-desc"><b>' + escapeHtml(m.name) + '</b><div class="po-item-code">' + escapeHtml(m.code) + ' · holding ' + invQty(h.holding) + ' ' + escapeHtml(m.unit) + '</div></div>' +
        '<input type="text" class="num inv-q" data-rq="1" inputmode="decimal" placeholder="0">' +
        '<div class="inv-unit">' + escapeHtml(m.unit) + '</div>' +
        '<select data-rc="1"><option value="good">Good</option><option value="damaged">Damaged</option></select><span></span></div>';
    });
    $('invRetLines').innerHTML = html;
  });
  $('invRetLines').addEventListener('input', (e)=>{ if(e.target.dataset.rq) invRetHold[Number(e.target.closest('[data-h]').dataset.h)].ret = e.target.value.trim(); });
  $('invRetLines').addEventListener('change', (e)=>{ if(e.target.dataset.rc) invRetHold[Number(e.target.closest('[data-h]').dataset.h)].cond = e.target.value; });
  $('invRetPost').addEventListener('click', async ()=>{
    const wh = invX.mine.find(w=> w.id === $('invRetWh').value), wid = $('invRetWorker').value;
    if(!wid){ toast('Choose who is returning'); return; }
    const picked = [];
    for(const h of invRetHold){
      if(!String(h.ret).trim()) continue;
      const q = spParseMoney(h.ret), m = invX.catById.get(h.material_id);
      if(q == null || Number.isNaN(q) || q <= 0){ toast((m ? m.code : 'Item') + ': enter a quantity above 0'); return; }
      if(q > Number(h.holding)){ toast((m ? m.code : 'Item') + ': they only hold ' + invQty(h.holding)); return; }
      picked.push(Object.assign({}, h, { q }));
    }
    if(!picked.length){ toast('Enter what is being returned'); return; }
    // one return slip per project / job order, so each is credited correctly
    const groups = new Map();
    picked.forEach(h=>{ const k = (h.project_id || '') + '|' + (h.job_order_id || ''); if(!groups.has(k)) groups.set(k, []); groups.get(k).push(h); });
    const dmg = picked.filter(h=> h.cond === 'damaged').length;
    if(!await uiConfirm('Post ' + groups.size + ' return slip' + (groups.size === 1 ? '' : 's') + ' into ' + wh.code + '?' + (dmg ? '\n\n' + dmg + ' damaged line' + (dmg === 1 ? '' : 's') + ' will be recorded but not restocked.' : ''))) return;
    const btn = $('invRetPost'); btn.disabled = true;
    const done = [];
    try{
      for(const [, hs] of groups){
        const r = await invRpc('inv_post_return', { warehouse_id: wh.id, worker_id: wid, project_id: hs[0].project_id, job_order_id: hs[0].job_order_id,
          note: $('invRetNote').value.trim(), lines: hs.map(h=> ({ material_id: h.material_id, qty: h.q, condition: h.cond })) });
        if(!r) return;
        done.push(r);
      }
      toast(done.map(r=> r.return_no).join(', ') + ' posted');
      invAfterPost('ret', done[0].id);
    }catch(e){ purchFail('Couldn\u2019t post the return' + (done.length ? ' (posted ' + done.map(r=> r.return_no).join(', ') + ' before the error)' : '') + ': ', e); }
    finally{ btn.disabled = false; }
  });

  // =====================================================================
  // TRANSFER
  // =====================================================================
  async function invShowTransfers(){
    await invEnter(()=>{
      $('invTrfFrom').innerHTML = invFillCommon();
      invTrfFillTo();
      $('invTrfNote').value = '';
      invLEBind('trf', 'invTrfLines', { cost:false, avail:true, wh:'invTrfFrom' });
      invLERender('trf');
    });
  }
  function invTrfFillTo(){
    const from = $('invTrfFrom').value;
    $('invTrfTo').innerHTML = invOpts(invX.whs.filter(w=> w.is_active && w.id !== from), w=> w.id, w=> w.code + ' · ' + w.name, 'Choose destination…');
  }
  $('invTrfFrom').addEventListener('change', ()=>{ invTrfFillTo(); invLERender('trf'); });
  $('invTrfAdd').addEventListener('click', ()=>{ invLE.trf.lines.push(invLEBlank()); invLERender('trf'); });
  $('invTrfPost').addEventListener('click', async ()=>{
    const from = invX.mine.find(w=> w.id === $('invTrfFrom').value), to = invX.whs.find(w=> w.id === $('invTrfTo').value);
    if(!to){ toast('Choose where it\u2019s going'); return; }
    const lines = invLECollect('trf');
    if(typeof lines === 'string'){ toast(lines); return; }
    const short = lines.filter(l=> l.qty > invAvail(from.id, l.material_id));
    if(short.length){ toast('Not enough stock in ' + from.code + ' for ' + short.map(l=> invX.catById.get(l.material_id).code).join(', ')); return; }
    if(!await uiConfirm('Transfer ' + lines.length + ' item' + (lines.length === 1 ? '' : 's') + ' from ' + from.code + ' to ' + to.code + '?')) return;
    const btn = $('invTrfPost'); btn.disabled = true;
    try{
      const r = await invRpc('inv_post_transfer', { from_warehouse_id: from.id, to_warehouse_id: to.id, note: $('invTrfNote').value.trim(), lines });
      if(!r) return;
      toast(r.transfer_no + ' posted');
      invAfterPost('trf', r.id);
    }catch(e){ purchFail('Couldn\u2019t post the transfer: ', e); }
    finally{ btn.disabled = false; }
  });

  // after any post: open the new slip (with its PDF) in Slips & History
  async function invAfterPost(kind, id){
    showPurchasingView('slips');
    setTimeout(()=> invOpenSlip(kind, id), 60);
  }

  // =====================================================================
  // SLIPS & HISTORY
  // =====================================================================
  let invSlips = [];
  async function invShowSlips(opts){
    if(!(opts && opts.silent)){ $('invSlipView').style.display = 'none'; $('invSlipListView').style.display = ''; $('invSlipList').innerHTML = '<div class="empty-state">Loading…</div>'; }
    if(!(await ensureCloud())) return;
    try{
      await invLoadCtx();
      const [a, b, c, d] = await Promise.all(['rcv', 'iss', 'ret', 'trf'].map(k=> db.from(INV_SLIP_KIND[k].table).select('*').order('created_at', { ascending:false }).limit(300)));
      for(const r of [a, b, c, d]) if(r.error) throw r.error;
      invSlips = [].concat((a.data || []).map(x=> Object.assign({ kind:'rcv' }, x)), (b.data || []).map(x=> Object.assign({ kind:'iss' }, x)),
        (c.data || []).map(x=> Object.assign({ kind:'ret' }, x)), (d.data || []).map(x=> Object.assign({ kind:'trf' }, x)))
        .sort((x, y)=> String(y.created_at).localeCompare(String(x.created_at)));
      $('invSlipWh').innerHTML = '<option value="">All warehouses</option>' + invX.whs.map(w=> '<option value="' + escapeHtml(w.id) + '">' + escapeHtml(w.code) + '</option>').join('');
      invRenderSlips();
    }catch(e){
      $('invSlipList').innerHTML = '<div class="empty-state">' + (purchIsAuthError(e) ? PURCH_EXPIRED_HTML : invMissingTables(e) ? 'Run migration 20260923_08_inventory_movements.sql first.' : 'Couldn\u2019t load slips: ' + escapeHtml(describeCloudError(e))) + '</div>';
    }
  }
  function invSlipNo(s){ return s[INV_SLIP_KIND[s.kind].no]; }
  function invSlipWhs(s){ return s.kind === 'trf' ? [s.from_warehouse_id, s.to_warehouse_id] : [s.warehouse_id]; }
  function invSlipParty(s){
    const wh = (id)=> { const w = invX.whs.find(x=> x.id === id); return w ? w.code : ''; };
    if(s.kind === 'rcv') return (s.po_id ? 'Against PO' : 'No PO') + (s.supplier_ref ? ' · ' + s.supplier_ref : '') + (s.direct_project_id || s.direct_job_order_id ? ' · direct to site' : '');
    if(s.kind === 'iss') return 'To ' + (s.worker_name || '');
    if(s.kind === 'ret') return 'From ' + (s.worker_name || '');
    return wh(s.from_warehouse_id) + ' → ' + wh(s.to_warehouse_id);
  }
  function invRenderSlips(){
    const t = $('invSlipType').value, wh = $('invSlipWh').value, pend = $('invSlipPending').checked;
    const q = ($('invSlipSearch').value || '').trim().toLowerCase();
    const rows = invSlips.filter(s=> (!t || s.kind === t) && (!wh || invSlipWhs(s).includes(wh)) && (!pend || (s.kind === 'iss' && s.status === 'issued')) &&
      (!q || [invSlipNo(s), invSlipParty(s), s.job_order_id, s.note, invPrjLabel(s.project_id || s.direct_project_id, '')].join(' ').toLowerCase().includes(q)));
    $('invSlipList').innerHTML = rows.length ? rows.slice(0, 300).map(s=>
      '<button type="button" class="mt-row" data-kind="' + s.kind + '" data-id="' + escapeHtml(s.id) + '"><div class="mt-row-main">' +
      '<div class="mt-row-title"><span class="mt-code">' + escapeHtml(invSlipNo(s)) + '</span>' + escapeHtml(INV_SLIP_KIND[s.kind].label) +
      (s.kind === 'iss' ? ' <span class="po-status ' + (s.status === 'acknowledged' ? 'fulfilled' : 'returned') + '">' + (s.status === 'acknowledged' ? 'signed' : 'awaiting signature') + '</span>' : '') + '</div>' +
      '<div class="sp-row-sub">' + escapeHtml([mrWhen(s.created_at), invSlipParty(s), s.job_order_id || s.direct_job_order_id, (s.project_id || s.direct_project_id) ? invPrjLabel(s.project_id || s.direct_project_id, '') : ''].filter(Boolean).join(' · ')) + '</div></div>' +
      '<div class="mt-row-price none">' + escapeHtml(invSlipWhs(s).map(id=> (invX.whs.find(w=> w.id === id) || {}).code || '').join(' → ')) + '</div></button>').join('')
      : '<div class="empty-state">' + (invSlips.length ? 'Nothing matches.' : 'No stock movements yet.') + '</div>';
  }
  ['invSlipSearch'].forEach(id=> $(id).addEventListener('input', invRenderSlips));
  ['invSlipType', 'invSlipWh', 'invSlipPending'].forEach(id=> $(id).addEventListener('change', invRenderSlips));
  $('invSlipList').addEventListener('click', (e)=>{
    if(e.target.closest('[data-purch-reauth]')){ purchReauth().then(ok=>{ if(ok) invShowSlips(); }); return; }
    const r = e.target.closest('.mt-row'); if(r) invOpenSlip(r.dataset.kind, r.dataset.id);
  });
  $('invSlipBack').addEventListener('click', ()=>{ $('invSlipView').style.display = 'none'; $('invSlipListView').style.display = ''; invRenderSlips(); });

  let invSlipOpen = null;
  async function invLoadSlip(kind, id){
    const K = INV_SLIP_KIND[kind];
    const [h, it] = await Promise.all([db.from(K.table).select('*').eq('id', id), db.from(K.items).select('*').eq(K.fk, id).order('line_no')]);
    if(h.error) throw h.error; if(it.error) throw it.error;
    if(!h.data || !h.data[0]) throw new Error('Slip not found');
    return { kind, h: h.data[0], items: it.data || [] };
  }
  async function invOpenSlip(kind, id){
    try{
      if(!invX.whs.length) await invLoadCtx();
      invSlipOpen = await invLoadSlip(kind, id);
      invRenderSlipDetail(invSlipOpen, 'invSlip');
      $('invSlipListView').style.display = 'none'; $('invSlipView').style.display = '';
      window.scrollTo({ top:0 });
    }catch(e){ purchFail('Couldn\u2019t open the slip: ', e); }
  }
  function invRenderSlipDetail(d, pre){
    const K = INV_SLIP_KIND[d.kind], h = d.h;
    const wh = (id)=>{ const w = invX.whs.find(x=> x.id === id); return w ? w.code + ' · ' + w.name : ''; };
    $(pre + 'Title').innerHTML = '<span class="mt-code">' + escapeHtml(h[K.no]) + '</span> ' + escapeHtml(K.label) +
      (d.kind === 'iss' ? ' <span class="po-status ' + (h.status === 'acknowledged' ? 'fulfilled' : 'returned') + '">' + (h.status === 'acknowledged' ? 'signed' : 'awaiting signature') + '</span>' : '');
    const kv = (k, v)=> v ? '<div><div class="k">' + k + '</div><div class="v">' + v + '</div></div>' : '';
    $(pre + 'Info').innerHTML = kv('Date', escapeHtml(mrWhen(h.created_at))) +
      (d.kind === 'trf' ? kv('From', escapeHtml(wh(h.from_warehouse_id))) + kv('To', escapeHtml(wh(h.to_warehouse_id))) : kv('Warehouse', escapeHtml(wh(h.warehouse_id)))) +
      (d.kind === 'iss' ? kv('Issued to', escapeHtml(h.worker_name)) + kv('Issued by', escapeHtml(h.issued_by_name)) + (h.ack_at ? kv('Signed', escapeHtml(mrWhen(h.ack_at))) : '') : '') +
      (d.kind === 'ret' ? kv('Returned by', escapeHtml(h.worker_name)) + kv('Received by', escapeHtml(h.received_by_name)) : '') +
      (d.kind === 'rcv' ? kv('Received by', escapeHtml(h.received_by_name)) + kv('DR / invoice', escapeHtml(h.supplier_ref)) + ((h.direct_project_id || h.direct_job_order_id) ? kv('Delivered to site', escapeHtml(invPrjLabel(h.direct_project_id, h.direct_job_order_id))) : '') : '') +
      (d.kind === 'trf' ? kv('By', escapeHtml(h.created_by_name)) : '') +
      ((h.project_id || h.job_order_id) ? kv('Project / job', escapeHtml(invPrjLabel(h.project_id, h.job_order_id))) : '') + kv('Note', escapeHtml(h.note));
    const name = (id)=> invX.catById.get(id) || { code:'', name:'(inactive item)', unit:'' };
    $(pre + 'Items').innerHTML = '<thead><tr><th>#</th><th>Item</th><th class="num">Qty</th><th>Unit</th>' + (d.kind === 'ret' ? '<th>Condition</th>' : d.kind === 'rcv' ? '<th>As on PO</th>' : '') + '</tr></thead><tbody>' +
      d.items.map((it, i)=>{ const m = name(it.material_id);
        return '<tr><td>' + (i + 1) + '</td><td><b>' + escapeHtml(m.name) + '</b><div class="sp-row-sub">' + escapeHtml(m.code) + '</div></td><td class="num">' + invQty(it.qty) + '</td><td>' + escapeHtml(m.unit) + '</td>' +
          (d.kind === 'ret' ? '<td>' + (it.condition === 'damaged' ? '<span class="sp-tag danger">Damaged</span>' : 'Good') + '</td>' : d.kind === 'rcv' ? '<td>' + (it.qty_po_units ? invQty(it.qty_po_units) + ' ' + escapeHtml(it.po_unit) : '—') + '</td>' : '') + '</tr>';
      }).join('') + '</tbody>';
  }
  $('invSlipPdf').addEventListener('click', ()=>{ if(invSlipOpen) invSlipPdf(invSlipOpen); });

  // ---------- slip PDF (same look as the PO) ----------
  async function invSlipPdf(d){
    try{
      await loadAwesScript('jspdf', awesLibs.jspdf); await loadAwesScript('autotable', awesLibs.autotable);
      await poLoadSettings().catch(()=>{});
      const co = poSettingsData || {}, style = co.header_style || 'green';
      const logo = co.logo_path ? await poLoadImage(co.logo_path).then(img=> poLogoForStyle(img, style)) : await poDefaultLogo(style);
      const fonts = await poLoadFonts();
      const { jsPDF } = window.jspdf;
      const doc = new jsPDF({ orientation:'p', unit:'pt', format:'a4', compress:true });
      let F = 'helvetica', FS = ['helvetica', 'bold'], FB = ['helvetica', 'bold'];
      if(fonts){ try{
        doc.addFileToVFS('Inter-Regular.ttf', fonts.regular); doc.addFont('Inter-Regular.ttf', 'Inter', 'normal');
        doc.addFileToVFS('Inter-SemiBold.ttf', fonts.semibold); doc.addFont('Inter-SemiBold.ttf', 'Inter', 'bold');
        doc.addFileToVFS('Inter-Bold.ttf', fonts.bold); doc.addFont('Inter-Bold.ttf', 'InterBold', 'normal');
        F = 'Inter'; FS = ['Inter', 'bold']; FB = ['InterBold', 'normal'];
      }catch(e){} }
      const reg = (s)=>{ doc.setFont(F, 'normal'); doc.setFontSize(s); }, semi = (s)=>{ doc.setFont(FS[0], FS[1]); doc.setFontSize(s); }, bold = (s)=>{ doc.setFont(FB[0], FB[1]); doc.setFontSize(s); };
      const W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight(), M = 36;
      const G = [21, 77, 52], SUB = [96, 108, 101], INK = [28, 34, 30], LINE = [216, 223, 219];
      const green = style !== 'white', ink = green ? [255, 255, 255] : INK;
      const K = INV_SLIP_KIND[d.kind], h = d.h, headH = 104;
      if(green){ doc.setFillColor(...G); doc.rect(0, 0, W, headH, 'F'); } else { doc.setFillColor(...G); doc.rect(0, headH - 4, W, 4, 'F'); }
      if(logo && logo.w){ const r = Math.min(150 / logo.w, 44 / logo.h); try{ doc.addImage(logo.dataUrl, 'PNG', M, 16, logo.w * r, logo.h * r, 'inv-logo', 'FAST'); }catch(e){} }
      semi(9.5); doc.setTextColor(...ink); doc.text(co.company_name || '', M, 78);
      reg(7.4); doc.text(doc.splitTextToSize(co.address || '', 320).slice(0, 1), M, 90);
      bold(16); doc.text(K.title, W - M, 36, { align:'right' });
      semi(10.5); doc.text(h[K.no], W - M, 54, { align:'right' });
      reg(8.8); doc.text(mrWhen(h.created_at), W - M, 68, { align:'right' });
      let y = headH + 20;
      const wh = (id)=>{ const w = invX.whs.find(x=> x.id === id); return w ? w.code + ' — ' + w.name : ''; };
      const info = [].concat(
        d.kind === 'trf' ? [['From', wh(h.from_warehouse_id)], ['To', wh(h.to_warehouse_id)]] : [['Warehouse', wh(h.warehouse_id)]],
        d.kind === 'iss' ? [['Issued to', h.worker_name]] : [], d.kind === 'ret' ? [['Returned by', h.worker_name]] : [],
        d.kind === 'rcv' ? [['DR / invoice', h.supplier_ref], ['Delivered to site', (h.direct_project_id || h.direct_job_order_id) ? invPrjLabel(h.direct_project_id, h.direct_job_order_id) : '']] : [],
        [['Project / job', (h.project_id || h.job_order_id) ? invPrjLabel(h.project_id, h.job_order_id) : ''], ['Note', h.note]]).filter(r=> r[1]);
      info.forEach(([k, v])=>{
        reg(7.8); doc.setTextColor(...SUB); doc.text(k, M, y);
        reg(9); doc.setTextColor(...INK); const ls = doc.splitTextToSize(String(v), W - M * 2 - 90); doc.text(ls, M + 90, y); y += ls.length * 11 + 3;
      });
      const name = (id)=> invX.catById.get(id) || { code:'', name:'(inactive item)', unit:'' };
      doc.autoTable({
        startY: y + 8, margin: { left:M, right:M, bottom:60 },
        head: [['#', 'Code', 'Item', 'Qty', 'Unit'].concat(d.kind === 'ret' ? ['Condition'] : d.kind === 'rcv' ? ['As on PO'] : [])],
        body: d.items.map((it, i)=>{ const m = name(it.material_id);
          return [String(i + 1), m.code, m.name, invQty(it.qty), m.unit].concat(d.kind === 'ret' ? [it.condition === 'damaged' ? 'Damaged' : 'Good'] : d.kind === 'rcv' ? [it.qty_po_units ? invQty(it.qty_po_units) + ' ' + it.po_unit : ''] : []); }),
        theme:'plain',
        styles: { font:F, fontSize:8.6, cellPadding:{ top:5, bottom:5, left:6, right:6 }, textColor:INK, lineColor:LINE, lineWidth:{ bottom:0.5 } },
        headStyles: { font:F, fontStyle:'bold', fillColor:G, textColor:255, fontSize:7.8 },
        alternateRowStyles: { fillColor:[247, 250, 248] },
        columnStyles: { 0:{ cellWidth:22, halign:'center' }, 1:{ cellWidth:64, textColor:SUB, fontSize:7.6 }, 3:{ halign:'right', cellWidth:56 }, 4:{ halign:'center', cellWidth:44 } }
      });
      // signatures at the bottom
      let sig = null;
      if(d.kind === 'iss' && h.ack_signature_path){
        try{ const r = await db.storage.from('inventory-signatures').download(h.ack_signature_path); if(r.data){ const url = await poBlobToDataUrl(r.data); const sz = await poImageSize(url); sig = { dataUrl:url, w:sz.w, h:sz.h }; } }catch(e){}
      }
      const blocks = d.kind === 'iss' ? [['Issued by', h.issued_by_name, null], ['Received by', h.worker_name, sig]]
        : d.kind === 'ret' ? [['Returned by', h.worker_name, null], ['Received by', h.received_by_name, null]]
        : d.kind === 'rcv' ? [['Delivered by (supplier)', '', null], ['Received by', h.received_by_name, null]]
        : [['Released by', h.created_by_name, null], ['Received by', '', null]];
      const sigTop = H - 46 - 90, sw = (W - M * 2 - 40) / 2;
      if(doc.lastAutoTable.finalY > sigTop - 10) doc.addPage();
      blocks.forEach(([cap, nm, img], i)=>{
        const x = M + i * (sw + 40);
        semi(6.8); doc.setTextColor(...SUB); doc.text(cap.toUpperCase(), x, sigTop);
        if(img && img.w){ const r = Math.min((sw - 20) / img.w, 44 / img.h); try{ doc.addImage(img.dataUrl, 'PNG', x + (sw - img.w * r) / 2, sigTop + 56 - img.h * r, img.w * r, img.h * r, undefined, 'FAST'); }catch(e){} }
        doc.setDrawColor(70, 76, 72); doc.setLineWidth(0.6); doc.line(x, sigTop + 58, x + sw, sigTop + 58);
        semi(8.6); doc.setTextColor(...INK); doc.text(nm ? nm.toUpperCase() : 'Signature over printed name / Date', x + sw / 2, sigTop + 70, { align:'center' });
        if(i === 1 && d.kind === 'iss' && h.ack_at){ reg(7.4); doc.setTextColor(...SUB); doc.text('Acknowledged ' + mrWhen(h.ack_at), x + sw / 2, sigTop + 81, { align:'center' }); }
      });
      const pages = doc.internal.getNumberOfPages();
      for(let p = 1; p <= pages; p++){ doc.setPage(p); reg(7); doc.setTextColor(...SUB); doc.text(h[K.no] + '   •   ' + (co.company_name || ''), M, H - 20); doc.text('Page ' + p + ' of ' + pages, W - M, H - 20, { align:'right' }); }
      const title = K.label + ' ' + h[K.no];
      $('previewOverlay').querySelector('h3').textContent = title;
      $('previewOkBtn').textContent = 'Close';
      $('previewOverlay').style.zIndex = '99';
      $('previewOverlay').classList.add('open');
      await renderPdfPreview(doc, h[K.no] + '.pdf', title);
    }catch(e){ console.error('slip pdf failed', e); toast('Couldn\u2019t build the PDF: ' + (e && e.message ? e.message : e)); }
  }

  // =====================================================================
  // MY MATERIALS (technician): sign for issue slips; what I hold
  // =====================================================================
  let invMine = [], invMineOpen = null, invSigPad = null;
  async function invShowMyMaterials(){
    $('invMineSlipView').style.display = 'none'; $('invMineListView').style.display = '';
    $('invMinePending').innerHTML = '<div class="empty-state">Loading…</div>';
    if(!(await ensureCloud())){ $('invMinePending').innerHTML = '<div class="empty-state">Not connected.</div>'; return; }
    try{
      const [s, hold, cat, pr] = await Promise.all([
        db.from('issue_slips').select('*, issue_slip_items(count)').eq('worker_id', currentUser.id).order('created_at', { ascending:false }).limit(100),
        db.rpc('inv_worker_holdings', { p_worker: currentUser.id }),
        db.from('materials').select('id, code, name, unit').eq('is_active', true),
        db.from('projects').select('id, project_no, name')
      ]);
      if(s.error) throw s.error;
      invMine = s.data || [];
      invX.catById = new Map((cat.data || []).map(m=> [m.id, m]));
      invX.projects = pr.data || [];
      const pend = invMine.filter(x=> x.status === 'issued');
      const row = (x)=> '<button type="button" class="mt-row" data-id="' + escapeHtml(x.id) + '"><div class="mt-row-main"><div class="mt-row-title"><span class="mt-code">' + escapeHtml(x.slip_no) + '</span>' +
        (x.status === 'issued' ? '<span class="po-status returned">sign now</span>' : '<span class="po-status fulfilled">signed</span>') + '</div>' +
        '<div class="sp-row-sub">' + escapeHtml([mrWhen(x.created_at), (x.issue_slip_items && x.issue_slip_items[0] ? x.issue_slip_items[0].count : 0) + ' item(s)', 'by ' + x.issued_by_name, x.job_order_id].filter(Boolean).join(' · ')) + '</div></div></button>';
      $('invMinePending').innerHTML = pend.length ? pend.map(row).join('') : '<div class="empty-state" style="padding:12px;">Nothing to sign. 👍</div>';
      $('invMineRecent').innerHTML = invMine.filter(x=> x.status !== 'issued').slice(0, 20).map(row).join('') || '<div class="empty-state" style="padding:12px;">No slips yet.</div>';
      const hs = hold.error ? [] : (hold.data || []);
      let html = '', last = null;
      hs.forEach(hh=>{
        const g = (hh.project_id || '') + '|' + (hh.job_order_id || '');
        if(g !== last){ last = g; html += '<div class="inv-hold-grp">' + escapeHtml(invPrjLabel(hh.project_id, hh.job_order_id)) + '</div>'; }
        const m = invX.catById.get(hh.material_id) || { code:'', name:'(item)', unit:'' };
        html += '<div class="sp-row"><div class="sp-row-top"><div><div class="sp-row-title">' + escapeHtml(m.name) + '</div><div class="sp-row-sub">' + escapeHtml(m.code) + '</div></div>' +
          '<div class="mt-row-price"><span class="inv-qty">' + invQty(hh.holding) + ' ' + escapeHtml(m.unit) + '</span></div></div></div>';
      });
      $('invMineHold').innerHTML = html || '<div class="empty-state" style="padding:12px;">You\u2019re not holding any issued materials.</div>';
      invSetMineBadge(pend.length);
    }catch(e){
      $('invMinePending').innerHTML = '<div class="empty-state">' + (purchIsAuthError(e) ? PURCH_EXPIRED_HTML : invMissingTables(e) ? 'Inventory isn\u2019t set up yet.' : 'Couldn\u2019t load: ' + escapeHtml(describeCloudError(e))) + '</div>';
    }
  }
  function invSetMineBadge(n){
    const b = document.getElementById('techQaMyMatBadge'); if(!b) return;
    b.textContent = n ? n + ' to sign' : ''; b.style.display = n ? '' : 'none';
  }
  // cheap check on the home screen so the tile shows how many slips need signing
  async function invRefreshMineBadge(){
    if(!currentUser || currentUser.role === 'admin' || currentUser.role === 'customer') return;
    try{
      const { data, error } = await db.from('issue_slips').select('id').eq('worker_id', currentUser.id).eq('status', 'issued');
      if(!error) invSetMineBadge((data || []).length);
    }catch(e){}
  }
  ['invMinePending', 'invMineRecent'].forEach(id=> $(id).addEventListener('click', (e)=>{
    if(e.target.closest('[data-purch-reauth]')){ purchReauth().then(ok=>{ if(ok) invShowMyMaterials(); }); return; }
    const r = e.target.closest('.mt-row'); if(r) invOpenMineSlip(r.dataset.id);
  }));
  $('invMineBack').addEventListener('click', ()=>{ $('invMineSlipView').style.display = 'none'; $('invMineListView').style.display = ''; invShowMyMaterials(); });
  $('techQaMyMaterials').addEventListener('click', ()=> showPurchasingView('myMaterials'));
  async function invOpenMineSlip(id){
    try{
      const whs = await db.from('warehouses').select('*'); invX.whs = whs.data || [];
      invMineOpen = await invLoadSlip('iss', id);
      invRenderSlipDetail(invMineOpen, 'invMine');
      const signed = invMineOpen.h.status === 'acknowledged';
      $('invMineSignSec').style.display = signed ? 'none' : '';
      $('invMineActions').style.display = signed ? 'none' : '';
      $('invMineListView').style.display = 'none'; $('invMineSlipView').style.display = '';
      window.scrollTo({ top:0 });
      if(!signed){
        await loadAwesScript('signature', awesLibs.signature);
        invSigPad = new SignaturePad($('invMineSig'), { penColor:'#1C2621', backgroundColor:'rgba(255,255,255,0)' });
        invSigFit();
      }
    }catch(e){ purchFail('Couldn\u2019t open the slip: ', e); }
  }
  // Size the canvas to its box (sharp on high-DPI phones). Re-run on resize
  // / rotation, redrawing what was already signed so it isn't squashed.
  function invSigFit(){
    const c = $('invMineSig');
    if(!invSigPad || !c.offsetWidth) return;
    const data = invSigPad.toData(), ratio = Math.max(window.devicePixelRatio || 1, 1);
    c.width = c.offsetWidth * ratio; c.height = c.offsetHeight * ratio;
    c.getContext('2d').scale(ratio, ratio);
    invSigPad.clear();
    if(data && data.length) invSigPad.fromData(data);
  }
  window.addEventListener('resize', ()=>{ if($('invMineSlipView').style.display !== 'none') invSigFit(); });
  $('invMineSigClear').addEventListener('click', ()=>{ if(invSigPad) invSigPad.clear(); });
  $('invMineAck').addEventListener('click', async ()=>{
    if(!invMineOpen) return;
    if(!invSigPad || invSigPad.isEmpty()){ toast('Please sign in the box first'); return; }
    if(!(await purchEnsureSession())) return;
    const btn = $('invMineAck'); btn.disabled = true;
    try{
      // crop to the ink (the signing box is mostly empty) so it prints large
      // and crisp on the slip — same routine as the PO e-signatures
      const cropped = poCleanSignature($('invMineSig')) || $('invMineSig');
      const blob = await new Promise(res=> cropped.toBlob(res, 'image/png'));
      const path = currentUser.id + '/' + invMineOpen.h.id + '-' + Date.now() + '.png';
      const up = await db.storage.from('inventory-signatures').upload(path, blob, { contentType:'image/png', upsert:false });
      if(up.error) throw up.error;
      const { error } = await db.rpc('inv_ack_issue', { p_slip: invMineOpen.h.id, p_signature_path: path });
      if(error) throw error;
      toast(invMineOpen.h.slip_no + ' acknowledged — thank you');
      $('invMineSlipView').style.display = 'none'; $('invMineListView').style.display = '';
      invShowMyMaterials();
    }catch(e){ purchFail('Couldn\u2019t acknowledge: ', e); }
    finally{ btn.disabled = false; }
  });
