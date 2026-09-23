  // =====================================================================
  // Purchasing — Purchase Orders (admin only)
  //
  // Tables (migration 20260923_03_purchase_orders.sql): purchase_orders,
  // purchase_order_items, po_signatories, po_settings; storage bucket
  // 'purchasing-assets' (logo/…, signatures/…).
  //
  // The DATABASE owns the rules: PO numbers, totals, draft→issued→cancelled,
  // locking, and the snapshots taken at issue. This screen mirrors the math
  // for display and reads everything back after each save.
  //
  // PDF: jsPDF + autotable (same libs as the Service Report). Viewed through
  // the shared preview overlay (renderPdfPreview) and downloaded/shared via
  // shareOrDownloadPdf — both in pdf.js.
  // =====================================================================

  const PO_BUCKET = 'purchasing-assets';
  const PO_VAT_RATE = 0.12;
  const PO_LIST_SELECT = 'id, po_no, status, po_date, total, ewt_amount, net_payable, reference, supplier_id, supplier_snapshot, updated_at, suppliers(name, trade_name), purchase_order_items(count)';

  let poCache = [];
  let poEditing = null;      // header row from the DB, or null for a new unsaved PO
  let poItems = [];          // [{key, id, material_id, code, description, unit, qty, unit_price}]
  let poSettingsData = null; // po_settings.data
  let poSignatories = [];
  let poSuppliers = [];      // suppliers with their contacts, for the picker + PDF
  let poReadOnly = false;
  let poKeySeq = 0;
  const poImgCache = new Map();  // storage path -> {dataUrl, w, h}

  function poUuid(){
    if(window.crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c=>{
      const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }
  function poRound2(n){ return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }
  function poNum(v){ const n = spParseMoney(v); return n == null || Number.isNaN(n) ? null : n; }
  function poFmt(n){ return Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits:2, maximumFractionDigits:2 }); }
  function poQtyFmt(n){ return Number(n || 0).toLocaleString('en-PH', { maximumFractionDigits:3 }); }
  function poToday(){
    // Manila date, whatever the device clock's zone is
    return new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
  }
  function poDateLong(d){
    if(!d) return '—';
    const dt = new Date(d + 'T00:00:00');
    return isNaN(dt) ? d : dt.toLocaleDateString('en-PH', { year:'numeric', month:'long', day:'numeric' });
  }
  function poSupplierName(s){ return s ? (s.trade_name || s.name || '') : ''; }

  // Same math as the database (po_compute_totals) — display only.
  // EWT is computed on the amount net of VAT (vatable) and deducted:
  // net payable = total − EWT.
  function poCalc(items, vatMode, discount, ewtRate){
    const subtotal = poRound2(items.reduce((a, it)=> a + poRound2((Number(it.qty) || 0) * (Number(it.unit_price) || 0)), 0));
    const net = Math.max(poRound2(subtotal - (Number(discount) || 0)), 0);
    let vat = 0, total = net, vatable = net;
    if(vatMode === 'exclusive'){ vat = poRound2(net * PO_VAT_RATE); total = poRound2(net + vat); }
    else if(vatMode === 'inclusive'){ vat = poRound2(net - net / (1 + PO_VAT_RATE)); vatable = poRound2(net - vat); }
    const rate = Number(ewtRate) || 0;
    const ewt = poRound2(vatable * rate);
    return { subtotal, discount: Number(discount) || 0, net, vat, vatable, total, ewtRate: rate, ewt, netPayable: poRound2(total - ewt) };
  }
  function poEwtLabel(rate){
    const pct = Math.round(Number(rate) * 10000) / 100;
    return 'Less: EWT ' + pct + '%' + (Number(rate) === 0.01 ? ' (goods)' : Number(rate) === 0.02 ? ' (services)' : '');
  }

  // "Six Thousand Three Hundred Twenty-Nine Pesos and 12/100 Only"
  function poAmountInWords(amount){
    const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven',
      'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
    const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
    const under1000 = (n)=>{
      let s = '';
      if(n >= 100){ s += ones[Math.floor(n / 100)] + ' Hundred'; n %= 100; if(n) s += ' '; }
      if(n >= 20){ s += tens[Math.floor(n / 10)]; if(n % 10) s += '-' + ones[n % 10]; }
      else if(n > 0) s += ones[n];
      return s;
    };
    const total = poRound2(Math.abs(Number(amount) || 0));
    let pesos = Math.floor(total);
    const cents = Math.round((total - pesos) * 100);
    if(pesos === 0) return 'Zero Pesos and ' + String(cents).padStart(2, '0') + '/100 Only';
    const scales = ['', ' Thousand', ' Million', ' Billion'];
    const parts = [];
    for(let i = 0; pesos > 0 && i < scales.length; i++){
      const chunk = pesos % 1000;
      if(chunk) parts.unshift(under1000(chunk) + scales[i]);
      pesos = Math.floor(pesos / 1000);
    }
    const whole = Math.floor(total);
    return parts.join(' ') + (whole === 1 ? ' Peso' : ' Pesos') + ' and ' + String(cents).padStart(2, '0') + '/100 Only';
  }

  // ---------- reference data ----------
  async function poLoadSettings(){
    const { data, error } = await db.from('po_settings').select('data').eq('id', 1);
    if(error) throw error;
    poSettingsData = (data && data[0] && data[0].data) || {};
    return poSettingsData;
  }
  async function poLoadSignatories(){
    const { data, error } = await db.from('po_signatories').select('*').order('name');
    if(error) throw error;
    poSignatories = data || [];
    return poSignatories;
  }
  async function poLoadSuppliers(){
    const { data, error } = await db.from('suppliers')
      .select('id, code, name, trade_name, address, city, tin, payment_terms, is_active, supplier_contacts(name, position, mobile, email, is_primary)')
      .order('name');
    if(error) throw error;
    poSuppliers = data || [];
    return poSuppliers;
  }
  async function poEnsureRefs(){
    const jobs = [poLoadSettings(), poLoadSignatories(), poLoadSuppliers()];
    if(!mtCache.length) jobs.push(mtLoad({ silent:true }));
    await Promise.all(jobs);
  }

  // ---------- list ----------
  async function poShow(){
    // Sidebar "Purchase Orders" while a PO is open: back to the list,
    // unless there are unsaved changes the admin wants to keep.
    if(poEditorVisible()){
      if(!poConfirmLeave()) return;
      poShowListView();
    }
    if(await poLoadList()) poRenderList();
  }
  async function poLoadList(opts){
    const silent = !!(opts && opts.silent);
    const list = $('poList');
    if(!silent) list.innerHTML = '<div class="empty-state">Loading…</div>';
    if(!(await ensureCloud())){
      if(!silent) list.innerHTML = '<div class="empty-state">Not connected to Shared Cloud — Purchase Orders need a connection.</div>';
      return false;
    }
    try{
      const { data, error } = await db.from('purchase_orders').select(PO_LIST_SELECT)
        .order('po_date', { ascending:false }).order('po_no', { ascending:false });
      if(error) throw error;
      poCache = data || [];
      return true;
    }catch(e){
      console.error('load purchase orders failed', describeCloudError(e));
      if(silent) return false;
      const msg = purchIsAuthError(e) ? PURCH_EXPIRED_HTML
        : /42P01|does not exist/.test(describeCloudError(e))
          ? 'The purchase order tables aren\u2019t in the database yet — run migration 20260923_03_purchase_orders.sql in Supabase first.'
          : 'Couldn\u2019t load purchase orders: ' + escapeHtml(describeCloudError(e));
      list.innerHTML = '<div class="empty-state">' + msg + '</div>';
      return false;
    }
  }
  function poListSupplier(r){
    return poSupplierName(r.suppliers) || poSupplierName(r.supplier_snapshot) || '— no supplier yet —';
  }
  function poRenderList(){
    const q = ($('poSearch').value || '').trim().toLowerCase();
    const st = $('poFilterStatus').value;
    const counts = poCache.reduce((a, r)=>{ a[r.status] = (a[r.status] || 0) + 1; return a; }, {});
    $('poCount').textContent = poCache.length
      ? [counts.draft ? counts.draft + ' draft' + (counts.draft > 1 ? 's' : '') : '', counts.issued ? counts.issued + ' issued' : ''].filter(Boolean).join(' · ')
      : '';
    const rows = poCache.filter(r=>{
      if(st && r.status !== st) return false;
      if(!q) return true;
      return [r.po_no, poListSupplier(r), r.reference].join(' ').toLowerCase().includes(q);
    });
    const list = $('poList');
    if(!rows.length){
      list.innerHTML = '<div class="empty-state">' + (poCache.length ? 'No purchase orders match.'
        : 'No purchase orders yet. Tap <b>+ New Purchase Order</b> to create one.') + '</div>';
      return;
    }
    list.innerHTML = rows.map(r=>{
      const n = Array.isArray(r.purchase_order_items) && r.purchase_order_items[0] ? r.purchase_order_items[0].count : 0;
      return '<button type="button" class="mt-row' + (r.status === 'cancelled' ? ' inactive' : '') + '" data-id="' + escapeHtml(r.id) + '">' +
        '<div class="mt-row-main"><div class="mt-row-title"><span class="mt-code">' + escapeHtml(r.po_no || '—') + '</span>' +
          escapeHtml(poListSupplier(r)) + ' <span class="po-status ' + escapeHtml(r.status) + '">' + escapeHtml(r.status) + '</span></div>' +
          '<div class="sp-row-sub">' + escapeHtml([poDateLong(r.po_date), n + ' item' + (n === 1 ? '' : 's'), r.reference].filter(Boolean).join(' · ')) + '</div></div>' +
        '<div class="mt-row-price">₱' + poFmt(Number(r.ewt_amount) > 0 ? r.net_payable : r.total) +
          (Number(r.ewt_amount) > 0 ? '<div class="sp-row-sub">net of EWT</div>' : '') + '</div></button>';
    }).join('');
  }
  $('poSearch').addEventListener('input', poRenderList);
  $('poFilterStatus').addEventListener('change', poRenderList);
  $('poList').addEventListener('click', (e)=>{
    if(e.target.closest('[data-purch-reauth]')){
      purchReauth().then(ok=>{ if(ok) poShow(); });
      return;
    }
    const row = e.target.closest('.mt-row');
    if(row) poOpen(row.dataset.id);
  });
  $('poAddBtn').addEventListener('click', ()=> poOpen(null));

  // ---------- in-page views ----------
  let poDirty = false;
  function poEditorVisible(){ return $('poEditorView').style.display !== 'none'; }
  function poShowEditorView(){
    $('poListView').style.display = 'none';
    $('poEditorView').style.display = '';
    $('purchasingView').classList.add('po-wide');
    window.scrollTo({ top: 0 });
  }
  function poShowListView(){
    $('poEditorView').style.display = 'none';
    $('poListView').style.display = '';
    $('purchasingView').classList.remove('po-wide');
    poEditing = null; poDirty = false;
    window.scrollTo({ top: 0 });
  }
  // Leaving an edited draft asks first.
  function poConfirmLeave(){
    return !poDirty || poReadOnly || confirm('Discard the changes you haven\u2019t saved?');
  }
  $('poEditorView').addEventListener('input', (e)=>{ if(!e.target.closest('.po-actions')) poDirty = true; });
  $('poEditorView').addEventListener('change', (e)=>{ if(!e.target.closest('.po-actions')) poDirty = true; });
  $('poBackBtn').addEventListener('click', ()=>{ if(poConfirmLeave()) poClose(); });
  $('poEditTermsBtn').addEventListener('click', ()=> $('poSettingsBtn').click());

  // ---------- editor ----------
  async function poOpen(id, prefill){
    if(!(await ensureCloud())){ toast('Not connected'); return; }
    try{
      await poEnsureRefs();
      let header = null, items = [];
      if(id){
        const h = await db.from('purchase_orders').select('*').eq('id', id);
        if(h.error) throw h.error;
        header = h.data && h.data[0];
        if(!header){ toast('That PO no longer exists'); poShow(); return; }
        const it = await db.from('purchase_order_items').select('*').eq('po_id', id).order('line_no');
        if(it.error) throw it.error;
        items = it.data || [];
      }
      poEditing = header;
      poItems = (prefill ? prefill.items : items).map(r=> ({
        key: ++poKeySeq, id: prefill ? null : r.id, material_id: r.material_id || null, code: r.code || '',
        description: r.description || '', unit: r.unit || '', qty: r.qty, unit_price: r.unit_price
      }));
      const src = header || (prefill && prefill.header) || {};
      const set = poSettingsData || {};
      poFillSupplierSelect(src.supplier_id);
      $('poSupplier').value = src.supplier_id || '';
      $('poReference').value = src.reference || '';
      $('poDate').value = header ? header.po_date : poToday();
      $('poDeliveryDate').value = src.delivery_date || '';
      $('poTerms').value = src.payment_terms != null ? src.payment_terms : '';
      $('poVatMode').value = src.vat_mode || set.vat_mode || 'exclusive';
      $('poDeliverTo').value = src.deliver_to != null && (header || prefill) ? src.deliver_to : (set.deliver_to || '');
      $('poDiscount').value = src.discount ? String(src.discount) : '';
      $('poEwt').value = String(Number(src.ewt_rate) || 0);
      if(!$('poEwt').value) $('poEwt').value = '0';
      poFillSignatorySelects(src.prepared_by_id, src.approved_by_id);
      $('poPreparedBy').value = src.prepared_by_id || '';
      $('poApprovedBy').value = src.approved_by_id || '';
      if(!poItems.length) poItems.push(poBlankItem());
      $('poStaleNote').style.display = 'none';
      poApplyMode();
      poRenderItems();
      poRenderTotals();
      poRenderSupplierInfo();
      poRenderSigHint();
      poShowEditorView();
      poDirty = !!prefill;   // a duplicate isn't saved yet
    }catch(e){
      purchFail('Couldn\u2019t open the PO: ', e);
    }
  }
  function poBlankItem(){ return { key: ++poKeySeq, id: null, material_id: null, code: '', description: '', unit: '', qty: '', unit_price: '' }; }

  function poApplyMode(){
    const st = poEditing ? poEditing.status : 'draft';
    poReadOnly = st !== 'draft';
    $('poSheetTitle').textContent = poEditing ? poEditing.po_no : 'New Purchase Order';
    $('poSheetStatus').className = 'po-status ' + st;
    $('poSheetStatus').textContent = poEditing ? st : 'unsaved';
    const note = $('poLockedNote');
    if(st === 'issued'){
      note.className = 'po-locked-note';
      note.textContent = 'Issued ' + (poEditing.issued_at ? new Date(poEditing.issued_at).toLocaleString('en-PH') : '') +
        ' — locked. It can be viewed, downloaded, duplicated or cancelled, but not edited.';
      note.style.display = '';
    }else if(st === 'cancelled'){
      note.className = 'po-locked-note cancelled';
      note.textContent = 'Cancelled ' + (poEditing.cancelled_at ? new Date(poEditing.cancelled_at).toLocaleString('en-PH') : '') +
        (poEditing.cancel_reason ? ' — Reason: ' + poEditing.cancel_reason : '');
      note.style.display = '';
    }else note.style.display = 'none';
    $$('#poEditorView input, #poEditorView select, #poEditorView textarea').forEach(el=>{ el.disabled = poReadOnly; });
    $('poAddItem').style.display = poReadOnly ? 'none' : '';
    poRenderActions();
  }
  function poRenderActions(){
    const st = poEditing ? poEditing.status : 'draft';
    const b = (id, label, cls)=> '<button type="button" class="btn ' + (cls || 'btn-secondary') + '" data-po-act="' + id + '">' + label + '</button>';
    let html = '';
    if(st === 'draft'){
      html = b('save', 'Save Draft') + b('preview', 'Preview PDF') + b('issue', 'Issue PO', 'btn-primary');
      if(poEditing) html += b('duplicate', 'Duplicate') + b('delete', 'Delete Draft', 'danger');
    }else{
      html = b('preview', 'View PDF', 'btn-primary') + b('download', 'Download PDF') + b('duplicate', 'Duplicate');
      if(st === 'issued') html += b('cancel', 'Cancel PO', 'danger');
    }
    $('poActions').innerHTML = html;
  }

  function poFillSupplierSelect(keepId){
    const opts = poSuppliers.filter(s=> s.is_active !== false || s.id === keepId)
      .map(s=> '<option value="' + escapeHtml(s.id) + '">' + escapeHtml(poSupplierName(s)) + (s.is_active === false ? ' (inactive)' : '') + '</option>');
    $('poSupplier').innerHTML = '<option value="">' + (poSuppliers.length ? 'Choose a supplier…' : 'No suppliers yet — add them in Supplier Database') + '</option>' + opts.join('');
  }
  function poFillSignatorySelects(keepPrep, keepAppr){
    const mk = (keep)=> '<option value="">— none —</option>' + poSignatories
      .filter(s=> s.is_active || s.id === keep)
      .map(s=> '<option value="' + escapeHtml(s.id) + '">' + escapeHtml(s.name) + (s.position ? ' — ' + escapeHtml(s.position) : '') + (s.signature_path ? '' : ' (no signature)') + '</option>').join('');
    const pv = $('poPreparedBy').value, av = $('poApprovedBy').value;
    $('poPreparedBy').innerHTML = mk(keepPrep || pv);
    $('poApprovedBy').innerHTML = mk(keepAppr || av);
    if(!keepPrep && pv) $('poPreparedBy').value = pv;
    if(!keepAppr && av) $('poApprovedBy').value = av;
  }
  function poRenderSigHint(){
    if(!poSignatories.length){
      $('poSigHint').innerHTML = 'No signatories yet — add them (with their e-signature) in <b>PO Settings, Logo &amp; Signatures</b>.';
      return;
    }
    const missing = [$('poPreparedBy').value, $('poApprovedBy').value].map(id=> poSignatories.find(s=> s.id === id)).filter(s=> s && !s.signature_path);
    $('poSigHint').textContent = missing.length ? missing.map(s=> s.name).join(', ') + ' has no uploaded signature yet — the PDF will show a blank signature line.' : '';
  }
  $('poPreparedBy').addEventListener('change', poRenderSigHint);
  $('poApprovedBy').addEventListener('change', poRenderSigHint);

  function poCurrentSupplier(){ return poSuppliers.find(s=> s.id === $('poSupplier').value) || null; }
  function poRenderSupplierInfo(){
    const s = poCurrentSupplier();
    if(!s){ $('poSupplierInfo').textContent = ''; return; }
    const c = (s.supplier_contacts || []).slice().sort((a, b)=> (b.is_primary ? 1 : 0) - (a.is_primary ? 1 : 0))[0];
    $('poSupplierInfo').innerHTML = [
      escapeHtml([s.address, s.city].filter(Boolean).join(', ')),
      s.tin ? 'TIN ' + escapeHtml(s.tin) : '',
      c ? escapeHtml(c.name + (c.mobile ? ' · ' + c.mobile : '')) : ''
    ].filter(Boolean).join('<br>');
  }
  let poLastSupplierTerms = '';
  $('poSupplier').addEventListener('focus', ()=>{ const s = poCurrentSupplier(); poLastSupplierTerms = s ? (s.payment_terms || '') : ''; });
  $('poSupplier').addEventListener('change', ()=>{
    const s = poCurrentSupplier();
    poRenderSupplierInfo();
    // Take the supplier's usual terms unless the admin typed their own.
    const cur = $('poTerms').value.trim();
    if(s && (!cur || cur === poLastSupplierTerms)) $('poTerms').value = s.payment_terms || '';
    poLastSupplierTerms = s ? (s.payment_terms || '') : '';
    // Offer to re-price catalog items from the new supplier's price list.
    if(!s) return;
    const changes = poItems.filter(it=> it.material_id).map(it=>{
      const p = poPriceFor(it.material_id, s.id);
      return p && p.price != null && Number(p.price) !== Number(it.unit_price) ? { it, p } : null;
    }).filter(Boolean);
    if(changes.length && confirm('Update ' + changes.length + ' item price' + (changes.length > 1 ? 's' : '') + ' from ' + poSupplierName(s) + '\u2019s price list?')){
      changes.forEach(({ it, p })=>{ it.unit_price = p.price; if(p.unitFromPrice) it.unit = p.unitFromPrice; });
      poRenderItems(); poRenderTotals();
    }
  });

  // Price of a catalog item for a supplier: that supplier's active price,
  // else the preferred/cheapest from anyone, else the standard cost.
  function poPriceFor(materialId, supplierId){
    const m = mtCache.find(x=> x.id === materialId);
    if(!m) return null;
    const live = m.prices.filter(p=> p.is_active && p.price != null);
    const mine = supplierId && live.find(p=> p.suppliers && p.suppliers.id === supplierId);
    const pick = mine || null;
    const unitFromPrice = (pr)=> pr && pr.price_unit ? pr.price_unit.replace(/^per\s+/i, '').trim() : '';
    if(pick) return { price: Number(pick.price), unitFromPrice: unitFromPrice(pick), source: 'supplier' };
    const best = mtBestPrice(m);
    if(best) return { price: Number(best.price), unitFromPrice: unitFromPrice(best), source: 'other' };
    if(m.standardCost != null) return { price: Number(m.standardCost), unitFromPrice: '', source: 'standard' };
    return null;
  }

  // ---------- items ----------
  function poRenderItems(){
    const wrap = $('poItems');
    wrap.innerHTML = poItems.map((it, i)=>{
      const amt = poRound2((Number(it.qty) || 0) * (Number(it.unit_price) || 0));
      const dis = poReadOnly ? ' disabled' : '';
      return '<div class="po-item" data-key="' + it.key + '">' +
        '<div class="po-no">' + (i + 1) + '</div>' +
        '<div class="po-item-desc"><input type="text" data-f="description" value="' + escapeHtml(it.description) + '" placeholder="' + (i === 0 ? 'Type an item name or code…' : 'Item') + '" autocomplete="off"' + dis + '>' +
          '<div class="po-item-code">' + (it.material_id ? escapeHtml(it.code) : (it.description ? 'not in catalog' : '')) + '</div></div>' +
        '<input type="text" class="num po-qty" data-f="qty" inputmode="decimal" value="' + escapeHtml(it.qty === '' || it.qty == null ? '' : String(it.qty)) + '" placeholder="Qty"' + dis + '>' +
        '<input type="text" class="po-unit" data-f="unit" list="mtUnitList" value="' + escapeHtml(it.unit) + '" placeholder="Unit"' + dis + '>' +
        '<input type="text" class="num po-price" data-f="unit_price" inputmode="decimal" value="' + escapeHtml(it.unit_price === '' || it.unit_price == null ? '' : String(it.unit_price)) + '" placeholder="Unit price"' + dis + '>' +
        '<div class="po-amt">₱' + poFmt(amt) + '</div>' +
        (poReadOnly ? '<span></span>' : '<button type="button" class="po-rm" data-rm="1" title="Remove item">&minus;</button>') +
      '</div>';
    }).join('');
  }
  function poItemByEl(el){
    const row = el.closest('.po-item');
    return row ? poItems.find(x=> String(x.key) === row.dataset.key) : null;
  }
  $('poItems').addEventListener('input', (e)=>{
    const it = poItemByEl(e.target);
    const f = e.target.dataset.f;
    if(!it || !f) return;
    if(f === 'qty' || f === 'unit_price'){
      it[f] = e.target.value.trim() === '' ? '' : (poNum(e.target.value) == null ? e.target.value : poNum(e.target.value));
      const row = e.target.closest('.po-item');
      row.querySelector('.po-amt').textContent = '₱' + poFmt(poRound2((Number(it.qty) || 0) * (Number(it.unit_price) || 0)));
      poRenderTotals();
    }else if(f === 'description'){
      it.description = e.target.value;
      // Edited away from the catalog name → becomes a free-text line.
      if(it.material_id){
        const m = mtCache.find(x=> x.id === it.material_id);
        if(!m || m.name !== it.description){ it.material_id = null; it.code = ''; }
      }
      e.target.closest('.po-item').querySelector('.po-item-code').textContent = it.material_id ? it.code : (it.description ? 'not in catalog' : '');
      poSuggest(e.target, it);
    }else it[f] = e.target.value;
  });
  $('poItems').addEventListener('click', (e)=>{
    const pick = e.target.closest('[data-pick]');
    if(pick){ poPickMaterial(poItemByEl(pick), pick.dataset.pick); return; }
    if(e.target.closest('[data-rm]')){
      const it = poItemByEl(e.target);
      poItems = poItems.filter(x=> x !== it);
      if(!poItems.length) poItems.push(poBlankItem());
      poRenderItems(); poRenderTotals();
    }
  });
  $('poItems').addEventListener('keydown', (e)=>{
    const box = e.target.closest('.po-item-desc') && e.target.closest('.po-item-desc').querySelector('.po-suggest');
    if(!box) return;
    const btns = Array.from(box.querySelectorAll('[data-pick]'));
    let i = btns.findIndex(b=> b.classList.contains('hl'));
    if(e.key === 'ArrowDown' || e.key === 'ArrowUp'){
      e.preventDefault();
      if(i >= 0) btns[i].classList.remove('hl');
      i = e.key === 'ArrowDown' ? Math.min(btns.length - 1, i + 1) : Math.max(0, i - 1);
      if(btns[i]){ btns[i].classList.add('hl'); btns[i].scrollIntoView({ block:'nearest' }); }
    }else if(e.key === 'Enter' && i >= 0){
      e.preventDefault(); poPickMaterial(poItemByEl(e.target), btns[i].dataset.pick);
    }else if(e.key === 'Escape'){ box.remove(); }
  });
  $('poItems').addEventListener('focusout', (e)=>{
    // let a click on a suggestion land first
    setTimeout(()=>{
      const d = e.target.closest && e.target.closest('.po-item-desc');
      if(d && !d.contains(document.activeElement)){ const b = d.querySelector('.po-suggest'); if(b) b.remove(); }
    }, 180);
  });
  function poSuggest(input, it){
    const host = input.closest('.po-item-desc');
    let box = host.querySelector('.po-suggest');
    const words = input.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if(!words.length){ if(box) box.remove(); return; }
    const sup = $('poSupplier').value;
    const hits = mtCache.filter(m=> m.isActive).filter(m=>{
      const hay = [m.code, m.name, m.family, m.brand, mtSpecText(m.specs)].join(' ').toLowerCase();
      return words.every(w=> hay.includes(w));
    }).slice(0, 8);
    if(!hits.length){ if(box) box.remove(); return; }
    if(!box){ box = document.createElement('div'); box.className = 'po-suggest'; host.appendChild(box); }
    box.innerHTML = hits.map((m, i)=>{
      const p = poPriceFor(m.id, sup);
      return '<button type="button" data-pick="' + escapeHtml(m.id) + '"' + (i === 0 ? ' class="hl"' : '') + '><span><b>' + escapeHtml(m.code) + '</b> ' + escapeHtml(m.name) + '</span>' +
        '<span class="s-price">' + (p ? '₱' + poFmt(p.price) + (p.source === 'supplier' ? '' : p.source === 'standard' ? ' std.' : ' other') : 'no price') + '</span></button>';
    }).join('');
  }
  function poPickMaterial(it, materialId){
    const m = mtCache.find(x=> x.id === materialId);
    if(!it || !m) return;
    const p = poPriceFor(m.id, $('poSupplier').value);
    it.material_id = m.id; it.code = m.code; it.description = m.name;
    it.unit = (p && p.unitFromPrice) || m.unit;
    if(p) it.unit_price = p.price;
    poRenderItems(); poRenderTotals();
    const row = $('poItems').querySelector('.po-item[data-key="' + it.key + '"] [data-f="qty"]');
    if(row) row.focus();
  }
  $('poAddItem').addEventListener('click', ()=>{
    poItems.push(poBlankItem());
    poRenderItems();
    const inputs = $('poItems').querySelectorAll('[data-f="description"]');
    if(inputs.length) inputs[inputs.length - 1].focus();
  });

  function poRenderTotals(){
    const vm = $('poVatMode').value;
    const t = poCalc(poCleanItems(), vm, poNum($('poDiscount').value) || 0, Number($('poEwt').value) || 0);
    $('poTotSub').textContent = '₱' + poFmt(t.subtotal);
    const row = (l, v)=> '<div class="row"><span>' + l + '</span><span>' + v + '</span></div>';
    $('poTotVatRows').innerHTML = vm === 'exclusive' ? row('Add: VAT 12%', '₱' + poFmt(t.vat))
      : vm === 'inclusive' ? row('VATable sales', '₱' + poFmt(t.vatable)) + row('VAT 12% (included)', '₱' + poFmt(t.vat))
      : row('VAT', 'Non-VAT');
    $('poTotTotal').textContent = '₱' + poFmt(t.total);
    $('poTotEwtRow').style.display = t.ewt ? '' : 'none';
    $('poTotEwtLabel').textContent = 'Withheld: ' + (Math.round(t.ewtRate * 10000) / 100) + '% of ₱' + poFmt(t.vatable) + ' (net of VAT)';
    $('poTotEwt').textContent = '(₱' + poFmt(t.ewt) + ')';
    $('poTotNetLabel').textContent = t.ewtRate ? 'Net Amount Payable' : 'Total Amount';
    $('poTotNet').textContent = '₱' + poFmt(t.netPayable);
  }
  $('poVatMode').addEventListener('change', poRenderTotals);
  $('poDiscount').addEventListener('input', poRenderTotals);
  $('poEwt').addEventListener('change', poRenderTotals);

  // Items with anything typed in them (fully blank rows are ignored), with
  // qty/price coerced to numbers — used for totals and saving.
  function poCleanItems(){
    return poItems.filter(it=> String(it.description || '').trim() || (it.qty !== '' && it.qty != null) || (it.unit_price !== '' && it.unit_price != null))
      .map(it=> Object.assign({}, it, { qty: Number(it.qty) || 0, unit_price: Number(it.unit_price) || 0 }));
  }
  function poValidate(){
    const items = poItems.filter(it=> String(it.description || '').trim() || (it.qty !== '' && it.qty != null) || (it.unit_price !== '' && it.unit_price != null));
    for(let i = 0; i < items.length; i++){
      const it = items[i], n = i + 1;
      if(!String(it.description || '').trim()) return 'Item ' + n + ': enter a description';
      const q = Number(it.qty);
      if(it.qty === '' || !isFinite(q) || q <= 0) return 'Item ' + n + ' (' + it.description + '): enter a quantity above 0';
      const p = Number(it.unit_price);
      if(it.unit_price === '' || !isFinite(p) || p < 0) return 'Item ' + n + ' (' + it.description + '): enter a unit price (0 is allowed)';
    }
    const d = spParseMoney($('poDiscount').value);
    if(Number.isNaN(d)) return 'Discount must be a number';
    return null;
  }
  function poGatherHeader(){
    return {
      supplier_id: $('poSupplier').value || null,
      po_date: $('poDate').value || poToday(),
      delivery_date: $('poDeliveryDate').value || null,
      deliver_to: $('poDeliverTo').value.trim(),
      payment_terms: $('poTerms').value.trim(),
      reference: $('poReference').value.trim(),
      vat_mode: $('poVatMode').value,
      discount: poNum($('poDiscount').value) || 0,
      ewt_rate: Number($('poEwt').value) || 0,
      prepared_by_id: $('poPreparedBy').value || null,
      approved_by_id: $('poApprovedBy').value || null
    };
  }

  // Saves header + items. Items are upserted by id, then any removed rows
  // are deleted — so a failure midway never leaves the draft with fewer
  // items than it had. Returns the fresh header row, or null.
  async function poSave(opts){
    const quiet = !!(opts && opts.quiet);
    const err = poValidate();
    if(err){ toast(err); return null; }
    if(!(await ensureCloud())){ toast('Not connected — can\u2019t save'); return null; }
    if(!(await purchEnsureSession())) return null;
    const header = poGatherHeader();
    try{
      let id = poEditing && poEditing.id;
      if(id){
        purchMarkOwn(id);
        const { error } = await db.from('purchase_orders').update(header).eq('id', id);
        if(error) throw error;
      }else{
        const { data, error } = await db.from('purchase_orders').insert(header).select('*').single();
        if(error) throw error;
        id = data.id; purchMarkOwn(id);
        poEditing = data;
      }
      const clean = poItems.filter(it=> String(it.description || '').trim());
      clean.forEach(it=>{ if(!it.id) it.id = poUuid(); });
      purchMarkOwn(id);
      if(clean.length){
        const rows = clean.map((it, i)=> ({
          id: it.id, po_id: id, line_no: i + 1, material_id: it.material_id || null, code: it.code || '',
          description: it.description.trim(), unit: (it.unit || '').trim(), qty: Number(it.qty), unit_price: Number(it.unit_price)
        }));
        const { error } = await db.from('purchase_order_items').upsert(rows, { onConflict: 'id' });
        if(error) throw error;
      }
      let del = db.from('purchase_order_items').delete().eq('po_id', id);
      if(clean.length) del = del.not('id', 'in', '(' + clean.map(it=> it.id).join(',') + ')');
      const dr = await del;
      if(dr.error) throw dr.error;
      const h = await db.from('purchase_orders').select('*').eq('id', id);
      if(h.error) throw h.error;
      poEditing = h.data[0];
      poApplyMode();
      poDirty = false;
      if(!quiet) toast(poEditing.po_no + ' saved');
      poLoadList({ silent:true }).then(ok=>{ if(ok) poRenderList(); });
      return poEditing;
    }catch(e){
      purchFail('Couldn\u2019t save the PO: ', e);
      return null;
    }
  }

  $('poActions').addEventListener('click', async (e)=>{
    const b = e.target.closest('[data-po-act]');
    if(!b) return;
    const act = b.dataset.poAct;
    const lock = (on)=> $$('#poActions .btn').forEach(x=>{ x.disabled = on; });
    lock(true);
    try{
      if(act === 'save') await poSave();
      else if(act === 'preview') await poShowPdf('view');
      else if(act === 'download') await poShowPdf('download');
      else if(act === 'duplicate') poDuplicate();
      else if(act === 'issue') await poIssue();
      else if(act === 'cancel') await poCancel();
      else if(act === 'delete') await poDeleteDraft();
    }finally{ lock(false); }
  });

  async function poIssue(){
    const err = poValidate();
    if(err){ toast(err); return; }
    if(!$('poSupplier').value){ toast('Choose a supplier before issuing'); return; }
    if(!poCleanItems().filter(it=> it.description.trim()).length){ toast('Add at least one item before issuing'); return; }
    if(!$('poApprovedBy').value){ toast('Choose who approves this PO before issuing'); $('poApprovedBy').focus(); return; }
    const t = poCalc(poCleanItems(), $('poVatMode').value, poNum($('poDiscount').value) || 0, Number($('poEwt').value) || 0);
    const s = poCurrentSupplier();
    if(!confirm('Issue this PO to ' + poSupplierName(s) + ' for ₱' + poFmt(t.total) + (t.ewt ? ' (net payable ₱' + poFmt(t.netPayable) + ' after EWT)' : '') + '?\n\nOnce issued it is locked: it can be viewed, downloaded or cancelled, but not edited.')) return;
    const saved = await poSave({ quiet:true });
    if(!saved) return;
    try{
      purchMarkOwn(saved.id);
      const { error } = await db.from('purchase_orders').update({ status:'issued' }).eq('id', saved.id);
      if(error) throw error;
      const h = await db.from('purchase_orders').select('*').eq('id', saved.id);
      if(h.error) throw h.error;
      poEditing = h.data[0];
      poApplyMode(); poRenderItems();
      toast(poEditing.po_no + ' issued');
      poLoadList({ silent:true }).then(ok=>{ if(ok) poRenderList(); });
      await poShowPdf('view');
    }catch(e){ purchFail('Couldn\u2019t issue the PO: ', e); }
  }
  async function poCancel(){
    if(!poEditing) return;
    const reason = prompt('Cancel ' + poEditing.po_no + '?\n\nThe PO stays on record, marked CANCELLED. Enter the reason:');
    if(reason === null) return;
    if(!reason.trim()){ toast('A reason is required to cancel'); return; }
    if(!(await purchEnsureSession())) return;
    try{
      purchMarkOwn(poEditing.id);
      const { error } = await db.from('purchase_orders').update({ status:'cancelled', cancel_reason: reason.trim() }).eq('id', poEditing.id);
      if(error) throw error;
      const h = await db.from('purchase_orders').select('*').eq('id', poEditing.id);
      if(h.error) throw h.error;
      poEditing = h.data[0];
      poApplyMode(); poRenderItems();
      toast(poEditing.po_no + ' cancelled');
      poLoadList({ silent:true }).then(ok=>{ if(ok) poRenderList(); });
    }catch(e){ purchFail('Couldn\u2019t cancel the PO: ', e); }
  }
  async function poDeleteDraft(){
    if(!poEditing) return;
    if(!confirm('Delete draft ' + poEditing.po_no + '? This can\u2019t be undone.')) return;
    poDirty = false;
    if(!(await purchEnsureSession())) return;
    try{
      purchMarkOwn(poEditing.id);
      const { error } = await db.from('purchase_orders').delete().eq('id', poEditing.id);
      if(error) throw error;
      toast('Draft deleted');
      poClose();
    }catch(e){ purchFail('Couldn\u2019t delete the draft: ', e); }
  }
  function poDuplicate(){
    if(!poConfirmLeave()) return;
    const header = poGatherHeader();
    const items = poCleanItems().filter(it=> it.description.trim());
    poEditing = null;
    poOpen(null, { header, items }).then(()=> toast('Copied into a new draft — review and save'));
  }
  function poClose(){
    poShowListView();
    poShow();
  }
  $('poStaleReload').addEventListener('click', ()=>{ if(poEditing) poOpen(poEditing.id); });

  // ---------- images from storage (logo / signatures) ----------
  function poBlobToDataUrl(blob){
    return new Promise((res, rej)=>{ const r = new FileReader(); r.onload = ()=> res(r.result); r.onerror = rej; r.readAsDataURL(blob); });
  }
  function poImageSize(dataUrl){
    return new Promise((res)=>{ const im = new Image(); im.onload = ()=> res({ w: im.naturalWidth, h: im.naturalHeight }); im.onerror = ()=> res({ w: 0, h: 0 }); im.src = dataUrl; });
  }
  async function poLoadImage(path){
    if(!path) return null;
    if(poImgCache.has(path)) return poImgCache.get(path);
    try{
      const { data, error } = await db.storage.from(PO_BUCKET).download(path);
      if(error || !data) throw error || new Error('no data');
      const dataUrl = await poBlobToDataUrl(data);
      const size = await poImageSize(dataUrl);
      const out = { dataUrl, w: size.w, h: size.h };
      poImgCache.set(path, out);
      return out;
    }catch(e){ console.warn('image load failed', path, e); return null; }
  }
  // The built-in AWES logo is white artwork (made for the green band).
  // For the white header it's recoloured to the brand green: every pixel
  // takes the green, keeping its transparency — so edges stay smooth.
  const poLogoCache = {};
  async function poDefaultLogo(style){
    const key = style === 'green' ? 'green-band' : 'white';
    if(poLogoCache[key]) return poLogoCache[key];
    const size = await poImageSize(AWES_LOGO_B64);
    if(key === 'green-band') return (poLogoCache[key] = { dataUrl: AWES_LOGO_B64, w: size.w, h: size.h });
    const im = new Image(); im.src = AWES_LOGO_B64; await im.decode();
    const c = document.createElement('canvas'); c.width = im.naturalWidth; c.height = im.naturalHeight;
    const ctx = c.getContext('2d');
    ctx.drawImage(im, 0, 0);
    ctx.globalCompositeOperation = 'source-in';   // paint only where the logo is
    ctx.fillStyle = 'rgb(21,77,52)';
    ctx.fillRect(0, 0, c.width, c.height);
    return (poLogoCache[key] = { dataUrl: c.toDataURL('image/png'), w: c.width, h: c.height });
  }

  // Uploaded logo → how it appears in the header: all-white on the green
  // band (shape kept via its transparency), original colours on white.
  const poTintCache = new Map();
  async function poLogoForStyle(img, style){
    if(!img || style !== 'green') return img;
    const key = img.dataUrl.length + ':' + img.dataUrl.slice(-40);
    if(poTintCache.has(key)) return poTintCache.get(key);
    const im = new Image(); im.src = img.dataUrl; await im.decode();
    const c = document.createElement('canvas'); c.width = im.naturalWidth; c.height = im.naturalHeight;
    const ctx = c.getContext('2d');
    ctx.drawImage(im, 0, 0);
    ctx.globalCompositeOperation = 'source-in';
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    const out = { dataUrl: c.toDataURL('image/png'), w: c.width, h: c.height };
    poTintCache.set(key, out);
    return out;
  }
  // A logo saved as JPG / on a white or coloured box has no transparency, so
  // turning it white would give a solid white rectangle. Remove a uniform
  // background (sampled from the corners) and crop to the artwork.
  function poPrepareLogo(src){
    const c = document.createElement('canvas'); c.width = src.width; c.height = src.height;
    const ctx = c.getContext('2d'); ctx.drawImage(src, 0, 0);
    const img = ctx.getImageData(0, 0, c.width, c.height), px = img.data, W = c.width, H = c.height;
    const at = (x, y)=> (y * W + x) * 4;
    const corners = [at(0, 0), at(W - 1, 0), at(0, H - 1), at(W - 1, H - 1)];
    const opaque = corners.every(i=> px[i + 3] > 245);
    if(opaque){
      const bg = [0, 1, 2].map(k=> corners.reduce((a, i)=> a + px[i + k], 0) / 4);
      const lo = 22, hi = 70;   // colour distance: ≤lo → background, ≥hi → artwork
      for(let i = 0; i < px.length; i += 4){
        const d = Math.sqrt((px[i] - bg[0]) ** 2 + (px[i + 1] - bg[1]) ** 2 + (px[i + 2] - bg[2]) ** 2);
        const a = d <= lo ? 0 : d >= hi ? 255 : Math.round(255 * (d - lo) / (hi - lo));
        px[i + 3] = Math.min(px[i + 3], a);
      }
      ctx.putImageData(img, 0, 0);
    }
    let x0 = W, y0 = H, x1 = -1, y1 = -1;
    for(let y = 0; y < H; y++) for(let x = 0; x < W; x++){
      if(px[at(x, y) + 3] > 24){ if(x < x0) x0 = x; if(x > x1) x1 = x; if(y < y0) y0 = y; if(y > y1) y1 = y; }
    }
    if(x1 < 0) return c;
    const pad = 4;
    x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(W - 1, x1 + pad); y1 = Math.min(H - 1, y1 + pad);
    const out = document.createElement('canvas'); out.width = x1 - x0 + 1; out.height = y1 - y0 + 1;
    out.getContext('2d').drawImage(c, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
    return out;
  }

  // ---------- PDF ----------
  // What goes on the PDF. Issued/cancelled POs print ONLY their snapshots,
  // so the document the supplier received never changes. Drafts use live
  // data (and the current form contents, even before saving).
  async function poPdfData(){
    const live = !poEditing || poEditing.status === 'draft';
    const header = live ? Object.assign({}, poEditing || {}, poGatherHeader()) : poEditing;
    const items = live ? poCleanItems().filter(it=> it.description.trim()) : poItems.map(it=> Object.assign({}, it, { qty: Number(it.qty), unit_price: Number(it.unit_price) }));
    let company, supplier, prepared, approved;
    if(live){
      company = poSettingsData || {};
      const s = poSuppliers.find(x=> x.id === header.supplier_id);
      const c = s ? (s.supplier_contacts || []).slice().sort((a, b)=> (b.is_primary ? 1 : 0) - (a.is_primary ? 1 : 0))[0] : null;
      supplier = s ? { name: s.name, trade_name: s.trade_name, address: s.address, city: s.city, tin: s.tin,
        contact_name: c ? c.name : '', contact_mobile: c ? c.mobile : '', contact_email: c ? c.email : '' } : null;
      const sig = (id)=>{ const x = poSignatories.find(s2=> s2.id === id); return x ? { name: x.name, position: x.position, signature_path: x.signature_path } : null; };
      prepared = sig(header.prepared_by_id); approved = sig(header.approved_by_id);
    }else{
      company = header.company_snapshot || poSettingsData || {};
      supplier = header.supplier_snapshot; prepared = header.prepared_snapshot; approved = header.approved_snapshot;
    }
    const style = company.header_style || 'green';
    const [logo, prepSig, apprSig] = await Promise.all([
      company.logo_path ? poLoadImage(company.logo_path).then(img=> poLogoForStyle(img, style)) : poDefaultLogo(style),
      prepared && prepared.signature_path ? poLoadImage(prepared.signature_path) : null,
      approved && approved.signature_path ? poLoadImage(approved.signature_path) : null
    ]);
    return { header, items, company, supplier, prepared, approved, logo: logo || await poDefaultLogo(style), prepSig, apprSig,
      totals: poCalc(items, header.vat_mode, header.discount, header.ewt_rate), status: header.status || 'draft',
      terms: company.terms || '' };
  }

  // ---- PDF typeface ----
  // Inter (SIL Open Font Licence — fonts/Inter-LICENSE.txt), subset to Latin
  // + punctuation + ₱, ~25 KB per weight. Loaded on first PDF only and
  // precached by the service worker for offline use. If it can't load, the
  // PDF falls back to jsPDF's built-in Helvetica (which has no ₱ glyph, so
  // amounts then print as "PHP").
  const PO_FONT_FILES = { regular:'fonts/Inter-Regular.ttf', semibold:'fonts/Inter-SemiBold.ttf', bold:'fonts/Inter-Bold.ttf' };
  let poFontData = null, poFontTried = false;
  async function poLoadFonts(){
    if(poFontData || poFontTried) return poFontData;
    poFontTried = true;
    try{
      const out = {};
      for(const [k, url] of Object.entries(PO_FONT_FILES)){
        const r = await fetch(url);
        if(!r.ok) throw new Error(url + ' ' + r.status);
        const bytes = new Uint8Array(await r.arrayBuffer());
        let bin = '';
        for(let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        out[k] = btoa(bin);
      }
      poFontData = out;
    }catch(e){ console.warn('PO font unavailable, using Helvetica', e); poFontTried = false; }
    return poFontData;
  }

  async function poBuildPdf(d){
    await loadAwesScript('jspdf', awesLibs.jspdf);
    await loadAwesScript('autotable', awesLibs.autotable);
    const fonts = await poLoadFonts();
    const { jsPDF } = window.jspdf;
    // compress: deflate page content + fonts. Images below also use 'FAST'
    // (lossless deflate) — jsPDF's default stores them raw, which made a
    // one-page PO with a logo + two signatures about 1.7 MB.
    const doc = new jsPDF({ orientation:'p', unit:'pt', format:'a4', compress:true });
    let F = 'helvetica', FS = ['helvetica', 'bold'], FB = ['helvetica', 'bold'];
    if(fonts){
      try{
        doc.addFileToVFS('Inter-Regular.ttf', fonts.regular);   doc.addFont('Inter-Regular.ttf', 'Inter', 'normal');
        doc.addFileToVFS('Inter-SemiBold.ttf', fonts.semibold); doc.addFont('Inter-SemiBold.ttf', 'Inter', 'bold');
        doc.addFileToVFS('Inter-Bold.ttf', fonts.bold);         doc.addFont('Inter-Bold.ttf', 'InterBold', 'normal');
        F = 'Inter'; FS = ['Inter', 'bold']; FB = ['InterBold', 'normal'];
      }catch(e){ console.warn('PO font registration failed', e); }
    }
    const peso = F === 'Inter' ? '\u20B1' : 'PHP ';
    const reg = (size)=>{ doc.setFont(F, 'normal'); if(size) doc.setFontSize(size); };
    const semi = (size)=>{ doc.setFont(FS[0], FS[1]); if(size) doc.setFontSize(size); };
    const bold = (size)=>{ doc.setFont(FB[0], FB[1]); if(size) doc.setFontSize(size); };
    const caps = (txt, x, yy, color, opts)=>{   // small spaced capitals for labels
      semi(6.8); doc.setTextColor(...color); doc.setCharSpace(0.6);
      doc.text(String(txt).toUpperCase(), x, yy, opts || {}); doc.setCharSpace(0);
    };

    const W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight();
    const M = 36;
    const G = [21, 77, 52], G2 = [31, 122, 80], MINT = [233, 243, 237], MINT_TXT = [197, 229, 210];
    const INK = [28, 34, 30], SUB = [96, 108, 101], LINE = [216, 223, 219];
    const co = d.company || {}, h = d.header, t = d.totals;
    const green = co.header_style !== 'white';          // default: green band
    const fitImg = (img, maxW, maxH)=>{
      if(!img || !img.w || !img.h) return { w: maxW, h: maxH };
      const r = Math.min(maxW / img.w, maxH / img.h);
      return { w: img.w * r, h: img.h * r };
    };
    const imgFmt = (url)=> /^data:image\/jpe?g/i.test(url) ? 'JPEG' : 'PNG';
    const money = (n)=> peso + poFmt(n);

    // ---- header (original layout): green band; logo with the company
    // details stacked under it on the left, title block on the right ----
    const headH = 118;
    const ink = green ? [255, 255, 255] : INK;
    const soft = green ? [255, 255, 255] : SUB;     // on the green band everything is white
    if(green){ doc.setFillColor(...G); doc.rect(0, 0, W, headH, 'F'); }
    else{ doc.setFillColor(...G); doc.rect(0, headH - 4, W, 4, 'F'); }
    const lg = fitImg(d.logo, 150, 44);
    try{ doc.addImage(d.logo.dataUrl, imgFmt(d.logo.dataUrl), M, 16, lg.w, lg.h, 'po-logo', 'FAST'); }catch(e){}
    let hy = 16 + lg.h + 14;
    semi(9.5); doc.setTextColor(...(green ? ink : G));
    doc.text(co.company_name || '', M, hy); hy += 11;
    reg(7.8); doc.setTextColor(...soft);
    if(co.tagline){ doc.text(co.tagline, M, hy); hy += 10; }
    reg(7.2); doc.setTextColor(...ink);
    doc.splitTextToSize(co.address || '', 310).slice(0, 2).forEach(line=>{ doc.text(line, M, hy); hy += 9; });
    const contact = [co.phone, co.email, co.tin ? 'TIN ' + co.tin : ''].filter(Boolean).join('   •   ');
    if(contact) doc.splitTextToSize(contact, 330).slice(0, 2).forEach(line=>{ doc.text(line, M, hy); hy += 9; });
    bold(18); doc.setTextColor(...(green ? ink : G));
    doc.text('PURCHASE ORDER', W - M, 36, { align:'right' });
    semi(10.5); doc.setTextColor(...ink);
    doc.text(h.po_no || 'DRAFT — not yet saved', W - M, 54, { align:'right' });
    reg(8.8); doc.setTextColor(...ink);
    doc.text('Date: ' + poDateLong(h.po_date), W - M, 68, { align:'right' });
    if(d.status !== 'issued'){ semi(8.8); doc.text('Status: ' + d.status.toUpperCase(), W - M, 82, { align:'right' }); }
    let y = Math.max(headH, hy + 6) + 16;

    // ---- supplier / delivery ----
    const colW = (W - M * 2 - 14) / 2, pad = 11, labW = 58;
    const block = (x, title, rows)=>{
      const lines = [];
      rows.forEach(([label, value, strong])=>{
        if(!value) return;
        reg(8.4);
        lines.push({ label, strong, wrapped: doc.splitTextToSize(String(value), colW - pad * 2 - (label ? labW : 0)) });
      });
      const hgt = 24 + lines.reduce((a, l)=> a + l.wrapped.length * 10.8 + 2.5, 0) + 8;
      return { hgt, draw: (hh)=>{
        doc.setFillColor(247, 250, 248); doc.setDrawColor(...LINE); doc.setLineWidth(0.5);
        doc.roundedRect(x, y, colW, hh, 3, 3, 'FD');
        doc.setFillColor(...G2); doc.rect(x, y, 3, hh, 'F');                 // accent edge
        caps(title, x + pad + 2, y + 14, G);
        let yy = y + 28;
        lines.forEach(l=>{
          if(l.label){ reg(7.6); doc.setTextColor(...SUB); doc.text(l.label, x + pad + 2, yy); }
          if(l.strong) semi(9.4); else reg(8.4);
          doc.setTextColor(...INK);
          doc.text(l.wrapped, x + pad + 2 + (l.label ? labW : 0), yy);
          yy += l.wrapped.length * 10.8 + 2.5;
        });
      } };
    };
    const s = d.supplier || {};
    const left = block(M, 'Supplier', [
      ['', s.name || '(no supplier selected)', true],
      ['', s.trade_name && s.trade_name !== s.name ? s.trade_name : ''],
      ['', [s.address, s.city].filter(Boolean).join(', ')],
      ['TIN', s.tin],
      ['Contact', [s.contact_name, s.contact_mobile].filter(Boolean).join(' · ')],
      ['Email', s.contact_email]
    ]);
    const right = block(M + colW + 14, 'Delivery & Terms', [
      ['Deliver to', h.deliver_to || '—'],
      ['Delivery', h.delivery_date ? poDateLong(h.delivery_date) : 'As soon as possible'],
      ['Terms', h.payment_terms || '—'],
      ['Reference', h.reference]
    ]);
    const boxH = Math.max(left.hgt, right.hgt, 84);
    left.draw(boxH); right.draw(boxH);
    y += boxH + 16;

    // ---- items ----
    doc.autoTable({
      startY: y, margin: { left: M, right: M, top: 40, bottom: 60 },
      head: [['#', 'Item Code', 'Description', 'Qty', 'Unit', 'Unit Price', 'Amount']],
      body: d.items.map((it, i)=> [String(i + 1), it.code || '', it.description, poQtyFmt(it.qty), it.unit || '', poFmt(it.unit_price), poFmt(poRound2(it.qty * it.unit_price))]),
      theme: 'plain',
      styles: { font: F, fontStyle:'normal', fontSize: 8.4, cellPadding: { top: 5.5, bottom: 5.5, left: 6, right: 6 }, textColor: INK, valign:'middle', lineColor: LINE, lineWidth: { bottom: 0.5 } },
      headStyles: { font: F, fontStyle:'bold', fillColor: G, textColor: 255, fontSize: 7.8, halign:'center', lineWidth: 0 },
      alternateRowStyles: { fillColor: [247, 250, 248] },
      columnStyles: {
        0: { halign:'center', cellWidth: 24, textColor: SUB }, 1: { cellWidth: 62, fontSize: 7.4, textColor: SUB }, 2: { cellWidth: 'auto' },
        3: { halign:'right', cellWidth: 46 }, 4: { halign:'center', cellWidth: 42 },
        5: { halign:'right', cellWidth: 70 }, 6: { halign:'right', cellWidth: 80, fontStyle:'bold' }
      },
      didParseCell: (c)=>{ if(c.section === 'head' && (c.column.index === 3 || c.column.index === 5 || c.column.index === 6)) c.cell.styles.halign = 'right'; if(c.section === 'head' && c.column.index === 2) c.cell.styles.halign = 'left'; }
    });
    y = doc.lastAutoTable.finalY + 14;

    // ---- totals (right) + amount in words (left) ----
    const rows = [['Subtotal', money(t.subtotal)]];
    if(t.discount) rows.push(['Less: Discount', '(' + money(t.discount) + ')']);
    if(h.vat_mode === 'exclusive') rows.push(['Add: VAT 12%', money(t.vat)]);
    else if(h.vat_mode === 'inclusive'){ rows.push(['VATable Sales', money(t.vatable)]); rows.push(['VAT 12% (included)', money(t.vat)]); }
    else rows.push(['VAT', 'Non-VAT']);
    if(t.ewt){
      rows.push(['Total Amount', money(t.total), true]);
      rows.push([poEwtLabel(t.ewtRate), '(' + money(t.ewt) + ')']);
    }
    const bandLabel = t.ewt ? 'NET AMOUNT PAYABLE' : 'TOTAL AMOUNT';
    const bandValue = t.ewt ? t.netPayable : t.total;
    const tw = 212, tx = W - M - tw;
    if(y + rows.length * 15 + 40 > H - 190){ doc.addPage(); y = 50; }
    rows.forEach(([l, v, strong], i)=>{
      if(strong){ doc.setDrawColor(...LINE); doc.setLineWidth(0.5); doc.line(tx + 10, y + i * 15, W - M - 10, y + i * 15); }
      if(strong) semi(8.6); else reg(8.6);
      doc.setTextColor(...(strong ? INK : SUB)); doc.text(l, tx + 10, y + 10 + i * 15);
      doc.setTextColor(...INK); doc.text(v, W - M - 10, y + 10 + i * 15, { align:'right' });
    });
    const ty = y + rows.length * 15 + 2;
    doc.setFillColor(...G); doc.roundedRect(tx, ty, tw, 26, 3, 3, 'F');
    semi(t.ewt ? 8 : 9); doc.setTextColor(...MINT_TXT); doc.text(bandLabel, tx + 10, ty + 16.5);
    bold(12.5); doc.setTextColor(255, 255, 255); doc.text(money(bandValue), W - M - 10, ty + 17.5, { align:'right' });
    caps('Amount in words', M, y + 10, G);
    reg(8.6); doc.setTextColor(...INK);
    const words = doc.splitTextToSize(poAmountInWords(bandValue), tx - M - 16);
    doc.text(words, M, y + 24);
    y = Math.max(ty + 26, y + 24 + words.length * 11) + 20;

    // ---- terms ----
    const termsText = d.terms || '';
    if(termsText){
      reg(7.8);
      const LH = 10.2, full = W - M * 2;
      const paras = termsText.split(/\r?\n/).map(line=>{
        const m = /^\s*(\d+[.)]|[-•*])\s+(.*)$/.exec(line);
        if(!m) return { num: '', lines: line.trim() ? doc.splitTextToSize(line.trim(), full) : [''] };
        const indent = Math.max(14, doc.getTextWidth(m[1]) + 6);
        return { num: m[1], indent, lines: doc.splitTextToSize(m[2], full - indent) };
      });
      const needed = paras.reduce((a, p)=> a + p.lines.length * LH + 2, 0);
      if(y + 18 + needed > H - 175){ doc.addPage(); y = 50; }
      caps('Terms & Conditions', M, y, G); y += 13;
      reg(7.8); doc.setTextColor(...SUB);
      paras.forEach(p=>{
        if(p.num){ doc.text(p.num, M, y); doc.text(p.lines, M + p.indent, y); }
        else doc.text(p.lines, M, y);
        y += p.lines.length * LH + 2;
      });
      y += 10;
    }

    // ---- signatures: pinned to the bottom of the LAST page ----
    const sigH = 96, sigTop = H - 46 - sigH;
    if(y > sigTop - 10) doc.addPage();
    y = sigTop;
    doc.setDrawColor(...LINE); doc.setLineWidth(0.5); doc.line(M, y - 12, W - M, y - 12);
    const gap = 18, sw = (W - M * 2 - gap * 2) / 3;
    const sigBlock = (x, caption, person, img, fallback)=>{
      caps(caption, x, y + 6, SUB);
      const lineY = y + 62;
      if(img && img.dataUrl){
        const f = fitImg(img, sw - 16, 44);
        try{ doc.addImage(img.dataUrl, imgFmt(img.dataUrl), x + (sw - f.w) / 2, lineY - f.h + 5, f.w, f.h, undefined, 'FAST'); }catch(e){}
      }
      doc.setDrawColor(70, 76, 72); doc.setLineWidth(0.6); doc.line(x, lineY, x + sw, lineY);
      if(person && person.name){
        semi(8.8); doc.setTextColor(...INK); doc.text(person.name.toUpperCase(), x + sw / 2, lineY + 12, { align:'center' });
        if(person.position){ reg(7.6); doc.setTextColor(...SUB); doc.text(person.position, x + sw / 2, lineY + 23, { align:'center' }); }
      }else{
        reg(7.6); doc.setTextColor(...SUB); doc.text(fallback, x + sw / 2, lineY + 12, { align:'center' });
      }
    };
    sigBlock(M, 'Prepared by', d.prepared, d.prepSig, 'Signature over printed name');
    sigBlock(M + sw + gap, 'Approved by', d.approved, d.apprSig, 'Signature over printed name');
    sigBlock(M + (sw + gap) * 2, 'Conforme — Supplier', null, null, 'Signature over printed name / Date');

    // ---- every page: watermark + footer ----
    const pages = doc.internal.getNumberOfPages();
    for(let pn = 1; pn <= pages; pn++){
      doc.setPage(pn);
      if(d.status !== 'issued'){
        try{
          doc.saveGraphicsState();
          doc.setGState(new doc.GState({ opacity: d.status === 'cancelled' ? 0.14 : 0.07 }));
          doc.setTextColor(...(d.status === 'cancelled' ? [200, 30, 30] : [40, 40, 40]));
          bold(92);
          doc.text(d.status === 'cancelled' ? 'CANCELLED' : 'DRAFT', W / 2, H / 2 + 70, { align:'center', angle: 35 });
          doc.restoreGraphicsState();
        }catch(e){}
      }
      doc.setDrawColor(...LINE); doc.setLineWidth(0.5); doc.line(M, H - 32, W - M, H - 32);
      reg(7); doc.setTextColor(...SUB);
      doc.text([h.po_no || 'Draft PO', co.company_name].filter(Boolean).join('   •   ') +
        (d.status === 'cancelled' && h.cancel_reason ? '   •   Cancelled: ' + h.cancel_reason : ''), M, H - 20);
      doc.text('Page ' + pn + ' of ' + pages, W - M, H - 20, { align:'right' });
    }
    doc.setTextColor(0, 0, 0);
    return doc;
  }

  // Preview overlay sits under the PO sheet by default (z-index 50) —
  // lift it while a PO is shown, drop it back when it closes.
  new MutationObserver(()=>{
    if(!$('previewOverlay').classList.contains('open')) $('previewOverlay').style.zIndex = '';
  }).observe($('previewOverlay'), { attributes:true, attributeFilter:['class'] });

  async function poShowPdf(mode){
    try{
      const d = await poPdfData();
      if(!d.items.length){ toast('Add at least one item first'); return; }
      const doc = await poBuildPdf(d);
      const supplierPart = d.supplier ? '-' + String(poSupplierName(d.supplier)).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) : '';
      const filename = (d.header.po_no || 'Draft-PO') + supplierPart + (d.status === 'issued' ? '' : '-' + d.status.toUpperCase()) + '.pdf';
      const title = 'Purchase Order ' + (d.header.po_no || '(draft)');
      if(mode === 'download'){
        const how = await shareOrDownloadPdf(doc, filename, title);
        toast(how === 'shared' ? 'PO shared' : 'PO downloaded');
        return;
      }
      $('previewOverlay').querySelector('h3').textContent = title;
      $('previewOkBtn').textContent = 'Close';
      $('previewOverlay').style.zIndex = '99';
      $('previewOverlay').classList.add('open');
      await renderPdfPreview(doc, filename, title);
    }catch(e){
      console.error('PO pdf failed', e);
      toast('Couldn\u2019t build the PDF: ' + (e && e.message ? e.message : e));
    }
  }

  // ---------- PO settings: company + logo ----------
  function poSetTab(tab){
    $$('#poSetTabs [data-po-tab]').forEach(b=> b.classList.toggle('active', b.dataset.poTab === tab));
    $('poSetPaneCompany').style.display = tab === 'company' ? '' : 'none';
    $('poSetPaneSignatories').style.display = tab === 'signatories' ? '' : 'none';
    if(tab === 'signatories') poRenderSigList();
  }
  $('poSetTabs').addEventListener('click', (e)=>{ const b = e.target.closest('[data-po-tab]'); if(b) poSetTab(b.dataset.poTab); });
  $('poSettingsBtn').addEventListener('click', async ()=>{
    if(!(await ensureCloud())){ toast('Not connected'); return; }
    try{ await Promise.all([poLoadSettings(), poLoadSignatories()]); }
    catch(e){ purchFail('Couldn\u2019t load PO settings: ', e); return; }
    poFillSettingsForm();
    poResetSigForm();
    poSetTab('company');
    $('poSettingsOverlay').classList.add('open');
  });
  $('poSettingsClose').addEventListener('click', ()=>{
    $('poSettingsOverlay').classList.remove('open');
    // an open PO editor picks up new signatories / defaults
    if(poEditorVisible()){ poFillSignatorySelects(); poRenderSigHint(); }
  });
  function poFillSettingsForm(){
    const d = poSettingsData || {};
    $('poCoName').value = d.company_name || ''; $('poCoTagline').value = d.tagline || '';
    $('poCoAddress').value = d.address || ''; $('poCoPhone').value = d.phone || '';
    $('poCoEmail').value = d.email || ''; $('poCoTin').value = d.tin || '';
    $('poCoVat').value = d.vat_mode || 'exclusive'; $('poCoDeliverTo').value = d.deliver_to || '';
    $('poCoTerms').value = d.terms || ''; $('poHeaderStyle').value = d.header_style || 'green';
    poRenderLogoPreview();
  }
  async function poRenderLogoPreview(){
    const d = poSettingsData || {};
    const box = $('poLogoPreview');
    const style = $('poHeaderStyle').value || 'green';
    box.classList.toggle('green', style === 'green');
    const img = d.logo_path ? await poLogoForStyle(await poLoadImage(d.logo_path), style) : await poDefaultLogo(style);
    box.innerHTML = img ? '<img alt="Logo" src="' + img.dataUrl + '">' : '<span style="font-size:12px;color:var(--text-muted);">Logo unavailable</span>';
    $('poLogoResetBtn').style.display = d.logo_path ? '' : 'none';
  }
  $('poHeaderStyle').addEventListener('change', poRenderLogoPreview);
  async function poSaveSettings(patch, msg){
    if(!(await purchEnsureSession())) return false;
    const data = Object.assign({}, poSettingsData || {}, patch);
    try{
      const { error } = await db.from('po_settings').upsert({ id: 1, data }, { onConflict: 'id' });
      if(error) throw error;
      poSettingsData = data;
      if(msg) toast(msg);
      return true;
    }catch(e){ purchFail('Couldn\u2019t save PO settings: ', e); return false; }
  }
  $('poSettingsSaveBtn').addEventListener('click', async ()=>{
    const btn = $('poSettingsSaveBtn'); btn.disabled = true;
    try{
      await poSaveSettings({
        company_name: $('poCoName').value.trim(), tagline: $('poCoTagline').value.trim(),
        address: $('poCoAddress').value.trim(), phone: $('poCoPhone').value.trim(),
        email: $('poCoEmail').value.trim(), tin: $('poCoTin').value.trim(),
        vat_mode: $('poCoVat').value, deliver_to: $('poCoDeliverTo').value.trim(),
        terms: $('poCoTerms').value.trim(), header_style: $('poHeaderStyle').value
      }, 'PO settings saved');
    }finally{ btn.disabled = false; }
  });

  // Draws an uploaded image onto a canvas (downscaled) and returns a PNG blob.
  function poLoadFileImage(file){
    return new Promise((res, rej)=>{
      const url = URL.createObjectURL(file);
      const im = new Image();
      im.onload = ()=>{ URL.revokeObjectURL(url); res(im); };
      im.onerror = ()=>{ URL.revokeObjectURL(url); rej(new Error('That file isn\u2019t a readable image')); };
      im.src = url;
    });
  }
  function poCanvasToBlob(c){ return new Promise(res=> c.toBlob(res, 'image/png')); }
  async function poImageToPng(file, maxW, maxH){
    const im = await poLoadFileImage(file);
    const r = Math.min(1, maxW / im.naturalWidth, maxH / im.naturalHeight);
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(im.naturalWidth * r)); c.height = Math.max(1, Math.round(im.naturalHeight * r));
    c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
    return c;
  }
  async function poUploadPng(canvas, folder){
    const blob = await poCanvasToBlob(canvas);
    const path = folder + '/' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.png';
    const { error } = await db.storage.from(PO_BUCKET).upload(path, blob, { contentType:'image/png', upsert:false });
    if(error) throw error;
    const dataUrl = canvas.toDataURL('image/png');
    poImgCache.set(path, { dataUrl, w: canvas.width, h: canvas.height });
    return path;
  }
  $('poLogoUploadBtn').addEventListener('click', ()=>{ $('poLogoFile').value = ''; $('poLogoFile').click(); });
  $('poLogoFile').addEventListener('change', async ()=>{
    const file = $('poLogoFile').files && $('poLogoFile').files[0];
    if(!file) return;
    if(file.size > 8 * 1024 * 1024){ toast('Logo file is over 8 MB'); return; }
    if(!(await purchEnsureSession())) return;
    const btn = $('poLogoUploadBtn'); btn.disabled = true; btn.textContent = 'Uploading…';
    try{
      const canvas = poPrepareLogo(await poImageToPng(file, 900, 320));
      const path = await poUploadPng(canvas, 'logo');
      // The old file is kept on purpose: issued POs still point at it.
      if(await poSaveSettings({ logo_path: path }, 'Logo updated')) poRenderLogoPreview();
    }catch(e){ purchFail('Logo upload failed: ', e); }
    finally{ btn.disabled = false; btn.textContent = 'Upload logo'; }
  });
  $('poLogoResetBtn').addEventListener('click', async ()=>{
    if(!confirm('Go back to the default AWES logo? (Issued POs keep the logo they were issued with.)')) return;
    if(await poSaveSettings({ logo_path: '' }, 'Using the default AWES logo')) poRenderLogoPreview();
  });

  // ---------- signatories ----------
  let poSigCanvas = null;          // processed signature waiting to be saved
  const poSigThumbs = new Map();   // path -> dataUrl (list thumbnails)

  // Turns a photo/scan of a signature into a clean PNG: paper → transparent,
  // then crops to the ink. Background level comes from the brighter pixels
  // so shadows/grey paper in phone photos are handled.
  function poCleanSignature(src){
    const c = document.createElement('canvas');
    c.width = src.width; c.height = src.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(src, 0, 0);
    const img = ctx.getImageData(0, 0, c.width, c.height);
    const px = img.data;
    const lums = [];
    for(let i = 0; i < px.length; i += 16) lums.push(0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]);
    lums.sort((a, b)=> a - b);
    const bg = lums[Math.floor(lums.length * 0.9)] || 255;
    const cut = bg * 0.78, soft = bg * 0.55;
    let minX = c.width, minY = c.height, maxX = -1, maxY = -1;
    for(let y = 0; y < c.height; y++){
      for(let x = 0; x < c.width; x++){
        const i = (y * c.width + x) * 4;
        if(px[i + 3] === 0) continue;
        const l = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
        let a;
        if(l >= cut) a = 0;
        else if(l <= soft) a = 255;
        else a = Math.round(255 * (cut - l) / (cut - soft));
        px[i + 3] = Math.min(px[i + 3], a);
        if(px[i + 3] > 40){ if(x < minX) minX = x; if(x > maxX) maxX = x; if(y < minY) minY = y; if(y > maxY) maxY = y; }
      }
    }
    ctx.putImageData(img, 0, 0);
    if(maxX < 0) return null;   // nothing but paper
    const pad = 8;
    minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
    maxX = Math.min(c.width - 1, maxX + pad); maxY = Math.min(c.height - 1, maxY + pad);
    const out = document.createElement('canvas');
    out.width = maxX - minX + 1; out.height = maxY - minY + 1;
    out.getContext('2d').drawImage(c, minX, minY, out.width, out.height, 0, 0, out.width, out.height);
    return out;
  }
  async function poProcessSigFile(){
    const file = $('poSigFile').files && $('poSigFile').files[0];
    poSigCanvas = null;
    if(!file){ poShowSigPreview(null); return; }
    if(file.size > 10 * 1024 * 1024){ toast('Signature image is over 10 MB'); $('poSigFile').value = ''; return; }
    try{
      let c = await poImageToPng(file, 1200, 600);
      if($('poSigClean').checked){
        const cleaned = poCleanSignature(c);
        if(!cleaned){ toast('No signature found in that image — try a darker pen or better light'); poShowSigPreview(null); return; }
        c = cleaned;
      }
      poSigCanvas = c;
      poShowSigPreview(c.toDataURL('image/png'));
    }catch(e){ toast(e.message || 'Couldn\u2019t read that image'); }
  }
  $('poSigFile').addEventListener('change', poProcessSigFile);
  $('poSigClean').addEventListener('change', poProcessSigFile);
  function poShowSigPreview(url){
    $('poSigPreview').innerHTML = url ? '<img alt="Signature" src="' + url + '">' : '<span>Signature preview</span>';
  }
  function poResetSigForm(){
    $('poSigId').value = ''; $('poSigName').value = ''; $('poSigPosition').value = '';
    $('poSigFile').value = ''; poSigCanvas = null; poShowSigPreview(null);
    $('poSigFormTitle').textContent = 'Add a signatory';
    $('poSigCancelBtn').style.display = 'none';
  }
  async function poRenderSigList(){
    const list = $('poSigList');
    if(!poSignatories.length){ list.innerHTML = '<div class="empty-state" style="padding:14px;">No signatories yet — add the people who prepare and approve POs below.</div>'; return; }
    list.innerHTML = poSignatories.map(s=>
      '<div class="sp-row" data-id="' + escapeHtml(s.id) + '"' + (s.is_active ? '' : ' style="opacity:.55;"') + '><div class="sp-row-top"><div style="min-width:0;">' +
        '<div class="sp-row-title">' + escapeHtml(s.name) + (s.is_active ? '' : ' <span class="sp-tag danger">Inactive</span>') + (s.signature_path ? '' : ' <span class="sp-tag warn">No signature</span>') + '</div>' +
        '<div class="sp-row-sub">' + escapeHtml(s.position || '') + '</div></div>' +
        '<div data-thumb="' + escapeHtml(s.signature_path || '') + '"></div></div>' +
      '<div class="user-card-actions"><button type="button" data-sact="edit" class="primary">Edit / New signature</button>' +
        '<button type="button" data-sact="toggle">' + (s.is_active ? 'Deactivate' : 'Reactivate') + '</button></div></div>'
    ).join('');
    for(const el of list.querySelectorAll('[data-thumb]')){
      const path = el.dataset.thumb;
      if(!path) continue;
      const img = await poLoadImage(path);
      if(img && el.isConnected) el.innerHTML = '<img class="po-sig-thumb" alt="" src="' + img.dataUrl + '">';
    }
  }
  $('poSigList').addEventListener('click', async (e)=>{
    const b = e.target.closest('[data-sact]');
    if(!b) return;
    const s = poSignatories.find(x=> x.id === b.closest('.sp-row').dataset.id);
    if(!s) return;
    if(b.dataset.sact === 'edit'){
      $('poSigId').value = s.id; $('poSigName').value = s.name; $('poSigPosition').value = s.position || '';
      $('poSigFile').value = ''; poSigCanvas = null;
      const img = s.signature_path ? await poLoadImage(s.signature_path) : null;
      poShowSigPreview(img ? img.dataUrl : null);
      $('poSigFormTitle').textContent = 'Edit ' + s.name + ' — upload a new file to replace the signature';
      $('poSigCancelBtn').style.display = '';
      $('poSigName').focus();
      return;
    }
    if(!(await purchEnsureSession())) return;
    b.disabled = true;
    try{
      const { error } = await db.from('po_signatories').update({ is_active: !s.is_active }).eq('id', s.id);
      if(error) throw error;
      await poLoadSignatories(); poRenderSigList();
    }catch(err){ b.disabled = false; purchFail('Couldn\u2019t update signatory: ', err); }
  });
  $('poSigCancelBtn').addEventListener('click', poResetSigForm);
  $('poSigSaveBtn').addEventListener('click', async ()=>{
    const name = $('poSigName').value.trim();
    if(!name){ toast('Enter the signatory\u2019s name'); $('poSigName').focus(); return; }
    const id = $('poSigId').value;
    if(!id && !poSigCanvas && !confirm('Save ' + name + ' without a signature? The PDF will show a blank line until one is uploaded.')) return;
    if(!(await purchEnsureSession())) return;
    const btn = $('poSigSaveBtn'); btn.disabled = true; btn.textContent = 'Saving…';
    try{
      const row = { name, position: $('poSigPosition').value.trim() };
      // A new file always gets a new path — issued POs keep pointing at the old one.
      if(poSigCanvas) row.signature_path = await poUploadPng(poSigCanvas, 'signatures');
      const res = id ? await db.from('po_signatories').update(row).eq('id', id)
                     : await db.from('po_signatories').insert(row);
      if(res.error) throw res.error;
      toast(id ? 'Signatory updated' : 'Signatory added');
      poResetSigForm();
      await poLoadSignatories(); poRenderSigList();
    }catch(e){ purchFail('Couldn\u2019t save signatory: ', e); }
    finally{ btn.disabled = false; btn.textContent = 'Save Signatory'; }
  });
