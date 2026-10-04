// ---------- Admin homepage: "Needs you now" + "Technicians today" ----------
  // One ranked list of what's waiting on admin, instead of equal-weight
  // counters. Tiers: urgent (red) → today (amber) → watch (grey); within a
  // tier, oldest first. Built from the same data renderHomeOverview()
  // already fetched, plus a few small reads of its own (service requests,
  // material requisitions, POs, PM dates, reorder). The server-side twin is
  // supabase/functions/admin-alerts (urgent push + 7:00 AM digest) — keep
  // the "late" rule in step with dtIsLateDispatch() in dispatch.js.
  // "Overdue" (below) is in-app only: acknowledged / in-progress job
  // orders whose scheduled day has passed without being completed.
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
    const [srNew, mrs, pos, pms, reorder, inbox] = await Promise.all([
      prioSafe(async ()=>{ const { data, error } = await db.from('service_requests').select('id, created_at, description, urgency, customer_id').eq('status', 'new').order('created_at'); if(error) throw error; return data || []; }, []),
      prioSafe(async ()=>{ const { data, error } = await db.from('material_requisitions').select('id, mrf_no, requester_name, requested_by, submitted_at, created_at').eq('status', 'submitted').order('submitted_at'); if(error) throw error; return data || []; }, []),
      // POs Purchasing submitted for approval (20261010_01)
      prioSafe(async ()=>{ const { data, error } = await db.from('purchase_orders').select('id, po_no, total, approval_requested_at, approval_requested_name, supplier_snapshot, suppliers(name)').eq('status', 'draft').not('approval_requested_at', 'is', null).order('approval_requested_at'); if(error) throw error; return data || []; }, []),
      prioSafe(async ()=>{ const { data, error } = await db.from('customer_equipment').select('id').gte('next_pm_date', today).lte('next_pm_date', in7); if(error) throw error; return data || []; }, []),
      prioSafe(async ()=>{ const { data, error } = await db.rpc('inv_rpt_reorder', { p_days: 90 }); if(error) throw error; return (data || []).filter(r=> r.reorder); }, []),
      // Every Inbox item across departments (20261011_01) — the ones without
      // their own rule below still show here, so nothing waiting is missed.
      prioSafe(async ()=>{ const { data, error } = await db.rpc('inbox_items'); if(error) throw error; return Array.isArray(data) ? data : []; }, [])
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
    return { srNew, mrs, mrItems, pos, pms, reorder, custNames, inbox };
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
    // URGENT — overdue: the crew acknowledged or arrived, but the scheduled
    // day has passed and the job order is still open. Once work starts the
    // date no longer expires a ticket (dtEffectiveStatus), so without this
    // it would sit in Work in Progress indefinitely — normally because some
    // units still have no Service Report (or "not done" flag).
    tickets.filter(t=> t.date && t.date < today && ['acknowledged', 'in_progress'].includes(dtEffectiveStatus(t))).forEach(t=>{
      const units = t.equipmentList || [];
      const open = units.filter(u=> !u.reportSrNo && !u.notDone);
      const endOfDay = new Date(t.date + 'T23:59:59' + BUSINESS_TZ_OFFSET).getTime();
      const overdue = isFinite(endOfDay) ? Math.max(0, Date.now() - endOfDay) : 0;
      const days = Math.max(1, Math.ceil(overdue / 86400000));
      const st = dtEffectiveStatus(t) === 'in_progress' ? 'still Work in Progress' : 'still En Route, never arrived';
      add('urgent', {
        key: 'overdue:' + t.id, age: overdue + 1,
        title: (t.jobOrderNo || t.id) + ' overdue ' + days + ' day' + (days === 1 ? '' : 's') + ' — ' + st,
        sub: [t.custName || 'Customer', 'scheduled ' + leaveFmtDate(t.date),
              units.length ? (open.length ? open.length + ' of ' + units.length + ' unit' + (units.length === 1 ? '' : 's') + ' without a service report' : 'all units reported — check the ticket')
                           : 'no units on the ticket',
              (t.assignedWorkerNames || []).join(', ') || 'no crew'].join(' · '),
        actions: [{ label: 'Open job order', primary: true, run: openTicket(t.id) }]
      });
    });
    // TODAY — on site for 10+ hours today with units still unreported
    tickets.filter(t=> t.date === today && dtEffectiveStatus(t) === 'in_progress' && t.arrivedAt && prioSince(t.arrivedAt) > 10 * 3600000).forEach(t=>{
      const units = t.equipmentList || [];
      const open = units.filter(u=> !u.reportSrNo && !u.notDone);
      if(!open.length) return;
      add('today', {
        key: 'long:' + t.id, age: prioSince(t.arrivedAt),
        title: (t.jobOrderNo || t.id) + ' on site ' + prioAge(prioSince(t.arrivedAt)) + ' — ' + open.length + ' unit' + (open.length === 1 ? '' : 's') + ' not reported',
        sub: (t.custName || 'Customer') + ' · ' + ((t.assignedWorkerNames || []).join(', ') || 'no crew'),
        actions: [{ label: 'Open job order', run: openTicket(t.id) }]
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
    // Opens Cash Advance admin on the right section + filter tab.
    const openCa = (reimb, filter)=> async ()=>{
      setSidebarActive(reimb ? 'sbNavReimbursement' : 'sbNavCashAdvance');
      await showCashAdvanceView();
      caShowAdminSection(reimb ? 'reimb' : 'requests');
      const btn = document.querySelector('#' + (reimb ? 'caReimbAdminFilterRow' : 'caAdminFilterRow') + ' button[data-filter="' + filter + '"]');
      if(btn) btn.click();
    };
    // TODAY — cash advance / reimbursement requests (full review only).
    // Reimbursements share the same table and 'pending' status, so they are
    // labelled and routed to their own section instead of passing as a cash
    // advance.
    (base.cashAdvances || []).filter(r=> r.status === 'pending').forEach(r=>{
      const reimb = r.kind === 'reimbursement';
      add('today', {
        key: 'ca:' + r.id, age: prioSince(r.submittedAt),
        title: (reimb ? 'Reimbursement ' : 'Cash advance ') + caFmtPeso(Number(r.amount) || 0) + ' — ' + (r.userName || 'Technician'),
        sub: (r.purpose ? String(r.purpose).slice(0, 70) + ' · ' : '') + 'waiting ' + prioAge(prioSince(r.submittedAt)),
        actions: [{ label: 'Review', run: openCa(reimb, 'pending') }]
      });
    });
    // Approved but the money has not been handed over yet (not "Given" /
    // not "Paid"). Approval alone doesn't put cash in the technician's
    // hand, so this stays on admin's list until Record Disbursement /
    // Record Payment is done. A cash advance whose date needed is today or
    // already past goes to URGENT — the technician needs it for the job.
    (base.cashAdvances || []).filter(r=> r.status === 'approved' && !r.disbursed).forEach(r=>{
      const reimb = r.kind === 'reimbursement';
      const needed = r.dateNeeded || '';
      const due = !reimb && needed && needed <= today;
      const age = prioSince(r.decidedAt || r.submittedAt);
      const neededTxt = reimb || !needed ? '' :
        (needed === today ? 'Needed today' : needed < today ? 'Needed ' + leaveFmtDate(needed) + ' (past due)' : 'Needed ' + leaveFmtDate(needed));
      add(due ? 'urgent' : 'today', {
        key: 'rel:' + r.id, age,
        title: reimb
          ? 'Reimbursement to pay — ' + caFmtPeso(Number(r.amount) || 0) + ' to ' + (r.userName || 'Technician')
          : 'Cash advance to release — ' + caFmtPeso(Number(r.amount) || 0) + ' to ' + (r.userName || 'Technician'),
        sub: [neededTxt, r.purpose ? String(r.purpose).slice(0, 60) : '', (age ? 'approved ' + prioAge(age) + ' ago, ' : 'approved, ') + 'not yet ' + (reimb ? 'paid' : 'given')].filter(Boolean).join(' · '),
        actions: [{ label: reimb ? 'Record payment' : 'Record release', primary: true, run: openCa(reimb, 'approved') }]
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
    // Filed reports no job-order close will sign off — Record Past Service,
    // or filed after the job order closed (20261009_01). Same test as the
    // database's service_report_needs_signoff().
    const openSrNos = new Set();
    tickets.filter(t=> ['open','preparing','acknowledged','in_progress','completed','scheduled'].includes(t.status))
      .forEach(t=> (t.equipmentList || []).forEach(u=>{ if(u.reportSrNo) openSrNos.add(u.reportSrNo); }));
    const toSign = (base.reports || []).filter(r=> r.completed && !r.signedOffAt && !openSrNos.has(r.srNo));
    if(toSign.length){
      add('today', {
        key: 'srsignoff', age: 1,
        title: toSign.length + ' service report' + (toSign.length === 1 ? '' : 's') + ' to sign off',
        sub: 'Not covered by a job order close \u00B7 ' + (toSign.map(r=> r.srNo).filter(Boolean).sort()[0] || ''),
        actions: [{ label: 'Review', primary: true, run: ()=> srOpenReviewQueue() }]
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
    // Inbox items that no rule above already covers, grouped by kind.
    const COVERED = PRIO_COVERED;
    const groups = {};
    (extra.inbox || []).forEach(x=>{
      if(!x || COVERED.has(x.kind) || /_endorse$/.test(x.kind || '')) return;
      (groups[x.kind] = groups[x.kind] || []).push(x);
    });
    Object.keys(groups).forEach(kind=>{
      const list = groups[kind].sort((a, b)=> (Number(b.age_hours) || 0) - (Number(a.age_hours) || 0));
      const top = list[0];
      // approvals and overdue work go to Today; escalated to Urgent
      const tier = list.some(x=> x.state === 'escalated') ? 'urgent'
        : (list.some(x=> x.state === 'overdue') || top.level === 'approve') ? 'today' : 'watch';
      const open = (typeof STAFF_MODULE_OPENERS !== 'undefined' && STAFF_MODULE_OPENERS[top.module]) || null;
      add(tier, {
        key: 'inbox:' + kind, age: (Number(top.age_hours) || 0) * 3600000,
        title: list.length === 1 ? top.label + (top.ref_label ? ' \u00B7 ' + top.ref_label : '') : list.length + ' \u00D7 ' + top.label,
        sub: (top.title || '') + (list.length > 1 ? ' \u00B7 oldest' : '') + (top.age_hours ? ' \u00B7 ' + prioAge((Number(top.age_hours) || 0) * 3600000) : ''),
        actions: open ? [{ label: 'Open', run: ()=> open() }] : [{ label: 'Inbox', run: ()=> staffOpenInbox() }]
      });
    });
    if((extra.reorder || []).length) add('watch', { key: 'reorder', title: extra.reorder.length + ' item' + (extra.reorder.length === 1 ? '' : 's') + ' below reorder level', actions: [{ label: 'Reorder report', run: ()=> showPurchasingView('invReports') }] });
    if((extra.pms || []).length) add('watch', { key: 'pm', title: extra.pms.length + ' PM' + (extra.pms.length === 1 ? '' : 's') + ' due this week', actions: [{ label: 'Calendar', run: ()=> showDispatchView('calendar') }] });
    (extra.pos || []).forEach(p=>{
      const age = prioSince(p.approval_requested_at);
      add(age > 24 * 3600000 ? 'urgent' : 'today', {
        key: 'poappr:' + p.id, age,
        title: (p.po_no || 'PO') + ' waiting for approval \u00B7 \u20B1' + Number(p.total || 0).toLocaleString('en-PH', { minimumFractionDigits:2, maximumFractionDigits:2 }),
        sub: ((p.suppliers && p.suppliers.name) || 'Supplier') + ' \u00B7 from ' + (p.approval_requested_name || 'Purchasing') + ' \u00B7 ' + prioAge(age),
        actions: [{ label: 'Review', primary: true, run: ()=> showPurchasingView('purchaseOrders') }]
      });
    });
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
      // The job order this row is about: what they are on, else what is late,
      // else their next one. The table's Acknowledged / En route / On site
      // cells all read from it. Acknowledgement is per technician (matched by
      // id); en route means every assigned technician has acknowledged, which
      // is exactly when the ticket moves to 'acknowledged'. No per-person
      // timestamp is stored for either, so those cells say Yes, not a time.
      const nextJ = live.slice().sort((a, b)=> String(a.dispatchTime || '').localeCompare(String(b.dispatchTime || '')))[0];
      const cur = onsite || enroute || late || nextJ || null;
      const eff = cur ? dtEffectiveStatus(cur) : '';
      const ack = !cur ? null : ((cur.acknowledgedBy || []).includes(u.id) ? 'yes' : (eff === 'scheduled' ? 'na' : 'wait'));
      return { id: u.id, name: u.name || u.username || 'Technician', key, label, sub, r: rank[key],
        hasJob: !!cur, joId: cur ? cur.id : null, joNo: cur ? (cur.jobOrderNo || cur.id) : '',
        isLate: !!cur && dtIsLateDispatch(cur), timeIn: (d && d.timeIn) || '',
        ack, en: !!cur && (eff === 'acknowledged' || eff === 'in_progress'),
        onSite: !!cur && eff === 'in_progress', onAt: (cur && cur.arrivedAt) || '' };
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
  function prioClock(iso){
    const t = iso ? new Date(iso) : null;
    return t && isFinite(t) ? t.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
  }
  function prioRenderTechs(rows){
    const n = k=> rows.filter(r=> k.includes(r.key)).length;
    const bits = [n(['onsite','enroute']) + ' on a job', n(['late']) ? n(['late']) + ' late' : '', n(['idle']) ? n(['idle']) + ' free' : '', n(['out']) ? n(['out']) + ' timed out' : '', n(['off']) ? n(['off']) + ' off' : ''].filter(Boolean);
    $('prioTechSub').textContent = bits.join(' · ');
    const box = $('prioTechList');
    if(!rows.length){ box.innerHTML = '<div class="empty-state">No active technicians.</div>'; return; }
    const dash = '<span class="ptt-dim">\u2014</span>';
    const head = '<div class="ptt-row ptt-head"><span>Name</span><span>Job order</span><span>Time-in</span><span>Acknowledged</span><span>En route</span><span>On site</span></div>';
    const body = rows.map(r=>{
      const name = '<button type="button" class="ptt-name" data-tid="' + escapeHtml(r.id) + '" title="Show on the live tracker">' + escapeHtml(r.name) + '</button>';
      const tin = r.timeIn ? escapeHtml(prioFmtTime(r.timeIn)) : '<span class="ptt-dim">Not in</span>';
      if(!r.hasJob){
        return '<div class="ptt-row">' + name + dash + '<span>' + tin + '</span>' +
          '<span class="ptt-span"><span class="prio-pill prio-pill-' + r.key + '">' + escapeHtml(r.label) + '</span><small>' + escapeHtml(r.sub) + '</small></span></div>';
      }
      const jo = '<span><button type="button" class="ptt-jo" data-jo="' + escapeHtml(String(r.joId)) + '">' + escapeHtml(r.joNo) + '</button>' +
        (r.isLate ? ' <span class="prio-pill prio-pill-late">Late</span>' : '') + '</span>';
      const ack = r.ack === 'yes' ? '<span class="prio-pill prio-pill-yes">Yes</span>'
        : r.ack === 'wait' ? '<span class="prio-pill prio-pill-wait">Waiting</span>' : dash;
      const en = r.en ? '<span class="prio-pill prio-pill-enroute">Yes</span>' : dash;
      const on = r.onSite ? '<span class="prio-pill prio-pill-onsite">' + escapeHtml(prioClock(r.onAt) || 'Yes') + '</span>' : dash;
      return '<div class="ptt-row">' + name + jo + '<span>' + tin + '</span><span>' + ack + '</span><span>' + en + '</span><span>' + on + '</span></div>';
    }).join('');
    box.innerHTML = head + body;
    box.onclick = e=>{
      const jo = e.target.closest('.ptt-jo');
      if(jo){ dtOpenTicketOverlay(jo.dataset.jo); return; }
      const nm = e.target.closest('.ptt-name');
      if(!nm) return;
      const li = document.querySelector('#trackerList .tracker-list-item[data-tid="' + String(nm.dataset.tid).replace(/"/g, '') + '"]');
      if(li) li.click(); else toast(nm.textContent + ' is not sharing a location right now');
    };
  }

  // ---- job order progress tracking: today's active job orders ----
  // Same four-stage bar the Job Orders list uses, plus the whole crew with
  // each technician's acknowledgement (dtAdminProgressHtml, dispatch.js), so
  // admin can watch every job order without opening any.
  const PRIO_PROGRESS_MAX = 8;
  function prioRenderProgress(base){
    const box = $('prioProgressList'); if(!box) return;
    const today = todayISO();
    const hidden = ['closed', 'cancelled', 'expired', 'replaced'];
    const rows = (base.tickets || [])
      .filter(t=> (t.date === today || t.status === 'in_progress' || t.status === 'acknowledged') && !hidden.includes(dtEffectiveStatus(t)))
      .sort((a, b)=> String(a.dispatchTime || '').localeCompare(String(b.dispatchTime || '')) || String(a.jobOrderNo || '').localeCompare(String(b.jobOrderNo || '')));
    const sub = $('prioProgressSub'); if(sub) sub.textContent = rows.length ? rows.length + ' active' : '';
    if(!rows.length){ box.innerHTML = '<div class="empty-state">No job orders in progress today.</div>'; return; }
    const shown = rows.slice(0, PRIO_PROGRESS_MAX);
    box.innerHTML = shown.map(t=>
      '<div class="ptp-item"><div class="ptp-head">' +
        '<button type="button" class="ptp-jo" data-jo="' + escapeHtml(String(t.id)) + '">' + escapeHtml((t.jobOrderNo || t.id) + (t.custName ? ' \u00b7 ' + t.custName : '')) + '</button>' +
        '<span class="ptp-time">' + (t.dispatchTime ? 'Dispatch ' + escapeHtml(prioFmtTime(t.dispatchTime)) : '') + '</span></div>' +
      dtAdminProgressHtml(t) + '</div>').join('') +
      (rows.length > shown.length ? '<button type="button" class="ptp-more" id="prioProgressMore">+ ' + (rows.length - shown.length) + ' more in Dispatch</button>' : '');
    box.onclick = e=>{
      const jo = e.target.closest('.ptp-jo');
      if(jo){ dtOpenTicketOverlay(jo.dataset.jo); return; }
      if(e.target.closest('#prioProgressMore')) showDispatchView('all');
    };
  }
  // App-icon badge (installed PWA): urgent + today. Also refreshed by the
  // push handler in sw.js whenever an alert arrives with the app closed.
  function prioSetBadge(n){
    try{
      if(n > 0 && navigator.setAppBadge) navigator.setAppBadge(n);
      else if(navigator.clearAppBadge) navigator.clearAppBadge();
    }catch(e){ /* unsupported — ignore */ }
  }

  // ---- dispatch board: today's job orders by technician on a time axis ----
  // Start = the ticket's dispatch time. Tickets store no end time, so every
  // block is drawn two hours wide — it shows WHEN a job starts and who has
  // it, not how long it will take. Late uses dtIsLateDispatch(), the same
  // rule as the priority list. Read-only; a click opens the existing job order.
  const PRIO_BOARD_COLORS = ['#7A4E2D','#6B3F8A','#0F5A40','#2A63B0','#8A5A00','#B0467A'];
  let prioBoardSel = null, prioBoardData = null;
  function prioHM(hhmm){ const p = String(hhmm || '').split(':').map(Number); return (p[0] || 0) + (p[1] || 0) / 60; }
  function prioFmtHour(x){ const h = Math.floor(x), m = Math.round((x - h) * 60); return ((h % 12) || 12) + ':' + String(m).padStart(2, '0') + ' ' + (h < 12 ? 'AM' : 'PM'); }
  function prioJobKind(t){
    if(dtIsLateDispatch(t)) return 'late';
    const s = dtEffectiveStatus(t);
    if(s === 'completed' || s === 'closed') return 'done';
    if(s === 'in_progress') return 'on';
    if(s === 'acknowledged') return 'en';
    return '';
  }
  function prioJobLabel(t, k){
    if(k === 'late') return 'Late ' + prioAge(Date.now() - dtDispatchMs(t)) + ', not acknowledged';
    return { done:'Completed', on:'On site', en:'En route' }[k] || 'Scheduled';
  }
  function prioRenderBoard(base){
    const card = $('prioBoardCard'); if(!card) return;
    const el = $('prioBoard'); if(!el) return;
    const today = todayISO();
    const users = (base.users || []).filter(u=> u.active !== false);
    const byId = {}; users.forEach(u=>{ byId[u.id] = u; });
    const jobs = (base.tickets || []).filter(t=> t.date === today && t.dispatchTime && !['cancelled','expired','replaced'].includes(dtEffectiveStatus(t)));
    const lanes = {}, order = [];
    const laneFor = (key, name)=>{ if(!lanes[key]){ lanes[key] = { key, name, jobs: [] }; order.push(key); } return lanes[key]; };
    jobs.forEach(t=>{
      const ids = t.assignedWorkerIds || [];
      if(!ids.length){ laneFor('_un', 'Unassigned').jobs.push(t); return; }
      ids.forEach((id, i)=>{ laneFor(id, (byId[id] && byId[id].name) || (t.assignedWorkerNames || [])[i] || 'Technician').jobs.push(t); });
    });
    const rows = order.filter(k=> k !== '_un').map(k=> lanes[k]).sort((a, b)=> a.name.localeCompare(b.name));
    if(lanes._un) rows.unshift(lanes._un);
    if(!jobs.length){
      el.innerHTML = '<div class="empty-state">No job orders with a dispatch time today.</div>';
      $('prioBoardDetail').innerHTML = ''; $('prioBoardNote').textContent = '';
      return;
    }
    const starts = jobs.map(t=> prioHM(t.dispatchTime));
    const H0 = Math.max(0, Math.min(7, Math.floor(Math.min.apply(null, starts))));
    const H1 = Math.min(24, Math.max(18, Math.ceil(Math.max.apply(null, starts) + 2)));
    const span = H1 - H0;
    const pct = x=> ((x - H0) / span * 100);
    let h = '<div class="adm-b-hours"><div></div><div>';
    for(let i = H0; i < H1; i++) h += '<span>' + ((i % 12) || 12) + ' ' + (i < 12 ? 'AM' : 'PM') + '</span>';
    h += '</div></div>';
    rows.forEach((r, ri)=>{
      const initials = r.key === '_un' ? '?' : r.name.split(/\s+/).map(w=> w[0]).join('').slice(0, 2).toUpperCase();
      const color = r.key === '_un' ? '#5A6B62' : PRIO_BOARD_COLORS[ri % PRIO_BOARD_COLORS.length];
      h += '<div class="adm-b-lane"><div class="adm-b-who"><span class="adm-b-av" style="background:' + color + '">' + escapeHtml(initials) + '</span><div><b>' + escapeHtml(r.name) + '</b>' +
        (r.key === '_un' ? '<small>Needs a technician</small>' : '') + '</div></div><div class="adm-b-track">';
      r.jobs.forEach(t=>{
        const a = prioHM(t.dispatchTime), k = prioJobKind(t);
        h += '<button type="button" class="adm-b-job ' + k + '" aria-pressed="false" data-id="' + escapeHtml(String(t.id)) + '" style="left:' + pct(a) + '%;width:calc(' + (2 / span * 100) + '% - 3px)" title="' +
          escapeHtml((t.jobOrderNo || '') + ' · ' + (t.custName || '')) + '"><b>' + escapeHtml(t.jobOrderNo || t.id) + '</b><span>' + escapeHtml(t.custName || '') + '</span></button>';
      });
      h += '</div></div>';
    });
    const off = parseInt(BUSINESS_TZ_OFFSET, 10) || 8;
    const nd = new Date(dtNowMs() + off * 3600000), nowH = nd.getUTCHours() + nd.getUTCMinutes() / 60;
    if(nowH >= H0 && nowH <= H1) h += '<div class="adm-b-now" data-t="' + prioFmtHour(nowH).replace(' AM', '').replace(' PM', '') + '" style="left:calc(132px + (100% - 132px) * ' + ((nowH - H0) / span) + ')"></div>';
    el.style.setProperty('--n', span);
    el.innerHTML = h;
    prioBoardData = { jobs, lanes };
    if(!prioBoardSel || !jobs.some(t=> String(t.id) === prioBoardSel)){
      const first = jobs.find(t=> dtIsLateDispatch(t)) || null; prioBoardSel = first ? String(first.id) : null;
    }
    prioBoardPick(prioBoardSel);
    el.onclick = e=>{ const b = e.target.closest('.adm-b-job'); if(b) prioBoardPick(b.dataset.id); };
    const open = $('prioBoardOpen'); if(open) open.onclick = ()=>{ const l = $('sbNavDispatch'); if(l) l.click(); };
    const free = users.filter(u=> !lanes[u.id]).length;
    $('prioBoardNote').textContent = (free ? free + ' technician' + (free === 1 ? ' has' : 's have') + ' no job order today. ' : '') + 'Blocks show the dispatch time, not the job length.';
  }
  function prioBoardPick(id){
    const el = $('prioBoard'), det = $('prioBoardDetail'); if(!el || !det) return;
    prioBoardSel = id ? String(id) : null;
    el.querySelectorAll('.adm-b-job').forEach(b=> b.setAttribute('aria-pressed', String(b.dataset.id === prioBoardSel)));
    const t = prioBoardData && prioBoardData.jobs.find(x=> String(x.id) === prioBoardSel);
    if(!t){ det.innerHTML = ''; return; }
    const k = prioJobKind(t), crew = (t.assignedWorkerNames || []).join(', ') || 'No technician yet';
    det.innerHTML = '<div><b>' + escapeHtml((t.jobOrderNo || t.id) + ', ' + (t.custName || 'Customer')) + '</b><small>' + escapeHtml(crew + ', dispatch ' + prioFmtHour(prioHM(t.dispatchTime)) + '. ' + prioJobLabel(t, k)) + '</small></div>' +
      '<button type="button" class="adm-b-open" id="prioBoardOpenJo">Open job order</button>';
    const b = $('prioBoardOpenJo'); if(b) b.onclick = ()=> dtOpenTicketOverlay(t.id);
  }
  // ---- sidebar counts ----
  // Every sidebar page and category carries a number for what is waiting on the
  // admin there, drawn from the same two sources as "Needs you now" so the two
  // always agree:
  //   * the ranked list (late job orders, requisitions, leave, cash advances ...)
  //   * the raw Inbox rows the list does not have its own rule for (receive a
  //     PO, tool defects, pay runs, errands ...), each carrying the module it
  //     belongs to — SB_MODULE_LINK says which sidebar page that is.
  // Red = something late / escalated, amber = needs action, grey = only a
  // heads-up (below reorder level). A category shows the total of its pages.
  // Inbox items the list already has a rule for; prioBuild and the counts below
  // must agree on this, so there is one copy.
  const PRIO_COVERED = new Set(['mr_review','ca_approve','rb_approve','ca_release','rb_pay','liq_review','liq_settle','leave_decide',
    'jo_review','report_signoff','sr_new','jo_late','jo_overdue','po_draft']);
  const SB_MODULE_LINK = {
    'pur.requisitions':'sbNavRequisitions', 'pur.purchase_orders':'sbNavPurchaseOrders', 'pur.suppliers':'sbNavSuppliers', 'pur.materials':'sbNavMaterials',
    'inv.stock':'sbNavStock', 'inv.receive':'sbNavReceive', 'inv.issue':'sbNavIssue', 'inv.returns':'sbNavReturns',
    'inv.transfers':'sbNavTransfers', 'inv.slips':'sbNavSlips', 'inv.reports':'sbNavInvReports', 'inv.warehouses':'sbNavWarehouses',
    'fin.cash_advance':'sbNavCashAdvance', 'fin.liquidation':'sbNavLiquidation', 'fin.reimbursement':'sbNavReimbursement',
    'fin.payroll_approve':'sbNavPayApprove', 'fin.payroll_rules':'sbNavPayRules',
    'hr.leaves':'sbNavLeave', 'hr.timesheets':'sbNavPayTimesheets', 'hr.payroll_runs':'sbNavPayRuns', 'hr.payroll_setup':'sbNavPaySetup', 'hr.attendance':'sbNavTechnicians',
    'hr.staff_attendance':'sbNavTechnicians', 'hr.tech_profiles':'sbNavTechnicians', 'ops.technicians':'sbNavTechnicians',
    'tools.register':'sbNavTlRegister', 'tools.issue':'sbNavTlIssue', 'tools.return':'sbNavTlReturn', 'tools.handover':'sbNavTlHandover',
    'tools.defects':'sbNavTlDefects', 'tools.maintenance':'sbNavTlMaint',
    'adm.errands':'sbNavErrands', 'adm.permits':'sbNavAdmPermits', 'adm.vehicles':'sbNavAdmVehicles', 'adm.contracts':'sbNavAdmContracts',
    'adm.bills':'sbNavAdmBills', 'adm.assets':'sbNavAdmAssets', 'adm.announcements':'menuManageAnnouncements',
    'adm.customers':'menuManageCustomers', 'adm.equipment':'menuManageEquipment',
    'ops.dispatch':'sbNavDispatch', 'ops.service_reports':'menuManageReports'
    // ops.service_requests is deliberately absent: that page keeps its own live badge (srRefreshAdminCounts)
  };
  let prioSbManaged = new Set();
  function prioSbPaint(id, o){
    const link = $(id); if(!link) return;
    let b = link.querySelector('.sidebar-badge');
    const show = !!o && (o.act > 0 || o.watch > 0);
    if(!b){ if(!show) return; b = document.createElement('span'); b.className = 'sidebar-badge'; link.appendChild(b); }
    if(!show){ b.textContent = ''; b.style.display = 'none'; b.removeAttribute('title'); b.classList.remove('is-late', 'is-watch'); return; }
    const act = o.act > 0;
    b.textContent = String(act ? o.act : o.watch);
    b.style.display = '';
    b.classList.toggle('is-late', act && o.red);
    b.classList.toggle('is-watch', !act);
    b.title = Object.keys(o.why).map(w=> o.why[w] + ' ' + w).join(' \u00B7 ');
  }
  function prioSidebarCounts(base, extra, items){
    extra = extra || {};
    const nav = {};
    const bump = (id, n, sev, why)=>{
      if(!id || !(n > 0)) return;
      const o = nav[id] || (nav[id] = { act:0, watch:0, red:false, why:{} });
      if(sev === 'watch') o.watch += n; else { o.act += n; if(sev === 'red') o.red = true; }
      if(why) o.why[why] = (o.why[why] || 0) + n;
    };
    // a grouped item ("3 job orders to review") stands for N records: N is in its title
    const num = it=> parseInt(String(it.title || ''), 10) || 1;
    (items || []).forEach(it=>{
      const k = String(it.key || '');
      const sev = it.tier === 'urgent' ? 'red' : (it.tier === 'watch' ? 'watch' : 'act');
      if(/^(late|exp|overdue|long):/.test(k)) bump('sbNavDispatch', 1, sev, k.indexOf('late') === 0 ? 'late' : k.indexOf('exp') === 0 ? 'expired' : k.indexOf('overdue') === 0 ? 'overdue' : 'running long');
      else if(k === 'jorev')   bump('sbNavDispatch', num(it), sev, 'to review');
      else if(k === 'nodisp')  bump('sbNavDispatch', num(it), 'watch', 'without a dispatch time');
      else if(k === 'srsignoff' || k === 'srsign') bump('menuManageReports', num(it), sev, 'to sign off');
      else if(k.indexOf('mr:') === 0)     bump('sbNavRequisitions', 1, sev, 'to review');
      else if(k.indexOf('poappr:') === 0) bump('sbNavPurchaseOrders', 1, sev, 'to approve');
      else if(k.indexOf('leave:') === 0)  bump('sbNavLeave', 1, sev, 'to decide');
      else if(k.indexOf('ca:') === 0)     bump('sbNavCashAdvance', 1, sev, 'to act on');
      else if(k.indexOf('liq:') === 0)    bump('sbNavLiquidation', 1, sev, 'to review');
      else if(k.indexOf('rel:') === 0)    bump('sbNavReimbursement', 1, sev, 'to act on');
      else if(k === 'settle')  bump('sbNavReimbursement', num(it), sev, 'to settle');
      else if(k === 'reorder') bump('sbNavStock', (extra.reorder || []).length, 'watch', 'below reorder level');
    });
    // Inbox rows without a rule of their own, one count per record
    (extra.inbox || []).forEach(x=>{
      if(!x || PRIO_COVERED.has(x.kind) || /_endorse$/.test(x.kind || '')) return;
      const id = SB_MODULE_LINK[x.module]; if(!id) return;
      const sev = x.state === 'escalated' ? 'red' : (x.state === 'overdue' || x.level === 'approve') ? 'act' : 'watch';
      const lbl = String(x.label || 'waiting'); bump(id, 1, sev, lbl.charAt(0).toLowerCase() + lbl.slice(1));
    });

    // paint pages; clear any that had a number last time and have none now
    const ids = new Set(Object.keys(nav));
    prioSbManaged.forEach(id=>{ if(!ids.has(id)) prioSbPaint(id, null); });
    ids.forEach(id=> prioSbPaint(id, nav[id]));
    prioSbManaged = ids;

    // categories: the total of their pages
    const cats = {};
    ids.forEach(id=>{
      const link = $(id), sec = link && link.closest('.sb-section'); if(!sec) return;
      const c = cats[sec.dataset.sbKey] || (cats[sec.dataset.sbKey] = { act:0, watch:0, red:false });
      c.act += nav[id].act; c.watch += nav[id].watch; if(nav[id].red) c.red = true;
    });
    document.querySelectorAll('#sidebarAdminGroup .sb-section[data-sb-key] .sb-count').forEach(el=>{
      const c = cats[el.closest('.sb-section').dataset.sbKey];
      const act = !!c && c.act > 0, n = !c ? 0 : (act ? c.act : c.watch);
      el.textContent = n > 0 ? String(n) : '';
      el.classList.toggle('is-late', act && c.red);
      el.classList.toggle('is-watch', !!c && !act && n > 0);
    });

    // Inbox itself: everything waiting across departments
    const ib = $('sbInboxBadge');
    if(ib){ const n = (extra.inbox || []).length; ib.textContent = n > 0 ? String(n) : ''; ib.style.display = n > 0 ? '' : 'none'; }
    if(typeof sbSyncTitles === 'function') sbSyncTitles();
  }

  function prioRenderStatusLine(){
    const el = $('admStatusLine'); if(!el) return;
    const tk = ((prioLastBase && prioLastBase.tickets) || []).filter(t=> t.date === todayISO());
    const late = tk.filter(t=> dtIsLateDispatch(t) && dtEffectiveStatus(t) !== 'expired').length;
    const un = tk.filter(t=> !(t.assignedWorkerIds || []).length && !dtIsTerminal(t)).length;
    const waiting = prioLastItems.filter(i=> i.tier !== 'watch').length;
    el.textContent = late ? late + ' job order' + (late === 1 ? ' is' : 's are') + ' running late.'
      : un ? un + ' job order' + (un === 1 ? ' has' : 's have') + ' no technician.'
      : waiting ? waiting + ' item' + (waiting === 1 ? ' needs' : 's need') + ' you today.'
      : 'Everything is on track today.';
  }

  async function prioRender(base){
    if(!currentUser || currentUser.role !== 'admin'){ $('prioCard').style.display = 'none'; $('prioTechCard').style.display = 'none'; if($('prioBoardCard')) $('prioBoardCard').style.display = 'none'; if($('prioProgressCard')) $('prioProgressCard').style.display = 'none'; if($('admStatusLine')) $('admStatusLine').textContent = ''; return; }
    $('prioCard').style.display = ''; $('prioTechCard').style.display = ''; if($('prioBoardCard')) $('prioBoardCard').style.display = ''; if($('prioProgressCard')) $('prioProgressCard').style.display = '';
    prioStartLive();
    try{
      const extra = await prioLoadExtras();
      prioLastItems = prioBuild(base, Object.assign({ custNames: {} }, extra));
      prioLastBase = base;
      try{ prioSidebarCounts(base, extra, prioLastItems); }catch(e){ console.warn('sidebar counts failed', e); }
      prioLastAt = Date.now();
      prioRenderList();
      prioRenderTechs(prioTechStatus(base));
      prioRenderBoard(base);
      prioRenderProgress(base);
      prioRenderStatusLine();
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
  let prioRefreshing = false, prioRefreshTimer = null, prioRt = null, prioLastAt = 0;
  function prioHomeVisible(){
    return !!prioLastBase && currentUser && currentUser.role === 'admin' && !document.hidden && $('homeScreen').style.display !== 'none';
  }
  async function prioRefreshLive(){
    // Off the homepage the sidebar counts still have to move, but a full
    // re-read every minute would be wasteful there: at most every 3 minutes.
    const away = !prioHomeVisible() && !!prioLastBase && currentUser && currentUser.role === 'admin' && !document.hidden && (Date.now() - prioLastAt > 180000);
    if((!prioHomeVisible() && !away) || prioRefreshing) return;
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
