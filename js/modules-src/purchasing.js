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

  // Shared with the Materials Database (materials.category) — keep in sync.
  const PURCH_CATEGORIES = [
    'Piping', 'Refrigerant', 'Electrical', 'Insulation', 'Consumables',
    'Parts & Components', 'Ducting & Ventilation', 'Plumbing',
    'Fire Protection', 'Hardware', 'Tools & Equipment', 'Others'
  ];
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
    if(!currentUser || currentUser.role !== 'admin') return;
    if(key === 'suppliers') spShow();
  }

  async function spShow(){
    const sel = $('spFilterCategory');
    if(sel.options.length <= 1){
      PURCH_CATEGORIES.forEach(c=>{ const o = document.createElement('option'); o.value = c; o.textContent = c; sel.appendChild(o); });
    }
    await spLoad();
    spRenderList();
  }

  async function spLoad(){
    const list = $('spList');
    list.innerHTML = '<div class="empty-state">Loading…</div>';
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
      spCache = [];
      const msg = /relation .*suppliers.* does not exist|42P01/.test(describeCloudError(e))
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
      return '<div class="user-card' + (s.isActive ? '' : ' inactive') + '" data-id="' + escapeHtml(s.id) + '">' +
        '<div class="user-card-head" data-act="toggle" style="cursor:pointer;"><div style="min-width:0;">' +
          '<div class="u-name">' + escapeHtml(spDisplayName(s)) + '</div>' +
          '<div class="u-status">' + escapeHtml(sub) + '</div>' +
          (tags ? '<div class="sp-tags">' + tags + '</div>' : '') +
        '</div><span class="card-caret">▾</span></div>' +
        '<div class="user-edit-panel">' +
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
      btn.disabled = true;
      try{
        const { error } = await db.from('suppliers').update({ is_active: on }).eq('id', s.id);
        if(error) throw error;
        s.isActive = on;
        toast(spDisplayName(s) + (on ? ' reactivated' : ' deactivated'));
        spRenderList();
      }catch(err){
        btn.disabled = false;
        toast('Couldn\u2019t update supplier: ' + describeCloudError(err));
      }
    }
  });

  // ---------- sheet ----------
  function spRenderSuppliesPick(){
    $('spSuppliesPick').innerHTML = PURCH_CATEGORIES.map(c=>
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
    spLoad().then(spRenderList);   // contacts/primary may have changed
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
    const btn = $('spSaveBtn'); btn.disabled = true;
    try{
      let res;
      if(spEditing) res = await db.from('suppliers').update(row).eq('id', spEditing.id).select('*, supplier_contacts(id,name,position,mobile,email,is_primary)').single();
      else res = await db.from('suppliers').insert(row).select('*, supplier_contacts(id,name,position,mobile,email,is_primary)').single();
      if(res.error) throw res.error;
      const saved = spFromRow(res.data);
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
      toast('Couldn\u2019t save supplier: ' + describeCloudError(e));
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
  async function spLoadContacts(){
    const list = $('spContactsList');
    list.innerHTML = '<div class="empty-state">Loading…</div>';
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
      toast('Couldn\u2019t update contact: ' + describeCloudError(err));
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
      toast('Couldn\u2019t save contact: ' + describeCloudError(e));
    }finally{ btn.disabled = false; }
  });

  // ---------- documents ----------
  function spResetDocForm(){
    $('spDocTitle').value = ''; $('spDocExpires').value = ''; $('spDocFile').value = '';
    if($('spDocType').options.length) $('spDocType').selectedIndex = 0;
  }
  let spDocsCache = [];
  async function spLoadDocs(){
    const list = $('spDocsList');
    list.innerHTML = '<div class="empty-state">Loading…</div>';
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
        toast('Couldn\u2019t open document: ' + describeCloudError(err));
      }
      return;
    }
    if(!confirm('Delete "' + (d.title || d.file_name || d.doc_type) + '"? This cannot be undone.')) return;
    b.disabled = true;
    try{
      const { error } = await db.from('supplier_documents').delete().eq('id', d.id);
      if(error) throw error;
      try{ await db.storage.from(SP_DOC_BUCKET).remove([d.storage_path]); }catch(_){}
      toast('Document deleted');
      spLoadDocs();
    }catch(err){
      b.disabled = false;
      toast('Couldn\u2019t delete document: ' + describeCloudError(err));
    }
  });
  $('spDocUploadBtn').addEventListener('click', async ()=>{
    if(!spEditing) return;
    const file = $('spDocFile').files && $('spDocFile').files[0];
    if(!file){ toast('Choose a file first'); return; }
    if(file.size > SP_DOC_MAX_BYTES){ toast('File is over 10 MB'); return; }
    if(!/^(application\/pdf|image\/)/.test(file.type || '')){ toast('Only PDF or image files'); return; }
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
      toast('Upload failed: ' + describeCloudError(e));
    }finally{ btn.disabled = false; btn.textContent = 'Upload'; }
  });

  // ---------- price list (read-only until the Materials Database is built) ----------
  async function spLoadPrices(){
    const list = $('spPricesList');
    list.innerHTML = '<div class="empty-state">Loading…</div>';
    try{
      const { data, error } = await db.from('supplier_materials')
        .select('id, supplier_item_code, price, price_unit, price_updated_at, min_order_qty, lead_time_days, is_preferred, is_active, materials(code, name, unit)')
        .eq('supplier_id', spEditing.id);
      if(error) throw error;
      const rows = (data || []).sort((a,b)=> ((a.materials && a.materials.name) || '').localeCompare((b.materials && b.materials.name) || ''));
      if(!rows.length){
        list.innerHTML = '<div class="empty-state" style="padding:16px;">No items priced for this supplier yet.<br>' +
          'Prices are linked to items from the <b>Materials Database</b>, which is the next build.</div>';
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
  function spParseCsv(text){
    const rows = []; let row = []; let f = ''; let q = false;
    text = text.replace(/^\uFEFF/, '');
    for(let i = 0; i < text.length; i++){
      const ch = text[i];
      if(q){
        if(ch === '"'){ if(text[i+1] === '"'){ f += '"'; i++; } else q = false; }
        else f += ch;
      }else if(ch === '"') q = true;
      else if(ch === ','){ row.push(f); f = ''; }
      else if(ch === '\n' || ch === '\r'){
        if(ch === '\r' && text[i+1] === '\n') i++;
        row.push(f); f = '';
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
        const lookup = new Map(PURCH_CATEGORIES.map(c=> [c.toLowerCase(), c]));
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
      toast('Import failed: ' + describeCloudError(e));
    }finally{
      btn.disabled = false; btn.textContent = 'Import CSV';
      await spLoad(); spRenderList();
    }
  });
