  // =====================================================================
  // Purchasing — Material Requisition (MRF)
  //
  // Technician side (purchPanel_myRequests): create / edit / submit own
  // requests for their job orders.  Admin side (purchPanel_requisitions):
  // review (approve with adjusted qty, return, reject), then fulfil
  // approved lines via Purchase Orders or "tech buys".
  //
  // The DATABASE enforces who may do what (migration
  // 20260923_06_material_requisitions.sql): numbering, ownership, job-order
  // assignment, locking, and the automatic approved⇄fulfilled switch.
  // =====================================================================

  const MR_URGENCY = { normal:'Normal', urgent:'Urgent', emergency:'Emergency' };
  const MR_STATUS_LABEL = { draft:'Draft', submitted:'Submitted', returned:'Returned', approved:'Approved', rejected:'Rejected', cancelled:'Cancelled', fulfilled:'Fulfilled' };
  const MR_PHOTO_BUCKET = 'requisition-photos';

  function mrDate(d){ return d ? poDateLong(String(d).slice(0, 10)) : '—'; }
  function mrWhen(ts){ return ts ? new Date(ts).toLocaleString('en-PH', { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' }) : ''; }
  function mrQty(n){ return n == null || n === '' ? '—' : poQtyFmt(n); }
  function mrLineCovered(it){
    if(Number(it.qty_approved) === 0 && it.qty_approved !== null) return true;
    if(it.fulfilled_by === 'tech_buy') return true;
    if(it.fulfilled_by === 'stock') return true;   // set by the database once fully issued
    return !!(it.po_id && it.purchase_orders && it.purchase_orders.status !== 'cancelled');
  }
  // Techs don't need the admin's price list — just the active catalog.
  let mrCatalog = [];
  async function mrLoadCatalog(){
    if(currentUser && currentUser.role === 'admin' && typeof mtCache !== 'undefined' && mtCache.length){ mrCatalog = mtCache.filter(m=> m.isActive); return; }
    const { data, error } = await db.from('materials').select('id, code, name, family, unit, brand, specs, category').eq('is_active', true).order('name');
    if(error) throw error;
    mrCatalog = (data || []).map(r=> ({ id:r.id, code:r.code, name:r.name, family:r.family || '', unit:r.unit, brand:r.brand || '', specs:r.specs || {}, category:r.category }));
  }
  // Shared item-name autocomplete (technician form)
  function mrSuggest(input, onPick){
    const host = input.closest('.po-item-desc');
    let box = host.querySelector('.po-suggest');
    const words = input.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if(!words.length){ if(box) box.remove(); return; }
    const hits = mrCatalog.filter(m=>{
      const hay = [m.code, m.name, m.family, m.brand, mtSpecText(m.specs)].join(' ').toLowerCase();
      return words.every(w=> hay.includes(w));
    }).slice(0, 12);
    if(!hits.length){ if(box) box.remove(); return; }
    if(!box){ box = document.createElement('div'); box.className = 'po-suggest'; host.appendChild(box); }
    box.innerHTML = hits.map((m, i)=> mtSuggestBtn(m, i, escapeHtml(m.unit || ''))).join('');
    box.onclick = (e)=>{ const b = e.target.closest('[data-pick]'); if(b) onPick(b.dataset.pick); };
  }

  // =====================================================================
  // TECHNICIAN
  // =====================================================================
  let mrtCache = [];
  let mrtEditing = null;     // header row, or null for a new request
  let mrtItems = [];
  let mrtJobs = [];
  let mrtUrgency = 'normal';
  let mrtPhotoFile = null;
  let mrtDirty = false;
  let mrtKey = 0;
  let mrtChannel = null;

  async function mrtShow(){
    if(mrtFormVisible()){
      if(mrtDirty && !confirm('Discard the changes you haven\u2019t saved?')) return;
      mrtShowList();
    }
    mrtRealtimeStart();
    await mrtLoadList();
  }
  function mrtFormVisible(){ return $('mrtFormView').style.display !== 'none'; }
  function mrtShowList(){ $('mrtFormView').style.display = 'none'; $('mrtListView').style.display = ''; mrtEditing = null; mrtDirty = false; window.scrollTo({ top:0 }); }
  function mrtShowForm(){ $('mrtListView').style.display = 'none'; $('mrtFormView').style.display = ''; window.scrollTo({ top:0 }); }

  async function mrtLoadList(opts){
    const silent = !!(opts && opts.silent);
    const list = $('mrtList');
    if(!silent) list.innerHTML = '<div class="empty-state">Loading…</div>';
    if(!(await ensureCloud())){ if(!silent) list.innerHTML = '<div class="empty-state">Not connected — requests need a connection.</div>'; return false; }
    try{
      const { data, error } = await db.from('material_requisitions')
        .select('id, mrf_no, status, urgency, job_order, needed_by, created_at, review_note, material_requisition_items(count)')
        .eq('requested_by', currentUser.id).order('created_at', { ascending:false });
      if(error) throw error;
      mrtCache = data || [];
      mrtRenderList();
      return true;
    }catch(e){
      console.error('load my requests failed', describeCloudError(e));
      if(!silent) list.innerHTML = '<div class="empty-state">' + (purchIsAuthError(e) ? PURCH_EXPIRED_HTML : 'Couldn\u2019t load your requests: ' + escapeHtml(describeCloudError(e))) + '</div>';
      return false;
    }
  }
  function mrtRenderList(){
    const list = $('mrtList');
    if(!mrtCache.length){ list.innerHTML = '<div class="empty-state">No requests yet. Tap <b>+ New Material Request</b>.</div>'; return; }
    list.innerHTML = mrtCache.map(r=>{
      const n = r.material_requisition_items && r.material_requisition_items[0] ? r.material_requisition_items[0].count : 0;
      const jo = r.job_order ? r.job_order.id + (r.job_order.custName ? ' · ' + r.job_order.custName : '') : 'No job order';
      return '<button type="button" class="mt-row" data-id="' + escapeHtml(r.id) + '"><div class="mt-row-main">' +
        '<div class="mt-row-title"><span class="mt-code">' + escapeHtml(r.mrf_no) + '</span><span class="po-status ' + r.status + '">' + escapeHtml(MR_STATUS_LABEL[r.status] || r.status) + '</span>' +
        (r.urgency !== 'normal' ? ' <span class="mr-urg ' + r.urgency + '">' + escapeHtml(MR_URGENCY[r.urgency]) + '</span>' : '') + '</div>' +
        '<div class="sp-row-sub">' + escapeHtml(jo) + ' · ' + n + ' item' + (n === 1 ? '' : 's') + (r.needed_by ? ' · needed ' + escapeHtml(mrDate(r.needed_by)) : '') + '</div>' +
        (r.status === 'returned' || r.status === 'rejected' ? '<div class="sp-row-sub" style="color:#9A6212;">Admin: ' + escapeHtml(r.review_note) + '</div>' : '') +
        '</div></button>';
    }).join('');
  }
  $('mrtList').addEventListener('click', (e)=>{
    if(e.target.closest('[data-purch-reauth]')){ purchReauth().then(ok=>{ if(ok) mrtLoadList(); }); return; }
    const row = e.target.closest('.mt-row'); if(row) mrtOpen(row.dataset.id);
  });
  $('mrtNewBtn').addEventListener('click', ()=> mrtOpen(null));
  $('mrtBackBtn').addEventListener('click', ()=>{
    if(mrtDirty && !confirm('Discard the changes you haven\u2019t saved?')) return;
    mrtShowList(); mrtLoadList();
  });

  async function mrtOpen(id){
    if(!(await ensureCloud())){ toast('Not connected'); return; }
    try{
      const jobsP = (typeof dtListForWorker === 'function' ? dtListForWorker(currentUser.id) : Promise.resolve([])).catch(()=> []);
      await mrLoadCatalog();
      let h = null, items = [];
      if(id){
        const r = await db.from('material_requisitions').select('*').eq('id', id);
        if(r.error) throw r.error;
        h = r.data && r.data[0];
        if(!h){ toast('That request no longer exists'); mrtLoadList(); return; }
        const it = await db.from('material_requisition_items').select('*').eq('mr_id', id).order('line_no');
        if(it.error) throw it.error;
        items = it.data || [];
      }
      const jobs = await jobsP;
      mrtJobs = jobs.filter(j=> !(typeof dtIsTerminal === 'function' && dtIsTerminal(j)));
      mrtEditing = h;
      mrtItems = items.map(r=> ({ key: ++mrtKey, id: r.id, material_id: r.material_id, code: r.code, description: r.description, unit: r.unit, qty: r.qty_requested, qty_approved: r.qty_approved }));
      if(!mrtItems.length) mrtItems.push(mrtBlank());
      const keepJob = h && h.job_order_id;
      $('mrtJob').innerHTML = '<option value="">No job order (office / stock)</option>' +
        mrtJobs.map(j=> '<option value="' + escapeHtml(j.id) + '">' + escapeHtml(j.id + (j.custName ? ' — ' + j.custName : '')) + '</option>').join('') +
        (keepJob && !mrtJobs.some(j=> j.id === keepJob) ? '<option value="' + escapeHtml(keepJob) + '">' + escapeHtml(keepJob + (h.job_order && h.job_order.custName ? ' — ' + h.job_order.custName : '')) + '</option>' : '');
      $('mrtJob').value = keepJob || (mrtJobs.length === 1 && !h ? mrtJobs[0].id : '');
      $('mrtNeeded').value = h && h.needed_by ? h.needed_by : '';
      mrtUrgency = h ? h.urgency : 'normal';
      $$('#mrtUrgency [data-u]').forEach(b=> b.classList.toggle('on', b.dataset.u === mrtUrgency));
      $('mrtDeliver').value = h && h.deliver_to ? h.deliver_to : 'Job site';
      $('mrtPurpose').value = h ? h.purpose : '';
      $('mrtPhoto').value = ''; mrtPhotoFile = null;
      $('mrtPhotoPreview').innerHTML = '';
      if(h && h.photo_path){
        db.storage.from(MR_PHOTO_BUCKET).download(h.photo_path).then(async ({ data })=>{
          if(data) $('mrtPhotoPreview').innerHTML = '<img alt="Photo" src="' + await poBlobToDataUrl(data) + '">';
        }).catch(()=>{});
      }
      mrtApplyMode();
      mrtRenderItems();
      mrtRenderJobInfo();
      mrtDirty = false;
      mrtShowForm();
    }catch(e){ purchFail('Couldn\u2019t open the request: ', e); }
  }
  function mrtBlank(){ return { key: ++mrtKey, id: null, material_id: null, code: '', description: '', unit: '', qty: '', qty_approved: null }; }
  function mrtEditable(){ return !mrtEditing || mrtEditing.status === 'draft' || mrtEditing.status === 'returned'; }
  function mrtApplyMode(){
    const h = mrtEditing, st = h ? h.status : 'draft', ed = mrtEditable();
    $('mrtTitle').textContent = h ? h.mrf_no : 'New Request';
    $('mrtStatus').className = 'po-status ' + st;
    $('mrtStatus').textContent = h ? (MR_STATUS_LABEL[st] || st) : 'unsaved';
    const note = $('mrtNote');
    const msg = !h ? '' : st === 'returned' ? 'Returned for changes — Admin: ' + h.review_note + '. Edit and submit again.'
      : st === 'rejected' ? 'Rejected — Admin: ' + h.review_note
      : st === 'submitted' ? 'Submitted ' + mrWhen(h.submitted_at) + ' — waiting for admin review.'
      : st === 'approved' ? 'Approved by ' + (h.reviewer_name || 'admin') + ' ' + mrWhen(h.reviewed_at) + '. Quantities below are what was approved.'
      : st === 'fulfilled' ? 'Fulfilled — all approved items are being purchased.'
      : st === 'cancelled' ? 'Cancelled.' : '';
    note.textContent = msg;
    note.className = 'po-locked-note' + (st === 'rejected' || st === 'cancelled' ? ' cancelled' : '');
    note.style.display = msg ? '' : 'none';
    $$('#mrtFormView input, #mrtFormView select, #mrtFormView textarea').forEach(el=>{ el.disabled = !ed; });
    $$('#mrtUrgency button').forEach(b=>{ b.disabled = !ed; });
    $('mrtAddItem').style.display = ed ? '' : 'none';
    const b = (a, l, c)=> '<button type="button" class="btn ' + (c || 'btn-secondary') + '" data-mrt="' + a + '">' + l + '</button>';
    let html = '';
    if(ed) html = b('save', 'Save Draft') + b('submit', st === 'returned' ? 'Submit Again' : 'Submit Request', 'btn-primary');
    if(h && ['draft', 'submitted', 'returned'].includes(st)) html += b(st === 'draft' ? 'delete' : 'cancel', st === 'draft' ? 'Delete Draft' : 'Cancel Request', 'danger');
    $('mrtActions').innerHTML = html;
    $('mrtActions').style.display = html ? '' : 'none';
  }
  function mrtRenderJobInfo(){
    const j = mrtJobs.find(x=> x.id === $('mrtJob').value) || (mrtEditing && mrtEditing.job_order && mrtEditing.job_order.id === $('mrtJob').value ? mrtEditing.job_order : null);
    $('mrtJobInfo').textContent = j ? [j.custName, j.siteAddress].filter(Boolean).join(' · ') : (mrtJobs.length ? '' : 'You have no active job orders — you can still request for the office or stock.');
  }
  $('mrtJob').addEventListener('change', mrtRenderJobInfo);
  $('mrtUrgency').addEventListener('click', (e)=>{
    const b = e.target.closest('[data-u]'); if(!b || b.disabled) return;
    mrtUrgency = b.dataset.u; mrtDirty = true;
    $$('#mrtUrgency [data-u]').forEach(x=> x.classList.toggle('on', x === b));
  });
  $('mrtFormView').addEventListener('input', ()=>{ mrtDirty = true; });

  function mrtRenderItems(){
    const ed = mrtEditable(), dis = ed ? '' : ' disabled';
    const reviewed = mrtEditing && ['approved', 'fulfilled'].includes(mrtEditing.status);
    $('mrtItems').innerHTML = mrtItems.map((it, i)=>{
      const cut = reviewed && it.qty_approved != null && Number(it.qty_approved) !== Number(it.qty);
      return '<div class="mr-item" data-key="' + it.key + '"><div class="po-no">' + (i + 1) + '</div>' +
        '<div class="po-item-desc"><input type="text" data-f="description" value="' + escapeHtml(it.description) + '" placeholder="' + (i === 0 ? 'e.g. copper tube 3/8' : 'Item') + '" autocomplete="off"' + dis + '>' +
        '<div class="po-item-code">' + (it.material_id ? escapeHtml(it.code) : (it.description ? 'not in list' : '')) + '</div></div>' +
        '<input type="text" class="num mrq" data-f="qty" inputmode="decimal" placeholder="Qty" value="' + escapeHtml(it.qty === '' || it.qty == null ? '' : String(it.qty)) + '"' + dis + '>' +
        '<input type="text" class="mru" data-f="unit" list="mtUnitList" placeholder="Unit" value="' + escapeHtml(it.unit || '') + '"' + dis + '>' +
        (ed ? '<button type="button" class="po-rm" data-rm="1" title="Remove">&minus;</button>' : '<span></span>') +
        (reviewed ? '<div class="mr-appr' + (cut ? ' reduced' : '') + '">Approved: ' + mrQty(it.qty_approved) + ' ' + escapeHtml(it.unit || '') + (cut ? ' (you asked for ' + mrQty(it.qty) + ')' : '') + '</div>' : '') +
      '</div>';
    }).join('');
  }
  function mrtItemByEl(el){ const r = el.closest('.mr-item'); return r ? mrtItems.find(x=> String(x.key) === r.dataset.key) : null; }
  $('mrtItems').addEventListener('input', (e)=>{
    const it = mrtItemByEl(e.target), f = e.target.dataset.f;
    if(!it || !f) return;
    if(f === 'description'){
      it.description = e.target.value;
      if(it.material_id){ const m = mrCatalog.find(x=> x.id === it.material_id); if(!m || m.name !== it.description){ it.material_id = null; it.code = ''; } }
      e.target.closest('.mr-item').querySelector('.po-item-code').textContent = it.material_id ? it.code : (it.description ? 'not in list' : '');
      mrSuggest(e.target, (mid)=>{
        const m = mrCatalog.find(x=> x.id === mid); if(!m) return;
        Object.assign(it, { material_id: m.id, code: m.code, description: m.name, unit: m.unit });
        mrtRenderItems();
        const q = $('mrtItems').querySelector('.mr-item[data-key="' + it.key + '"] [data-f="qty"]'); if(q) q.focus();
      });
    }else if(f === 'qty') it.qty = e.target.value.trim() === '' ? '' : (poNum(e.target.value) == null ? e.target.value : poNum(e.target.value));
    else it[f] = e.target.value;
  });
  $('mrtItems').addEventListener('keydown', (e)=>{
    const box = e.target.closest('.po-item-desc') && e.target.closest('.po-item-desc').querySelector('.po-suggest');
    if(!box) return;
    const btns = Array.from(box.querySelectorAll('[data-pick]'));
    let i = btns.findIndex(b=> b.classList.contains('hl'));
    if(e.key === 'ArrowDown' || e.key === 'ArrowUp'){ e.preventDefault(); if(i >= 0) btns[i].classList.remove('hl'); i = e.key === 'ArrowDown' ? Math.min(btns.length - 1, i + 1) : Math.max(0, i - 1); if(btns[i]) btns[i].classList.add('hl'); }
    else if(e.key === 'Enter' && i >= 0){ e.preventDefault(); btns[i].click(); }
    else if(e.key === 'Escape') box.remove();
  });
  $('mrtItems').addEventListener('focusout', (e)=>{
    setTimeout(()=>{ const d = e.target.closest && e.target.closest('.po-item-desc'); if(d && !d.contains(document.activeElement)){ const b = d.querySelector('.po-suggest'); if(b) b.remove(); } }, 180);
  });
  $('mrtItems').addEventListener('click', (e)=>{
    if(!e.target.closest('[data-rm]')) return;
    const it = mrtItemByEl(e.target);
    mrtItems = mrtItems.filter(x=> x !== it);
    if(!mrtItems.length) mrtItems.push(mrtBlank());
    mrtDirty = true; mrtRenderItems();
  });
  $('mrtAddItem').addEventListener('click', ()=>{
    mrtItems.push(mrtBlank()); mrtRenderItems();
    const all = $('mrtItems').querySelectorAll('[data-f="description"]'); if(all.length) all[all.length - 1].focus();
  });
  $('mrtPhoto').addEventListener('change', async ()=>{
    const f = $('mrtPhoto').files && $('mrtPhoto').files[0];
    mrtPhotoFile = null; $('mrtPhotoPreview').innerHTML = '';
    if(!f) return;
    try{
      const c = await poImageToPng(f, 1400, 1400);        // shrink big phone photos
      mrtPhotoFile = await new Promise(res=> c.toBlob(res, 'image/jpeg', 0.82));
      $('mrtPhotoPreview').innerHTML = '<img alt="Photo" src="' + c.toDataURL('image/jpeg', 0.7) + '">';
      mrtDirty = true;
    }catch(e){ toast(e.message || 'Couldn\u2019t read that photo'); }
  });

  function mrtValidate(forSubmit){
    const rows = mrtItems.filter(it=> String(it.description || '').trim() || (it.qty !== '' && it.qty != null));
    for(let i = 0; i < rows.length; i++){
      const it = rows[i];
      if(!String(it.description || '').trim()) return 'Item ' + (i + 1) + ': what do you need?';
      const q = Number(it.qty);
      if(it.qty === '' || !isFinite(q) || q <= 0) return 'Item ' + (i + 1) + ' (' + it.description + '): enter how many';
    }
    if(forSubmit && !rows.length) return 'Add at least one item';
    return null;
  }
  async function mrtSave(submit){
    const err = mrtValidate(submit);
    if(err){ toast(err); return null; }
    if(!(await ensureCloud())){ toast('Not connected — can\u2019t save'); return null; }
    if(!(await purchEnsureSession())) return null;
    const header = {
      job_order_id: $('mrtJob').value || null, needed_by: $('mrtNeeded').value || null, urgency: mrtUrgency,
      deliver_to: $('mrtDeliver').value, purpose: $('mrtPurpose').value.trim()
    };
    try{
      let id = mrtEditing && mrtEditing.id;
      if(mrtPhotoFile){
        const path = currentUser.id + '/' + Date.now() + '.jpg';
        const up = await db.storage.from(MR_PHOTO_BUCKET).upload(path, mrtPhotoFile, { contentType:'image/jpeg', upsert:false });
        if(up.error) throw up.error;
        header.photo_path = path;
      }
      if(id){
        purchMarkOwn(id);
        const { error } = await db.from('material_requisitions').update(header).eq('id', id);
        if(error) throw error;
      }else{
        const { data, error } = await db.from('material_requisitions').insert(header).select('*').single();
        if(error) throw error;
        id = data.id; mrtEditing = data; purchMarkOwn(id);
      }
      const clean = mrtItems.filter(it=> String(it.description || '').trim());
      clean.forEach(it=>{ if(!it.id) it.id = poUuid(); });
      if(clean.length){
        const { error } = await db.from('material_requisition_items').upsert(clean.map((it, i)=> ({
          id: it.id, mr_id: id, line_no: i + 1, material_id: it.material_id || null, code: it.code || '',
          description: it.description.trim(), unit: (it.unit || '').trim(), qty_requested: Number(it.qty)
        })), { onConflict:'id' });
        if(error) throw error;
      }
      let del = db.from('material_requisition_items').delete().eq('mr_id', id);
      if(clean.length) del = del.not('id', 'in', '(' + clean.map(it=> it.id).join(',') + ')');
      const dr = await del; if(dr.error) throw dr.error;
      if(submit){
        purchMarkOwn(id);
        const { error } = await db.from('material_requisitions').update({ status:'submitted' }).eq('id', id);
        if(error) throw error;
      }
      const h = await db.from('material_requisitions').select('*').eq('id', id);
      if(h.error) throw h.error;
      mrtEditing = h.data[0];
      mrtPhotoFile = null; mrtDirty = false;
      if(submit){
        const who = currentUser.name || 'A technician';
        notifyAdmins('New material request', mrtEditing.mrf_no + ' from ' + who + ' — ' + clean.length + ' item' + (clean.length === 1 ? '' : 's') +
          (mrtEditing.urgency !== 'normal' ? ' (' + MR_URGENCY[mrtEditing.urgency].toUpperCase() + ')' : ''), 'mrf-' + mrtEditing.id);
        toast(mrtEditing.mrf_no + ' submitted — admin has been notified');
        mrtShowList(); mrtLoadList();
      }else{
        toast(mrtEditing.mrf_no + ' saved as draft');
        mrtApplyMode(); mrtRenderItems();
      }
      return mrtEditing;
    }catch(e){ purchFail('Couldn\u2019t save the request: ', e); return null; }
  }
  $('mrtActions').addEventListener('click', async (e)=>{
    const b = e.target.closest('[data-mrt]'); if(!b) return;
    const act = b.dataset.mrt;
    $$('#mrtActions .btn').forEach(x=>{ x.disabled = true; });
    try{
      if(act === 'save') await mrtSave(false);
      else if(act === 'submit'){ if(confirm('Submit this request to the admin? You can\u2019t edit it after submitting unless it\u2019s returned to you.')) await mrtSave(true); }
      else if(act === 'cancel' || act === 'delete'){
        if(!confirm(act === 'delete' ? 'Delete this draft?' : 'Cancel ' + mrtEditing.mrf_no + '?')) return;
        if(!(await purchEnsureSession())) return;
        purchMarkOwn(mrtEditing.id);
        const q = act === 'delete' ? db.from('material_requisitions').delete().eq('id', mrtEditing.id)
                                   : db.from('material_requisitions').update({ status:'cancelled' }).eq('id', mrtEditing.id);
        const { error } = await q; if(error) throw error;
        toast(act === 'delete' ? 'Draft deleted' : 'Request cancelled');
        mrtShowList(); mrtLoadList();
      }
    }catch(err){ purchFail('Couldn\u2019t update the request: ', err); }
    finally{ $$('#mrtActions .btn').forEach(x=>{ x.disabled = false; }); }
  });

  // Live status for the technician (own requests only — RLS + filter).
  function mrtRealtimeStart(){
    if(mrtChannel || !db || typeof db.channel !== 'function' || !currentUser) return;
    purchSetLive('connecting');
    mrtChannel = db.channel('mrf-tech-' + currentUser.id)
      .on('postgres_changes', { event:'*', schema:'public', table:'material_requisitions', filter:'requested_by=eq.' + currentUser.id }, (p)=>{
        const row = p && (p.new && p.new.id ? p.new : p.old);
        if(row && purchIsOwn(row.id)) return;
        clearTimeout(mrtChannel._t);
        mrtChannel._t = setTimeout(async ()=>{
          if($('purchPanel_myRequests').style.display === 'none') return;
          if(mrtFormVisible()){
            // reopen read-only views; never overwrite what the tech is typing
            if(mrtEditing && row && row.id === mrtEditing.id && !mrtDirty) mrtOpen(mrtEditing.id);
          }else mrtLoadList({ silent:true });
        }, 400);
      })
      .subscribe((st)=>{ purchSetLive(st === 'SUBSCRIBED' ? 'on' : (st === 'CHANNEL_ERROR' || st === 'TIMED_OUT' || st === 'CLOSED') ? 'off' : 'connecting'); });
  }
  function mrtRealtimeTeardown(){
    if(mrtChannel && db){ try{ db.removeChannel(mrtChannel); }catch(e){} }
    mrtChannel = null;
  }

  // =====================================================================
  // ADMIN
  // =====================================================================
  let mrCache = [];
  let mrOpenRow = null;      // header being reviewed
  let mrOpenItems = [];
  let mrQtyDraft = {};       // item id -> adjusted qty while reviewing
  let mrSelected = new Set();

  function mrDetailVisible(){ return $('mrDetailView').style.display !== 'none'; }
  async function mrShow(){
    if(mrDetailVisible()) mrShowListView();
    if(await mrLoadList()) mrRenderList();
  }
  function mrShowListView(){ $('mrDetailView').style.display = 'none'; $('mrListView').style.display = ''; $('purchasingView').classList.remove('po-wide'); mrOpenRow = null; }
  function mrShowDetailView(){ $('mrListView').style.display = 'none'; $('mrDetailView').style.display = ''; $('purchasingView').classList.add('po-wide'); window.scrollTo({ top:0 }); }

  async function mrLoadList(opts){
    const silent = !!(opts && opts.silent);
    const list = $('mrList');
    if(!silent) list.innerHTML = '<div class="empty-state">Loading…</div>';
    if(!(await ensureCloud())){ if(!silent) list.innerHTML = '<div class="empty-state">Not connected.</div>'; return false; }
    try{
      const { data, error } = await db.from('material_requisitions')
        .select('id, mrf_no, status, urgency, requester_name, job_order, needed_by, submitted_at, created_at, material_requisition_items(count)')
        .neq('status', 'draft').order('created_at', { ascending:false });
      if(error) throw error;
      mrCache = data || [];
      return true;
    }catch(e){
      console.error('load requisitions failed', describeCloudError(e));
      if(silent) return false;
      list.innerHTML = '<div class="empty-state">' + (purchIsAuthError(e) ? PURCH_EXPIRED_HTML
        : /42P01|does not exist/.test(describeCloudError(e)) ? 'The requisition tables aren\u2019t in the database yet — run migration 20260923_06_material_requisitions.sql first.'
        : 'Couldn\u2019t load requisitions: ' + escapeHtml(describeCloudError(e))) + '</div>';
      return false;
    }
  }
  function mrRenderList(){
    const f = $('mrFilterStatus').value, q = ($('mrSearch').value || '').trim().toLowerCase();
    const counts = mrCache.reduce((a, r)=>{ a[r.status] = (a[r.status] || 0) + 1; return a; }, {});
    $('mrCount').textContent = [counts.submitted ? counts.submitted + ' to review' : '', counts.approved ? counts.approved + ' to fulfil' : ''].filter(Boolean).join(' · ');
    const urgRank = { emergency:0, urgent:1, normal:2 };
    const rows = mrCache.filter(r=>{
      if(f === 'open' && !['submitted', 'approved'].includes(r.status)) return false;
      if(f && f !== 'open' && r.status !== f) return false;
      if(!q) return true;
      return [r.mrf_no, r.requester_name, r.job_order && r.job_order.id, r.job_order && r.job_order.custName].join(' ').toLowerCase().includes(q);
    }).sort((a, b)=> (a.status === 'submitted' ? 0 : 1) - (b.status === 'submitted' ? 0 : 1) || urgRank[a.urgency] - urgRank[b.urgency] || String(b.submitted_at || b.created_at).localeCompare(String(a.submitted_at || a.created_at)));
    const list = $('mrList');
    if(!rows.length){ list.innerHTML = '<div class="empty-state">' + (mrCache.length ? 'Nothing here.' : 'No requests yet. Technicians create them from their home screen.') + '</div>'; return; }
    list.innerHTML = rows.map(r=>{
      const n = r.material_requisition_items && r.material_requisition_items[0] ? r.material_requisition_items[0].count : 0;
      const jo = r.job_order ? r.job_order.id + (r.job_order.custName ? ' · ' + r.job_order.custName : '') : 'No job order';
      return '<button type="button" class="mt-row" data-id="' + escapeHtml(r.id) + '"><div class="mt-row-main">' +
        '<div class="mt-row-title"><span class="mt-code">' + escapeHtml(r.mrf_no) + '</span>' + escapeHtml(r.requester_name || 'Technician') +
        ' <span class="po-status ' + r.status + '">' + escapeHtml(MR_STATUS_LABEL[r.status]) + '</span>' +
        (r.urgency !== 'normal' ? ' <span class="mr-urg ' + r.urgency + '">' + escapeHtml(MR_URGENCY[r.urgency]) + '</span>' : '') + '</div>' +
        '<div class="sp-row-sub">' + escapeHtml(jo) + ' · ' + n + ' item' + (n === 1 ? '' : 's') + (r.needed_by ? ' · needed ' + escapeHtml(mrDate(r.needed_by)) : '') +
        (r.submitted_at ? ' · sent ' + escapeHtml(mrWhen(r.submitted_at)) : '') + '</div></div></button>';
    }).join('');
  }
  $('mrSearch').addEventListener('input', mrRenderList);
  $('mrFilterStatus').addEventListener('change', mrRenderList);
  $('mrList').addEventListener('click', (e)=>{
    if(e.target.closest('[data-purch-reauth]')){ purchReauth().then(ok=>{ if(ok) mrShow(); }); return; }
    const row = e.target.closest('.mt-row'); if(row) mrOpen(row.dataset.id);
  });
  $('mrBackBtn').addEventListener('click', ()=>{ mrShowListView(); mrShow(); });
  $('mrStaleReload').addEventListener('click', ()=>{ if(mrOpenRow) mrOpen(mrOpenRow.id); });

  async function mrOpen(id){
    try{
      if(!mtCache.length) await mtLoad({ silent:true }).catch(()=>{});
      const [h, it] = await Promise.all([
        db.from('material_requisitions').select('*').eq('id', id),
        db.from('material_requisition_items').select('*, purchase_orders(id, po_no, status)').eq('mr_id', id).order('line_no')
      ]);
      if(h.error) throw h.error; if(it.error) throw it.error;
      mrOpenRow = h.data && h.data[0];
      if(!mrOpenRow){ toast('That request no longer exists'); mrShow(); return; }
      mrOpenItems = it.data || [];
      mrQtyDraft = {}; mrSelected = new Set();
      $('mrStaleNote').style.display = 'none';
      mrRenderDetail();
      mrShowDetailView();
    }catch(e){ purchFail('Couldn\u2019t open the request: ', e); }
  }
  function mrRenderDetail(){
    const h = mrOpenRow, st = h.status;
    $('mrTitle').textContent = h.mrf_no;
    $('mrStatus').className = 'po-status ' + st; $('mrStatus').textContent = MR_STATUS_LABEL[st];
    $('mrUrgency').className = 'mr-urg ' + h.urgency; $('mrUrgency').textContent = h.urgency !== 'normal' ? MR_URGENCY[h.urgency] : '';
    const jo = h.job_order;
    const kv = (k, v, wide)=> '<div' + (wide ? ' class="wide"' : '') + '><div class="k">' + k + '</div><div class="v">' + (v || '—') + '</div></div>';
    $('mrInfo').innerHTML =
      kv('Requested by', escapeHtml(h.requester_name || 'Technician') + (h.submitted_at ? '<div class="sp-row-sub">' + escapeHtml(mrWhen(h.submitted_at)) + '</div>' : '')) +
      kv('Job order', jo ? '<b>' + escapeHtml(jo.id) + '</b><div class="sp-row-sub">' + escapeHtml([jo.custName, jo.siteAddress].filter(Boolean).join(' · ')) + '</div>' : 'None — office / stock') +
      kv('Needed by', escapeHtml(mrDate(h.needed_by))) +
      kv('Deliver to', escapeHtml(h.deliver_to)) +
      (h.purpose ? kv('Purpose / notes', escapeHtml(h.purpose), true) : '') +
      (h.review_note ? kv(st === 'rejected' ? 'Rejected — reason' : st === 'returned' ? 'Returned — reason' : 'Admin note', escapeHtml(h.review_note), true) : '') +
      (h.reviewed_at ? kv('Reviewed', escapeHtml((h.reviewer_name || 'Admin') + ' · ' + mrWhen(h.reviewed_at))) : '') +
      (h.photo_path ? '<div class="wide"><div class="k">Photo</div><div class="mr-photo" id="mrPhotoBox">Loading photo…</div></div>' : '');
    if(h.photo_path){
      db.storage.from(MR_PHOTO_BUCKET).download(h.photo_path).then(async ({ data })=>{
        const box = document.getElementById('mrPhotoBox'); if(box)   // re-created per open, so not via the cached $()
        box.innerHTML = data ? '<img alt="Photo" src="' + await poBlobToDataUrl(data) + '">' : 'Photo unavailable';
      }).catch(()=>{});
    }
    const reviewing = st === 'submitted';
    const fulfilling = st === 'approved' || st === 'fulfilled';
    const head = '<thead><tr>' + (fulfilling ? '<th style="width:28px;"><input type="checkbox" id="mrSelAll" title="Select all open lines"></th>' : '') +
      '<th>#</th><th>Item</th><th class="num">Requested</th><th class="num">' + (reviewing ? 'Approve' : 'Approved') + '</th><th>Unit</th>' + (fulfilling ? '<th>Fulfilment</th>' : '') + '</tr></thead>';
    const body = mrOpenItems.map((it, i)=>{
      const covered = mrLineCovered(it);
      const appr = it.qty_approved;
      const cut = appr != null && Number(appr) !== Number(it.qty_requested);
      let cov = '';
      if(fulfilling){
        if(Number(appr) === 0) cov = '<span class="cov ok">Not needed</span>';
        else if(it.fulfilled_by === 'tech_buy') cov = '<span class="cov ok">Tech buys</span>';
        else if(it.fulfilled_by === 'stock') cov = '<span class="cov ok">Issued from stock</span>';
        else if(Number(it.qty_issued) > 0) cov = '<span class="cov open">' + mrQty(it.qty_issued) + ' of ' + mrQty(appr) + ' issued from stock</span>';
        else if(it.po_id && it.purchase_orders) cov = '<span class="cov ' + (it.purchase_orders.status === 'cancelled' ? 'open' : 'ok') + '"><a data-open-po="' + escapeHtml(it.po_id) + '">' +
          escapeHtml(it.purchase_orders.po_no) + '</a> ' + escapeHtml(it.purchase_orders.status) + (it.purchase_orders.status === 'cancelled' ? ' — needs a new PO' : '') + '</span>';
        else cov = '<span class="cov open">Not yet</span>';
      }
      return '<tr data-id="' + escapeHtml(it.id) + '">' +
        (fulfilling ? '<td>' + (covered ? '' : '<input type="checkbox" class="mr-sel"' + (mrSelected.has(it.id) ? ' checked' : '') + '>') + '</td>' : '') +
        '<td>' + (i + 1) + '</td><td><b>' + escapeHtml(it.description) + '</b><div class="sp-row-sub">' + (it.material_id ? escapeHtml(it.code) : 'typed by the technician — not linked to the catalog') + (it.note ? ' · ' + escapeHtml(it.note) : '') + '</div>' +
          (!it.material_id && ['submitted', 'approved'].includes(st) && !it.po_id ? '<div class="po-item-desc mr-link"><input type="text" data-link="1" placeholder="Link to catalog item…" autocomplete="off"></div>' : '') + '</td>' +
        '<td class="num">' + mrQty(it.qty_requested) + '</td>' +
        '<td class="num">' + (reviewing
          ? '<input type="text" class="mr-qty" inputmode="decimal" value="' + escapeHtml(String(mrQtyDraft[it.id] != null ? mrQtyDraft[it.id] : (appr != null ? appr : it.qty_requested))) + '">'
          : '<span class="' + (cut ? 'reduced' : '') + '">' + mrQty(appr) + '</span>') + '</td>' +
        '<td>' + escapeHtml(it.unit || '') + '</td>' + (fulfilling ? '<td>' + cov + '</td>' : '') + '</tr>';
    }).join('');
    $('mrItemsTable').innerHTML = head + '<tbody>' + body + '</tbody>';
    $('mrItemsHint').textContent = reviewing ? 'Lower a quantity to approve less than requested, or set it to 0 if the item isn\u2019t needed.'
      : fulfilling ? (mrOpenItems.some(it=> !mrLineCovered(it)) ? 'Tick the open lines, then create Purchase Orders for them or mark them as bought by the technician.' : 'Every approved line is covered.') : '';
    const b = (a, l, c)=> '<button type="button" class="btn ' + (c || 'btn-secondary') + '" data-mr="' + a + '">' + l + '</button>';
    let html = '';
    if(reviewing) html = b('return', 'Return for Changes') + b('reject', 'Reject', 'danger') + b('approve', 'Approve', 'btn-primary');
    else if(fulfilling){
      if(mrOpenItems.some(it=> !mrLineCovered(it))) html = b('techbuy', 'Mark: Tech Buys') + b('createpo', 'Create PO(s)', 'btn-primary');
      html += b('pdf', 'View PDF');
      if(st === 'approved') html += b('cancel', 'Cancel Request', 'danger');
    }else html = b('pdf', 'View PDF');
    $('mrActions').innerHTML = html;
  }
  // Link a technician's typed line to a Materials Database item (needed
  // before it can go on a Purchase Order, which accepts catalog items only)
  // keyboard for the link box: ↑/↓ to move, Enter to pick, Esc to close
  $('mrItemsTable').addEventListener('keydown', (e)=>{
    if(!e.target.dataset || !e.target.dataset.link) return;
    const box = e.target.closest('.po-item-desc').querySelector('.po-suggest'); if(!box) return;
    const btns = Array.from(box.querySelectorAll('[data-pick]')); let i = btns.findIndex(b=> b.classList.contains('hl'));
    if(e.key === 'ArrowDown' || e.key === 'ArrowUp'){ e.preventDefault(); if(i >= 0) btns[i].classList.remove('hl'); i = e.key === 'ArrowDown' ? Math.min(btns.length - 1, i + 1) : Math.max(0, i - 1); if(btns[i]) btns[i].classList.add('hl'); }
    else if(e.key === 'Enter' && i >= 0){ e.preventDefault(); btns[i].click(); }
    else if(e.key === 'Escape') box.remove();
  });
  $('mrItemsTable').addEventListener('input', (e)=>{
    if(!e.target.dataset.link) return;
    const id = e.target.closest('tr').dataset.id;
    mrCatalog = mtCache.filter(m=> m.isActive);
    mrSuggest(e.target, async (mid)=>{
      const m = mtCache.find(x=> x.id === mid); if(!m) return;
      if(!(await purchEnsureSession())) return;
      const { error } = await db.from('material_requisition_items').update({ material_id: m.id, code: m.code }).eq('id', id);
      if(error){ purchFail('Couldn\u2019t link it: ', error); return; }
      toast('Linked to ' + m.code + ' ' + m.name);
      mrOpen(mrOpenRow.id);
    });
  });
  $('mrItemsTable').addEventListener('input', (e)=>{
    if(!e.target.classList.contains('mr-qty')) return;
    mrQtyDraft[e.target.closest('tr').dataset.id] = e.target.value;
  });
  $('mrItemsTable').addEventListener('change', (e)=>{
    if(e.target.id === 'mrSelAll'){
      mrOpenItems.filter(it=> !mrLineCovered(it)).forEach(it=>{ if(e.target.checked) mrSelected.add(it.id); else mrSelected.delete(it.id); });
      $$('#mrItemsTable .mr-sel').forEach(x=>{ x.checked = e.target.checked; });
    }else if(e.target.classList.contains('mr-sel')){
      const id = e.target.closest('tr').dataset.id;
      if(e.target.checked) mrSelected.add(id); else mrSelected.delete(id);
    }
  });
  $('mrItemsTable').addEventListener('click', (e)=>{
    const a = e.target.closest('[data-open-po]'); if(!a) return;
    const poId = a.dataset.openPo;
    showPurchasingView('purchaseOrders');
    setTimeout(()=> poOpen(poId), 50);
  });

  $('mrActions').addEventListener('click', async (e)=>{
    const b = e.target.closest('[data-mr]'); if(!b) return;
    const act = b.dataset.mr;
    $$('#mrActions .btn').forEach(x=>{ x.disabled = true; });
    try{
      if(act === 'approve') await mrApprove();
      else if(act === 'return' || act === 'reject') await mrReturnOrReject(act);
      else if(act === 'techbuy') await mrMarkTechBuy();
      else if(act === 'createpo') await mrCreatePos();
      else if(act === 'pdf') await mrShowPdf();
      else if(act === 'cancel'){
        if(!confirm('Cancel ' + mrOpenRow.mrf_no + '? Lines already on Purchase Orders stay on them.')) return;
        await mrSetStatus({ status:'cancelled' }, 'Request cancelled');
      }
    }finally{ $$('#mrActions .btn').forEach(x=>{ x.disabled = false; }); }
  });
  async function mrSetStatus(patch, msg){
    if(!(await purchEnsureSession())) return false;
    try{
      purchMarkOwn(mrOpenRow.id);
      const { error } = await db.from('material_requisitions').update(patch).eq('id', mrOpenRow.id);
      if(error) throw error;
      toast(msg);
      await mrOpen(mrOpenRow.id);
      mrLoadList({ silent:true }).then(ok=>{ if(ok) mrRenderList(); });
      return true;
    }catch(err){ purchFail('Couldn\u2019t update the request: ', err); return false; }
  }
  async function mrApprove(){
    // validate adjusted quantities
    const updates = [];
    for(const it of mrOpenItems){
      const raw = mrQtyDraft[it.id];
      if(raw == null) continue;
      const n = spParseMoney(raw);
      if(n == null || Number.isNaN(n)){ toast(it.description + ': enter a quantity (0 = not needed)'); return; }
      if(n > Number(it.qty_requested)){ toast(it.description + ': can\u2019t approve more than requested (' + mrQty(it.qty_requested) + ')'); return; }
      if(n !== Number(it.qty_approved != null ? it.qty_approved : it.qty_requested)) updates.push({ id: it.id, qty_approved: n });
    }
    const reduced = updates.filter(u=> u.qty_approved < Number(mrOpenItems.find(x=> x.id === u.id).qty_requested)).length;
    if(!confirm('Approve ' + mrOpenRow.mrf_no + (reduced ? ' with ' + reduced + ' reduced quantit' + (reduced === 1 ? 'y' : 'ies') : ' as requested') + '? The technician will be notified.')) return;
    if(!(await purchEnsureSession())) return;
    try{
      for(const u of updates){
        const { error } = await db.from('material_requisition_items').update({ qty_approved: u.qty_approved }).eq('id', u.id);
        if(error) throw error;
      }
    }catch(err){ purchFail('Couldn\u2019t save the quantities: ', err); return; }
    if(await mrSetStatus({ status:'approved' }, mrOpenRow.mrf_no + ' approved')){
      notifyUser(mrOpenRow.requested_by, 'Material request approved', mrOpenRow.mrf_no + (reduced ? ' was approved with some quantities reduced.' : ' was approved.'), 'mrf-' + mrOpenRow.id);
    }
  }
  async function mrReturnOrReject(kind){
    const reason = prompt(kind === 'reject' ? 'Reject ' + mrOpenRow.mrf_no + '. Reason (the technician will see this):' : 'Return ' + mrOpenRow.mrf_no + ' to the technician for changes. What should they change?');
    if(reason === null) return;
    if(!reason.trim()){ toast('Please give a reason'); return; }
    const ok = await mrSetStatus({ status: kind === 'reject' ? 'rejected' : 'returned', review_note: reason.trim() }, mrOpenRow.mrf_no + (kind === 'reject' ? ' rejected' : ' returned to the technician'));
    if(ok) notifyUser(mrOpenRow.requested_by, kind === 'reject' ? 'Material request rejected' : 'Material request needs changes', mrOpenRow.mrf_no + ': ' + reason.trim(), 'mrf-' + mrOpenRow.id);
  }
  function mrSelectedOpen(){ return mrOpenItems.filter(it=> mrSelected.has(it.id) && !mrLineCovered(it)); }
  async function mrMarkTechBuy(){
    const sel = mrSelectedOpen();
    if(!sel.length){ toast('Tick the lines the technician will buy'); return; }
    if(!confirm('Mark ' + sel.length + ' line' + (sel.length === 1 ? '' : 's') + ' as bought by ' + (mrOpenRow.requester_name || 'the technician') + ' (cash advance)?')) return;
    if(!(await purchEnsureSession())) return;
    try{
      purchMarkOwn(mrOpenRow.id);
      const { error } = await db.from('material_requisition_items').update({ fulfilled_by:'tech_buy' }).in('id', sel.map(it=> it.id));
      if(error) throw error;
      toast('Marked as tech buys');
      notifyUser(mrOpenRow.requested_by, 'Materials: please purchase', mrOpenRow.mrf_no + ': ' + sel.length + ' item' + (sel.length === 1 ? '' : 's') + ' approved for you to buy (cash advance).', 'mrf-' + mrOpenRow.id);
      await mrOpen(mrOpenRow.id);
    }catch(err){ purchFail('Couldn\u2019t update the lines: ', err); }
  }

  // Groups the ticked lines by each catalog item's PREFERRED supplier and
  // creates one draft PO per supplier. Free-text lines, or items with no
  // preferred supplier, go on one extra draft with no supplier chosen yet.
  async function mrCreatePos(){
    const sel = mrSelectedOpen();
    if(!sel.length){ toast('Tick the lines to put on Purchase Orders'); return; }
    const unlinked = sel.filter(it=> !it.material_id);
    if(unlinked.length){ toast('Link ' + unlinked.map(it=> '“' + it.description + '”').join(', ') + ' to a catalog item first (the box under each line)'); return; }
    if(!(await ensureCloud())){ toast('Not connected'); return; }
    try{ await Promise.all([mtLoad({ silent:true }), poLoadSettings(), poLoadSuppliers()]); }
    catch(e){ purchFail('Couldn\u2019t load suppliers / prices: ', e); return; }
    const groups = new Map();   // supplierId|'' -> lines
    sel.forEach(it=>{
      const m = it.material_id && mtCache.find(x=> x.id === it.material_id);
      const pref = m && m.prices.find(p=> p.is_preferred && p.is_active && p.suppliers && p.suppliers.is_active !== false);
      const key = pref ? pref.suppliers.id : '';
      if(!groups.has(key)) groups.set(key, []);
      groups.get(key).push(it);
    });
    const names = Array.from(groups.keys()).map(k=> (k ? poSupplierName(poSuppliers.find(s=> s.id === k)) : 'No preferred supplier (choose in the PO)') + ': ' + groups.get(k).length + ' line' + (groups.get(k).length === 1 ? '' : 's'));
    if(!confirm('Create ' + groups.size + ' draft Purchase Order' + (groups.size === 1 ? '' : 's') + '?\n\n' + names.join('\n') + '\n\nThey open as drafts so you can check prices before issuing.')) return;
    if(!(await purchEnsureSession())) return;
    const set = poSettingsData || {};
    const jo = mrOpenRow.job_order;
    const deliverTo = mrOpenRow.deliver_to === 'Job site' && jo && jo.siteAddress ? jo.siteAddress + (jo.custName ? ' (' + jo.custName + ')' : '') : (set.deliver_to || '');
    const created = [];
    try{
      for(const [supplierId, lines] of groups){
        const sup = poSuppliers.find(s=> s.id === supplierId);
        const header = {
          supplier_id: supplierId || null, reference: mrOpenRow.mrf_no + (jo ? ' / ' + jo.id + (jo.custName ? ' — ' + jo.custName : '') : ''),
          deliver_to: deliverTo, payment_terms: sup ? (sup.payment_terms || '') : '', vat_mode: set.vat_mode || 'exclusive',
          delivery_date: mrOpenRow.needed_by || null
        };
        const { data: po, error } = await db.from('purchase_orders').insert(header).select('id, po_no').single();
        if(error) throw error;
        const rows = lines.map((it, i)=>{
          const p = it.material_id ? poPriceFor(it.material_id, supplierId || null) : null;
          return { id: poUuid(), po_id: po.id, line_no: i + 1, material_id: it.material_id || null, code: it.code || '', description: it.description,
            unit: (p && p.unitFromPrice) || it.unit || '',
            // only what hasn't already been issued from stock
            qty: Number(it.qty_approved != null ? it.qty_approved : it.qty_requested) - Number(it.qty_issued || 0), unit_price: p ? p.price : 0 };
        });
        const ir = await db.from('purchase_order_items').insert(rows); if(ir.error) throw ir.error;
        purchMarkOwn(mrOpenRow.id);
        const lr = await db.from('material_requisition_items').update({ fulfilled_by:'po', po_id: po.id }).in('id', lines.map(it=> it.id));
        if(lr.error) throw lr.error;
        created.push(po.po_no);
      }
      toast('Created ' + created.join(', ') + ' — open them from the Fulfilment column');
      await mrOpen(mrOpenRow.id);
    }catch(err){
      purchFail('Couldn\u2019t create the Purchase Orders' + (created.length ? ' (made ' + created.join(', ') + ' before the error)' : '') + ': ', err);
      if(created.length) mrOpen(mrOpenRow.id);
    }
  }

  // ---------- MRF PDF (same look as the PO) ----------
  async function mrShowPdf(){
    try{
      await loadAwesScript('jspdf', awesLibs.jspdf);
      await loadAwesScript('autotable', awesLibs.autotable);
      await poLoadSettings().catch(()=>{});
      const co = poSettingsData || {};
      const style = co.header_style || 'green';
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
      const reg = (s)=>{ doc.setFont(F, 'normal'); doc.setFontSize(s); };
      const semi = (s)=>{ doc.setFont(FS[0], FS[1]); doc.setFontSize(s); };
      const bold = (s)=>{ doc.setFont(FB[0], FB[1]); doc.setFontSize(s); };
      const W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight(), M = 36;
      const G = [21, 77, 52], SUB = [96, 108, 101], INK = [28, 34, 30], LINE = [216, 223, 219];
      const green = style !== 'white', ink = green ? [255, 255, 255] : INK;
      const h = mrOpenRow, jo = h.job_order;
      const headH = 104;
      if(green){ doc.setFillColor(...G); doc.rect(0, 0, W, headH, 'F'); } else { doc.setFillColor(...G); doc.rect(0, headH - 4, W, 4, 'F'); }
      if(logo && logo.w){ const r = Math.min(150 / logo.w, 44 / logo.h); try{ doc.addImage(logo.dataUrl, 'PNG', M, 16, logo.w * r, logo.h * r, 'mr-logo', 'FAST'); }catch(e){} }
      semi(9.5); doc.setTextColor(...ink); doc.text(co.company_name || '', M, 78);
      reg(7.4); doc.text(doc.splitTextToSize(co.address || '', 320).slice(0, 1), M, 90);
      bold(16); doc.text('MATERIAL REQUISITION', W - M, 36, { align:'right' });
      semi(10.5); doc.text(h.mrf_no, W - M, 54, { align:'right' });
      reg(8.8); doc.text('Status: ' + MR_STATUS_LABEL[h.status].toUpperCase() + (h.urgency !== 'normal' ? '   •   ' + MR_URGENCY[h.urgency].toUpperCase() : ''), W - M, 68, { align:'right' });
      let y = headH + 20;
      const info = [['Requested by', (h.requester_name || '') + (h.submitted_at ? '  (' + mrWhen(h.submitted_at) + ')' : '')],
        ['Job order', jo ? jo.id + (jo.custName ? ' — ' + jo.custName : '') : 'None (office / stock)'], ['Site', jo && jo.siteAddress],
        ['Needed by', h.needed_by ? mrDate(h.needed_by) : 'Not specified'], ['Deliver to', h.deliver_to], ['Purpose', h.purpose]].filter(r=> r[1]);
      info.forEach(([k, v])=>{
        reg(7.8); doc.setTextColor(...SUB); doc.text(k, M, y);
        reg(9); doc.setTextColor(...INK); const lines = doc.splitTextToSize(String(v), W - M * 2 - 90); doc.text(lines, M + 90, y);
        y += lines.length * 11 + 3;
      });
      const showFul = h.status === 'approved' || h.status === 'fulfilled';
      doc.autoTable({
        startY: y + 8, margin: { left:M, right:M, bottom:60 },
        head: [['#', 'Item', 'Code', 'Requested', 'Approved', 'Unit'].concat(showFul ? ['Fulfilment'] : [])],
        body: mrOpenItems.map((it, i)=> [String(i + 1), it.description, it.code || '', mrQty(it.qty_requested), mrQty(it.qty_approved), it.unit || '']
          .concat(showFul ? [Number(it.qty_approved) === 0 ? 'Not needed' : it.fulfilled_by === 'tech_buy' ? 'Tech buys' : it.fulfilled_by === 'stock' ? 'Issued from stock' : it.purchase_orders ? it.purchase_orders.po_no + (it.purchase_orders.status === 'cancelled' ? ' (cancelled)' : '') : 'Open'] : [])),
        theme:'plain',
        styles: { font:F, fontSize:8.4, cellPadding:{ top:5, bottom:5, left:6, right:6 }, textColor:INK, lineColor:LINE, lineWidth:{ bottom:0.5 } },
        headStyles: { font:F, fontStyle:'bold', fillColor:G, textColor:255, fontSize:7.8 },
        alternateRowStyles: { fillColor:[247, 250, 248] },
        columnStyles: { 0:{ cellWidth:22, halign:'center' }, 2:{ cellWidth:60, textColor:SUB, fontSize:7.4 }, 3:{ halign:'right', cellWidth:60 }, 4:{ halign:'right', cellWidth:60 }, 5:{ halign:'center', cellWidth:40 } }
      });
      // signatures pinned at the bottom
      const sigTop = H - 46 - 80, sw = (W - M * 2 - 36) / 3;
      if(doc.lastAutoTable.finalY > sigTop - 10) doc.addPage();
      [['Requested by', h.requester_name], ['Reviewed / approved by', h.reviewer_name], ['Received by', '']].forEach(([cap, name], i)=>{
        const x = M + i * (sw + 18);
        semi(6.8); doc.setTextColor(...SUB); doc.text(cap.toUpperCase(), x, sigTop);
        doc.setDrawColor(70, 76, 72); doc.setLineWidth(0.6); doc.line(x, sigTop + 50, x + sw, sigTop + 50);
        semi(8.6); doc.setTextColor(...INK); doc.text(name ? name.toUpperCase() : 'Signature over printed name / Date', x + sw / 2, sigTop + 62, { align:'center' });
      });
      const pages = doc.internal.getNumberOfPages();
      for(let p = 1; p <= pages; p++){
        doc.setPage(p); reg(7); doc.setTextColor(...SUB);
        doc.text(h.mrf_no + '   •   ' + (co.company_name || ''), M, H - 20);
        doc.text('Page ' + p + ' of ' + pages, W - M, H - 20, { align:'right' });
      }
      const filename = h.mrf_no + '.pdf', title = 'Material Requisition ' + h.mrf_no;
      $('previewOverlay').querySelector('h3').textContent = title;
      $('previewOkBtn').textContent = 'Close';
      $('previewOverlay').style.zIndex = '99';
      $('previewOverlay').classList.add('open');
      await renderPdfPreview(doc, filename, title);
    }catch(e){ console.error('MRF pdf failed', e); toast('Couldn\u2019t build the PDF: ' + (e && e.message ? e.message : e)); }
  }
