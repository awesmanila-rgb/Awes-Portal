  // =====================================================================
  // Purchasing — Supplier Database (admin only)
  //
  // Tables (migration 20260923_01_purchasing_suppliers_materials.sql):
  //   suppliers, supplier_contacts, supplier_documents, supplier_materials
  // All admin-only under RLS. Suppliers are never hard-deleted — only
  // deactivated — because requisitions and POs will reference them.
  //
  // Entry point: purchOnShow(key), called by showPurchasingView() in home.js.
  // =====================================================================

  // Material categories (materials.category, suppliers.supplies).
  // Managed in Purchasing › Materials Database › Manage Categories and kept
  // in public.material_categories (migration 20260925_01). These start as
  // the original fixed list and are refilled IN PLACE from the database by
  // purchLoadCategories(), so every screen reading them stays current:
  //   PURCH_CATEGORIES — active ones: offered when adding/editing items & suppliers
  //   PURCH_CAT_ALL    — active + hidden, in display order: filters, list grouping, imports
  const PURCH_CATEGORIES = [
    'Piping', 'Refrigerant', 'Electrical', 'Insulation', 'Consumables',
    'Parts & Components', 'Ducting & Ventilation', 'Plumbing',
    'Fire Protection', 'Hardware', 'Tools & Equipment', 'Others'
  ];
  const PURCH_CAT_ALL = PURCH_CATEGORIES.slice();
  let purchCats = [];              // rows of material_categories, in order
  let purchCatsLoaded = false;
  let purchCatsMissing = false;    // table not created yet (migration not run)
  let purchCatsLoading = null;

  async function purchLoadCategories(force){
    if(purchCatsLoaded && !force) return true;
    if(purchCatsLoading && !force) return purchCatsLoading;
    purchCatsLoading = (async ()=>{
      try{
        if(!(await ensureCloud())) return false;
        const { data, error } = await db.from('material_categories').select('*')
          .order('sort_order').order('name');
        if(error) throw error;
        purchCats = (data || []).slice().sort((a, b)=> (a.is_system ? 1 : 0) - (b.is_system ? 1 : 0)
          || a.sort_order - b.sort_order || a.name.localeCompare(b.name));
        purchCatsMissing = false;
        purchCatsLoaded = true;
        purchSyncCategoryLists();
        purchApplyCategorySelects();
        return true;
      }catch(e){
        const msg = describeCloudError(e);
        if(/42P01|PGRST205|does not exist|material_categories/.test(msg)) purchCatsMissing = true;
        else console.warn('load material categories failed', msg);
        return false;
      }finally{ purchCatsLoading = null; }
    })();
    return purchCatsLoading;
  }
  function purchSyncCategoryLists(){
    if(!purchCats.length) return;
    PURCH_CATEGORIES.length = 0; PURCH_CAT_ALL.length = 0;
    purchCats.forEach(c=>{
      PURCH_CAT_ALL.push(c.name);
      if(c.is_active) PURCH_CATEGORIES.push(c.name);
      MT_CODE_PREFIX[c.name] = c.code_prefix;
    });
  }
  // <option>s for a category picker: active ones, plus `keep` if it's hidden
  // (so editing an item that sits in a hidden category doesn't lose it).
  function purchCategoryOptions(keep){
    const list = PURCH_CATEGORIES.slice();
    if(keep && !list.includes(keep)) list.push(keep);
    return list.map(c=> '<option value="' + escapeHtml(c) + '">' + escapeHtml(c) + (PURCH_CATEGORIES.includes(c) ? '' : ' (hidden)') + '</option>').join('');
  }
  // Refill every category dropdown that has already been built, keeping its selection.
  function purchApplyCategorySelects(){
    const refill = (id, allLabel)=>{
      const el = document.getElementById(id);
      if(!el || el.options.length <= 1) return;   // not built yet — it fills itself from the lists on first show
      const keep = el.value;
      el.innerHTML = '<option value="">' + allLabel + '</option>' + PURCH_CAT_ALL.map(c=> '<option value="' + escapeHtml(c) + '">' + escapeHtml(c) + '</option>').join('');
      el.value = PURCH_CAT_ALL.includes(keep) ? keep : '';
    };
    refill('spFilterCategory', 'All categories');
    refill('mtFilterCategory', 'All categories');
    refill('invStockCat', 'All categories');
    refill('rpCat', 'All categories');
    const mc = document.getElementById('mtCategory');
    if(mc && mc.options.length){ const keep = mc.value; mc.innerHTML = purchCategoryOptions(keep); mc.value = keep; }
    if(document.getElementById('spSheetOverlay') && $('spSheetOverlay').classList.contains('open')) spRenderSuppliesPick();
  }
  const SP_DOC_TYPES = ['BIR 2303', 'DTI / SEC', "Mayor's Permit", 'Quotation', 'Price List', 'Other'];
  const SP_DOC_BUCKET = 'supplier-documents';
  const SP_DOC_MAX_BYTES = 10 * 1024 * 1024;
  const SP_PRICE_STALE_DAYS = 60;

  let spCache = [];            // suppliers, each with .contacts (embedded)
  let spEditing = null;        // supplier being edited in the sheet, or null when adding
  let spSheetSupplies = [];    // supplies selection inside the sheet
  let spContactsCache = [];

  // ---------- row <-> object ----------
  function spFromRow(r){
    const bank = r.bank_details || {};
    return {
      id: r.id, code: r.code || '', name: r.name || '', tradeName: r.trade_name || '',
      supplies: Array.isArray(r.supplies) ? r.supplies : [],
      address: r.address || '', city: r.city || '', tin: r.tin || '',
      vatRegistered: (r.vat_registered === true || r.vat_registered === false) ? r.vat_registered : null,
      paymentTerms: r.payment_terms || '', creditLimit: r.credit_limit,
      delivers: !!r.delivers, rating: r.rating || null, remarks: r.remarks || '',
      bank: { bank: bank.bank || '', accountName: bank.account_name || '', accountNo: bank.account_no || '', ewallet: bank.ewallet || '' },
      isActive: r.is_active !== false,
      contacts: Array.isArray(r.supplier_contacts) ? r.supplier_contacts : [],
      updatedAt: r.updated_at
    };
  }
  function spDisplayName(s){ return s.tradeName || s.name; }
  function spPrimaryContact(s){
    const c = s.contacts || [];
    return c.find(x=> x.is_primary) || c[0] || null;
  }
  function spParseMoney(v){
    const t = String(v == null ? '' : v).replace(/[₱,\s]/g, '');
    if(t === '') return null;
    const n = Number(t);
    return isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : NaN;
  }
  function spMoney(n){
    if(n == null || n === '') return '—';
    return '₱' + Number(n).toLocaleString('en-PH', { minimumFractionDigits:2, maximumFractionDigits:2 });
  }
  function spDaysSince(dateStr){
    if(!dateStr) return null;
    const d = new Date(dateStr + (String(dateStr).length === 10 ? 'T00:00:00' : ''));
    return Math.floor((Date.now() - d.getTime()) / 86400000);
  }

  // ---------- entry ----------
  function purchOnShow(key){
    purchLoadCategories();   // cached after the first load; realtime keeps it fresh
    if(key === 'myRequests'){ if(currentUser) mrtShow(); return; }   // technician screen
    if(key === 'myStock'){ if(currentUser) invShowMyStock(); return; } // storekeeper screen (quantities only)
    if(key === 'myMaterials'){ if(currentUser) invShowMyMaterials(); return; }
    // Movement screens: admins and storekeepers (the database decides who
    // may post for which warehouse)
    if(key === 'receive'){ invShowReceive(); return; }
    if(key === 'issue'){ invShowIssue(); return; }
    if(key === 'returns'){ invShowReturns(); return; }
    if(key === 'transfers'){ invShowTransfers(); return; }
    if(key === 'slips'){ invShowSlips(); return; }
    if(key === 'invReports'){ rpShow(); return; }   // admins + storekeepers (quantities only for storekeepers)
    // Tools & Equipment — the database decides who may do what
    const tlPages = { tlHub: tlShowHub, tlRegister: tlShowRegister, tlIssue: tlShowIssue, tlReturn: tlShowReturn, tlHandover: tlShowHandover,
      tlDefects: tlShowDefects, tlMaint: tlShowMaint, tlSlips: tlShowSlips, tlReports: tlShowReports, myTools: tlShowMine };
    if(tlPages[key]){ tlPages[key](); return; }
    if(!currentUser || currentUser.role !== 'admin') return;
    purchRealtimeStart();
    if(key === 'suppliers') spShow();
    if(key === 'materials') mtShow();
    if(key === 'purchaseOrders') poShow();
    if(key === 'requisitions') mrShow();
    if(key === 'stock') invShowStock();
    if(key === 'warehouses') invShowWarehouses();
    if(key === 'projects') invShowProjects();
  }

  async function spShow(){
    await purchLoadCategories();
    const sel = $('spFilterCategory');
    if(sel.options.length <= 1){
      PURCH_CAT_ALL.forEach(c=>{ const o = document.createElement('option'); o.value = c; o.textContent = c; sel.appendChild(o); });
    }
    if(await spLoad()) spRenderList();
  }

  async function spLoad(opts){
    const silent = !!(opts && opts.silent);
    const list = $('spList');
    if(!silent) list.innerHTML = '<div class="empty-state">Loading…</div>';
    if(!(await ensureCloud())){
      spCache = [];
      list.innerHTML = '<div class="empty-state">Not connected to Shared Cloud — the Supplier Database needs a connection.</div>';
      return false;
    }
    try{
      const { data, error } = await db.from('suppliers')
        .select('*, supplier_contacts(id,name,position,mobile,email,is_primary)')
        .order('name', { ascending: true });
      if(error) throw error;
      spCache = (data || []).map(spFromRow);
      return true;
    }catch(e){
      console.error('load suppliers failed', describeCloudError(e));
      if(silent) return false;   // background refresh: keep what's on screen
      spCache = [];
      const msg = purchIsAuthError(e) ? PURCH_EXPIRED_HTML : /relation .*suppliers.* does not exist|42P01/.test(describeCloudError(e))
        ? 'The suppliers table isn\u2019t in the database yet — run migration 20260923_01_purchasing_suppliers_materials.sql in Supabase first.'
        : 'Couldn\u2019t load suppliers: ' + escapeHtml(describeCloudError(e));
      list.innerHTML = '<div class="empty-state">' + msg + '</div>';
      return false;
    }
  }

  function spFiltered(){
    const q = ($('spSearch').value || '').trim().toLowerCase();
    const cat = $('spFilterCategory').value;
    const showInactive = $('spShowInactive').checked;
    return spCache.filter(s=>{
      if(!showInactive && !s.isActive) return false;
      if(cat && !s.supplies.includes(cat)) return false;
      if(!q) return true;
      const hay = [s.code, s.name, s.tradeName, s.city, s.address, s.tin]
        .concat((s.contacts || []).map(c=> c.name + ' ' + c.mobile + ' ' + c.email))
        .join(' ').toLowerCase();
      return hay.includes(q);
    });
  }

  function spRenderList(){
    const list = $('spList');
    const active = spCache.filter(s=> s.isActive).length;
    $('spCount').textContent = spCache.length ? (active + ' active' + (spCache.length > active ? ' · ' + (spCache.length - active) + ' inactive' : '')) : '';
    const rows = spFiltered();
    const openIds = new Set($$('#spList .user-card').filter(c=> c.querySelector('.user-edit-panel.open')).map(c=> c.dataset.id));
    if(rows.length === 0){
      list.innerHTML = '<div class="empty-state">' + (spCache.length === 0
        ? 'No suppliers yet. Tap <b>+ Add Supplier</b>, or import a CSV.'
        : 'No suppliers match.') + '</div>';
      return;
    }
    list.innerHTML = rows.map(s=>{
      const pc = spPrimaryContact(s);
      const sub = [s.code, s.city, s.paymentTerms, s.delivers ? 'Delivers' : 'Pickup only'].filter(Boolean).join(' · ');
      const tags = s.supplies.map(t=> '<span class="sp-tag">' + escapeHtml(t) + '</span>').join('') +
        (s.isActive ? '' : '<span class="sp-tag danger">Inactive</span>') +
        (s.rating ? '<span class="sp-tag muted">' + '★'.repeat(s.rating) + '</span>' : '');
      const vat = s.vatRegistered === true ? 'VAT-registered' : s.vatRegistered === false ? 'Non-VAT' : 'Unknown';
      const isOpen = openIds.has(s.id) ? ' open' : '';
      return '<div class="user-card' + (s.isActive ? '' : ' inactive') + '" data-id="' + escapeHtml(s.id) + '">' +
        '<div class="user-card-head' + isOpen + '" data-act="toggle" style="cursor:pointer;"><div style="min-width:0;">' +
          '<div class="u-name">' + escapeHtml(spDisplayName(s)) + '</div>' +
          '<div class="u-status">' + escapeHtml(sub) + '</div>' +
          (tags ? '<div class="sp-tags">' + tags + '</div>' : '') +
        '</div><span class="card-caret">▾</span></div>' +
        '<div class="user-edit-panel' + isOpen + '">' +
          (s.tradeName && s.tradeName !== s.name ? '<div class="cust-detail-row"><b>Registered name:</b> ' + escapeHtml(s.name) + '</div>' : '') +
          '<div class="cust-detail-row"><b>Address:</b> ' + escapeHtml([s.address, s.city].filter(Boolean).join(', ') || '—') + '</div>' +
          '<div class="cust-detail-row"><b>Contact:</b> ' + (pc
            ? escapeHtml(pc.name) + (pc.position ? ' (' + escapeHtml(pc.position) + ')' : '') +
              (pc.mobile ? ' · <a href="tel:' + escapeHtml(pc.mobile.replace(/\s/g, '')) + '">' + escapeHtml(pc.mobile) + '</a>' : '')
            : '—') + (s.contacts.length > 1 ? ' <span style="color:var(--text-muted);">+' + (s.contacts.length - 1) + ' more</span>' : '') + '</div>' +
          '<div class="cust-detail-row"><b>TIN / VAT:</b> ' + escapeHtml(s.tin || '—') + ' · ' + vat + '</div>' +
          '<div class="cust-detail-row"><b>Terms:</b> ' + escapeHtml(s.paymentTerms || '—') +
            (s.creditLimit != null ? ' · Credit limit ' + spMoney(s.creditLimit) : '') + '</div>' +
          (s.remarks ? '<div class="cust-detail-row"><b>Remarks:</b> ' + escapeHtml(s.remarks) + '</div>' : '') +
          '<div class="user-card-actions">' +
            '<button type="button" data-act="edit" class="primary">Edit</button>' +
            '<button type="button" data-act="contacts">Contacts</button>' +
            '<button type="button" data-act="docs">Documents</button>' +
            '<button type="button" data-act="prices">Price List</button>' +
            (s.isActive
              ? '<button type="button" data-act="deactivate" class="danger">Deactivate</button>'
              : '<button type="button" data-act="reactivate">Reactivate</button>') +
          '</div>' +
        '</div>' +
      '</div>';
    }).join('');
  }

  $('spSearch').addEventListener('input', spRenderList);
  $('spFilterCategory').addEventListener('change', spRenderList);
  $('spShowInactive').addEventListener('change', spRenderList);
  $('spAddBtn').addEventListener('click', ()=> spOpenSheet(null, 'info'));

  $('spList').addEventListener('click', async (e)=>{
    const btn = e.target.closest('[data-act]');
    if(!btn) return;
    const card = btn.closest('.user-card');
    const s = card && spCache.find(x=> x.id === card.dataset.id);
    if(!s) return;
    const act = btn.dataset.act;
    if(act === 'toggle'){
      card.querySelector('.user-edit-panel').classList.toggle('open');
      card.querySelector('.user-card-head').classList.toggle('open');
      return;
    }
    if(act === 'edit') return spOpenSheet(s, 'info');
    if(act === 'contacts' || act === 'docs' || act === 'prices') return spOpenSheet(s, act);
    if(act === 'deactivate' || act === 'reactivate'){
      const on = act === 'reactivate';
      if(!on && !confirm('Deactivate ' + spDisplayName(s) + '? It will be hidden from pickers but kept for existing records. You can reactivate it any time.')) return;
      if(!(await purchEnsureSession())) return;
      btn.disabled = true;
      try{
        purchMarkOwn(s.id);
        const { error } = await db.from('suppliers').update({ is_active: on }).eq('id', s.id);
        if(error) throw error;
        s.isActive = on;
        toast(spDisplayName(s) + (on ? ' reactivated' : ' deactivated'));
        spRenderList();
      }catch(err){
        btn.disabled = false;
        purchFail('Couldn\u2019t update supplier: ', err);
      }
    }
  });

  // ---------- sheet ----------
  function spRenderSuppliesPick(){
    // Active categories, plus any hidden one this supplier already has.
    const list = PURCH_CATEGORIES.concat(spSheetSupplies.filter(c=> !PURCH_CATEGORIES.includes(c)));
    $('spSuppliesPick').innerHTML = list.map(c=>
      '<button type="button" data-cat="' + escapeHtml(c) + '" class="' + (spSheetSupplies.includes(c) ? 'on' : '') + '">' + escapeHtml(c) + '</button>'
    ).join('');
  }
  $('spSuppliesPick').addEventListener('click', (e)=>{
    const b = e.target.closest('[data-cat]');
    if(!b) return;
    const c = b.dataset.cat;
    spSheetSupplies = spSheetSupplies.includes(c) ? spSheetSupplies.filter(x=> x !== c) : spSheetSupplies.concat(c);
    b.classList.toggle('on');
  });

  function spOpenSheet(s, tab){
    spEditing = s;
    $('spStaleNote').style.display = 'none';
    $('spSheetTitle').textContent = s ? spDisplayName(s) : 'Add Supplier';
    $('spCodeLine').style.display = s ? '' : 'none';
    $('spCodeLine').textContent = s ? s.code + (s.isActive ? '' : ' · Inactive') : '';
    $('spName').value = s ? s.name : '';
    $('spTradeName').value = s ? s.tradeName : '';
    spSheetSupplies = s ? s.supplies.slice() : [];
    spRenderSuppliesPick();
    $('spAddress').value = s ? s.address : '';
    $('spCity').value = s ? s.city : '';
    $('spTin').value = s ? s.tin : '';
    $('spVat').value = s && s.vatRegistered !== null ? String(s.vatRegistered) : '';
    $('spTerms').value = s ? s.paymentTerms : 'COD';
    $('spCreditLimit').value = s && s.creditLimit != null ? String(s.creditLimit) : '';
    $('spDelivers').value = s && s.delivers ? 'true' : 'false';
    $('spRating').value = s && s.rating ? String(s.rating) : '';
    $('spBank').value = s ? s.bank.bank : '';
    $('spAcctName').value = s ? s.bank.accountName : '';
    $('spAcctNo').value = s ? s.bank.accountNo : '';
    $('spEwallet').value = s ? s.bank.ewallet : '';
    $('spRemarks').value = s ? s.remarks : '';
    $('spSaveBtn').textContent = s ? 'Save Changes' : 'Save Supplier';
    $('spSaveBtn').disabled = false;
    spResetContactForm();
    const sel = $('spDocType');
    if(!sel.options.length) sel.innerHTML = SP_DOC_TYPES.map(t=> '<option>' + escapeHtml(t) + '</option>').join('');
    spResetDocForm();
    spSetTabsEnabled(!!s);
    spShowTab(s ? tab : 'info');
    $('spSheetOverlay').classList.add('open');
  }
  function spSetTabsEnabled(on){
    $$('#spTabs [data-sp-tab]').forEach(b=>{
      if(b.dataset.spTab !== 'info') b.classList.toggle('sp-seg-disabled', !on);
    });
  }
  function spShowTab(tab){
    $$('#spTabs [data-sp-tab]').forEach(b=> b.classList.toggle('active', b.dataset.spTab === tab));
    $('spPaneInfo').style.display = tab === 'info' ? '' : 'none';
    $('spPaneContacts').style.display = tab === 'contacts' ? '' : 'none';
    $('spPaneDocs').style.display = tab === 'docs' ? '' : 'none';
    $('spPanePrices').style.display = tab === 'prices' ? '' : 'none';
    if(!spEditing) return;
    if(tab === 'contacts') spLoadContacts();
    if(tab === 'docs') spLoadDocs();
    if(tab === 'prices') spLoadPrices();
  }
  $('spTabs').addEventListener('click', (e)=>{
    const b = e.target.closest('[data-sp-tab]');
    if(b && !b.classList.contains('sp-seg-disabled')) spShowTab(b.dataset.spTab);
  });
  function spCloseSheet(){
    $('spSheetOverlay').classList.remove('open');
    spEditing = null;
    spLoad().then(ok=>{ if(ok) spRenderList(); });   // contacts/primary may have changed
  }
  $('spSheetClose').addEventListener('click', spCloseSheet);

  $('spSaveBtn').addEventListener('click', async ()=>{
    const name = $('spName').value.trim();
    if(!name){ toast('Registered business name is required'); $('spName').focus(); return; }
    const credit = spParseMoney($('spCreditLimit').value);
    if(Number.isNaN(credit)){ toast('Credit limit must be a number'); $('spCreditLimit').focus(); return; }
    const dup = spCache.find(x=> x.name.trim().toLowerCase() === name.toLowerCase() && (!spEditing || x.id !== spEditing.id));
    if(dup && !confirm('A supplier named "' + dup.name + '" (' + dup.code + ') already exists. Save anyway?')) return;
    const vat = $('spVat').value;
    const row = {
      name, trade_name: $('spTradeName').value.trim(), supplies: spSheetSupplies.slice(),
      address: $('spAddress').value.trim(), city: $('spCity').value.trim(), tin: $('spTin').value.trim(),
      vat_registered: vat === '' ? null : vat === 'true',
      payment_terms: $('spTerms').value.trim() || 'COD', credit_limit: credit,
      delivers: $('spDelivers').value === 'true',
      rating: $('spRating').value ? Number($('spRating').value) : null,
      bank_details: {
        bank: $('spBank').value.trim(), account_name: $('spAcctName').value.trim(),
        account_no: $('spAcctNo').value.trim(), ewallet: $('spEwallet').value.trim()
      },
      remarks: $('spRemarks').value.trim()
    };
    if(!(await ensureCloud())){ toast('Not connected — can\u2019t save'); return; }
    if(!(await purchEnsureSession())) return;
    const btn = $('spSaveBtn'); btn.disabled = true;
    try{
      let res;
      if(spEditing) res = await db.from('suppliers').update(row).eq('id', spEditing.id).select('*, supplier_contacts(id,name,position,mobile,email,is_primary)').single();
      else res = await db.from('suppliers').insert(row).select('*, supplier_contacts(id,name,position,mobile,email,is_primary)').single();
      if(res.error) throw res.error;
      const saved = spFromRow(res.data);
      purchMarkOwn(saved.id);
      const wasNew = !spEditing;
      const i = spCache.findIndex(x=> x.id === saved.id);
      if(i >= 0) spCache[i] = saved; else spCache.push(saved);
      spCache.sort((a,b)=> a.name.localeCompare(b.name));
      spEditing = saved;
      spRenderList();
      $('spSheetTitle').textContent = spDisplayName(saved);
      $('spCodeLine').style.display = ''; $('spCodeLine').textContent = saved.code;
      btn.textContent = 'Save Changes';
      spSetTabsEnabled(true);
      toast(wasNew ? 'Supplier saved as ' + saved.code + ' — add contacts next' : 'Supplier updated');
      if(wasNew) spShowTab('contacts');
    }catch(e){
      purchFail('Couldn\u2019t save supplier: ', e);
    }finally{ btn.disabled = false; }
  });

  // ---------- contacts ----------
  function spResetContactForm(){
    $('spContactId').value = '';
    ['spContactName','spContactPosition','spContactMobile','spContactEmail'].forEach(id=> $(id).value = '');
    $('spContactPrimary').checked = false;
    $('spContactFormTitle').textContent = 'Add a contact';
    $('spContactCancelBtn').style.display = 'none';
  }
  async function spLoadContacts(opts){
    const list = $('spContactsList');
    if(!(opts && opts.silent)) list.innerHTML = '<div class="empty-state">Loading…</div>';
    try{
      const { data, error } = await db.from('supplier_contacts').select('*')
        .eq('supplier_id', spEditing.id).order('is_primary', { ascending:false }).order('name');
      if(error) throw error;
      spContactsCache = data || [];
      if(!spContactsCache.length){
        list.innerHTML = '<div class="empty-state" style="padding:16px;">No contacts yet.</div>';
        $('spContactPrimary').checked = true;   // first contact defaults to primary
        return;
      }
      list.innerHTML = spContactsCache.map(c=>
        '<div class="sp-row" data-id="' + escapeHtml(c.id) + '"><div class="sp-row-top"><div style="min-width:0;">' +
          '<div class="sp-row-title">' + escapeHtml(c.name) + (c.is_primary ? ' <span class="sp-tag">Primary</span>' : '') + '</div>' +
          '<div class="sp-row-sub">' + [
            c.position ? escapeHtml(c.position) : '',
            c.mobile ? '<a href="tel:' + escapeHtml(c.mobile.replace(/\s/g, '')) + '">' + escapeHtml(c.mobile) + '</a>' : '',
            c.email ? '<a href="mailto:' + escapeHtml(c.email) + '">' + escapeHtml(c.email) + '</a>' : ''
          ].filter(Boolean).join(' · ') + '</div>' +
        '</div></div><div class="user-card-actions">' +
          '<button type="button" data-cact="edit">Edit</button>' +
          (c.is_primary ? '' : '<button type="button" data-cact="primary">Make primary</button>') +
          '<button type="button" data-cact="remove" class="danger">Remove</button>' +
        '</div></div>'
      ).join('');
    }catch(e){
      list.innerHTML = '<div class="empty-state">Couldn\u2019t load contacts: ' + escapeHtml(describeCloudError(e)) + '</div>';
    }
  }
  // The unique "one primary per supplier" index means the old primary must
  // be cleared before a new one is set.
  async function spClearPrimary(exceptId){
    let q = db.from('supplier_contacts').update({ is_primary:false }).eq('supplier_id', spEditing.id).eq('is_primary', true);
    if(exceptId) q = q.neq('id', exceptId);
    const { error } = await q;
    if(error) throw error;
  }
  $('spContactsList').addEventListener('click', async (e)=>{
    const b = e.target.closest('[data-cact]');
    if(!b) return;
    const c = spContactsCache.find(x=> x.id === b.closest('.sp-row').dataset.id);
    if(!c) return;
    const act = b.dataset.cact;
    if(act === 'edit'){
      $('spContactId').value = c.id;
      $('spContactName').value = c.name; $('spContactPosition').value = c.position || '';
      $('spContactMobile').value = c.mobile || ''; $('spContactEmail').value = c.email || '';
      $('spContactPrimary').checked = !!c.is_primary;
      $('spContactFormTitle').textContent = 'Edit contact';
      $('spContactCancelBtn').style.display = '';
      $('spContactName').focus();
      return;
    }
    if(!(await purchEnsureSession())) return;
    b.disabled = true;
    try{
      if(act === 'primary'){
        await spClearPrimary(c.id);
        const { error } = await db.from('supplier_contacts').update({ is_primary:true }).eq('id', c.id);
        if(error) throw error;
        toast(c.name + ' is now the primary contact');
      }else if(act === 'remove'){
        if(!confirm('Remove ' + c.name + ' from this supplier?')){ b.disabled = false; return; }
        const { error } = await db.from('supplier_contacts').delete().eq('id', c.id);
        if(error) throw error;
        toast('Contact removed');
      }
      spLoadContacts();
    }catch(err){
      b.disabled = false;
      purchFail('Couldn\u2019t update contact: ', err);
    }
  });
  $('spContactCancelBtn').addEventListener('click', spResetContactForm);
  $('spContactSaveBtn').addEventListener('click', async ()=>{
    if(!spEditing) return;
    const name = $('spContactName').value.trim();
    if(!name){ toast('Contact name is required'); $('spContactName').focus(); return; }
    const id = $('spContactId').value;
    const primary = $('spContactPrimary').checked;
    const row = {
      name, position: $('spContactPosition').value.trim(),
      mobile: $('spContactMobile').value.trim(), email: $('spContactEmail').value.trim(),
      is_primary: primary
    };
    if(!(await purchEnsureSession())) return;
    const btn = $('spContactSaveBtn'); btn.disabled = true;
    try{
      if(primary) await spClearPrimary(id || null);
      const res = id
        ? await db.from('supplier_contacts').update(row).eq('id', id)
        : await db.from('supplier_contacts').insert(Object.assign({ supplier_id: spEditing.id }, row));
      if(res.error) throw res.error;
      toast(id ? 'Contact updated' : 'Contact added');
      spResetContactForm();
      spLoadContacts();
    }catch(e){
      purchFail('Couldn\u2019t save contact: ', e);
    }finally{ btn.disabled = false; }
  });

  // ---------- documents ----------
  function spResetDocForm(){
    $('spDocTitle').value = ''; $('spDocExpires').value = ''; $('spDocFile').value = '';
    if($('spDocType').options.length) $('spDocType').selectedIndex = 0;
  }
  let spDocsCache = [];
  async function spLoadDocs(opts){
    const list = $('spDocsList');
    if(!(opts && opts.silent)) list.innerHTML = '<div class="empty-state">Loading…</div>';
    try{
      const { data, error } = await db.from('supplier_documents').select('*')
        .eq('supplier_id', spEditing.id).order('created_at', { ascending:false });
      if(error) throw error;
      spDocsCache = data || [];
      if(!spDocsCache.length){
        list.innerHTML = '<div class="empty-state" style="padding:16px;">No documents yet — upload BIR 2303, permits, or quotations below.</div>';
        return;
      }
      const today = new Date().toISOString().slice(0,10);
      list.innerHTML = spDocsCache.map(d=>{
        let exp = '';
        if(d.expires_on){
          const left = -spDaysSince(d.expires_on);
          exp = d.expires_on < today ? '<span class="sp-tag danger">Expired ' + escapeHtml(d.expires_on) + '</span>'
            : left <= 30 ? '<span class="sp-tag warn">Expires ' + escapeHtml(d.expires_on) + '</span>'
            : '<span class="sp-tag muted">Valid until ' + escapeHtml(d.expires_on) + '</span>';
        }
        return '<div class="sp-row" data-id="' + escapeHtml(d.id) + '"><div class="sp-row-top"><div style="min-width:0;">' +
          '<div class="sp-row-title">' + escapeHtml(d.title || d.doc_type) + ' <span class="sp-tag muted">' + escapeHtml(d.doc_type) + '</span> ' + exp + '</div>' +
          '<div class="sp-row-sub">' + escapeHtml(d.file_name || '') + ' · uploaded ' + escapeHtml(String(d.created_at || '').slice(0,10)) + '</div>' +
        '</div></div><div class="user-card-actions">' +
          '<button type="button" data-dact="open" class="primary">Open</button>' +
          '<button type="button" data-dact="remove" class="danger">Delete</button>' +
        '</div></div>';
      }).join('');
    }catch(e){
      list.innerHTML = '<div class="empty-state">Couldn\u2019t load documents: ' + escapeHtml(describeCloudError(e)) + '</div>';
    }
  }
  $('spDocsList').addEventListener('click', async (e)=>{
    const b = e.target.closest('[data-dact]');
    if(!b) return;
    const d = spDocsCache.find(x=> x.id === b.closest('.sp-row').dataset.id);
    if(!d) return;
    if(b.dataset.dact === 'open' && (/^(application\/pdf|image\/)/.test(d.mime_type || '') || /\.(pdf|png|jpe?g|webp|gif)$/i.test(d.file_name || d.storage_path || ''))){
      // PDFs and images open in the app's PDF viewer (Download / Share there).
      b.disabled = true;
      try{
        const { data, error } = await db.storage.from(SP_DOC_BUCKET).download(d.storage_path);
        if(error) throw error;
        const isPdf = (d.mime_type || '') === 'application/pdf' || /\.pdf$/i.test(d.file_name || d.storage_path || '');
        const blob = isPdf ? new Blob([data], { type:'application/pdf' }) : data;
        await openFileInPdfViewer(blob, d.file_name || d.title || 'document', d.title || d.file_name || d.doc_type);
      }catch(err){
        purchFail('Couldn\u2019t open document: ', err);
      }finally{ b.disabled = false; }
      return;
    }
    if(b.dataset.dact === 'open'){
      // Open the tab synchronously (inside the tap) so mobile popup
      // blockers allow it, then point it at the signed URL once we have it.
      const w = window.open('', '_blank');
      try{
        const { data, error } = await db.storage.from(SP_DOC_BUCKET).createSignedUrl(d.storage_path, 600);
        if(error) throw error;
        if(w) w.location.href = data.signedUrl; else window.location.href = data.signedUrl;
      }catch(err){
        if(w) w.close();
        purchFail('Couldn\u2019t open document: ', err);
      }
      return;
    }
    if(!confirm('Delete "' + (d.title || d.file_name || d.doc_type) + '"? This cannot be undone.')) return;
    if(!(await purchEnsureSession())) return;
    b.disabled = true;
    try{
      const { error } = await db.from('supplier_documents').delete().eq('id', d.id);
      if(error) throw error;
      try{ await db.storage.from(SP_DOC_BUCKET).remove([d.storage_path]); }catch(_){}
      toast('Document deleted');
      spLoadDocs();
    }catch(err){
      b.disabled = false;
      purchFail('Couldn\u2019t delete document: ', err);
    }
  });
  $('spDocUploadBtn').addEventListener('click', async ()=>{
    if(!spEditing) return;
    const file = $('spDocFile').files && $('spDocFile').files[0];
    if(!file){ toast('Choose a file first'); return; }
    if(file.size > SP_DOC_MAX_BYTES){ toast('File is over 10 MB'); return; }
    if(!/^(application\/pdf|image\/)/.test(file.type || '')){ toast('Only PDF or image files'); return; }
    if(!(await purchEnsureSession())) return;
    const btn = $('spDocUploadBtn'); btn.disabled = true; btn.textContent = 'Uploading…';
    const safeName = (file.name || 'document').replace(/[^a-zA-Z0-9._-]/g, '_');
    const path = spEditing.id + '/' + Date.now() + '-' + safeName;
    try{
      const up = await db.storage.from(SP_DOC_BUCKET).upload(path, file, { contentType: file.type, upsert:false });
      if(up.error) throw up.error;
      const { error } = await db.from('supplier_documents').insert({
        supplier_id: spEditing.id, doc_type: $('spDocType').value,
        title: $('spDocTitle').value.trim(), storage_path: path,
        file_name: file.name || safeName, mime_type: file.type || '',
        expires_on: $('spDocExpires').value || null
      });
      if(error){
        try{ await db.storage.from(SP_DOC_BUCKET).remove([path]); }catch(_){}
        throw error;
      }
      toast('Document uploaded');
      spResetDocForm();
      spLoadDocs();
    }catch(e){
      purchFail('Upload failed: ', e);
    }finally{ btn.disabled = false; btn.textContent = 'Upload'; }
  });

  // ---------- price list (read-only until the Materials Database is built) ----------
  async function spLoadPrices(opts){
    const list = $('spPricesList');
    if(!(opts && opts.silent)) list.innerHTML = '<div class="empty-state">Loading…</div>';
    try{
      const { data, error } = await db.from('supplier_materials')
        .select('id, supplier_item_code, price, price_unit, price_updated_at, min_order_qty, lead_time_days, is_preferred, is_active, materials(code, name, unit)')
        .eq('supplier_id', spEditing.id);
      if(error) throw error;
      const rows = (data || []).sort((a,b)=> ((a.materials && a.materials.name) || '').localeCompare((b.materials && b.materials.name) || ''));
      if(!rows.length){
        list.innerHTML = '<div class="empty-state" style="padding:16px;">No items priced for this supplier yet.<br>' +
          'Add prices from <b>Purchasing › Materials Database</b> — open an item, then its <b>Supplier Prices</b> tab.</div>';
        return;
      }
      list.innerHTML = '<div class="sp-table-wrap"><table class="sp-table"><thead><tr>' +
        '<th>Item</th><th>Their code</th><th class="num">Price</th><th>Updated</th><th class="num">Lead time</th></tr></thead><tbody>' +
        rows.map(r=>{
          const m = r.materials || {};
          const age = spDaysSince(r.price_updated_at);
          const stale = age != null && age > SP_PRICE_STALE_DAYS;
          return '<tr' + (r.is_active ? '' : ' style="opacity:.55;"') + '><td><b>' + escapeHtml(m.name || '—') + '</b><div class="sp-row-sub">' + escapeHtml(m.code || '') +
              (r.is_preferred ? ' <span class="sp-tag">Preferred</span>' : '') + '</div></td>' +
            '<td>' + escapeHtml(r.supplier_item_code || '—') + '</td>' +
            '<td class="num">' + spMoney(r.price) + '<div class="sp-row-sub">' + escapeHtml(r.price_unit || (m.unit ? 'per ' + m.unit : '')) + '</div></td>' +
            '<td>' + (r.price_updated_at ? escapeHtml(r.price_updated_at) : '—') + (stale ? ' <span class="sp-tag warn">' + age + 'd old</span>' : '') + '</td>' +
            '<td class="num">' + (r.lead_time_days != null ? r.lead_time_days + 'd' : '—') + '</td></tr>';
        }).join('') + '</tbody></table></div>';
    }catch(e){
      list.innerHTML = '<div class="empty-state">Couldn\u2019t load price list: ' + escapeHtml(describeCloudError(e)) + '</div>';
    }
  }

  // ---------- CSV import / export ----------
  // Columns. Bank details are deliberately excluded from both directions.
  const SP_CSV_COLS = ['code','name','trade_name','supplies','address','city','tin','vat_registered',
    'payment_terms','credit_limit','delivers','rating','remarks','is_active',
    'contact_name','contact_position','contact_mobile','contact_email'];

  function spCsvCell(v){
    const t = v == null ? '' : String(v);
    return /[",\r\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
  }
  // RFC 4180-ish parser: quoted fields, escaped quotes, CRLF/LF, embedded newlines.
  // Like Excel, a quote only opens a quoted field when it's the field's first
  // character — so hand-typed inch marks (Copper Tube 3/8" Soft) stay literal
  // instead of swallowing the rest of the row.
  function spParseCsv(text){
    const rows = []; let row = []; let f = ''; let q = false; let atStart = true;
    text = text.replace(/^\uFEFF/, '');
    for(let i = 0; i < text.length; i++){
      const ch = text[i];
      if(q){
        if(ch === '"'){ if(text[i+1] === '"'){ f += '"'; i++; } else q = false; }
        else f += ch;
        continue;
      }
      if(ch === '"' && atStart){ q = true; atStart = false; continue; }
      atStart = false;
      if(ch === ','){ row.push(f); f = ''; atStart = true; }
      else if(ch === '\n' || ch === '\r'){
        if(ch === '\r' && text[i+1] === '\n') i++;
        row.push(f); f = ''; atStart = true;
        if(row.some(c=> c.trim() !== '')) rows.push(row);
        row = [];
      }else f += ch;
    }
    row.push(f);
    if(row.some(c=> c.trim() !== '')) rows.push(row);
    return rows;
  }
  function spCsvBool(v){
    const t = String(v || '').trim().toLowerCase();
    if(['y','yes','true','1','vat','vat-registered','delivers','active'].includes(t)) return true;
    if(['n','no','false','0','non-vat','nonvat','pickup','pickup only','inactive'].includes(t)) return false;
    return null;
  }

  $('spExportBtn').addEventListener('click', ()=>{
    const rows = spFiltered();
    const lines = [SP_CSV_COLS.join(',')].concat(rows.map(s=>{
      const pc = spPrimaryContact(s) || {};
      return [s.code, s.name, s.tradeName, s.supplies.join('; '), s.address, s.city, s.tin,
        s.vatRegistered === null ? '' : (s.vatRegistered ? 'yes' : 'no'),
        s.paymentTerms, s.creditLimit == null ? '' : s.creditLimit, s.delivers ? 'yes' : 'no',
        s.rating || '', s.remarks, s.isActive ? 'yes' : 'no',
        pc.name || '', pc.position || '', pc.mobile || '', pc.email || ''].map(spCsvCell).join(',');
    }));
    // BOM so Excel reads ñ and ₱ correctly
    const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type:'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'suppliers-' + new Date().toISOString().slice(0,10) + '.csv';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(()=> URL.revokeObjectURL(a.href), 2000);
    toast(rows.length ? 'Exported ' + rows.length + ' supplier' + (rows.length === 1 ? '' : 's') : 'Exported a blank template');
  });

  $('spImportBtn').addEventListener('click', ()=>{ $('spImportFile').value = ''; $('spImportFile').click(); });
  $('spImportFile').addEventListener('change', async ()=>{
    const file = $('spImportFile').files && $('spImportFile').files[0];
    if(!file) return;
    if(!(await ensureCloud())){ toast('Not connected — can\u2019t import'); return; }
    if(!(await purchEnsureSession())) return;
    let rows;
    try{ rows = spParseCsv(await file.text()); }catch(e){ toast('Couldn\u2019t read that file'); return; }
    if(rows.length < 2){ toast('The CSV has no data rows'); return; }
    const head = rows[0].map(h=> h.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''));
    if(!head.includes('name')){ toast('CSV needs at least a "name" column'); return; }
    const col = (r, k)=>{ const i = head.indexOf(k); return i < 0 ? undefined : (r[i] || '').trim(); };
    const has = (k)=> head.includes(k);

    const byCode = new Map(spCache.map(s=> [s.code.toLowerCase(), s]));
    const byName = new Map(spCache.map(s=> [s.name.trim().toLowerCase(), s]));
    const inserts = [], updates = [], skipped = [];
    rows.slice(1).forEach((r, idx)=>{
      const name = col(r, 'name');
      if(!name){ skipped.push('row ' + (idx + 2) + ': no name'); return; }
      const row = { name };
      if(has('trade_name')) row.trade_name = col(r, 'trade_name');
      if(has('supplies')){
        const lookup = new Map(PURCH_CAT_ALL.map(c=> [c.toLowerCase(), c]));
        row.supplies = col(r, 'supplies').split(/[;|]/).map(x=> x.trim()).filter(Boolean)
          .map(x=> lookup.get(x.toLowerCase()) || x);
      }
      ['address','city','tin','payment_terms','remarks'].forEach(k=>{ if(has(k)) row[k] = col(r, k); });
      if(has('vat_registered')) row.vat_registered = spCsvBool(col(r, 'vat_registered'));
      if(has('delivers')) row.delivers = spCsvBool(col(r, 'delivers')) === true;
      if(has('is_active') && col(r, 'is_active') !== '') row.is_active = spCsvBool(col(r, 'is_active')) !== false;
      if(has('credit_limit')){
        const n = spParseMoney(col(r, 'credit_limit'));
        if(Number.isNaN(n)){ skipped.push('row ' + (idx + 2) + ': bad credit_limit'); return; }
        row.credit_limit = n;
      }
      if(has('rating')){
        const n = parseInt(col(r, 'rating'), 10);
        row.rating = n >= 1 && n <= 5 ? n : null;
      }
      if(row.payment_terms === '') delete row.payment_terms;
      const code = has('code') ? col(r, 'code') : '';
      const existing = (code && byCode.get(code.toLowerCase())) || byName.get(name.toLowerCase());
      const contact = has('contact_name') && col(r, 'contact_name') ? {
        name: col(r, 'contact_name'), position: col(r, 'contact_position') || '',
        mobile: col(r, 'contact_mobile') || '', email: col(r, 'contact_email') || ''
      } : null;
      if(existing) updates.push({ id: existing.id, row });
      else{
        if(code) row.code = code;
        inserts.push({ row, contact });
      }
    });
    if(!inserts.length && !updates.length){ toast('Nothing to import' + (skipped.length ? ' — ' + skipped[0] : '')); return; }
    if(!confirm('Import ' + file.name + '?\n\n' +
      inserts.length + ' new supplier' + (inserts.length === 1 ? '' : 's') + '\n' +
      updates.length + ' existing supplier' + (updates.length === 1 ? '' : 's') + ' updated (matched by code, then name)\n' +
      (skipped.length ? skipped.length + ' row' + (skipped.length === 1 ? '' : 's') + ' skipped\n' : '') +
      '\nContacts are only added for new suppliers. Bank details are never imported.')) return;

    const btn = $('spImportBtn'); btn.disabled = true; btn.textContent = 'Importing…';
    let okNew = 0, okUpd = 0; const fails = [];
    try{
      if(inserts.length){
        const { data, error } = await db.from('suppliers').insert(inserts.map(x=> x.row)).select('id, name');
        if(error) throw error;
        okNew = (data || []).length;
        const contactRows = [];
        (data || []).forEach(d=>{
          const src = inserts.find(x=> x.row.name === d.name && x.contact);
          if(src) contactRows.push(Object.assign({ supplier_id: d.id, is_primary: true }, src.contact));
        });
        if(contactRows.length){
          const cr = await db.from('supplier_contacts').insert(contactRows);
          if(cr.error) fails.push('contacts: ' + describeCloudError(cr.error));
        }
      }
      for(const u of updates){
        const { error } = await db.from('suppliers').update(u.row).eq('id', u.id);
        if(error) fails.push(u.row.name + ': ' + describeCloudError(error)); else okUpd++;
      }
      toast('Imported: ' + okNew + ' new, ' + okUpd + ' updated' + (fails.length ? ' — ' + fails.length + ' failed (see console)' : ''));
      if(fails.length) console.error('supplier import failures', fails);
    }catch(e){
      purchFail('Import failed: ', e);
    }finally{
      btn.disabled = false; btn.textContent = 'Import CSV';
      if(await spLoad()) spRenderList();
    }
  });

  // =====================================================================
  // Purchasing — Materials Database (admin only)
  //
  // Tables: materials (catalog), supplier_materials (price list; one row
  // per supplier+material, at most one is_preferred per material),
  // supplier_price_history (written by trigger — read-only here).
  // Materials are never hard-deleted, only deactivated. Removing a
  // supplier price also only deactivates the row, so its history is kept.
  // =====================================================================

  const MT_SCOPES = ['Aircon', 'Ventilation', 'General Scope'];
  const MT_CODE_PREFIX = {
    'Piping':'PIP', 'Refrigerant':'REF', 'Electrical':'ELE', 'Insulation':'INS',
    'Consumables':'CON', 'Parts & Components':'PRT', 'Ducting & Ventilation':'DUC',
    'Plumbing':'PLB', 'Fire Protection':'FPR', 'Hardware':'HDW',
    'Tools & Equipment':'TLS', 'Others':'OTH'
  };
  const MT_PAGE = 150;             // rows rendered before "Show more"
  const MT_SELECT = '*, supplier_materials(id, price, price_unit, price_updated_at, is_preferred, is_active, suppliers(id, code, name, trade_name, is_active))';

  let mtCache = [];
  let mtEditing = null;
  let mtSheetScope = [];
  let mtSpecs = [];                // [{k, v}] while the sheet is open
  let mtShowLimit = MT_PAGE;
  let mtSuppliersLite = [];        // for the supplier picker
  let mtPricesCache = [];

  function mtFromRow(r){
    const specs = r.specs && typeof r.specs === 'object' ? r.specs : {};
    return {
      id: r.id, code: r.code || '', name: r.name || '', family: r.family || '',
      category: r.category || 'Others', scope: Array.isArray(r.scope) ? r.scope : [],
      unit: r.unit || '', packUnit: r.pack_unit || '', packQty: r.pack_qty,
      brand: r.brand || '', specs, standardCost: r.standard_cost,
      isActive: r.is_active !== false, notes: r.notes || '',
      prices: Array.isArray(r.supplier_materials) ? r.supplier_materials : []
    };
  }
  // The price to show on the list: preferred active supplier, else the
  // cheapest active one. Returns null when nothing is priced.
  function mtBestPrice(m){
    const live = m.prices.filter(p=> p.is_active && p.price != null && (!p.suppliers || p.suppliers.is_active !== false));
    if(!live.length) return null;
    return live.find(p=> p.is_preferred) || live.slice().sort((a,b)=> Number(a.price) - Number(b.price))[0];
  }
  function mtSupplierLabel(s){ return s ? (s.trade_name || s.name || '') : ''; }
  function mtSpecText(specs){
    return Object.keys(specs || {}).map(k=> k + ': ' + specs[k]).join(' · ');
  }
  // Second line of an item suggestion: brand + every spec, so items that
  // share a name (e.g. several "Copper Tube" sizes) can be told apart.
  function mtSuggestSub(m){
    const bits = [];
    if(m.brand) bits.push('Brand: ' + m.brand);
    const sp = mtSpecText(m.specs);
    if(sp) bits.push(sp);
    return bits.join(' · ');
  }
  // One suggestion button (shared by the PO, requisition and inventory pickers).
  function mtSuggestBtn(m, i, right){
    const sub = mtSuggestSub(m);
    return '<button type="button" data-pick="' + escapeHtml(m.id) + '"' + (i === 0 ? ' class="hl"' : '') + '>' +
      '<span class="s-main"><span class="s-name"><b>' + escapeHtml(m.code) + '</b> ' + escapeHtml(m.name) + '</span>' +
      (sub ? '<span class="s-specs">' + escapeHtml(sub) + '</span>' : '<span class="s-specs s-none">No specs recorded</span>') + '</span>' +
      '<span class="s-price">' + right + '</span></button>';
  }
  function mtNormCode(v){ return String(v || '').trim().toUpperCase().replace(/\s+/g, '-'); }

  async function mtShow(){
    await purchLoadCategories();
    const cat = $('mtFilterCategory');
    if(cat.options.length <= 1){
      PURCH_CAT_ALL.forEach(c=>{ const o = document.createElement('option'); o.value = c; o.textContent = c; cat.appendChild(o); });
      $('mtCategory').innerHTML = purchCategoryOptions();
    }
    mtShowLimit = MT_PAGE;
    if(await mtLoad()) mtRenderList();
  }

  async function mtLoad(opts){
    const silent = !!(opts && opts.silent);
    const list = $('mtList');
    if(!silent) list.innerHTML = '<div class="empty-state">Loading…</div>';
    if(!(await ensureCloud())){
      mtCache = [];
      list.innerHTML = '<div class="empty-state">Not connected to Shared Cloud — the Materials Database needs a connection.</div>';
      return false;
    }
    try{
      const { data, error } = await db.from('materials').select(MT_SELECT).order('code', { ascending:true });
      if(error) throw error;
      mtCache = (data || []).map(mtFromRow);
      mtRefreshDatalists();
      return true;
    }catch(e){
      console.error('load materials failed', describeCloudError(e));
      if(silent) return false;
      mtCache = [];
      const msg = purchIsAuthError(e) ? PURCH_EXPIRED_HTML : /42P01|42703|does not exist/.test(describeCloudError(e))
        ? 'The materials table isn\u2019t ready yet — run migration 20260923_01_purchasing_suppliers_materials.sql in Supabase first.'
        : 'Couldn\u2019t load materials: ' + escapeHtml(describeCloudError(e));
      list.innerHTML = '<div class="empty-state">' + msg + '</div>';
      return false;
    }
  }
  function mtRefreshDatalists(){
    const uniq = (arr)=> Array.from(new Set(arr.filter(Boolean))).sort((a,b)=> a.localeCompare(b));
    $('mtFamilyList').innerHTML = uniq(mtCache.map(m=> m.family)).map(f=> '<option value="' + escapeHtml(f) + '">').join('');
    $('mtBrandList').innerHTML = uniq(mtCache.map(m=> m.brand)).map(f=> '<option value="' + escapeHtml(f) + '">').join('');
  }

  function mtFiltered(){
    const q = ($('mtSearch').value || '').trim().toLowerCase();
    const cat = $('mtFilterCategory').value;
    const scope = $('mtFilterScope').value;
    const showInactive = $('mtShowInactive').checked;
    const words = q.split(/\s+/).filter(Boolean);
    return mtCache.filter(m=>{
      if(!showInactive && !m.isActive) return false;
      if(cat && m.category !== cat) return false;
      if(scope && !m.scope.includes(scope)) return false;
      if(!words.length) return true;
      const hay = [m.code, m.name, m.family, m.brand, m.notes, mtSpecText(m.specs)]
        .concat(m.prices.map(p=> mtSupplierLabel(p.suppliers))).join(' ').toLowerCase();
      return words.every(w=> hay.includes(w));   // every word, any order: "3/8 copper" finds "Copper Tube 3/8"
    });
  }

  function mtRenderList(){
    const list = $('mtList');
    const active = mtCache.filter(m=> m.isActive).length;
    $('mtCount').textContent = mtCache.length ? (active + ' active' + (mtCache.length > active ? ' · ' + (mtCache.length - active) + ' inactive' : '')) : '';
    const rows = mtFiltered();
    if(!rows.length){
      list.innerHTML = '<div class="empty-state">' + (mtCache.length === 0
        ? 'No materials yet. Tap <b>+ Add Material</b>, or use <b>Seed from Service Reports</b> to start from what your technicians already use.'
        : 'No materials match.') + '</div>';
      return;
    }
    // Grouped by category (in the standard category order), then family, then name.
    const order = new Map(PURCH_CAT_ALL.map((c,i)=> [c, i]));
    rows.sort((a,b)=> (order.has(a.category) ? order.get(a.category) : 99) - (order.has(b.category) ? order.get(b.category) : 99)
      || (a.family || a.name).localeCompare(b.family || b.name) || a.name.localeCompare(b.name, undefined, { numeric:true }));
    const shown = rows.slice(0, mtShowLimit);
    const counts = rows.reduce((acc, m)=>{ acc[m.category] = (acc[m.category] || 0) + 1; return acc; }, {});
    let html = '', lastCat = null;
    shown.forEach(m=>{
      if(m.category !== lastCat){
        lastCat = m.category;
        html += '<div class="mt-group-head">' + escapeHtml(m.category) + '<span>' + counts[m.category] + '</span></div>';
      }
      const best = mtBestPrice(m);
      const sub = [m.family && m.family !== m.name ? m.family : '', m.brand, mtSpecText(m.specs),
        m.packUnit && m.packQty ? '1 ' + m.packUnit + ' = ' + m.packQty + ' ' + m.unit : ''].filter(Boolean).join(' · ');
      const tags = m.scope.map(s=> '<span class="sp-tag muted">' + escapeHtml(s) + '</span>').join('') +
        (m.isActive ? '' : '<span class="sp-tag danger">Inactive</span>');
      let priceHtml;
      if(best){
        const age = spDaysSince(best.price_updated_at);
        priceHtml = '<div class="mt-row-price">' + spMoney(best.price) +
          '<div class="sp-row-sub">' + escapeHtml(best.price_unit || 'per ' + m.unit) + '</div>' +
          '<div class="sp-row-sub">' + (best.is_preferred ? '<span class="mt-star">★</span> ' : '') + escapeHtml(mtSupplierLabel(best.suppliers)) + '</div>' +
          (age != null && age > SP_PRICE_STALE_DAYS ? '<span class="sp-tag warn">' + age + 'd old</span>' : '') + '</div>';
      }else if(m.standardCost != null){
        priceHtml = '<div class="mt-row-price none">~' + spMoney(m.standardCost) + '<div class="sp-row-sub">std. cost / ' + escapeHtml(m.unit) + '</div></div>';
      }else{
        priceHtml = '<div class="mt-row-price none">No price</div>';
      }
      html += '<button type="button" class="mt-row' + (m.isActive ? '' : ' inactive') + '" data-id="' + escapeHtml(m.id) + '">' +
        '<div class="mt-row-main"><div class="mt-row-title"><span class="mt-code">' + escapeHtml(m.code) + '</span>' + escapeHtml(m.name) + '</div>' +
        '<div class="sp-row-sub">' + escapeHtml(sub || 'Unit: ' + m.unit) + '</div>' +
        (tags ? '<div class="sp-tags">' + tags + '</div>' : '') + '</div>' + priceHtml + '</button>';
    });
    if(rows.length > shown.length){
      html += '<button type="button" class="btn btn-secondary mt-more" id="mtShowMore">Show ' + Math.min(MT_PAGE, rows.length - shown.length) + ' more (' + (rows.length - shown.length) + ' hidden)</button>';
    }
    list.innerHTML = html;
  }

  const mtResetAndRender = ()=>{ mtShowLimit = MT_PAGE; mtRenderList(); };
  $('mtSearch').addEventListener('input', mtResetAndRender);
  $('mtFilterCategory').addEventListener('change', mtResetAndRender);
  $('mtFilterScope').addEventListener('change', mtResetAndRender);
  $('mtShowInactive').addEventListener('change', mtResetAndRender);
  $('mtAddBtn').addEventListener('click', ()=> mtOpenSheet(null, 'info'));
  $('mtList').addEventListener('click', (e)=>{
    if(e.target.closest('#mtShowMore')){ mtShowLimit += MT_PAGE; mtRenderList(); return; }
    const row = e.target.closest('.mt-row');
    const m = row && mtCache.find(x=> x.id === row.dataset.id);
    if(m) mtOpenSheet(m, 'info');
  });

  // ---------- sheet: details ----------
  function mtRenderScopePick(){
    $('mtScopePick').innerHTML = MT_SCOPES.map(s=>
      '<button type="button" data-scope="' + escapeHtml(s) + '" class="' + (mtSheetScope.includes(s) ? 'on' : '') + '">' + escapeHtml(s) + '</button>').join('');
  }
  $('mtScopePick').addEventListener('click', (e)=>{
    const b = e.target.closest('[data-scope]');
    if(!b) return;
    const s = b.dataset.scope;
    mtSheetScope = mtSheetScope.includes(s) ? mtSheetScope.filter(x=> x !== s) : mtSheetScope.concat(s);
    b.classList.toggle('on');
  });

  function mtRenderSpecs(){
    $('mtSpecsList').innerHTML = mtSpecs.map((sp, i)=>
      '<div class="mt-spec-row" data-i="' + i + '">' +
        '<input type="text" data-f="k" value="' + escapeHtml(sp.k) + '" placeholder="e.g. Size" list="mtSpecKeyList">' +
        '<input type="text" data-f="v" value="' + escapeHtml(sp.v) + '" placeholder=\'e.g. 3/8"\'>' +
        '<button type="button" data-rm="1" title="Remove">&minus;</button></div>').join('') +
      '<datalist id="mtSpecKeyList"><option value="Size"><option value="Gauge"><option value="Thickness"><option value="Length"><option value="Rating"><option value="Voltage"><option value="Capacity"><option value="Refrigerant"><option value="Material"><option value="Color"></datalist>';
  }
  $('mtSpecsList').addEventListener('input', (e)=>{
    const row = e.target.closest('.mt-spec-row');
    if(row && e.target.dataset.f) mtSpecs[Number(row.dataset.i)][e.target.dataset.f] = e.target.value;
  });
  $('mtSpecsList').addEventListener('click', (e)=>{
    if(!e.target.closest('[data-rm]')) return;
    mtSpecs.splice(Number(e.target.closest('.mt-spec-row').dataset.i), 1);
    mtRenderSpecs();
  });
  $('mtAddSpec').addEventListener('click', ()=>{
    mtSpecs.push({ k:'', v:'' });
    mtRenderSpecs();
    const inputs = $('mtSpecsList').querySelectorAll('input[data-f=k]');
    if(inputs.length) inputs[inputs.length - 1].focus();
  });

  function mtUpdatePackPreview(){
    const u = $('mtUnit').value.trim(), pu = $('mtPackUnit').value.trim(), q = $('mtPackQty').value.trim();
    $('mtPackPreview').textContent = (u && pu && q) ? '1 ' + pu + ' = ' + q + ' ' + u : '';
  }
  ['mtUnit','mtPackUnit','mtPackQty'].forEach(id=> $(id).addEventListener('input', mtUpdatePackPreview));

  function mtSuggestCodeFor(category){
    const prefix = MT_CODE_PREFIX[category] || 'MAT';
    const re = new RegExp('^' + prefix + '-(\\d+)$');
    let max = 0;
    mtCache.forEach(m=>{ const mm = m.code.match(re); if(mm) max = Math.max(max, Number(mm[1])); });
    return prefix + '-' + String(max + 1).padStart(3, '0');
  }
  $('mtSuggestCode').addEventListener('click', ()=>{ $('mtCode').value = mtSuggestCodeFor($('mtCategory').value); });
  // New item: keep the suggested code in step with the category until the
  // admin types their own.
  $('mtCategory').addEventListener('change', ()=>{
    if(!mtEditing && (!$('mtCode').value || $('mtCode').dataset.auto === '1')){
      $('mtCode').value = mtSuggestCodeFor($('mtCategory').value);
      $('mtCode').dataset.auto = '1';
    }
  });
  $('mtCode').addEventListener('input', ()=>{ $('mtCode').dataset.auto = ''; });

  // prefill: optional {name, unit, category, ...} for new items (seed / duplicate)
  function mtOpenSheet(m, tab, prefill){
    mtEditing = m;
    $('mtStaleNote').style.display = 'none';
    const src = m || prefill || {};
    $('mtSheetTitle').textContent = m ? m.name : (prefill && prefill.duplicateOf ? 'New size of ' + prefill.duplicateOf : 'Add Material');
    $('mtStatusLine').style.display = m ? '' : 'none';
    $('mtStatusLine').textContent = m ? m.code + (m.isActive ? '' : ' · Inactive') : '';
    $('mtCategory').innerHTML = purchCategoryOptions(src.category);
    $('mtCategory').value = src.category || PURCH_CATEGORIES[0];
    $('mtCode').value = m ? m.code : mtSuggestCodeFor($('mtCategory').value);
    $('mtCode').dataset.auto = m ? '' : '1';
    $('mtName').value = src.name || '';
    $('mtFamily').value = src.family || '';
    $('mtBrand').value = src.brand || '';
    mtSheetScope = (src.scope || []).slice();
    mtRenderScopePick();
    $('mtUnit').value = src.unit || '';
    $('mtPackUnit').value = src.packUnit || '';
    $('mtPackQty').value = src.packQty != null ? String(src.packQty) : '';
    $('mtStdCost').value = src.standardCost != null ? String(src.standardCost) : '';
    mtUpdatePackPreview();
    mtSpecs = Object.keys(src.specs || {}).map(k=> ({ k, v: String(src.specs[k]) }));
    mtRenderSpecs();
    $('mtNotes').value = src.notes || '';
    $('mtSaveBtn').textContent = m ? 'Save Changes' : 'Save Material';
    $('mtSaveBtn').disabled = false;
    $('mtSheetActions').style.display = m ? '' : 'none';
    if(m) $('mtToggleActiveBtn').textContent = m.isActive ? 'Deactivate' : 'Reactivate';
    mtResetPriceForm();
    mtSetTabsEnabled(!!m);
    mtShowTab(m ? tab : 'info');
    $('mtSheetOverlay').classList.add('open');
    if(!m) setTimeout(()=> $(src.name ? 'mtUnit' : 'mtName').focus(), 50);
  }
  function mtSetTabsEnabled(on){
    $$('#mtTabs [data-mt-tab]').forEach(b=>{ if(b.dataset.mtTab !== 'info') b.classList.toggle('sp-seg-disabled', !on); });
  }
  function mtShowTab(tab){
    $$('#mtTabs [data-mt-tab]').forEach(b=> b.classList.toggle('active', b.dataset.mtTab === tab));
    $('mtPaneInfo').style.display = tab === 'info' ? '' : 'none';
    $('mtPanePrices').style.display = tab === 'prices' ? '' : 'none';
    $('mtPaneHistory').style.display = tab === 'history' ? '' : 'none';
    if(!mtEditing) return;
    if(tab === 'prices') mtLoadPrices();
    if(tab === 'history') mtLoadHistory();
  }
  $('mtTabs').addEventListener('click', (e)=>{
    const b = e.target.closest('[data-mt-tab]');
    if(b && !b.classList.contains('sp-seg-disabled')) mtShowTab(b.dataset.mtTab);
  });
  $('mtSheetClose').addEventListener('click', async ()=>{
    $('mtSheetOverlay').classList.remove('open');
    mtEditing = null;
    if(await mtLoad()) mtRenderList();
    if($('mtSeedOverlay').classList.contains('open')) mtSeedRender();
  });

  function mtGatherRow(){
    const num = (id)=> spParseMoney($(id).value);
    const specs = {};
    mtSpecs.forEach(sp=>{ const k = sp.k.trim(), v = sp.v.trim(); if(k && v) specs[k] = v; });
    return {
      code: mtNormCode($('mtCode').value), name: $('mtName').value.trim(),
      family: $('mtFamily').value.trim(), category: $('mtCategory').value,
      scope: mtSheetScope.slice(), unit: $('mtUnit').value.trim(),
      pack_unit: $('mtPackUnit').value.trim() || null, pack_qty: num('mtPackQty'),
      brand: $('mtBrand').value.trim(), specs, standard_cost: num('mtStdCost'),
      notes: $('mtNotes').value.trim()
    };
  }

  $('mtSaveBtn').addEventListener('click', async ()=>{
    const row = mtGatherRow();
    if(!row.code){ toast('Code is required'); $('mtCode').focus(); return; }
    if(!/^[A-Z0-9][A-Z0-9._\-/]*$/.test(row.code)){ toast('Code: letters, numbers, - . / only'); $('mtCode').focus(); return; }
    if(!row.name){ toast('Item name is required'); $('mtName').focus(); return; }
    if(!row.unit){ toast('Issue unit is required (e.g. ft, pc, kg)'); $('mtUnit').focus(); return; }
    if(Number.isNaN(row.pack_qty) || row.pack_qty === 0){ toast('Qty per purchase unit must be a positive number'); $('mtPackQty').focus(); return; }
    if(Number.isNaN(row.standard_cost)){ toast('Standard cost must be a number'); $('mtStdCost').focus(); return; }
    if(row.pack_qty != null && !row.pack_unit){ toast('Enter the purchase unit for that quantity (e.g. roll)'); $('mtPackUnit').focus(); return; }
    const clash = mtCache.find(x=> x.code === row.code && (!mtEditing || x.id !== mtEditing.id));
    if(clash){ toast('Code ' + row.code + ' is already used by ' + clash.name); $('mtCode').focus(); return; }
    const twin = mtCache.find(x=> x.name.trim().toLowerCase() === row.name.toLowerCase() && (!mtEditing || x.id !== mtEditing.id));
    if(twin && !confirm('"' + twin.name + '" already exists as ' + twin.code + '. Save another item with the same name?')) return;
    if(!(await ensureCloud())){ toast('Not connected — can\u2019t save'); return; }
    if(!(await purchEnsureSession())) return;
    const btn = $('mtSaveBtn'); btn.disabled = true;
    try{
      const res = mtEditing
        ? await db.from('materials').update(row).eq('id', mtEditing.id).select(MT_SELECT).single()
        : await db.from('materials').insert(row).select(MT_SELECT).single();
      if(res.error) throw res.error;
      const saved = mtFromRow(res.data);
      purchMarkOwn(saved.id);
      const wasNew = !mtEditing;
      const i = mtCache.findIndex(x=> x.id === saved.id);
      if(i >= 0) mtCache[i] = saved; else mtCache.push(saved);
      mtEditing = saved;
      mtRefreshDatalists();
      mtRenderList();
      $('mtSheetTitle').textContent = saved.name;
      $('mtStatusLine').style.display = ''; $('mtStatusLine').textContent = saved.code + (saved.isActive ? '' : ' · Inactive');
      btn.textContent = 'Save Changes';
      $('mtSheetActions').style.display = '';
      $('mtToggleActiveBtn').textContent = saved.isActive ? 'Deactivate' : 'Reactivate';
      mtSetTabsEnabled(true);
      toast(wasNew ? saved.code + ' saved — add supplier prices next' : 'Material updated');
      if(wasNew) mtShowTab('prices');
    }catch(e){
      const msg = describeCloudError(e);
      if(purchIsAuthError(e)){ purchReauth(); return; }
      toast(/23505/.test(msg) ? 'That code is already in use' : 'Couldn\u2019t save material: ' + msg);
    }finally{ btn.disabled = false; }
  });

  $('mtDuplicateBtn').addEventListener('click', ()=>{
    if(!mtEditing) return;
    const m = mtEditing;
    // New size of the same thing: keep category/family/unit/scope/brand, and
    // the spec *names* (Size, Gauge…) with their values cleared.
    const specs = {};
    Object.keys(m.specs || {}).forEach(k=>{ specs[k] = ''; });
    mtOpenSheet(null, 'info', {
      duplicateOf: m.name, category: m.category, family: m.family || m.name, brand: m.brand,
      scope: m.scope, unit: m.unit, packUnit: m.packUnit, packQty: m.packQty, specs, name: m.family || ''
    });
    mtSpecs = Object.keys(specs).map(k=> ({ k, v:'' }));
    mtRenderSpecs();
    $('mtName').focus();
  });

  $('mtToggleActiveBtn').addEventListener('click', async ()=>{
    const m = mtEditing;
    if(!m) return;
    const on = !m.isActive;
    if(!on && !confirm('Deactivate ' + m.code + ' ' + m.name + '? Technicians won\u2019t be able to pick it; existing records keep it.')) return;
    if(!(await purchEnsureSession())) return;
    const btn = $('mtToggleActiveBtn'); btn.disabled = true;
    try{
      purchMarkOwn(m.id);
      const { error } = await db.from('materials').update({ is_active:on }).eq('id', m.id);
      if(error) throw error;
      m.isActive = on;
      btn.textContent = on ? 'Deactivate' : 'Reactivate';
      $('mtStatusLine').textContent = m.code + (on ? '' : ' · Inactive');
      mtRenderList();
      toast(m.code + (on ? ' reactivated' : ' deactivated'));
    }catch(e){ purchFail('Couldn\u2019t update: ', e); }
    finally{ btn.disabled = false; }
  });

  // ---------- sheet: supplier prices ----------
  async function mtLoadSuppliersLite(){
    const { data, error } = await db.from('suppliers').select('id, code, name, trade_name, is_active').order('name');
    if(error) throw error;
    mtSuppliersLite = data || [];
  }
  function mtFillSupplierSelect(keepId){
    const taken = new Set(mtPricesCache.filter(p=> p.is_active).map(p=> p.supplier_id));
    const opts = mtSuppliersLite
      .filter(s=> s.id === keepId || (s.is_active && !taken.has(s.id)))
      .map(s=> '<option value="' + escapeHtml(s.id) + '">' + escapeHtml(mtSupplierLabel(s)) + ' (' + escapeHtml(s.code) + ')</option>');
    $('mtPriceSupplier').innerHTML = opts.length
      ? '<option value="">Choose a supplier…</option>' + opts.join('')
      : '<option value="">' + (mtSuppliersLite.length ? 'Every active supplier already has a price here' : 'No suppliers yet — add them in Supplier Database') + '</option>';
    if(keepId) $('mtPriceSupplier').value = keepId;
    // Nothing left to add (and not editing an existing price): show a note
    // instead of an empty form.
    const nothingToAdd = !opts.length && !keepId;
    $('mtPriceForm').style.display = nothingToAdd ? 'none' : '';
    $('mtPriceAllDone').style.display = nothingToAdd && mtSuppliersLite.length ? '' : 'none';
    if(nothingToAdd && !mtSuppliersLite.length) $('mtPriceForm').style.display = '';
  }
  function mtResetPriceForm(){
    $('mtPriceId').value = '';
    ['mtPriceAmount','mtPriceItemCode','mtPriceMoq','mtPriceLead'].forEach(id=> $(id).value = '');
    $('mtPriceUnit').value = mtEditing && mtEditing.unit ? mtEditing.unit : '';
    $('mtPriceDate').value = new Date().toISOString().slice(0,10);
    $('mtPricePreferred').checked = false;
    $('mtPriceSupplier').disabled = false;
    $('mtPriceFormTitle').textContent = 'Add a supplier price';
    $('mtPriceCancelBtn').style.display = 'none';
  }
  // opts.silent: no "Loading…" flash. opts.keepForm: a background refresh —
  // leave whatever the admin is typing in the price form alone.
  async function mtLoadPrices(opts){
    const silent = !!(opts && opts.silent), keepForm = !!(opts && opts.keepForm);
    const list = $('mtPricesList');
    if(!silent) list.innerHTML = '<div class="empty-state">Loading…</div>';
    try{
      const [pr] = await Promise.all([
        db.from('supplier_materials').select('*, suppliers(id, code, name, trade_name, is_active)').eq('material_id', mtEditing.id),
        mtLoadSuppliersLite()
      ]);
      if(pr.error) throw pr.error;
      mtPricesCache = (pr.data || []).sort((a,b)=> (b.is_active - a.is_active) || (b.is_preferred - a.is_preferred) || (Number(a.price) - Number(b.price)));
      if(keepForm){
        const editingId = $('mtPriceId').value;
        const chosen = $('mtPriceSupplier').value;
        const editing = editingId && mtPricesCache.find(p=> p.id === editingId);
        mtFillSupplierSelect(editing ? editing.supplier_id : undefined);
        if(editing) $('mtPriceSupplier').disabled = true;
        else if(chosen && Array.from($('mtPriceSupplier').options).some(o=> o.value === chosen)) $('mtPriceSupplier').value = chosen;
      }else{
        mtResetPriceForm();
        mtFillSupplierSelect();
      }
      const live = mtPricesCache.filter(p=> p.is_active);
      if(!live.length){
        list.innerHTML = '<div class="empty-state" style="padding:16px;">No supplier prices yet. Add the first one below.</div>';
      }else{
        const cheapest = Math.min.apply(null, live.filter(p=> p.price != null).map(p=> Number(p.price)));
        list.innerHTML = live.map(p=>{
          const age = spDaysSince(p.price_updated_at);
          const meta = [p.supplier_item_code ? 'Their code ' + escapeHtml(p.supplier_item_code) : '',
            p.min_order_qty != null ? 'MOQ ' + escapeHtml(String(p.min_order_qty)) : '',
            p.lead_time_days != null ? escapeHtml(String(p.lead_time_days)) + 'd lead time' : '',
            p.price_updated_at ? 'priced ' + escapeHtml(p.price_updated_at) : ''].filter(Boolean).join(' · ');
          return '<div class="sp-row" data-id="' + escapeHtml(p.id) + '"><div class="sp-row-top"><div style="min-width:0;">' +
              '<div class="sp-row-title">' + (p.is_preferred ? '<span class="mt-star">★</span> ' : '') + escapeHtml(mtSupplierLabel(p.suppliers)) +
                (p.suppliers && p.suppliers.is_active === false ? ' <span class="sp-tag danger">Supplier inactive</span>' : '') +
                (live.length > 1 && Number(p.price) === cheapest ? ' <span class="sp-tag">Lowest</span>' : '') +
                (age != null && age > SP_PRICE_STALE_DAYS ? ' <span class="sp-tag warn">' + age + 'd old</span>' : '') + '</div>' +
              '<div class="sp-row-sub">' + (meta || '&nbsp;') + '</div></div>' +
            '<div class="mt-row-price">' + spMoney(p.price) + '<div class="sp-row-sub">' + escapeHtml(p.price_unit || 'per ' + mtEditing.unit) + '</div></div></div>' +
            '<div class="user-card-actions">' +
              '<button type="button" data-pact="edit" class="primary">Update price</button>' +
              (p.is_preferred ? '<button type="button" data-pact="unpref">Unset preferred</button>' : '<button type="button" data-pact="pref">Make preferred</button>') +
              '<button type="button" data-pact="remove" class="danger">Remove</button>' +
            '</div></div>';
        }).join('');
      }
    }catch(e){
      list.innerHTML = '<div class="empty-state">Couldn\u2019t load prices: ' + escapeHtml(describeCloudError(e)) + '</div>';
    }
  }
  // Unique "one preferred per material" index → clear the old one first.
  async function mtClearPreferred(exceptId){
    let q = db.from('supplier_materials').update({ is_preferred:false }).eq('material_id', mtEditing.id).eq('is_preferred', true);
    if(exceptId) q = q.neq('id', exceptId);
    const { error } = await q;
    if(error) throw error;
  }
  $('mtPricesList').addEventListener('click', async (e)=>{
    const b = e.target.closest('[data-pact]');
    if(!b) return;
    const p = mtPricesCache.find(x=> x.id === b.closest('.sp-row').dataset.id);
    if(!p) return;
    const act = b.dataset.pact;
    if(act === 'edit'){
      mtFillSupplierSelect(p.supplier_id);
      $('mtPriceSupplier').disabled = true;
      $('mtPriceId').value = p.id;
      $('mtPriceAmount').value = p.price != null ? String(p.price) : '';
      $('mtPriceUnit').value = p.price_unit || mtEditing.unit;
      $('mtPriceDate').value = new Date().toISOString().slice(0,10);   // updating = re-quoted today
      $('mtPriceItemCode').value = p.supplier_item_code || '';
      $('mtPriceMoq').value = p.min_order_qty != null ? String(p.min_order_qty) : '';
      $('mtPriceLead').value = p.lead_time_days != null ? String(p.lead_time_days) : '';
      $('mtPricePreferred').checked = !!p.is_preferred;
      $('mtPriceFormTitle').textContent = 'Update price — ' + mtSupplierLabel(p.suppliers);
      $('mtPriceCancelBtn').style.display = '';
      $('mtPriceAmount').focus();
      return;
    }
    if(!(await purchEnsureSession())) return;
    b.disabled = true;
    try{
      if(act === 'pref'){
        await mtClearPreferred(p.id);
        const { error } = await db.from('supplier_materials').update({ is_preferred:true }).eq('id', p.id);
        if(error) throw error;
        toast(mtSupplierLabel(p.suppliers) + ' is now preferred');
      }else if(act === 'unpref'){
        const { error } = await db.from('supplier_materials').update({ is_preferred:false }).eq('id', p.id);
        if(error) throw error;
      }else if(act === 'remove'){
        if(!confirm('Remove ' + mtSupplierLabel(p.suppliers) + '\u2019s price for this item? Its price history is kept.')){ b.disabled = false; return; }
        const { error } = await db.from('supplier_materials').update({ is_active:false, is_preferred:false }).eq('id', p.id);
        if(error) throw error;
        toast('Price removed');
      }
      mtLoadPrices();
    }catch(err){
      b.disabled = false;
      purchFail('Couldn\u2019t update price: ', err);
    }
  });
  $('mtPriceCancelBtn').addEventListener('click', ()=>{ mtResetPriceForm(); mtFillSupplierSelect(); });
  $('mtPriceSaveBtn').addEventListener('click', async ()=>{
    if(!mtEditing) return;
    const id = $('mtPriceId').value;
    const supplierId = $('mtPriceSupplier').value;
    if(!supplierId){ toast('Choose a supplier'); return; }
    const price = spParseMoney($('mtPriceAmount').value);
    if(price == null || Number.isNaN(price)){ toast('Enter a valid price'); $('mtPriceAmount').focus(); return; }
    const moq = spParseMoney($('mtPriceMoq').value);
    const leadRaw = $('mtPriceLead').value.trim();
    const lead = leadRaw === '' ? null : parseInt(leadRaw, 10);
    if(Number.isNaN(moq) || moq === 0){ toast('Min. order qty must be a positive number'); return; }
    if(leadRaw !== '' && (Number.isNaN(lead) || lead < 0)){ toast('Lead time must be whole days'); return; }
    const preferred = $('mtPricePreferred').checked;
    const unitTxt = $('mtPriceUnit').value.trim();
    const row = {
      price, price_unit: unitTxt ? (/^per\s/i.test(unitTxt) ? unitTxt : 'per ' + unitTxt) : null,
      price_updated_at: $('mtPriceDate').value || new Date().toISOString().slice(0,10),
      supplier_item_code: $('mtPriceItemCode').value.trim(), min_order_qty: moq,
      lead_time_days: lead, is_preferred: preferred, is_active: true
    };
    if(!(await purchEnsureSession())) return;
    const btn = $('mtPriceSaveBtn'); btn.disabled = true;
    try{
      if(preferred) await mtClearPreferred(id || null);
      // A supplier removed earlier still has its (inactive) row — the
      // supplier+material pair is unique — so revive it instead of inserting.
      const existing = id ? { id } : mtPricesCache.find(p=> p.supplier_id === supplierId);
      const res = existing
        ? await db.from('supplier_materials').update(row).eq('id', existing.id)
        : await db.from('supplier_materials').insert(Object.assign({ supplier_id: supplierId, material_id: mtEditing.id }, row));
      if(res.error) throw res.error;
      toast(id ? 'Price updated' : 'Price added');
      mtLoadPrices();
    }catch(e){
      purchFail('Couldn\u2019t save price: ', e);
    }finally{ btn.disabled = false; }
  });

  // ---------- sheet: price history ----------
  async function mtLoadHistory(opts){
    const list = $('mtHistoryList');
    if(!(opts && opts.silent)) list.innerHTML = '<div class="empty-state">Loading…</div>';
    try{
      const sm = await db.from('supplier_materials').select('id, suppliers(code, name, trade_name)').eq('material_id', mtEditing.id);
      if(sm.error) throw sm.error;
      const ids = (sm.data || []).map(r=> r.id);
      if(!ids.length){ list.innerHTML = '<div class="empty-state" style="padding:16px;">No price changes recorded yet.</div>'; return; }
      const names = new Map((sm.data || []).map(r=> [r.id, mtSupplierLabel(r.suppliers)]));
      const { data, error } = await db.from('supplier_price_history').select('*')
        .in('supplier_material_id', ids).order('changed_at', { ascending:false }).limit(200);
      if(error) throw error;
      const rows = data || [];
      if(!rows.length){ list.innerHTML = '<div class="empty-state" style="padding:16px;">No price changes recorded yet.</div>'; return; }
      // change vs. the previous entry for the same supplier
      const prevBySupplier = {};
      const withDelta = rows.slice().reverse().map(r=>{
        const prev = prevBySupplier[r.supplier_material_id];
        prevBySupplier[r.supplier_material_id] = r;
        return Object.assign({ delta: prev && prev.price != null && r.price != null ? Number(r.price) - Number(prev.price) : null, first: !prev }, r);
      }).reverse();
      list.innerHTML = '<p style="font-size:12px; color:var(--text-muted); margin-top:0;">Every price change is logged automatically. Newest first.</p>' +
        '<div class="sp-table-wrap"><table class="sp-table"><thead><tr><th>Date</th><th>Supplier</th><th class="num">Price</th><th class="num">Change</th></tr></thead><tbody>' +
        withDelta.map(r=>{
          const d = r.delta;
          const chg = r.first ? '<span class="sp-tag muted">first</span>'
            : d == null || d === 0 ? '—'
            : '<span style="color:' + (d > 0 ? 'var(--danger)' : 'var(--green-dark)') + '; font-weight:700;">' + (d > 0 ? '+' : '−') + spMoney(Math.abs(d)).replace('₱', '₱') + '</span>';
          return '<tr><td>' + escapeHtml(String(r.changed_at || '').slice(0,10)) + '</td><td>' + escapeHtml(names.get(r.supplier_material_id) || '—') + '</td>' +
            '<td class="num">' + spMoney(r.price) + '<div class="sp-row-sub">' + escapeHtml(r.price_unit || '') + '</div></td><td class="num">' + chg + '</td></tr>';
        }).join('') + '</tbody></table></div>';
    }catch(e){
      list.innerHTML = '<div class="empty-state">Couldn\u2019t load price history: ' + escapeHtml(describeCloudError(e)) + '</div>';
    }
  }

  // ---------- seed from Service Reports ----------
  let mtSeedItems = [];   // [{name, unit, count}]
  function mtNormName(s){ return String(s || '').trim().replace(/\s+/g, ' ').toLowerCase(); }
  $('mtSeedBtn').addEventListener('click', async ()=>{
    $('mtSeedOverlay').classList.add('open');
    $('mtSeedSearch').value = '';
    const list = $('mtSeedList');
    list.innerHTML = '<div class="empty-state">Reading Service Reports…</div>';
    if(!(await ensureCloud())){ list.innerHTML = '<div class="empty-state">Not connected.</div>'; return; }
    try{
      const agg = new Map();
      const PAGE = 1000;
      for(let from = 0; from < 20000; from += PAGE){
        const { data, error } = await db.from('service_reports').select('materials').range(from, from + PAGE - 1);
        if(error) throw error;
        (data || []).forEach(r=> (Array.isArray(r.materials) ? r.materials : []).forEach(it=>{
          const raw = String((it && (it.description || it.details)) || '').trim().replace(/\s+/g, ' ');
          if(!raw) return;
          const key = raw.toLowerCase();
          const e = agg.get(key) || { name: raw, units: {}, count: 0 };
          e.count++;
          const u = String((it && it.unit) || '').trim();
          if(u) e.units[u] = (e.units[u] || 0) + 1;
          agg.set(key, e);
        }));
        if(!data || data.length < PAGE) break;
      }
      mtSeedItems = Array.from(agg.values()).map(e=>({
        name: e.name, count: e.count,
        unit: Object.keys(e.units).sort((a,b)=> e.units[b] - e.units[a])[0] || ''
      })).sort((a,b)=> b.count - a.count || a.name.localeCompare(b.name));
      mtSeedRender();
    }catch(e){
      list.innerHTML = '<div class="empty-state">Couldn\u2019t read Service Reports: ' + escapeHtml(describeCloudError(e)) + '</div>';
    }
  });
  function mtSeedRender(){
    const known = new Set(mtCache.map(m=> mtNormName(m.name)));
    const q = mtNormName($('mtSeedSearch').value);
    const items = mtSeedItems.filter(it=> !known.has(mtNormName(it.name)) && (!q || mtNormName(it.name).includes(q)));
    const list = $('mtSeedList');
    if(!mtSeedItems.length){ list.innerHTML = '<div class="empty-state">No materials found on any Service Report yet.</div>'; return; }
    if(!items.length){ list.innerHTML = '<div class="empty-state">' + (q ? 'No matches.' : 'Everything from your Service Reports is already in the catalog. 🎉') + '</div>'; return; }
    list.innerHTML = items.slice(0, 300).map(it=>
      '<div class="mt-seed-row" data-name="' + escapeHtml(it.name) + '" data-unit="' + escapeHtml(it.unit) + '">' +
        '<div class="mt-seed-main">' + escapeHtml(it.name) + (it.unit ? ' <span class="sp-tag muted">' + escapeHtml(it.unit) + '</span>' : '') + '</div>' +
        '<div class="mt-seed-count">used ' + it.count + '×</div>' +
        '<button type="button">Add</button></div>').join('') +
      (items.length > 300 ? '<div class="empty-state">Showing the 300 most used — filter to find others.</div>' : '');
  }
  $('mtSeedSearch').addEventListener('input', mtSeedRender);
  $('mtSeedList').addEventListener('click', (e)=>{
    const b = e.target.closest('button');
    if(!b) return;
    const row = b.closest('.mt-seed-row');
    // Clean up the typed name a little: Title Case words that were typed all
    // lower-case, keep sizes/codes (3/8", R32, AWG) untouched.
    const name = row.dataset.name.replace(/\b([a-z])([a-z]{2,})\b/g, (m, a, rest)=> a.toUpperCase() + rest);
    mtOpenSheet(null, 'info', { name, unit: row.dataset.unit });
  });
  $('mtSeedClose').addEventListener('click', ()=> $('mtSeedOverlay').classList.remove('open'));

  // ---------- Manage Categories (admin) ----------
  // Add / rename / reorder / hide / delete material categories.
  // Renames go through rename_material_category(), which moves every item
  // and supplier "Supplies" entry to the new name in the same transaction.
  let mcEditId = null;
  let mcBusy = false;
  function mcUsage(name){ return mtCache.filter(m=> m.category === name).length; }
  function mcSuggestPrefix(name){
    const words = String(name || '').toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
    if(!words.length) return '';
    let base = words.length === 1 ? words[0].slice(0, 3) : (words[0].slice(0, 2) + words[1][0]);
    if(base.length < 2) base = (base + 'X').slice(0, 2);
    const used = new Set(purchCats.map(c=> c.code_prefix));
    if(!used.has(base)) return base;
    for(let i = 2; i < 100; i++){ const p = base.slice(0, 4) + i; if(!used.has(p)) return p; }
    return base;
  }
  function mcCheck(name, prefix, selfId){
    if(!name) return 'Enter a category name';
    if(name.length > 60) return 'Keep the name under 60 characters';
    if(purchCats.some(c=> c.id !== selfId && c.name.toLowerCase() === name.toLowerCase())) return 'There is already a category called “' + name + '”';
    if(!/^[A-Z0-9]{2,6}$/.test(prefix)) return 'Code prefix: 2–6 letters or numbers, e.g. WLD';
    const clash = purchCats.find(c=> c.id !== selfId && c.code_prefix === prefix);
    if(clash) return 'Prefix ' + prefix + ' is already used by ' + clash.name;
    return null;
  }
  async function mcOpen(){
    mcEditId = null;
    $('mcNewName').value = ''; $('mcNewPrefix').value = ''; $('mcNewPrefix').dataset.typed = '';
    $('mcSheetOverlay').classList.add('open');
    $('mcList').innerHTML = '<div class="empty-state">Loading…</div>';
    await purchLoadCategories(true);
    mcRender();
  }
  function mcRender(){
    const list = $('mcList');
    $('mcAddRow').style.display = purchCatsMissing ? 'none' : '';
    if(purchCatsMissing){
      list.innerHTML = '<div class="empty-state">Categories can\u2019t be managed yet — run migration <b>20260925_01_material_categories.sql</b> in Supabase first. Until then the standard list is used.</div>';
      return;
    }
    if(!purchCats.length){ list.innerHTML = '<div class="empty-state">No categories yet.</div>'; return; }
    const movable = purchCats.filter(c=> !c.is_system);
    list.innerHTML = purchCats.map(c=>{
      const n = mcUsage(c.name);
      const idx = movable.indexOf(c);
      if(c.id === mcEditId){
        return '<div class="mc-row editing" data-id="' + escapeHtml(c.id) + '">' +
          '<div class="mc-edit"><input type="text" data-mc-f="name" value="' + escapeHtml(c.name) + '" maxlength="60" placeholder="Category name">' +
          '<input type="text" data-mc-f="prefix" value="' + escapeHtml(c.code_prefix) + '" maxlength="6" placeholder="Code">' +
          '<div class="mc-edit-note">' + (n ? 'Renaming moves all ' + n + ' item' + (n === 1 ? '' : 's') + ' and any supplier listing to the new name. ' : '') +
            'A new prefix only affects new item codes — existing codes stay as they are.</div></div>' +
          '<div class="mc-acts"><button type="button" class="btn btn-primary" data-mc="save">Save</button><button type="button" class="btn btn-secondary" data-mc="cancel">Cancel</button></div></div>';
      }
      return '<div class="mc-row' + (c.is_active ? '' : ' off') + '" data-id="' + escapeHtml(c.id) + '">' +
        '<div class="mc-move">' + (c.is_system ? '' :
          '<button type="button" data-mc="up" title="Move up"' + (idx <= 0 ? ' disabled' : '') + '>&#9650;</button>' +
          '<button type="button" data-mc="down" title="Move down"' + (idx >= movable.length - 1 ? ' disabled' : '') + '>&#9660;</button>') + '</div>' +
        '<div class="mc-main"><div class="mc-name">' + escapeHtml(c.name) + ' <span class="mc-prefix">' + escapeHtml(c.code_prefix) + '</span>' +
          (c.is_active ? '' : ' <span class="mc-tag">Hidden</span>') + (c.is_system ? ' <span class="mc-tag sys">Fallback</span>' : '') + '</div>' +
          '<div class="mc-sub">' + (n ? n + ' item' + (n === 1 ? '' : 's') : 'No items') + '</div></div>' +
        '<div class="mc-acts">' + (c.is_system ? '<button type="button" class="mc-btn" data-mc="edit" title="Change the code prefix">Prefix</button>' :
          '<button type="button" class="mc-btn" data-mc="edit">Edit</button>' +
          '<button type="button" class="mc-btn" data-mc="toggle">' + (c.is_active ? 'Hide' : 'Show') + '</button>' +
          (n ? '' : '<button type="button" class="mc-btn danger" data-mc="del">Delete</button>')) + '</div></div>';
    }).join('');
    const ed = list.querySelector('.mc-row.editing');
    if(ed){
      const nameEl = ed.querySelector('[data-mc-f="name"]');
      const isSys = purchCats.some(c=> c.id === mcEditId && c.is_system);
      if(isSys){ nameEl.readOnly = true; nameEl.title = 'The fallback category can\u2019t be renamed'; }
      (isSys ? ed.querySelector('[data-mc-f="prefix"]') : nameEl).focus();
    }
  }
  // After a change: reload categories, and items too when a rename moved them.
  async function mcAfterChange(reloadItems){
    await purchLoadCategories(true);
    mcRender();
    if(reloadItems) await mtLoad({ silent:true });
    if(purchVisible('materials')) mtRenderList();
    if(reloadItems && typeof spLoad === 'function' && spCache.length) spLoad({ silent:true });
  }
  async function mcRun(fn, fail){
    if(mcBusy) return;
    if(!(await ensureCloud())){ toast('Not connected'); return; }
    if(!(await purchEnsureSession())) return;
    mcBusy = true; $('mcList').classList.add('busy');
    try{ await fn(); }
    catch(e){ purchFail(fail, e); }
    finally{ mcBusy = false; $('mcList').classList.remove('busy'); }
  }
  $('mcNewName').addEventListener('input', ()=>{
    if($('mcNewPrefix').dataset.typed !== '1') $('mcNewPrefix').value = mcSuggestPrefix($('mcNewName').value.trim());
  });
  $('mcNewPrefix').addEventListener('input', (e)=>{ e.target.dataset.typed = e.target.value ? '1' : ''; e.target.value = e.target.value.toUpperCase(); });
  const mcAdd = ()=> mcRun(async ()=>{
    const name = $('mcNewName').value.trim().replace(/\s+/g, ' ');
    const prefix = ($('mcNewPrefix').value || mcSuggestPrefix(name)).trim().toUpperCase();
    const err = mcCheck(name, prefix, null);
    if(err){ toast(err); return; }
    const movable = purchCats.filter(c=> !c.is_system);
    const sort = (movable.length ? Math.max(...movable.map(c=> c.sort_order)) : 0) + 10;
    const { error } = await db.from('material_categories').insert({ name, code_prefix: prefix, sort_order: sort });
    if(error) throw error;
    $('mcNewName').value = ''; $('mcNewPrefix').value = ''; $('mcNewPrefix').dataset.typed = '';
    toast('Added “' + name + '”');
    await mcAfterChange(false);
    $('mcNewName').focus();
  }, 'Couldn\u2019t add the category: ');
  $('mcAddBtn').addEventListener('click', mcAdd);
  $('mcAddRow').addEventListener('keydown', (e)=>{ if(e.key === 'Enter'){ e.preventDefault(); mcAdd(); } });

  $('mcList').addEventListener('keydown', (e)=>{
    if(!e.target.closest('.mc-row.editing')) return;
    if(e.key === 'Enter'){ e.preventDefault(); e.target.closest('.mc-row').querySelector('[data-mc="save"]').click(); }
    if(e.key === 'Escape'){ e.preventDefault(); mcEditId = null; mcRender(); }
  });
  $('mcList').addEventListener('input', (e)=>{ if(e.target.dataset.mcF === 'prefix') e.target.value = e.target.value.toUpperCase(); });
  $('mcList').addEventListener('click', (e)=>{
    const b = e.target.closest('[data-mc]'); if(!b || b.disabled) return;
    const row = b.closest('.mc-row');
    const c = purchCats.find(x=> x.id === row.dataset.id); if(!c) return;
    const act = b.dataset.mc;
    if(act === 'edit'){ mcEditId = c.id; mcRender(); return; }
    if(act === 'cancel'){ mcEditId = null; mcRender(); return; }
    if(act === 'save') return mcRun(async ()=>{
      const name = row.querySelector('[data-mc-f="name"]').value.trim().replace(/\s+/g, ' ');
      const prefix = row.querySelector('[data-mc-f="prefix"]').value.trim().toUpperCase();
      const err = mcCheck(name, prefix, c.id);
      if(err){ toast(err); return; }
      const renamed = name !== c.name;
      if(renamed){
        const n = mcUsage(c.name);
        if(n && !confirm('Rename “' + c.name + '” to “' + name + '”?\n\nAll ' + n + ' item' + (n === 1 ? '' : 's') + ' in it, and suppliers that list it, will move to the new name.')) return;
        const { error } = await db.rpc('rename_material_category', { p_id: c.id, p_name: name });
        if(error) throw error;
      }
      if(prefix !== c.code_prefix){
        const { error } = await db.from('material_categories').update({ code_prefix: prefix }).eq('id', c.id);
        if(error) throw error;
      }
      mcEditId = null;
      toast(renamed ? 'Renamed to “' + name + '”' : 'Saved');
      await mcAfterChange(renamed);
    }, 'Couldn\u2019t save the category: ');
    if(act === 'toggle') return mcRun(async ()=>{
      const { error } = await db.from('material_categories').update({ is_active: !c.is_active }).eq('id', c.id);
      if(error) throw error;
      toast(c.is_active ? '“' + c.name + '” hidden — existing items keep it' : '“' + c.name + '” is available again');
      await mcAfterChange(false);
    }, 'Couldn\u2019t update the category: ');
    if(act === 'del'){
      if(!confirm('Delete the category “' + c.name + '”?')) return;
      return mcRun(async ()=>{
        const { error } = await db.from('material_categories').delete().eq('id', c.id);
        if(error) throw error;
        toast('Deleted “' + c.name + '”');
        await mcAfterChange(false);
      }, 'Couldn\u2019t delete: ');
    }
    if(act === 'up' || act === 'down') return mcRun(async ()=>{
      const movable = purchCats.filter(x=> !x.is_system);
      const i = movable.indexOf(c), j = act === 'up' ? i - 1 : i + 1;
      if(j < 0 || j >= movable.length) return;
      [movable[i], movable[j]] = [movable[j], movable[i]];
      // Renumber 10, 20, 30… and save only the rows whose position changed.
      const changes = movable.map((x, k)=> ({ x, sort: (k + 1) * 10 })).filter(o=> o.x.sort_order !== o.sort);
      const res = await Promise.all(changes.map(o=> db.from('material_categories').update({ sort_order: o.sort }).eq('id', o.x.id)));
      const bad = res.find(r=> r.error); if(bad) throw bad.error;
      await mcAfterChange(false);
    }, 'Couldn\u2019t reorder: ');
  });
  $('mcBtn').addEventListener('click', mcOpen);
  $('mcSheetClose').addEventListener('click', ()=>{ mcEditId = null; $('mcSheetOverlay').classList.remove('open'); });

  // ---------- CSV import / export ----------
  const MT_CSV_COLS = ['code','name','family','category','scope','unit','pack_unit','pack_qty','brand','specs','standard_cost','notes','is_active'];
  // specs travel as "Size=3/8""; Gauge=22"
  function mtSpecsToCsv(specs){ return Object.keys(specs || {}).map(k=> k + '=' + specs[k]).join('; '); }
  function mtSpecsFromCsv(txt){
    const o = {};
    String(txt || '').split(';').forEach(part=>{
      const i = part.indexOf('=');
      if(i > 0){ const k = part.slice(0, i).trim(), v = part.slice(i + 1).trim(); if(k && v) o[k] = v; }
    });
    return o;
  }
  $('mtExportBtn').addEventListener('click', ()=>{
    const rows = mtFiltered();
    const lines = [MT_CSV_COLS.join(',')].concat(rows.map(m=> [
      m.code, m.name, m.family, m.category, m.scope.join('; '), m.unit, m.packUnit, m.packQty == null ? '' : m.packQty,
      m.brand, mtSpecsToCsv(m.specs), m.standardCost == null ? '' : m.standardCost, m.notes, m.isActive ? 'yes' : 'no'
    ].map(spCsvCell).join(',')));
    const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type:'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'materials-' + new Date().toISOString().slice(0,10) + '.csv';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(()=> URL.revokeObjectURL(a.href), 2000);
    toast(rows.length ? 'Exported ' + rows.length + ' item' + (rows.length === 1 ? '' : 's') : 'Exported a blank template');
  });
  $('mtImportBtn').addEventListener('click', ()=>{ $('mtImportFile').value = ''; $('mtImportFile').click(); });
  $('mtImportFile').addEventListener('change', async ()=>{
    const file = $('mtImportFile').files && $('mtImportFile').files[0];
    if(!file) return;
    if(!(await ensureCloud())){ toast('Not connected — can\u2019t import'); return; }
    if(!(await purchEnsureSession())) return;
    let rows;
    try{ rows = spParseCsv(await file.text()); }catch(e){ toast('Couldn\u2019t read that file'); return; }
    if(rows.length < 2){ toast('The CSV has no data rows'); return; }
    const head = rows[0].map(h=> h.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''));
    const missing = ['name','unit'].filter(k=> !head.includes(k));
    if(missing.length){ toast('CSV needs columns: ' + missing.join(', ')); return; }
    const col = (r, k)=>{ const i = head.indexOf(k); return i < 0 ? undefined : (r[i] || '').trim(); };
    const has = (k)=> head.includes(k);
    const catLookup = new Map(PURCH_CAT_ALL.map(c=> [c.toLowerCase(), c]));
    const scopeLookup = new Map(MT_SCOPES.map(s=> [s.toLowerCase(), s]));
    const byCode = new Map(mtCache.map(m=> [m.code, m]));
    const usedCodes = new Set(mtCache.map(m=> m.code));
    const nextCode = (cat)=>{   // auto-code rows without one, avoiding clashes within this file too
      const prefix = MT_CODE_PREFIX[cat] || 'MAT';
      let n = 1; const re = new RegExp('^' + prefix + '-(\\d+)$');
      usedCodes.forEach(c=>{ const mm = c.match(re); if(mm) n = Math.max(n, Number(mm[1]) + 1); });
      const code = prefix + '-' + String(n).padStart(3, '0'); usedCodes.add(code); return code;
    };
    const inserts = [], updates = [], skipped = [];
    rows.slice(1).forEach((r, idx)=>{
      const line = 'row ' + (idx + 2);
      const name = col(r, 'name'), unit = col(r, 'unit');
      if(!name || !unit){ skipped.push(line + ': needs name and unit'); return; }
      const category = has('category') ? (catLookup.get((col(r, 'category') || '').toLowerCase()) || 'Others') : 'Others';
      const row = { name, unit, category };
      ['family','brand','notes'].forEach(k=>{ if(has(k)) row[k] = col(r, k); });
      if(has('pack_unit')) row.pack_unit = col(r, 'pack_unit') || null;
      if(has('scope')) row.scope = col(r, 'scope').split(/[;|,]/).map(x=> scopeLookup.get(x.trim().toLowerCase())).filter(Boolean);
      if(has('specs')) row.specs = mtSpecsFromCsv(col(r, 'specs'));
      if(has('is_active') && col(r, 'is_active') !== '') row.is_active = spCsvBool(col(r, 'is_active')) !== false;
      for(const k of ['pack_qty', 'standard_cost']){
        if(!has(k)) continue;
        const n = spParseMoney(col(r, k));
        if(Number.isNaN(n) || (k === 'pack_qty' && n === 0)){ skipped.push(line + ': bad ' + k); return; }
        row[k] = n;
      }
      const code = has('code') ? mtNormCode(col(r, 'code')) : '';
      if(code && byCode.has(code)) updates.push({ id: byCode.get(code).id, row });
      else{ row.code = code || nextCode(category); usedCodes.add(row.code); inserts.push(row); }
    });
    if(!inserts.length && !updates.length){ toast('Nothing to import' + (skipped.length ? ' — ' + skipped[0] : '')); return; }
    if(!confirm('Import ' + file.name + '?\n\n' +
      inserts.length + ' new item' + (inserts.length === 1 ? '' : 's') + ' (rows without a code get one automatically)\n' +
      updates.length + ' existing item' + (updates.length === 1 ? '' : 's') + ' updated (matched by code)\n' +
      (skipped.length ? skipped.length + ' row' + (skipped.length === 1 ? '' : 's') + ' skipped — ' + skipped.slice(0, 3).join('; ') + '\n' : '') +
      '\nSupplier prices aren\u2019t part of this file.')) return;
    const btn = $('mtImportBtn'); btn.disabled = true; btn.textContent = 'Importing…';
    let okNew = 0, okUpd = 0; const fails = [];
    try{
      for(let i = 0; i < inserts.length; i += 200){
        const { data, error } = await db.from('materials').insert(inserts.slice(i, i + 200)).select('id');
        if(error) throw error;
        okNew += (data || []).length;
      }
      for(const u of updates){
        const { error } = await db.from('materials').update(u.row).eq('id', u.id);
        if(error) fails.push(u.row.name + ': ' + describeCloudError(error)); else okUpd++;
      }
      toast('Imported: ' + okNew + ' new, ' + okUpd + ' updated' + (fails.length ? ' — ' + fails.length + ' failed (see console)' : ''));
      if(fails.length) console.error('material import failures', fails);
    }catch(e){
      const msg = describeCloudError(e);
      if(purchIsAuthError(e)){ purchReauth(); return; }
      toast(/23505/.test(msg) ? 'Import stopped: a code in the file is already used' : 'Import failed: ' + msg);
    }finally{
      btn.disabled = false; btn.textContent = 'Import CSV';
      if(await mtLoad()) mtRenderList();
    }
  });


  // =====================================================================
  // Purchasing — live updates (Supabase Realtime)
  //
  // One channel for all purchasing tables (published by migration
  // 20260923_02_purchasing_realtime.sql). Any insert/update/delete —
  // from this device or another admin's — queues a short-debounced,
  // silent refresh of just the parts that are on screen:
  //   * the Supplier / Materials lists (expanded cards stay expanded)
  //   * an open sheet's Contacts / Documents / Prices / History tab
  //   * the supplier picker in "Add a supplier price" (without wiping what's
  //     being typed)
  // Forms are never overwritten. If the supplier/material open in a sheet is
  // changed elsewhere, a notice offers to reload it instead.
  // Missed events (socket dropped, phone asleep) are covered by a refresh
  // when the app regains focus or the connection comes back.
  // =====================================================================
  const PURCH_RT_TABLES = ['suppliers', 'supplier_contacts', 'supplier_documents', 'materials', 'supplier_materials',
    'purchase_orders', 'purchase_order_items', 'po_signatories', 'po_settings',
    'material_requisitions', 'material_requisition_items',
    'warehouses', 'warehouse_storekeepers', 'projects', 'project_job_orders', 'stock_balances', 'stock_movements',
    'stock_receipts', 'issue_slips', 'return_slips', 'stock_transfers', 'material_categories'];
  let purchChannel = null;
  let purchPending = new Set();
  let purchPendingIds = new Set();
  let purchTimer = null;
  const purchOwn = new Map();      // id -> time of our own write

  function purchMarkOwn(id){ if(id) purchOwn.set(id, Date.now()); }
  function purchIsOwn(id){ const t = purchOwn.get(id); return !!t && Date.now() - t < 5000; }
  function purchVisible(panel){
    return $('purchasingView').style.display !== 'none' && $('purchPanel_' + panel).style.display !== 'none';
  }
  function purchSheetTab(prefix){   // active tab of an open sheet, else null
    if(!$(prefix + 'SheetOverlay').classList.contains('open')) return null;
    const b = document.querySelector('#' + prefix + 'Tabs .seg-tab.active');
    return b ? (b.dataset.spTab || b.dataset.mtTab) : null;
  }
  function purchSetLive(state){
    $$('.purch-live').forEach(el=>{
      el.className = 'purch-live ' + state;
      el.textContent = state === 'on' ? 'Live' : state === 'off' ? 'Offline' : 'Connecting…';
      el.title = state === 'on' ? 'Updates appear automatically'
        : state === 'off' ? 'Live updates paused — will refresh when the connection is back' : '';
    });
  }

  function purchRealtimeStart(){
    if(purchChannel || !db || typeof db.channel !== 'function') return;
    purchSetLive('connecting');
    let ch = db.channel('purchasing-admin-' + (currentUser && currentUser.id || 'x'));
    PURCH_RT_TABLES.forEach(t=>{
      ch = ch.on('postgres_changes', { event:'*', schema:'public', table:t }, (payload)=> purchQueue(t, payload));
    });
    purchChannel = ch.subscribe((status)=>{
      if(status === 'SUBSCRIBED'){
        // (Re)connected: catch up on anything missed while we were down.
        const wasOff = document.querySelector('.purch-live.off');
        purchSetLive('on');
        if(wasOff) purchQueueAll();
      }else if(status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED'){
        purchSetLive('off');
      }
    });
  }
  function purchRealtimeTeardown(){
    clearTimeout(purchTimer); purchTimer = null;
    purchPending.clear(); purchPendingIds.clear();
    if(purchChannel && db){ try{ db.removeChannel(purchChannel); }catch(e){} }
    purchChannel = null;
  }

  function purchQueue(table, payload){
    purchPending.add(table);
    const row = payload && (payload.new && payload.new.id ? payload.new : payload.old);
    if(row && row.id && (table === 'suppliers' || table === 'materials') && !purchIsOwn(row.id)){
      purchPendingIds.add(table + ':' + row.id);
    }
    // A PO changed elsewhere: header events carry the PO id, item events its po_id.
    const poId = row && (table === 'purchase_orders' ? row.id : table === 'purchase_order_items' ? row.po_id : null);
    if(poId && !purchIsOwn(poId)) purchPendingIds.add('po:' + poId);
    const mrId = row && (table === 'material_requisitions' ? row.id : table === 'material_requisition_items' ? row.mr_id : null);
    if(mrId && !purchIsOwn(mrId)) purchPendingIds.add('mr:' + mrId);
    clearTimeout(purchTimer);
    // Debounced: a CSV import fires hundreds of events — refresh once.
    purchTimer = setTimeout(purchApply, 400);
  }
  function purchQueueAll(){ PURCH_RT_TABLES.forEach(t=> purchPending.add(t)); clearTimeout(purchTimer); purchTimer = setTimeout(purchApply, 50); }

  async function purchApply(){
    const t = purchPending; purchPending = new Set();
    const ids = purchPendingIds; purchPendingIds = new Set();
    if(!currentUser || currentUser.role !== 'admin') return;
    const has = (...names)=> names.some(n=> t.has(n));
    const jobs = [];

    // Supplier Database
    if(has('suppliers', 'supplier_contacts') && purchVisible('suppliers')){
      jobs.push(spLoad({ silent:true }).then(ok=>{ if(ok) spRenderList(); }));
    }
    const spTab = purchSheetTab('sp');
    if(spTab && spEditing){
      if(spTab === 'contacts' && has('supplier_contacts')) jobs.push(spLoadContacts({ silent:true }));
      if(spTab === 'docs' && has('supplier_documents')) jobs.push(spLoadDocs({ silent:true }));
      if(spTab === 'prices' && has('supplier_materials', 'materials')) jobs.push(spLoadPrices({ silent:true }));
      if(ids.has('suppliers:' + spEditing.id)) $('spStaleNote').style.display = '';
    }

    // Categories: reload the lists (and every dropdown), redraw the manager
    if(has('material_categories')){
      jobs.push(purchLoadCategories(true).then(()=>{
        if($('mcSheetOverlay').classList.contains('open')) mcRender();
        if(purchVisible('materials')) mtRenderList();
      }));
    }
    // Materials Database (its rows also show supplier names, so supplier
    // renames/deactivations refresh it too)
    if(has('materials', 'supplier_materials', 'suppliers') && purchVisible('materials')){
      jobs.push(mtLoad({ silent:true }).then(ok=>{
        if(!ok) return;
        mtRenderList();
        if($('mtSeedOverlay').classList.contains('open')) mtSeedRender();
      }));
    }
    const mtTab = purchSheetTab('mt');
    if(mtTab && mtEditing){
      if(mtTab === 'prices' && has('supplier_materials', 'suppliers')) jobs.push(mtLoadPrices({ silent:true, keepForm:true }));
      if(mtTab === 'history' && has('supplier_materials')) jobs.push(mtLoadHistory({ silent:true }));
      if(ids.has('materials:' + mtEditing.id)) $('mtStaleNote').style.display = '';
    }
    // Purchase Orders
    if(typeof poLoadList === 'function' && has('purchase_orders', 'purchase_order_items', 'suppliers') && purchVisible('purchaseOrders')){
      jobs.push(poLoadList({ silent:true }).then(ok=>{ if(ok) poRenderList(); }));
    }
    if(typeof poEditorVisible === 'function' && poEditorVisible()){
      if(poEditing && ids.has('po:' + poEditing.id)) $('poStaleNote').style.display = '';
      if(has('po_signatories')) jobs.push(poLoadSignatories().then(()=>{ poFillSignatorySelects(); poRenderSigHint(); }).catch(()=>{}));
      if(has('suppliers', 'supplier_contacts')) jobs.push(poLoadSuppliers().then(()=>{
        const cur = $('poSupplier').value; poFillSupplierSelect(cur); $('poSupplier').value = cur; poRenderSupplierInfo();
        $('poSupplier').disabled = poReadOnly;
      }).catch(()=>{}));
      if(has('materials', 'supplier_materials') && !purchVisible('materials')) jobs.push(mtLoad({ silent:true }));
    }
    if($('poSettingsOverlay').classList.contains('open')){
      if(has('po_signatories')) jobs.push(poLoadSignatories().then(poRenderSigList).catch(()=>{}));
    }
    // Material Requisitions (a PO being issued/cancelled/deleted changes
    // fulfilment too, so PO events refresh an open request)
    if(typeof mrLoadList === 'function' && purchVisible('requisitions')){
      if(has('material_requisitions', 'material_requisition_items')) jobs.push(mrLoadList({ silent:true }).then(ok=>{ if(ok && !mrDetailVisible()) mrRenderList(); }));
      if(mrDetailVisible() && mrOpenRow){
        if(ids.has('mr:' + mrOpenRow.id) && mrOpenRow.status === 'submitted') $('mrStaleNote').style.display = '';
        else if(ids.has('mr:' + mrOpenRow.id) || has('purchase_orders')) jobs.push(mrOpen(mrOpenRow.id));
      }
    }
    // Inventory
    if(typeof invShowStock === 'function'){
      if(purchVisible('stock') && has('stock_balances', 'stock_movements', 'warehouses', 'materials')){
        if($('invOpeningView').style.display === 'none') jobs.push(invLoadStock({ silent:true }).then(ok=>{ if(ok && invItemOpen) return invRenderItem(); }));
      }
      if(purchVisible('warehouses') && has('warehouses', 'warehouse_storekeepers', 'stock_balances')) jobs.push(invShowWarehouses({ silent:true }));
      if(purchVisible('projects') && has('projects', 'project_job_orders', 'stock_movements') && $('invPrjEditView').style.display === 'none') jobs.push(invShowProjects({ silent:true }));
      if(purchVisible('slips') && has('stock_receipts', 'issue_slips', 'return_slips', 'stock_transfers') && $('invSlipView').style.display === 'none') jobs.push(invShowSlips({ silent:true }));
    }
    try{ await Promise.all(jobs); }catch(e){ console.error('purchasing live refresh failed', e); }
  }

  // Reload the open item from the latest data (after the stale notice).
  $('spStaleReload').addEventListener('click', ()=>{
    const cur = spEditing && spCache.find(x=> x.id === spEditing.id);
    const tab = purchSheetTab('sp') || 'info';
    if(cur) spOpenSheet(cur, tab);
  });
  $('mtStaleReload').addEventListener('click', ()=>{
    const cur = mtEditing && mtCache.find(x=> x.id === mtEditing.id);
    const tab = purchSheetTab('mt') || 'info';
    if(cur) mtOpenSheet(cur, tab);
  });

  // Catch-up when the tab/app comes back or the network returns.
  function purchCatchUp(){
    if(!purchChannel || !currentUser || currentUser.role !== 'admin') return;
    if($('purchasingView').style.display === 'none') return;
    purchQueueAll();
  }
  document.addEventListener('visibilitychange', ()=>{ if(document.visibilityState === 'visible') purchCatchUp(); });
  window.addEventListener('online', purchCatchUp);


  // =====================================================================
  // Purchasing — expired sign-in handling
  //
  // The app restores `currentUser` from localStorage, which can outlive the
  // real Supabase Auth session (expired refresh token, long-idle tab,
  // signed out elsewhere, admin password changed). Requests then go out as
  // `anon`, which every purchasing table refuses (42501 "permission denied
  // … TO anon"). Instead of that raw error:
  //   * each write first checks for a live session (purchEnsureSession);
  //   * if it's gone, a small "Sign in again" box asks for the admin
  //     password — the sheet and anything typed in it stay as they are —
  //     and the write then carries on by itself;
  //   * any request that still fails that way opens the same box.
  // =====================================================================
  const PURCH_EXPIRED_HTML = 'Your admin sign-in has expired, so the database can\u2019t be read. ' +
    '<button type="button" class="btn btn-primary mt-small-btn" data-purch-reauth="1" style="margin-top:10px;">Sign in again</button>';
  let purchReauthWaiters = [];

  // Reads the raw error fields (the "TO anon" part lives in .hint), so it
  // doesn't depend on how describeCloudError formats things.
  function purchErrText(e){
    if(!e) return '';
    return [e.code, e.message, e.details, e.hint, e.error_description, e.name].filter(Boolean).join(' | ') || String(e);
  }
  function purchIsAuthError(e){
    const m = purchErrText(e);
    return (/42501/.test(m) && /\banon\b/i.test(m)) || /PGRST30[123]|JWT expired|invalid JWT|jwt malformed/i.test(m);
  }
  // "permission denied" (42501, not an RLS row check) should never happen to
  // a signed-in admin on these tables — if the hint didn't say so, confirm
  // by checking whether the session is actually still alive.
  function purchIsPermissionDenied(e){
    const m = purchErrText(e);
    return /42501/.test(m) && /permission denied/i.test(m);
  }
  async function purchFail(prefix, e){
    if(purchIsAuthError(e)){ purchReauth(); return; }
    if(purchIsPermissionDenied(e) && !(await cloudAuthUid())){ purchReauth(); return; }
    toast(prefix + describeCloudError(e));
  }
  async function purchEnsureSession(){
    const uid = await cloudAuthUid();
    if(uid) return true;
    return purchReauth();
  }
  // Resolves true once signed back in, false if the admin backs out.
  function purchReauth(){
    return new Promise((resolve)=>{
      purchReauthWaiters.push(resolve);
      if($('purchReauthOverlay').classList.contains('open')) return;
      $('purchReauthPw').value = '';
      $('purchReauthErr').textContent = '';
      $('purchReauthBtn').disabled = false;
      $('purchReauthOverlay').classList.add('open');
      setTimeout(()=> $('purchReauthPw').focus(), 50);
    });
  }
  function purchReauthDone(ok){
    $('purchReauthOverlay').classList.remove('open');
    const w = purchReauthWaiters; purchReauthWaiters = [];
    w.forEach(r=> r(ok));
  }
  async function purchReauthSubmit(){
    const pw = $('purchReauthPw').value;
    if(!pw){ $('purchReauthErr').textContent = 'Enter the admin password.'; return; }
    const btn = $('purchReauthBtn'); btn.disabled = true; btn.textContent = 'Signing in…';
    try{
      const { data, error } = await db.auth.signInWithPassword({ email: ADMIN_EMAIL, password: pw });
      if(error) throw error;
      if(!data || !data.user || (data.user.email || '').toLowerCase() !== ADMIN_EMAIL.toLowerCase()) throw new Error('Not the admin account');
      toast('Signed in again');
      purchReauthDone(true);
      purchQueueAll();   // re-read everything now that the database will answer
    }catch(e){
      const m = describeCloudError(e);
      $('purchReauthErr').textContent = /invalid login|invalid_credentials|400/i.test(m) ? 'Wrong password — try again.' : 'Couldn\u2019t sign in: ' + m;
    }finally{ btn.disabled = false; btn.textContent = 'Sign in'; }
  }
  $('purchReauthBtn').addEventListener('click', purchReauthSubmit);
  $('purchReauthPw').addEventListener('keydown', (e)=>{ if(e.key === 'Enter') purchReauthSubmit(); });
  $('purchReauthClose').addEventListener('click', ()=> purchReauthDone(false));
  $('purchReauthLogout').addEventListener('click', ()=>{ purchReauthDone(false); doLogout(); });
  // "Sign in again" button inside a list's error message
  ['spList', 'mtList'].forEach(id=> $(id).addEventListener('click', (e)=>{
    if(!e.target.closest('[data-purch-reauth]')) return;
    e.stopPropagation();
    purchReauth().then(ok=>{
      if(!ok) return;
      if(id === 'spList') spLoad().then(ok=>{ if(ok) spRenderList(); }); else mtLoad().then(ok=>{ if(ok) mtRenderList(); });
    });
  }, true));
