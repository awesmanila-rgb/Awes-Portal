  // =====================================================================
  // Operations dashboard on the staff home
  //
  // The Super Admin's dashboard (#adminDash, drawn by admin-priority.js,
  // dispatch.js and tracker.js) shown on the homepage of office staff who hold
  // Operations pages — every card limited to what that person may open:
  //
  //   Needs you now ........ Dispatch, Service Requests or Service Reports (View)
  //                          and only the items from those pages
  //   (the "Operations today" tile card was removed as redundant)  (was: one tile per page they held, job orders, late,
  //                          awaiting review, new requests, reports to sign off,
  //                          technicians timed in)
  //   Dispatch board, Job order progress,
  //   Technicians status,
  //   Schedule calendar .... Dispatch (View)
  //   Live tracker (+ list)  Live Tracker (View) — with both, Job order progress sits beside the map
  //                          and the Technicians status table runs full-width below
  //   Time-in / time-out ... only with Technician Attendance (View)
  //   Everything else on the admin dashboard (finance, leave, purchasing,
  //   activity log, charts) is hidden — those stay in Inbox / their own pages.
  //
  // The database enforces the same rules (has_perm in RLS), so a card whose
  // data a person may not read could never show it; the checks below just keep
  // the screen honest (no empty cards, no failing requests).
  //
  // Mechanics: #adminDash is MOVED (not copied) into the staff home so every id,
  // handler and style keeps working; a marker comment remembers where it lived.
  // opsUndockDash() puts it back — called before the staff home is redrawn,
  // when anyone else's home opens, and on sign out. The Super Admin dashboard
  // itself is not changed.
  // =====================================================================

  const OPS_HIDE = ['homeAnnouncementsCard', 'homeOverviewCard', 'homeJobOrdersCard', 'homeIntroCard', 'homeActivityCard', 'admJobsCard', 'admChartCard', 'admWeekCard', 'prioCard',
    'prioBoardCard', 'prioTechCard', 'prioProgressCard', 'homeScheduleCalendarCard', 'dashTwoCol', 'homeTrackerCard', 'homeTechListCard'];  // all hidden first, then the allowed ones shown
  const opsDock = { marker:null, orig:{}, busy:false, wired:false, rt:null, rtUid:null, rtTries:0, deb:null };

  function opsPerms(){
    return {
      d:   can('ops.dispatch', 'view'),
      sr:  can('ops.service_requests', 'view'),
      rep: can('ops.service_reports', 'view'),
      trk: can('ops.tracker', 'view'),
      dtr: can('hr.attendance', 'view')
    };
  }
  // Operations staff = office staff (not a messenger) holding at least one Operations page that has dashboard cards
  function opsCanDash(){
    if(!currentUser || currentUser.role !== 'staff') return false;
    if(typeof isMessengerUser === 'function' && isMessengerUser()) return false;
    const p = opsPerms();
    return !!(p.d || p.sr || p.rep || p.trk);
  }
  // Which Needs-you-now items each page may see. Everything else (leave, cash, purchasing…) is
  // another department's work and stays in the Inbox.
  function opsItemAllowed(key){
    const k = String(key || ''), p = opsPerms();
    if(/^(late|exp|overdue|long):/.test(k) || k === 'jorev' || k === 'nodisp') return p.d;
    if(k.indexOf('sr:') === 0) return p.sr;
    if(k === 'srsignoff' || k === 'srsign') return p.rep;
    return false;
  }

  // ---------- dock / undock ----------
  function opsDockDash(host){
    const dash = document.getElementById('adminDash');
    if(!dash) return false;
    if(dash.parentNode !== host){
      if(!opsDock.marker){ opsDock.marker = document.createComment('ops-dock:adminDash'); dash.parentNode.insertBefore(opsDock.marker, dash); }
      host.appendChild(dash);
    }
    return true;
  }
  function opsUndockDash(){
    const dash = document.getElementById('adminDash');
    const m = opsDock.marker;
    // restore what this screen hid / showed, so the Super Admin dashboard is exactly as it was
    Object.keys(opsDock.orig).forEach(id=>{ const el = document.getElementById(id); if(el) el.style.display = opsDock.orig[id]; });
    opsDock.orig = {};
    const stats = document.getElementById('opsStatsCard'); if(stats && stats.parentNode) stats.parentNode.removeChild(stats);
    if(dash){ dash.classList.remove('ops-map', 'ops-disp'); }
    if(dash && m && m.parentNode) m.parentNode.insertBefore(dash, m);
    if(m && m.parentNode) m.parentNode.removeChild(m);
    opsDock.marker = null;
    const host = document.getElementById('opsDash'); if(host && host.parentNode) host.parentNode.removeChild(host);
    document.body.classList.remove('has-ops-dash');
  }
  function opsSetVis(id, on){
    const el = document.getElementById(id); if(!el) return;
    if(!(id in opsDock.orig)) opsDock.orig[id] = el.style.display;
    el.style.display = on ? '' : 'none';
  }

  // The "Operations today" card of tiles was removed: the Needs you now list, the Job order progress and the
  // Technicians status already show the same figures. A copy left over from an earlier version is cleaned up here.
  function opsRemoveStatsCard(){ const stale = document.getElementById('opsStatsCard'); if(stale && stale.parentNode) stale.parentNode.removeChild(stale); }

  // ---------- render ----------
  async function opsRenderDashboard(target, quiet){
    if(!opsCanDash()){ opsUndockDash(); opsRealtimeTeardown(); return; }
    if(!target || !document.body.contains(target) || opsDock.busy) return;
    opsDock.busy = true;
    try{
      let host = document.getElementById('opsDash');
      if(!host){
        host = document.createElement('div'); host.id = 'opsDash'; host.className = 'ops-dash';
        const first = target.querySelector('.card');
        if(first && first.nextSibling) target.insertBefore(host, first.nextSibling); else target.appendChild(host);
        document.body.classList.add('has-ops-dash');
      }
      if(!opsDockDash(host)){ return; }
      const p = opsPerms();
      const dash = document.getElementById('adminDash');
      if(dash){ dash.classList.toggle('ops-map', !!p.trk); dash.classList.toggle('ops-disp', !!p.d); }   // layout: Job order progress beside the map
      // show only the cards this person may use; hide the rest of the admin dashboard
      OPS_HIDE.forEach(id=> opsSetVis(id, false));
      opsSetVis('prioCard', p.d || p.sr || p.rep);
      ['prioBoardCard', 'prioTechCard', 'prioProgressCard', 'homeScheduleCalendarCard'].forEach(id=> opsSetVis(id, p.d));
      opsSetVis('dashTwoCol', p.trk); opsSetVis('homeTrackerCard', p.trk);   // the separate technician list stays hidden: Technicians status replaces it

      const [tickets, users, dtrToday, reports, extra] = await Promise.all([
        p.d ? dtListAll().catch(()=> null) : Promise.resolve([]),
        (p.d || p.dtr) ? cloudListUsers().catch(()=> null) : Promise.resolve([]),
        p.dtr ? dtrListAllForDate(todayISO()).catch(()=> null) : Promise.resolve([]),
        p.rep ? (async ()=>{ try{ return (await cloudListReports({ lite:true })) || []; }catch(e){ return null; } })() : Promise.resolve([]),
        p.sr ? prioLoadExtras().catch(()=> ({})) : Promise.resolve({})
      ]);
      if(quiet && p.d && tickets === null) return;   // a failed background refresh keeps what is on screen
      const base = { users: users || [], dtrToday: dtrToday || [], tickets: tickets || [], cashAdvances: [], leaves: [], reports: reports || [] };
      const ex = Object.assign({ srNew: [], mrs: [], mrItems: {}, pos: [], pms: [], reorder: [], custNames: {}, inbox: [] }, extra || {});
      let items = [];
      try{ items = prioBuild(base, ex).filter(it=> opsItemAllowed(it.key)); }catch(e){ console.warn('ops dashboard: priority list failed', e); }
      prioLastItems = items; prioLastBase = base;
      opsRemoveStatsCard();
      if(p.d || p.sr || p.rep) prioRenderList();
      if(p.d){
        prioRenderTechs(prioTechStatus(base));
        prioRenderBoard(base);
        prioRenderProgress(base);
        dtHomeCalTicketsCache = base.tickets;
        dtCalRender('homeCal', dtHomeCalTicketsCache);
        const bo = document.getElementById('prioBoardOpen'); if(bo) bo.onclick = ()=> staffOpenModule('ops.dispatch');
      }
      if(p.trk){
        try{ await trackerAdminInit(); }catch(e){ console.warn('ops dashboard: tracker', e); }
        try{ if(typeof trackerMap !== 'undefined' && trackerMap && trackerMap.invalidateSize) setTimeout(()=> trackerMap.invalidateSize(), 250); }catch(e){}
      }
      opsLiveStart(p);
    }catch(e){
      console.warn('ops dashboard failed', e);
    }finally{ opsDock.busy = false; }
  }


  // ---------- live: real-time (when published) + 60 s + on return ----------
  function opsHomeVisible(){
    const h = document.getElementById('staffPanel_home');
    return !!(h && h.offsetParent !== null && document.getElementById('opsDash') && opsCanDash());
  }
  async function opsRefreshNow(){
    if(document.hidden || navigator.onLine === false || !opsHomeVisible()) return;
    if(document.querySelector('.overlay.open')) return;
    await opsRenderDashboard(document.getElementById('staffPanel_home'), true);
  }
  function opsRefreshSoon(){ clearTimeout(opsDock.deb); opsDock.deb = setTimeout(opsRefreshNow, 1500); }
  function opsLiveStart(p){
    if(!opsDock.wired){
      opsDock.wired = true;
      setInterval(opsRefreshNow, 60000);
      document.addEventListener('visibilitychange', ()=>{ if(!document.hidden) opsRefreshSoon(); });
      window.addEventListener('online', opsRefreshSoon);
    }
    if(opsDock.rt && opsDock.rtUid === currentUser.id) return;
    if(typeof db === 'undefined' || !db || !db.channel) return;
    opsRealtimeTeardown();
    opsDock.rtUid = currentUser.id;
    try{
      const ch = db.channel('ops-dash-' + currentUser.id);
      opsDock.rt = ch;
      if(p.d) ch.on('postgres_changes', { event:'*', schema:'public', table:'dispatch_tickets' }, opsRefreshSoon);
      if(p.dtr) ch.on('postgres_changes', { event:'*', schema:'public', table:'dtr_records' }, opsRefreshSoon);
      ch.subscribe((status)=>{
        if(opsDock.rt !== ch) return;
        if(status === 'SUBSCRIBED'){ opsDock.rtTries = 0; return; }
        if(status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED'){
          opsDock.rt = null; opsDock.rtUid = null;
          try{ db.removeChannel(ch); }catch(_){}
          const wait = Math.min(300000, 5000 * Math.pow(2, opsDock.rtTries++));
          setTimeout(()=>{ if(currentUser && opsCanDash()) opsLiveStart(opsPerms()); }, wait);
        }
      });
    }catch(e){ opsDock.rt = null; opsDock.rtUid = null; }
  }
  function opsRealtimeTeardown(){
    const old = opsDock.rt; opsDock.rt = null; opsDock.rtUid = null; opsDock.rtTries = 0;
    if(old){ try{ db.removeChannel(old); }catch(_){} }
  }
