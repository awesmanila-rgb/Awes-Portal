  // =====================================================================
  // Department staff (Round 1, Phase 4)
  //
  //   * Office Staff sign-in (username + password) and session restore
  //   * can(module, level) — the one permission check screens use
  //   * Staff home (what I can use, who I report to)
  //   * Department Staff (Super Admin) / My Team (Heads): list, add, edit
  //     access, rename, reset password, deactivate/reactivate, move Head,
  //     preview what a user sees
  //   * Activity Log viewer
  //
  // Server side: supabase/migrations/20260926_01_departments_access.sql and
  // supabase/functions/admin-create-staff. The database is the authority —
  // this screen only mirrors its rules (one level, the ceiling rule) so
  // people aren't offered choices the server will refuse.
  // =====================================================================

  const STAFF_EMAIL_DOMAIN = 'staff.awes-app.local';
  const STAFF_FN = 'admin-create-staff';
  const PERM_RANK = { view:1, edit:2, approve:3 };
  const PERM_LABEL = { view:'View', edit:'Edit', approve:'Approve' };

  // Pages already opened to staff in the database (Phase 3 adds keys here
  // department by department, together with that department's RLS
  // migration). A granted page that isn't listed yet shows as "Opening soon"
  // instead of a link, so nobody lands on a screen that can't load its data.
  const STAFF_READY_MODULES = [
    // Purchasing — 20260926_02_purchasing_staff_access.sql
    'pur.materials', 'pur.suppliers', 'pur.requisitions', 'pur.purchase_orders',
    // Inventory — 20260926_03_inventory_staff_access.sql
    'inv.stock', 'inv.warehouses', 'inv.receive', 'inv.issue', 'inv.returns', 'inv.transfers', 'inv.slips', 'inv.reports',
    // Accounting & Finance — 20260926_04_finance_staff_access.sql
    // ('fin.costs' is a switch, not a page — it just unlocks peso values)
    'fin.cash_advance', 'fin.liquidation', 'fin.reimbursement',
    // Human Resources — 20260926_05_hr_staff_access.sql
    'hr.attendance', 'hr.leaves', 'hr.tech_profiles',
    // Administration — 20260926_06_administration_staff_access.sql
    'adm.customers', 'adm.equipment', 'adm.announcements', 'adm.dropdowns',
    // Operations (part 1) — 20260926_07_operations_staff_access.sql
    'ops.dispatch', 'ops.service_requests', 'ops.service_reports', 'ops.past_service',
    // Operations (part 2) — 20260926_08_operations_tools_staff_access.sql
    'ops.tracker', 'ops.projects',
    'tools.register', 'tools.issue', 'tools.return', 'tools.handover', 'tools.defects', 'tools.maintenance', 'tools.slips', 'tools.reports'
  ];

  function staffEmailFor(username){ return String(username||'').trim().toLowerCase() + '@' + STAFF_EMAIL_DOMAIN; }
  function isStaffUser(){ return !!(currentUser && currentUser.role === 'staff'); }

  // Super Admin: always. Staff: when granted at that level (or higher) and
  // not expired. Everyone else: no. Screens use this to show or hide; the
  // database re-checks every read and write regardless.
  function can(module, level){
    if(!currentUser) return false;
    if(currentUser.role === 'admin') return true;
    if(currentUser.role !== 'staff') return false;
    const g = ((currentUser.access || {}).access || {})[module];
    if(!g) return false;
    if(g.expires_at && new Date(g.expires_at) <= new Date()) return false;
    return (PERM_RANK[g.level] || 0) >= (PERM_RANK[level || 'view'] || 1);
  }
  function staffIsHead(){ return !!(isStaffUser() && currentUser.access && currentUser.access.is_head && !currentUser.access.supervisor); }

  function staffFmtPeso(n){
    return '\u20B1' + Number(n||0).toLocaleString('en-PH', { minimumFractionDigits:0, maximumFractionDigits:2 });
  }
  // Stored as a timestamp; edited as a Manila calendar date (access ends at
  // the end of that day).
  function staffDateOf(ts){
    if(!ts) return '';
    try{ return new Date(ts).toLocaleDateString('en-CA', { timeZone:'Asia/Manila' }); }catch(e){ return ''; }
  }
  function staffEndOfDay(d){ return d ? d + 'T23:59:59+08:00' : null; }
  function staffFmtDate(ts){
    if(!ts) return '';
    try{ return new Date(ts).toLocaleDateString('en-PH', { timeZone:'Asia/Manila', month:'short', day:'numeric', year:'numeric' }); }catch(e){ return ''; }
  }
  function staffFmtDateTime(ts){
    try{ return new Date(ts).toLocaleString('en-PH', { timeZone:'Asia/Manila', month:'short', day:'numeric', hour:'numeric', minute:'2-digit' }); }catch(e){ return ''; }
  }

  // Edge Function call that always resolves to {ok, data|error, code}.
  async function staffInvoke(body){
    if(!(await ensureCloud())) return { ok:false, error:'Not connected to the cloud' };
    try{
      const { data, error } = await db.functions.invoke(STAFF_FN, { body });
      if(error){
        let payload = null;
        try{ payload = error.context && typeof error.context.json === 'function' ? await error.context.json() : null; }catch(e){}
        return { ok:false, error:(payload && payload.error) || error.message || 'Request failed', code: payload && payload.code, payload };
      }
      if(data && data.error) return { ok:false, error:data.error, code:data.code, payload:data };
      return { ok:true, data };
    }catch(e){ return { ok:false, error: (e && e.message) || 'Request failed' }; }
  }

  // ---------------------------------------------------------------------
  // Session
  // ---------------------------------------------------------------------
  // Loads a signed-in staff user's profile and access. Returns
  //   { user }            ready to use
  //   { inactive:true }   deactivated (or their Head is)
  //   { notStaff:true }   signed in, but not a staff account
  //   null                could not be checked right now
  async function staffBuildUser(userId){
    try{
      const [{ data: prof, error: pErr }, { data: access, error: aErr }] = await Promise.all([
        db.from('profiles').select('id, name, role, active, username, position, must_change_password').eq('id', userId).maybeSingle(),
        db.rpc('my_access')
      ]);
      if(pErr || aErr) return null;
      if(!prof) return null;
      if(prof.role !== 'staff') return { notStaff:true };
      if(prof.active === false || (access && access.active === false)) return { inactive:true };
      return { user: {
        id: prof.id, name: prof.name || prof.username || 'Staff', role:'staff',
        username: prof.username || '', position: prof.position || '',
        mustChangePassword: !!prof.must_change_password,
        access: access || {}
      }};
    }catch(e){ return null; }
  }

  function staffCommitSession(user){
    currentUser = user;
    try{ localStorage.setItem('current-user', JSON.stringify(currentUser)); }catch(e){}
    updateUserBadge();
    applyUserRestrictions();
    $('loginOverlay').classList.remove('open');
  }

  // Called by checkLoginGate() in auth.js for a verified staff session.
  async function staffRestoreSession(verified, saved){
    const r = await staffBuildUser(verified.id);
    if(r && r.user){
      staffCommitSession(r.user);
      if(r.user.mustChangePassword) await showChangePasswordScreen(true);
      enterApp();
      return;
    }
    if(r && (r.inactive || r.notStaff)){
      try{ await db.auth.signOut({ scope:'local' }); }catch(e){}
      localStorage.removeItem('current-user');
      currentUser = null;
      await showLoginScreen(r.inactive ? 'Your access was deactivated. Ask your department Head or the admin.' : 'Please sign in again.');
      return;
    }
    // Couldn't load right now (weak signal) — a refresh must never sign
    // anyone out, so fall back to the cached copy when it's the same person.
    if(saved && saved.role === 'staff' && saved.id === verified.id){
      staffCommitSession(saved);
      enterApp();
      return;
    }
    await showLoginScreen('Could not load your account — try again.');
  }

  // Refreshes access mid-session (a Head or the admin may have changed it).
  async function staffRefreshAccess(){
    if(!isStaffUser()) return;
    const r = await staffBuildUser(currentUser.id);
    if(r && r.user){
      currentUser.access = r.user.access;
      currentUser.name = r.user.name;
      currentUser.position = r.user.position;
      try{ localStorage.setItem('current-user', JSON.stringify(currentUser)); }catch(e){}
      staffRenderSidebar();
    }else if(r && r.inactive){
      toast('Your access was deactivated');
    }
  }

  // ---------------------------------------------------------------------
  // Sign-in form (from Staff Access → "Office Staff")
  // ---------------------------------------------------------------------
  function renderStaffLoginForm(message, prefill){
    const container = $('loginList');
    container.innerHTML = '';
    container.appendChild(loginStaffBackButton());
    if(message){
      const m = document.createElement('div');
      m.style.cssText = 'font-size:13px; color:var(--danger); margin-bottom:10px; text-align:center;';
      m.textContent = message;
      container.appendChild(m);
    }
    const heading = document.createElement('div');
    heading.style.cssText = 'font-size:13px; font-weight:700; color:var(--text-muted); margin-bottom:8px; text-align:center;';
    heading.textContent = 'Office Staff sign-in';
    container.appendChild(heading);

    const userField = document.createElement('div');
    userField.className = 'field';
    userField.innerHTML = '<label for="loginStaffUser">Username</label>';
    const userInput = document.createElement('input');
    userInput.type = 'text'; userInput.id = 'loginStaffUser';
    userInput.autocomplete = 'username'; userInput.autocapitalize = 'none'; userInput.spellcheck = false;
    userInput.placeholder = 'Your username';
    userInput.value = prefill || '';
    userField.appendChild(userInput);
    container.appendChild(userField);

    const { field: pwField, input: pwInput } = loginFieldWithIcon({
      label:'Password', id:'loginStaffPw', type:'password', placeholder:'Enter your password',
      iconHtml: LOGIN_ICON_LOCK, toggleable:true
    });
    container.appendChild(pwField);

    const submit = document.createElement('button');
    submit.type = 'button'; submit.className = 'btn btn-primary'; submit.style.width = '100%';
    submit.textContent = 'Sign In';
    const doSubmit = async ()=>{
      const username = (userInput.value||'').trim();
      const pw = pwInput.value;
      if(!username || !pw){ toast('Enter your username and password'); return; }
      if(!(await ensureCloud())){ renderStaffLoginForm('Not connected to the cloud — check Shared Cloud Setup.', username); return; }
      submit.disabled = true;
      const { data, error } = await db.auth.signInWithPassword({ email: staffEmailFor(username), password: pw });
      if(error || !data || !data.user){
        submit.disabled = false;
        renderStaffLoginForm('Incorrect username or password — try again.', username);
        return;
      }
      const r = await staffBuildUser(data.user.id);
      submit.disabled = false;
      if(!r || !r.user){
        try{ await db.auth.signOut({ scope:'local' }); }catch(e){}
        renderStaffLoginForm(
          r && r.inactive ? 'This account has been deactivated. Ask your department Head or the admin.'
          : r && r.notStaff ? 'This is not an office staff account.'
          : 'Could not load your account — try again.', username);
        return;
      }
      staffCommitSession(r.user);
      if(r.user.mustChangePassword) await showChangePasswordScreen(true);
      enterApp({ freshLogin:true });
      toast('Welcome, ' + r.user.name);
    };
    submit.addEventListener('click', doSubmit);
    userInput.addEventListener('keydown', (e)=>{ if(e.key==='Enter'){ e.preventDefault(); pwInput.focus(); } });
    pwInput.addEventListener('keydown', (e)=>{ if(e.key==='Enter') doSubmit(); });
    container.appendChild(submit);
    setTimeout(()=> (prefill ? pwInput : userInput).focus(), 50);
  }

  // ---------------------------------------------------------------------
  // View shell: #staffView with one panel per screen
  // ---------------------------------------------------------------------
  const STAFF_PANELS = {
    home:     { nav:'sbNavDashboard',   title:'Home',             sub:'Your departments & access' },
    team:     { nav:'',                 title:'Department Staff', sub:'Accounts, departments & page access' },
    edit:     { nav:'',                 title:'Staff Account',    sub:'Departments & page access' },
    activity: { nav:'',                 title:'Activity Log',     sub:'Who did what, and when' },
    preview:  { nav:'',                 title:'Preview',          sub:'What this user sees' },
    tracker:  { nav:'',                 title:'Live Tracker',     sub:'Where technicians are right now' },
    templates:{ nav:'',                 title:'Role Templates',   sub:'Saved sets of departments & page levels' },
    inbox:    { nav:'',                 title:'Inbox',            sub:'Work waiting on you, oldest first' }
  };
  let staffViewHiding = false;

  function showStaffView(panel){
    const p = STAFF_PANELS[panel] || STAFF_PANELS.home;
    document.body.classList.remove('dashboard-active');
    staffViewHiding = true;
    document.querySelectorAll('main, #homeScreen, .cp-screen').forEach(el=>{ if(el.id !== 'staffView') el.style.display = 'none'; });
    staffViewHiding = false;
    $$('#staffView .stf-panel').forEach(el=>{ el.style.display = (el.id === 'staffPanel_' + panel) ? '' : 'none'; });
    $('staffView').style.display = '';
    if($('footerBar')) $('footerBar').style.display = 'none';
    if($('metaBar')) $('metaBar').style.display = 'none';
    if($('homeBtn')) $('homeBtn').style.display = panel === 'home' ? 'none' : '';
    let title = p.title, sub = p.sub, nav = p.nav;
    if(panel === 'team'){
      title = isStaffUser() ? 'My Team' : 'Department Staff';
      nav = isStaffUser() ? 'staffNavTeam' : 'menuManageStaff';
      sub = isStaffUser() ? 'Your sub-users & their access' : sub;
    }
    if(panel === 'activity') nav = isStaffUser() ? 'staffNavActivity' : 'menuActivityLog';
    if(panel === 'edit') nav = isStaffUser() ? 'staffNavTeam' : 'menuManageStaff';
    if(panel === 'tracker') nav = staffNavId('ops.tracker');
    if(panel === 'templates') nav = 'menuManageStaff';
    if(panel === 'inbox') nav = isStaffUser() ? 'staffNavInbox' : 'menuInbox';
    setHeaderTitle(title, sub);
    setSidebarActive(nav);
    window.scrollTo({ top:0 });
  }

  // Every other screen hides its own fixed list of views, none of which
  // knows about #staffView — so hide it whenever any of them appears.
  function staffWatchOtherViews(){
    if(typeof MutationObserver !== 'function') return;
    const obs = new MutationObserver((muts)=>{
      if(staffViewHiding) return;
      const sv = $('staffView');
      if(!sv || sv.style.display === 'none') return;
      for(const m of muts){
        const el = m.target;
        if(el !== sv && el.style && el.style.display !== 'none'){ sv.style.display = 'none'; return; }
      }
    });
    document.querySelectorAll('main, #homeScreen, .cp-screen').forEach(el=>{
      if(el.id !== 'staffView') obs.observe(el, { attributes:true, attributeFilter:['style'] });
    });
  }

  // ---------------------------------------------------------------------
  // Directory (catalog + accounts the caller may see — RLS decides)
  // ---------------------------------------------------------------------
  const stf = { departments:[], modules:[], people:[], deps:{}, access:{}, loadedAt:0,
                templates:[], links:{}, delegations:[], round2:false };

  async function staffLoadDirectory(force){
    if(!force && stf.loadedAt && Date.now() - stf.loadedAt < 15000) return true;
    if(!(await ensureCloud())) return false;
    try{
      const [d, m, p, sd, sa] = await Promise.all([
        db.from('departments').select('*').order('sort'),
        db.from('app_modules').select('*').order('sort'),
        db.from('profiles').select('id, name, role, active, username, position, supervisor_id, created_at, deactivated_at').eq('role','staff').order('name'),
        db.from('staff_departments').select('*'),
        db.from('staff_access').select('*')
      ]);
      const err = d.error || m.error || p.error || sd.error || sa.error;
      if(err) throw err;
      stf.departments = d.data || [];
      stf.modules = m.data || [];
      stf.people = p.data || [];
      stf.deps = {}; stf.access = {};
      (sd.data||[]).forEach(r=>{ (stf.deps[r.user_id] = stf.deps[r.user_id] || []).push(r); });
      (sa.data||[]).forEach(r=>{ (stf.access[r.user_id] = stf.access[r.user_id] || {})[r.module_key] = r; });
      // Round 2 (20260927_01) — optional: absent tables just mean no
      // templates / delegations yet
      const [tp, tl2, dg] = await Promise.all([
        db.from('access_templates').select('*').order('name'),
        db.from('staff_template_links').select('*'),
        db.from('staff_delegations').select('*').is('revoked_at', null).order('starts_on')
      ]);
      stf.templates = tp.error ? [] : (tp.data || []);
      stf.links = {}; (tl2.error ? [] : (tl2.data || [])).forEach(r=>{ stf.links[r.user_id] = r.template_id; });
      stf.delegations = dg.error ? [] : (dg.data || []);
      stf.round2 = !tp.error;
      stf.loadedAt = Date.now();
      return true;
    }catch(e){
      console.error('staff directory', e);
      toast('Could not load staff — run the 20260926_01 migration if you haven\u2019t yet');
      return false;
    }
  }
  // Called on logout: the directory was loaded under the previous
  // person's permissions and must never be shown to the next.
  function staffResetCache(){
    staffTrackerUnmount();   // before the panels are cleared
    stf.departments = []; stf.modules = []; stf.people = []; stf.deps = {}; stf.access = {}; stf.loadedAt = 0;
    stfEd = null;
  }
  const stfLevelKey = (n)=> n === 3 ? 'approve' : n === 2 ? 'edit' : n === 1 ? 'view' : '';
  function stfPerson(id){ return stf.people.find(p=> p.id === id) || null; }
  function stfIsHead(id){ return (stf.deps[id]||[]).some(d=> d.is_head); }
  function stfHeadDepts(id){ return (stf.deps[id]||[]).filter(d=> d.is_head).map(d=> d.department_id); }
  function stfDeptName(id){ const d = stf.departments.find(x=> x.id === id); return d ? d.name : id; }
  function stfModule(key){ return stf.modules.find(m=> m.key === key) || null; }

  // ---------------------------------------------------------------------
  // Staff home
  // ---------------------------------------------------------------------
  // access: a my_access()-shaped object. opts.preview renders another
  // user's view for the Super Admin, read-only.
  function staffAccessSummaryHtml(access){
    const grants = access.access || {};
    const byDept = {};
    Object.keys(grants).forEach(k=>{
      const m = stfModule(k);
      const dept = m ? m.department : 'other';
      (byDept[dept] = byDept[dept] || []).push({ key:k, m, g:grants[k] });
    });
    const depts = stf.departments.filter(d=> byDept[d.id]);
    if(!depts.length) return '<div class="empty-state">No pages have been given yet. Ask your department Head or the admin.</div>';
    return depts.map(d=>{
      const rows = byDept[d.id].sort((a,b)=> ((a.m&&a.m.sort)||0) - ((b.m&&b.m.sort)||0)).map(({ key, m, g })=>{
        const ready = STAFF_READY_MODULES.includes(key);
        const bits = [];
        if(!(m && m.is_switch)) bits.push('<span class="stf-lvl stf-lvl-' + g.level + '">' + PERM_LABEL[g.level] + '</span>');
        else bits.push('<span class="stf-lvl stf-lvl-view">On</span>');
        if(g.level === 'approve' && m && m.has_limit) bits.push('<span class="stf-meta">' + (g.approve_limit != null ? 'up to ' + staffFmtPeso(g.approve_limit) : 'no limit') + '</span>');
        if(g.expires_at) bits.push('<span class="stf-meta">until ' + escapeHtml(staffFmtDate(g.expires_at)) + '</span>');
        if(g.delegated_from) bits.push('<span class="stf-deleg">covering for ' + escapeHtml(g.delegated_from) + (g.delegated_until ? ' until ' + escapeHtml(staffFmtDate(g.delegated_until + 'T12:00:00+08:00')) : '') + '</span>');
        return '<div class="stf-access-row' + (ready ? ' stf-ready' : '') + '"' + (ready ? ' data-open="' + escapeHtml(key) + '"' : '') + '>' +
          '<span class="stf-access-name">' + escapeHtml(m ? m.label : key) + '</span>' +
          '<span class="stf-access-bits">' + bits.join('') + (ready ? '' : '<span class="stf-soon">Opening soon</span>') + '</span></div>';
      }).join('');
      const head = (access.departments||[]).some(x=> x.id === d.id && x.is_head);
      return '<div class="stf-dept-block"><div class="stf-dept-title">' + escapeHtml(d.name) + (head ? ' <span class="stf-head-badge">Head</span>' : '') + '</div>' + rows + '</div>';
    }).join('');
  }

  async function staffRenderHome(target, access, opts){
    opts = opts || {};
    await staffLoadDirectory();
    const who = opts.person || { name: currentUser && currentUser.name, position: currentUser && currentUser.position };
    const role = access.is_head ? 'Department Head' : access.supervisor ? 'Reports to ' + access.supervisor.name : 'Staff';
    const teamCount = opts.preview ? 0 : stf.people.filter(p=> p.supervisor_id === (currentUser && currentUser.id) && p.active).length;
    target.innerHTML =
      (opts.preview ? '<div class="stf-preview-note">Preview — this is what <b>' + escapeHtml(who.name||'') + '</b> sees after signing in. Nothing here can be changed.</div>' : '') +
      '<div class="card"><div class="card-body stf-hello">' +
        '<div class="stf-hello-name">' + (opts.preview ? '' : 'Good day, ') + escapeHtml(who.name || '') + '</div>' +
        '<div class="stf-hello-sub">' + escapeHtml([who.position, role].filter(Boolean).join(' \u00B7 ')) + '</div>' +
        (access.departments && access.departments.length ? '<div class="stf-chips">' + access.departments.map(d=> '<span class="stf-chip">' + escapeHtml(d.name) + (d.is_head ? ' \u2605' : '') + '</span>').join('') + '</div>' : '') +
      '</div></div>' +
      (access.is_head && !opts.preview ?
        '<div class="card"><div class="card-body stf-team-tile"><div><div class="stf-tile-title">My Team</div>' +
        '<div class="stf-tile-sub">' + teamCount + ' active sub-user' + (teamCount === 1 ? '' : 's') + '</div></div>' +
        '<button type="button" class="btn btn-primary" data-act="team">Manage</button></div></div>' : '') +
      '<div class="card"><div class="card-head"><span>' + (opts.preview ? 'Their access' : 'Your access') + '</span></div><div class="card-body">' +
        staffAccessSummaryHtml(access) +
        (STAFF_READY_MODULES.length ? '' : '<p class="stf-note">Department pages open here one department at a time. Until then, pages show as \u201COpening soon\u201D.</p>') +
      '</div></div>' +
      (opts.preview ? '<button type="button" class="btn btn-secondary" data-act="back" style="width:100%;">\u2190 Back to account</button>' :
        '<div class="stf-actions-row"><button type="button" class="btn btn-secondary" data-act="password">Change Password</button>' +
        '<button type="button" class="btn btn-secondary" data-act="activity">My Activity</button></div>');
    if(!opts.preview){ staffRenderInboxSummary(target); staffRenderDashboard(target); if(access.is_head) staffRenderLeaveHandover(target); }
    const on = (act, fn)=>{ const b = target.querySelector('[data-act="' + act + '"]'); if(b) b.addEventListener('click', fn); };
    on('team', ()=> staffOpenTeam());
    on('password', ()=> showChangePasswordScreen(false));
    on('activity', ()=> staffOpenActivity());
    on('back', ()=> opts.onBack && opts.onBack());
  }

  async function showStaffHome(){
    if(staffMaybeOpenInboxFromUrl()) return;
    showStaffView('home');
    const target = $('staffPanel_home');
    target.innerHTML = '<div class="empty-state">Loading\u2026</div>';
    await staffRefreshAccess();
    if(!isStaffUser()) return;
    await staffRenderHome(target, currentUser.access || {});
  }

  // Sidebar for staff: granted + opened pages (Phase 3), My Team for Heads.
  function staffRenderSidebar(){
    const grp = $('sidebarStaffGroup');
    if(!grp) return;
    const staff = isStaffUser();
    grp.style.display = staff ? '' : 'none';
    if(!staff) return;
    const pagesEl = $('staffNavPages');
    if(pagesEl && !stf.modules.length && STAFF_READY_MODULES.some(k=> can(k, 'view'))){
      // labels come from the catalog — load it, then draw again
      staffLoadDirectory().then(ok=>{ if(ok && stf.modules.length) staffRenderSidebar(); });
    }
    if(pagesEl){
      const keys = STAFF_READY_MODULES.filter(k=> can(k, 'view'));
      pagesEl.innerHTML = keys.map(k=>{
        const m = stfModule(k);
        return '<button type="button" class="sidebar-link" id="' + staffNavId(k) + '" data-staff-open="' + escapeHtml(k) + '">' + escapeHtml(m ? m.label : k) + '</button>';
      }).join('');
    }
    if($('staffNavTeam')) $('staffNavTeam').style.display = staffIsHead() ? '' : 'none';
    if(typeof fitSidebarNav === 'function') fitSidebarNav();
  }

  // ---------------------------------------------------------------------
  // Team list
  // ---------------------------------------------------------------------
  let stfShowInactive = false;

  async function staffOpenTeam(){
    if(!currentUser || !(currentUser.role === 'admin' || staffIsHead())){ toast('Only the admin or a department Head can manage staff'); return; }
    if(currentUser.role === 'admin' && !(await ensureAdminAuthenticated())) return;
    showStaffView('team');
    const target = $('staffPanel_team');
    target.innerHTML = '<div class="empty-state">Loading\u2026</div>';
    if(!(await staffLoadDirectory(true))){ target.innerHTML = '<div class="empty-state">Could not load staff.</div>'; return; }
    staffRenderTeam();
  }

  function staffPersonCardHtml(p, opts){
    const deps = (stf.deps[p.id]||[]).map(d=> '<span class="stf-chip' + (d.is_head ? ' stf-chip-head' : '') + '">' + escapeHtml(stfDeptName(d.department_id)) + (d.is_head ? ' \u2605 Head' : '') + '</span>').join('');
    const pages = Object.keys(stf.access[p.id]||{}).length;
    return '<button type="button" class="stf-person' + (p.active ? '' : ' stf-inactive') + (opts && opts.sub ? ' stf-sub' : '') + '" data-edit="' + p.id + '">' +
      '<span class="stf-avatar">' + escapeHtml((p.name||'?').trim().charAt(0).toUpperCase()) + '</span>' +
      '<span class="stf-person-main"><span class="stf-person-name">' + escapeHtml(p.name||'') + (p.active ? '' : ' <span class="stf-off">Deactivated</span>') + '</span>' +
      '<span class="stf-person-sub">@' + escapeHtml(p.username||'') + (p.position ? ' \u00B7 ' + escapeHtml(p.position) : '') + ' \u00B7 ' + pages + ' page' + (pages === 1 ? '' : 's') + '</span>' +
      (deps ? '<span class="stf-chips">' + deps + '</span>' : '') + '</span>' +
      '<span class="stf-chev">\u203A</span></button>';
  }

  function staffRenderTeam(){
    const target = $('staffPanel_team');
    const isSuper = currentUser.role === 'admin';
    const visible = stf.people.filter(p=> stfShowInactive || p.active);
    let listHtml = '';
    if(isSuper){
      const tops = visible.filter(p=> !p.supervisor_id);
      const orphans = visible.filter(p=> p.supervisor_id && !stfPerson(p.supervisor_id));
      listHtml = tops.map(h=>{
        const subs = visible.filter(p=> p.supervisor_id === h.id);
        return staffPersonCardHtml(h) + subs.map(s=> staffPersonCardHtml(s, { sub:true })).join('');
      }).join('') + orphans.map(s=> staffPersonCardHtml(s, { sub:true })).join('');
    }else{
      listHtml = visible.filter(p=> p.supervisor_id === currentUser.id).map(p=> staffPersonCardHtml(p)).join('');
    }
    const total = stf.people.filter(p=> p.active && (isSuper || p.supervisor_id === currentUser.id)).length;
    target.innerHTML =
      '<div class="card"><div class="card-body">' +
        '<p class="stf-note" style="margin-top:0;">' + (isSuper
          ? 'Office staff accounts for Purchasing, Accounting &amp; Finance, Human Resources, Administration and Operations. A department Head (\u2605) can add sub-users under them, with no more access than their own.'
          : 'Your sub-users. You can give them any of your own pages, up to your own level, approval limit and end date.') + '</p>' +
        '<div class="stf-toolbar">' +
          '<button type="button" class="btn btn-primary" data-act="add">+ Add ' + (isSuper ? 'Staff' : 'Sub-user') + '</button>' +
          (isSuper && stf.round2 ? '<button type="button" class="btn btn-secondary" data-act="templates">Role Templates (' + stf.templates.length + ')</button>' : '') +
          '<label class="sp-check"><input type="checkbox" data-act="inactive"' + (stfShowInactive ? ' checked' : '') + '> Show deactivated</label>' +
          '<span class="stf-count">' + total + ' active</span>' +
        '</div>' +
        '<div class="stf-list">' + (listHtml || '<div class="empty-state">' + (isSuper ? 'No staff accounts yet. Add a department Head first.' : 'No sub-users yet.') + '</div>') + '</div>' +
      '</div></div>';
    target.querySelector('[data-act="add"]').addEventListener('click', ()=> staffOpenEditor(null));
    const tb = target.querySelector('[data-act="templates"]'); if(tb) tb.addEventListener('click', ()=> staffOpenTemplates());
    if(!isSuper && stf.round2) staffRenderDelegationCard(target);
    target.querySelector('[data-act="inactive"]').addEventListener('change', (e)=>{ stfShowInactive = e.target.checked; staffRenderTeam(); });
    target.querySelectorAll('[data-edit]').forEach(b=> b.addEventListener('click', ()=> staffOpenEditor(b.getAttribute('data-edit'))));
  }

  // ---------------------------------------------------------------------
  // Editor
  // ---------------------------------------------------------------------
  // Form state, kept separately from the DOM so the form can be re-drawn
  // (e.g. when the Super Admin picks a different Head) without losing edits.
  let stfEd = null;

  function staffEditorStateFrom(personId){
    const p = personId ? stfPerson(personId) : null;
    const s = {
      id: p ? p.id : null,
      original: p,
      name: p ? (p.name||'') : '',
      username: p ? (p.username||'') : '',
      position: p ? (p.position||'') : '',
      password: '',
      supervisorId: p ? (p.supervisor_id || '') : (isStaffUser() ? currentUser.id : ''),
      depts: {},     // id -> { member, head }
      grants: {}     // module -> { level, limit, until }
    };
    (stf.deps[s.id]||[]).forEach(d=>{ s.depts[d.department_id] = { member:true, head: !!d.is_head }; });
    Object.values(stf.access[s.id]||{}).forEach(a=>{
      s.grants[a.module_key] = { level: stfLevelKey(a.level), limit: a.approve_limit != null ? String(a.approve_limit) : '', until: staffDateOf(a.expires_at) };
    });
    return s;
  }

  // What the supervisor (if any) allows: null = no ceiling (Super Admin
  // editing a top-level account).
  function staffCeiling(s){
    if(!s.supervisorId) return null;
    const grants = stf.access[s.supervisorId] || {};
    const out = { depts: stfHeadDepts(s.supervisorId), modules:{} };
    Object.values(grants).forEach(a=>{
      if(a.expires_at && new Date(a.expires_at) <= new Date()) return;
      out.modules[a.module_key] = { rank: a.level, limit: a.approve_limit, until: staffDateOf(a.expires_at), untilTs: a.expires_at || null };
    });
    return out;
  }

  function staffOpenEditor(personId){
    stfEd = staffEditorStateFrom(personId);
    showStaffView('edit');
    staffRenderEditor();
  }

  function staffLevelControl(mod, g, cap){
    const levels = mod.is_switch ? [['', 'Off'], ['view', 'On']]
      : [['', 'None'], ['view', 'View'], ['edit', 'Edit']].concat(mod.approvable ? [['approve', 'Approve']] : []);
    return '<div class="stf-seg" role="radiogroup" aria-label="' + escapeHtml(mod.label) + '">' + levels.map(([v, lab])=>{
      const disabled = cap && v && (PERM_RANK[v] > cap.rank);
      const on = (g.level || '') === v;
      return '<button type="button" class="stf-seg-btn' + (on ? ' on' : '') + '" data-level="' + v + '"' + (disabled ? ' disabled title="Above the Head\u2019s own level"' : '') + ' role="radio" aria-checked="' + on + '">' + lab + '</button>';
    }).join('') + '</div>';
  }

  function staffRenderEditor(){
    const s = stfEd;
    const target = $('staffPanel_edit');
    const isSuper = currentUser.role === 'admin';
    const isNew = !s.id;
    const cap = staffCeiling(s);
    const p = s.original;
    const heads = stf.people.filter(x=> x.active && !x.supervisor_id && stfIsHead(x.id) && x.id !== s.id);
    const hasSubs = !!(s.id && stf.people.some(x=> x.supervisor_id === s.id));

    const deptCards = stf.departments.map(d=>{
      if(cap && !cap.depts.includes(d.id)) return '';
      const st = s.depts[d.id] || { member:false, head:false };
      const mods = stf.modules.filter(m=> m.department === d.id && (!cap || cap.modules[m.key]));
      const rows = mods.map(m=>{
        const g = s.grants[m.key] || { level:'', limit:'', until:'' };
        const c = cap ? cap.modules[m.key] : null;
        const showLimit = g.level === 'approve' && m.has_limit;
        return '<div class="stf-mod" data-mod="' + escapeHtml(m.key) + '">' +
          '<div class="stf-mod-top"><span class="stf-mod-name">' + escapeHtml(m.label) + '</span>' + staffLevelControl(m, g, c) + '</div>' +
          (g.level ? '<div class="stf-mod-extra">' +
            (showLimit ? '<label>Approve up to \u20B1<input type="number" min="0" step="0.01" inputmode="decimal" data-f="limit" value="' + escapeHtml(g.limit) + '" placeholder="' + (c && c.limit != null ? 'max ' + escapeHtml(String(c.limit)) : 'no limit') + '"></label>' : '') +
            '<label>Ends on <input type="date" data-f="until" value="' + escapeHtml(g.until) + '"' + (c && c.until ? ' max="' + escapeHtml(c.until) + '"' : '') + '>' + (c && c.until ? '' : '<span class="stf-hint">blank = permanent</span>') + '</label>' +
          '</div>' : '') +
        '</div>';
      }).join('');
      const headToggle = (isSuper && !s.supervisorId)
        ? '<label class="stf-head-toggle"><input type="checkbox" data-f="head"' + (st.head ? ' checked' : '') + (st.member ? '' : ' disabled') + '> Head of this department</label>' : '';
      return '<div class="stf-dept' + (st.member ? ' on' : '') + '" data-dept="' + escapeHtml(d.id) + '">' +
        '<label class="stf-dept-head"><input type="checkbox" data-f="member"' + (st.member ? ' checked' : '') + '> <span>' + escapeHtml(d.name) + '</span></label>' +
        headToggle +
        (st.member ? '<div class="stf-mods">' + (rows || '<div class="stf-note">No pages available here.</div>') + '</div>' : '') +
      '</div>';
    }).join('');

    target.innerHTML =
      '<button type="button" class="btn btn-secondary stf-back" data-act="back">\u2190 ' + (isStaffUser() ? 'My Team' : 'Department Staff') + '</button>' +
      (p && !p.active ? '<div class="stf-banner-off">This account is deactivated' + (p.deactivated_at ? ' since ' + escapeHtml(staffFmtDate(p.deactivated_at)) : '') + '. It cannot sign in.</div>' : '') +
      '<div class="card"><div class="card-head"><span>' + (isNew ? 'New ' + (isStaffUser() ? 'sub-user' : 'staff account') : 'Account') + '</span></div><div class="card-body">' +
        '<div class="field"><label>Full name</label><input type="text" data-f="name" value="' + escapeHtml(s.name) + '" placeholder="e.g. Maria Santos"></div>' +
        '<div class="field"><label>Username <span class="stf-hint">used to sign in</span></label><input type="text" data-f="username" autocapitalize="none" spellcheck="false" value="' + escapeHtml(s.username) + '" placeholder="e.g. msantos"></div>' +
        '<div class="field"><label>Position <span class="stf-hint">optional</span></label><input type="text" data-f="position" value="' + escapeHtml(s.position) + '" placeholder="e.g. Purchasing Officer"></div>' +
        (isNew ? '<div class="field"><label>Temporary password <span class="stf-hint">they set their own at first sign-in</span></label>' +
          '<div class="stf-pw-row"><input type="text" data-f="password" autocomplete="off" value="' + escapeHtml(s.password) + '" placeholder="At least 6 characters">' +
          '<button type="button" class="btn btn-secondary" data-act="genpw">Generate</button></div></div>' : '') +
        (isSuper ? '<div class="field"><label>Reports to</label><select data-f="supervisor"' + (hasSubs ? ' disabled' : '') + '>' +
          '<option value="">Super Admin (top level)</option>' +
          heads.map(h=> '<option value="' + h.id + '"' + (s.supervisorId === h.id ? ' selected' : '') + '>' + escapeHtml(h.name) + ' \u2014 Head of ' + escapeHtml(stfHeadDepts(h.id).map(stfDeptName).join(', ')) + '</option>').join('') +
          '</select>' + (hasSubs ? '<div class="stf-hint">This Head has sub-users, so they stay at the top level.</div>' : '') + '</div>' : '') +
      '</div></div>' +
      '<div class="card"><div class="card-head"><span>Departments &amp; pages</span></div><div class="card-body">' +
        staffTemplatePickerHtml(s) +
        '<p class="stf-note" style="margin-top:0;">Tick a department, then choose each page\u2019s level. <b>View</b> sees it, <b>Edit</b> also creates and changes, <b>Approve</b> also approves.' +
        (cap ? ' Choices above the Head\u2019s own access are greyed out.' : '') + '</p>' +
        (deptCards || '<div class="empty-state">No departments available.</div>') +
      '</div></div>' +
      '<div class="stf-save-bar"><button type="button" class="btn btn-primary" data-act="save">' + (isNew ? 'Create Account' : 'Save Changes') + '</button></div>' +
      (!isNew ? '<div class="card"><div class="card-head"><span>More</span></div><div class="card-body stf-more">' +
        (isSuper ? '<button type="button" class="btn btn-secondary" data-act="preview">Preview what they see</button>' : '') +
        '<button type="button" class="btn btn-secondary" data-act="resetpw">Reset password</button>' +
        '<button type="button" class="btn btn-secondary" data-act="activity">Their activity</button>' +
        (p && p.active ? '<button type="button" class="btn btn-secondary stf-danger" data-act="deactivate">Deactivate</button>'
                       : '<button type="button" class="btn btn-secondary" data-act="reactivate">Reactivate</button>') +
      '</div></div>' : '');

    staffWireEditor(target);
    if(isSuper && !isNew && stf.round2 && p && p.active) staffRenderDelegationCard(target, s.id, ()=> staffOpenEditor(s.id));
  }

  function staffSyncFromForm(target){
    const s = stfEd;
    const val = (sel)=>{ const el = target.querySelector(sel); return el ? el.value : undefined; };
    if(val('[data-f="name"]') !== undefined) s.name = val('[data-f="name"]');
    if(val('[data-f="username"]') !== undefined) s.username = val('[data-f="username"]');
    if(val('[data-f="position"]') !== undefined) s.position = val('[data-f="position"]');
    if(val('[data-f="password"]') !== undefined) s.password = val('[data-f="password"]');
    target.querySelectorAll('.stf-mod').forEach(row=>{
      const k = row.getAttribute('data-mod');
      if(!s.grants[k]) return;
      const lim = row.querySelector('[data-f="limit"]'); if(lim) s.grants[k].limit = lim.value;
      const un = row.querySelector('[data-f="until"]'); if(un) s.grants[k].until = un.value;
    });
  }

  function staffWireEditor(target){
    const s = stfEd;
    const on = (act, fn)=>{ const b = target.querySelector('[data-act="' + act + '"]'); if(b) b.addEventListener('click', fn); };
    on('back', ()=> staffOpenTeamList());
    on('genpw', ()=>{
      const chars = 'abcdefghjkmnpqrstuvwxyzACDEFGHJKLMNPQRSTUVWXYZ23456789';
      const arr = new Uint32Array(8); crypto.getRandomValues(arr);
      const pw = Array.from(arr, n=> chars[n % chars.length]).join('');
      const el = target.querySelector('[data-f="password"]'); if(el) el.value = pw;
      s.password = pw;
    });
    const sup = target.querySelector('[data-f="supervisor"]');
    if(sup) sup.addEventListener('change', ()=>{
      staffSyncFromForm(target);
      s.supervisorId = sup.value;
      // Under a Head: nobody is Head, and anything outside the Head's own
      // access is dropped from the form (the server would refuse it anyway).
      const cap = staffCeiling(s);
      if(cap){
        Object.keys(s.depts).forEach(id=>{ s.depts[id].head = false; if(!cap.depts.includes(id)) delete s.depts[id]; });
        Object.keys(s.grants).forEach(k=>{
          const c = cap.modules[k];
          if(!c){ delete s.grants[k]; return; }
          if(PERM_RANK[s.grants[k].level] > c.rank) s.grants[k].level = stfLevelKey(c.rank);
          if(c.until && (!s.grants[k].until || s.grants[k].until > c.until)) s.grants[k].until = c.until;
        });
      }
      staffRenderEditor();
    });
    target.querySelectorAll('.stf-dept').forEach(card=>{
      const id = card.getAttribute('data-dept');
      const mem = card.querySelector('[data-f="member"]');
      mem.addEventListener('change', ()=>{
        staffSyncFromForm(target);
        if(mem.checked) s.depts[id] = { member:true, head:false };
        else{
          delete s.depts[id];
          stf.modules.filter(m=> m.department === id).forEach(m=> delete s.grants[m.key]);
        }
        staffRenderEditor();
      });
      const hd = card.querySelector('[data-f="head"]');
      if(hd) hd.addEventListener('change', ()=>{ if(s.depts[id]) s.depts[id].head = hd.checked; });
    });
    target.querySelectorAll('.stf-mod').forEach(row=>{
      const k = row.getAttribute('data-mod');
      row.querySelectorAll('.stf-seg-btn').forEach(btn=> btn.addEventListener('click', ()=>{
        staffSyncFromForm(target);
        const lv = btn.getAttribute('data-level');
        if(!lv) delete s.grants[k];
        else{
          s.grants[k] = Object.assign({ limit:'', until:'' }, s.grants[k] || {}, { level: lv });
          // Under a Head whose own access ends: start from (and never pass) that date.
          const c = (staffCeiling(s) || { modules:{} }).modules[k];
          if(c && c.until && (!s.grants[k].until || s.grants[k].until > c.until)) s.grants[k].until = c.until;
        }
        staffRenderEditor();
      }));
    });
    on('save', ()=> staffSaveEditor(target));
    on('applytpl', ()=> staffApplyTemplateFromEditor(target));
    on('preview', ()=> staffPreview());
    on('resetpw', ()=> staffResetPassword());
    on('activity', ()=> staffOpenActivity({ actorId: s.id }));
    on('deactivate', ()=> staffDeactivate());
    on('reactivate', ()=> staffReactivate());
  }

  function staffOpenTeamList(){
    showStaffView('team');
    staffRenderTeam();
  }

  function staffPayload(s){
    const cap = staffCeiling(s);
    const departments = Object.keys(s.depts).filter(id=> s.depts[id].member).map(id=> ({ id, is_head: !s.supervisorId && !!s.depts[id].head }));
    const inDept = {};
    departments.forEach(d=> stf.modules.filter(m=> m.department === d.id).forEach(m=> inDept[m.key] = true));
    const access = Object.keys(s.grants).filter(k=> inDept[k] && s.grants[k].level).map(k=>{
      const g = s.grants[k]; const m = stfModule(k);
      const c = cap && cap.modules[k];
      const until = (c && c.until && (!g.until || g.until > c.until)) ? c.until : g.until;
      return {
        module: k, level: g.level,
        approve_limit: (g.level === 'approve' && m && m.has_limit && g.limit !== '' && g.limit != null) ? Number(g.limit) : null,
        // Same day as the Head's end date → use the Head's exact moment, so
        // it can never land a few hours past it.
        expires_at: (c && c.until && until === c.until) ? c.untilTs : staffEndOfDay(until)
      };
    });
    return { departments, access };
  }

  async function staffSaveEditor(target){
    staffSyncFromForm(target);
    const s = stfEd;
    const name = (s.name||'').trim();
    const username = (s.username||'').trim().toLowerCase();
    if(!name){ toast('Enter the full name'); return; }
    if(!/^[a-z0-9][a-z0-9._-]{2,29}$/.test(username)){ toast('Username: 3\u201330 letters, numbers, dot, dash or underscore'); return; }
    const { departments, access } = staffPayload(s);
    if(!departments.length){ toast('Tick at least one department'); return; }
    for(const a of access){
      if(a.approve_limit != null && !(a.approve_limit >= 0)){ toast('Check the approval limits'); return; }
    }
    const btn = target.querySelector('[data-act="save"]');
    btn.disabled = true; btn.textContent = 'Saving\u2026';
    try{
      if(!s.id){
        if((s.password||'').length < 6){ toast('Temporary password: at least 6 characters'); return; }
        const r = await staffInvoke({ action:'create', username, name, position:(s.position||'').trim(), password:s.password,
                                      supervisorId: s.supervisorId || null, departments, access });
        if(!r.ok){ toast(r.error); return; }
        await staffLoadDirectory(true);
        await uiConfirm('Account created.\n\nUsername: ' + username + '\nTemporary password: ' + s.password +
                        '\n\nThey sign in from Staff Access \u2192 Office Staff, and choose their own password the first time.',
                        { title:'Share these sign-in details', ok:'Done', cancel:'Close' });
        staffOpenEditor(r.data.id);
        return;
      }
      const o = s.original;
      const steps = [];
      if(name !== (o.name||'') || (s.position||'').trim() !== (o.position||''))
        steps.push({ action:'update_profile', userId:s.id, name, position:(s.position||'').trim() });
      if(username !== (o.username||'').toLowerCase()) steps.push({ action:'change_username', userId:s.id, username });
      const accessStep = { action:'update_access', userId:s.id, departments, access };
      const moved = currentUser.role === 'admin' && (s.supervisorId||'') !== (o.supervisor_id||'');
      const moveStep = { action:'set_supervisor', userId:s.id, supervisorId: s.supervisorId || null };
      // Moving UNDER a Head: drop Head flags first (the database won't place
      // a Head under a Head), then move — the move trims access to the new
      // Head's. Moving to the TOP level: move first, so Head can be ticked.
      if(moved && s.supervisorId){ steps.push(accessStep, moveStep); }
      else if(moved){ steps.push(moveStep, accessStep); }
      else steps.push(accessStep);
      for(const step of steps){
        const r = await staffInvoke(step);
        if(!r.ok){ toast(r.error); await staffLoadDirectory(true); return; }
      }
      toast('Saved');
      await staffLoadDirectory(true);
      if(isStaffUser() && s.id === currentUser.id) staffRefreshAccess();
      staffOpenEditor(s.id);
    }finally{
      if(document.contains(btn)){ btn.disabled = false; btn.textContent = s.id ? 'Save Changes' : 'Create Account'; }
    }
  }

  async function staffPreview(){
    const s = stfEd; const p = s.original;
    if(!p) return;
    const acc = {
      is_head: stfIsHead(p.id) && !p.supervisor_id,
      supervisor: p.supervisor_id ? { id:p.supervisor_id, name:(stfPerson(p.supervisor_id)||{}).name || '' } : null,
      departments: (stf.deps[p.id]||[]).map(d=> ({ id:d.department_id, name:stfDeptName(d.department_id), is_head:d.is_head })),
      access: {}
    };
    Object.values(stf.access[p.id]||{}).forEach(a=>{
      if(a.expires_at && new Date(a.expires_at) <= new Date()) return;
      acc.access[a.module_key] = { level: stfLevelKey(a.level), approve_limit: a.approve_limit, expires_at: a.expires_at };
    });
    showStaffView('preview');
    await staffRenderHome($('staffPanel_preview'), acc, { preview:true, person:p, onBack: ()=> staffOpenEditor(p.id) });
  }

  async function staffResetPassword(){
    const p = stfEd.original;
    const pw = await uiPrompt('New temporary password for ' + p.name + ' (at least 6 characters). They choose their own at next sign-in.', '', { title:'Reset password', ok:'Reset' });
    if(pw == null) return;
    if(pw.length < 6){ toast('At least 6 characters'); return; }
    const r = await staffInvoke({ action:'reset_password', userId:p.id, password:pw });
    toast(r.ok ? 'Password reset \u2014 tell ' + p.name + ' the new temporary password' : r.error);
  }

  async function staffDeactivate(){
    const p = stfEd.original;
    if(!(await uiConfirm('Deactivate ' + p.name + '? They lose access right away and can no longer sign in. Everything they did stays on record.', { ok:'Deactivate', danger:true }))) return;
    let r = await staffInvoke({ action:'deactivate', userId:p.id });
    if(!r.ok && r.code === 'has_sub_users'){
      const again = await uiConfirm(r.error + '\n\nDeactivate them too? To move them to another Head instead, cancel, then open each sub-user and change \u201CReports to\u201D first.',
                                    { ok:'Deactivate all', danger:true });
      if(!again) return;
      r = await staffInvoke({ action:'deactivate', userId:p.id, subUsers:'deactivate' });
    }
    if(!r.ok){ toast(r.error); return; }
    toast('Deactivated ' + p.name);
    await staffLoadDirectory(true);
    staffOpenEditor(p.id);
  }

  async function staffReactivate(){
    const p = stfEd.original;
    const r = await staffInvoke({ action:'reactivate', userId:p.id });
    if(!r.ok){ toast(r.error); return; }
    toast('Reactivated ' + p.name);
    await staffLoadDirectory(true);
    staffOpenEditor(p.id);
  }

  // ---------------------------------------------------------------------
  // Activity Log
  // ---------------------------------------------------------------------
  const STAFF_ENTITY_LABEL = {
    staff:'Staff account', suppliers:'Supplier', supplier_contacts:'Supplier contact', supplier_materials:'Supplier price',
    materials:'Material', material_categories:'Material category', material_requisitions:'Material requisition',
    purchase_orders:'Purchase order', po_signatories:'PO signatory', po_settings:'PO settings',
    warehouses:'Warehouse', warehouse_storekeepers:'Storekeeper', stock_receipts:'Stock receipt', issue_slips:'Issue slip',
    return_slips:'Return slip', stock_transfers:'Stock transfer', projects:'Project', project_job_orders:'Project job order',
    tools:'Tool', tool_slips:'Tool slip', tool_defects:'Tool defect', tool_maintenance:'Tool calibration',
    cash_advance_requests:'Cash advance', leave_requests:'Leave request', dtr_records:'DTR',
    dispatch_tickets:'Job order', service_requests:'Service request', service_reports:'Service report',
    customers:'Customer', customer_equipment:'Customer equipment', customer_login_links:'Customer login',
    technician_violations:'Violation', technician_documents:'Technician document', announcements:'Announcement', app_settings:'Settings',
    template:'Role template', inbox_sla:'Inbox response time', supplier_documents:'Supplier document'
  };
  const STAFF_ACTION_LABEL = {
    insert:'created', update:'changed', delete:'deleted',
    'staff.create':'created account', 'staff.update_access':'changed access of', 'staff.update_profile':'edited',
    'staff.change_username':'renamed', 'staff.reset_password':'reset password of', 'staff.set_supervisor':'moved',
    'staff.deactivate':'deactivated', 'staff.reactivate':'reactivated', 'staff.reauth_failed':'wrong password (approval)',
    'staff.apply_template':'applied a role template to', 'template.create':'created', 'template.update':'changed', 'template.delete':'deleted',
    'delegation.create':'set up a delegation for', 'delegation.revoke':'ended the delegation for', 'inbox.sla':'changed the response time for'
  };
  // gen: bumped whenever the list is reset, so a fetch that was already in
  // flight for an older filter/screen can't finish into the new one.
  const stfAct = { actorId:'', type:'', rows:[], done:false, busy:false, gen:0 };
  function staffResetActivity(){ stfAct.rows = []; stfAct.done = false; stfAct.busy = false; stfAct.gen++; }

  async function staffOpenActivity(opts){
    opts = opts || {};
    if(currentUser && currentUser.role === 'admin' && !(await ensureAdminAuthenticated())) return;
    showStaffView('activity');
    stfAct.actorId = opts.actorId || (isStaffUser() && !staffIsHead() ? currentUser.id : '');
    stfAct.type = ''; staffResetActivity();
    await staffLoadDirectory();
    staffRenderActivityShell();
    staffLoadActivity();
  }

  function staffRenderActivityShell(){
    const target = $('staffPanel_activity');
    const people = currentUser.role === 'admin' ? stf.people
                 : stf.people.filter(p=> p.id === currentUser.id || p.supervisor_id === currentUser.id);
    const showPeople = currentUser.role === 'admin' || staffIsHead();
    target.innerHTML =
      '<div class="card"><div class="card-body">' +
        '<p class="stf-note" style="margin-top:0;">A permanent record of changes made in the app. Lines can\u2019t be edited or removed.' +
        (currentUser.role === 'admin' ? '' : staffIsHead() ? ' You see your own and your sub-users\u2019 activity.' : ' You see your own activity.') + '</p>' +
        '<div class="stf-toolbar">' +
          (showPeople ? '<select data-f="actor"><option value="">' + (currentUser.role === 'admin' ? 'Everyone' : 'Me &amp; my team') + '</option>' +
            (currentUser.role === 'admin' ? '<option value="__system">System (automatic)</option>' : '') +
            people.map(p=> '<option value="' + p.id + '"' + (stfAct.actorId === p.id ? ' selected' : '') + '>' + escapeHtml(p.name||p.username) + '</option>').join('') + '</select>' : '') +
          '<select data-f="type"><option value="">All records</option>' +
            Object.keys(STAFF_ENTITY_LABEL).map(k=> '<option value="' + k + '">' + escapeHtml(STAFF_ENTITY_LABEL[k]) + '</option>').join('') + '</select>' +
        '</div>' +
        '<div class="stf-log" id="stfLogList"><div class="empty-state">Loading\u2026</div></div>' +
        '<button type="button" class="btn btn-secondary" data-act="more" style="width:100%; display:none;">Load more</button>' +
      '</div></div>';
    const actor = target.querySelector('[data-f="actor"]');
    if(actor) actor.addEventListener('change', ()=>{ stfAct.actorId = actor.value; staffResetActivity(); staffLoadActivity(); });
    const type = target.querySelector('[data-f="type"]');
    type.addEventListener('change', ()=>{ stfAct.type = type.value; staffResetActivity(); staffLoadActivity(); });
    target.querySelector('[data-act="more"]').addEventListener('click', ()=> staffLoadActivity());
  }

  async function staffLoadActivity(){
    if(stfAct.busy || stfAct.done) return;
    stfAct.busy = true;
    const gen = stfAct.gen;
    const PAGE = 40;
    try{
      let q = db.from('activity_log').select('*').order('at', { ascending:false }).order('id', { ascending:false });
      if(stfAct.actorId === '__system') q = q.is('actor_id', null);
      else if(stfAct.actorId) q = q.eq('actor_id', stfAct.actorId);
      if(stfAct.type) q = q.eq('entity_type', stfAct.type);
      if(stfAct.rows.length) q = q.lt('id', stfAct.rows[stfAct.rows.length - 1].id);
      const { data, error } = await q.limit(PAGE);
      if(gen !== stfAct.gen) return;          // superseded — the newer load renders
      if(error) throw error;
      stfAct.rows = stfAct.rows.concat(data || []);
      if(!data || data.length < PAGE) stfAct.done = true;
    }catch(e){
      console.error('activity log', e);
      toast('Could not load the activity log');
    }finally{ if(gen === stfAct.gen) stfAct.busy = false; }
    if(gen === stfAct.gen) staffRenderActivityRows();
  }

  function staffActivityDetailsHtml(r){
    const d = r.details || {};
    const keys = Object.keys(d);
    if(!keys.length) return '';
    const fmt = (v)=>{
      if(v == null) return '\u2014';
      if(typeof v === 'object') return escapeHtml(JSON.stringify(v).slice(0, 160));
      return escapeHtml(String(v).slice(0, 160));
    };
    let lines;
    if(r.action === 'update'){
      lines = keys.slice(0, 12).map(k=>{
        const c = d[k] || {};
        if(c && typeof c === 'object' && ('from' in c || 'to' in c)) return '<div><b>' + escapeHtml(k) + '</b>: ' + fmt(c.from) + ' \u2192 ' + fmt(c.to) + '</div>';
        // nested (e.g. a job order's data): { field: {from,to} }
        return Object.keys(c).slice(0, 8).map(ik=> '<div><b>' + escapeHtml(ik) + '</b>: ' + fmt((c[ik]||{}).from) + ' \u2192 ' + fmt((c[ik]||{}).to) + '</div>').join('');
      });
    }else{
      lines = keys.filter(k=> !/^(id|created_at|updated_at)$/.test(k)).slice(0, 10).map(k=> '<div><b>' + escapeHtml(k) + '</b>: ' + fmt(d[k]) + '</div>');
    }
    return '<details class="stf-log-details"><summary>Details</summary>' + lines.join('') + (keys.length > 12 ? '<div>\u2026</div>' : '') + '</details>';
  }

  function staffRenderActivityRows(){
    const list = $live('stfLogList');
    if(!list) return;
    if(!stfAct.rows.length){ list.innerHTML = '<div class="empty-state">Nothing recorded yet.</div>'; }
    else list.innerHTML = stfAct.rows.map(r=>{
      const what = STAFF_ENTITY_LABEL[r.entity_type] || r.entity_type;
      const verb = STAFF_ACTION_LABEL[r.action] || r.action;
      const who = r.actor_id ? (r.actor_name || 'Someone') : 'System';
      const obj = r.entity_type === 'staff' ? (r.entity_label ? '@' + r.entity_label : what)
                : what + (r.entity_label ? ' \u201C' + r.entity_label + '\u201D' : '');
      return '<div class="stf-log-row"><div class="stf-log-when">' + escapeHtml(staffFmtDateTime(r.at)) + '</div>' +
        '<div class="stf-log-what"><b>' + escapeHtml(who) + '</b> ' + escapeHtml(verb) + ' ' + escapeHtml(obj) + '</div>' +
        staffActivityDetailsHtml(r) + '</div>';
    }).join('');
    const more = $('staffPanel_activity').querySelector('[data-act="more"]');
    if(more) more.style.display = stfAct.done ? 'none' : '';
  }

  // =====================================================================
  // Round 2 — department dashboards, role templates, delegation
  // (20260927_01_round2_templates_delegation_dashboards.sql)
  // =====================================================================

  // ---- Dashboard on the staff home ------------------------------------
  async function staffRenderDashboard(target){
    const host = document.createElement('div');
    host.className = 'stf-dash';
    const first = target.querySelector('.card');
    if(first && first.nextSibling) target.insertBefore(host, first.nextSibling); else target.appendChild(host);
    let rows = null;
    try{ const { data, error } = await db.rpc('dept_dashboard'); if(!error) rows = data; }catch(e){}
    if(!Array.isArray(rows) || !rows.length){ host.remove(); return; }
    await staffLoadDirectory();
    const byDept = {};
    rows.forEach(r=> (byDept[r.dept] = byDept[r.dept] || []).push(r));
    host.innerHTML = stf.departments.filter(d=> byDept[d.id]).map(d=>
      '<div class="card stf-dash-card"><div class="card-head"><span>' + escapeHtml(d.name) + '</span></div><div class="card-body stf-dash-grid">' +
      byDept[d.id].map(r=>{
        const val = (r.value != null ? Number(r.value).toLocaleString('en-PH') : '') + (r.of != null ? '<small> / ' + Number(r.of).toLocaleString('en-PH') + '</small>' : '');
        const money = r.money != null ? '<div class="stf-dash-money">' + staffFmtPeso(r.money) + '</div>' : '';
        const openable = STAFF_READY_MODULES.includes(r.module) && can(r.module, 'view');
        return '<button type="button" class="stf-dash-tile' + (r.tone === 'warn' ? ' warn' : '') + '"' + (openable ? ' data-open="' + escapeHtml(r.module) + '"' : ' disabled') + '>' +
          '<div class="stf-dash-val">' + (val || money) + '</div>' + (val ? money : '') +
          '<div class="stf-dash-label">' + escapeHtml(r.label) + '</div></button>';
      }).join('') + '</div></div>').join('');
  }

  // ---- Role templates (Super Admin) -----------------------------------
  let stfTpl = null;   // { id, name, description, depts:{id:true}, grants:{module:{level, limit}} }

  function staffTemplatePickerHtml(s){
    if(!stf.round2 || !stf.templates.length || !s.id) return '';
    const linked = stf.links[s.id] ? stf.templates.find(t=> t.id === stf.links[s.id]) : null;
    return '<div class="stf-tpl-pick">' +
      (linked ? '<div class="stf-tpl-linked">Kept in sync with the <b>' + escapeHtml(linked.name) + '</b> template. Changing access below by hand unlinks it.</div>' : '') +
      '<div class="stf-toolbar" style="margin:0 0 6px;"><select data-f="tpl"><option value="">Apply a role template\u2026</option>' +
      stf.templates.map(t=> '<option value="' + t.id + '">' + escapeHtml(t.name) + '</option>').join('') + '</select>' +
      '<label class="sp-check"><input type="checkbox" data-f="tpllink" checked> keep in sync</label>' +
      '<button type="button" class="btn btn-secondary" data-act="applytpl">Apply</button></div>' +
      (s.supervisorId ? '<div class="stf-hint">Cut down automatically to the Head\u2019s own access.</div>' : '') +
    '</div>';
  }

  async function staffApplyTemplateFromEditor(target){
    const sel = target.querySelector('[data-f="tpl"]'); const link = target.querySelector('[data-f="tpllink"]');
    if(!sel || !sel.value){ toast('Choose a template'); return; }
    const t = stf.templates.find(x=> x.id === sel.value);
    if(!(await uiConfirm('Replace ' + stfEd.name + '\u2019s departments and pages with the \u201C' + t.name + '\u201D template?' +
        (link && link.checked ? ' Later changes to the template will update them too.' : ''), { ok:'Apply template' }))) return;
    const { error } = await db.rpc('template_apply', { p_user: stfEd.id, p_template: t.id, p_link: !!(link && link.checked) });
    if(error){ toast(describeCloudError ? describeCloudError(error) : error.message); return; }
    toast('Template applied');
    await staffLoadDirectory(true);
    staffOpenEditor(stfEd.id);
  }

  async function staffOpenTemplates(){
    showStaffView('templates');
    await staffLoadDirectory(true);
    const target = $('staffPanel_templates');
    const count = (id)=> Object.values(stf.links).filter(x=> x === id).length;
    target.innerHTML =
      '<button type="button" class="btn btn-secondary stf-back" data-act="back">\u2190 Department Staff</button>' +
      '<div class="card"><div class="card-body">' +
        '<p class="stf-note" style="margin-top:0;">A role template is a saved set of departments and page levels. Apply one when adding someone; people kept in sync update automatically when you change the template. Sub-users always get it cut down to their Head\u2019s own access.</p>' +
        '<div class="stf-toolbar"><button type="button" class="btn btn-primary" data-act="new">+ New Template</button></div>' +
        '<div class="stf-list">' + (stf.templates.length ? stf.templates.map(t=>
          '<button type="button" class="stf-person" data-tpl="' + t.id + '"><span class="stf-avatar">\u2630</span>' +
          '<span class="stf-person-main"><span class="stf-person-name">' + escapeHtml(t.name) + '</span>' +
          '<span class="stf-person-sub">' + (t.access || []).length + ' pages \u00B7 ' + count(t.id) + ' ' + (count(t.id) === 1 ? 'person' : 'people') + ' in sync' +
          (t.description ? ' \u00B7 ' + escapeHtml(t.description) : '') + '</span></span><span class="stf-chev">\u203A</span></button>').join('')
          : '<div class="empty-state">No templates yet.</div>') + '</div>' +
      '</div></div>';
    target.querySelector('[data-act="back"]').addEventListener('click', ()=> staffOpenTeamList());
    target.querySelector('[data-act="new"]').addEventListener('click', ()=> staffOpenTemplateEditor(null));
    target.querySelectorAll('[data-tpl]').forEach(b=> b.addEventListener('click', ()=> staffOpenTemplateEditor(b.getAttribute('data-tpl'))));
  }

  function staffOpenTemplateEditor(id){
    const t = id ? stf.templates.find(x=> x.id === id) : null;
    stfTpl = { id: t ? t.id : null, name: t ? t.name : '', description: t ? t.description : '', depts:{}, grants:{} };
    (t ? t.departments : []).forEach(d=> stfTpl.depts[d] = true);
    (t ? t.access : []).forEach(a=> stfTpl.grants[a.module] = { level: a.level, limit: a.approve_limit != null ? String(a.approve_limit) : '' });
    showStaffView('templates');
    staffRenderTemplateEditor();
  }

  function staffRenderTemplateEditor(){
    const t = stfTpl, target = $('staffPanel_templates');
    const inSync = t.id ? Object.values(stf.links).filter(x=> x === t.id).length : 0;
    target.innerHTML =
      '<button type="button" class="btn btn-secondary stf-back" data-act="back">\u2190 Role Templates</button>' +
      '<div class="card"><div class="card-head"><span>' + (t.id ? 'Template' : 'New template') + '</span></div><div class="card-body">' +
        '<div class="field"><label>Name</label><input type="text" data-f="name" value="' + escapeHtml(t.name) + '" placeholder="e.g. Purchasing Clerk"></div>' +
        '<div class="field"><label>Description <span class="stf-hint">optional</span></label><input type="text" data-f="desc" value="' + escapeHtml(t.description) + '"></div>' +
      '</div></div>' +
      '<div class="card"><div class="card-head"><span>Departments &amp; pages</span></div><div class="card-body">' +
        stf.departments.map(d=>{
          const on = !!t.depts[d.id];
          const rows = stf.modules.filter(m=> m.department === d.id).map(m=>{
            const g = t.grants[m.key] || { level:'', limit:'' };
            return '<div class="stf-mod" data-mod="' + escapeHtml(m.key) + '"><div class="stf-mod-top"><span class="stf-mod-name">' + escapeHtml(m.label) + '</span>' +
              staffLevelControl(m, g, null) + '</div>' +
              (g.level === 'approve' && m.has_limit ? '<div class="stf-mod-extra"><label>Approve up to \u20B1<input type="number" min="0" step="0.01" data-f="limit" value="' + escapeHtml(g.limit) + '" placeholder="no limit"></label></div>' : '') +
            '</div>';
          }).join('');
          return '<div class="stf-dept' + (on ? ' on' : '') + '" data-dept="' + d.id + '"><label class="stf-dept-head"><input type="checkbox" data-f="member"' + (on ? ' checked' : '') + '> <span>' + escapeHtml(d.name) + '</span></label>' +
            (on ? '<div class="stf-mods">' + rows + '</div>' : '') + '</div>';
        }).join('') +
      '</div></div>' +
      (inSync ? '<p class="stf-note">Saving updates the ' + inSync + ' ' + (inSync === 1 ? 'person' : 'people') + ' kept in sync with this template.</p>' : '') +
      '<div class="stf-save-bar"><button type="button" class="btn btn-primary" data-act="save">' + (t.id ? 'Save Template' : 'Create Template') + '</button></div>' +
      (t.id ? '<button type="button" class="btn btn-secondary stf-danger" data-act="delete" style="width:100%;">Delete template</button>' : '');
    const sync = ()=>{
      t.name = target.querySelector('[data-f="name"]').value; t.description = target.querySelector('[data-f="desc"]').value;
      target.querySelectorAll('.stf-mod').forEach(r=>{ const k = r.dataset.mod, l = r.querySelector('[data-f="limit"]'); if(l && t.grants[k]) t.grants[k].limit = l.value; });
    };
    target.querySelector('[data-act="back"]').addEventListener('click', ()=> staffOpenTemplates());
    target.querySelectorAll('.stf-dept [data-f="member"]').forEach(cb=> cb.addEventListener('change', ()=>{
      sync(); const id = cb.closest('.stf-dept').dataset.dept;
      if(cb.checked) t.depts[id] = true; else { delete t.depts[id]; stf.modules.filter(m=> m.department === id).forEach(m=> delete t.grants[m.key]); }
      staffRenderTemplateEditor();
    }));
    target.querySelectorAll('.stf-mod .stf-seg-btn').forEach(btn=> btn.addEventListener('click', ()=>{
      sync(); const k = btn.closest('.stf-mod').dataset.mod, lv = btn.dataset.level;
      if(!lv) delete t.grants[k]; else t.grants[k] = Object.assign({ limit:'' }, t.grants[k] || {}, { level: lv });
      staffRenderTemplateEditor();
    }));
    target.querySelector('[data-act="save"]').addEventListener('click', async ()=>{
      sync();
      if(!t.name.trim()){ toast('Give the template a name'); return; }
      const depts = Object.keys(t.depts);
      const access = Object.keys(t.grants).filter(k=>{ const m = stfModule(k); return m && t.depts[m.department] && t.grants[k].level; })
        .map(k=> ({ module:k, level:t.grants[k].level, approve_limit: t.grants[k].limit === '' ? null : Number(t.grants[k].limit) }));
      if(!depts.length){ toast('Tick at least one department'); return; }
      const { data, error } = await db.rpc('template_save', { p_id: t.id, p_name: t.name.trim(), p_description: t.description.trim(), p_departments: depts, p_access: access });
      if(error){ toast(error.message || 'Could not save'); return; }
      toast(t.id ? 'Template saved' : 'Template created');
      await staffLoadDirectory(true);
      staffOpenTemplateEditor(data || t.id);
    });
    const del = target.querySelector('[data-act="delete"]');
    if(del) del.addEventListener('click', async ()=>{
      if(!(await uiConfirm('Delete the \u201C' + t.name + '\u201D template? People keep the access they have now; they just stop being kept in sync.', { ok:'Delete', danger:true }))) return;
      const { error } = await db.rpc('template_delete', { p_id: t.id });
      if(error){ toast(error.message); return; }
      toast('Template deleted'); await staffLoadDirectory(true); staffOpenTemplates();
    });
  }

  // ---- Approved leave → offer to hand over approvals (Heads) ----------
  // Shown on a Head's home when they have approved leave coming up (or
  // under way) that no delegation covers yet.
  let stfDelegPrefill = null;
  async function staffRenderLeaveHandover(target){
    if(!isStaffUser()) return;
    let rows = [];
    try{
      const { data, error } = await db.from('leave_requests').select('id, status, data')
        .eq('technician_id', currentUser.id).eq('status', 'approved');
      if(error) return;
      rows = data || [];
    }catch(e){ return; }
    if(!rows.length) return;
    await staffLoadDirectory();
    if(!stf.round2) return;
    const today = staffDateOf(new Date().toISOString());
    const d0 = (r)=> (r.data && (r.data.dateFrom || r.data.from)) || '';
    const d1 = (r)=> (r.data && (r.data.dateTo || r.data.to || r.data.dateFrom || r.data.from)) || '';
    const mine = stf.delegations.filter(d=> d.from_user === currentUser.id);
    const open = rows.filter(r=> d0(r) && d1(r) >= today)
      .filter(r=> !mine.some(d=> d.starts_on <= (d0(r) < today ? today : d0(r)) && d.ends_on >= d1(r)))
      .sort((a, b)=> d0(a).localeCompare(d0(b)));
    if(!open.length) return;
    const hasApprove = Object.values(stf.access[currentUser.id] || {}).some(a=> a.level === 3);
    const hasTeam = stf.people.some(p=> p.supervisor_id === currentUser.id && p.active);
    if(!hasApprove || !hasTeam) return;
    const r = open[0];
    const fmt = (d)=> staffFmtDate(d + 'T12:00:00+08:00');
    const el = document.createElement('div');
    el.className = 'stf-handover';
    el.innerHTML = '<div><b>Your ' + escapeHtml((r.data && r.data.leaveType) || 'leave') + ' (' + escapeHtml(fmt(d0(r))) + (d1(r) !== d0(r) ? ' \u2013 ' + escapeHtml(fmt(d1(r))) : '') + ') is approved.</b>' +
      '<div class="stf-hint" style="margin:2px 0 0;">Nobody is covering your approvals for those dates yet.</div></div>' +
      '<button type="button" class="btn btn-primary">Hand over approvals</button>';
    el.querySelector('button').addEventListener('click', ()=>{
      stfDelegPrefill = { from: d0(r) < today ? today : d0(r), to: d1(r), note: ((r.data && r.data.leaveType) || 'Leave') };
      staffOpenTeam();
    });
    const first = target.querySelector('.card');
    if(first) target.insertBefore(el, first); else target.prepend(el);
  }

  // ---- Delegation while away (Heads) ----------------------------------
  // fromId: whose approvals are handed over (default: me, as a Head).
  // The Super Admin can set one up for any Head from that Head's account
  // page, to any other active staff member.
  function staffRenderDelegationCard(teamTarget, fromId, redraw){
    const me = fromId || currentUser.id;
    const asAdmin = currentUser.role === 'admin';
    redraw = redraw || (()=> staffRenderTeam());
    const subs = asAdmin ? stf.people.filter(p=> p.active && p.id !== me)
                         : stf.people.filter(p=> p.supervisor_id === me && p.active);
    const mine = Object.values(stf.access[me] || {}).filter(a=> a.level === 3 && (!a.expires_at || new Date(a.expires_at) > new Date()));
    const list = stf.delegations.filter(d=> d.from_user === me && d.ends_on >= staffDateOf(new Date().toISOString()));
    const card = document.createElement('div');
    card.className = 'card';
    const nameOf = (id)=> (stfPerson(id) || {}).name || '';
    const who = asAdmin ? ((stfPerson(me) || {}).name || 'this Head') : 'you';
    card.innerHTML = '<div class="card-head"><span>Delegate while away</span></div><div class="card-body">' +
      '<p class="stf-note" style="margin-top:0;">' + (asAdmin
        ? 'Let someone approve for ' + escapeHtml(who) + ' between two dates \u2014 with ' + escapeHtml(who) + '\u2019s peso limits, and never their own records. It switches off by itself after the end date.'
        : 'Going on leave or out to site? Let one of your sub-users approve for you between two dates \u2014 with your peso limits, and never their own records. It switches off by itself after the end date.') + '</p>' +
      (list.length ? '<div class="stf-list" style="margin-bottom:10px;">' + list.map(d=>
        '<div class="stf-deleg-row"><div><b>' + escapeHtml(nameOf(d.to_user)) + '</b> \u00B7 ' + escapeHtml(staffFmtDate(d.starts_on + 'T12:00:00+08:00')) + ' \u2013 ' + escapeHtml(staffFmtDate(d.ends_on + 'T12:00:00+08:00')) +
        '<div class="stf-hint" style="margin:0;">' + d.modules.map(m=> escapeHtml((stfModule(m) || {}).label || m)).join(', ') + (d.note ? ' \u00B7 ' + escapeHtml(d.note) : '') + '</div></div>' +
        '<button type="button" class="btn btn-secondary stf-danger" data-revoke="' + d.id + '">End now</button></div>').join('') + '</div>' : '') +
      (!mine.length ? '<div class="stf-hint">' + (asAdmin ? escapeHtml(who) + ' has no pages at Approve' : 'You don\u2019t have any pages at Approve') + ', so there\u2019s nothing to delegate.</div>'
       : !subs.length ? '<div class="stf-hint">' + (asAdmin ? 'No other active staff to delegate to.' : 'Add a sub-user first \u2014 you can delegate only to your own team.') + '</div>'
       : '<div class="stf-deleg-form">' +
          '<div class="field"><label>Who covers for you</label><select data-f="dto">' + subs.map(p=> '<option value="' + p.id + '">' + escapeHtml(p.name) + '</option>').join('') + '</select></div>' +
          '<div class="stf-pw-row"><div class="field" style="flex:1;"><label>From</label><input type="date" data-f="dfrom" value="' + staffDateOf(new Date().toISOString()) + '"></div>' +
          '<div class="field" style="flex:1;"><label>Until</label><input type="date" data-f="dto2"></div></div>' +
          '<div class="field"><label>Approvals to hand over</label>' + mine.map(a=>
            '<label class="sp-check" style="display:flex; margin:4px 0;"><input type="checkbox" data-dmod="' + escapeHtml(a.module_key) + '" checked> ' + escapeHtml((stfModule(a.module_key) || {}).label || a.module_key) +
            (a.approve_limit != null ? ' <span class="stf-hint">up to ' + staffFmtPeso(a.approve_limit) + '</span>' : '') + '</label>').join('') + '</div>' +
          '<div class="field"><label>Note <span class="stf-hint">optional</span></label><input type="text" data-f="dnote" placeholder="e.g. Sick leave, site visit in Tiaong"></div>' +
          '<button type="button" class="btn btn-primary" data-act="delegate" style="width:100%;">Delegate</button></div>') +
    '</div>';
    teamTarget.appendChild(card);
    // Came here from "Hand over approvals" on an approved leave: fill in its dates
    if(stfDelegPrefill && !asAdmin && card.querySelector('[data-f="dfrom"]')){
      card.querySelector('[data-f="dfrom"]').value = stfDelegPrefill.from;
      card.querySelector('[data-f="dto2"]').value = stfDelegPrefill.to;
      card.querySelector('[data-f="dnote"]').value = stfDelegPrefill.note;
      stfDelegPrefill = null;
      setTimeout(()=> card.scrollIntoView({ behavior:'smooth', block:'start' }), 50);
    }
    card.querySelectorAll('[data-revoke]').forEach(b=> b.addEventListener('click', async ()=>{
      if(!(await uiConfirm('End this delegation now?', { ok:'End now', danger:true }))) return;
      const { error } = await db.rpc('delegation_revoke', { p_id: b.dataset.revoke });
      if(error){ toast(error.message); return; }
      toast('Delegation ended'); await staffLoadDirectory(true); redraw();
    }));
    const go = card.querySelector('[data-act="delegate"]');
    if(go) go.addEventListener('click', async ()=>{
      const to = card.querySelector('[data-f="dto"]').value, from = card.querySelector('[data-f="dfrom"]').value, until = card.querySelector('[data-f="dto2"]').value;
      const mods = [...card.querySelectorAll('[data-dmod]:checked')].map(x=> x.dataset.dmod);
      if(!from || !until){ toast('Choose the dates'); return; }
      if(!mods.length){ toast('Tick at least one approval to hand over'); return; }
      const args = { p_to: to, p_starts: from, p_ends: until, p_modules: mods, p_note: card.querySelector('[data-f="dnote"]').value.trim() };
      if(asAdmin) args.p_from = me;
      const { error } = await db.rpc('delegation_create', args);
      if(error){ toast(error.message); return; }
      toast('Delegated to ' + ((stfPerson(to) || {}).name || 'your sub-user'));
      await staffLoadDirectory(true); redraw();
    });
  }

  // =====================================================================
  // Round 3 — Inbox with overdue escalation (20260928_01_round3_inbox_escalation.sql)
  // =====================================================================
  const STF_INBOX_DEPT = { purchasing:'Purchasing', finance:'Accounting & Finance', hr:'Human Resources', administration:'Administration', operations:'Operations' };
  const stfInbox = { items:[], filter:'all', loaded:false, ok:false };

  function staffFmtWait(h){
    h = Number(h) || 0;
    if(h < 1) return Math.max(1, Math.round(h * 60)) + ' min';
    if(h < 48) return Math.round(h) + ' h';
    return Math.round(h / 24) + ' days';
  }
  async function staffLoadInbox(){
    try{
      const { data, error } = await db.rpc('inbox_items');
      if(error){ stfInbox.ok = false; stfInbox.items = []; return false; }
      stfInbox.items = Array.isArray(data) ? data : [];
      stfInbox.ok = true;
    }catch(e){ stfInbox.ok = false; stfInbox.items = []; }
    stfInbox.loaded = true;
    staffInboxBadge();
    return stfInbox.ok;
  }
  function staffInboxBadge(){
    const n = stfInbox.items.filter(x=> x.state !== 'waiting').length;
    ['staffNavInbox', 'menuInbox'].forEach(id=>{
      const el = $(id); if(!el) return;
      let b = el.querySelector('.stf-badge');
      if(!b){ b = document.createElement('span'); b.className = 'stf-badge'; el.appendChild(b); }
      b.textContent = n > 99 ? '99+' : String(n);
      b.style.display = n ? '' : 'none';
    });
  }
  function staffInboxRowHtml(x){
    const dept = STF_INBOX_DEPT[x.department] || x.department;
    return '<button type="button" class="stf-inbox-row stf-inbox-' + x.state + '" data-open="' + escapeHtml(x.module) + '">' +
      '<span class="stf-inbox-dot"></span>' +
      '<span class="stf-inbox-main"><span class="stf-inbox-label">' + escapeHtml(x.label) + (x.ref_label ? ' \u00B7 <b>' + escapeHtml(x.ref_label) + '</b>' : '') + '</span>' +
      '<span class="stf-inbox-title">' + escapeHtml(x.title || '') + '</span>' +
      '<span class="stf-inbox-meta">' + escapeHtml(dept) + '</span></span>' +
      '<span class="stf-inbox-age">' + escapeHtml(staffFmtWait(x.age_hours)) +
      '<small>' + (x.state === 'escalated' ? 'escalated' : x.state === 'overdue' ? 'overdue' : 'waiting') + '</small></span></button>';
  }

  // Summary card at the top of the staff home
  async function staffRenderInboxSummary(target){
    if(!(await staffLoadInbox()) || !stfInbox.items.length) { if(stfInbox.ok) staffRenderPushPrompt(target); return; }
    const esc = stfInbox.items.filter(x=> x.state === 'escalated').length;
    const ovd = stfInbox.items.filter(x=> x.state === 'overdue').length;
    const card = document.createElement('div');
    card.className = 'card stf-inbox-card';
    card.innerHTML = '<div class="card-head"><span>Inbox</span></div><div class="card-body">' +
      '<div class="stf-inbox-counts">' +
        (esc ? '<span class="stf-count-pill esc">' + esc + ' escalated</span>' : '') +
        (ovd ? '<span class="stf-count-pill ovd">' + ovd + ' overdue</span>' : '') +
        '<span class="stf-count-pill">' + stfInbox.items.length + ' waiting on you</span></div>' +
      '<div class="stf-inbox-list">' + stfInbox.items.slice(0, 3).map(staffInboxRowHtml).join('') + '</div>' +
      '<button type="button" class="btn btn-secondary" data-act="inbox" style="width:100%; margin-top:8px;">Open Inbox</button></div>';
    const first = target.querySelector('.card');
    if(first && first.nextSibling) target.insertBefore(card, first.nextSibling); else target.appendChild(card);
    card.querySelector('[data-act="inbox"]').addEventListener('click', ()=> staffOpenInbox());
    staffRenderPushPrompt(target);
  }

  // Staff devices: offer to turn on notifications (escalations arrive by push)
  function staffRenderPushPrompt(target){
    if(!isStaffUser() || typeof pushSupported !== 'function' || !pushSupported()) return;
    if(Notification.permission !== 'default' || (typeof pushPromptSnoozed === 'function' && pushPromptSnoozed())) return;
    const el = document.createElement('div');
    el.className = 'stf-handover';
    el.innerHTML = '<div><b>Turn on notifications</b><div class="stf-hint" style="margin:2px 0 0;">Get told when work in your Inbox is overdue, even with the app closed.</div></div>' +
      '<button type="button" class="btn btn-primary">Turn on</button>';
    el.querySelector('button').addEventListener('click', async ()=>{
      await pushRequestPermission();   // shows its own message
      el.remove();
    });
    target.appendChild(el);
  }

  async function staffOpenInbox(){
    showStaffView('inbox');
    const target = $('staffPanel_inbox');
    target.innerHTML = '<div class="empty-state">Loading\u2026</div>';
    const ok = await staffLoadInbox();
    if(!ok){ target.innerHTML = '<div class="empty-state">The Inbox isn\u2019t set up yet (run the 20260928_01 migration).</div>'; return; }
    staffRenderInbox();
  }

  function staffRenderInbox(){
    const target = $('staffPanel_inbox');
    const all = stfInbox.items;
    const depts = [...new Set(all.map(x=> x.department))];
    const f = stfInbox.filter;
    const list = all.filter(x=> f === 'all' ? true : f === 'attention' ? x.state !== 'waiting' : x.department === f);
    const chip = (key, label, n)=> '<button type="button" class="stf-chip-btn' + (f === key ? ' on' : '') + '" data-filter="' + key + '">' + escapeHtml(label) + (n != null ? ' <b>' + n + '</b>' : '') + '</button>';
    target.innerHTML =
      '<div class="card"><div class="card-body">' +
        '<p class="stf-note" style="margin-top:0;">Everything waiting on a page you can act on, oldest and most urgent first. Items turn <b>overdue</b> after their response time and <b>escalate</b> to the department Head (then the Super Admin) if they wait longer.</p>' +
        '<div class="stf-chips-row">' + chip('all', 'All', all.length) + chip('attention', 'Needs attention', all.filter(x=> x.state !== 'waiting').length) +
          depts.map(d=> chip(d, STF_INBOX_DEPT[d] || d, all.filter(x=> x.department === d).length)).join('') + '</div>' +
        '<div class="stf-inbox-list">' + (list.length ? list.map(staffInboxRowHtml).join('') : '<div class="empty-state">Nothing waiting \u2014 all caught up.</div>') + '</div>' +
        (currentUser.role === 'admin' ? '<button type="button" class="btn btn-secondary" data-act="sla" style="width:100%; margin-top:10px;">Response times\u2026</button>' : '') +
      '</div></div>';
    target.querySelectorAll('[data-filter]').forEach(b=> b.addEventListener('click', ()=>{ stfInbox.filter = b.dataset.filter; staffRenderInbox(); }));
    target.querySelectorAll('[data-open]').forEach(b=> b.addEventListener('click', ()=> staffOpenModule(b.dataset.open)));
    const sla = target.querySelector('[data-act="sla"]'); if(sla) sla.addEventListener('click', ()=> staffOpenSla());
  }

  async function staffOpenSla(){
    const target = $('staffPanel_inbox');
    const { data, error } = await db.from('inbox_sla').select('*').order('sort');
    if(error){ toast('Could not load response times'); return; }
    target.innerHTML =
      '<button type="button" class="btn btn-secondary stf-back" data-act="back">\u2190 Inbox</button>' +
      '<div class="card"><div class="card-head"><span>Response times</span></div><div class="card-body">' +
        '<p class="stf-note" style="margin-top:0;">For each kind of work: after how many hours it shows as <b>overdue</b>, and after how many it <b>escalates</b> \u2014 the department\u2019s Heads are notified, and you at twice that. Untick to leave a kind out of every inbox.</p>' +
        (data || []).map(r=>
          '<div class="stf-sla-row" data-kind="' + escapeHtml(r.kind) + '">' +
            '<label class="sp-check stf-sla-name"><input type="checkbox" data-f="active"' + (r.active ? ' checked' : '') + '> ' + escapeHtml(r.label) +
              ' <span class="stf-hint">' + escapeHtml(STF_INBOX_DEPT[r.department] || r.department) + '</span></label>' +
            '<label>Overdue after <input type="number" min="0" step="1" data-f="warn" value="' + Number(r.warn_hours) + '"> h</label>' +
            '<label>Escalate after <input type="number" min="0" step="1" data-f="esc" value="' + Number(r.escalate_hours) + '"> h</label>' +
          '</div>').join('') +
        '<button type="button" class="btn btn-primary" data-act="savesla" style="width:100%; margin-top:10px;">Save response times</button>' +
      '</div></div>';
    target.querySelector('[data-act="back"]').addEventListener('click', ()=> staffOpenInbox());
    target.querySelector('[data-act="savesla"]').addEventListener('click', async ()=>{
      const rows = [...target.querySelectorAll('.stf-sla-row')];
      const orig = {}; (data || []).forEach(r=> orig[r.kind] = r);
      let changed = 0;
      for(const row of rows){
        const k = row.dataset.kind, o = orig[k];
        const w = Number(row.querySelector('[data-f="warn"]').value), e = Number(row.querySelector('[data-f="esc"]').value);
        const act = row.querySelector('[data-f="active"]').checked;
        if(!(w >= 0) || !(e >= w)){ toast(o.label + ': escalation must be at least the overdue time'); return; }
        if(w === Number(o.warn_hours) && e === Number(o.escalate_hours) && act === !!o.active) continue;
        const { error: sErr } = await db.rpc('inbox_sla_save', { p_kind: k, p_warn: w, p_escalate: e, p_active: act });
        if(sErr){ toast(sErr.message); return; }
        changed++;
      }
      toast(changed ? 'Saved ' + changed + ' change' + (changed === 1 ? '' : 's') : 'No changes');
      staffOpenInbox();
    });
  }

  // A notification tap opens the app at ?inbox=1 → straight to the Inbox
  function staffMaybeOpenInboxFromUrl(){
    try{
      const u = new URL(location.href);
      if(u.searchParams.get('inbox') !== '1') return false;
      u.searchParams.delete('inbox');
      history.replaceState(null, '', u.pathname + (u.search ? u.search : '') + u.hash);
      if(currentUser && (currentUser.role === 'admin' || isStaffUser())){ staffOpenInbox(); return true; }
    }catch(e){}
    return false;
  }

  // ---------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------
  (function staffWire(){
    const bind = (id, fn)=>{ const el = $(id); if(el) el.addEventListener('click', ()=>{ closeMainMenu(); fn(); }); };
    bind('menuManageStaff', ()=> staffOpenTeam());
    bind('menuActivityLog', ()=> staffOpenActivity());
    bind('staffNavTeam', ()=> staffOpenTeam());
    bind('staffNavActivity', ()=> staffOpenActivity());
    bind('staffNavPassword', ()=> showChangePasswordScreen(false));
    bind('staffNavMyLeave', ()=>{ showLeaveView(true); setSidebarActive('staffNavMyLeave'); });
    bind('staffNavInbox', ()=> staffOpenInbox());
    bind('menuInbox', ()=> staffOpenInbox());
    const pages = $('staffNavPages');
    if(pages) pages.addEventListener('click', (e)=>{
      const b = e.target.closest('[data-staff-open]');
      if(!b) return;
      closeMainMenu();
      staffOpenModule(b.getAttribute('data-staff-open'));
    });
    const home = $('staffPanel_home');
    if(home) home.addEventListener('click', (e)=>{
      const row = e.target.closest('[data-open]');
      if(row) staffOpenModule(row.getAttribute('data-open'));
    });
    staffWatchOtherViews();
  })();

  // Each opened page → the screen that already shows it.
  function staffNavId(key){ return 'staffNavMod_' + String(key).replace(/[^a-z0-9]/gi, '_'); }
  const STAFF_MODULE_OPENERS = {
    'pur.materials':       ()=> showPurchasingView('materials'),
    'pur.suppliers':       ()=> showPurchasingView('suppliers'),
    'pur.requisitions':    ()=> showPurchasingView('requisitions'),
    'pur.purchase_orders': ()=> showPurchasingView('purchaseOrders'),
    // Without "See peso values", Stock on Hand is the quantities-only screen
    // storekeepers use (all warehouses for staff).
    'inv.stock':           ()=> showPurchasingView(staffSeesCosts() ? 'stock' : 'myStock'),
    'inv.warehouses':      ()=> showPurchasingView('warehouses'),
    'inv.receive':         ()=> showPurchasingView('receive'),
    'inv.issue':           ()=> showPurchasingView('issue'),
    'inv.returns':         ()=> showPurchasingView('returns'),
    'inv.transfers':       ()=> showPurchasingView('transfers'),
    'inv.slips':           ()=> showPurchasingView('slips'),
    'inv.reports':         ()=> showPurchasingView('invReports'),
    // Advances and the liquidations inside them share the Requests list
    'fin.cash_advance':    async ()=>{ await showCashAdvanceView(); caShowAdminSection('requests'); },
    // Liquidation lands on the liquidations waiting for review
    'fin.liquidation':     async ()=>{
      await showCashAdvanceView(); caShowAdminSection('requests');
      const f = document.querySelector('#caAdminFilterRow [data-filter="toReviewLiq"]'); if(f) f.click();
    },
    'fin.reimbursement':   async ()=>{ await showCashAdvanceView(); caShowAdminSection('reimb'); },
    // Attendance and Technician Profiles both start from the technician
    // list on the Online DTR page (profiles open from "View Profile").
    'hr.attendance':       ()=> showDtrView(),
    'hr.tech_profiles':    ()=> showDtrView(),
    'hr.leaves':           ()=> showLeaveView(),
    'adm.customers':       ()=>{ admApplyStaffMode(); showCustomersManagerView(); },
    'adm.equipment':       ()=>{ admApplyStaffMode(); showEquipmentManagerView(); },
    'adm.announcements':   ()=>{ admApplyStaffMode(); annOpenAdmin(); },
    'adm.dropdowns':       ()=>{ admApplyStaffMode(); openManageLists(); },
    'ops.dispatch':        ()=>{ opsApplyStaffMode(); showDispatchView(); },
    'ops.service_requests':()=>{ opsApplyStaffMode(); showServiceRequestsView(); srAdminInit(); },   // srAdminInit: live-refreshing queue
    'ops.service_reports': ()=>{ opsApplyStaffMode(); showServiceReportsManagerView(); },
    'ops.past_service':    ()=>{ opsApplyStaffMode(); showServiceReport(); srShowTab('backentry'); },
    'ops.tracker':         ()=> staffOpenTracker(),
    'ops.projects':        ()=> showPurchasingView('projects'),
    'tools.register':      ()=> showPurchasingView('tlRegister'),
    'tools.issue':         ()=> showPurchasingView('tlIssue'),
    'tools.return':        ()=> showPurchasingView('tlReturn'),
    'tools.handover':      ()=> showPurchasingView('tlHandover'),
    'tools.defects':       ()=> showPurchasingView('tlDefects'),
    'tools.maintenance':   ()=> showPurchasingView('tlMaint'),
    'tools.slips':         ()=> showPurchasingView('tlSlips'),
    'tools.reports':       ()=> showPurchasingView('tlReports')
  };
  const STAFF_TOOL_KEYS = { tlRegister:'tools.register', tlIssue:'tools.issue', tlReturn:'tools.return', tlHandover:'tools.handover',
    tlDefects:'tools.defects', tlMaint:'tools.maintenance', tlSlips:'tools.slips', tlReports:'tools.reports' };
  function staffToolPageAllowed(key){
    if(key === 'tlHub') return Object.values(STAFF_TOOL_KEYS).some(m=> can(m, 'view'));
    const m = STAFF_TOOL_KEYS[key];
    return !!(m && can(m, 'view'));
  }

  // Live Tracker for staff: the Super Admin's Home holds the one tracker
  // card (map + realtime + poll). Staff borrow it into their own page while
  // they look at it, and it goes back where it came from on logout.
  let stfTrackerHome = null;
  function staffOpenTracker(){
    showStaffView('tracker');
    const card = document.getElementById('homeTrackerCard');
    const panel = $('staffPanel_tracker');
    if(!card || !panel) return;
    if(card.parentNode !== panel){
      stfTrackerHome = { parent: card.parentNode, next: card.nextSibling };
      panel.innerHTML = '';
      panel.appendChild(card);
    }
    card.style.display = '';
    trackerAdminInit();
  }
  function staffTrackerUnmount(){
    const card = document.getElementById('homeTrackerCard');
    if(card && stfTrackerHome && stfTrackerHome.parent){
      stfTrackerHome.parent.insertBefore(card, stfTrackerHome.next);
      card.style.display = 'none';
    }
    stfTrackerHome = null;
    if(typeof trackerAdminTeardown === 'function') trackerAdminTeardown();
  }
  // Dispatch: who sees the office side, and who may act on job orders
  function dtIsDispatcher(){ return !!currentUser && (currentUser.role === 'admin' || (isStaffUser() && can('ops.dispatch', 'view'))); }
  function dtCanDispatch(){ return !!currentUser && (currentUser.role === 'admin' || (isStaffUser() && can('ops.dispatch', 'edit'))); }
  // Service requests: office side / may act
  function srIsOffice(){ return !!currentUser && (currentUser.role === 'admin' || (isStaffUser() && can('ops.service_requests', 'view'))); }
  function srCanManage(){ return !!currentUser && (currentUser.role === 'admin' || (isStaffUser() && can('ops.service_requests', 'edit'))); }
  function opsApplyStaffMode(){
    const staff = isStaffUser(), cls = document.body.classList;
    cls.toggle('stf-ro-dt',  staff && !can('ops.dispatch', 'edit'));
    cls.toggle('stf-ro-srq', staff && !can('ops.service_requests', 'edit'));
    cls.toggle('stf-ro-srm', staff && !can('ops.service_reports', 'edit'));
  }
  // Administration pages a staff member can only view hide their write
  // controls (stf-ro-* rules in app.css); the database refuses them anyway.
  function admApplyStaffMode(){
    const staff = isStaffUser(), cls = document.body.classList;
    cls.toggle('stf-ro-cust', staff && !can('adm.customers', 'edit'));
    cls.toggle('stf-ro-equip', staff && !can('adm.equipment', 'edit') && !can('adm.customers', 'edit'));
  }
  // Online DTR / Leave / technician profile: who sees the reviewer side
  function hrIsReviewer(module){
    if(!currentUser) return false;
    if(currentUser.role === 'admin') return true;
    if(!isStaffUser()) return false;
    return module ? can(module, 'view') : (can('hr.attendance', 'view') || can('hr.tech_profiles', 'view'));
  }
  function hrApplyStaffMode(){
    const staff = isStaffUser(), cls = document.body.classList;
    cls.toggle('stf-nv-att', staff && !can('hr.attendance', 'view'));
    cls.toggle('stf-nv-tp',  staff && !can('hr.tech_profiles', 'view'));
    cls.toggle('stf-ne-tp',  staff && !can('hr.tech_profiles', 'edit'));
    cls.toggle('stf-na-lv',  staff && !can('hr.leaves', 'approve'));
  }
  // Peso values: Super Admin always; staff with "See peso values".
  function staffSeesCosts(){
    if(!currentUser) return false;
    if(currentUser.role === 'admin') return true;
    return isStaffUser() && !!(currentUser.access && currentUser.access.see_costs);
  }
  function staffOpenModule(key){
    const fn = STAFF_MODULE_OPENERS[key];
    if(typeof fn === 'function' && STAFF_READY_MODULES.includes(key) && can(key, 'view')){
      Promise.resolve(fn()).then(()=> setSidebarActive(staffNavId(key)));
      setSidebarActive(staffNavId(key));
    }else toast('This page isn\u2019t open yet');
  }

  // ---------------------------------------------------------------------
  // Purchasing screens (purchasing.js / purchase-orders.js / requisitions.js)
  // ---------------------------------------------------------------------
  const STAFF_PURCH_KEYS = { suppliers:'pur.suppliers', materials:'pur.materials', requisitions:'pur.requisitions', purchaseOrders:'pur.purchase_orders',
    stock:'inv.stock', myStock:'inv.stock', warehouses:'inv.warehouses', projects:'ops.projects', receive:'inv.receive', issue:'inv.issue',
    returns:'inv.returns', transfers:'inv.transfers', slips:'inv.slips', invReports:'inv.reports' };
  // May this user open purchasing page `key`? (Super Admin: always)
  function purchStaffAllowed(key){
    if(currentUser && currentUser.role === 'admin') return true;
    const m = STAFF_PURCH_KEYS[key];
    return !!(m && isStaffUser() && STAFF_READY_MODULES.includes(m) && can(m, 'view'));
  }
  // View-only pages hide their add/save/delete controls (see the stf-ro-*
  // rules in app.css). The database refuses those writes regardless.
  function purchApplyStaffMode(){
    const staff = isStaffUser();
    const cls = document.body.classList;
    cls.toggle('stf-ro-sup', staff && !can('pur.suppliers', 'edit'));
    cls.toggle('stf-ro-mat', staff && !can('pur.materials', 'edit'));
    cls.toggle('stf-ro-mr',  staff && !can('pur.requisitions', 'edit'));
    cls.toggle('stf-ro-po',  staff && !can('pur.purchase_orders', 'edit'));
    cls.toggle('stf-ro-stock', staff && !(can('inv.stock', 'edit') && staffSeesCosts()));
    cls.toggle('stf-ro-wh',  staff && !can('inv.warehouses', 'edit'));
    cls.toggle('stf-ro-rcv', staff && !can('inv.receive', 'edit'));
    cls.toggle('stf-ro-iss', staff && !can('inv.issue', 'edit'));
    cls.toggle('stf-ro-ret', staff && !can('inv.returns', 'edit'));
    cls.toggle('stf-ro-trf', staff && !can('inv.transfers', 'edit'));
    // Admin-only inventory controls some staff may use (.inv-admin-only)
    cls.toggle('stf-inv-direct', staff && can('inv.receive', 'edit'));
    cls.toggle('stf-inv-money',  staff && staffSeesCosts());
    cls.toggle('stf-inv-makepo', staff && staffSeesCosts() && can('pur.purchase_orders', 'edit'));
    // Projects and Tools & Equipment
    cls.toggle('stf-ro-prj', staff && !can('ops.projects', 'edit'));
    cls.toggle('stf-ro-tlreg', staff && !can('tools.register', 'edit'));
    cls.toggle('stf-ro-tlis', staff && !can('tools.issue', 'edit'));
    cls.toggle('stf-ro-tlrt', staff && !can('tools.return', 'edit'));
    cls.toggle('stf-ro-tlho', staff && !can('tools.handover', 'edit'));
    cls.toggle('stf-ro-tlmt', staff && !can('tools.maintenance', 'edit'));
    // Admin-only tool controls some staff may use (.inv-admin-only)
    cls.toggle('stf-tl-reg', staff && can('tools.register', 'edit'));
    cls.toggle('stf-tl-regmoney', staff && can('tools.register', 'edit') && staffSeesCosts());
    cls.toggle('stf-tl-decide', staff && can('tools.defects', 'edit'));
  }

  // ---------------------------------------------------------------------
  // Approvals by staff: pre-check (readable reason) + password re-entry.
  // The database applies the same rules again when the change is saved.
  // ---------------------------------------------------------------------
  async function staffEnsureReauth(){
    if(!isStaffUser()) return true;
    try{
      const { data, error } = await db.rpc('recently_reauthed', { p_minutes: 4 });
      if(!error && data === true) return true;
    }catch(e){}
    const pw = await askPassword({ title:'Confirm it\u2019s you', label:'Enter your password to approve', placeholder:'Your password' });
    if(!pw) return false;
    const r = await staffInvoke({ action:'reauth', password: pw });
    if(!r.ok){ toast(r.error || 'Incorrect password'); return false; }
    return true;
  }
  async function staffApprovalPrecheck(module, amount, creatorId){
    if(!isStaffUser()) return true;
    let reason = 'ok';
    try{
      const { data, error } = await db.rpc('staff_approval_check', {
        p_module: module, p_amount: amount == null ? null : Number(amount),
        p_creator: creatorId || null, p_require_reauth: false });
      if(!error && data) reason = data;
    }catch(e){}
    if(reason === 'ok') return staffEnsureReauth();
    const m = stfModule(module);
    const what = (m ? m.label : 'record').toLowerCase().replace(/s$/, '');
    const g = ((currentUser.access || {}).access || {})[module] || {};
    toast(reason === 'own_record' ? 'You can\u2019t approve your own ' + what + ' \u2014 another approver has to'
        : reason === 'over_limit' ? 'Above your approval limit of ' + staffFmtPeso(g.approve_limit) + ' \u2014 someone with a higher limit has to approve'
        : 'You don\u2019t have Approve access for this page');
    return false;
  }
