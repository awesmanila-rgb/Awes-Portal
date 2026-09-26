  // =====================================================================
  // Inventory — Reports (migration 20260923_09_inventory_reports.sql)
  //
  // Every figure comes from a database function computed from the stock
  // ledger (Philippine-time months). Storekeepers get their own warehouses
  // and quantities only — the functions return NULL for every value, and
  // this screen simply hides value columns when there are none.
  //
  // Each report builds one "model" { title, subtitle, sheets:[{name, head,
  // rows, money[], totalRow}] } that drives the on-screen table, the PDF
  // and the Excel file, so all three always show the same numbers.
  // =====================================================================

  let rpTab = 'balance', rpModel = null, rpProjectsAll = [], rpReorderRows = [];
  const RP_MONTH = (d)=> new Date(String(d).slice(0, 10) + 'T00:00:00').toLocaleDateString('en-PH', { month:'long', year:'numeric' });
  function rpMoney(){ return staffSeesCosts(); }   // Super Admin, or staff with "See peso values"
  function rpMonthRange(){
    const f = $('rpFrom').value, t = $('rpTo').value || f;
    const first = f + '-01';
    const [y, m] = t.split('-').map(Number);
    const last = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);   // last day of the To month
    return { first, last, label: f === t ? RP_MONTH(first) : RP_MONTH(first) + ' – ' + RP_MONTH(t + '-01') };
  }
  const rpItem = (id)=> invX.catById.get(id) || { code:'', name:'(inactive item)', unit:'', category:'' };
  const rpWhCode = (id)=> (invX.whs.find(w=> w.id === id) || {}).code || '';
  function rpPrj(pid, job){
    const p = rpProjectsAll.find(x=> x.id === pid) || invX.projects.find(x=> x.id === pid);
    return [p ? p.project_no + ' ' + p.name : '', job].filter(Boolean).join(' · ') || '—';
  }
  function rpMatchItem(id){
    const m = rpItem(id), cat = $('rpCat').value;
    if(cat && m.category !== cat) return false;
    return true;
  }
  function rpSearchOk(text){
    const words = ($('rpSearch').value || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
    return !words.length || words.every(w=> String(text).toLowerCase().includes(w));
  }

  async function rpShow(){
    if(!(await ensureCloud())){ toast('Not connected'); return; }
    try{
      await invLoadCtx();
      if(rpMoney()){ const r = await db.from('projects').select('id, project_no, name, budget, status'); rpProjectsAll = r.data || []; }
    }catch(e){ purchFail('Couldn\u2019t load inventory: ', e); return; }
    $('purchasingView').classList.add('po-wide');
    if(!$('rpFrom').value){
      const now = poToday().slice(0, 7);
      $('rpFrom').value = now; $('rpTo').value = now;
    }
    const whs = invX.allWh ? invX.whs : invX.mine;
    $('rpWh').innerHTML = (whs.length > 1 ? '<option value="">All warehouses</option>' : '') + whs.map(w=> '<option value="' + escapeHtml(w.id) + '">' + escapeHtml(w.code + ' · ' + w.name) + '</option>').join('');
    if($('rpCat').options.length <= 1) $('rpCat').innerHTML = '<option value="">All categories</option>' + PURCH_CAT_ALL.map(c=> '<option>' + escapeHtml(c) + '</option>').join('');
    rpSetTab(rpTab === 'project' && !rpMoney() ? 'balance' : rpTab);
  }
  function rpSetTab(tab){
    rpTab = tab;
    $$('#rpTabs [data-rp]').forEach(b=> b.classList.toggle('active', b.dataset.rp === tab));
    $$('.rp-filters .rp-f').forEach(f=>{ f.style.display = f.dataset.for.split(' ').includes(tab) ? '' : 'none'; });
    $('rpMakePo').style.display = tab === 'reorder' && (invIsAdmin() || (rpMoney() && can('pur.purchase_orders', 'edit'))) ? '' : 'none';
    rpModel = null;
    $('rpSummary').innerHTML = ''; $('rpCheck').textContent = ''; $('rpCheck').className = 'rp-check';
    $('rpOut').innerHTML = '<div class="empty-state">Choose the options and tap <b>Run Report</b>.</div>';
  }
  $('rpTabs').addEventListener('click', (e)=>{ const b = e.target.closest('[data-rp]'); if(b) rpSetTab(b.dataset.rp); });
  $('rpRun').addEventListener('click', ()=> rpRun());
  $('rpSearch').addEventListener('keydown', (e)=>{ if(e.key === 'Enter') rpRun(); });

  async function rpRun(){
    const btn = $('rpRun'); btn.disabled = true; btn.textContent = 'Running…';
    $('rpOut').innerHTML = '<div class="empty-state">Running…</div>';
    try{
      if(!(await purchEnsureSession())) return;
      const fn = { balance: rpBalance, register: rpRegister, project: rpProjectCost, slow: rpSlow, reorder: rpReorder, unreturned: rpUnreturned }[rpTab];
      rpModel = await fn();
      rpRender(rpModel);
    }catch(e){
      rpModel = null;
      $('rpOut').innerHTML = '<div class="empty-state">' + (invMissingTables(e) || /function .*inv_rpt/.test(describeCloudError(e)) ? 'Run migration 20260923_09_inventory_reports.sql in Supabase first.' : 'Couldn\u2019t run the report: ' + escapeHtml(describeCloudError(e))) + '</div>';
    }finally{ btn.disabled = false; btn.textContent = 'Run Report'; }
  }
  async function rpCall(fn, args){
    const { data, error } = await db.rpc(fn, args);
    if(error) throw error;
    return data || [];
  }

  // ---------- 1. Stock balance: beginning → ending ----------
  async function rpBalance(){
    const r = rpMonthRange(), wh = $('rpWh').value || null;
    const rows = (await rpCall('inv_rpt_balance', { p_from: r.first, p_to: r.last, p_warehouse: wh }))
      .filter(x=> rpMatchItem(x.material_id) && rpSearchOk([rpItem(x.material_id).code, rpItem(x.material_id).name].join(' ')));
    const money = rpMoney() && rows.some(x=> x.end_value != null);
    // With values, every quantity sits right beside its peso amount under
    // one heading (Beginning: Qty | ₱, + Purchased: Qty | ₱ …).
    const MEAS = [['Beginning', 'beg'], ['+ Purchased', 'purch'], ['+ Returned', 'ret'], ['− Issued', 'iss'], ['± Transfers', 'trf'], ['± Adjust.', 'adj'], ['= Ending', 'end']];
    const lead = ['Month', 'Warehouse', 'Code', 'Item', 'Unit'];
    const head = money ? lead.concat(...MEAS.map(()=> ['Qty', '₱'])) : lead.concat(MEAS.map(m=> m[0]));
    const headGroups = money ? [['', lead.length]].concat(MEAS.map(m=> [m[0], 2])) : null;
    const moneyCols = money ? MEAS.map((m, i)=> lead.length + i * 2 + 1) : null;
    const sorted = rows.slice().sort((a, b)=> a.month.localeCompare(b.month) || rpWhCode(a.warehouse_id).localeCompare(rpWhCode(b.warehouse_id)) || rpItem(a.material_id).name.localeCompare(rpItem(b.material_id).name, undefined, { numeric:true }));
    const out = sorted.map(x=>{
      const m = rpItem(x.material_id);
      const cells = money ? [].concat(...MEAS.map(([, k])=> [+x[k + '_qty'], +x[k + '_value']])) : MEAS.map(([, k])=> +x[k + '_qty']);
      return [RP_MONTH(x.month), rpWhCode(x.warehouse_id), m.code, m.name, m.unit].concat(cells);
    });
    // month totals (values only — adding feet to kilograms means nothing)
    const months = Array.from(new Set(sorted.map(x=> x.month)));
    const totals = months.map(mo=>{
      const rs = sorted.filter(x=> x.month === mo);
      const sum = (k)=> rs.reduce((a, x)=> a + Number(x[k] || 0), 0);
      return { month: mo, beg: sum('beg_value'), purch: sum('purch_value'), ret: sum('ret_value'), iss: sum('iss_value'), trf: sum('trf_value'), adj: sum('adj_value'), end: sum('end_value') };
    });
    // reconciliation: the To month's ending vs Stock on Hand now (only
    // meaningful when the report runs up to the current month)
    let check = null;
    if(r.last.slice(0, 7) === poToday().slice(0, 7)){
      const last = sorted.filter(x=> x.month.slice(0, 7) === r.last.slice(0, 7));
      const bad = last.filter(x=> Math.abs(Number(x.end_qty) - invAvail(x.warehouse_id, x.material_id)) > 0.0005);
      const onhandOnly = Array.from(invX.avail.entries()).filter(([k, q])=>{
        const [w, m] = k.split('|');
        return q > 0 && (!wh || w === wh) && rpMatchItem(m) && !last.some(x=> x.warehouse_id === w && x.material_id === m);
      });
      check = (bad.length || onhandOnly.length)
        ? { ok:false, text: '⚠ ' + (bad.length + onhandOnly.length) + ' item(s) don\u2019t tie to Stock on Hand — ' + bad.concat(onhandOnly.map(([k])=> ({ material_id:k.split('|')[1] }))).slice(0, 4).map(x=> rpItem(x.material_id).code).join(', ') }
        : { ok:true, text: '✓ This month\u2019s ending balances tie to Stock on Hand' + (search() ? ' (for the items shown)' : '') + '.' };
    }
    function search(){ return ($('rpSearch').value || '').trim() || $('rpCat').value; }
    const lastT = totals[totals.length - 1];
    return {
      title: 'Monthly Stock Balance', subtitle: r.label + ' · ' + (wh ? rpWhCode(wh) : 'All warehouses'),
      summary: money && lastT ? [['Beginning value', invMoney(totals[0].beg)], ['Purchased', invMoney(totals.reduce((a, t)=> a + t.purch, 0))],
        ['Issued', invMoney(totals.reduce((a, t)=> a + t.iss, 0))], ['Ending value', invMoney(lastT.end)]]
        : [['Items', String(new Set(sorted.map(x=> x.material_id)).size)], ['Months', String(months.length)]],
      check,
      sheets: [{ name:'Stock Balance', head, headGroups, rows: out, groupCol: 0, numFrom: 5, moneyCols,
        // month totals: pesos only (feet + kilograms can't be added), each under its own ₱ column
        groupTotals: money ? Object.fromEntries(totals.map(t=> [RP_MONTH(t.month),
          ['', '', '', 'Month total', ''].concat(...['beg', 'purch', 'ret', 'iss', 'trf', 'adj', 'end'].map(k=> ['', t[k]]))])) : null,
        landscape: true }]
    };
  }

  // ---------- 2. Purchases, issuances & returns ----------
  async function rpRegister(){
    const r = rpMonthRange(), wh = $('rpWh').value || null, kind = $('rpKind').value, view = $('rpRegView').value;
    const lines = (await rpCall('inv_rpt_register', { p_from: r.first, p_to: r.last, p_warehouse: wh }))
      .filter(x=> (!kind || x.kind === kind) && rpMatchItem(x.material_id) &&
        rpSearchOk([rpItem(x.material_id).code, rpItem(x.material_id).name, x.doc_ref, x.worker_name, x.supplier, x.po_no, rpPrj(x.project_id, x.job_order_id)].join(' ')));
    const money = rpMoney() && lines.some(x=> x.value != null);
    const K = { purchase:'Purchase', issue:'Issue', 'return':'Return' };
    const tot = (k, f)=> lines.filter(x=> x.kind === k && (!f || f(x))).reduce((a, x)=> a + Number(x.value || 0), 0);
    const summary = money ? [['Purchased', invMoney(tot('purchase'))], ['Issued', invMoney(tot('issue'))], ['Returned (good)', invMoney(tot('return', x=> x.condition === 'good'))],
      ['Net issued', invMoney(tot('issue') - tot('return', x=> x.condition === 'good'))]]
      : [['Lines', String(lines.length)], ['Purchases', String(lines.filter(x=> x.kind === 'purchase').length)], ['Issues', String(lines.filter(x=> x.kind === 'issue').length)], ['Returns', String(lines.filter(x=> x.kind === 'return').length)]];
    const sheets = [];
    // per item
    const byItem = new Map();
    lines.forEach(x=>{
      const e = byItem.get(x.material_id) || { p:0, pv:0, i:0, iv:0, rg:0, rv:0, rd:0 };
      const q = Number(x.qty), v = Number(x.value || 0);
      if(x.kind === 'purchase'){ e.p += q; e.pv += v; }
      else if(x.kind === 'issue'){ e.i += q; e.iv += v; }
      else if(x.condition === 'damaged') e.rd += q; else { e.rg += q; e.rv += v; }
      byItem.set(x.material_id, e);
    });
    const itemRows = Array.from(byItem.entries()).sort((a, b)=> rpItem(a[0]).name.localeCompare(rpItem(b[0]).name, undefined, { numeric:true })).map(([id, e])=>{
      const m = rpItem(id);
      return [m.code, m.name, m.unit, e.p, e.i, e.rg, e.rd, e.i - e.rg].concat(money ? [e.pv, e.iv, e.rv, e.iv - e.rv] : []);
    });
    const itemTot = money ? ['', 'Total', '', '', '', '', '', ''].concat([itemRows.reduce((a, r)=> a + r[8], 0), itemRows.reduce((a, r)=> a + r[9], 0), itemRows.reduce((a, r)=> a + r[10], 0), itemRows.reduce((a, r)=> a + r[11], 0)]) : null;
    if(view === 'summary'){
      sheets.push({ name:'By Item', head:['Code', 'Item', 'Unit', 'Purchased', 'Issued', 'Returned (good)', 'Returned (damaged)', 'Net issued'].concat(money ? ['Purchased ₱', 'Issued ₱', 'Returned ₱', 'Net issued ₱'] : []),
        rows:itemRows, numFrom:3, moneyFrom: money ? 8 : null, totalRow:itemTot, landscape:true });
      // by project / job
      const group = (keyFn, labelFn, filter)=>{
        const g = new Map();
        lines.filter(filter).forEach(x=>{ const k = keyFn(x); const e = g.get(k) || { label: labelFn(x), n:0, v:0, q:0 }; e.n++; e.v += Number(x.value || 0) * (x.kind === 'return' ? -1 : 1); g.set(k, e); });
        return Array.from(g.values()).sort((a, b)=> b.v - a.v || a.label.localeCompare(b.label));
      };
      const prj = group(x=> (x.project_id || '') + '|' + (x.job_order_id || ''), x=> rpPrj(x.project_id, x.job_order_id), x=> x.kind !== 'purchase' && (x.project_id || x.job_order_id) && x.condition !== 'damaged');
      if(prj.length) sheets.push({ name:'By Project', head:['Project / job order', 'Lines'].concat(money ? ['Net material cost ₱'] : []), rows: prj.map(e=> [e.label, e.n].concat(money ? [e.v] : [])), numFrom:1, moneyFrom: money ? 2 : null });
      const wk = group(x=> x.worker_name || '—', x=> x.worker_name || '—', x=> x.kind !== 'purchase' && x.condition !== 'damaged');
      if(wk.length) sheets.push({ name:'By Worker', head:['Worker', 'Lines'].concat(money ? ['Net issued ₱'] : []), rows: wk.map(e=> [e.label, e.n].concat(money ? [e.v] : [])), numFrom:1, moneyFrom: money ? 2 : null });
      const sp = group(x=> x.supplier || '—', x=> x.supplier || 'No supplier', x=> x.kind === 'purchase');
      if(sp.length) sheets.push({ name:'By Supplier', head:['Supplier', 'Lines'].concat(money ? ['Purchased ₱'] : []), rows: sp.map(e=> [e.label, e.n].concat(money ? [e.v] : [])), numFrom:1, moneyFrom: money ? 2 : null });
    }
    // detail (always included in Excel; shown on screen in Detail view)
    const detail = lines.map(x=>{
      const m = rpItem(x.material_id);
      return [mrWhen(x.at), K[x.kind] + (x.condition === 'damaged' ? ' (damaged)' : ''), x.doc_ref, rpWhCode(x.warehouse_id), m.code, m.name, Number(x.qty), m.unit,
        x.kind === 'purchase' ? [x.supplier, x.po_no].filter(Boolean).join(' · ') : (x.worker_name || ''), rpPrj(x.project_id, x.job_order_id), x.note || '']
        .concat(money ? [x.unit_cost != null ? Number(x.unit_cost) : '', x.value != null ? Number(x.value) : ''] : []);
    });
    const detailSheet = { name:'Detail', head:['Date', 'Type', 'Slip no.', 'Warehouse', 'Code', 'Item', 'Qty', 'Unit', 'Supplier / worker', 'Project / job', 'Note'].concat(money ? ['Unit cost ₱', 'Value ₱'] : []),
      rows: detail, numCols:[6], moneyFrom: money ? 11 : null, landscape:true };
    if(view === 'detail') sheets.unshift(detailSheet);
    else{ detailSheet.excelOnly = true; sheets.push(detailSheet); }   // Summary on screen/PDF; Excel gets the detail too
    return { title: 'Purchases, Issuances & Returns', subtitle: r.label + ' · ' + (wh ? rpWhCode(wh) : 'All warehouses') + (kind ? ' · ' + K[kind] + 's only' : ''), summary, sheets };
  }

  // ---------- 3. Project cost by month (admin) ----------
  async function rpProjectCost(){
    const r = rpMonthRange();
    const rows = await rpCall('inv_rpt_project_cost', { p_from: r.first, p_to: r.last });
    const months = [];
    for(let d = new Date(r.first + 'T00:00:00'); d <= new Date(r.last + 'T00:00:00'); d.setMonth(d.getMonth() + 1)) months.push(d.toISOString().slice(0, 7));
    const ids = Array.from(new Set(rows.map(x=> x.project_id)));
    const out = ids.map(pid=>{
      const p = rpProjectsAll.find(x=> x.id === pid) || { project_no:'?', name:'', budget:null };
      const per = months.map(mo=> rows.filter(x=> x.project_id === pid && String(x.month).slice(0, 7) === mo).reduce((a, x)=> a + Number(x.cost), 0));
      const toDate = rows.filter(x=> x.project_id === pid).reduce((a, x)=> a + Number(x.cost), 0);
      const inRange = per.reduce((a, v)=> a + v, 0);
      const budget = p.budget != null ? Number(p.budget) : null;
      return [p.project_no, p.name].concat(per, [inRange, toDate, budget != null ? budget : '', budget ? Math.round(toDate / budget * 1000) / 10 : '']);
    }).sort((a, b)=> b[2 + months.length + 1] - a[2 + months.length + 1]);
    const monthHeads = months.map(mo=> new Date(mo + '-01T00:00:00').toLocaleDateString('en-PH', { month:'short', year:'2-digit' }) + ' ₱');
    const flagged = out.filter(r=> r[r.length - 1] !== '' && r[r.length - 1] >= 80);
    return {
      title: 'Project Material Cost by Month', subtitle: r.label,
      summary: [['Projects', String(out.length)], ['Cost in period', invMoney(out.reduce((a, r)=> a + r[2 + months.length], 0))], ['At / over 80% of budget', String(flagged.length)]],
      sheets: [{ name:'Project Cost', head:['Project', 'Name'].concat(monthHeads, ['In period ₱', 'To date ₱', 'Budget ₱', '% of budget']), rows: out,
        moneyFrom: 2, moneyTo: 2 + months.length + 2, pctCol: 2 + months.length + 3, flagRow: (row)=> row[row.length - 1] !== '' && row[row.length - 1] >= 80, landscape: months.length > 3 }]
    };
  }

  // ---------- 4. Slow-moving / dead stock ----------
  async function rpSlow(){
    const days = Number($('rpDays').value), wh = $('rpWh').value;
    const rows = (await rpCall('inv_rpt_slow_moving', {}))
      .filter(x=> x.days_idle >= days && (!wh || x.warehouse_id === wh) && rpMatchItem(x.material_id) && rpSearchOk([rpItem(x.material_id).code, rpItem(x.material_id).name].join(' ')))
      .sort((a, b)=> b.days_idle - a.days_idle);
    const money = rpMoney() && rows.some(x=> x.value != null);
    const tied = rows.reduce((a, x)=> a + Number(x.value || 0), 0);
    return {
      title: 'Slow-Moving & Dead Stock', subtitle: 'Not issued for ' + days + '+ days · as of ' + poDateLong(poToday()),
      summary: [['Items', String(rows.length)]].concat(money ? [['Value tied up', invMoney(tied)]] : []).concat([['180+ days (dead)', String(rows.filter(x=> x.days_idle >= 180).length)]]),
      sheets: [{ name:'Slow-Moving', head:['Warehouse', 'Code', 'Item', 'On hand', 'Unit', 'Last issued', 'Days idle'].concat(money ? ['Value ₱'] : []),
        rows: rows.map(x=>{ const m = rpItem(x.material_id); return [rpWhCode(x.warehouse_id), m.code, m.name, Number(x.qty_on_hand), m.unit, x.last_out ? poDateLong(x.last_out) : 'never', x.days_idle].concat(money ? [Number(x.value)] : []); }),
        numCols:[3, 6], moneyFrom: money ? 7 : null, flagRow:(row)=> row[6] >= 180, totalRow: money ? ['', '', 'Total', '', '', '', '', tied] : null }]
    };
  }

  // ---------- 5. Reorder suggestions ----------
  async function rpReorder(){
    const win = Number($('rpWindow').value);
    const rows = (await rpCall('inv_rpt_reorder', { p_days: win }))
      .filter(x=> rpMatchItem(x.material_id) && rpSearchOk([rpItem(x.material_id).code, rpItem(x.material_id).name, x.supplier].join(' ')))
      .sort((a, b)=> (b.reorder ? 1 : 0) - (a.reorder ? 1 : 0) || Number(a.months_cover == null ? 999 : a.months_cover) - Number(b.months_cover == null ? 999 : b.months_cover));
    rpReorderRows = rows;
    const money = rpMoney();
    const need = rows.filter(x=> x.reorder);
    return {
      title: 'Reorder Suggestions', subtitle: 'Usage over the last ' + win + ' days · as of ' + poDateLong(poToday()),
      summary: [['To reorder', String(need.length)], ['Tracked items', String(rows.length)]].concat(money ? [['Est. order value', invMoney(need.reduce((a, x)=> a + Number(x.suggested_qty) * Number(x.unit_price || 0), 0))]] : []),
      note: 'Reorder when stock covers less than the supplier\u2019s lead time + ½ month; the suggestion tops it up to lead time + 1 month. Lead time comes from the preferred supplier\u2019s price list (7 days if not set).',
      sheets: [{ name:'Reorder', head:(money ? ['✓'] : []).concat(['Code', 'Item', 'On hand', 'Unit', 'Used / month', 'Months left', 'Lead (days)', 'Suggested qty']).concat(money ? ['Supplier', 'Unit price ₱', 'Est. value ₱'] : []),
        rows: rows.map(x=>{ const m = rpItem(x.material_id);
          return (money ? [x.reorder ? '☐' : ''] : []).concat([m.code, m.name, Number(x.on_hand), m.unit, Number(x.usage_per_month), x.months_cover != null ? Number(x.months_cover) : '—', x.lead_days, Number(x.suggested_qty)])
            .concat(money ? [x.supplier || '—', x.unit_price != null ? Number(x.unit_price) : '', x.unit_price != null ? Number(x.suggested_qty) * Number(x.unit_price) : ''] : []); }),
        numCols: money ? [3, 5, 6, 7, 8] : [2, 4, 5, 6, 7], moneyFrom: money ? 10 : null, flagRow:(row, i)=> rows[i].reorder, selectable: money }]
    };
  }

  // ---------- 6. Unreturned by worker ----------
  async function rpUnreturned(){
    const minDays = Number($('rpHeld').value), wh = $('rpWh').value;
    const rows = (await rpCall('inv_rpt_unreturned', {}))
      .filter(x=> x.days_held >= minDays && (!wh || x.warehouse_id === wh) && rpSearchOk([x.worker_name, rpItem(x.material_id).code, rpItem(x.material_id).name, rpPrj(x.project_id, x.job_order_id)].join(' ')))
      .sort((a, b)=> String(a.worker_name).localeCompare(String(b.worker_name)) || b.days_held - a.days_held);
    const money = rpMoney() && rows.some(x=> x.value != null);
    return {
      title: 'Unreturned Materials by Worker', subtitle: (minDays ? 'Held ' + minDays + '+ days' : 'All held materials') + ' · as of ' + poDateLong(poToday()),
      summary: [['Workers', String(new Set(rows.map(x=> x.worker_id)).size)], ['Lines', String(rows.length)]].concat(money ? [['Value held', invMoney(rows.reduce((a, x)=> a + Number(x.value || 0), 0))]] : []),
      sheets: [{ name:'Unreturned', head:['Worker', 'Code', 'Item', 'Holding', 'Unit', 'Project / job', 'Since', 'Days'].concat(money ? ['Value ₱'] : []),
        rows: rows.map(x=>{ const m = rpItem(x.material_id); return [x.worker_name, m.code, m.name, Number(x.holding), m.unit, rpPrj(x.project_id, x.job_order_id), poDateLong(x.oldest), x.days_held].concat(money ? [Number(x.value || 0)] : []); }),
        groupCol: 0, numCols:[3, 7], moneyFrom: money ? 8 : null, flagRow:(row)=> row[7] >= 60 }]
    };
  }

  // ---------- on-screen rendering ----------
  function rpIsMoney(sheet, ci){
    if(sheet.moneyCols) return sheet.moneyCols.includes(ci);
    return sheet.moneyFrom != null && ci >= sheet.moneyFrom && (sheet.moneyTo == null || ci <= sheet.moneyTo);
  }
  function rpFmt(v, sheet, ci){
    if(v === '' || v == null) return '';
    const isMoney = rpIsMoney(sheet, ci);
    if(ci === sheet.pctCol) return typeof v === 'number' ? v.toFixed(1) + '%' : v;
    if(typeof v === 'number') return isMoney ? poFmt(v) : invQty(v);
    return escapeHtml(v);
  }
  function rpIsNum(sheet, ci){
    return (sheet.numFrom != null && ci >= sheet.numFrom) || (sheet.numCols || []).includes(ci) || rpIsMoney(sheet, ci) || ci === sheet.pctCol;
  }
  // pre: element-id prefix, so other report pages (Tool Reports: 'tr') can
  // reuse the same renderer, PDF and Excel export
  function rpRender(model, pre){
    pre = pre || 'rp';
    $(pre + 'Summary').innerHTML = (model.summary || []).map(([k, v])=> '<div class="tile"><div class="k">' + escapeHtml(k) + '</div><div class="v">' + escapeHtml(v) + '</div></div>').join('');
    const c = $(pre + 'Check');
    c.textContent = model.check ? model.check.text : (model.note || '');
    c.className = 'rp-check' + (model.check ? (model.check.ok ? ' ok' : ' bad') : '');
    $(pre + 'Out').innerHTML = model.sheets.filter(s=> !s.excelOnly).map((sh, si)=>{
      if(!sh.rows.length) return (si ? '<div class="rp-sub">' + escapeHtml(sh.name) + '</div>' : '') + '<div class="empty-state">No data for these options.</div>';
      let body = '', lastGroup = null;
      sh.rows.forEach((row, ri)=>{
        if(sh.groupCol != null && row[sh.groupCol] !== lastGroup){
          if(lastGroup != null && sh.groupTotals && sh.groupTotals[lastGroup]) body += rpTotalRow(sh.groupTotals[lastGroup], sh);
          lastGroup = row[sh.groupCol];
          body += '<tr class="rp-month"><td colspan="' + (sh.head.length - (sh.groupCol != null ? 1 : 0)) + '">' + escapeHtml(lastGroup) + '</td></tr>';
        }
        const flag = sh.flagRow && sh.flagRow(row, ri);
        body += '<tr' + (flag ? ' class="rp-flag"' : '') + ' data-ri="' + ri + '">' + row.map((v, ci)=>{
          if(ci === sh.groupCol) return '';
          if(sh.selectable && ci === 0) return '<td>' + (v ? '<input type="checkbox" class="rp-sel" checked>' : '') + '</td>';
          return '<td class="' + (rpIsNum(sh, ci) ? 'num' : '') + (rpPairStart(sh, ci) ? ' pair' : '') + '">' + rpFmt(v, sh, ci) + '</td>';
        }).join('') + '</tr>';
      });
      if(lastGroup != null && sh.groupTotals && sh.groupTotals[lastGroup]) body += rpTotalRow(sh.groupTotals[lastGroup], sh);
      if(sh.totalRow) body += rpTotalRow(sh.totalRow, sh);
      return (si ? '<div class="rp-sub">' + escapeHtml(sh.name) + '</div>' : '') +
        '<div class="sp-table-wrap"><table class="sp-table rp-table"><thead>' + (sh.headGroups ? '<tr class="rp-hgroup">' + rpGroupSpans(sh).map(([l, n])=>
          '<th colspan="' + n + '"' + (l ? ' class="grp"' : '') + '>' + escapeHtml(l) + '</th>').join('') + '</tr>' : '') + '<tr>' + sh.head.map((h, ci)=> ci === sh.groupCol ? '' : '<th class="' + (rpIsNum(sh, ci) ? 'num' : '') + (rpPairStart(sh, ci) ? ' pair' : '') + '">' + escapeHtml(h) + '</th>').join('') + '</tr></thead><tbody>' + body + '</tbody></table></div>';
    }).join('');
  }
  const rpPairStart = (sh, ci)=> !!(sh.headGroups && sh.moneyCols && sh.moneyCols.includes(ci + 1));
  // heading spans with the hidden group column (e.g. Month) taken out
  function rpGroupSpans(sh){
    let ci = 0;
    return sh.headGroups.map(([l, n])=>{
      const hide = sh.groupCol != null && sh.groupCol >= ci && sh.groupCol < ci + n ? 1 : 0;
      ci += n;
      return [l, n - hide];
    }).filter(([, n])=> n > 0);
  }
  function rpTotalRow(row, sh){ return '<tr class="rp-total">' + row.map((v, ci)=> ci === sh.groupCol ? '' : '<td class="' + (rpIsNum(sh, ci) ? 'num' : '') + (rpPairStart(sh, ci) ? ' pair' : '') + '">' + rpFmt(v, sh, ci) + '</td>').join('') + '</tr>'; }

  // ---------- Excel ----------
  $('rpXlsx').addEventListener('click', ()=> rpExportXlsx(rpModel, $('rpFrom').value));
  async function rpExportXlsx(rpModel, tag){
    if(!rpModel){ toast('Run the report first'); return; }
    try{
      await loadAwesScript('xlsx', awesLibs.xlsx);
      const wb = XLSX.utils.book_new();
      const co = (poSettingsData && poSettingsData.company_name) || 'AW Engineering Services';
      rpModel.sheets.forEach(sh=>{
        const rows = sh.rows.map(r=> r.map((v, ci)=> sh.selectable && ci === 0 ? (v ? 'reorder' : '') : v));
        const band = sh.headGroups ? [[].concat(...sh.headGroups.map(([l, n])=> [l].concat(Array(n - 1).fill(''))))] : [];
        const aoa = [[co], [rpModel.title], [rpModel.subtitle], []].concat(band, [sh.head], rows);
        if(sh.totalRow) aoa.push(sh.totalRow);
        const ws = XLSX.utils.aoa_to_sheet(aoa);
        if(sh.headGroups){
          let c = 0; ws['!merges'] = [];
          sh.headGroups.forEach(([l, n])=>{ if(n > 1 && l) ws['!merges'].push({ s:{ r:4, c }, e:{ r:4, c: c + n - 1 } }); c += n; });
        }
        ws['!cols'] = sh.head.map((h, ci)=> ({ wch: Math.min(48, Math.max(String(h).length + 2, ...rows.slice(0, 200).map(r=> String(r[ci] == null ? '' : r[ci]).length + 1))) }));
        // number formats: money with 2 decimals, quantities up to 3
        const first = 5 + band.length;   // column headings on row 5 (6 with a heading band) → data after
        for(let ri = 0; ri < rows.length + (sh.totalRow ? 1 : 0); ri++){
          sh.head.forEach((h, ci)=>{
            const cell = ws[XLSX.utils.encode_cell({ r: first + ri, c: ci })];
            if(!cell || cell.t !== 'n') return;
            cell.z = ci === sh.pctCol ? '0.0"%"' : rpIsMoney(sh, ci) ? '#,##0.00' : '#,##0.###';
          });
        }
        XLSX.utils.book_append_sheet(wb, ws, sh.name.slice(0, 31));
      });
      const name = rpModel.title.replace(/[^A-Za-z0-9]+/g, '-').replace(/-+$/, '') + '-' + (tag || poToday().slice(0, 7)) + '.xlsx';
      XLSX.writeFile(wb, name);
      toast('Excel file downloaded');
    }catch(e){ console.error('xlsx failed', e); toast('Couldn\u2019t create the Excel file: ' + (e && e.message ? e.message : e)); }
  }

  // ---------- PDF ----------
  $('rpPdf').addEventListener('click', ()=> rpExportPdf(rpModel, $('rpFrom').value));
  async function rpExportPdf(rpModel, tag){
    if(!rpModel){ toast('Run the report first'); return; }
    try{
      await loadAwesScript('jspdf', awesLibs.jspdf); await loadAwesScript('autotable', awesLibs.autotable);
      await poLoadSettings().catch(()=>{});
      const co = poSettingsData || {}, style = co.header_style || 'green';
      const logo = co.logo_path ? await poLoadImage(co.logo_path).then(img=> poLogoForStyle(img, style)) : await poDefaultLogo(style);
      const fonts = await poLoadFonts();
      const land = rpModel.sheets.some(s=> s.landscape && !s.excelOnly);
      const { jsPDF } = window.jspdf;
      const doc = new jsPDF({ orientation: land ? 'l' : 'p', unit:'pt', format:'a4', compress:true });
      let F = 'helvetica', FS = ['helvetica', 'bold'], FB = ['helvetica', 'bold'];
      if(fonts){ try{
        doc.addFileToVFS('Inter-Regular.ttf', fonts.regular); doc.addFont('Inter-Regular.ttf', 'Inter', 'normal');
        doc.addFileToVFS('Inter-SemiBold.ttf', fonts.semibold); doc.addFont('Inter-SemiBold.ttf', 'Inter', 'bold');
        doc.addFileToVFS('Inter-Bold.ttf', fonts.bold); doc.addFont('Inter-Bold.ttf', 'InterBold', 'normal');
        F = 'Inter'; FS = ['Inter', 'bold']; FB = ['InterBold', 'normal'];
      }catch(e){} }
      const peso = F === 'Inter' ? '\u20B1' : 'PHP ';
      const W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight(), M = 30;
      const G = [21, 77, 52], SUB = [96, 108, 101], INK = [28, 34, 30], LINE = [216, 223, 219];
      const green = style !== 'white';
      const header = ()=>{
        if(green){ doc.setFillColor(...G); doc.rect(0, 0, W, 64, 'F'); } else { doc.setFillColor(...G); doc.rect(0, 61, W, 3, 'F'); }
        if(logo && logo.w){ const r = Math.min(110 / logo.w, 32 / logo.h); try{ doc.addImage(logo.dataUrl, 'PNG', M, 16, logo.w * r, logo.h * r, 'rp-logo', 'FAST'); }catch(e){} }
        doc.setTextColor(...(green ? [255, 255, 255] : G));
        doc.setFont(FB[0], FB[1]); doc.setFontSize(15); doc.text(rpModel.title.toUpperCase(), W - M, 30, { align:'right' });
        doc.setFont(F, 'normal'); doc.setFontSize(8.5); doc.text(rpModel.subtitle + '   •   ' + (co.company_name || ''), W - M, 46, { align:'right' });
      };
      header();
      let y = 82;
      if(rpModel.summary && rpModel.summary.length){
        doc.setFont(F, 'normal'); doc.setFontSize(8.5); doc.setTextColor(...INK);
        doc.text(rpModel.summary.map(([k, v])=> k + ': ' + String(v).replace('₱', peso)).join('     '), M, y); y += 12;
      }
      const note = rpModel.check ? rpModel.check.text.replace('✓', '').replace('⚠', '!') : rpModel.note;
      if(note){ doc.setFontSize(7.5); doc.setTextColor(...SUB); doc.text(doc.splitTextToSize(note, W - M * 2), M, y); y += 14; }
      rpModel.sheets.filter(s=> !s.excelOnly).forEach((sh, si)=>{
        if(si){ doc.setFont(FS[0], FS[1]); doc.setFontSize(9); doc.setTextColor(...G); if(y > H - 90){ doc.addPage(); header(); y = 82; } doc.text(sh.name.toUpperCase(), M, y + 4); y += 10; }
        const txt = (v, ci)=>{ const t = rpFmt(v, sh, ci); return typeof t === 'string' ? t.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'") : t; };
        const body = [];
        let last = null;
        sh.rows.forEach(row=>{
          if(sh.groupCol != null && row[sh.groupCol] !== last){
            if(last != null && sh.groupTotals && sh.groupTotals[last]) body.push({ total:true, cells: sh.groupTotals[last] });
            last = row[sh.groupCol];
            body.push({ group:true, cells:[last] });
          }
          body.push({ cells: row });
        });
        if(last != null && sh.groupTotals && sh.groupTotals[last]) body.push({ total:true, cells: sh.groupTotals[last] });
        if(sh.totalRow) body.push({ total:true, cells: sh.totalRow });
        const cols = sh.head.map((h, ci)=> ci).filter(ci=> !(sh.selectable && ci === 0) && ci !== sh.groupCol);
        doc.autoTable({
          startY: y + 4, margin:{ left:M, right:M, top:78, bottom:36 },
          head: (sh.headGroups ? [rpGroupSpans(sh).map(([l, n])=> ({ content: l, colSpan: n, styles:{ halign:'center', fillColor: l ? [31, 122, 80] : G } }))] : [])
            .concat([cols.map(ci=> sh.head[ci].replace('₱', peso))]),
          body: body.map(b=> b.group ? [{ content: String(b.cells[0]).toUpperCase(), colSpan: cols.length, styles:{ fillColor:[233, 243, 237], textColor:G, fontStyle:'bold', fontSize:7.5 } }]
            : cols.map(ci=> ({ content: txt(b.cells[ci], ci), styles: b.total ? { fontStyle:'bold' } : {} }))),
          theme:'plain',
          styles:{ font:F, fontSize: cols.length > 14 ? 6.4 : cols.length > 10 ? 7 : 8, cellPadding:{ top:3.5, bottom:3.5, left:4, right:4 }, textColor:INK, lineColor:LINE, lineWidth:{ bottom:0.4 } },
          headStyles:{ font:F, fontStyle:'bold', fillColor:G, textColor:255, fontSize: cols.length > 14 ? 6.2 : 7 },
          columnStyles: Object.fromEntries(cols.map((ci, i)=> [i, rpIsNum(sh, ci) ? { halign:'right' } : {}])),
          // column labels line up with their numbers (right-aligned)
          didParseCell: (c)=>{
            if(c.section === 'head' && c.row.index === (sh.headGroups ? 1 : 0) && rpIsNum(sh, cols[c.column.index])) c.cell.styles.halign = 'right';
          },
          didDrawCell: (c)=>{
            if(c.section === 'head' && c.row.index === 0) return;
            const ci = cols[c.column.index];
            if(ci != null && rpPairStart(sh, ci)){ doc.setDrawColor(200, 210, 204); doc.setLineWidth(0.5); doc.line(c.cell.x, c.cell.y, c.cell.x, c.cell.y + c.cell.height); }
          },
          didDrawPage: ()=>{ header(); }
        });
        y = doc.lastAutoTable.finalY + 16;
      });
      const pages = doc.internal.getNumberOfPages();
      for(let p = 1; p <= pages; p++){ doc.setPage(p); doc.setFont(F, 'normal'); doc.setFontSize(7); doc.setTextColor(...SUB);
        doc.text('Generated ' + new Date().toLocaleString('en-PH') + (rpMoney() ? '' : ' · quantities only'), M, H - 16); doc.text('Page ' + p + ' of ' + pages, W - M, H - 16, { align:'right' }); }
      const title = rpModel.title;
      $('previewOverlay').querySelector('h3').textContent = title;
      $('previewOkBtn').textContent = 'Close';
      $('previewOverlay').style.zIndex = '99';
      $('previewOverlay').classList.add('open');
      await renderPdfPreview(doc, title.replace(/[^A-Za-z0-9]+/g, '-').replace(/-+$/, '') + '-' + (tag || '') + '.pdf', title);
    }catch(e){ console.error('report pdf failed', e); toast('Couldn\u2019t build the PDF: ' + (e && e.message ? e.message : e)); }
  }

  // ---------- reorder → draft POs (admin) ----------
  $('rpMakePo').addEventListener('click', async ()=>{
    if(!rpModel || rpTab !== 'reorder'){ toast('Run the Reorder report first'); return; }
    const picked = Array.from($$('#rpOut tr[data-ri]')).filter(tr=> tr.querySelector('.rp-sel') && tr.querySelector('.rp-sel').checked)
      .map(tr=> rpReorderRows[Number(tr.dataset.ri)]).filter(x=> x && Number(x.suggested_qty) > 0);
    if(!picked.length){ toast('Tick the items to order'); return; }
    const groups = new Map();
    picked.forEach(x=>{ const k = x.supplier_id || ''; if(!groups.has(k)) groups.set(k, []); groups.get(k).push(x); });
    if(!await uiConfirm('Create ' + groups.size + ' draft PO' + (groups.size === 1 ? '' : 's') + ' for ' + picked.length + ' item' + (picked.length === 1 ? '' : 's') + '?\n\n' +
      Array.from(groups.entries()).map(([k, xs])=> (xs[0].supplier || 'No preferred supplier (choose in the PO)') + ': ' + xs.length).join('\n') + '\n\nThey open as drafts — check quantities and prices before issuing.')) return;
    if(!(await purchEnsureSession())) return;
    try{
      await Promise.all([mtLoad({ silent:true }), poLoadSettings(), poLoadSuppliers()]);
      const made = [];
      for(const [sid, xs] of groups){
        const sup = poSuppliers.find(s=> s.id === sid);
        const { data: po, error } = await db.from('purchase_orders').insert({ supplier_id: sid || null, reference: 'Reorder ' + poToday(),
          payment_terms: sup ? (sup.payment_terms || '') : '', deliver_to: (poSettingsData && poSettingsData.deliver_to) || '', vat_mode: (poSettingsData && poSettingsData.vat_mode) || 'exclusive' }).select('id, po_no').single();
        if(error) throw error;
        const rows = xs.map((x, i)=>{ const m = rpItem(x.material_id), pr = poPriceFor(x.material_id, sid || null);
          return { id: poUuid(), po_id: po.id, line_no: i + 1, material_id: x.material_id, code: m.code, description: m.name,
            unit: (pr && pr.unitFromPrice) || m.unit, qty: Number(x.suggested_qty), unit_price: pr ? pr.price : 0 }; });
        const ir = await db.from('purchase_order_items').insert(rows); if(ir.error) throw ir.error;
        made.push(po.po_no);
      }
      toast('Created draft ' + made.join(', ') + ' — review them in Purchase Orders');
    }catch(e){ purchFail('Couldn\u2019t create the POs: ', e); }
  });
