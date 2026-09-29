  // =====================================================================
  // Payroll — Phase 3: pay runs and payslips (20261006_01_payroll_runs.sql)
  //
  //   HR › Pay Runs (hr.payroll_runs) / Finance › Payroll Approval
  //   (fin.payroll_approve) — the same page; buttons follow access:
  //     start (locked timesheets) → adjustments / cash advances → Compute
  //     (payroll-compute Edge Function) → Submit → Approve / Send back →
  //     Release (payslips appear, cash advances settle, loans go down)
  //   Payroll Setup › Employees › Allowances & loans (recurring items)
  //   My HR › My Payslips (technicians and office staff)
  //   Payslip and payroll register PDFs open in the shared PDF viewer;
  //   the register also exports to Excel.
  // =====================================================================

  const PR_MIGRATION_MSG = 'Pay runs aren\u2019t set up in the database yet \u2014 run migration <b>20261006_01_payroll_runs.sql</b> in Supabase first.';
  const PR_STATUS = { draft:'Draft', computed:'Computed \u2014 check it', submitted:'Waiting for approval', approved:'Approved \u2014 ready to release', released:'Released' };
  const PR_STATUS_CLS = { draft:'muted', computed:'warn', submitted:'warn', approved:'', released:'' };
  const PR_CATS_EARN = { ALLOWANCE:'Allowance', BONUS:'Bonus', THIRTEENTH_MONTH:'13th month pay', OTHER_BENEFITS:'Other benefits', COMMISSION:'Commission', HAZARD_PAY:'Hazard pay', ADJUSTMENT:'Adjustment', REIMBURSEMENT:'Reimbursement', OTHER:'Other' };
  const PR_CATS_DED = { LOAN:'Loan', CASH_ADVANCE:'Cash advance', UNIFORM:'Uniform / equipment', UNION_DUES:'Union dues', ADJUSTMENT:'Adjustment', OTHER:'Other' };

  const pr = { runs:[], periods:[], run:null, period:null, lines:[], adj:[], names:new Map() };
  const prCanRun = ()=> can('hr.payroll_runs', 'edit');
  const prCanApprove = ()=> can('fin.payroll_approve', 'approve');
  const prCanRelease = ()=> can('fin.payroll_approve', 'edit');
  const prMissing = (e)=> payMissing(e) || /payroll_run|payroll_lines/.test(String(e && e.message));
  function prErr(prefix, e){
    if(typeof purchIsAuthError === 'function' && purchIsAuthError(e)) return PURCH_EXPIRED_HTML;
    return prMissing(e) ? PR_MIGRATION_MSG : payEsc(prefix + describeCloudError(e));
  }
  const prShow = (w)=>{ ['list', 'run'].forEach(k=>{ $('prView_' + k).style.display = k === w ? '' : 'none'; }); window.scrollTo({ top:0 }); };

  function prOnShow(){
    $('purchasingView').classList.add('po-wide');
    prShow('list');
    prLoadList();
  }

  // ---------------- list ----------------
  async function prLoadList(){
    const box = $('prList');
    box.innerHTML = '<div class="empty-state">Loading\u2026</div>';
    if(!(await ensureCloud())){ box.innerHTML = '<div class="empty-state">Not connected.</div>'; return; }
    try{
      const [r, p] = await Promise.all([
        db.from('payroll_runs').select('*').order('created_at', { ascending:false }).limit(60),
        db.from('payroll_periods').select('*').eq('status', 'locked').order('period_start', { ascending:false }).limit(60)
      ]);
      if(r.error) throw r.error; if(p.error) throw p.error;
      pr.runs = r.data || []; pr.periods = p.data || [];
      const byId = new Map(pr.periods.map(x=> [x.id, x]));
      const ready = pr.periods.filter(x=> !pr.runs.some(r=> r.period_id === x.id));
      let html = '';
      if(ready.length && prCanRun()){
        html += '<div class="po-sec"><div class="po-sec-title">Ready for a pay run</div>' + ready.map(x=>
          '<div class="pay-ver"><div><b>' + payEsc(x.label) + '</b><div class="sp-row-sub">' + payEsc(PAY_FREQ[x.pay_frequency] || '') + ' \u00B7 pay date ' + payEsc(payDate(x.pay_date)) + ' \u00B7 timesheets locked</div></div>' +
          '<button type="button" class="btn btn-primary pay-sm" data-pr-start="' + payEsc(x.id) + '">Start pay run</button></div>').join('') + '</div>';
      } else if(!pr.runs.length){
        html += '<div class="pay-banner warn">No pay runs yet. Lock a period in <b>Timesheets</b> first, then start its pay run here.</div>';
      }
      html += pr.runs.map(r=>{
        const per = byId.get(r.period_id);
        return '<div class="sp-row" data-id="' + payEsc(r.id) + '"><div class="sp-row-top"><div style="min-width:0;">' +
          '<div class="sp-row-title">' + payEsc(per ? per.label : 'Pay run') + ' <span class="sp-tag ' + (PR_STATUS_CLS[r.status] || '') + '">' + payEsc(PR_STATUS[r.status] || r.status) + '</span></div>' +
          '<div class="sp-row-sub">' + (per ? 'Pay date ' + payEsc(payDate(per.pay_date)) + ' \u00B7 ' : '') + (r.headcount ? r.headcount + ' people' : 'not computed yet') + (r.sent_back_note ? ' \u00B7 sent back: ' + payEsc(r.sent_back_note) : '') + '</div></div>' +
          (r.headcount ? '<div class="mt-row-price">' + payPeso(r.total_net) + '<div class="sp-row-sub">net pay</div></div>' : '') + '</div>' +
          '<div class="user-card-actions"><button type="button" class="primary" data-pr-open="1">Open</button></div></div>';
      }).join('');
      box.innerHTML = html || '<div class="empty-state">No pay runs yet.</div>';
    }catch(e){ box.innerHTML = '<div class="empty-state">' + prErr('Couldn\u2019t load pay runs: ', e) + '</div>'; }
  }
  $('prList').addEventListener('click', async (e)=>{
    if(e.target.closest('[data-purch-reauth]')){ purchReauth().then(ok=>{ if(ok) prLoadList(); }); return; }
    const st = e.target.closest('[data-pr-start]');
    if(st){
      st.disabled = true;
      const { data, error } = await db.rpc('payroll_run_create', { p_period: st.dataset.prStart });
      if(error){ st.disabled = false; toast('Couldn\u2019t start: ' + payDbMsg(error)); return; }
      const ca = await db.rpc('payroll_run_add_cash_advances', { p_run:data });
      toast('Pay run started' + (!ca.error && ca.data ? ' \u2014 ' + ca.data + ' cash advance balance' + (ca.data === 1 ? '' : 's') + ' added' : ''));
      prOpenRun(data);
      return;
    }
    const row = e.target.closest('.sp-row');
    if(row && e.target.closest('[data-pr-open]')) prOpenRun(row.dataset.id);
  });

  // ---------------- one run ----------------
  async function prOpenRun(id){
    prShow('run');
    const box = $('prRunBody');
    box.innerHTML = '<div class="empty-state">Loading\u2026</div>';
    try{
      const r = await db.from('payroll_runs').select('*').eq('id', id).maybeSingle();
      if(r.error) throw r.error;
      if(!r.data){ box.innerHTML = '<div class="empty-state">That pay run no longer exists.</div>'; return; }
      pr.run = r.data;
      const [p, l, a, t] = await Promise.all([
        db.from('payroll_periods').select('*').eq('id', pr.run.period_id).maybeSingle(),
        db.from('payroll_lines').select('*').eq('run_id', id),
        db.from('payroll_run_adjustments').select('*').eq('run_id', id).order('created_at'),
        db.from('payroll_timesheets').select('profile_id').eq('period_id', pr.run.period_id)
      ]);
      for(const x of [p, l, a]) if(x.error) throw x.error;
      pr.period = p.data; pr.lines = l.data || []; pr.adj = a.data || [];
      const ids = [...new Set([...(t.data || []).map(x=> x.profile_id), ...pr.lines.map(x=> x.profile_id), ...pr.adj.map(x=> x.profile_id)])];
      if(ids.length){
        const pp = await db.from('profiles').select('id, name').in('id', ids);
        (pp.data || []).forEach(x=> pr.names.set(x.id, x.name));
      }
      pr.people = ids.sort((x, y)=> String(pr.names.get(x) || '').localeCompare(String(pr.names.get(y) || '')));
      prRenderRun();
    }catch(e){ box.innerHTML = '<div class="empty-state">' + prErr('Couldn\u2019t load the pay run: ', e) + '</div>'; }
  }
  function prRenderRun(){
    const r = pr.run, per = pr.period || {}, editable = prCanRun() && (r.status === 'draft' || r.status === 'computed');
    $('prRunTitle').textContent = per.label || 'Pay run';
    const banner = {
      draft: 'Add any one-off earnings or deductions below, then <b>Compute</b>. Recurring allowances and loans come from Payroll Setup; hours come from the locked timesheets.',
      computed: 'Check each person\u2019s pay (tap a row for the payslip). Change anything and it goes back to draft. When it\u2019s right, <b>Submit for approval</b>.',
      submitted: 'Waiting for Finance to approve. HR can\u2019t change it now; Finance can send it back with a reason.',
      approved: 'Approved. <b>Release</b> once salaries are paid out \u2014 payslips then appear in each person\u2019s My HR.',
      released: 'Released ' + payWhen(r.released_at) + '. Payslips are in each person\u2019s My HR. This pay run is final.'
    }[r.status];
    const act = [];
    if(editable){
      act.push('<button type="button" class="btn btn-primary" data-pr-act="compute">' + (r.status === 'computed' ? 'Compute again' : 'Compute pay') + '</button>');
      if(r.status === 'computed') act.push('<button type="button" class="btn btn-primary" data-pr-act="submit">Submit for approval</button>');
      act.push('<button type="button" class="btn btn-secondary" data-pr-act="ca">Pull in cash advances</button>');
    }
    if(r.status === 'submitted' && prCanApprove()) act.push('<button type="button" class="btn btn-primary" data-pr-act="approve">\u2713 Approve ' + payPeso(r.total_net) + '</button>');
    if(r.status === 'submitted' && (prCanApprove() || prCanRun())) act.push('<button type="button" class="btn btn-secondary" data-pr-act="back">Send back\u2026</button>');
    if(r.status === 'approved' && prCanRelease()) act.push('<button type="button" class="btn btn-primary" data-pr-act="release">Release pay</button>');
    if(pr.lines.length){
      act.push('<button type="button" class="btn btn-secondary" data-pr-act="pdf">Register PDF</button>');
      act.push('<button type="button" class="btn btn-secondary" data-pr-act="xlsx">Register Excel</button>');
    }
    if(editable) act.push('<button type="button" class="btn btn-secondary pay-danger" data-pr-act="delete">Delete pay run</button>');

    const T = (l)=> (l.result && l.result.totals) || {};
    const rows = pr.lines.slice().sort((a, b)=> String(pr.names.get(a.profile_id) || '').localeCompare(String(pr.names.get(b.profile_id) || ''))).map(l=>{
      const t = T(l), w = (l.warnings || []).length;
      return '<tr class="ts-click" data-line="' + payEsc(l.profile_id) + '"><td><b>' + payEsc(pr.names.get(l.profile_id) || '') + '</b>' + (w ? ' <span class="sp-tag warn">' + w + ' note' + (w === 1 ? '' : 's') + '</span>' : '') + '</td>' +
        '<td class="num">' + payPeso(t.grossPay) + '</td><td class="num">' + payPeso(t.employeeMandatoryContributions) + '</td><td class="num">' + payPeso(t.withholdingTax) + '</td>' +
        '<td class="num">' + payPeso(t.voluntaryDeductions) + (Number(t.deferredDeductions) ? '<div class="pay-warn">' + payPeso(t.deferredDeductions) + ' carried over</div>' : '') + '</td>' +
        '<td class="num"><b>' + payPeso(t.netPay) + '</b></td><td class="num pay-muted">' + payPeso(t.employerContributions) + '</td></tr>';
    }).join('');
    const tot = pr.lines.reduce((a, l)=>{ const t = T(l); ['grossPay', 'employeeMandatoryContributions', 'withholdingTax', 'voluntaryDeductions', 'netPay', 'employerContributions'].forEach(k=> a[k] = (a[k] || 0) + (Number(t[k]) || 0)); return a; }, {});

    const adjRows = pr.adj.map(a=> '<tr data-adj="' + payEsc(a.id) + '"><td>' + payEsc(pr.names.get(a.profile_id) || '') + '</td><td>' + payEsc(a.name) +
        (a.source === 'cash_advance' ? ' <span class="sp-tag muted">Cash advance</span>' : '') + '<div class="pay-muted">' + payEsc((a.kind === 'earning' ? PR_CATS_EARN : PR_CATS_DED)[a.category] || a.category) +
        (a.kind === 'earning' ? (a.is_de_minimis ? ' \u00B7 de minimis ' + payEsc(a.de_minimis_code) : a.is_taxable ? ' \u00B7 taxable' : ' \u00B7 not taxable') : '') + '</div></td>' +
        '<td class="num ' + (a.kind === 'deduction' ? 'pay-warn' : '') + '">' + (a.kind === 'deduction' ? '\u2212' : '+') + payPeso(a.amount) + '</td>' +
        (editable ? '<td><button type="button" class="pay-rm" data-adj-rm="1" aria-label="Remove">\u00D7</button></td>' : '') + '</tr>').join('');
    const people = (pr.people || []).map(id=> '<option value="' + payEsc(id) + '">' + payEsc(pr.names.get(id) || id) + '</option>').join('');

    $('prRunBody').innerHTML =
      '<div class="pay-banner ' + (r.status === 'released' || r.status === 'approved' ? '' : 'warn') + '">' + banner + (r.sent_back_note && r.status === 'computed' ? '<div><b>Sent back:</b> ' + payEsc(r.sent_back_note) + '</div>' : '') + '</div>' +
      '<div class="pay-hint" style="margin:-6px 0 12px;">' + payEsc(PAY_FREQ[per.pay_frequency] || '') + ' \u00B7 ' + payEsc(payDate(per.period_start)) + ' to ' + payEsc(payDate(per.period_end)) + ' \u00B7 pay date ' + payEsc(payDate(per.pay_date)) +
        (r.rule_labels ? '<br>Rules: ' + payEsc(r.rule_labels) : '') + '</div>' +
      (r.headcount ? '<div class="pr-kpis"><div><span>Gross pay</span><b>' + payPeso(r.total_gross) + '</b></div><div><span>Net pay</span><b>' + payPeso(r.total_net) + '</b></div><div><span>Employer contributions</span><b>' + payPeso(r.total_employer) + '</b></div><div><span>Total cost</span><b>' + payPeso(r.total_cost) + '</b></div></div>' : '') +
      (act.length ? '<div class="pay-actions">' + act.join('') + '</div>' : '') +
      '<div id="prErrors"></div>' +
      (pr.lines.length ? '<div class="po-sec"><div class="po-sec-title">Payroll register</div><div class="pay-table-wrap"><table class="pay-table"><thead><tr><th>Employee</th><th class="num">Gross</th><th class="num">SSS / PhilHealth / Pag-IBIG</th><th class="num">Tax</th><th class="num">Other deductions</th><th class="num">Net pay</th><th class="num">Employer share</th></tr></thead><tbody>' +
        rows + '<tr class="pr-total"><td>Total</td><td class="num">' + payPeso(tot.grossPay) + '</td><td class="num">' + payPeso(tot.employeeMandatoryContributions) + '</td><td class="num">' + payPeso(tot.withholdingTax) + '</td><td class="num">' + payPeso(tot.voluntaryDeductions) + '</td><td class="num">' + payPeso(tot.netPay) + '</td><td class="num">' + payPeso(tot.employerContributions) + '</td></tr>' +
        '</tbody></table></div><div class="pay-hint">Tap a person to open their payslip.</div></div>' : '') +
      '<div class="po-sec"><div class="po-sec-title">One-off earnings &amp; deductions (this pay run only)</div>' +
        (pr.adj.length ? '<div class="pay-table-wrap"><table class="pay-table"><tbody>' + adjRows + '</tbody></table></div>' : '<div class="pay-hint">None.</div>') +
        (editable ? '<div class="po-grid" style="margin-top:10px;">' +
          payField('po-c3', 'Person', '<select id="prA_who">' + people + '</select>') +
          payField('po-c3', 'Type', '<select id="prA_kind"><option value="earning">Earning (+)</option><option value="deduction">Deduction (\u2212)</option></select>') +
          payField('po-c3', 'Category', '<select id="prA_cat">' + payOpts(PR_CATS_EARN, 'BONUS') + '</select>') +
          payField('po-c3', 'Amount (\u20B1)', '<input type="text" inputmode="decimal" id="prA_amt" placeholder="0.00">') +
          payField('po-c6', 'Description', '<input type="text" id="prA_name" placeholder="e.g. Performance bonus, uniform deduction">') +
          payField('po-c3', 'Tax', '<select id="prA_tax"><option value="auto">Per BIR rules</option><option value="taxable">Taxable</option><option value="exempt">Not taxable</option><option value="dm">De minimis\u2026</option></select>',
            '13th month, bonuses &amp; other benefits: tax-free up to the yearly cap') +
          payField('po-c3', 'De minimis type', '<select id="prA_dm" disabled><option value="">\u2014</option></select>') +
          '<div class="po-c12"><button type="button" class="btn btn-primary" id="prA_add">+ Add to this pay run</button></div></div>' : '') +
      '</div>';
    if(editable) prFillDm();
  }
  async function prFillDm(){
    // de minimis codes from the BIR rule in force
    try{
      const { data } = await db.from('payroll_rules').select('config, effective_from, effective_to, published_at').eq('kind', 'bir').not('published_at', 'is', null);
      const pd = pr.period && pr.period.pay_date;
      const cur = (data || []).find(x=> x.effective_from <= pd && (!x.effective_to || x.effective_to >= pd));
      const codes = Object.keys((cur && cur.config && cur.config.de_minimis) || {});
      if($('prA_dm')) $('prA_dm').innerHTML = '<option value="">\u2014</option>' + codes.map(c=> '<option value="' + payEsc(c) + '">' + payEsc(c.replace(/_/g, ' ').toLowerCase()) + '</option>').join('');
    }catch(e){}
  }
  $('prRunBody').addEventListener('change', (e)=>{
    if(e.target.id === 'prA_kind'){
      const ded = e.target.value === 'deduction';
      $('prA_cat').innerHTML = payOpts(ded ? PR_CATS_DED : PR_CATS_EARN, ded ? 'ADJUSTMENT' : 'BONUS');
      $('prA_tax').disabled = ded; $('prA_dm').disabled = true;
    }
    if(e.target.id === 'prA_tax') $('prA_dm').disabled = e.target.value !== 'dm';
  });
  $('prRunBack').addEventListener('click', ()=>{ prShow('list'); prLoadList(); });
  $('prRunBody').addEventListener('click', async (e)=>{
    const tr = e.target.closest('tr[data-line]');
    if(tr){ const l = pr.lines.find(x=> x.profile_id === tr.dataset.line); if(l) prPayslipPdf(l, pr.period, pr.names.get(l.profile_id)); return; }
    if(e.target.closest('[data-adj-rm]')){
      const a = pr.adj.find(x=> x.id === e.target.closest('tr').dataset.adj);
      if(!a || !await uiConfirm('Remove \u201C' + a.name + '\u201D (' + payPeso(a.amount) + ') for ' + (pr.names.get(a.profile_id) || '') + '?' + (pr.run.status === 'computed' ? '\n\nThe pay run goes back to draft.' : ''))) return;
      const { error } = await db.from('payroll_run_adjustments').delete().eq('id', a.id);
      if(error){ toast('Couldn\u2019t remove: ' + payDbMsg(error)); return; }
      prOpenRun(pr.run.id); return;
    }
    if(e.target.id === 'prA_add'){
      const kind = $('prA_kind').value, tax = $('prA_tax').value, amt = payNum($('prA_amt').value), name = $('prA_name').value.trim();
      const cat = $('prA_cat').value;
      if(!(amt > 0)){ toast('Enter the amount'); return; }
      if(!name){ toast('Enter a description'); return; }
      if(tax === 'dm' && !$('prA_dm').value){ toast('Choose the de minimis type'); return; }
      const autoTaxable = !['THIRTEENTH_MONTH', 'BONUS', 'OTHER_BENEFITS', 'REIMBURSEMENT'].includes(cat);
      const row = { run_id:pr.run.id, profile_id:$('prA_who').value, kind, name, category:cat, amount:amt,
        is_taxable: kind === 'earning' ? (tax === 'taxable' || (tax === 'auto' && autoTaxable)) : false,
        is_de_minimis: kind === 'earning' && tax === 'dm', de_minimis_code: kind === 'earning' && tax === 'dm' ? $('prA_dm').value : null };
      if(cat === 'REIMBURSEMENT') row.is_taxable = false;
      const { error } = await db.from('payroll_run_adjustments').insert(row);
      if(error){ toast('Couldn\u2019t add: ' + payDbMsg(error)); return; }
      toast('Added' + (pr.run.status === 'computed' ? ' \u2014 compute again' : ''));
      prOpenRun(pr.run.id); return;
    }
    const b = e.target.closest('[data-pr-act]');
    if(!b) return;
    const r = pr.run, act = b.dataset.prAct;
    b.disabled = true;
    try{
      if(act === 'compute') await prCompute();
      if(act === 'ca'){
        const { data, error } = await db.rpc('payroll_run_add_cash_advances', { p_run:r.id });
        if(error) throw error;
        toast(data ? data + ' cash advance balance' + (data === 1 ? '' : 's') + ' added' : 'No unsettled cash advances for these people');
      }
      if(act === 'submit'){
        if(!await uiConfirm('Submit this pay run for approval?\n\n' + r.headcount + ' people, net pay ' + payPeso(r.total_net) + '. It can\u2019t be changed while it waits.', { ok:'Submit' })) return;
        const { error } = await db.rpc('payroll_run_submit', { p_run:r.id }); if(error) throw error;
        toast('Submitted for approval');
      }
      if(act === 'back'){
        const why = await uiPrompt('Send this pay run back?\n\nWhat needs fixing?', '', { ok:'Send back', multiline:false });
        if(why == null) return;
        if(!why.trim()){ toast('Say why it\u2019s being sent back'); return; }
        const { error } = await db.rpc('payroll_run_send_back', { p_run:r.id, p_reason:why.trim() }); if(error) throw error;
        toast('Sent back');
      }
      if(act === 'approve'){
        if(!(await staffApprovalPrecheck('fin.payroll_approve', Number(r.total_net), r.computed_by))) return;
        if(!await uiConfirm('Approve pay for ' + (pr.period && pr.period.label) + '?\n\n' + r.headcount + ' people \u00B7 net pay ' + payPeso(r.total_net) + ' \u00B7 total cost ' + payPeso(r.total_cost) + '.', { ok:'Approve' })) return;
        const { error } = await db.rpc('payroll_run_approve', { p_run:r.id });
        if(error){ if(error.hint === 'reauth_required' && await staffEnsureReauth()){ b.disabled = false; return b.click(); } throw error; }
        toast('Pay run approved');
      }
      if(act === 'release'){
        if(!await uiConfirm('Release this pay run?\n\nDo this once salaries have been paid out. Payslips appear in each person\u2019s My HR, cash advances included are marked settled, and loan balances go down. This can\u2019t be undone.', { ok:'Release' })) return;
        const { data, error } = await db.rpc('payroll_run_release', { p_run:r.id }); if(error) throw error;
        toast('Released' + (data && data.cash_advances_settled ? ' \u2014 ' + data.cash_advances_settled + ' cash advance' + (data.cash_advances_settled === 1 ? '' : 's') + ' settled' : ''));
      }
      if(act === 'delete'){
        if(!await uiConfirm('Delete this pay run?\n\nIts adjustments and computed pay are removed. The timesheets stay locked.')) return;
        const { error } = await db.rpc('payroll_run_delete', { p_run:r.id }); if(error) throw error;
        toast('Pay run deleted'); prShow('list'); prLoadList(); return;
      }
      if(act === 'pdf'){ await prRegisterPdf(); return; }
      if(act === 'xlsx'){ await prRegisterXlsx(); return; }
      prOpenRun(r.id);
    }catch(err){ toast('Couldn\u2019t do that: ' + payDbMsg(err)); }
    finally{ b.disabled = false; }
  });

  async function prCompute(){
    toast('Computing pay\u2026');
    const { data, error } = await db.functions.invoke('payroll-compute', { body:{ runId: pr.run.id } });
    let body = data;
    if(error){
      try{ body = error.context && typeof error.context.json === 'function' ? await error.context.json() : null; }catch(e){ body = null; }
      if(!body){
        const m = String(error.message || '');
        throw new Error(/not found|404|Failed to send/i.test(m) ? 'The payroll-compute function isn\u2019t deployed yet \u2014 run: supabase functions deploy payroll-compute' : m);
      }
    }
    if(body && body.error){
      if(body.errors && body.errors.length){
        $('prErrors').innerHTML = '<div class="pay-banner warn"><b>' + payEsc(body.error) + '</b>' + body.errors.map(x=> '<div>' + payEsc(x.name) + ': ' + payEsc(x.message) + '</div>').join('') + '</div>';
      }
      throw new Error(body.error);
    }
    toast('Computed: ' + (body.people || 0) + ' people, net pay ' + payPeso(body.totalNet));
  }

  // ---------------- payslip PDF ----------------
  async function prPdfBase(title){
    await loadAwesScript('jspdf', awesLibs.jspdf); await loadAwesScript('autotable', awesLibs.autotable);
    await poLoadSettings().catch(()=>{});
    const co = poSettingsData || {}, style = co.header_style || 'green';
    const logo = co.logo_path ? await poLoadImage(co.logo_path).then(img=> poLogoForStyle(img, style)).catch(()=> null) : await poDefaultLogo(style).catch(()=> null);
    const fonts = await poLoadFonts().catch(()=> null);
    return { co, style, logo, fonts };
  }
  function prDocSetup(doc, base){
    let F = 'helvetica', FB = ['helvetica', 'bold'];
    if(base.fonts){ try{
      doc.addFileToVFS('Inter-Regular.ttf', base.fonts.regular); doc.addFont('Inter-Regular.ttf', 'Inter', 'normal');
      doc.addFileToVFS('Inter-Bold.ttf', base.fonts.bold); doc.addFont('Inter-Bold.ttf', 'InterBold', 'normal');
      F = 'Inter'; FB = ['InterBold', 'normal'];
    }catch(e){} }
    return { F, FB, peso: F === 'Inter' ? '\u20B1' : 'PHP ' };
  }
  function prHeader(doc, base, fonts, title, sub){
    const W = doc.internal.pageSize.getWidth(), M = 30, G = [21, 77, 52], green = base.style !== 'white';
    if(green){ doc.setFillColor(...G); doc.rect(0, 0, W, 64, 'F'); } else { doc.setFillColor(...G); doc.rect(0, 61, W, 3, 'F'); }
    if(base.logo && base.logo.w){ const r = Math.min(110 / base.logo.w, 32 / base.logo.h); try{ doc.addImage(base.logo.dataUrl, 'PNG', M, 16, base.logo.w * r, base.logo.h * r, 'pr-logo', 'FAST'); }catch(e){} }
    doc.setTextColor(...(green ? [255, 255, 255] : G));
    doc.setFont(fonts.FB[0], fonts.FB[1]); doc.setFontSize(15); doc.text(title, W - M, 30, { align:'right' });
    doc.setFont(fonts.F, 'normal'); doc.setFontSize(8.5); doc.text(sub, W - M, 46, { align:'right' });
  }
  async function prPayslipPdf(line, per, name){
    try{
      const base = await prPdfBase();
      const { jsPDF } = window.jspdf;
      const doc = new jsPDF({ unit:'pt', format:'a4', compress:true });
      const f = prDocSetup(doc, base);
      const W = doc.internal.pageSize.getWidth(), M = 30, INK = [28, 34, 30], SUB = [96, 108, 101], G = [21, 77, 52], LINE = [216, 223, 219];
      const res = line.result || {}, t = res.totals || {}, b = res.breakdown || {};
      const money = (n)=> f.peso + Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits:2, maximumFractionDigits:2 });
      prHeader(doc, base, f, 'PAYSLIP', (per ? per.label : '') + '   \u2022   ' + (base.co.company_name || ''));
      let y = 88;
      doc.setTextColor(...INK); doc.setFont(f.FB[0], f.FB[1]); doc.setFontSize(12); doc.text(String(name || ''), M, y);
      doc.setFont(f.F, 'normal'); doc.setFontSize(8.5); doc.setTextColor(...SUB);
      const inp = line.input || {}, comp = (inp.employee && inp.employee.compensation) || {};
      doc.text('Pay period ' + (per ? payDate(per.period_start) + ' \u2013 ' + payDate(per.period_end) : '') + '   \u2022   Pay date ' + (per ? payDate(per.pay_date) : '') +
        (comp.rateType ? '   \u2022   ' + (PAY_RATE_TYPE[comp.rateType] || comp.rateType) + ' ' + money(comp.baseRate) : ''), M, y + 14);
      y += 30;
      const qty = (x)=> x.quantity != null && x.unit ? (Number(x.quantity).toLocaleString('en-PH', { maximumFractionDigits:2 }) + ' ' + String(x.unit).toLowerCase() + (x.unit === 'HOURS' || x.unit === 'DAYS' ? '' : '')) : '';
      const earn = (b.earnings || []).map(x=> [x.name + (x.exemptAmount > 0 && x.taxableAmount === 0 ? ' (non-taxable)' : ''), qty(x), money(x.amount)]);
      const ded = [].concat(b.employeeContributions || [], b.withholdingTax ? [b.withholdingTax] : [], b.voluntaryDeductions || []).map(x=> [x.name, '', money(x.amount)]);
      const table = (head, body, total, startY, x, w)=>{
        doc.autoTable({ startY, margin:{ left:x, right:W - x - w }, tableWidth:w,
          head:[head], body: body.length ? body : [['\u2014', '', '']], foot:[total],
          theme:'plain', styles:{ font:f.F, fontSize:8, cellPadding:{ top:3.5, bottom:3.5, left:4, right:4 }, textColor:INK, lineColor:LINE, lineWidth:{ bottom:0.4 } },
          headStyles:{ font:f.F, fillColor:G, textColor:255, fontSize:7.5 }, footStyles:{ font:f.FB[0], fontStyle:'normal', textColor:INK, fillColor:[233, 243, 237] },
          columnStyles:{ 1:{ halign:'right', cellWidth:60 }, 2:{ halign:'right', cellWidth:80 } },
          didParseCell:(c)=>{ if(c.column.index > 0) c.cell.styles.halign = 'right'; } });
        return doc.lastAutoTable.finalY;
      };
      const half = (W - M * 2 - 14) / 2;
      const y1 = table(['EARNINGS', '', 'AMOUNT'], earn, ['Gross pay', '', money(t.grossPay)], y, M, half);
      const y2 = table(['DEDUCTIONS', '', 'AMOUNT'], ded, ['Total deductions', '', money(t.totalDeductions)], y, M + half + 14, half);
      y = Math.max(y1, y2) + 18;
      doc.setFillColor(...G); doc.rect(M, y, W - M * 2, 34, 'F');
      doc.setTextColor(255, 255, 255); doc.setFont(f.FB[0], f.FB[1]); doc.setFontSize(11); doc.text('NET PAY', M + 12, y + 21);
      doc.setFontSize(15); doc.text(money(t.netPay), W - M - 12, y + 22, { align:'right' });
      y += 52;
      doc.setTextColor(...SUB); doc.setFont(f.F, 'normal'); doc.setFontSize(7.5);
      const er = (b.employerContributions || []).map(x=> x.name + ' ' + money(x.amount)).join('   \u2022   ');
      if(er){ doc.text(doc.splitTextToSize('Employer contributions (not deducted from your pay): ' + er, W - M * 2), M, y); y += 20; }
      doc.text('Taxable income this period ' + money(t.taxableIncome) + '   \u2022   Non-taxable earnings ' + money(t.nonTaxableEarnings) + (Number(t.deferredDeductions) ? '   \u2022   Carried to next pay ' + money(t.deferredDeductions) : ''), M, y); y += 12;
      doc.text('Rules: ' + (res.ruleVersionId || ''), M, y);
      doc.text('This payslip was generated by the AWES App.', M, doc.internal.pageSize.getHeight() - 20);
      await openFileInPdfViewer(doc, 'Payslip-' + String(name || '').replace(/[^A-Za-z0-9]+/g, '-') + '-' + (per ? per.period_end : '') + '.pdf', 'Payslip \u2014 ' + (name || ''));
    }catch(e){ console.error('payslip pdf', e); toast('Couldn\u2019t build the payslip: ' + (e && e.message ? e.message : e)); }
  }

  // ---------------- register ----------------
  function prRegisterRows(){
    return pr.lines.slice().sort((a, b)=> String(pr.names.get(a.profile_id) || '').localeCompare(String(pr.names.get(b.profile_id) || ''))).map(l=>{
      const t = (l.result && l.result.totals) || {}, c = (l.result && l.result.contributions) || {};
      const ee = (k)=> Number(c[k] && c[k].period && c[k].period.employee) || 0;
      return [pr.names.get(l.profile_id) || '', Number(t.grossPay) || 0, ee('sss'), ee('philhealth'), ee('pagibig'), Number(t.withholdingTax) || 0,
        Number(t.voluntaryDeductions) || 0, Number(t.netPay) || 0, Number(t.employerContributions) || 0];
    });
  }
  const PR_REG_HEAD = ['Employee', 'Gross', 'SSS', 'PhilHealth', 'Pag-IBIG', 'Tax', 'Other deductions', 'Net pay', 'Employer share'];
  async function prRegisterXlsx(){
    try{
      await loadAwesScript('xlsx', awesLibs.xlsx);
      await poLoadSettings().catch(()=>{});
      const rows = prRegisterRows();
      const tot = PR_REG_HEAD.map((h, i)=> i === 0 ? 'Total' : rows.reduce((a, r)=> a + r[i], 0));
      const aoa = [[(poSettingsData && poSettingsData.company_name) || ''], ['Payroll register \u2014 ' + pr.period.label], ['Pay date ' + payDate(pr.period.pay_date) + ' \u00B7 ' + (PR_STATUS[pr.run.status] || '')], [], PR_REG_HEAD].concat(rows, [tot]);
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      ws['!cols'] = PR_REG_HEAD.map((h, i)=> ({ wch: i === 0 ? 28 : 14 }));
      for(let r = 5; r < aoa.length; r++) for(let c = 1; c < PR_REG_HEAD.length; c++){ const cell = ws[XLSX.utils.encode_cell({ r, c })]; if(cell && cell.t === 'n') cell.z = '#,##0.00'; }
      const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Register');
      XLSX.writeFile(wb, 'Payroll-register-' + pr.period.period_end + '.xlsx');
      toast('Excel file downloaded');
    }catch(e){ toast('Couldn\u2019t create the Excel file: ' + (e && e.message ? e.message : e)); }
  }
  async function prRegisterPdf(){
    try{
      const base = await prPdfBase();
      const { jsPDF } = window.jspdf;
      const doc = new jsPDF({ orientation:'l', unit:'pt', format:'a4', compress:true });
      const f = prDocSetup(doc, base);
      const M = 30, G = [21, 77, 52], INK = [28, 34, 30], LINE = [216, 223, 219];
      const money = (n)=> Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits:2, maximumFractionDigits:2 });
      const rows = prRegisterRows();
      const tot = PR_REG_HEAD.map((h, i)=> i === 0 ? 'TOTAL (' + rows.length + ')' : money(rows.reduce((a, r)=> a + r[i], 0)));
      const head = ()=> prHeader(doc, base, f, 'PAYROLL REGISTER', pr.period.label + '   \u2022   pay date ' + payDate(pr.period.pay_date) + '   \u2022   ' + (base.co.company_name || ''));
      head();
      doc.autoTable({ startY:82, margin:{ left:M, right:M, top:78, bottom:40 },
        head:[PR_REG_HEAD.map(h=> h === 'Employee' ? h : h + ' (' + f.peso.trim() + ')')], body: rows.map(r=> r.map((v, i)=> i ? money(v) : v)), foot:[tot],
        theme:'plain', styles:{ font:f.F, fontSize:8, cellPadding:{ top:4, bottom:4, left:4, right:4 }, textColor:INK, lineColor:LINE, lineWidth:{ bottom:0.4 } },
        headStyles:{ font:f.F, fillColor:G, textColor:255, fontSize:7.5 }, footStyles:{ font:f.FB[0], fontStyle:'normal', fillColor:[233, 243, 237], textColor:INK },
        columnStyles: Object.fromEntries(PR_REG_HEAD.map((h, i)=> [i, i ? { halign:'right' } : {}])),
        didParseCell:(c)=>{ if((c.section === 'head' || c.section === 'foot') && c.column.index > 0) c.cell.styles.halign = 'right'; },
        didDrawPage: head });
      const H = doc.internal.pageSize.getHeight(), W = doc.internal.pageSize.getWidth();
      const y = Math.min(doc.lastAutoTable.finalY + 40, H - 60);
      doc.setFont(f.F, 'normal'); doc.setFontSize(8); doc.setTextColor(...INK);
      [['Prepared by', 'computed_by'], ['Approved by', 'approved_by'], ['Released by', 'released_by']].forEach(([l], i)=>{
        const x = M + i * ((W - M * 2) / 3);
        doc.setDrawColor(...LINE); doc.line(x, y, x + 180, y); doc.text(l, x, y + 12);
      });
      await openFileInPdfViewer(doc, 'Payroll-register-' + pr.period.period_end + '.pdf', 'Payroll register \u2014 ' + pr.period.label);
    }catch(e){ console.error('register pdf', e); toast('Couldn\u2019t build the PDF: ' + (e && e.message ? e.message : e)); }
  }

  // ---------------- My Payslips ----------------
  async function prMyPayslipsShow(){
    $('purchasingView').classList.remove('po-wide');
    const box = $('prMyList');
    box.innerHTML = '<div class="empty-state">Loading\u2026</div>';
    if(!(await ensureCloud())){ box.innerHTML = '<div class="empty-state">Not connected.</div>'; return; }
    try{
      const l = await db.from('payroll_lines').select('*').eq('profile_id', currentUser.id).order('pay_date', { ascending:false }).limit(48);
      if(l.error) throw l.error;
      const lines = l.data || [];
      if(!lines.length){ box.innerHTML = '<div class="empty-state">No payslips yet. They appear here once payroll is released.</div>'; return; }
      const runs = await db.from('payroll_runs').select('id, period_id').in('id', lines.map(x=> x.run_id));
      const per = await db.from('payroll_periods').select('*').in('id', (runs.data || []).map(x=> x.period_id));
      const perByRun = new Map((runs.data || []).map(r=> [r.id, (per.data || []).find(p=> p.id === r.period_id)]));
      pr.myLines = lines; pr.myPer = perByRun;
      box.innerHTML = lines.map((x, i)=>{
        const p = perByRun.get(x.run_id);
        return '<div class="sp-row" data-i="' + i + '"><div class="sp-row-top"><div style="min-width:0;"><div class="sp-row-title">' + payEsc(p ? p.label : payDate(x.period_end)) + '</div>' +
          '<div class="sp-row-sub">Paid ' + payEsc(payDate(x.pay_date)) + ' \u00B7 gross ' + payPeso(x.gross) + '</div></div>' +
          '<div class="mt-row-price">' + payPeso(x.net) + '<div class="sp-row-sub">take-home</div></div></div>' +
          '<div class="user-card-actions"><button type="button" class="primary" data-my-slip="1">View payslip</button></div></div>';
      }).join('');
    }catch(e){ box.innerHTML = '<div class="empty-state">' + (prMissing(e) ? 'Payslips aren\u2019t available yet.' : payEsc('Couldn\u2019t load payslips: ' + describeCloudError(e))) + '</div>'; }
  }
  $('prMyList').addEventListener('click', (e)=>{
    const row = e.target.closest('.sp-row');
    if(!row || !e.target.closest('[data-my-slip]')) return;
    const l = pr.myLines[Number(row.dataset.i)];
    prPayslipPdf(l, pr.myPer.get(l.run_id), currentUser.name);
  });

  // ---------------- Payroll Setup › Allowances & loans ----------------
  async function prLoadRecurring(profileId){
    const box = $('payEmpRecurring');
    if(!box) return;
    box.innerHTML = '<div class="empty-state">Loading\u2026</div>';
    const { data, error } = await db.from('payroll_recurring_items').select('*').eq('profile_id', profileId).order('kind').order('code');
    if(error){ box.innerHTML = '<div class="pay-hint">' + (prMissing(error) ? 'Available after migration 20261006_01_payroll_runs.sql.' : payEsc(describeCloudError(error))) + '</div>'; return; }
    const ro = !payCanSetup();
    pr.recur = data || [];
    box.innerHTML = (pr.recur.length ? '<div class="pay-table-wrap"><table class="pay-table"><thead><tr><th>Item</th><th class="num">Each pay run</th><th class="num">Balance</th><th>Dates</th>' + (ro ? '' : '<th></th>') + '</tr></thead><tbody>' +
      pr.recur.map(r=> '<tr data-rec="' + payEsc(r.id) + '"' + (r.is_active ? '' : ' style="opacity:.55;"') + '><td><b>' + payEsc(r.name) + '</b> <span class="pay-muted">' + payEsc(r.code) + '</span><div class="pay-muted">' +
        (r.kind === 'earning' ? 'Earning \u00B7 ' + (r.is_de_minimis ? 'de minimis ' + payEsc(r.de_minimis_code) : r.is_taxable ? 'taxable' : 'not taxable') : 'Deduction \u00B7 ' + payEsc(PR_CATS_DED[r.category] || r.category)) + (r.is_active ? '' : ' \u00B7 stopped') + '</div></td>' +
        '<td class="num">' + (r.kind === 'deduction' ? '\u2212' : '+') + payPeso(r.amount) + '</td><td class="num">' + (r.balance == null ? '\u2013' : payPeso(r.balance)) + '</td>' +
        '<td class="pay-muted">' + payEsc((r.start_date ? 'from ' + payDate(r.start_date) : '') + (r.end_date ? ' until ' + payDate(r.end_date) : '')) + '</td>' +
        (ro ? '' : '<td><button type="button" class="pay-link" data-rec-toggle="1">' + (r.is_active ? 'Stop' : 'Resume') + '</button> <button type="button" class="pay-rm" data-rec-del="1" aria-label="Delete">\u00D7</button></td>') + '</tr>').join('') +
      '</tbody></table></div>' : '<div class="pay-hint">None. Add allowances paid every pay run, or loans deducted until paid off.</div>') +
      (ro ? '' : '<div class="po-grid" style="margin-top:10px;">' +
        payField('po-c3', 'Type', '<select id="prR_kind"><option value="earning">Allowance (+)</option><option value="deduction">Deduction / loan (\u2212)</option></select>') +
        payField('po-c3', 'Name', '<input type="text" id="prR_name" placeholder="e.g. Transportation allowance">') +
        payField('po-c3', 'Each pay run (\u20B1)', '<input type="text" inputmode="decimal" id="prR_amt">') +
        payField('po-c3', 'Tax / balance', '<select id="prR_tax"><option value="taxable">Taxable</option><option value="exempt">Not taxable</option><option value="RICE_SUBSIDY">De minimis: rice</option><option value="LAUNDRY_ALLOWANCE">De minimis: laundry</option><option value="UNIFORM_ALLOWANCE">De minimis: uniform</option></select>' +
          '<input type="text" inputmode="decimal" id="prR_bal" placeholder="Loan balance (\u20B1)" style="display:none;">') +
        payField('po-c3', 'From (optional)', '<input type="date" id="prR_from">') +
        payField('po-c3', 'Until (optional)', '<input type="date" id="prR_to">') +
        '<div class="po-c6" style="align-self:end;"><button type="button" class="btn btn-secondary" id="prR_add" style="width:100%;">+ Add item</button></div></div>');
  }
  document.addEventListener('change', (e)=>{
    if(e.target.id !== 'prR_kind') return;
    const ded = e.target.value === 'deduction';
    $('prR_tax').style.display = ded ? 'none' : ''; $('prR_bal').style.display = ded ? '' : 'none';
  });
  document.addEventListener('click', async (e)=>{
    const box = e.target.closest('#payEmpRecurring');
    if(!box || !pay.editing) return;
    const pid = pay.editing.id;
    if(e.target.id === 'prR_add'){
      const kind = $('prR_kind').value, name = $('prR_name').value.trim(), amt = payNum($('prR_amt').value), tax = $('prR_tax').value;
      if(!name){ toast('Enter a name'); return; }
      if(!(amt > 0)){ toast('Enter the amount per pay run'); return; }
      const bal = $('prR_bal').value.trim() === '' ? null : payNum($('prR_bal').value);
      if(bal != null && !(bal >= 0)){ toast('The balance must be a number'); return; }
      const code = name.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30) || 'ITEM';
      const row = { profile_id:pid, kind, name, code: pr.recur && pr.recur.some(r=> r.code === code) ? code + '_' + (pr.recur.length + 1) : code,
        category: kind === 'earning' ? 'ALLOWANCE' : (bal != null ? 'LOAN' : 'OTHER'), amount:amt,
        is_taxable: kind === 'earning' && tax === 'taxable', is_de_minimis: kind === 'earning' && /^[A-Z_]+$/.test(tax) && tax !== 'taxable' && tax !== 'exempt',
        de_minimis_code: kind === 'earning' && !['taxable', 'exempt'].includes(tax) ? tax : null,
        balance: kind === 'deduction' ? bal : null, start_date: $('prR_from').value || null, end_date: $('prR_to').value || null };
      const { error } = await db.from('payroll_recurring_items').insert(row);
      if(error){ toast('Couldn\u2019t add: ' + payDbMsg(error)); return; }
      toast('Added'); prLoadRecurring(pid); return;
    }
    const tr = e.target.closest('tr[data-rec]');
    if(!tr) return;
    const r = (pr.recur || []).find(x=> x.id === tr.dataset.rec);
    if(e.target.closest('[data-rec-toggle]')){
      const { error } = await db.from('payroll_recurring_items').update({ is_active: !r.is_active }).eq('id', r.id);
      if(error){ toast('Couldn\u2019t save: ' + payDbMsg(error)); return; }
      prLoadRecurring(pid);
    }
    if(e.target.closest('[data-rec-del]')){
      if(!await uiConfirm('Delete \u201C' + r.name + '\u201D? Past payslips keep what was paid.')) return;
      const { error } = await db.from('payroll_recurring_items').delete().eq('id', r.id);
      if(error){ toast('Couldn\u2019t delete: ' + payDbMsg(error)); return; }
      prLoadRecurring(pid);
    }
  });
