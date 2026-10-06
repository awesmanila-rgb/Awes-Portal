  // =====================================================================
  // Materials trail — the journey of every ITEM on a material request
  //
  //   Request > Approve > Buy > Arrive > Hand over > Return
  //
  // Up to approval a request moves as one; after that each item takes its own path
  // (a PO, the worker buying it, or stock), so each item gets its own trail.
  // Data: mr_trail(request) / mr_progress(requests[]) (migration 20261025_01), which
  // also say what the caller may do next:
  //   * the requester or the collector can record "I received this" on a PO line
  //     (po_worker_receive) — no warehouse stock, the goods are with the worker;
  //   * the person assigned to buy a "tech buys" line can record the purchase with the
  //     store, price and a receipt photo (mr_record_purchase).
  // The collector (who will pick the materials up) and the buyer are chosen with
  // mr_set_collector / mr_set_buyer (migration 20261024_01).
  // =====================================================================

  const MT_STEPS = ['Request', 'Approve', 'Buy', 'Arrive', 'Hand over', 'Return'];
  let mtWorkers = null;
  const mtQty = (n)=> Number(n || 0).toLocaleString('en-PH', { maximumFractionDigits:3 });
  const mtMoneyFmt = (n)=> n == null ? '' : '\u20B1' + Number(n).toLocaleString('en-PH', { minimumFractionDigits:2, maximumFractionDigits:2 });
  const mtDay = (ts)=> { try{ return new Date(ts).toLocaleDateString('en-PH', { timeZone:'Asia/Manila', month:'short', day:'numeric' }); }catch(e){ return ''; } };

  async function mtLoadWorkers(){
    if(mtWorkers) return mtWorkers;
    try{
      const { data, error } = await db.rpc('worker_names');
      if(error) throw error;
      mtWorkers = data || [];
    }catch(e){ mtWorkers = []; }
    return mtWorkers;
  }
  // exclude: the requester is already the "default" choice, so they are not listed again
  const mtWorkerOptions = (selected, blankLabel, exclude)=> '<option value="">' + escapeHtml(blankLabel) + '</option>' +
    (mtWorkers || []).filter(w=> !exclude || w.id !== exclude).map(w=> '<option value="' + escapeHtml(w.id) + '"' + (w.id === selected ? ' selected' : '') + '>' + escapeHtml(w.name) + (w.role === 'technician' ? '' : ' (office)') + '</option>').join('');

  // ---------- what each item's situation is, in plain words ----------
  function mtRouteChip(it){
    const r = it.route;
    return r === 'po' ? 'Purchase order' : r === 'tech_buy' ? 'A worker buys it' : r === 'stock' ? 'From stock' : r === 'none' ? 'Not needed' : 'Not planned yet';
  }
  function mtFacts(it, money){
    const out = [];
    const need = mtQty(it.qty_need) + ' ' + (it.unit || '');
    if(it.route === 'none') return ['The office approved 0 of this, so nothing is needed.'];
    if(it.route === 'po' && it.po){
      const po = it.po;
      if(po.status === 'cancelled') out.push('<b>' + escapeHtml(po.po_no || 'The PO') + ' was cancelled.</b> The office is making a new order.');
      else if(po.status === 'draft') out.push((po.waiting_approval ? 'The order is waiting for approval' : 'The office is preparing the order') + ' (' + escapeHtml(po.po_no || 'PO') + ').');
      else{
        out.push('Ordered on <b>' + escapeHtml(po.po_no || 'PO') + '</b>' + (po.delivery_date ? ', supplier delivers ' + escapeHtml(mtDay(po.delivery_date + 'T12:00:00+08:00')) : '') + '.');
        out.push('Arrived: <b>' + mtQty(it.po_received) + ' of ' + mtQty(it.po_qty) + '</b>' +
          (it.po_received > 0 ? ' (' + [it.po_received_in_warehouse > 0 ? mtQty(it.po_received_in_warehouse) + ' in the warehouse' : '', it.po_received_by_workers > 0 ? mtQty(it.po_received_by_workers) + ' received by workers' : ''].filter(Boolean).join(', ') + ')' : '') + '.');
      }
    }else if(it.route === 'tech_buy'){
      const b = it.buyer && it.buyer.name ? escapeHtml(it.buyer.name) : 'The requester';
      out.push('<b>' + b + '</b> buys this (cash advance).');
      out.push('Bought so far: <b>' + mtQty(it.bought_qty) + ' of ' + mtQty(it.qty_need) + '</b>' + (money && it.bought_amount != null && Number(it.bought_qty) > 0 ? ' \u00B7 ' + mtMoneyFmt(it.bought_amount) : '') + '.');
    }else if(it.route === 'stock'){
      out.push('Taken from warehouse stock.');
    }else if(it.progress >= 2){
      out.push('Waiting for the office to decide how to get this (' + escapeHtml(need) + ').');
    }
    (it.issued || []).forEach(s=>{
      out.push('Issued <b>' + mtQty(s.qty) + '</b> to <b>' + escapeHtml(s.worker || '') + '</b> (' + escapeHtml(s.slip_no || '') + ') \u2014 ' +
        (s.status === 'acknowledged' ? 'signed' + (s.ack_at ? ' ' + escapeHtml(mtDay(s.ack_at)) : '') : '<span class="mt-wait">waiting for their signature</span>') + '.');
    });
    if(Number(it.returned_good) + Number(it.returned_damaged) > 0)
      out.push('Returned: ' + [Number(it.returned_good) > 0 ? mtQty(it.returned_good) + ' good' : '', Number(it.returned_damaged) > 0 ? mtQty(it.returned_damaged) + ' damaged' : ''].filter(Boolean).join(', ') + '.');
    return out;
  }

  function mtPathHtml(p){
    // done: steps 1..p ; next: p+1 (blue) ; after the hand-over the return is optional
    return '<div class="mt-path" role="list">' + MT_STEPS.map((label, i)=>{
      const n = i + 1, done = n <= p, next = n === p + 1 && n <= 5;
      return '<div class="mt-node ' + (done ? 'done' : next ? 'next' : '') + '" role="listitem" aria-label="' + escapeHtml(label) + (done ? ', done' : next ? ', next' : '') + '">' +
        '<span class="mt-dot">' + (done ? '\u2713' : n) + '</span><span class="mt-lab">' + escapeHtml(label) + '</span></div>';
    }).join('') + '</div>';
  }

  function mtItemHtml(it, money){
    const actions = (it.can_receive ? '<button type="button" class="btn btn-primary mt-act" data-mt-act="receive" data-item="' + escapeHtml(it.id) + '">I received this</button>' : '') +
      (it.can_buy ? '<button type="button" class="btn btn-primary mt-act" data-mt-act="buy" data-item="' + escapeHtml(it.id) + '">I bought this</button>' : '');
    return '<div class="mt-item" data-item="' + escapeHtml(it.id) + '">' +
      '<div class="mt-item-head"><div class="mt-item-name">' + escapeHtml(it.description) + (it.code ? ' <span class="mt-code">' + escapeHtml(it.code) + '</span>' : '') + '</div>' +
      '<div class="mt-item-qty">' + mtQty(it.qty_need) + ' ' + escapeHtml(it.unit || '') + '</div></div>' +
      '<div class="mt-route">' + escapeHtml(mtRouteChip(it)) + '</div>' + (it.route === 'none' ? '' : mtPathHtml(it.progress)) +
      '<ul class="mt-facts">' + mtFacts(it, money).map(f=> '<li>' + f + '</li>').join('') + '</ul>' +
      (actions ? '<div class="mt-actions">' + actions + '</div>' : '') + '</div>';
  }

  // ---------- who collects ----------
  function mtCollectorHtml(t){
    const mr = t.mr, mine = mr.requested_by === currentUser.id;
    const canSet = mine || (isStaffUser() && can('pur.requisitions', 'edit')) || (currentUser && currentUser.role === 'admin');
    const open = !['cancelled', 'rejected'].includes(mr.status);
    const name = mr.collector ? escapeHtml(mr.collector.name) : escapeHtml(mr.requester_name || 'The requester');
    if(!(canSet && open)) return '<div class="mt-collector"><span>Collector:</span> <b>' + name + '</b></div>';
    return '<div class="mt-collector"><label>Who collects the materials? <select data-mt-collector>' + mtWorkerOptions(mr.collector ? mr.collector.id : '', (mr.requester_name || 'The requester') + ' (default)', mr.requested_by) + '</select></label>' +
      '<button type="button" class="btn btn-secondary mt-small" data-mt-act="setcollector" style="display:none;">Save</button></div>';
  }

  async function mtMountTrail(host, mrId){
    if(!host) return;
    host.innerHTML = '<div class="empty-state">Loading the trail\u2026</div>';
    try{
      await mtLoadWorkers();
      const { data, error } = await db.rpc('mr_trail', { p_mr: mrId });
      if(error) throw error;
      host._mt = { mrId, trail: data };
      const items = data.items || [];
      // Simple by default: a one-line answer on top, the steps of each item folded away.
      // It opens by itself only when the caller has something to do (receive / buy).
      const todo = items.some(it=> it.can_receive || it.can_buy);
      const mmRow = (typeof mm !== 'undefined' && mm.rows.find(r=> r.id === mrId)) || null;
      const line = mmRow ? '<div class="mt-now ' + mmRow.stage + '"><b>' + escapeHtml(mmLabel(mmRow.stage, data.mr.requested_by === currentUser.id)) + '</b>' +
        (mmRow.stage === 'done' ? '' : ' \u2014 waiting on <b>' + escapeHtml(mmRow.waiting_on || '') + '</b>' + (mmRow.days != null ? ' \u00B7 ' + escapeHtml(mmDays(mmRow.days)) : '')) + '</div>' : '';
      host.innerHTML = '<div class="mt-trail">' + line + mtCollectorHtml(data) +
        '<details class="mt-more"' + (todo ? ' open' : '') + '><summary>' + (todo ? 'What you need to do' : 'Show each item\u2019s steps') + '</summary>' +
        (items.length ? items.map(it=> mtItemHtml(it, data.money)).join('') : '<div class="empty-state">No items.</div>') + '</details></div>';
    }catch(e){
      const m = describeCloudError(e);
      host.innerHTML = '<div class="empty-state">' + (/mr_trail|PGRST202|42883/.test(m) ? 'The trail needs migration 20261025_01_materials_trail_and_issue.sql to be run in Supabase (it is inside RUN_THIS_IN_SUPABASE.sql).' : 'Couldn\u2019t load the trail: ' + escapeHtml(m)) + '</div>';
    }
  }
  const mtRefresh = (host)=> host && host._mt ? mtMountTrail(host, host._mt.mrId) : null;

  // ---------- small form dialog (receive / purchase) ----------
  function mtDialog(title, bodyHtml, okLabel, onOk){
    let ov = $('mtOverlay');
    if(!ov){
      ov = document.createElement('div'); ov.id = 'mtOverlay'; ov.className = 'overlay';
      ov.innerHTML = '<div class="sheet"><div class="sheet-head"><h3></h3><button type="button" class="sheet-x" data-mt-x aria-label="Close">\u00D7</button></div><div class="sheet-body" id="mtBody"></div><div class="sheet-foot"><button type="button" class="btn btn-secondary" data-mt-x>Cancel</button><button type="button" class="btn btn-primary" id="mtOk"></button></div></div>';
      document.body.appendChild(ov);
      ov.addEventListener('click', (e)=>{ if(e.target === ov || e.target.closest('[data-mt-x]')) ov.classList.remove('open'); });
    }
    ov.querySelector('h3').textContent = title;
    $('mtBody').innerHTML = bodyHtml;
    const ok = $('mtOk'); ok.textContent = okLabel; ok.disabled = false;
    ok.onclick = async ()=>{ ok.disabled = true; try{ const done = await onOk($('mtBody')); if(done !== false) ov.classList.remove('open'); }finally{ ok.disabled = false; } };
    ov.style.zIndex = '99'; ov.classList.add('open');
  }
  async function mtUploadPhoto(file, prefix){
    if(!file) return '';
    const path = currentUser.id + '/' + prefix + '-' + Date.now() + '.jpg';
    const up = await db.storage.from(MR_PHOTO_BUCKET).upload(path, file, { contentType: file.type || 'image/jpeg', upsert:false });
    if(up.error) throw up.error;
    return path;
  }
  const mtErr = (e)=> { const m = describeCloudError(e); return m.replace(/^.*?:\s*(?=[A-Z])/, ''); };

  function mtReceiveDialog(host, it){
    const left = Math.max(0, Number(it.po_qty) - Number(it.po_received));
    mtDialog('I received this',
      '<p class="mt-dlg-p"><b>' + escapeHtml(it.description) + '</b><br>' + mtQty(left) + ' ' + escapeHtml(it.unit || '') + ' still to arrive on ' + escapeHtml((it.po && it.po.po_no) || 'the PO') + '.</p>' +
      '<div class="field"><label>How many did you receive?</label><input type="text" inputmode="decimal" data-f="qty" value="' + escapeHtml(String(left)) + '"></div>' +
      '<div class="field"><label>Note <span class="mt-hint">optional</span></label><input type="text" data-f="note" placeholder="e.g. delivered to the site, signed by the guard"></div>' +
      '<div class="field"><label>Photo <span class="mt-hint">optional</span></label><input type="file" accept="image/*" data-f="photo"></div>' +
      '<p class="mt-dlg-hint">This records that the goods are with you. It does not add stock to a warehouse.</p>',
      'Save receipt', async (body)=>{
        const qty = Number(body.querySelector('[data-f="qty"]').value.replace(/,/g, ''));
        if(!(qty > 0)){ toast('Enter how many you received'); return false; }
        if(qty > left + 1e-9){ toast('Only ' + mtQty(left) + ' is left to receive'); return false; }
        try{
          const photo = await mtUploadPhoto(body.querySelector('[data-f="photo"]').files[0], 'received');
          const { data, error } = await db.rpc('po_worker_receive', { p: { po_item_id: it.po_item_id, qty, note: body.querySelector('[data-f="note"]').value.trim(), photo_path: photo } });
          if(error) throw error;
          toast('Saved \u2014 ' + (data && Number(data.left) > 0 ? mtQty(data.left) + ' still to arrive' : 'all received'));
          if(host._mt && typeof notifyAdmins === 'function') notifyAdmins('Materials received by a worker', (host._mt.trail.mr.mrf_no || '') + ': ' + mtQty(qty) + ' ' + (it.unit || '') + ' of ' + it.description + ' \u2014 ' + (currentUser.name || 'a worker'), 'mt-rcv-' + it.id);
          mtRefresh(host);
        }catch(e){ toast('Couldn\u2019t save: ' + mtErr(e)); return false; }
      });
  }
  function mtBuyDialog(host, it, money){
    const left = Math.max(0, Number(it.qty_need) - Number(it.bought_qty));
    mtDialog('I bought this',
      '<p class="mt-dlg-p"><b>' + escapeHtml(it.description) + '</b><br>' + mtQty(left) + ' ' + escapeHtml(it.unit || '') + ' still to buy.</p>' +
      '<div class="field"><label>How many did you buy?</label><input type="text" inputmode="decimal" data-f="qty" value="' + escapeHtml(String(left)) + '"></div>' +
      '<div class="field"><label>Price for each (\u20B1)</label><input type="text" inputmode="decimal" data-f="price" placeholder="0.00"></div>' +
      '<div class="field"><label>Store</label><input type="text" data-f="store" placeholder="e.g. Hardware Depot, Pasay"></div>' +
      '<div class="field"><label>Date bought</label><input type="date" data-f="date" value="' + escapeHtml(poToday()) + '" max="' + escapeHtml(poToday()) + '"></div>' +
      '<div class="field"><label>Photo of the receipt</label><input type="file" accept="image/*" data-f="photo"></div>',
      'Save purchase', async (body)=>{
        const f = (k)=> body.querySelector('[data-f="' + k + '"]');
        const qty = Number(f('qty').value.replace(/,/g, '')), price = Number(String(f('price').value || '0').replace(/[\u20B1,\s]/g, ''));
        if(!(qty > 0)){ toast('Enter how many you bought'); return false; }
        if(qty > left + 1e-9){ toast('Only ' + mtQty(left) + ' is left to buy'); return false; }
        if(!isFinite(price) || price < 0){ toast('Enter the price for each'); return false; }
        if(!f('store').value.trim()){ toast('Enter the store'); return false; }
        try{
          const receipt = await mtUploadPhoto(f('photo').files[0], 'receipt');
          const { data, error } = await db.rpc('mr_record_purchase', { p: { mr_item_id: it.id, qty, unit_price: price, store: f('store').value.trim(), purchased_on: f('date').value, receipt_path: receipt, note: '' } });
          if(error) throw error;
          toast('Saved \u2014 ' + (data && Number(data.left) > 0 ? mtQty(data.left) + ' still to buy' : 'all bought'));
          if(typeof notifyAdmins === 'function') notifyAdmins('Materials bought by a worker', (host._mt.trail.mr.mrf_no || '') + ': ' + mtQty(qty) + ' ' + (it.unit || '') + ' of ' + it.description + ' \u2014 ' + (currentUser.name || 'a worker'), 'mt-buy-' + it.id);
          mtRefresh(host);
        }catch(e){ toast('Couldn\u2019t save: ' + mtErr(e)); return false; }
      });
  }

  // one delegated handler for every mounted trail
  document.addEventListener('change', (ev)=>{
    const sel = ev.target.closest && ev.target.closest('[data-mt-collector]'); if(!sel) return;
    const btn = sel.closest('.mt-collector').querySelector('[data-mt-act="setcollector"]'); if(btn) btn.style.display = '';
  });
  document.addEventListener('click', async (ev)=>{
    const b = ev.target.closest && ev.target.closest('[data-mt-act]'); if(!b) return;
    const host = b.closest('.mt-trail') && b.closest('.mt-trail').parentElement; if(!host || !host._mt) return;
    const act = b.getAttribute('data-mt-act'), t = host._mt.trail;
    if(act === 'setcollector'){
      const sel = host.querySelector('[data-mt-collector]');
      b.disabled = true;
      try{
        const { error } = await db.rpc('mr_set_collector', { p_mr: host._mt.mrId, p_collector: sel.value || null });
        if(error) throw error;
        toast(sel.value ? 'Saved \u2014 ' + sel.options[sel.selectedIndex].text + ' collects' : 'Saved \u2014 the requester collects');
        if(sel.value) notifyUser(sel.value, 'You will collect materials', (t.mr.mrf_no || '') + ' \u2014 ' + (t.mr.requester_name || 'a worker') + ' named you to collect them.', 'mt-col-' + host._mt.mrId);
        mtRefresh(host);
      }catch(e){ toast('Couldn\u2019t save: ' + mtErr(e)); b.disabled = false; }
      return;
    }
    const it = (t.items || []).find(x=> x.id === b.getAttribute('data-item')); if(!it) return;
    if(act === 'receive'){
      if(!it.po_item_id){ toast('Couldn\u2019t find the order line \u2014 ask the office'); return; }
      mtReceiveDialog(host, it);
    }else if(act === 'buy') mtBuyDialog(host, it, t.money);
  });

  // ---------- list rows: one little path per item ----------
  async function mtFillProgress(list, ids){
    if(!list || !ids.length) return;
    try{
      const { data, error } = await db.rpc('mr_progress', { p_ids: ids });
      if(error || !data) return;
      list.querySelectorAll('[data-dots]').forEach(el=>{
        const arr = data[el.getAttribute('data-dots')];
        if(!arr || !arr.length){ el.innerHTML = ''; return; }
        el.innerHTML = arr.map(p=> '<span class="mt-mini" title="' + escapeHtml(p >= 6 ? 'Returned' : p >= 5 ? 'Handed over' : p >= 4 ? 'Arrived' : p >= 3 ? 'Being bought / ordered' : p >= 2 ? 'Approved' : 'Sent') + '">' +
          MT_STEPS.slice(0, 5).map((_, i)=> '<i class="' + (i < Math.min(p, 5) ? 'on' : i === Math.min(p, 5) ? 'next' : '') + '"></i>').join('') + '</span>').join('');
      });
    }catch(e){}
  }

  // ---------- the office picks WHO buys (any worker) ----------
  function mtChooseBuyer(count, requesterName, requesterId){
    return new Promise(async (resolve)=>{
      await mtLoadWorkers();
      mtDialog('Who buys ' + (count === 1 ? 'this item' : 'these ' + count + ' items') + '?',
        '<p class="mt-dlg-p">Any worker can buy it. They record the store, price and receipt in My Requests.</p>' +
        '<div class="field"><label>Buyer</label><select data-f="buyer">' + mtWorkerOptions('', requesterName + ' (the requester)', requesterId) + '</select></div>',
        'Mark as bought by them', async (body)=>{ resolve(body.querySelector('[data-f="buyer"]').value || ''); });
      const ov = $('mtOverlay');
      const onClose = (e)=>{ if(e.target === ov || (e.target.closest && e.target.closest('[data-mt-x]'))){ ov.removeEventListener('click', onClose); resolve(null); } };
      ov.addEventListener('click', onClose);
    });
  }

  // =====================================================================
  // Materials Monitor — the SIMPLE view: five stages, one list, one answer per request:
  // "who has to act next, and for how many days?"   (mr_monitor, migration 20261026_01)
  //   To approve > Being bought > Ready to hand over > Waiting for signature > Done
  // =====================================================================
  const MM_STAGES = [
    { k:'approval', label:'To approve',            mine:'Waiting for approval' },
    { k:'buying',   label:'Being bought',          mine:'Being bought' },
    { k:'ready',    label:'Ready to hand over',    mine:'Ready to collect' },
    { k:'sign',     label:'Waiting for signature', mine:'Sign for it' },
    { k:'done',     label:'Done',                  mine:'Done' }
  ];
  const mm = { rows:[], stage:'', loaded:false, ok:true };
  const mmLabel = (k, mine)=> (MM_STAGES.find(s=> s.k === k) || {})[mine ? 'mine' : 'label'] || k;
  const mmDays = (n)=> n == null ? '' : n === 0 ? 'today' : n === 1 ? '1 day' : n + ' days';

  async function mmLoad(){
    try{
      const { data, error } = await db.rpc('mr_monitor', { p_days: 60 });
      if(error) throw error;
      mm.rows = (data && data.rows) || []; mm.ok = true; mm.error = null;
    }catch(e){
      mm.rows = []; mm.ok = false;
      mm.error = /mr_monitor|PGRST202|42883/.test(describeCloudError(e)) ? 'The monitor needs migration 20261026_01_materials_monitor.sql to be run in Supabase (it is inside RUN_THIS_IN_SUPABASE.sql).' : 'Couldn\u2019t load the monitor: ' + describeCloudError(e);
    }
    mm.loaded = true;
    return mm.ok;
  }
  const mmCount = (k)=> mm.rows.filter(r=> r.stage === k).length;

  function mmRowHtml(r, mine){
    const sub = r.stage === 'done' ? 'Everything handed over' : 'Waiting on <b>' + escapeHtml(r.waiting_on || '') + '</b>' + (r.days != null ? ' \u00B7 ' + escapeHtml(mmDays(r.days)) : '');
    const jo = r.job_order ? r.job_order.id + (r.job_order.custName ? ' \u00B7 ' + r.job_order.custName : '') : '';
    const part = r.total > 1 && r.stage !== 'approval' ? (r.counts.done || 0) + ' of ' + r.total + ' items done' : '';
    return '<button type="button" class="mm-row ' + r.stage + '" data-id="' + escapeHtml(r.id) + '"><span class="mm-bar"></span><span class="mm-main">' +
      '<span class="mm-top"><b>' + escapeHtml(r.mrf_no) + '</b>' + (mine ? '' : ' \u00B7 ' + escapeHtml(r.requester_name || 'Worker')) + (r.late ? ' <span class="mm-late">Late</span>' : '') +
      (r.urgency && r.urgency !== 'normal' ? ' <span class="mm-late">' + escapeHtml(r.urgency === 'emergency' ? 'Emergency' : 'Urgent') + '</span>' : '') + '</span>' +
      '<span class="mm-stage">' + escapeHtml(mmLabel(r.stage, mine)) + '</span>' +
      '<span class="mm-sub">' + sub + '</span>' +
      (jo || part ? '<span class="mm-meta">' + escapeHtml([jo, part].filter(Boolean).join(' \u00B7 ')) + '</span>' : '') + '</span></button>';
  }
  function mmSorted(rows){
    const rank = { approval:0, buying:1, ready:2, sign:3, done:4 };
    return rows.slice().sort((a, b)=> (b.late ? 1 : 0) - (a.late ? 1 : 0) || rank[a.stage] - rank[b.stage] || (b.days || 0) - (a.days || 0));
  }

  // ---------- office: tiles + one list ----------
  function mmRenderOffice(){
    const tiles = $('mmTiles'), list = $('mmList'); if(!tiles || !list) return;
    if(!mm.ok){ tiles.innerHTML = ''; $('mmTitle').textContent = ''; list.innerHTML = '<div class="empty-state">' + escapeHtml(mm.error || '') + '</div>'; return; }
    tiles.innerHTML = MM_STAGES.map(s=> '<button type="button" class="mm-tile ' + s.k + (mm.stage === s.k ? ' on' : '') + '" data-stage="' + s.k + '"><span class="mm-n">' + mmCount(s.k) + '</span><span class="mm-l">' + escapeHtml(s.label) + '</span></button>').join('');
    const late = mm.rows.filter(r=> r.late).length;
    const rows = mm.stage ? mm.rows.filter(r=> r.stage === mm.stage) : mm.rows.filter(r=> r.stage !== 'done');
    $('mmTitle').innerHTML = (mm.stage ? escapeHtml(mmLabel(mm.stage)) + ' \u00B7 tap it again to see everything' : 'Everything that is not done yet') + (late ? ' <span class="mm-late">' + late + ' late</span>' : '');
    list.innerHTML = rows.length ? mmSorted(rows).map(r=> mmRowHtml(r, false)).join('') : '<div class="empty-state">' + (mm.rows.length ? 'Nothing here.' : 'No material requests yet.') + '</div>';
  }
  async function mmShowOffice(){
    if(!mm.loaded) $('mmList').innerHTML = '<div class="empty-state">Loading\u2026</div>';
    await mmLoad(); mmRenderOffice();
  }
  document.addEventListener('click', (ev)=>{
    const tile = ev.target.closest && ev.target.closest('#mmTiles [data-stage]');
    if(tile){ mm.stage = mm.stage === tile.dataset.stage ? '' : tile.dataset.stage; mmRenderOffice(); return; }
    const row = ev.target.closest && ev.target.closest('#mmList .mm-row');
    if(row){ mrOpen(row.dataset.id); return; }
    const tab = ev.target.closest && ev.target.closest('#mrTabs [data-tab]');
    if(tab){
      $$('#mrTabs .seg-tab').forEach(b=> b.classList.toggle('active', b === tab));
      $('mrMonitorView').style.display = tab.dataset.tab === 'monitor' ? '' : 'none';
      $('mrAllView').style.display = tab.dataset.tab === 'all' ? '' : 'none';
      if(tab.dataset.tab === 'monitor') mmShowOffice();
    }
  });

  // ---------- workers: three plain tiles + a plain line on each of their requests ----------
  function mmRenderMine(){
    const box = $('mmMyTiles'); if(!box) return;
    if(!mm.ok || !mm.rows.length){ box.innerHTML = ''; return; }
    const n = (ks)=> mm.rows.filter(r=> ks.includes(r.stage)).length;
    const mine = [['Waiting', ['approval', 'buying'], 'buying'], ['Ready for you', ['ready', 'sign'], 'ready'], ['Done', ['done'], 'done']];
    box.innerHTML = mine.map(m=> '<div class="mm-tile ' + m[2] + '"><span class="mm-n">' + n(m[1]) + '</span><span class="mm-l">' + m[0] + '</span></div>').join('');
  }
  async function mmFillMine(list){
    await mmLoad(); mmRenderMine();
    if(!list || !mm.ok) return;
    const by = new Map(mm.rows.map(r=> [r.id, r]));
    list.querySelectorAll('[data-chip]').forEach(el=>{
      const r = by.get(el.getAttribute('data-chip'));
      if(!r){ el.innerHTML = ''; return; }
      el.innerHTML = '<span class="mm-chip ' + r.stage + '">' + escapeHtml(mmLabel(r.stage, true)) + '</span>' +
        (r.stage === 'done' ? '' : '<span class="mm-chip-sub">Waiting on ' + escapeHtml(r.waiting_on || '') + (r.days != null ? ' \u00B7 ' + escapeHtml(mmDays(r.days)) : '') + '</span>') +
        (r.late ? '<span class="mm-late">Late</span>' : '');
    });
  }

  // office "All requests" rows get the same plain chip (from the already loaded monitor data)
  function mmFillChips(list){
    if(!list) return;
    const paint = ()=>{
      const by = new Map(mm.rows.map(r=> [r.id, r]));
      list.querySelectorAll('[data-chip]').forEach(el=>{
        const r = by.get(el.getAttribute('data-chip'));
        el.innerHTML = r ? '<span class="mm-chip ' + r.stage + '">' + escapeHtml(mmLabel(r.stage, false)) + '</span>' + (r.stage === 'done' ? '' : '<span class="mm-chip-sub">Waiting on ' + escapeHtml(r.waiting_on || '') + (r.days != null ? ' \u00B7 ' + escapeHtml(mmDays(r.days)) : '') + '</span>') + (r.late ? '<span class="mm-late">Late</span>' : '') : '';
      });
    };
    if(mm.loaded) paint(); else mmLoad().then(paint);
  }
