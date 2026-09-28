  // =====================================================================
  // In-app guide — ENGINE (content lives in guide-content.js)
  //
  //   * works out which page is on screen (for every kind of user)
  //   * "About this page" card at the top of it, with a "Where this fits"
  //     flow strip; × closes it for that page, ? in the header brings it back
  //   * Help & Guide: every page this person can open, searchable
  //   * first-run tour per role, and a getting-started checklist on home
  //   * English / Tagalog toggle everywhere
  //   * progress saved per person (user_guide_progress, 20260929_01), with
  //     this device as the fallback
  // =====================================================================

  const GD_UI = {
    about:   { en:'About this page', tl:'Tungkol sa page na ito' },
    steps:   { en:'How to use it', tl:'Paano gamitin' },
    tip:     { en:'Tip', tl:'Tip' },
    fits:    { en:'Where this fits', tl:'Saan ito kabilang' },
    allHelp: { en:'All pages & help', tl:'Lahat ng page at tulong' },
    help:    { en:'Help & Guide', tl:'Tulong at Gabay' },
    search:  { en:'Search pages…', tl:'Maghanap ng page…' },
    replay:  { en:'Replay the tour', tl:'Ulitin ang tour' },
    resetTips:{ en:'Show all page tips again', tl:'Ipakita ulit ang lahat ng tip' },
    open:    { en:'Open this page', tl:'Buksan ang page na ito' },
    next:    { en:'Next', tl:'Susunod' },
    back:    { en:'Back', tl:'Bumalik' },
    done:    { en:'Done', tl:'Tapos' },
    skip:    { en:'Skip', tl:'Laktawan' },
    start:   { en:'Getting started', tl:'Pagsisimula' },
    hide:    { en:'Hide', tl:'Itago' },
    none:    { en:'No pages match.', tl:'Walang tugmang page.' },
    langNote:{ en:'Page names stay in English so they match the screen.', tl:'Nananatiling English ang pangalan ng page para tugma sa screen.' }
  };
  const GD_GROUPS = [
    ['home.', { en:'Home', tl:'Home' }], ['staff.home', { en:'Home', tl:'Home' }],
    ['staff.inbox', { en:'Inbox', tl:'Inbox' }],
    ['dispatch', { en:'Operations', tl:'Operations' }], ['sreq', { en:'Operations', tl:'Operations' }], ['sr.', { en:'Operations', tl:'Operations' }],
    ['srm', { en:'Operations', tl:'Operations' }], ['messages', { en:'Operations', tl:'Operations' }], ['documents', { en:'Operations', tl:'Operations' }],
    ['staff.tracker', { en:'Operations', tl:'Operations' }], ['p.projects', { en:'Operations', tl:'Operations' }],
    ['p.tl', { en:'Tools & Equipment', tl:'Tools & Equipment' }], ['p.myTools', { en:'Tools & Equipment', tl:'Tools & Equipment' }],
    ['p.materials', { en:'Purchasing', tl:'Purchasing' }], ['p.suppliers', { en:'Purchasing', tl:'Purchasing' }], ['p.requisitions', { en:'Purchasing', tl:'Purchasing' }],
    ['p.myRequests', { en:'Purchasing', tl:'Purchasing' }], ['p.purchaseOrders', { en:'Purchasing', tl:'Purchasing' }],
    ['p.', { en:'Inventory', tl:'Inventory' }],
    ['ca.', { en:'Accounting & Finance', tl:'Accounting & Finance' }], ['financeHr', { en:'Accounting & Finance', tl:'Accounting & Finance' }],
    ['dtr.', { en:'Human Resources', tl:'Human Resources' }], ['leave.', { en:'Human Resources', tl:'Human Resources' }],
    ['customers', { en:'Administration', tl:'Administration' }], ['custHistory', { en:'Administration', tl:'Administration' }],
    ['equipment', { en:'Administration', tl:'Administration' }], ['ann', { en:'Administration', tl:'Administration' }],
    ['dropdowns', { en:'Administration', tl:'Administration' }], ['users', { en:'Administration', tl:'Administration' }],
    ['staff.', { en:'Department Staff', tl:'Department Staff' }], ['cp.', { en:'Customer Portal', tl:'Customer Portal' }]
  ];

  const GD = { lang:'en', uid:null, prog:null, key:null, force:{}, saveT:null, obsT:null, tour:null, loading:false, checkAt:0 };

  function gdL(o){ return o ? (o[GD.lang] != null ? o[GD.lang] : o.en) : ''; }
  function gdRole(){
    if(!currentUser) return null;
    if(currentUser.role === 'admin') return 'admin';
    if(currentUser.role === 'staff') return 'staff';
    if(currentUser.role === 'customer') return 'customer';
    return 'tech';
  }
  function gdShown(el){ return !!(el && el.getClientRects().length); }
  function gdEl(id){ return document.getElementById(id); }
  function gdTitle(key){ const e = GUIDE_PAGES[key]; return e ? e.en.t : key; }   // page names stay English

  // ---------------------------------------------------------------------
  // Progress
  // ---------------------------------------------------------------------
  function gdBlank(){ return { lang:null, closed:{}, seen:{}, tours:{}, done:{}, hidden:{} }; }
  async function gdLoad(uid){
    GD.loading = true;
    let p = null;
    try{ p = JSON.parse(localStorage.getItem('awes-guide:' + uid) || 'null'); }catch(e){}
    try{
      if(typeof ensureCloud === 'function' && await ensureCloud()){
        const { data, error } = await db.from('user_guide_progress').select('data').eq('user_id', uid).maybeSingle();
        if(!error && data && data.data) p = data.data;
      }
    }catch(e){}
    GD.prog = Object.assign(gdBlank(), p || {});
    GD.lang = GD.prog.lang || localStorage.getItem('awes-guide-lang') || 'en';
    GD.loading = false;
  }
  function gdSave(){
    if(!GD.uid || !GD.prog) return;
    try{ localStorage.setItem('awes-guide:' + GD.uid, JSON.stringify(GD.prog)); }catch(e){}
    clearTimeout(GD.saveT);
    GD.saveT = setTimeout(async ()=>{
      try{
        if(typeof ensureCloud === 'function' && await ensureCloud())
          await db.from('user_guide_progress').upsert({ user_id: GD.uid, data: GD.prog, updated_at: new Date().toISOString() });
      }catch(e){}
    }, 1200);
  }
  function gdSetLang(l){
    GD.lang = l === 'tl' ? 'tl' : 'en';
    try{ localStorage.setItem('awes-guide-lang', GD.lang); }catch(e){}
    if(GD.prog){ GD.prog.lang = GD.lang; gdSave(); }
    gdRender(true);
    if(gdEl('gdHelp') && gdEl('gdHelp').classList.contains('open')) gdRenderHelp();
    GD.checkAt = 0; gdRenderChecklist();
    if(GD.tour) gdTourStep(GD.tour.i);
  }

  // ---------------------------------------------------------------------
  // Which page is on screen
  // ---------------------------------------------------------------------
  function gdDetect(){
    const role = gdRole();
    if(!role) return null;
    const hit = (key, host)=> ({ key, host });
    // overlays that are pages of their own
    const ov = [['techProfileOverlay', 'techProfile'], ['poSettingsOverlay', 'poSettings'], ['settingsOverlay', 'settings'],
                ['announcementsAdminOverlay', 'ann'], ['adminOverlay', 'dropdowns'], ['usersOverlay', 'users']];
    for(const [id, key] of ov){
      const o = gdEl(id);
      if(o && o.classList.contains('open')) return hit(key, o.querySelector('.sheet-body, .modal-body, .sheet-content') || o.firstElementChild);
    }
    const sv = gdEl('staffView');
    if(gdShown(sv)){
      const p = [...sv.querySelectorAll('.stf-panel')].find(gdShown);
      const map = { staffPanel_home:'staff.home', staffPanel_team:'staff.team', staffPanel_edit:'staff.edit', staffPanel_templates:'staff.templates',
                    staffPanel_activity:'staff.activity', staffPanel_inbox:'staff.inbox', staffPanel_tracker:'staff.tracker',
                    staffPanel_preview:'staff.preview' };
      return p && map[p.id] ? hit(map[p.id], p) : null;
    }
    for(const el of document.querySelectorAll('.cp-screen')){
      if(gdShown(el)){
        const k = el.id.replace(/^customer/, '').replace(/Screen$/, '');
        return hit('cp.' + k.charAt(0).toLowerCase() + k.slice(1), el);
      }
    }
    const pv = gdEl('purchasingView');
    if(gdShown(pv)){
      const p = [...pv.querySelectorAll('[id^="purchPanel_"]')].find(gdShown);
      return p ? hit('p.' + p.id.slice('purchPanel_'.length), p) : null;
    }
    const pair = (viewId, officeId, officeKey, mineId, mineKey)=>{
      const v = gdEl(viewId); if(!gdShown(v)) return null;
      if(gdShown(gdEl(officeId))) return hit(officeKey, gdEl(officeId));
      return hit(mineKey, gdShown(gdEl(mineId)) ? gdEl(mineId) : v);
    };
    let r;
    if((r = pair('dispatchView', 'dispatchAdminArea', 'dispatch.office', 'dispatchTechArea', 'dispatch.tech'))) return r;
    if((r = pair('leaveView', 'leaveAdminArea', 'leave.office', 'leaveTechArea', 'leave.mine'))) return r;
    if((r = pair('cashAdvanceView', 'caAdminArea', 'ca.office', 'caTechArea', 'ca.mine'))) return r;
    const dv = gdEl('dtrView');
    if(gdShown(dv)) return hit(gdShown(gdEl('dtrAdminTableCard')) ? 'dtr.office' : 'dtr.tech', dv);
    const srv = gdEl('serviceReportView');
    if(gdShown(srv)){
      if(gdShown(gdEl('srBackEntryPanel'))) return hit('sr.backentry', gdEl('srBackEntryPanel'));
      if(gdShown(gdEl('srHistoryPanel')) && role === 'tech') return hit('sr.history', gdEl('srHistoryPanel'));
      if(gdShown(gdEl('srNewPanel')) && role === 'tech') return hit('sr.new', gdEl('srNewPanel'));
      return null;
    }
    const simple = { serviceRequestsView:'sreq', serviceReportsManagerView:'srm', customersManagerView:'customers', customerHistoryView:'custHistory',
                     equipmentManagerView:'equipment', messagesView:'messages', documentsView:'documents', financeHrView:'financeHr' };
    for(const id in simple) if(gdShown(gdEl(id))) return hit(simple[id], gdEl(id));
    const hs = gdEl('homeScreen');
    if(gdShown(hs)){
      if(role === 'admin') return hit('home.admin', hs);
      if(role === 'tech') return hit('home.tech', hs);
    }
    return null;
  }

  // ---------------------------------------------------------------------
  // Opening a page from the guide (flow strip, Help, checklist)
  // ---------------------------------------------------------------------
  function gdGoValue(key){
    const e = GUIDE_PAGES[key], role = gdRole();
    if(!e || !role || !(e.roles || []).includes(role)) return null;
    const g = (e.go || {})[role];
    if(!g) return null;
    if(role === 'staff' && /^[a-z]+\.[a-z_]+$/.test(g)){
      if(!(typeof STAFF_READY_MODULES !== 'undefined' && STAFF_READY_MODULES.includes(g) && can(g, 'view'))) return null;
    }
    if(role === 'staff' && e.module && !can(e.module, 'view')) return null;
    if(g === '@team' && !(staffIsHead && staffIsHead())) return null;
    return g;
  }
  function gdCanOpen(key){ return !!gdGoValue(key); }
  function gdGo(key){
    const g = gdGoValue(key);
    if(!g) return false;
    gdCloseHelp();
    if(/^[a-z]+\.[a-z_]+$/.test(g)){ staffOpenModule(g); return true; }
    if(g.startsWith('@purch:')){ showPurchasingView(g.slice(7)); return true; }
    const fn = { '@home': ()=> showHome(), '@team': ()=> staffOpenTeam(), '@activity': ()=> staffOpenActivity(),
                 '@inbox': ()=> staffOpenInbox(), '@myleave': ()=> showLeaveView(true),
                 '@mydtr': ()=> showDtrView(true), '@mycash': ()=> showCashAdvanceView(true, 'new'),
                 '@fn:leave': ()=> showLeaveView(), '@fn:cpHistory': ()=> cpShowScreen('History') }[g];
    if(fn){ fn(); return true; }
    const el = gdEl(g);
    if(el){ el.click(); return true; }
    return false;
  }

  // ---------------------------------------------------------------------
  // "About this page" card
  // ---------------------------------------------------------------------
  function gdLangSwitch(){
    return '<span class="gd-lang" role="group" aria-label="Language">' +
      '<button type="button" data-gd-lang="en" class="' + (GD.lang === 'en' ? 'on' : '') + '">EN</button>' +
      '<button type="button" data-gd-lang="tl" class="' + (GD.lang === 'tl' ? 'on' : '') + '">TL</button></span>';
  }
  function gdFlowHtml(key){
    const e = GUIDE_PAGES[key];
    const steps = e && e.flow ? GUIDE_FLOWS[e.flow] : null;
    if(!steps) return '';
    return '<div class="gd-flow"><div class="gd-flow-label">' + escapeHtml(gdL(GD_UI.fits)) + '</div><div class="gd-flow-steps">' +
      steps.map((st, i)=>{
        const arrow = i ? '<span class="gd-arrow" aria-hidden="true">\u203A</span>' : '';
        if(typeof st !== 'string') return arrow + '<span class="gd-step gd-stage">' + escapeHtml(gdL(st)) + '</span>';
        const cur = st === key, ok = !cur && gdCanOpen(st);
        return arrow + '<button type="button" class="gd-step' + (cur ? ' cur' : '') + (!cur && !ok ? ' off' : '') + '"' + (ok ? ' data-gd-go="' + st + '"' : ' disabled') + '>' +
          escapeHtml(gdTitle(st)) + '</button>';
      }).join('') + '</div></div>';
  }
  function gdCardHtml(key){
    const e = GUIDE_PAGES[key], t = e[GD.lang] || e.en;
    const steps = (t.s && t.s.length) ? t.s : e.en.s;
    return '<div class="gd-head"><span class="gd-i">?</span><span class="gd-about">' + escapeHtml(gdL(GD_UI.about)) + '</span>' +
        gdLangSwitch() + '<button type="button" class="gd-x" data-gd-close aria-label="Close">\u00D7</button></div>' +
      '<div class="gd-title">' + escapeHtml(e.en.t) + '</div>' +
      '<p class="gd-p">' + escapeHtml(t.p || e.en.p) + '</p>' +
      (steps && steps.length ? '<ol class="gd-steps">' + steps.map(x=> '<li>' + escapeHtml(x) + '</li>').join('') + '</ol>' : '') +
      ((t.tip || e.en.tip) ? '<div class="gd-tip"><b>' + escapeHtml(gdL(GD_UI.tip)) + ':</b> ' + escapeHtml(t.tip || e.en.tip) + '</div>' : '') +
      gdFlowHtml(key) +
      '<div class="gd-foot"><button type="button" class="gd-link" data-gd-help>' + escapeHtml(gdL(GD_UI.allHelp)) + ' \u203A</button></div>';
  }
  function gdCard(){
    let c = gdEl('gdCard');
    if(!c){
      c = document.createElement('div');
      c.id = 'gdCard'; c.className = 'gd-card';
      c.addEventListener('click', (ev)=>{
        const t = ev.target.closest('[data-gd-lang],[data-gd-close],[data-gd-go],[data-gd-help]');
        if(!t) return;
        if(t.dataset.gdLang) return gdSetLang(t.dataset.gdLang);
        if(t.hasAttribute('data-gd-close')){ if(GD.key && GD.prog){ GD.prog.closed[GD.key] = true; delete GD.force[GD.key]; gdSave(); } return gdRender(true); }
        if(t.dataset.gdGo) return gdGo(t.dataset.gdGo);
        if(t.hasAttribute('data-gd-help')) return gdOpenHelp();
      });
    }
    return c;
  }

  // Put guide blocks at the top of a page — but after a page's own header
  // (the customer portal screens start with their brand / title bar).
  function gdInsertTop(host, el){
    const first = host.firstElementChild;
    const after = first && first !== el && first.matches('.cp-header, .cp-tools-head, .cp-profile-head, .sheet-head') ? first : null;
    const ref = after ? after.nextSibling : host.firstChild;
    if(el.parentNode === host && (el === ref || el.previousSibling === after || (!after && el === host.firstChild))) return;
    host.insertBefore(el, ref);
  }
  function gdRender(forceRedraw){
    const card = gdCard();
    const btn = gdEl('gdHelpBtn');
    // only write when it changes — every style write wakes the observer
    const want = currentUser && GD.prog ? '' : 'none';
    if(btn && btn.style.display !== want) btn.style.display = want;
    const fab = gdEl('gdHelpFab');
    if(fab){
      const headerOn = !!(btn && want === '' && btn.getBoundingClientRect().width > 0);
      const fwant = want === '' && !headerOn && !(GD.tour) ? '' : 'none';
      if(fab.style.display !== fwant) fab.style.display = fwant;
    }
    if(!currentUser || !GD.prog){ card.remove(); GD.key = null; return; }
    const d = gdDetect();
    const key = d && GUIDE_PAGES[d.key] && (GUIDE_PAGES[d.key].roles || []).includes(gdRole()) ? d.key : null;
    if(key !== GD.key){
      GD.key = key;
      if(key && !GD.prog.seen[key]){ GD.prog.seen[key] = true; gdSave(); GD.checkAt = 0; }
      forceRedraw = true;
    }
    const on = !!(key && (GD.force[key] || !GD.prog.closed[key]));
    if(btn && btn.classList.contains('on') !== on) btn.classList.toggle('on', on);
    if(fab && fab.classList.contains('on') !== on) fab.classList.toggle('on', on);
    if(!key || (GD.prog.closed[key] && !GD.force[key]) || !d.host){ card.remove(); return; }
    if(forceRedraw || card.dataset.key !== key || card.dataset.lang !== GD.lang){
      card.innerHTML = gdCardHtml(key);
      card.dataset.key = key; card.dataset.lang = GD.lang;
    }
    if(card.parentNode !== d.host) gdInsertTop(d.host, card);
  }

  // ---------------------------------------------------------------------
  // Help & Guide
  // ---------------------------------------------------------------------
  function gdGroupOf(key){ for(const [pre, g] of GD_GROUPS) if(key === pre || key.startsWith(pre)) return g; return { en:'Other', tl:'Iba pa' }; }
  function gdHelpPages(){
    const role = gdRole();
    return Object.keys(GUIDE_PAGES).filter(k=>{
      const e = GUIDE_PAGES[k];
      if(!(e.roles || []).includes(role)) return false;
      if(role === 'staff' && e.module && !can(e.module, 'view')) return false;
      if(role === 'staff' && k === 'staff.team' && !(staffIsHead && staffIsHead())) return false;
      return true;
    });
  }
  function gdOpenHelp(){
    let h = gdEl('gdHelp');
    if(!h){
      h = document.createElement('div');
      h.id = 'gdHelp'; h.className = 'gd-help';
      h.innerHTML = '<div class="gd-help-sheet" role="dialog" aria-modal="true"><div class="gd-help-head"></div><div class="gd-help-body"></div></div>';
      document.body.appendChild(h);
      h.addEventListener('click', (ev)=>{
        if(ev.target === h) return gdCloseHelp();
        const t = ev.target.closest('[data-gd-lang],[data-gd-go],[data-gd-x],[data-gd-replay],[data-gd-reset]');
        if(!t) return;
        if(t.dataset.gdLang) return gdSetLang(t.dataset.gdLang);
        if(t.dataset.gdGo) return gdGo(t.dataset.gdGo);
        if(t.hasAttribute('data-gd-x')) return gdCloseHelp();
        if(t.hasAttribute('data-gd-replay')){ gdCloseHelp(); return gdStartTour(true); }
        if(t.hasAttribute('data-gd-reset')){ GD.prog.closed = {}; GD.force = {}; gdSave(); gdCloseHelp(); gdRender(true); toast(GD.lang === 'tl' ? 'Ipinapakita ulit ang mga tip' : 'Page tips will show again'); }
      });
      h.addEventListener('input', (ev)=>{ if(ev.target.matches('[data-gd-search]')) gdRenderHelpList(ev.target.value); });
    }
    gdRenderHelp();
    h.classList.add('open');
    setTimeout(()=>{ const s = h.querySelector('[data-gd-search]'); if(s && window.innerWidth > 700) s.focus(); }, 60);
  }
  function gdCloseHelp(){ const h = gdEl('gdHelp'); if(h) h.classList.remove('open'); }
  function gdRenderHelp(){
    const h = gdEl('gdHelp'); if(!h) return;
    const q = (h.querySelector('[data-gd-search]') || {}).value || '';
    h.querySelector('.gd-help-head').innerHTML =
      '<div class="gd-help-title">' + escapeHtml(gdL(GD_UI.help)) + '</div>' + gdLangSwitch() +
      '<button type="button" class="gd-x" data-gd-x aria-label="Close">\u00D7</button>';
    h.querySelector('.gd-help-body').innerHTML =
      '<input type="search" class="gd-search" data-gd-search placeholder="' + escapeHtml(gdL(GD_UI.search)) + '" value="' + escapeHtml(q) + '">' +
      '<div class="gd-help-actions"><button type="button" class="btn btn-secondary" data-gd-replay>' + escapeHtml(gdL(GD_UI.replay)) + '</button>' +
      '<button type="button" class="btn btn-secondary" data-gd-reset>' + escapeHtml(gdL(GD_UI.resetTips)) + '</button></div>' +
      '<p class="gd-note">' + escapeHtml(gdL(GD_UI.langNote)) + '</p><div class="gd-help-list"></div>';
    gdRenderHelpList(q);
  }
  function gdRenderHelpList(q){
    const h = gdEl('gdHelp'); if(!h) return;
    const list = h.querySelector('.gd-help-list');
    q = String(q || '').trim().toLowerCase();
    const keys = gdHelpPages().filter(k=>{
      if(!q) return true;
      const e = GUIDE_PAGES[k];
      return [e.en.t, e.en.p, e.tl.p, (e.en.s || []).join(' '), (e.tl.s || []).join(' ')].join(' ').toLowerCase().includes(q);
    });
    if(!keys.length){ list.innerHTML = '<div class="empty-state">' + escapeHtml(gdL(GD_UI.none)) + '</div>'; return; }
    let html = '', lastGroup = '';
    keys.forEach(k=>{
      const e = GUIDE_PAGES[k], t = e[GD.lang] || e.en, g = gdL(gdGroupOf(k));
      if(g !== lastGroup){ html += '<div class="gd-group">' + escapeHtml(g) + '</div>'; lastGroup = g; }
      html += '<details class="gd-item"' + (k === GD.key ? ' open' : '') + '><summary><b>' + escapeHtml(e.en.t) + '</b><span>' + escapeHtml(t.p || e.en.p) + '</span></summary>' +
        ((t.s || []).length ? '<ol class="gd-steps">' + t.s.map(x=> '<li>' + escapeHtml(x) + '</li>').join('') + '</ol>' : '') +
        (t.tip ? '<div class="gd-tip"><b>' + escapeHtml(gdL(GD_UI.tip)) + ':</b> ' + escapeHtml(t.tip) + '</div>' : '') +
        gdFlowHtml(k) +
        (gdCanOpen(k) && k !== GD.key ? '<button type="button" class="btn btn-primary gd-open" data-gd-go="' + k + '">' + escapeHtml(gdL(GD_UI.open)) + '</button>' : '') +
      '</details>';
    });
    list.innerHTML = html;
  }

  // ---------------------------------------------------------------------
  // First-run tour
  // ---------------------------------------------------------------------
  function gdStartTour(manual){
    const role = gdRole();
    // steps without a target (sel: null) are centred messages
    const steps = (GUIDE_TOURS[role] || []).filter(s=> !s.sel || gdShown(document.querySelector(s.sel)));
    if(!steps.length) return;
    if(!manual && GD.prog.tours[role]) return;
    GD.tour = { role, steps, i:0 };
    let o = gdEl('gdTour');
    if(!o){
      o = document.createElement('div');
      o.id = 'gdTour'; o.className = 'gd-tour';
      o.innerHTML = '<div class="gd-spot"></div><div class="gd-bubble" role="dialog" aria-live="polite"></div>';
      document.body.appendChild(o);
      o.addEventListener('click', (ev)=>{
        const t = ev.target.closest('[data-gd-t],[data-gd-lang]');
        if(!t) return;
        if(t.dataset.gdLang) return gdSetLang(t.dataset.gdLang);
        const a = t.dataset.gdT;
        if(a === 'next') gdTourStep(GD.tour.i + 1);
        else if(a === 'back') gdTourStep(GD.tour.i - 1);
        else gdEndTour();
      });
      window.addEventListener('resize', ()=>{ if(GD.tour) gdTourStep(GD.tour.i); });
    }
    o.classList.add('open');
    gdTourStep(0);
  }
  function gdTourStep(i){
    const T = GD.tour; if(!T) return;
    if(i >= T.steps.length) return gdEndTour();
    T.i = Math.max(0, i);
    const s = T.steps[T.i], el = s.sel ? document.querySelector(s.sel) : null;
    const o = gdEl('gdTour'), spot = o.querySelector('.gd-spot'), b = o.querySelector('.gd-bubble');
    if(s.sel && !gdShown(el)){ return gdTourStep(T.i + 1); }
    const pad = 6;
    // no target: a zero-size spot in the middle just dims the screen
    const r = el ? el.getBoundingClientRect() : { left: window.innerWidth / 2, top: window.innerHeight / 2 - 90, right: window.innerWidth / 2, bottom: window.innerHeight / 2 - 90, width: 0, height: 0 };
    Object.assign(spot.style, el ? { left:(r.left - pad) + 'px', top:(r.top - pad) + 'px', width:(r.width + pad*2) + 'px', height:(r.height + pad*2) + 'px', borderColor:'#fff' }
                                 : { left:r.left + 'px', top:r.top + 'px', width:'0px', height:'0px', borderColor:'transparent' });
    const last = T.i === T.steps.length - 1;
    b.innerHTML = '<div class="gd-bubble-head"><span class="gd-count">' + (T.i + 1) + ' / ' + T.steps.length + '</span>' + gdLangSwitch() + '</div>' +
      '<p>' + escapeHtml(gdL(s)) + '</p><div class="gd-bubble-btns">' +
      '<button type="button" class="gd-link" data-gd-t="skip">' + escapeHtml(gdL(GD_UI.skip)) + '</button>' +
      (T.i ? '<button type="button" class="btn btn-secondary" data-gd-t="back">' + escapeHtml(gdL(GD_UI.back)) + '</button>' : '') +
      '<button type="button" class="btn btn-primary" data-gd-t="next">' + escapeHtml(gdL(last ? GD_UI.done : GD_UI.next)) + '</button></div>';
    // bubble below the target, or above it when there's no room
    const bw = Math.min(320, window.innerWidth - 24);
    b.style.width = bw + 'px';
    b.style.left = (el ? Math.max(12, Math.min(r.left, window.innerWidth - bw - 12)) : Math.round((window.innerWidth - bw) / 2)) + 'px';
    const below = r.bottom + 12, h = b.offsetHeight || 150;
    b.style.top = (below + h < window.innerHeight - 8 ? below : Math.max(12, r.top - h - 12)) + 'px';
  }
  function gdEndTour(){
    const o = gdEl('gdTour'); if(o) o.classList.remove('open');
    if(GD.tour && GD.prog){ GD.prog.tours[GD.tour.role] = true; gdSave(); }
    GD.tour = null;
  }

  // ---------------------------------------------------------------------
  // Getting-started checklist (on each role's home)
  // ---------------------------------------------------------------------
  const GD_CHECKS = {
    hasStaff: async ()=> { const r = await db.from('profiles').select('id', { count:'exact', head:true }).eq('role', 'staff'); return (r.count || 0) > 0; },
    hasSignatoryLink: async ()=> { const r = await db.from('po_signatories').select('id', { count:'exact', head:true }).not('user_id', 'is', null); return !r.error && (r.count || 0) > 0; },
    hasTech: async ()=> { const r = await db.from('profiles').select('id', { count:'exact', head:true }).eq('role', 'technician'); return (r.count || 0) > 0; },
    hasCustomer: async ()=> { const r = await db.from('customers').select('id', { count:'exact', head:true }); return (r.count || 0) > 0; },
    passwordChanged: async ()=> !(currentUser && currentUser.mustChangePassword),
    openedAPage: async ()=> Object.keys(GD.prog.seen || {}).some(k=> !['staff.home', 'staff.inbox', 'leave.mine'].includes(k)),
    pushOn: async ()=> typeof Notification !== 'undefined' && Notification.permission === 'granted'
  };
  function gdChecklistHost(role){
    if(role === 'admin') return gdEl('adminDash') || gdEl('homeScreen');
    if(role === 'staff') return gdEl('staffPanel_home');
    if(role === 'tech') return gdEl('homeScreen');
    if(role === 'customer') return gdEl('customerHomeScreen');
    return null;
  }
  let gdCheckBusy = false;
  // throttled: at most every 30 s, or right after something relevant (checkAt = 0)
  async function gdRenderChecklist(){
    if(GD.checkAt && Date.now() - GD.checkAt < 30000 && gdEl('gdChecklist') && gdEl('gdChecklist').parentNode === gdChecklistHost(gdRole())) return;
    GD.checkAt = Date.now();
    const role = gdRole();
    const old = gdEl('gdChecklist');
    if(!role || !GD.prog || GD.prog.hidden[role]){ if(old) old.remove(); return; }
    const host = gdChecklistHost(role);
    if(!host || !gdShown(host)){ return; }
    if(gdCheckBusy) return;
    gdCheckBusy = true;
    const items = GUIDE_CHECKLISTS[role] || [];
    const done = [];
    for(const it of items){
      let ok = !!(GD.prog.done[it.id] || (it.page && !it.check && GD.prog.seen[it.page]));
      if(!ok && it.check && GD_CHECKS[it.check]){ try{ ok = await GD_CHECKS[it.check](); }catch(e){ ok = false; } }
      if(ok && !GD.prog.done[it.id]){ GD.prog.done[it.id] = true; gdSave(); }
      done.push(ok);
    }
    gdCheckBusy = false;
    const n = done.filter(Boolean).length;
    if(n === items.length){ const c = gdEl('gdChecklist'); if(c) c.remove(); return; }
    let c = gdEl('gdChecklist');
    if(!c){
      c = document.createElement('div');
      c.id = 'gdChecklist'; c.className = 'card gd-check';
      c.addEventListener('click', (ev)=>{
        const t = ev.target.closest('[data-gd-go],[data-gd-hide],[data-gd-lang]');
        if(!t) return;
        if(t.dataset.gdLang) return gdSetLang(t.dataset.gdLang);
        if(t.hasAttribute('data-gd-hide')){ GD.prog.hidden[gdRole()] = true; gdSave(); return c.remove(); }
        if(t.dataset.gdGo) gdGo(t.dataset.gdGo);
      });
    }
    c.innerHTML = '<div class="card-body"><div class="gd-check-head"><b>' + escapeHtml(gdL(GD_UI.start)) + '</b><span class="gd-check-n">' + n + ' / ' + items.length + '</span>' +
      gdLangSwitch() + '<button type="button" class="gd-link" data-gd-hide>' + escapeHtml(gdL(GD_UI.hide)) + '</button></div>' +
      '<div class="gd-bar"><span style="width:' + Math.round(n / items.length * 100) + '%"></span></div>' +
      items.map((it, i)=>{
        const go = it.page && gdCanOpen(it.page) && !done[i];
        return '<' + (go ? 'button type="button" data-gd-go="' + it.page + '"' : 'div') + ' class="gd-check-row' + (done[i] ? ' done' : '') + '">' +
          '<span class="gd-tick">' + (done[i] ? '\u2713' : '') + '</span><span>' + escapeHtml(gdL(it)) + '</span>' + (go ? '<span class="gd-chev">\u203A</span>' : '') +
          '</' + (go ? 'button' : 'div') + '>';
      }).join('') + '</div>';
    if(c.parentNode !== host) gdInsertTop(host, c);
  }

  // ---------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------
  // ? : show / hide this page's card (or open Help when the page has none)
  function gdHelpClick(){
    if(!GD.key){ gdOpenHelp(); return; }
    const shown = !!(gdEl('gdCard') && gdEl('gdCard').parentNode);
    if(shown){ GD.prog.closed[GD.key] = true; delete GD.force[GD.key]; gdSave(); }
    else GD.force[GD.key] = true;
    gdRender(true);
    if(!shown) setTimeout(()=>{ const c = gdEl('gdCard'); if(c) c.scrollIntoView({ behavior:'smooth', block:'start' }); }, 40);
  }
  function gdAddHelpLinks(){
    const mk = (id, cls)=>{
      const b = document.createElement('button');
      b.type = 'button'; b.id = id; b.className = cls;
      b.innerHTML = '<span class="menu-ico"><svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3"/><path d="M12 17h.01"/></svg></span>' + 'Help &amp; Guide';
      b.addEventListener('click', ()=>{ if(typeof closeMainMenu === 'function') closeMainMenu(); gdOpenHelp(); });
      return b;
    };
    [['menuChangePin', 'menuGuide'], ['staffNavPassword', 'staffNavGuide'], ['techNavSettings', 'techNavGuide']].forEach(([after, id])=>{
      const a = gdEl(after);
      if(a && !gdEl(id)) a.parentNode.insertBefore(mk(id, a.className), a.nextSibling);
    });
    const prof = gdEl('customerProfileScreen');
    if(prof && !gdEl('cpGuideBtn')){
      const b = document.createElement('button');
      b.type = 'button'; b.id = 'cpGuideBtn'; b.className = 'btn btn-secondary gd-cp-help';
      b.textContent = 'Help & Guide';
      b.addEventListener('click', gdOpenHelp);
      gdInsertTop(prof, b);
    }
  }

  (function gdWire(){
    const actions = document.querySelector('.app-top .top-actions');
    if(actions && !gdEl('gdHelpBtn')){
      const b = document.createElement('button');
      b.className = 'icon-btn gd-help-btn'; b.id = 'gdHelpBtn'; b.type = 'button';
      b.setAttribute('aria-label', 'About this page'); b.textContent = '?'; b.style.display = 'none';
      b.addEventListener('click', gdHelpClick);
      actions.insertBefore(b, actions.firstChild);
    }
    // The header is hidden on wide screens (sidebar layout) and in the
    // customer portal — there, the same ? floats in the corner instead.
    if(!gdEl('gdHelpFab')){
      const f = document.createElement('button');
      f.type = 'button'; f.id = 'gdHelpFab'; f.className = 'gd-help-fab'; f.textContent = '?';
      f.setAttribute('aria-label', 'About this page'); f.style.display = 'none';
      f.addEventListener('click', gdHelpClick);
      document.body.appendChild(f);
    }
    gdAddHelpLinks();

    // Follow sign-in / sign-out and every screen change
    const tick = async ()=>{
      const uid = currentUser ? currentUser.id : null;
      if(uid !== GD.uid){
        GD.uid = uid; GD.prog = null; GD.key = null; GD.force = {}; GD.checkAt = 0;
        if(GD.tour) gdEndTour();
        gdCloseHelp();
        const old = gdEl('gdChecklist'); if(old) old.remove();
        if(uid){ await gdLoad(uid); if(GD.uid !== uid) return; }
        gdRender(true);
        if(uid) setTimeout(()=>{ if(GD.uid === uid && GD.prog && !GD.prog.tours[gdRole()]) gdStartTour(false); }, 1800);
      }else gdRender(false);
      if(GD.key && /^(home\.|staff\.home|cp\.home)/.test(GD.key)) gdRenderChecklist();
    };
    const obs = new MutationObserver(()=>{ clearTimeout(GD.obsT); GD.obsT = setTimeout(tick, 150); });
    obs.observe(document.body, { attributes:true, subtree:true, attributeFilter:['style', 'class'] });
    setTimeout(tick, 400);
  })();
