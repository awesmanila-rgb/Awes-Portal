  // =====================================================================
  // Employees › Technicians (20261013_01)
  //
  // The old Users & Roles sheet created technicians; that moved here, next
  // to Office Staff, so every employee account is managed in one place.
  //   Super Admin, or staff with Operations › Technicians:
  //     View — the list; Edit — add, edit, reset password, restrictions,
  //     deactivate / reactivate, clear the DTR device lock.
  //   Account changes go through admin-create-staff (tech_* actions), which
  //   re-checks the access server-side. Storekeeper warehouses stay Super
  //   Admin only. HR keeps the records: Technician Profile opens from here
  //   for anyone with the HR pages.
  // =====================================================================

  const emp = { techs:[], locks:new Set(), inv:null, showInactive:false, q:'', open:null };
  const empCanTechView = ()=> !!currentUser && (currentUser.role === 'admin' || (isStaffUser() && can('ops.technicians', 'view')));
  const empCanTechEdit = ()=> !!currentUser && (currentUser.role === 'admin' || (isStaffUser() && can('ops.technicians', 'edit')));
  const empIsSuper = ()=> !!currentUser && currentUser.role === 'admin';

  // Tab strip shown above Office Staff / Technicians
  function empTabsHtml(active){
    const staffOk = empIsSuper() || staffIsHead();
    if(!(staffOk && empCanTechView())) return '';
    return '<div class="seg-tabs emp-tabs">' +
      '<button type="button" class="seg-tab' + (active === 'staff' ? ' active' : '') + '" data-emp-tab="staff">' + (empIsSuper() ? 'Office Staff' : 'My Team') + '</button>' +
      '<button type="button" class="seg-tab' + (active === 'tech' ? ' active' : '') + '" data-emp-tab="tech">Technicians</button></div>';
  }
  function empBindTabs(target){
    target.querySelectorAll('[data-emp-tab]').forEach(b=> b.addEventListener('click', ()=>{
      stfEmpTab = b.dataset.empTab;
      if(stfEmpTab === 'tech') empRenderTechs(target); else staffRenderTeam();
    }));
  }

  // Opener for staff with Operations › Technicians (sidebar page)
  async function staffOpenTechnicians(){
    if(!empCanTechView()){ toast('You don\u2019t have access to technician accounts'); return; }
    if(currentUser.role === 'admin' && !(await ensureAdminAuthenticated())) return;
    stfEmpTab = 'tech';
    showStaffView('team');
    setHeaderTitle('Employees', 'Technician accounts');
    if(isStaffUser()) setSidebarActive(staffNavId('ops.technicians'));
    const target = $('staffPanel_team');
    target.innerHTML = '<div class="empty-state">Loading\u2026</div>';
    if((empIsSuper() || staffIsHead()) && !(await staffLoadDirectory(true))){ /* office list is optional here */ }
    empRenderTechs(target);
  }

  async function empLoadTechs(){
    const [p, l] = await Promise.all([
      db.from('profiles').select('id, name, username, active, no_history, no_report, read_only').eq('role', 'technician').order('name'),
      db.from('device_locks').select('technician_id')
    ]);
    if(p.error) throw p.error;
    // restrictions live in three profile columns (see cloudSetUser in auth.js)
    emp.techs = (p.data || []).map(t=> Object.assign(t, { restrictions:{ noHistory:!!t.no_history, noReport:!!t.no_report, readOnly:!!t.read_only } }));
    emp.locks = new Set((l.data || []).map(x=> x.technician_id));
    emp.inv = (empIsSuper() && typeof invLoadUsersContext === 'function') ? await invLoadUsersContext().catch(()=> null) : null;
  }

  function empRestrLabel(r){
    r = r || {};
    const f = [];
    if(r.noHistory) f.push('No history'); if(r.noReport) f.push('No reports'); if(r.readOnly) f.push('Read-only');
    return f.join(' \u00B7 ');
  }

  async function empRenderTechs(target, keepOpen){
    target = target || $('staffPanel_team');
    target.innerHTML = empTabsHtml('tech') + '<div class="empty-state">Loading technicians\u2026</div>';
    empBindTabs(target);
    try{ await empLoadTechs(); }
    catch(e){ target.innerHTML = empTabsHtml('tech') + '<div class="empty-state">Couldn\u2019t load technicians: ' + escapeHtml(describeCloudError(e)) + '</div>'; empBindTabs(target); return; }
    const edit = empCanTechEdit();
    const q = emp.q.trim().toLowerCase();
    const rows = emp.techs.filter(t=> (emp.showInactive || t.active !== false) &&
      (!q || [t.name, t.username].some(v=> String(v || '').toLowerCase().includes(q))));
    const activeN = emp.techs.filter(t=> t.active !== false).length;
    target.innerHTML = empTabsHtml('tech') +
      '<div class="card"><div class="card-body">' +
        '<p class="stf-note" style="margin-top:0;">Field technicians (Operations). ' + (edit ? 'Add accounts, set sign-in details and restrictions, and deactivate anyone who leaves.' : 'View only.') +
          ' Attendance, leave, violations and documents are kept by HR in each <b>Technician Profile</b>.</p>' +
        '<div class="stf-toolbar">' +
          (edit ? '<button type="button" class="btn btn-primary" data-emp="add">+ Add Technician</button>' : '') +
          '<input type="search" class="emp-search" data-emp="q" placeholder="Search name or username" value="' + escapeHtml(emp.q) + '">' +
          '<label class="sp-check"><input type="checkbox" data-emp="inactive"' + (emp.showInactive ? ' checked' : '') + '> Show deactivated</label>' +
          '<span class="stf-count">' + activeN + ' active</span>' +
        '</div>' +
        '<div id="empAddBox"></div>' +
        '<div class="stf-list">' + (rows.length ? rows.map(empTechRow).join('') : '<div class="empty-state">' + (emp.techs.length ? 'Nobody matches.' : 'No technicians yet.') + '</div>') + '</div>' +
      '</div></div>';
    empBindTabs(target);
    const addBtn = target.querySelector('[data-emp="add"]');
    if(addBtn) addBtn.addEventListener('click', ()=> empOpenAdd(target));
    const qi = target.querySelector('[data-emp="q"]');
    qi.addEventListener('input', ()=>{ emp.q = qi.value; clearTimeout(qi._t); qi._t = setTimeout(()=>{ empRenderTechsList(target); }, 200); });
    target.querySelector('[data-emp="inactive"]').addEventListener('change', (e)=>{ emp.showInactive = e.target.checked; empRenderTechsList(target); });
    target.querySelectorAll('[data-tech]').forEach(b=> b.addEventListener('click', ()=> empOpenTech(target, b.dataset.tech)));
    if(keepOpen) empOpenTech(target, keepOpen);
  }
  // re-filter without reloading
  function empRenderTechsList(target){
    const q = emp.q.trim().toLowerCase();
    const rows = emp.techs.filter(t=> (emp.showInactive || t.active !== false) &&
      (!q || [t.name, t.username].some(v=> String(v || '').toLowerCase().includes(q))));
    const list = target.querySelector('.stf-list');
    list.innerHTML = rows.length ? rows.map(empTechRow).join('') : '<div class="empty-state">Nobody matches.</div>';
    list.querySelectorAll('[data-tech]').forEach(b=> b.addEventListener('click', ()=> empOpenTech(target, b.dataset.tech)));
  }
  function empTechRow(t){
    const active = t.active !== false;
    const r = empRestrLabel(t.restrictions);
    return '<button type="button" class="stf-person' + (active ? '' : ' stf-inactive') + '" data-tech="' + escapeHtml(t.id) + '">' +
      '<span class="stf-avatar emp-tech-av">' + escapeHtml((t.name || '?').trim().charAt(0).toUpperCase()) + '</span>' +
      '<span class="stf-person-main"><span class="stf-person-name">' + escapeHtml(t.name || '') + (active ? '' : ' <span class="stf-off">Deactivated</span>') + '</span>' +
      '<span class="stf-person-sub">' + (t.username ? '@' + escapeHtml(t.username) : '<span style="color:var(--amber);">no username</span>') + ' \u00B7 Technician' +
        (r ? ' \u00B7 ' + escapeHtml(r) : '') + (emp.locks.has(t.id) ? ' \u00B7 \uD83D\uDD12 DTR device' : '') +
        (emp.inv && typeof invUserStatusLine === 'function' ? '' : '') + '</span></span>' +
      '<span class="stf-chev">\u203A</span></button>';
  }

  // server call; falls back to the old function for the Super Admin when
  // admin-create-staff hasn't been redeployed yet
  async function empFn(body){
    const { data, error } = await db.functions.invoke('admin-create-staff', { body });
    let res = data;
    if(error){
      try{ res = error.context && typeof error.context.json === 'function' ? await error.context.json() : null; }catch(e){ res = null; }
      if(!res) res = { error: error.message || 'Request failed' };
    }
    if(res && res.error && /Unknown action/i.test(res.error) && empIsSuper()){
      return { legacy:true };
    }
    return res || {};
  }

  function empOpenAdd(target){
    const box = target.querySelector('#empAddBox');
    box.innerHTML = '<div class="po-sec emp-add"><div class="po-sec-title">New technician</div><div class="po-grid">' +
      '<div class="field po-c6"><label>Full name <span class="req">*</span></label><input type="text" data-n="name" placeholder="e.g. Juan Dela Cruz"></div>' +
      '<div class="field po-c6"><label>Username <span class="req">*</span></label><input type="text" data-n="username" autocapitalize="none" autocomplete="off" placeholder="e.g. juan.delacruz"></div>' +
      '<div class="field po-c6"><label>Password <span class="req">*</span></label><input type="password" data-n="pw1" autocomplete="new-password" placeholder="At least 4 characters"></div>' +
      '<div class="field po-c6"><label>Confirm password</label><input type="password" data-n="pw2" autocomplete="new-password"></div>' +
      '</div><div class="pay-actions"><button type="button" class="btn btn-primary" data-n="save">Create Technician</button><button type="button" class="btn btn-secondary" data-n="cancel">Cancel</button></div></div>';
    const g = (k)=> box.querySelector('[data-n="' + k + '"]');
    g('name').focus();
    g('cancel').addEventListener('click', ()=>{ box.innerHTML = ''; });
    g('save').addEventListener('click', async ()=>{
      const name = g('name').value.trim(), username = g('username').value.trim().toLowerCase(), pw = g('pw1').value;
      if(!name){ toast('Enter the full name'); return; }
      if(!/^[a-z0-9][a-z0-9._-]{2,29}$/.test(username)){ toast('Username: 3\u201330 letters, numbers, dot, dash or underscore'); return; }
      if(pw.length < 4){ toast('Password must be at least 4 characters'); return; }
      if(pw !== g('pw2').value){ toast('Passwords don\u2019t match'); return; }
      g('save').disabled = true;
      let res = await empFn({ action:'tech_create', name, username, password:pw });
      if(res.legacy){
        // Super Admin, old deployment: the previous create path + username update
        const r2 = await db.functions.invoke('admin-create-technician', { body:{ name, password:pw } });
        res = r2.error ? { error: (r2.data && r2.data.error) || r2.error.message } : (r2.data || {});
        if(res.id) await cloudSetUser(res.id, { username });
      }
      g('save').disabled = false;
      if(res.error){ toast(res.error); return; }
      toast('Added ' + name);
      box.innerHTML = '';
      empRenderTechs(target, res.id);
    });
  }

  function empOpenTech(target, id){
    const t = emp.techs.find(x=> x.id === id);
    if(!t) return;
    const edit = empCanTechEdit(), active = t.active !== false, r = t.restrictions || {};
    const dis = edit ? '' : ' disabled';
    const hrOk = empIsSuper() || (typeof hrIsReviewer === 'function' && (hrIsReviewer('hr.attendance') || hrIsReviewer('hr.leaves') || hrIsReviewer('hr.tech_profiles')));
    const payOk = empIsSuper() || can('hr.payroll_setup', 'view');
    const chk = (k, title, desc)=> '<label class="restrict-row"><input type="checkbox" data-t="' + k + '"' + (r[k] ? ' checked' : '') + dis + '>' +
      '<span class="rtxt"><span class="rt-title">' + title + '</span><span class="rt-desc">' + desc + '</span></span></label>';
    target.innerHTML = empTabsHtml('tech') +
      '<div class="card"><div class="card-body">' +
      '<button type="button" class="btn btn-secondary stf-back" data-t="back">\u2190 Technicians</button>' +
      '<div class="emp-head"><span class="stf-avatar emp-tech-av">' + escapeHtml((t.name || '?').charAt(0).toUpperCase()) + '</span><div>' +
        '<div class="stf-person-name">' + escapeHtml(t.name || '') + (active ? '' : ' <span class="stf-off">Deactivated</span>') + '</div>' +
        '<div class="stf-person-sub">Technician \u00B7 Operations' + (emp.locks.has(t.id) ? ' \u00B7 \uD83D\uDD12 DTR locked to a device' : '') + '</div></div></div>' +
      '<div class="pay-actions">' +
        (hrOk ? '<button type="button" class="btn btn-secondary" data-t="profile">Technician Profile (HR records)</button>' : '') +
        (payOk ? '<button type="button" class="btn btn-secondary" data-t="pay">Payroll Setup</button>' : '') +
      '</div>' +
      '<div class="po-sec"><div class="po-sec-title">Sign-in</div><div class="po-grid">' +
        '<div class="field po-c6"><label>Full name</label><input type="text" data-t="name" value="' + escapeHtml(t.name || '') + '"' + dis + '></div>' +
        '<div class="field po-c6"><label>Username</label><input type="text" data-t="username" autocapitalize="none" autocomplete="off" value="' + escapeHtml(t.username || '') + '"' + dis + '></div>' +
        (edit ? '<div class="field po-c6"><label>New password (leave blank to keep)</label><input type="password" data-t="pw1" autocomplete="new-password"></div>' +
                '<div class="field po-c6"><label>Confirm new password</label><input type="password" data-t="pw2" autocomplete="new-password"></div>' : '') +
      '</div></div>' +
      '<div class="po-sec"><div class="restrict-group"><h5>Restrictions</h5>' +
        chk('noHistory', 'Block History access', 'Can\u2019t open History or view past reports.') +
        chk('noReport', 'Block report generation', 'Can\u2019t preview, generate or share PDF reports.') +
        chk('readOnly', 'Read-only', 'Can\u2019t save drafts, start new reports, or generate reports.') +
      '</div></div>' +
      (emp.inv && typeof invUserPanelHtml === 'function' ? '<div class="po-sec emp-inv">' + invUserPanelHtml(emp.inv, t.id) + '</div>' : '') +
      (edit ? '<div class="pay-actions"><button type="button" class="btn btn-primary" data-t="save">Save Changes</button>' +
          (emp.locks.has(t.id) ? '<button type="button" class="btn btn-secondary" data-t="unlock">Reset DTR device</button>' : '') +
          '<button type="button" class="btn btn-secondary' + (active ? ' pay-danger' : '') + '" data-t="toggle">' + (active ? 'Deactivate\u2026' : 'Reactivate') + '</button></div>' : '') +
      '</div></div>';
    empBindTabs(target);
    const g = (k)=> target.querySelector('[data-t="' + k + '"]');
    g('back').addEventListener('click', ()=> empRenderTechs(target));
    if(g('profile')) g('profile').addEventListener('click', ()=> techOpenProfile({ id:t.id, name:t.name }));
    if(g('pay')) g('pay').addEventListener('click', ()=> showPurchasingView('paySetup'));
    if(!edit) return;
    if(g('unlock')) g('unlock').addEventListener('click', async ()=>{
      if(!await uiConfirm('Reset ' + t.name + '\u2019s DTR device?\n\nUse this if they lost or replaced their phone \u2014 the next device they time in from becomes their device.', { ok:'Reset' })) return;
      const ok = await clearDeviceLock(t.id);
      toast(ok ? 'Device lock cleared for ' + t.name : 'Couldn\u2019t clear the device lock');
      if(ok) empRenderTechs(target, t.id);
    });
    g('toggle').addEventListener('click', async ()=>{
      if(active && !await uiConfirm('Deactivate ' + t.name + '?\n\nThey\u2019re signed out and can\u2019t sign in again. Their reports, attendance and history stay.', { ok:'Deactivate', danger:true })) return;
      let res = await empFn({ action: active ? 'tech_deactivate' : 'tech_reactivate', userId:t.id });
      if(res.legacy){ const ok = await cloudSetUser(t.id, { active: !active }); res = ok ? {} : { error:'Couldn\u2019t update' }; }
      if(res.error){ toast(res.error); return; }
      toast(active ? t.name + ' deactivated' : t.name + ' reactivated');
      empRenderTechs(target, t.id);
    });
    g('save').addEventListener('click', async ()=>{
      const name = g('name').value.trim(), username = g('username').value.trim().toLowerCase();
      const pw1 = g('pw1').value, pw2 = g('pw2').value;
      if(!name){ toast('Enter the full name'); return; }
      if(!/^[a-z0-9][a-z0-9._-]{2,29}$/.test(username)){ toast('Username: 3\u201330 letters, numbers, dot, dash or underscore'); return; }
      if(pw1 || pw2){
        if(pw1.length < 4){ toast('Password must be at least 4 characters'); return; }
        if(pw1 !== pw2){ toast('Passwords don\u2019t match'); return; }
      }
      const restrictions = { noHistory:g('noHistory').checked, noReport:g('noReport').checked, readOnly:g('readOnly').checked };
      g('save').disabled = true;
      let res = await empFn({ action:'tech_update', userId:t.id, name, username, restrictions });
      if(res.legacy){ const ok = await cloudSetUser(t.id, { name, username, restrictions }); res = ok ? {} : { error:'Couldn\u2019t save' }; }
      if(!res.error && pw1){
        let r2 = await empFn({ action:'tech_reset_password', userId:t.id, password:pw1 });
        if(r2.legacy){
          const x = await db.functions.invoke('admin-create-technician', { body:{ action:'reset_password', technicianId:t.id, password:pw1 } });
          r2 = x.error || (x.data && x.data.error) ? { error:'Couldn\u2019t change the password' } : {};
        }
        if(r2.error) res = r2;
      }
      if(!res.error && emp.inv && typeof invSaveUserWarehouses === 'function'){
        const ok = await invSaveUserWarehouses(emp.inv, t.id, target);
        if(!ok) res = { error:'Saved, but the storekeeper warehouses couldn\u2019t be saved' };
      }
      g('save').disabled = false;
      if(res.error){ toast(res.error); return; }
      toast('Saved ' + name + (pw1 ? ' \u2014 password changed' : ''));
      empRenderTechs(target, t.id);
    });
  }
