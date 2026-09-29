  // =====================================================================
  // Payroll — Phase 2: Timesheets (migration 20261005_01_payroll_timesheets.sql)
  //
  //   HR › Timesheets (module hr.timesheets)
  //     periods list → a period (everyone's totals) → one person's days
  //   Build pulls DTR, approved leave, holidays and rest days. Every number
  //   on these screens is worked out by the database (one trigger), so what
  //   HR sees is what Phase 3's pay runs will use.
  // =====================================================================

  const TS_MIGRATION_MSG = 'Timesheets aren\u2019t set up in the database yet \u2014 run migration <b>20261005_01_payroll_timesheets.sql</b> in Supabase first.';
  const TS_STATUS = { present:'Present', incomplete:'No time-out', absent:'Absent', leave:'Leave', rest:'Rest day', holiday:'Holiday', not_hired:'Not yet hired', upcoming:'Upcoming' };
  const TS_STATUS_CLS = { present:'', incomplete:'danger', absent:'warn', leave:'muted', rest:'muted', holiday:'muted', not_hired:'muted', upcoming:'muted' };
  const TS_DAY_TYPE = { ORDINARY:'', REST_DAY:'Rest day', SPECIAL_HOLIDAY:'Special day', SPECIAL_HOLIDAY_REST_DAY:'Special day + rest day',
    HOLIDAY_REGULAR_WORKED:'Regular holiday', HOLIDAY_REGULAR_REST_DAY:'Regular holiday + rest day' };
  const TS_FLAG = { MISSING_OUT:'No time-out', MISSING_OT_OUT:'No OT time-out', OT_NOT_APPROVED:'OT not approved', TIME_OUT_BEFORE_IN:'Time-out before time-in',
    OT_OUT_BEFORE_IN:'OT out before OT in', WORKED_ON_LEAVE:'Worked while on leave', UNKNOWN_LEAVE_TYPE:'Leave type not in the list', LONG_SHIFT:'Over 16 hours',
    LATE:'Late', UNDERTIME:'Undertime' };
  const TS_BLOCKING = ['MISSING_OUT', 'MISSING_OT_OUT', 'OT_NOT_APPROVED', 'TIME_OUT_BEFORE_IN', 'OT_OUT_BEFORE_IN'];
  const TS_HR_STATUS = { '':'As recorded', absent:'Absent', leave_paid:'Paid leave', leave_unpaid:'Unpaid leave', day_off:'Day off (rest-day swap)', workday:'Workday (rest-day swap)' };

  const ts = { periods:[], period:null, totals:[], person:null, days:[] };
  const tsCanEdit = ()=> can('hr.timesheets', 'edit');
  const tsCanLock = ()=> can('hr.timesheets', 'approve');

  function tsMissing(e){ return payMissing(e) || /payroll_period|payroll_timesheet/.test(String(e && e.message)); }
  function tsErr(prefix, e){
    if(typeof purchIsAuthError === 'function' && purchIsAuthError(e)) return PURCH_EXPIRED_HTML;
    return tsMissing(e) ? TS_MIGRATION_MSG : payEsc(prefix + describeCloudError(e));
  }
  // minutes → "7:40"
  function tsHM(m){ m = Math.round(Number(m) || 0); if(!m) return '\u2013'; return Math.floor(m / 60) + ':' + String(m % 60).padStart(2, '0'); }
  function tsH(h){ const n = Number(h) || 0; return n ? String(payTidy(n)) : '\u2013'; }
  function tsClock(t){
    if(!t) return '';
    try{ return new Date(t).toLocaleTimeString('en-GB', { timeZone:'Asia/Manila', hour:'2-digit', minute:'2-digit' }); }catch(e){ return ''; }
  }
  function tsDayLabel(d){
    const dt = new Date(d + 'T00:00:00+08:00');
    return dt.toLocaleDateString('en-PH', { timeZone:'Asia/Manila', weekday:'short' }) + ' ' + dt.toLocaleDateString('en-PH', { timeZone:'Asia/Manila', month:'short', day:'numeric' });
  }
  // "HH:MM" on a work date (Manila) → ISO; `after` = the time it must come after
  function tsIso(date, hhmm, after){
    if(!hhmm) return null;
    let t = new Date(date + 'T' + hhmm + ':00+08:00').getTime();
    if(after){ const a = new Date(after).getTime(); while(t <= a) t += 864e5; }
    return new Date(t).toISOString();
  }
  function tsShow(which){
    ['list', 'period', 'person'].forEach(k=>{ $('tsView_' + k).style.display = k === which ? '' : 'none'; });
    window.scrollTo({ top:0 });
  }

  function tsOnShow(){
    $('purchasingView').classList.add('po-wide');
    document.body.classList.toggle('ts-ro', !tsCanEdit());
    tsShow('list');
    tsLoadPeriods();
  }

  // ---------------- periods ----------------
  async function tsLoadPeriods(){
    const list = $('tsPeriodList');
    list.innerHTML = '<div class="empty-state">Loading\u2026</div>';
    if(!(await ensureCloud())){ list.innerHTML = '<div class="empty-state">Not connected.</div>'; return; }
    try{
      const { data, error } = await db.from('payroll_periods').select('*').order('period_start', { ascending:false }).limit(60);
      if(error) throw error;
      ts.periods = data || [];
      tsSuggestNext();
      if(!ts.periods.length){ list.innerHTML = '<div class="empty-state">No pay periods yet.' + (tsCanEdit() ? ' Open the first one above.' : '') + '</div>'; return; }
      list.innerHTML = ts.periods.map(p=> '<div class="sp-row" data-id="' + payEsc(p.id) + '"><div class="sp-row-top"><div style="min-width:0;">' +
        '<div class="sp-row-title">' + payEsc(p.label) + ' ' + (p.status === 'locked' ? '<span class="sp-tag">\u{1F512} Locked</span>' : (p.built_at ? '<span class="sp-tag warn">Being reviewed</span>' : '<span class="sp-tag muted">Not built yet</span>')) + '</div>' +
        '<div class="sp-row-sub">' + payEsc(PAY_FREQ[p.pay_frequency] || p.pay_frequency) + ' \u00B7 pay date ' + payEsc(payDate(p.pay_date)) + '</div></div></div>' +
        '<div class="user-card-actions"><button type="button" class="primary" data-ts-open="1">Open</button></div></div>').join('');
    }catch(e){ list.innerHTML = '<div class="empty-state">' + tsErr('Couldn\u2019t load pay periods: ', e) + '</div>'; }
  }
  // next period after the latest one of the chosen frequency
  function tsSuggestNext(){
    const f = $('tsNewFreq').value;
    const last = ts.periods.filter(p=> p.pay_frequency === f).sort((a, b)=> b.period_end.localeCompare(a.period_end))[0];
    const iso = (d)=> d.toISOString().slice(0, 10);
    const addDays = (s, n)=>{ const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
    const eom = (y, m)=> iso(new Date(Date.UTC(y, m + 1, 0)));
    let start;
    if(last) start = addDays(last.period_end, 1);
    else {
      const t = payToday(), y = +t.slice(0, 4), m = +t.slice(5, 7) - 1, day = +t.slice(8, 10);
      start = f === 'SEMI_MONTHLY' ? (day <= 15 ? t.slice(0, 8) + '01' : t.slice(0, 8) + '16') : (f === 'MONTHLY' ? t.slice(0, 8) + '01' : t);
      if(f === 'WEEKLY' || f === 'BI_WEEKLY'){ const d = new Date(t + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); start = iso(d); }
    }
    const y = +start.slice(0, 4), m = +start.slice(5, 7) - 1, day = +start.slice(8, 10);
    let end;
    if(f === 'SEMI_MONTHLY') end = day <= 15 ? start.slice(0, 8) + '15' : eom(y, m);
    else if(f === 'MONTHLY') end = addDays(iso(new Date(Date.UTC(y, m + 1, day))), -1);
    else end = addDays(start, f === 'WEEKLY' ? 6 : 13);
    $('tsNewStart').value = start; $('tsNewEnd').value = end;
    $('tsNewPay').value = addDays(end, f === 'SEMI_MONTHLY' || f === 'MONTHLY' ? 5 : 3);
  }
  $('tsNewFreq').addEventListener('change', tsSuggestNext);
  $('tsNewCreate').addEventListener('click', async ()=>{
    if(!tsCanEdit()) return;
    const f = $('tsNewFreq').value, s = $('tsNewStart').value, e = $('tsNewEnd').value, pd = $('tsNewPay').value;
    if(!s || !e || !pd){ toast('Enter the period dates and the pay date'); return; }
    const { data, error } = await db.rpc('payroll_period_create', { p_frequency:f, p_start:s, p_end:e, p_pay_date:pd, p_label:'' });
    if(error){ toast(tsMissing(error) ? 'Run migration 20261005_01_payroll_timesheets.sql first' : 'Couldn\u2019t open the period: ' + payDbMsg(error)); return; }
    toast('Pay period opened \u2014 now build its timesheets');
    await tsLoadPeriods();
    tsOpenPeriod(data);
  });
  $('tsPeriodList').addEventListener('click', (e)=>{
    if(e.target.closest('[data-purch-reauth]')){ purchReauth().then(ok=>{ if(ok) tsLoadPeriods(); }); return; }
    const row = e.target.closest('.sp-row');
    if(row && e.target.closest('[data-ts-open]')) tsOpenPeriod(row.dataset.id);
  });

  // ---------------- one period ----------------
  async function tsOpenPeriod(id){
    tsShow('period');
    const box = $('tsPeriodBody');
    box.innerHTML = '<div class="empty-state">Loading\u2026</div>';
    try{
      const [p, t] = await Promise.all([
        db.from('payroll_periods').select('*').eq('id', id).maybeSingle(),
        db.rpc('payroll_period_totals', { p_period:id })
      ]);
      if(p.error) throw p.error; if(t.error) throw t.error;
      if(!p.data){ box.innerHTML = '<div class="empty-state">That pay period no longer exists.</div>'; return; }
      ts.period = p.data; ts.totals = t.data || [];
      tsRenderPeriod();
    }catch(e){ box.innerHTML = '<div class="empty-state">' + tsErr('Couldn\u2019t load the period: ', e) + '</div>'; }
  }
  function tsRenderPeriod(){
    const p = ts.period, locked = p.status === 'locked', edit = tsCanEdit() && !locked;
    $('tsPeriodTitle').textContent = p.label;
    const issues = ts.totals.reduce((a, r)=> a + (r.issues || 0), 0);
    const unrev = ts.totals.filter(r=> !r.reviewed_at).length;
    const ended = p.period_end < payToday();
    let status;
    if(locked) status = '<div class="pay-banner">\u{1F512} Locked ' + payEsc(payWhen(p.locked_at)) + '. Pay runs will use these totals. Unlock only to fix a mistake.</div>';
    else if(!p.built_at) status = '<div class="pay-banner warn">Not built yet. <b>Build timesheets</b> pulls everyone\u2019s DTR, approved leave and holidays for these dates.</div>';
    else status = '<div class="pay-banner ' + (issues || unrev ? 'warn' : '') + '">' +
      (issues ? '<b>' + issues + ' day' + (issues === 1 ? '' : 's') + ' need attention</b> (missing time-out or OT to approve). ' : '') +
      (unrev ? unrev + ' of ' + ts.totals.length + ' not reviewed yet. ' : 'Everyone is reviewed. ') +
      (!ended ? 'The period ends ' + payEsc(payDate(p.period_end)) + ' \u2014 rebuild after then to pick up the last days.' : (!issues && !unrev ? 'Ready to lock.' : '')) + '</div>';
    const act = [];
    if(edit) act.push('<button type="button" class="btn btn-primary" data-ts-act="build">' + (p.built_at ? 'Rebuild from DTR' : 'Build timesheets') + '</button>');
    if(edit && p.built_at) act.push('<button type="button" class="btn btn-secondary" data-ts-act="otall">Approve all OT</button>');
    if(!locked && tsCanLock() && p.built_at) act.push('<button type="button" class="btn btn-primary" data-ts-act="lock">\u{1F512} Lock period</button>');
    if(locked && tsCanLock()) act.push('<button type="button" class="btn btn-secondary" data-ts-act="unlock">Unlock\u2026</button>');
    if(edit && p.built_at) act.push('<button type="button" class="btn btn-secondary pay-danger" data-ts-act="reset">Start over\u2026</button>');
    if(edit) act.push('<button type="button" class="btn btn-secondary pay-danger" data-ts-act="delete">Delete period</button>');
    const rows = ts.totals.map(r=>{
      const leave = (Number(r.days_paid_leave) || 0) + (Number(r.days_unpaid_leave) || 0);
      return '<tr data-person="' + payEsc(r.profile_id) + '" class="ts-click' + (r.issues ? ' ts-bad' : '') + '">' +
        '<td><b>' + payEsc(r.name || '') + '</b>' + (r.employee_no ? '<div class="pay-muted">' + payEsc(r.employee_no) + '</div>' : '') + '</td>' +
        '<td class="num">' + (r.days_present || '\u2013') + '</td><td class="num">' + (r.days_absent || '\u2013') + '</td>' +
        '<td class="num">' + (leave ? payTidy(leave) + (Number(r.days_unpaid_leave) ? ' <span class="pay-muted">(' + payTidy(r.days_unpaid_leave) + ' unpaid)</span>' : '') : '\u2013') + '</td>' +
        '<td class="num">' + tsH(r.regular_hours) + '</td><td class="num">' + tsH(Number(r.late_hours) + Number(r.undertime_hours)) + '</td>' +
        '<td class="num">' + tsH(r.ot_paid_hours) + (Number(r.ot_claimed_hours) > Number(r.ot_paid_hours) ? ' <span class="pay-muted">of ' + tsH(r.ot_claimed_hours) + '</span>' : '') + '</td>' +
        '<td>' + (r.issues ? '<span class="sp-tag danger">' + r.issues + ' to fix</span>' : '') + (r.warnings ? ' <span class="sp-tag warn">' + r.warnings + ' note' + (r.warnings === 1 ? '' : 's') + '</span>' : '') + '</td>' +
        '<td>' + (r.reviewed_at ? '<span class="pay-ok">\u2713 Reviewed</span>' : '<span class="pay-muted">Not yet</span>') + '</td></tr>';
    }).join('');
    $('tsPeriodBody').innerHTML = status +
      '<div class="pay-hint" style="margin:-6px 0 12px;">' + payEsc(PAY_FREQ[p.pay_frequency] || p.pay_frequency) + ' \u00B7 ' + payEsc(payDate(p.period_start)) + ' to ' + payEsc(payDate(p.period_end)) +
        ' \u00B7 pay date ' + payEsc(payDate(p.pay_date)) + (p.built_at ? ' \u00B7 built ' + payEsc(payWhen(p.built_at)) : '') + '</div>' +
      (act.length ? '<div class="pay-actions">' + act.join('') + '</div>' : '') +
      (ts.totals.length ? '<div class="pay-table-wrap"><table class="pay-table"><thead><tr><th>Employee</th><th class="num">Present</th><th class="num">Absent</th><th class="num">Leave</th><th class="num">Regular h</th><th class="num">Late / UT h</th><th class="num">OT h</th><th>Checks</th><th>Review</th></tr></thead><tbody>' +
        rows + '</tbody></table></div><div class="pay-hint">Tap a person to see and correct their days.</div>'
        : (p.built_at ? '<div class="empty-state">Nobody is paid ' + payEsc((PAY_FREQ[p.pay_frequency] || '').toLowerCase()) + '. Check Payroll Setup \u203A Employees.</div>' : ''));
  }
  $('tsPeriodBack').addEventListener('click', ()=>{ tsShow('list'); tsLoadPeriods(); });
  $('tsPeriodBody').addEventListener('click', async (e)=>{
    const tr = e.target.closest('tr[data-person]');
    if(tr){ tsOpenPerson(tr.dataset.person); return; }
    const b = e.target.closest('[data-ts-act]');
    if(!b) return;
    const p = ts.period, act = b.dataset.tsAct;
    b.disabled = true;
    try{
      if(act === 'build'){
        const { data, error } = await db.rpc('payroll_period_build', { p_period:p.id, p_reset:false });
        if(error) throw error;
        toast((data.employees || 0) + ' people, ' + (data.days || 0) + ' days built' + (data.kept_corrections ? ' \u2014 ' + data.kept_corrections + ' correction' + (data.kept_corrections === 1 ? '' : 's') + ' kept' : ''));
      }
      if(act === 'reset'){
        if(!await uiConfirm('Start over?\n\nEvery correction, absence change and OT approval in this period is thrown away and the days are rebuilt straight from DTR.', { ok:'Start over', danger:true })) return;
        const { error } = await db.rpc('payroll_period_build', { p_period:p.id, p_reset:true });
        if(error) throw error;
        toast('Rebuilt from DTR');
      }
      if(act === 'otall'){
        if(!await uiConfirm('Approve all OT in this period?\n\nEvery overtime hour still waiting is approved as recorded. You can lower any day afterwards.', { ok:'Approve' })) return;
        const { data, error } = await db.rpc('payroll_ts_approve_ot', { p_period:p.id, p_profile:null });
        if(error) throw error;
        toast((data || 0) + ' day' + (data === 1 ? '' : 's') + ' of OT approved');
      }
      if(act === 'lock'){
        if(!(await staffApprovalPrecheck('hr.timesheets', null, null))) return;
        if(!await uiConfirm('Lock ' + p.label + '?\n\nNobody can change these timesheets after this. Pay runs will use the totals.', { ok:'Lock' })) return;
        const { error } = await db.rpc('payroll_period_lock', { p_period:p.id });
        if(error){ if(error.hint === 'reauth_required' && await staffEnsureReauth()){ b.disabled = false; return b.click(); } throw error; }
        toast('Period locked');
      }
      if(act === 'unlock'){
        if(!(await staffApprovalPrecheck('hr.timesheets', null, null))) return;
        const why = await uiPrompt('Unlock ' + p.label + '?\n\nWhy? (kept in the activity log)', '', { ok:'Unlock', multiline:false });
        if(why == null) return;
        if(!why.trim()){ toast('Say why the period is being unlocked'); return; }
        const { error } = await db.rpc('payroll_period_unlock', { p_period:p.id, p_reason:why.trim() });
        if(error) throw error;
        toast('Period unlocked');
      }
      if(act === 'delete'){
        if(!await uiConfirm('Delete ' + p.label + '?\n\nIts timesheets and corrections are removed. DTR records are not affected.')) return;
        const { error } = await db.rpc('payroll_period_delete', { p_period:p.id });
        if(error) throw error;
        toast('Pay period deleted');
        tsShow('list'); tsLoadPeriods(); return;
      }
      tsOpenPeriod(p.id);
    }catch(err){ toast('Couldn\u2019t do that: ' + payDbMsg(err)); }
    finally{ b.disabled = false; }
  });

  // ---------------- one person ----------------
  async function tsOpenPerson(profileId){
    const r = ts.totals.find(x=> x.profile_id === profileId);
    ts.person = r || { profile_id:profileId, name:'' };
    tsShow('person');
    $('tsPersonTitle').textContent = (r && r.name) || '';
    const box = $('tsPersonBody');
    box.innerHTML = '<div class="empty-state">Loading\u2026</div>';
    try{
      const { data, error } = await db.from('payroll_timesheet_days').select('*').eq('period_id', ts.period.id).eq('profile_id', profileId).order('work_date');
      if(error) throw error;
      ts.days = data || [];
      tsRenderPerson();
    }catch(e){ box.innerHTML = '<div class="empty-state">' + tsErr('Couldn\u2019t load the days: ', e) + '</div>'; }
  }
  function tsRenderPerson(){
    const r = ts.person, locked = ts.period.status === 'locked', edit = tsCanEdit() && !locked;
    const rest = (r.rest_days || []).map(d=> PAY_DAYS[d]).join(', ') || 'none';
    const pendingOt = ts.days.filter(d=> (d.flags || []).includes('OT_NOT_APPROVED')).length;
    const bad = ts.days.filter(d=> (d.flags || []).some(f=> TS_BLOCKING.includes(f))).length;
    const rows = ts.days.map(d=>{
      const flags = (d.flags || []).filter(f=> f !== 'LATE' && f !== 'UNDERTIME');
      const blocking = flags.some(f=> TS_BLOCKING.includes(f));
      const type = TS_DAY_TYPE[d.day_type] || '';
      return '<tr data-day="' + payEsc(d.id) + '" class="' + (blocking ? 'ts-bad' : '') + '">' +
        '<td class="ts-date"><b>' + payEsc(tsDayLabel(d.work_date)) + '</b>' + (type ? '<div class="pay-muted">' + payEsc(type) + (d.holiday_name ? ': ' + payEsc(d.holiday_name) : '') + '</div>' : '') + '</td>' +
        '<td><span class="sp-tag ' + (TS_STATUS_CLS[d.status] || '') + '">' + payEsc(d.status === 'leave' ? (d.leave_paid ? 'Paid leave' : d.leave_paid === false ? 'Unpaid leave' : 'Leave') : TS_STATUS[d.status] || d.status) + '</span>' +
          (d.adjusted ? ' <span class="sp-tag warn" title="' + payEsc(d.adjust_note) + '">Corrected</span>' : '') + '</td>' +
        '<td class="num">' + payEsc(tsClock(d.time_in) || '\u2013') + ' \u2013 ' + payEsc(tsClock(d.time_out) || '\u2013') + '</td>' +
        '<td class="num">' + tsHM(d.regular_min + d.premium_min) + '</td>' +
        '<td class="num">' + tsHM(d.late_min + d.undertime_min) + '</td>' +
        '<td class="num">' + (d.ot_claimed_min ? payEsc(tsClock(d.ot_in) || '') + (d.ot_in ? '\u2013' + payEsc(tsClock(d.ot_out) || '?') + '<br>' : '') + tsHM(d.ot_claimed_min) : '\u2013') + '</td>' +
        '<td class="num">' + (d.ot_claimed_min ? (edit ? '<input type="text" inputmode="decimal" class="ts-ot-in" data-ot="' + payEsc(d.id) + '" value="' + (d.ot_approved_min == null ? '' : payTidy(d.ot_approved_min / 60)) + '" placeholder="h">' : tsHM(d.ot_paid_min)) : '') + '</td>' +
        '<td class="num">' + tsHM(d.nd_min + d.nd_ot_min) + '</td>' +
        '<td>' + flags.map(f=> '<span class="sp-tag ' + (TS_BLOCKING.includes(f) ? 'danger' : 'warn') + '">' + payEsc(TS_FLAG[f] || f) + '</span>').join(' ') + '</td>' +
        (edit ? '<td><button type="button" class="pay-link" data-ts-fix="1">Correct</button></td>' : '') + '</tr>';
    }).join('');
    $('tsPersonBody').innerHTML =
      '<div class="pay-hint" style="margin:-6px 0 10px;">Shift ' + payEsc(payT(r.shift_start) || '\u2014') + '\u2013' + payEsc(payT(r.shift_end) || '\u2014') + ' \u00B7 break ' + payEsc(r.break_minutes == null ? '\u2014' : r.break_minutes + ' min') + ' \u00B7 rest days: ' + payEsc(rest) +
        ' \u00B7 ' + payEsc(ts.period.label) + '</div>' +
      (edit ? '<div class="pay-actions">' +
        (pendingOt ? '<button type="button" class="btn btn-secondary" data-ts-pact="ot">Approve all OT (' + pendingOt + ')</button>' : '') +
        (r.reviewed_at ? '<button type="button" class="btn btn-secondary" data-ts-pact="unreview">Undo review</button>'
                       : '<button type="button" class="btn btn-primary" data-ts-pact="review"' + (bad ? ' disabled title="Fix the days in red first"' : '') + '>\u2713 Mark reviewed</button>') +
        '</div>' : '') +
      (r.reviewed_at ? '<div class="pay-banner">\u2713 Reviewed ' + payEsc(payWhen(r.reviewed_at)) + '. Any correction clears this.</div>' : (bad ? '<div class="pay-banner warn">Fix the ' + bad + ' day' + (bad === 1 ? '' : 's') + ' in red, then mark reviewed.</div>' : '')) +
      '<div class="pay-table-wrap"><table class="pay-table ts-days"><thead><tr><th>Day</th><th>Status</th><th class="num">In \u2013 Out</th><th class="num">Hours</th><th class="num">Late / UT</th><th class="num">OT recorded</th><th class="num">OT approved (h)</th><th class="num">Night diff.</th><th>Checks</th>' + (edit ? '<th></th>' : '') + '</tr></thead><tbody>' +
        rows + '</tbody></table></div>' +
      '<div class="pay-hint">Hours are h:mm. OT is paid only once approved; leave the box empty to decide later, or enter fewer hours to approve part of it.</div>';
  }
  $('tsPersonBack').addEventListener('click', ()=>{ tsOpenPeriod(ts.period.id); });
  $('tsPersonBody').addEventListener('change', async (e)=>{
    const inp = e.target.closest('[data-ot]');
    if(!inp) return;
    const d = ts.days.find(x=> x.id === inp.dataset.ot);
    const s = inp.value.trim();
    let mins = null;
    if(s !== ''){ const h = payNum(s); if(!(h >= 0)){ toast('Enter hours, e.g. 2 or 1.5'); return; } mins = Math.round(h * 60); }
    if(mins != null && mins > d.ot_claimed_min){ toast('That\u2019s more than the ' + tsHM(d.ot_claimed_min) + ' recorded \u2014 approving the recorded OT'); mins = d.ot_claimed_min; }
    const { error } = await db.from('payroll_timesheet_days').update({ ot_approved_min:mins }).eq('id', d.id);
    if(error){ toast('Couldn\u2019t save: ' + payDbMsg(error)); return; }
    await tsReloadPerson();
  });
  async function tsReloadPerson(){
    const [t, dd] = await Promise.all([
      db.rpc('payroll_period_totals', { p_period:ts.period.id }),
      db.from('payroll_timesheet_days').select('*').eq('period_id', ts.period.id).eq('profile_id', ts.person.profile_id).order('work_date')
    ]);
    if(!t.error){ ts.totals = t.data || []; ts.person = ts.totals.find(x=> x.profile_id === ts.person.profile_id) || ts.person; }
    if(!dd.error) ts.days = dd.data || [];
    tsRenderPerson();
  }
  $('tsPersonBody').addEventListener('click', async (e)=>{
    const pa = e.target.closest('[data-ts-pact]');
    if(pa){
      const a = pa.dataset.tsPact; pa.disabled = true;
      try{
        if(a === 'ot'){
          const { error } = await db.rpc('payroll_ts_approve_ot', { p_period:ts.period.id, p_profile:ts.person.profile_id });
          if(error) throw error; toast('OT approved');
        } else {
          const { error } = await db.rpc('payroll_ts_set_reviewed', { p_period:ts.period.id, p_profile:ts.person.profile_id, p_reviewed: a === 'review' });
          if(error) throw error; toast(a === 'review' ? 'Marked reviewed' : 'Review undone');
        }
        await tsReloadPerson();
      }catch(err){ toast('Couldn\u2019t do that: ' + payDbMsg(err)); pa.disabled = false; }
      return;
    }
    if(e.target.closest('[data-ts-fix]')){ tsOpenFix(e.target.closest('tr').dataset.day); return; }
    if(e.target.closest('[data-fix-cancel]')){ tsRenderPerson(); return; }
    if(e.target.closest('[data-fix-save]')) tsSaveFix(e.target.closest('tr').dataset.fix);
  });
  function tsOpenFix(id){
    tsRenderPerson();
    const d = ts.days.find(x=> x.id === id);
    const tr = $('tsPersonBody').querySelector('tr[data-day="' + id + '"]');
    if(!d || !tr) return;
    const cols = tr.cells.length;
    tr.insertAdjacentHTML('afterend', '<tr class="ts-fix" data-fix="' + payEsc(id) + '"><td colspan="' + cols + '"><div class="po-grid">' +
      payField('po-c3', 'Time in', '<input type="time" data-f="in" value="' + payEsc(tsClock(d.time_in)) + '">') +
      payField('po-c3', 'Time out', '<input type="time" data-f="out" value="' + payEsc(tsClock(d.time_out)) + '">', 'Earlier than time in = next day') +
      payField('po-c3', 'OT in', '<input type="time" data-f="otin" value="' + payEsc(tsClock(d.ot_in)) + '">') +
      payField('po-c3', 'OT out', '<input type="time" data-f="otout" value="' + payEsc(tsClock(d.ot_out)) + '">') +
      payField('po-c6', 'Count this day as', '<select data-f="status">' + payOpts(TS_HR_STATUS, d.hr_status || '') + '</select>',
        d.leave_type ? 'Approved leave on file: ' + payEsc(d.leave_type) : '') +
      payField('po-c6', 'Why? <span class="req">*</span>', '<input type="text" data-f="note" value="" placeholder="e.g. Forgot to time out \u2014 confirmed by foreman">',
        d.adjusted ? 'Last correction: ' + payEsc(d.adjust_note) : '') +
      '</div><div class="pay-actions"><button type="button" class="btn btn-primary" data-fix-save="1">Save correction</button><button type="button" class="btn btn-secondary" data-fix-cancel="1">Cancel</button></div>' +
      (d.dtr_snapshot ? '<div class="pay-hint">DTR as recorded: in ' + payEsc(tsClock(payDtrTime(d.work_date, d.dtr_snapshot.timeIn)) || '\u2013') + ', out ' + payEsc(tsClock(payDtrTime(d.work_date, d.dtr_snapshot.timeOut)) || '\u2013') +
        (d.dtr_snapshot.otTimeIn ? ', OT ' + payEsc(tsClock(payDtrTime(d.work_date, d.dtr_snapshot.otTimeIn)) || '') + '\u2013' + payEsc(tsClock(payDtrTime(d.work_date, d.dtr_snapshot.otTimeOut)) || '') : '') + '</div>' : '<div class="pay-hint">No DTR record for this day.</div>') +
      '</td></tr>');
    const note = $('tsPersonBody').querySelector('tr.ts-fix [data-f="note"]');
    if(note) note.focus();
  }
  function payDtrTime(date, v){
    if(!v) return null;
    if(/^\s*\d{1,2}:\d{2}/.test(v)) return tsIso(date, v.trim().slice(0, 5).padStart(5, '0'));
    return v;
  }
  async function tsSaveFix(id){
    const d = ts.days.find(x=> x.id === id);
    const row = $('tsPersonBody').querySelector('tr.ts-fix');
    const g = (f)=> row.querySelector('[data-f="' + f + '"]').value;
    const note = g('note').trim();
    if(!note){ toast('Say why this day is being corrected'); return; }
    const tin = tsIso(d.work_date, g('in'));
    const tout = tsIso(d.work_date, g('out'), tin);
    const oin = tsIso(d.work_date, g('otin'), tout || tin);
    const oout = tsIso(d.work_date, g('otout'), oin);
    if(!tin && tout){ toast('Enter the time in too'); return; }
    if(!oin && oout){ toast('Enter the OT start too'); return; }
    const upd = { time_in:tin, time_out:tout, ot_in:oin, ot_out:oout, hr_status: g('status') || null, adjust_note:note };
    const { error } = await db.from('payroll_timesheet_days').update(upd).eq('id', id);
    if(error){ toast('Couldn\u2019t save: ' + payDbMsg(error)); return; }
    toast('Day corrected');
    await tsReloadPerson();
  }
