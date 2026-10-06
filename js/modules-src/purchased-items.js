  // =====================================================================
  // Purchased Items (Purchasing page) — every item bought, by the DATE IT WAS
  // RECEIVED, over a month or any date range, totalled per item or line by line,
  // with a PDF of the same view.
  //
  // Data: the database function purchased_items_report(from, to)
  // (migrations 20261020_01 + 20261022_01 + 20261024_01). Each row is one received
  // line, dated by the Philippine day it arrived; peso values only for people who
  // may see prices. Supplier / search / grouping are applied here, on what came
  // back, so the screen and the PDF always show the same rows and totals.
  // =====================================================================

  const pi = { rows:[], money:false, mode:'month', view:'item', supplier:'', q:'', from:'', to:'', loaded:false, loading:false, seq:0 };
  const PI_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  const piPad = (n)=> String(n).padStart(2, '0');
  const piLastDay = (y, m)=> new Date(Date.UTC(y, m, 0)).getUTCDate();   // m is 1-12
  function piMonthRange(ym){
    const [y, m] = String(ym).split('-').map(Number);
    return { from: y + '-' + piPad(m) + '-01', to: y + '-' + piPad(m) + '-' + piPad(piLastDay(y, m)) };
  }
  function piDateLabel(iso){
    const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
    return d + ' ' + PI_MONTHS[m - 1].slice(0, 3) + ' ' + y;
  }
  function piCoverageLabel(){
    if(pi.mode === 'month'){ const [y, m] = pi.from.split('-').map(Number); return PI_MONTHS[m - 1] + ' ' + y; }
    return pi.from === pi.to ? piDateLabel(pi.from) : piDateLabel(pi.from) + ' to ' + piDateLabel(pi.to);
  }
  const piMoney = (n)=> n == null || n === '' ? '\u2014' : '\u20B1' + Number(n).toLocaleString('en-PH', { minimumFractionDigits:2, maximumFractionDigits:2 });
  const piQty = (n)=> Number(n || 0).toLocaleString('en-PH', { maximumFractionDigits:3 });

  // ---------- coverage controls ----------
  function piSetMode(mode){
    pi.mode = mode;
    $('piModeMonth').classList.toggle('active', mode === 'month');
    $('piModeRange').classList.toggle('active', mode === 'range');
    $('piMonthWrap').style.display = mode === 'month' ? '' : 'none';
    $('piRangeWrap').style.display = mode === 'range' ? '' : 'none';
    if(mode === 'month'){
      const r = piMonthRange($('piMonth').value || poToday().slice(0, 7));
      pi.from = r.from; pi.to = r.to;
    }else{
      pi.from = $('piFrom').value || pi.from; pi.to = $('piTo').value || pi.to;
    }
  }
  function piApplyRangeFields(from, to){
    $('piFrom').value = from; $('piTo').value = to; pi.from = from; pi.to = to;
  }
  function piShiftMonth(delta){
    const [y, m] = ($('piMonth').value || poToday().slice(0, 7)).split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 1 + delta, 1));
    $('piMonth').value = d.getUTCFullYear() + '-' + piPad(d.getUTCMonth() + 1);
    piSetMode('month'); piLoad();
  }
  function piPreset(kind){
    const today = poToday(), y = Number(today.slice(0, 4)), m = Number(today.slice(5, 7));
    if(kind === 'this'){ $('piMonth').value = today.slice(0, 7); piSetMode('month'); }
    else if(kind === 'last'){ const d = new Date(Date.UTC(y, m - 2, 1)); $('piMonth').value = d.getUTCFullYear() + '-' + piPad(d.getUTCMonth() + 1); piSetMode('month'); }
    else if(kind === 'year'){ piApplyRangeFields(y + '-01-01', today); piSetMode('range'); }
    piLoad();
  }

  // ---------- load ----------
  async function piShow(){
    if(!pi.loaded){
      $('piMonth').value = poToday().slice(0, 7);
      piSetMode('month');
    }
    await piLoad();
  }
  async function piLoad(){
    const box = $('piBody');
    if(pi.mode === 'range'){ pi.from = $('piFrom').value; pi.to = $('piTo').value; }
    if(!pi.from || !pi.to){ box.innerHTML = '<div class="empty-state">Choose the dates to cover.</div>'; return; }
    if(pi.to < pi.from){ box.innerHTML = '<div class="empty-state">The end date is before the start date.</div>'; return; }
    const seq = ++pi.seq;
    pi.loading = true;
    box.innerHTML = '<div class="empty-state">Loading\u2026</div>';
    $('piCoverage').textContent = piCoverageLabel();
    if(!(await ensureCloud())){ box.innerHTML = '<div class="empty-state">Not connected \u2014 this page needs a connection.</div>'; pi.loading = false; return; }
    try{
      const { data, error } = await db.rpc('purchased_items_report', { p_from: pi.from, p_to: pi.to });
      if(seq !== pi.seq) return;   // a newer request owns the screen
      if(error) throw error;
      pi.rows = (data && data.rows) || [];
      pi.money = !!(data && data.money);
      pi.loaded = true;
      piFillSuppliers();
      piRender();
    }catch(e){
      if(seq !== pi.seq) return;
      console.error('purchased items failed', describeCloudError(e));
      const msg = (typeof purchIsAuthError === 'function' && purchIsAuthError(e)) ? PURCH_EXPIRED_HTML
        : /purchased_items_report|PGRST202|42883/.test(describeCloudError(e)) ? 'This page needs migration 20261020_01_purchased_items.sql to be run in Supabase (it is inside RUN_THIS_IN_SUPABASE.sql) first.'
        : /access/i.test(describeCloudError(e)) ? 'You don\u2019t have access to Purchased Items.'
        : 'Couldn\u2019t load purchased items: ' + escapeHtml(describeCloudError(e));
      box.innerHTML = '<div class="empty-state">' + msg + '</div>';
    }finally{ if(seq === pi.seq) pi.loading = false; }
  }

  // ---------- filtering and totals ----------
  function piFillSuppliers(){
    const names = Array.from(new Set(pi.rows.map(r=> r.supplier))).sort((a, b)=> a.localeCompare(b));
    const keep = names.includes(pi.supplier) ? pi.supplier : '';
    pi.supplier = keep;
    $('piSupplier').innerHTML = '<option value="">All suppliers</option>' + names.map(n=> '<option value="' + escapeHtml(n) + '">' + escapeHtml(n) + '</option>').join('');
    $('piSupplier').value = keep;
  }
  function piFiltered(){
    const q = pi.q.trim().toLowerCase();
    return pi.rows.filter(r=>{
      if(pi.supplier && r.supplier !== pi.supplier) return false;
      if(!q) return true;
      return [r.description, r.code, r.po_no, r.receipt_no, r.supplier, r.reference].filter(Boolean).join(' ').toLowerCase().includes(q);
    });
  }
  // One row per item (and unit) with its totals
  function piGroup(rows){
    const map = new Map();
    rows.forEach(r=>{
      const key = (r.material_id || (String(r.code || '').toLowerCase() + '|' + String(r.description || '').toLowerCase())) + '|' + String(r.unit || '').toLowerCase();
      let g = map.get(key);
      if(!g){ g = { code: r.code || '', description: r.description, unit: r.unit || '', qty:0, amount:0, docs:new Set(), suppliers:new Set(), hasAmount:false }; map.set(key, g); }
      g.qty += Number(r.qty || 0);
      if(r.amount != null){ g.amount += Number(r.amount); g.hasAmount = true; }
      g.docs.add(piDoc(r)); g.suppliers.add(r.supplier);
    });
    return Array.from(map.values()).sort((a, b)=> a.description.localeCompare(b.description));
  }
  const piDoc = (r)=> r.receipt_no || r.doc_no || r.po_no || '';
  function piTotals(rows){
    const amount = rows.reduce((a, r)=> a + (r.amount != null ? Number(r.amount) : 0), 0);
    return { lines: rows.length, items: piGroup(rows).length, deliveries: new Set(rows.map(piDoc)).size, amount };
  }

  // ---------- render ----------
  function piRender(){
    const rows = piFiltered(), t = piTotals(rows);
    $('piCoverage').textContent = piCoverageLabel();
    $('piSummary').innerHTML =
      '<div class="pi-stat"><span>Items</span><b>' + t.items.toLocaleString('en-PH') + '</b></div>' +
      '<div class="pi-stat"><span>Lines received</span><b>' + t.lines.toLocaleString('en-PH') + '</b></div>' +
      '<div class="pi-stat"><span>Deliveries</span><b>' + t.deliveries.toLocaleString('en-PH') + '</b></div>' +
      (pi.money ? '<div class="pi-stat total"><span>Total amount</span><b>' + piMoney(t.amount) + '</b></div>' : '');
    $('piViewItem').classList.toggle('active', pi.view === 'item');
    $('piViewLine').classList.toggle('active', pi.view === 'line');
    $('piPdf').disabled = !rows.length;
    const box = $('piBody');
    if(!rows.length){
      box.innerHTML = '<div class="empty-state">' + (pi.rows.length ? 'Nothing matches those filters.' : 'Nothing was received in ' + escapeHtml(piCoverageLabel()) + '.') + '</div>';
      return;
    }
    let head, body, foot;
    if(pi.view === 'item'){
      head = ['Item', 'Unit', 'Qty received', 'Deliveries'].concat(pi.money ? ['Amount'] : []);
      body = piGroup(rows).map(g=> '<tr><td><b>' + escapeHtml(g.description) + '</b>' + (g.code ? '<div class="sp-row-sub">' + escapeHtml(g.code) + '</div>' : '') +
        (g.suppliers.size ? '<div class="sp-row-sub">' + escapeHtml(Array.from(g.suppliers).join(', ')) + '</div>' : '') + '</td><td>' + escapeHtml(g.unit) + '</td><td class="num">' + piQty(g.qty) + '</td><td class="num">' + g.docs.size + '</td>' +
        (pi.money ? '<td class="num">' + (g.hasAmount ? piMoney(g.amount) : '\u2014') + '</td>' : '') + '</tr>').join('');
      foot = '<tr class="pi-total"><td colspan="3">Total</td><td class="num">' + t.deliveries + '</td>' + (pi.money ? '<td class="num">' + piMoney(t.amount) + '</td>' : '') + '</tr>';
    }else{
      head = ['Date received', 'Receipt', 'PO no.', 'Supplier', 'Item', 'Qty', 'Unit'].concat(pi.money ? ['Unit price'] : []).concat(['Received at']).concat(pi.money ? ['Amount'] : []);
      body = rows.map(r=> '<tr><td>' + escapeHtml(piDateLabel(r.received_on)) + '</td><td>' + escapeHtml(r.receipt_no || r.doc_no || '') + '</td><td>' + escapeHtml(r.po_no || '') + '</td><td>' + escapeHtml(r.supplier) + '</td><td><b>' + escapeHtml(r.description) + '</b>' + (r.code ? '<div class="sp-row-sub">' + escapeHtml(r.code) + '</div>' : '') + '</td>' +
        '<td class="num">' + piQty(r.qty) + '</td><td>' + escapeHtml(r.unit || '') + '</td>' + (pi.money ? '<td class="num">' + piMoney(r.unit_price) + '</td>' : '') +
        '<td>' + escapeHtml(r.where || '') + '</td>' + (pi.money ? '<td class="num">' + piMoney(r.amount) + '</td>' : '') + '</tr>').join('');
      foot = '<tr class="pi-total"><td colspan="' + (pi.money ? 10 : 8) + '">Total</td>' + (pi.money ? '<td class="num">' + piMoney(t.amount) + '</td>' : '<td></td>') + '</tr>';
    }
    box.innerHTML = '<div class="pi-scroll"><table class="pi-table"><thead><tr>' + head.map((h, i)=> '<th' + (/^(Qty|Qty received|Deliveries|Unit price|Amount)$/.test(h) ? ' class="num"' : '') + '>' + h + '</th>').join('') + '</tr></thead><tbody>' + body + '</tbody><tfoot>' + foot + '</tfoot></table></div>' +
      '<p class="pi-note">' + 'Counted on the day the goods were received. ' + (pi.money ? 'Amounts are quantity received \u00D7 the PO unit price, before the purchase order\u2019s discount and VAT. ' : 'Quantities only \u2014 you can\u2019t see prices. ') +
      'Includes goods received into a warehouse, goods a worker received on site, and items a worker bought. Goods received with no purchase order are not included.</p>';
  }

  // ---------- events ----------
  // Bound only if this page's markup is in index.html — a missing element must never stop the app starting.
  function piBind(){
  $('piModeMonth').addEventListener('click', ()=>{ piSetMode('month'); piLoad(); });
  $('piModeRange').addEventListener('click', ()=>{
    if(!$('piFrom').value){ piApplyRangeFields(pi.from, pi.to); }
    piSetMode('range'); piLoad();
  });
  $('piPrev').addEventListener('click', ()=> piShiftMonth(-1));
  $('piNext').addEventListener('click', ()=> piShiftMonth(1));
  $('piMonth').addEventListener('change', ()=>{ piSetMode('month'); piLoad(); });
  $('piFrom').addEventListener('change', ()=>{ pi.from = $('piFrom').value; piLoad(); });
  $('piTo').addEventListener('change', ()=>{ pi.to = $('piTo').value; piLoad(); });
  $('piPresets').addEventListener('click', (e)=>{ const b = e.target.closest('[data-preset]'); if(b) piPreset(b.dataset.preset); });
  $('piSupplier').addEventListener('change', ()=>{ pi.supplier = $('piSupplier').value; piRender(); });
  $('piSearch').addEventListener('input', ()=>{ pi.q = $('piSearch').value; piRender(); });
  $('piViewItem').addEventListener('click', ()=>{ pi.view = 'item'; piRender(); });
  $('piViewLine').addEventListener('click', ()=>{ pi.view = 'line'; piRender(); });
  }
  if(document.getElementById('piModeMonth')) piBind();

  // ---------- PDF ----------
  $('piPdf').addEventListener('click', ()=> piExportPdf());
  async function piExportPdf(){
    const rows = piFiltered();
    if(!rows.length){ toast('Nothing to print'); return; }
    try{
      await loadAwesScript('jspdf', awesLibs.jspdf); await loadAwesScript('autotable', awesLibs.autotable);
      await poLoadSettings().catch(()=>{});
      const co = poSettingsData || {}, style = co.header_style || 'green';
      const logo = co.logo_path ? await poLoadImage(co.logo_path).then(img=> poLogoForStyle(img, style)) : await poDefaultLogo(style);
      const fonts = await poLoadFonts();
      const { jsPDF } = window.jspdf;
      const doc = new jsPDF({ orientation:'l', unit:'pt', format:'a4', compress:true });
      let F = 'helvetica', FB = ['helvetica', 'bold'];
      if(fonts){ try{
        doc.addFileToVFS('Inter-Regular.ttf', fonts.regular); doc.addFont('Inter-Regular.ttf', 'Inter', 'normal');
        doc.addFileToVFS('Inter-Bold.ttf', fonts.bold); doc.addFont('Inter-Bold.ttf', 'InterBold', 'normal');
        F = 'Inter'; FB = ['InterBold', 'normal'];
      }catch(e){} }
      const peso = F === 'Inter' ? '\u20B1' : 'PHP ';
      const money = (n)=> n == null ? '' : peso + Number(n).toLocaleString('en-PH', { minimumFractionDigits:2, maximumFractionDigits:2 });
      const W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight(), M = 30;
      const G = [21, 77, 52], SUB = [96, 108, 101], INK = [28, 34, 30], LINE = [216, 223, 219];
      const green = style !== 'white', t = piTotals(rows), cover = piCoverageLabel();
      const header = ()=>{
        if(green){ doc.setFillColor(...G); doc.rect(0, 0, W, 64, 'F'); } else { doc.setFillColor(...G); doc.rect(0, 61, W, 3, 'F'); }
        if(logo && logo.w){ const r = Math.min(110 / logo.w, 32 / logo.h); try{ doc.addImage(logo.dataUrl, 'PNG', M, 16, logo.w * r, logo.h * r, 'pi-logo', 'FAST'); }catch(e){} }
        doc.setTextColor(...(green ? [255, 255, 255] : G));
        doc.setFont(FB[0], FB[1]); doc.setFontSize(15); doc.text('PURCHASED ITEMS', W - M, 30, { align:'right' });
        doc.setFont(F, 'normal'); doc.setFontSize(8.5); doc.text('Received ' + cover + '   \u2022   ' + (co.company_name || ''), W - M, 46, { align:'right' });
      };
      header();
      let y = 82;
      doc.setFont(F, 'normal'); doc.setFontSize(8.5); doc.setTextColor(...INK);
      const sum = ['Items: ' + t.items, 'Lines received: ' + t.lines, 'Deliveries: ' + t.deliveries].concat(pi.money ? ['Total: ' + money(t.amount)] : []);
      doc.text(sum.join('     '), M, y); y += 12;
      const filt = [pi.supplier ? 'Supplier: ' + pi.supplier : '', pi.q.trim() ? 'Search: ' + pi.q.trim() : '', pi.view === 'item' ? 'Totals per item' : 'Every line'].filter(Boolean).join('   \u2022   ');
      doc.setFontSize(7.5); doc.setTextColor(...SUB); doc.text(filt, M, y); y += 8;
      const num = (list)=> Object.fromEntries(list.map(i=> [i, { halign:'right' }]));
      let head, body, foot, colStyles;
      if(pi.view === 'item'){
        const g = piGroup(rows);
        head = ['Item', 'Code', 'Suppliers', 'Unit', 'Qty received', 'Deliveries'].concat(pi.money ? ['Amount'] : []);
        body = g.map(x=> [x.description, x.code, Array.from(x.suppliers).join(', '), x.unit, piQty(x.qty), String(x.docs.size)].concat(pi.money ? [x.hasAmount ? money(x.amount) : ''] : []));
        foot = [{ content:'Total', colSpan:5, styles:{ fontStyle:'bold' } }, { content:String(t.deliveries), styles:{ halign:'right', fontStyle:'bold' } }].concat(pi.money ? [{ content: money(t.amount), styles:{ halign:'right', fontStyle:'bold' } }] : []);
        colStyles = Object.assign({ 3:{ cellWidth:44 } }, num(pi.money ? [4, 5, 6] : [4, 5]));
      }else{
        head = ['Date received', 'Receipt', 'PO no.', 'Supplier', 'Item', 'Qty', 'Unit'].concat(pi.money ? ['Unit price'] : []).concat(['Received at']).concat(pi.money ? ['Amount'] : []);
        body = rows.map(r=> [piDateLabel(r.received_on), r.receipt_no || r.doc_no || '', r.po_no || '', r.supplier, r.description + (r.code ? '  (' + r.code + ')' : ''), piQty(r.qty), r.unit || ''].concat(pi.money ? [money(r.unit_price)] : []).concat([r.where || '']).concat(pi.money ? [money(r.amount)] : []));
        foot = [{ content:'Total', colSpan: pi.money ? 10 : 8, styles:{ fontStyle:'bold' } }].concat(pi.money ? [{ content: money(t.amount), styles:{ halign:'right', fontStyle:'bold' } }] : [{ content:'' }]);
        colStyles = Object.assign({ 0:{ cellWidth:58 }, 1:{ cellWidth:66 }, 2:{ cellWidth:66 }, 6:{ cellWidth:38 } }, num(pi.money ? [5, 7, 9] : [5]));
      }
      doc.autoTable({
        startY: y + 4, margin:{ left:M, right:M, top:78, bottom:36 }, head:[head], body, foot:[foot], showFoot:'lastPage',
        theme:'plain',
        styles:{ font:F, fontSize:8, cellPadding:{ top:3.5, bottom:3.5, left:4, right:4 }, textColor:INK, lineColor:LINE, lineWidth:{ bottom:0.4 } },
        headStyles:{ font:F, fontStyle:'bold', fillColor:G, textColor:255, fontSize:7.2 },
        footStyles:{ font:F, fillColor:[233, 243, 237], textColor:G, fontSize:8.2 },
        alternateRowStyles:{ fillColor:[247, 250, 248] },
        columnStyles: colStyles,
        didParseCell: (c)=>{ if(c.section === 'head' && colStyles[c.column.index] && colStyles[c.column.index].halign === 'right') c.cell.styles.halign = 'right'; },
        didDrawPage: ()=>{ header(); }
      });
      const pages = doc.internal.getNumberOfPages();
      for(let p = 1; p <= pages; p++){
        doc.setPage(p); doc.setFont(F, 'normal'); doc.setFontSize(7); doc.setTextColor(...SUB);
        doc.text('Generated ' + new Date().toLocaleString('en-PH') + (pi.money ? '' : ' \u00B7 quantities only') + ' \u00B7 by date received', M, H - 16);
        doc.text('Page ' + p + ' of ' + pages, W - M, H - 16, { align:'right' });
      }
      const title = 'Purchased Items';
      $('previewOverlay').querySelector('h3').textContent = title;
      $('previewOkBtn').textContent = 'Close';
      $('previewOverlay').style.zIndex = '99';
      $('previewOverlay').classList.add('open');
      await renderPdfPreview(doc, 'Purchased-Items-' + pi.from + '-to-' + pi.to + '.pdf', title);
    }catch(e){ console.error('purchased items pdf failed', e); toast('Couldn\u2019t build the PDF: ' + (e && e.message ? e.message : e)); }
  }
