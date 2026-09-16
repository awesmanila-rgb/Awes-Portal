// ---------- meta bar live update ----------
  $('svcDate').addEventListener('change', ()=> $('metaDate').textContent = fmtDate($('svcDate').value));

  // ---------- init defaults ----------
  // Which dispatch ticket + equipment line item (if any) the report
  // currently being filed is tied to — set by srApplyJobOrder (dispatch.js)
  // when a technician picks a piece of equipment off a Job Order, read by
  // the save handler in pdf.js to mark that item "reported" once the report
  // goes through. Declared here because resetForm() below runs once at load
  // time, before dispatch.js's own module code has executed.
  let srCurrentTicketId = null;
  let srCurrentEquipId = null;
  // Set instead of srCurrentEquipId when a technician has picked MULTIPLE
  // equipment items off one Job Order to batch-sign — see
  // srApplyJobOrderBatch() (dispatch.js) and the submit loop in pdf.js.
  // Each entry is one equipment item off the ticket's equipmentList.
  let srBatchEquipItems = null;

  // Progressive-section state. Declared HERE, at the top of the module,
  // rather than beside the functions that use it further down: resetForm()
  // is called at load and assigns srMaxSection, so a `let` declared after
  // that call site leaves it in the temporal dead zone — which threw
  // "Cannot access 'srMaxSection' before initialization" and took the
  // whole bundle (and therefore the whole page) down with it.
  // The wizard's steps. Section 1 (Customer's Information) is deliberately
  // NOT a step — it comes from the Job Order and the technician cannot edit
  // it, so it is filled silently and never shown. Sections 8-10 are the
  // split of what used to be one "Acknowledgment" card, so Time & Remarks,
  // the technician's signature and the customer's signature each get their
  // own screen.
  const SR_SECTION_TITLES = {
    1:"Customer's Information", 2:'Equipment Details', 3:'Report Summary',
    4:'Components / Parts Needed', 5:'Works Done to this unit', 6:'Operation Parameters',
    7:'Installation Parameters', 8:'Time & Remarks', 9:'Technician Signature',
    10:'Customer Acknowledgment'
  };
  const SR_FIRST_SECTION = 2;   // the wizard always starts at Equipment Details
  const SR_LAST_SECTION = 10;
  let srMaxSection = 1;
  // The ONE section currently on screen (srRevealSections hides the rest).
  // srMaxSection is still the furthest reached — it's what the chip
  // navigator and the progress bar are built from.
  let srCurrentSection = 1;
  function resetForm(){
    // Scoped to the Service Report view only. This used to select every text,
    // number, textarea and checkbox on the page, so starting a new report also
    // wiped whatever the user had typed into the Dispatch, Leave, Cash Advance,
    // Customers and Admin forms — all of which live in the same document.
    const scope = $('serviceReportView') || document;
    scope.querySelectorAll('input[type=text], input[type=number], textarea').forEach(el=>el.value='');
    scope.querySelectorAll('input[type=checkbox]').forEach(el=>{ el.checked=false; el.closest('.chk')?.classList.remove('checked'); });
    $('svcDate').value = todayISO();
    $('timeIn').value=''; $('timeOut').value='';
    $('findingsList').innerHTML=''; $('recsList').innerHTML=''; $('servicesDoneList').innerHTML='';
    addListRow('findingsList'); addListRow('recsList'); addListRow('servicesDoneList');
    $('materialsBody').innerHTML=''; materialRowCount=0;
    $('isInstallToggle').checked=false; $('installSection').classList.remove('open');
    loadCustomerEquipment(null);
    clearEquipPickedId();
    setEquipTab(null);
    $('custDetailsWrap').style.display = 'none';
    // Technicians must pick an authorized Job Order before Customer's Info
    // (and everything after it) appears — admin has no Job Order gate and
    // always sees it directly. srRenderJobOrderPicker/srApplyJobOrder
    // re-confirm this on their own paths too; this just sets the sane
    // default whenever the form is reset from anywhere else.
    const sec1 = $('sec1Card');
    if(sec1) sec1.style.display = (currentUser && currentUser.role==='admin') ? '' : 'none';
    ['sec2Card','sec3Card','sec4Card','sec5Card','sec6Card','sec7Card','sec8Card'].forEach(id=>{
      const el = $(id); if(el) el.style.display = 'none';
    });
    $('materialsTableWrap').style.display = 'none';
    collapseAllSections();
    toggleCollapsibleSection($('sec1Head'), true); // keep section 1 (Customer's Info) open — it's the entry point
    if($('srJobOrderHead')) toggleCollapsibleSection($('srJobOrderHead'), true); // keep the Job Order picker open too
    if(sigCustomerPad) sigCustomerPad.clear();
    if(sigTechPad) sigTechPad.clear();
    unlockSignature('sigCustomer'); unlockSignature('sigTech');
    $('sigCustomerPh').style.display='flex'; $('sigTechPh').style.display='flex';
    $('metaDate').textContent = fmtDate($('svcDate').value);
    $('statusPill').textContent='Draft'; $('statusPill').className='status-pill status-draft';
    currentSrNo = null;
    currentTechnicianId = null;
    srCurrentTicketId = null;
    srCurrentEquipId = null;
    srBatchEquipItems = null;
    if($('srBatchBanner')) $('srBatchBanner').style.display = 'none';
    $('metaSrNo').textContent='—';
    clearInvalid();
    applyTechNameDefault();
    srMaxSection = 1;
    srCurrentSection = 1;
    srUpdateFooterBar();
    srRenderStepper();
  }
  resetForm();
  // ---------- progressive sections ----------
  // The report has 8 sections. They used to all appear at once the moment a
  // customer was set, which is a wall of fields on a phone in the field.
  // Now each one reveals as the previous is finished, via a Continue button
  // appended to every section body. Sections already revealed STAY
  // revealed, so going back to change something never means re-walking the
  // form. The step tracker above stays visible throughout either way.
  // Section 2 is filled automatically per unit in batch mode (see
  // srBatchBanner), so it's skipped rather than shown empty.
  function srSectionIsSkipped(n){
    if(n===1) return true; // customer info: inherited from the Job Order, never shown
    // Installation Parameters is behind a toggle — off means the unit wasn't
    // newly installed on this visit, so the step is skipped entirely.
    if(n===7){ const t = $('installToggle'); return !(t && t.checked); }
    return false;
  }
  function srNextSection(n){
    let next = n+1;
    while(next<=SR_LAST_SECTION && srSectionIsSkipped(next)) next++;
    return next;
  }
  function srPrevSection(n){
    let prev = n-1;
    while(prev>=SR_FIRST_SECTION && srSectionIsSkipped(prev)) prev--;
    return prev < SR_FIRST_SECTION ? SR_FIRST_SECTION : prev;
  }
  // Only sections with genuinely required fields block progress. Everything
  // else continues freely — gating optional sections would turn progressive
  // disclosure into an obstacle rather than a simplification.
  function srSectionBlocker(n){
    if(n===1){
      if(!$('custName').value.trim()) return 'Enter the customer name to continue';
      if(!$('svcDate').value) return 'Set the service date to continue';
      const email = $('custEmail').value.trim();
      if(!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return 'A valid customer email is required — the report is sent there';
      return null;
    }
    return null;
  }
  // The footer (Save Draft / Generate & Share Report) belongs to the END of
  // the form. It used to show for the entire "Create New" tab, which was
  // right when every section was visible at once — but with progressive
  // sections it meant offering "Generate & Share Report" while the
  // technician was still on Customer's Information. It now appears only
  // once the last section (Acknowledgment, where the signatures are) has
  // been reached, and stays visible after that so they can still scroll up
  // to edit and come back.
  function srUpdateFooterBar(){
    const bar = $('footerBar');
    if(!bar) return;
    const newPanel = $('srNewPanel');
    const onNewTab = newPanel && newPanel.style.display !== 'none';
    bar.style.display = (onNewTab && srCurrentSection >= SR_LAST_SECTION) ? 'flex' : 'none';
  }
  // A section counts as already handled when the Job Order prefill has
  // filled everything it asks for (srApplyJobOrder populates customer
  // details, the equipment fields, and the trouble call). There's nothing
  // to do on those, so the form opens past them instead of making the
  // technician page through screens of data they didn't type and can't
  // usefully change.
  function srSectionPrefilled(n){
    if(n===1){
      return !!$('custName').value.trim() && !!$('svcDate').value && !!$('custEmail').value.trim();
    }
    if(n===2){
      return srSectionIsSkipped(2)
        || !!($('equipType').value.trim() || $('modelCU').value.trim() || $('modelFCU').value.trim());
    }
    // Section 3 is deliberately NEVER treated as prefilled. The Job Order
    // supplies its trouble call, but Findings and Recommendations — the
    // substance of the report — start empty, and skipping past it would
    // take a technician to the signatures without ever asking for them.
    return false; // 3-8 always need real input
  }
  // First section that actually needs attention.
  function srFirstUnfilledSection(){
    for(let n=1; n<=SR_LAST_SECTION; n++){
      if(srSectionIsSkipped(n)) continue;
      if(!srSectionPrefilled(n)) return n;
    }
    return SR_LAST_SECTION;
  }

  // Only the CURRENT section is on screen. Showing every unlocked section
  // at once rebuilt the same wall of fields progressive disclosure exists
  // to avoid — by the last section the page was all eight again. Earlier
  // sections stay reachable through the chip navigator (srRenderSectionNav)
  // rather than by scrolling past them.
  function srRevealSections(){
    for(let n=1; n<=SR_LAST_SECTION; n++){
      const card = $('sec'+n+'Card');
      if(!card) continue;
      if(n===1 && currentUser && currentUser.role!=='admin' && !srCurrentTicketId){
        card.style.display = 'none'; // no Job Order picked yet
        continue;
      }
      card.style.display = (n===srCurrentSection && !srSectionIsSkipped(n)) ? '' : 'none';
    }
    srRenderSectionNav();
    srUpdateFooterBar();
    srRenderStepper();
  }

  // Chips for every section reached so far, so going back to fix something
  // is one tap instead of a scroll through hidden cards.
  function srRenderSectionNav(){
    const host = $('srSectionNav');
    if(!host) return;
    if(srMaxSection<=1 && srCurrentSection<=1){ host.innerHTML = ''; host.style.display='none'; return; }
    host.style.display = '';
    let html = '';
    for(let n=1; n<=SR_LAST_SECTION; n++){
      if(srSectionIsSkipped(n)) continue;
      if(n>srMaxSection) continue;
      const cls = n===srCurrentSection ? 'sr-nav-chip active' : 'sr-nav-chip';
      html += '<button type="button" class="'+cls+'" data-sr-nav="'+n+'">'+n+'</button>';
    }
    host.innerHTML = '<span class="sr-nav-label">Section</span>'+html;
  }
  function srGoToSection(n){
    if(n>SR_LAST_SECTION) n = SR_LAST_SECTION;
    if(n<1) n = 1;
    srCurrentSection = n;
    srMaxSection = Math.max(srMaxSection, n);
    srRevealSections();
    const head = $('sec'+n+'Head');
    if(head) toggleCollapsibleSection(head, true);
    window.scrollTo({top:0, behavior:'smooth'});
  }
  // Appended once at startup — putting these in the markup would mean
  // eight near-identical blocks kept in sync by hand.
  function srInstallContinueButtons(){
    for(let n=SR_FIRST_SECTION; n<=SR_LAST_SECTION; n++){
      const body = $('sec'+n+'Body');
      if(!body || body.querySelector('.sr-step-nav')) continue;
      const wrap = document.createElement('div');
      wrap.className = 'sr-continue-wrap sr-step-nav';
      // Back on every step except the first; Next on every step except the
      // last (where the footer's Generate/Save buttons take over).
      const backBtn = n>SR_FIRST_SECTION
        ? '<button type="button" class="btn btn-secondary sr-back-btn" data-sr-back="'+n+'">\u2190 Back</button>'
        : '';
      const nextBtn = n<SR_LAST_SECTION
        ? '<button type="button" class="btn btn-primary sr-continue-btn" data-sr-section="'+n+'">Next \u2192</button>'
        : '';
      wrap.innerHTML = backBtn + nextBtn;
      body.appendChild(wrap);
    }
    document.addEventListener('click', (e)=>{
      const back = e.target.closest('.sr-back-btn');
      if(!back) return;
      srGoToSection(srPrevSection(parseInt(back.getAttribute('data-sr-back'), 10)));
    });
    // Chip navigator — delegated, since the chips are re-rendered on every
    // section change.
    document.addEventListener('click', (e)=>{
      const chip = e.target.closest('[data-sr-nav]');
      if(!chip) return;
      srGoToSection(parseInt(chip.getAttribute('data-sr-nav'), 10));
    });
    document.addEventListener('click', (e)=>{
      const btn = e.target.closest('.sr-continue-btn');
      if(!btn) return;
      const n = parseInt(btn.getAttribute('data-sr-section'), 10);
      const blocker = srSectionBlocker(n);
      if(blocker){ toast(blocker); return; }
      const head = $('sec'+n+'Head');
      if(head) toggleCollapsibleSection(head, false); // collapse the one just finished
      srGoToSection(srNextSection(n));
    });
  }
  // Continue labels shift when batch mode skips section 2, so refresh them
  // whenever that mode changes.
  // Kept as a no-op: the step buttons now read plainly "Back" / "Next", so
  // there are no per-section labels to keep in sync. Still called from
  // dispatch.js when batch mode toggles.
  function srRefreshContinueLabels(){ srRenderSectionNav(); }

  function srSetAllSectionsRevealed(){
    srMaxSection = SR_LAST_SECTION;
    srCurrentSection = SR_LAST_SECTION;
    srUpdateFooterBar();
    srRenderStepper();
  }

  // Installation toggle reveals its own fields and re-evaluates whether
  // step 7 exists at all (srSectionIsSkipped reads this checkbox).
  (function(){
    const t = $('installToggle');
    if(!t) return;
    t.addEventListener('change', ()=>{
      const wrap = $('installFieldsWrap');
      if(wrap) wrap.style.display = t.checked ? '' : 'none';
      srRenderSectionNav();
    });
  })();
  // =====================================================================
  // Wizard entry flow: instruction gate -> Create New / Saved Draft ->
  // job order -> Single / Multiple -> unit -> the step form.
  // Each screen is a card; srShowEntry() shows exactly one of them (or
  // none, once the form itself is running).
  // =====================================================================
  // Session-scoped on purpose: shown once per sign-in, not on every tap.
  // Someone filing six reports in a day should read it once.
  let srGateSeenThisSession = false;
  const SR_ENTRY_SCREENS = ['srEntryGate','srEntryChoice','srEntryMode'];
  function srShowEntry(which){
    SR_ENTRY_SCREENS.forEach(id=>{ const el = $(id); if(el) el.style.display = (id===which) ? '' : 'none'; });
    const showingEntry = !!which;
    // While an entry screen is up, the form, its stepper, chips and footer
    // all stay out of the way.
    ['srStepperContainer','srSectionNav'].forEach(id=>{ const el=$(id); if(el) el.style.display = showingEntry ? 'none' : ''; });
    for(let n=1; n<=SR_LAST_SECTION; n++){ const c=$('sec'+n+'Card'); if(c && showingEntry) c.style.display='none'; }
    if(showingEntry && $('footerBar')) $('footerBar').style.display = 'none';
    // The old always-on instructions card is redundant now that the gate
    // shows the same content up front.
    if($('srInstructionsCard')) $('srInstructionsCard').style.display = 'none';
    if(!showingEntry) srRevealSections();
  }
  // Entry point from the Report tab / bottom nav.
  function srStartReportFlow(){
    if(!srGateSeenThisSession){
      const body = $('srEntryGateBody');
      const howto = $('srInstructionsBody');
      if(body){
        body.innerHTML = (howto ? howto.innerHTML : '<p>Fill each step and tap Next. You will sign at the end.</p>')
          + '<button type="button" class="btn btn-primary" id="srGateOkBtn" style="width:100%; margin-top:14px;">I Understand</button>';
        const ok = body.querySelector('#srGateOkBtn');
        if(ok) ok.onclick = ()=>{ srGateSeenThisSession = true; srShowEntry('srEntryChoice'); };
      }
      srShowEntry('srEntryGate');
      return;
    }
    srShowEntry('srEntryChoice');
  }
  if($('srTileCreateNew')) $('srTileCreateNew').addEventListener('click', ()=>{
    srShowEntry(null);
    // The Job Order picker already exists and is titled "Select from Job
    // Order" — reuse it rather than building a second list.
    if(typeof srRenderJobOrderPicker === 'function') srRenderJobOrderPicker();
  });
  if($('srTileSavedDraft')) $('srTileSavedDraft').addEventListener('click', ()=>{
    srShowEntry(null);
    if(typeof showServiceReportTab === 'function') showServiceReportTab('drafts');
  });
  if($('srEntryModeBack')) $('srEntryModeBack').addEventListener('click', ()=> srShowEntry('srEntryChoice'));

  srInstallContinueButtons();

  // ---------- progressive step tracker ----------
  // Same jo-stepper visual language as the Job Order / Cash Advance
  // trackers. Re-rendered at every state change below rather than on every
  // keystroke — resetForm, applying a Job Order (single or batch), signing,
  // and submitting all call this directly.
  function srRenderStepper(){
    const container = $('srStepperContainer');
    if(!container) return;
    const isAdmin = currentUser && currentUser.role==='admin';
    const step1Done = isAdmin || !!srCurrentTicketId;
    const step2Done = step1Done && !!$('custName').value.trim() && !!$('svcDate').value;
    const custSigned = !!(sigCustomerPad && !sigCustomerPad.isEmpty());
    const techSigned = !!(sigTechPad && !sigTechPad.isEmpty());
    const step3Done = step2Done && custSigned && techSigned;
    const step4Done = step3Done && $('statusPill').textContent==='Completed';
    let stage = 0;
    if(step1Done) stage = 1;
    if(step2Done) stage = 2;
    if(step3Done) stage = 3;
    if(step4Done) stage = 4;
    const isBatch = srBatchEquipItems && srBatchEquipItems.length > 1;
    const labels = isBatch
      ? ['Job Order Selected','Details Filled','Signed Once','All Reports Submitted']
      : ['Job Order Selected','Details Filled','Signed','Submitted'];
    const stepsHtml = labels.map((label,i)=>{
      const state = i<stage ? 'done' : (i===stage ? 'current' : 'upcoming');
      return '<div class="jo-step '+state+'">'+
          '<span class="jo-step-line"></span>'+
          '<span class="jo-step-dot">'+(i<stage ? '\u2713' : (i+1))+'</span>'+
          '<span class="jo-step-label">'+label+'</span>'+
        '</div>';
    }).join('');
    let nextText;
    if(step4Done) nextText = isBatch ? 'All reports for this batch were generated.' : 'Report submitted.';
    else if(step3Done) nextText = 'Tap "Generate & Share Report" below to submit'+(isBatch ? ' every report in this batch.' : '.');
    else if(step2Done) nextText = 'Sign in Section 8 to continue (both customer and technician).';
    else if(step1Done) nextText = "Fill in Customer's Information and the sections below.";
    else nextText = 'Select a Job Order above to get started.';
    // Section progress sits alongside the four coarse stages: the stages
    // say what phase you're in, this says how far through the actual form
    // you are. Visible the whole time the form is being filled, which is
    // what keeps the tracker meaningful now that sections appear one at a
    // time rather than all at once.
    let sectionLine = '';
    if(step1Done && !step4Done){
      const total = srSectionIsSkipped(2) ? SR_LAST_SECTION-1 : SR_LAST_SECTION;
      const shown = Math.min(srMaxSection, SR_LAST_SECTION);
      const pos = srSectionIsSkipped(2) && shown>2 ? shown-1 : shown;
      const pct = Math.round((pos/total)*100);
      sectionLine = '<div class="sr-section-progress">'+
          '<div class="sr-section-progress-bar"><span style="width:'+pct+'%"></span></div>'+
          '<div class="sr-section-progress-text">Section '+pos+' of '+total+
            ' \u00b7 '+escapeHtml(SR_SECTION_TITLES[shown]||'')+'</div>'+
        '</div>';
    }
    container.innerHTML = '<div class="jo-stepper">'+
      '<div class="jo-stepper-track">'+stepsHtml+'</div>'+
      sectionLine+
      '<div class="jo-stepper-next"><b>Next:</b> '+nextText+'</div>'+
    '</div>';
  }
  ['custName','svcDate'].forEach(id=>{ const el = $(id); if(el){ el.addEventListener('input', srRenderStepper); el.addEventListener('change', srRenderStepper); } });
  srRenderStepper();
  // Auto-fills the Technician Name field from the logged-in account (still
  // editable, in case a different technician actually performed the work).
  function applyTechNameDefault(){
    if(currentUser && currentUser.name) $('techName').value = currentUser.name;
  }

  // ---------- validation ----------
  function clearInvalid(){
    document.querySelectorAll('.field.invalid').forEach(f=>f.classList.remove('invalid'));
  }
  function validate(){
    clearInvalid();
    let ok = true;
    if(!$('custName').value.trim()){ $('f_custName').classList.add('invalid'); ok=false; }
    if(!$('svcDate').value){ $('f_date').classList.add('invalid'); ok=false; }
    const email = $('custEmail').value.trim();
    if(!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){ $('f_custEmail').classList.add('invalid'); ok=false; }
    return ok;
  }

  // ---------- gather form data ----------
  function gatherData(){
    const findings = Array.from($('findingsList').querySelectorAll('textarea')).map(t=>t.value.trim()).filter(Boolean);
    const recs = Array.from($('recsList').querySelectorAll('textarea')).map(t=>t.value.trim()).filter(Boolean);
    const servicesDone = Array.from($('servicesDoneList').querySelectorAll('textarea')).map(t=>t.value.trim()).filter(Boolean);
    const materials = Array.from($('materialsBody').querySelectorAll('tr')).map(tr=>({
      description: tr.querySelector('.m-desc').value.trim(),
      qty: tr.querySelector('.m-qty').value.trim(),
      unit: tr.querySelector('.m-unit').value.trim()
    })).filter(r=>r.description||r.qty||r.unit);

    return {
      srNo: currentSrNo,
      technicianId: currentTechnicianId || (currentUser ? currentUser.id : null),
      date: $('svcDate').value,
      custName: $('custName').value.trim(),
      custAddress: $('custAddress').value.trim(),
      contactNo: $('contactNo').value.trim(),
      contactPerson: $('contactPerson').value.trim(),
      equipType: $('equipType').value.trim(), modelCU:$('modelCU').value.trim(), serialCU:$('serialCU').value.trim(),
      modelFCU:$('modelFCU').value.trim(), serialFCU:$('serialFCU').value.trim(),
      coolCap:$('coolCap').value.trim(), mountType:$('mountType').value.trim(),
      brand:$('brand').value.trim(), refrigerantType:$('refrigerantType').value.trim(),
      compressorType:$('compressorType').value.trim(), equipLocation:$('equipLocation').value.trim(),
      troubleCall:$('troubleCall').value.trim(), findings, recs, materials, servicesDone,
      before:{
        amp:[$('b_amp_l1').value,$('b_amp_l2').value,$('b_amp_l3').value],
        volt:[$('b_volt_l12').value,$('b_volt_l23').value,$('b_volt_l31').value],
        pressure:[$('b_press_suction').value,$('b_press_discharge').value],
        temp:$('b_temp').value, airflow:$('b_airflow').value
      },
      after:{
        amp:[$('a_amp_l1').value,$('a_amp_l2').value,$('a_amp_l3').value],
        volt:[$('a_volt_l12').value,$('a_volt_l23').value,$('a_volt_l31').value],
        pressure:[$('a_press_suction').value,$('a_press_discharge').value],
        temp:$('a_temp').value, airflow:$('a_airflow').value
      },
      isInstall: $('isInstallToggle').checked,
      install:{
        pd:[$('pd_suction').value,$('pd_discharge').value,$('pd_drain').value],
        pl:[$('pl_refline').value,$('pl_drain').value],
        ws:[$('ws_feeder').value,$('ws_control').value],
        breaker:$('circuit_breaker').value,
        pi:[$('pi_refline').value,$('pi_drain').value],
        riser:$('riser_height').value, ptrap:$('ptrap').value, bracketType:$('bracketType').value
      },
      timeIn:$('timeIn').value, timeOut:$('timeOut').value, remarks:$('remarks').value.trim(),
      custPrintedName:$('custPrintedName').value.trim(), techName:$('techName').value.trim(),
      custEmail: $('custEmail').value.trim(),
      sigCustomerRaw: sigCustomerPad.isEmpty() ? null : sigCustomerPad.toDataURL('image/png'),
      sigTechRaw: sigTechPad.isEmpty() ? null : sigTechPad.toDataURL('image/png')
    };
  }
  async function gatherDataForOutput(){
    await ensureSignaturePads();
    const data = gatherData();
    data.sigCustomer = data.sigCustomerRaw ? await downscaleDataUrl(data.sigCustomerRaw, 400) : null;
    data.sigTech = data.sigTechRaw ? await downscaleDataUrl(data.sigTechRaw, 400) : null;
    return data;
  }

  // ---------- save draft ----------
  // Returns SAVE_CLOUD / SAVE_QUEUED / SAVE_FAILED so callers stop telling the
  // user "saved" when the write actually failed and nothing was retained.
  // Drafts save locally first when there is no signal, then upload on their
  // own via the outbox (see registerOutboxHandler('report', ...) below) —
  // triggered automatically on 'online', on the app coming back to the
  // foreground, and by the periodic safety-net timer in core.js. "Sync now"
  // just runs that same flush immediately on demand.
  async function saveReport(srNo, data){
    // Which customer_equipment row this report is for is decided by an
    // explicit earlier choice, not guessed here: getEquipPickedId() (set
    // by renderEquipPicker()'s click handler, or by openReport() when
    // resuming a draft/batch item that already has one) is the real id if
    // the technician picked an existing record and hasn't edited a field
    // since. Otherwise this is content the technician typed via "+ Add
    // New" — genuinely new, so cloudAddCustomerEquipment() just creates a
    // fresh row, no matching against what's already on file.
    const matchedCustomer = customersCache.find(c=> c.name.toLowerCase() === (data.custName||'').trim().toLowerCase());
    if(matchedCustomer) data.equipmentId = getEquipPickedId() || await cloudAddCustomerEquipment(matchedCustomer.id, data);
    let result = SAVE_FAILED;
    if(await ensureCloud() && await cloudSaveReport(srNo, data)) result = SAVE_CLOUD;
    // Keep only the downscaled signatures on disk: the full-resolution raw
    // canvas exports are several hundred KB each and were being persisted for
    // no reason, filling local storage and bloating every upload.
    const persisted = Object.assign({}, data);
    delete persisted.sigCustomerRaw;
    delete persisted.sigTechRaw;
    try{ await window.storage.set('report:'+srNo, JSON.stringify(persisted), false); }
    catch(e){ console.error('local report save failed', e); }
    if(result!==SAVE_CLOUD){
      // Queue it so it uploads by itself the next time there is a connection,
      // instead of living only on this phone until someone reopens it.
      if(await outboxQueue('report', srNo, persisted)) result = SAVE_QUEUED;
    }
    return result;
  }
  registerOutboxHandler('report', async (srNo, payload)=>{
    let finalSr = srNo;
    // A report numbered offline gets a real sequential SR number now that the
    // server is reachable, so provisional ids never reach the shared history.
    if(isProvisionalSrNo(srNo)){
      const real = await cloudNextSrNo((payload.date || todayISO()).replace(/-/g,''));
      if(real) finalSr = real;
    }
    payload.srNo = finalSr;
    const ok = await cloudSaveReport(finalSr, payload);
    if(!ok) throw new Error('report upload failed');
    if(finalSr !== srNo){
      try{
        await window.storage.set('report:'+finalSr, JSON.stringify(payload), false);
        await window.storage.delete('report:'+srNo);
      }catch(e){}
    }
  });
  $('saveDraftBtn').addEventListener('click', async ()=>{
    if(!$('custName').value.trim()){ toast('Add a customer name before saving'); $('f_custName').classList.add('invalid'); return; }
    if(!currentSrNo){ currentSrNo = await nextSrNo(); $('metaSrNo').textContent = currentSrNo; }
    const data = await gatherDataForOutput();
    const res = await saveReport(currentSrNo, data);
    if(res===SAVE_FAILED){ toast('Could not save '+currentSrNo+' — nothing was stored, please try again'); return; }
    toast(res===SAVE_CLOUD
      ? ('Draft saved to shared cloud: '+currentSrNo)
      : ('Draft saved on this device — it will upload automatically when you are online'));
    resetForm();
  });
