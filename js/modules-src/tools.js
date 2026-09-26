  // =====================================================================
  // Tools & Equipment (migration 20260923_10_tools_equipment.sql)
  //
  // Every change of status / custody is ONE call to a tl_* database
  // function (issue, return, handover, sign, defect decision, calibration),
  // which validates it. Admins read the tools table; storekeepers and
  // workers read tools_view (no purchase cost).
  // =====================================================================

  const TL_CATEGORIES = ['Power Tools', 'Hand Tools', 'Testing & Measuring', 'Pumps & Recovery', 'Brazing & Welding',
    'Flaring & Swaging', 'Ladders & Access', 'Safety / PPE', 'Other'];
  const TL_STATUS = { available:'Available', issued:'Issued', defective:'Defective', repair:'In repair', lost:'Lost', retired:'Retired' };
  const TL_COND = { good:'Good', needs_repair:'Needs repair', defective:'Defective', missing_parts:'Missing parts', lost:'Lost' };
  const TL_SLIP = { issue:{ label:'Issue', title:'TOOL ISSUE SLIP' }, 'return':{ label:'Return', title:'TOOL RETURN SLIP' }, handover:{ label:'Handover', title:'TOOL HANDOVER SLIP' } };
  const TL_BUCKET = 'tool-files';
  // isAdmin: Super Admin. allWh: every warehouse (admin or department staff).
  // money: purchase / repair costs (admin, or staff with "See peso values").
  // canRegister / canDecide: Tool Register Edit / Defect Reports Edit.
  const tl = { tools:[], whs:[], mine:[], workers:[], jobs:[], projects:[], suppliers:[], isAdmin:false,
               allWh:false, money:false, canRegister:false, canDecide:false };

  const tlToday = ()=> poToday();
  const tlTool = (id)=> tl.tools.find(t=> t.id === id);
  const tlWh = (id)=> (tl.whs.find(w=> w.id === id) || {}).code || '';
  const tlOverdue = (t)=> t.status === 'issued' && t.due_back && t.due_back < tlToday();
  const tlMaintLate = (t)=> t.next_maint_due && t.next_maint_due < tlToday();
  const tlMaintSoon = (t)=> t.next_maint_due && !tlMaintLate(t) && t.next_maint_due <= new Date(Date.now() + 30 * 864e5 + 8 * 3600e3).toISOString().slice(0, 10);
  const tlStatusPill = (s)=> '<span class="tl-st ' + escapeHtml(s) + '">' + escapeHtml(TL_STATUS[s] || s) + '</span>';
  function tlLabel(t){ return t ? t.asset_tag + ' · ' + t.name : ''; }

  async function tlLoad(){
    tl.isAdmin = invIsAdmin();
    tl.allWh = tl.isAdmin || isStaffUser();
    tl.money = staffSeesCosts();
    tl.canRegister = tl.isAdmin || (isStaffUser() && can('tools.register', 'edit'));
    tl.canDecide = tl.isAdmin || (isStaffUser() && can('tools.defects', 'edit'));
    const [tools, whs, keep, wk, jobs, pr] = await Promise.all([
      db.from(tl.money ? 'tools' : 'tools_view').select('*').order('asset_tag'),
      db.from('warehouses').select('*').order('code'),
      tl.allWh ? Promise.resolve({ data:null }) : db.from('warehouse_storekeepers').select('warehouse_id').eq('user_id', currentUser.id),
      db.from('profiles').select('id, name').eq('role', 'technician').eq('active', true).order('name'),
      db.rpc('inv_open_job_orders'),
      db.from('projects').select('id, project_no, name, status').order('project_no', { ascending:false })
    ]);
    if(tools.error) throw tools.error;
    tl.tools = tools.data || [];
    tl.whs = whs.data || [];
    const ids = keep.data ? new Set(keep.data.map(k=> k.warehouse_id)) : null;
    tl.mine = tl.whs.filter(w=> w.is_active && (!ids || ids.has(w.id)));
    tl.workers = wk.data || [];
    tl.jobs = jobs.error ? [] : (jobs.data || []);
    tl.projects = pr.error ? [] : (pr.data || []);
  }
  async function tlEnter(needWh){
    if(!(await ensureCloud())){ toast('Not connected'); return false; }
    try{ await tlLoad(); }
    catch(e){ purchFail(invMissingTables(e) ? 'Run migration 20260923_10_tools_equipment.sql first: ' : 'Couldn\u2019t load tools: ', e); return false; }
    if(needWh && !tl.mine.length){ toast(tl.allWh ? 'Add an active warehouse first' : 'You aren\u2019t assigned to a warehouse'); return false; }
    $('purchasingView').classList.add('po-wide');
    return true;
  }
  const tlOpts = (list, val, lab, empty)=> (empty != null ? '<option value="">' + escapeHtml(empty) + '</option>' : '') +
    list.map(x=> '<option value="' + escapeHtml(val(x)) + '">' + escapeHtml(lab(x)) + '</option>').join('');
  const tlWhOpts = ()=> tlOpts(tl.mine, w=> w.id, w=> w.code + ' · ' + w.name);
  const tlWorkerOpts = (empty)=> tlOpts(tl.workers, w=> w.id, w=> w.name, empty || 'Choose a person…');
  const tlPrj = (pid, job)=>{ const p = tl.projects.find(x=> x.id === pid); return [p ? p.project_no + ' ' + p.name : '', job].filter(Boolean).join(' · '); };

  // navigation: hub buttons + "← Tools"
  $('purchasingView').addEventListener('click', (e)=>{
    const go = e.target.closest('[data-tl-go]'); if(go){ showPurchasingView(go.dataset.tlGo); return; }
    if(e.target.closest('[data-tl-hub]')) showPurchasingView('tlHub');
  });
  // "Here / Later on their phone" pickers
  $$('[data-signmode]').forEach(g=> g.addEventListener('click', (e)=>{
    const b = e.target.closest('[data-m]'); if(!b) return;
    g.querySelectorAll('[data-m]').forEach(x=> x.classList.toggle('on', x === b));
  }));
  const tlMode = (id)=> ($(id).querySelector('.on') || {}).dataset.m || 'counter';

  // ---------- signature capture ----------
  let tlPad = null, tlSignResolve = null;
  function tlSign(title, who){
    return new Promise(async (resolve)=>{
      tlSignResolve = resolve;
      $('tlSignTitle').textContent = title; $('tlSignWho').textContent = who || '';
      $('tlSignOverlay').classList.add('open');
      try{
        await loadAwesScript('signature', awesLibs.signature);
        const c = $('tlSignCanvas'), r = Math.max(window.devicePixelRatio || 1, 1);
        c.width = c.offsetWidth * r; c.height = c.offsetHeight * r; c.getContext('2d').scale(r, r);
        tlPad = new SignaturePad(c, { penColor:'#1C2621', backgroundColor:'rgba(255,255,255,0)' });
      }catch(e){ toast('Signature tool couldn\u2019t load — check the connection'); tlSignDone(null); }
    });
  }
  function tlSignDone(v){ $('tlSignOverlay').classList.remove('open'); const r = tlSignResolve; tlSignResolve = null; if(r) r(v); }
  $('tlSignClear').addEventListener('click', ()=>{ if(tlPad) tlPad.clear(); });
  $('tlSignClose').addEventListener('click', ()=> tlSignDone(null));
  $('tlSignOk').addEventListener('click', async ()=>{
    if(!tlPad || tlPad.isEmpty()){ toast('Please sign in the box'); return; }
    const c = poCleanSignature($('tlSignCanvas')) || $('tlSignCanvas');
    tlSignDone(await new Promise(res=> c.toBlob(res, 'image/png')));
  });
  async function tlUpload(blob, ext){
    const path = currentUser.id + '/' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.' + ext;
    const up = await db.storage.from(TL_BUCKET).upload(path, blob, { contentType: ext === 'png' ? 'image/png' : 'image/jpeg', upsert:false });
    if(up.error) throw up.error;
    return path;
  }
  async function tlPhotoBlob(file){
    const c = await poImageToPng(file, 1400, 1400);
    return { blob: await new Promise(res=> c.toBlob(res, 'image/jpeg', 0.8)), url: c.toDataURL('image/jpeg', 0.6) };
  }
  async function tlDownloadUrl(path){
    if(!path) return null;
    try{ const r = await db.storage.from(TL_BUCKET).download(path); return r.data ? await poBlobToDataUrl(r.data) : null; }catch(e){ return null; }
  }

  // ---------- QR scanner (built-in BarcodeDetector, else jsQR, else type it) ----------
  let tlScanStream = null, tlScanResolve = null, tlScanLoop = 0;
  function tlParseTag(txt){ const m = /TL-\d{3,}/i.exec(String(txt || '')); return m ? m[0].toUpperCase() : null; }
  function tlScan(){
    return new Promise(async (resolve)=>{
      tlScanResolve = resolve;
      $('tlScanManual').value = ''; $('tlScanMsg').textContent = 'Point the camera at the label.';
      $('tlScanOverlay').classList.add('open');
      try{
        tlScanStream = await navigator.mediaDevices.getUserMedia({ video:{ facingMode:'environment' }, audio:false });
        const v = $('tlScanVideo'); v.srcObject = tlScanStream; await v.play();
        let detect;
        if('BarcodeDetector' in window){ const bd = new BarcodeDetector({ formats:['qr_code'] }); detect = async ()=>{ const r = await bd.detect(v); return r[0] && r[0].rawValue; }; }
        else{
          await loadAwesScript('jsqr', awesLibs.jsqr);
          const cv = document.createElement('canvas'), cx = cv.getContext('2d', { willReadFrequently:true });
          detect = async ()=>{ if(!v.videoWidth) return null; cv.width = v.videoWidth; cv.height = v.videoHeight; cx.drawImage(v, 0, 0);
            const r = jsQR(cx.getImageData(0, 0, cv.width, cv.height).data, cv.width, cv.height); return r && r.data; };
        }
        const id = ++tlScanLoop;
        const tick = async ()=>{
          if(id !== tlScanLoop || !tlScanResolve) return;
          try{ const raw = await detect(); const tag = tlParseTag(raw); if(tag){ tlScanDone(tag); return; } }catch(e){}
          setTimeout(tick, 250);
        };
        tick();
      }catch(e){ $('tlScanMsg').textContent = 'Camera not available — type the asset tag below.'; }
    });
  }
  function tlScanDone(tag){
    tlScanLoop++;
    if(tlScanStream){ tlScanStream.getTracks().forEach(t=> t.stop()); tlScanStream = null; }
    $('tlScanOverlay').classList.remove('open');
    const r = tlScanResolve; tlScanResolve = null; if(r) r(tag);
  }
  $('tlScanClose').addEventListener('click', ()=> tlScanDone(null));
  $('tlScanManualOk').addEventListener('click', ()=>{ const t = tlParseTag($('tlScanManual').value); if(t) tlScanDone(t); else toast('Enter a tag like TL-0001'); });
  $('tlScanManual').addEventListener('keydown', (e)=>{ if(e.key === 'Enter') $('tlScanManualOk').click(); });

  // ---------- QR labels (vector QR, crisp at any size) ----------
  async function tlLabelsPdf(tools){
    if(!tools.length){ toast('No tools to label'); return; }
    await loadAwesScript('jspdf', awesLibs.jspdf); await loadAwesScript('qrgen', awesLibs.qrgen);
    await poLoadSettings().catch(()=>{});
    const co = (poSettingsData && poSettingsData.company_name) || 'AW Engineering Services';
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation:'p', unit:'mm', format:'a4', compress:true });
    const cols = 3, rows = 8, lw = 64, lh = 33, mx = (210 - cols * lw) / 2, my = (297 - rows * lh) / 2;
    tools.forEach((t, i)=>{
      if(i && i % (cols * rows) === 0) doc.addPage();
      const k = i % (cols * rows), x = mx + (k % cols) * lw, y = my + Math.floor(k / cols) * lh;
      doc.setDrawColor(200); doc.setLineWidth(0.2); doc.roundedRect(x + 1, y + 1, lw - 2, lh - 2, 2, 2);
      const qr = qrcode(0, 'M'); qr.addData('AWES-TOOL:' + t.asset_tag); qr.make();
      const n = qr.getModuleCount(), size = 25, cell = size / n, qx = x + 4, qy = y + (lh - size) / 2;
      doc.setFillColor(0, 0, 0);
      for(let r = 0; r < n; r++) for(let c = 0; c < n; c++) if(qr.isDark(r, c)) doc.rect(qx + c * cell, qy + r * cell, cell + 0.02, cell + 0.02, 'F');
      doc.setTextColor(21, 77, 52); doc.setFont('helvetica', 'bold'); doc.setFontSize(12); doc.text(t.asset_tag, qx + size + 3, y + 11);
      doc.setTextColor(30, 30, 30); doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5);
      doc.text(doc.splitTextToSize(t.name, lw - size - 10).slice(0, 2), qx + size + 3, y + 16);
      doc.setFontSize(6); doc.setTextColor(110); doc.text(doc.splitTextToSize(co, lw - size - 10).slice(0, 1), qx + size + 3, y + lh - 5);
    });
    $('previewOverlay').querySelector('h3').textContent = 'QR Labels';
    $('previewOkBtn').textContent = 'Close';
    $('previewOverlay').style.zIndex = '99';
    $('previewOverlay').classList.add('open');
    await renderPdfPreview(doc, 'tool-labels-' + tlToday() + '.pdf', 'Tool QR Labels');
  }

  // =====================================================================
  // REGISTER
  // =====================================================================
  let tlDetailTool = null, tlEditTool = null, tlKitRows = [];
  function tlRegView(v){
    $('tlRegList').style.display = v === 'list' ? '' : 'none';
    $('tlRegForm').style.display = v === 'form' ? '' : 'none';
    $('tlRegDetail').style.display = v === 'detail' ? '' : 'none';
    window.scrollTo({ top:0 });
  }
  async function tlShowRegister(){
    if(!(await tlEnter(false))) return;
    tlRegView('list');
    $('tlRegWh').innerHTML = '<option value="">All warehouses</option>' + tl.whs.map(w=> '<option value="' + escapeHtml(w.id) + '">' + escapeHtml(w.code) + '</option>').join('');
    tlRenderRegister();
  }
  function tlRegFiltered(){
    const st = $('tlRegStatus').value, wh = $('tlRegWh').value, kind = $('tlRegKind').value;
    const words = ($('tlRegSearch').value || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
    return tl.tools.filter(t=> (!wh || t.home_warehouse_id === wh) && (!kind || t.kind === kind) &&
      (!st || (st === 'overdue' ? tlOverdue(t) : st === 'maint' ? (tlMaintLate(t) || tlMaintSoon(t)) : t.status === st)) &&
      (!words.length || words.every(w=> [t.asset_tag, t.name, t.brand, t.model, t.serial_no, t.holder_name, t.category].join(' ').toLowerCase().includes(w))));
  }
  function tlRenderRegister(){
    const rows = tlRegFiltered(), all = tl.tools;
    const n = (f)=> all.filter(f).length;
    $('tlRegisterCount').textContent = all.length ? all.length + ' tools' : '';
    $('tlRegSummary').innerHTML = [['Available', n(t=> t.status === 'available')], ['Issued', n(t=> t.status === 'issued')], ['Overdue', n(tlOverdue)],
      ['Defective / repair', n(t=> t.status === 'defective' || t.status === 'repair')], ['Calibration overdue', n(tlMaintLate)]]
      .map(([k, v])=> '<div class="tile"><div class="k">' + k + '</div><div class="v">' + v + '</div></div>').join('');
    $('tlRegRows').innerHTML = rows.length ? rows.map(t=>
      '<button type="button" class="mt-row" data-id="' + escapeHtml(t.id) + '"><div class="mt-row-main"><div class="mt-row-title"><span class="mt-code">' + escapeHtml(t.asset_tag) + '</span>' +
      escapeHtml(t.name) + (t.kind === 'kit' ? ' <span class="sp-tag muted">Kit · ' + (t.kit_contents || []).length + ' items</span>' : '') + ' ' + tlStatusPill(t.status) + '</div>' +
      '<div class="sp-row-sub">' + escapeHtml([t.category, [t.brand, t.model].filter(Boolean).join(' '), t.serial_no ? 'S/N ' + t.serial_no : '', tlWh(t.home_warehouse_id)].filter(Boolean).join(' · ')) + '</div>' +
      (t.status === 'issued' ? '<div class="sp-row-sub' + (tlOverdue(t) ? '" style="color:var(--danger);font-weight:700;' : '') + '">With ' + escapeHtml(t.holder_name) + (t.due_back ? ' · due ' + escapeHtml(poDateLong(t.due_back)) + (tlOverdue(t) ? ' — OVERDUE' : '') : '') + '</div>' : '') +
      (t.next_maint_due ? '<div class="sp-row-sub" style="' + (tlMaintLate(t) ? 'color:var(--danger);font-weight:700;' : tlMaintSoon(t) ? 'color:#9A6212;font-weight:700;' : '') + '">' + escapeHtml(t.maint_type === 'inspection' ? 'Inspection' : 'Calibration') + ' due ' + escapeHtml(poDateLong(t.next_maint_due)) + (tlMaintLate(t) ? ' — OVERDUE (can\u2019t be issued)' : '') + '</div>' : '') +
      '</div></button>').join('') : '<div class="empty-state">' + (all.length ? 'Nothing matches.' : 'No tools yet.' + (tl.canRegister ? ' Tap <b>+ Add Tool / Kit</b> or import a CSV.' : '')) + '</div>';
  }
  ['tlRegSearch'].forEach(id=> $(id).addEventListener('input', tlRenderRegister));
  ['tlRegStatus', 'tlRegWh', 'tlRegKind'].forEach(id=> $(id).addEventListener('change', tlRenderRegister));
  $('tlRegRows').addEventListener('click', (e)=>{ const r = e.target.closest('.mt-row'); if(r) tlOpenDetail(r.dataset.id); });
  $('tlScanBtn').addEventListener('click', async ()=>{
    const tag = await tlScan(); if(!tag) return;
    const t = tl.tools.find(x=> x.asset_tag === tag);
    if(t) tlOpenDetail(t.id); else toast(tag + ' isn\u2019t in the register' + (tl.allWh ? '' : ' (or not your warehouse)'));
  });
  $('tlLabelsBtn').addEventListener('click', async ()=>{
    const rows = tlRegFiltered();
    if(rows.length > 1 && !await uiConfirm('Print QR labels for the ' + rows.length + ' tools shown? (Filter the list first to print fewer.)')) return;
    tlLabelsPdf(rows).catch(e=> toast('Couldn\u2019t make labels: ' + e.message));
  });

  // ---------- add / edit (admin) ----------
  function tlRenderKitRows(){
    $('tlFKitRows').innerHTML = tlKitRows.map((k, i)=> '<div class="tl-kit-row" data-i="' + i + '"><input type="text" data-k="name" value="' + escapeHtml(k.name) + '" placeholder="e.g. Screwdriver set">' +
      '<input type="text" data-k="qty" inputmode="numeric" value="' + escapeHtml(String(k.qty)) + '" placeholder="Qty"><button type="button" class="tl-rm" data-rm="1">&minus;</button></div>').join('');
  }
  $('tlFKitRows').addEventListener('input', (e)=>{ const r = e.target.closest('[data-i]'); if(r) tlKitRows[+r.dataset.i][e.target.dataset.k] = e.target.value; });
  $('tlFKitRows').addEventListener('click', (e)=>{ if(!e.target.closest('[data-rm]')) return; tlKitRows.splice(+e.target.closest('[data-i]').dataset.i, 1); tlRenderKitRows(); });
  $('tlFKitAdd').addEventListener('click', ()=>{ tlKitRows.push({ name:'', qty:1 }); tlRenderKitRows(); });
  function tlFormKind(){
    const kit = $('tlFKind').value === 'kit';
    $('tlFKitSec').style.display = kit ? '' : 'none';
    $('tlFSerialsWrap').style.display = !tlEditTool && Number($('tlFQty').value) > 1 ? '' : 'none';
  }
  $('tlFKind').addEventListener('change', tlFormKind);
  $('tlFQty').addEventListener('input', tlFormKind);
  async function tlOpenForm(t){
    tlEditTool = t || null;
    $('tlFormTitle').textContent = t ? 'Edit ' + t.asset_tag : 'New Tool / Kit';
    $('tlFCat').innerHTML = TL_CATEGORIES.map(c=> '<option>' + escapeHtml(c) + '</option>').join('');
    $('tlFWh').innerHTML = tlOpts(tl.whs.filter(w=> w.is_active || (t && w.id === t.home_warehouse_id)), w=> w.id, w=> w.code + ' · ' + w.name);
    const sup = await db.from('suppliers').select('id, name, trade_name').eq('is_active', true).order('name');
    $('tlFSup').innerHTML = tlOpts(sup.data || [], s=> s.id, s=> s.trade_name || s.name, '— none —');
    const v = (id, x)=>{ $(id).value = x == null ? '' : String(x); };
    v('tlFKind', t ? t.kind : 'tool'); v('tlFName', t && t.name); v('tlFCat', t ? t.category : 'Power Tools'); v('tlFBrand', t && t.brand); v('tlFModel', t && t.model);
    v('tlFSerial', t && t.serial_no); v('tlFWh', t ? t.home_warehouse_id : (tl.mine[0] || tl.whs[0] || {}).id); v('tlFQty', 1); v('tlFSerials', '');
    v('tlFMaint', t && t.maint_type); v('tlFInterval', t && t.maint_interval_days); v('tlFNext', t && t.next_maint_due);
    v('tlFPDate', t && t.purchase_date); v('tlFCost', t && t.purchase_cost); v('tlFSup', t && t.supplier_id); v('tlFPo', t && t.po_no);
    v('tlFWarranty', t && t.warranty_until); v('tlFNotes', t && t.notes);
    $('tlFQtyWrap').style.display = t ? 'none' : '';
    tlKitRows = t ? (t.kit_contents || []).map(k=> Object.assign({}, k)) : [];
    tlRenderKitRows(); tlFormKind();
    tlRegView('form');
  }
  $('tlAddBtn').addEventListener('click', ()=> tlOpenForm(null));
  $('tlFormBack').addEventListener('click', ()=> tlEditTool ? tlOpenDetail(tlEditTool.id) : tlRegView('list'));
  $('tlFSave').addEventListener('click', async ()=>{
    const name = $('tlFName').value.trim();
    if(!name){ toast('Enter the tool name'); return; }
    const cost = spParseMoney($('tlFCost').value), iv = $('tlFInterval').value.trim() ? parseInt($('tlFInterval').value, 10) : null;
    if(Number.isNaN(cost)){ toast('Cost must be a number'); return; }
    if($('tlFMaint').value && !(iv > 0)){ toast('Enter how often it needs ' + $('tlFMaint').value + ' (days)'); return; }
    const kind = $('tlFKind').value;
    const kit = kind === 'kit' ? tlKitRows.filter(k=> String(k.name).trim()).map(k=> ({ name: String(k.name).trim(), qty: Math.max(1, parseInt(k.qty, 10) || 1) })) : [];
    if(kind === 'kit' && !kit.length){ toast('List what\u2019s in the kit'); return; }
    const row = { kind, name, category: $('tlFCat').value, brand: $('tlFBrand').value.trim(), model: $('tlFModel').value.trim(), home_warehouse_id: $('tlFWh').value,
      kit_contents: kit, maint_type: $('tlFMaint').value || null, maint_interval_days: $('tlFMaint').value ? iv : null, next_maint_due: $('tlFMaint').value ? ($('tlFNext').value || null) : null,
      purchase_date: $('tlFPDate').value || null, purchase_cost: cost, supplier_id: $('tlFSup').value || null, po_no: $('tlFPo').value.trim(),
      warranty_until: $('tlFWarranty').value || null, notes: $('tlFNotes').value.trim() };
    if(!(await purchEnsureSession())) return;
    try{
      if(tlEditTool){
        const upd = Object.assign(row, { serial_no: $('tlFSerial').value.trim() });
        // Staff save through the database (purchase fields only with "See
        // peso values" — never blanked by a form that didn't show them).
        const { error } = isStaffUser()
          ? await db.rpc('tl_staff_save_tools', { p_id: tlEditTool.id, p_rows: [upd] })
          : await db.from('tools').update(upd).eq('id', tlEditTool.id);
        if(error) throw error;
        toast(tlEditTool.asset_tag + ' saved');
        await tlLoad(); tlOpenDetail(tlEditTool.id);
      }else{
        const qty = Math.max(1, Math.min(200, parseInt($('tlFQty').value, 10) || 1));
        const serials = $('tlFSerials').value.split(/\r?\n/).map(x=> x.trim());
        const rows = Array.from({ length: qty }, (_, i)=> Object.assign({}, row, { serial_no: qty === 1 ? $('tlFSerial').value.trim() : (serials[i] || '') }));
        const { data, error } = isStaffUser()
          ? await db.rpc('tl_staff_save_tools', { p_id: null, p_rows: rows })
          : await db.from('tools').insert(rows).select('id, asset_tag');
        if(error) throw error;
        toast('Added ' + data.map(x=> x.asset_tag).join(', '));
        await tlLoad(); tlRegView('list'); tlRenderRegister();
        if(await uiConfirm('Print QR labels for the new ' + (data.length === 1 ? 'tool' : data.length + ' tools') + ' now?')) tlLabelsPdf(tl.tools.filter(t=> data.some(d=> d.id === t.id)));
      }
    }catch(e){ purchFail('Couldn\u2019t save: ', e); }
  });
  // CSV import (admin): name, kind, category, brand, model, serial_no, warehouse_code, purchase_date, purchase_cost, maint_type, maint_interval_days, next_maint_due
  $('tlImportBtn').addEventListener('click', ()=>{ $('tlImportFile').value = ''; $('tlImportFile').click(); });
  $('tlImportFile').addEventListener('change', async ()=>{
    const f = $('tlImportFile').files && $('tlImportFile').files[0]; if(!f) return;
    const rows = spParseCsv(await f.text()); if(rows.length < 2){ toast('The CSV has no data rows'); return; }
    const h = rows[0].map(x=> x.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_')), col = (r, k)=>{ const i = h.indexOf(k); return i < 0 ? '' : String(r[i] || '').trim(); };
    if(!h.includes('name') || !h.includes('warehouse_code')){ toast('CSV needs at least: name, warehouse_code'); return; }
    const out = [], bad = [];
    rows.slice(1).forEach((r, i)=>{
      const w = tl.whs.find(x=> x.code.toUpperCase() === col(r, 'warehouse_code').toUpperCase());
      if(!col(r, 'name') || !w){ bad.push(i + 2); return; }
      const mt = ['calibration', 'inspection'].includes(col(r, 'maint_type')) ? col(r, 'maint_type') : null;
      out.push({ name: col(r, 'name'), kind: col(r, 'kind') === 'kit' ? 'kit' : 'tool', category: TL_CATEGORIES.find(c=> c.toLowerCase() === col(r, 'category').toLowerCase()) || 'Other',
        brand: col(r, 'brand'), model: col(r, 'model'), serial_no: col(r, 'serial_no'), home_warehouse_id: w.id, purchase_date: col(r, 'purchase_date') || null,
        purchase_cost: col(r, 'purchase_cost') ? spParseMoney(col(r, 'purchase_cost')) : null, maint_type: mt,
        maint_interval_days: mt && parseInt(col(r, 'maint_interval_days'), 10) > 0 ? parseInt(col(r, 'maint_interval_days'), 10) : null, next_maint_due: mt ? (col(r, 'next_maint_due') || null) : null });
    });
    if(!out.length){ toast('Nothing to import' + (bad.length ? ' — check rows ' + bad.slice(0, 5).join(', ') : '')); return; }
    if(!await uiConfirm('Add ' + out.length + ' tool' + (out.length === 1 ? '' : 's') + (bad.length ? ' (skipping ' + bad.length + ' row(s) with no name or unknown warehouse)' : '') + '?')) return;
    const { data, error } = isStaffUser()
      ? await db.rpc('tl_staff_save_tools', { p_id: null, p_rows: out })
      : await db.from('tools').insert(out).select('id');
    if(error){ purchFail('Import failed: ', error); return; }
    toast('Imported ' + data.length + ' tools'); await tlLoad(); tlRenderRegister();
  });

  // ---------- detail + history ----------
  async function tlOpenDetail(id){
    const t = tlTool(id); if(!t) return;
    tlDetailTool = t;
    $('tlDetTitle').innerHTML = '<span class="mt-code">' + escapeHtml(t.asset_tag) + '</span> ' + escapeHtml(t.name) + ' ' + tlStatusPill(t.status);
    const kv = (k, v)=> v ? '<div><div class="k">' + k + '</div><div class="v">' + v + '</div></div>' : '';
    $('tlDetInfo').innerHTML = kv('Type', t.kind === 'kit' ? 'Kit' : 'Tool / equipment') + kv('Category', escapeHtml(t.category)) + kv('Brand / model', escapeHtml([t.brand, t.model].filter(Boolean).join(' '))) +
      kv('Serial no.', escapeHtml(t.serial_no)) + kv('Home warehouse', escapeHtml(tlWh(t.home_warehouse_id))) +
      (t.status === 'issued' ? kv('With', escapeHtml(t.holder_name) + (t.due_back ? ' · due ' + escapeHtml(poDateLong(t.due_back)) : '') + (tlOverdue(t) ? ' <b style="color:var(--danger)">OVERDUE</b>' : '')) + kv('For', escapeHtml(tlPrj(t.project_id, t.job_order_id))) : '') +
      (t.maint_type ? kv(t.maint_type === 'inspection' ? 'Inspection' : 'Calibration', 'every ' + t.maint_interval_days + ' days · next ' + escapeHtml(poDateLong(t.next_maint_due)) + (tlMaintLate(t) ? ' <b style="color:var(--danger)">OVERDUE</b>' : '')) : '') +
      (t.kind === 'kit' ? '<div class="wide"><div class="k">Kit contents</div><div class="v">' + escapeHtml((t.kit_contents || []).map(k=> k.name + (k.qty > 1 ? ' ×' + k.qty : '')).join(', ')) + '</div></div>' : '') +
      kv('Purchased', escapeHtml([t.purchase_date ? poDateLong(t.purchase_date) : '', t.po_no, t.purchase_cost != null && tl.money ? '₱' + poFmt(t.purchase_cost) : ''].filter(Boolean).join(' · '))) +
      kv('Warranty until', t.warranty_until ? escapeHtml(poDateLong(t.warranty_until)) + (t.warranty_until < tlToday() ? ' (expired)' : '') : '');
    const b = (a, l, c)=> '<button type="button" class="btn ' + (c || 'btn-secondary') + '" data-da="' + a + '">' + l + '</button>';
    $('tlDetActions').innerHTML = b('label', 'Print QR Label') + (t.maint_type && t.status !== 'issued' ? b('maint', 'Record ' + (t.maint_type === 'inspection' ? 'Inspection' : 'Calibration')) : '') +
      (tl.canRegister ? b('edit', 'Edit') + (t.status === 'lost' ? b('found', 'Mark Found') : '') + (['available', 'lost', 'defective'].includes(t.status) ? b('retire', 'Retire', 'danger') : '') : '');
    tlRegView('detail');
    const h = await db.from('tool_events').select('*').eq('tool_id', t.id).order('at', { ascending:false }).limit(200);
    $('tlDetHist').innerHTML = (h.data || []).length ? '<thead><tr><th>When</th><th>Event</th><th>Ref.</th><th>Details</th><th>By</th></tr></thead><tbody>' +
      h.data.map(e=> '<tr><td>' + escapeHtml(mrWhen(e.at)) + '</td><td><b>' + escapeHtml(e.event) + '</b></td><td>' + escapeHtml(e.ref) + '</td><td>' + escapeHtml(e.detail) + '</td><td>' + escapeHtml(e.by_name) + '</td></tr>').join('') + '</tbody>'
      : '<tbody><tr><td style="color:var(--text-muted);">No history yet.</td></tr></tbody>';
  }
  $('tlDetBack').addEventListener('click', ()=>{ tlRegView('list'); tlRenderRegister(); });
  $('tlDetActions').addEventListener('click', async (e)=>{
    const b = e.target.closest('[data-da]'); if(!b || !tlDetailTool) return;
    const t = tlDetailTool, a = b.dataset.da;
    if(a === 'label') return tlLabelsPdf([t]);
    if(a === 'edit') return tlOpenForm(t);
    if(a === 'maint'){ showPurchasingView('tlMaint'); setTimeout(()=> tlMaintOpenForm(t.id), 300); return; }
    const reason = await uiPrompt(a === 'found' ? 'Where was ' + t.asset_tag + ' found?' : 'Why is ' + t.asset_tag + ' being retired?');
    if(!reason || !reason.trim()) return;
    if(!(await purchEnsureSession())) return;
    const { error } = await db.rpc('tl_admin_status', { p_tool: t.id, p_status: a === 'found' ? 'available' : 'retired', p_note: reason.trim() });
    if(error){ purchFail('Couldn\u2019t update: ', error); return; }
    toast(t.asset_tag + (a === 'found' ? ' back in service' : ' retired')); await tlLoad(); tlOpenDetail(t.id);
  });

  // =====================================================================
  // DEFECTS
  // =====================================================================
  let tlDefects = [], tlDefOpen = null;
  async function tlShowDefects(){
    if(!(await tlEnter(false))) return;
    $('tlDefDetail').style.display = 'none'; $('tlDefList').style.display = '';
    const r = await db.from('tool_defects').select('*').order('created_at', { ascending:false }).limit(500);
    tlDefects = r.data || [];
    tlRenderDefects();
  }
  function tlRenderDefects(){
    const st = $('tlDefStatus').value, q = ($('tlDefSearch').value || '').trim().toLowerCase();
    const rows = tlDefects.filter(d=> (st === 'active' ? d.status !== 'closed' : !st || d.status === st) &&
      (!q || [d.defect_no, tlLabel(tlTool(d.tool_id)), d.worker_name, d.description].join(' ').toLowerCase().includes(q)));
    $('tlDefectsCount').textContent = tlDefects.filter(d=> d.status !== 'closed').length ? tlDefects.filter(d=> d.status !== 'closed').length + ' open' : '';
    $('tlDefRows').innerHTML = rows.length ? rows.map(d=>{ const t = tlTool(d.tool_id) || {};
      return '<button type="button" class="mt-row" data-id="' + escapeHtml(d.id) + '"><div class="mt-row-main"><div class="mt-row-title"><span class="mt-code">' + escapeHtml(d.defect_no) + '</span>' +
        escapeHtml(tlLabel(t)) + ' <span class="tl-st ' + (d.status === 'closed' ? 'retired' : d.status === 'in_repair' ? 'repair' : 'defective') + '">' + escapeHtml(d.status.replace('_', ' ')) + '</span>' +
        (d.under_warranty ? ' <span class="sp-tag">Under warranty</span>' : '') + '</div>' +
        '<div class="sp-row-sub">' + escapeHtml([TL_COND[d.condition] || d.condition, d.worker_name ? 'from ' + d.worker_name : '', mrWhen(d.created_at), d.decision !== 'pending' ? 'decision: ' + d.decision.replace('_', ' ') : ''].filter(Boolean).join(' · ')) + '</div>' +
        (d.description ? '<div class="sp-row-sub">' + escapeHtml(d.description) + '</div>' : '') + '</div></button>'; }).join('')
      : '<div class="empty-state">No defect reports here.</div>';
  }
  $('tlDefSearch').addEventListener('input', tlRenderDefects); $('tlDefStatus').addEventListener('change', tlRenderDefects);
  $('tlDefRows').addEventListener('click', (e)=>{ const r = e.target.closest('.mt-row'); if(r) tlOpenDefect(r.dataset.id); });
  $('tlDefBack').addEventListener('click', ()=>{ $('tlDefDetail').style.display = 'none'; $('tlDefList').style.display = ''; tlRenderDefects(); });
  async function tlOpenDefect(id){
    const d = tlDefects.find(x=> x.id === id); if(!d) return;
    tlDefOpen = d; const t = tlTool(d.tool_id) || {};
    $('tlDefTitle').innerHTML = '<span class="mt-code">' + escapeHtml(d.defect_no) + '</span> ' + escapeHtml(tlLabel(t));
    const kv = (k, v)=> v ? '<div><div class="k">' + k + '</div><div class="v">' + v + '</div></div>' : '';
    $('tlDefInfo').innerHTML = kv('Condition', escapeHtml(TL_COND[d.condition] || d.condition)) + kv('Returned by', escapeHtml(d.worker_name)) + kv('Job / project', escapeHtml(tlPrj(d.project_id, d.job_order_id))) +
      kv('Reported', escapeHtml(mrWhen(d.created_at) + ' by ' + d.reported_by_name)) + kv('Warranty', d.under_warranty ? '<b>Still under warranty</b> — claim from the supplier' : 'Not under warranty') +
      kv('Status', escapeHtml(d.status.replace('_', ' ') + (d.decision !== 'pending' ? ' · ' + d.decision.replace('_', ' ') : ''))) +
      (d.repair_cost != null && tl.money ? kv('Repair cost', '₱' + poFmt(d.repair_cost) + (d.repair_vendor ? ' · ' + escapeHtml(d.repair_vendor) : '')) : '') +
      (d.chargeable_to_worker ? kv('Chargeable to worker', 'Yes (per company policy)') : '') +
      '<div class="wide"><div class="k">Description</div><div class="v">' + escapeHtml(d.description || '—') + '</div></div>' +
      (d.photo_path ? '<div class="wide"><div class="k">Photo</div><div class="v mr-photo" id="tlDefPhoto">Loading…</div></div>' : '');
    if(d.photo_path) tlDownloadUrl(d.photo_path).then(u=>{ const el = document.getElementById('tlDefPhoto'); if(el) el.innerHTML = u ? '<img src="' + u + '">' : 'Photo unavailable'; });
    $('tlDCause').value = d.cause; $('tlDDec').value = d.decision; $('tlDVendor').value = d.repair_vendor || '';
    $('tlDCost').value = d.repair_cost != null ? String(d.repair_cost) : ''; $('tlDCharge').checked = !!d.chargeable_to_worker; $('tlDNote').value = '';
    $('tlDefDecideSec').style.display = tl.canDecide && d.status !== 'closed' ? '' : 'none';
    $('tlDefList').style.display = 'none'; $('tlDefDetail').style.display = '';
    window.scrollTo({ top:0 });
  }
  $('tlDefDecideSec').addEventListener('click', async (e)=>{
    const b = e.target.closest('[data-dstat]'); if(!b || !tlDefOpen) return;
    const st = b.dataset.dstat, dec = $('tlDDec').value, cost = spParseMoney($('tlDCost').value);
    if(st === 'closed' && dec === 'pending'){ toast('Choose a decision before closing'); return; }
    if(st === 'in_repair' && dec !== 'repair'){ toast('Set the decision to Repair first'); return; }
    if(Number.isNaN(cost)){ toast('Repair cost must be a number'); return; }
    if(st === 'closed' && !await uiConfirm('Close ' + tlDefOpen.defect_no + ' as "' + dec.replace('_', ' ') + '"? ' + (['replace', 'write_off'].includes(dec) ? 'The tool will be retired.' : 'The tool goes back into service.'))) return;
    if(!(await purchEnsureSession())) return;
    const { error } = await db.rpc('tl_decide_defect', { p: { defect_id: tlDefOpen.id, decision: dec, status: st, cause: $('tlDCause').value,
      repair_vendor: $('tlDVendor').value.trim(), repair_cost: cost, chargeable_to_worker: $('tlDCharge').checked, note: $('tlDNote').value.trim() } });
    if(error){ purchFail('Couldn\u2019t save the decision: ', error); return; }
    toast(tlDefOpen.defect_no + ' updated'); await tlShowDefects();
  });

  // =====================================================================
  // CALIBRATION & INSPECTION
  // =====================================================================
  let tlMaintTool = null;
  async function tlShowMaint(){
    if(!(await tlEnter(false))) return;
    $('tlMtForm').style.display = 'none';
    tlRenderMaint();
  }
  function tlRenderMaint(){
    const due = $('tlMtShow').value === 'due', q = ($('tlMtSearch').value || '').trim().toLowerCase();
    const rows = tl.tools.filter(t=> t.maint_type && t.status !== 'retired' && (!due || tlMaintLate(t) || tlMaintSoon(t)) &&
      (!q || [t.asset_tag, t.name, t.serial_no].join(' ').toLowerCase().includes(q))).sort((a, b)=> String(a.next_maint_due).localeCompare(String(b.next_maint_due)));
    $('tlMaintCount').textContent = tl.tools.filter(tlMaintLate).length ? tl.tools.filter(tlMaintLate).length + ' overdue' : '';
    $('tlMtRows').innerHTML = rows.length ? rows.map(t=> '<div class="sp-row" data-id="' + escapeHtml(t.id) + '"><div class="sp-row-top"><div style="min-width:0;"><div class="sp-row-title"><span class="mt-code">' + escapeHtml(t.asset_tag) + '</span> ' + escapeHtml(t.name) + ' ' + tlStatusPill(t.status) + '</div>' +
      '<div class="sp-row-sub">' + escapeHtml((t.maint_type === 'inspection' ? 'Inspection' : 'Calibration') + ' every ' + t.maint_interval_days + ' days · ' + tlWh(t.home_warehouse_id)) + '</div></div>' +
      '<div class="mt-row-price" style="' + (tlMaintLate(t) ? 'color:var(--danger);' : tlMaintSoon(t) ? 'color:#9A6212;' : '') + '">' + escapeHtml(t.next_maint_due ? poDateLong(t.next_maint_due) : 'not set') + '<div class="sp-row-sub">' + (tlMaintLate(t) ? 'OVERDUE' : tlMaintSoon(t) ? 'due soon' : 'next due') + '</div></div></div>' +
      '<div class="user-card-actions"><button type="button" class="primary" data-mt="1"' + (t.status === 'issued' ? ' disabled title="Return it first"' : '') + '>Record result</button></div></div>').join('')
      : '<div class="empty-state">' + (due ? 'Nothing overdue or due in the next 30 days. ✓' : 'No tools have a calibration or inspection schedule yet — set one on the tool.') + '</div>';
  }
  $('tlMtSearch').addEventListener('input', tlRenderMaint); $('tlMtShow').addEventListener('change', tlRenderMaint);
  $('tlMtRows').addEventListener('click', (e)=>{ if(e.target.closest('[data-mt]')) tlMaintOpenForm(e.target.closest('.sp-row').dataset.id); });
  function tlMaintOpenForm(id){
    const t = tlTool(id); if(!t) return;
    tlMaintTool = t;
    $('tlMtFormTitle').textContent = 'Record ' + (t.maint_type === 'inspection' ? 'inspection' : 'calibration') + ' — ' + t.asset_tag + ' ' + t.name;
    $('tlMtDate').value = tlToday(); $('tlMtResult').value = 'pass'; $('tlMtRef').value = ''; $('tlMtNote').value = '';
    $('tlMtForm').style.display = ''; $('tlMtForm').scrollIntoView({ block:'center' });
  }
  $('tlMtCancel').addEventListener('click', ()=>{ $('tlMtForm').style.display = 'none'; });
  $('tlMtSave').addEventListener('click', async ()=>{
    const t = tlMaintTool; if(!t) return;
    if($('tlMtResult').value === 'fail' && !$('tlMtNote').value.trim()){ toast('Describe why it failed'); return; }
    if(!(await purchEnsureSession())) return;
    const { data, error } = await db.rpc('tl_log_maintenance', { p: { tool_id: t.id, type: t.maint_type, done_on: $('tlMtDate').value, result: $('tlMtResult').value,
      cert_ref: $('tlMtRef').value.trim(), note: $('tlMtNote').value.trim() } });
    if(error){ purchFail('Couldn\u2019t save: ', error); return; }
    toast(data && data.defect_no ? 'Failed — ' + data.defect_no + ' opened; tool out of service' : 'Passed — next due ' + poDateLong(data.next_due));
    await tlLoad(); $('tlMtForm').style.display = 'none'; tlRenderMaint();
  });

  // =====================================================================
  // shared: tool line list with type-ahead + scan + optional photo
  // =====================================================================
  function tlLineList(id, pool){        // pool(): tools allowed on this list
    const st = { lines:[], pool };
    const find = $(id + 'Find');
    const add = (t)=>{
      if(!t){ return; }
      if(st.lines.some(l=> l.tool_id === t.id)){ toast(t.asset_tag + ' is already on the list'); return; }
      if(!st.pool().some(x=> x.id === t.id)){ toast(t.asset_tag + ' can\u2019t be added here (' + (TL_STATUS[t.status] || t.status) + (t.status === 'available' ? ', other warehouse' : '') + ')'); return; }
      st.lines.push({ tool_id: t.id, note:'', photo:null });
      render();
    };
    function render(){
      $(id).innerHTML = st.lines.length ? st.lines.map((l, i)=>{ const t = tlTool(l.tool_id);
        return '<div class="tl-line" data-i="' + i + '"><div class="tl-line-top"><div><span class="tl-tag">' + escapeHtml(t.asset_tag) + '</span> <span class="tl-name">' + escapeHtml(t.name) + '</span>' +
          '<div class="tl-sub">' + escapeHtml([t.kind === 'kit' ? 'Kit: ' + (t.kit_contents || []).map(k=> k.name + (k.qty > 1 ? ' ×' + k.qty : '')).join(', ') : '', t.serial_no ? 'S/N ' + t.serial_no : ''].filter(Boolean).join(' · ')) + '</div>' +
          (tlMaintLate(t) ? '<div class="tl-bad">' + escapeHtml((t.maint_type === 'inspection' ? 'Inspection' : 'Calibration') + ' overdue since ' + poDateLong(t.next_maint_due)) + ' — it won\u2019t be issued</div>' : tlMaintSoon(t) ? '<div class="tl-warn">' + escapeHtml((t.maint_type === 'inspection' ? 'Inspection' : 'Calibration') + ' due ' + poDateLong(t.next_maint_due)) + '</div>' : '') +
          '</div><button type="button" class="tl-rm" data-rm="1">&minus;</button></div>' +
          '<div class="tl-line-ctl"><label class="btn btn-secondary mt-small-btn" style="margin:0;">Photo<input type="file" accept="image/*" capture="environment" data-photo="1" style="display:none;"></label>' +
          '<input type="text" data-note="1" placeholder="Note (optional)" value="' + escapeHtml(l.note) + '"></div>' +
          (l.photo ? '<div class="tl-photo"><img src="' + l.photo.url + '"></div>' : '') + '</div>'; }).join('')
        : '<div class="empty-state" style="padding:12px;">No tools yet — type a tag or name below, or scan.</div>';
    }
    $(id).addEventListener('click', (e)=>{ if(e.target.closest('[data-rm]')){ st.lines.splice(+e.target.closest('[data-i]').dataset.i, 1); render(); } });
    $(id).addEventListener('input', (e)=>{ if(e.target.dataset.note) st.lines[+e.target.closest('[data-i]').dataset.i].note = e.target.value; });
    $(id).addEventListener('change', async (e)=>{
      if(!e.target.dataset.photo || !e.target.files[0]) return;
      try{ st.lines[+e.target.closest('[data-i]').dataset.i].photo = await tlPhotoBlob(e.target.files[0]); render(); }catch(err){ toast('Couldn\u2019t read that photo'); }
    });
    find.addEventListener('input', ()=>{
      const row = find.parentElement; let box = row.querySelector('.po-suggest');
      const w = find.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
      const hits = w.length ? st.pool().filter(t=> !st.lines.some(l=> l.tool_id === t.id) && w.every(x=> [t.asset_tag, t.name, t.serial_no, t.brand].join(' ').toLowerCase().includes(x))).slice(0, 8) : [];
      if(!hits.length){ if(box) box.remove(); return; }
      if(!box){ box = document.createElement('div'); box.className = 'po-suggest'; row.appendChild(box); }
      box.innerHTML = hits.map((t, i)=> '<button type="button" data-pick="' + escapeHtml(t.id) + '"' + (i === 0 ? ' class="hl"' : '') + '><span><b>' + escapeHtml(t.asset_tag) + '</b> ' + escapeHtml(t.name) + '</span><span class="s-price">' + escapeHtml(t.serial_no) + '</span></button>').join('');
      box.onclick = (ev)=>{ const b = ev.target.closest('[data-pick]'); if(!b) return; add(tlTool(b.dataset.pick)); find.value = ''; box.remove(); find.focus(); };
    });
    find.addEventListener('keydown', (e)=>{
      const box = find.parentElement.querySelector('.po-suggest');
      if(e.key === 'Enter'){ e.preventDefault(); const tag = tlParseTag(find.value);
        const t = tag ? tl.tools.find(x=> x.asset_tag === tag) : null;
        if(t){ add(t); find.value = ''; if(box) box.remove(); } else if(box){ const h = box.querySelector('.hl'); if(h) h.click(); } }
    });
    $(id + 'Scan').addEventListener('click', async ()=>{ const tag = await tlScan(); if(!tag) return; const t = tl.tools.find(x=> x.asset_tag === tag); if(t) add(t); else toast(tag + ' isn\u2019t in the register'); });
    st.render = render; st.reset = ()=>{ st.lines = []; render(); };
    return st;
  }
  // collect signatures (+ photos) then post
  async function tlSigsAndPost(opts){
    // opts: { keeperTitle, keeperWho, workerTitle, workerWho, needWorker, lines }
    const k = await tlSign(opts.keeperTitle, opts.keeperWho); if(!k) return null;
    let w = null;
    if(opts.needWorker){ w = await tlSign(opts.workerTitle, opts.workerWho); if(!w) return null; }
    const paths = { keeper: await tlUpload(k, 'png'), worker: w ? await tlUpload(w, 'png') : '' };
    for(const l of (opts.lines || [])) if(l.photo && !l.photo_path) l.photo_path = await tlUpload(l.photo.blob, 'jpg');
    return paths;
  }

  // =====================================================================
  // ISSUE
  // =====================================================================
  const tlIs = tlLineList('tlIsLines', ()=> tl.tools.filter(t=> t.status === 'available' && t.home_warehouse_id === $('tlIsWh').value));
  async function tlShowIssue(){
    if(!(await tlEnter(true))) return;
    $('tlIsWh').innerHTML = tlWhOpts(); $('tlIsWorker').innerHTML = tlWorkerOpts();
    $('tlIsJob').innerHTML = tlOpts(tl.jobs, j=> j.id, j=> j.id + (j.cust_name ? ' — ' + j.cust_name : ''), '— none —');
    $('tlIsProject').innerHTML = tlOpts(tl.projects.filter(p=> ['planning', 'active', 'on_hold'].includes(p.status)), p=> p.id, p=> p.project_no + ' — ' + p.name, '— none —');
    $('tlIsDue').value = ''; $('tlIsNote').value = ''; $('tlIsLinesFind').value = '';
    tlIs.reset();
  }
  $('tlIsWh').addEventListener('change', ()=>{ tlIs.lines = tlIs.lines.filter(l=> tlTool(l.tool_id).home_warehouse_id === $('tlIsWh').value); tlIs.render(); });
  $('tlIsPost').addEventListener('click', async ()=>{
    const worker = tl.workers.find(w=> w.id === $('tlIsWorker').value), wh = tl.mine.find(w=> w.id === $('tlIsWh').value);
    if(!worker){ toast('Choose who the tools are issued to'); return; }
    if(!tlIs.lines.length){ toast('Add at least one tool'); return; }
    const late = tlIs.lines.map(l=> tlTool(l.tool_id)).filter(tlMaintLate);
    if(late.length){ toast(late.map(t=> t.asset_tag).join(', ') + ': calibration/inspection overdue — remove it or record a pass first'); return; }
    if($('tlIsDue').value && $('tlIsDue').value < tlToday()){ toast('The due-back date is in the past'); return; }
    const mode = tlMode('tlIsMode');
    if(!(await purchEnsureSession())) return;
    const btn = $('tlIsPost'); btn.disabled = true;
    try{
      const sig = await tlSigsAndPost({ keeperTitle:'Warehouseman signature', keeperWho:'Issued by ' + (currentUser.name || '') + ' — ' + tlIs.lines.length + ' tool(s) to ' + worker.name,
        workerTitle:'Worker signature', workerWho: worker.name + ' — I received the tools listed, in good condition', needWorker: mode === 'counter', lines: tlIs.lines });
      if(!sig) return;
      const { data, error } = await db.rpc('tl_post_issue', { p: { warehouse_id: wh.id, worker_id: worker.id, job_order_id: $('tlIsJob').value || null, project_id: $('tlIsProject').value || null,
        due_back: $('tlIsDue').value || null, note: $('tlIsNote').value.trim(), sign_mode: mode, sig_keeper_path: sig.keeper, sig_worker_path: sig.worker,
        lines: tlIs.lines.map(l=> ({ tool_id: l.tool_id, photo_path: l.photo_path || '', note: l.note })) } });
      if(error) throw error;
      notifyUser(worker.id, 'Tools issued to you', data.slip_no + ' — ' + tlIs.lines.length + ' tool(s)' + (mode === 'phone' ? '. Open My Tools and sign to confirm.' : '.') + ($('tlIsDue').value ? ' Due back ' + poDateLong($('tlIsDue').value) + '.' : ''), 'tis-' + data.id);
      toast(data.slip_no + (mode === 'phone' ? ' posted — waiting for ' + worker.name + '\u2019s signature' : ' posted'));
      tlAfterPost(data.id);
    }catch(e){ purchFail('Couldn\u2019t issue: ', e); }
    finally{ btn.disabled = false; }
  });

  // =====================================================================
  // RETURN — tools held by the chosen worker
  // =====================================================================
  let tlRt = [];
  async function tlShowReturn(){
    if(!(await tlEnter(true))) return;
    $('tlRtWh').innerHTML = tlWhOpts();
    const holders = tl.workers.filter(w=> tl.tools.some(t=> t.status === 'issued' && t.holder_id === w.id));
    $('tlRtWorker').innerHTML = tlOpts(holders, w=> w.id, w=> w.name + ' (' + tl.tools.filter(t=> t.status === 'issued' && t.holder_id === w.id).length + ')', holders.length ? 'Choose a person…' : 'Nobody is holding tools');
    $('tlRtNote').value = ''; tlRt = [];
    $('tlRtLines').innerHTML = '<div class="empty-state" style="padding:12px;">Choose who is returning tools.</div>';
  }
  function tlRenderReturn(){
    $('tlRtLines').innerHTML = tlRt.length ? tlRt.map((l, i)=>{ const t = tlTool(l.tool_id);
      return '<div class="tl-line" data-i="' + i + '"><div class="tl-line-top"><label class="sp-check" style="margin:0;"><input type="checkbox" data-inc="1"' + (l.inc ? ' checked' : '') + '> ' +
        '<span><span class="tl-tag">' + escapeHtml(t.asset_tag) + '</span> <span class="tl-name">' + escapeHtml(t.name) + '</span></span></label>' +
        (tlOverdue(t) ? '<span class="tl-bad">overdue</span>' : '') + '</div>' +
        '<div class="tl-sub">' + escapeHtml([t.job_order_id, t.issued_at ? 'since ' + mrWhen(t.issued_at) : '', t.due_back ? 'due ' + poDateLong(t.due_back) : ''].filter(Boolean).join(' · ')) + '</div>' +
        (l.inc ? '<div class="tl-line-ctl"><select data-cond="1">' + Object.entries(TL_COND).map(([k, v])=> '<option value="' + k + '"' + (l.cond === k ? ' selected' : '') + '>' + v + '</option>').join('') + '</select>' +
          '<input type="text" data-note="1" placeholder="' + (l.cond === 'good' ? 'Note (optional)' : 'What\u2019s wrong? (or add a photo)') + '" value="' + escapeHtml(l.note) + '"></div>' +
          (t.kind === 'kit' && l.cond !== 'lost' ? '<div class="tl-kit"><span class="tl-sub">Missing from kit:</span>' + (t.kit_contents || []).map((k, ki)=> '<label><input type="checkbox" data-kit="' + ki + '"' + (l.missing.includes(ki) ? ' checked' : '') + '> ' + escapeHtml(k.name) + (k.qty > 1 ? ' ×' + k.qty : '') + '</label>').join('') + '</div>' : '') +
          (l.cond !== 'good' && l.cond !== 'lost' ? '<div class="tl-photo"><label class="btn btn-secondary mt-small-btn" style="margin:0;">Photo of the damage<input type="file" accept="image/*" capture="environment" data-photo="1" style="display:none;"></label>' + (l.photo ? '<img src="' + l.photo.url + '">' : '') + '</div>' : '') : '') +
        '</div>'; }).join('') : '<div class="empty-state" style="padding:12px;">This person isn\u2019t holding any tools.</div>';
  }
  $('tlRtWorker').addEventListener('change', ()=>{
    const w = $('tlRtWorker').value;
    tlRt = tl.tools.filter(t=> t.status === 'issued' && t.holder_id === w).map(t=> ({ tool_id: t.id, inc:true, cond:'good', note:'', missing:[], photo:null }));
    tlRenderReturn();
  });
  $('tlRtLines').addEventListener('change', async (e)=>{
    const r = e.target.closest('[data-i]'); if(!r) return; const l = tlRt[+r.dataset.i];
    if(e.target.dataset.inc){ l.inc = e.target.checked; tlRenderReturn(); }
    else if(e.target.dataset.cond){ l.cond = e.target.value; tlRenderReturn(); }
    else if(e.target.dataset.kit != null){ const k = +e.target.dataset.kit; l.missing = e.target.checked ? l.missing.concat(k) : l.missing.filter(x=> x !== k); }
    else if(e.target.dataset.photo && e.target.files[0]){ try{ l.photo = await tlPhotoBlob(e.target.files[0]); tlRenderReturn(); }catch(err){ toast('Couldn\u2019t read that photo'); } }
  });
  $('tlRtLines').addEventListener('input', (e)=>{ if(e.target.dataset.note) tlRt[+e.target.closest('[data-i]').dataset.i].note = e.target.value; });
  $('tlRtPost').addEventListener('click', async ()=>{
    const worker = tl.workers.find(w=> w.id === $('tlRtWorker').value), wh = tl.mine.find(w=> w.id === $('tlRtWh').value);
    const lines = tlRt.filter(l=> l.inc);
    if(!worker || !lines.length){ toast('Choose who is returning and tick the tools'); return; }
    for(const l of lines){ const t = tlTool(l.tool_id);
      if(l.cond !== 'good' && l.cond !== 'lost' && !l.photo && !l.note.trim() && !l.missing.length){ toast(t.asset_tag + ': add a photo or a note about the problem'); return; } }
    const bad = lines.filter(l=> l.cond !== 'good' || l.missing.length).length;
    if(bad && !await uiConfirm(bad + ' tool(s) not in good condition — a defect report opens for each and they go out of service. Continue?')) return;
    const mode = tlMode('tlRtMode');
    if(!(await purchEnsureSession())) return;
    const btn = $('tlRtPost'); btn.disabled = true;
    try{
      const sig = await tlSigsAndPost({ keeperTitle:'Warehouseman signature', keeperWho:'Received by ' + (currentUser.name || '') + ' — ' + lines.length + ' tool(s) from ' + worker.name,
        workerTitle:'Worker signature', workerWho: worker.name + ' — I returned the tools listed, in the condition noted', needWorker: mode === 'counter', lines });
      if(!sig) return;
      const { data, error } = await db.rpc('tl_post_return', { p: { warehouse_id: wh.id, worker_id: worker.id, note: $('tlRtNote').value.trim(), sign_mode: mode,
        sig_keeper_path: sig.keeper, sig_worker_path: sig.worker,
        lines: lines.map(l=>{ const t = tlTool(l.tool_id); return { tool_id: l.tool_id, condition: l.cond, note: l.note.trim(), photo_path: l.photo_path || '',
          kit_missing: l.missing.map(k=> t.kit_contents[k]) }; }) } });
      if(error) throw error;
      if(mode === 'phone') notifyUser(worker.id, 'Please sign your tool return', data.slip_no + ' — open My Tools and sign to confirm.', 'trs-' + data.id);
      toast(data.slip_no + ' posted' + (data.defects ? ' — ' + data.defects + ' defect report(s) opened' : ''));
      tlAfterPost(data.id);
    }catch(e){ purchFail('Couldn\u2019t receive: ', e); }
    finally{ btn.disabled = false; }
  });

  // =====================================================================
  // HANDOVER (admin / storekeeper screen; workers use My Tools)
  // =====================================================================
  let tlHo = [];
  async function tlShowHandover(){
    if(!(await tlEnter(false))) return;
    const holders = tl.workers.filter(w=> tl.tools.some(t=> t.status === 'issued' && t.holder_id === w.id));
    $('tlHoFrom').innerHTML = tlOpts(holders, w=> w.id, w=> w.name, holders.length ? 'Choose who has the tools…' : 'Nobody is holding tools');
    $('tlHoTo').innerHTML = tlWorkerOpts(); $('tlHoNote').value = ''; tlHo = [];
    $('tlHoLines').innerHTML = '<div class="empty-state" style="padding:12px;">Choose who is handing over.</div>';
  }
  function tlRenderPick(host, arr){
    $(host).innerHTML = arr.length ? arr.map((l, i)=>{ const t = tlTool(l.tool_id);
      return '<label class="tl-line" style="display:block;" data-i="' + i + '"><input type="checkbox" data-pick="1"' + (l.inc ? ' checked' : '') + '> <span class="tl-tag">' + escapeHtml(t.asset_tag) + '</span> <span class="tl-name">' + escapeHtml(t.name) + '</span>' +
        '<div class="tl-sub">' + escapeHtml([t.job_order_id, t.due_back ? 'due ' + poDateLong(t.due_back) : ''].filter(Boolean).join(' · ')) + '</div></label>'; }).join('')
      : '<div class="empty-state" style="padding:12px;">No tools held.</div>';
  }
  $('tlHoFrom').addEventListener('change', ()=>{ tlHo = tl.tools.filter(t=> t.status === 'issued' && t.holder_id === $('tlHoFrom').value).map(t=> ({ tool_id:t.id, inc:false })); tlRenderPick('tlHoLines', tlHo); });
  $('tlHoLines').addEventListener('change', (e)=>{ if(e.target.dataset.pick) tlHo[+e.target.closest('[data-i]').dataset.i].inc = e.target.checked; });
  async function tlDoHandover(fromId, toId, toolIds, note){
    const from = tl.workers.find(w=> w.id === fromId) || { name: currentUser.name }, to = tl.workers.find(w=> w.id === toId);
    if(!to || fromId === toId){ toast('Choose who is receiving the tools'); return null; }
    if(!toolIds.length){ toast('Tick the tools being handed over'); return null; }
    if(!(await purchEnsureSession())) return null;
    const g = await tlSign('Giver signature', from.name + ' — I handed over ' + toolIds.length + ' tool(s) to ' + to.name); if(!g) return null;
    const r = await tlSign('Receiver signature', to.name + ' — I received ' + toolIds.length + ' tool(s) from ' + from.name); if(!r) return null;
    const { data, error } = await db.rpc('tl_post_handover', { p: { from_worker_id: fromId, to_worker_id: toId, note: note || '',
      sig_giver_path: await tlUpload(g, 'png'), sig_receiver_path: await tlUpload(r, 'png'), lines: toolIds.map(id=> ({ tool_id:id })) } });
    if(error) throw error;
    notifyUser(toId, 'Tools handed over to you', data.slip_no + ' — ' + toolIds.length + ' tool(s) from ' + from.name + '. You\u2019re now responsible for them.', 'tho-' + data.id);
    toast(data.slip_no + ' — custody moved to ' + to.name);
    return data;
  }
  $('tlHoPost').addEventListener('click', async ()=>{
    const btn = $('tlHoPost'); btn.disabled = true;
    try{ const d = await tlDoHandover($('tlHoFrom').value, $('tlHoTo').value, tlHo.filter(l=> l.inc).map(l=> l.tool_id), $('tlHoNote').value.trim()); if(d) tlAfterPost(d.id); }
    catch(e){ purchFail('Couldn\u2019t hand over: ', e); }
    finally{ btn.disabled = false; }
  });

  // =====================================================================
  // SLIPS
  // =====================================================================
  let tlSlips = [], tlSlipOpen = null;
  async function tlAfterPost(slipId){
    showPurchasingView('tlSlips');
    setTimeout(()=> tlOpenSlip(slipId), 150);
  }
  async function tlShowSlips(){
    if(!(await tlEnter(false))) return;
    $('tlSlipDetail').style.display = 'none'; $('tlSlipList').style.display = '';
    const r = await db.from('tool_slips').select('*').order('created_at', { ascending:false }).limit(500);
    tlSlips = r.data || [];
    tlRenderSlips();
  }
  const tlParties = (s)=> s.type === 'issue' ? 'To ' + s.to_worker_name : s.type === 'return' ? 'From ' + s.from_worker_name : s.from_worker_name + ' → ' + s.to_worker_name;
  function tlRenderSlips(){
    const ty = $('tlSlipType').value, q = ($('tlSlipSearch').value || '').trim().toLowerCase();
    const rows = tlSlips.filter(s=> (!ty || (ty === 'pending' ? s.status === 'pending_signature' : s.type === ty)) && (!q || [s.slip_no, tlParties(s), s.job_order_id, s.note].join(' ').toLowerCase().includes(q)));
    $('tlSlipsCount').textContent = tlSlips.filter(s=> s.status === 'pending_signature').length ? tlSlips.filter(s=> s.status === 'pending_signature').length + ' awaiting signature' : '';
    $('tlSlipRows').innerHTML = rows.length ? rows.map(s=> '<button type="button" class="mt-row" data-id="' + escapeHtml(s.id) + '"><div class="mt-row-main"><div class="mt-row-title"><span class="mt-code">' + escapeHtml(s.slip_no) + '</span>' +
      escapeHtml(TL_SLIP[s.type].label) + ' <span class="po-status ' + (s.status === 'complete' ? 'fulfilled' : 'returned') + '">' + (s.status === 'complete' ? 'signed by both' : 'awaiting worker signature') + '</span></div>' +
      '<div class="sp-row-sub">' + escapeHtml([mrWhen(s.created_at), tlParties(s), s.job_order_id, s.warehouse_id ? tlWh(s.warehouse_id) : 'on site'].filter(Boolean).join(' · ')) + '</div></div></button>').join('')
      : '<div class="empty-state">No tool slips yet.</div>';
  }
  $('tlSlipSearch').addEventListener('input', tlRenderSlips); $('tlSlipType').addEventListener('change', tlRenderSlips);
  $('tlSlipRows').addEventListener('click', (e)=>{ const r = e.target.closest('.mt-row'); if(r) tlOpenSlip(r.dataset.id); });
  $('tlSlipBack').addEventListener('click', ()=>{ $('tlSlipDetail').style.display = 'none'; $('tlSlipList').style.display = ''; tlShowSlips(); });
  async function tlLoadSlip(id){
    const [h, l] = await Promise.all([db.from('tool_slips').select('*').eq('id', id), db.from('tool_slip_lines').select('*').eq('slip_id', id)]);
    if(h.error) throw h.error; if(l.error) throw l.error;
    if(!h.data || !h.data[0]) throw new Error('Slip not found');
    return { h: h.data[0], lines: l.data || [] };
  }
  function tlRenderSlipInto(d, pre){
    const s = d.h;
    $(pre + 'Title').innerHTML = '<span class="mt-code">' + escapeHtml(s.slip_no) + '</span> ' + escapeHtml(TL_SLIP[s.type].label) +
      ' <span class="po-status ' + (s.status === 'complete' ? 'fulfilled' : 'returned') + '">' + (s.status === 'complete' ? 'signed by both' : 'awaiting worker signature') + '</span>';
    const kv = (k, v)=> v ? '<div><div class="k">' + k + '</div><div class="v">' + v + '</div></div>' : '';
    $(pre + 'Info').innerHTML = kv('Date', escapeHtml(mrWhen(s.created_at))) + kv(s.type === 'handover' ? 'From' : s.type === 'issue' ? 'Warehouse' : 'Into', escapeHtml(s.type === 'handover' ? s.from_worker_name : tlWh(s.warehouse_id))) +
      kv(s.type === 'return' ? 'Returned by' : 'Received by', escapeHtml(s.type === 'return' ? s.from_worker_name : s.to_worker_name)) +
      kv(s.type === 'handover' ? 'Recorded by' : 'Warehouseman', escapeHtml(s.keeper_name)) + kv('Job / project', escapeHtml(tlPrj(s.project_id, s.job_order_id))) +
      kv('Due back', s.due_back ? escapeHtml(poDateLong(s.due_back)) : '') + kv('Worker signed', s.sign_mode === 'phone' ? 'on their phone' + (s.completed_at ? ' · ' + escapeHtml(mrWhen(s.completed_at)) : '') : 'at the counter') + kv('Note', escapeHtml(s.note));
    $(pre + 'Items').innerHTML = '<thead><tr><th>Tag</th><th>Tool</th><th>Serial</th>' + (s.type === 'return' ? '<th>Condition</th>' : '') + '<th>Note</th></tr></thead><tbody>' +
      d.lines.map(l=>{ const t = tlTool(l.tool_id) || { asset_tag:'?', name:'(tool)', serial_no:'' };
        return '<tr><td><b>' + escapeHtml(t.asset_tag) + '</b></td><td>' + escapeHtml(t.name) + '</td><td>' + escapeHtml(t.serial_no) + '</td>' +
          (s.type === 'return' ? '<td>' + (l.condition === 'good' ? 'Good' : '<span class="sp-tag danger">' + escapeHtml(TL_COND[l.condition]) + '</span>') + '</td>' : '') +
          '<td>' + escapeHtml([l.note, (l.kit_missing || []).length ? 'Missing: ' + l.kit_missing.map(k=> k.name).join(', ') : ''].filter(Boolean).join(' · ')) + '</td></tr>'; }).join('') + '</tbody>';
  }
  async function tlOpenSlip(id){
    try{
      if(!tl.tools.length) await tlLoad();
      tlSlipOpen = await tlLoadSlip(id);
      tlRenderSlipInto(tlSlipOpen, 'tlSlip');
      $('tlSlipList').style.display = 'none'; $('tlSlipDetail').style.display = '';
      window.scrollTo({ top:0 });
    }catch(e){ purchFail('Couldn\u2019t open the slip: ', e); }
  }
  $('tlSlipPdf').addEventListener('click', ()=>{ if(tlSlipOpen) tlSlipPdf(tlSlipOpen); });
  async function tlSlipPdf(d){
    try{
      await loadAwesScript('jspdf', awesLibs.jspdf); await loadAwesScript('autotable', awesLibs.autotable);
      await poLoadSettings().catch(()=>{});
      const co = poSettingsData || {}, style = co.header_style || 'green';
      const logo = co.logo_path ? await poLoadImage(co.logo_path).then(img=> poLogoForStyle(img, style)) : await poDefaultLogo(style);
      const fonts = await poLoadFonts();
      const { jsPDF } = window.jspdf; const doc = new jsPDF({ orientation:'p', unit:'pt', format:'a4', compress:true });
      let F = 'helvetica', FB = ['helvetica', 'bold'];
      if(fonts){ try{ doc.addFileToVFS('Inter-Regular.ttf', fonts.regular); doc.addFont('Inter-Regular.ttf', 'Inter', 'normal');
        doc.addFileToVFS('Inter-Bold.ttf', fonts.bold); doc.addFont('Inter-Bold.ttf', 'InterBold', 'normal'); F = 'Inter'; FB = ['InterBold', 'normal']; }catch(e){} }
      const W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight(), M = 36, G = [21, 77, 52], SUB = [96, 108, 101], INK = [28, 34, 30];
      const s = d.h, green = style !== 'white';
      if(green){ doc.setFillColor(...G); doc.rect(0, 0, W, 96, 'F'); } else { doc.setFillColor(...G); doc.rect(0, 92, W, 4, 'F'); }
      if(logo && logo.w){ const r = Math.min(140 / logo.w, 40 / logo.h); try{ doc.addImage(logo.dataUrl, 'PNG', M, 16, logo.w * r, logo.h * r, 'tl-logo', 'FAST'); }catch(e){} }
      doc.setTextColor(...(green ? [255, 255, 255] : INK));
      doc.setFont(F, 'normal'); doc.setFontSize(9); doc.text(co.company_name || '', M, 76);
      doc.setFont(FB[0], FB[1]); doc.setFontSize(16); doc.text(TL_SLIP[s.type].title, W - M, 36, { align:'right' });
      doc.setFontSize(10.5); doc.text(s.slip_no, W - M, 54, { align:'right' });
      doc.setFont(F, 'normal'); doc.setFontSize(8.8); doc.text(mrWhen(s.created_at), W - M, 68, { align:'right' });
      let y = 116;
      const info = [[s.type === 'handover' ? 'From' : 'Warehouse', s.type === 'handover' ? s.from_worker_name : tlWh(s.warehouse_id) + ' — ' + ((tl.whs.find(w=> w.id === s.warehouse_id) || {}).name || '')],
        [s.type === 'return' ? 'Returned by' : 'Received by', s.type === 'return' ? s.from_worker_name : s.to_worker_name], ['Job / project', tlPrj(s.project_id, s.job_order_id)],
        ['Due back', s.due_back ? poDateLong(s.due_back) : ''], ['Note', s.note]].filter(r=> r[1]);
      info.forEach(([k, v])=>{ doc.setFontSize(7.8); doc.setTextColor(...SUB); doc.text(k, M, y); doc.setFontSize(9); doc.setTextColor(...INK); const ls = doc.splitTextToSize(String(v), W - M * 2 - 90); doc.text(ls, M + 90, y); y += ls.length * 11 + 3; });
      doc.autoTable({ startY: y + 8, margin:{ left:M, right:M, bottom:60 },
        head:[['Tag', 'Tool', 'Serial no.'].concat(s.type === 'return' ? ['Condition'] : [], ['Note'])],
        body: d.lines.map(l=>{ const t = tlTool(l.tool_id) || {};
          return [t.asset_tag || '', t.name || '', t.serial_no || ''].concat(s.type === 'return' ? [TL_COND[l.condition]] : [],
            [[l.note, (l.kit_missing || []).length ? 'Missing: ' + l.kit_missing.map(k=> k.name).join(', ') : '', t.kind === 'kit' && s.type === 'issue' ? 'Kit: ' + (t.kit_contents || []).map(k=> k.name + (k.qty > 1 ? ' ×' + k.qty : '')).join(', ') : ''].filter(Boolean).join(' · ')]); }),
        // explicit row fills: without them the rows inherit the header band's green fill
        theme:'plain', styles:{ font:F, fontSize:8.6, cellPadding:5, textColor:INK, fillColor:[255, 255, 255], lineColor:[216, 223, 219], lineWidth:{ bottom:0.5 } },
        alternateRowStyles:{ fillColor:[247, 250, 248] },
        headStyles:{ font:F, fillColor:G, textColor:255, fontSize:7.8 }, columnStyles:{ 0:{ cellWidth:58, fontStyle:'bold' } } });
      const [kSig, wSig] = await Promise.all([s.sig_keeper_path, s.sig_worker_path].map(async p=>{ const u = await tlDownloadUrl(p); if(!u) return null; const z = await poImageSize(u); return { dataUrl:u, w:z.w, h:z.h }; }));
      const caps = s.type === 'issue' ? [['Issued by (warehouseman)', s.keeper_name, kSig], ['Received by (worker)', s.to_worker_name, wSig]]
        : s.type === 'return' ? [['Returned by (worker)', s.from_worker_name, wSig], ['Received by (warehouseman)', s.keeper_name, kSig]]
        : [['Handed over by', s.from_worker_name, kSig], ['Received by', s.to_worker_name, wSig]];
      const top = H - 46 - 92, sw = (W - M * 2 - 40) / 2;
      if(doc.lastAutoTable.finalY > top - 10) doc.addPage();
      caps.forEach(([cap, nm, img], i)=>{
        const x = M + i * (sw + 40);
        doc.setFont(F, 'normal'); doc.setFontSize(6.8); doc.setTextColor(...SUB); doc.text(cap.toUpperCase(), x, top);
        if(img && img.w){ const r = Math.min((sw - 20) / img.w, 46 / img.h); try{ doc.addImage(img.dataUrl, 'PNG', x + (sw - img.w * r) / 2, top + 58 - img.h * r, img.w * r, img.h * r, undefined, 'FAST'); }catch(e){} }
        else{ doc.setFontSize(7.4); doc.setTextColor(200, 120, 20); doc.text('awaiting signature', x + sw / 2, top + 40, { align:'center' }); }
        doc.setDrawColor(70, 76, 72); doc.setLineWidth(0.6); doc.line(x, top + 60, x + sw, top + 60);
        doc.setFont(FB[0], FB[1]); doc.setFontSize(8.6); doc.setTextColor(...INK); doc.text((nm || '').toUpperCase(), x + sw / 2, top + 72, { align:'center' });
      });
      doc.setFont(F, 'normal'); doc.setFontSize(7); doc.setTextColor(...SUB);
      doc.text(s.slip_no + '   •   ' + (co.company_name || '') + (s.status === 'complete' ? '' : '   •   NOT YET SIGNED BY THE WORKER'), M, H - 20);
      $('previewOverlay').querySelector('h3').textContent = TL_SLIP[s.type].label + ' ' + s.slip_no;
      $('previewOkBtn').textContent = 'Close'; $('previewOverlay').style.zIndex = '99'; $('previewOverlay').classList.add('open');
      await renderPdfPreview(doc, s.slip_no + '.pdf', TL_SLIP[s.type].label + ' ' + s.slip_no);
    }catch(e){ console.error('tool slip pdf', e); toast('Couldn\u2019t build the PDF: ' + (e && e.message ? e.message : e)); }
  }

  // =====================================================================
  // MY TOOLS (worker)
  // =====================================================================
  let tlMinePend = [], tlMineOpen = null, tlMineHo = [];
  async function tlShowMine(){
    $('tlMineSlip').style.display = 'none'; $('tlMineHo').style.display = 'none'; $('tlMineList').style.display = '';
    $('tlMinePending').innerHTML = '<div class="empty-state">Loading…</div>';
    if(!(await ensureCloud())) return;
    try{
      const [t, s, wk] = await Promise.all([db.from('tools_view').select('*').eq('holder_id', currentUser.id).order('asset_tag'),
        db.from('tool_slips').select('*').eq('status', 'pending_signature').order('created_at', { ascending:false }),
        db.from('profiles').select('id, name').eq('role', 'technician').eq('active', true).order('name')]);
      if(t.error) throw t.error;
      tl.tools = t.data || []; tl.workers = wk.data || [];
      tlMinePend = (s.data || []).filter(x=> (x.type === 'issue' && x.to_worker_id === currentUser.id) || (x.type === 'return' && x.from_worker_id === currentUser.id));
      $('tlMinePending').innerHTML = tlMinePend.length ? tlMinePend.map(x=> '<button type="button" class="mt-row" data-id="' + escapeHtml(x.id) + '"><div class="mt-row-main"><div class="mt-row-title"><span class="mt-code">' + escapeHtml(x.slip_no) + '</span>' +
        escapeHtml(TL_SLIP[x.type].label) + ' <span class="po-status returned">sign now</span></div><div class="sp-row-sub">' + escapeHtml(mrWhen(x.created_at) + ' · by ' + x.keeper_name) + '</div></div></button>').join('')
        : '<div class="empty-state" style="padding:12px;">Nothing to sign. 👍</div>';
      $('tlMineHold').innerHTML = tl.tools.length ? tl.tools.map(t=> '<div class="sp-row"><div class="sp-row-top"><div><div class="sp-row-title"><span class="mt-code">' + escapeHtml(t.asset_tag) + '</span> ' + escapeHtml(t.name) + '</div>' +
        '<div class="sp-row-sub">' + escapeHtml([t.job_order_id, t.kind === 'kit' ? (t.kit_contents || []).length + ' items in kit' : t.serial_no ? 'S/N ' + t.serial_no : ''].filter(Boolean).join(' · ')) + '</div></div>' +
        '<div class="mt-row-price" style="' + (tlOverdue(t) ? 'color:var(--danger);' : '') + '">' + (t.due_back ? escapeHtml(poDateLong(t.due_back)) : '—') + '<div class="sp-row-sub">' + (tlOverdue(t) ? 'OVERDUE' : 'due back') + '</div></div></div></div>').join('')
        : '<div class="empty-state" style="padding:12px;">You\u2019re not holding any company tools.</div>';
      $('tlMineHandover').style.display = tl.tools.length ? '' : 'none';
      tlSetMineBadge(tlMinePend.length, tl.tools.filter(tlOverdue).length);
    }catch(e){ $('tlMinePending').innerHTML = '<div class="empty-state">' + (invMissingTables(e) ? 'Tools aren\u2019t set up yet.' : 'Couldn\u2019t load: ' + escapeHtml(describeCloudError(e))) + '</div>'; }
  }
  function tlSetMineBadge(pend, overdue){
    const b = document.getElementById('techQaMyToolsBadge'); if(!b) return;
    const txt = [pend ? pend + ' to sign' : '', overdue ? overdue + ' overdue' : ''].filter(Boolean).join(' · ');
    b.textContent = txt; b.style.display = txt ? '' : 'none';
  }
  async function tlRefreshMineBadge(){
    if(!currentUser || currentUser.role === 'admin' || currentUser.role === 'customer') return;
    try{
      const [t, s] = await Promise.all([db.from('tools_view').select('status, due_back').eq('holder_id', currentUser.id), db.from('tool_slips').select('type, to_worker_id, from_worker_id').eq('status', 'pending_signature')]);
      if(t.error) return;
      tlSetMineBadge((s.data || []).filter(x=> (x.type === 'issue' && x.to_worker_id === currentUser.id) || (x.type === 'return' && x.from_worker_id === currentUser.id)).length, (t.data || []).filter(tlOverdue).length);
    }catch(e){}
  }
  $('techQaMyTools').addEventListener('click', ()=> showPurchasingView('myTools'));
  $('tlMinePending').addEventListener('click', async (e)=>{
    const r = e.target.closest('.mt-row'); if(!r) return;
    try{
      const d = await tlLoadSlip(r.dataset.id);
      const ids = d.lines.map(l=> l.tool_id).filter(id=> !tlTool(id));
      if(ids.length){ const x = await db.from('tools_view').select('*').in('id', ids); (x.data || []).forEach(t=> tl.tools.push(t)); }
      tlMineOpen = d; tlRenderSlipInto(d, 'tlMine');
      $('tlMineList').style.display = 'none'; $('tlMineSlip').style.display = ''; window.scrollTo({ top:0 });
    }catch(err){ purchFail('Couldn\u2019t open the slip: ', err); }
  });
  $('tlMineBack').addEventListener('click', tlShowMine);
  $('tlMineSign').addEventListener('click', async ()=>{
    if(!tlMineOpen) return;
    const s = tlMineOpen.h;
    const blob = await tlSign('Your signature', s.type === 'issue' ? 'I received the tools listed on ' + s.slip_no : 'I returned the tools listed on ' + s.slip_no + ', in the condition noted');
    if(!blob) return;
    if(!(await purchEnsureSession())) return;
    try{
      const path = await tlUpload(blob, 'png');
      const { error } = await db.rpc('tl_sign_slip', { p_slip: s.id, p_path: path });
      if(error) throw error;
      toast(s.slip_no + ' signed — thank you'); tlShowMine();
    }catch(e){ purchFail('Couldn\u2019t sign: ', e); }
  });
  $('tlMineHandover').addEventListener('click', ()=>{
    tlMineHo = tl.tools.map(t=> ({ tool_id:t.id, inc:false }));
    $('tlMineHoTo').innerHTML = tlOpts(tl.workers.filter(w=> w.id !== currentUser.id), w=> w.id, w=> w.name, 'Choose a person…');
    tlRenderPick('tlMineHoLines', tlMineHo);
    $('tlMineList').style.display = 'none'; $('tlMineHo').style.display = '';
  });
  $('tlMineHoLines').addEventListener('change', (e)=>{ if(e.target.dataset.pick) tlMineHo[+e.target.closest('[data-i]').dataset.i].inc = e.target.checked; });
  $('tlMineHoBack').addEventListener('click', tlShowMine);
  $('tlMineHoPost').addEventListener('click', async ()=>{
    const btn = $('tlMineHoPost'); btn.disabled = true;
    try{ tl.workers.push({ id: currentUser.id, name: currentUser.name });
      const d = await tlDoHandover(currentUser.id, $('tlMineHoTo').value, tlMineHo.filter(l=> l.inc).map(l=> l.tool_id), ''); if(d) tlShowMine(); }
    catch(e){ purchFail('Couldn\u2019t hand over: ', e); }
    finally{ btn.disabled = false; }
  });

  // =====================================================================
  // TOOL REPORTS (same engine / PDF / Excel as Inventory Reports)
  // =====================================================================
  let trTab = 'monthly', trModel = null;
  async function tlShowReports(){
    if(!(await tlEnter(false))) return;
    if(!$('trFrom').value){ $('trFrom').value = tlToday().slice(0, 7); $('trTo').value = tlToday().slice(0, 7); }
    $('trWh').innerHTML = '<option value="">All warehouses</option>' + (tl.allWh ? tl.whs : tl.mine).map(w=> '<option value="' + escapeHtml(w.id) + '">' + escapeHtml(w.code) + '</option>').join('');
    trSetTab(trTab);
  }
  function trSetTab(t){
    trTab = t; trModel = null;
    $$('#trTabs [data-tr]').forEach(b=> b.classList.toggle('active', b.dataset.tr === t));
    $$('#purchPanel_tlReports [data-trf]').forEach(f=>{ f.style.display = f.dataset.trf.split(' ').includes(t) ? '' : 'none'; });
    $('trSummary').innerHTML = ''; $('trCheck').textContent = ''; $('trOut').innerHTML = '<div class="empty-state">Choose the options and tap <b>Run Report</b>.</div>';
  }
  $('trTabs').addEventListener('click', (e)=>{ const b = e.target.closest('[data-tr]'); if(b) trSetTab(b.dataset.tr); });
  $('trPdf').addEventListener('click', ()=> rpExportPdf(trModel, $('trFrom').value));
  $('trXlsx').addEventListener('click', ()=> rpExportXlsx(trModel, $('trFrom').value));
  $('trRun').addEventListener('click', async ()=>{
    const btn = $('trRun'); btn.disabled = true;
    try{ await tlLoad(); trModel = await ({ monthly: trMonthly, custody: trCustody, defects: trDefects, register: trRegister })[trTab](); rpRender(trModel, 'tr'); }
    catch(e){ $('trOut').innerHTML = '<div class="empty-state">Couldn\u2019t run the report: ' + escapeHtml(describeCloudError(e)) + '</div>'; }
    finally{ btn.disabled = false; }
  });
  function trRange(){
    const f = $('trFrom').value, t = $('trTo').value || f, [y, m] = t.split('-').map(Number);
    return { first: f + '-01', last: new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10), label: f === t ? RP_MONTH(f + '-01') : RP_MONTH(f + '-01') + ' – ' + RP_MONTH(t + '-01') };
  }
  const trLocal = (ts)=> new Date(new Date(ts).getTime() + 8 * 3600e3).toISOString().slice(0, 10);
  const trWhOk = (id)=> !$('trWh').value || id === $('trWh').value;
  async function trMonthly(){
    const r = trRange();
    const [sl, df] = await Promise.all([db.from('tool_slips').select('*, tool_slip_lines(*)').gte('created_at', r.first + 'T00:00:00+08:00').lte('created_at', r.last + 'T23:59:59+08:00'),
      db.from('tool_defects').select('*').gte('created_at', r.first + 'T00:00:00+08:00').lte('created_at', r.last + 'T23:59:59+08:00')]);
    const months = []; for(let d = new Date(r.first + 'T00:00:00Z'); d.toISOString().slice(0, 10) <= r.last; d.setUTCMonth(d.getUTCMonth() + 1)) months.push(d.toISOString().slice(0, 7));
    const money = tl.money;
    const rows = months.map(mo=>{
      const bought = tl.tools.filter(t=> t.purchase_date && t.purchase_date.slice(0, 7) === mo && trWhOk(t.home_warehouse_id));
      const inM = (s)=> trLocal(s.created_at).slice(0, 7) === mo && (s.type === 'handover' || trWhOk(s.warehouse_id));
      const lines = (ty)=> (sl.data || []).filter(s=> s.type === ty && inM(s)).reduce((a, s)=> a.concat(s.tool_slip_lines || []), []);
      const ret = lines('return');
      return [RP_MONTH(mo + '-01'), bought.length, lines('issue').length, ret.filter(l=> l.condition === 'good').length, ret.filter(l=> ['needs_repair', 'defective', 'missing_parts'].includes(l.condition)).length,
        ret.filter(l=> l.condition === 'lost').length, lines('handover').length, (df.data || []).filter(d=> trLocal(d.created_at).slice(0, 7) === mo).length]
        .concat(money ? [bought.reduce((a, t)=> a + Number(t.purchase_cost || 0), 0)] : []);
    });
    const sum = (i)=> rows.reduce((a, x)=> a + x[i], 0);
    return { title:'Tools & Equipment — Monthly Movements', subtitle: r.label + ' · ' + ($('trWh').value ? tlWh($('trWh').value) : 'All warehouses'),
      summary: [['Purchased', String(sum(1))], ['Issued', String(sum(2))], ['Returned good', String(sum(3))], ['Defective / lost', String(sum(4) + sum(5))]].concat(money ? [['Spent on tools', invMoney(sum(8))]] : []),
      sheets:[{ name:'Monthly', head:['Month', 'Purchased', 'Issued', 'Returned good', 'Returned defective', 'Lost', 'Handovers', 'Defect reports'].concat(money ? ['Purchase cost ₱'] : []), rows,
        numCols:[1, 2, 3, 4, 5, 6, 7], moneyCols: money ? [8] : null, totalRow: ['Total', sum(1), sum(2), sum(3), sum(4), sum(5), sum(6), sum(7)].concat(money ? [sum(8)] : []) }] };
  }
  async function trCustody(){
    const out = tl.tools.filter(t=> t.status === 'issued' && trWhOk(t.home_warehouse_id)).sort((a, b)=> String(a.holder_name).localeCompare(String(b.holder_name)) || String(a.due_back || '9').localeCompare(String(b.due_back || '9')));
    const days = (t)=> t.issued_at ? Math.round((Date.now() - new Date(t.issued_at).getTime()) / 864e5) : '';
    return { title:'Tools in Custody & Overdue', subtitle:'As of ' + poDateLong(tlToday()),
      summary:[['Tools out', String(out.length)], ['Workers', String(new Set(out.map(t=> t.holder_id)).size)], ['Overdue', String(out.filter(tlOverdue).length)]],
      sheets:[{ name:'Custody', head:['Worker', 'Tag', 'Tool', 'Serial', 'Job / project', 'Issued', 'Due back', 'Days out', 'Status'],
        rows: out.map(t=> [t.holder_name, t.asset_tag, t.name, t.serial_no, tlPrj(t.project_id, t.job_order_id), t.issued_at ? poDateLong(trLocal(t.issued_at)) : '', t.due_back ? poDateLong(t.due_back) : '—', days(t), tlOverdue(t) ? 'OVERDUE' : 'ok']),
        groupCol:0, numCols:[7], flagRow:(row)=> row[8] === 'OVERDUE' }] };
  }
  async function trDefects(){
    const r = trRange();
    const q = await db.from('tool_defects').select('*').gte('created_at', r.first + 'T00:00:00+08:00').lte('created_at', r.last + 'T23:59:59+08:00').order('created_at');
    const ds = (q.data || []).filter(d=>{ const t = tlTool(d.tool_id); return !t || trWhOk(t.home_warehouse_id); });
    const money = tl.money;
    const grp = (key)=>{ const m = new Map(); ds.forEach(d=>{ const k = key(d) || '—'; const e = m.get(k) || [k, 0, 0]; e[1]++; e[2] += Number(d.repair_cost || 0); m.set(k, e); }); return Array.from(m.values()).sort((a, b)=> b[1] - a[1]); };
    const model = (d)=>{ const t = tlTool(d.tool_id) || {}; return [t.name, t.brand, t.model].filter(Boolean).join(' '); };
    const cut = (rows)=> money ? rows : rows.map(x=> x.slice(0, 2));
    return { title:'Defective Tools Report', subtitle: r.label,
      summary:[['Defect reports', String(ds.length)], ['Still open', String(ds.filter(d=> d.status !== 'closed').length)], ['Under warranty', String(ds.filter(d=> d.under_warranty).length)]].concat(money ? [['Repair cost', invMoney(ds.reduce((a, d)=> a + Number(d.repair_cost || 0), 0))]] : []),
      sheets:[
        { name:'Defects', head:['Date', 'DEF no.', 'Tag', 'Tool', 'Condition', 'Worker', 'Cause', 'Decision', 'Status', 'Warranty'].concat(money ? ['Repair ₱'] : []),
          rows: ds.map(d=>{ const t = tlTool(d.tool_id) || {}; return [poDateLong(trLocal(d.created_at)), d.defect_no, t.asset_tag || '', t.name || '', TL_COND[d.condition] || d.condition, d.worker_name || '—', d.cause, d.decision.replace('_', ' '), d.status.replace('_', ' '), d.under_warranty ? 'yes' : ''].concat(money ? [d.repair_cost != null ? Number(d.repair_cost) : ''] : []); }),
          moneyCols: money ? [10] : null, landscape:true },
        { name:'By Tool Model', head:['Tool model', 'Defects'].concat(money ? ['Repair ₱'] : []), rows: cut(grp(model)), numCols:[1], moneyCols: money ? [2] : null },
        { name:'By Worker', head:['Worker', 'Defects'].concat(money ? ['Repair ₱'] : []), rows: cut(grp(d=> d.worker_name)), numCols:[1], moneyCols: money ? [2] : null },
        { name:'By Cause', head:['Cause', 'Defects'].concat(money ? ['Repair ₱'] : []), rows: cut(grp(d=> d.cause)), numCols:[1], moneyCols: money ? [2] : null }] };
  }
  async function trRegister(){
    const rows = tl.tools.filter(t=> trWhOk(t.home_warehouse_id)).sort((a, b)=> a.category.localeCompare(b.category) || a.asset_tag.localeCompare(b.asset_tag));
    const money = tl.money, val = (f)=> rows.filter(f).reduce((a, t)=> a + Number(t.purchase_cost || 0), 0);
    return { title:'Tool & Equipment Register', subtitle:'As of ' + poDateLong(tlToday()) + ' · ' + ($('trWh').value ? tlWh($('trWh').value) : 'All warehouses'),
      summary:[['Tools & kits', String(rows.length)], ['In service', String(rows.filter(t=> ['available', 'issued'].includes(t.status)).length)], ['Out of service', String(rows.filter(t=> ['defective', 'repair'].includes(t.status)).length)], ['Lost', String(rows.filter(t=> t.status === 'lost').length)]]
        .concat(money ? [['Value in service', invMoney(val(t=> ['available', 'issued'].includes(t.status)))], ['Value lost', invMoney(val(t=> t.status === 'lost'))]] : []),
      sheets:[{ name:'Register', head:['Category', 'Tag', 'Tool', 'Brand / model', 'Serial', 'Warehouse', 'Status', 'Holder', 'Next calibration', 'Purchased'].concat(money ? ['Cost ₱'] : []),
        rows: rows.map(t=> [t.category, t.asset_tag, t.name + (t.kind === 'kit' ? ' (kit)' : ''), [t.brand, t.model].filter(Boolean).join(' '), t.serial_no, tlWh(t.home_warehouse_id), TL_STATUS[t.status], t.holder_name,
          t.next_maint_due ? poDateLong(t.next_maint_due) + (tlMaintLate(t) ? ' (overdue)' : '') : '', t.purchase_date ? poDateLong(t.purchase_date) : ''].concat(money ? [t.purchase_cost != null ? Number(t.purchase_cost) : ''] : [])),
        groupCol:0, moneyCols: money ? [10] : null, flagRow:(row)=> ['Lost', 'Defective'].includes(row[6]) || String(row[8]).includes('overdue'), landscape:true }] };
  }

  // hub landing
  async function tlShowHub(){ await tlEnter(false); }
