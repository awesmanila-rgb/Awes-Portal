// ---------- Record Past Service (admin back-entry) ----------
  // Admin can't author a normal Service Report (it carries the technician's
  // name and signature — see setVis('srTabNewBtn', isTech) in auth.js). This
  // is the honest alternative: record work a technician already performed,
  // filed under that technician, with both signatures left blank and the
  // record stamped with who keyed it in (admin_record_past_service RPC,
  // supabase/migrations/20260924_02_report_back_entry.sql). It shows in the
  // report lists and in that unit's equipment history like any report.
  let beUnits = [];
  let beLoaded = false;

  function beLines(id){
    return String($(id).value || '').split(/\r?\n/).map(x=> x.trim()).filter(Boolean);
  }
  function beReset(){
    ['beTrouble','beServices','beFindings','beRecs','beParts','beRemarks','beCustRep','beTimeIn','beTimeOut'].forEach(id=> $(id).value = '');
    $('beDate').value = '';
    $('beConfirm').checked = false;
  }
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
    if(keepCust){ $('beCustomer').value = keepCust; }
    beLoaded = true;
  }
  async function beLoadUnits(){
    const custId = $('beCustomer').value;
    const sel = $('beUnit');
    beUnits = [];
    $('beUnitHint').textContent = '';
    if(!custId){ sel.disabled = true; sel.innerHTML = '<option value="">Choose a customer first…</option>'; return; }
    sel.disabled = true; sel.innerHTML = '<option value="">Loading units…</option>';
    try{
      const { data, error } = await db.from('customer_equipment').select('*').eq('customer_id', custId);
      if(error) throw error;
      beUnits = (data || []).map(equipRowToObj);
    }catch(e){ console.error('load units failed', describeCloudError(e)); toast('Could not load this customer\u2019s units'); }
    if(!beUnits.length){
      sel.innerHTML = '<option value="">No units on file</option>';
      $('beUnitHint').textContent = 'Add the unit under Equipment first, then come back to record the visit.';
      return;
    }
    sel.innerHTML = '<option value="">Select unit…</option>' + beUnits.map(u=>{
      const bits = [equipDisplayName(u), u.equipType, u.brand, u.coolCap].map(x=> String(x || '').trim()).filter(Boolean);
      return '<option value="'+escapeHtml(u.id)+'">'+escapeHtml(bits.join(' · '))+'</option>';
    }).join('');
    sel.disabled = false;
  }
  async function beOpen(){
    if(!beLoaded) beReset();
    try{ await beLoadPickers(); }
    catch(e){ console.error('record past service: load failed', e); toast('Could not load technicians/customers'); }
  }
  $('beCustomer').addEventListener('change', beLoadUnits);

  $('beSaveBtn').addEventListener('click', async ()=>{
    const techId = $('beTech').value, custId = $('beCustomer').value, unitId = $('beUnit').value;
    const date = $('beDate').value, services = beLines('beServices');
    if(!techId) return toast('Choose the technician who did the work');
    if(!custId) return toast('Choose the customer');
    if(!unitId) return toast('Choose the unit that was serviced');
    if(!date) return toast('Enter the date the work was performed');
    if(date > todayISO()) return toast('The date can\u2019t be in the future');
    if(!services.length) return toast('List the work that was done');
    if(!$('beConfirm').checked) return toast('Tick the confirmation box first');
    const cust = (customersCache || []).find(c=> c.id === custId) || {};
    const u = beUnits.find(x=> x.id === unitId) || {};
    const payload = {
      technician_id: techId, date,
      service_category: $('beCategory').value || DEFAULT_REPORT_CATEGORY,
      customer_id: custId, cust_name: cust.name || '', cust_address: cust.address || '',
      contact_no: cust.contactNo || '', contact_person: cust.contactPerson || '', cust_email: cust.email || '',
      equipment_id: unitId,
      equip_type: u.equipType || '', equip_location: u.equipLocation || '', brand: u.brand || '',
      mount_type: u.mountType || '', cool_cap: u.coolCap || '', model_cu: u.modelCU || '', serial_cu: u.serialCU || '',
      model_fcu: u.modelFCU || '', serial_fcu: u.serialFCU || '', refrigerant_type: u.refrigerantType || '',
      compressor_type: u.compressorType || '',
      trouble_call: $('beTrouble').value.trim(),
      time_in: $('beTimeIn').value, time_out: $('beTimeOut').value,
      services_done: services, findings: beLines('beFindings'), recommendations: beLines('beRecs'),
      materials: beLines('beParts').map(t=> ({ description: t, qty: '', unit: '' })),
      remarks: $('beRemarks').value.trim(),
      customer_printed_name: $('beCustRep').value.trim(),
      is_install: false
    };
    const btn = $('beSaveBtn');
    btn.disabled = true; btn.textContent = 'Saving…';
    try{
      if(!(await ensureCloud())) throw new Error('offline');
      const { data: srNo, error } = await db.rpc('admin_record_past_service', { p_report: payload });
      if(error) throw error;
      toast('Saved as ' + srNo);
      beReset();
      beLoaded = false;
      // Show the filed report straight away, in the PDF viewer.
      const d = await cloudGetReport(srNo);
      if(d){
        const doc = await buildPdf(d);
        await openFileInPdfViewer(doc, srNo + '.pdf', d.custName || srNo);
      }
    }catch(e){
      console.error('record past service failed', describeCloudError(e));
      const msg = (e && e.message) || '';
      toast(msg === 'offline' ? 'You\u2019re offline — this needs a connection to save'
        : /P0001|future|Choose|unit|date/i.test(msg) ? msg : 'Could not save — ' + (msg || 'please try again'));
    }finally{
      btn.disabled = false; btn.textContent = 'Save Past Service Report';
    }
  });
