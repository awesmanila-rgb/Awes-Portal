  // =====================================================================
  // Site deliveries — a supplier delivers STRAIGHT TO A SITE
  //
  //   OFFICE  (Receive Stock > "Supplier delivering to a site")
  //     assigns the delivery: supplier / PO > the site and the worker who will receive it >
  //     the expected items > review. The worker is told.
  //   WORKER  (My Deliveries, on their phone)
  //     confirms how many of each item arrived and adds photos as proof (at least one).
  //   Nothing goes into a warehouse. For lines on a PO, what arrived is added to the PO line
  //   and shows in Purchased Items as "Received by <worker>".
  //
  // NOTE: this screen redraws itself, so it reads elements with $live() (the app's $() remembers
  // the first node it found and would keep returning the old, detached one).
  //
  // Database: site_deliveries / site_delivery_items / site_delivery_photos and the functions
  // site_delivery_create / _receive / _cancel (migration 20261027_01); photos go to the private
  // bucket delivery-proofs, each worker only into their own folder.
  // =====================================================================

  const SD_BUCKET = 'delivery-proofs';
  const sd = { form:null, tab:'assign', filter:'assigned', list:[], mine:[], rcv:null, ctxOk:false, pos:[], suppliers:[] };
  const sdDay = (ts)=> { try{ return new Date(ts).toLocaleDateString('en-PH', { timeZone:'Asia/Manila', month:'short', day:'numeric' }); }catch(e){ return ''; } };
  const sdDate = (d)=> d ? sdDay(String(d).length === 10 ? d + 'T12:00:00+08:00' : d) : '';
  const sdNum = (n)=> Number(n || 0).toLocaleString('en-PH', { maximumFractionDigits:3 });
  const SD_STATUS = { assigned:{ label:'To receive', cls:'approval' }, received:{ label:'Received', cls:'ready' }, cancelled:{ label:'Cancelled', cls:'' } };
  const sdChip = (st)=> '<span class="mm-chip ' + ((SD_STATUS[st] || {}).cls || '') + '">' + escapeHtml((SD_STATUS[st] || { label:st }).label) + '</span>';

  // ---------- photos ----------
  async function sdUpload(files, deliveryId){
    const out = [];
    for(const f of files){
      let blob = null;
      try{ blob = await compressImageForUpload(f, { targetBytes: 350 * 1024, maxDim: 1800 }); }catch(e){ blob = null; }
      const path = currentUser.id + '/' + deliveryId + '/' + Date.now() + '-' + (out.length + 1) + '.jpg';
      const up = await db.storage.from(SD_BUCKET).upload(path, blob || f, { contentType:'image/jpeg', upsert:false });
      if(up.error) throw up.error;
      out.push(path);
    }
    return out;
  }
  async function sdSigned(paths){
    if(!paths.length) return {};
    const { data } = await db.storage.from(SD_BUCKET).createSignedUrls(paths, 3600);
    const m = {}; (data || []).forEach(x=>{ if(x && x.path && x.signedUrl) m[x.path] = x.signedUrl; });
    return m;
  }
  function sdLightbox(url){
    let ov = $live('sdLightbox');
    if(!ov){
      ov = document.createElement('div'); ov.id = 'sdLightbox'; ov.className = 'sd-lightbox';
      ov.innerHTML = '<button type="button" class="sd-lb-x" aria-label="Close">\u00D7</button><img alt="Delivery proof">';
      ov.addEventListener('click', ()=> ov.classList.remove('open'));
      document.body.appendChild(ov);
    }
    ov.querySelector('img').src = url; ov.classList.add('open');
  }

  // =====================================================================
  // WORKER — My Deliveries
  // =====================================================================
  async function sdMineShow(){
    sd.rcv = null;
    $live('sdMineForm').style.display = 'none'; $live('sdMineList').style.display = '';
    $live('sdMineList').innerHTML = '<div class="empty-state">Loading\u2026</div>';
    if(!(await ensureCloud())){ $live('sdMineList').innerHTML = '<div class="empty-state">Not connected \u2014 this page needs a connection.</div>'; return; }
    try{
      const { data, error } = await db.from('site_deliveries').select('*, site_delivery_items(*), site_delivery_photos(id)')
        .eq('assigned_to', currentUser.id).order('assigned_at', { ascending:false }).limit(40);
      if(error) throw error;
      sd.mine = data || [];
      sdRenderMine();
      if(sd.openAfter){ const id = sd.openAfter; sd.openAfter = null; if(sd.mine.some(d=> d.id === id && d.status === 'assigned')) sdOpenReceive(id); }
    }catch(e){
      const m = describeCloudError(e);
      $live('sdMineList').innerHTML = '<div class="empty-state">' + (/site_deliveries|PGRST205|42P01/.test(m) ? 'This page needs migration 20261027_01_site_deliveries.sql to be run in Supabase.' : 'Couldn\u2019t load your deliveries: ' + escapeHtml(m)) + '</div>';
    }
  }
  function sdItemsLine(d){
    const it = (d.site_delivery_items || []).slice().sort((a, b)=> a.line_no - b.line_no);
    return it.slice(0, 3).map(i=> escapeHtml(i.description) + ' \u00D7 ' + sdNum(i.qty_expected) + (i.unit ? ' ' + escapeHtml(i.unit) : '')).join(', ') + (it.length > 3 ? ' + ' + (it.length - 3) + ' more' : '');
  }
  function sdRenderMine(){
    const todo = sd.mine.filter(d=> d.status === 'assigned'), rest = sd.mine.filter(d=> d.status !== 'assigned');
    const card = (d)=> '<div class="sd-card"><div class="sd-card-top"><b>' + escapeHtml(d.supplier_name || 'Supplier') + '</b>' + sdChip(d.status) + '</div>' +
      '<div class="sd-line"><span>Deliver to</span>' + escapeHtml(d.site_label) + '</div>' +
      (d.expected_on ? '<div class="sd-line"><span>Expected</span>' + escapeHtml(sdDate(d.expected_on)) + '</div>' : '') +
      '<div class="sd-line"><span>Items</span>' + sdItemsLine(d) + '</div>' +
      (d.note ? '<div class="sd-line"><span>Office note</span>' + escapeHtml(d.note) + '</div>' : '') +
      (d.status === 'assigned' ? '<button type="button" class="btn btn-primary sd-go" data-rcv="' + escapeHtml(d.id) + '">I received it</button>' :
        d.status === 'received' ? '<div class="sd-line"><span>Received</span>' + escapeHtml(sdDay(d.received_at)) + ' \u00B7 ' + (d.site_delivery_photos || []).length + ' photo' + ((d.site_delivery_photos || []).length === 1 ? '' : 's') + '</div>' :
        '<div class="sd-line"><span>Why</span>' + escapeHtml(d.cancel_reason || '') + '</div>') + '</div>';
    $live('sdMineList').innerHTML =
      '<p class="sd-intro">When a supplier delivers to a site, the office assigns you to receive it. Count what arrived and take photos as proof.</p>' +
      (todo.length ? '<h3 class="sd-h">To receive (' + todo.length + ')</h3>' + todo.map(card).join('') : '<div class="empty-state">Nothing to receive right now.</div>') +
      (rest.length ? '<h3 class="sd-h">Earlier</h3>' + rest.map(card).join('') : '');
  }

  // ---- the receive form ----
  function sdOpenReceive(id){
    const d = sd.mine.find(x=> x.id === id); if(!d) return;
    sd.rcv = { d, files:[], uploaded:[], busy:false };
    $live('sdMineList').style.display = 'none'; $live('sdMineForm').style.display = '';
    sdRenderReceive();
  }
  function sdRenderReceive(){
    const r = sd.rcv, d = r.d, items = (d.site_delivery_items || []).slice().sort((a, b)=> a.line_no - b.line_no);
    $live('sdMineForm').innerHTML =
      '<div class="po-ed-top"><button type="button" class="po-back" id="sdRcvBack">&larr; My deliveries</button></div>' +
      '<div class="sd-head"><b>' + escapeHtml(d.supplier_name || 'Supplier') + '</b><span>' + escapeHtml(d.site_label) + '</span>' + (d.expected_on ? '<span>Expected ' + escapeHtml(sdDate(d.expected_on)) + '</span>' : '') + '</div>' +
      '<h3 class="sd-h">1. How many arrived?</h3>' +
      items.map(i=> '<div class="sd-item" data-item="' + escapeHtml(i.id) + '"><div class="sd-item-name"><b>' + escapeHtml(i.description) + '</b><span>Expected ' + sdNum(i.qty_expected) + ' ' + escapeHtml(i.unit || '') + '</span></div>' +
        '<input type="text" inputmode="decimal" class="sd-q" value="' + escapeHtml(String(Number(i.qty_expected))) + '" aria-label="Quantity received of ' + escapeHtml(i.description) + '">' +
        '<input type="text" class="sd-n" placeholder="Note (e.g. 2 damaged)" aria-label="Note"></div>').join('') +
      '<h3 class="sd-h">2. Photos as proof <span class="sd-req">required</span></h3>' +
      '<p class="sd-help">Show the delivery and the items. Take as many as you need.</p>' +
      '<div class="sd-thumbs" id="sdThumbs">' + r.files.map((f, n)=> '<div class="sd-thumb"><img src="' + escapeHtml(f.url) + '" alt="Photo ' + (n + 1) + '"><button type="button" data-rm="' + n + '" aria-label="Remove photo ' + (n + 1) + '">\u00D7</button></div>').join('') + '</div>' +
      '<input type="file" id="sdFile" accept="image/*" multiple hidden>' +
      '<button type="button" class="btn btn-secondary sd-add" id="sdAddPhoto">+ Add photos</button>' +
      '<h3 class="sd-h">3. Anything to tell the office?</h3>' +
      '<input type="text" id="sdRcvNote" placeholder="Optional note">' +
      '<div class="sd-err" id="sdRcvErr" role="alert"></div>' +
      '<button type="button" class="btn btn-primary sd-submit" id="sdRcvSubmit">Confirm delivery received</button>';
  }
  async function sdSubmitReceive(){
    const r = sd.rcv; if(!r || r.busy) return;
    const err = (m)=> { $live('sdRcvErr').textContent = m; };
    const items = (r.d.site_delivery_items || []).slice().sort((a, b)=> a.line_no - b.line_no), lines = [];
    let any = false;
    for(const i of items){
      const row = $live('sdMineForm').querySelector('.sd-item[data-item="' + i.id + '"]');
      const q = spParseMoney(row.querySelector('.sd-q').value);
      if(q == null || Number.isNaN(q)){ err(i.description + ': say how many arrived (0 if none).'); return; }
      if(q > Number(i.qty_expected)){ err(i.description + ': only ' + sdNum(i.qty_expected) + ' were expected.'); return; }
      if(q > 0) any = true;
      lines.push({ item_id:i.id, qty_received:q, note:row.querySelector('.sd-n').value.trim() });
    }
    if(!any){ err('Nothing arrived? Tell the office instead of recording this.'); return; }
    if(!r.files.length && !r.uploaded.length){ err('Add at least one photo as proof.'); return; }
    err('');
    r.busy = true; const btn = $live('sdRcvSubmit'); btn.disabled = true; btn.textContent = 'Saving\u2026';
    try{
      if(!(await purchEnsureSession())){ return; }
      // upload once; if the save fails the paths are kept so a retry does not upload again
      if(r.files.length){ const paths = await sdUpload(r.files.map(f=> f.file), r.d.id); r.uploaded = r.uploaded.concat(paths); r.files = []; }
      const { data, error } = await db.rpc('site_delivery_receive', { p: { id:r.d.id, lines, photos:r.uploaded, note:$live('sdRcvNote').value.trim() } });
      if(error) throw error;
      toast('Saved \u2014 thank you');
      const who = currentUser.name || 'A worker';
      if(r.d.assigned_by) notifyUser(r.d.assigned_by, 'Delivery received', (data && data.delivery_no || 'A delivery') + ' \u2014 ' + who + ' received it at ' + r.d.site_label + '.', 'sd-rcv-' + r.d.id);
      if(typeof notifyAdmins === 'function') notifyAdmins('Delivery received on site', (data && data.delivery_no || '') + ' \u2014 ' + who + ' \u00B7 ' + r.d.site_label, 'sd-rcv-' + r.d.id);
      sd.rcv = null; sdMineShow();
    }catch(e){
      err('Couldn\u2019t save: ' + describeCloudError(e).replace(/^.*?:\s*(?=[A-Z])/, ''));
      btn.disabled = false; btn.textContent = 'Confirm delivery received';
    }finally{ if(sd.rcv) sd.rcv.busy = false; }
  }
  document.addEventListener('click', (ev)=>{
    const t = ev.target;
    if(!t.closest || !t.closest('#purchPanel_myDeliveries')) return;
    const go = t.closest('[data-rcv]'); if(go){ sdOpenReceive(go.getAttribute('data-rcv')); return; }
    if(t.closest('#sdRcvBack')){ sd.rcv = null; $live('sdMineForm').style.display = 'none'; $live('sdMineList').style.display = ''; sdRenderMine(); return; }
    if(t.closest('#sdAddPhoto')){ $live('sdFile').click(); return; }
    const rm = t.closest('#sdThumbs [data-rm]'); if(rm){ const f = sd.rcv.files.splice(Number(rm.getAttribute('data-rm')), 1)[0]; if(f) URL.revokeObjectURL(f.url); sdKeepFields(); return; }
    if(t.closest('#sdRcvSubmit')) sdSubmitReceive();
  });
  document.addEventListener('change', (ev)=>{
    if(!ev.target || ev.target.id !== 'sdFile' || !sd.rcv) return;
    Array.from(ev.target.files || []).forEach(f=>{ if(sd.rcv.files.length < 12 - sd.rcv.uploaded.length && /^image\//.test(f.type || 'image/')) sd.rcv.files.push({ file:f, url:URL.createObjectURL(f) }); });
    ev.target.value = ''; sdKeepFields();
  });
  // re-draw the form (for the photo grid) without losing what has been typed
  function sdKeepFields(){
    const keep = { q:[], n:[], note:$live('sdRcvNote') ? $live('sdRcvNote').value : '' };
    $live('sdMineForm').querySelectorAll('.sd-item').forEach(row=>{ keep.q.push(row.querySelector('.sd-q').value); keep.n.push(row.querySelector('.sd-n').value); });
    sdRenderReceive();
    $live('sdMineForm').querySelectorAll('.sd-item').forEach((row, i)=>{ row.querySelector('.sd-q').value = keep.q[i]; row.querySelector('.sd-n').value = keep.n[i]; });
    $live('sdRcvNote').value = keep.note;
  }

  // =====================================================================
  // OFFICE — assign a delivery, and see the deliveries with their proof
  // =====================================================================
  function sdBlankForm(){ return { step:0, po_id:'', supplier_id:'', supplier_name:'', ref:'', project_id:'', job_order_id:'', site_label:'', expected_on:'', worker_id:'', note:'', items:[], err:'' }; }
  async function sdOfficeShow(){
    if(!sd.form) sd.form = sdBlankForm();
    sdSetTab(sd.tab);
    if(!(await ensureCloud())){ $live('sdAssign').innerHTML = '<div class="empty-state">Not connected \u2014 this page needs a connection.</div>'; return; }
    try{
      await invLoadCtx();
      const [sup, pos] = await Promise.all([ db.from('suppliers_directory').select('id, display_name').order('display_name'), db.rpc('inv_pos_to_receive') ]);
      sd.suppliers = sup.data || []; sd.pos = pos.data || []; sd.ctxOk = true;
    }catch(e){ sd.ctxOk = false; }
    sdRenderAssign();
    if(sd.tab === 'list') sdLoadList();
  }
  function sdSetTab(tab){
    sd.tab = tab;
    $$('#sdTabs .seg-tab').forEach(b=> b.classList.toggle('active', b.dataset.tab === tab));
    if(tab === 'assign' && sd.form && sd.ctxOk) sdRenderAssign();   // always the current form, never a stale screen
    $live('sdAssign').style.display = tab === 'assign' ? '' : 'none';
    $live('sdList').style.display = tab === 'list' ? '' : 'none';
    $live('sdDetail').style.display = 'none';
  }

  // ---- the assign wizard (same look as the movement screens) ----
  const SD_STEPS = [
    { n:'Supplier', q:'Which supplier is delivering?', h:'Pick the purchase order, or type the supplier\u2019s name.' },
    { n:'Site',     q:'Where does it go, and who receives it?', h:'The worker you pick receives it on site and uploads photos as proof.' },
    { n:'Items',    q:'What is expected?', h:'What the supplier should bring. The worker confirms how much arrived.' },
    { n:'Review',   q:'Check and assign', h:'The worker is told as soon as you assign it.' }
  ];
  const sdPoOf = (id)=> sd.pos.find(p=> p.id === id);
  const sdWorker = (id)=> (invX.workers || []).find(w=> w.id === id);
  function sdOpts(list, val, label, blank, sel){ return '<option value="">' + escapeHtml(blank) + '</option>' + list.map(x=> '<option value="' + escapeHtml(val(x)) + '"' + (val(x) === sel ? ' selected' : '') + '>' + escapeHtml(label(x)) + '</option>').join(''); }
  function sdChipsHtml(f){
    const po = sdPoOf(f.po_id), sup = po ? po.supplier : (f.supplier_name || (sd.suppliers.find(s=> s.id === f.supplier_id) || {}).display_name || '');
    const w = sdWorker(f.worker_id), site = f.site_label || (invX.projects || []).filter(p=> p.id === f.project_id).map(p=> p.name)[0] || f.job_order_id || '';
    const n = f.items.filter(i=> i.on !== false && Number(i.qty) > 0).length;
    return '<span class="wz-chip' + (sup ? ' set' : '') + '">' + escapeHtml(sup || 'Supplier') + '</span><span class="wz-arr" aria-hidden="true">\u2192</span><span class="wz-chip' + (site ? ' set' : '') + '">' + escapeHtml(site || 'Site') + '</span><span class="wz-arr" aria-hidden="true">\u2192</span><span class="wz-chip' + (w ? ' set' : '') + '">' + escapeHtml(w ? w.name : 'Receiver') + '</span>' + (n ? '<span class="wz-chip">' + n + ' item' + (n === 1 ? '' : 's') + '</span>' : '');
  }
  function sdStepBody(f){
    if(f.step === 0){
      return '<div class="po-grid wz-grid"><div class="field po-c12"><label>Purchase order <span class="sd-opt">optional</span></label><select id="sdPo">' +
        sdOpts(sd.pos, p=> p.id, p=> p.po_no + ' \u00B7 ' + (p.supplier || 'no supplier'), 'No purchase order', f.po_id) + '</select></div>' +
        (f.po_id ? '' : '<div class="field po-c12"><label>Supplier</label><select id="sdSup">' + sdOpts(sd.suppliers, s=> s.id, s=> s.display_name, 'Not in the list', f.supplier_id) + '</select></div>' +
          '<div class="field po-c12"' + (f.supplier_id ? ' style="display:none"' : '') + '><label>Supplier name</label><input type="text" id="sdSupName" value="' + escapeHtml(f.supplier_name) + '" placeholder="If the supplier is not in the list"></div>') +
        '<div class="field po-c12"><label>Delivery receipt / reference no. <span class="sd-opt">optional</span></label><input type="text" id="sdRef" value="' + escapeHtml(f.ref) + '" placeholder="e.g. DR-5521"></div></div>';
    }
    if(f.step === 1){
      return '<div class="wz-recipient po-c12"><span class="wz-recipient-art">' + IT.art.custody(96) + '</span><div class="field wz-recipient-f"><label>Worker who receives it <span class="req">*</span></label><select id="sdWorker">' +
          sdOpts(invX.workers || [], w=> w.id, w=> w.name, 'Choose a worker\u2026', f.worker_id) + '</select></div></div>' +
        '<div class="po-grid wz-grid"><div class="field po-c6"><label>Project</label><select id="sdProj">' + sdOpts(invX.projects || [], p=> p.id, p=> (p.project_no ? p.project_no + ' \u2014 ' : '') + p.name, '\u2014 none \u2014', f.project_id) + '</select></div>' +
        '<div class="field po-c6"><label>Job order</label><select id="sdJob">' + sdOpts(invX.jobs || [], j=> j.id, j=> j.id + (j.cust_name ? ' \u00B7 ' + j.cust_name : ''), '\u2014 none \u2014', f.job_order_id) + '</select></div>' +
        '<div class="field po-c12"><label>Site address <span class="sd-opt">if not a project or job order</span></label><input type="text" id="sdSite" value="' + escapeHtml(f.site_label) + '" placeholder="Where exactly?"></div>' +
        '<div class="field po-c6"><label>Expected on</label><input type="date" id="sdDate" value="' + escapeHtml(f.expected_on) + '"></div>' +
        '<div class="field po-c6"><label>Note to the worker <span class="sd-opt">optional</span></label><input type="text" id="sdNote" value="' + escapeHtml(f.note) + '" placeholder="e.g. ask for the guard"></div></div>';
    }
    if(f.step === 2){
      const rows = f.items.map((i, n)=> '<div class="sd-row" data-n="' + n + '">' + (i.po_item_id ? '<label class="sd-on"><input type="checkbox" data-on="1"' + (i.on !== false ? ' checked' : '') + '></label>' : '') +
        '<div class="sd-row-name">' + (i.po_item_id ? '<b>' + escapeHtml(i.description) + '</b><span>Left on the PO: ' + sdNum(i.max) + ' ' + escapeHtml(i.unit || '') + '</span>' :
          '<input type="text" data-d="1" list="sdCat" placeholder="Item" value="' + escapeHtml(i.description) + '"><input type="text" data-u="1" class="sd-unit" placeholder="unit" value="' + escapeHtml(i.unit) + '">') + '</div>' +
        '<input type="text" inputmode="decimal" class="sd-q" data-q="1" placeholder="Qty" value="' + escapeHtml(String(i.qty)) + '" aria-label="Expected quantity">' +
        (i.po_item_id ? '' : '<button type="button" class="po-rm" data-rm="' + n + '" title="Remove">\u2212</button>') + '</div>').join('');
      return '<datalist id="sdCat">' + (invX.cat || []).map(m=> '<option value="' + escapeHtml(m.name) + '"></option>').join('') + '</datalist>' + rows +
        (f.po_id ? '<p class="sd-help">Untick a line the supplier is not bringing to this site.</p>' : '<button type="button" class="btn btn-secondary" id="sdAddItem">+ Add item</button>');
    }
    const w = sdWorker(f.worker_id), po = sdPoOf(f.po_id), items = f.items.filter(i=> i.on !== false && Number(i.qty) > 0);
    const site = [ (invX.projects || []).filter(p=> p.id === f.project_id).map(p=> p.name)[0], f.job_order_id, f.site_label ].filter(Boolean).join(' \u00B7 ');
    return '<dl class="wz-sum"><dt>Supplier</dt><dd>' + escapeHtml(po ? po.supplier : (f.supplier_name || (sd.suppliers.find(s=> s.id === f.supplier_id) || {}).display_name || '\u2014')) + '</dd>' +
      (po ? '<dt>Purchase order</dt><dd>' + escapeHtml(po.po_no) + '</dd>' : '') + (f.ref ? '<dt>Reference</dt><dd>' + escapeHtml(f.ref) + '</dd>' : '') +
      '<dt>Site</dt><dd>' + escapeHtml(site) + '</dd>' + (f.expected_on ? '<dt>Expected</dt><dd>' + escapeHtml(sdDate(f.expected_on)) + '</dd>' : '') +
      '<dt>Receiver</dt><dd>' + escapeHtml(w ? w.name : '') + '</dd><dt>Assigned by</dt><dd>You \u2014 ' + escapeHtml(currentUser.name || '') + '</dd></dl>' +
      '<div class="wz-lines">' + items.map(i=> '<div class="wz-li"><span>' + escapeHtml(i.description) + '</span><b>' + escapeHtml(sdNum(i.qty)) + ' ' + escapeHtml(i.unit || '') + '</b></div>').join('') + '</div>' +
      '<div class="wz-what">What happens</div><div class="wz-eff">' +
      '<div><span class="wz-ico" aria-hidden="true">\u2713</span><span>' + escapeHtml(w ? w.name : 'The worker') + ' is told to receive it</span></div>' +
      '<div><span class="wz-ico" aria-hidden="true">\u2713</span><span>They confirm what arrived and upload photos as proof</span></div>' +
      '<div><span class="wz-ico warn" aria-hidden="true">!</span><span>Nothing goes into a warehouse' + (po ? '; the PO line shows what arrived' : '') + '</span></div></div>';
  }
  function sdRenderAssign(){
    const f = sd.form, host = $live('sdAssign');
    if(!sd.ctxOk){ host.innerHTML = '<div class="empty-state">Couldn\u2019t load the suppliers and workers. Check your connection.</div>'; return; }
    host.innerHTML = '<div class="wz"><ol class="wz-steps">' + SD_STEPS.map((s, i)=> '<li class="' + (i < f.step ? 'done' : i === f.step ? 'cur' : '') + '"><button type="button" class="wz-stp" data-sdgo="' + i + '"' + (i > f.step ? ' disabled' : '') + '><span class="wz-dot">' + (i < f.step ? '\u2713' : i + 1) + '</span><span class="wz-sl">' + s.n + '</span></button></li>').join('') + '</ol>' +
      '<div class="wz-bar">' + sdChipsHtml(f) + '</div>' +
      '<section class="wz-step on"><h3 class="wz-q">' + SD_STEPS[f.step].q + '</h3><p class="wz-help">' + SD_STEPS[f.step].h + '</p><div class="wz-body">' + sdStepBody(f) + '</div></section>' +
      '<div class="wz-err" role="alert">' + escapeHtml(f.err) + '</div>' +
      '<div class="wz-foot"><button type="button" class="btn btn-secondary" id="sdBack"' + (f.step === 0 ? ' style="visibility:hidden"' : '') + '>Back</button><button type="button" class="btn btn-primary" id="sdNext">' + (f.step === 3 ? 'Assign the delivery' : 'Next: ' + SD_STEPS[f.step + 1].n.toLowerCase()) + '</button></div></div>';
  }
  function sdReadStep(){
    const f = sd.form, g = (id)=> $live(id) ? $live(id).value : null;
    if(f.step === 0){
      if(g('sdPo') !== null){ const prev = f.po_id; f.po_id = g('sdPo'); if(f.po_id !== prev){ f.items = sdItemsFromPo(f.po_id); } }
      if(g('sdSup') !== null) f.supplier_id = g('sdSup'); if(g('sdSupName') !== null) f.supplier_name = g('sdSupName').trim(); if(g('sdRef') !== null) f.ref = g('sdRef').trim();
    }
    if(f.step === 1){ ['Worker:worker_id', 'Proj:project_id', 'Job:job_order_id'].forEach(p=>{ const [id, k] = p.split(':'); if(g('sd' + id) !== null) f[k] = g('sd' + id); }); if(g('sdSite') !== null) f.site_label = g('sdSite').trim(); if(g('sdDate') !== null) f.expected_on = g('sdDate'); if(g('sdNote') !== null) f.note = g('sdNote').trim(); }
    if(f.step === 2){
      $live('sdAssign').querySelectorAll('.sd-row').forEach(row=>{
        const i = f.items[Number(row.dataset.n)]; if(!i) return;
        const q = row.querySelector('[data-q]'); if(q) i.qty = q.value.trim();
        const on = row.querySelector('[data-on]'); if(on) i.on = on.checked;
        const d = row.querySelector('[data-d]'); if(d){ i.description = d.value.trim(); const m = (invX.cat || []).find(c=> c.name.toLowerCase() === i.description.toLowerCase()); i.material_id = m ? m.id : null; if(m && !i.unit) i.unit = m.unit; }
        const u = row.querySelector('[data-u]'); if(u) i.unit = u.value.trim();
      });
    }
  }
  function sdItemsFromPo(poId){
    const po = sdPoOf(poId); if(!po) return [];
    return (po.items || []).map(i=>{ const left = Number(i.qty) - Number(i.qty_received); return { po_item_id:i.id, material_id:i.material_id || null, description:i.description, unit:i.unit || '', qty:String(left), max:left, on:left > 0 }; }).filter(i=> i.max > 0);
  }
  function sdCheck(step){
    const f = sd.form;
    if(step === 0 && !f.po_id && !f.supplier_id && !f.supplier_name) return 'Pick the purchase order or the supplier.';
    if(step === 1){
      if(!f.worker_id) return 'Choose the worker who receives it.';
      if(!f.project_id && !f.job_order_id && !f.site_label) return 'Say where it goes: a project, a job order or the site address.';
    }
    if(step === 2){
      const rows = f.items.filter(i=> i.on !== false && (i.po_item_id || i.description || String(i.qty).trim()));
      if(!rows.length) return 'Add at least one item.';
      for(const i of rows){
        if(!i.description) return 'Name every item.';
        const q = spParseMoney(i.qty);
        if(q == null || Number.isNaN(q) || q <= 0) return i.description + ': enter a quantity above 0.';
        if(i.po_item_id && q > i.max) return i.description + ': only ' + sdNum(i.max) + ' left on the PO.';
      }
    }
    return '';
  }
  async function sdAssignNow(){
    const f = sd.form, btn = $live('sdNext'); btn.disabled = true; btn.textContent = 'Assigning\u2026';
    try{
      if(!(await purchEnsureSession())) return;
      const items = f.items.filter(i=> i.on !== false && Number(spParseMoney(i.qty)) > 0).map(i=> ({ po_item_id:i.po_item_id || null, material_id:i.material_id || null, description:i.description, unit:i.unit || '', qty_expected:spParseMoney(i.qty) }));
      const { data, error } = await db.rpc('site_delivery_create', { p: { po_id:f.po_id || null, supplier_id:f.supplier_id || null, supplier_name:f.supplier_name, supplier_ref:f.ref, project_id:f.project_id || null, job_order_id:f.job_order_id || null, site_label:f.site_label, expected_on:f.expected_on || null, note:f.note, assigned_to:f.worker_id, items } });
      if(error) throw error;
      const w = sdWorker(f.worker_id), po = sdPoOf(f.po_id);
      notifyUser(f.worker_id, 'Delivery to receive', (data.delivery_no || 'A delivery') + ' \u2014 ' + (po ? po.supplier : f.supplier_name || 'a supplier') + ' delivers to ' + (f.site_label || 'the site') + '. Open My Deliveries to record it with photos.', 'sd-new-' + data.id);
      toast(data.delivery_no + ' assigned to ' + (w ? w.name : 'the worker'));
      sd.form = sdBlankForm(); sd.tab = 'list'; sd.filter = 'assigned'; sdSetTab('list'); sdLoadList();
    }catch(e){
      f.err = describeCloudError(e).replace(/^.*?:\s*(?=[A-Z])/, ''); sdRenderAssign();
    }
  }
  document.addEventListener('click', (ev)=>{
    const t = ev.target; if(!t.closest || !t.closest('#purchPanel_siteDelivery')) return;
    const tab = t.closest('#sdTabs [data-tab]'); if(tab){ sdSetTab(tab.dataset.tab); if(tab.dataset.tab === 'list') sdLoadList(); return; }
    if(t.closest('#sdBackReceive')){ showPurchasingView('receive'); return; }
    const f = sd.form;
    const go = t.closest('[data-sdgo]'); if(go){ sdReadStep(); const g = Number(go.dataset.sdgo); if(g < f.step){ f.step = g; f.err = ''; sdRenderAssign(); } return; }
    if(t.closest('#sdBack')){ sdReadStep(); f.step = Math.max(0, f.step - 1); f.err = ''; sdRenderAssign(); return; }
    if(t.closest('#sdAddItem')){ sdReadStep(); f.items.push({ po_item_id:null, material_id:null, description:'', unit:'', qty:'', on:true }); sdRenderAssign(); return; }
    const rm = t.closest('#sdAssign [data-rm]'); if(rm){ sdReadStep(); f.items.splice(Number(rm.dataset.rm), 1); sdRenderAssign(); return; }
    if(t.closest('#sdNext')){
      sdReadStep(); const e = sdCheck(f.step);
      if(e){ f.err = e; sdRenderAssign(); return; }
      f.err = '';
      if(f.step === 0 && !f.po_id && !f.items.length) f.items = [{ po_item_id:null, material_id:null, description:'', unit:'', qty:'', on:true }];
      if(f.step === 3){ for(let i = 0; i < 3; i++){ const x = sdCheck(i); if(x){ f.step = i; f.err = x; sdRenderAssign(); return; } } sdAssignNow(); return; }
      f.step++; sdRenderAssign();
    }
    // list + detail
    const card = t.closest('[data-sdopen]'); if(card){ sdOpenDetail(card.dataset.sdopen); return; }
    const flt = t.closest('#sdFilters [data-f]'); if(flt){ sd.filter = flt.dataset.f; sdRenderList(); return; }
    if(t.closest('#sdDetailBack')){ $live('sdDetail').style.display = 'none'; $live('sdList').style.display = ''; return; }
    const ph = t.closest('[data-photo]'); if(ph){ sdLightbox(ph.dataset.photo); return; }
    if(t.closest('#sdCancelBtn')) sdCancelDialog(t.closest('#sdCancelBtn').dataset.id);
  });
  document.addEventListener('change', (ev)=>{
    if(!ev.target.closest || !ev.target.closest('#sdAssign')) return;
    // choosing a PO / supplier changes what the step shows
    if(ev.target.id === 'sdPo' || ev.target.id === 'sdSup'){ sdReadStep(); sdRenderAssign(); }
  });

  // ---- the deliveries list + a delivery's detail with its photos ----
  async function sdLoadList(){
    $live('sdList').innerHTML = '<div class="empty-state">Loading\u2026</div>';
    try{
      const { data, error } = await db.from('site_deliveries').select('*, site_delivery_items(*), site_delivery_photos(id)').order('assigned_at', { ascending:false }).limit(120);
      if(error) throw error;
      sd.list = data || []; sdRenderList();
    }catch(e){
      const m = describeCloudError(e);
      $live('sdList').innerHTML = '<div class="empty-state">' + (/site_deliveries|PGRST205|42P01/.test(m) ? 'This page needs migration 20261027_01_site_deliveries.sql to be run in Supabase.' : 'Couldn\u2019t load deliveries: ' + escapeHtml(m)) + '</div>';
    }
  }
  function sdRenderList(){
    const n = (s)=> sd.list.filter(d=> d.status === s).length;
    const rows = sd.filter ? sd.list.filter(d=> d.status === sd.filter) : sd.list;
    $live('sdList').innerHTML = '<div class="sd-filters" id="sdFilters">' + [['assigned', 'To receive'], ['received', 'Received'], ['cancelled', 'Cancelled'], ['', 'All']].map(x=> '<button type="button" class="sd-fl' + (sd.filter === x[0] ? ' on' : '') + '" data-f="' + x[0] + '">' + x[1] + (x[0] ? ' <b>' + n(x[0]) + '</b>' : '') + '</button>').join('') + '</div>' +
      (rows.length ? rows.map(d=> '<button type="button" class="sd-card sd-open" data-sdopen="' + escapeHtml(d.id) + '"><span class="sd-card-top"><b>' + escapeHtml(d.delivery_no) + ' \u00B7 ' + escapeHtml(d.supplier_name || 'Supplier') + '</b>' + sdChip(d.status) + '</span>' +
        '<span class="sd-line"><span>Site</span>' + escapeHtml(d.site_label) + '</span><span class="sd-line"><span>Receiver</span>' + escapeHtml(d.assigned_to_name) + (d.expected_on ? ' \u00B7 expected ' + escapeHtml(sdDate(d.expected_on)) : '') + '</span>' +
        '<span class="sd-line"><span>Items</span>' + sdItemsLine(d) + '</span>' + (d.status === 'received' ? '<span class="sd-line"><span>Proof</span>' + (d.site_delivery_photos || []).length + ' photo' + ((d.site_delivery_photos || []).length === 1 ? '' : 's') + ' \u00B7 ' + escapeHtml(sdDay(d.received_at)) + '</span>' : '') + '</button>').join('') : '<div class="empty-state">Nothing here.</div>');
  }
  async function sdOpenDetail(id){
    const d = sd.list.find(x=> x.id === id); if(!d) return;
    $live('sdList').style.display = 'none'; $live('sdDetail').style.display = '';
    $live('sdDetail').innerHTML = '<div class="empty-state">Loading\u2026</div>';
    let photos = [];
    if(d.status === 'received'){ try{ const r = await db.from('site_delivery_photos').select('path, uploaded_at').eq('delivery_id', id).order('uploaded_at'); photos = r.data || []; }catch(e){} }
    const urls = await sdSigned(photos.map(p=> p.path)).catch(()=> ({}));
    const items = (d.site_delivery_items || []).slice().sort((a, b)=> a.line_no - b.line_no);
    $live('sdDetail').innerHTML = '<div class="po-ed-top"><button type="button" class="po-back" id="sdDetailBack">&larr; Deliveries</button></div>' +
      '<div class="sd-head"><b>' + escapeHtml(d.delivery_no) + ' \u00B7 ' + escapeHtml(d.supplier_name || 'Supplier') + '</b>' + sdChip(d.status) + '</div>' +
      '<dl class="wz-sum"><dt>Site</dt><dd>' + escapeHtml(d.site_label) + '</dd><dt>Receiver</dt><dd>' + escapeHtml(d.assigned_to_name) + '</dd><dt>Assigned</dt><dd>' + escapeHtml(sdDay(d.assigned_at)) + ' by ' + escapeHtml(d.assigned_by_name || '') + '</dd>' +
      (d.expected_on ? '<dt>Expected</dt><dd>' + escapeHtml(sdDate(d.expected_on)) + '</dd>' : '') + (d.supplier_ref ? '<dt>Reference</dt><dd>' + escapeHtml(d.supplier_ref) + '</dd>' : '') + (d.note ? '<dt>Note</dt><dd>' + escapeHtml(d.note) + '</dd>' : '') +
      (d.status === 'received' ? '<dt>Received</dt><dd>' + escapeHtml(sdDay(d.received_at)) + (d.receive_note ? ' \u2014 ' + escapeHtml(d.receive_note) : '') + '</dd>' : '') + (d.status === 'cancelled' ? '<dt>Cancelled</dt><dd>' + escapeHtml(d.cancel_reason) + '</dd>' : '') + '</dl>' +
      '<div class="wz-lines">' + items.map(i=> '<div class="wz-li"><span>' + escapeHtml(i.description) + (i.item_note ? ' <em>' + escapeHtml(i.item_note) + '</em>' : '') + '</span><b>' + (i.qty_received == null ? sdNum(i.qty_expected) + ' expected' : sdNum(i.qty_received) + ' of ' + sdNum(i.qty_expected)) + ' ' + escapeHtml(i.unit || '') + '</b></div>').join('') + '</div>' +
      (d.status === 'received' ? '<h3 class="sd-h">Proof photos</h3><div class="sd-thumbs">' + (photos.length ? photos.map((p, n)=> urls[p.path] ? '<button type="button" class="sd-thumb" data-photo="' + escapeHtml(urls[p.path]) + '" aria-label="Open photo ' + (n + 1) + '"><img src="' + escapeHtml(urls[p.path]) + '" alt="Proof photo ' + (n + 1) + '"></button>' : '').join('') : '<div class="empty-state">No photos could be loaded.</div>') + '</div>' : '') +
      (d.status === 'assigned' ? '<button type="button" class="btn btn-secondary" id="sdCancelBtn" data-id="' + escapeHtml(d.id) + '" style="margin-top:12px;">Cancel this delivery</button>' : '');
  }
  function sdCancelDialog(id){
    mtDialog('Cancel this delivery?', '<div class="field"><label>Why?</label><input type="text" data-f="why" placeholder="e.g. supplier rescheduled"></div>', 'Cancel the delivery', async (body)=>{
      const why = body.querySelector('[data-f="why"]').value.trim();
      if(!why){ toast('Say why'); return false; }
      try{ const { error } = await db.rpc('site_delivery_cancel', { p_id:id, p_reason:why }); if(error) throw error; toast('Cancelled'); sdLoadList(); $live('sdDetail').style.display = 'none'; $live('sdList').style.display = ''; }
      catch(e){ toast('Couldn\u2019t cancel: ' + describeCloudError(e).replace(/^.*?:\s*(?=[A-Z])/, '')); return false; }
    });
  }
