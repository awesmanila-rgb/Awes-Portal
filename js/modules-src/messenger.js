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
  const MSGR_OWN_HEADER = ['Home', 'Menu', 'My account', 'Alerts', 'Cash', 'My Errands'];   // screens that draw their own heading

  function isMessengerUser(){ return !!(typeof isStaffUser === 'function' && isStaffUser() && can('adm.my_errands', 'view')); }

  // Called whenever the signed-in user or their access may have changed.
  function msgrApply(){
    const on = isMessengerUser();
    document.body.classList.toggle('role-messenger', on);
    const nav = $('msgrNav');
    if(nav) nav.style.display = on ? '' : 'none';
    if(!on) document.body.classList.remove('msgr-own-head');
    if(on){ msgrLiveStart(); msgrRealtimeStart(); } else msgrRealtimeTeardown();
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
  // Everything in the staff Inbox is work waiting on him ('waiting' / 'overdue' / 'escalated' only say
  // how urgent), plus his own cash advances still to be liquidated.
  const MSGR_RANK = { escalated:0, overdue:1, waiting:2 };
  function msgrAlertList(){
    const items = (typeof stfInbox !== 'undefined' && stfInbox && stfInbox.items) ? stfInbox.items : [];
    const out = items.map(x=> ({ src:'inbox', x, state:x.state || 'waiting', title:x.label || 'Waiting for you',
      sub:[x.ref_label, x.title].filter(Boolean).join(' \u00B7 '), age:x.age_hours, module:x.module }));
    if(msgr.cash.toLiq > 0) out.push({ src:'liq', state:'waiting', title:'Send in your receipts',
      sub:'My liquidation \u00B7 ' + msgr.cash.toLiq + ' cash advance' + (msgr.cash.toLiq === 1 ? '' : 's') + ' to close', module:'fin.liquidation' });
    return out.sort((a, b)=> (MSGR_RANK[a.state] != null ? MSGR_RANK[a.state] : 2) - (MSGR_RANK[b.state] != null ? MSGR_RANK[b.state] : 2));
  }
  const msgrNeedsYou = msgrAlertList;

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

  // ---------- new-errand notice + notifications prompt ----------
  function msgrNoticeNew(open, quiet){
    const ids = new Set(open.map(e=> e.id));
    if(quiet && msgr.seen){
      const fresh = open.filter(e=> !msgr.seen.has(e.id));
      if(fresh.length){
        toast(fresh.length === 1 ? 'New errand: ' + fresh[0].title : fresh.length + ' new errands');
        try{ if(navigator.vibrate) navigator.vibrate([150, 80, 150]); }catch(e){}
      }
    }
    msgr.seen = ids;
  }
  function msgrPushHtml(){
    if(typeof pushSupported !== 'function' || !pushSupported()) return '';
    if(Notification.permission === 'default'){
      if(typeof pushPromptSnoozed === 'function' && pushPromptSnoozed()) return '';
      return '<div class="msgr-push"><div class="msgr-push-top"><span class="msgr-mic warn">' + msgrIc('bell', 24) + '</span><div><div class="msgr-push-t">Turn on notifications</div>' +
        '<div class="msgr-push-s">So your phone tells you when the office gives you a new errand, even when the app is closed.</div></div></div>' +
        '<button type="button" class="msgr-big" data-msgr="pushon">' + msgrIc('bell', 30) + '<span>TURN ON</span></button>' +
        '<button type="button" class="msgr-textbtn" data-msgr="pushlater">Not now</button></div>';
    }
    if(Notification.permission === 'denied')
      return '<div class="msgr-banner">' + msgrIc('bell', 22) + '<span><b>Notifications are blocked.</b> You will not be told about new errands unless you open the app. Turn them on in your phone\u2019s browser settings for this app.</span></div>';
    return '';
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

  async function msgrRenderHome(target, quiet){
    if(!quiet) target.innerHTML = '<div class="msgr-page"><div class="empty-state">Loading\u2026</div></div>';
    const [data] = await Promise.all([msgrLoad(), (typeof staffLoadInbox === 'function' ? staffLoadInbox() : null)]);
    if(!data.ok){
      if(quiet) return;   // a background refresh never replaces a good screen with an error
      target.innerHTML = '<div class="msgr-page"><div class="msgr-head"><div><div class="msgr-hello">' + msgrGreeting() + '</div><div class="msgr-name">' + msgrEsc(msgrFirstName()) + '</div></div>' + msgrBellHtml() + '</div>' +
        '<div class="msgr-card"><div class="msgr-card-t">Can\u2019t load your errands</div><p class="msgr-p">Check your connection, then try again.</p>' + msgrBtn('retry', 'TRY AGAIN', 'refund') + '</div></div>';
      return;
    }
    const tIn = data.dtr && data.dtr.timeIn, tOut = data.dtr && data.dtr.timeOut;
    const { open, done, failed } = msgrSplit(data.errands);
    msgr.openErrands = open.length;
    msgrNoticeNew(open, quiet);
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
      msgrPushHtml() + chip + msgrSummary(total, done.length, inProg, segs) + card +
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
    if(act === 'alerts'){ msgrShowAlerts(); }
    else if(act === 'retry') msgrRenderHome(home);
    else if(act === 'pushon'){ b.disabled = true; try{ await pushRequestPermission(); }finally{ msgrRenderHome(home, true); } }
    else if(act === 'pushlater'){
      try{ localStorage.setItem(pushPromptSnoozeKey(), String(Date.now() + 7 * 86400000)); }catch(e){}
      msgrRenderHome(home, true);
    }
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
    ((typeof stfInbox !== 'undefined' && stfInbox.items) || []).forEach(x=>{ const m = STAFF_TECH_HUB.includes(x.module) ? 'tech.hub' : x.module; counts[m] = (counts[m] || 0) + 1; });
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
      msgrMenuRow('cash', 'My cash advance', 'Money for errands', 'data-msgr-go="cashNew"', msgr.cash.pending || '') +
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
    document.body.classList.remove('msgr-own-head');   // Home / Menu / Account turn it back on via their title
    switch(where){
      case 'home': return msgrShowHome();
      case 'errands': msgrSetTab('errands'); return showPurchasingView('myErrands');
      case 'cash': return msgrShowCash();
      case 'cashNew': msgrSetTab('cash'); return showCashAdvanceView(true, 'new');
      case 'alerts': return msgrShowAlerts();
      case 'menu': return msgrShowMenu();
      case 'account': return msgrShowAccount();
      case 'dtr': return showDtrView(true);
      case 'leave': return showLeaveView(true);
      case 'payslips': return showPurchasingView('myPayslips');
      case 'liq': msgrSetTab('cash'); return showCashAdvanceView(true, 'liquidate');
      case 'reimb': msgrSetTab('cash'); return showCashAdvanceView(true, 'reimburse');
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
    ['staffPanel_msgrMenu', 'staffPanel_msgrAccount', 'staffPanel_msgrAlerts', 'staffPanel_msgrCash'].forEach(id=>{
      const el = $(id); if(!el) return;
      el.addEventListener('click', (ev)=>{
        const go = ev.target.closest('[data-msgr-go]');
        if(go){ msgrGo(go.getAttribute('data-msgr-go')); return; }
        const mod = ev.target.closest('[data-msgr-module]');
        if(mod){ staffOpenModule(mod.getAttribute('data-msgr-module')); return; }
        const bell = ev.target.closest('[data-msgr="alerts"]');
        if(bell) msgrShowAlerts();
      });
    });
  })();

  // =====================================================================
  // Guided errand — ONE instruction per screen (renders into #erMyBody)
  //
  // Hooked from errands.js erRenderDetail(): for the messenger's own errand
  // that is assigned / in progress it draws these screens instead of the long
  // detail page. State is derived from the errand itself (status, checklist
  // done flags, uploaded files, transmittal), so every action just reloads the
  // errand and the right next screen appears. Photos, signatures, steps,
  // hand-over, finish and "couldn't complete" all call the same server
  // functions as the old page (erStepAction / erDeliver / errand_complete /
  // errand_fail). Done and failed errands fall back to the old read-only page.
  // =====================================================================
  Object.assign(MSGR_ICONS, {
    nobody:'<circle cx="12" cy="8" r="3.5"/><path d="M5 20a7 7 0 0 1 14 0"/><path d="M4 4l16 16"/>',
    wrongpin:'<path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z"/><path d="M10 8l4 4M14 8l-4 4"/>',
    nodoc:'<path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4"/><path d="M10 14l4 4M14 14l-4 4"/>',
    info:'<circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/>',
    camera:'<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
    pen:'<path d="M4 20l4-1 11-11-3-3L5 16z"/>',
    stamp:'<path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4"/><path d="M10 14l2 2 4-4"/>',
    phone:'<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z"/>'
  });
  const MSGR_REASONS = [['Nobody was there', 'nobody'], ['Office is closed', 'lock'], ['Wrong address', 'wrongpin'], ['Papers are missing', 'nodoc'], ['Something else', 'info']];

  function msgrGInfo(e){
    const place = [e.destination, e.address].filter(Boolean).join(', ');
    const rows = [];
    if(place) rows.push('<div class="msgr-g-line">' + msgrIc('pin', 20) + '<span>' + msgrEsc(place) + '</span></div>' +
      '<a class="msgr-linkbtn" href="https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(place) + '" target="_blank" rel="noopener">' + msgrIc('arrow', 18, 2.6) + 'Directions</a>');
    if(e.contact_name || e.contact_phone) rows.push('<div class="msgr-g-line">' + msgrIc('people', 20) + '<span>' + msgrEsc(e.contact_name || '') + '</span></div>' +
      (e.contact_phone ? '<a class="msgr-linkbtn" href="tel:' + msgrEsc(e.contact_phone) + '">' + msgrIc('phone', 18, 2.4) + 'Call ' + msgrEsc(e.contact_phone) + '</a>' : ''));
    if(e.instructions) rows.push('<div class="msgr-g-line">' + msgrIc('info', 20) + '<span>' + msgrEsc(e.instructions).replace(/\n/g, '<br>') + '</span></div>');
    if(e.cash_amount) rows.push('<div class="msgr-g-line">' + msgrIc('cash', 20) + '<span>Cash needed: \u20B1' + Number(e.cash_amount).toLocaleString('en-PH', { minimumFractionDigits:2 }) + (e.cash_note ? ' \u2014 ' + msgrEsc(e.cash_note) : '') + '</span></div>');
    return rows.length ? '<details class="msgr-info"><summary>Errand details</summary>' + rows.join('') + '</details>' : '';
  }
  function msgrGPlan(e){
    const ck = Array.isArray(e.checklist) ? e.checklist : [];
    const needTx = !!(e.transmittal_required || (e.items || []).length);
    const total = ck.length + (needTx ? 1 : 0);
    const doneN = ck.filter(s=> s.done).length + (needTx && er.tx ? 1 : 0);
    return { ck, needTx, total, doneN };
  }
  function msgrGTop(e, plan, showBar){
    const bar = (showBar && plan.total) ? '<div class="msgr-segs">' + Array.from({ length: plan.total }, (_, i)=> '<span class="msgr-seg ' + (i < plan.doneN ? 'g' : i === plan.doneN ? 'b' : '') + '"></span>').join('') + '</div>' : '';
    const pill = (showBar && plan.total && plan.doneN < plan.total) ? '<span class="msgr-pill">Step ' + (plan.doneN + 1) + ' of ' + plan.total + '</span>' : '';
    return '<div class="msgr-g-top"><button type="button" class="msgr-backbtn" data-er-back="1">' + msgrIc('back', 22, 2.8) + 'My errands</button>' + pill + '</div>' + bar;
  }
  const msgrLink = (act, text, extra)=> '<button type="button" class="msgr-textbtn' + (extra || '') + '" data-msgr-g="' + act + '">' + text + '</button>';

  function msgrGReady(e){
    const plan = msgrGPlan(e);
    const steps = plan.ck.slice(0, 6).map((s, i)=> '<div class="msgr-g-step"><span class="msgr-mic">' + msgrIc(s.needs_photo ? 'camera' : s.needs_signature ? 'pen' : 'check', 22) + '</span><span>' + msgrEsc(s.text) + '</span></div>').join('') +
      (plan.needTx ? '<div class="msgr-g-step"><span class="msgr-mic">' + msgrIc('pen', 22) + '</span><span>Hand over and get a signature</span></div>' : '');
    return msgrGTop(e, plan, false) +
      '<div><div class="msgr-g-h">Ready to go?</div><div class="msgr-g-sub">Here is your errand' + (steps ? '. It has ' + (plan.ck.length + (plan.needTx ? 1 : 0)) + ' simple part' + ((plan.ck.length + (plan.needTx ? 1 : 0)) === 1 ? '' : 's') : '') + '.</div></div>' +
      '<div class="msgr-card"><div class="msgr-card-t">' + msgrEsc(e.title) + '</div>' +
      (e.due_at ? '<div class="msgr-due">' + msgrIc('clock', 20) + 'Due ' + msgrEsc(msgrDue(e.due_at)) + '</div>' : '') + (steps ? '<div class="msgr-g-steps">' + steps + '</div>' : '') + '</div>' +
      msgrGInfo(e) +
      '<button type="button" class="msgr-big" data-er-act="start">' + msgrIc('play', 30) + '<span>START ERRAND</span></button>' +
      msgrTap('your time and location are saved. Then you see your first step.') + msgrLink('problem', 'I can\u2019t do this errand', ' danger');
  }

  function msgrGStepScreen(e, plan, s){
    const files = er.files.filter(f=> f.step_id === s.id);
    const hasPhoto = files.some(f=> f.kind === 'proof'), hasSig = files.some(f=> f.kind === 'signature');
    const needPhoto = !!s.needs_photo && !hasPhoto, needSig = !!s.needs_signature && !hasSig;
    let btn, tap, sub;
    if(needPhoto){ btn = '<button type="button" class="msgr-big" data-step-act="photo">' + msgrIc('camera', 30) + '<span>TAKE PHOTO</span></button>'; tap = 'your camera opens. After the photo, a green button appears.'; sub = 'This step needs a photo for the office.'; }
    else if(needSig){ btn = '<button type="button" class="msgr-big" data-step-act="sign">' + msgrIc('pen', 30) + '<span>SIGN HERE</span></button>'; tap = 'a box opens to sign with your finger.'; sub = 'This step needs a signature.'; }
    else { btn = '<button type="button" class="msgr-big" data-step-act="done">' + msgrIc('check', 30, 3) + '<span>DONE</span></button>'; tap = 'this step is saved with your time and location. Then you see the next step.'; sub = (s.needs_photo || s.needs_signature) ? 'Everything for this step is added.' : 'Tap the green button when you finish this.'; }
    const proof = (hasPhoto || hasSig) ? '<div class="msgr-g-proof">' + (hasPhoto ? '<div class="msgr-ok-line">' + msgrIc('check', 20, 3) + 'Photo added</div>' : '') + (hasSig ? '<div class="msgr-ok-line">' + msgrIc('check', 20, 3) + 'Signature saved</div>' : '') + (typeof erThumbs === 'function' ? erThumbs(files) : '') + '</div>' : '';
    const prev = plan.ck.slice().reverse().find(x=> x.done);
    return msgrGTop(e, plan, true) +
      '<div data-step="' + msgrEsc(s.id) + '"><div class="msgr-g-h">' + msgrEsc(s.text) + '</div><div class="msgr-g-sub">' + sub + '</div>' + proof +
      '<div class="msgr-g-act">' + btn + '</div></div>' + msgrTap(tap) + msgrGInfo(e) +
      '<div class="msgr-g-links"><button type="button" class="msgr-textbtn" data-er-act="photo">Add a receipt or photo</button>' +
      (prev ? '<span data-step="' + msgrEsc(prev.id) + '"><button type="button" class="msgr-textbtn" data-step-act="undo">Go back one step</button></span>' : '') +
      msgrLink('problem', 'Can\u2019t finish this errand?', ' danger') + '</div>';
  }
  function msgrGHandOver(e, plan){
    const items = (e.items || []).map(i=> '<div class="msgr-g-line"><span>' + msgrEsc(i.qty) + ' \u00D7 ' + msgrEsc(i.description) + '</span></div>').join('');
    const card = (how, icon, t, s)=> '<button type="button" class="msgr-choice" data-msgr-g="hand" data-how="' + how + '"><span class="msgr-mic big">' + msgrIc(icon, 34, 2.2) + '</span>' +
      '<span class="msgr-mrow-main"><span class="msgr-choice-t">' + t + '</span><span class="msgr-mrow-s">' + s + '</span></span><span class="msgr-chev">' + msgrIc('chev', 26, 3) + '</span></button>';
    return msgrGTop(e, plan, true) + '<div><div class="msgr-g-h">How did they receive it?</div><div class="msgr-g-sub">Tap one. You can\u2019t get this wrong.</div></div>' +
      (items ? '<div class="msgr-card"><div class="msgr-label">ITEMS TO HAND OVER</div>' + items + '</div>' : '') +
      card('sign', 'pen', 'They sign on my phone', 'Best for offices and companies.') +
      card('stamp', 'stamp', 'They stamp a copy', 'Banks and government offices usually do this. You take a photo of it.') +
      msgrTap('you add the receiver\u2019s name and signature, or a photo of the stamped copy.') + msgrLink('problem', 'Can\u2019t finish this errand?', ' danger');
  }
  function msgrGSignName(e, plan){
    const bar = plan.total ? '<div class="msgr-segs">' + Array.from({ length: plan.total }, (_, i)=> '<span class="msgr-seg ' + (i < plan.doneN ? 'g' : i === plan.doneN ? 'b' : '') + '"></span>').join('') + '</div>' : '';
    return '<div class="msgr-g-top"><button type="button" class="msgr-backbtn" data-msgr-g="handback">' + msgrIc('back', 22, 2.8) + 'Back</button>' +
      (plan.total ? '<span class="msgr-pill">Step ' + plan.total + ' of ' + plan.total + '</span>' : '') + '</div>' + bar +
      '<div><div class="msgr-g-h">Ask them to sign</div><div class="msgr-g-sub">Hand your phone to the receiver.</div></div>' +
      '<label class="msgr-field"><span class="msgr-label">RECEIVER\u2019S NAME</span><input id="msgrRecvName" class="msgr-input" type="text" autocomplete="off" value="' + msgrEsc(e.contact_name || '') + '" placeholder="Type their name"></label>' +
      '<button type="button" class="msgr-big" data-msgr-g="signgo">' + msgrIc('pen', 30) + '<span>ASK THEM TO SIGN</span></button>' +
      msgrTap('a box opens for the receiver to sign with a finger. Then you sign once, and the hand-over is saved.');
  }
  function msgrGFinish(e, plan){
    const note = (msgr.gNoteFor === e.id && msgr.gNote) ? '<div class="msgr-g-line">' + msgrIc('info', 20) + '<span>' + msgrEsc(msgr.gNote) + '</span></div>' : '';
    return msgrGTop(e, plan, true) + '<div class="msgr-g-center">' + msgrCircle('done').replace('msgr-circ done', 'msgr-circ done huge') +
      '<div class="msgr-g-h">All steps done</div><div class="msgr-g-sub">' + (er.tx ? 'Handed over' + (er.tx.receiver_name ? ' to ' + msgrEsc(er.tx.receiver_name) : '') + '. ' : '') + 'Tap the green button to tell the office.</div></div>' + note +
      '<button type="button" class="msgr-big" data-msgr-g="finish">' + msgrIc('check', 30, 3) + '<span>FINISH ERRAND</span></button>' +
      msgrTap('the office is told it is done, with your time and location.') +
      '<div class="msgr-g-links"><button type="button" class="msgr-textbtn" data-msgr-g="note">' + (note ? 'Change my note' : 'Add a note for the office') + '</button><button type="button" class="msgr-textbtn" data-er-act="photo">Add a receipt or photo</button></div>';
  }
  function msgrGProblem(e){
    const btn = ([t, ic])=> '<button type="button" class="msgr-reason" data-msgr-g="reason" data-reason="' + msgrEsc(t) + '"' + (t === 'Something else' ? ' data-other="1"' : '') + '><span class="msgr-mic warn">' + msgrIc(ic, 26) + '</span><span class="msgr-reason-t">' + t + '</span><span class="msgr-chev">' + msgrIc('chev', 24, 3) + '</span></button>';
    return '<div class="msgr-g-top"><button type="button" class="msgr-backbtn" data-msgr-g="unproblem">' + msgrIc('back', 22, 2.8) + 'Back</button></div>' +
      '<div><div class="msgr-g-h">What went wrong?</div><div class="msgr-g-sub">Tap the closest one.</div></div>' + MSGR_REASONS.map(btn).join('') +
      msgrTap('the office is told right away, with your time and place. They will plan a new try. Nothing is lost.') +
      '<button type="button" class="msgr-secondary" data-msgr-g="unproblem">Go back to my errand</button>';
  }
  function msgrGFailed(e){
    return '<div class="msgr-g-center"><span class="msgr-circ prog huge"></span><div class="msgr-g-h">The office has been told</div><div class="msgr-g-sub">' + msgrEsc(e.failed_reason || '') + '</div></div>' +
      msgrTap('the office will plan a new try. You don\u2019t need to do anything else.').replace('When you tap:', 'What happens now:') +
      '<button type="button" class="msgr-big" data-msgr-g="home">' + msgrIc('home', 30) + '<span>BACK TO HOME</span></button>';
  }
  async function msgrGComplete(box, e){
    const plan = msgrGPlan(e);
    const when = e.completed_at ? new Date(e.completed_at).toLocaleTimeString('en-PH', { timeZone:'Asia/Manila', hour:'numeric', minute:'2-digit' }) : '';
    const line = (t)=> '<div class="msgr-ok-line big">' + msgrIc('check', 22, 3) + t + '</div>';
    document.body.classList.add('msgr-own-head');
    box.innerHTML = '<div class="msgr-page msgr-guided"><div class="msgr-g-center">' + msgrCircle('done').replace('msgr-circ done', 'msgr-circ done huge') +
      '<div class="msgr-g-h">Errand complete</div><div class="msgr-g-sub">' + msgrEsc(e.title) + (when ? ' \u2014 finished at ' + msgrEsc(when) : '') + '. Well done, ' + msgrEsc(msgrFirstName()) + '.</div></div>' +
      '<div class="msgr-card">' + (plan.ck.length ? line(plan.doneN >= plan.ck.length ? 'All ' + plan.ck.length + ' steps done' : plan.doneN + ' of ' + plan.ck.length + ' steps done') : '') +
      (er.tx ? line('Handed over and signed') : '') + line('Time and place saved') + '</div>' +
      msgrTap('the office checks it. You don\u2019t need to do anything else.').replace('When you tap:', 'What happens now:') +
      '<div id="msgrNextSlot"><button type="button" class="msgr-big" data-msgr-g="home">' + msgrIc('home', 30) + '<span>BACK TO HOME</span></button></div></div>';
    try{
      const { data } = await db.from('errands').select('id, title, due_at').eq('assigned_to', currentUser.id).in('status', ['assigned', 'in_progress']).order('due_at', { ascending:true, nullsFirst:false }).limit(1);
      const nx = data && data[0], slot = box.querySelector('#msgrNextSlot');
      if(nx && slot) slot.innerHTML = '<button type="button" class="msgr-big" data-msgr-g="open-next" data-id="' + msgrEsc(nx.id) + '">' + msgrIc('arrow', 30, 2.8) + '<span>NEXT ERRAND</span></button>' +
        '<div class="msgr-g-next">Next: ' + msgrEsc(nx.title) + (nx.due_at ? ', due ' + msgrEsc(msgrDue(nx.due_at)) : '') + '</div>' +
        '<button type="button" class="msgr-secondary" data-msgr-g="home">Back to Home</button>';
    }catch(err){}
    window.scrollTo({ top:0 });
  }

  // Called from errands.js erRenderDetail(); true = this file drew the screen.
  function msgrRenderGuided(box, e){
    if(!isMessengerUser() || e.assigned_to !== currentUser.id) return false;
    const st = e.status;
    let html = null;
    if(msgr.gProblem === e.id && (st === 'assigned' || st === 'in_progress')) html = msgrGProblem(e);
    else if(st === 'assigned') html = msgrGReady(e);
    else if(st === 'in_progress'){
      const plan = msgrGPlan(e);
      const cur = plan.ck.find(s=> !s.done);
      if(cur) html = msgrGStepScreen(e, plan, cur);
      else if(plan.needTx && !er.tx) html = (msgr.gHandSign === e.id) ? msgrGSignName(e, plan) : msgrGHandOver(e, plan);
      else html = msgrGFinish(e, plan);
    }
    else if(st === 'done' && er.justDone === e.id){ msgrGComplete(box, e); return true; }
    else if(st === 'failed' && er.justFailed === e.id) html = msgrGFailed(e);
    else return false;
    document.body.classList.add('msgr-own-head');
    box.innerHTML = '<div class="msgr-page msgr-guided">' + html + '</div>';
    return true;
  }

  (function msgrGuidedWire(){
    const body = $('erMyBody'); if(!body) return;
    body.addEventListener('click', async (ev)=>{
      const b = ev.target.closest('[data-msgr-g]'); if(!b || !er.cur || !isMessengerUser()) return;
      const act = b.dataset.msgrG, x = er.cur;
      const redraw = ()=> { msgrRenderGuided(body, x); window.scrollTo({ top:0 }); };
      try{
        if(act === 'home'){ er.justDone = null; er.justFailed = null; msgr.gProblem = null; return msgrGo('home'); }
        if(act === 'open-next'){ er.justDone = null; return erOpenDetail(b.dataset.id); }
        if(act === 'problem'){ msgr.gProblem = x.id; return redraw(); }
        if(act === 'unproblem'){ msgr.gProblem = null; return redraw(); }
        if(act === 'note'){
          const t = await uiPrompt('Anything the office should know? (optional)', msgr.gNoteFor === x.id ? (msgr.gNote || '') : '', { ok:'Save note', multiline:true });
          if(t == null) return;
          msgr.gNote = t.trim(); msgr.gNoteFor = x.id; return redraw();
        }
        if(act === 'handback'){ msgr.gHandSign = null; return redraw(); }
        if(act === 'hand' && b.dataset.how === 'sign'){ msgr.gHandSign = x.id; return redraw(); }
        b.disabled = true;
        if(act === 'hand'){ await erDeliver(false); return; }
        if(act === 'signgo'){
          const inp = $('msgrRecvName'), name = inp ? inp.value.trim() : '';
          if(!name){ toast('Type the receiver\u2019s name first'); if(inp) inp.focus(); return; }
          await erDeliver(true, name); return;
        }
        if(act === 'finish'){
          const loc = await erLoc(); if(!loc) return;
          const { error } = await db.rpc('errand_complete', { p_id:x.id, p_note:(msgr.gNoteFor === x.id ? msgr.gNote : '') || '', p_loc:loc });
          if(error) throw error;
          er.justDone = x.id; msgr.gNote = ''; msgr.gNoteFor = null;
          return erOpenDetail(x.id);
        }
        if(act === 'reason'){
          let why = b.dataset.reason;
          if(b.dataset.other){
            const t = await uiPrompt('What happened?', '', { ok:'Send', multiline:true });
            if(t == null) return;
            if(!t.trim()){ toast('Say what happened'); return; }
            why = t.trim();
          }else if(!(await uiConfirm('Tell the office you couldn\u2019t finish?\n\n' + why, { ok:'Tell the office', cancel:'Go back' }))) return;
          const loc = await erLoc(); if(!loc) return;
          const { error } = await db.rpc('errand_fail', { p_id:x.id, p_reason:why, p_loc:loc });
          if(error) throw error;
          msgr.gProblem = null; er.justFailed = x.id;
          return erOpenDetail(x.id);
        }
      }catch(err){ toast('Couldn\u2019t do that: ' + ((err && err.message) || describeCloudError(err))); }
      finally{ b.disabled = false; }
    });
  })();

  // =====================================================================
  // Alerts (the bell) — everything waiting on him, most urgent first
  // =====================================================================
  const MSGR_ALERT_ICON = { adm:'list', fin:'cash', hr:'clock', inv:'box', pur:'cart', tools:'tool', ops:'truck' };
  async function msgrShowAlerts(quiet){
    const target = $('staffPanel_msgrAlerts');
    if(!quiet){
      msgrSetTab('home');
      showStaffView('msgrAlerts');
      target.innerHTML = '<div class="msgr-page"><div class="empty-state">Loading\u2026</div></div>';
    }
    await Promise.all([msgrLoad(), (typeof staffLoadInbox === 'function' ? staffLoadInbox() : null)]);
    const list = msgr.alerts = msgrAlertList();
    const card = (a, i)=>{
      const sev = a.state === 'escalated' ? 'red' : a.state === 'overdue' ? 'red' : '';
      const tag = a.state === 'escalated' ? '<span class="msgr-tag red">ESCALATED</span>' : a.state === 'overdue' ? '<span class="msgr-tag red">OVERDUE</span>' : '';
      const wait = a.src === 'inbox' && a.age != null && typeof staffFmtWait === 'function' ? 'Waiting ' + staffFmtWait(a.age) : '';
      return '<div class="msgr-alert ' + sev + '"><div class="msgr-alert-top"><span class="msgr-mic warn">' + msgrIc(MSGR_ALERT_ICON[String(a.module || '').split('.')[0]] || 'bell', 24) + '</span>' +
        '<div class="msgr-alert-main">' + tag + '<div class="msgr-alert-t">' + msgrEsc(a.title) + '</div>' + (a.sub ? '<div class="msgr-alert-s">' + msgrEsc(a.sub) + '</div>' : '') +
        (wait ? '<div class="msgr-alert-w">' + msgrEsc(wait) + '</div>' : '') + '</div></div>' +
        '<button type="button" class="msgr-open" data-msgr-alert="' + i + '"><span>Open</span>' + msgrIc('arrow', 22, 2.8) + '</button></div>';
    };
    target.innerHTML = '<div class="msgr-page"><button type="button" class="msgr-backbtn" data-msgr-go="home">' + msgrIc('back', 22, 2.8) + 'Back</button>' +
      '<div><div class="msgr-title">Alerts</div><div class="msgr-g-sub">' + (list.length ? list.length + ' thing' + (list.length === 1 ? '' : 's') + ' need' + (list.length === 1 ? 's' : '') + ' you' : 'You\u2019re all caught up') + '</div></div>' +
      (list.length ? '<div class="msgr-label amber">NEEDS YOU</div>' + list.map(card).join('') + msgrTap('you go straight to the page that needs you. Done items leave this list.')
        : '<div class="msgr-g-center">' + msgrCircle('done').replace('msgr-circ done', 'msgr-circ done huge') + '<div class="msgr-g-sub">Nothing is waiting for you right now.</div></div>' +
          '<button type="button" class="msgr-big" data-msgr-go="home">' + msgrIc('home', 30) + '<span>BACK TO HOME</span></button>') + '</div>';
  }
  function msgrOpenAlert(a){
    if(!a) return;
    if(a.src === 'liq') return msgrGo('liq');
    const x = a.x;
    if(x.kind === 'errand_todo' && x.ref_id) return msgrOpenErrand(x.ref_id);
    if(/_endorse$/.test(x.kind || '')) return staffOpenTeam();
    if(x.kind === 'report_signoff') return srOpenReviewQueue();
    if(x.kind === 'jo_review') return showDispatchView('all').then(()=>{ if(typeof dtSetAdminFilter === 'function') dtSetAdminFilter('completed'); });
    return staffOpenModule(x.module);
  }
  document.addEventListener('click', (ev)=>{
    const b = ev.target.closest('[data-msgr-alert]');
    if(b && isMessengerUser()) msgrOpenAlert((msgr.alerts || [])[Number(b.getAttribute('data-msgr-alert'))]);
  });

  // =====================================================================
  // Errands tab — to do (in order), done today, earlier
  // =====================================================================
  function msgrRenderMine(box, all, quiet){
    const { open, done, failed } = msgrSplit(all);
    msgrNoticeNew(open, quiet);
    const late = open.filter(e=> typeof erOverdue === 'function' && erOverdue(e)).length;
    const doneIds = new Set(done.concat(failed).map(e=> e.id));
    const earlier = all.filter(e=> ['done', 'failed', 'closed'].includes(e.status) && !doneIds.has(e.id))
      .sort((a, b)=> String(b.completed_at || b.failed_at || b.closed_at || '').localeCompare(String(a.completed_at || a.failed_at || a.closed_at || ''))).slice(0, 10);
    const sub = open.length ? open.length + ' to do' + (late ? ' \u00B7 ' + late + ' late' : '') : 'Nothing to do right now';
    const rowFor = (e, n, kind)=> msgrRow(e, n, kind);
    document.body.classList.add('msgr-own-head');
    box.innerHTML = '<div class="msgr-page" data-msgr-screen="errands"><div class="msgr-head"><div><div class="msgr-title">My errands</div><div class="msgr-g-sub" style="margin-top:4px;">' + sub + '</div></div>' + msgrBellHtml() + '</div>' +
      (late ? '<div class="msgr-banner">' + msgrIc('clock', 22) + '<span><b>' + late + ' late.</b> Finish ' + (late === 1 ? 'it' : 'them') + ', or open it and tap \u201CCan\u2019t finish\u201D so the office can reschedule.</span></div>' : '') +
      (open.length ? '<div class="msgr-label">TO DO, IN THIS ORDER</div><div class="msgr-list">' + open.map((e, i)=> rowFor(e, i + 1, e.status === 'in_progress' ? 'prog' : 'todo')).join('') + '</div>'
        : '<div class="msgr-card"><div class="msgr-done-line">' + msgrCircle('done') + '<div><div class="msgr-card-t">All caught up</div><p class="msgr-p">The office will tell you when a new errand is ready.</p></div></div></div>') +
      (done.length || failed.length ? '<div class="msgr-label">DONE TODAY</div><div class="msgr-list">' + done.map(e=> rowFor(e, 0, 'done')).join('') + failed.map(e=> rowFor(e, 0, 'failed')).join('') + '</div>' : '') +
      (earlier.length ? '<div class="msgr-label">EARLIER</div><div class="msgr-list">' + earlier.map(e=> rowFor(e, 0, e.status === 'failed' ? 'failed' : 'done')).join('') + '</div>' : '') + '</div>';
  }
  (function msgrMineWire(){
    const body = $('erMyBody'); if(!body) return;
    body.addEventListener('click', (ev)=>{
      if(!isMessengerUser()) return;
      const row = ev.target.closest('[data-msgr-errand]');
      if(row){ erOpenDetail(row.getAttribute('data-msgr-errand')); return; }
      const bell = ev.target.closest('[data-msgr="alerts"]');
      if(bell) msgrShowAlerts();
    });
  })();

  // =====================================================================
  // Cash tab — three plain choices, each opening the page that already exists
  // =====================================================================
  async function msgrShowCash(){
    msgrSetTab('cash');
    showStaffView('msgrCash');
    const target = $('staffPanel_msgrCash');
    target.innerHTML = '<div class="msgr-page"><div class="empty-state">Loading\u2026</div></div>';
    await Promise.all([msgrLoad(), (typeof staffLoadInbox === 'function' ? staffLoadInbox() : null)]);
    const card = (go, icon, t, s, hint, n)=> '<button type="button" class="msgr-choice small" data-msgr-go="' + go + '"><span class="msgr-mic big">' + msgrIc(icon, 30, 2.2) + '</span>' +
      '<span class="msgr-mrow-main"><span class="msgr-choice-t">' + t + '</span><span class="msgr-mrow-s">' + s + '</span>' + (hint ? '<span class="msgr-choice-h">' + hint + '</span>' : '') + '</span>' +
      (n ? '<span class="msgr-count">' + n + '</span>' : '') + '<span class="msgr-chev">' + msgrIc('chev', 24, 3) + '</span></button>';
    target.innerHTML = '<div class="msgr-page"><div class="msgr-head"><div><div class="msgr-title">Cash</div><div class="msgr-g-sub" style="margin-top:4px;">Money for your errands</div></div>' + msgrBellHtml() + '</div>' +
      (msgr.cash.toLiq ? '<div class="msgr-banner">' + msgrIc('liq', 22) + '<span><b>' + msgr.cash.toLiq + ' to close.</b> Send in your receipts for the cash you received.</span></div>' : '') +
      card('cashNew', 'cash', 'Ask for cash', 'Cash advance', 'Need money for an errand? Ask here first.', msgr.cash.pending) +
      card('liq', 'liq', 'Send in your receipts', 'Liquidation', 'Show how you used the cash.', msgr.cash.toLiq) +
      card('reimb', 'refund', 'Money I paid first', 'Reimbursement', 'Paid with your own money? Ask to get it back.', 0) + '</div>';
  }

  // =====================================================================
  // Live updates — so a new errand shows up without anyone tapping anything
  //   1. database real-time (errands assigned to him; migration 20261018_01),
  //   2. refresh when the app comes back to the front or the phone is online again,
  //   3. a quiet refresh about once a minute while Home / Errands / Alerts is open.
  // Only those three list screens ever refresh. A guided errand step, a dialog
  // or the Menu is never redrawn underneath him. If real-time is not set up
  // (or drops) 2 and 3 still keep the screen current.
  // =====================================================================
  const msgrVisible = (el)=> !!el && el.offsetParent !== null;
  function msgrActiveScreen(){
    if(!currentUser || !isMessengerUser()) return null;
    const home = $('staffPanel_home'), al = $('staffPanel_msgrAlerts'), mine = $('erMyBody');
    if(msgrVisible(home) && home.querySelector('.msgr-page')) return 'home';
    if(msgrVisible(al) && al.querySelector('.msgr-page')) return 'alerts';
    if(msgrVisible(mine) && er.mode === 'messenger' && mine.querySelector('[data-msgr-screen="errands"]')) return 'errands';
    return null;
  }
  let msgrBusy = false, msgrDeb = null, msgrLiveWired = false;
  async function msgrRefreshNow(){
    if(msgrBusy || document.hidden || navigator.onLine === false) return;
    const s = msgrActiveScreen(); if(!s) return;
    if(document.querySelector('.overlay.open')) return;   // a dialog (signature box, question) is open
    msgrBusy = true;
    try{
      if(s === 'home') await msgrRenderHome($('staffPanel_home'), true);
      else if(s === 'alerts') await msgrShowAlerts(true);
      else await erShowMine(true);
    }catch(e){}
    finally{ msgrBusy = false; }
  }
  function msgrRefreshSoon(){ clearTimeout(msgrDeb); msgrDeb = setTimeout(msgrRefreshNow, 700); }   // a burst of changes -> one refresh
  function msgrLiveStart(){
    if(msgrLiveWired) return;
    msgrLiveWired = true;
    setInterval(msgrRefreshNow, 60000);
    document.addEventListener('visibilitychange', ()=>{ if(!document.hidden) msgrRefreshSoon(); });
    window.addEventListener('online', msgrRefreshSoon);
    window.addEventListener('pageshow', msgrRefreshSoon);
  }
  let msgrRt = null, msgrRtUid = null, msgrRtTries = 0;
  function msgrRealtimeStart(){
    if(!currentUser || !isMessengerUser() || typeof db === 'undefined' || !db || !db.channel) return;
    if(msgrRt && msgrRtUid === currentUser.id) return;
    msgrRealtimeTeardown();
    msgrRtUid = currentUser.id;
    try{
      const ch = db.channel('errands-me-' + currentUser.id);
      msgrRt = ch;
      ch.on('postgres_changes', { event:'*', schema:'public', table:'errands', filter:'assigned_to=eq.' + currentUser.id }, msgrRefreshSoon)
        .subscribe((status)=>{
          if(msgrRt !== ch) return;   // torn down on purpose (sign out)
          if(status === 'SUBSCRIBED'){ msgrRtTries = 0; return; }
          if(status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED'){
            // dropped (network change, sleep) or not enabled yet: retry with a growing pause; the 1-minute refresh covers the gap
            msgrRt = null; msgrRtUid = null;
            try{ db.removeChannel(ch); }catch(_){}
            const wait = Math.min(300000, 5000 * Math.pow(2, msgrRtTries++));
            setTimeout(()=>{ if(currentUser && isMessengerUser()) msgrRealtimeStart(); }, wait);
          }
        });
    }catch(e){ msgrRt = null; msgrRtUid = null; }
  }
  function msgrRealtimeTeardown(){
    const old = msgrRt; msgrRt = null; msgrRtUid = null; msgrRtTries = 0;
    if(old){ try{ db.removeChannel(old); }catch(_){} }
  }
