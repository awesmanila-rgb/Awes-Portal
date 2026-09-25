// ---------- Header title (changes per feature page) ----------
  function setHeaderTitle(title, sub){
    $('brandName').textContent = title;
    $('brandSub').textContent = sub || '';
  }

  async function showDtrView(){
    document.body.classList.remove('dashboard-active');
    $('homeScreen').style.display = 'none';
    $('serviceReportView').style.display = 'none';
    $('leaveView').style.display = 'none';
    $('cashAdvanceView').style.display = 'none';
    $('dispatchView').style.display = 'none';
    $('equipmentManagerView').style.display = 'none';
    $('customersManagerView').style.display = 'none';
    $('serviceReportsManagerView').style.display = 'none';
    $('messagesView').style.display = 'none';
    $('documentsView').style.display = 'none';
    if($('financeHrView')) $('financeHrView').style.display = 'none';
    $('customerHistoryView').style.display = 'none';
    $('serviceRequestsView').style.display = 'none';
    if($('purchasingView')) $('purchasingView').style.display = 'none';
    $('dtrView').style.display = '';
    $('footerBar').style.display = 'none';
    $('metaBar').style.display = 'none';
    $('homeBtn').style.display = '';
    setHeaderTitle('Online DTR', 'Daily Time Record');
    window.scrollTo({top:0});
    if(currentUser && currentUser.role==='admin'){
      // Admin has no DTR of their own — DTR is per-technician. Land on the
      // attendance table (today's status for everyone); "View DTR" on a
      // row drills into that one technician's read-only history below.
      $('dtrTechCard').style.display = 'none';
      $('dtrAdminTableCard').style.display = '';
      $('dtrAdminViewingCard').style.display = 'none';
      $('dtrHistoryCard').style.display = 'none';
      dtrViewingUser = null;
      $('dtrHistoryList').innerHTML = '<div class="empty-state">Select a technician to view their DTR.</div>';
      dtrRenderAdminTable();
    }else if(currentUser){
      $('dtrTechCard').style.display = '';
      $('dtrAdminTableCard').style.display = 'none';
      $('dtrAdminViewingCard').style.display = 'none';
      $('dtrHistoryCard').style.display = '';
      $('dtrTechName').textContent = currentUser.name;
      dtrViewingUser = null;
      await dtrRenderDeviceBanner();
      await dtrRenderTodayStatus();
      await dtrRenderHistory();
    }
  }

  // ---------- Manage Equipment List — full page (admin-only), reached via
  // the "Equipment" sidebar nav item. Was previously a popup sheet; now its
  // own dedicated page, same pattern as the other full-page views above. ----------
  async function showEquipmentManagerView(){
    document.body.classList.remove('dashboard-active');
    $('homeScreen').style.display = 'none';
    $('serviceReportView').style.display = 'none';
    $('leaveView').style.display = 'none';
    $('cashAdvanceView').style.display = 'none';
    $('dispatchView').style.display = 'none';
    $('dtrView').style.display = 'none';
    $('equipmentManagerView').style.display = '';
    $('customersManagerView').style.display = 'none';
    $('serviceReportsManagerView').style.display = 'none';
    $('messagesView').style.display = 'none';
    $('documentsView').style.display = 'none';
    if($('financeHrView')) $('financeHrView').style.display = 'none';
    $('customerHistoryView').style.display = 'none';
    $('serviceRequestsView').style.display = 'none';
    if($('purchasingView')) $('purchasingView').style.display = 'none';
    $('footerBar').style.display = 'none';
    $('metaBar').style.display = 'none';
    $('homeBtn').style.display = '';
    setHeaderTitle('Equipment', 'Manage Equipment List');
    window.scrollTo({top:0});
    await openEquipmentManagerPage();
  }
  $('menuManageEquipment').addEventListener('click', async ()=>{
    closeMainMenu();
    setSidebarActive('menuManageEquipment');
    if(!(await ensureAdminAuthenticated())) return;
    showEquipmentManagerView();
  });

  // ---------- Manage Customers — full page (admin-only), reached via the
  // "Customers" sidebar nav item. Was previously a popup sheet; now its own
  // dedicated page, same pattern as the other full-page views above. ----------
  async function showCustomersManagerView(){
    document.body.classList.remove('dashboard-active');
    $('homeScreen').style.display = 'none';
    $('serviceReportView').style.display = 'none';
    $('leaveView').style.display = 'none';
    $('cashAdvanceView').style.display = 'none';
    $('dispatchView').style.display = 'none';
    $('dtrView').style.display = 'none';
    $('equipmentManagerView').style.display = 'none';
    $('customersManagerView').style.display = '';
    $('serviceReportsManagerView').style.display = 'none';
    $('messagesView').style.display = 'none';
    $('documentsView').style.display = 'none';
    if($('financeHrView')) $('financeHrView').style.display = 'none';
    $('customerHistoryView').style.display = 'none';
    $('serviceRequestsView').style.display = 'none';
    if($('purchasingView')) $('purchasingView').style.display = 'none';
    $('footerBar').style.display = 'none';
    $('metaBar').style.display = 'none';
    $('homeBtn').style.display = '';
    setHeaderTitle('Customers', 'Manage Customers');
    window.scrollTo({top:0});
    await openCustomersManagerPage();
  }

  // ---------- Customer History — full page (admin-only), reached via the
  // "History" action on a customer card in Manage Customers. Lands on the
  // customer's details plus every equipment record on file; tapping an
  // equipment record drills into that unit's full service-report history
  // (same drill-down pattern as the DTR attendance table above). ----------
  async function showCustomerHistoryView(c){
    document.body.classList.remove('dashboard-active');
    $('homeScreen').style.display = 'none';
    $('serviceReportView').style.display = 'none';
    $('leaveView').style.display = 'none';
    $('cashAdvanceView').style.display = 'none';
    $('dispatchView').style.display = 'none';
    $('dtrView').style.display = 'none';
    $('equipmentManagerView').style.display = 'none';
    $('customersManagerView').style.display = 'none';
    $('serviceReportsManagerView').style.display = 'none';
    $('messagesView').style.display = 'none';
    $('documentsView').style.display = 'none';
    if($('financeHrView')) $('financeHrView').style.display = 'none';
    $('serviceRequestsView').style.display = 'none';
    if($('purchasingView')) $('purchasingView').style.display = 'none';
    $('customerHistoryView').style.display = '';
    $('footerBar').style.display = 'none';
    $('metaBar').style.display = 'none';
    $('homeBtn').style.display = '';
    setHeaderTitle('Customer History', c.name);
    window.scrollTo({top:0});
    await openCustomerHistoryPage(c);
  }
  $('custHistBackToListBtn').addEventListener('click', ()=> showCustomersManagerView());
  $('custHistBackToEquipBtn').addEventListener('click', ()=> custHistShowEquipList());

  // ---------- Manage Service Reports — full page (admin-only), reached via
  // the "Service Reports" sidebar nav item. Was previously the "Saved
  // Reports" popup sheet; now its own dedicated page with All / Draft /
  // Completed tabs and a search bar. ----------
  async function showServiceReportsManagerView(){
    document.body.classList.remove('dashboard-active');
    $('homeScreen').style.display = 'none';
    $('serviceReportView').style.display = 'none';
    $('leaveView').style.display = 'none';
    $('cashAdvanceView').style.display = 'none';
    $('dispatchView').style.display = 'none';
    $('dtrView').style.display = 'none';
    $('equipmentManagerView').style.display = 'none';
    $('customersManagerView').style.display = 'none';
    $('serviceReportsManagerView').style.display = '';
    $('messagesView').style.display = 'none';
    $('documentsView').style.display = 'none';
    if($('financeHrView')) $('financeHrView').style.display = 'none';
    $('customerHistoryView').style.display = 'none';
    $('serviceRequestsView').style.display = 'none';
    if($('purchasingView')) $('purchasingView').style.display = 'none';
    $('footerBar').style.display = 'none';
    $('metaBar').style.display = 'none';
    $('homeBtn').style.display = '';
    setHeaderTitle('Service Reports', 'Saved Reports');
    window.scrollTo({top:0});
    await openServiceReportsManagerPage();
  }

  // ---------- Home screen greeting (technicians only) ----------
  // Big, plain greeting plus today's attendance. The attendance strip opens
  // the DTR screen, where Time In/Out is actually recorded. The old fixed
  // "how to use Job Orders" paragraph is gone — Need to do now below tells
  // the technician what to do, based on where they actually are.
  let thLastDtr = null;
  function thFmtClock(iso){
    return iso ? new Date(iso).toLocaleTimeString('en-PH', {hour:'numeric', minute:'2-digit'}) : null;
  }
  function thRenderGreeting(todayDtr){
    const card = $('homeGreetingCard');
    if(!card) return;
    if(!currentUser || currentUser.role==='admin'){ card.style.display = 'none'; return; }
    card.style.display = '';
    const now = new Date();
    const h = now.getHours();
    const part = h < 12 ? 'Good morning' : (h < 18 ? 'Good afternoon' : 'Good evening');
    const first = String(currentUser.name||'').trim().split(/\s+/)[0] || '';
    const dateStr = now.toLocaleDateString('en-PH', {weekday:'long', month:'short', day:'numeric'});
    const tIn = todayDtr && todayDtr.timeIn, tOut = todayDtr && todayDtr.timeOut;
    // Overtime is a second shift logged after Time Out — only shown once it
    // has started, so a normal day keeps the strip to one line.
    const otIn = todayDtr && todayDtr.otTimeIn, otOut = todayDtr && todayDtr.otTimeOut;
    const loading = todayDtr === undefined;
    const val = (iso, missing)=> iso
      ? '<b>'+thFmtClock(iso)+'</b>'
      : '<b class="'+(missing ? 'th-missing' : 'th-dim')+'">'+(loading ? '…' : (missing ? 'Not yet' : '—'))+'</b>';
    $('homeGreetingText').innerHTML =
      '<div class="th-greet">'+
        '<h1 class="th-greet-name">'+part+(first ? ', '+escapeHtml(first) : '')+'</h1>'+
        '<p class="th-greet-date">'+escapeHtml(dateStr)+'</p>'+
      '</div>'+
      '<button type="button" class="th-attend'+(!loading && !tIn ? ' th-attend-warn' : '')+'" id="greetAttendLink">'+
        '<span class="th-attend-ic">'+icon('clock')+'</span>'+
        '<span class="th-attend-body">'+
          '<span class="th-attend-label">Attendance today</span>'+
          '<span class="th-attend-vals"><span>Time in: '+val(tIn, true)+'</span><span>Time out: '+val(tOut, !!tIn)+'</span></span>'+
          (otIn ? '<span class="th-attend-vals th-attend-ot"><span>OT in: '+val(otIn, true)+'</span><span>OT out: '+val(otOut, true)+'</span></span>' : '')+
        '</span>'+
        '<span class="th-attend-go">Open ›</span>'+
      '</button>';
  }
  async function renderHomeGreeting(){
    if(!currentUser || currentUser.role==='admin'){ const c=$('homeGreetingCard'); if(c) c.style.display='none'; return; }
    // Draw straight away (cached attendance, or "…"), then the full
    // homepage render below refreshes it with today's real record.
    thRenderGreeting(thLastDtr && thLastDtr.date===todayISO() ? thLastDtr.rec : undefined);
  }

  // ---------- Need to do now (technician only) ----------
  // Replaces the old 5-slide Overview carousel. Built for technicians who
  // are not used to apps: every action waiting on them is its own card with
  // a big title, one plain sentence, and one full-width button, ranked so
  // the first card is always the thing to do first.
  //
  // Ranking (lower = first):
  //   10 Time in            20 Finish service reports   30 Arrived at site
  //   35 Acknowledge (late) 40 Acknowledge              45 Waiting on crew (info)
  //   50 Report drafts      55 Material request to fix  60 Sign tool slip
  //   61 Sign material slip 62 Return overdue tools     70 Liquidate
  //   80 Unread messages    90 Time out
  // Things waiting on ADMIN are listed separately under "Waiting for
  // approval" — they are not the technician's job, so they never appear as
  // a numbered step.
  function thFmtHm(hm){
    if(!hm) return '';
    const m = /^(\d{1,2}):(\d{2})/.exec(hm);
    if(!m) return hm;
    let hh = Number(m[1]); const ap = hh>=12 ? 'PM' : 'AM';
    hh = hh%12 || 12;
    return hh+':'+m[2]+' '+ap;
  }
  function thDayWord(iso){
    const t = todayISO();
    if(iso===t) return 'Today';
    const d = new Date(t+'T00:00:00'); d.setDate(d.getDate()+1);
    const tom = d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
    if(iso===tom) return 'Tomorrow';
    return new Date(iso+'T00:00:00').toLocaleDateString('en-PH', {weekday:'short', month:'short', day:'numeric'});
  }
  function thMates(r){
    const n = (r.assignedWorkerNames||[]).filter(x=> x && x!==currentUser.name);
    return n.length ? 'With '+n.join(', ') : '';
  }
  function thJoWhere(r){
    return [r.custName, r.siteAddress].filter(Boolean).join(' · ');
  }
  // 3-step job tracker: Accept → Arrive at site → Report.
  function thStepperHtml(cur, tone){
    const labels = ['Accept', 'Arrive at site', 'Report'];
    let html = '<div class="th-steps">';
    labels.forEach((_, i)=>{
      const n = i+1;
      const cls = n < cur ? 'done' : (n===cur ? 'cur th-'+tone : '');
      if(i>0) html += '<span class="th-step-line'+(n<=cur ? ' done' : '')+'"></span>';
      html += '<span class="th-step-dot '+cls+'">'+(n<cur ? icon('check') : n)+'</span>';
    });
    html += '</div><div class="th-step-labels">'+labels.map(l=> '<span>'+l+'</span>').join('')+'</div>';
    return html;
  }
  // Cheap reads for the slip / tool / requisition tasks. Each one is
  // optional — a missing table (feature not set up yet) just contributes
  // nothing rather than breaking the homepage.
  async function thLoadExtras(){
    const out = { toolSlips:0, overdueTools:0, matSlips:0, reqs:[] };
    if(!db || !(await ensureCloud().catch(()=>false))) return out;
    const safe = (p)=> p.then(r=> (r && !r.error) ? (r.data||[]) : []).catch(()=> []);
    const [tools, slips, iss, reqs] = await Promise.all([
      safe(db.from('tools_view').select('status, due_back').eq('holder_id', currentUser.id)),
      safe(db.from('tool_slips').select('type, to_worker_id, from_worker_id').eq('status', 'pending_signature')),
      safe(db.from('issue_slips').select('id').eq('worker_id', currentUser.id).eq('status', 'issued')),
      safe(db.from('material_requisitions').select('id, mrf_no, status, job_order, created_at, reviewed_at')
        .eq('requested_by', currentUser.id).order('created_at', { ascending:false }).limit(30))
    ]);
    out.toolSlips = slips.filter(x=> (x.type==='issue' && x.to_worker_id===currentUser.id) || (x.type==='return' && x.from_worker_id===currentUser.id)).length;
    out.overdueTools = tools.filter(t=> t.status==='issued' && t.due_back && t.due_back < todayISO()).length;
    out.matSlips = iss.length;
    out.reqs = reqs;
    return out;
  }

  let techOvChannel = null, techOvTimer = null, techOvBusy = false;
  function techOvVisible(){
    return !!currentUser && currentUser.role !== 'admin' && currentUser.role !== 'customer' &&
      !document.hidden && $('homeScreen') && $('homeScreen').style.display !== 'none';
  }
  async function techOvRefresh(){
    if(!techOvVisible() || techOvBusy) return;
    techOvBusy = true;
    try{ await renderHomeTechOverview(); }finally{ techOvBusy = false; }
  }
  function techOvRefreshSoon(){ clearTimeout(techOvTimer); techOvTimer = setTimeout(techOvRefresh, 1500); }
  function techOvStartLive(){
    if(techOvChannel || !db || !db.channel || !currentUser) return;
    try{
      techOvChannel = db.channel('tech-home-'+currentUser.id)
        .on('postgres_changes', { event:'*', schema:'public', table:'dispatch_tickets' }, techOvRefreshSoon)
        .subscribe();
    }catch(e){ techOvChannel = null; }
  }
  function techOvStopLive(){
    if(techOvChannel && db){ try{ db.removeChannel(techOvChannel); }catch(e){} }
    techOvChannel = null;
  }
  setInterval(techOvRefresh, 60000);
  document.addEventListener('visibilitychange', ()=>{ if(!document.hidden) techOvRefreshSoon(); });

  async function renderHomeTechOverview(){
    const card = $('homeTechOverviewCard');
    if(!currentUser || currentUser.role==='admin'){ card.style.display = 'none'; techOvStopLive(); return; }
    card.style.display = '';
    techOvStartLive();

    const [tickets, reporterTickets, reports, cashAdvances, leaves, unreadCount, todayDtr, extras] = await Promise.all([
      dtListForWorker(currentUser.id).catch(()=>[]),
      dtListForReporter(currentUser.id).catch(()=>[]),
      cloudListReports().catch(()=>null),
      caListForUser(currentUser.id).catch(()=>[]),
      leaveListForUser(currentUser.id).catch(()=>[]),
      dtCountUnreadMessages().catch(()=>0),
      dtrGetDay(currentUser.id, todayISO()).catch(()=>null),
      thLoadExtras().catch(()=> ({ toolSlips:0, overdueTools:0, matSlips:0, reqs:[] }))
    ]);
    thLastDtr = { date: todayISO(), rec: todayDtr };
    thRenderGreeting(todayDtr);

    const tasks = [];
    const add = (t)=> tasks.push(t);
    const today = todayISO();
    const timedIn = !!(todayDtr && todayDtr.timeIn);
    const timedOut = !!(todayDtr && todayDtr.timeOut);
    const reporterIds = new Set((reporterTickets||[]).map(t=> t.id));

    // What this technician should see of each ticket (a replaced tech sees
    // their frozen copy — and dtIsTerminal drops it, so it never shows).
    // Seeding dtLastTicketsById is what lets Acknowledge / Arrived from the
    // homepage send the same customer + admin notifications as from My Job
    // Order, since those read the ticket from this cache.
    const mine = (tickets||[]).map(t=>{ const v = dtViewFor(t, currentUser.id); dtLastTicketsById[v.id] = v; return v; });
    const live = mine.filter(t=> !dtIsTerminal(t));
    const sortKey = (r)=> (r.date||'')+' '+(r.dispatchTime||r.expectedTime||'');

    if(!timedIn){
      add({ rank:10, tone:'green', ic:'clock', title:'Time in for today',
        sub:'Record your attendance before you start work.', btn:'Time in now', act:'dtr' });
    }

    live.forEach(r=>{
      const stage = dtEffectiveStatus(r);
      const ackd = (r.acknowledgedBy||[]).includes(currentUser.id);
      const jo = escapeHtml(r.jobOrderNo || r.id);
      const where = escapeHtml(thJoWhere(r));
      const mates = thMates(r);
      const mateLine = mates ? '<br>'+escapeHtml(mates) : '';
      if(stage==='in_progress'){
        const items = r.equipmentList||[];
        const pending = items.filter(it=> !it.reportSrNo && !it.notDone).length;
        const done = items.length - pending;
        if(pending===0) return;
        if(reporterIds.has(r.id)){
          add({ rank:20, key:sortKey(r), tone:'amber', ic:'file',
            title:'Finish '+pending+' service report'+(pending===1?'':'s'),
            sub: jo+(where ? ' · '+where : '')+'<br>'+done+' of '+items.length+' units done',
            steps:3, btn:'Open reports', act:'report', id:r.id });
        }else{
          add({ rank:46, key:sortKey(r), tone:'gray', ic:'people', info:true,
            title:'Work in progress · '+jo,
            sub:(where ? where+'<br>' : '')+'Your teammate files the service reports for this job.' });
        }
      }else if(stage==='acknowledged'){
        if(r.arrivedAt) return;
        add({ rank:30, key:sortKey(r), tone:'amber', ic:'pin',
          title:'Tap when you reach the site',
          sub: jo+(where ? ' · '+where : '')+(r.expectedTime ? '<br>Expected at site '+thFmtHm(r.expectedTime) : '')+mateLine,
          steps:2, btn:'Arrived at Site', act:'arrived', id:r.id, jo:r.jobOrderNo });
      }else if(stage==='preparing'){
        if(ackd){
          const assigned = (r.assignedWorkerIds||[]).length;
          const acked = (r.acknowledgedBy||[]).filter(id=> (r.assignedWorkerIds||[]).includes(id)).length;
          add({ rank:45, key:sortKey(r), tone:'gray', ic:'people', info:true,
            title:'Waiting for your teammates · '+jo,
            sub: acked+' of '+assigned+' have accepted. You can tap Arrived at Site once everyone accepts.', steps:1 });
          return;
        }
        const late = dtIsLateDispatch(r);
        add({ rank: late ? 35 : 40, key:sortKey(r), tone: late ? 'red' : 'green', ic:'truck',
          tag: late ? 'Late' : null,
          title:'Accept job order '+jo,
          sub: (where ? where+'<br>' : '')+thDayWord(r.date)+(r.dispatchTime ? ' · leave by '+thFmtHm(r.dispatchTime) : (r.expectedTime ? ' · at site '+thFmtHm(r.expectedTime) : ''))+mateLine,
          steps:1, btn:'Acknowledge', act:'ack', id:r.id, jo:r.jobOrderNo });
      }
    });

    const drafts = reports===null ? [] : reports.filter(r=> r.technicianId===currentUser.id && !r.completed);
    if(drafts.length){
      add({ rank:50, tone:'amber', ic:'edit',
        title:'Finish '+drafts.length+' saved report draft'+(drafts.length===1?'':'s'),
        sub:'You started '+(drafts.length===1 ? 'this report' : 'these reports')+' but did not submit yet.',
        btn:'Open drafts', act:'drafts' });
    }
    const reqFix = (extras.reqs||[]).filter(q=> q.status==='returned' || q.status==='draft');
    if(reqFix.length){
      const returned = reqFix.filter(q=> q.status==='returned').length;
      add({ rank:55, tone: returned ? 'red' : 'blue', ic:'package',
        title: returned ? 'Fix your material request' : 'Submit your material request',
        sub: returned ? 'Admin sent '+(returned===1 ? 'a request' : returned+' requests')+' back. Open it to see what to change.'
                      : (reqFix.length===1 ? 'A request' : reqFix.length+' requests')+' is saved but not sent to admin yet.',
        btn:'Open requests', act:'requests' });
    }
    if(extras.toolSlips){
      add({ rank:60, tone:'blue', ic:'edit', title:'Sign for tools',
        sub:extras.toolSlips+' tool slip'+(extras.toolSlips===1?'':'s')+' waiting for your signature.',
        btn:'Sign slip', act:'tools' });
    }
    if(extras.matSlips){
      add({ rank:61, tone:'blue', ic:'edit', title:'Sign for materials',
        sub:extras.matSlips+' material slip'+(extras.matSlips===1?'':'s')+' waiting for your signature.',
        btn:'Sign slip', act:'materials' });
    }
    if(extras.overdueTools){
      add({ rank:62, tone:'red', ic:'tools', tag:'Overdue',
        title:'Return '+extras.overdueTools+' tool'+(extras.overdueTools===1?'':'s'),
        sub:'Past the return date. Bring '+(extras.overdueTools===1 ? 'it' : 'them')+' back to the warehouse.',
        btn:'See my tools', act:'tools' });
    }
    const liq = (cashAdvances||[]).filter(r=> r.kind!=='reimbursement').filter(caNeedsLiquidation);
    if(liq.length){
      const fix = liq.filter(r=> r.liquidation && r.liquidation.status==='disapproved').length;
      const waiting = liq.filter(r=> r.liquidation && r.liquidation.status==='pending').length;
      const todo = liq.length - waiting;
      if(todo>0){
        const one = liq.find(r=> !(r.liquidation && r.liquidation.status==='pending'));
        add({ rank:70, tone: fix ? 'red' : 'blue', ic:'receipt',
          title: fix ? 'Fix your liquidation' : 'Liquidate cash advance',
          sub: fix ? 'Admin sent it back. Open it to see what to correct.'
                   : (todo===1 && one ? caFmtPeso(one.amount)+(one.purpose ? ' · '+escapeHtml(one.purpose) : '') : todo+' cash advances')+'<br>Submit your receipts for the money you received.',
          btn:'Liquidate', act:'liquidate' });
      }
    }
    if(unreadCount>0){
      add({ rank:80, tone:'teal', ic:'chat',
        title:'Read '+unreadCount+' new message'+(unreadCount===1?'':'s'),
        sub:'Job order chat from admin or your teammates.', btn:'Open messages', act:'messages' });
    }
    if(timedIn && !timedOut){
      const busyToday = live.some(r=>{
        const st = dtEffectiveStatus(r);
        return st==='in_progress' || st==='acknowledged' || (st==='preparing' && r.date===today);
      });
      if(!busyToday || new Date().getHours() >= 17){
        add({ rank:90, tone:'green', ic:'logOut', title:'Time out',
          sub:'Record your time out before you go home.', btn:'Time out', act:'dtr' });
      }
    }

    if(todayDtr && todayDtr.otTimeIn && !todayDtr.otTimeOut){
      add({ rank:91, tone:'green', ic:'logOut', title:'Time out from overtime',
        sub:'Overtime started at '+thFmtClock(todayDtr.otTimeIn)+'. Record your OT time out when you finish.',
        btn:'OT time out', act:'dtr' });
    }
    tasks.sort((a,b)=> a.rank-b.rank || String(a.key||'').localeCompare(String(b.key||'')));
    thRenderTasks(tasks);
    thRenderWaiting(cashAdvances, leaves, extras.reqs);
    thRenderUpcoming(live);

    // Tile badges + the shared bell / nav badges.
    const msgB = $('techQaMsgBadge');
    if(msgB){ msgB.textContent = unreadCount ? unreadCount+' new' : ''; msgB.style.display = unreadCount ? '' : 'none'; }
    renderDashboardGreeting();
    const notifEl = $('notifBadge');
    if(notifEl){
      notifEl.textContent = unreadCount > 99 ? '99+' : String(unreadCount);
      notifEl.style.display = unreadCount > 0 ? '' : 'none';
    }
    const sidebarBadgeEl = $('sidebarMsgBadge');
    if(sidebarBadgeEl){ sidebarBadgeEl.style.display = unreadCount>0 ? '' : 'none'; sidebarBadgeEl.textContent = String(unreadCount); }
    const techMoreBadgeEl = $('techMoreMsgBadge');
    if(techMoreBadgeEl){ techMoreBadgeEl.style.display = unreadCount>0 ? '' : 'none'; techMoreBadgeEl.textContent = String(unreadCount); }
  }

  function thRenderTasks(tasks){
    const list = $('thTodoList');
    const actionable = tasks.filter(t=> !t.info);
    const late = tasks.filter(t=> t.tag==='Late' || t.tag==='Overdue').length;
    $('thTodoCount').innerHTML = actionable.length
      ? actionable.length+' task'+(actionable.length===1?'':'s')+(late ? ' · <span class="th-red-txt">'+late+' late</span>' : '')
      : '';
    if(!tasks.length){
      list.innerHTML =
        '<div class="th-card th-allclear">'+
          '<span class="th-ic th-green">'+icon('checkCircle')+'</span>'+
          '<div><h3 class="th-title">You are all caught up</h3>'+
          '<p class="th-sub">Nothing needs you right now. New job orders will show up here.</p></div>'+
        '</div>';
      return;
    }
    let step = 0, firstDone = false;
    list.innerHTML = tasks.map(t=>{
      let tag = '';
      let hero = false;
      if(t.info){
        tag = '<span class="th-tag th-gray">Waiting</span>';
      }else{
        step++;
        hero = !firstDone; firstDone = true;
        const label = 'Step '+step+(hero ? ' · Do this first' : '')+(t.tag ? ' · '+t.tag : '');
        tag = '<span class="th-tag th-'+(t.tag ? 'red' : (hero ? 'green' : 'gray'))+'">'+label+'</span>';
      }
      const stepCur = t.steps ? t.steps : 0;
      return '<div class="th-card'+(hero ? ' th-hero' : '')+(t.info ? ' th-info' : '')+'">'+
          tag+
          '<div class="th-top">'+
            '<span class="th-ic th-'+t.tone+'">'+icon(t.ic)+'</span>'+
            '<div class="th-text"><h3 class="th-title">'+t.title+'</h3><p class="th-sub">'+t.sub+'</p></div>'+
          '</div>'+
          (stepCur ? thStepperHtml(stepCur, t.tone==='gray' ? 'green' : t.tone) : '')+
          (t.btn ? '<button type="button" class="th-btn'+(hero ? ' th-btn-primary' : '')+'" data-th-act="'+t.act+'"'+
            (t.id ? ' data-id="'+escapeHtml(t.id)+'"' : '')+(t.jo ? ' data-jo="'+escapeHtml(t.jo)+'"' : '')+'>'+t.btn+'</button>' : '')+
        '</div>';
    }).join('');
  }

  function thRenderWaiting(cashAdvances, leaves, reqs){
    const rows = [];
    const row = (label, status, tone, act)=> rows.push(
      '<button type="button" class="th-wait-row" data-th-act="'+act+'"><span class="th-wait-label">'+label+'</span>'+
      '<span class="th-wait-st th-'+tone+'-txt">'+status+'</span></button>');
    (cashAdvances||[]).forEach(r=>{
      const what = r.kind==='reimbursement' ? 'Reimbursement' : 'Cash advance';
      const act = r.kind==='reimbursement' ? 'reimburse' : 'cashadvance';
      if(r.status==='pending') row(what+' · '+caFmtPeso(r.amount), 'Pending', 'amber', act);
      else if(r.status==='approved' && r.kind!=='reimbursement' && !r.disbursed) row(what+' · '+caFmtPeso(r.amount), 'Approved, not yet released', 'green', act);
      if(r.liquidation && r.liquidation.status==='pending') row('Liquidation · '+caFmtPeso(r.amount), 'Pending', 'amber', 'liquidate');
    });
    (leaves||[]).filter(l=> l.status==='pending').forEach(l=>{
      row(escapeHtml(l.leaveType||'Leave')+' · '+leaveFmtDate(l.dateFrom), 'Pending', 'amber', 'leave');
    });
    const weekAgo = new Date(Date.now() - 7*864e5).toISOString();
    (reqs||[]).forEach(q=>{
      const lbl = 'Material request '+escapeHtml(q.mrf_no || '');
      if(q.status==='submitted') row(lbl, 'Pending', 'amber', 'requests');
      else if(q.status==='approved' && String(q.reviewed_at||q.created_at||'') >= weekAgo) row(lbl, 'Approved', 'green', 'requests');
    });
    $('thWaitWrap').style.display = rows.length ? '' : 'none';
    $('thWaitList').innerHTML = rows.join('');
  }

  function thRenderUpcoming(live){
    const up = live.filter(r=> dtEffectiveStatus(r)==='scheduled' && r.date)
      .sort((a,b)=> a.date.localeCompare(b.date) || (a.dispatchTime||a.expectedTime||'').localeCompare(b.dispatchTime||b.expectedTime||''))
      .slice(0, 3);
    $('thUpcomingWrap').style.display = up.length ? '' : 'none';
    $('thUpcomingList').innerHTML = up.map(r=>{
      const t = r.dispatchTime ? 'leave by '+thFmtHm(r.dispatchTime) : (r.expectedTime ? 'at site '+thFmtHm(r.expectedTime) : '');
      return '<button type="button" class="th-card th-up" data-th-act="ticket" data-id="'+escapeHtml(r.id)+'">'+
          '<span class="th-ic th-gray">'+icon('calendar')+'</span>'+
          '<span class="th-text"><span class="th-title">'+escapeHtml(r.jobOrderNo||r.id)+(r.custName ? ' · '+escapeHtml(r.custName) : '')+'</span>'+
          '<span class="th-sub">'+thDayWord(r.date)+(t ? ' · '+t : '')+'<br>You can accept it from '+escapeHtml(dtWindowOpensText(r))+'</span></span>'+
          '<span class="th-chev">›</span>'+
        '</button>';
    }).join('');
  }

  // One delegated handler for every button on the technician homepage.
  // Acknowledge and Arrived at Site run right here (after a confirm), using
  // the exact same functions as My Job Order; everything else opens its own
  // screen.
  async function thHandleAct(e){
    const el = e.target.closest('[data-th-act]');
    if(!el) return;
    const act = el.dataset.thAct, id = el.dataset.id, jo = el.dataset.jo || 'this job order';
    if(act==='ack'){
      if(!await uiConfirm('Accept '+jo+'?\n\nThis tells admin you are taking this job.')) return;
      el.disabled = true; el.textContent = 'Saving…';
      try{ await dtAcknowledge(id); } finally { await renderHomeTechOverview().catch(()=>{}); }
      return;
    }
    if(act==='arrived'){
      if(!await uiConfirm('Record that you arrived at the site for '+jo+'?\n\nThe customer will be told work has started.')) return;
      try{ await dtMarkArrived(id, el); } finally { await renderHomeTechOverview().catch(()=>{}); }
      return;
    }
    if(act==='dtr') return showDtrView();
    if(act==='report') return showServiceReport();
    if(act==='drafts'){ showServiceReport(); srShowTab('draft'); return; }
    if(act==='requests') return showPurchasingView('myRequests');
    if(act==='tools') return showPurchasingView('myTools');
    if(act==='materials') return showPurchasingView('myMaterials');
    if(act==='messages') return showMessagesView();
    if(act==='leave') return showLeaveView();
    if(act==='ticket') return dtOpenTicketOverlay(id);
    if(act==='liquidate' || act==='cashadvance' || act==='reimburse'){
      await showCashAdvanceView();
      if(currentUser && currentUser.role!=='admin') caShowTab(act==='liquidate' ? 'liquidate' : act==='reimburse' ? 'reimburse' : 'history');
    }
  }
  $('homeTechOverviewCard').addEventListener('click', thHandleAct);

  // Lightweight badge refresh — called right after a message thread is
  // marked read (see dtRefreshMessages/dtOpenTicketOverlay in dispatch.js)
  // so the sidebar/bell badges drop immediately instead of waiting for the
  // next full Home overview render.
  async function refreshUnreadMsgBadges(){
    if(!currentUser) return;
    const unreadCount = await dtCountUnreadMessages().catch(()=>0);
    const sidebarBadgeEl = $('sidebarMsgBadge');
    if(sidebarBadgeEl){ sidebarBadgeEl.style.display = unreadCount>0 ? '' : 'none'; sidebarBadgeEl.textContent = String(unreadCount); }
    const techMoreBadgeEl = $('techMoreMsgBadge');
    if(techMoreBadgeEl){ techMoreBadgeEl.style.display = unreadCount>0 ? '' : 'none'; techMoreBadgeEl.textContent = String(unreadCount); }
    const notifEl = $('notifBadge');
    if(notifEl && currentUser.role!=='admin'){
      notifEl.textContent = unreadCount > 99 ? '99+' : String(unreadCount);
      notifEl.style.display = unreadCount > 0 ? '' : 'none';
    }
  }

  // ---------- Home screen overview (admin only) ----------
  // A management snapshot shown above the feature tiles once logged in as
  // admin — technician check-ins, requests awaiting a decision, dispatch
  // ticket load, and reports still short of a customer sign-off. Every
  // number here is a best-effort read of data other screens already own
  // (DTR, Cash Advance, Leave, Dispatch, Service Reports); nothing new is
  // stored just for this panel.
  async function renderHomeOverview(){
    const card = $('homeOverviewCard');
    if(!currentUser || currentUser.role!=='admin'){
      card.style.display = 'none';
      const trackerCard = $('homeTrackerCard');
      if(trackerCard) trackerCard.style.display = 'none';
      const techListCard = $('homeTechListCard');
      if(techListCard) techListCard.style.display = 'none';
      const actCard = $('homeActivityCard');
      if(actCard) actCard.style.display = 'none';
      const calCard = $('homeScheduleCalendarCard');
      if(calCard) calCard.style.display = 'none';
      return;
    }
    card.style.display = '';
    renderDashboardGreeting();

    const [users, dtrToday, tickets, cashAdvances, leaves, reports] = await Promise.all([
      cloudListUsers().catch(()=>[]),
      dtrListAllForDate(todayISO()).catch(()=>[]),
      dtListAll().catch(()=>[]),
      caListAll().catch(()=>[]),
      leaveListAll().catch(()=>[]),
      (async ()=>{
        // Mirrors loadHistory()'s cloud-first / local-fallback read, without
        // scoping to one technician's device-only drafts.
        if(await ensureCloud()){
          const cloudRows = await cloudListReports().catch(()=>null);
          if(cloudRows) return cloudRows;
        }
        const out = [];
        try{
          const res = await window.storage.list('report:', false);
          for(const key of (res.keys||[])){
            try{ const item = await window.storage.get(key, false); out.push(JSON.parse(item.value)); }catch(e){}
          }
        }catch(e){}
        return out;
      })()
    ]);

    // "Needs you now" + "Technicians today" (admin-priority.js) reuse this
    // same data; not awaited so the counters below never wait on its extra
    // reads.
    prioRender({ users, dtrToday, tickets, cashAdvances, leaves, reports });

    // Active Technicians — how many of today's active roster have clocked in.
    const activeUsers = (users||[]).filter(u=> u.active!==false);
    const checkedInIds = new Set((dtrToday||[]).filter(d=> d && d.timeIn).map(d=> d.technicianId));
    const totalTech = activeUsers.length;
    const checkedInCount = activeUsers.filter(u=> checkedInIds.has(u.id)).length;
    const pct = totalTech>0 ? Math.round((checkedInCount/totalTech)*100) : 0;
    $('ovTechValue').textContent = checkedInCount+' / '+totalTech;
    $('ovTechBar').style.width = pct+'%';
    $('ovTechSub').textContent = pct+'% Check-in Rate (from Online DTR)';

    // Pending Requisitions — Cash Advance / Leave requests awaiting a decision.
    // A submitted liquidation lives on an already-approved advance (status
    // stays 'approved'), so it's invisible to the r.status==='pending' filter
    // below unless counted separately here — otherwise a technician's
    // liquidation submission never surfaces on the admin's dashboard at all.
    const pendingCA = (cashAdvances||[]).filter(r=> r.status==='pending').length;
    const pendingLiq = (cashAdvances||[]).filter(r=> r.liquidation && r.liquidation.status==='pending').length;
    const pendingLeave = (leaves||[]).filter(r=> r.status==='pending').length;
    $('ovReqValue').textContent = String(pendingCA+pendingLiq+pendingLeave);
    $('ovReqSub').textContent = pendingCA+' Cash Advance'+(pendingCA===1?'':'s')+' · '+pendingLiq+' Liquidation'+(pendingLiq===1?'':'s')+' · '+pendingLeave+' Leave Form'+(pendingLeave===1?'':'s');

    // Finance overview stat removed from the dashboard (layout revision) —
    // the underlying cash-advance/liquidation figures are still surfaced
    // via the "To Settle" stat below and the Finance section pages.

    // To Settle — approved liquidations with a return/reimburse balance that
    // hasn't actually been paid back yet either direction. This is distinct
    // from "Finance" above: that's money not yet liquidated at all, this is
    // money whose liquidation IS approved but the leftover balance is still
    // outstanding — a state that used to have no dashboard visibility
    // whatsoever, since the balance was only ever computed for display and
    // never persisted or tracked anywhere.
    const unsettled = (cashAdvances||[]).filter(r=> r.liquidation && r.liquidation.status==='approved' && r.liquidation.settlement && !r.liquidation.settlement.settled);
    const toCollect = unsettled.filter(r=> r.liquidation.settlement.type==='return').reduce((sum,r)=> sum + r.liquidation.settlement.amount, 0);
    const toReimburse = unsettled.filter(r=> r.liquidation.settlement.type==='reimburse').reduce((sum,r)=> sum + r.liquidation.settlement.amount, 0);
    $('ovSettleValue').textContent = String(unsettled.length);
    const settleParts = [];
    if(toCollect>0) settleParts.push('To collect: '+caFmtPeso(toCollect));
    if(toReimburse>0) settleParts.push('To reimburse: '+caFmtPeso(toReimburse));
    $('ovSettleSub').textContent = settleParts.length ? settleParts.join(' · ') : 'Nothing pending';

    // Dispatch Status — job orders still live, split by whether anyone is
    // on them yet. The old filter excluded ONLY 'completed', which the new
    // lifecycle inverts twice over: closed, cancelled and expired tickets
    // were all counted as open, while 'completed' — now an intermediate
    // stage waiting on admin's review, not the end — was excluded. Using
    // dtIsTerminal keeps this correct as stages change.
    const liveTickets = (tickets||[]).filter(t=> !dtIsTerminal(t) || dtEffectiveStatus(t)==='completed');
    const unassigned = liveTickets.filter(t=> !(t.assignedWorkerIds && t.assignedWorkerIds.length)).length;
    const assignedCount = liveTickets.length - unassigned;
    $('ovDispatchValue').textContent = String(liveTickets.length);
    // "In Progress" would now collide with the Work in Progress stage,
    // which means something specific and narrower.
    $('ovDispatchSub').textContent = assignedCount+' Assigned · '+unassigned+' Unassigned';

    // Unreviewed Reports — completed drafts still waiting to be finished
    // (which is where the customer's acknowledgment sign-off happens).
    const draftReports = (reports||[]).filter(r=> !r.completed).length;
    $('ovReportsValue').textContent = String(draftReports);
    $('ovReportsSub').textContent = draftReports+' Service Report'+(draftReports===1?'':'s')+' Pending Sign-off';

    // Service Requests — customer-filed, admin-only (service-requests.js).
    // srAdminInit() renders the value itself (and keeps it live afterward
    // via realtime), but it's awaited here so the notification bell total
    // just below already reflects it on this first render.
    const openServiceRequests = (typeof srAdminInit === 'function') ? (await srAdminInit()) || 0 : 0;

    // Job orders awaiting review — every unit resolved, now sitting on
    // ADMIN to read the reports and close it. This is the only automated
    // reminder in the lifecycle: technicians are not nagged, because they
    // cannot close a job order themselves, and admin coordinates with them
    // through the job order's own thread instead.
    const awaitingReview = (tickets||[]).filter(t=> t.status==='completed').length;
    if($('ovReviewCard')){
      $('ovReviewCard').style.display = awaitingReview > 0 ? '' : 'none';
      $('ovReviewValue').textContent = String(awaitingReview);
      $('ovReviewSub').textContent = awaitingReview+' Job Order'+(awaitingReview===1?'':'s')+' Awaiting Your Review';
      // Straight into the Review filter rather than the default list — a
      // count you then have to go hunting for is a worse reminder than no
      // count at all. Assigned rather than added so repeated dashboard
      // renders don't stack handlers.
      $('ovReviewCard').style.cursor = 'pointer';
      $('ovReviewCard').onclick = async ()=>{
        // Awaited: showDispatchView is async and renders the admin list
        // itself. Setting the filter without waiting let that first render
        // land AFTER this one, leaving the Review button highlighted above
        // an unfiltered list.
        if(typeof showDispatchView === 'function') await showDispatchView('all');
        if(typeof dtSetAdminFilter === 'function') dtSetAdminFilter('completed');
      };
    }

    // Notification bell in the dashboard top bar — total items anywhere in
    // the app that are waiting on an admin decision or sign-off.
    const notifTotal = pendingCA + pendingLiq + pendingLeave + draftReports + openServiceRequests + awaitingReview;
    const notifEl = $('notifBadge');
    if(notifEl){
      notifEl.textContent = notifTotal > 99 ? '99+' : String(notifTotal);
      notifEl.style.display = notifTotal > 0 ? '' : 'none';
    }

    // A counter at zero steps back so the ones that need attention stand out.
    $$('#homeOverviewCard .overview-stat').forEach(el=>{
      const v = el.querySelector('.overview-stat-value');
      el.classList.toggle('ov-zero', !!v && v.textContent.trim() === '0');
    });

    // Live map of every technician currently sharing a location — see tracker.js.
    trackerAdminInit();
    const actCard = $('homeActivityCard');
    if(actCard){ actCard.style.display = ''; renderRecentActivity(cashAdvances, leaves, tickets); }

    // Schedule Calendar widget — reuses the tickets already fetched above,
    // via the shared engine in dispatch.js (dtCalRender), so no extra query.
    const calCard = $('homeScheduleCalendarCard');
    if(calCard){ calCard.style.display = ''; dtHomeCalTicketsCache = tickets || []; dtCalRender('homeCal', dtHomeCalTicketsCache); }
  }
  let dtHomeCalTicketsCache = [];
  $('homeCalPrevBtn').addEventListener('click', ()=>{ dtCalPrev('homeCal'); dtCalRender('homeCal', dtHomeCalTicketsCache); });
  $('homeCalNextBtn').addEventListener('click', ()=>{ dtCalNext('homeCal'); dtCalRender('homeCal', dtHomeCalTicketsCache); });
  $('homeCalTodayBtn').addEventListener('click', ()=>{ dtCalGoToday('homeCal'); dtCalRender('homeCal', dtHomeCalTicketsCache); });
  $('homeCalDayList').addEventListener('click', dtHandleEquipRowClick);
  $('homeCalViewAllBtn').addEventListener('click', ()=>{
    closeMainMenu();
    setSidebarActive('sbNavDispatch');
    showDispatchView('calendar');
  });

  // ---------- Dashboard top bar greeting (admin only) ----------
  function renderDashboardGreeting(){
    const el = $('dtGreetingTitle');
    if(!el) return;
    const hour = new Date().getHours();
    const part = hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
    const name = (currentUser && currentUser.name) ? currentUser.name : 'Admin';
    el.innerHTML = 'Good '+escapeHtml(part)+', '+escapeHtml(name)+'! '+icon('wave');
  }

  // ---------- Recent Activity (admin dashboard, next to the live tracker) ----------
  // A lightweight, best-effort feed built from data other screens already
  // own (Cash Advance, Leave, Dispatch) — nothing new is stored just for
  // this panel. Service reports aren't included since they don't carry a
  // submission timestamp to sort by.
  function timeAgo(iso){
    if(!iso) return '';
    const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime())/60000));
    if(mins < 1) return 'Just now';
    if(mins < 60) return mins+'m ago';
    const hrs = Math.round(mins/60);
    if(hrs < 24) return hrs+'h ago';
    return Math.round(hrs/24)+'d ago';
  }
  function renderRecentActivity(cashAdvances, leaves, tickets){
    const list = $('recentActivityList');
    if(!list) return;
    const statusDot = (status)=> status==='pending' ? 'amber' : (status==='approved' ? 'green' : 'gray');
    const items = [];
    (cashAdvances||[]).forEach(r=> items.push({
      name: r.userName || 'Technician', desc: 'Filed a cash advance request',
      time: r.submittedAt, dot: statusDot(r.status)
    }));
    (leaves||[]).forEach(r=> items.push({
      name: r.userName || 'Technician', desc: 'Filed a leave request',
      time: r.submittedAt, dot: statusDot(r.status)
    }));
    (tickets||[]).forEach(t=> items.push({
      name: (t.assignedWorkerNames && t.assignedWorkerNames[0]) || t.custName || 'Dispatch',
      desc: 'Dispatch ticket '+(t.jobOrderNo||'')+' — '+(t.status||'updated'),
      time: t.createdAt, dot: 'blue'
    }));
    items.sort((a,b)=> (b.time||'').localeCompare(a.time||''));
    const top = items.slice(0,6);
    if(top.length===0){ list.innerHTML = '<div class="empty-state">No recent activity yet.</div>'; return; }
    list.innerHTML = top.map(it=>
      '<div class="activity-row"><span class="activity-dot activity-'+it.dot+'"></span>'+
      '<div class="activity-body"><div class="activity-name">'+escapeHtml(it.name)+'</div>'+
      '<div class="activity-desc">'+escapeHtml(it.desc)+'</div></div>'+
      '<div class="activity-time">'+timeAgo(it.time)+'</div></div>'
    ).join('');
  }

  // ---------- Sidebar nav (admin dashboard shell) ----------
  function setSidebarActive(id){
    $$('.sidebar-link').forEach(el=> el.classList.toggle('active', el.id===id));
  }
  $('sbNavDashboard').addEventListener('click', ()=>{ closeMainMenu(); showHome(); });
  $('sbNavTechnicians').addEventListener('click', ()=>{ closeMainMenu(); setSidebarActive('sbNavTechnicians'); showDtrView(); });
  // The Finance section used to be a single "Requisitions" sidebar item; it's
  // now three (Cash Advance / Liquidation / Reimbursement) so each opens the
  // same Cash Advance view already highlighted on the relevant tab.
  $('sbNavCashAdvance').addEventListener('click', ()=>{ closeMainMenu(); setSidebarActive('sbNavCashAdvance'); showCashAdvanceView(); });
  $('sbNavLiquidation').addEventListener('click', async ()=>{
    closeMainMenu(); setSidebarActive('sbNavLiquidation');
    await showCashAdvanceView();
    caShowTab('liquidate');
  });
  $('sbNavReimbursement').addEventListener('click', async ()=>{
    closeMainMenu(); setSidebarActive('sbNavReimbursement');
    await showCashAdvanceView();
    caShowAdminSection('reimb');
  });
  $('sbNavDispatch').addEventListener('click', ()=>{ closeMainMenu(); setSidebarActive('sbNavDispatch'); showDispatchView(); });
  $('menuManageReports').addEventListener('click', ()=>{
    closeMainMenu();
    setSidebarActive('menuManageReports');
    showServiceReportsManagerView();
  });
  $('menuManageCustomers').addEventListener('click', async ()=>{
    closeMainMenu();
    setSidebarActive('menuManageCustomers');
    if(!(await ensureAdminAuthenticated())) return;
    showCustomersManagerView();
  });
  // ---------- Purchasing (admin) ----------
  // One #purchasingView holds a panel per sidebar item; showPurchasingView
  // hides every other main view (same list the other show*View functions
  // use) and reveals just the requested panel.
  const PURCH_PAGES = {
    materials:      { nav:'sbNavMaterials',      title:'Materials Database',   sub:'Catalog of materials & parts' },
    suppliers:      { nav:'sbNavSuppliers',      title:'Supplier Database',    sub:'Suppliers, contacts & price lists' },
    requisitions:   { nav:'sbNavRequisitions',   title:'Material Requisition', sub:'Review & fulfil technician requests' },
    myRequests:     { nav:'',                    title:'Material Requests',    sub:'Request materials for your jobs' },
    stock:          { nav:'sbNavStock',          title:'Stock on Hand',        sub:'Quantities & value per warehouse' },
    warehouses:     { nav:'sbNavWarehouses',     title:'Warehouses',           sub:'Stock locations & storekeepers' },
    projects:       { nav:'sbNavProjects',       title:'Projects',             sub:'Job orders & material cost' },
    myStock:        { nav:'',                    title:'Warehouse Stock',      sub:'Your warehouses' },
    receive:        { nav:'sbNavReceive',        title:'Receive Stock',        sub:'Deliveries — against a PO or not' },
    issue:          { nav:'sbNavIssue',          title:'Issue to Worker',      sub:'Materials out, for a project / job' },
    returns:        { nav:'sbNavReturns',        title:'Returns',              sub:'Unused materials back to stock' },
    transfers:      { nav:'sbNavTransfers',      title:'Transfers',            sub:'Between warehouses' },
    slips:          { nav:'sbNavSlips',          title:'Slips & History',      sub:'Every stock movement document' },
    myMaterials:    { nav:'',                    title:'My Materials',         sub:'Sign for issued materials' },
    invReports:     { nav:'sbNavInvReports',     title:'Inventory Reports',    sub:'Balances, movements, cost & stock health' },
    tlHub:          { nav:'',                    title:'Tools & Equipment',    sub:'Issue, return, register, calibration' },
    tlRegister:     { nav:'sbNavTlRegister',     title:'Tool Register',        sub:'Every tool & kit, with its history' },
    tlIssue:        { nav:'sbNavTlIssue',        title:'Issue Tools',          sub:'Signed by warehouseman & worker' },
    tlReturn:       { nav:'sbNavTlReturn',       title:'Return Tools',         sub:'Condition checked, both sign' },
    tlHandover:     { nav:'sbNavTlHandover',     title:'Tool Handover',        sub:'Worker to worker, on site' },
    tlDefects:      { nav:'sbNavTlDefects',      title:'Defect Reports',       sub:'Defective, damaged & lost tools' },
    tlMaint:        { nav:'sbNavTlMaint',        title:'Calibration & Inspection', sub:'Due dates — overdue tools can\u2019t be issued' },
    tlSlips:        { nav:'sbNavTlSlips',        title:'Tool Slips',           sub:'Issue, return & handover slips' },
    tlReports:      { nav:'sbNavTlReports',      title:'Tool Reports',         sub:'Movements, custody, defects, register' },
    myTools:        { nav:'',                    title:'My Tools',             sub:'Sign for tools, see what you hold' },
    purchaseOrders: { nav:'sbNavPurchaseOrders', title:'Purchase Orders',      sub:'Create, issue & download POs' }
  };
  function showPurchasingView(key){
    const page = PURCH_PAGES[key] || PURCH_PAGES.materials;
    document.body.classList.remove('dashboard-active');
    ['homeScreen','serviceReportView','leaveView','cashAdvanceView','dispatchView','dtrView',
     'equipmentManagerView','customersManagerView','serviceReportsManagerView','messagesView',
     'documentsView','financeHrView','customerHistoryView','serviceRequestsView']
      .forEach(id=>{ const el=$(id); if(el) el.style.display='none'; });
    $$('#purchasingView .purch-panel').forEach(el=>{ el.style.display = (el.id === 'purchPanel_'+key) ? '' : 'none'; });
    $('purchasingView').style.display = '';
    $('footerBar').style.display = 'none';
    $('metaBar').style.display = 'none';
    $('homeBtn').style.display = '';
    setHeaderTitle(page.title, page.sub);
    setSidebarActive(page.nav);
    window.scrollTo({top:0});
    purchOnShow(key);   // purchasing.js — loads the page's data
  }
  Object.keys(PURCH_PAGES).forEach(key=>{
    // Technician pages (myRequests) have no sidebar button — skip them.
    // Binding to a missing button would throw here and abort the rest of
    // the app's start-up.
    if(!PURCH_PAGES[key].nav || !$(PURCH_PAGES[key].nav)) return;
    $(PURCH_PAGES[key].nav).addEventListener('click', async ()=>{
      closeMainMenu();
      if(!(await ensureAdminAuthenticated())) return;
      showPurchasingView(key);
    });
  });
  $('menuManageUsers').addEventListener('click', ()=> setSidebarActive('menuManageUsers'));
  $('menuManageDropdowns').addEventListener('click', ()=> setSidebarActive('menuManageDropdowns'));

  // ---------- Technician sidebar nav ----------
  // Same closeMainMenu()/setSidebarActive() convention as the admin nav
  // above — this just points each item at the technician's own version of
  // that screen instead of the admin's management view.
  $('techNavDispatch').addEventListener('click', ()=>{ closeMainMenu(); setSidebarActive('techNavDispatch'); showDispatchView(); });
  $('techNavServiceReport').addEventListener('click', ()=>{ closeMainMenu(); setSidebarActive('techNavServiceReport'); showServiceReport(); });
  $('techNavCashAdvance').addEventListener('click', ()=>{ closeMainMenu(); setSidebarActive('techNavCashAdvance'); showCashAdvanceView(); });
  $('techNavLiquidation').addEventListener('click', async ()=>{
    closeMainMenu(); setSidebarActive('techNavLiquidation');
    await showCashAdvanceView();
    if(currentUser && currentUser.role!=='admin') caShowTab('liquidate');
  });
  $('techNavReimbursement').addEventListener('click', async ()=>{
    closeMainMenu(); setSidebarActive('techNavReimbursement');
    await showCashAdvanceView();
    if(currentUser && currentUser.role!=='admin') caShowTab('reimburse');
  });
  $('techNavDtr').addEventListener('click', ()=>{ closeMainMenu(); setSidebarActive('techNavDtr'); showDtrView(); });
  $('techNavLeave').addEventListener('click', ()=>{ closeMainMenu(); setSidebarActive('techNavLeave'); showLeaveView(); });
  $('techNavMessages').addEventListener('click', ()=>{ closeMainMenu(); setSidebarActive('techNavMessages'); showMessagesView(); });
  $('techNavDocuments').addEventListener('click', ()=>{ closeMainMenu(); setSidebarActive('techNavDocuments'); showDocumentsView(); });
  $('techNavSettings').addEventListener('click', ()=>{ closeMainMenu(); showChangePasswordScreen(false); });

  // ---------- Messages hub (every Job Order thread, one screen) ----------
  async function showMessagesView(){
    document.body.classList.remove('dashboard-active');
    $('homeScreen').style.display = 'none';
    $('serviceReportView').style.display = 'none';
    $('dtrView').style.display = 'none';
    $('leaveView').style.display = 'none';
    $('cashAdvanceView').style.display = 'none';
    $('dispatchView').style.display = 'none';
    $('equipmentManagerView').style.display = 'none';
    $('customersManagerView').style.display = 'none';
    $('serviceReportsManagerView').style.display = 'none';
    $('documentsView').style.display = 'none';
    if($('financeHrView')) $('financeHrView').style.display = 'none';
    $('customerHistoryView').style.display = 'none';
    $('serviceRequestsView').style.display = 'none';
    if($('purchasingView')) $('purchasingView').style.display = 'none';
    $('messagesView').style.display = '';
    $('footerBar').style.display = 'none';
    $('metaBar').style.display = 'none';
    $('homeBtn').style.display = '';
    setHeaderTitle('Job Order Messages', 'Every thread in one place');
    window.scrollTo({top:0});
    await dtRenderMessagesHub();
  }
  async function dtRenderMessagesHub(){
    const list = $('messagesHubList');
    if(!list) return;
    list.innerHTML = '<div class="empty-state">Loading…</div>';
    if(!currentUser){ list.innerHTML = ''; return; }
    if(!(await ensureCloud())){ list.innerHTML = '<div class="empty-state">Connect to the internet to see Job Order messages.</div>'; return; }
    const tickets = currentUser.role==='admin' ? await dtListAll().catch(()=>[]) : await dtListForWorker(currentUser.id).catch(()=>[]);
    let allMsgs = [];
    try{
      const { data, error } = await db.from('dispatch_ticket_messages').select('*').order('created_at', {ascending:false});
      if(error) throw error;
      allMsgs = data || [];
    }catch(e){ console.error('messages hub load failed', describeCloudError(e)); }
    const byTicket = {};
    allMsgs.forEach(m=>{ (byTicket[m.ticket_id] = byTicket[m.ticket_id] || []).push(m); });
    const withMsgs = tickets.filter(t=> byTicket[t.id] && byTicket[t.id].length>0)
      .sort((a,b)=> new Date(byTicket[b.id][0].created_at) - new Date(byTicket[a.id][0].created_at));
    if(withMsgs.length===0){ list.innerHTML = '<div class="empty-state">No Job Order messages yet.</div>'; return; }
    list.innerHTML = withMsgs.map(t=>{
      const msgs = byTicket[t.id];
      const last = msgs[0];
      const lastRead = dtGetLastRead(t.id);
      const unread = msgs.filter(m=> m.sender_id!==currentUser.id && (!lastRead || new Date(m.created_at)>new Date(lastRead))).length;
      const preview = last.body.length>70 ? last.body.slice(0,70)+'…' : last.body;
      return '<div class="dt-msghub-row" data-jo-open="'+escapeHtml(t.id)+'">'+
        '<div class="dt-msghub-main">'+
          '<div class="u-name">'+escapeHtml(t.jobOrderNo)+' — '+escapeHtml(t.custName)+'</div>'+
          '<div class="u-status">'+escapeHtml(last.sender_name)+': '+escapeHtml(preview)+'</div>'+
        '</div>'+
        (unread>0 ? '<span class="sidebar-badge">'+unread+'</span>' : '')+
      '</div>';
    }).join('');
  }
  $('messagesHubList').addEventListener('click', (e)=>{
    const row = e.target.closest('[data-jo-open]');
    if(row) dtOpenTicketOverlay(row.dataset.joOpen);
  });

  // ---------- Documents (a technician's own completed Service Reports) ----------
  async function showDocumentsView(){
    document.body.classList.remove('dashboard-active');
    $('homeScreen').style.display = 'none';
    $('serviceReportView').style.display = 'none';
    $('dtrView').style.display = 'none';
    $('leaveView').style.display = 'none';
    $('cashAdvanceView').style.display = 'none';
    $('dispatchView').style.display = 'none';
    $('equipmentManagerView').style.display = 'none';
    $('customersManagerView').style.display = 'none';
    $('serviceReportsManagerView').style.display = 'none';
    $('messagesView').style.display = 'none';
    $('documentsView').style.display = '';
    if($('financeHrView')) $('financeHrView').style.display = 'none';
    $('footerBar').style.display = 'none';
    $('metaBar').style.display = 'none';
    $('homeBtn').style.display = '';
    setHeaderTitle('My Documents', 'Completed Service Reports');
    window.scrollTo({top:0});
    const onlyMe = currentUser && currentUser.role!=='admin' ? currentUser.id : null;
    await loadHistory('documentsList', 'completed', onlyMe);
  }

  // ---------- Home screen (feature tiles) ----------
  // Admin's homepage reads "Field Operations Portal" / "Management &
  // Administration" instead of the technician's "Technician's Homepage" /
  // "Field digital form" — shared by showHome() and the coming-soon flash
  // below so both stay in sync for whichever role is logged in.
  function homeHeaderTitle(){
    return (currentUser && currentUser.role==='admin')
      ? ['Field Operations Portal', 'Management & Administration']
      : ["Technician's Homepage", 'Field digital form'];
  }
  function showHome(){
    // Customer sessions get their own home screen/router entirely — bail
    // out here before anything below (which assumes admin/tech-only
    // elements) runs. See showCustomerHome() in customer-equipment-history.js.
    if(currentUser && currentUser.role==='customer'){ showCustomerHome(); return; }
    if(typeof invRefreshStorekeeperTile === 'function') invRefreshStorekeeperTile();   // storekeepers get a Warehouse Stock tile
    if(typeof invRefreshMineBadge === 'function') invRefreshMineBadge();               // "N to sign" on My Materials
    if(typeof tlRefreshMineBadge === 'function') tlRefreshMineBadge();                 // tools to sign / overdue on My Tools
    document.body.classList.add('dashboard-active');
    setSidebarActive('sbNavDashboard');
    $('homeScreen').style.display = '';
    $('serviceReportView').style.display = 'none';
    $('dtrView').style.display = 'none';
    $('leaveView').style.display = 'none';
    $('cashAdvanceView').style.display = 'none';
    $('dispatchView').style.display = 'none';
    $('equipmentManagerView').style.display = 'none';
    $('customersManagerView').style.display = 'none';
    $('serviceReportsManagerView').style.display = 'none';
    $('messagesView').style.display = 'none';
    $('documentsView').style.display = 'none';
    if($('financeHrView')) $('financeHrView').style.display = 'none';
    $('customerHistoryView').style.display = 'none';
    $('serviceRequestsView').style.display = 'none';
    if($('purchasingView')) $('purchasingView').style.display = 'none';
    $('customerHomeScreen').style.display = 'none';
    $('customerEquipmentDetailScreen').style.display = 'none';
    // Same belt-and-suspenders as doLogout() in auth.js — the newer
    // customer-portal screens (Units/History/Tools/Calc/Profile/Requests,
    // account picker) predate none of admin/tech's own hide-lists, so a
    // leftover customer session's screen could otherwise still be sitting
    // visible underneath whatever admin/tech screen loads next.
    ['customerRequestsScreen','customerUnitsScreen','customerHistoryScreen',
     'customerToolsScreen','customerCalcScreen','customerProfileScreen',
     'customerAccountPickerScreen'
    ].forEach(id=>{ const el = $(id); if(el) el.style.display = 'none'; });
    $('footerBar').style.display = 'none';
    $('metaBar').style.display = 'none';
    $('homeBtn').style.display = 'none';
    setHeaderTitle(...homeHeaderTitle());
    $('tile_dispatch_label').textContent = (currentUser && currentUser.role==='admin') ? 'Service Dispatch Ticket' : 'My Job Order';
    renderHomeGreeting();
    renderHomeTechOverview();
    renderHomeOverview();
    renderHomeAnnouncements();
    renderTechQuickActions();
    techSetNavActive('home');
    window.scrollTo({top:0});
  }
  // ---------- Service Report: Create New / Saved Draft / Completed / All tabs ----------
  // `opts.skipReset` lets a caller switch to the New panel without wiping the
  // form — used by openReport() (Continue), which already populated the form
  // with a draft's data and just needs the panel switched, not cleared again.
  function srShowTab(which, opts){
    opts = opts || {};
    $('srTabNewBtn').classList.toggle('active', which==='new');
    $('srTabDraftBtn').classList.toggle('active', which==='draft');
    $('srTabCompletedBtn').classList.toggle('active', which==='completed');
    $('srTabAllBtn').classList.toggle('active', which==='all');
    $('srTabBackEntryBtn').classList.toggle('active', which==='backentry');
    const isHistoryTab = which!=='new' && which!=='backentry';
    $('srNewPanel').style.display = which==='new' ? '' : 'none';
    $('srBackEntryPanel').style.display = which==='backentry' ? '' : 'none';
    if(which==='backentry') beOpen();
    $('srHistoryPanel').style.display = isHistoryTab ? '' : 'none';
    // The footer (Save Draft / Generate Report) and the SR-No./status meta
    // bar only make sense while actively filling out a report.
    // Leaving the Create New tab always hides the footer; entering it hands
    // the decision to srUpdateFooterBar, which only shows it once the last
    // section has been reached (see its comment in ui.js).
    if(which!=='new') $('footerBar').style.display = 'none';
    else if(typeof srUpdateFooterBar === 'function') srUpdateFooterBar();
    else $('footerBar').style.display = 'flex';
    $('metaBar').style.display = which==='new' ? '' : 'none';
    if(which==='new'){
      // "Create New" is a hard reset, not just a tab switch — same convention
      // as the Dispatch admin's "New" tab (dtShowAdminTab). Any in-progress
      // report (blank or partly filled, saved or not) is discarded every time
      // this tab is opened this way, and the flow always starts over from the
      // Job Order picker rather than resuming whatever was on screen before.
      if(!opts.skipReset){
        resetForm();
        // Without this, a technician who had scrolled down a long form (or a
        // long Saved Draft / Completed list) still sees whatever part of the
        // page they were on after the reset — the panel underneath did switch
        // and clear, but it looks like nothing happened until they scroll up.
        window.scrollTo({top:0, behavior:'smooth'});
      }
      // The wizard's entry flow owns this now: instruction gate (once per
      // session) -> Create New / Saved Draft -> job order -> Single /
      // Multiple -> unit. srTileCreateNew is what calls the picker.
      if(typeof srStartReportFlow === 'function') srStartReportFlow();
      else srRenderJobOrderPicker();
    }
    if(isHistoryTab){
      $('srHistoryPanelTitle').textContent =
        which==='draft' ? 'Saved Draft Reports' : which==='completed' ? 'Completed Reports' : 'All Reports';
      loadHistory('srHistoryList', which);
    }
  }
  $('srTabNewBtn').addEventListener('click', ()=> srShowTab('new'));
  $('srTabDraftBtn').addEventListener('click', ()=> srShowTab('draft'));
  $('srTabCompletedBtn').addEventListener('click', ()=> srShowTab('completed'));
  $('srTabAllBtn').addEventListener('click', ()=> srShowTab('all'));
  $('srTabBackEntryBtn').addEventListener('click', ()=> srShowTab('backentry'));

  function showServiceReport(){
    document.body.classList.remove('dashboard-active');
    $('homeScreen').style.display = 'none';
    $('dtrView').style.display = 'none';
    $('leaveView').style.display = 'none';
    $('cashAdvanceView').style.display = 'none';
    $('dispatchView').style.display = 'none';
    $('equipmentManagerView').style.display = 'none';
    $('customersManagerView').style.display = 'none';
    $('serviceReportsManagerView').style.display = 'none';
    $('messagesView').style.display = 'none';
    $('documentsView').style.display = 'none';
    if($('financeHrView')) $('financeHrView').style.display = 'none';
    $('customerHistoryView').style.display = 'none';
    $('serviceRequestsView').style.display = 'none';
    if($('purchasingView')) $('purchasingView').style.display = 'none';
    $('serviceReportView').style.display = '';
    $('homeBtn').style.display = '';
    setHeaderTitle('Service Report', 'Field digital form');
    if(currentUser && currentUser.role==='admin'){
      // Admin can't author a blank report — the "Create New" tab is hidden
      // for this role — so land on "All" instead of the now-inaccessible
      // Create New panel. Admin still reaches the same form panel to edit
      // an existing report by opening it from a history list.
      srShowTab('all');
    }else{
      // Just entering the section, not the explicit "Create New" tab action —
      // don't discard whatever the technician was already filling out.
      srShowTab('new', {skipReset:true});
    }
    window.scrollTo({top:0});
  }
  // ---------- Remember which screen was open across a refresh ----------
  // A plain page reload re-runs the whole app from scratch, so without this
  // every refresh — even just hitting the browser's reload button — landed
  // back on Home regardless of what the person was actually doing. This
  // snapshots whichever top-level view is visible right before the page
  // unloads, and enterApp() (below) tries to reopen that same view instead
  // of unconditionally calling showHome().
  const LAST_SCREEN_KEY = 'awes-last-screen';
  // Screens that need a specific record to reopen correctly (a particular
  // customer, a particular equipment unit) aren't restorable from just a
  // screen name alone — restoring to their nearest safe parent instead of
  // guessing at that record.
  const RESTORABLE_SCREENS = {
    homeScreen: {fn: ()=> showHome(), roles: ['admin','tech']},
    serviceReportView: {fn: ()=> showServiceReport(), roles: ['admin','tech']},
    dtrView: {fn: ()=> showDtrView(), roles: ['admin','tech']},
    leaveView: {fn: ()=> showLeaveView(), roles: ['admin','tech']},
    cashAdvanceView: {fn: ()=> showCashAdvanceView(), roles: ['admin','tech']},
    dispatchView: {fn: ()=> showDispatchView(), roles: ['admin','tech']},
    equipmentManagerView: {fn: ()=> showEquipmentManagerView(), roles: ['admin']},
    customersManagerView: {fn: ()=> showCustomersManagerView(), roles: ['admin']},
    serviceReportsManagerView: {fn: ()=> showServiceReportsManagerView(), roles: ['admin']},
    messagesView: {fn: ()=> showMessagesView(), roles: ['admin','tech']},
    documentsView: {fn: ()=> showDocumentsView(), roles: ['admin','tech']},
    financeHrView: {fn: ()=> showFinanceHrView(), roles: ['tech']},
    customerHomeScreen: {fn: ()=> showCustomerHome(), roles: ['customer']},
    // Needs a customer record to render — fall back to the list it's reached from.
    customerHistoryView: {fn: ()=> showCustomersManagerView(), roles: ['admin']},
    // Needs a specific equipment record — fall back to the customer's own home.
    customerEquipmentDetailScreen: {fn: ()=> showCustomerHome(), roles: ['customer']}
  };
  function snapshotCurrentScreen(){
    // Nobody's signed in (e.g. this fires right after Logout, from a
    // leftover view that's still technically visible behind the login
    // overlay) — there's no session to resume, so don't save anything.
    // Without this guard, a pagehide/visibilitychange firing after
    // doLogout() clears awes-last-screen could immediately re-write it
    // with the stale screen, and the next sign-in would land back there
    // instead of Home.
    if(!currentUser) return;
    try{
      for(const id of Object.keys(RESTORABLE_SCREENS)){
        const el = $(id);
        if(el && el.style.display !== 'none'){ localStorage.setItem(LAST_SCREEN_KEY, id); return; }
      }
    }catch(e){}
  }
  window.addEventListener('pagehide', snapshotCurrentScreen);
  window.addEventListener('beforeunload', snapshotCurrentScreen);
  document.addEventListener('visibilitychange', ()=>{ if(document.visibilityState==='hidden') snapshotCurrentScreen(); });
  function restoreLastScreenOrHome(){
    let key = null;
    try{ key = localStorage.getItem(LAST_SCREEN_KEY); }catch(e){}
    const entry = key && RESTORABLE_SCREENS[key];
    const role = currentUser && currentUser.role;
    if(entry && role && entry.roles.indexOf(role)!==-1){ entry.fn(); return; }
    showHome();
  }

  async function enterApp(opts){
    // Awaited before anything else: the very next line reads todayISO() for
    // the DTR lookup, and from here on the job order lifecycle gates
    // acknowledgement, Preparing and expiry on the same answer. Syncing
    // after the first read would mean the app briefly runs on unverified
    // device time. Failure is non-fatal — syncServerTime leaves the offset
    // at zero and the app carries on using device time, which is what it
    // did before this existed.
    await syncServerTime();
    // Location sharing follows today's DTR, not just sign-in — see
    // dtrIsOnClock() and the tracker calls inside dtrDoTimeIn/Out and
    // dtrDoOtTimeIn/Out in history.js. This lookup only matters for
    // resuming correctly after the app was closed and reopened mid-shift;
    // the normal start/stop path is the DTR buttons themselves.
    if(currentUser && currentUser.role==='tech'){
      const todayDtr = await dtrGetDay(currentUser.id, todayISO()).catch(()=>null);
      if(dtrIsOnClock(todayDtr)) trackerStartBroadcasting();
      else trackerStopBroadcasting();
    }else{
      trackerStopBroadcasting();
    }
    // {freshLogin:true} — passed only by the three login forms themselves
    // (renderTechnicianLoginForm / renderAdminLoginForm / the customer
    // form, in auth.js) right after credentials were just typed and
    // verified. An actual sign-in should always land on Home, never on
    // wherever a PREVIOUS session happened to leave off — only a same-
    // session page refresh should restore that. checkLoginGate()'s own
    // enterApp() calls (session-restore on load, no credentials typed)
    // deliberately pass nothing here, so that path keeps restoring the
    // last screen exactly as before.
    if(opts && opts.freshLogin){
      // Also clear it here, not just in doLogout() — a tab that was simply
      // closed (never hit Logout) leaves the old session's last-screen
      // sitting in localStorage, and without this it would otherwise leak
      // into whatever screen the NEXT person's fresh sign-in restores on.
      try{ localStorage.removeItem(LAST_SCREEN_KEY); }catch(e){}
      // A customer login always gets the greeting + account-picker screen
      // first (see showCustomerAccountPicker() in customer-portal.js)
      // instead of landing straight on Home — including a login linked to
      // just one customer record, so every customer sees the same
      // "Viewing this account" confirmation on sign-in rather than only
      // the ones with 2+ linked accounts. Admin and technician logins go
      // straight to Home exactly as before.
      if(currentUser && currentUser.role==='customer' && (currentUser.customerList||[]).length && typeof showCustomerAccountPicker==='function'){
        showCustomerAccountPicker();
      } else {
        showHome();
      }
    }else{
      restoreLastScreenOrHome();
    }
  }
  $('tile_serviceReport').addEventListener('click', showServiceReport);
  $('tile_dtr').addEventListener('click', showDtrView);
  // Coming-soon tiles don't navigate to a real page yet, so the header title
  // change is shown briefly alongside the toast, then reverts to the home
  // title once the toast fades (avoids leaving a mismatched header behind
  // on a screen that's still showing the home tile grid).
  function flashComingSoonHeader(title, message){
    setHeaderTitle(title, 'Field digital form');
    toast(message);
    setTimeout(()=>{ if($('homeScreen').style.display !== 'none') setHeaderTitle(...homeHeaderTitle()); }, 2200);
  }
  $('tile_cashAdvance').addEventListener('click', showCashAdvanceView);
  $('tile_dispatch').addEventListener('click', showDispatchView);
  $('tile_leave').addEventListener('click', showLeaveView);
  // Admins land on the review queue; technicians on their own requests.
  $('tile_materialRequest').addEventListener('click', async ()=>{
    if(currentUser && currentUser.role === 'admin'){
      if(!(await ensureAdminAuthenticated())) return;
      showPurchasingView('requisitions');
    }else showPurchasingView('myRequests');
  });
  $('tile_changePassword').addEventListener('click', ()=> showChangePasswordScreen(false));
  $('homeBtn').addEventListener('click', showHome);

  // Today's Job Order card(s) in the home greeting — delegated on the
  // persistent container since renderHomeGreeting() rebuilds its contents
  // (via innerHTML) on every call, which would otherwise strip any listener
  // attached directly to a card. Opens My Job Order and jumps straight to
  // that ticket, reusing the same highlight-and-expand behavior already
  // used when a technician is sent here from the Service Report picker
  // (see srGoAcknowledgeTicket).
  $('homeGreetingText').addEventListener('click', function(e){
    // Attendance strip → the DTR screen, where Time In/Out is actually
    // recorded (the values shown in the strip are display-only).
    if(e.target.closest('.th-attend')) showDtrView();
  });

  // ---------- Technician Quick Actions (single card, 4 tiles — replaces
  // the shared .home-grid for this role only; see body.role-tech .home-grid
  // {display:none} in app.css). Shown/hidden alongside homeGreetingCard/
  // homeTechOverviewCard — called from showHome() below. ----------
  function renderTechQuickActions(){
    const card = $('techQuickActionsCard');
    if(!card) return;
    card.style.display = (currentUser && currentUser.role==='tech') ? '' : 'none';
  }
  $('techQaServiceReport').addEventListener('click', showServiceReport);
  $('techQaJobOrder').addEventListener('click', ()=> showDispatchView());
  $('techQaMaterials').addEventListener('click', ()=> showPurchasingView('myRequests'));
  $('techQaAttendance').addEventListener('click', ()=> showDtrView());
  $('techQaMessages').addEventListener('click', ()=> showMessagesView());
  $('techQaLeave').addEventListener('click', ()=> showLeaveView());
  $('techQaCashAdvance').addEventListener('click', async ()=>{
    await showCashAdvanceView();
    if(currentUser && currentUser.role!=='admin') caShowTab('new');
  });
  $('techQaReimburse').addEventListener('click', async ()=>{
    await showCashAdvanceView();
    if(currentUser && currentUser.role!=='admin') caShowTab('reimburse');
  });

  // ---------- Finance & HR page — tile view of Attendance / Cash Advance /
  // Leave / Liquidation / Reimbursement. Each tile opens the exact same
  // screen or tab the old sheet (and before that, the sidebar) opened. ----------
  function showFinanceHrView(){
    document.body.classList.remove('dashboard-active');
    ['homeScreen','serviceReportView','dtrView','leaveView','cashAdvanceView','dispatchView',
     'equipmentManagerView','customersManagerView','serviceReportsManagerView','messagesView',
     'documentsView','customerHistoryView','serviceRequestsView','purchasingView'].forEach(id=>{ const el=$(id); if(el) el.style.display='none'; });
    $('financeHrView').style.display = '';
    $('footerBar').style.display = 'none';
    $('metaBar').style.display = 'none';
    $('homeBtn').style.display = '';
    setHeaderTitle('Finance & HR', 'Attendance, cash advance & leave');
    if(typeof techSetNavActive === 'function') techSetNavActive('finance');
    window.scrollTo({top:0});
  }
  $('techFhAttendance').addEventListener('click', ()=> showDtrView());
  $('techFhCashAdvance').addEventListener('click', ()=> showCashAdvanceView());
  $('techFhLeave').addEventListener('click', ()=> showLeaveView());
  $('techFhLiquidation').addEventListener('click', async ()=>{
    await showCashAdvanceView();
    if(currentUser && currentUser.role!=='admin') caShowTab('liquidate');
  });
  $('techFhReimbursement').addEventListener('click', async ()=>{
    await showCashAdvanceView();
    if(currentUser && currentUser.role!=='admin') caShowTab('reimburse');
  });

  // ---------- More sheet — the bottom nav's overflow tab for whatever
  // doesn't get its own slot. ----------
  function techOpenMoreSheet(){ $('techMoreSheet').classList.add('open'); }
  function techCloseMoreSheet(){ $('techMoreSheet').classList.remove('open'); }
  $('closeTechMoreSheet').addEventListener('click', techCloseMoreSheet);
  $('techMoreSheet').addEventListener('click', (e)=>{ if(e.target.id==='techMoreSheet') techCloseMoreSheet(); });
  $('techMoreMessages').addEventListener('click', ()=>{ techCloseMoreSheet(); showMessagesView(); });  $('techMoreDocuments').addEventListener('click', ()=>{ techCloseMoreSheet(); showDocumentsView(); });
  $('techMoreSettings').addEventListener('click', ()=>{ techCloseMoreSheet(); showChangePasswordScreen(false); });

  // ---------- Technician profile (More > Profile) ----------
  // Renders from currentUser plus a fresh profiles-row read and the auth
  // session's email — only fields that actually exist are shown (the
  // profiles table has no position/contact columns), so nothing renders
  // as a permanently-blank row. Today's figures reuse the same calls the
  // home screen already makes.
  function techCloseProfileSheet(){ $('techMyProfileSheet').classList.remove('open'); }
  async function techOpenProfileSheet(){
    $('techMyProfileSheet').classList.add('open');
    await techRenderProfile();
  }
  async function techRenderProfile(){
    if(!currentUser) return;
    const setTxt = (id, val)=>{ const el = $(id); if(el) el.textContent = val || '—'; };
    setTxt('techMyProfileAvatar', (currentUser.name||'?').trim().charAt(0).toUpperCase() || '?');
    setTxt('techMyProfileName', currentUser.name);
    setTxt('techMyProfileRole', currentUser.role==='tech' ? 'Technician' : currentUser.role);
    setTxt('techMyProfileFullName', currentUser.name);
    setTxt('techMyProfileUsername', currentUser.username);
    // Reset the async fields so a previous open's values never linger
    // while this render is still in flight.
    setTxt('techMyProfileStatus', '—');
    setTxt('techMyProfileTimeIn', '—');
    setTxt('techMyProfileTimeOut', '—');
    setTxt('techMyProfileOpenJo', '—');
    const fmtT = (iso)=> iso ? new Date(iso).toLocaleTimeString('en-PH', {hour:'2-digit', minute:'2-digit'}) : '—';
    const [prof, todayDtr, myTickets] = await Promise.all([
      (typeof cloudGetUser==='function' ? cloudGetUser(currentUser.id).catch(()=>null) : Promise.resolve(null)),
      dtrGetDay(currentUser.id, todayISO()).catch(()=>null),
      dtListForWorker(currentUser.id).catch(()=>[])
    ]);
    if(prof){
      setTxt('techMyProfileUsername', prof.username || currentUser.username);
      setTxt('techMyProfileStatus', prof.active===false ? 'Inactive' : 'Active');
    }
    if(typeof pushRefreshToggles === 'function') pushRefreshToggles();
    setTxt('techMyProfileTimeIn', fmtT(todayDtr && todayDtr.timeIn));
    setTxt('techMyProfileTimeOut', fmtT(todayDtr && todayDtr.timeOut));
    const openCount = (myTickets||[]).filter(t=> !['completed','closed','cancelled','expired'].includes(dtEffectiveStatus(t))).length;
    setTxt('techMyProfileOpenJo', String(openCount));
  }
  $('techMoreProfile').addEventListener('click', ()=>{ techCloseMoreSheet(); techOpenProfileSheet(); });
  $('closeTechMyProfileSheet').addEventListener('click', techCloseProfileSheet);
  $('techMyProfileSheet').addEventListener('click', (e)=>{ if(e.target.id==='techMyProfileSheet') techCloseProfileSheet(); });
  $('techMyProfileChangePwBtn').addEventListener('click', ()=>{ techCloseProfileSheet(); showChangePasswordScreen(false); });
  $('techMyProfileLogoutBtn').addEventListener('click', ()=>{ techCloseProfileSheet(); doLogout(); });

  // ---------- Technician bottom nav (#techNav) — replaces the sidebar for
  // this role only (admin keeps .admin-sidebar unchanged). Same .cp-nav/
  // .cp-nav-btn classes as the customer portal's own nav, so it's already
  // responsive (bottom bar on mobile, top bar on desktop) with no extra
  // CSS needed here. Shown/hidden centrally in applyUserRestrictions()
  // (auth.js) alongside the role-tech body class. ----------
  function techSetNavActive(name){
    const nav = $('techNav');
    if(!nav) return;
    $$('.cp-nav-btn', nav).forEach(btn=> btn.classList.remove('active'));
    const map = { home:'techNavBtnHome', jobs:'techNavBtnJobs', report:'techNavBtnReport', finance:'techNavBtnFinance', more:'techNavBtnMore' };
    const id = map[name];
    if(id && $(id)) $(id).classList.add('active');
  }
  // Keeps --tech-nav-h / --tech-footer-h equal to the bars' real rendered
  // heights (the nav's includes the phone's safe-area inset), so overlays
  // and page padding in app.css line up with the bar on every device.
  // A hidden bar measures 0, which is exactly what the CSS needs then.
  (function techTrackBarHeights(){
    const root = document.documentElement;
    const track = (el, varName)=>{
      if(!el) return;
      const apply = ()=> root.style.setProperty(varName, el.offsetHeight+'px');
      apply();
      if(typeof ResizeObserver === 'function') new ResizeObserver(apply).observe(el);
      // display:none -> '' doesn't always fire a resize on older WebViews.
      new MutationObserver(apply).observe(el, { attributes:true, attributeFilter:['style','class'] });
      window.addEventListener('resize', apply);
    };
    track($('techNav'), '--tech-nav-h');
    track($('footerBar'), '--tech-footer-h');
  })();
  // Overlays now leave the bar visible and tappable (see app.css), so a tap
  // on it while one is open must close it — otherwise the new page would
  // open underneath a sheet that's still showing. Capture phase, so this
  // runs before the button's own handler (which may open the More sheet).
  if($('techNav')){
    $('techNav').addEventListener('click', ()=>{
      // The Job Order overlay has its own cleanup (message channel etc.).
      const jo = $('dtTicketOverlay');
      if(jo && jo.classList.contains('open') && typeof dtCloseTicketOverlay === 'function') dtCloseTicketOverlay();
      document.querySelectorAll('.overlay.open:not(.login-overlay)').forEach(o=> o.classList.remove('open'));
    }, true);
  }
  $('techNavBtnHome').addEventListener('click', ()=>{ techSetNavActive('home'); showHome(); });
  $('techNavBtnJobs').addEventListener('click', ()=>{ techSetNavActive('jobs'); showDispatchView(); });
  $('techNavBtnReport').addEventListener('click', ()=>{ techSetNavActive('report'); showServiceReport(); });
  $('techNavBtnFinance').addEventListener('click', ()=> showFinanceHrView());
  $('techNavBtnMore').addEventListener('click', ()=>{ techSetNavActive('more'); techOpenMoreSheet(); });
