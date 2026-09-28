  // =====================================================================
  // Payroll — Phase 1 (migration 20261004_01_payroll_foundation.sql)
  //
  //   Payroll Setup  (HR › Payroll Setup, module hr.payroll_setup)
  //       Employees        pay setup per technician / office staff, their
  //                        government IDs (Edit access only) and rate history
  //       Holidays         regular / special days, fixed-date pre-fill
  //       Company Settings defaults used when pay runs are built (Phase 3)
  //
  //   Payroll Rules  (Finance › Payroll Rules, module fin.payroll_rules)
  //       SSS / PhilHealth / Pag-IBIG / BIR / Labor premiums.
  //       New version (a draft copy) → edit → publish. Published versions
  //       are frozen by the database; every change is in the audit trail.
  //
  // Both open as panels of #purchasingView (paySetup / payRules), so the
  // shared page switching, sidebar highlight and staff gating apply. The
  // database is the authority on every read and write.
  // =====================================================================

  const PAY_MIGRATION_MSG = 'Payroll isn\u2019t set up in the database yet \u2014 run migration <b>20261004_01_payroll_foundation.sql</b> in Supabase first.';
  const PAY_FREQ = { WEEKLY:'Weekly', BI_WEEKLY:'Every 2 weeks', SEMI_MONTHLY:'Twice a month (15th / end)', MONTHLY:'Monthly' };
  const PAY_RATE_TYPE = { DAILY:'Daily rate', MONTHLY:'Monthly salary', HOURLY:'Hourly rate' };
  const PAY_EMP_STATUS = { regular:'Regular', probationary:'Probationary', contractual:'Contractual', project:'Project-based', part_time:'Part-time' };
  const PAY_PAYOUT = { cash:'Cash', bank:'Bank transfer', gcash:'GCash', maya:'Maya' };
  const PAY_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const PAY_HOL_KIND = { REGULAR:'Regular holiday', SPECIAL_NON_WORKING:'Special non-working day', SPECIAL_WORKING:'Special working day' };
  const PAY_TIMING = { SPLIT_EQUAL:'Split equally across the cutoffs', FIRST_CUTOFF:'All on the first cutoff', LAST_CUTOFF:'All on the last cutoff' };
  const PAY_KINDS = [
    { k:'sss',        name:'SSS',         sub:'Social Security System contributions' },
    { k:'philhealth', name:'PhilHealth',  sub:'Health insurance premium' },
    { k:'pagibig',    name:'Pag-IBIG',    sub:'HDMF contributions' },
    { k:'bir',        name:'BIR Withholding Tax', sub:'Tax table, de minimis and the 13th-month cap' },
    { k:'labor',      name:'Labor Premiums', sub:'Overtime, holiday, rest day and night differential' }
  ];
  const PAY_EARN_CATS = { BASIC:'Basic pay', OVERTIME:'Overtime', HOLIDAY_PAY:'Holiday / rest day pay', NIGHT_DIFFERENTIAL:'Night differential', HAZARD_PAY:'Hazard pay' };
  const PAY_CAP_COVERS = { THIRTEENTH_MONTH:'13th month pay', BONUS:'Bonuses', OTHER_BENEFITS:'Other benefits' };
  const PAY_DM_PERIODS = ['DAY', 'MONTH', 'SEMESTER', 'YEAR'];

  const pay = {
    people:[], emp:new Map(), ids:new Map(), settings:null, loaded:false,
    tab:'employees', editing:null,
    year: Number(new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 4)), holidays:[],
    rules:[], audit:[], rule:null, cfg:null
  };

  const payEsc = (v)=> escapeHtml(v == null ? '' : String(v));
  const payToday = ()=> new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
  const payNum = (v)=>{ const n = Number(String(v == null ? '' : v).replace(/[,\u20B1\s]/g, '')); return Number.isFinite(n) ? n : NaN; };
  const payTidy = (n)=> Number(Number(n).toPrecision(12));
  const payPct = (f)=> f == null || f === '' ? '' : String(payTidy(Number(f) * 100));
  const payFromPct = (v)=>{ const n = payNum(v); return Number.isFinite(n) ? payTidy(n / 100) : NaN; };
  function payPeso(n){ return '\u20B1' + Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits:2, maximumFractionDigits:2 }); }
  function payDate(d){
    if(!d) return '';
    try{ return new Date(d + 'T00:00:00+08:00').toLocaleDateString('en-PH', { timeZone:'Asia/Manila', month:'short', day:'numeric', year:'numeric' }); }catch(e){ return d; }
  }
  function payWhen(ts){
    try{ return new Date(ts).toLocaleString('en-PH', { timeZone:'Asia/Manila', month:'short', day:'numeric', year:'numeric', hour:'numeric', minute:'2-digit' }); }catch(e){ return ''; }
  }
  function payMissing(e){
    const s = String((e && (e.message || '')) + ' ' + (e && e.code || ''));
    return /PGRST20[25]|42P01|42883/.test(s) || (/payroll_/.test(s) && /does not exist|schema cache|could not find/i.test(s));
  }
  function payErrHtml(prefix, e){
    if(typeof purchIsAuthError === 'function' && purchIsAuthError(e)) return PURCH_EXPIRED_HTML;
    return payMissing(e) ? PAY_MIGRATION_MSG : payEsc(prefix + describeCloudError(e));
  }
  // readable message from a database refusal
  function payDbMsg(e){
    const m = String((e && e.message) || '');
    if(/payroll_employees_no_uq|duplicate key/.test(m)) return 'That employee number is already used by someone else.';
    if(/payroll_employees_check/.test(m)) return 'A minimum wage earner needs the regional minimum daily wage.';
    if(/row-level security|permission denied/i.test(m)) return 'You don\u2019t have Edit access for this.';
    return describeCloudError(e);
  }
  const payCanSetup = ()=> can('hr.payroll_setup', 'edit');
  const payCanRules = ()=> can('fin.payroll_rules', 'edit');
  const payCanPublish = ()=> can('fin.payroll_rules', 'approve');

  function payOnShow(key){
    $('purchasingView').classList.add('po-wide');
    if(key === 'paySetup') paySetupShow();
    else if(key === 'payRules') payRulesShow();
  }

  // =====================================================================
  // Payroll Setup
  // =====================================================================
  function paySetupShow(){
    document.body.classList.toggle('pay-ro', !payCanSetup());
    paySetTab(pay.tab || 'employees');
  }
  function paySetTab(tab){
    pay.tab = tab;
    $$('#paySetupTabs [data-pay-tab]').forEach(b=> b.classList.toggle('active', b.dataset.payTab === tab));
    ['employees', 'holidays', 'settings'].forEach(t=>{ $('payTab_' + t).style.display = t === tab ? '' : 'none'; });
    if(tab === 'employees'){ payShowEmpList(); payLoadEmployees(); }
    if(tab === 'holidays') payLoadHolidays();
    if(tab === 'settings') payLoadSettings();
  }
  $('paySetupTabs').addEventListener('click', (e)=>{
    const b = e.target.closest('[data-pay-tab]');
    if(b) paySetTab(b.dataset.payTab);
  });

  // ---------------- Employees ----------------
  async function payLoadEmployees(){
    const list = $('payEmpList');
    list.innerHTML = '<div class="empty-state">Loading\u2026</div>';
    if(!(await ensureCloud())){ list.innerHTML = '<div class="empty-state">Not connected.</div>'; return; }
    try{
      const [pp, ee, ids, st] = await Promise.all([
        db.from('profiles').select('id, name, role, position, active, username').in('role', ['technician', 'staff']).order('name'),
        db.from('payroll_employees').select('*'),
        payCanSetup() ? db.from('payroll_gov_ids').select('*') : Promise.resolve({ data:[] }),
        db.from('payroll_settings').select('*').maybeSingle()
      ]);
      for(const r of [pp, ee, ids, st]) if(r.error) throw r.error;
      pay.people = pp.data || [];
      pay.emp = new Map((ee.data || []).map(r=> [r.profile_id, r]));
      pay.ids = new Map((ids.data || []).map(r=> [r.profile_id, r]));
      pay.settings = st.data || null;
      pay.loaded = true;
      payRenderEmpList();
    }catch(e){
      list.innerHTML = '<div class="empty-state">' + payErrHtml('Couldn\u2019t load employees: ', e) + '</div>';
    }
  }
  function payRenderEmpList(){
    const list = $('payEmpList');
    const q = ($('payEmpSearch').value || '').trim().toLowerCase();
    const f = $('payEmpFilter').value;
    const rows = pay.people.filter(p=>{
      const e = pay.emp.get(p.id);
      if(f === 'missing' && (e || !p.active)) return false;
      if(f === 'set' && !(e && e.is_active)) return false;
      if(f === 'inactive' && !(e && !e.is_active) && p.active) return false;
      if(!f && !p.active && !e) return false;
      if(!q) return true;
      return [p.name, p.username, p.position, e && e.employee_no].some(v=> String(v || '').toLowerCase().includes(q));
    });
    const setUp = pay.people.filter(p=> pay.emp.has(p.id) && pay.emp.get(p.id).is_active).length;
    const missing = pay.people.filter(p=> p.active && !pay.emp.has(p.id)).length;
    $('payEmpCount').textContent = setUp + ' on payroll' + (missing ? ' \u00B7 ' + missing + ' not set up' : '');
    if(!rows.length){ list.innerHTML = '<div class="empty-state">' + (pay.people.length ? 'Nobody matches.' : 'No technicians or office staff yet.') + '</div>'; return; }
    list.innerHTML = rows.map(p=>{
      const e = pay.emp.get(p.id);
      const role = p.role === 'technician' ? 'Technician' : (p.position || 'Office staff');
      let tag, rate = '';
      if(!e) tag = '<span class="sp-tag warn">Not set up</span>';
      else if(!e.is_active) tag = '<span class="sp-tag muted">Off payroll</span>';
      else tag = '<span class="sp-tag">' + payEsc(PAY_FREQ[e.pay_frequency] ? PAY_FREQ[e.pay_frequency].split(' (')[0] : e.pay_frequency) + '</span>';
      if(e) rate = '<div class="mt-row-price">' + payPeso(e.base_rate) + '<div class="sp-row-sub">' + ({ MONTHLY:'per month', DAILY:'per day', HOURLY:'per hour' }[e.rate_type] || '') + '</div></div>';
      return '<div class="sp-row' + (p.active ? '' : ' inactive') + '" data-id="' + payEsc(p.id) + '"' + (p.active ? '' : ' style="opacity:.6;"') + '><div class="sp-row-top"><div style="min-width:0;">' +
        '<div class="sp-row-title">' + (e && e.employee_no ? '<span class="mt-code">' + payEsc(e.employee_no) + '</span> ' : '') + payEsc(p.name || '') + ' ' + tag +
          (p.active ? '' : ' <span class="sp-tag danger">Account deactivated</span>') + '</div>' +
        '<div class="sp-row-sub">' + payEsc(role) + (e && e.is_mwe ? ' \u00B7 Minimum wage earner' : '') + (e ? ' \u00B7 ' + payEsc(PAY_PAYOUT[e.payout_method] || e.payout_method) : '') + '</div></div>' +
        rate + '</div>' +
        '<div class="user-card-actions"><button type="button" class="primary" data-pay-edit="1">' + (payCanSetup() ? (e ? 'Edit' : 'Set up pay') : 'View') + '</button></div></div>';
    }).join('');
  }
  $('payEmpSearch').addEventListener('input', ()=>{ if(pay.loaded) payRenderEmpList(); });
  $('payEmpFilter').addEventListener('change', ()=>{ if(pay.loaded) payRenderEmpList(); });
  $('payEmpList').addEventListener('click', (e)=>{
    if(e.target.closest('[data-purch-reauth]')){ purchReauth().then(ok=>{ if(ok) payLoadEmployees(); }); return; }
    const row = e.target.closest('.sp-row');
    if(row && e.target.closest('[data-pay-edit]')) payOpenEmp(row.dataset.id);
  });

  function payShowEmpList(){ $('payEmpEditView').style.display = 'none'; $('payEmpListView').style.display = ''; pay.editing = null; }

  function payEmpDefaults(){
    const s = pay.settings || {};
    return { employee_no:'', employment_status:'regular', hire_date:null, rate_type:'DAILY', base_rate:0,
      pay_frequency: s.default_pay_frequency || 'SEMI_MONTHLY', working_days_per_year: Number(s.default_working_days || 313),
      hours_per_day: Number(s.default_hours_per_day || 8), shift_start:'08:00', shift_end:'17:00', break_minutes:60, rest_days:[0],
      is_mwe:false, regional_min_daily_wage:null, sss_enabled:true, philhealth_enabled:true, pagibig_enabled:true, tax_enabled:true,
      payout_method:'cash', payout_bank:'', payout_account_name:'', payout_account_no:'', is_active:true, notes:'' };
  }
  const payOpts = (map, val)=> Object.keys(map).map(k=> '<option value="' + payEsc(k) + '"' + (String(k) === String(val) ? ' selected' : '') + '>' + payEsc(map[k]) + '</option>').join('');
  const payT = (t)=> t ? String(t).slice(0, 5) : '';
  const payField = (cls, label, inner, hint)=> '<div class="field ' + cls + '"><label>' + label + '</label>' + inner + (hint ? '<div class="pay-hint">' + hint + '</div>' : '') + '</div>';

  async function payOpenEmp(id){
    const p = pay.people.find(x=> x.id === id);
    if(!p) return;
    const existing = pay.emp.get(id);
    const e = Object.assign(payEmpDefaults(), existing || {});
    const g = pay.ids.get(id) || { tin:'', sss_no:'', philhealth_no:'', pagibig_no:'' };
    const ro = !payCanSetup();
    const dis = ro ? ' disabled' : '';
    pay.editing = { id, isNew: !existing };
    $('payEmpListView').style.display = 'none';
    $('payEmpEditView').style.display = '';
    $('payEmpTitle').textContent = (existing ? '' : 'Set up pay \u2014 ') + (p.name || '');
    const rest = new Set((e.rest_days || []).map(Number));
    $('payEmpForm').innerHTML =
      '<div class="po-sec"><div class="po-sec-title">Employment</div><div class="po-grid">' +
        payField('po-c3', 'Employee no.', '<input type="text" id="payE_no" value="' + payEsc(e.employee_no || '') + '" placeholder="e.g. AWES-014"' + dis + '>') +
        payField('po-c3', 'Status', '<select id="payE_status"' + dis + '>' + payOpts(PAY_EMP_STATUS, e.employment_status) + '</select>') +
        payField('po-c3', 'Date hired', '<input type="date" id="payE_hire" value="' + payEsc(e.hire_date || '') + '"' + dis + '>') +
        payField('po-c3', 'On payroll', '<select id="payE_active"' + dis + '><option value="true"' + (e.is_active ? ' selected' : '') + '>Yes</option><option value="false"' + (e.is_active ? '' : ' selected') + '>No \u2014 leave out of pay runs</option></select>') +
      '</div></div>' +
      '<div class="po-sec"><div class="po-sec-title">Pay</div><div class="po-grid">' +
        payField('po-c3', 'Rate type <span class="req">*</span>', '<select id="payE_rateType"' + dis + '>' + payOpts(PAY_RATE_TYPE, e.rate_type) + '</select>') +
        payField('po-c3', 'Rate (\u20B1) <span class="req">*</span>', '<input type="text" inputmode="decimal" id="payE_rate" value="' + payEsc(e.base_rate || '') + '" placeholder="0.00"' + dis + '>') +
        payField('po-c6', 'Paid', '<select id="payE_freq"' + dis + '>' + payOpts(PAY_FREQ, e.pay_frequency) + '</select>') +
        payField('po-c3', 'Working days a year', '<input type="text" inputmode="decimal" id="payE_days" list="payDaysList" value="' + payEsc(e.working_days_per_year) + '"' + dis + '>',
          '313 = 6-day week, 261 = 5-day week, 365 = paid every day') +
        payField('po-c3', 'Hours a day', '<input type="text" inputmode="decimal" id="payE_hours" value="' + payEsc(e.hours_per_day) + '"' + dis + '>') +
        payField('po-c6', 'Works out to', '<div class="pay-derived" id="payE_derived"></div>') +
      '</div></div>' +
      '<div class="po-sec"><div class="po-sec-title">Schedule</div><div class="po-grid">' +
        payField('po-c3', 'Shift starts', '<input type="time" id="payE_shiftStart" value="' + payEsc(payT(e.shift_start)) + '"' + dis + '>') +
        payField('po-c3', 'Shift ends', '<input type="time" id="payE_shiftEnd" value="' + payEsc(payT(e.shift_end)) + '"' + dis + '>') +
        payField('po-c3', 'Unpaid break (minutes)', '<input type="text" inputmode="numeric" id="payE_break" value="' + payEsc(e.break_minutes) + '"' + dis + '>') +
        payField('po-c12', 'Rest days', '<div class="pay-checks" id="payE_rest">' + PAY_DAYS.map((d, i)=>
          '<label class="pay-chk"><input type="checkbox" data-rest="' + i + '"' + (rest.has(i) ? ' checked' : '') + dis + '> ' + d + '</label>').join('') + '</div>',
          'Used later to tell rest-day work from ordinary days, and to measure lates against the shift.') +
      '</div></div>' +
      '<div class="po-sec"><div class="po-sec-title">Government contributions &amp; tax</div><div class="po-grid">' +
        payField('po-c12', '', '<div class="pay-checks">' +
          '<label class="pay-chk"><input type="checkbox" id="payE_sss"' + (e.sss_enabled ? ' checked' : '') + dis + '> SSS</label>' +
          '<label class="pay-chk"><input type="checkbox" id="payE_ph"' + (e.philhealth_enabled ? ' checked' : '') + dis + '> PhilHealth</label>' +
          '<label class="pay-chk"><input type="checkbox" id="payE_pag"' + (e.pagibig_enabled ? ' checked' : '') + dis + '> Pag-IBIG</label>' +
          '<label class="pay-chk"><input type="checkbox" id="payE_tax"' + (e.tax_enabled ? ' checked' : '') + dis + '> Withholding tax</label></div>') +
        payField('po-c6', 'Minimum wage earner', '<select id="payE_mwe"' + dis + '><option value="false">No</option><option value="true"' + (e.is_mwe ? ' selected' : '') + '>Yes \u2014 basic, OT, holiday &amp; night pay are tax-exempt</option></select>') +
        payField('po-c6', 'Regional minimum daily wage (\u20B1)', '<input type="text" inputmode="decimal" id="payE_minWage" value="' + payEsc(e.regional_min_daily_wage || '') + '" placeholder="e.g. 695.00"' + dis + '>',
          'Needed for minimum wage earners and for the overtime meal allowance limit.') +
      '</div></div>' +
      '<div class="po-sec"><div class="po-sec-title">Salary payout</div><div class="po-grid">' +
        payField('po-c3', 'Paid by', '<select id="payE_payout"' + dis + '>' + payOpts(PAY_PAYOUT, e.payout_method) + '</select>') +
        payField('po-c3', 'Bank / wallet', '<input type="text" id="payE_bank" value="' + payEsc(e.payout_bank) + '" placeholder="e.g. BDO"' + dis + '>') +
        payField('po-c3', 'Account name', '<input type="text" id="payE_accName" value="' + payEsc(e.payout_account_name) + '"' + dis + '>') +
        payField('po-c3', 'Account / mobile no.', '<input type="text" id="payE_accNo" value="' + payEsc(e.payout_account_no) + '"' + dis + '>') +
      '</div></div>' +
      (ro ? '' :
      '<div class="po-sec"><div class="po-sec-title">Government IDs</div><div class="po-grid">' +
        payField('po-c3', 'TIN', '<input type="text" id="payG_tin" value="' + payEsc(g.tin) + '" placeholder="000-000-000-000">') +
        payField('po-c3', 'SSS no.', '<input type="text" id="payG_sss" value="' + payEsc(g.sss_no) + '" placeholder="00-0000000-0">') +
        payField('po-c3', 'PhilHealth no.', '<input type="text" id="payG_ph" value="' + payEsc(g.philhealth_no) + '" placeholder="00-000000000-0">') +
        payField('po-c3', 'Pag-IBIG MID no.', '<input type="text" id="payG_pag" value="' + payEsc(g.pagibig_no) + '" placeholder="0000-0000-0000">') +
        '<div class="po-c12 pay-hint" id="payG_warn"></div>' +
      '</div></div>') +
      '<div class="po-sec"><div class="po-sec-title">Notes</div>' +
        '<div class="field"><textarea id="payE_notes" rows="2"' + dis + '>' + payEsc(e.notes) + '</textarea></div></div>';
    $('payEmpSave').style.display = ro ? 'none' : '';
    payEmpDerive();
    payIdWarn();
    window.scrollTo({ top:0 });
    payLoadHistory(id);
  }
  // same arithmetic the payroll engine uses (engine.ts), so what HR sees here is what pay runs will use
  function payEmpDerive(){
    const el = $('payE_derived'); if(!el) return;
    const rate = payNum($('payE_rate').value), days = payNum($('payE_days').value), hours = payNum($('payE_hours').value);
    const type = $('payE_rateType').value;
    if(!(rate > 0) || !(days > 0) || !(hours > 0)){ el.textContent = '\u2014'; return; }
    let monthly, daily, hourly;
    if(type === 'MONTHLY'){ monthly = rate; daily = rate * 12 / days; hourly = daily / hours; }
    else if(type === 'DAILY'){ daily = rate; monthly = rate * days / 12; hourly = rate / hours; }
    else { hourly = rate; daily = rate * hours; monthly = daily * days / 12; }
    el.innerHTML = '<b>' + payPeso(daily) + '</b>/day \u00B7 <b>' + payPeso(hourly) + '</b>/hour \u00B7 <b>' + payPeso(monthly) + '</b>/month equivalent';
    const mwe = $('payE_mwe').value === 'true', min = payNum($('payE_minWage').value);
    if(min > 0 && daily + 0.005 < min) el.innerHTML += '<div class="pay-warn">Below the regional minimum daily wage you entered (' + payPeso(min) + ').</div>';
    else if(mwe && min > 0 && daily > min + 0.005) el.innerHTML += '<div class="pay-warn">Marked as minimum wage earner but paid above the minimum \u2014 check the tax exemption.</div>';
  }
  function payIdWarn(){
    const el = $('payG_warn'); if(!el) return;
    const d = (id)=> ($(id).value || '').replace(/\D/g, '').length;
    const w = [];
    if($('payG_tin').value && ![9, 12, 13].includes(d('payG_tin'))) w.push('TIN is usually 9 or 12 digits');
    if($('payG_sss').value && d('payG_sss') !== 10) w.push('SSS no. is 10 digits');
    if($('payG_ph').value && d('payG_ph') !== 12) w.push('PhilHealth no. is 12 digits');
    if($('payG_pag').value && d('payG_pag') !== 12) w.push('Pag-IBIG MID no. is 12 digits');
    el.innerHTML = w.length ? '<span class="pay-warn">Check: ' + payEsc(w.join(' \u00B7 ')) + '.</span>' : 'Only people with Payroll Setup \u203A Edit can see these numbers. The employee can see their own.';
  }
  $('payEmpForm').addEventListener('input', (e)=>{
    if(/^payE_(rate|days|hours|minWage)$/.test(e.target.id)) payEmpDerive();
    if(/^payG_/.test(e.target.id)) payIdWarn();
  });
  $('payEmpForm').addEventListener('change', (e)=>{ if(/^payE_(rateType|mwe)$/.test(e.target.id)) payEmpDerive(); });

  async function payLoadHistory(id){
    const el = $('payEmpHistory');
    el.innerHTML = '<div class="empty-state">Loading\u2026</div>';
    try{
      const { data, error } = await db.from('payroll_rate_history').select('*').eq('profile_id', id).order('changed_at', { ascending:false }).limit(30);
      if(error) throw error;
      if(!data || !data.length){ el.innerHTML = '<div class="empty-state">No rate recorded yet.</div>'; return; }
      el.innerHTML = '<div class="pay-table-wrap"><table class="pay-table"><thead><tr><th>Changed</th><th>Rate type</th><th class="num">Rate</th><th>By</th></tr></thead><tbody>' +
        data.map(r=> '<tr><td>' + payEsc(payWhen(r.changed_at)) + '</td><td>' + payEsc(PAY_RATE_TYPE[r.rate_type] || r.rate_type) + '</td><td class="num">' + payPeso(r.base_rate) + '</td><td>' + payEsc(r.changed_by_name || '\u2014') + '</td></tr>').join('') +
        '</tbody></table></div>';
    }catch(e){ el.innerHTML = '<div class="empty-state">' + payErrHtml('Couldn\u2019t load rate history: ', e) + '</div>'; }
  }

  $('payEmpBack').addEventListener('click', payShowEmpList);
  $('payEmpCancel').addEventListener('click', payShowEmpList);
  $('payEmpSave').addEventListener('click', async ()=>{
    if(!pay.editing || !payCanSetup()) return;
    const id = pay.editing.id;
    const rest = $$('#payE_rest [data-rest]').filter(c=> c.checked).map(c=> Number(c.dataset.rest));
    const row = {
      profile_id: id,
      employee_no: $('payE_no').value.trim() || null,
      employment_status: $('payE_status').value,
      hire_date: $('payE_hire').value || null,
      is_active: $('payE_active').value === 'true',
      rate_type: $('payE_rateType').value,
      base_rate: payNum($('payE_rate').value),
      pay_frequency: $('payE_freq').value,
      working_days_per_year: payNum($('payE_days').value),
      hours_per_day: payNum($('payE_hours').value),
      shift_start: $('payE_shiftStart').value || '08:00',
      shift_end: $('payE_shiftEnd').value || '17:00',
      break_minutes: Math.round(payNum($('payE_break').value || 0)),
      rest_days: rest,
      sss_enabled: $('payE_sss').checked, philhealth_enabled: $('payE_ph').checked,
      pagibig_enabled: $('payE_pag').checked, tax_enabled: $('payE_tax').checked,
      is_mwe: $('payE_mwe').value === 'true',
      regional_min_daily_wage: $('payE_minWage').value.trim() ? payNum($('payE_minWage').value) : null,
      payout_method: $('payE_payout').value,
      payout_bank: $('payE_bank').value.trim(), payout_account_name: $('payE_accName').value.trim(), payout_account_no: $('payE_accNo').value.trim(),
      notes: $('payE_notes').value.trim()
    };
    if(!(row.base_rate > 0) && row.is_active){ toast('Enter the rate'); $('payE_rate').focus(); return; }
    if(!Number.isFinite(row.base_rate) || row.base_rate < 0){ toast('The rate must be a number'); return; }
    if(!(row.working_days_per_year > 0 && row.working_days_per_year <= 366)){ toast('Working days a year must be between 1 and 366'); return; }
    if(!(row.hours_per_day > 0 && row.hours_per_day <= 24)){ toast('Hours a day must be between 1 and 24'); return; }
    if(!(row.break_minutes >= 0 && row.break_minutes <= 240)){ toast('Break must be 0 to 240 minutes'); return; }
    if(row.is_mwe && !(row.regional_min_daily_wage > 0)){ toast('Enter the regional minimum daily wage for a minimum wage earner'); $('payE_minWage').focus(); return; }
    if(row.regional_min_daily_wage != null && !(row.regional_min_daily_wage > 0)){ toast('The regional minimum wage must be a number'); return; }
    const old = pay.emp.get(id);
    if(old && (old.base_rate != row.base_rate || old.rate_type !== row.rate_type)){
      if(!await uiConfirm('Save the new rate?\n\n' + payPeso(old.base_rate) + ' (' + (PAY_RATE_TYPE[old.rate_type] || '') + ') \u2192 ' + payPeso(row.base_rate) + ' (' + (PAY_RATE_TYPE[row.rate_type] || '') + '). The change is kept in the rate history.')) return;
    }
    const btn = $('payEmpSave'); btn.disabled = true;
    try{
      const { error } = await db.from('payroll_employees').upsert(row, { onConflict:'profile_id' });
      if(error) throw error;
      const g = { profile_id:id, tin:$('payG_tin').value.trim(), sss_no:$('payG_sss').value.trim(), philhealth_no:$('payG_ph').value.trim(), pagibig_no:$('payG_pag').value.trim() };
      const og = pay.ids.get(id);
      const changed = og ? ['tin', 'sss_no', 'philhealth_no', 'pagibig_no'].some(k=> (og[k] || '') !== g[k]) : (g.tin || g.sss_no || g.philhealth_no || g.pagibig_no);
      if(changed){
        const r2 = await db.from('payroll_gov_ids').upsert(g, { onConflict:'profile_id' });
        if(r2.error) throw r2.error;
      }
      toast('Pay setup saved');
      await payLoadEmployees();
      payShowEmpList();
    }catch(e){
      if(typeof purchIsAuthError === 'function' && purchIsAuthError(e)){ purchReauth(); }
      else toast(payMissing(e) ? 'Run migration 20261004_01_payroll_foundation.sql first' : 'Couldn\u2019t save: ' + payDbMsg(e));
    }finally{ btn.disabled = false; }
  });

  // ---------------- Holidays ----------------
  async function payLoadHolidays(){
    const list = $('payHolList');
    const sel = $('payHolYear');
    if(!sel.options.length){
      const y = pay.year;
      sel.innerHTML = [y - 1, y, y + 1, y + 2].map(v=> '<option value="' + v + '"' + (v === y ? ' selected' : '') + '>' + v + '</option>').join('');
    }
    pay.year = Number(sel.value);
    $('payHolPrefill').textContent = 'Add fixed-date holidays for ' + pay.year;
    list.innerHTML = '<div class="empty-state">Loading\u2026</div>';
    if(!(await ensureCloud())){ list.innerHTML = '<div class="empty-state">Not connected.</div>'; return; }
    try{
      const { data, error } = await db.from('payroll_holidays').select('*')
        .gte('holiday_date', pay.year + '-01-01').lte('holiday_date', pay.year + '-12-31').order('holiday_date');
      if(error) throw error;
      pay.holidays = data || [];
      payRenderHolidays();
    }catch(e){ list.innerHTML = '<div class="empty-state">' + payErrHtml('Couldn\u2019t load holidays: ', e) + '</div>'; }
  }
  function payRenderHolidays(){
    const list = $('payHolList');
    const ro = !payCanSetup();
    if(!pay.holidays.length){
      list.innerHTML = '<div class="empty-state">No holidays for ' + pay.year + ' yet.' + (ro ? '' : ' Start with <b>Add fixed-date holidays</b>, then add the movable ones.') + '</div>';
      return;
    }
    const cls = { REGULAR:'', SPECIAL_NON_WORKING:'warn', SPECIAL_WORKING:'muted' };
    list.innerHTML = pay.holidays.map(h=>{
      const d = new Date(h.holiday_date + 'T00:00:00+08:00');
      const wd = d.toLocaleDateString('en-PH', { timeZone:'Asia/Manila', weekday:'short' });
      return '<div class="sp-row pay-hol" data-id="' + payEsc(h.id) + '"><div class="sp-row-top"><div style="min-width:0;">' +
        '<div class="sp-row-title"><span class="pay-hol-date">' + payEsc(payDate(h.holiday_date)) + ' \u00B7 ' + payEsc(wd) + '</span> ' + payEsc(h.name) + '</div>' +
        '<div class="sp-row-sub"><span class="sp-tag ' + (cls[h.kind] || '') + '">' + payEsc(PAY_HOL_KIND[h.kind] || h.kind) + '</span> ' +
          (h.scope && h.scope !== 'National' ? '<span class="sp-tag muted">' + payEsc(h.scope) + ' only</span> ' : '') + payEsc(h.notes || '') + '</div></div>' +
        (ro ? '' : '<div class="user-card-actions"><button type="button" data-hol-del="1">Remove</button></div>') + '</div></div>';
    }).join('');
  }
  $('payHolYear').addEventListener('change', payLoadHolidays);
  $('payHolPrefill').addEventListener('click', async ()=>{
    if(!payCanSetup()) return;
    if(!await uiConfirm('Add the fixed-date holidays for ' + pay.year + '?\n\nNew Year, Araw ng Kagitingan, Labor Day, Independence Day, Bonifacio Day, Christmas, Rizal Day, Ninoy Aquino Day, All Saints\u2019 Day, Immaculate Conception and the last day of the year. Dates already on the list are skipped.', { ok:'Add' })) return;
    try{
      const { data, error } = await db.rpc('payroll_holidays_prefill', { p_year: pay.year });
      if(error) throw error;
      toast((data || 0) + ' holiday' + (data === 1 ? '' : 's') + ' added \u2014 now add Holy Week, National Heroes Day, the Eids and any moved dates from this year\u2019s proclamation');
      payLoadHolidays();
    }catch(e){ toast(payMissing(e) ? 'Run migration 20261004_01_payroll_foundation.sql first' : 'Couldn\u2019t add: ' + payDbMsg(e)); }
  });
  $('payHolAdd').addEventListener('click', async ()=>{
    if(!payCanSetup()) return;
    const row = { holiday_date: $('payHolDate').value, name: $('payHolName').value.trim(), kind: $('payHolKind').value,
      scope: $('payHolScope').value.trim() || 'National', notes: $('payHolNotes').value.trim() };
    if(!row.holiday_date){ toast('Choose the date'); return; }
    if(!row.name){ toast('Enter the holiday\u2019s name'); return; }
    try{
      const { error } = await db.from('payroll_holidays').insert(row);
      if(error) throw error;
      $('payHolName').value = ''; $('payHolNotes').value = '';
      toast('Holiday added');
      const y = row.holiday_date.slice(0, 4);
      if(y !== String(pay.year) && [...$('payHolYear').options].some(o=> o.value === y)) $('payHolYear').value = y;
      payLoadHolidays();
    }catch(e){
      toast(/payroll_holidays_uq|duplicate/.test(String(e && e.message)) ? 'There\u2019s already a holiday on that date for that place' : 'Couldn\u2019t add: ' + payDbMsg(e));
    }
  });
  $('payHolList').addEventListener('click', async (e)=>{
    if(!e.target.closest('[data-hol-del]')) return;
    const h = pay.holidays.find(x=> x.id === e.target.closest('.sp-row').dataset.id);
    if(!h) return;
    if(!await uiConfirm('Remove ' + h.name + ' (' + payDate(h.holiday_date) + ') from the holidays?')) return;
    const { error } = await db.from('payroll_holidays').delete().eq('id', h.id);
    if(error){ toast('Couldn\u2019t remove: ' + payDbMsg(error)); return; }
    toast('Holiday removed');
    payLoadHolidays();
  });

  // ---------------- Company settings ----------------
  async function payLoadSettings(){
    const box = $('paySettingsForm');
    box.innerHTML = '<div class="empty-state">Loading\u2026</div>';
    if(!(await ensureCloud())){ box.innerHTML = '<div class="empty-state">Not connected.</div>'; return; }
    try{
      const { data, error } = await db.from('payroll_settings').select('*').maybeSingle();
      if(error) throw error;
      pay.settings = data;
      const s = data || {};
      const dis = payCanSetup() ? '' : ' disabled';
      box.innerHTML = '<div class="po-sec"><div class="po-sec-title">Defaults for new pay setups</div><div class="po-grid">' +
          payField('po-c6', 'Pay frequency', '<select id="payS_freq"' + dis + '>' + payOpts(PAY_FREQ, s.default_pay_frequency) + '</select>') +
          payField('po-c3', 'Working days a year', '<input type="text" inputmode="decimal" id="payS_days" list="payDaysList" value="' + payEsc(s.default_working_days) + '"' + dis + '>') +
          payField('po-c3', 'Hours a day', '<input type="text" inputmode="decimal" id="payS_hours" value="' + payEsc(s.default_hours_per_day) + '"' + dis + '>') +
        '</div></div>' +
        '<div class="po-sec"><div class="po-sec-title">Pay runs</div><div class="po-grid">' +
          payField('po-c6', 'SSS / PhilHealth / Pag-IBIG deducted', '<select id="payS_timing"' + dis + '>' + payOpts(PAY_TIMING, s.contribution_timing) + '</select>',
            'For people paid more than once a month.') +
          payField('po-c3', 'Minimum take-home pay (\u20B1)', '<input type="text" inputmode="decimal" id="payS_minNet" value="' + payEsc(s.minimum_net_pay) + '"' + dis + '>',
            'Loans and other deductions stop at this amount; the rest carries over.') +
          payField('po-c3', 'Grace period for lates (minutes)', '<input type="text" inputmode="numeric" id="payS_grace" value="' + payEsc(s.grace_minutes) + '"' + dis + '>') +
        '</div></div>' +
        (s.updated_at ? '<div class="pay-hint">Last changed ' + payEsc(payWhen(s.updated_at)) + '</div>' : '');
      $('paySettingsSave').style.display = payCanSetup() ? '' : 'none';
    }catch(e){ box.innerHTML = '<div class="empty-state">' + payErrHtml('Couldn\u2019t load settings: ', e) + '</div>'; }
  }
  $('paySettingsSave').addEventListener('click', async ()=>{
    if(!payCanSetup()) return;
    const row = { default_pay_frequency: $('payS_freq').value, default_working_days: payNum($('payS_days').value),
      default_hours_per_day: payNum($('payS_hours').value), contribution_timing: $('payS_timing').value,
      minimum_net_pay: payNum($('payS_minNet').value || 0), grace_minutes: Math.round(payNum($('payS_grace').value || 0)),
      updated_by: currentUser.id, updated_at: new Date().toISOString() };
    if(!(row.default_working_days > 0 && row.default_working_days <= 366)){ toast('Working days a year must be between 1 and 366'); return; }
    if(!(row.default_hours_per_day > 0 && row.default_hours_per_day <= 24)){ toast('Hours a day must be between 1 and 24'); return; }
    if(!(row.minimum_net_pay >= 0)){ toast('Minimum take-home pay must be 0 or more'); return; }
    if(!(row.grace_minutes >= 0 && row.grace_minutes <= 120)){ toast('Grace period must be 0 to 120 minutes'); return; }
    const { data, error } = await db.from('payroll_settings').update(row).eq('id', 1).select();
    if(error){ toast('Couldn\u2019t save: ' + payDbMsg(error)); return; }
    if(!data || !data.length){ toast('You don\u2019t have Edit access for this.'); return; }
    toast('Payroll settings saved');
    payLoadSettings();
  });

  // =====================================================================
  // Payroll Rules
  // =====================================================================
  async function payRulesShow(){
    pay.rule = null;
    const body = $('payRulesBody');
    body.innerHTML = '<div class="empty-state">Loading\u2026</div>';
    if(!(await ensureCloud())){ body.innerHTML = '<div class="empty-state">Not connected.</div>'; return; }
    try{
      const [r, a] = await Promise.all([
        db.from('payroll_rules').select('*').order('effective_from', { ascending:false }),
        db.from('payroll_rule_audit').select('id, rule_id, kind, action, actor_name, reason, at').order('at', { ascending:false }).limit(25)
      ]);
      if(r.error) throw r.error;
      pay.rules = r.data || [];
      pay.audit = a.error ? [] : (a.data || []);
      payRenderRules();
    }catch(e){ body.innerHTML = '<div class="empty-state">' + payErrHtml('Couldn\u2019t load payroll rules: ', e) + '</div>'; }
  }
  function payRuleSummary(kind, c){
    try{
      if(kind === 'sss'){
        const b = c.brackets || [];
        return 'Employee ' + payPct(c.employee_rate) + '% \u00B7 Employer ' + payPct(c.employer_rate) + '% \u00B7 MSC ' + payPeso(b[0] && b[0].msc).replace('.00', '') + '\u2013' + payPeso(b.length && b[b.length - 1].msc).replace('.00', '') + ' (' + b.length + ' brackets)';
      }
      if(kind === 'philhealth') return payPct(c.premium_rate) + '% shared ' + payPct(c.employee_split) + '/' + payPct(c.employer_split) + ' \u00B7 salary ' + payPeso(c.salary_floor).replace('.00', '') + '\u2013' + payPeso(c.salary_ceiling).replace('.00', '');
      if(kind === 'pagibig') return 'Employee ' + payPct(c.employee_rate) + '% \u00B7 Employer ' + payPct(c.employer_rate) + '% \u00B7 up to ' + payPeso(c.max_fund_salary).replace('.00', '') + ' salary';
      if(kind === 'bir') return (c.period === 'MONTHLY' ? 'Monthly' : c.period) + ' table, ' + (c.brackets || []).length + ' brackets \u00B7 13th month / benefits cap ' + payPeso(c.other_benefits_cap && c.other_benefits_cap.annual_amount).replace('.00', '') + ' \u00B7 ' + Object.keys(c.de_minimis || {}).length + ' de minimis benefits';
      if(kind === 'labor'){
        const ot = c.premiums && c.premiums.OT_REGULAR;
        return 'OT ' + (ot ? payPct(ot.multiplier) + '%' : '\u2014') + ' \u00B7 night differential ' + payPct(c.night_differential && c.night_differential.rate) + '% \u00B7 ' + Object.keys(c.premiums || {}).length + ' premiums';
      }
    }catch(e){}
    return '';
  }
  function payRenderRules(){
    const body = $('payRulesBody');
    const today = payToday();
    const pending = PAY_KINDS.filter(K=> !pay.rules.some(r=> r.kind === K.k && r.published_at));
    let html = pending.length ?
      '<div class="pay-banner warn"><b>Not ready for pay runs yet.</b> Publish ' + payEsc(pending.map(K=> K.name).join(', ')) +
      '. The first versions were filled in from the 2026 rates as a starting point \u2014 have your accountant check every figure before publishing.</div>' :
      '<div class="pay-banner">All five rules are published. Pay runs use the version in force on each pay date; published versions never change.</div>';
    html += PAY_KINDS.map(K=>{
      const mine = pay.rules.filter(r=> r.kind === K.k);
      const pub = mine.filter(r=> r.published_at);
      const current = pub.find(r=> r.effective_from <= today && (!r.effective_to || r.effective_to >= today));
      const upcoming = pub.filter(r=> r.effective_from > today).sort((a, b)=> a.effective_from.localeCompare(b.effective_from));
      const draft = mine.find(r=> !r.published_at);
      const past = pub.filter(r=> r !== current && !upcoming.includes(r));
      const line = (r, label, cls)=> '<div class="pay-ver ' + (cls || '') + '" data-rule="' + payEsc(r.id) + '"><div style="min-width:0;"><div class="pay-ver-top"><span class="sp-tag ' + (cls === 'draft' ? 'warn' : cls === 'past' ? 'muted' : '') + '">' + label + '</span> <b>' + payEsc(r.version_label || 'Draft') + '</b> \u00B7 from ' + payEsc(payDate(r.effective_from)) +
        (r.effective_to ? ' to ' + payEsc(payDate(r.effective_to)) : '') + '</div><div class="sp-row-sub">' + payEsc(payRuleSummary(K.k, r.config)) + '</div></div>' +
        '<button type="button" class="pay-link" data-rule-open="' + payEsc(r.id) + '">' + (cls === 'draft' && payCanRules() ? 'Continue' : 'View') + ' \u203A</button></div>';
      return '<div class="po-sec pay-rule-card"><div class="pay-rule-head"><div><div class="pay-rule-name">' + payEsc(K.name) + '</div><div class="sp-row-sub">' + payEsc(K.sub) + '</div></div>' +
        (!draft && payCanRules() && pub.length ? '<button type="button" class="btn btn-secondary pay-sm" data-rule-new="' + K.k + '">+ New version</button>' : '') + '</div>' +
        (current ? line(current, 'In force') : (pub.length ? '' : '<div class="pay-ver"><span class="sp-row-sub" style="color:#9A6212;">Not published yet</span></div>')) +
        upcoming.map(r=> line(r, 'Starts ' + payDate(r.effective_from), 'next')).join('') +
        (draft ? line(draft, 'Draft', 'draft') : '') +
        (past.length ? '<details class="pay-past"><summary>' + past.length + ' earlier version' + (past.length === 1 ? '' : 's') + '</summary>' + past.map(r=> line(r, 'Ended', 'past')).join('') + '</details>' : '') +
        '</div>';
    }).join('');
    if(pay.audit.length){
      const act = { draft_created:'started a draft', draft_edited:'edited a draft', draft_deleted:'deleted a draft', published:'published', closed:'closed (replaced)' };
      const name = (k)=> (PAY_KINDS.find(K=> K.k === k) || {}).name || k;
      html += '<div class="po-sec"><div class="po-sec-title">Change history</div>' +
        pay.audit.filter(a=> a.action !== 'draft_edited').slice(0, 15).map(a=> '<div class="pay-audit"><span class="pay-audit-when">' + payEsc(payWhen(a.at)) + '</span> <b>' + payEsc(a.actor_name || 'System') + '</b> ' + payEsc(act[a.action] || a.action) + ' ' + payEsc(name(a.kind)) +
          (a.reason ? ' \u2014 <i>' + payEsc(a.reason) + '</i>' : '') + '</div>').join('') + '</div>';
    }
    body.innerHTML = html;
  }
  $('payRulesBody').addEventListener('click', async (e)=>{
    if(e.target.closest('[data-purch-reauth]')){ purchReauth().then(ok=>{ if(ok) payRulesShow(); }); return; }
    const nw = e.target.closest('[data-rule-new]');
    if(nw){
      const K = PAY_KINDS.find(x=> x.k === nw.dataset.ruleNew);
      const start = await uiPrompt('New ' + K.name + ' version\n\nWhen does it take effect? (YYYY-MM-DD) A copy of the current version is made for you to change.', payNextMonth(), { ok:'Create draft' });
      if(start == null) return;
      if(!/^\d{4}-\d{2}-\d{2}$/.test(start.trim())){ toast('Enter the date as YYYY-MM-DD'); return; }
      const { data, error } = await db.rpc('payroll_rule_new_draft', { p_kind: K.k, p_effective_from: start.trim() });
      if(error){ toast('Couldn\u2019t start a draft: ' + payDbMsg(error)); return; }
      await payRulesShow();
      payOpenRule(data);
      return;
    }
    const op = e.target.closest('[data-rule-open]');
    if(op) payOpenRule(op.dataset.ruleOpen);
    const back = e.target.closest('[data-rule-back]');
    if(back) payRulesShow();
  });
  function payNextMonth(){
    const d = new Date(Date.now() + 8 * 3600e3);
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
  }

  // ---------------- rule editor ----------------
  function payOpenRule(id){
    const r = pay.rules.find(x=> x.id === id);
    if(!r) return;
    pay.rule = r;
    pay.cfg = JSON.parse(JSON.stringify(r.config || {}));
    const K = PAY_KINDS.find(x=> x.k === r.kind);
    const ro = !!r.published_at || !payCanRules();
    const dis = ro ? ' disabled' : '';
    const status = r.published_at ? 'Published ' + payWhen(r.published_at) + ' \u2014 can\u2019t be changed' : 'Draft \u2014 not used by pay runs until published';
    $('payRulesBody').innerHTML =
      '<div class="po-ed-top"><button type="button" class="po-back" data-rule-back="1">\u2039 Payroll Rules</button><div class="po-ed-title">' + payEsc(K.name) + (r.published_at ? ' \u00B7 ' + payEsc(r.version_label) : ' \u00B7 Draft') + '</div>' +
        '<span class="sp-tag ' + (r.published_at ? '' : 'warn') + '">' + payEsc(status) + '</span></div>' +
      '<div class="po-sec"><div class="po-sec-title">Version</div><div class="po-grid">' +
        payField('po-c3', 'Takes effect', '<input type="date" id="payR_from" value="' + payEsc(r.effective_from) + '"' + dis + '>') +
        payField('po-c3', 'Version name', '<input type="text" id="payR_label" value="' + payEsc(r.version_label) + '" placeholder="Filled in when published"' + dis + '>') +
        payField('po-c6', 'Legal basis (circular, wage order\u2026)', '<input type="text" id="payR_legal" value="' + payEsc(r.legal_reference) + '"' + dis + '>') +
        payField('po-c12', 'Notes', '<textarea id="payR_notes" rows="2"' + dis + '>' + payEsc(r.notes) + '</textarea>') +
      '</div></div>' +
      '<div id="payR_form">' + payRuleForm(r.kind, pay.cfg, ro) + '</div>' +
      '<div class="pay-problem" id="payR_problem"></div>' +
      (ro ? '' : '<div class="pay-actions">' +
        '<button type="button" class="btn btn-primary" id="payR_save">Save Draft</button>' +
        (payCanPublish() ? '<button type="button" class="btn btn-primary pay-publish" id="payR_publish">Publish\u2026</button>' : '') +
        '<button type="button" class="btn btn-secondary" id="payR_check">Check</button>' +
        '<button type="button" class="btn btn-secondary pay-danger" id="payR_delete">Delete Draft</button></div>' +
        (payCanPublish() ? '' : '<div class="pay-hint">Someone with Payroll Rules \u203A Approve has to publish this draft.</div>'));
    window.scrollTo({ top:0 });
    if(!ro){
      $('payR_save').addEventListener('click', ()=> paySaveRule(false));
      $('payR_check').addEventListener('click', ()=> payCheckRule(true));
      $('payR_delete').addEventListener('click', payDeleteRule);
      if($('payR_publish')) $('payR_publish').addEventListener('click', payPublishRule);
    }
  }

  // --- per-kind forms. Values shown as % are stored as fractions (5% = 0.05).
  const payIn = (id, v, ro, extra)=> '<input type="text" inputmode="decimal" id="' + id + '" value="' + payEsc(v == null ? '' : v) + '"' + (ro ? ' disabled' : '') + (extra || '') + '>';
  const payCell = (key, v, ro, cls)=> '<td class="' + (cls || '') + '"><input type="text" inputmode="decimal" data-k="' + key + '" value="' + payEsc(v == null ? '' : v) + '"' + (ro ? ' disabled' : '') + '></td>';
  const payRm = (ro)=> ro ? '' : '<td class="pay-rm-cell"><button type="button" class="pay-rm" data-row-rm="1" aria-label="Remove row">\u00D7</button></td>';
  function payRuleForm(kind, c, ro){
    if(kind === 'sss'){
      const ec = c.ec || {};
      return '<div class="po-sec"><div class="po-sec-title">Rates</div><div class="po-grid">' +
          payField('po-c3', 'Employee share (%)', payIn('payC_ee', payPct(c.employee_rate), ro)) +
          payField('po-c3', 'Employer share (%)', payIn('payC_er', payPct(c.employer_rate), ro)) +
          payField('po-c6', '', '<div class="pay-hint">Share of the Monthly Salary Credit (MSC) in each bracket.</div>') +
          payField('po-c3', 'EC: MSC threshold (\u20B1)', payIn('payC_ecT', ec.threshold_msc, ro)) +
          payField('po-c3', 'EC below threshold (\u20B1)', payIn('payC_ecB', ec.below_amount, ro)) +
          payField('po-c3', 'EC at / above (\u20B1)', payIn('payC_ecA', ec.at_or_above_amount, ro)) +
        '</div></div>' +
        '<div class="po-sec"><div class="po-sec-title">Brackets</div>' +
          (ro ? '' : '<div class="pay-gen"><span>Rebuild the table:</span> MSC from ' + payIn('payG_lo', (c.brackets && c.brackets[0] && c.brackets[0].msc) || 5000, false, ' class="pay-sm-in"') +
            ' to ' + payIn('payG_hi', (c.brackets && c.brackets.length && c.brackets[c.brackets.length - 1].msc) || 35000, false, ' class="pay-sm-in"') +
            ' step ' + payIn('payG_step', 500, false, ' class="pay-sm-in"') + ' regular MSC up to ' + payIn('payG_reg', 20000, false, ' class="pay-sm-in"') +
            ' <button type="button" class="btn btn-secondary pay-sm" id="payG_build">Rebuild</button></div>') +
          '<div class="pay-table-wrap pay-tall"><table class="pay-table pay-edit" id="payT_sss"><thead><tr><th>#</th><th class="num">Salary from</th><th class="num">Salary to</th><th class="num">MSC</th><th class="num">Regular SS</th><th class="num">MPF</th>' + (ro ? '' : '<th></th>') + '</tr></thead><tbody>' +
            (c.brackets || []).map((b, i, arr)=> '<tr><td class="pay-idx">' + (i + 1) + '</td>' + payCell('comp_from', b.comp_from, ro, 'num') +
              (i === arr.length - 1 ? '<td class="num pay-muted">and above</td>' : payCell('comp_to', b.comp_to, ro, 'num')) +
              payCell('msc', b.msc, ro, 'num') + payCell('regular_msc', b.regular_msc, ro, 'num') + payCell('mpf_msc', b.mpf_msc, ro, 'num') + payRm(ro) + '</tr>').join('') +
          '</tbody></table></div>' + (ro ? '' : '<button type="button" class="pay-link" data-row-add="sss">+ Add bracket</button>') + '</div>';
    }
    if(kind === 'philhealth'){
      return '<div class="po-sec"><div class="po-sec-title">Premium</div><div class="po-grid">' +
        payField('po-c3', 'Premium rate (%)', payIn('payC_rate', payPct(c.premium_rate), ro)) +
        payField('po-c3', 'Employee pays (%)', payIn('payC_ees', payPct(c.employee_split), ro), 'Share of the premium') +
        payField('po-c3', 'Employer pays (%)', payIn('payC_ers', payPct(c.employer_split), ro)) +
        payField('po-c3', '', '') +
        payField('po-c3', 'Salary floor (\u20B1)', payIn('payC_floor', c.salary_floor, ro)) +
        payField('po-c3', 'Salary ceiling (\u20B1)', payIn('payC_ceil', c.salary_ceiling, ro)) +
        payField('po-c3', 'Minimum premium (\u20B1)', payIn('payC_min', c.min_total_premium, ro), 'Optional') +
        payField('po-c3', 'Maximum premium (\u20B1)', payIn('payC_max', c.max_total_premium, ro), 'Optional') +
      '</div></div>';
    }
    if(kind === 'pagibig'){
      return '<div class="po-sec"><div class="po-sec-title">Contributions</div><div class="po-grid">' +
        payField('po-c3', 'Employee (%)', payIn('payC_ee', payPct(c.employee_rate), ro)) +
        payField('po-c3', 'Employer (%)', payIn('payC_er', payPct(c.employer_rate), ro)) +
        payField('po-c6', 'Maximum fund salary (\u20B1)', payIn('payC_maxSal', c.max_fund_salary, ro)) +
        payField('po-c3', 'Employee cap (\u20B1)', payIn('payC_maxEe', c.max_employee_contribution, ro), 'Optional') +
        payField('po-c3', 'Employer cap (\u20B1)', payIn('payC_maxEr', c.max_employer_contribution, ro), 'Optional') +
      '</div></div>';
    }
    if(kind === 'bir'){
      const cap = c.other_benefits_cap || {};
      const covers = new Set(cap.covers || []);
      const rnd = c.rounding || {};
      const dm = c.de_minimis || {};
      const dis = ro ? ' disabled' : '';
      return '<div class="po-sec"><div class="po-sec-title">Withholding table</div><div class="po-grid">' +
          payField('po-c6', 'Table is for', '<select id="payC_period"' + dis + '>' + payOpts({ MONTHLY:'Monthly pay (others use it month-to-date)', SEMI_MONTHLY:'Semi-monthly pay', WEEKLY:'Weekly pay', BI_WEEKLY:'Bi-weekly pay' }, c.period) + '</select>') +
          payField('po-c3', 'Rounding', '<select id="payC_rmode"' + dis + '>' + payOpts({ HALF_UP:'Nearest (half up)', HALF_EVEN:'Nearest (half even)', DOWN:'Always down', UP:'Always up' }, rnd.mode) + '</select>') +
          payField('po-c3', 'Decimal places', payIn('payC_rscale', rnd.scale, ro)) +
        '</div>' +
        '<div class="pay-table-wrap"><table class="pay-table pay-edit" id="payT_bir"><thead><tr><th>#</th><th class="num">Taxable over</th><th class="num">Up to</th><th class="num">Fixed tax</th><th class="num">+ Rate (%)</th><th class="num">of excess over</th>' + (ro ? '' : '<th></th>') + '</tr></thead><tbody>' +
          (c.brackets || []).map((b, i, arr)=> '<tr><td class="pay-idx">' + (i + 1) + '</td>' + payCell('over', b.over, ro, 'num') +
            '<td class="num pay-muted">' + (i === arr.length - 1 ? 'and above' : payEsc(arr[i + 1].over)) + '</td>' +
            payCell('base_tax', b.base_tax, ro, 'num') + payCell('rate', payPct(b.rate), ro, 'num') + payCell('excess_over', b.excess_over, ro, 'num') + payRm(ro) + '</tr>').join('') +
        '</tbody></table></div>' + (ro ? '' : '<button type="button" class="pay-link" data-row-add="bir">+ Add bracket</button>') +
        '<div class="pay-hint">Each bracket ends where the next one starts. Tax = fixed tax + rate \u00D7 (taxable pay \u2212 excess over).</div></div>' +
        '<div class="po-sec"><div class="po-sec-title">13th month pay &amp; other benefits</div><div class="po-grid">' +
          payField('po-c3', 'Tax-free up to (\u20B1 a year)', payIn('payC_cap', cap.annual_amount, ro)) +
          payField('po-c6', 'Counts toward the cap', '<div class="pay-checks">' + Object.keys(PAY_CAP_COVERS).map(k=>
            '<label class="pay-chk"><input type="checkbox" data-cover="' + k + '"' + (covers.has(k) ? ' checked' : '') + dis + '> ' + PAY_CAP_COVERS[k] + '</label>').join('') + '</div>') +
          payField('po-c3', 'De minimis above its limit', '<select id="payC_excess"' + dis + '>' + payOpts({ ADD_TO_OTHER_BENEFITS:'Counts toward this cap', TAXABLE:'Taxable right away' }, cap.de_minimis_excess_treatment) + '</select>') +
        '</div></div>' +
        '<div class="po-sec"><div class="po-sec-title">De minimis benefits</div>' +
          '<div class="pay-table-wrap"><table class="pay-table pay-edit" id="payT_dm"><thead><tr><th>Code</th><th>Limit type</th><th class="num">Limit</th><th>Per</th><th>Shares a limit with</th>' + (ro ? '' : '<th></th>') + '</tr></thead><tbody>' +
            Object.keys(dm).map(k=> payDmRow(k, dm[k], ro)).join('') +
          '</tbody></table></div>' + (ro ? '' : '<button type="button" class="pay-link" data-row-add="dm">+ Add benefit</button>') +
          '<div class="pay-hint">Limit type \u201C% of min. wage\u201D: enter the percentage (30 = 30% of the regional minimum daily wage). \u201CDays\u201D: number of days a year (e.g. leave conversion).</div></div>';
    }
    if(kind === 'labor'){
      const pf = c.pay_frequencies || {};
      const nd = c.night_differential || {};
      const ex = new Set((c.mwe && c.mwe.exempt_categories) || []);
      const pr = c.premiums || {};
      const dis = ro ? ' disabled' : '';
      return '<div class="po-sec"><div class="po-sec-title">Pay periods a year</div><div class="po-grid">' +
          ['WEEKLY', 'BI_WEEKLY', 'SEMI_MONTHLY', 'MONTHLY'].map(f=> payField('po-c3', payEsc(PAY_FREQ[f].split(' (')[0]), payIn('payC_pf_' + f, pf[f] && pf[f].periods_per_year, ro))).join('') +
        '</div></div>' +
        '<div class="po-sec"><div class="po-sec-title">Night differential</div><div class="po-grid">' +
          payField('po-c3', 'Additional (%)', payIn('payC_nd', payPct(nd.rate), ro), 'Of the hourly rate (with any premium)') +
          payField('po-c3', 'From', '<input type="time" id="payC_ndFrom" value="' + payEsc(nd.start || '22:00') + '"' + dis + '>') +
          payField('po-c3', 'Until', '<input type="time" id="payC_ndTo" value="' + payEsc(nd.end || '06:00') + '"' + dis + '>') +
        '</div></div>' +
        '<div class="po-sec"><div class="po-sec-title">Minimum wage earners: tax-free pay</div><div class="pay-checks">' +
          Object.keys(PAY_EARN_CATS).map(k=> '<label class="pay-chk"><input type="checkbox" data-mwe="' + k + '"' + (ex.has(k) ? ' checked' : '') + dis + '> ' + PAY_EARN_CATS[k] + '</label>').join('') +
        '</div></div>' +
        '<div class="po-sec"><div class="po-sec-title">Premiums</div>' +
          '<div class="pay-table-wrap"><table class="pay-table pay-edit" id="payT_prem"><thead><tr><th>Code</th><th>Name</th><th>Type</th><th class="num">Pay (%)</th><th class="num">Monthly-paid (%)</th>' + (ro ? '' : '<th></th>') + '</tr></thead><tbody>' +
            Object.keys(pr).map(k=> payPremRow(k, pr[k], ro)).join('') +
          '</tbody></table></div>' + (ro ? '' : '<button type="button" class="pay-link" data-row-add="prem">+ Add premium</button>') +
          '<div class="pay-hint">Pay (%) is of the hourly rate: 125 = 125%. \u201CMonthly-paid\u201D is used instead for monthly-salaried staff whose salary already covers the day (leave blank to use Pay %).</div></div>';
    }
    return '';
  }
  function payDmRow(code, r, ro){
    r = r || {};
    const dis = ro ? ' disabled' : '';
    const lim = r.limit_type === 'PCT_OF_MIN_WAGE' ? payPct(r.pct) : r.limit;
    return '<tr>' + '<td><input type="text" data-k="code" value="' + payEsc(code) + '"' + dis + ' placeholder="RICE_SUBSIDY"></td>' +
      '<td><select data-k="limit_type"' + dis + '>' + payOpts({ AMOUNT:'Peso amount', PCT_OF_MIN_WAGE:'% of min. wage', DAYS:'Days' }, r.limit_type || 'AMOUNT') + '</select></td>' +
      payCell('limit', lim, ro, 'num') +
      '<td><select data-k="period"' + dis + '>' + PAY_DM_PERIODS.map(p=> '<option value="' + p + '"' + (p === (r.period || 'YEAR') ? ' selected' : '') + '>' + p.charAt(0) + p.slice(1).toLowerCase() + '</option>').join('') + '</select></td>' +
      '<td><input type="text" data-k="pool" value="' + payEsc(r.pool || '') + '"' + dis + ' placeholder="(own limit)"></td>' + payRm(ro) + '</tr>';
  }
  function payPremRow(code, p, ro){
    p = p || {};
    const dis = ro ? ' disabled' : '';
    return '<tr><td><input type="text" data-k="code" value="' + payEsc(code) + '"' + dis + ' placeholder="CODE"></td>' +
      '<td><input type="text" data-k="name" value="' + payEsc(p.name || '') + '"' + dis + '></td>' +
      '<td><select data-k="category"' + dis + '>' + payOpts({ OVERTIME:'Overtime', HOLIDAY_PAY:'Holiday / rest day' }, p.category || 'OVERTIME') + '</select></td>' +
      payCell('multiplier', payPct(p.multiplier), ro, 'num') + payCell('monthly_paid_multiplier', p.monthly_paid_multiplier == null ? '' : payPct(p.monthly_paid_multiplier), ro, 'num') + payRm(ro) + '</tr>';
  }
  // table row add / remove, SSS rebuild, BIR "up to" follows the next row
  $('payRulesBody').addEventListener('click', (e)=>{
    const rm = e.target.closest('[data-row-rm]');
    if(rm){ const tr = rm.closest('tr'); const tb = tr.parentNode; tr.remove(); payRenumber(tb); return; }
    const add = e.target.closest('[data-row-add]');
    if(add){
      const t = add.dataset.rowAdd;
      if(t === 'dm') $('payT_dm').tBodies[0].insertAdjacentHTML('beforeend', payDmRow('', null, false));
      if(t === 'prem') $('payT_prem').tBodies[0].insertAdjacentHTML('beforeend', payPremRow('', null, false));
      if(t === 'sss' || t === 'bir'){
        // re-render the table from the current values plus one empty row
        const cfg = payReadRule(true);
        if(t === 'sss'){ cfg.brackets.push({ comp_from:null, comp_to:null, msc:null }); }
        else { const last = cfg.brackets[cfg.brackets.length - 1] || {}; cfg.brackets.push({ over:null, base_tax:null, rate:last.rate, excess_over:null }); }
        $('payR_form').innerHTML = payRuleForm(pay.rule.kind, cfg, false);
      }
      return;
    }
    if(e.target.id === 'payG_build'){
      const lo = payNum($('payG_lo').value), hi = payNum($('payG_hi').value), step = payNum($('payG_step').value), reg = payNum($('payG_reg').value);
      if(!(lo > 0 && hi > lo && step > 0) || (hi - lo) / step > 400){ toast('Check the MSC range and step'); return; }
      const cfg = payReadRule(true);
      const rows = [];
      for(let m = lo, i = 0; m <= hi + 0.001; m += step, i++){
        rows.push({ msc:m, comp_from: i === 0 ? 0 : payTidy(m - step / 2), comp_to: payTidy(m + step / 2 - 0.01),
          regular_msc: reg > 0 ? Math.min(m, reg) : m, mpf_msc: reg > 0 ? Math.max(m - reg, 0) : 0 });
      }
      rows[rows.length - 1].comp_to = null;
      cfg.brackets = rows;
      $('payR_form').innerHTML = payRuleForm('sss', cfg, false);
      toast(rows.length + ' brackets built \u2014 check them against the SSS table, then save');
    }
  });
  $('payRulesBody').addEventListener('input', (e)=>{
    // BIR: show each bracket's "up to" as the next row's "over"
    const t = e.target.closest('#payT_bir');
    if(t && e.target.dataset.k === 'over'){
      const rows = [...t.tBodies[0].rows];
      rows.forEach((tr, i)=>{ const c = tr.cells[2]; if(c) c.textContent = i === rows.length - 1 ? 'and above' : (rows[i + 1].querySelector('[data-k="over"]').value || '\u2014'); });
    }
  });
  function payRenumber(tb){
    [...tb.rows].forEach((tr, i)=>{ const c = tr.querySelector('.pay-idx'); if(c) c.textContent = i + 1; });
    if(tb.parentNode.id === 'payT_bir' || tb.parentNode.id === 'payT_sss'){
      $('payR_form').innerHTML = payRuleForm(pay.rule.kind, payReadRule(true), false);
    }
  }

  // Read the form back into a config. Starts from the original so any keys
  // this screen doesn't show are kept. loose = keep blanks (while editing).
  function payReadRule(loose){
    const kind = pay.rule.kind;
    const c = JSON.parse(JSON.stringify(pay.cfg || {}));
    const v = (id)=> $(id) ? $(id).value : '';
    const n = (id)=> { const s = String(v(id)).trim(); return s === '' ? null : payNum(s); };
    const p = (id)=> { const s = String(v(id)).trim(); return s === '' ? null : payFromPct(s); };
    const opt = (obj, key, val)=>{ if(val == null) delete obj[key]; else obj[key] = val; };
    const cellN = (tr, k)=>{ const el = tr.querySelector('[data-k="' + k + '"]'); if(!el) return undefined; const s = el.value.trim(); return s === '' ? null : payNum(s); };
    const cellS = (tr, k)=>{ const el = tr.querySelector('[data-k="' + k + '"]'); return el ? el.value.trim() : ''; };
    if(kind === 'sss'){
      c.employee_rate = p('payC_ee'); c.employer_rate = p('payC_er');
      c.ec = Object.assign({}, c.ec || {}, { threshold_msc:n('payC_ecT'), below_amount:n('payC_ecB'), at_or_above_amount:n('payC_ecA') });
      const rows = [...$('payT_sss').tBodies[0].rows];
      c.brackets = rows.map((tr, i)=>{
        const b = { msc:cellN(tr, 'msc'), comp_from:cellN(tr, 'comp_from'), comp_to: i === rows.length - 1 ? null : cellN(tr, 'comp_to') };
        const rm = cellN(tr, 'regular_msc'), mp = cellN(tr, 'mpf_msc');
        if(rm != null) b.regular_msc = rm; if(mp != null) b.mpf_msc = mp;
        return b;
      });
    }
    if(kind === 'philhealth'){
      c.premium_rate = p('payC_rate'); c.employee_split = p('payC_ees'); c.employer_split = p('payC_ers');
      c.salary_floor = n('payC_floor'); c.salary_ceiling = n('payC_ceil');
      opt(c, 'min_total_premium', n('payC_min')); opt(c, 'max_total_premium', n('payC_max'));
    }
    if(kind === 'pagibig'){
      c.employee_rate = p('payC_ee'); c.employer_rate = p('payC_er'); c.max_fund_salary = n('payC_maxSal');
      opt(c, 'max_employee_contribution', n('payC_maxEe')); opt(c, 'max_employer_contribution', n('payC_maxEr'));
    }
    if(kind === 'bir'){
      c.period = v('payC_period');
      c.rounding = { mode: v('payC_rmode'), scale: n('payC_rscale') };
      const rows = [...$('payT_bir').tBodies[0].rows];
      const overs = rows.map(tr=> cellN(tr, 'over'));
      c.brackets = rows.map((tr, i)=>({ over:overs[i], up_to: i === rows.length - 1 ? null : overs[i + 1],
        base_tax:cellN(tr, 'base_tax'), rate: (()=>{ const s = cellS(tr, 'rate'); return s === '' ? null : payFromPct(s); })(),
        excess_over: cellN(tr, 'excess_over') == null && !loose ? overs[i] : cellN(tr, 'excess_over') }));
      c.other_benefits_cap = Object.assign({}, c.other_benefits_cap || {}, {
        annual_amount:n('payC_cap'), covers: $$('#payR_form [data-cover]').filter(x=> x.checked).map(x=> x.dataset.cover),
        de_minimis_excess_treatment: v('payC_excess') });
      const dm = {};
      [...$('payT_dm').tBodies[0].rows].forEach(tr=>{
        const code = cellS(tr, 'code').toUpperCase().replace(/[^A-Z0-9_]/g, '_');
        if(!code) return;
        const type = cellS(tr, 'limit_type');
        const lim = cellS(tr, 'limit');
        const r = { limit_type:type, period:cellS(tr, 'period') };
        if(type === 'PCT_OF_MIN_WAGE') r.pct = lim === '' ? null : payFromPct(lim); else r.limit = lim === '' ? null : payNum(lim);
        const pool = cellS(tr, 'pool').toUpperCase().replace(/[^A-Z0-9_]/g, '_');
        if(pool) r.pool = pool;
        dm[code] = r;
      });
      c.de_minimis = dm;
    }
    if(kind === 'labor'){
      c.pay_frequencies = {};
      ['WEEKLY', 'BI_WEEKLY', 'SEMI_MONTHLY', 'MONTHLY'].forEach(f=>{ c.pay_frequencies[f] = { periods_per_year:n('payC_pf_' + f) }; });
      c.night_differential = Object.assign({}, c.night_differential || {}, { rate:p('payC_nd'), start:v('payC_ndFrom') || '22:00', end:v('payC_ndTo') || '06:00' });
      c.mwe = Object.assign({}, c.mwe || {}, { exempt_categories: $$('#payR_form [data-mwe]').filter(x=> x.checked).map(x=> x.dataset.mwe) });
      const pr = {};
      [...$('payT_prem').tBodies[0].rows].forEach(tr=>{
        const code = cellS(tr, 'code').toUpperCase().replace(/[^A-Z0-9_]/g, '_');
        if(!code) return;
        const old = (pay.cfg.premiums || {})[code] || {};
        const r = Object.assign({}, old, { name:cellS(tr, 'name'), category:cellS(tr, 'category'),
          multiplier: (()=>{ const s = cellS(tr, 'multiplier'); return s === '' ? null : payFromPct(s); })() });
        const m = cellS(tr, 'monthly_paid_multiplier');
        if(m === '') delete r.monthly_paid_multiplier; else r.monthly_paid_multiplier = payFromPct(m);
        pr[code] = r;
      });
      c.premiums = pr;
    }
    return c;
  }
  function payNaN(o){ return JSON.stringify(o, (k, val)=> (typeof val === 'number' && !Number.isFinite(val)) ? '__NaN__' : val).includes('__NaN__'); }
  async function payCheckRule(show){
    const cfg = payReadRule(false);
    const box = $('payR_problem');
    if(payNaN(cfg)){ box.innerHTML = '<span class="pay-warn">A box has something that isn\u2019t a number.</span>'; return { cfg, problem:'nan' }; }
    try{
      const { data, error } = await db.rpc('payroll_rule_problem', { p_kind: pay.rule.kind, c: cfg });
      if(error) throw error;
      box.innerHTML = data ? '<span class="pay-warn">' + payEsc(data) + '</span>' : (show ? '<span class="pay-ok">\u2713 Everything needed is filled in. Still check each figure against the source.</span>' : '');
      return { cfg, problem:data };
    }catch(e){ box.innerHTML = '<span class="pay-warn">' + payEsc('Couldn\u2019t check: ' + describeCloudError(e)) + '</span>'; return { cfg, problem:'error' }; }
  }
  async function paySaveRule(quiet){
    const r = pay.rule;
    const { cfg, problem } = await payCheckRule(false);
    if(problem === 'nan' || problem === 'error') return false;
    const from = $('payR_from').value;
    if(!from){ toast('Choose when this version takes effect'); return false; }
    const { error } = await db.rpc('payroll_rule_save_draft', { p_id:r.id, p_config:cfg, p_effective_from:from,
      p_version_label:$('payR_label').value.trim(), p_legal_reference:$('payR_legal').value.trim(), p_notes:$('payR_notes').value.trim() });
    if(error){ toast('Couldn\u2019t save: ' + payDbMsg(error)); return false; }
    pay.cfg = cfg;
    Object.assign(r, { config:cfg, effective_from:from, version_label:$('payR_label').value.trim(), legal_reference:$('payR_legal').value.trim(), notes:$('payR_notes').value.trim() });
    if(!quiet) toast(problem ? 'Draft saved \u2014 fix the item shown before publishing' : 'Draft saved');
    return !problem;
  }
  async function payDeleteRule(){
    const reason = await uiPrompt('Delete this draft?\n\nWhy? (kept in the change history)', '', { ok:'Delete', danger:true, multiline:false });
    if(reason == null) return;
    const { error } = await db.rpc('payroll_rule_delete_draft', { p_id: pay.rule.id, p_reason: reason.trim() });
    if(error){ toast('Couldn\u2019t delete: ' + payDbMsg(error)); return; }
    toast('Draft deleted');
    payRulesShow();
  }
  async function payPublishRule(){
    const r = pay.rule;
    const K = PAY_KINDS.find(x=> x.k === r.kind);
    if(!(await paySaveRule(true))){ toast('Fix the item shown before publishing'); return; }
    if(!(await staffApprovalPrecheck('fin.payroll_rules', null, r.created_by))) return;
    const cur = pay.rules.find(x=> x.kind === r.kind && x.published_at && !x.effective_to);
    if(!await uiConfirm('Publish ' + K.name + ' from ' + payDate(r.effective_from) + '?\n\n' +
      (cur ? 'The current version (' + (cur.version_label || '') + ') ends the day before. ' : '') +
      'Published versions can never be edited or deleted \u2014 a correction needs a new version.', { ok:'Publish' })) return;
    const reason = await uiPrompt('Why is this being published?\n\nName the circular, revenue regulation or wage order it follows.', r.legal_reference || '', { ok:'Publish', multiline:false });
    if(reason == null) return;
    if(!reason.trim()){ toast('Say why this version is being published'); return; }
    const { error } = await db.rpc('payroll_rule_publish', { p_id:r.id, p_reason:reason.trim() });
    if(error){
      if(error.hint === 'reauth_required' || /password/i.test(error.message || '')){
        if(await staffEnsureReauth()) return payPublishRule();
        return;
      }
      toast('Couldn\u2019t publish: ' + payDbMsg(error)); return;
    }
    toast(K.name + ' published');
    payRulesShow();
  }
