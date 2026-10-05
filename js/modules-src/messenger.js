  // =====================================================================
  // Messenger / liaison account — simple "mission" experience
  //
  // A messenger is office staff with the My Errands page (adm.my_errands) —
  // the same rule dtrLocationRequired() already uses. For them:
  //   * a bottom bar (#msgrNav: Home · Errands · Cash · Menu) replaces the
  //     sidebar and hamburger on EVERY screen (body.role-messenger),
  //   * Home (staffPanel_home) shows today's errands in order with ONE big
  //     next action (Time in → Start errand → Continue → Time out),
  //   * Menu (staffPanel_msgrMenu) lists every page the old sidebar had,
  //   * My account (staffPanel_msgrAccount) holds password, activity, sign out.
  // Everything opens the screens that already exist; nothing here writes to
  // the database except through the existing time in/out and errand_start.
  // =====================================================================

  const msgr = { tab:'home', cash:{ toLiq:0, pending:0 }, openErrands:0 };
  const MSGR_OWN_HEADER = ['Home', 'Menu', 'My account'];   // screens that draw their own heading

  function isMessengerUser(){ return !!(typeof isStaffUser === 'function' && isStaffUser() && can('adm.my_errands', 'view')); }

  // Called whenever the signed-in user or their access may have changed.
  function msgrApply(){
    const on = isMessengerUser();
    document.body.classList.toggle('role-messenger', on);
    const nav = $('msgrNav');
    if(nav) nav.style.display = on ? '' : 'none';
    if(!on) document.body.classList.remove('msgr-own-head');
  }
  // Header: messenger screens that draw their own heading hide the top bar.
  function msgrOnHeader(title){
    document.body.classList.toggle('msgr-own-head', isMessengerUser() && MSGR_OWN_HEADER.includes(title));
  }
  function msgrSetTab(tab){
    msgr.tab = tab;
    document.querySelectorAll('#msgrNav [data-msgr-tab]').forEach(b=>{
      const on = b.getAttribute('data-msgr-tab') === tab;
      b.classList.toggle('active', on);
      if(on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
  }

  const msgrEsc = (v)=> escapeHtml(v == null ? '' : String(v));
  const MSGR_ICONS = {
    bell:'<path d="M6 17V11a6 6 0 0 1 12 0v6l1.5 2h-15z"/><path d="M10 21a2 2 0 0 0 4 0"/>',
    home:'<path d="M4 11l8-7 8 7v9H4z"/><path d="M10 20v-6h4v6"/>',
    list:'<path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01"/>',
    cash:'<rect x="3" y="6" width="18" height="14" rx="2.5"/><path d="M3 10h18M16 15h2"/>',
    menu:'<path d="M4 7h16M4 12h16M4 17h16"/>',
    clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    check:'<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    play:'<path d="M8 5l12 7-12 7z"/>',
    pin:'<path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>',
    chev:'<path d="M9 5l7 7-7 7"/>',
    down:'<path d="M5 9l7 7 7-7"/>',
    back:'<path d="M15 5l-7 7 7 7"/>',
    arrow:'<path d="M5 12h14M13 6l6 6-6 6"/>',
    leave:'<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/>',
    slip:'<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/>',
    liq:'<rect x="5" y="5" width="14" height="16" rx="2"/><path d="M9 3h6v4H9zM9 14l2 2 4-4"/>',
    refund:'<path d="M4 12a8 8 0 1 0 3-6.2M4 4v4h4"/>',
    plus:'<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>',
    lock:'<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
    pulse:'<path d="M3 12h4l3-7 4 14 3-7h4"/>',
    out:'<path d="M9 4H5v16h4M16 8l4 4-4 4M20 12H9"/>',
    page:'<path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4"/>',
    cart:'<circle cx="9" cy="20" r="1.5"/><circle cx="17" cy="20" r="1.5"/><path d="M3 4h2l2.5 11h10L20 7H6"/>',
    box:'<path d="M12 3l8 4v10l-8 4-8-4V7z"/><path d="M4 7l8 4 8-4M12 11v10"/>',
    tool:'<path d="M15 5a4 4 0 0 0-4 5L4 17l3 3 7-7a4 4 0 0 0 5-4l-3 2-2-2z"/>',
    people:'<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6.5 6.5 0 0 1 3.5 6"/>',
    building:'<path d="M4 21V7l8-4 8 4v14M9 21v-6h6v6M8 10h.01M12 10h.01M16 10h.01"/>',
    gear:'<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1"/>',
    truck:'<path d="M3 6h11v10H3zM14 9h4l3 3v4h-7"/><circle cx="7" cy="18" r="1.8"/><circle cx="17" cy="18" r="1.8"/>'
  };
  function msgrIc(name, size, sw){
    const fill = name === 'play' ? 'currentColor' : 'none';
    return '<svg width="' + (size || 24) + '" height="' + (size || 24) + '" viewBox="0 0 24 24" fill="' + fill + '" stroke="currentColor" stroke-width="' + (sw === undefined ? 2.4 : sw) + '" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (MSGR_ICONS[name] || '') + '</svg>';
  }

  // ---------- small helpers ----------
  function msgrGreeting(){
    const h = new Date(Date.now() + 8 * 3600e3).getUTCHours();
    return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  }
  function msgrFirstName(){ return String((currentUser && currentUser.name) || '').trim().split(/\s+/)[0] || 'there'; }
  function msgrManilaDay(ts){
    try{ return new Date(ts).toLocaleDateString('en-CA', { timeZone:'Asia/Manila' }); }catch(e){ return ''; }
  }
  function msgrDue(ts){
    if(!ts) return '';
    try{
      const t = new Date(ts);
      const time = t.toLocaleTimeString('en-PH', { timeZone:'Asia/Manila', hour:'numeric', minute:'2-digit' });
      return msgrManilaDay(t) === todayISO() ? time : t.toLocaleDateString('en-PH', { timeZone:'Asia/Manila', month:'short', day:'numeric' }) + ', ' + time;
    }catch(e){ return ''; }
  }
  function msgrPlace(e){ return String(e.destination || e.address || '').trim(); }
  function msgrNeedsYou(){
    const items = (typeof stfInbox !== 'undefined' && stfInbox && stfInbox.items) ? stfInbox.items : [];
    return items.filter(x=> x.state !== 'waiting');
  }

  // ---------- data ----------
  async function msgrLoad(){
    const uid = currentUser.id;
    const out = { dtr:null, errands:[], cash:{ toLiq:0, pending:0 }, ok:true, err:null };
    try{
      const [d, e, c] = await Promise.all([
        dtrGetDay(uid, todayISO()).catch(()=> null),
        db.from('errands').select('id, errand_no, title, destination, address, due_at, status, checklist, started_at, completed_at, failed_at, closed_at')
          .eq('assigned_to', uid).in('status', ['assigned', 'in_progress', 'done', 'failed', 'closed']).order('due_at', { ascending:true, nullsFirst:false }).limit(200),
        db.from('cash_advance_requests').select('status, data').eq('technician_id', uid)
      ]);
      out.dtr = d || null;
      if(e.error) throw e.error;
      out.errands = e.data || [];
      const cash = c && c.data || [];
      out.cash.toLiq = cash.filter(r=> r.data && r.data.disbursed && (!r.data.liquidation || typeof r.data.liquidation !== 'object')).length;
      out.cash.pending = cash.filter(r=> r.status === 'pending').length;
    }catch(err){ out.ok = false; out.err = err; }
    msgr.cash = out.cash;
    return out;
  }
  function msgrSplit(list){
    const today = todayISO();
    const open = list.filter(e=> e.status === 'assigned' || e.status === 'in_progress');
    // recommended order: the one already under way first, then by due time
    open.sort((a, b)=> (a.status === 'in_progress' ? 0 : 1) - (b.status === 'in_progress' ? 0 : 1) ||
      (a.due_at ? new Date(a.due_at).getTime() : Infinity) - (b.due_at ? new Date(b.due_at).getTime() : Infinity));
    const finished = (e)=> msgrManilaDay(e.completed_at || e.failed_at || e.closed_at || '') === today;
    const done = list.filter(e=> (e.status === 'done' || e.status === 'closed') && finished(e));
    const failed = list.filter(e=> e.status === 'failed' && finished(e));
    return { open, done, failed };
  }

  // ---------- Home ----------
  function msgrBellHtml(){
    const n = msgrNeedsYou().length;
    return '<button type="button" class="msgr-bell" data-msgr="alerts" aria-label="Alerts' + (n ? ', ' + n + ' need you' : '') + '">' + msgrIc('bell', 28, 2.2) +
      (n ? '<span class="msgr-bell-n">' + (n > 99 ? '99+' : n) + '</span>' : '') + '</button>';
  }
  function msgrCircle(kind, n){
    if(kind === 'done') return '<span class="msgr-circ done">' + msgrIc('check', 20, 3.2) + '</span>';
    if(kind === 'prog') return '<span class="msgr-circ prog"></span>';
    return '<span class="msgr-circ">' + (n || '') + '</span>';
  }
  function msgrRow(e, n, kind){
    const late = kind !== 'done' && typeof erOverdue === 'function' && erOverdue(e);
    const when = kind === 'done' ? (e.completed_at || e.closed_at ? new Date(e.completed_at || e.closed_at).toLocaleTimeString('en-PH', { timeZone:'Asia/Manila', hour:'numeric', minute:'2-digit' }) : '')
      : kind === 'failed' ? 'Not finished' : msgrDue(e.due_at);
    return '<button type="button" class="msgr-row" data-msgr-errand="' + msgrEsc(e.id) + '">' + msgrCircle(kind === 'failed' ? 'todo' : kind, n) +
      '<span class="msgr-row-main"><span class="msgr-row-title">' + msgrEsc(e.title) + '</span>' +
      (msgrPlace(e) ? '<span class="msgr-row-sub">' + msgrEsc(msgrPlace(e)) + '</span>' : '') + '</span>' +
      '<span class="msgr-row-time' + (late ? ' late' : '') + (kind === 'done' ? ' ok' : '') + '">' + (late ? 'Late · ' : '') + msgrEsc(when) + '</span></button>';
  }
  function msgrSummary(total, done, inProg, segs){
    const bar = segs.map(s=> '<span class="msgr-seg ' + s + '"></span>').join('');
    const left = Math.max(0, total - done);
    const sub = !total ? 'Nothing assigned yet' : (inProg ? inProg + ' in progress · ' + (left - inProg) + ' to go' : done + ' done · ' + left + ' to go');
    return '<div class="msgr-sum"><div class="msgr-label green">TODAY\u2019S TASKS</div>' +
      '<div class="msgr-sum-line"><span class="msgr-sum-big">' + total + ' errand' + (total === 1 ? '' : 's') + '</span><span class="msgr-sum-sub">' + sub + '</span></div>' +
      (total ? '<div class="msgr-segs">' + bar + '</div>' : '') + '</div>';
  }
  function msgrNextBox(title, text){
    return '<div class="msgr-next"><span class="msgr-next-ic">' + msgrIc('play', 22, 1.5) + '</span><div><span class="msgr-tag">NEXT STEP</span>' +
      '<div class="msgr-next-t">' + msgrEsc(title) + '</div><div class="msgr-next-s">' + msgrEsc(text) + '</div></div></div>';
  }
  const msgrBtn = (act, label, icon, id)=> '<button type="button" class="msgr-big" data-msgr="' + act + '"' + (id ? ' data-id="' + msgrEsc(id) + '"' : '') + '>' + msgrIc(icon, 30) + '<span>' + label + '</span></button>';
  const msgrTap = (txt)=> '<div class="msgr-tap">' + msgrIc('arrow', 20, 2.6) + '<div><b>When you tap:</b> ' + txt + '</div></div>';

  async function msgrRenderHome(target){
    target.innerHTML = '<div class="msgr-page"><div class="empty-state">Loading\u2026</div></div>';
    const [data] = await Promise.all([msgrLoad(), (typeof staffLoadInbox === 'function' ? staffLoadInbox() : null)]);
    if(!data.ok){
      target.innerHTML = '<div class="msgr-page"><div class="msgr-head"><div><div class="msgr-hello">' + msgrGreeting() + '</div><div class="msgr-name">' + msgrEsc(msgrFirstName()) + '</div></div>' + msgrBellHtml() + '</div>' +
        '<div class="msgr-card"><div class="msgr-card-t">Can\u2019t load your errands</div><p class="msgr-p">Check your connection, then try again.</p>' + msgrBtn('retry', 'TRY AGAIN', 'refund') + '</div></div>';
      return;
    }
    const tIn = data.dtr && data.dtr.timeIn, tOut = data.dtr && data.dtr.timeOut;
    const { open, done, failed } = msgrSplit(data.errands);
    msgr.openErrands = open.length;
    const total = open.length + done.length + failed.length;
    const featured = open[0] || null;
    const inProg = open.filter(e=> e.status === 'in_progress').length;
    const fmt = (t)=>{ try{ return new Date(t).toLocaleTimeString('en-PH', { timeZone:'Asia/Manila', hour:'numeric', minute:'2-digit' }); }catch(e){ return ''; } };

    const segs = [];
    done.forEach(()=> segs.push('g'));
    failed.forEach(()=> segs.push('n'));
    open.forEach((e, i)=> segs.push(e.status === 'in_progress' ? 'a' : (i === 0 && tIn && !tOut ? 'b' : 'n')));

    let chip = tOut ? '<span class="msgr-chip ok">' + msgrIc('check', 18, 2.6) + 'Timed out ' + msgrEsc(fmt(tOut)) + '</span>'
      : tIn ? '<span class="msgr-chip ok">' + msgrIc('check', 18, 2.6) + 'Timed in ' + msgrEsc(fmt(tIn)) + '</span>'
      : '<span class="msgr-chip warn">' + msgrIc('clock', 18) + 'Not timed in yet</span>';

    let card = '', listTitle = 'RECOMMENDED ORDER', listRows = '';
    const rest = featured ? open.slice(1) : [];
    if(!tIn){
      card = '<div class="msgr-card blue">' + msgrNextBox('Time in', 'Tap the green button to begin your day.') + msgrBtn('timein', 'TIME IN', 'clock') +
        msgrTap('your time and location are saved.' + (open.length ? ' Then you can start errand 1.' : '')) + '</div>';
      listRows = open.map((e, i)=> msgrRow(e, i + 1, 'todo')).join('');
    }else if(tOut){
      card = '<div class="msgr-card"><div class="msgr-done-line">' + msgrCircle('done') + '<div><div class="msgr-card-t">You\u2019re done for today</div><p class="msgr-p">See you tomorrow, ' + msgrEsc(msgrFirstName()) + '.</p></div></div></div>';
      listTitle = 'TODAY\u2019S ERRANDS';
      listRows = done.map(e=> msgrRow(e, 0, 'done')).join('') + failed.map(e=> msgrRow(e, 0, 'failed')).join('');
    }else if(featured && featured.status === 'in_progress'){
      const ck = Array.isArray(featured.checklist) ? featured.checklist : [];
      const nextStep = ck.find(s=> !s.done);
      card = '<div class="msgr-card amber"><div class="msgr-card-top"><span class="msgr-tag amber">IN PROGRESS</span>' + (ck.length ? '<span class="msgr-pill">' + ck.filter(s=> s.done).length + ' of ' + ck.length + ' steps</span>' : '') + '</div>' +
        '<div class="msgr-card-t">' + msgrEsc(featured.title) + '</div>' +
        (msgrPlace(featured) ? '<div class="msgr-card-sub">' + msgrEsc(msgrPlace(featured)) + '</div>' : '') +
        msgrNextBox(nextStep ? nextStep.text : 'Finish the errand', nextStep ? 'This is the next thing to do.' : 'Tap the green button to see what is left.') +
        msgrBtn('open', 'CONTINUE ERRAND', 'play', featured.id) + msgrTap('you see this errand\u2019s steps. Your place is saved as you go.') + '</div>';
      listRows = rest.map((e, i)=> msgrRow(e, i + 2, 'todo')).join('');
    }else if(featured){
      card = '<div class="msgr-card blue"><div class="msgr-card-top"><span class="msgr-num">1</span><span class="msgr-tag">UP NEXT</span></div>' +
        '<div class="msgr-card-t">' + msgrEsc(featured.title) + '</div>' +
        (msgrPlace(featured) ? '<div class="msgr-card-sub">' + msgrEsc(msgrPlace(featured)) + '</div>' : '') +
        (featured.due_at ? '<div class="msgr-due">' + msgrIc('clock', 20) + 'Due ' + msgrEsc(msgrDue(featured.due_at)) + '</div>' : '') +
        msgrBtn('start', 'START ERRAND 1', 'play', featured.id) + msgrTap('your time and location are saved. Then you see the steps.') + '</div>';
      listRows = rest.map((e, i)=> msgrRow(e, i + 2, 'todo')).join('');
    }else{
      card = '<div class="msgr-card"><div class="msgr-done-line">' + msgrCircle('done') + '<div><div class="msgr-card-t">' + (total ? 'All errands done' : 'No errands right now') + '</div>' +
        '<p class="msgr-p">' + (total ? 'Great work, ' + msgrEsc(msgrFirstName()) + '.' : 'The office will tell you when one is ready.') + '</p></div></div>' +
        (total ? msgrNextBox('Time out', 'Tap the green button to end your day.') : '') +
        msgrBtn('timeout', 'TIME OUT', 'clock') + msgrTap('your time and location are saved. The office then reviews today\u2019s errands.') + '</div>';
      listTitle = 'TODAY\u2019S ERRANDS';
      listRows = done.map(e=> msgrRow(e, 0, 'done')).join('') + failed.map(e=> msgrRow(e, 0, 'failed')).join('');
    }
    // finished errands stay visible under the open ones
    const finishedRows = (open.length && tIn && !tOut) ? done.map(e=> msgrRow(e, 0, 'done')).join('') + failed.map(e=> msgrRow(e, 0, 'failed')).join('') : '';

    target.innerHTML = '<div class="msgr-page">' +
      '<div class="msgr-head"><div><div class="msgr-hello">' + msgrGreeting() + '</div><div class="msgr-name">' + msgrEsc(msgrFirstName()) + '</div></div>' + msgrBellHtml() + '</div>' +
      chip + msgrSummary(total, done.length, inProg, segs) + card +
      (listRows ? '<div class="msgr-label">' + listTitle + '</div><div class="msgr-list">' + listRows + '</div>' : '') +
      (finishedRows ? '<div class="msgr-label">DONE TODAY</div><div class="msgr-list">' + finishedRows + '</div>' : '') + '</div>';
  }

  async function msgrShowHome(){
    msgrSetTab('home');
    await showStaffHome();
  }
  // Open one errand in the existing errand screen (the guided errand steps come next).
  function msgrOpenErrand(id){
    msgrSetTab('errands');
    if(typeof er !== 'undefined') er.pendingOpen = id;
    showPurchasingView('myErrands');
  }
  async function msgrStartErrand(id, btn){
    if(btn) btn.disabled = true;
    try{
      const loc = await erLoc(); if(!loc) return;
      const { error } = await db.rpc('errand_start', { p_id:id, p_loc:loc });
      if(error) throw error;
      toast('Errand started');
      msgrOpenErrand(id);
    }catch(err){ toast('Couldn\u2019t start: ' + ((err && err.message) || describeCloudError(err))); }
    finally{ if(btn) btn.disabled = false; }
  }

  document.addEventListener('click', async (ev)=>{
    const home = $('staffPanel_home');
    const row = ev.target.closest('[data-msgr-errand]');
    if(row && home && home.contains(row)){ msgrOpenErrand(row.getAttribute('data-msgr-errand')); return; }
    const b = ev.target.closest('[data-msgr]');
    if(!b || !home || !home.contains(b) || !isMessengerUser()) return;
    const act = b.getAttribute('data-msgr'), id = b.getAttribute('data-id');
    if(act === 'alerts'){ msgrSetTab('home'); staffOpenInbox(); }
    else if(act === 'retry') msgrRenderHome(home);
    else if(act === 'timein'){ b.disabled = true; try{ await dtrDoTimeIn(); }finally{ b.disabled = false; } msgrRenderHome(home); }
    else if(act === 'timeout'){
      if(!(await uiConfirm('Time out for today?', { ok:'Time out', cancel:'Not yet' }))) return;
      b.disabled = true; try{ await dtrDoTimeOut(); }finally{ b.disabled = false; } msgrRenderHome(home);
    }
    else if(act === 'start') msgrStartErrand(id, b);
    else if(act === 'open') msgrOpenErrand(id);
  });

  // ---------- Menu ----------
  function msgrMenuRow(icon, label, sub, attrs, count){
    return '<button type="button" class="msgr-mrow" ' + attrs + '><span class="msgr-mic">' + msgrIc(icon, 24) + '</span>' +
      '<span class="msgr-mrow-main"><span class="msgr-mrow-t">' + msgrEsc(label) + '</span>' + (sub ? '<span class="msgr-mrow-s">' + msgrEsc(sub) + '</span>' : '') + '</span>' +
      (count ? '<span class="msgr-count">' + count + '</span>' : '') + '<span class="msgr-chev">' + msgrIc('chev', 22, 3) + '</span></button>';
  }
  const MSGR_GROUP_ICON = { 'Operations':'truck', 'Customers':'people', 'Purchasing':'cart', 'Inventory':'box', 'Tools':'tool', 'Human Resources':'people', 'Finance':'cash', 'Administration':'building', 'System':'gear' };
  const MSGR_PAGE_HINT = {
    'pur.requisitions':'Ask for materials', 'pur.purchase_orders':'Orders to suppliers', 'pur.materials':'Material list', 'pur.suppliers':'Supplier list',
    'inv.stock':'What is in the warehouse', 'inv.receive':'Items coming in', 'inv.issue':'Items going out', 'inv.returns':'Items coming back', 'inv.transfers':'Move items between places',
    'inv.slips':'Past slips', 'inv.reports':'Stock reports', 'inv.warehouses':'Warehouse list',
    'tools.register':'All tools', 'tools.issue':'Give a tool to a worker', 'tools.return':'Take a tool back', 'tools.handover':'Pass a tool on', 'tools.defects':'Report a broken tool', 'tools.maintenance':'Tool servicing', 'tools.slips':'Past tool slips', 'tools.reports':'Tool reports',
    'adm.announcements':'Memos from the office'
  };
  function msgrMenuPages(){
    // the department pages the office granted (same list the old sidebar showed)
    const keys = [];
    STAFF_READY_MODULES.filter(k=> k !== 'adm.my_errands' && can(k, 'view')).forEach(k=>{
      const kk = STAFF_TECH_HUB.includes(k) ? 'tech.hub' : k;
      if(!keys.includes(kk)) keys.push(kk);
    });
    const counts = {};
    msgrNeedsYou().forEach(x=>{ const m = STAFF_TECH_HUB.includes(x.module) ? 'tech.hub' : x.module; counts[m] = (counts[m] || 0) + 1; });
    return keys.map(k=>{
      const m = typeof stfModule === 'function' ? stfModule(k) : null;
      return { key:k, label: k === 'tech.hub' ? 'Technicians' : (STAFF_NAV_LABELS[k] || (m ? m.label : k)), group: staffNavGroup(k), n: counts[k] || 0 };
    });
  }
  function msgrPageRow(p, nested){
    return '<button type="button" class="msgr-prow' + (nested ? ' nested' : '') + '" data-msgr-module="' + msgrEsc(p.key) + '"><span class="msgr-mrow-main"><span class="msgr-mrow-t">' + msgrEsc(p.label) + '</span>' +
      (MSGR_PAGE_HINT[p.key] ? '<span class="msgr-mrow-s">' + msgrEsc(MSGR_PAGE_HINT[p.key]) + '</span>' : '') + '</span>' +
      (p.n ? '<span class="msgr-count">' + p.n + '</span>' : '') + '<span class="msgr-chev">' + msgrIc('chev', 22, 3) + '</span></button>';
  }
  async function msgrShowMenu(){
    msgrSetTab('menu');
    showStaffView('msgrMenu');
    const target = $('staffPanel_msgrMenu');
    target.innerHTML = '<div class="msgr-page"><div class="empty-state">Loading\u2026</div></div>';
    if(typeof staffLoadDirectory === 'function' && !stf.modules.length) await staffLoadDirectory();
    await Promise.all([msgrLoad(), (typeof staffLoadInbox === 'function' ? staffLoadInbox() : null)]);
    const pages = msgrMenuPages();
    const groups = {};
    pages.forEach(p=> (groups[p.group] = groups[p.group] || []).push(p));
    // few extra pages: list them straight under My work; many: one folder per department
    let more = '';
    if(pages.length && pages.length <= 3) more = pages.map(p=> msgrPageRow(p)).join('');
    else if(pages.length){
      more = '<div class="msgr-label" style="margin-top:6px;">MORE PAGES FROM THE OFFICE</div><div class="msgr-hint">Tap a folder to open it.</div>' +
        STAFF_NAV_GROUPS.filter(g=> groups[g]).map(g=>{
          const list = groups[g], n = list.reduce((a, p)=> a + p.n, 0);
          return '<details class="msgr-folder"><summary><span class="msgr-mic">' + msgrIc(MSGR_GROUP_ICON[g] || 'page', 24) + '</span>' +
            '<span class="msgr-mrow-main"><span class="msgr-mrow-t">' + msgrEsc(g) + '</span><span class="msgr-mrow-s">' + list.length + ' page' + (list.length === 1 ? '' : 's') + '</span></span>' +
            (n ? '<span class="msgr-count">' + n + '</span>' : '') + '<span class="msgr-chev down">' + msgrIc('down', 22, 3) + '</span></summary>' +
            '<div class="msgr-folder-body">' + list.map(p=> msgrPageRow(p, true)).join('') + '</div></details>';
        }).join('');
    }
    const initial = (currentUser.name || '?').trim().charAt(0).toUpperCase();
    target.innerHTML = '<div class="msgr-page"><div class="msgr-head"><div class="msgr-title">Menu</div>' + msgrBellHtml() + '</div>' +
      '<button type="button" class="msgr-acct" data-msgr-go="account"><span class="msgr-avatar">' + msgrEsc(initial) + '</span><span class="msgr-mrow-main"><span class="msgr-mrow-t">' + msgrEsc(currentUser.name || '') + '</span><span class="msgr-acct-s">My account</span></span><span class="msgr-chev">' + msgrIc('chev', 22, 3) + '</span></button>' +
      '<div class="msgr-label">MY WORK</div>' + msgrMenuRow('list', 'My errands', 'Today and past', 'data-msgr-go="errands"', msgr.openErrands || '') + more +
      '<div class="msgr-label">MY TIME AND PAY</div>' +
      msgrMenuRow('clock', 'My attendance', 'Time in and out', 'data-msgr-go="dtr"') + msgrMenuRow('leave', 'My leave', 'Days off', 'data-msgr-go="leave"') + msgrMenuRow('slip', 'My payslips', 'Your pay', 'data-msgr-go="payslips"') +
      '<div class="msgr-label">MY MONEY</div>' +
      msgrMenuRow('cash', 'My cash advance', 'Money for errands', 'data-msgr-go="cash"', msgr.cash.pending || '') +
      msgrMenuRow('liq', 'My liquidation', 'Send in your receipts', 'data-msgr-go="liq"', msgr.cash.toLiq || '') +
      msgrMenuRow('refund', 'My reimbursement', 'Money you paid first', 'data-msgr-go="reimb"') +
      '<div class="msgr-label">ASK THE OFFICE</div>' + msgrMenuRow('plus', 'Errand requests', 'Ask for a messenger', 'data-msgr-go="errandReq"') + '</div>';
  }

  // ---------- My account ----------
  function msgrShowAccount(){
    msgrSetTab('menu');
    showStaffView('msgrAccount');
    const target = $('staffPanel_msgrAccount');
    const initial = (currentUser.name || '?').trim().charAt(0).toUpperCase();
    const online = navigator.onLine !== false;
    target.innerHTML = '<div class="msgr-page"><button type="button" class="msgr-backbtn" data-msgr-go="menu">' + msgrIc('back', 22, 2.8) + 'Back</button>' +
      '<div class="msgr-title">My account</div>' +
      '<div class="msgr-profile"><span class="msgr-avatar big">' + msgrEsc(initial) + '</span><div class="msgr-profile-n">' + msgrEsc(currentUser.name || '') + '</div>' +
      '<div class="msgr-profile-r">' + msgrEsc(currentUser.position || 'Messenger') + '</div>' +
      '<div class="msgr-conn ' + (online ? 'ok' : 'off') + '"><span></span>' + (online ? 'Connected' : 'No connection') + '</div></div>' +
      msgrMenuRow('lock', 'Change password', 'Keep your account safe', 'data-msgr-go="password"') +
      msgrMenuRow('pulse', 'My activity', 'What you did lately', 'data-msgr-go="activity"') +
      '<button type="button" class="msgr-signout" data-msgr-go="signout">' + msgrIc('out', 26) + 'Sign out</button></div>';
  }

  // ---------- navigation (bar + Menu rows) ----------
  async function msgrGo(where){
    switch(where){
      case 'home': return msgrShowHome();
      case 'errands': msgrSetTab('errands'); return showPurchasingView('myErrands');
      case 'cash': msgrSetTab('cash'); return showCashAdvanceView(true, 'new');
      case 'menu': return msgrShowMenu();
      case 'account': return msgrShowAccount();
      case 'dtr': return showDtrView(true);
      case 'leave': return showLeaveView(true);
      case 'payslips': return showPurchasingView('myPayslips');
      case 'liq': return showCashAdvanceView(true, 'liquidate');
      case 'reimb': return showCashAdvanceView(true, 'reimburse');
      case 'errandReq': return showPurchasingView('errandRequests');
      case 'password': return showChangePasswordScreen(false);
      case 'activity': return staffOpenActivity();
      case 'signout':
        if(await uiConfirm('Sign out of AWES?', { ok:'Sign out', cancel:'Stay signed in' })) return doLogout();
        return;
    }
  }
  (function msgrWire(){
    const nav = $('msgrNav');
    if(nav) nav.addEventListener('click', (ev)=>{
      const b = ev.target.closest('[data-msgr-tab]'); if(!b) return;
      msgrGo(b.getAttribute('data-msgr-tab'));
    });
    ['staffPanel_msgrMenu', 'staffPanel_msgrAccount'].forEach(id=>{
      const el = $(id); if(!el) return;
      el.addEventListener('click', (ev)=>{
        const go = ev.target.closest('[data-msgr-go]');
        if(go){ msgrGo(go.getAttribute('data-msgr-go')); return; }
        const mod = ev.target.closest('[data-msgr-module]');
        if(mod){ staffOpenModule(mod.getAttribute('data-msgr-module')); return; }
        const bell = ev.target.closest('[data-msgr="alerts"]');
        if(bell) staffOpenInbox();
      });
    });
  })();
