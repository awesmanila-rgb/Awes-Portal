  // =====================================================================
  // Administration pages (20261014_01)
  //   Permits & Licenses · Vehicles · Contracts · Bills & Utilities · Office Assets
  // One small register engine drives all five (list → editor → files);
  // Vehicles, Bills and Assets add their own panels (trips / fuel / service,
  // monthly bills, issue & return). Each page lives in #purchasingView as
  // purchPanel_<key> with its body in #admBody_<key>.
  // =====================================================================

  const ADM_MIGRATION_MSG = 'This page isn\u2019t set up in the database yet \u2014 run migration <b>20261014_01_admin_office.sql</b> in Supabase first.';
  const admEsc = (v)=> escapeHtml(v == null ? '' : String(v));
  const admToday = ()=> new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
  const admDays = (d)=> d ? Math.round((new Date(d + 'T00:00:00Z') - new Date(admToday() + 'T00:00:00Z')) / 864e5) : null;
  const admPeso = (n)=> n == null || n === '' ? '' : '\u20B1' + Number(n).toLocaleString('en-PH', { minimumFractionDigits:2, maximumFractionDigits:2 });
  function admDate(d){ if(!d) return ''; try{ return new Date(d + 'T00:00:00+08:00').toLocaleDateString('en-PH', { timeZone:'Asia/Manila', month:'short', day:'numeric', year:'numeric' }); }catch(e){ return d; } }
  function admExpiryTag(d, lead){
    const n = admDays(d);
    if(n == null) return '';
    if(n < 0) return '<span class="sp-tag danger">Expired ' + admEsc(admDate(d)) + '</span>';
    if(n <= (lead == null ? 30 : lead)) return '<span class="sp-tag warn">' + (n === 0 ? 'Expires today' : n + ' day' + (n === 1 ? '' : 's') + ' left') + '</span>';
    return '<span class="sp-tag muted">Until ' + admEsc(admDate(d)) + '</span>';
  }
  const admMissing = (e)=> /adm_|PGRST20[25]|42P01|42883/.test(String((e && (e.message || e.code)) || '')) && /does not exist|schema cache|could not find/i.test(String(e && e.message));

  const ADM_PERMIT_KINDS = { business_permit:'Mayor\u2019s / Business Permit', bir_cor:'BIR Certificate of Registration (2303)', fsic:'Fire Safety Inspection Certificate (FSIC)',
    pcab:'PCAB Contractor\u2019s License', philgeps:'PhilGEPS Registration', sec_dti:'SEC / DTI Registration', sss_philhealth_pagibig:'SSS / PhilHealth / Pag-IBIG employer registration',
    insurance:'Insurance policy', iso:'ISO / certification', barangay:'Barangay Clearance', other:'Other' };
  const ADM_CONTRACT_KINDS = { customer_pms:'Customer PMS / maintenance', customer_service:'Customer service / project', supplier:'Supplier agreement', lease:'Office / warehouse lease', other:'Other' };
  const ADM_BILL_CATS = { electricity:'Electricity', water:'Water', internet:'Internet', phone:'Phone / mobile plan', rent:'Rent', association:'Association dues', other:'Other' };
  const ADM_ASSET_CATS = { laptop:'Laptop', desktop:'Desktop', phone:'Mobile phone', tablet:'Tablet', printer:'Printer', monitor:'Monitor', furniture:'Furniture', other:'Other' };
  const ADM_VEH_KINDS = { van:'Van', pickup:'Pick-up', car:'Car', truck:'Truck', motorcycle:'Motorcycle', other:'Other' };

  // ---- page definitions ----------------------------------------------------
  const ADM = {
    permits: { table:'adm_permits', module:'adm.permits', entity:'permit', noun:'permit / license', order:'expires_on',
      intro:'Business permits, registrations, licenses and certificates. The Inbox reminds whoever has this page before each one expires (60 days ahead by default).',
      fields:[['kind','Type','select',ADM_PERMIT_KINDS,'c6'],['name','Name / description','text',null,'c6',true],['number','Number','text',null,'c3'],['issuer','Issued by','text',null,'c3'],
        ['holder','Covers (office / branch / person)','text',null,'c6'],['issued_on','Issued','date',null,'c3'],['expires_on','Expires','date',null,'c3'],
        ['lead_days','Remind me (days before)','number',null,'c3'],['cost','Cost (\u20B1)','number',null,'c3'],['notes','Notes','textarea',null,'c12'],['active','In use','check',null,'c12']],
      defaults:{ kind:'business_permit', lead_days:60, active:true },
      row:(r)=> ({ title:r.name, tag:r.active === false ? '<span class="sp-tag muted">Not in use</span>' : admExpiryTag(r.expires_on, r.lead_days),
        sub:[ADM_PERMIT_KINDS[r.kind] || r.kind, r.number, r.issuer].filter(Boolean).join(' \u00B7 ') }) },
    contracts: { table:'adm_contracts', module:'adm.contracts', entity:'contract', noun:'contract', order:'end_on',
      intro:'Customer PMS and service contracts, supplier agreements and leases. You\u2019re reminded before each one ends (30 days ahead by default).',
      fields:[['kind','Type','select',ADM_CONTRACT_KINDS,'c6'],['title','Title','text',null,'c6',true],['party_name','Customer / supplier / lessor','text',null,'c6'],
        ['contract_no','Contract no.','text',null,'c3'],['status','Status','select',{ draft:'Draft', active:'Active', renewed:'Renewed', ended:'Ended', cancelled:'Cancelled' },'c3'],
        ['start_on','Starts','date',null,'c3'],['end_on','Ends','date',null,'c3'],['lead_days','Remind me (days before)','number',null,'c3'],['value','Value (\u20B1)','number',null,'c3'],
        ['billing','Billing (e.g. monthly, quarterly)','text',null,'c6'],['auto_renew','Renews automatically','check',null,'c6'],['notes','Notes / scope','textarea',null,'c12']],
      defaults:{ kind:'customer_pms', status:'active', lead_days:30 },
      row:(r)=> ({ title:r.title, tag:r.status !== 'active' ? '<span class="sp-tag muted">' + admEsc(r.status) + '</span>' : admExpiryTag(r.end_on, r.lead_days),
        sub:[ADM_CONTRACT_KINDS[r.kind] || r.kind, r.party_name, r.value != null ? admPeso(r.value) : '', r.billing].filter(Boolean).join(' \u00B7 ') }) },
    vehicles: { table:'adm_vehicles', module:'adm.vehicles', entity:'vehicle', noun:'vehicle', order:'plate_no',
      intro:'Company vehicles: trip tickets, fuel, PMS and OR/CR / insurance. Alerts go out 30 days before registration or insurance expires, when PMS is due, or when a trip is still out after 12 hours.',
      fields:[['plate_no','Plate no.','text',null,'c3',true],['make_model','Make / model','text',null,'c3'],['kind','Type','select',ADM_VEH_KINDS,'c3'],['year','Year','number',null,'c3'],
        ['color','Color','text',null,'c3'],['odometer_km','Odometer (km)','number',null,'c3'],['reg_expires_on','OR/CR registration expires','date',null,'c3'],['insurance_expires_on','Insurance expires','date',null,'c3'],
        ['pms_every_km','PMS every (km)','number',null,'c3'],['next_pms_km','Next PMS at (km)','number',null,'c3'],['next_pms_on','Next PMS date','date',null,'c3'],
        ['assigned_to','Usually driven by','person',null,'c3'],['notes','Notes','textarea',null,'c12'],['active','In use','check',null,'c12']],
      defaults:{ kind:'van', active:true, pms_every_km:5000 },
      row:(r)=>{
        const w = [];
        const rg = admDays(r.reg_expires_on), ins = admDays(r.insurance_expires_on);
        if(rg != null && rg <= 30) w.push(rg < 0 ? 'OR/CR expired' : 'OR/CR in ' + rg + 'd');
        if(ins != null && ins <= 30) w.push(ins < 0 ? 'insurance expired' : 'insurance in ' + ins + 'd');
        if(r.next_pms_km && r.odometer_km >= r.next_pms_km - 300) w.push('PMS due');
        return { title:r.plate_no + (r.make_model ? ' \u2014 ' + r.make_model : ''), tag: r.active === false ? '<span class="sp-tag muted">Not in use</span>' : (w.length ? '<span class="sp-tag warn">' + admEsc(w.join(' \u00B7 ')) + '</span>' : ''),
          sub:[ADM_VEH_KINDS[r.kind] || r.kind, (r.odometer_km || 0).toLocaleString('en-PH') + ' km', r.next_pms_km ? 'next PMS ' + Number(r.next_pms_km).toLocaleString('en-PH') + ' km' : ''].filter(Boolean).join(' \u00B7 ') };
      } },
    assets: { table:'adm_assets', module:'adm.assets', entity:'asset', noun:'asset', order:'asset_tag',
      intro:'Laptops, phones, printers and other office equipment. Issue each one to a person and take it back when they leave \u2014 you\u2019re alerted if it\u2019s still with someone whose account was deactivated.',
      fields:[['category','Category','select',ADM_ASSET_CATS,'c3'],['name','Item','text',null,'c6',true],['asset_tag','Tag (auto)','text',null,'c3','ro'],
        ['brand_model','Brand / model','text',null,'c6'],['serial_no','Serial no.','text',null,'c6'],['purchased_on','Purchased','date',null,'c3'],['cost','Cost (\u20B1)','number',null,'c3'],
        ['status','Status','select',{ available:'Available', issued:'Issued', repair:'Under repair', retired:'Retired', lost:'Lost' },'c3'],['holder_id','Issued to','person',null,'c3'],
        ['notes','Notes / condition','textarea',null,'c12']],
      defaults:{ category:'laptop', status:'available' },
      row:(r)=> ({ title:(r.asset_tag ? r.asset_tag + ' \u2014 ' : '') + r.name,
        tag: r.status === 'issued' ? '<span class="sp-tag">With ' + admEsc(r.holder_name) + '</span>' : '<span class="sp-tag ' + (r.status === 'available' ? 'muted' : 'warn') + '">' + admEsc({ available:'Available', repair:'Under repair', retired:'Retired', lost:'Lost' }[r.status] || r.status) + '</span>',
        sub:[ADM_ASSET_CATS[r.category] || r.category, r.brand_model, r.serial_no ? 'S/N ' + r.serial_no : ''].filter(Boolean).join(' \u00B7 ') }) }
  };
  const adm = { key:null, rows:[], people:[], messengers:[], q:'', showAll:false };
  const admCanEdit = (key)=> can((key === 'bills' ? { module:'adm.bills' } : ADM[key]).module, 'edit');

  async function admOnShow(key){
    $('purchasingView').classList.add('po-wide');
    adm.key = key; adm.q = '';
    const box = $('admBody_' + key);
    box.innerHTML = '<div class="empty-state">Loading\u2026</div>';
    if(!(await ensureCloud())){ box.innerHTML = '<div class="empty-state">Not connected.</div>'; return; }
    try{
      const pp = await db.from('profiles').select('id, name, role, active').in('role', ['staff', 'technician']).order('name');
      adm.people = (pp.data || []).filter(p=> p.active !== false);
    }catch(e){ adm.people = []; }
    if(key === 'bills') return admBillsShow();
    admList(key);
  }

  // ---- generic list ---------------------------------------------------------
  async function admList(key){
    const d = ADM[key], box = $('admBody_' + key);
    try{
      const { data, error } = await db.from(d.table).select('*').order(d.order, { ascending:true, nullsFirst:false });
      if(error) throw error;
      adm.rows = data || [];
    }catch(e){ box.innerHTML = '<div class="empty-state">' + (admMissing(e) ? ADM_MIGRATION_MSG : admEsc('Couldn\u2019t load: ' + describeCloudError(e))) + '</div>'; return; }
    const draw = ()=>{
      const q = adm.q.trim().toLowerCase();
      const rows = adm.rows.filter(r=> (adm.showAll || r.active !== false && !['retired', 'lost', 'ended', 'cancelled'].includes(r.status)) &&
        (!q || JSON.stringify(r).toLowerCase().includes(q)));
      box.querySelector('.adm-list').innerHTML = rows.length ? rows.map(r=>{ const v = d.row(r);
        return '<div class="sp-row" data-id="' + admEsc(r.id) + '"><div class="sp-row-top"><div style="min-width:0;"><div class="sp-row-title">' + admEsc(v.title) + ' ' + (v.tag || '') + '</div>' +
          '<div class="sp-row-sub">' + admEsc(v.sub) + '</div></div></div><div class="user-card-actions"><button type="button" class="primary" data-open="1">Open</button></div></div>'; }).join('')
        : '<div class="empty-state">' + (adm.rows.length ? 'Nothing matches.' : 'Nothing here yet.') + '</div>';
    };
    box.innerHTML = '<p class="pay-intro">' + d.intro + '</p><div class="stf-toolbar">' +
      (admCanEdit(key) ? '<button type="button" class="btn btn-primary" data-new="1">+ Add ' + admEsc(d.noun) + '</button>' : '') +
      '<input type="search" class="emp-search" placeholder="Search" data-q="1"><label class="sp-check"><input type="checkbox" data-all="1"' + (adm.showAll ? ' checked' : '') + '> Show inactive / ended</label></div><div class="adm-list"></div>';
    draw();
    box.querySelector('[data-q]').addEventListener('input', (e)=>{ adm.q = e.target.value; draw(); });
    box.querySelector('[data-all]').addEventListener('change', (e)=>{ adm.showAll = e.target.checked; draw(); });
    const nb = box.querySelector('[data-new]'); if(nb) nb.addEventListener('click', ()=> admEdit(key, null));
    box.querySelector('.adm-list').addEventListener('click', (e)=>{ const r = e.target.closest('.sp-row'); if(r && e.target.closest('[data-open]')) admEdit(key, adm.rows.find(x=> x.id === r.dataset.id)); });
  }

  // ---- generic editor -------------------------------------------------------
  function admFieldHtml(f, v, ro){
    const [k, label, type, opts, w, req] = f;
    const dis = ro || req === 'ro' ? ' disabled' : '';
    const id = 'admF_' + k;
    let inp;
    if(type === 'select') inp = '<select id="' + id + '"' + dis + '>' + Object.keys(opts).map(o=> '<option value="' + o + '"' + (String(v) === o ? ' selected' : '') + '>' + admEsc(opts[o]) + '</option>').join('') + '</select>';
    else if(type === 'textarea') inp = '<textarea id="' + id + '" rows="2"' + dis + '>' + admEsc(v || '') + '</textarea>';
    else if(type === 'check') return '<div class="po-c12"><label class="pay-chk"><input type="checkbox" id="' + id + '"' + (v ? ' checked' : '') + dis + '> ' + admEsc(label) + '</label></div>';
    else if(type === 'person') inp = '<select id="' + id + '"' + dis + '><option value="">\u2014 nobody \u2014</option>' + adm.people.map(p=> '<option value="' + admEsc(p.id) + '"' + (v === p.id ? ' selected' : '') + '>' + admEsc(p.name) + (p.role === 'technician' ? ' (technician)' : '') + '</option>').join('') + '</select>';
    else inp = '<input type="' + (type === 'number' ? 'text" inputmode="decimal' : type) + '" id="' + id + '" value="' + admEsc(v == null ? '' : v) + '"' + dis + '>';
    return '<div class="field po-' + w + '"><label>' + admEsc(label) + (req === true ? ' <span class="req">*</span>' : '') + '</label>' + inp + '</div>';
  }
  function admRead(d){
    const o = {};
    d.fields.forEach(([k, , type, , , req])=>{
      if(req === 'ro') return;
      const el = $('admF_' + k); if(!el) return;
      if(type === 'check') o[k] = el.checked;
      else if(type === 'number') o[k] = el.value.trim() === '' ? null : Number(el.value.replace(/,/g, ''));
      else if(type === 'date' || type === 'person') o[k] = el.value || null;
      else o[k] = el.value.trim();
    });
    return o;
  }
  function admEdit(key, r){
    const d = ADM[key], box = $('admBody_' + key), edit = admCanEdit(key);
    const v = Object.assign({}, d.defaults, r || {});
    box.innerHTML = '<div class="po-ed-top"><button type="button" class="po-back" data-back="1">\u2039 Back</button><div class="po-ed-title">' + admEsc(r ? d.row(r).title : 'New ' + d.noun) + '</div></div>' +
      '<div class="po-sec"><div class="po-grid">' + d.fields.map(f=> admFieldHtml(f, v[f[0]], !edit)).join('') + '</div></div>' +
      (edit ? '<div class="pay-actions"><button type="button" class="btn btn-primary" data-save="1">' + (r ? 'Save Changes' : 'Add') + '</button>' +
        (r ? '<button type="button" class="btn btn-secondary pay-danger" data-del="1">Delete</button>' : '') + '</div>' : '') +
      (r && key === 'vehicles' ? '<div id="admVehExtra"></div>' : '') +
      (r && key === 'assets' ? '<div id="admAssetExtra"></div>' : '') +
      (r ? '<div class="po-sec"><div class="po-sec-title">Files (scans, photos, PDFs)</div><div id="admFiles"></div></div>' : '');
    window.scrollTo({ top:0 });
    box.querySelector('[data-back]').addEventListener('click', ()=> admList(key));
    if(edit){
      box.querySelector('[data-save]').addEventListener('click', async (e)=>{
        const o = admRead(d);
        const reqF = d.fields.find(f=> f[5] === true && !o[f[0]]);
        if(reqF){ toast('Enter the ' + reqF[1].toLowerCase()); return; }
        const bad = d.fields.find(f=> f[2] === 'number' && o[f[0]] != null && !Number.isFinite(o[f[0]]));
        if(bad){ toast(bad[1] + ' must be a number'); return; }
        e.target.disabled = true;
        const q = r ? db.from(d.table).update(o).eq('id', r.id).select() : db.from(d.table).insert(o).select();
        const { data, error } = await q;
        e.target.disabled = false;
        if(error){ toast('Couldn\u2019t save: ' + (/unique|duplicate/i.test(error.message) ? 'that already exists' : error.message)); return; }
        toast(r ? 'Saved' : 'Added');
        const saved = (data && data[0]) || r;
        admEdit(key, saved);
      });
      const del = box.querySelector('[data-del]');
      if(del) del.addEventListener('click', async ()=>{
        if(!await uiConfirm('Delete this ' + d.noun + '?\n\nIts files and history are deleted too. To keep the record, untick \u201CIn use\u201D or set the status instead.')) return;
        const { error } = await db.from(d.table).delete().eq('id', r.id);
        if(error){ toast('Couldn\u2019t delete: ' + error.message); return; }
        toast('Deleted'); admList(key);
      });
    }
    if(r){
      admFiles(d.entity, r.id, edit);
      if(key === 'vehicles') admVehicleExtra(r, edit);
      if(key === 'assets') admAssetExtra(r, edit);
    }
  }

  // ---- files ------------------------------------------------------------------
  async function admFiles(entity, id, edit){
    const box = $('admFiles'); if(!box) return;
    const { data } = await db.from('adm_files').select('*').eq('entity', entity).eq('entity_id', id).order('uploaded_at');
    const files = data || [];
    box.innerHTML = (files.length ? files.map(f=> '<div class="pay-audit" data-f="' + admEsc(f.id) + '"><button type="button" class="pay-link" data-open-f="' + admEsc(f.path) + '">\uD83D\uDCCE ' + admEsc(f.name || f.path.split('/').pop()) + '</button>' +
        (edit ? ' <button type="button" class="pay-rm" data-del-f="' + admEsc(f.id) + '" aria-label="Remove">\u00D7</button>' : '') + '</div>').join('') : '<div class="pay-hint">No files yet.</div>') +
      (edit ? '<button type="button" class="btn btn-secondary pay-sm" data-up="1" style="margin-top:8px;">+ Add file</button>' : '');
    box.onclick = async (e)=>{
      const o = e.target.closest('[data-open-f]');
      if(o){ const { data } = await db.storage.from('admin-docs').createSignedUrl(o.dataset.openF, 600); if(data && data.signedUrl) window.open(data.signedUrl, '_blank', 'noopener'); return; }
      const dl = e.target.closest('[data-del-f]');
      if(dl){
        const f = files.find(x=> x.id === dl.dataset.delF);
        if(!await uiConfirm('Remove ' + (f.name || 'this file') + '?')) return;
        await db.storage.from('admin-docs').remove([f.path]);
        await db.from('adm_files').delete().eq('id', f.id);
        admFiles(entity, id, edit); return;
      }
      if(e.target.closest('[data-up]')){
        const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/*,application/pdf';
        inp.onchange = async ()=>{
          const file = inp.files && inp.files[0]; if(!file) return;
          if(file.size > 15 * 1024 * 1024){ toast('Files up to 15 MB'); return; }
          let blob = file;
          if(/^image\//.test(file.type)){ try{ blob = await compressImageForUpload(file, { targetBytes:400 * 1024, maxDim:2000 }); }catch(err){} }
          const safe = file.name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(-60);
          const path = entity + '/' + id + '/' + Date.now() + '-' + safe;
          toast('Uploading\u2026');
          const up = await db.storage.from('admin-docs').upload(path, blob, { contentType: blob.type || file.type });
          if(up.error){ toast('Couldn\u2019t upload: ' + up.error.message); return; }
          const { error } = await db.from('adm_files').insert({ entity, entity_id:id, path, name:file.name });
          if(error){ toast('Couldn\u2019t save the file: ' + error.message); return; }
          toast('File added'); admFiles(entity, id, edit);
        };
        inp.click();
      }
    };
  }

  // ---- vehicles: trips, fuel, service ---------------------------------------------
  async function admVehicleExtra(v, edit){
    const box = $('admVehExtra'); if(!box) return;
    const [t, f, s] = await Promise.all([
      db.from('adm_vehicle_trips').select('*').eq('vehicle_id', v.id).order('out_at', { ascending:false }).limit(30),
      db.from('adm_vehicle_fuel').select('*').eq('vehicle_id', v.id).order('filled_on', { ascending:false }).limit(20),
      db.from('adm_vehicle_service').select('*').eq('vehicle_id', v.id).order('serviced_on', { ascending:false }).limit(20)
    ]);
    const trips = t.data || [], fuel = f.data || [], svc = s.data || [];
    const open = trips.find(x=> x.status === 'out');
    const when = (ts)=> ts ? new Date(ts).toLocaleString('en-PH', { timeZone:'Asia/Manila', month:'short', day:'numeric', hour:'numeric', minute:'2-digit' }) : '';
    box.innerHTML =
      '<div class="po-sec"><div class="po-sec-title">Trip tickets</div>' +
        (open ? '<div class="pay-banner warn">Out since ' + admEsc(when(open.out_at)) + ' \u2014 ' + admEsc(open.driver_name) + ' to ' + admEsc(open.destination || '\u2014') + ' (' + admEsc(open.trip_no) + ')' +
            (edit ? ' <button type="button" class="btn btn-primary pay-sm" data-trip-in="' + admEsc(open.id) + '">Close trip\u2026</button>' : '') + '</div>'
          : (edit ? '<div class="po-grid">' +
              '<div class="field po-c3"><label>Driver</label><select id="admT_driver">' + adm.people.map(p=> '<option value="' + admEsc(p.id) + '"' + (p.id === v.assigned_to ? ' selected' : '') + '>' + admEsc(p.name) + '</option>').join('') + '</select></div>' +
              '<div class="field po-c3"><label>Destination</label><input type="text" id="admT_dest"></div>' +
              '<div class="field po-c3"><label>Purpose / JO / errand no.</label><input type="text" id="admT_ref"></div>' +
              '<div class="field po-c3"><label>Odometer out (km)</label><input type="text" inputmode="numeric" id="admT_km" value="' + admEsc(v.odometer_km || 0) + '"></div>' +
              '<div class="po-c12"><button type="button" class="btn btn-primary pay-sm" data-trip-out="1">Start trip ticket</button></div></div>' : '')) +
        (trips.length ? '<div class="pay-table-wrap"><table class="pay-table"><thead><tr><th>Trip</th><th>Driver</th><th>Destination</th><th>Out</th><th>In</th><th class="num">km</th></tr></thead><tbody>' +
          trips.map(x=> '<tr><td>' + admEsc(x.trip_no) + '</td><td>' + admEsc(x.driver_name) + '</td><td>' + admEsc(x.destination) + (x.reference ? '<div class="pay-muted">' + admEsc(x.reference) + '</div>' : '') + '</td><td>' + admEsc(when(x.out_at)) + '</td><td>' + admEsc(x.status === 'out' ? 'still out' : when(x.in_at)) + '</td><td class="num">' + (x.km_in != null ? (x.km_in - x.km_out).toLocaleString('en-PH') : '\u2013') + '</td></tr>').join('') +
          '</tbody></table></div>' : '<div class="pay-hint">No trips yet.</div>') + '</div>' +
      '<div class="po-sec"><div class="po-sec-title">Fuel</div>' +
        (edit ? '<div class="po-grid"><div class="field po-c3"><label>Date</label><input type="date" id="admF2_date" value="' + admToday() + '"></div><div class="field po-c3"><label>Amount (\u20B1)</label><input type="text" inputmode="decimal" id="admF2_amt"></div>' +
          '<div class="field po-c3"><label>Liters</label><input type="text" inputmode="decimal" id="admF2_l"></div><div class="field po-c3"><label>Odometer (km)</label><input type="text" inputmode="numeric" id="admF2_km"></div>' +
          '<div class="field po-c6"><label>Station</label><input type="text" id="admF2_st"></div><div class="po-c6" style="align-self:end;"><button type="button" class="btn btn-secondary pay-sm" data-fuel="1">+ Add fuel</button></div></div>' : '') +
        (fuel.length ? fuel.map(x=> '<div class="pay-audit"><span class="pay-audit-when">' + admEsc(admDate(x.filled_on)) + '</span> ' + admPeso(x.amount) + (x.liters ? ' \u00B7 ' + x.liters + ' L' : '') + (x.odometer_km ? ' \u00B7 ' + Number(x.odometer_km).toLocaleString('en-PH') + ' km' : '') + (x.station ? ' \u00B7 ' + admEsc(x.station) : '') + '</div>').join('') : '<div class="pay-hint">No fuel records yet.</div>') + '</div>' +
      '<div class="po-sec"><div class="po-sec-title">Service / PMS</div>' +
        (edit ? '<div class="po-grid"><div class="field po-c3"><label>Date</label><input type="date" id="admS_date" value="' + admToday() + '"></div><div class="field po-c3"><label>Odometer (km)</label><input type="text" inputmode="numeric" id="admS_km" value="' + admEsc(v.odometer_km || '') + '"></div>' +
          '<div class="field po-c6"><label>Work done</label><input type="text" id="admS_work" placeholder="e.g. change oil, oil & air filter"></div><div class="field po-c3"><label>Shop</label><input type="text" id="admS_shop"></div>' +
          '<div class="field po-c3"><label>Cost (\u20B1)</label><input type="text" inputmode="decimal" id="admS_cost"></div><div class="field po-c3"><label>Next PMS date (optional)</label><input type="date" id="admS_next"></div>' +
          '<div class="po-c3" style="align-self:end;"><button type="button" class="btn btn-secondary pay-sm" data-svc="1">+ Add service</button></div></div>' +
          '<div class="pay-hint">The next PMS km is set automatically: odometer + \u201CPMS every (km)\u201D.</div>' : '') +
        (svc.length ? svc.map(x=> '<div class="pay-audit"><span class="pay-audit-when">' + admEsc(admDate(x.serviced_on)) + '</span> ' + admEsc(x.work) + (x.odometer_km ? ' \u00B7 ' + Number(x.odometer_km).toLocaleString('en-PH') + ' km' : '') + (x.cost ? ' \u00B7 ' + admPeso(x.cost) : '') + (x.shop ? ' \u00B7 ' + admEsc(x.shop) : '') + '</div>').join('') : '<div class="pay-hint">No service records yet.</div>') + '</div>';
    if(!edit) return;
    const reload = async ()=>{ const r = await db.from('adm_vehicles').select('*').eq('id', v.id).maybeSingle(); admEdit('vehicles', r.data || v); };
    box.onclick = async (e)=>{
      if(e.target.closest('[data-trip-out]')){
        const km = Number($('admT_km').value), drv = $('admT_driver');
        if(!(km >= 0)){ toast('Enter the odometer reading'); return; }
        const { error } = await db.from('adm_vehicle_trips').insert({ vehicle_id:v.id, driver_id:drv.value || null, driver_name:drv.options[drv.selectedIndex] ? drv.options[drv.selectedIndex].text : '',
          destination:$('admT_dest').value.trim(), reference:$('admT_ref').value.trim(), km_out:km });
        if(error){ toast('Couldn\u2019t start: ' + error.message); return; }
        toast('Trip ticket started'); reload();
      }
      const ti = e.target.closest('[data-trip-in]');
      if(ti){
        const kmIn = await uiPrompt('Close the trip\n\nOdometer reading now (km)?', '', { ok:'Close trip', multiline:false });
        if(kmIn == null) return;
        const n = Number(String(kmIn).replace(/,/g, ''));
        if(!(n >= 0)){ toast('Enter the odometer reading'); return; }
        const { error } = await db.from('adm_vehicle_trips').update({ status:'returned', km_in:n, in_at:new Date().toISOString() }).eq('id', ti.dataset.tripIn);
        if(error){ toast(/check/i.test(error.message) ? 'That\u2019s lower than the km when it left' : 'Couldn\u2019t close: ' + error.message); return; }
        toast('Trip closed'); reload();
      }
      if(e.target.closest('[data-fuel]')){
        const amt = Number($('admF2_amt').value.replace(/,/g, ''));
        if(!(amt > 0)){ toast('Enter the amount'); return; }
        const km = $('admF2_km').value.trim(), l = $('admF2_l').value.trim();
        const { error } = await db.from('adm_vehicle_fuel').insert({ vehicle_id:v.id, filled_on:$('admF2_date').value || admToday(), amount:amt,
          liters: l ? Number(l) : null, odometer_km: km ? Number(km) : null, station:$('admF2_st').value.trim() });
        if(error){ toast('Couldn\u2019t save: ' + error.message); return; }
        toast('Fuel added'); reload();
      }
      if(e.target.closest('[data-svc]')){
        const work = $('admS_work').value.trim();
        if(!work){ toast('Say what work was done'); return; }
        const km = $('admS_km').value.trim(), cost = $('admS_cost').value.trim();
        const { error } = await db.from('adm_vehicle_service').insert({ vehicle_id:v.id, serviced_on:$('admS_date').value || admToday(), work,
          odometer_km: km ? Number(km) : null, cost: cost ? Number(cost) : null, shop:$('admS_shop').value.trim(), next_due_on:$('admS_next').value || null });
        if(error){ toast('Couldn\u2019t save: ' + error.message); return; }
        toast('Service recorded'); reload();
      }
    };
  }

  // ---- assets: history --------------------------------------------------------------
  async function admAssetExtra(a){
    const box = $('admAssetExtra'); if(!box) return;
    const { data } = await db.from('adm_asset_events').select('*').eq('asset_id', a.id).order('at', { ascending:false }).limit(40);
    box.innerHTML = '<div class="po-sec"><div class="po-sec-title">History</div>' + ((data || []).map(x=> '<div class="pay-audit"><span class="pay-audit-when">' +
      admEsc(new Date(x.at).toLocaleString('en-PH', { timeZone:'Asia/Manila', month:'short', day:'numeric', year:'numeric' })) + '</span> ' +
      admEsc({ added:'Added', issued:'Issued to ' + x.holder_name, returned:'Returned by ' + x.holder_name, repair:'Sent for repair', retired:'Retired', lost:'Reported lost' }[x.action] || x.action) +
      (x.by_name ? ' <span class="pay-muted">(' + admEsc(x.by_name) + ')</span>' : '') + '</div>').join('') || '<div class="pay-hint">\u2014</div>') +
      '<div class="pay-hint">To issue or take back: set \u201CIssued to\u201D (or clear it) and save.</div></div>';
  }

  // ---- bills --------------------------------------------------------------------------
  const ADM_BILL_FIELDS = [['name','Account name','text',null,'c6',true],['category','Type','select',ADM_BILL_CATS,'c3'],['provider','Provider','text',null,'c3'],
    ['account_no','Account no.','text',null,'c3'],['due_day','Due every month on day','number',null,'c3'],['usual_amount','Usual amount (\u20B1)','number',null,'c3'],
    ['pay_at','Where / how it\u2019s paid','text',null,'c3'],['send_messenger','Usually paid by the messenger','check',null,'c12'],['messenger_id','Messenger','messenger',null,'c6'],
    ['notes','Notes','textarea',null,'c12'],['active','Active','check',null,'c12']];
  async function admBillsShow(){
    const box = $('admBody_bills'), edit = can('adm.bills', 'edit');
    try{
      await db.rpc('adm_bills_generate');
      const [a, b, m] = await Promise.all([
        db.from('adm_bill_accounts').select('*').order('name'),
        db.from('adm_bills').select('*').order('due_on', { ascending:false }).limit(200),
        db.rpc('errand_messengers')
      ]);
      if(a.error) throw a.error; if(b.error) throw b.error;
      adm.accounts = a.data || []; adm.bills = b.data || []; adm.messengers = m.data || [];
    }catch(e){ box.innerHTML = '<div class="empty-state">' + (admMissing(e) ? ADM_MIGRATION_MSG : admEsc('Couldn\u2019t load: ' + describeCloudError(e))) + '</div>'; return; }
    const accName = (id)=> (adm.accounts.find(x=> x.id === id) || {}).name || '';
    const unpaid = adm.bills.filter(x=> x.status === 'unpaid').sort((x, y)=> x.due_on.localeCompare(y.due_on));
    const paid = adm.bills.filter(x=> x.status === 'paid').slice(0, 30);
    const billRow = (x)=>{
      const n = admDays(x.due_on);
      const tag = x.status === 'paid' ? '<span class="sp-tag">Paid ' + admEsc(admDate(x.paid_on)) + '</span>'
        : n < 0 ? '<span class="sp-tag danger">Overdue ' + (-n) + 'd</span>' : n <= 3 ? '<span class="sp-tag warn">Due in ' + n + 'd</span>' : '<span class="sp-tag muted">Due ' + admEsc(admDate(x.due_on)) + '</span>';
      return '<div class="sp-row" data-bill="' + admEsc(x.id) + '"><div class="sp-row-top"><div style="min-width:0;"><div class="sp-row-title">' + admEsc(accName(x.account_id)) + ' \u00B7 ' +
        admEsc(new Date(x.period + 'T00:00:00+08:00').toLocaleDateString('en-PH', { timeZone:'Asia/Manila', month:'long', year:'numeric' })) + ' ' + tag + (x.errand_id ? ' <span class="sp-tag muted">Messenger errand</span>' : '') + '</div>' +
        '<div class="sp-row-sub">' + (x.status === 'paid' ? admPeso(x.paid_amount) + (x.reference ? ' \u00B7 ref ' + admEsc(x.reference) : '') : admPeso(x.amount) || 'amount not set') + '</div></div></div>' +
        (edit && x.status === 'unpaid' ? '<div class="user-card-actions"><button type="button" class="primary" data-pay="1">Mark paid\u2026</button>' + (x.errand_id ? '' : '<button type="button" data-send="1">Send messenger</button>') + '</div>' : '') + '</div>';
    };
    box.innerHTML = '<p class="pay-intro">Monthly bills are created automatically from each account a few days before they\u2019re due. You\u2019re alerted 3 days before and when overdue; tap <b>Send messenger</b> to make it an errand.</p>' +
      '<div class="po-sec"><div class="po-sec-title">To pay</div>' + (unpaid.length ? unpaid.map(billRow).join('') : '<div class="pay-hint">Nothing due.</div>') + '</div>' +
      '<div class="po-sec"><div class="po-sec-title">Accounts</div>' +
        (edit ? '<div class="pay-actions"><button type="button" class="btn btn-primary pay-sm" data-acc-new="1">+ Add account</button></div>' : '') +
        (adm.accounts.length ? adm.accounts.map(x=> '<div class="sp-row" data-acc="' + admEsc(x.id) + '"' + (x.active ? '' : ' style="opacity:.55;"') + '><div class="sp-row-top"><div style="min-width:0;"><div class="sp-row-title">' + admEsc(x.name) + '</div>' +
          '<div class="sp-row-sub">' + admEsc([ADM_BILL_CATS[x.category], x.account_no && 'acct ' + x.account_no, x.due_day && 'due every ' + x.due_day + ordinal(x.due_day), x.usual_amount != null && admPeso(x.usual_amount)].filter(Boolean).join(' \u00B7 ')) + '</div></div></div>' +
          '<div class="user-card-actions"><button type="button" class="primary" data-acc-open="1">' + (edit ? 'Edit' : 'View') + '</button></div></div>').join('') : '<div class="pay-hint">No accounts yet \u2014 add Meralco, water, internet, rent\u2026</div>') + '</div>' +
      (paid.length ? '<div class="po-sec"><div class="po-sec-title">Paid</div>' + paid.map(billRow).join('') + '</div>' : '');
    box.onclick = async (e)=>{
      if(e.target.closest('[data-acc-new]')) return admBillAccount(null);
      const ar = e.target.closest('[data-acc]');
      if(ar && e.target.closest('[data-acc-open]')) return admBillAccount(adm.accounts.find(x=> x.id === ar.dataset.acc));
      const br = e.target.closest('[data-bill]'); if(!br) return;
      const bill = adm.bills.find(x=> x.id === br.dataset.bill);
      if(e.target.closest('[data-send]')){
        const acc = adm.accounts.find(x=> x.id === bill.account_id) || {};
        if(!await uiConfirm('Send the messenger to pay ' + acc.name + '?\n\nAn errand is created' + (acc.messenger_id ? ' and assigned to ' + ((adm.messengers.find(m=> m.id === acc.messenger_id) || {}).name || 'the messenger') : ' for Administration to assign') +
          ', due ' + admDate(bill.due_on) + ', with ' + (admPeso(bill.amount) || 'the amount to be set') + ' as cash needed.', { ok:'Send' })) return;
        const { error } = await db.rpc('adm_bill_send_errand', { p_bill:bill.id, p_messenger:null });
        if(error){ toast('Couldn\u2019t send: ' + error.message); return; }
        toast('Errand created'); return admBillsShow();
      }
      if(e.target.closest('[data-pay]')){
        const amt = await uiPrompt('Mark paid\n\nAmount paid (\u20B1)?', bill.amount != null ? String(bill.amount) : '', { ok:'Next', multiline:false });
        if(amt == null) return;
        const n = Number(String(amt).replace(/,/g, ''));
        if(!(n >= 0)){ toast('Enter the amount'); return; }
        const ref = await uiPrompt('Official receipt / reference no. (optional)', '', { ok:'Mark paid', multiline:false });
        if(ref == null) return;
        const { error } = await db.from('adm_bills').update({ status:'paid', paid_on:admToday(), paid_amount:n, reference:ref.trim(), paid_by_name:currentUser.name || '' }).eq('id', bill.id);
        if(error){ toast('Couldn\u2019t save: ' + error.message); return; }
        toast('Marked paid'); admBillsShow();
      }
    };
  }
  function ordinal(n){ n = Number(n); return (n % 10 === 1 && n !== 11) ? 'st' : (n % 10 === 2 && n !== 12) ? 'nd' : (n % 10 === 3 && n !== 13) ? 'rd' : 'th'; }
  function admBillAccount(a){
    const box = $('admBody_bills'), edit = can('adm.bills', 'edit');
    const v = Object.assign({ category:'electricity', active:true }, a || {});
    box.innerHTML = '<div class="po-ed-top"><button type="button" class="po-back" data-back="1">\u2039 Bills & Utilities</button><div class="po-ed-title">' + admEsc(a ? a.name : 'New account') + '</div></div>' +
      '<div class="po-sec"><div class="po-grid">' + ADM_BILL_FIELDS.map(f=>{
        if(f[2] === 'messenger') return '<div class="field po-' + f[4] + '"><label>' + f[1] + '</label><select id="admF_messenger_id"' + (edit ? '' : ' disabled') + '><option value="">\u2014 Administration assigns \u2014</option>' +
          adm.messengers.map(m=> '<option value="' + admEsc(m.id) + '"' + (v.messenger_id === m.id ? ' selected' : '') + '>' + admEsc(m.name) + '</option>').join('') + '</select></div>';
        return admFieldHtml(f, v[f[0]], !edit); }).join('') + '</div></div>' +
      (edit ? '<div class="pay-actions"><button type="button" class="btn btn-primary" data-save="1">' + (a ? 'Save' : 'Add account') + '</button>' + (a ? '<button type="button" class="btn btn-secondary pay-danger" data-del="1">Delete</button>' : '') + '</div>' : '') +
      (a ? '<div class="po-sec"><div class="po-sec-title">Files</div><div id="admFiles"></div></div>' : '');
    box.querySelector('[data-back]').addEventListener('click', admBillsShow);
    if(a) admFiles('bill', a.id, edit);
    if(!edit) return;
    box.querySelector('[data-save]').addEventListener('click', async ()=>{
      const o = admRead({ fields:ADM_BILL_FIELDS.filter(f=> f[2] !== 'messenger') });
      o.messenger_id = $('admF_messenger_id').value || null;
      if(!o.name){ toast('Enter the account name'); return; }
      if(o.due_day != null && !(o.due_day >= 1 && o.due_day <= 31)){ toast('Due day is 1 to 31'); return; }
      const { error } = a ? await db.from('adm_bill_accounts').update(o).eq('id', a.id) : await db.from('adm_bill_accounts').insert(o);
      if(error){ toast('Couldn\u2019t save: ' + error.message); return; }
      toast('Saved'); admBillsShow();
    });
    const del = box.querySelector('[data-del]');
    if(del) del.addEventListener('click', async ()=>{
      if(!await uiConfirm('Delete ' + a.name + '?\n\nIts bill history is deleted too. To keep the history, untick Active instead.')) return;
      const { error } = await db.from('adm_bill_accounts').delete().eq('id', a.id);
      if(error){ toast('Couldn\u2019t delete: ' + error.message); return; }
      admBillsShow();
    });
  }
