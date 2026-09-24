// ---------- Record Past Service (admin back-entry) ----------
  // Admin can't author a normal Service Report (it carries the technician's
  // name and signature — see setVis('srTabNewBtn', isTech) in auth.js). This
  // is the honest alternative: record work a technician already performed,
  // filed under that technician, with both signatures left blank and the
  // record stamped with who keyed it in (admin_record_past_service[s] RPC,
  // supabase/migrations/20260924_02 and _03). It shows in the report lists
  // and in each unit's equipment history like any report.
  //
  // Single / Multiple mirrors the technician's own wizard: the work
  // details are shared, and each unit gets its own report, SR number and
  // operation parameters (readings differ per unit).
  let beUnits = [];        // customer_equipment rows for the chosen customer
  let beCards = [];        // [{key}] one per unit being reported
  let beCardSeq = 0;
  let beMulti = false;
  let beLoaded = false;

  const BE_OP = [
    // [row label, [field, placeholder, phase3-only]...]
    ['Amperage',                    [['amp1','Amps'],['amp2','A\u2082',1],['amp3','A\u2083',1]]],
    ['Voltage',                     [['volt1','Volts'],['volt2','V\u2082',1],['volt3','V\u2083',1]]],
    ['Pressure (Suction/Discharge)',[['psuc','Suction'],['pdis','Discharge']]],
    ['Supply Air Temp (\u00b0C)',   [['temp','Supply air temp (\u00b0C)']]],
    ['Air Volume Flow Rate (cfm)',  [['air','Air volume flow (cfm)']]]
  ];

  function beLines(id){
    return String($(id).value || '').split(/\r?\n/).map(x=> x.trim()).filter(Boolean);
  }
  function beReset(){
    ['beTrouble','beServices','beFindings','beRecs','beParts','beRemarks','beCustRep','beTimeIn','beTimeOut'].forEach(id=> $(id).value = '');
    $('beDate').value = '';
    $('beConfirm').checked = false;
    beSetMode(false);
  }

  // ---- unit cards ----
  function beOpTableHtml(key){
    const cell = (side, fields)=> '<td><div class="opdata-cell-inputs">' + fields.map(([f, ph, p3])=>
      '<input type="text" inputmode="decimal" data-op="'+side+'_'+f+'" placeholder="'+ph+'"'+(p3 ? ' class="be-p3" style="display:none;"' : '')+'>').join('') + '</div></td>';
    return '<div class="opdata-table-wrap"><table class="opdata-table"><thead><tr><th></th><th>Before Servicing</th><th>After Servicing</th></tr></thead><tbody>' +
      BE_OP.map(([label, fields])=> '<tr><td class="opdata-row-label">'+label+'</td>'+cell('b', fields)+cell('a', fields)+'</tr>').join('') +
      '</tbody></table></div>';
  }
  function beUnitOptions(selected){
    const taken = beCards.map(c=> beCardEl(c.key)).filter(Boolean).map(el=> el.querySelector('[data-be="unit"]').value);
    return '<option value="">Select unit…</option>' + beUnits.map(u=>{
      const bits = [equipDisplayName(u), u.equipType, u.brand, u.coolCap].map(x=> String(x || '').trim()).filter(Boolean);
      const dis = u.id !== selected && taken.includes(u.id);
      return '<option value="'+escapeHtml(u.id)+'"'+(u.id === selected ? ' selected' : '')+(dis ? ' disabled' : '')+'>'+escapeHtml(bits.join(' · ') + (dis ? ' (already added)' : ''))+'</option>';
    }).join('');
  }
  function beCardEl(key){ return $('beUnitList').querySelector('[data-card="'+key+'"]'); }
  function beRefreshUnitSelects(){
    beCards.forEach((c, i)=>{
      const el = beCardEl(c.key); if(!el) return;
      const sel = el.querySelector('[data-be="unit"]');
      const v = sel.value;
      sel.innerHTML = beUnits.length ? beUnitOptions(v) : '<option value="">'+($('beCustomer').value ? 'No units on file' : 'Choose a customer first…')+'</option>';
      sel.disabled = !beUnits.length;
      el.querySelector('.be-unit-head b').textContent = beMulti ? 'Unit ' + (i + 1) : 'Unit';
      el.querySelector('.be-unit-remove').style.display = (beMulti && beCards.length > 1) ? '' : 'none';
      el.querySelector('.be-copy').style.display = (beMulti && i > 0) ? '' : 'none';
    });
    $('beAddUnitBtn').style.display = beMulti ? '' : 'none';
    $('beAddUnitBtn').disabled = !beUnits.length || beCards.length >= beUnits.length;
    $('beWorkSub').textContent = beMulti ? 'shared by every unit' : '';
    $('beSaveBtn').textContent = beMulti ? 'Save ' + beCards.length + ' Past Service Report' + (beCards.length === 1 ? '' : 's') : 'Save Past Service Report';
  }
  function beAddCard(){
    const key = ++beCardSeq;
    beCards.push({ key });
    const el = document.createElement('div');
    el.className = 'be-unit'; el.dataset.card = key;
    el.innerHTML =
      '<div class="be-unit-head"><b>Unit</b><button type="button" class="be-unit-remove">Remove</button></div>' +
      '<div class="field"><label>Unit serviced <span class="req">*</span></label><select data-be="unit"></select></div>' +
      '<label class="sr-phase-toggle"><input type="checkbox" data-be="p3"><span>This unit is 3-phase (L1/L2/L3)</span></label>' +
      beOpTableHtml(key) +
      '<button type="button" class="be-copy">Copy readings from the unit above</button>';
    $('beUnitList').appendChild(el);
    el.querySelector('[data-be="unit"]').addEventListener('change', beRefreshUnitSelects);
    el.querySelector('[data-be="p3"]').addEventListener('change', (e)=> beApplyPhase(el, e.target.checked));
    el.querySelector('.be-unit-remove').addEventListener('click', ()=>{
      beCards = beCards.filter(c=> c.key !== key); el.remove(); beRefreshUnitSelects();
    });
    el.querySelector('.be-copy').addEventListener('click', ()=>{
      const idx = beCards.findIndex(c=> c.key === key);
      const prev = idx > 0 ? beCardEl(beCards[idx - 1].key) : null;
      if(!prev) return;
      const p3 = prev.querySelector('[data-be="p3"]').checked;
      el.querySelector('[data-be="p3"]').checked = p3; beApplyPhase(el, p3);
      prev.querySelectorAll('[data-op]').forEach(inp=>{ el.querySelector('[data-op="'+inp.dataset.op+'"]').value = inp.value; });
      toast('Readings copied — adjust what differs');
    });
    beRefreshUnitSelects();
  }
  function beApplyPhase(el, on){
    el.querySelectorAll('.be-p3').forEach(inp=>{ inp.style.display = on ? '' : 'none'; if(!on) inp.value = ''; });
  }
  function beSetMode(multi){
    beMulti = !!multi;
    $('beModeSingle').classList.toggle('active', !beMulti);
    $('beModeMulti').classList.toggle('active', beMulti);
    if(!beMulti){
      // back to one card: keep the first, drop the rest
      beCards.slice(1).forEach(c=>{ const el = beCardEl(c.key); if(el) el.remove(); });
      beCards = beCards.slice(0, 1);
    }
    if(!beCards.length) beAddCard();
    else if(beMulti && beCards.length < 2 && beUnits.length > 1) beAddCard();
    beRefreshUnitSelects();
  }
  $('beModeSingle').addEventListener('click', ()=> beSetMode(false));
  $('beModeMulti').addEventListener('click', ()=> beSetMode(true));
  $('beAddUnitBtn').addEventListener('click', ()=> beAddCard());

  // Same shape the normal report stores (before_data / after_data).
  function beReadOp(el, side){
    const v = f=>{ const i = el.querySelector('[data-op="'+side+'_'+f+'"]'); return i ? i.value.trim() : ''; };
    return { amp:[v('amp1'), v('amp2'), v('amp3')], volt:[v('volt1'), v('volt2'), v('volt3')],
             pressure:[v('psuc'), v('pdis')], temp:v('temp'), airflow:v('air') };
  }

  // ---- pickers ----
  async function beLoadPickers(){
    $('beDate').max = todayISO();
    const catSel = $('beCategory');
    if(!catSel.options.length){
      catSel.innerHTML = SERVICE_CATEGORIES.map(c=> '<option value="'+c.key+'">'+escapeHtml(c.label)+'</option>').join('');
      catSel.value = DEFAULT_REPORT_CATEGORY;
    }
    const techs = (await cloudListUsers() || []).filter(u=> u.active !== false)
      .sort((a, b)=> String(a.name || '').localeCompare(String(b.name || '')));
    const keepTech = $('beTech').value;
    $('beTech').innerHTML = '<option value="">Select technician…</option>' +
      techs.map(t=> '<option value="'+escapeHtml(t.id)+'">'+escapeHtml(t.name || t.username || 'Technician')+'</option>').join('');
    if(keepTech) $('beTech').value = keepTech;
    await loadCustomers();
    const keepCust = $('beCustomer').value;
    $('beCustomer').innerHTML = '<option value="">Select customer…</option>' +
      (customersCache || []).map(c=> '<option value="'+escapeHtml(c.id)+'">'+escapeHtml(c.name)+'</option>').join('');
    if(keepCust) $('beCustomer').value = keepCust;
    beLoaded = true;
  }
  async function beLoadUnits(){
    const custId = $('beCustomer').value;
    beUnits = [];
    $('beUnitHint').textContent = '';
    // a new customer means none of the old unit picks are valid
    beCards.forEach(c=>{ const el = beCardEl(c.key); if(el) el.querySelector('[data-be="unit"]').value = ''; });
    if(custId){
      try{
        const { data, error } = await db.from('customer_equipment').select('*').eq('customer_id', custId);
        if(error) throw error;
        beUnits = (data || []).map(equipRowToObj);
      }catch(e){ console.error('load units failed', describeCloudError(e)); toast('Could not load this customer\u2019s units'); }
      if(!beUnits.length) $('beUnitHint').textContent = 'This customer has no units on file. Add the unit under Equipment first, then come back to record the visit.';
    }
    beRefreshUnitSelects();
  }
  async function beOpen(){
    if(!beLoaded) beReset();
    try{ await beLoadPickers(); }
    catch(e){ console.error('record past service: load failed', e); toast('Could not load technicians/customers'); }
    beRefreshUnitSelects();
  }
  $('beCustomer').addEventListener('change', beLoadUnits);

  // ---- save ----
  $('beSaveBtn').addEventListener('click', async ()=>{
    const techId = $('beTech').value, custId = $('beCustomer').value;
    const date = $('beDate').value, services = beLines('beServices');
    if(!techId) return toast('Choose the technician who did the work');
    if(!custId) return toast('Choose the customer');
    const cards = beCards.map(c=> beCardEl(c.key)).filter(Boolean);
    const unitIds = cards.map(el=> el.querySelector('[data-be="unit"]').value);
    const missing = unitIds.findIndex(v=> !v);
    if(missing >= 0) return toast(beMulti ? 'Choose the unit for Unit ' + (missing + 1) : 'Choose the unit that was serviced');
    if(new Set(unitIds).size !== unitIds.length) return toast('The same unit was added twice');
    if(!date) return toast('Enter the date the work was performed');
    if(date > todayISO()) return toast('The date can\u2019t be in the future');
    if(!services.length) return toast('List the work that was done');
    if(!$('beConfirm').checked) return toast('Tick the confirmation box first');

    const cust = (customersCache || []).find(c=> c.id === custId) || {};
    const shared = {
      technician_id: techId, date,
      service_category: $('beCategory').value || DEFAULT_REPORT_CATEGORY,
      customer_id: custId, cust_name: cust.name || '', cust_address: cust.address || '',
      contact_no: cust.contactNo || '', contact_person: cust.contactPerson || '', cust_email: cust.email || '',
      trouble_call: $('beTrouble').value.trim(),
      time_in: $('beTimeIn').value, time_out: $('beTimeOut').value,
      services_done: services, findings: beLines('beFindings'), recommendations: beLines('beRecs'),
      materials: beLines('beParts').map(t=> ({ description: t, qty: '', unit: '' })),
      remarks: $('beRemarks').value.trim(),
      customer_printed_name: $('beCustRep').value.trim(),
      is_install: false
    };
    const reports = cards.map((el, i)=>{
      const u = beUnits.find(x=> x.id === unitIds[i]) || {};
      return Object.assign({}, shared, {
        equipment_id: u.id,
        equip_type: u.equipType || '', equip_location: u.equipLocation || '', brand: u.brand || '',
        mount_type: u.mountType || '', cool_cap: u.coolCap || '', model_cu: u.modelCU || '', serial_cu: u.serialCU || '',
        model_fcu: u.modelFCU || '', serial_fcu: u.serialFCU || '', refrigerant_type: u.refrigerantType || '',
        compressor_type: u.compressorType || '',
        before_data: beReadOp(el, 'b'), after_data: beReadOp(el, 'a')
      });
    });

    const btn = $('beSaveBtn');
    const label = btn.textContent;
    btn.disabled = true; btn.textContent = 'Saving…';
    try{
      if(!(await ensureCloud())) throw new Error('offline');
      // One transaction for every unit: all saved, or none.
      const { data: srNos, error } = await db.rpc('admin_record_past_services', { p_reports: reports });
      if(error) throw error;
      toast(srNos.length === 1 ? 'Saved as ' + srNos[0] : srNos.length + ' reports saved (' + srNos[0] + ' – ' + srNos[srNos.length - 1] + ')');
      // Clear the form, keep technician/customer (often recording several visits in a row).
      ['beTrouble','beServices','beFindings','beRecs','beParts','beRemarks','beCustRep','beTimeIn','beTimeOut','beDate'].forEach(id=> $(id).value = '');
      $('beConfirm').checked = false;
      $('beUnitList').innerHTML = ''; beCards = [];
      beSetMode(beMulti);
      // Show what was filed, in the PDF viewer (Download / Share there).
      const rows = (await Promise.all(srNos.map(sr=> cloudGetReport(sr)))).filter(Boolean);
      if(rows.length === 1){
        await openFileInPdfViewer(await buildPdf(rows[0]), rows[0].srNo + '.pdf', rows[0].custName || rows[0].srNo);
      }else if(rows.length > 1){
        const docs = [];
        for(const d of rows) docs.push({ doc: await buildPdf(d), label: d.srNo + ' · ' + (d.equipLocation || d.equipType || ''), filename: d.srNo + '.pdf' });
        $('previewOverlay').querySelector('h3').textContent = (rows[0].custName || 'Reports') + ' — ' + rows.length + ' units';
        $('previewOkBtn').textContent = 'Close';
        $('previewOverlay').style.zIndex = '99';
        $('previewOverlay').classList.add('open');
        setPreviewZoom(1);
        await renderPdfPreviewMulti(docs);
      }
    }catch(e){
      console.error('record past service failed', describeCloudError(e));
      const msg = (e && e.message) || '';
      toast(msg === 'offline' ? 'You\u2019re offline — this needs a connection to save'
        : /future|Choose|unit|date|twice|at most/i.test(msg) ? msg : 'Could not save — ' + (msg || 'please try again'));
    }finally{
      btn.disabled = false;
      if(btn.textContent === 'Saving…') btn.textContent = label;
      beRefreshUnitSelects();
    }
  });
