  // =====================================================================
  // Errands — messenger / liaison officer (20261012_01 / _02)
  //
  //   Administration › Errands (adm.errands)       key 'errands'
  //       Requests · Active · To Review · Recurring · History; new / edit /
  //       approve / decline / assign / replace / cancel / close / confirm the
  //       stamped copy is back. Approve access manages recurring errands.
  //   Administration › My Errands (adm.my_errands) key 'myErrands'
  //       the messenger: Start → checklist (photo / signature per step) →
  //       transmittal (receiver signature OR stamped copy photo) → Done, or
  //       Couldn't complete. EVERY action records the time (server) and the
  //       phone's GPS location — nothing goes through without a location.
  //   My HR › Errand Requests (any staff)           key 'errandRequests'
  //   Transmittal slip PDF opens in the shared PDF viewer.
  // =====================================================================

  const ER_MIGRATION_MSG = 'Errands aren\u2019t set up in the database yet \u2014 run migrations <b>20261012_01_errands.sql</b> and <b>20261012_02_errands_alerts.sql</b> in Supabase first.';
  const ER_TYPES = { deliver:'Deliver documents / items', pickup:'Pick up', government:'Government office (BIR, SSS, PhilHealth, Pag-IBIG, LGU)',
    bank:'Bank', payment:'Pay a bill', purchase:'Buy / pick up materials', other:'Other' };
  const ER_STATUS = { requested:'Waiting for approval', open:'No messenger yet', assigned:'Assigned', in_progress:'In progress',
    done:'Done \u2014 to review', failed:'Couldn\u2019t complete', closed:'Closed', cancelled:'Cancelled' };
  const ER_STATUS_CLS = { requested:'warn', open:'warn', assigned:'', in_progress:'', done:'warn', failed:'danger', closed:'muted', cancelled:'muted' };
  const ER_FREQ = { daily:'Every day', weekly:'Every week', monthly:'Every month', yearly:'Every year' };
  const ER_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  const er = { tab:'active', list:[], messengers:[], recs:[], cur:null, files:[], tx:null, urls:new Map(), mode:'manager' };
  const erEsc = (v)=> escapeHtml(v == null ? '' : String(v));
  const erCanEdit = ()=> can('adm.errands', 'edit');
  const erCanApprove = ()=> can('adm.errands', 'approve');
  const erMissing = (e)=> /errand|PGRST20[25]|42P01|42883/.test(String((e && (e.message || e.code)) || ''));
  function erErr(prefix, e){
    if(typeof purchIsAuthError === 'function' && purchIsAuthError(e)) return PURCH_EXPIRED_HTML;
    return erMissing(e) && /does not exist|schema cache|could not find/i.test(String(e && e.message)) ? ER_MIGRATION_MSG : erEsc(prefix + describeCloudError(e));
  }
  function erWhen(ts){
    if(!ts) return '';
    try{ return new Date(ts).toLocaleString('en-PH', { timeZone:'Asia/Manila', month:'short', day:'numeric', year:'numeric', hour:'numeric', minute:'2-digit' }); }catch(e){ return ''; }
  }
  const erOverdue = (e)=> e.due_at && ['open', 'assigned', 'in_progress'].includes(e.status) && new Date(e.due_at).getTime() < Date.now();
  function erLocBtn(loc, label){
    if(!loc || loc.lat == null) return '';
    return '<button type="button" class="dtr-loc-tag er-loc" data-loc="' + erEsc(JSON.stringify(loc)) + '" data-loc-title="' + erEsc(label || 'Location') + '">\uD83D\uDCCD ' +
      erEsc(loc.address ? String(loc.address).split(',').slice(0, 2).join(',') : Number(loc.lat).toFixed(5) + ', ' + Number(loc.lng).toFixed(5)) + '</button>';
  }
  document.addEventListener('click', (e)=>{
    const b = e.target.closest('.er-loc');
    if(!b) return;
    try{ dtrOpenLocationOverlay(JSON.parse(b.dataset.loc), b.dataset.locTitle); }catch(err){}
  });
  // Every messenger action needs a location (timestamps come from the server).
  async function erLoc(){
    toast('Getting your location\u2026');
    const loc = await dtrGetLocation();
    if(!loc){ toast('Turn on location and allow it for this app \u2014 every errand step records where you are'); return null; }
    return loc;
  }
  function erIsoLocal(v){ return v ? new Date(v).toISOString() : null; }
  function erToLocalInput(ts){
    if(!ts) return '';
    const d = new Date(new Date(ts).getTime() + 8 * 3600e3);
    return d.toISOString().slice(0, 16);
  }
  function erFromLocalInput(v){ return v ? new Date(v + ':00+08:00').toISOString() : null; }
  async function erUrl(path){
    if(!path) return '';
    if(er.urls.has(path)) return er.urls.get(path);
    const { data } = await db.storage.from('errand-files').createSignedUrl(path, 3600);
    const u = (data && data.signedUrl) || '';
    er.urls.set(path, u);
    return u;
  }
  async function erUpload(errandId, fileOrBlob, kind, stepId, loc){
    let blob = fileOrBlob, ext = 'png', type = 'image/png';
    if(kind !== 'signature'){
      try{ blob = await compressImageForUpload(fileOrBlob, { targetBytes: 250 * 1024, maxDim: 1600 }); }catch(e){ blob = fileOrBlob; }
      ext = 'jpg'; type = 'image/jpeg';
    }
    const path = errandId + '/' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.' + ext;
    const up = await db.storage.from('errand-files').upload(path, blob, { contentType:type, upsert:false });
    if(up.error) throw up.error;
    if(kind !== 'none'){
      const { error } = await db.rpc('errand_add_file', { p_id:errandId, p_path:path, p_kind:kind, p_step:stepId || null, p_loc:loc || null });
      if(error) throw error;
    }
    return path;
  }
  function erPickPhoto(){
    return new Promise((resolve)=>{
      const inp = document.createElement('input');
      inp.type = 'file'; inp.accept = 'image/*'; inp.capture = 'environment';
      inp.onchange = ()=> resolve(inp.files && inp.files[0] ? inp.files[0] : null);
      inp.click();
    });
  }

  // ---------- signature pad (in-page dialog) ----------
  function erSignature(title, sub){
    return new Promise((resolve)=>{
      const ov = document.createElement('div');
      ov.className = 'overlay open er-sig-ov';
      ov.innerHTML = '<div class="modal er-sig-modal"><h3>' + erEsc(title) + '</h3>' + (sub ? '<p class="pay-hint">' + erEsc(sub) + '</p>' : '') +
        '<canvas class="er-sig-canvas" width="600" height="240"></canvas>' +
        '<div class="pay-actions"><button type="button" class="btn btn-secondary" data-sig="clear">Clear</button>' +
        '<button type="button" class="btn btn-secondary" data-sig="cancel">Cancel</button><button type="button" class="btn btn-primary" data-sig="ok">Use this signature</button></div></div>';
      document.body.appendChild(ov);
      const c = ov.querySelector('canvas'), ctx = c.getContext('2d');
      ctx.lineWidth = 3; ctx.lineCap = 'round'; ctx.strokeStyle = '#111';
      let drawing = false, drawn = false;
      const pos = (ev)=>{ const r = c.getBoundingClientRect(); const t = ev.touches ? ev.touches[0] : ev; return { x:(t.clientX - r.left) * c.width / r.width, y:(t.clientY - r.top) * c.height / r.height }; };
      const down = (ev)=>{ ev.preventDefault(); drawing = true; const p = pos(ev); ctx.beginPath(); ctx.moveTo(p.x, p.y); };
      const move = (ev)=>{ if(!drawing) return; ev.preventDefault(); const p = pos(ev); ctx.lineTo(p.x, p.y); ctx.stroke(); drawn = true; };
      const up = ()=>{ drawing = false; };
      c.addEventListener('pointerdown', down); c.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
      c.addEventListener('touchstart', down, { passive:false }); c.addEventListener('touchmove', move, { passive:false }); c.addEventListener('touchend', up);
      ov.addEventListener('click', (ev)=>{
        const b = ev.target.closest('[data-sig]');
        if(!b) return;
        if(b.dataset.sig === 'clear'){ ctx.clearRect(0, 0, c.width, c.height); drawn = false; return; }
        if(b.dataset.sig === 'ok' && !drawn){ toast('Sign in the box first'); return; }
        const done = (v)=>{ window.removeEventListener('pointerup', up); ov.remove(); resolve(v); };
        if(b.dataset.sig === 'cancel') return done(null);
        c.toBlob((blob)=> done(blob), 'image/png');
      });
    });
  }

  // =====================================================================
  // Administration › Errands
  // =====================================================================
  async function erOnShow(key){
    $('purchasingView').classList.add('po-wide');
    er.mode = key === 'myErrands' ? 'messenger' : key === 'errandRequests' ? 'requests' : 'manager';
    if(!(await ensureCloud())){ ['erManagerBody', 'erMyBody', 'erReqBody'].forEach(id=>{ if($(id)) $(id).innerHTML = '<div class="empty-state">Not connected.</div>'; }); return; }
    if(er.mode === 'manager'){
      try{ await db.rpc('errand_recur_run_now'); }catch(e){}
      erShowManager();
    }else if(er.mode === 'messenger') erShowMine();
    else erShowRequests();
  }
  async function erLoadMessengers(){
    const { data } = await db.rpc('errand_messengers');
    er.messengers = data || [];
  }
  async function erShowManager(){
    const box = $('erManagerBody');
    box.innerHTML = '<div class="empty-state">Loading\u2026</div>';
    try{
      const [l] = await Promise.all([
        db.from('errands').select('*').order('due_at', { ascending:true, nullsFirst:false }).limit(400),
        erLoadMessengers()
      ]);
      if(l.error) throw l.error;
      er.list = l.data || [];
      if(er.tab === 'recurring'){
        const r = await db.from('errand_recurrences').select('*').order('title');
        er.recs = r.error ? [] : (r.data || []);
      }
      erRenderManager();
    }catch(e){ box.innerHTML = '<div class="empty-state">' + erErr('Couldn\u2019t load errands: ', e) + '</div>'; }
  }
  function erRow(e, opts){
    const due = e.due_at ? erWhen(e.due_at) : 'No due date';
    const late = erOverdue(e);
    return '<div class="sp-row' + (late ? ' er-late' : '') + '" data-er="' + erEsc(e.id) + '"><div class="sp-row-top"><div style="min-width:0;">' +
      '<div class="sp-row-title"><span class="mt-code">' + erEsc(e.errand_no) + '</span> ' + erEsc(e.title) + ' <span class="sp-tag ' + (late ? 'danger' : (ER_STATUS_CLS[e.status] || '')) + '">' +
        erEsc(late ? 'Overdue' : ER_STATUS[e.status] || e.status) + '</span>' + (e.priority === 'urgent' ? ' <span class="sp-tag danger">Urgent</span>' : '') + '</div>' +
      '<div class="sp-row-sub">' + erEsc(e.destination || ER_TYPES[e.type] || '') + ' \u00B7 due ' + erEsc(due) +
        (opts && opts.mine ? '' : ' \u00B7 ' + erEsc(e.assigned_name || 'no messenger')) +
        (e.requested_by_name ? ' \u00B7 requested by ' + erEsc(e.requested_by_name) : '') + '</div></div></div>' +
      '<div class="user-card-actions"><button type="button" class="primary" data-er-open="1">Open</button></div></div>';
  }
  function erRenderManager(){
    const box = $('erManagerBody');
    const groups = {
      requests: er.list.filter(e=> e.status === 'requested'),
      active: er.list.filter(e=> ['open', 'assigned', 'in_progress'].includes(e.status)),
      review: er.list.filter(e=> ['done', 'failed'].includes(e.status)),
      history: er.list.filter(e=> ['closed', 'cancelled'].includes(e.status)).reverse()
    };
    const late = groups.active.filter(erOverdue).length;
    const tabs = [['requests', 'Requests'], ['active', 'Active'], ['review', 'To Review'], ['recurring', 'Recurring'], ['history', 'History']];
    let html = '<div class="seg-tabs pay-tabs">' + tabs.map(([k, l])=> '<button type="button" class="seg-tab' + (er.tab === k ? ' active' : '') + '" data-er-tab="' + k + '">' + l +
        (groups[k] && groups[k].length && k !== 'history' ? ' <span class="po-tab-count">' + groups[k].length + '</span>' : '') + '</button>').join('') + '</div>';
    if(erCanEdit() && er.tab !== 'recurring') html += '<div class="pay-actions"><button type="button" class="btn btn-primary" data-er-new="1">+ New Errand</button></div>';
    if(er.tab === 'active' && late) html += '<div class="pay-banner warn"><b>' + late + ' overdue.</b> The Administration Head and the Super Admin have been alerted.</div>';
    if(!er.messengers.length && erCanEdit()) html += '<div class="pay-banner warn">No messengers yet. In <b>Department Staff</b>, give the messenger account <b>Administration \u203A My Errands (Messenger)</b>.</div>';
    if(er.tab === 'recurring'){ box.innerHTML = html + erRecurringHtml(); return; }
    const rows = groups[er.tab] || [];
    html += rows.length ? rows.map(e=> erRow(e)).join('') : '<div class="empty-state">' + ({ requests:'No requests waiting.', active:'No active errands.', review:'Nothing to review.', history:'Nothing yet.' }[er.tab]) + '</div>';
    box.innerHTML = html;
  }
  $('erManagerBody').addEventListener('click', async (e)=>{
    if(e.target.closest('[data-purch-reauth]')){ purchReauth().then(ok=>{ if(ok) erShowManager(); }); return; }
    const t = e.target.closest('[data-er-tab]');
    if(t){ er.tab = t.dataset.erTab; if(er.tab === 'recurring') erShowManager(); else erRenderManager(); return; }
    if(e.target.closest('[data-er-new]')){ erOpenEditor(null); return; }
    const row = e.target.closest('.sp-row[data-er]');
    if(row && e.target.closest('[data-er-open]')){ erOpenDetail(row.dataset.er); return; }
    const rr = e.target.closest('[data-rec-open]');
    if(rr){ erOpenRecEditor(rr.dataset.recOpen === 'new' ? null : er.recs.find(x=> x.id === rr.dataset.recOpen)); return; }
  });

  // ---------- editor (new / edit / request) ----------
  function erLinesHtml(kind, rows, ro){
    const dis = ro ? ' disabled' : '';
    if(kind === 'checklist'){
      return '<div class="pay-table-wrap"><table class="pay-table pay-edit" id="erCk"><thead><tr><th>Step</th><th>Photo</th><th>Signature</th>' + (ro ? '' : '<th></th>') + '</tr></thead><tbody>' +
        rows.map(s=> '<tr data-id="' + erEsc(s.id || '') + '"' + (s.done ? ' class="er-done-row"' : '') + '><td><input type="text" data-k="text" value="' + erEsc(s.text || '') + '"' + (s.done ? ' disabled' : dis) + ' placeholder="e.g. Get stamped receiving copy"></td>' +
          '<td class="er-c"><input type="checkbox" data-k="needs_photo"' + (s.needs_photo ? ' checked' : '') + (s.done ? ' disabled' : dis) + '></td>' +
          '<td class="er-c"><input type="checkbox" data-k="needs_signature"' + (s.needs_signature ? ' checked' : '') + (s.done ? ' disabled' : dis) + '></td>' +
          (ro ? '' : '<td class="pay-rm-cell">' + (s.done ? '\u2713' : '<button type="button" class="pay-rm" data-row-rm="1">\u00D7</button>') + '</td>') + '</tr>').join('') +
        '</tbody></table></div>' + (ro ? '' : '<button type="button" class="pay-link" data-er-add="checklist">+ Add step</button>');
    }
    return '<div class="pay-table-wrap"><table class="pay-table pay-edit" id="erIt"><thead><tr><th>Qty</th><th>Description</th><th>Remarks</th>' + (ro ? '' : '<th></th>') + '</tr></thead><tbody>' +
      rows.map(i=> '<tr><td style="width:70px;"><input type="text" data-k="qty" value="' + erEsc(i.qty || '1') + '"' + dis + '></td><td><input type="text" data-k="description" value="' + erEsc(i.description || '') + '"' + dis + ' placeholder="e.g. BIR Form 1601-C (2 copies)"></td>' +
        '<td><input type="text" data-k="remarks" value="' + erEsc(i.remarks || '') + '"' + dis + '></td>' + (ro ? '' : '<td class="pay-rm-cell"><button type="button" class="pay-rm" data-row-rm="1">\u00D7</button></td>') + '</tr>').join('') +
      '</tbody></table></div>' + (ro ? '' : '<button type="button" class="pay-link" data-er-add="items">+ Add item</button>');
  }
  function erFormHtml(e, forRequest, forRec){
    e = e || {};
    const opt = (map, v)=> Object.keys(map).map(k=> '<option value="' + k + '"' + (k === v ? ' selected' : '') + '>' + erEsc(map[k]) + '</option>').join('');
    const msg = '<option value="">\u2014 not yet \u2014</option>' + er.messengers.map(m=> '<option value="' + erEsc(m.id) + '"' + ((e.assigned_to || e.assign_to) === m.id ? ' selected' : '') + '>' + erEsc(m.name) + '</option>').join('');
    return '<div class="po-sec"><div class="po-sec-title">Errand</div><div class="po-grid">' +
        payField('po-c6', 'What needs doing <span class="req">*</span>', '<input type="text" id="erF_title" value="' + erEsc(e.title || '') + '" placeholder="e.g. File BIR 1601-C for September">') +
        payField('po-c3', 'Type', '<select id="erF_type">' + opt(ER_TYPES, e.type || 'other') + '</select>') +
        payField('po-c3', 'Priority', '<select id="erF_priority">' + opt({ normal:'Normal', urgent:'Urgent' }, e.priority || 'normal') + '</select>') +
        (forRec ? '' : payField('po-c6', 'Due', '<input type="datetime-local" id="erF_due" value="' + erEsc(erToLocalInput(e.due_at)) + '">')) +
        (forRequest ? '' : payField('po-c6', 'Messenger', '<select id="erF_to">' + msg + '</select>')) +
        payField('po-c12', 'Instructions', '<textarea id="erF_instr" rows="3" placeholder="What to do, what to bring, who to ask for\u2026">' + erEsc(e.instructions || '') + '</textarea>') +
      '</div></div>' +
      '<div class="po-sec"><div class="po-sec-title">Where</div><div class="po-grid">' +
        payField('po-c6', 'Office / place', '<input type="text" id="erF_dest" value="' + erEsc(e.destination || '') + '" placeholder="e.g. BIR RDO 047 East Makati">') +
        payField('po-c6', 'Address', '<input type="text" id="erF_addr" value="' + erEsc(e.address || '') + '">') +
        payField('po-c6', 'Contact person', '<input type="text" id="erF_cname" value="' + erEsc(e.contact_name || '') + '">') +
        payField('po-c6', 'Contact number', '<input type="tel" id="erF_cphone" value="' + erEsc(e.contact_phone || '') + '">') +
      '</div></div>' +
      '<div class="po-sec"><div class="po-sec-title">Checklist</div>' + erLinesHtml('checklist', e.checklist || []) +
        '<div class="pay-hint">Tick Photo / Signature for steps that need proof. The messenger can\u2019t mark the step done without it.</div></div>' +
      '<div class="po-sec"><div class="po-sec-title">Items to deliver / pick up (transmittal slip)</div>' + erLinesHtml('items', e.items || []) +
        '<div class="pay-checks"><label class="pay-chk"><input type="checkbox" id="erF_tx"' + (e.transmittal_required ? ' checked' : '') + '> Transmittal slip required</label>' +
        '<label class="pay-chk"><input type="checkbox" id="erF_copy"' + (e.copy_expected ? ' checked' : '') + '> A stamped / received copy comes back to the office</label></div></div>' +
      '<div class="po-sec"><div class="po-sec-title">Cash (optional)</div><div class="po-grid">' +
        payField('po-c3', 'Amount needed (\u20B1)', '<input type="text" inputmode="decimal" id="erF_cash" value="' + erEsc(e.cash_amount == null ? '' : e.cash_amount) + '">') +
        payField('po-c6', 'For', '<input type="text" id="erF_cashnote" value="' + erEsc(e.cash_note || '') + '" placeholder="e.g. filing fee, courier, fare">',
          'The messenger requests it as a cash advance and liquidates it with the receipts.') +
      '</div></div>';
  }
  function erReadForm(forRec){
    const rows = (id, keys)=> [...(document.querySelectorAll('#' + id + ' tbody tr'))].map(tr=>{
      const o = {}; if(tr.dataset.id) o.id = tr.dataset.id;
      keys.forEach(k=>{ const el = tr.querySelector('[data-k="' + k + '"]'); if(el) o[k] = el.type === 'checkbox' ? el.checked : el.value.trim(); });
      return o;
    });
    const p = {
      title: $('erF_title').value.trim(), type: $('erF_type').value, priority: $('erF_priority').value,
      instructions: $('erF_instr').value.trim(), destination: $('erF_dest').value.trim(), address: $('erF_addr').value.trim(),
      contact_name: $('erF_cname').value.trim(), contact_phone: $('erF_cphone').value.trim(),
      checklist: rows('erCk', ['text', 'needs_photo', 'needs_signature']).filter(s=> s.text),
      items: rows('erIt', ['qty', 'description', 'remarks']).filter(i=> i.description),
      transmittal_required: $('erF_tx').checked, copy_expected: $('erF_copy').checked,
      cash_amount: $('erF_cash').value.trim(), cash_note: $('erF_cashnote').value.trim()
    };
    if(!forRec) p.due_at = erFromLocalInput($('erF_due').value);
    if($('erF_to')) p.assigned_to = $('erF_to').value || null;
    return p;
  }
  function erFormEvents(root){
    root.addEventListener('click', (e)=>{
      const add = e.target.closest('[data-er-add]');
      if(add){
        const tb = root.querySelector(add.dataset.erAdd === 'checklist' ? '#erCk tbody' : '#erIt tbody');
        const tmp = document.createElement('tbody');
        tmp.innerHTML = erLinesHtml(add.dataset.erAdd, [add.dataset.erAdd === 'checklist' ? { text:'' } : { qty:'1', description:'' }]).match(/<tbody>([\s\S]*)<\/tbody>/)[1];
        tb.appendChild(tmp.firstElementChild);
        const f = tb.lastElementChild.querySelector('input[type=text]'); if(f) f.focus();
        return;
      }
      const rm = e.target.closest('[data-row-rm]');
      if(rm) rm.closest('tr').remove();
    });
  }
  function erOpenEditor(e){
    const box = $('erManagerBody');
    box.innerHTML = '<div class="po-ed-top"><button type="button" class="po-back" data-er-back="1">\u2039 Errands</button><div class="po-ed-title">' + (e ? erEsc(e.errand_no) + ' \u00B7 Edit' : 'New errand') + '</div></div>' +
      (e && e.status === 'failed' ? '<div class="pay-banner warn">Couldn\u2019t complete: ' + erEsc(e.failed_reason) + '. Set a new due date (and messenger) to send it out again.</div>' : '') +
      erFormHtml(e) + '<div class="pay-actions"><button type="button" class="btn btn-primary" data-er-save="1">' + (e ? 'Save Changes' : 'Create Errand') + '</button>' +
      '<button type="button" class="btn btn-secondary" data-er-back="1">Cancel</button></div>';
    window.scrollTo({ top:0 });
    const saveBtn = box.querySelector('[data-er-save]');
    box.querySelectorAll('[data-er-back]').forEach(b=> b.addEventListener('click', ()=> e ? erOpenDetail(e.id) : erShowManager()));
    erFormEvents(box);
    saveBtn.addEventListener('click', async ()=>{
      const p = erReadForm();
      if(!p.title){ toast('Say what the errand is'); return; }
      if(!p.due_at){ toast('Set when it\u2019s due'); return; }
      if(p.cash_amount && !(Number(p.cash_amount) >= 0)){ toast('Cash amount must be a number'); return; }
      saveBtn.disabled = true;
      const { data, error } = await db.rpc('errand_save', { p_id: e ? e.id : null, p });
      saveBtn.disabled = false;
      if(error){ toast('Couldn\u2019t save: ' + (error.message || describeCloudError(error))); return; }
      const m = er.messengers.find(x=> x.id === p.assigned_to);
      if(m && (!e || e.assigned_to !== m.id || e.status === 'failed')) erNotifyMessenger(m.id, p.title, p.due_at);
      toast(e ? 'Saved' : 'Errand created' + (m ? ' and sent to ' + m.name : ''));
      erOpenDetail(data || (e && e.id));
    });
  }
  function erNotifyMessenger(uid, title, due){
    try{ notifyUser(uid, 'Errand assigned to you', title + (due ? ' \u2014 due ' + erWhen(due) : ''), 'errand-' + uid + '-' + Date.now()); }catch(e){}
  }

  // ---------- detail ----------
  async function erOpenDetail(id){
    const box = er.mode === 'messenger' ? $('erMyBody') : er.mode === 'requests' ? $('erReqBody') : $('erManagerBody');
    box.innerHTML = '<div class="empty-state">Loading\u2026</div>';
    try{
      const [e, f, t] = await Promise.all([
        db.from('errands').select('*').eq('id', id).maybeSingle(),
        db.from('errand_files').select('*').eq('errand_id', id).order('taken_at'),
        db.from('errand_transmittals').select('*').eq('errand_id', id).maybeSingle()
      ]);
      if(e.error) throw e.error;
      if(!e.data){ box.innerHTML = '<div class="empty-state">That errand no longer exists.</div>'; return; }
      er.cur = e.data; er.files = f.data || []; er.tx = t.data || null;
      if(!er.messengers.length && er.mode === 'manager') await erLoadMessengers();
      erRenderDetail(box);
    }catch(err){ box.innerHTML = '<div class="empty-state">' + erErr('Couldn\u2019t load the errand: ', err) + '</div>'; }
  }
  function erThumbs(files){
    if(!files.length) return '';
    return '<div class="er-thumbs">' + files.map(f=> '<button type="button" class="er-thumb" data-er-img="' + erEsc(f.path) + '" title="' + erEsc(f.kind + ' \u00B7 ' + erWhen(f.taken_at)) + '">' +
      '<img alt="" data-er-src="' + erEsc(f.path) + '"><span>' + erEsc({ proof:'Proof', attachment:'Photo', stamped_copy:'Stamped copy', signature:'Signature', receipt:'Receipt' }[f.kind] || f.kind) + '</span></button>').join('') + '</div>';
  }
  async function erFillThumbs(root){
    for(const img of root.querySelectorAll('img[data-er-src]')){
      img.src = await erUrl(img.dataset.erSrc);
    }
  }
  function erRenderDetail(box){
    const e = er.cur, mine = e.assigned_to === currentUser.id, mgr = er.mode === 'manager';
    const late = erOverdue(e);
    const ck = e.checklist || [];
    const stepFiles = (sid)=> er.files.filter(f=> f.step_id === sid);
    const act = [];
    if(mgr){
      if(e.status === 'requested' && erCanApprove()) act.push('<button type="button" class="btn btn-primary" data-er-act="approve">\u2713 Approve\u2026</button><button type="button" class="btn btn-secondary" data-er-act="decline">Decline\u2026</button>');
      if(['requested', 'open', 'assigned', 'in_progress', 'failed'].includes(e.status) && erCanEdit()) act.push('<button type="button" class="btn btn-secondary" data-er-act="edit">' + (e.status === 'failed' ? 'Reschedule / Edit' : 'Edit') + '</button>');
      if(['open', 'assigned', 'in_progress', 'failed'].includes(e.status) && erCanEdit()) act.push('<button type="button" class="btn btn-secondary" data-er-act="assign">' + (e.assigned_to ? 'Replace messenger\u2026' : 'Assign\u2026') + '</button>');
      if(e.status === 'done' && erCanApprove()) act.push('<button type="button" class="btn btn-primary" data-er-act="close">\u2713 Close</button>');
      if(er.tx && e.copy_expected && !er.tx.office_received_at && erCanEdit()) act.push('<button type="button" class="btn btn-secondary" data-er-act="copy">Stamped copy received</button>');
      if(!['done', 'closed', 'cancelled'].includes(e.status) && erCanEdit()) act.push('<button type="button" class="btn btn-secondary pay-danger" data-er-act="cancel">Cancel errand\u2026</button>');
    }
    if(er.mode === 'requests' && e.status === 'requested') act.push('<button type="button" class="btn btn-secondary pay-danger" data-er-act="cancel">Cancel request\u2026</button>');
    if(er.tx) act.push('<button type="button" class="btn btn-secondary" data-er-act="pdf">Transmittal PDF</button>');

    // messenger working view
    let work = '';
    if(er.mode === 'messenger' && mine){
      if(e.status === 'assigned') work = '<div class="pay-actions"><button type="button" class="btn btn-primary er-big" data-er-act="start">\u25B6 Start errand</button><button type="button" class="btn btn-secondary" data-er-act="fail">Couldn\u2019t do it\u2026</button></div>';
      if(e.status === 'in_progress'){
        const needTx = e.transmittal_required || (e.items || []).length;
        work = '<div class="pay-actions">' + (needTx && !er.tx ? '<button type="button" class="btn btn-primary" data-er-act="deliver">\u270D Hand over & sign transmittal</button>' : '') +
          '<button type="button" class="btn btn-secondary" data-er-act="photo">\uD83D\uDCF7 Add photo / receipt</button>' +
          '<button type="button" class="btn btn-primary er-big" data-er-act="done">\u2713 Errand done</button>' +
          '<button type="button" class="btn btn-secondary pay-danger" data-er-act="fail">Couldn\u2019t complete\u2026</button></div>';
      }
    }
    const steps = ck.length ? '<div class="po-sec"><div class="po-sec-title">Checklist (' + ck.filter(s=> s.done).length + ' of ' + ck.length + ' done)</div>' +
      ck.map(s=>{
        const fs = stepFiles(s.id);
        const canWork = er.mode === 'messenger' && mine && e.status === 'in_progress';
        return '<div class="er-step' + (s.done ? ' done' : '') + '" data-step="' + erEsc(s.id) + '"><div class="er-step-main"><span class="er-step-box">' + (s.done ? '\u2713' : '') + '</span><div style="min-width:0;"><b>' + erEsc(s.text) + '</b>' +
            (s.needs_photo ? ' <span class="sp-tag muted">\uD83D\uDCF7 photo</span>' : '') + (s.needs_signature ? ' <span class="sp-tag muted">\u270D signature</span>' : '') +
            (s.done ? '<div class="pay-hint">Done ' + erEsc(erWhen(s.done_at)) + ' ' + erLocBtn(s.done_loc, s.text) + '</div>' : '') + erThumbs(fs) + '</div></div>' +
          (canWork ? '<div class="er-step-act">' + (s.done ? '<button type="button" class="pay-link" data-step-act="undo">Undo</button>'
              : ((s.needs_photo ? '<button type="button" class="btn btn-secondary pay-sm" data-step-act="photo">\uD83D\uDCF7 Photo</button>' : '') +
                 (s.needs_signature ? '<button type="button" class="btn btn-secondary pay-sm" data-step-act="sign">\u270D Sign</button>' : '') +
                 '<button type="button" class="btn btn-primary pay-sm" data-step-act="done">Done</button>')) + '</div>' : '') + '</div>';
      }).join('') + '</div>' : '';
    const other = er.files.filter(f=> !f.step_id && f.kind !== 'signature');
    const tx = er.tx ? '<div class="po-sec"><div class="po-sec-title">Transmittal ' + erEsc(er.tx.transmittal_no) + '</div>' +
        '<div class="pay-hint">Handed over ' + erEsc(erWhen(er.tx.delivered_at)) + ' by ' + erEsc(er.tx.delivered_by_name || '') + ' ' + erLocBtn(er.tx.delivered_loc, er.tx.transmittal_no) + '</div>' +
        (er.tx.receiver_name ? '<div>Received by <b>' + erEsc(er.tx.receiver_name) + '</b>' + (er.tx.receiver_position ? ', ' + erEsc(er.tx.receiver_position) : '') + '</div>' : '') +
        erThumbs(er.files.filter(f=> [er.tx.receiver_signature_path, er.tx.stamped_copy_path, er.tx.messenger_signature_path].includes(f.path))) +
        (e.copy_expected ? '<div class="pay-hint">' + (er.tx.office_received_at ? '\u2713 Stamped copy back in the office ' + erEsc(erWhen(er.tx.office_received_at)) + ' (' + erEsc(er.tx.office_received_by_name || '') + ')' : 'Stamped copy not yet back in the office') + '</div>' : '') + '</div>'
      : ((e.transmittal_required || (e.items || []).length) ? '<div class="po-sec"><div class="po-sec-title">Items to hand over</div>' +
          (e.items || []).map(i=> '<div>' + erEsc(i.qty) + ' \u00D7 ' + erEsc(i.description) + (i.remarks ? ' <span class="pay-muted">(' + erEsc(i.remarks) + ')</span>' : '') + '</div>').join('') +
          '<div class="pay-hint">Needs the receiver\u2019s signature, or a photo of the stamped receiving copy.</div></div>' : '');
    const back = er.mode === 'messenger' ? 'My errands' : er.mode === 'requests' ? 'My requests' : 'Errands';
    box.innerHTML =
      '<div class="po-ed-top"><button type="button" class="po-back" data-er-back="1">\u2039 ' + back + '</button><div class="po-ed-title">' + erEsc(e.errand_no) + '</div>' +
        '<span class="sp-tag ' + (late ? 'danger' : (ER_STATUS_CLS[e.status] || '')) + '">' + erEsc(late ? 'Overdue' : ER_STATUS[e.status] || e.status) + '</span></div>' +
      '<div class="er-head"><div class="er-title">' + erEsc(e.title) + (e.priority === 'urgent' ? ' <span class="sp-tag danger">Urgent</span>' : '') + '</div>' +
        '<div class="sp-row-sub">' + erEsc(ER_TYPES[e.type] || '') + ' \u00B7 due <b' + (late ? ' style="color:var(--danger);"' : '') + '>' + erEsc(e.due_at ? erWhen(e.due_at) : 'no due date') + '</b>' +
          ' \u00B7 ' + erEsc(e.assigned_name || 'no messenger yet') + '</div>' +
        (e.destination || e.address ? '<div class="er-where">\uD83D\uDCCD <b>' + erEsc(e.destination) + '</b> ' + erEsc(e.address) +
          (e.address || e.destination ? ' <a href="https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent((e.destination + ' ' + e.address).trim()) + '" target="_blank" rel="noopener" class="pay-link">Map</a>' : '') + '</div>' : '') +
        (e.contact_name || e.contact_phone ? '<div>\uD83D\uDC64 ' + erEsc(e.contact_name) + (e.contact_phone ? ' \u00B7 <a href="tel:' + erEsc(e.contact_phone) + '">' + erEsc(e.contact_phone) + '</a>' : '') + '</div>' : '') +
        (e.instructions ? '<div class="er-instr">' + erEsc(e.instructions).replace(/\n/g, '<br>') + '</div>' : '') +
        (e.cash_amount ? '<div class="pay-hint">Cash needed: \u20B1' + Number(e.cash_amount).toLocaleString('en-PH', { minimumFractionDigits:2 }) + (e.cash_note ? ' \u2014 ' + erEsc(e.cash_note) : '') +
          (er.mode === 'messenger' ? ' \u00B7 request it in Finance \u203A Cash Advance and liquidate with the receipts' : '') + '</div>' : '') +
        (e.status === 'failed' ? '<div class="pay-banner warn">Couldn\u2019t complete: ' + erEsc(e.failed_reason) + ' ' + erLocBtn(e.failed_loc, 'Couldn\u2019t complete') + '</div>' : '') +
        (e.status === 'cancelled' ? '<div class="pay-banner warn">' + (e.approved_at ? 'Cancelled' : 'Declined') + ' by ' + erEsc(e.cancelled_by_name || '') + ': ' + erEsc(e.cancel_reason) + '</div>' : '') +
      '</div>' + work +
      (act.length ? '<div class="pay-actions">' + act.join('') + '</div>' : '') +
      steps + tx +
      (other.length ? '<div class="po-sec"><div class="po-sec-title">Photos &amp; receipts</div>' + erThumbs(other) + '</div>' : '') +
      '<div class="po-sec"><div class="po-sec-title">Timeline</div>' + erTimeline(e) + '</div>';
    erFillThumbs(box);
    window.scrollTo({ top:0 });
  }
  function erTimeline(e){
    const ev = [];
    const p = (at, text, loc)=>{ if(at) ev.push({ at, text, loc }); };
    p(e.requested_at, 'Requested by ' + (e.requested_by_name || ''));
    p(e.created_at && !e.requested_at ? e.created_at : null, 'Created by ' + (e.created_by_name || ''));
    p(e.approved_at && e.requested_at ? e.approved_at : null, 'Approved by ' + (e.approved_by_name || ''));
    p(e.assigned_at, 'Assigned to ' + (e.assigned_name || ''));
    p(e.started_at, 'Started', e.start_loc);
    (e.checklist || []).forEach(s=> p(s.done_at, '\u2713 ' + s.text, s.done_loc));
    er.files.forEach(f=> p(f.taken_at, ({ proof:'Photo', attachment:'Photo', stamped_copy:'Stamped copy photo', signature:'Signature', receipt:'Receipt' }[f.kind] || 'File') + ' by ' + (f.uploaded_by_name || ''), f.loc));
    if(er.tx) p(er.tx.delivered_at, 'Transmittal ' + er.tx.transmittal_no + ' \u2014 received by ' + (er.tx.receiver_name || 'stamped copy'), er.tx.delivered_loc);
    p(e.completed_at, 'Done' + (e.result_note ? ': ' + e.result_note : ''), e.completed_loc);
    p(e.failed_at, 'Couldn\u2019t complete: ' + e.failed_reason, e.failed_loc);
    p(e.closed_at, 'Closed by ' + (e.closed_by_name || ''));
    if(er.tx) p(er.tx.office_received_at, 'Stamped copy back in the office (' + (er.tx.office_received_by_name || '') + ')');
    p(e.cancelled_at, 'Cancelled by ' + (e.cancelled_by_name || '') + ': ' + e.cancel_reason);
    ev.sort((a, b)=> String(a.at).localeCompare(String(b.at)));
    return ev.map(x=> '<div class="pay-audit"><span class="pay-audit-when">' + erEsc(erWhen(x.at)) + '</span> ' + erEsc(x.text) + ' ' + erLocBtn(x.loc, x.text) + '</div>').join('') || '<div class="pay-hint">\u2014</div>';
  }
  async function erBodyClick(e){
    const box = e.currentTarget;
    if(e.target.closest('[data-er-back]')){ er.mode === 'messenger' ? erShowMine() : er.mode === 'requests' ? erShowRequests() : erShowManager(); return; }
    const img = e.target.closest('[data-er-img]');
    if(img){ const u = await erUrl(img.dataset.erImg); if(u) window.open(u, '_blank', 'noopener'); return; }
    const sa = e.target.closest('[data-step-act]');
    if(sa){ await erStepAction(sa.dataset.stepAct, sa.closest('[data-step]').dataset.step, sa); return; }
    const b = e.target.closest('[data-er-act]');
    if(!b || !er.cur) return;
    const x = er.cur, act = b.dataset.erAct;
    b.disabled = true;
    try{
      if(act === 'edit'){ erOpenEditor(x); return; }
      if(act === 'pdf'){ await erTransmittalPdf(); return; }
      if(act === 'approve'){
        const to = await erPickMessenger('Approve ' + x.errand_no + ' and assign it to\u2026', x.assigned_to, true);
        if(to === undefined) return;
        const { error } = await db.rpc('errand_approve', { p_id:x.id, p_assign:to || null }); if(error) throw error;
        if(to) erNotifyMessenger(to, x.title, x.due_at);
        if(x.requested_by) notifyUser(x.requested_by, 'Errand request approved', x.errand_no + ' \u00B7 ' + x.title, 'errand-req-' + x.id);
        toast('Approved');
      }
      if(act === 'decline'){
        const why = await uiPrompt('Decline ' + x.errand_no + '?\n\nWhy? The requester sees this.', '', { ok:'Decline', multiline:false });
        if(why == null) return; if(!why.trim()){ toast('Say why it\u2019s declined'); return; }
        const { error } = await db.rpc('errand_decline', { p_id:x.id, p_reason:why.trim() }); if(error) throw error;
        if(x.requested_by) notifyUser(x.requested_by, 'Errand request declined', x.errand_no + ': ' + why.trim(), 'errand-req-' + x.id);
        toast('Declined');
      }
      if(act === 'assign'){
        const to = await erPickMessenger((x.assigned_to ? 'Replace ' + (x.assigned_name || 'the messenger') + ' on ' : 'Assign ') + x.errand_no + ' \u2014 choose the messenger', x.assigned_to, false);
        if(!to) return;
        const { error } = await db.rpc('errand_assign', { p_id:x.id, p_to:to }); if(error) throw error;
        erNotifyMessenger(to, x.title, x.due_at);
        if(x.assigned_to && x.assigned_to !== to) notifyUser(x.assigned_to, 'Errand reassigned', x.errand_no + ' was given to someone else', 'errand-' + x.id);
        toast('Assigned');
      }
      if(act === 'cancel'){
        const why = await uiPrompt('Cancel ' + x.errand_no + '?\n\nWhy?', '', { ok:'Cancel errand', danger:true, multiline:false });
        if(why == null) return; if(!why.trim()){ toast('Say why it\u2019s cancelled'); return; }
        const { error } = await db.rpc('errand_cancel', { p_id:x.id, p_reason:why.trim() }); if(error) throw error;
        if(x.assigned_to && x.assigned_to !== currentUser.id) notifyUser(x.assigned_to, 'Errand cancelled', x.errand_no + ': ' + why.trim(), 'errand-' + x.id);
        toast('Cancelled');
      }
      if(act === 'close'){
        if(!await uiConfirm('Close ' + x.errand_no + '?\n\nIt moves to History.', { ok:'Close' })) return;
        const { error } = await db.rpc('errand_close', { p_id:x.id }); if(error) throw error;
        toast('Closed');
      }
      if(act === 'copy'){
        const { error } = await db.rpc('errand_confirm_copy', { p_id:x.id }); if(error) throw error;
        toast('Stamped copy recorded as received');
      }
      // ---- messenger ----
      if(act === 'start'){
        const loc = await erLoc(); if(!loc) return;
        const { error } = await db.rpc('errand_start', { p_id:x.id, p_loc:loc }); if(error) throw error;
        toast('Started \u2014 ' + dtrLocLabel(loc));
      }
      if(act === 'photo'){
        const f = await erPickPhoto(); if(!f) return;
        const kind = await uiConfirm('Is this a receipt?\n\nReceipts can be used in your liquidation.', { ok:'Receipt', cancel:'Other photo' }) ? 'receipt' : 'attachment';
        const loc = await erLoc(); if(!loc) return;
        toast('Uploading\u2026');
        await erUpload(x.id, f, kind, null, loc);
        toast('Photo added');
      }
      if(act === 'deliver'){ await erDeliver(); return; }
      if(act === 'done'){
        const note = await uiPrompt('Errand done?\n\nAnything the office should know? (optional)', '', { ok:'Done', multiline:true });
        if(note == null) return;
        const loc = await erLoc(); if(!loc) return;
        const { error } = await db.rpc('errand_complete', { p_id:x.id, p_note:note.trim(), p_loc:loc }); if(error) throw error;
        toast('Done \u2014 sent to Administration');
      }
      if(act === 'fail'){
        const why = await uiPrompt('Couldn\u2019t complete ' + x.errand_no + '?\n\nWhat happened? (e.g. office closed, lacking document)', '', { ok:'Send', multiline:true });
        if(why == null) return; if(!why.trim()){ toast('Say what happened'); return; }
        const loc = await erLoc(); if(!loc) return;
        const { error } = await db.rpc('errand_fail', { p_id:x.id, p_reason:why.trim(), p_loc:loc }); if(error) throw error;
        toast('Sent to Administration');
      }
      erOpenDetail(x.id);
    }catch(err){ toast('Couldn\u2019t do that: ' + (err.message || describeCloudError(err))); }
    finally{ b.disabled = false; }
  }
  ['erManagerBody', 'erMyBody', 'erReqBody'].forEach(id=> $(id).addEventListener('click', erBodyClick));

  function erPickMessenger(title, current, allowNone){
    return new Promise((resolve)=>{
      const ov = document.createElement('div');
      ov.className = 'overlay open er-sig-ov';
      ov.innerHTML = '<div class="modal"><h3>' + erEsc(title) + '</h3>' +
        (er.messengers.length ? er.messengers.map(m=> '<label class="er-pick"><input type="radio" name="erPick" value="' + erEsc(m.id) + '"' + (m.id === current ? ' checked' : '') + '> ' + erEsc(m.name) + '</label>').join('')
          : '<p class="pay-hint">No messengers set up yet (Department Staff \u203A Administration \u203A My Errands).</p>') +
        (allowNone ? '<label class="er-pick"><input type="radio" name="erPick" value=""' + (!current ? ' checked' : '') + '> Assign later</label>' : '') +
        '<div class="pay-actions"><button type="button" class="btn btn-secondary" data-p="cancel">Cancel</button><button type="button" class="btn btn-primary" data-p="ok">OK</button></div></div>';
      document.body.appendChild(ov);
      ov.addEventListener('click', (ev)=>{
        const b = ev.target.closest('[data-p]'); if(!b) return;
        const sel = ov.querySelector('input[name=erPick]:checked');
        ov.remove();
        if(b.dataset.p === 'cancel') return resolve(undefined);
        resolve(sel ? sel.value : (allowNone ? '' : undefined));
      });
    });
  }

  async function erStepAction(act, sid, btn){
    const x = er.cur;
    btn.disabled = true;
    try{
      if(act === 'photo' || act === 'sign'){
        let blob;
        if(act === 'photo'){ blob = await erPickPhoto(); }
        else blob = await erSignature('Signature', (x.checklist || []).find(s=> s.id === sid).text);
        if(!blob) return;
        const loc = await erLoc(); if(!loc) return;
        toast('Uploading\u2026');
        await erUpload(x.id, blob, act === 'photo' ? 'proof' : 'signature', sid, loc);
        toast(act === 'photo' ? 'Photo added \u2014 now tap Done' : 'Signature added \u2014 now tap Done');
      }else{
        const loc = await erLoc(); if(!loc) return;
        const { error } = await db.rpc('errand_step', { p_id:x.id, p_step:sid, p_done: act === 'done', p_loc:loc });
        if(error) throw error;
      }
      erOpenDetail(x.id);
    }catch(err){ toast('Couldn\u2019t do that: ' + (err.message || describeCloudError(err))); }
    finally{ btn.disabled = false; }
  }

  async function erDeliver(){
    const x = er.cur;
    const how = await uiConfirm('Hand over the items\n\nWill the receiver sign on your phone? Government offices and banks usually stamp a receiving copy instead \u2014 then take a photo of it.',
      { ok:'Receiver signs', cancel:'Photo of stamped copy' });
    const p = { items: x.items || [] };
    if(how){
      const name = await uiPrompt('Receiver\u2019s name', x.contact_name || '', { ok:'Next', multiline:false });
      if(name == null) return; if(!name.trim()){ toast('Enter the receiver\u2019s name'); return; }
      const pos = await uiPrompt('Receiver\u2019s position / office (optional)', '', { ok:'Next', multiline:false });
      if(pos == null) return;
      const rs = await erSignature('Receiver: ' + name.trim(), 'Received the items listed on ' + x.errand_no);
      if(!rs) return;
      const ms = await erSignature('Your signature', 'Delivered by ' + (currentUser.name || ''));
      if(!ms) return;
      const loc = await erLoc(); if(!loc) return;
      toast('Saving\u2026');
      p.receiver_name = name.trim(); p.receiver_position = (pos || '').trim();
      p.receiver_signature_path = await erUpload(x.id, rs, 'signature', null, loc);
      p.messenger_signature_path = await erUpload(x.id, ms, 'signature', null, loc);
      p.loc = loc;
    }else{
      const f = await erPickPhoto(); if(!f) return;
      const loc = await erLoc(); if(!loc) return;
      toast('Uploading\u2026');
      p.stamped_copy_path = await erUpload(x.id, f, 'stamped_copy', null, loc);
      const ms = await erSignature('Your signature', 'Delivered by ' + (currentUser.name || ''));
      if(ms) p.messenger_signature_path = await erUpload(x.id, ms, 'signature', null, loc);
      p.loc = loc;
    }
    const { data, error } = await db.rpc('errand_deliver', { p_id:x.id, p });
    if(error){ toast('Couldn\u2019t save: ' + (error.message || describeCloudError(error))); return; }
    toast('Transmittal ' + data + ' recorded');
    await erOpenDetail(x.id);
  }

  // ---------- transmittal PDF ----------
  async function erImgData(path){
    if(!path) return null;
    try{
      const u = await erUrl(path); if(!u) return null;
      const blob = await (await fetch(u)).blob();
      return await new Promise(res=>{ const r = new FileReader(); r.onload = ()=> res(r.result); r.readAsDataURL(blob); });
    }catch(e){ return null; }
  }
  async function erTransmittalPdf(){
    const e = er.cur, t = er.tx;
    if(!t) return;
    try{
      const base = await prPdfBase();
      const { jsPDF } = window.jspdf;
      const doc = new jsPDF({ unit:'pt', format:'a4', compress:true });
      const f = prDocSetup(doc, base);
      const W = doc.internal.pageSize.getWidth(), M = 34, INK = [28, 34, 30], SUB = [96, 108, 101], G = [21, 77, 52], LINE = [216, 223, 219];
      prHeader(doc, base, f, 'TRANSMITTAL SLIP', t.transmittal_no + '   \u2022   ' + (base.co.company_name || ''));
      let y = 88;
      const kv = (k, v, x, yy)=>{ doc.setFont(f.F, 'normal'); doc.setFontSize(7.5); doc.setTextColor(...SUB); doc.text(k.toUpperCase(), x, yy);
        doc.setFontSize(10); doc.setTextColor(...INK); doc.text(doc.splitTextToSize(String(v || '\u2014'), (W - M * 2) / 2 - 10), x, yy + 12); };
      kv('To', (t.to_name || '') + (t.to_org ? (t.to_name ? ' \u2014 ' : '') + t.to_org : ''), M, y);
      kv('Date / time delivered', erWhen(t.delivered_at), W / 2, y);
      y += 34;
      kv('From', base.co.company_name || 'AW Engineering Services', M, y);
      kv('Errand', e.errand_no + ' \u2014 ' + e.title, W / 2, y);
      y += 34;
      if(t.delivered_loc){ kv('Location', t.delivered_loc.address || (Number(t.delivered_loc.lat).toFixed(5) + ', ' + Number(t.delivered_loc.lng).toFixed(5)), M, y); y += 34; }
      doc.autoTable({ startY:y, margin:{ left:M, right:M }, head:[['QTY', 'DESCRIPTION', 'REMARKS']],
        body:(t.items || []).map(i=> [i.qty || '', i.description || '', i.remarks || '']),
        theme:'plain', styles:{ font:f.F, fontSize:9, cellPadding:5, textColor:INK, lineColor:LINE, lineWidth:{ bottom:0.4 } },
        headStyles:{ font:f.F, fillColor:G, textColor:255, fontSize:8 }, columnStyles:{ 0:{ cellWidth:50, halign:'center' }, 2:{ cellWidth:140 } } });
      y = doc.lastAutoTable.finalY + 24;
      const [rs, ms, st] = await Promise.all([erImgData(t.receiver_signature_path), erImgData(t.messenger_signature_path), erImgData(t.stamped_copy_path)]);
      const box = (label, name, sub, img, x)=>{
        const w = (W - M * 2 - 30) / 2;
        if(img){ try{ doc.addImage(img, img.indexOf('image/png') > 0 ? 'PNG' : 'JPEG', x + 10, y, w - 20, 60, undefined, 'FAST'); }catch(err){} }
        doc.setDrawColor(...LINE); doc.line(x, y + 66, x + w, y + 66);
        doc.setFont(f.FB[0], f.FB[1]); doc.setFontSize(9); doc.setTextColor(...INK); doc.text(String(name || ''), x + w / 2, y + 80, { align:'center' });
        doc.setFont(f.F, 'normal'); doc.setFontSize(7.5); doc.setTextColor(...SUB); doc.text(sub, x + w / 2, y + 92, { align:'center' });
        doc.text(label, x, y - 6);
      };
      box('DELIVERED BY', t.delivered_by_name, 'Messenger', ms, M);
      box('RECEIVED BY', t.receiver_name || (st ? 'See stamped receiving copy' : ''), t.receiver_position || (st ? '' : 'Name / position'), rs, W / 2 + 15);
      y += 116;
      if(st){
        doc.setFont(f.F, 'normal'); doc.setFontSize(8); doc.setTextColor(...SUB); doc.text('STAMPED RECEIVING COPY', M, y);
        try{ const pr = doc.getImageProperties(st); const w = Math.min(W - M * 2, 300), h = w * pr.height / pr.width;
          if(y + h + 20 > doc.internal.pageSize.getHeight()){ doc.addPage(); y = 40; }
          doc.addImage(st, 'JPEG', M, y + 8, w, h, undefined, 'FAST'); y += h + 20; }catch(err){}
      }
      doc.setFont(f.F, 'normal'); doc.setFontSize(7); doc.setTextColor(...SUB);
      doc.text('Times are recorded by the AWES server; locations by the messenger\u2019s phone GPS.', M, doc.internal.pageSize.getHeight() - 20);
      await openFileInPdfViewer(doc, t.transmittal_no + '.pdf', 'Transmittal ' + t.transmittal_no);
    }catch(err){ console.error('transmittal pdf', err); toast('Couldn\u2019t build the PDF: ' + (err.message || err)); }
  }

  // =====================================================================
  // My Errands (messenger)
  // =====================================================================
  async function erShowMine(){
    const box = $('erMyBody');
    box.innerHTML = '<div class="empty-state">Loading\u2026</div>';
    try{
      const { data, error } = await db.from('errands').select('*').eq('assigned_to', currentUser.id).order('due_at', { ascending:true, nullsFirst:false }).limit(200);
      if(error) throw error;
      const all = data || [];
      const open = all.filter(e=> ['assigned', 'in_progress'].includes(e.status));
      const recent = all.filter(e=> ['done', 'failed', 'closed'].includes(e.status)).reverse().slice(0, 15);
      const late = open.filter(erOverdue).length;
      const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
      const dueToday = open.filter(e=> e.due_at && new Date(new Date(e.due_at).getTime() + 8 * 3600e3).toISOString().slice(0, 10) <= today).length;
      box.innerHTML = (late ? '<div class="pay-banner warn"><b>' + late + ' overdue.</b> Finish them or tap Couldn\u2019t complete so the office can reschedule.</div>'
          : '<div class="pay-banner">' + (open.length ? open.length + ' open \u00B7 ' + dueToday + ' due today' : 'No errands right now.') + '</div>') +
        (open.length ? open.map(e=> erRow(e, { mine:true })).join('') : '') +
        (recent.length ? '<div class="po-sec-title" style="margin-top:14px;">Recent</div>' + recent.map(e=> erRow(e, { mine:true })).join('') : '');
    }catch(e){ box.innerHTML = '<div class="empty-state">' + erErr('Couldn\u2019t load your errands: ', e) + '</div>'; }
  }
  $('erMyBody').addEventListener('click', (e)=>{
    const row = e.target.closest('.sp-row[data-er]');
    if(row && e.target.closest('[data-er-open]')) erOpenDetail(row.dataset.er);
  });

  // =====================================================================
  // Errand Requests (any staff)
  // =====================================================================
  async function erShowRequests(){
    const box = $('erReqBody');
    box.innerHTML = '<div class="empty-state">Loading\u2026</div>';
    try{
      const { data, error } = await db.from('errands').select('*').eq('requested_by', currentUser.id).order('created_at', { ascending:false }).limit(100);
      if(error) throw error;
      const rows = data || [];
      box.innerHTML = '<p class="pay-intro">Need something delivered, picked up, paid or filed? Request it here \u2014 Administration approves it and assigns a messenger. You\u2019re notified at each step.</p>' +
        '<div class="pay-actions"><button type="button" class="btn btn-primary" data-req-new="1">+ Request an Errand</button></div>' +
        (rows.length ? rows.map(e=> erRow(e)).join('') : '<div class="empty-state">You haven\u2019t requested any errands yet.</div>');
    }catch(e){ box.innerHTML = '<div class="empty-state">' + erErr('Couldn\u2019t load your requests: ', e) + '</div>'; }
  }
  $('erReqBody').addEventListener('click', (e)=>{
    if(e.target.closest('[data-req-new]')){ erOpenRequestForm(); return; }
    const row = e.target.closest('.sp-row[data-er]');
    if(row && e.target.closest('[data-er-open]')) erOpenDetail(row.dataset.er);
  });
  function erOpenRequestForm(){
    const box = $('erReqBody');
    box.innerHTML = '<div class="po-ed-top"><button type="button" class="po-back" data-er-back="1">\u2039 My requests</button><div class="po-ed-title">Request an errand</div></div>' +
      erFormHtml({}, true) + '<div class="pay-actions"><button type="button" class="btn btn-primary" data-req-send="1">Send Request</button></div>';
    erFormEvents(box);
    box.querySelector('[data-req-send]').addEventListener('click', async (ev)=>{
      const p = erReadForm();
      if(!p.title){ toast('Say what the errand is'); return; }
      if(!p.due_at){ toast('Set when it\u2019s needed'); return; }
      ev.target.disabled = true;
      const { error } = await db.rpc('errand_request', { p });
      ev.target.disabled = false;
      if(error){ toast('Couldn\u2019t send: ' + (error.message || describeCloudError(error))); return; }
      toast('Request sent to Administration');
      erShowRequests();
    });
  }

  // =====================================================================
  // Recurring errands
  // =====================================================================
  function erRecDesc(r){
    const t = String(r.due_time || '').slice(0, 5);
    if(r.freq === 'daily') return 'Every day at ' + t;
    if(r.freq === 'weekly') return 'Every ' + (r.weekdays || []).map(d=> ER_DAYS[d]).join(', ') + ' at ' + t;
    const dom = Number(r.day_of_month) === 0 ? 'last day' : 'day ' + r.day_of_month;
    if(r.freq === 'monthly') return 'Monthly on ' + dom + ' at ' + t;
    return 'Yearly, ' + ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][(r.month || 1) - 1] + ' ' + dom + ' at ' + t;
  }
  function erRecurringHtml(){
    return '<p class="pay-intro">Errands that repeat \u2014 remittances, filings, deposits, rent. Each one is created automatically a few days before it\u2019s due and sent to its messenger.</p>' +
      (erCanApprove() ? '<div class="pay-actions"><button type="button" class="btn btn-primary" data-rec-open="new">+ New Recurring Errand</button></div>' : '<div class="pay-hint">Errands \u203A Approve is needed to set these up.</div>') +
      (er.recs.length ? er.recs.map(r=> '<div class="sp-row"' + (r.active ? '' : ' style="opacity:.55;"') + '><div class="sp-row-top"><div style="min-width:0;"><div class="sp-row-title">' + erEsc(r.title) +
        (r.active ? '' : ' <span class="sp-tag muted">Paused</span>') + '</div><div class="sp-row-sub">' + erEsc(erRecDesc(r)) + ' \u00B7 created ' + erEsc(r.lead_days) + ' day(s) ahead' +
        (r.next_due ? ' \u00B7 next ' + erEsc(payDate(r.next_due)) : '') + ' \u00B7 ' + erEsc((er.messengers.find(m=> m.id === r.assign_to) || {}).name || 'no messenger') + '</div></div></div>' +
        (erCanApprove() ? '<div class="user-card-actions"><button type="button" class="primary" data-rec-open="' + erEsc(r.id) + '">Edit</button></div>' : '') + '</div>').join('')
        : '<div class="empty-state">No recurring errands yet.</div>');
  }
  function erOpenRecEditor(r){
    const box = $('erManagerBody');
    r = r || { freq:'monthly', weekdays:[1], day_of_month:10, due_time:'10:00', lead_days:2, if_weekend:'before', active:true };
    const wd = new Set(r.weekdays || []);
    box.innerHTML = '<div class="po-ed-top"><button type="button" class="po-back" data-rec-back="1">\u2039 Recurring</button><div class="po-ed-title">' + (r.id ? erEsc(r.title) : 'New recurring errand') + '</div></div>' +
      '<div class="po-sec"><div class="po-sec-title">Repeats</div><div class="po-grid">' +
        payField('po-c3', 'How often', '<select id="erR_freq">' + Object.keys(ER_FREQ).map(k=> '<option value="' + k + '"' + (r.freq === k ? ' selected' : '') + '>' + ER_FREQ[k] + '</option>').join('') + '</select>') +
        payField('po-c3', 'Due time', '<input type="time" id="erR_time" value="' + erEsc(String(r.due_time || '10:00').slice(0, 5)) + '">') +
        payField('po-c3', 'Create it ahead (days)', '<input type="text" inputmode="numeric" id="erR_lead" value="' + erEsc(r.lead_days) + '">') +
        payField('po-c3', 'If it falls on a weekend', '<select id="erR_wk">' + payOpts({ keep:'Keep the date', before:'Move to Friday before', after:'Move to Monday after' }, r.if_weekend) + '</select>') +
        payField('po-c12 er-f-weekly', 'On', '<div class="pay-checks">' + ER_DAYS.map((d, i)=> '<label class="pay-chk"><input type="checkbox" data-wd="' + i + '"' + (wd.has(i) ? ' checked' : '') + '> ' + d + '</label>').join('') + '</div>') +
        payField('po-c3 er-f-month', 'Day of the month', '<input type="text" inputmode="numeric" id="erR_dom" value="' + erEsc(r.day_of_month) + '">', '0 = last day of the month') +
        payField('po-c3 er-f-year', 'Month', '<select id="erR_month">' + ['January','February','March','April','May','June','July','August','September','October','November','December'].map((m, i)=> '<option value="' + (i + 1) + '"' + (Number(r.month) === i + 1 ? ' selected' : '') + '>' + m + '</option>').join('') + '</select>') +
        payField('po-c3', 'Starting', '<input type="date" id="erR_start" value="' + erEsc(r.start_date || '') + '">') +
        payField('po-c3', 'Until (optional)', '<input type="date" id="erR_end" value="' + erEsc(r.end_date || '') + '">') +
      '</div></div>' + erFormHtml(Object.assign({}, r, { assigned_to:r.assign_to }), false, true) +
      '<div class="pay-actions"><button type="button" class="btn btn-primary" data-rec-save="1">Save</button>' +
        (r.id ? '<button type="button" class="btn btn-secondary" data-rec-toggle="1">' + (r.active ? 'Pause' : 'Resume') + '</button><button type="button" class="btn btn-secondary pay-danger" data-rec-del="1">Delete</button>' : '') + '</div>';
    const syncFreq = ()=>{
      const f = $('erR_freq').value;
      box.querySelectorAll('.er-f-weekly').forEach(el=> el.style.display = f === 'weekly' ? '' : 'none');
      box.querySelectorAll('.er-f-month').forEach(el=> el.style.display = f === 'monthly' || f === 'yearly' ? '' : 'none');
      box.querySelectorAll('.er-f-year').forEach(el=> el.style.display = f === 'yearly' ? '' : 'none');
    };
    $('erR_freq').addEventListener('change', syncFreq); syncFreq();
    erFormEvents(box);
    box.querySelector('[data-rec-back]').addEventListener('click', ()=>{ er.tab = 'recurring'; erShowManager(); });
    box.querySelector('[data-rec-save]').addEventListener('click', async ()=>{
      const p = erReadForm(true);
      delete p.assigned_to;
      Object.assign(p, { assign_to: $('erF_to').value || null, freq: $('erR_freq').value, due_time: $('erR_time').value || '10:00',
        lead_days: Number($('erR_lead').value) || 0, if_weekend: $('erR_wk').value, day_of_month: Number($('erR_dom').value) || 0,
        month: Number($('erR_month').value) || 1, start_date: $('erR_start').value || null, end_date: $('erR_end').value || null,
        weekdays: [...box.querySelectorAll('[data-wd]')].filter(c=> c.checked).map(c=> Number(c.dataset.wd)) });
      if(!p.title){ toast('Give it a title'); return; }
      const { error } = await db.rpc('errand_recurrence_save', { p_id: r.id || null, p });
      if(error){ toast('Couldn\u2019t save: ' + (error.message || describeCloudError(error))); return; }
      try{ await db.rpc('errand_recur_run_now'); }catch(e){}
      toast('Recurring errand saved'); er.tab = 'recurring'; erShowManager();
    });
    const tg = box.querySelector('[data-rec-toggle]');
    if(tg) tg.addEventListener('click', async ()=>{
      const { error } = await db.rpc('errand_recurrence_set', { p_id:r.id, p_active:!r.active, p_delete:false });
      if(error){ toast('Couldn\u2019t save: ' + describeCloudError(error)); return; }
      toast(r.active ? 'Paused' : 'Resumed'); er.tab = 'recurring'; erShowManager();
    });
    const del = box.querySelector('[data-rec-del]');
    if(del) del.addEventListener('click', async ()=>{
      if(!await uiConfirm('Delete the recurring errand \u201C' + r.title + '\u201D?\n\nErrands it already created stay.')) return;
      const { error } = await db.rpc('errand_recurrence_set', { p_id:r.id, p_active:false, p_delete:true });
      if(error){ toast('Couldn\u2019t delete: ' + describeCloudError(error)); return; }
      toast('Deleted'); er.tab = 'recurring'; erShowManager();
    });
  }
