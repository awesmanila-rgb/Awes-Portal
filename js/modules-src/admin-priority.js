// ---------- Admin homepage: "Needs you now" + "Technicians today" ----------
  // One ranked list of what's waiting on admin, instead of equal-weight
  // counters. Tiers: urgent (red) → today (amber) → watch (grey); within a
  // tier, oldest first. Built from the same data renderHomeOverview()
  // already fetched, plus a few small reads of its own (service requests,
  // material requisitions, POs, PM dates, reorder). The server-side twin is
  // supabase/functions/admin-alerts (urgent push + 7:00 AM digest) — keep
  // the "late" rule in step with dtIsLateDispatch() in dispatch.js.
  //
  // Quick approve: only where the whole decision fits on one line —
  // leave requests, and material requisitions approved exactly as
  // requested. Cash advance, liquidation, JO review and report sign-off
  // always open the full screen.
  const PRIO_TODAY_SHOWN = 6;
  let prioExpanded = false;
  let prioLastItems = [];

  function prioAge(ms){
    if(!(ms > 0)) return '';
    const m = Math.round(ms / 60000);
    if(m < 60) return m + 'm';
    const h = Math.round(m / 60);
    if(h < 24) return h + 'h';
    const d = Math.round(h / 24);
    return d + (d === 1 ? ' day' : ' days');
  }
  function prioSince(iso){ const t = iso ? new Date(iso).getTime() : NaN; return isFinite(t) ? Date.now() - t : 0; }
  function prioFmtTime(hhmm){
    if(!hhmm) return '';
    const [h, m] = hhmm.split(':').map(Number);
    return ((h % 12) || 12) + ':' + String(m).padStart(2, '0') + (h < 12 ? ' AM' : ' PM');
  }
  function prioDateRange(a, b){ return leaveFmtDate(a) + (b && b !== a ? ' – ' + leaveFmtDate(b) : ''); }
  function prioOverlaps(a1, a2, b1, b2){ return a1 <= (b2 || b1) && b1 <= (a2 || a1); }

  async function prioSafe(fn, fallback){ try{ return await fn(); }catch(e){ console.warn('priority: partial data', e); return fallback; } }

  // ---- extra reads (each best-effort; a failure just drops that row type) ----
  async function prioLoadExtras(){
    if(!(await ensureCloud())) return {};
    const today = todayISO();
    const in7 = new Date(new Date(today + 'T00:00:00+08:00').getTime() + 7 * 86400000).toISOString().slice(0, 10);
    const twoDaysAgo = new Date(Date.now() - 2 * 86400000).toISOString();
    const [srNew, mrs, pos, pms, reorder] = await Promise.all([
      prioSafe(async ()=>{ const { data, error } = await db.from('service_requests').select('id, created_at, description, urgency, customer_id').eq('status', 'new').order('created_at'); if(error) throw error; return data || []; }, []),
      prioSafe(async ()=>{ const { data, error } = await db.from('material_requisitions').select('id, mrf_no, requester_name, requested_by, submitted_at, created_at').eq('status', 'submitted').order('submitted_at'); if(error) throw error; return data || []; }, []),
      prioSafe(async ()=>{ const { data, error } = await db.from('purchase_orders').select('id, po_no, updated_at').eq('status', 'draft').lt('updated_at', twoDaysAgo).order('updated_at'); if(error) throw error; return data || []; }, []),
      prioSafe(async ()=>{ const { data, error } = await db.from('customer_equipment').select('id').gte('next_pm_date', today).lte('next_pm_date', in7); if(error) throw error; return data || []; }, []),
      prioSafe(async ()=>{ const { data, error } = await db.rpc('inv_rpt_reorder', { p_days: 90 }); if(error) throw error; return (data || []).filter(r=> r.reorder); }, [])
    ]);
    // First few lines of each requisition, for the one-line summary.
    let mrItems = {};
    if(mrs.length){
      await prioSafe(async ()=>{
        const { data, error } = await db.from('material_requisition_items').select('mr_id, description, qty_requested, unit').in('mr_id', mrs.map(m=> m.id));
        if(error) throw error;
        (data || []).forEach(it=>{ (mrItems[it.mr_id] = mrItems[it.mr_id] || []).push(it); });
      }, null);
    }
    const custNames = {};
    (customersCache || []).forEach(c=>{ custNames[c.id] = c.name; });
    return { srNew, mrs, mrItems, pos, pms, reorder, custNames };
  }

  // ---- build the ranked list ----
  function prioBuild(base, extra){
    const items = [];
    const today = todayISO();
    const tickets = base.tickets || [];
    const add = (tier, o)=> items.push(Object.assign({ tier, age: 0, actions: [] }, o));
    const openTicket = id=> ()=> dtOpenTicketOverlay(id);

    // URGENT — late job orders (dispatch time passed, nobody en route)
    tickets.filter(t=> t.date === today && dtIsLateDispatch(t) && dtEffectiveStatus(t) !== 'expired').forEach(t=>{
      const lateBy = Date.now() - dtDispatchMs(t);
      add('urgent', {
        key: 'late:' + t.id, age: lateBy,
        title: (t.jobOrderNo || t.id) + ' is ' + prioAge(lateBy) + ' late — not en route',
        sub: (t.custName || 'Customer') + ' · Dispatch ' + prioFmtTime(t.dispatchTime) + ' · ' + ((t.assignedWorkerNames || []).join(', ') || 'no crew'),
        actions: [{ label: 'Open job order', primary: true, run: openTicket(t.id) }]
      });
    });
    // URGENT — expired today (window passed, nobody acknowledged)
    tickets.filter(t=> t.date === today && dtEffectiveStatus(t) === 'expired').forEach(t=>{
      add('urgent', {
        key: 'exp:' + t.id, age: 1,
        title: (t.jobOrderNo || t.id) + ' expired — no one acknowledged',
        sub: (t.custName || 'Customer') + ' · raise a new job order if the visit is still needed',
        actions: [{ label: 'Open', primary: false, run: openTicket(t.id) }]
      });
    });
    // URGENT — customer service requests nobody has acknowledged for 60+ min
    (extra.srNew || []).forEach(r=>{
      const age = prioSince(r.created_at);
      if(age < 60 * 60000) return;
      add('urgent', {
        key: 'sr:' + r.id, age,
        title: 'Service request unanswered for ' + prioAge(age) + (r.urgency === 'urgent' ? ' (marked urgent)' : ''),
        sub: (extra.custNames[r.customer_id] || 'Customer') + ' · ' + String(r.description || '').slice(0, 80),
        actions: [{ label: 'Open requests', primary: true, run: ()=> showServiceRequestsView() }]
      });
    });

    // TODAY — leave (quick approve)
    (base.leaves || []).filter(r=> r.status === 'pending').forEach(r=>{
      const others = (base.leaves || []).filter(o=> o.status === 'approved' && o.userId !== r.userId && prioOverlaps(r.dateFrom, r.dateTo, o.dateFrom, o.dateTo));
      const jos = tickets.filter(t=> !dtIsTerminal(t) && (t.assignedWorkerIds || []).includes(r.userId) && t.date >= r.dateFrom && t.date <= (r.dateTo || r.dateFrom));
      const conflict = [others.length ? others.map(o=> o.userName).join(', ') + ' also off' : 'No one else off',
                        jos.length ? jos.length + ' job order' + (jos.length === 1 ? '' : 's') + ' assigned those days' : ''].filter(Boolean).join(' · ');
      add('today', {
        key: 'leave:' + r.id, age: prioSince(r.submittedAt), kind: 'leave', rec: r, others, jos,
        title: 'Leave — ' + (r.userName || 'Technician') + ', ' + prioDateRange(r.dateFrom, r.dateTo) + ' (' + (r.leaveType || 'Leave') + ')',
        sub: conflict + ' · waiting ' + prioAge(prioSince(r.submittedAt)),
        actions: [{ label: 'Open', run: ()=> showLeaveView() }, { label: 'Quick approve', primary: true, run: ()=> prioQuickApprove('leave:' + r.id) }]
      });
    });
    // TODAY — material requisitions (quick approve = exactly as requested)
    (extra.mrs || []).forEach(m=>{
      const lines = (extra.mrItems[m.id] || []);
      const summary = lines.slice(0, 2).map(it=> it.description + ' ×' + mrQty(it.qty_requested) + (it.unit ? ' ' + it.unit : '')).join(', ') + (lines.length > 2 ? ' …' : '');
      const age = prioSince(m.submitted_at || m.created_at);
      add('today', {
        key: 'mr:' + m.id, age, kind: 'mr', rec: m, lines,
        title: 'Material requisition ' + m.mrf_no + ' — ' + lines.length + ' item' + (lines.length === 1 ? '' : 's'),
        sub: (m.requester_name || 'Technician') + (summary ? ' · ' + summary : '') + ' · waiting ' + prioAge(age),
        actions: [{ label: 'Open', run: async ()=>{ showPurchasingView('requisitions'); await mrOpen(m.id); } },
                  { label: 'Quick approve', primary: true, run: ()=> prioQuickApprove('mr:' + m.id) }]
      });
    });
    // TODAY — cash advance (full review only)
    (base.cashAdvances || []).filter(r=> r.status === 'pending').forEach(r=>{
      add('today', {
        key: 'ca:' + r.id, age: prioSince(r.submittedAt),
        title: 'Cash advance ' + caFmtPeso(Number(r.amount) || 0) + ' — ' + (r.userName || 'Technician'),
        sub: (r.purpose ? String(r.purpose).slice(0, 70) + ' · ' : '') + 'waiting ' + prioAge(prioSince(r.submittedAt)),
        actions: [{ label: 'Review', run: ()=>{ setSidebarActive('sbNavCashAdvance'); showCashAdvanceView(); } }]
      });
    });
    // TODAY — liquidation (full review only)
    (base.cashAdvances || []).filter(r=> r.liquidation && r.liquidation.status === 'pending').forEach(r=>{
      const at = r.liquidation.submittedAt || r.submittedAt;
      add('today', {
        key: 'liq:' + r.id, age: prioSince(at),
        title: 'Liquidation to check — ' + (r.userName || 'Technician'),
        sub: 'Receipts for ' + caFmtPeso(Number(r.amountGiven || r.amount) || 0) + ' · waiting ' + prioAge(prioSince(at)),
        actions: [{ label: 'Review', run: async ()=>{ setSidebarActive('sbNavLiquidation'); await showCashAdvanceView(); caShowTab('liquidate'); } }]
      });
    });
    // TODAY — grouped: JO review, reports to sign off, balances to settle
    const toReview = tickets.filter(t=> t.status === 'completed');
    if(toReview.length){
      const oldest = Math.max(...toReview.map(t=> prioSince(t.completedAt)));
      add('today', {
        key: 'jorev', age: oldest,
        title: toReview.length + ' job order' + (toReview.length === 1 ? '' : 's') + ' to review and close',
        sub: 'Oldest ' + (toReview[0].jobOrderNo || '') + (oldest ? ' · ' + prioAge(oldest) : ''),
        actions: [{ label: 'Review', run: async ()=>{ await showDispatchView('all'); dtSetAdminFilter('completed'); } }]
      });
    }
    const drafts = (base.reports || []).filter(r=> !r.completed);
    if(drafts.length){
      add('today', {
        key: 'srsign', age: 1,
        title: drafts.length + ' service report' + (drafts.length === 1 ? '' : 's') + ' pending sign-off',
        sub: 'Oldest ' + (drafts.map(r=> r.srNo).filter(Boolean).sort()[0] || ''),
        actions: [{ label: 'Review', run: ()=>{ showServiceReport(); srShowTab('draft'); } }]
      });
    }
    const unsettled = (base.cashAdvances || []).filter(r=> r.liquidation && r.liquidation.status === 'approved' && r.liquidation.settlement && !r.liquidation.settlement.settled);
    if(unsettled.length){
      add('today', {
        key: 'settle', age: 1,
        title: unsettled.length + ' balance' + (unsettled.length === 1 ? '' : 's') + ' to settle',
        sub: 'Approved liquidations with money to collect or reimburse',
        actions: [{ label: 'Open', run: async ()=>{ setSidebarActive('sbNavReimbursement'); await showCashAdvanceView(); caShowAdminSection('reimb'); } }]
      });
    }

    // WATCH — chips
    if((extra.reorder || []).length) add('watch', { key: 'reorder', title: extra.reorder.length + ' item' + (extra.reorder.length === 1 ? '' : 's') + ' below reorder level', actions: [{ label: 'Reorder report', run: ()=> showPurchasingView('invReports') }] });
    if((extra.pms || []).length) add('watch', { key: 'pm', title: extra.pms.length + ' PM' + (extra.pms.length === 1 ? '' : 's') + ' due this week', actions: [{ label: 'Calendar', run: ()=> showDispatchView('calendar') }] });
    (extra.pos || []).slice(0, 3).forEach(p=> add('watch', { key: 'po:' + p.id, title: (p.po_no || 'PO') + ' still a draft (' + prioAge(prioSince(p.updated_at)) + ')', actions: [{ label: 'Open', run: ()=> showPurchasingView('purchaseOrders') }] }));
    const noDispatch = tickets.filter(t=> t.date === today && !t.dispatchTime && !dtIsTerminal(t));
    if(noDispatch.length) add('watch', { key: 'nodisp', title: noDispatch.length + ' JO' + (noDispatch.length === 1 ? '' : 's') + ' today without a dispatch time', actions: [{ label: 'Dispatch', run: ()=> showDispatchView('all') }] });

    const rank = { urgent: 0, today: 1, watch: 2 };
    items.sort((a, b)=> rank[a.tier] - rank[b.tier] || b.age - a.age);
    return items;
  }

  // ---- technicians today ----
  function prioTechStatus(base){
    const today = todayISO();
    const users = (base.users || []).filter(u=> u.active !== false).sort((a, b)=> String(a.name).localeCompare(String(b.name)));
    const dtr = {}; (base.dtrToday || []).forEach(d=>{ if(d) dtr[d.technicianId] = d; });
    const tickets = (base.tickets || []).filter(t=> t.date === today || t.status === 'in_progress' || t.status === 'acknowledged');
    const onLeave = new Set((base.leaves || []).filter(l=> l.status === 'approved' && today >= l.dateFrom && today <= (l.dateTo || l.dateFrom)).map(l=> l.userId));
    const rank = { late:0, onsite:1, enroute:2, idle:3, next:4, notin:5, done:6, out:7, off:8 };
    return users.map(u=>{
      const mine = tickets.filter(t=> (t.assignedWorkerIds || []).includes(u.id));
      const live = mine.filter(t=> !dtIsTerminal(t) || t.status === 'in_progress');
      const d = dtr[u.id];
      let key, label, sub;
      const late = live.find(t=> dtIsLateDispatch(t));
      const onsite = live.find(t=> t.status === 'in_progress');
      const enroute = live.find(t=> t.status === 'acknowledged');
      if(onLeave.has(u.id)){ key = 'off'; label = 'Off'; sub = 'On leave'; }
      else if(late){ key = 'late'; label = 'Late'; sub = (late.jobOrderNo || '') + ' · dispatch ' + prioFmtTime(late.dispatchTime); }
      else if(onsite){ key = 'onsite'; label = 'On site'; sub = (onsite.jobOrderNo || '') + ' · ' + (onsite.custName || ''); }
      else if(enroute){ key = 'enroute'; label = 'En route'; sub = (enroute.jobOrderNo || '') + ' · ' + (enroute.custName || ''); }
      else if(live.length){ const n = live.slice().sort((a, b)=> String(a.dispatchTime || '').localeCompare(String(b.dispatchTime || '')))[0];
        key = 'next'; label = 'Next'; sub = (n.jobOrderNo || '') + (n.dispatchTime ? ' · dispatch ' + prioFmtTime(n.dispatchTime) : ''); }
      else if(mine.length){ key = 'done'; label = 'Done'; sub = mine.length + ' job' + (mine.length === 1 ? '' : 's') + ' today'; }
      else if(d && d.otTimeIn && !d.otTimeOut){ key = 'idle'; label = 'Overtime'; sub = 'OT since ' + prioFmtTime(d.otTimeIn) + ' · no job order'; }
      else if(d && d.timeIn && !d.timeOut){ key = 'idle'; label = 'Idle'; sub = 'Timed in ' + prioFmtTime(d.timeIn) + ' · no job order'; }
      else if(d && d.timeOut){ key = 'out'; label = 'Timed out'; sub = 'In ' + prioFmtTime(d.timeIn) + ' · out ' + prioFmtTime(d.otTimeOut || d.timeOut); }
      else { key = 'notin'; label = 'Not timed in'; sub = 'No job order today'; }
      return { id: u.id, name: u.name || u.username || 'Technician', key, label, sub, r: rank[key] };
    }).sort((a, b)=> a.r - b.r || a.name.localeCompare(b.name));
  }

  // ---- render ----
  function prioItemHtml(it, idx){
    return '<div class="prio-item prio-' + it.tier + '">' +
      '<span class="prio-dot" aria-hidden="true"></span>' +
      '<div class="prio-text"><div class="prio-title">' + escapeHtml(it.title) + '</div>' +
        (it.sub ? '<div class="prio-sub">' + escapeHtml(it.sub) + '</div>' : '') + '</div>' +
      '<div class="prio-actions">' + it.actions.map((a, j)=>
        '<button type="button" class="prio-btn' + (a.primary ? ' primary' : '') + '" data-prio="' + idx + ':' + j + '">' + escapeHtml(a.label) + '</button>').join('') +
      '</div></div>';
  }
  function prioRenderList(){
    const items = prioLastItems;
    const urgent = items.filter(i=> i.tier === 'urgent'), today = items.filter(i=> i.tier === 'today'), watch = items.filter(i=> i.tier === 'watch');
    $('prioCountUrgent').textContent = urgent.length + ' urgent';
    $('prioCountToday').textContent = today.length + ' for today';
    $('prioCountWatch').textContent = watch.length + ' to watch';
    $('prioCountUrgent').classList.toggle('zero', !urgent.length);
    $('prioCountToday').classList.toggle('zero', !today.length);
    $('prioCountWatch').classList.toggle('zero', !watch.length);
    if(!items.length){
      $('prioList').innerHTML = '<div class="prio-clear"><b>All clear ✓</b><span>Nothing is waiting on you right now.</span></div>';
      return;
    }
    const idx = it=> items.indexOf(it);
    let html = '';
    if(urgent.length) html += '<div class="prio-tier prio-tier-urgent">Urgent</div>' + urgent.map(it=> prioItemHtml(it, idx(it))).join('');
    if(today.length){
      const shown = prioExpanded ? today : today.slice(0, PRIO_TODAY_SHOWN);
      html += '<div class="prio-tier prio-tier-today">For today</div>' + shown.map(it=> prioItemHtml(it, idx(it))).join('');
      if(today.length > shown.length) html += '<button type="button" class="prio-more" id="prioMoreBtn">+ ' + (today.length - shown.length) + ' more for today</button>';
    }
    if(watch.length) html += '<div class="prio-tier prio-tier-watch">Watch</div><div class="prio-watch">' + watch.map(it=>
      '<button type="button" class="prio-chip" data-prio="' + idx(it) + ':0">' + escapeHtml(it.title) + '</button>').join('') + '</div>';
    $('prioList').innerHTML = html;
  }
  function prioRenderTechs(rows){
    const n = k=> rows.filter(r=> k.includes(r.key)).length;
    const bits = [n(['onsite','enroute']) + ' on a job', n(['late']) ? n(['late']) + ' late' : '', n(['idle']) ? n(['idle']) + ' free' : '', n(['out']) ? n(['out']) + ' timed out' : '', n(['off']) ? n(['off']) + ' off' : ''].filter(Boolean);
    $('prioTechSub').textContent = bits.join(' · ');
    $('prioTechList').innerHTML = rows.length ? rows.map(r=>
      '<div class="prio-tech"><b>' + escapeHtml(r.name) + '</b><span class="prio-tech-sub">' + escapeHtml(r.sub) + '</span>' +
      '<span class="prio-pill prio-pill-' + r.key + '">' + escapeHtml(r.label) + '</span></div>').join('')
      : '<div class="empty-state">No active technicians.</div>';
  }
  // App-icon badge (installed PWA): urgent + today. Also refreshed by the
  // push handler in sw.js whenever an alert arrives with the app closed.
  function prioSetBadge(n){
    try{
      if(n > 0 && navigator.setAppBadge) navigator.setAppBadge(n);
      else if(navigator.clearAppBadge) navigator.clearAppBadge();
    }catch(e){ /* unsupported — ignore */ }
  }

  async function prioRender(base){
    if(!currentUser || currentUser.role !== 'admin'){ $('prioCard').style.display = 'none'; $('prioTechCard').style.display = 'none'; return; }
    $('prioCard').style.display = ''; $('prioTechCard').style.display = '';
    prioStartLive();
    try{
      const extra = await prioLoadExtras();
      prioLastItems = prioBuild(base, Object.assign({ custNames: {} }, extra));
      prioLastBase = base;
      prioRenderList();
      prioRenderTechs(prioTechStatus(base));
      prioSetBadge(prioLastItems.filter(i=> i.tier !== 'watch').length);
    }catch(e){
      console.error('priority render failed', e);
      $('prioList').innerHTML = '<div class="empty-state">Couldn\u2019t load the priority list — pull to refresh.</div>';
    }
  }
  let prioLastBase = null;
  // "Late" is time-based, so re-check every 2 minutes while the admin is
  // looking at the homepage — a job order turns red at its dispatch time
  // without anyone having to refresh.
  //
  // Time-ins/outs and job-order moves must show up without leaving the
  // homepage, so a refresh re-reads today's DTR and the job orders (the
  // two things "Technicians today" and the late rule depend on) instead of
  // re-drawing the data from when the page opened. Triggered by: realtime
  // changes on dtr_records / dispatch_tickets (when those tables publish),
  // a 60-second poll as the safety net, and returning to the app.
  let prioRefreshing = false, prioRefreshTimer = null, prioRt = null;
  function prioHomeVisible(){
    return !!prioLastBase && currentUser && currentUser.role === 'admin' && !document.hidden && $('homeScreen').style.display !== 'none';
  }
  async function prioRefreshLive(){
    if(!prioHomeVisible() || prioRefreshing) return;
    prioRefreshing = true;
    try{
      const [dtrToday, tickets] = await Promise.all([
        dtrListAllForDate(todayISO()).catch(()=> null),
        dtListAll().catch(()=> null)
      ]);
      const base = Object.assign({}, prioLastBase);
      if(dtrToday) base.dtrToday = dtrToday;
      if(tickets) base.tickets = tickets;
      await prioRender(base);
    }finally{ prioRefreshing = false; }
  }
  function prioRefreshSoon(){
    clearTimeout(prioRefreshTimer);
    prioRefreshTimer = setTimeout(prioRefreshLive, 1500);   // bursts of changes → one refresh
  }
  function prioStartLive(){
    if(prioRt || !db || !db.channel) return;
    try{
      prioRt = db.channel('admin-priority-live')
        .on('postgres_changes', { event:'*', schema:'public', table:'dtr_records' }, prioRefreshSoon)
        .on('postgres_changes', { event:'*', schema:'public', table:'dispatch_tickets' }, prioRefreshSoon)
        .subscribe();
    }catch(e){ prioRt = null; }
  }
  setInterval(prioRefreshLive, 60000);
  document.addEventListener('visibilitychange', ()=>{ if(!document.hidden) prioRefreshSoon(); });

  $('prioList').addEventListener('click', async (e)=>{
    if(e.target.closest('#prioMoreBtn')){ prioExpanded = true; prioRenderList(); return; }
    const b = e.target.closest('[data-prio]'); if(!b) return;
    const [i, j] = b.dataset.prio.split(':').map(Number);
    const it = prioLastItems[i]; const act = it && it.actions[j];
    if(!act) return;
    try{ closeMainMenu && closeMainMenu(); }catch(err){}
    try{ await act.run(); }catch(err){ console.error('priority action failed', err); toast('Could not open that'); }
  });

  // ---- quick approve (leave, MR as requested) ----
  let prioQaItem = null;
  function prioQaClose(){ $('prioQaOverlay').classList.remove('open'); prioQaItem = null; }
  function prioQuickApprove(key){
    const it = prioLastItems.find(x=> x.key === key); if(!it) return;
    prioQaItem = it;
    let title, body;
    if(it.kind === 'leave'){
      const r = it.rec;
      title = 'Approve leave for ' + (r.userName || 'this technician') + '?';
      body = '<div>' + escapeHtml((r.leaveType || 'Leave') + ' · ' + prioDateRange(r.dateFrom, r.dateTo) + ' (' + (r.days || 1) + (Number(r.days) === 1 ? ' day' : ' days') + ')') + '</div>' +
        '<div>' + escapeHtml(it.others.length ? 'Also off those days: ' + it.others.map(o=> o.userName).join(', ') : 'No other technician is off those days.') + '</div>' +
        '<div' + (it.jos.length ? ' class="prio-qa-warn"' : '') + '>' + escapeHtml(it.jos.length ? it.jos.length + ' job order' + (it.jos.length === 1 ? ' is' : 's are') + ' assigned to them on those dates: ' + it.jos.map(t=> t.jobOrderNo).join(', ') : 'No job orders assigned to them on those dates.') + '</div>' +
        (r.reason ? '<div class="prio-qa-muted">Reason: ' + escapeHtml(r.reason) + '</div>' : '');
    }else{
      const m = it.rec;
      title = 'Approve ' + m.mrf_no + ' as requested?';
      body = '<div>' + escapeHtml((m.requester_name || 'Technician') + ' · ' + it.lines.length + ' item' + (it.lines.length === 1 ? '' : 's')) + '</div>' +
        '<ul class="prio-qa-lines">' + it.lines.map(l=> '<li>' + escapeHtml(l.description + ' — ' + mrQty(l.qty_requested) + (l.unit ? ' ' + l.unit : '')) + '</li>').join('') + '</ul>' +
        '<div class="prio-qa-muted">To change a quantity, use Open instead.</div>';
    }
    $('prioQaTitle').textContent = title;
    $('prioQaBody').innerHTML = body + '<div class="prio-qa-muted">Recorded as approved by ' + escapeHtml((currentUser && currentUser.name) || 'you') + '. The technician is notified.</div>';
    $('prioQaOverlay').classList.add('open');
  }
  $('prioQaCancel').addEventListener('click', prioQaClose);
  $('prioQaApprove').addEventListener('click', async ()=>{
    const it = prioQaItem; if(!it) return;
    const btn = $('prioQaApprove'); btn.disabled = true; btn.textContent = 'Approving…';
    try{
      if(it.kind === 'leave'){
        await leaveDecide(it.rec.id, 'approved', '');
      }else{
        const m = it.rec;
        const { data, error } = await db.from('material_requisitions').update({ status: 'approved' }).eq('id', m.id).eq('status', 'submitted').select('id');
        if(error) throw error;
        if(!data || !data.length){ toast(m.mrf_no + ' was already decided'); }
        else{
          toast(m.mrf_no + ' approved');
          notifyUser(m.requested_by, 'Material request approved', m.mrf_no + ' was approved.', 'mrf-' + m.id);
        }
      }
      prioQaClose();
      if(typeof renderHomeOverview === 'function') renderHomeOverview();
    }catch(e){
      console.error('quick approve failed', describeCloudError(e));
      toast('Could not approve — ' + ((e && e.message) || 'try again'));
    }finally{ btn.disabled = false; btn.textContent = 'Approve'; }
  });
