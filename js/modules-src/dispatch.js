// ---------- Service Dispatch Ticket (table: dispatch_tickets) ----------
  // Admin-created and assigned to one or more technicians; those technicians
  // then acknowledge and later mark it completed. This is the reverse
  // direction from Leave/Cash Advance (which are technician-filed, admin-
  // reviewed) — here admin files, technician actions it.
  function dtGenLocalId(){ return 'JO-'+todayISO().replace(/-/g,'')+'-'+Date.now(); }
  // Old tickets only ever had a single equipmentDetails object + one shared
  // scope list. Wrap those into the new equipmentList shape on read so
  // nothing written before this change breaks.
  function dtNormalizeTicket(rec){
    if(!rec) return rec;
    if(!rec.equipmentList){
      if(rec.equipmentDetails && Object.values(rec.equipmentDetails).some(v=>v)){
        rec.equipmentList = [Object.assign({id:'legacy-1'}, rec.equipmentDetails, {
          scope: rec.scope||[], reportSrNo: rec.status==='completed' ? 'legacy' : null
        })];
      }else{
        rec.equipmentList = [];
      }
    }
    return rec;
  }
  const DT_PAGE = 200;
  const DT_MAX_ROWS = 5000;
  async function dtNextJobOrderNo(){
    const dateStr = todayISO().replace(/-/g,'');
    if(await ensureCloud()){
      try{
        const { data, error } = await db.rpc('next_jo_no', { p_date: todayISO() });
        if(!error && data) return data;
      }catch(e){ console.error('cloud JO counter failed', e); }
    }
    let seq = 1;
    try{
      const res = await window.storage.get('jo-counter:'+dateStr, false);
      seq = res ? (JSON.parse(res.value).seq + 1) : 1;
    }catch(e){ seq = 1; }
    try{ await window.storage.set('jo-counter:'+dateStr, JSON.stringify({seq}), false); }catch(e){}
    return 'JO-'+dateStr+'-'+String(seq).padStart(3,'0');
  }
  // Returns a tri-state result so callers can tell "saved to the server" from
  // "only saved on this phone" instead of showing a success message either way.
  async function dtSaveTicket(id, data){
    if(await ensureCloud()){
      try{
        const { error } = await db.from('dispatch_tickets').upsert({
          id, status: data.status||'preparing',
          created_at: data.createdAt || new Date().toISOString(), data
        });
        if(error) throw error;
        return SAVE_CLOUD;
      }catch(e){ console.error('dispatch save failed', describeCloudError(e)); }
    }
    try{
      await window.storage.set('dispatch:'+id, JSON.stringify(data), false);
      return (await outboxQueue('dispatch', id, data)) ? SAVE_QUEUED : SAVE_FAILED;
    }catch(e){ return SAVE_FAILED; }
  }
  registerOutboxHandler('dispatch', async (id, payload)=>{
    const { error } = await db.from('dispatch_tickets').upsert({
      id, status: payload.status||'preparing',
      created_at: payload.createdAt || new Date().toISOString(), data: payload
    });
    if(error) throw error;
  });

  // ---------- Offline acknowledge / arrival ----------
  // Acknowledge and Arrived at Site both required a live connection, which
  // is the wrong requirement for where they actually happen: a plant room,
  // a basement, a warehouse with no signal. Worse under the revised
  // lifecycle than before it, because arrival is what unlocks the Service
  // Report — a dead spot used to block a status update, and now blocks the
  // entire visit.
  //
  // Queued as a per-ticket-per-action item so the replay is idempotent.
  // The key is deliberately NOT unique per tap: tapping Acknowledge twice
  // offline should produce one queued acknowledgement, not two.
  //
  // The replay re-reads the ticket and re-applies the SAME merge the online
  // path uses, rather than replaying a stored copy of the whole ticket. A
  // technician who acknowledged at 9am in a basement and surfaces at noon
  // must not overwrite what the rest of the crew did in between.
  registerOutboxHandler('dispatch-act', async (key, payload)=>{
    const rec = await dtGetTicket(payload.ticketId);
    if(!rec) return; // ticket deleted since — nothing to replay onto
    if(payload.action === 'ack'){
      const ackBy = new Set(rec.acknowledgedBy||[]);
      if(ackBy.has(payload.userId)) return; // already landed
      ackBy.add(payload.userId);
      const list = Array.from(ackBy);
      const assigned = rec.assignedWorkerIds || [];
      // If they were replaced while offline, their acknowledgement is no
      // longer meaningful — drop it rather than re-adding someone who has
      // been taken off the job.
      if(!assigned.includes(payload.userId)) return;
      const everyone = assigned.length>0 && assigned.every(w=> list.includes(w));
      const merged = Object.assign({}, rec, {
        acknowledgedBy: list,
        acknowledgedAt: rec.acknowledgedAt || payload.at,
        status: everyone ? 'acknowledged' : 'preparing'
      });
      const { error } = await db.from('dispatch_tickets')
        .update({ status: merged.status, data: merged }).eq('id', payload.ticketId);
      if(error) throw error;
      if(everyone && typeof srMarkEnRouteByTicket === 'function') srMarkEnRouteByTicket(payload.ticketId).catch(()=>{});
      return;
    }
    if(payload.action === 'arrived'){
      if(rec.arrivedAt) return; // someone else recorded arrival first
      if(!(rec.assignedWorkerIds||[]).includes(payload.userId)) return;
      const merged = Object.assign({}, rec, {
        arrivedAt: payload.at, arrivedBy: payload.userName,
        arrivedById: payload.userId, status: 'in_progress'
      });
      const { error } = await db.from('dispatch_tickets')
        .update({ status:'in_progress', data: merged }).eq('id', payload.ticketId);
      if(error) throw error;
      if(typeof srMarkInProgressByTicket === 'function') srMarkInProgressByTicket(payload.ticketId).catch(()=>{});
    }
  });

  // Applies the action to the LOCAL copy so the technician sees it take
  // effect, and queues the replay. Offline there is no server clock, so the
  // timestamp uses the last known server offset (serverNowISO falls back to
  // device time with offset 0) — good enough for a Time In the technician
  // can edit, and honest about where it came from.
  async function dtQueueOfflineAction(ticketId, action){
    if(!currentUser) return false;
    const at = serverNowISO();
    const rec = (await dtGetTicket(ticketId)) || dtLastTicketsById[ticketId];
    if(!rec){ toast('Open this job order once while online first'); return false; }
    const local = Object.assign({}, rec);
    if(action === 'ack'){
      const list = Array.from(new Set((local.acknowledgedBy||[]).concat([currentUser.id])));
      local.acknowledgedBy = list;
      local.acknowledgedAt = local.acknowledgedAt || at;
      const assigned = local.assignedWorkerIds || [];
      local.status = (assigned.length>0 && assigned.every(w=> list.includes(w))) ? 'acknowledged' : 'preparing';
    }else{
      if(local.arrivedAt){ toast('Arrival already recorded'); return false; }
      local.arrivedAt = at; local.arrivedBy = currentUser.name || null;
      local.arrivedById = currentUser.id; local.status = 'in_progress';
      // Flags this timestamp as taken from the device, not the server, so
      // it can be told apart later if the clock turns out to have been off.
      if(!isServerTimeVerified || !isServerTimeVerified()) local.arrivedAtUnverified = true;
    }
    try{ await window.storage.set('dispatch:'+ticketId, JSON.stringify(local), false); }catch(e){}
    dtLastTicketsById[ticketId] = local;
    const ok = await outboxQueue('dispatch-act', ticketId+':'+action, {
      ticketId, action, userId: currentUser.id, userName: currentUser.name || null, at
    });
    return ok;
  }

  async function dtLocalList(){
    try{
      const res = await window.storage.list('dispatch:', false);
      const items = [];
      for(const key of (res.keys||[])){
        try{ const item = await window.storage.get(key, false); items.push(dtNormalizeTicket(JSON.parse(item.value))); }catch(e){}
      }
      items.sort((a,b)=> (b.createdAt||'').localeCompare(a.createdAt||''));
      return items;
    }catch(e){ return []; }
  }
  // Pages through results instead of silently stopping at 300 rows, which used
  // to make older tickets vanish from the admin list with no warning.
  async function dtFetchPaged(applyFilter){
    const out = [];
    for(let from=0; from<DT_MAX_ROWS; from+=DT_PAGE){
      let q = db.from('dispatch_tickets').select('data')
        .order('created_at',{ascending:false}).range(from, from+DT_PAGE-1);
      if(applyFilter) q = applyFilter(q);
      const { data, error } = await q;
      if(error) throw error;
      const rows = data || [];
      rows.forEach(r=> out.push(dtNormalizeTicket(r.data)));
      if(rows.length < DT_PAGE) break;
    }
    return out;
  }
  async function dtListAll(){
    if(await ensureCloud()){
      try{ return await dtFetchPaged(null); }
      catch(e){ console.error('dispatch list failed', describeCloudError(e)); }
    }
    return dtLocalList();
  }
  // Filters on the server (`assigned_worker_ids @> [workerId]`) rather than
  // downloading every technician's tickets and filtering in JavaScript.
  async function dtListForWorker(workerId){
    if(!workerId) return [];
    if(await ensureCloud()){
      try{
        // Two queries, not one `.or()`: PostgREST's or= syntax doesn't
        // compose with jsonb containment cleanly, and two indexed
        // containment scans are cheaper than the alternative anyway.
        // The second picks up tickets this technician was REPLACED on —
        // they keep read access (see the RLS policy) so the job order can
        // close out on their side with a reason instead of vanishing.
        const assigned = await dtFetchPaged(q=> q.contains('data->assignedWorkerIds', JSON.stringify([workerId])));
        const removed  = await dtFetchPaged(q=> q.contains('data->removedWorkerIds',  JSON.stringify([workerId])));
        // A technician can be removed from a ticket and later re-added, so
        // the two sets can overlap — current assignment wins.
        const seen = new Set(assigned.map(t=> t.id));
        return assigned.concat(removed.filter(t=> !seen.has(t.id)));
      }catch(e){ console.error('dispatch worker list failed', describeCloudError(e)); }
    }
    return (await dtLocalList()).filter(t=>
      (t.assignedWorkerIds||[]).includes(workerId) || (t.removedWorkerIds||[]).includes(workerId));
  }
  // Was THIS viewer replaced on this ticket? Everything about a removal is
  // per-viewer: the ticket itself is alive and unchanged for the crew still
  // on it, and only the replaced person sees it as finished.
  function dtRemovalFor(r, userId){
    if(!r || !userId) return null;
    if((r.assignedWorkerIds||[]).includes(userId)) return null; // re-added since
    if(!(r.removedWorkerIds||[]).includes(userId)) return null;
    const entries = (r.removedWorkers||[]).filter(e=> e.id===userId);
    return entries.length ? entries[entries.length-1] : { id:userId, reason:null };
  }
  // What a given viewer should actually SEE. For everyone still on the
  // ticket that's the live record; for someone replaced it's the snapshot
  // taken at their removal, so their copy stops updating at the moment they
  // stopped being involved. The removal bookkeeping is preserved on top of
  // the snapshot, since dtRemovalFor and dtEffectiveStatus read it to keep
  // rendering the ticket as 'replaced'.
  function dtViewFor(r, userId){
    const removal = dtRemovalFor(r, userId);
    if(!removal || !removal.snapshot) return r;
    return Object.assign({}, r, removal.snapshot, {
      removedWorkerIds: r.removedWorkerIds,
      removedWorkers: r.removedWorkers
    });
  }
  // Being ASSIGNED to a ticket and being ALLOWED to file its Service Report
  // are two different things — admin explicitly picks which assigned
  // worker(s) may create the report, so not everyone on the ticket can.
  // This powers the "From Job Order" picker specifically; dtListForWorker
  // above still governs general ticket visibility (the My Job Order tab).
  async function dtListForReporter(workerId){
    if(!workerId) return [];
    if(await ensureCloud()){
      try{
        return await dtFetchPaged(q=> q.contains('data->reportAllowedWorkerIds', JSON.stringify([workerId])));
      }catch(e){ console.error('dispatch reporter list failed', describeCloudError(e)); }
    }
    return (await dtLocalList()).filter(t=> (t.reportAllowedWorkerIds||[]).includes(workerId));
  }

  // ---------- Realtime: live ticket updates ----------
  // Until now the job order lists only ever refreshed when the person
  // looking at them did something. A technician acknowledging was invisible
  // on admin's screen until admin reloaded, which defeats the point of a
  // list-level progress tracker — dots that never move on their own are
  // just a slower version of opening each ticket.
  //
  // Three deliberate choices here, all about not melting the database:
  //
  //   1. PATCH, DON'T REFETCH. The payload already carries the full new row
  //      (data jsonb + status), so a change updates dtLastTicketsById in
  //      place. A naive `=> dtListAll()` would re-page every ticket in the
  //      system on every keystroke-level change; with a few hundred tickets
  //      and a busy afternoon that is a self-inflicted outage.
  //   2. DEBOUNCE THE RENDER, NOT THE PATCH. The cache updates immediately
  //      so nothing is ever lost, but the DOM rebuild is coalesced — a
  //      batch of writes (admin reassigning, then the trigger firing, then
  //      the linked request syncing) repaints once, not four times.
  //   3. LET RLS DO THE FILTERING. dispatch_select_assigned already limits
  //      a technician to their own tickets, and Supabase realtime applies
  //      the same policy to the stream, so the technician channel needs no
  //      client-side filter to stay private. The explicit assignment check
  //      below is for a different case — see the unassign note.
  let dtTicketChannel = null;
  let dtRenderTimer = null;
  const DT_RENDER_DEBOUNCE_MS = 250;

  function dtScheduleRender(){
    if(dtRenderTimer) clearTimeout(dtRenderTimer);
    dtRenderTimer = setTimeout(()=>{
      dtRenderTimer = null;
      if(!currentUser) return;
      // Only repaint what's actually on screen. Rendering a hidden view
      // costs the same as a visible one and buys nothing.
      const dispatchVisible = $('dispatchView') && $('dispatchView').style.display !== 'none';
      if(!dispatchVisible) return;
      // The Messages tab replaces the list rather than filtering it, so a
      // ticket change must not repaint a job order list underneath it —
      // 'messages' is not a status and would match nothing anyway.
      if(currentUser.role === 'admin'){
        if(dtAdminFilter === 'messages') dtRenderChatInbox(); else dtRenderAdminList();
      }else{
        if(dtTechListTab === 'inbox') dtRenderChatInbox(); else dtRenderTechList();
      }
    }, DT_RENDER_DEBOUNCE_MS);
  }

  // Applies one realtime payload to the local cache. Returns true when the
  // change is relevant to this user, so the caller can skip the repaint
  // entirely for noise.
  function dtApplyRealtimePayload(payload){
    if(!payload || !currentUser) return false;
    const isAdmin = currentUser.role === 'admin';
    const newRow = payload.new && payload.new.data ? dtNormalizeTicket(payload.new.data) : null;
    const oldRow = payload.old && payload.old.data ? payload.old.data : null;

    if(payload.eventType === 'DELETE'){
      const goneId = (oldRow && oldRow.id) || (payload.old && payload.old.id);
      if(goneId && dtLastTicketsById[goneId]){ delete dtLastTicketsById[goneId]; return true; }
      return false;
    }
    if(!newRow || !newRow.id) return false;

    // The unassign case, and the reason this migration sets REPLICA
    // IDENTITY FULL. When admin reassigns a ticket away from a technician,
    // that technician stops satisfying the RLS policy — so the row simply
    // stops arriving in future. Nothing tells them it's gone, and a ticket
    // they can no longer act on would sit in their list until they reload.
    // The update that REMOVED them is still delivered (they matched the
    // old row), so this is the one chance to drop it from the cache.
    if(!isAdmin){
      const stillMine = (newRow.assignedWorkerIds || []).includes(currentUser.id);
      const wasMine = oldRow ? (oldRow.assignedWorkerIds || []).includes(currentUser.id) : false;
      const replaced = (newRow.removedWorkerIds || []).includes(currentUser.id);
      if(!stillMine){
        if(replaced){
          // Not dropped — a replaced technician keeps a read-only record.
          // Storing the live row is still correct: every render path runs it
          // through dtViewFor, which swaps in the snapshot frozen at their
          // removal, so later activity on the ticket never reaches them.
          dtLastTicketsById[newRow.id] = newRow;
          if(wasMine){
            // Worth interrupting for: they may be standing in front of the
            // site. Silence is how someone drives to a job that isn't theirs.
            toast('A job order was reassigned — it has closed on your side');
          }
          return true;
        }
        if(wasMine && dtLastTicketsById[newRow.id]){
          delete dtLastTicketsById[newRow.id];
          return true;
        }
        return false;
      }
    }
    dtLastTicketsById[newRow.id] = newRow;
    // Keep an open overlay in step with the row behind it, otherwise admin
    // can be reading a detail view that quietly stopped being true.
    if(dtOverlayTicket && dtOverlayTicket.id === newRow.id) dtOverlayTicket = newRow;
    return true;
  }

  // Messages, across every ticket. Separate from dtMsgChannel, which is
  // per-ticket and only exists while that ticket's overlay is open — fine
  // for the thread itself, useless for the inbox, whose entire purpose is
  // showing messages on tickets you are NOT currently looking at. Without
  // this, a message arriving while admin sits on the Messages tab is
  // invisible until they navigate away and back.
  let dtInboxMsgChannel = null;
  function dtSubscribeTickets(){
    dtUnsubscribeTickets();
    if(!db || !currentUser) return;
    try{
      dtTicketChannel = db.channel('dispatch-tickets-'+currentUser.id)
        .on('postgres_changes', { event:'*', schema:'public', table:'dispatch_tickets' }, (payload)=>{
          if(dtApplyRealtimePayload(payload)) dtScheduleRender();
        })
        .subscribe();
      dtInboxMsgChannel = db.channel('dispatch-inbox-'+currentUser.id)
        .on('postgres_changes', { event:'INSERT', schema:'public', table:'dispatch_ticket_messages' }, ()=>{
          // Badge always; the inbox only when it's the visible list.
          if(typeof refreshUnreadMsgBadges === 'function') refreshUnreadMsgBadges();
          const onInbox = (currentUser.role==='admin') ? dtAdminFilter==='messages' : dtTechListTab==='inbox';
          if(onInbox) dtScheduleRender();
        })
        .subscribe();
    }catch(e){ console.error('dispatch realtime subscribe failed', describeCloudError(e)); }
  }
  function dtUnsubscribeTickets(){
    if(dtRenderTimer){ clearTimeout(dtRenderTimer); dtRenderTimer = null; }
    if(dtTicketChannel && db){ try{ db.removeChannel(dtTicketChannel); }catch(e){} }
    dtTicketChannel = null;
    if(dtInboxMsgChannel && db){ try{ db.removeChannel(dtInboxMsgChannel); }catch(e){} }
    dtInboxMsgChannel = null;
  }

  // ---------- Service Report: "From Job Order" picker ----------
  // Shows the technician's own Job Order tickets that still have equipment
  // needing a report. Tapping a ticket expands its pending equipment as a
  // checklist; tapping one piece of equipment fills the form with THAT
  // unit's details/scope and files one report just for it — one dispatch
  // ticket can cover many units, but each still gets its own report.
  // srCurrentTicketId / srCurrentEquipId (which ticket + equipment item the
  // report currently being filed is tied to) are declared in ui.js, not
  // here — resetForm() runs once at load time before this module's code
  // executes, and clears them, so they must already be initialized by then.
  async function srRenderJobOrderPicker(){
    const card = $('srJobOrderCard');
    const list = $('srJobOrderList');
    if(!currentUser || currentUser.role==='admin'){
      card.style.display = 'none';
      // Admin has no Job Order gate — Customer's Info is always visible.
      $('sec1Card').style.display = '';
      return;
    }
    card.style.display = '';
    // Reset anything the unit step changed (see backToUnits below), so a
    // re-render always comes back as the full "Select From Job Order" list.
    const t = $('srJobOrderTitle');
    if(t && t.dataset.originalHtml) t.innerHTML = t.dataset.originalHtml;
    else if(t) t.dataset.originalHtml = t.innerHTML;
    list.innerHTML = '<div class="empty-state">Loading…</div>';
    const mine = await dtListForReporter(currentUser.id);
    // A ticket can be closed with some equipment left unreported (closing
    // with exceptions marks those units "not done" instead of requiring a
    // report — see dtCloseTicket). Once closed, the Job Order is finalized,
    // so it shouldn't keep showing up here as something still needing a
    // report to be filed against it.
    // Reports are filed DURING the visit, so the ticket must have reached
    // Work in Progress — someone tapped Arrived at Site. Filtering only on
    // "not terminal" used to let a future-dated job order appear here, so a
    // technician could file next week's report today; and a Preparing
    // ticket would have no arrival time to fill Time In from.
    //
    // A unit flagged Not Yet Done is resolved, not pending: it has no
    // reportSrNo and would otherwise keep offering itself for a report the
    // technician already said couldn't be done.
    // Category the technician chose on the previous screen (srPickerCategory,
    // declared in ui.js). Tickets created before categories existed carry
    // none, so they're listed under every category rather than vanishing
    // from the picker — whatever the technician picks becomes the report's.
    const cat = (typeof srPickerCategory !== 'undefined') ? srPickerCategory : null;
    const openOnes = mine.filter(r=>
      dtEffectiveStatus(r)==='in_progress' &&
      (!cat || !r.category || r.category===cat) &&
      (r.equipmentList||[]).some(it=> !it.reportSrNo && !it.notDone));
    if(t && cat) t.innerHTML = t.dataset.originalHtml + ' — ' + escapeHtml(serviceCategoryLabel(cat));
    if($('srJobOrderChangeCat')) $('srJobOrderChangeCat').style.display = cat ? '' : 'none';
    if(openOnes.length===0){
      list.innerHTML = '<div class="empty-state">No '+(cat ? escapeHtml(serviceCategoryLabel(cat))+' ' : '')+'Job Order tickets with equipment still needing a report.</div>';
      return;
    }
    list.innerHTML = '';
    openOnes.forEach(r=>{
      const items = r.equipmentList||[];
      const pending = items.filter(it=> !it.reportSrNo && !it.notDone);
      const resolved = items.filter(it=> it.reportSrNo || it.notDone).length;
      // Filing implies the visit happened. The list above already restricts
      // this to tickets someone has arrived at; this second check is
      // per-person — on a shared job order, a colleague's arrival moves the
      // ticket, but each technician still files under their own
      // acknowledgement.
      const alreadyAck = (r.acknowledgedBy||[]).includes(currentUser.id);
      const row = document.createElement('div');
      row.className = 'user-card' + (alreadyAck ? '' : ' jo-locked');
      row.innerHTML = '<div class="user-card-head" style="cursor:pointer;">'+
          '<div>'+
            '<div class="u-name">'+escapeHtml(r.jobOrderNo)+' — '+escapeHtml(r.custName)+'</div>'+
            '<div class="u-status">'+dtCategoryTagHtml(r)+leaveFmtDate(r.date)+(r.expectedTime ? (' at '+r.expectedTime) : '')+
              (r.siteAddress ? (' · '+escapeHtml(r.siteAddress)) : '')+'</div>'+
            '<div class="u-status">'+resolved+' of '+items.length+' equipment resolved</div>'+
          '</div>'+
          (alreadyAck
            ? dtStatusPill(r)
            : '<button type="button" class="sr-ack-required-btn">'+icon('lock')+' Acknowledge Required</button>')+
        '</div>'+
        (alreadyAck
          ? '<div class="dt-equip-pending" style="display:none; margin-top:8px;"></div>'
          : '<div class="sr-ack-required-note">Open this Job Order in <b>My Job Order</b> and tap Acknowledge before you can file a report for it.</div>');
      const head = row.querySelector('.user-card-head');
      if(!alreadyAck){
        // Locked row: tapping anywhere on it (including the pill button)
        // sends the technician to acknowledge it, instead of expanding an
        // equipment picker they're not allowed to use yet.
        head.addEventListener('click', (e)=>{ e.stopPropagation(); srGoAcknowledgeTicket(r); });
        list.appendChild(row);
        return;
      }
      const pendingWrap = row.querySelector('.dt-equip-pending');
      function renderSinglePickList(){
        pendingWrap.innerHTML = '';
        if(pending.length===0){
          pendingWrap.innerHTML = '<div class="empty-state">All equipment on this ticket already has a report.</div>';
          return;
        }
        pending.forEach(it=>{
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'combo-item';
          btn.style.cssText = 'display:flex; align-items:center; justify-content:space-between; gap:8px; width:100%; text-align:left; border:1px solid var(--border); border-radius:8px; margin-bottom:6px; padding:10px; background:none;';
          // A pending item with a draftSrNo already has a Service Report
          // started for it (just not completed yet). Flag it clearly so a
          // technician re-opening this ticket doesn't start a second,
          // duplicate report for the same unit — tapping it below resumes
          // the existing draft instead of blanking the form.
          btn.innerHTML = '<span>'+escapeHtml(dtEquipSummaryLine(it))+'</span>'+
            (it.draftSrNo ? '<span class="status-pill status-draft" style="flex-shrink:0;">Draft Saved</span>' : '');
          btn.addEventListener('click', (e)=>{
            e.stopPropagation();
            if(it.draftSrNo) srResumeDraft(r, it);
            else srApplyJobOrder(r, it);
          });
          pendingWrap.appendChild(btn);
        });
        // Add New Equipment — for a unit found on site that isn't on the
        // ticket. Opens the report on this job order with the equipment
        // fields blank and the "+ Add New" tab active; saving the report
        // then registers it permanently against the customer via
        // cloudAddCustomerEquipment (customers.js), so it appears in their
        // equipment list from then on.
        const addBtn = document.createElement('button');
        addBtn.type = 'button';
        addBtn.className = 'sr-batch-toggle-link';
        addBtn.style.cssText = 'width:100%; text-align:center; background:none; border:1px dashed var(--border); border-radius:8px; color:var(--green-dark); font-size:12.5px; font-weight:700; padding:10px 0; margin-top:6px; cursor:pointer;';
        addBtn.innerHTML = icon('plus')+' Add New Equipment';
        addBtn.addEventListener('click', (e)=>{
          e.stopPropagation();
          // srApplyJobOrder already skips the equipment fill when no unit
          // is passed, leaving those fields blank for the technician.
          srApplyJobOrder(r, null);
          if(typeof setEquipTab === 'function') setEquipTab('addnew');
          if(typeof setEquipPickedId === 'function') setEquipPickedId(null);
          toast('Enter the equipment details — it will be saved to this customer');
        });
        pendingWrap.appendChild(addBtn);
      }
      // Single vs Multiple is now its own screen (srEntryMode), shown
      // between picking a job order and picking units — see
      // srStartReportFlow in ui.js. The inline "batch sign" link it
      // replaces is gone; with only one unit pending there's nothing to
      // choose, so that case goes straight to the unit list.
      function openUnitStep(){
        const modeScreen = $('srEntryMode');
        // One unit pending: nothing to choose between Single and Multiple,
        // so go straight to the unit step — but through the same isolation
        // so it reads as its own screen rather than an inline expansion.
        if(pending.length < 2 || !modeScreen){ backToUnits(renderSinglePickList); return; }
        $('srEntryModeTitle').textContent = 'Report Type — '+(r.jobOrderNo||'');
        if(typeof srShowEntry === 'function') srShowEntry('srEntryMode');
        // Render into the EXISTING pendingWrap — do NOT call
        // srRenderJobOrderPicker() here. That rebuilds the whole list,
        // which detaches the pendingWrap these handlers close over, so the
        // units were being appended to an orphaned node while the screen
        // showed a freshly-rebuilt job order list: tapping a tile looked
        // like it bounced straight back to "Select from Job Order".
        function backToUnits(render){
          if(typeof srShowEntry === 'function') srShowEntry(null);
          if($('srJobOrderCard')) $('srJobOrderCard').style.display = '';
          // Show ONLY the chosen job order's units and retitle the card.
          // The unit list lives inside this card, so simply re-showing it
          // with every other job order still listed looked identical to
          // being sent back to "Select From Job Order" — which is exactly
          // what it was read as.
          const title = $('srJobOrderTitle');
          if(title) title.textContent = 'Select unit for this report — '+(r.jobOrderNo||'');
          Array.from($('srJobOrderList').children).forEach(el=>{
            el.style.display = (el===row) ? '' : 'none';
          });
          // The row's own header is redundant now that it's the only one.
          if(head) head.style.display = 'none';
          render();
          pendingWrap.style.display = '';
          window.scrollTo({top:0, behavior:'smooth'});
        }
        $('srTileSingle').onclick = ()=> backToUnits(renderSinglePickList);
        $('srTileMultiple').onclick = ()=> backToUnits(()=> srRenderBatchPicker(pendingWrap, r, pending, renderSinglePickList));
      }
      head.addEventListener('click', ()=>{
        const isOpen = pendingWrap.style.display !== 'none';
        if(isOpen){ pendingWrap.style.display = 'none'; return; }
        // Opening a job order now goes through the Single/Multiple step
        // rather than straight to the unit list.
        openUnitStep();
      });
      list.appendChild(row);
    });
  }
  // Checkbox multi-select shown in place of the single-tap list above, once
  // a technician taps "Select multiple to batch sign". Replaces
  // pendingWrap's contents; tapping "Cancel" restores the single-tap list
  // via the onCancel callback (renderSinglePickList, passed in above) rather
  // than re-deriving it here.
  function srRenderBatchPicker(pendingWrap, ticket, pending, onCancel){
    pendingWrap.innerHTML = '<div class="leave-note" style="margin-bottom:8px;">Check every unit you serviced on this visit, then continue — you\'ll fill the shared details once and sign once for all of them.</div>';
    const checks = [];
    pending.forEach(it=>{
      const label = document.createElement('label');
      label.className = 'chk';
      label.style.cssText = 'display:flex; align-items:center; gap:8px; border:1px solid var(--border); border-radius:8px; margin-bottom:6px; padding:10px;';
      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.value = it.id;
      label.appendChild(cb);
      const span = document.createElement('span');
      span.textContent = dtEquipSummaryLine(it) + (it.draftSrNo ? ' (Draft Saved — will be overwritten)' : '');
      label.appendChild(span);
      pendingWrap.appendChild(label);
      checks.push({cb, item:it});
    });
    const actionRow = document.createElement('div');
    actionRow.style.cssText = 'display:flex; gap:8px; margin-top:8px;';
    const continueBtn = document.createElement('button');
    continueBtn.type = 'button';
    continueBtn.className = 'btn btn-primary';
    continueBtn.style.cssText = 'flex:1;';
    continueBtn.textContent = 'Continue with Selected';
    continueBtn.addEventListener('click', (e)=>{
      e.stopPropagation();
      const selected = checks.filter(c=> c.cb.checked).map(c=> c.item);
      if(selected.length===0){ toast('Check at least one unit first'); return; }
      srApplyJobOrderBatch(ticket, selected);
    });
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'btn btn-secondary';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', (e)=>{ e.stopPropagation(); onCancel(); });
    actionRow.appendChild(continueBtn); actionRow.appendChild(cancelBtn);
    pendingWrap.appendChild(actionRow);
  }
  // Set while a technician is being sent from the Service Report picker to
  // My Job Order to acknowledge a specific ticket (see srGoAcknowledgeTicket
  // below). Read by dtRenderTechList to show the "Back to Service Report"
  // banner and by dtHighlightTechCard to know which card to scroll to.
  let srAckReturnTicketId = null;
  function srGoAcknowledgeTicket(ticket){
    srAckReturnTicketId = ticket.id;
    toast('Acknowledge '+ticket.jobOrderNo+' to unlock its report');
    // No filter tabs anymore — every job order is always listed, so the
    // ticket is guaranteed to be there once the list renders.
    showDispatchView().then(()=> dtHighlightTechCard(ticket.id));
  }
  // Scrolls to and briefly outlines one card in the My Job Order list, and
  // expands its details — used right after landing here from
  // srGoAcknowledgeTicket so the technician doesn't have to hunt for the
  // one ticket they were sent to deal with among everything else assigned
  // to them.
  function dtHighlightTechCard(ticketId){
    const card = $('dtTechList') && $('dtTechList').querySelector('[data-ticket-id="'+CSS.escape(ticketId)+'"]');
    if(!card) return;
    const toggleHead = card.querySelector('.jo-card-toggle');
    if(toggleHead) dtToggleCardBody(toggleHead, true);
    card.scrollIntoView({behavior:'smooth', block:'center'});
    card.classList.add('jo-card-flash');
    setTimeout(()=> card.classList.remove('jo-card-flash'), 1800);
  }
  // Was calling applyCustomerToForm(matched), which kicks off
  // loadCustomerEquipment(...).then(defaultEquipTabForCustomer) without
  // waiting for it — that promise settled AFTER this function had already
  // filled in the equipment fields and switched to the "addnew" tab to show
  // them, and its resolution (defaultEquipTabForCustomer -> setEquipTab(null))
  // immediately hid that same section again. The fields were technically
  // populated, but invisible, so a technician tapping a unit from the Job
  // Order picker had to switch tabs by hand to actually see the autofill —
  // exactly the redundant re-selecting this picker exists to avoid. Awaiting
  // the equipment load here, then applying the equipment fields and calling
  // setEquipTab('addnew') last, guarantees nothing can hide the section
  // afterward.
  // ---------- Time In, from the arrival tap ----------
  // The Service Report's Time In used to be a bare field the technician
  // typed from memory, with no link to the job order at all. It now
  // defaults to the moment someone tapped Arrived at Site — the same
  // server-stamped instant that moved the ticket to Work in Progress, so
  // the report and the job order agree on when work started.
  //
  // Left EDITABLE on purpose: a crew that started before anyone remembered
  // to tap needs to be able to correct it, and forcing the stamped value
  // would push them to falsify the rest instead.
  function srPrefillTimeInFromTicket(ticket){
    // The report's DATE follows the job order, not the wall clock. A night
    // visit on a job order dated the 18th produces a report filed at 00:30
    // on the 19th — defaulting to "today" dated that paperwork a day after
    // the job it belongs to, with a Time In reading 23:59 the day before.
    // Still editable, like every other prefill here.
    const dateEl = $('svcDate');
    if(dateEl && ticket && ticket.date && dateEl.value === todayISO()){
      // Only when the field is still at its own default — never clobber a
      // date the technician typed.
      dateEl.value = ticket.date;
    }
    const el = $('timeIn');
    if(!el || !ticket || !ticket.arrivedAt) return;
    if(el.value) return; // never overwrite something already entered
    try{
      const d = new Date(ticket.arrivedAt);
      if(isNaN(d.getTime())) return;
      // Rendered in the business timezone for the same reason todayISO is:
      // a device on the wrong zone would otherwise show a start time hours
      // off from when the crew actually arrived.
      const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: BUSINESS_TZ, hour:'2-digit', minute:'2-digit', hour12:false
      }).format(d);
      el.value = parts;
    }catch(e){ console.error('time-in prefill failed', e); }
  }

  async function srApplyJobOrder(ticket, equipItem){
    resetForm();
    // A Job Order was actually picked — Customer's Info (and everything
    // after it) can now be shown, since a technician's report must be tied
    // to an authorized ticket rather than a freely-typed customer.
    $('sec1Card').style.display = '';
    // Prefer a saved customer record when the name matches — it may have an
    // email on file (dispatch tickets don't capture one), which the report
    // needs for auto-send. Job-order-specific site/contact details still win.
    const matched = customersCache.find(c=> c.name.toLowerCase() === (ticket.custName||'').trim().toLowerCase());
    if(matched){
      $('custName').value = matched.name;
      $('custAddress').value = matched.address||'';
      $('contactNo').value = matched.contactNo||'';
      $('contactPerson').value = matched.contactPerson||'';
      $('custEmail').value = matched.email||'';
      await loadCustomerEquipment(matched.id);
      revealSectionsAfterCustomer();
    }else{
      $('custName').value = ticket.custName||'';
      revealSectionsAfterCustomer();
    }
    if(ticket.siteAddress) $('custAddress').value = ticket.siteAddress;
    if(ticket.contactName) $('contactPerson').value = ticket.contactName;
    if(ticket.contactNo) $('contactNo').value = ticket.contactNo;
    if(equipItem){
      EQUIP_FIELD_KEYS.forEach(k=>{ const el=$(k); if(el) el.value = equipItem[k]||''; });
      // equipItem.equipmentId is the real customer_equipment.id, stamped
      // onto the ticket's equipmentList item at ticket-creation time (see
      // dtAddCustomerEquipmentBatch in dispatch.js) — reuse it directly so
      // filing this report doesn't create a second row for the same unit.
      // Tickets created before this fix won't carry one; falls through to
      // treating it as new, same as any other "+ Add New" content.
      setEquipPickedId(equipItem.equipmentId || null);
      setEquipTab('addnew'); // last, so nothing queued above can re-hide these fields
      if(equipItem.scope && equipItem.scope.length) $('troubleCall').value = equipItem.scope.join('; ');
    }
    srCurrentTicketId = ticket.id;
    srSetReportCategory(ticket.category || srPickerCategory || null);
    srPrefillTimeInFromTicket(ticket);
    srCurrentEquipId = equipItem ? equipItem.id : null;
    // Hidden HERE, not in the wizard's own reveal pass: srCurrentTicketId
    // is only assigned on the line above, AFTER
    // revealSectionsAfterCustomer() ran further up — so that check read a
    // null ticket id and left the bar on screen. The unit was chosen two
    // screens earlier, so this step is purely "review and edit these
    // details"; the Existing / "+ Add New" tabs have nothing left to
    // decide and only made a selected unit look like a new one.
    if($('equipTabBar')) $('equipTabBar').style.display = 'none';
    // The unit is chosen — the Job Order picker has done its job and must
    // not sit above every step of the form from here on.
    if($('srJobOrderCard')) $('srJobOrderCard').style.display = 'none';
    // The old scroll-to-section-1 is wrong for the wizard: section 1 isn't
    // even a step now, and srGoToSection already scrolls to the top.
    srRenderStepper();
  }

  // Batch-sign entry point: fills Customer's Information ONCE for every
  // selected equipment item (same ticket, so same customer/site), then
  // hides Section 2 (Equipment Description) — it has no single answer when
  // several different units are involved, so each unit's own equipment
  // fields (EQUIP_FIELD_KEYS) are pulled straight off its ticket record at
  // submit time instead (see the batch loop in pdf.js). Sections 3-8 are
  // filled once and shared verbatim across every report this generates.
  async function srApplyJobOrderBatch(ticket, equipItems){
    resetForm();
    $('sec1Card').style.display = '';
    const matched = customersCache.find(c=> c.name.toLowerCase() === (ticket.custName||'').trim().toLowerCase());
    if(matched){
      $('custName').value = matched.name;
      $('custAddress').value = matched.address||'';
      $('contactNo').value = matched.contactNo||'';
      $('contactPerson').value = matched.contactPerson||'';
      $('custEmail').value = matched.email||'';
      revealSectionsAfterCustomer();
    }else{
      $('custName').value = ticket.custName||'';
      revealSectionsAfterCustomer();
    }
    if(ticket.siteAddress) $('custAddress').value = ticket.siteAddress;
    if(ticket.contactName) $('contactPerson').value = ticket.contactName;
    if(ticket.contactNo) $('contactNo').value = ticket.contactNo;
    // Section 2 doesn't apply in batch mode — each report's equipment
    // fields come from its own item at submit time, not from this form.
    if($('sec2Card')) $('sec2Card').style.display = 'none';
    srCurrentTicketId = ticket.id;
    srSetReportCategory(ticket.category || srPickerCategory || null);
    srPrefillTimeInFromTicket(ticket);
    srCurrentEquipId = null;
    if($('equipTabBar')) $('equipTabBar').style.display = 'none';
    if($('srJobOrderCard')) $('srJobOrderCard').style.display = 'none';
    srBatchEquipItems = equipItems;
    // Fresh per-unit readings for this batch (see srOpResetForBatch in ui.js).
    if(typeof srOpResetForBatch === 'function') srOpResetForBatch(equipItems);
    // Section 2 is skipped in batch mode, so section 1's Continue button
    // needs to name section 3 instead — see srRefreshContinueLabels.
    if(typeof srRefreshContinueLabels === 'function') srRefreshContinueLabels();
    // Land on the first step that actually exists in batch mode — section 2
    // is skipped here, so without this the wizard sat on a hidden card.
    if(typeof srGoToSection === 'function' && typeof srNextSection === 'function'){
      srGoToSection(srNextSection(1));
    }
    $('srBatchBanner').style.display = '';
    $('srBatchList').innerHTML = equipItems.map(it=>
      '<div class="leave-note" style="margin-bottom:4px;">• '+escapeHtml(dtEquipSummaryLine(it))+'</div>'
    ).join('');
    const scopes = Array.from(new Set(equipItems.flatMap(it=> it.scope||[])));
    if(scopes.length) $('troubleCall').value = scopes.join('; ');
    toast('Job Order '+ticket.jobOrderNo+' applied for batch signing — fill in the shared details below, then sign once');
    $('srBatchBanner').scrollIntoView({behavior:'smooth', block:'start'});
    srRenderStepper();
  }

  // Re-opens an equipment item that already has a draft Service Report
  // (equipItem.draftSrNo) instead of starting a blank one — that avoids
  // filing a second report for the same unit. Pulls the full previously-
  // saved report (not just the customer/equipment fields srApplyJobOrder
  // fills in) via the normal report loader, then re-attaches the Job Order
  // linkage from this click's context, since the saved report row itself
  // doesn't carry ticketId/equipId.
  async function srResumeDraft(ticket, equipItem){
    const srNo = equipItem.draftSrNo;
    let data = null;
    if(await ensureCloud()) data = await cloudGetReport(srNo);
    if(!data){
      try{ const item = await window.storage.get('report:'+srNo, false); data = item ? JSON.parse(item.value) : null; }
      catch(e){ data = null; }
    }
    if(!data){
      toast('Could not load the saved draft for this unit — starting a new report instead');
      srApplyJobOrder(ticket, equipItem);
      return;
    }
    await openReport(data);
    srCurrentTicketId = ticket.id;
    // A draft started before categories existed is an old report, and old
    // reports are Aircon (see reportCategoryOf in core.js).
    srSetReportCategory(reportCategoryOf(data));
    srPrefillTimeInFromTicket(ticket);
    srCurrentEquipId = equipItem.id;
    // Same as the two paths above: once a unit is in play, the Job Order
    // picker and the equipment tab bar are done and must not sit above the
    // wizard's steps.
    if($('srJobOrderCard')) $('srJobOrderCard').style.display = 'none';
    if($('equipTabBar')) $('equipTabBar').style.display = 'none';
    toast('Continuing draft '+srNo);
  }

  // ---- simple repeatable-textarea list (scope items) ----
  // Mirrors service-report.js's addListRow, including the suggestions
  // dropdown (attachCombo) — this used to just be a plain textarea with no
  // suggestions at all, unlike every equivalent list in Service Report
  // (Findings, Recommendations, Services Done). Both the shared "Default
  // Scope of Works" list and each equipment item's own "Scope of Service"
  // list go through this function, so both get suggestions from the same
  // admin-editable 'scopeOfWork' list (see DEFAULT_LISTS in customers.js).
  function dtAddSimpleRow(containerId, value){
    const wrap = document.createElement('div');
    wrap.className = 'itemrow';
    const ta = document.createElement('textarea');
    ta.rows = 1; ta.value = value || '';
    ta.placeholder = 'e.g. Clean coils, check refrigerant, test operation';
    const rm = document.createElement('button');
    rm.type = 'button'; rm.className = 'rm-btn'; rm.textContent = '\u2212';
    rm.onclick = () => wrap.remove();
    wrap.appendChild(ta); wrap.appendChild(rm);
    $(containerId).appendChild(wrap);
    attachCombo(ta, 'scopeOfWork');
  }
  document.querySelectorAll('#dtNewCard .add-row-btn[data-target]').forEach(btn=>{
    btn.addEventListener('click', ()=> dtAddSimpleRow(btn.dataset.target));
  });
  function dtCollectSimpleList(containerId){
    return Array.from($(containerId).querySelectorAll('textarea')).map(t=>t.value.trim()).filter(Boolean);
  }

  $('dtReqOthers').addEventListener('change', function(){
    $('dtReqOthersDetailWrap').style.display = this.checked ? '' : 'none';
  });

  // ---- lightweight customer autocomplete scoped to this form's own fields ----
  // ---------- Equipment picker for Dispatch Ticket ----------
  // Deliberately independent state from Service Report's equipment picker
  // (not sharing currentCustomerId/currentEquipmentCache) — Dispatch and
  // Service Report can each have their own form mid-edit, and sharing that
  // global state would let one screen's customer selection silently
  // overwrite the other's equipment list. Both read/write the same
  // customer_equipment table underneath, so equipment entered on a dispatch
  // ticket shows up for technicians on Service Report later, and vice versa.
  let dtCurrentCustomerId = null;
  let dtCurrentEquipmentCache = [];
  let dtCurrentEquipTab = null;
  // Multi-equipment draft state for the ticket currently being built — each
  // item becomes its own Service Report later, so each carries its own scope
  // (seeded from the Default Scope list at the moment it's added, then
  // independently editable per unit).
  let dtDraftEquipItems = [];
  function dtGenEquipId(){ return 'de-'+Date.now()+'-'+Math.random().toString(36).slice(2,7); }
  function dtPickEquipFields(e){ const out={}; EQUIP_FIELD_KEYS.forEach(k=> out[k]=e[k]||''); return out; }
  function dtEquipKey(fields){ return EQUIP_FIELD_KEYS.map(k=>(fields[k]||'').trim()).join('|'); }
  async function dtLoadCustomerEquipment(customerId){
    dtCurrentCustomerId = customerId;
    if(!customerId){ dtCurrentEquipmentCache = []; return; }
    if(await ensureCloud()){
      try{
        const { data, error } = await db.from('customer_equipment').select('*').eq('customer_id', customerId);
        if(error) throw error;
        dtCurrentEquipmentCache = (data||[]).map(equipRowToObj);
        return;
      }catch(e){ console.error('load dispatch equipment failed', describeCloudError(e)); }
    }
    dtCurrentEquipmentCache = [];
  }
  // Leads with equipDisplayName() (core.js) — same convention as
  // equipSummaryLine() in customers.js — so a unit's label (or, until one's
  // set, its shortened fixed id) is visible everywhere a dispatch ticket
  // lists equipment, not just in the admin/customer-portal equipment views.
  function dtEquipSummaryLine(e){
    const name = equipDisplayName(e);
    // equipDisplayName() falls back to equipLocation when a unit has no
    // label, so listing equipLocation in the details too printed it twice
    // ("Bible House — Bible House · Koppel · ..."). Include it only when
    // it isn't already doing duty as the name.
    const loc = (e.equipLocation||'').trim();
    const parts = (loc && loc !== name) ? [loc] : [];
    const rest = parts.concat([e.brand, e.mountType, e.equipType, e.coolCap])
      .filter(Boolean).join('  ·  ') || '(no details on file)';
    return name + '  —  ' + rest;
  }
  // Checkbox multi-select — lets an admin add several (or all) of a
  // customer's known units to this ticket in one pass instead of loading
  // them into the single-equipment fields one at a time.
  function dtRenderEquipPicker(){
    const list = $('dtEquipPickerList');
    list.innerHTML = '';
    if(!dtCurrentCustomerId){
      list.innerHTML = '<div class="combo-empty">Select a customer first.</div>';
      return;
    }
    if(dtCurrentEquipmentCache.length===0){
      list.innerHTML = '<div class="combo-empty">No equipment on file yet for this customer — tap "+ Add New" to add one.</div>';
      return;
    }
    const addedKeys = new Set(dtDraftEquipItems.map(it=> dtEquipKey(it)));
    dtCurrentEquipmentCache.forEach(e=>{
      const already = addedKeys.has(dtEquipKey(e));
      const row = document.createElement('label');
      row.className = 'chk';
      row.style.cssText = 'display:flex; border:1px solid var(--border); border-radius:8px; margin-bottom:6px; padding:10px;'+(already?' opacity:.6;':'');
      row.innerHTML = '<input type="checkbox" value="'+e.id+'"'+(already?' disabled checked':'')+'><span>'+escapeHtml(dtEquipSummaryLine(e))+(already?' (already added)':'')+'</span>';
      list.appendChild(row);
    });
  }
  function dtEquipCountLabel(){
    $('dtEquipCount').textContent = dtDraftEquipItems.length===0
      ? 'No equipment added yet'
      : (dtDraftEquipItems.length+' equipment added to this ticket');
  }
  // Appends one equipment line item as its own card with an independent,
  // always-editable Scope of Service list — seeded from the Default Scope
  // list at the moment of adding. Appending (never re-rendering the whole
  // list) means adding/removing one item never wipes another item's
  // in-progress scope edits.
  function dtAppendEquipItemCard(item){
    const wrap = $('dtEquipItemsList');
    const empty = wrap.querySelector('.empty-state');
    if(empty) empty.remove();
    const scopeId = 'dtEquipScope-'+item.id;
    const card = document.createElement('div');
    card.className = 'user-card';
    card.style.marginBottom = '8px';
    card.dataset.equipId = item.id;
    card.innerHTML = '<div class="user-card-head"><div><div class="u-name">'+escapeHtml(dtEquipSummaryLine(item))+'</div></div></div>'+
      '<div class="field" style="margin-top:6px; margin-bottom:6px;">'+
        '<label style="font-size:12px;">Scope of Service for this unit</label>'+
        '<div id="'+scopeId+'"></div>'+
      '</div>';
    const rmBtn = document.createElement('button');
    rmBtn.type = 'button'; rmBtn.className = 'rm-btn'; rmBtn.textContent = 'Remove';
    rmBtn.style.cssText = 'width:auto; padding:4px 10px;';
    rmBtn.addEventListener('click', ()=>{
      dtDraftEquipItems = dtDraftEquipItems.filter(x=> x.id!==item.id);
      card.remove();
      dtEquipCountLabel();
      if(dtDraftEquipItems.length===0) wrap.innerHTML = '<div class="empty-state">No equipment added yet.</div>';
      dtRenderEquipPicker();
    });
    card.querySelector('.user-card-head').appendChild(rmBtn);
    const scopeBtn = document.createElement('button');
    scopeBtn.type = 'button'; scopeBtn.className = 'add-row-btn'; scopeBtn.textContent = '+ Add scope item';
    scopeBtn.addEventListener('click', ()=> dtAddSimpleRow(scopeId));
    card.querySelector('.field').appendChild(scopeBtn);
    wrap.appendChild(card);
    const defaults = dtCollectSimpleList('dtDefaultScopeList');
    if(defaults.length) defaults.forEach(v=> dtAddSimpleRow(scopeId, v));
    else dtAddSimpleRow(scopeId);
    dtEquipCountLabel();
  }
  async function dtAddEquipItemFromFields(){
    const fields = dtCollectEquipmentFields();
    if(!EQUIP_FIELD_KEYS.some(k=>fields[k])){ toast('Enter at least one equipment detail'); return; }
    const item = Object.assign({id: dtGenEquipId()}, fields);
    dtDraftEquipItems.push(item);
    dtAppendEquipItemCard(item);
    // Genuinely new content (this is the "+ Add New" path) — insert it now
    // and stamp the real id straight onto this same item object (mutated
    // in place, since it's already the one sitting in dtDraftEquipItems).
    if(dtCurrentCustomerId) await dtAddCustomerEquipmentBatch(dtCurrentCustomerId, [item]);
    dtResetEquipmentFields();
    toast('Equipment added to ticket');
  }
  function dtAddSelectedExistingEquip(){
    const checked = Array.from($('dtEquipPickerList').querySelectorAll('input:checked:not(:disabled)'));
    if(checked.length===0){ toast('Select at least one'); return; }
    checked.forEach(cb=>{
      const e = dtCurrentEquipmentCache.find(x=> x.id===cb.value);
      if(!e) return;
      // Carries the real customer_equipment.id straight through as
      // equipmentId — this is an explicit "it's already on file" pick, so
      // dtAddCustomerEquipmentBatch() will skip it entirely rather than
      // re-deriving (or re-verifying) sameness from its fields.
      const item = Object.assign({id: dtGenEquipId(), equipmentId: e.id}, dtPickEquipFields(e));
      dtDraftEquipItems.push(item);
      dtAppendEquipItemCard(item);
    });
    dtRenderEquipPicker();
    toast(checked.length+' equipment added');
  }
  function dtAddAllExistingEquip(){
    const addedKeys = new Set(dtDraftEquipItems.map(it=> dtEquipKey(it)));
    let count = 0;
    dtCurrentEquipmentCache.forEach(e=>{
      const key = dtEquipKey(e);
      if(addedKeys.has(key)) return;
      const item = Object.assign({id: dtGenEquipId(), equipmentId: e.id}, dtPickEquipFields(e));
      dtDraftEquipItems.push(item);
      dtAppendEquipItemCard(item);
      addedKeys.add(key);
      count++;
    });
    dtRenderEquipPicker();
    toast(count>0 ? ('Added '+count+' equipment from file') : 'All equipment on file is already added');
  }
  $('dtAddEquipItemBtn').addEventListener('click', dtAddEquipItemFromFields);
  $('dtAddSelectedEquipBtn').addEventListener('click', dtAddSelectedExistingEquip);
  $('dtAddAllEquipBtn').addEventListener('click', dtAddAllExistingEquip);
  function dtSetEquipTab(tab){
    dtCurrentEquipTab = tab;
    $('dtEquipTabExisting').classList.toggle('active', tab==='existing');
    $('dtEquipTabAddNew').classList.toggle('active', tab==='addnew');
    if(tab==='existing'){
      if(!dtCurrentCustomerId){ toast('Select a customer first'); dtCurrentEquipTab='addnew'; $('dtEquipTabExisting').classList.remove('active'); $('dtEquipTabAddNew').classList.add('active'); }
      $('dtEquipPickerPanel').style.display = dtCurrentEquipTab==='existing' ? '' : 'none';
      $('dtEquipFieldsWrap').style.display = dtCurrentEquipTab==='existing' ? 'none' : '';
      if(dtCurrentEquipTab==='existing') dtRenderEquipPicker();
    }else if(tab==='addnew'){
      $('dtEquipPickerPanel').style.display = 'none';
      $('dtEquipFieldsWrap').style.display = '';
    }else{
      $('dtEquipPickerPanel').style.display = 'none';
      $('dtEquipFieldsWrap').style.display = 'none';
    }
  }
  function dtDefaultEquipTabForCustomer(){
    dtSetEquipTab(dtCurrentEquipmentCache.length>0 ? 'existing' : 'addnew');
  }
  function dtCollectEquipmentFields(){
    const fields = {};
    EQUIP_FIELD_KEYS.forEach(k=>{ const el=$('dt'+k.charAt(0).toUpperCase()+k.slice(1)); fields[k] = el ? el.value.trim() : ''; });
    return fields;
  }
  function dtResetEquipmentFields(){
    EQUIP_FIELD_KEYS.forEach(k=>{ const el=$('dt'+k.charAt(0).toUpperCase()+k.slice(1)); if(el) el.value=''; });
  }
  // Ensures every item in a batch (a dispatch ticket's equipmentList, or a
  // single item just added via "+ Add New") has a real customer_equipment.id
  // attached as item.equipmentId — mutating each item object in place.
  // Fixed 2026-09, twice over:
  // 1) This used to be dtAddCustomerEquipmentIfNew(), called once per item
  //    via equipmentList.forEach(item=> dtAddCustomerEquipmentIfNew(custId,
  //    item)) — forEach doesn't await its (async) callback, so every call
  //    for a multi-item ticket ran concurrently against the same stale
  //    snapshot of dtCurrentEquipmentCache.
  // 2) The fix for that still decided "is this new?" by comparing field
  //    values against what's already on file — which is the wrong
  //    question. Whether an item needs a new row is decided once, up
  //    front, by which action added it: dtAddSelectedExistingEquip() /
  //    dtAddAllExistingEquip() stamp the real id straight from the picked
  //    record (item.equipmentId already set, nothing to do here); only
  //    "+ Add New" items reach this function without one, and those are
  //    unconditionally new — inserted with no comparison against existing
  //    rows at all, exactly like cloudAddCustomerEquipment() (customers.js).
  async function dtAddCustomerEquipmentBatch(customerId, items){
    const toInsert = items.filter(it=> !it.equipmentId);
    if(!customerId || toInsert.length===0) return;
    if(!(await ensureCloud())) return;
    for(const item of toInsert){
      const hasAnyValue = EQUIP_FIELD_KEYS.some(k=> (item[k]||'').trim());
      if(!hasAnyValue) continue;
      const rec = { customer_id: customerId };
      EQUIP_FIELD_KEYS.forEach(k=> rec[EQUIP_FIELD_TO_COLUMN[k]] = item[k]||'');
      try{
        const { data: inserted, error } = await db.from('customer_equipment').insert(rec).select('id').single();
        if(error) throw error;
        item.equipmentId = inserted.id;
        if(customerId === dtCurrentCustomerId) dtCurrentEquipmentCache.push(equipRowToObj(Object.assign({}, rec, { id: inserted.id })));
      }catch(e){ console.error('add dispatch equipment failed', describeCloudError(e)); }
    }
  }

  function dtSetupCustomerCombo(){
    const input = $('dtCustName');
    if(input.dataset.comboAttached) return;
    input.dataset.comboAttached = '1';
    const wrap = $('dtCustNameWrap');
    wrap.style.position = 'relative';
    input.classList.add('combo-input');
    const caret = document.createElement('button');
    caret.type = 'button'; caret.className = 'combo-caret'; caret.innerHTML = '&#9662;';
    wrap.appendChild(caret);
    const panel = document.createElement('div');
    panel.className = 'combo-panel';
    wrap.appendChild(panel);
    function fillFrom(c){
      input.value = c.name;
      input.dataset.customerId = c.id;
      $('dtSiteAddress').value = c.address||'';
      $('dtContactName').value = c.contactPerson||'';
      $('dtContactNo').value = c.contactNo||'';
      panel.classList.remove('open');
      dtResetEquipmentFields();
      dtLoadCustomerEquipment(c.id).then(dtDefaultEquipTabForCustomer);
    }
    // Typing after picking must drop the stored id, or the ticket silently
    // links to the PREVIOUS customer while displaying the new name.
    input.addEventListener('input', ()=>{
      const picked = (customersCache||[]).find(c=> String(c.id)===String(input.dataset.customerId||''));
      if(picked && input.value.trim() !== (picked.name||'').trim()) delete input.dataset.customerId;
    });
    function render(filterText){
      const q = (filterText||'').toLowerCase();
      const filtered = customersCache.filter(c=> c.name.toLowerCase().includes(q));
      panel.innerHTML = '';
      if(filtered.length===0){
        const empty = document.createElement('div');
        empty.className = 'combo-empty';
        empty.textContent = customersCache.length===0 ? 'No saved customers yet — just type the name' : 'No matches — new customer? Just fill in the fields below';
        panel.appendChild(empty);
      }
      filtered.slice(0,25).forEach(c=>{
        const row = document.createElement('div');
        row.className = 'combo-item';
        const span = document.createElement('span');
        span.textContent = c.name + (c.address ? '  —  '+c.address : '');
        row.appendChild(span);
        row.addEventListener('mousedown', (e)=> e.preventDefault());
        row.addEventListener('click', ()=> fillFrom(c));
        panel.appendChild(row);
      });
      panel.classList.add('open');
    }
    input.addEventListener('focus', ()=> render(input.value));
    input.addEventListener('input', ()=>{ delete input.dataset.customerId; render(input.value); });
    caret.addEventListener('click', (e)=>{
      e.preventDefault();
      if(panel.classList.contains('open')){ panel.classList.remove('open'); } else { render(input.value); input.focus(); }
    });
    document.addEventListener('click', (e)=>{ if(!wrap.contains(e.target)) panel.classList.remove('open'); });
    if(!$('dtEquipTabExisting').dataset.hooked){
      $('dtEquipTabExisting').dataset.hooked = '1';
      $('dtEquipTabExisting').addEventListener('click', ()=> dtSetEquipTab('existing'));
      $('dtEquipTabAddNew').addEventListener('click', ()=> dtSetEquipTab('addnew'));
      dtSetEquipTab(null);
    }
    attachDtEquipCombos();
  }

  // Links the "Equipment for this Job Order" fields (Equipment Type, Brand,
  // Mounting Type, etc.) to the same named suggestion lists the Service
  // Report's own Equipment section and the admin "Manage Equipment List →
  // Add" tab use (configured via Manage Dropdown Lists) — even though these
  // inputs have dt-prefixed ids, attachCombo's keyOverride lets a
  // differently-id'd input share a list. Guarded by attachCombo's own
  // dataset flag, so calling this more than once (e.g. every time the New
  // Job Order form is opened) is harmless.
  function attachDtEquipCombos(){
    const idFor = (key)=> 'dt'+key.charAt(0).toUpperCase()+key.slice(1);
    EQUIP_FIELD_KEYS.forEach(key=>{
      const el = $(idFor(key));
      if(el) attachCombo(el, key);
    });
  }

  async function dtRenderWorkerChecklist(){
    const box = $('dtWorkerChecklist');
    box.innerHTML = '<div class="empty-state">Loading technicians…</div>';
    const users = (await cloudListUsers()) || [];
    const active = users.filter(u=> u.active!==false);
    if(active.length===0){ box.innerHTML = '<div class="empty-state">No active technicians — add one under Manage Users.</div>'; return; }
    box.innerHTML = '';
    active.sort((a,b)=> a.name.localeCompare(b.name)).forEach(u=>{
      const lbl = document.createElement('label');
      lbl.className = 'chk';
      lbl.innerHTML = '<input type="checkbox" value="'+u.id+'" data-name="'+escapeHtml(u.name)+'"><span>'+escapeHtml(u.name)+'</span>';
      box.appendChild(lbl);
    });
    if(!box.dataset.hooked){
      box.dataset.hooked = '1';
      box.addEventListener('change', dtRenderReporterChecklist);
    }
    dtRenderReporterChecklist();
  }
  // The "who can create the Service Report" list is always a SUBSET of
  // whoever is currently checked in Assigned Workers — kept in sync live,
  // so admin can't accidentally authorize someone who isn't even assigned.
  function dtRenderReporterChecklist(){
    const assigned = Array.from($('dtWorkerChecklist').querySelectorAll('input:checked'))
      .map(el=>({id: el.value, name: el.dataset.name}));
    const box = $('dtReporterChecklist');
    const previouslyChecked = new Set(Array.from(box.querySelectorAll('input:checked')).map(el=>el.value));
    if(assigned.length===0){ box.innerHTML = '<div class="empty-state">Assign workers above first.</div>'; return; }
    box.innerHTML = '';
    assigned.forEach(w=>{
      const lbl = document.createElement('label');
      lbl.className = 'chk';
      const checked = previouslyChecked.has(w.id) ? ' checked' : '';
      lbl.innerHTML = '<input type="checkbox" value="'+w.id+'" data-name="'+escapeHtml(w.name)+'"'+checked+'><span>'+escapeHtml(w.name)+'</span>';
      box.appendChild(lbl);
    });
  }

  // ---------- Category (Aircon / Ventilation / General Scope) ----------
  // Required on every new ticket. Stored as data.category (a key from
  // SERVICE_CATEGORIES in core.js); technicians then only see this ticket
  // under the matching category when starting a Service Report.
  function dtGetCategory(){
    const on = $('dtCategoryGroup') && $('dtCategoryGroup').querySelector('.dt-cat-btn.active');
    return on ? on.dataset.cat : null;
  }
  function dtSetCategory(key){
    const g = $('dtCategoryGroup'); if(!g) return;
    g.classList.remove('invalid');
    g.querySelectorAll('.dt-cat-btn').forEach(b=>{
      const on = b.dataset.cat === key;
      b.classList.toggle('active', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    });
  }
  if($('dtCategoryGroup')){
    $('dtCategoryGroup').querySelectorAll('.dt-cat-btn').forEach(b=>{
      b.addEventListener('click', ()=> dtSetCategory(b.dataset.cat));
    });
  }
  // Small inline tag for list rows / card heads. Empty for legacy tickets.
  function dtCategoryTagHtml(r){
    const label = r && serviceCategoryLabel(r.category);
    return label ? '<span class="jo-cat-tag">'+escapeHtml(label)+'</span>' : '';
  }

  function dtResetForm(){
    dtSourceServiceRequestId = null;
    dtSetCategory(null);
    dtContinuedFromTicketId = null;
    $('dtJobOrderNo').value = '—';
    $('dtDate').value = todayISO();
    $('dtExpectedTime').value = '';
    $('dtCustName').value = ''; delete $('dtCustName').dataset.customerId;
    $('dtSiteAddress').value = '';
    $('dtContactName').value = ''; $('dtContactNo').value = '';
    dtResetEquipmentFields();
    dtLoadCustomerEquipment(null);
    dtSetEquipTab(null);
    $('dtDefaultScopeList').innerHTML=''; dtAddSimpleRow('dtDefaultScopeList');
    dtDraftEquipItems = [];
    $('dtEquipItemsList').innerHTML = '<div class="empty-state">No equipment added yet.</div>';
    dtEquipCountLabel();
    $('dtRemarks').value = '';
    ['dtReqWorkPermit','dtReqGatePass','dtReqSafety','dtReqOthers'].forEach(id=> $(id).checked=false);
    $('dtReqOthersDetail').value = '';
    $('dtReqOthersDetailWrap').style.display = 'none';
    dtRenderWorkerChecklist();
  }

  // Set by dtPrefillCreateFromServiceRequest below when the Create form was
  // opened from a customer's service request; dtCreateTicket's success path
  // uses it to call srLinkTicket() so the request follows the resulting
  // ticket (see also the completion-sync hook in dtComplete). Cleared by
  // dtResetForm so it never leaks onto an unrelated, later ticket.
  let dtSourceServiceRequestId = null;

  // Set by dtContinueClosedTicket below when the Create form was opened as
  // a "Continue Tomorrow" follow-up to an earlier, closed ticket that still
  // had unfinished equipment on it. dtCreateTicket's success path uses this
  // to stamp continuedTicketId back onto that earlier ticket. Cleared by
  // dtResetForm so it never leaks onto an unrelated, later ticket.
  let dtContinuedFromTicketId = null;

  // Opens the Create Dispatch Ticket tab with a customer service request's
  // details pre-filled, so admin can review/adjust and finish creating the
  // ticket the normal way (dtCreateTicket, above). Called from
  // service-requests.js srConvertToTicket() — this does not save a ticket
  // by itself. request: {id, customerId, equipmentId, description, urgency,
  // requestedDate} as shaped by service-requests.js srRowToRequest().
  async function dtPrefillCreateFromServiceRequest(request){
    await showDispatchView('new'); // already calls dtResetForm() internally via dtShowAdminTab('new')
    dtSourceServiceRequestId = request.id;
    if(request.customerId){
      // customersCache is populated by whichever screen loads it first
      // (see showDispatchView's own comment on this above); find the
      // matching name for the combo's text field.
      const cust = (typeof customersCache !== 'undefined' ? customersCache : []).find(c=> String(c.id)===String(request.customerId));
      if(cust){
        $('dtCustName').value = cust.name || '';
        $('dtCustName').dataset.customerId = cust.id;
        // Site address only ever comes from the customer's own record —
        // service_requests has no separate address field of its own.
        $('dtSiteAddress').value = cust.address || '';
        // Contact name/number: the request's own on-site contact (if the
        // customer filled it in) is more relevant to THIS job than the
        // customer's general on-file contact, so it takes priority.
        $('dtContactName').value = request.contactPerson || cust.contactPerson || '';
        $('dtContactNo').value = request.contactNumber || cust.contactNo || '';
        await dtLoadCustomerEquipment(cust.id);
      }
    }
    if(request.requestedDate) $('dtDate').value = request.requestedDate;
    // Reason for service — the request's description, as-is (no extra
    // narrative wrapping); the urgency tag stays since it's easy to miss
    // otherwise once this is sitting in a plain remarks box.
    const urgentPrefix = request.urgency==='urgent' ? '[URGENT] ' : '';
    $('dtRemarks').value = urgentPrefix + (request.description||'');
    // Access requirements the customer already flagged when filing the
    // request carry straight over — no reason to make admin re-enter them.
    $('dtReqGatePass').checked = !!request.accessGatePass;
    $('dtReqWorkPermit').checked = !!request.accessWorkPermit;
    $('dtReqOthers').checked = !!request.accessOthers;
    if(request.accessOthers){
      $('dtReqOthersDetail').value = request.accessOthersDetail || (request.accessLadder ? 'Ladder' : '');
      $('dtReqOthersDetailWrap').style.display = '';
    } else if(request.accessLadder){
      // Dispatch's requirement checklist has no dedicated "Ladder" option
      // (only Work Permit / Gate Pass / Safety / Others) — fold it into
      // Others rather than silently dropping it.
      $('dtReqOthers').checked = true;
      $('dtReqOthersDetail').value = 'Ladder';
      $('dtReqOthersDetailWrap').style.display = '';
    }
    toast('Review the pre-filled details, then create the ticket');
  }

  // Assigned technician names for one ticket — already denormalized right
  // onto the ticket's own JSON blob (assignedWorkerNames, set at creation —
  // see dtCreateTicket below), so this is a single-row fetch with no join
  // to a users table needed. Used by the customer portal's home-screen
  // "Active service" hero to show who's on the job.
  async function dtFetchTicketTechNames(ticketId){
    if(!ticketId || !(await ensureCloud())) return [];
    try{
      const { data, error } = await db.from('dispatch_tickets')
        .select('data').eq('id', ticketId).maybeSingle();
      if(error) throw error;
      return (data && data.data && data.data.assignedWorkerNames) || [];
    }catch(e){ console.error('fetch ticket technicians failed', describeCloudError(e)); return []; }
  }

  async function dtCreateTicket(){
    const workers = Array.from($('dtWorkerChecklist').querySelectorAll('input:checked'))
      .map(el=>({id: el.value, name: el.dataset.name}));
    const reporters = Array.from($('dtReporterChecklist').querySelectorAll('input:checked'))
      .map(el=>({id: el.value, name: el.dataset.name}));
    const custName = $('dtCustName').value.trim();
    const custId = $('dtCustName').dataset.customerId || null;
    // No confirm prompt here: a ticket is always raised against a customer
    // already on file, so custId being missing would be a bug to fix
    // rather than a choice to confirm. The real cause of dispatched jobs
    // not reaching the portal was a missing admin INSERT policy on
    // service_requests — see 20260916_04_admin_insert_service_requests.sql.
    if(workers.length===0){ toast('Assign at least one worker'); return; }
    if(reporters.length===0){ toast('Select at least one technician who can create the Service Report'); return; }
    const category = dtGetCategory();
    if(!category){
      toast('Select a category — Aircon, Ventilation or General Scope');
      if($('dtCategoryGroup')){
        $('dtCategoryGroup').classList.add('invalid');
        $('dtCategoryGroup').scrollIntoView({behavior:'smooth', block:'center'});
      }
      return;
    }
    if(!custName){ toast('Enter the customer\'s name'); return; }
    if(!$('dtDate').value){ toast('Set the date'); return; }
    if(dtDraftEquipItems.length===0){ toast('Add at least one piece of equipment to the ticket'); return; }
    $('dtCreateBtn').disabled = true; $('dtCreateBtn').textContent = 'Creating…';
    const jobOrderNo = await dtNextJobOrderNo();
    const id = jobOrderNo || dtGenLocalId();
    // One line item per piece of equipment, each with its own scope — one
    // Service Report gets filed per item later, tracked via reportSrNo.
    const equipmentList = dtDraftEquipItems.map(item=>{
      const scope = dtCollectSimpleList('dtEquipScope-'+item.id);
      return Object.assign({}, item, { scope, reportSrNo: null });
    });
    // Catch-all: every item should already carry equipmentId by now (set
    // the moment it was added — see dtAddEquipItemFromFields/
    // dtAddSelectedExistingEquip/dtAddAllExistingEquip above), but this is
    // a no-op for anything that does and a last chance for anything that
    // doesn't (e.g. the earlier insert failed offline and connectivity has
    // since come back) — done BEFORE the ticket saves, so equipmentList
    // is stored with every real id already attached.
    if(custId) await dtAddCustomerEquipmentBatch(custId, equipmentList);
    const data = {
      id, jobOrderNo: id, status: 'preparing',
      category,
      date: $('dtDate').value, expectedTime: $('dtExpectedTime').value,
      assignedWorkerIds: workers.map(w=>w.id), assignedWorkerNames: workers.map(w=>w.name),
      reportAllowedWorkerIds: reporters.map(w=>w.id), reportAllowedWorkerNames: reporters.map(w=>w.name),
      custName, siteAddress: $('dtSiteAddress').value.trim(),
      contactName: $('dtContactName').value.trim(), contactNo: $('dtContactNo').value.trim(),
      equipment: equipmentList.map(dtEquipSummaryLine), equipmentList,
      remarks: $('dtRemarks').value.trim(),
      requirements: {
        workPermit: $('dtReqWorkPermit').checked, gatePass: $('dtReqGatePass').checked,
        safety: $('dtReqSafety').checked, others: $('dtReqOthers').checked,
        othersDetail: $('dtReqOthersDetail').value.trim()
      },
      // Server time, like every other lifecycle timestamp — a device with a
      // skewed clock would otherwise stamp a creation time that disagrees
      // with the acknowledgement and arrival times recorded against it.
      createdAt: serverNowISO(),
      createdBy: currentUser ? currentUser.name : 'Admin',
      acknowledgedBy: [], acknowledgedAt: null, arrivedAt: null, arrivedBy: null, arrivedById: null, completedAt: null,
      // Initialised so the reassignment audit trail and the replaced-
      // technician read path (dispatch_select_assigned matches on
      // removedWorkerIds) never have to cope with a missing key.
      removedWorkerIds: [], removedWorkers: [],
      // Denormalized so a later "Continue Tomorrow" (see dtContinueClosedTicket)
      // can prefill straight from this ticket and re-link the follow-up ticket
      // to the same originating request, without a round trip to fetch it.
      custId: custId || null,
      sourceServiceRequestId: dtSourceServiceRequestId || null,
      // Set only when this ticket was itself created via "Continue Tomorrow"
      // from an earlier, closed ticket — see dtContinueClosedTicket below,
      // which stamps the reverse pointer (continuedTicketId) onto that
      // earlier ticket right after this one saves successfully.
      continuedFromTicketId: dtContinuedFromTicketId || null
    };
    const res = await dtSaveTicket(id, data);
    $('dtCreateBtn').disabled = false; $('dtCreateBtn').textContent = 'Create Dispatch Ticket';
    if(res===SAVE_FAILED){ toast('Could not create ticket — check your connection'); return; }
    toast(res===SAVE_CLOUD
      ? ('Dispatch ticket '+id+' created')
      : ('Ticket '+id+' saved on this device — technicians will see it once you are online'));
    // If this ticket was created from a customer's service request (see
    // dtPrefillCreateFromServiceRequest above), link the two so the
    // request's status follows the ticket from here on (srLinkTicket sets
    // it to 'dispatched' now; dtAcknowledge's hook takes it to
    // 'in_progress' once a technician acknowledges, and dtComplete's
    // completion hook takes it to 'completed' later). Best-effort — an
    // ordinary ticket with no source request just leaves this as a no-op.
    // Real OS notifications (see push.js). Best-effort and never awaited —
    // the ticket has already saved and must not fail on a notification.
    if(typeof notifyUser === 'function'){
      (workers||[]).forEach(w=>{
        notifyUser(w.id, 'New job order assigned',
          jobOrderNo+' \u2014 '+(custName||'')+' on '+($('dtDate').value||''), 'jo-new');
      });
    }
    if(custId && typeof notifyCustomer === 'function'){
      notifyCustomer(custId, 'A technician has been scheduled',
        'Your service is scheduled for '+($('dtDate').value||'')+'.', 'jo-dispatched');
    }
    if(dtSourceServiceRequestId && typeof srLinkTicket === 'function'){
      srLinkTicket(dtSourceServiceRequestId, id).catch(()=>{});
    }else if(custId && typeof srCreateForAdminDispatch === 'function'){
      // No originating request — admin scheduled this directly. The
      // customer's home screen reads service_requests only, so without a
      // row here the job is invisible to them: no active-service card, no
      // progress tracker, no technician name, nothing to message about.
      // Create one, already 'dispatched' and linked, so every existing
      // customer-facing behaviour works for this ticket too. Best-effort:
      // the ticket itself has already saved and must not fail on this.
      // Equipment is only carried over when the ticket covers exactly one
      // unit — the request row holds a single equipment_id, so guessing on
      // a multi-unit ticket would misattribute it.
      const singleEquipId = (equipmentList.length===1 && equipmentList[0].equipmentId)
        ? equipmentList[0].equipmentId : null;
      srCreateForAdminDispatch({
        customerId: custId,
        equipmentId: singleEquipId,
        ticketId: id,
        description: $('dtRemarks').value.trim() || ('Scheduled service visit — '+jobOrderNo),
        requestedDate: $('dtDate').value || null
      }).then(row=>{
        // Silent failure here is what makes this look like "dispatch just
        // doesn't reach the customer" — surface it so it can be fixed.
        if(!row) toast('Job order saved, but the customer portal entry could not be created — they will not see this job');
      }).catch(()=>{});
    }
    // Mirrors the srLinkTicket call above, for the "Continue Tomorrow" case:
    // best-effort, never blocks the ticket that DID just save successfully.
    if(dtContinuedFromTicketId){
      (async ()=>{
        try{
          const prev = await dtGetTicket(dtContinuedFromTicketId);
          if(!prev) return;
          const merged = Object.assign({}, prev, { continuedTicketId: id });
          await db.from('dispatch_tickets').update({ data: merged }).eq('id', dtContinuedFromTicketId);
        }catch(e){ console.error('stamp continuedTicketId failed', describeCloudError(e)); }
      })();
    }
    dtResetForm();
    $('dtJobOrderNo').value = '—';
  }
  $('dtCreateBtn').addEventListener('click', dtCreateTicket);

  function dtReqSummary(r){
    const items = [];
    if(r.requirements){
      if(r.requirements.workPermit) items.push('Work Permit');
      if(r.requirements.gatePass) items.push('Gate Pass');
      if(r.requirements.safety) items.push('Safety');
      if(r.requirements.others) items.push('Others'+(r.requirements.othersDetail ? (' ('+escapeHtml(r.requirements.othersDetail)+')') : ''));
    }
    return items.length ? items.join(', ') : 'None specified';
  }
  // ---------- Computed lifecycle status ----------
  // Two of the stages are never stored, only derived on every render from
  // the server-anchored business date (see todayISO in core.js):
  //
  //   PREPARING — true on the scheduled day, before anyone acknowledges.
  //     Deriving it means no midnight job has to run and then be monitored;
  //     a ticket created on the 20th for the 25th simply starts rendering
  //     as Preparing on the 25th, untouched in the database. It also
  //     self-corrects when admin edits the scheduled date, where a stored
  //     value would need a cleanup pass.
  //
  //   EXPIRED — the scheduled day ended with NOBODY having acknowledged.
  //     This is narrower than it used to be: expiry keyed on "past due and
  //     not finished", which killed jobs that were legitimately acknowledged
  //     and still running past midnight. Multi-day work is normal, so only
  //     an untouched job order expires now.
  //
  // Neither writes to the row, so nothing needs cleaning up if a date moves.
  // ---------- The acknowledgement window ----------
  // Anchored to the APPOINTMENT, not the calendar day. Keying off the date
  // alone broke late-night work: a job order scheduled 11:59pm was
  // acknowledgeable only during that calendar day, so a crew arriving at
  // 12:02am found it already expired — permanently, with no report
  // possible. For after-hours plant and building work that is the normal
  // case, not an edge case.
  //
  //   opens    = scheduled time - 4h   (Preparing begins, Acknowledge unlocks)
  //   expires  = scheduled time + 8h   (only if NOBODY acknowledged)
  //
  // 4 hours ahead lets a crew accept the job while travelling; 8 hours
  // after means someone held up on an earlier call can still take it,
  // without an abandoned job order lingering into the next afternoon.
  const DT_WINDOW_OPEN_HOURS = 4;
  const DT_EXPIRE_HOURS = 8;
  // The Philippines has no daylight saving, so a fixed offset is exact
  // year-round and avoids parsing a local-time string through the device's
  // own timezone — which is the thing we don't trust.
  const BUSINESS_TZ_OFFSET = '+08:00';

  function dtNowMs(){ return new Date(serverNowISO()).getTime(); }
  // Returns { opens, expires } in ms, or null when the ticket has no date.
  function dtWindow(r){
    if(!r || !r.date) return null;
    if(r.expectedTime){
      const at = new Date(r.date+'T'+r.expectedTime+':00'+BUSINESS_TZ_OFFSET).getTime();
      if(!isFinite(at)) return null;
      return { opens: at - DT_WINDOW_OPEN_HOURS*3600000, expires: at + DT_EXPIRE_HOURS*3600000 };
    }
    // No time given — the field has always been optional and plenty of
    // existing tickets have it blank. Those get the whole scheduled day
    // plus the same 8 hours, which is strictly MORE generous than the old
    // midnight cutoff, so nothing in the database becomes unacknowledgeable
    // the moment this ships.
    const dayStart = new Date(r.date+'T00:00:00'+BUSINESS_TZ_OFFSET).getTime();
    if(!isFinite(dayStart)) return null;
    return { opens: dayStart, expires: dayStart + 24*3600000 + DT_EXPIRE_HOURS*3600000 };
  }
  // Past its window with nobody having acknowledged.
  function dtIsPastDue(r){
    const w = dtWindow(r);
    return !!w && dtNowMs() > w.expires;
  }
  // Before the window opens a ticket shows no status label at all — it
  // isn't due yet, and labelling it invites a technician to act early.
  function dtIsFuture(r){
    const w = dtWindow(r);
    return !!w && dtNowMs() < w.opens;
  }
  // For the "come back on the day" note — says the hour, not just the date,
  // now that the hour is what actually governs.
  function dtWindowOpensText(r){
    const w = dtWindow(r);
    if(!w) return '';
    const d = new Date(w.opens);
    const day = new Intl.DateTimeFormat('en-PH', { timeZone: BUSINESS_TZ, month:'short', day:'numeric' }).format(d);
    const time = new Intl.DateTimeFormat('en-PH', { timeZone: BUSINESS_TZ, hour:'numeric', minute:'2-digit', hour12:true }).format(d);
    return day+' at '+time;
  }
  function dtHasAnyAck(r){ return ((r.acknowledgedBy||[]).length > 0); }
  // Expiry is TERMINAL: a job order whose scheduled day passed with no
  // acknowledgement means the visit never happened, and there's no
  // attendance record for that day to back it up. Letting it be
  // acknowledged or reported on afterwards would record a site visit that
  // didn't occur, so every action is blocked and admin raises a fresh job
  // order instead. dtIsTerminal is the single check the list filters,
  // action buttons and report picker all share.
  function dtIsTerminal(r){
    return ['completed','closed','cancelled','expired','replaced'].includes(dtEffectiveStatus(r));
  }
  function dtIsExpired(r){ return dtEffectiveStatus(r)==='expired'; }
  function dtEffectiveStatus(r){
    // 'replaced' is PER-VIEWER and deliberately checked first: the ticket
    // itself is alive and unchanged for the crew still on it — only the
    // technician who was swapped out sees it as finished. Admin never sees
    // this branch (dtRemovalFor keys off the viewer's own id), so the
    // admin list and filters keep showing the ticket's real status.
    if(currentUser && dtRemovalFor(r, currentUser.id)) return 'replaced';
    // Stored terminal states win over anything computed.
    if(r.status==='closed' || r.status==='cancelled' || r.status==='completed') return r.status;
    // Stored in-flight states. Once someone has acknowledged or arrived,
    // the date no longer decides anything — the work is underway and runs
    // until it's resolved, however many days that takes.
    if(r.status==='in_progress') return 'in_progress';
    if(r.status==='acknowledged') return 'acknowledged';
    // Nothing stored beyond 'open'/'preparing', so the date decides.
    if(dtIsPastDue(r)) return dtHasAnyAck(r) ? 'acknowledged' : 'expired';
    if(dtIsFuture(r)) return 'scheduled';
    return 'preparing';
  }
  // Legacy rows created before the lifecycle change carry status 'open'.
  // dtEffectiveStatus maps those onto the new stages by date, so no
  // destructive backfill is needed — see dtNormalizeTicket for the same
  // approach applied to pre-equipmentList tickets.
  function dtStatusPill(r){
    const status = dtEffectiveStatus(r);
    if(status==='replaced') return '<span class="status-pill" style="background:#E4E7E4; color:#4A524B;">Status: Closed — Replaced</span>';
    if(status==='cancelled') return '<span class="status-pill" style="background:#F8D7DA; color:#B02A37;">Status: Cancelled</span>';
    if(status==='expired') return '<span class="status-pill" style="background:#F8D7DA; color:#B02A37;">Status: Expired</span>';
    if(status==='closed'){
      const hasExceptions = (r.equipmentList||[]).some(it=> it.notDone);
      return '<span class="status-pill" style="background:#E4E7E4; color:#4A524B;">Status: Closed'+(hasExceptions ? ' \u26A0' : '')+'</span>';
    }
    // Admin reviews a Completed job order before closing it, so the same
    // stage is labelled for what each side is meant to do with it.
    if(status==='completed'){
      const label = (currentUser && currentUser.role==='admin') ? 'For Review' : 'Completed';
      return '<span class="status-pill" style="background:#DCEFE5; color:#1F7A52;">Status: '+label+'</span>';
    }
    if(status==='in_progress') return '<span class="status-pill" style="background:#E4F0F1; color:#1F6F7A;">Status: Work in Progress</span>';
    if(status==='acknowledged') return '<span class="status-pill" style="background:#DCEAE0; color:var(--green-dark);">Status: En Route</span>';
    if(status==='preparing') return '<span class="status-pill" style="background:#FBF0DC; color:#B9791F;">Status: Preparing</span>';
    // Future-dated: deliberately no "Status:" prefix — it isn't in the
    // lifecycle yet, it's just booked.
    return '<span class="status-pill status-draft">Scheduled</span>';
  }
  // Shows every equipment item on the ticket with its own scope and
  // report status, capped so a 100-unit ticket doesn't blow up the card —
  // the full list is still reachable via the technician's equipment
  // checklist when filing reports. Each row is a link (data-ticket-id /
  // data-equip-idx) opening dtOpenEquipDetailOverlay with that unit's full
  // record — see the click delegation on #dtAdminList/#dtTechList below,
  // since dtCardHtml's result is injected via innerHTML rather than built
  // as live DOM nodes, so individual listeners can't be attached here.
  function dtEquipmentSummaryBlock(r){
    const items = r.equipmentList || [];
    if(items.length===0) return '';
    // Counts RESOLVED, not merely reported: a unit flagged Not Yet Done is
    // a finished question, and it is what auto-completion counts too, so
    // the header has to agree or a ticket completes at "3 of 5".
    const resolved = items.filter(it=> it.reportSrNo || it.notDone).length;
    // Flagging belongs to the technician doing the visit, and only while
    // the visit is happening. Admin resolves exceptions at review instead.
    const canFlag = currentUser && currentUser.role!=='admin' &&
      dtEffectiveStatus(r)==='in_progress' && !dtRemovalFor(r, currentUser.id) &&
      (r.assignedWorkerIds||[]).includes(currentUser.id);
    const cap = 8;
    const rows = items.slice(0,cap).map((it,i)=>{
      const scope = (it.scope||[]).map(escapeHtml).join('; ');
      let state = '';
      if(it.reportSrNo) state = ' <span style="color:var(--green-dark);">&#10003; Reported</span>';
      else if(it.notDone) state = ' <span style="color:var(--amber);">&#9888; Not yet done</span>';
      // Only ONE control per row, chosen by the unit's state — a reported
      // unit gets neither, so there is no path to flag work that is already
      // filed.
      let action = '';
      if(canFlag && it.notDone){
        action = '<button type="button" class="dt-equip-undo secondary" data-ticket-id="'+escapeHtml(r.id)+'" data-equip-id="'+escapeHtml(it.id)+'" '+
          'style="margin-top:4px; font-size:11.5px; padding:4px 10px;">Undo — I can do this one</button>';
      }else if(canFlag && !it.reportSrNo){
        action = '<button type="button" class="dt-equip-notdone" data-ticket-id="'+escapeHtml(r.id)+'" data-equip-id="'+escapeHtml(it.id)+'" '+
          'style="margin-top:4px; font-size:11.5px; padding:4px 10px;">Can\'t do this one</button>';
      }
      return '<div style="margin:4px 0; padding-left:8px; border-left:2px solid var(--border);">'+
        '<div class="dt-equip-row" data-ticket-id="'+escapeHtml(r.id)+'" data-equip-idx="'+i+'" style="cursor:pointer;">'+
          '<div>'+escapeHtml(dtEquipSummaryLine(it))+state+
            ' <span style="color:var(--green-dark); text-decoration:underline; font-size:12px;">View details ›</span></div>'+
          (scope ? '<div style="font-size:12px; color:var(--text-muted);">Scope: '+scope+'</div>' : '')+
        '</div>'+
        (it.notDone && it.notDoneReason ? '<div style="font-size:12px; color:var(--amber);">Reason: '+escapeHtml(it.notDoneReason)+'</div>' : '')+
        action+
      '</div>';
    }).join('') + (items.length>cap ? '<div style="font-size:12px; color:var(--text-muted);">+'+(items.length-cap)+' more…</div>' : '');
    return '<div class="leave-comment"><b>Equipment ('+resolved+' of '+items.length+' resolved)</b>'+rows+'</div>';
  }
  // Full-detail view for one equipment line item — every field the
  // Equipment Information section of a Service Report would show, plus
  // this unit's Scope of Service and its report status on this ticket.
  const DT_EQUIP_DETAIL_KEYS = [
    'equipType','brand','mountType','coolCap','modelCU','serialCU',
    'modelFCU','serialFCU','refrigerantType','compressorType','equipLocation'
  ];
  function dtOpenEquipDetailOverlay(ticket, item){
    if(!item) return;
    $('dtEquipDetailTitle').textContent = dtEquipSummaryLine(item);
    // Fixed "Equipment ID" row — always the raw id (equipShortId), same as
    // the admin equipment detail overlay's own read-only ID row, plus the
    // customer label alongside it (if set) so a technician sees both
    // without having to leave the dispatch ticket.
    const idRows = '<div class="equip-detail-row"><span class="equip-detail-label">Equipment ID</span><span style="font-family:monospace;">'+escapeHtml(equipShortId(item))+'</span></div>'+
      (item.label ? '<div class="equip-detail-row"><span class="equip-detail-label">Customer Label</span><span>'+escapeHtml(item.label)+'</span></div>' : '');
    const fieldRows = idRows + DT_EQUIP_DETAIL_KEYS.map(k=>{
      const val = (item[k]||'').toString().trim();
      if(!val) return '';
      const label = (FIELD_META[k] && FIELD_META[k].label) || k;
      return '<div class="equip-detail-row"><span class="equip-detail-label">'+escapeHtml(label)+'</span><span>'+escapeHtml(val)+'</span></div>';
    }).join('');
    const scope = (item.scope||[]).map(escapeHtml).join('; ');
    const scopeRow = scope ? '<div class="equip-detail-row"><span class="equip-detail-label">Scope of Service</span><span>'+scope+'</span></div>' : '';
    const statusRow = item.reportSrNo
      ? '<div class="equip-detail-row"><span class="equip-detail-label">Report</span><span>'+escapeHtml(item.reportSrNo)+' — Reported</span></div>'
      : item.draftSrNo
        ? '<div class="equip-detail-row"><span class="equip-detail-label">Report</span><span>'+escapeHtml(item.draftSrNo)+' — Draft saved</span></div>'
        : '<div class="equip-detail-row"><span class="equip-detail-label">Report</span><span>Not started yet</span></div>';
    $('dtEquipDetailBody').innerHTML = (fieldRows || '<div class="empty-state">No equipment details on file.</div>') + scopeRow + statusRow;
    $('dtEquipDetailOverlay').classList.add('open');
  }
  $('closeDtEquipDetail').addEventListener('click', ()=> $('dtEquipDetailOverlay').classList.remove('open'));
  $('dtEquipDetailOverlay').addEventListener('click', (e)=>{ if(e.target.id==='dtEquipDetailOverlay') $('dtEquipDetailOverlay').classList.remove('open'); });
  // Both admin's "All" tab and a technician's "My Job Order" tab render
  // dtCardHtml() straight into innerHTML, so a single delegated listener per
  // list (rather than one per row) is what actually gets a click on a
  // "View details" row, or the "Open Job Order" button. dtLastTicketsById is
  // refreshed by whichever render function ran most recently, so a click
  // always resolves against what's currently on screen.
  let dtLastTicketsById = {};
  // Per-card expand/collapse for the job order list rows — independent
  // toggles (not an accordion like the Service Report form's collapsible
  // sections), so a technician can have several open at once while
  // scanning. Delegated on the same listener as the other row clicks.
  function dtToggleCardBody(head, forceOpen){
    const body = head.nextElementSibling;
    if(!body || !body.classList.contains('jo-card-body')) return;
    const willOpen = forceOpen!==undefined ? forceOpen : body.style.display==='none';
    body.style.display = willOpen ? '' : 'none';
    const caret = head.querySelector('.jo-caret');
    if(caret) caret.innerHTML = icon('caretDown', willOpen ? 'style="transform:rotate(180deg);"' : '');
  }
  function dtHandleEquipRowClick(e){
    // Checked before the toggle header below: "Open Job Order" now lives
    // inside the same header element that carries data-jo-toggle (it sits to
    // the right of the title), so without this ordering a tap on the button
    // would match the ancestor's data-jo-toggle first and just expand the
    // card instead of opening the ticket.
    const openBtn = e.target.closest('[data-jo-open]');
    if(openBtn){
      e.stopPropagation();
      dtOpenTicketOverlay(openBtn.dataset.joOpen);
      return;
    }
    const toggleHead = e.target.closest('[data-jo-toggle]');
    if(toggleHead){
      // Everywhere else, each Job Order card expands/collapses independently
      // (a technician scanning several open tickets can leave more than one
      // expanded). The Schedule Calendar's day list is the one place that
      // should behave like an accordion — opening one Job Order there closes
      // any other one already open, so the day list stays scannable. This is
      // scoped to #dtCalDayList / #homeCalDayList only via e.currentTarget,
      // the list the listener is actually attached to.
      const listEl = e.currentTarget;
      const isCalendarList = listEl && (listEl.id==='dtCalDayList' || listEl.id==='homeCalDayList');
      if(isCalendarList){
        const body = toggleHead.nextElementSibling;
        const willOpen = !!(body && body.classList.contains('jo-card-body') && body.style.display==='none');
        listEl.querySelectorAll('.jo-card-toggle').forEach(h=>{ if(h!==toggleHead) dtToggleCardBody(h, false); });
        dtToggleCardBody(toggleHead, willOpen);
      }else{
        dtToggleCardBody(toggleHead);
      }
      return;
    }
    // Flag / un-flag are checked BEFORE the row handler: both buttons sit
    // inside the equipment block, and without this a tap would also open
    // the detail overlay on top of the prompt.
    const notDoneBtn = e.target.closest('.dt-equip-notdone');
    if(notDoneBtn){
      e.stopPropagation();
      const reason = prompt('Why can\'t this unit be serviced today?\n\nAdmin sees this when reviewing the job order, so be specific — "customer locked the plant room", "needs a part we don\'t carry".');
      // prompt returns null on Cancel and '' on an empty OK. Only the
      // second deserves a complaint; cancelling is not an error.
      if(reason === null) return;
      dtMarkEquipmentNotDone(notDoneBtn.dataset.ticketId, notDoneBtn.dataset.equipId, reason);
      return;
    }
    const undoBtn = e.target.closest('.dt-equip-undo');
    if(undoBtn){
      e.stopPropagation();
      dtClearEquipmentNotDone(undoBtn.dataset.ticketId, undoBtn.dataset.equipId);
      return;
    }
    const row = e.target.closest('.dt-equip-row');
    if(!row) return;
    e.stopPropagation();
    const ticket = dtLastTicketsById[row.dataset.ticketId];
    const item = ticket && (ticket.equipmentList||[])[Number(row.dataset.equipIdx)];
    dtOpenEquipDetailOverlay(ticket, item);
  }
  $('dtAdminList').addEventListener('click', dtHandleEquipRowClick);
  $('dtTechList').addEventListener('click', dtHandleEquipRowClick);
  // The Job Order detail overlay re-renders dtCardHtml() too (for the
  // summary at the top), so its equipment "View details" rows need the
  // same delegated handler — see dtOpenTicketOverlay, which also seeds
  // dtLastTicketsById with the ticket being viewed.
  $('dtTicketOverlay').addEventListener('click', dtHandleEquipRowClick);
  // The header row (job order no., customer, date, status) always stays
  // visible so a technician can scan the whole list at a glance; everything
  // below it — address, equipment, remarks, requirements — sits inside a
  // collapsed "jo-card-body" that opens on tap (see data-jo-toggle handling
  // in dtHandleEquipRowClick). "Open Job Order" lives in the header itself
  // (right side, next to the status pill) rather than below the collapsible
  // body, so it's reachable without expanding the card. hideOpenBtn lets the
  // ticket-detail overlay reuse this same header for its own summary without
  // showing a redundant "Open Job Order" button for the ticket it's already
  // showing. extraBodyHtml (used by the technician's list — see
  // dtStepperHtml) is inserted at the very top of the body, above the rest
  // of the ticket's details.
  function dtCardHtml(r, forAdmin, extraBodyHtml, hideOpenBtn){
    const detailBody =
      (extraBodyHtml || '')+
      (r.siteAddress ? '<div class="leave-comment"><b>Site Address</b>'+escapeHtml(r.siteAddress)+'</div>' : '')+
      (forAdmin && r.reportAllowedWorkerNames && r.reportAllowedWorkerNames.length ? '<div class="leave-comment"><b>Can Create Service Report</b>'+escapeHtml(r.reportAllowedWorkerNames.join(', '))+'</div>' : '')+
      (r.contactName ? '<div class="leave-comment"><b>Contact at Site</b>'+escapeHtml(r.contactName)+(r.contactNo?(' · '+escapeHtml(r.contactNo)):'')+'</div>' : '')+
      dtEquipmentSummaryBlock(r)+
      (r.remarks ? '<div class="leave-comment"><b>Special Instructions</b>'+escapeHtml(r.remarks)+'</div>' : '')+
      '<div class="leave-comment"><b>Requirements</b>'+dtReqSummary(r)+'</div>'+
      (forAdmin ? '<div class="leave-comment"><b>Created by</b>'+escapeHtml(r.createdBy||'Admin')+'</div>' : '');
    return '<div class="user-card-head jo-card-toggle" data-jo-toggle>'+
        '<div>'+
          '<div class="u-name">'+escapeHtml(r.jobOrderNo)+' — '+escapeHtml(r.custName)+'</div>'+
          '<div class="u-status">'+dtCategoryTagHtml(r)+leaveFmtDate(r.date)+(r.expectedTime ? (' at '+r.expectedTime) : '')+' · '+escapeHtml((r.assignedWorkerNames||[]).join(', '))+'</div>'+
          // Admin only, and outside jo-card-body on purpose: this has to be
          // readable without expanding the card, otherwise monitoring ten
          // live tickets still means ten taps.
          (forAdmin ? dtAdminProgressHtml(r) : '')+
        '</div>'+
        '<div class="jo-card-head-actions">'+
          (hideOpenBtn ? '' : '<button type="button" class="jo-open-btn" data-jo-open="'+escapeHtml(r.id)+'">Open Job Order</button>')+
          dtStatusPill(r)+'<span class="jo-caret">▾</span>'+
        '</div>'+
      '</div>'+
      '<div class="jo-card-body" style="display:none;">'+detailBody+'</div>';
  }
  // ---------- Admin list: ticket-wide progress tracker ----------
  // dtStepperHtml below is SELF-centric: it asks "did I acknowledge, did I
  // complete", which is the right question for a technician and a useless
  // one for admin — on a three-technician ticket admin isn't any of them.
  // This is the aggregate view instead: how many of the assigned crew have
  // acknowledged, and how many equipment units are resolved. It renders in
  // the card HEAD (always visible) rather than the collapsed body, because
  // the whole point is monitoring several tickets without opening any.
  function dtAdminProgressHtml(r){
    const status = dtEffectiveStatus(r);
    if(status==='cancelled' || status==='expired') return '';
    // Not in the lifecycle yet — a four-segment bar on a job order booked
    // for next week reads as "stalled at step 1" rather than "not due".
    if(status==='scheduled'){
      return '<div class="jo-admin-progress" style="margin-top:6px;">'+
        '<div class="u-status" style="font-size:10.5px;">Scheduled — technicians can acknowledge from '+escapeHtml(dtWindowOpensText(r))+'</div>'+
      '</div>';
    }

    const assigned = (r.assignedWorkerIds||[]).length;
    const acked = (r.acknowledgedBy||[]).filter(id=> (r.assignedWorkerIds||[]).includes(id)).length;
    const units = (r.equipmentList||[]).length;
    // "Resolved" deliberately counts BOTH a filed report and a unit the
    // technician flagged as not done — an inaccessible unit is a finished
    // question, not outstanding work. Counting only reports would leave
    // tickets looking permanently stalled at 4/5.
    const resolved = (r.equipmentList||[]).filter(it=> it.reportSrNo || it.notDone).length;

    // Four segments matching the lifecycle stages admin actually watches.
    // Each is filled/half/empty rather than a single percentage, because
    // "which stage is it stuck at" is the question, not "how far along".
    const stages = [
      { label:'Ack',      done: assigned>0 && acked>=assigned, part: acked>0 },
      { label:'On Site',  done: !!r.arrivedAt,                 part: !!r.arrivedAt },
      { label:'Reported', done: units>0 && resolved>=units,    part: resolved>0 },
      // Half-lit at Completed: the work is done and the job order is now
      // waiting on ADMIN to review and close it. That distinction is the
      // whole reason this bar exists on the admin list.
      { label:'Closed',   done: status==='closed',             part: status==='completed' }
    ];
    const bar = stages.map(s=>{
      const color = s.done ? 'var(--green)' : (s.part ? 'var(--amber, #B8860B)' : 'var(--border)');
      return '<div style="flex:1; height:5px; border-radius:3px; background:'+color+';"></div>';
    }).join('');

    // Counts only where they carry information. "2 of 3 acknowledged" tells
    // admin exactly who to chase; "3 of 3" is noise once it's complete.
    const bits = [];
    if(assigned>0 && acked<assigned) bits.push(acked+' of '+assigned+' acknowledged');
    if(units>0 && resolved<units)    bits.push(resolved+' of '+units+' units reported');
    if(r.arrivedAt && resolved<units) bits.push('on site');
    if(status==='completed') bits.push('waiting on your review');

    return '<div class="jo-admin-progress" style="margin-top:6px;">'+
        '<div style="display:flex; gap:3px; margin-bottom:3px;">'+bar+'</div>'+
        (bits.length ? '<div class="u-status" style="font-size:10.5px;">'+escapeHtml(bits.join(' · '))+'</div>' : '')+
      '</div>';
  }

  // ---------- Technician list: progressive step tracker ----------
  // Shown at the top of each expanded job order card in "My Job Order" (not
  // on admin's list) so a technician can see at a glance where a ticket
  // stands and exactly what to do next, without reading through the full
  // detail block below it. Stage is derived from the same acknowledgedBy /
  // acknowledgedBy / arrivedAt / status fields the action buttons use — "Expired"
  // is deliberately NOT one of the stages: it's a date-based warning (see
  // dtEffectiveStatus) that can appear at any stage before Closed, not a
  // step the ticket passes through.
  function dtStepperHtml(r){
    if(r.status==='cancelled'){
      return '<div class="jo-stepper"><div class="jo-stepper-next" style="color:var(--danger);"><b>Cancelled</b>'+
        (r.cancelReason ? (' — '+escapeHtml(r.cancelReason)) : '')+'</div></div>';
    }
    // Checked before expiry: a technician taken off a ticket that later
    // expired should be told they were replaced, not blamed for not
    // acknowledging something that stopped being theirs.
    const removal = dtRemovalFor(r, currentUser.id);
    if(removal){
      return '<div class="jo-stepper"><div class="jo-stepper-next">'+
        '<b>Closed for you — replaced</b><br>'+
        'You were taken off this job order'+
        (removal.replacedByName ? ' and replaced by '+escapeHtml(removal.replacedByName) : '')+
        (removal.removedBy ? ' by '+escapeHtml(removal.removedBy) : '')+
        '.<br>Reason: '+escapeHtml(removal.reason || 'Admin input')+
        '<br>No further action is needed from you, and no Service Report can be filed against it.'+
        '</div></div>';
    }
    if(dtIsExpired(r)){
      return '<div class="jo-stepper"><div class="jo-stepper-next" style="color:var(--danger);">'+
        '<b>Expired — closed automatically</b><br>Nobody acknowledged this within 8 hours of the scheduled time, so it can no longer be acknowledged or reported on. Ask your admin to issue a new job order.</div></div>';
    }
    const stage_ = dtEffectiveStatus(r);
    const ack = (r.acknowledgedBy||[]).includes(currentUser.id);
    const arrived = !!r.arrivedAt;
    const units = r.equipmentList || [];
    const resolved = units.filter(it=> it.reportSrNo || it.notDone).length;

    // Five stages, matching what the customer sees on their own card.
    // "Scheduled" is not one of them: a ticket dated in the future hasn't
    // entered the lifecycle yet, so it gets the note below instead of a
    // track implying step 1 is underway.
    const steps = ['Preparing','En Route','Work in Progress','Completed','Closed'];
    let stage = 0;
    if(stage_==='closed') stage = 4;
    else if(stage_==='completed') stage = 3;
    else if(stage_==='in_progress') stage = 2;
    else if(stage_==='acknowledged') stage = 1;

    const stepsHtml = steps.map((label,i)=>{
      const state = i<stage ? 'done' : (i===stage ? 'current' : 'upcoming');
      return '<div class="jo-step '+state+'">'+
          '<span class="jo-step-line"></span>'+
          '<span class="jo-step-dot">'+(i<stage ? icon('check') : (i+1))+'</span>'+
          '<span class="jo-step-label">'+label+'</span>'+
        '</div>';
    }).join('');

    let nextText;
    if(stage_==='scheduled'){
      // The whole point of the date-lock: they can see the job, prepare for
      // it, and know exactly when it becomes actionable.
      return '<div class="jo-stepper"><div class="jo-stepper-next">'+
        '<b>Scheduled for '+leaveFmtDate(r.date)+(r.expectedTime ? (' at '+r.expectedTime) : '')+'</b><br>'+
        'You can review the details now. The <b>Acknowledge</b> button appears from '+
        escapeHtml(dtWindowOpensText(r))+' — four hours before the scheduled time.'+
        '</div></div>';
    }
    if(stage_==='closed') nextText = 'Fully closed by admin — no further action needed.';
    else if(stage_==='completed') nextText = 'All equipment resolved. Admin is reviewing the Service Report(s) and will close this job order.';
    else if(stage_==='in_progress'){
      nextText = resolved+' of '+units.length+' unit(s) resolved. File a Service Report for each one — or flag a unit as not done, with a reason, if it can\'t be serviced. The job order completes on its own once none are left.';
    }
    else if(ack && stage_==='acknowledged') nextText = 'The customer knows you\'re on the way. Tap Arrived at Site when you get there — that starts the work and fills Time In on the Service Report.';
    else if(ack) nextText = 'Acknowledged — waiting for the other assigned technician(s) before the customer is told the crew is en route.';
    else nextText = 'Scheduled for today. Tap Acknowledge to accept this job order.';

    return '<div class="jo-stepper">'+
      '<div class="jo-stepper-track">'+stepsHtml+'</div>'+
      '<div class="jo-stepper-next"><b>Next:</b> '+nextText+'</div>'+
    '</div>';
  }
  // Best-effort write-back: called after a Service Report tied to one
  // equipment line item is saved, so the ticket's progress ("38 of 100
  // reported") reflects it. Never blocks or fails the report save itself —
  // if it can't reach the cloud right now, the ticket just catches up
  // whenever it's next viewed online.
  async function dtMarkEquipmentReported(ticketId, equipId, srNo){
    if(!ticketId || !equipId) return;
    if(!(await ensureCloud())) return;
    try{
      const rec = await dtGetTicket(ticketId);
      if(!rec || !rec.equipmentList) return;
      const idx = rec.equipmentList.findIndex(it=> it.id===equipId);
      if(idx<0 || rec.equipmentList[idx].reportSrNo===srNo) return;
      // Patches ONE array element server-side under a row lock. Writing the
      // whole equipmentList back from here lost concurrent edits: two
      // technicians finishing different units on the same job order each
      // sent their own copy of the list, and the slower write erased the
      // other's reportSrNo — the report row survived but the ticket forgot
      // it, so that unit never resolved and the job order could never
      // complete.
      const { error } = await db.rpc('dispatch_set_equipment_state', {
        p_ticket_id: ticketId, p_equip_id: equipId,
        // draftSrNo is dropped in the same write: once a report is filed
        // the draft pointer is stale, and leaving it made the review
        // section show both against one unit.
        p_patch: { reportSrNo: srNo }, p_clear_keys: ['draftSrNo']
      });
      if(error) throw error;
    }catch(e){ console.error('mark equipment reported failed', describeCloudError(e)); }
  }
  // Same idea as dtMarkEquipmentReported, but for a Service Report that was
  // only saved as a draft. Lets the "From Job Order" picker show "Draft
  // Saved" on that equipment instead of leaving it looking untouched, which
  // is what let technicians file a second report for the same unit.
  async function dtMarkEquipmentDraft(ticketId, equipId, srNo){
    if(!ticketId || !equipId) return;
    if(!(await ensureCloud())) return;
    try{
      const rec = await dtGetTicket(ticketId);
      if(!rec || !rec.equipmentList) return;
      const idx = rec.equipmentList.findIndex(it=> it.id===equipId);
      // Never downgrade an item that's already fully reported, and skip the
      // write if it's already flagged with this exact draft.
      if(idx<0 || rec.equipmentList[idx].reportSrNo || rec.equipmentList[idx].draftSrNo===srNo) return;
      const { error } = await db.rpc('dispatch_set_equipment_state', {
        p_ticket_id: ticketId, p_equip_id: equipId, p_patch: { draftSrNo: srNo }
      });
      if(error) throw error;
    }catch(e){ console.error('mark equipment draft failed', describeCloudError(e)); }
  }

  // Must match the button marked .active in index.html. 'open' no longer
  // exists as a status, so leaving it here would open the admin list empty.
  let dtAdminFilter = 'preparing';
  async function dtRenderAdminList(){
    const list = $('dtAdminList');
    list.innerHTML = '<div class="empty-state">Loading…</div>';
    const all = await dtListAll();
    const items = dtAdminFilter==='all' ? all : all.filter(r=> dtEffectiveStatus(r)===dtAdminFilter);
    dtLastTicketsById = {};
    items.forEach(r=> dtLastTicketsById[r.id] = r);
    if(items.length===0){
      // Raw filter keys read badly here — "No in_progress dispatch tickets".
      const FILTER_LABELS = { preparing:'preparing', acknowledged:'en route', in_progress:'in-progress',
        completed:'job orders awaiting review', scheduled:'scheduled', closed:'closed',
        expired:'expired', cancelled:'cancelled' };
      const label = dtAdminFilter==='all' ? 'dispatch tickets'
        : (dtAdminFilter==='completed' ? FILTER_LABELS.completed : (FILTER_LABELS[dtAdminFilter]||dtAdminFilter)+' dispatch tickets');
      list.innerHTML = '<div class="empty-state">No '+label+'.</div>';
      return;
    }
    list.innerHTML = '';
    items.forEach(r=>{
      const card = document.createElement('div');
      card.className = 'user-card';
      card.innerHTML = dtCardHtml(r, true);
      list.appendChild(card);
    });
  }
  // Selects a filter programmatically and keeps the button row's .active
  // state in step — used by the dashboard's "Job Orders to Review" card,
  // which deep-links straight into that queue.
  function dtSetAdminFilter(filter){
    const btn = document.querySelector('#dtAdminFilterRow button[data-filter="'+filter+'"]');
    if(!btn) return false;
    document.querySelectorAll('#dtAdminFilterRow button').forEach(b=> b.classList.remove('active'));
    btn.classList.add('active');
    dtAdminFilter = filter;
    // 'messages' is not a status — it swaps the whole list for the thread
    // inbox, so it can't go through the status filter below.
    const inbox = filter==='messages';
    if($('dtAdminList')) $('dtAdminList').style.display = inbox ? 'none' : '';
    if($('dtAdminInboxList')) $('dtAdminInboxList').style.display = inbox ? '' : 'none';
    if(inbox) dtRenderChatInbox(); else dtRenderAdminList();
    return true;
  }
  document.querySelectorAll('#dtAdminFilterRow button').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      document.querySelectorAll('#dtAdminFilterRow button').forEach(b=> b.classList.remove('active'));
      btn.classList.add('active');
      dtAdminFilter = btn.dataset.filter;
      const inboxSel = dtAdminFilter==='messages';
      if($('dtAdminList')) $('dtAdminList').style.display = inboxSel ? 'none' : '';
      if($('dtAdminInboxList')) $('dtAdminInboxList').style.display = inboxSel ? '' : 'none';
      if(inboxSel){ dtRenderChatInbox(); return; }
      dtRenderAdminList();
    });
  });
  function dtShowAdminTab(which){
    $('dtTabNew').classList.toggle('active', which==='new');
    $('dtTabAll').classList.toggle('active', which==='all');
    $('dtTabCalendar').classList.toggle('active', which==='calendar');
    $('dtNewCard').style.display = which==='new' ? '' : 'none';
    $('dtAllCard').style.display = which==='all' ? '' : 'none';
    $('dtCalendarCard').style.display = which==='calendar' ? '' : 'none';
    if(which==='new') dtResetForm();
    else if(which==='calendar') dtRenderCalendarTab();
    else if(dtAdminFilter === 'messages') dtSetAdminFilter('messages');
    else dtRenderAdminList();
  }
  $('dtTabNew').addEventListener('click', ()=> dtShowAdminTab('new'));
  $('dtTabAll').addEventListener('click', ()=> dtShowAdminTab('all'));
  $('dtTabCalendar').addEventListener('click', ()=> dtShowAdminTab('calendar'));

  // Which of the two technician-list tabs is showing — 'active' (open,
  // acknowledged, completed, expired: anything still needing attention) or
  // 'closed' (fully finalized tickets, kept out of the way by default).
  // Module-level so dtRenderTechList (re-run after every action) remembers
  // which tab the technician was on.
  let dtTechListTab = 'active';
  function dtSetTechListTab(tab){
    dtTechListTab = tab;
    if($('dtTechTabActive')) $('dtTechTabActive').classList.toggle('active', tab==='active');
    if($('dtTechTabClosed')) $('dtTechTabClosed').classList.toggle('active', tab==='closed');
    if($('dtTechTabInbox')) $('dtTechTabInbox').classList.toggle('active', tab==='inbox');
    // The inbox lists threads, not job orders, so it swaps the whole list
    // rather than filtering it — and the job-order-only controls above
    // (expand all) would do nothing there.
    const inbox = tab==='inbox';
    if($('dtTechList')) $('dtTechList').style.display = inbox ? 'none' : '';
    if($('dtInboxList')) $('dtInboxList').style.display = inbox ? '' : 'none';
    if($('dtTechExpandAllBtn')) $('dtTechExpandAllBtn').style.display = inbox ? 'none' : '';
    if(inbox) dtRenderChatInbox(); else dtRenderTechList();
  }
  if($('dtTechTabActive')) $('dtTechTabActive').addEventListener('click', ()=> dtSetTechListTab('active'));
  if($('dtTechTabClosed')) $('dtTechTabClosed').addEventListener('click', ()=> dtSetTechListTab('closed'));
  if($('dtTechTabInbox')) $('dtTechTabInbox').addEventListener('click', ()=> dtSetTechListTab('inbox'));
  // No more status tabs — every job order assigned to the technician is
  // always shown. This just orders the list so the ones needing action sit
  // above ones that don't: unacknowledged first, then acknowledged/in
  // progress, then completed, then closed last; ties broken by soonest
  // scheduled date.
  function dtSortTechTickets(items){
    function priority(r){
      const st = dtEffectiveStatus(r);
      // Most urgent first: an unacknowledged job order due today is the one
      // thing a technician must act on right now.
      if(st==='closed' || st==='replaced' || st==='cancelled' || st==='expired') return 6;
      if(st==='completed') return 5;
      if(st==='scheduled') return 4;   // not actionable yet
      if(st==='in_progress') return 2; // work underway — units still to report
      if(st==='acknowledged') return 1;
      return 0; // preparing, not yet acknowledged
    }
    return items.slice().sort((a,b)=>{
      const pa = priority(a), pb = priority(b);
      if(pa!==pb) return pa-pb;
      return (a.date||'').localeCompare(b.date||'');
    });
  }
  async function dtRenderTechList(){
    const list = $('dtTechList');
    if(!currentUser || currentUser.role==='admin') return;
    list.innerHTML = '<div class="empty-state">Loading…</div>';
    // Fresh render = every card starts collapsed again, so the toolbar
    // button's label always starts back at "Expand all" too.
    if($('dtTechExpandAllBtn')){
      $('dtTechExpandAllBtn').dataset.mode = 'expand';
      $('dtTechExpandAllBtn').textContent = '⤢ Expand all';
    }
    const mine = await dtListForWorker(currentUser.id);
    dtRenderBackToSrBanner(mine);
    const sorted = dtSortTechTickets(mine);
    // Closed tickets live in their own tab now, so each tab only ever
    // renders the subset it owns — a technician's day-to-day list isn't
    // padded out with tickets that need nothing further from them. The
    // Closed tab additionally re-sorts newest-first (by closedAt when
    // available, falling back to the scheduled date), since "recent on top"
    // is what's useful once a ticket is done — dtSortTechTickets's own
    // ascending date tie-break is aimed at the Active tab's upcoming work.
    // A replaced ticket is finished from this technician's side, so it
    // belongs in Closed with the rest of their finished work rather than
    // sitting in Active as something they might still act on. Sorted by
    // the removal timestamp where there is one, so "why did that job
    // disappear" is answered at the top of the list.
    const removedAtOf = (r)=>{
      const rem = dtRemovalFor(r, currentUser.id);
      return (rem && rem.removedAt) || r.closedAt || r.cancelledAt || r.date || '';
    };
    const items = dtTechListTab==='closed'
      ? sorted.filter(r=> dtIsTerminal(r) && dtEffectiveStatus(r)!=='completed')
          .sort((a,b)=> removedAtOf(b).localeCompare(removedAtOf(a)))
      : sorted.filter(r=> !dtIsTerminal(r) || dtEffectiveStatus(r)==='completed');
    dtLastTicketsById = {};
    // Store what was RENDERED, not the live row. The equipment "View
    // details" overlay resolves against this map using a data-equip-idx
    // computed from the card's own equipment list — caching the live row
    // while rendering a frozen one means a replaced technician taps a unit
    // and gets current data, or with a changed list, the wrong unit.
    items.forEach(r=> dtLastTicketsById[r.id] = dtViewFor(r, currentUser.id));
    if(items.length===0){
      list.innerHTML = dtTechListTab==='closed'
        ? '<div class="empty-state">'+icon('folder')+' No closed job orders yet</div>'
        : '<div class="empty-state">'+icon('inbox')+' No active job orders<br><span class="dt-jo-empty-sub">Job orders your admin assigns to you will show up here.</span></div>';
      return;
    }
    list.innerHTML = '';
    items.forEach(rLive=>{
      // Replaced tickets render from their snapshot, so a technician sees
      // the job exactly as it stood when they came off it — not how it went
      // on without them.
      const r = dtViewFor(rLive, currentUser.id);
      const card = document.createElement('div');
      card.className = 'user-card';
      card.dataset.ticketId = r.id;
      // Buttons now follow THIS technician's own progress, not the whole
      // ticket's status. Previously a shared ticket could sit at "open" so a
      // colleague who had already acknowledged never got a Complete button,
      // and one person's Complete closed it for everyone.
      // Buttons follow the ticket's lifecycle stage, not a per-person tally.
      // Only two actions remain for a technician: Acknowledge (their own,
      // on the scheduled day) and Arrived at Site (one tap, whole crew).
      // Completion is now derived from equipment being reported, and
      // closing is admin-only — neither is a button here any more.
      const stage = dtEffectiveStatus(r);
      const alreadyAck = (r.acknowledgedBy||[]).includes(currentUser.id);
      const arrived = !!r.arrivedAt;
      // An expired/cancelled/closed ticket takes no actions at all — see
      // dtIsTerminal. Offering buttons here would only produce a refusal.
      // A replaced technician is locked out unconditionally.
      const locked = !!dtRemovalFor(r, currentUser.id) || dtIsTerminal(r);
      // Viewable before the scheduled day, but not actionable — the note in
      // the stepper explains when to come back.
      const notYetDue = stage==='scheduled';
      card.innerHTML = dtCardHtml(r, false, dtStepperHtml(r)) +
        '<div class="user-card-actions">'+
          (!locked && !notYetDue && !alreadyAck ? '<button data-act="ack" class="primary">Acknowledge</button>' : '')+
          // Arrival requires the ticket to have reached En Route — i.e.
          // EVERY assigned technician acknowledged. Offering it while the
          // crew is still partly unacknowledged let one person jump the
          // ticket from Preparing straight to Work in Progress, so the
          // customer never saw En Route at all.
          (!locked && stage==='acknowledged' && !arrived ? '<button data-act="arrived" class="primary">Arrived at Site</button>' : '')+
          (!locked && alreadyAck && stage==='preparing' ? '<span class="u-status">Waiting for the other assigned technician(s) to acknowledge</span>' : '')+
          (!locked && arrived && stage==='in_progress' ? '<span class="u-status">File a Service Report for each unit, or flag it as not done</span>' : '')+
        '</div>';
      const ackBtn = card.querySelector('[data-act="ack"]');
      if(ackBtn) ackBtn.addEventListener('click', ()=> dtAcknowledge(r.id));
      const arrivedBtn = card.querySelector('[data-act="arrived"]');
      if(arrivedBtn) arrivedBtn.addEventListener('click', ()=> dtMarkArrived(r.id, arrivedBtn));
      list.appendChild(card);
    });
  }
  // Shows/updates the "Back to Service Report" banner when the technician
  // was sent here specifically to acknowledge one ticket (srAckReturnTicketId
  // — set by srGoAcknowledgeTicket). Its wording adapts once that ticket
  // actually becomes acknowledged, but the button works either way: going
  // back just re-shows the Job Order picker, which re-checks acknowledgment
  // for itself.
  function dtRenderBackToSrBanner(mine){
    const banner = $('dtBackToSrBanner');
    if(!banner) return;
    if(!srAckReturnTicketId){ banner.style.display = 'none'; return; }
    const ticket = (mine||[]).find(t=> t.id===srAckReturnTicketId);
    const jo = ticket ? ticket.jobOrderNo : 'That Job Order';
    // A technician sent here from the Service Report to acknowledge a ticket
    // can be replaced while standing on this screen. Without this branch the
    // banner would keep telling them to acknowledge a job order that is now
    // locked, with no button to do it — an instruction they cannot follow.
    const removal = ticket && currentUser ? dtRemovalFor(ticket, currentUser.id) : null;
    if(removal){
      $('dtBackToSrText').innerHTML = icon('lock')+' '+jo+' was reassigned — you can no longer file its Service Report.';
      banner.style.display = '';
      return;
    }
    const nowAck = ticket && currentUser && (ticket.acknowledgedBy||[]).includes(currentUser.id);
    $('dtBackToSrText').innerHTML = nowAck
      ? (icon('checkCircle')+' '+jo+' is acknowledged — you can head back now.')
      : (icon('clipboard')+' Acknowledge '+jo+' below to unlock its Service Report.');
    banner.style.display = '';
  }
  if($('dtBackToSrBtn')){
    $('dtBackToSrBtn').addEventListener('click', ()=>{
      srAckReturnTicketId = null;
      $('dtBackToSrBanner').style.display = 'none';
      showServiceReport();
    });
  }
  if($('dtBackToSrDismissBtn')){
    $('dtBackToSrDismissBtn').addEventListener('click', ()=>{
      srAckReturnTicketId = null;
      $('dtBackToSrBanner').style.display = 'none';
    });
  }
  // Every render rebuilds #dtTechList with all cards collapsed, so this
  // button always starts back at "Expand all" too — its own state never
  // needs to survive a re-render, only reflect what's on screen right now.
  if($('dtTechExpandAllBtn')){
    $('dtTechExpandAllBtn').addEventListener('click', function(){
      const expand = this.dataset.mode === 'expand';
      $$('#dtTechList .jo-card-toggle', document).forEach(head=> dtToggleCardBody(head, expand));
      this.dataset.mode = expand ? 'collapse' : 'expand';
      this.textContent = expand ? '⤡ Collapse all' : '⤢ Expand all';
    });
  }
  // Fetches only the ticket being changed, checks the current user is actually
  // assigned to it, and writes a targeted update instead of upserting the whole
  // record — so two technicians acting at once no longer overwrite each other.
  async function dtGetTicket(id){
    if(await ensureCloud()){
      try{
        const { data, error } = await db.from('dispatch_tickets').select('data').eq('id', id).maybeSingle();
        if(error) throw error;
        return data ? dtNormalizeTicket(data.data) : null;
      }catch(e){ console.error('dispatch fetch failed', describeCloudError(e)); return null; }
    }
    try{
      const item = await window.storage.get('dispatch:'+id, false);
      return item ? dtNormalizeTicket(JSON.parse(item.value)) : null;
    }catch(e){ return null; }
  }
  async function dtApplyWorkerChange(id, mutate){
    if(!currentUser){ toast('Please sign in again'); return false; }
    if(!(await ensureCloud())){ toast('This needs a connection — try again when online'); return false; }
    try{
      const rec = await dtGetTicket(id);
      if(!rec){ toast('Ticket not found'); return false; }
      const assigned = rec.assignedWorkerIds || [];
      if(currentUser.role!=='admin' && !assigned.includes(currentUser.id)){
        toast('This ticket is not assigned to you');
        return false;
      }
      const change = mutate(rec, assigned);
      if(!change) return false;
      const merged = Object.assign({}, rec, change);
      const { data: rows, error } = await db.from('dispatch_tickets')
        .update({ status: merged.status, data: merged }).eq('id', id).select('id');
      if(error) throw error;
      if(!rows || !rows.length){ toast('This ticket changed elsewhere — refreshing'); return false; }
      return true;
    }catch(e){
      console.error('dispatch update failed', describeCloudError(e));
      toast('Could not save — please try again');
      return false;
    }
  }
  // ---------- Admin: replace an assigned technician ----------
  // The absence problem. A ticket only reaches "En Route" once EVERY
  // assigned technician has acknowledged, so one person calling in sick
  // used to strand the ticket permanently — there was no way to edit
  // assignment after creation at all, and no amount of admin authority
  // could unstick it.
  //
  // Swapping has to touch more than assignedWorkerIds, because the
  // "everyone acknowledged" gate reads those arrays fresh every time. Leave
  // the departing technician's acknowledgment behind and the ticket would
  // count a person who isn't on the job any more, reporting itself as fully
  // acknowledged when the replacement hasn't even seen it.
  //
  // What deliberately SURVIVES a swap: arrivedAt. It records a fact about
  // the visit — someone was on site at that time, and the Service Report's
  // Time In is derived from it — not a fact about a particular person.
  // Stripping it would knock a ticket backwards out of Work in Progress and
  // silently change what the report says about when work started.
  async function dtReassignWorker(ticketId, outgoingId, incomingWorker, reason){
    if(!currentUser || currentUser.role!=='admin'){ toast('Only an admin can reassign a job order'); return false; }
    if(!incomingWorker || !incomingWorker.id){ toast('Pick a replacement technician'); return false; }
    if(!(await ensureCloud())){ toast('This needs a connection — try again when online'); return false; }
    try{
      const rec = await dtGetTicket(ticketId);
      if(!rec){ toast('Job order not found'); return false; }
      if(rec.status==='closed' || rec.status==='cancelled'){ toast('This job order is already finalized'); return false; }

      const assigned = (rec.assignedWorkerIds||[]).slice();
      const names    = (rec.assignedWorkerNames||[]).slice();
      const idx = assigned.indexOf(outgoingId);
      if(idx === -1){ toast('That technician is not assigned to this job order'); return false; }
      if(assigned.includes(incomingWorker.id)){ toast('That technician is already on this job order'); return false; }

      const outgoingName = names[idx] || 'Technician';
      assigned[idx] = incomingWorker.id;
      names[idx]    = incomingWorker.name;

      // Report permission follows assignment: someone off the job should
      // not keep the right to file its Service Report. The replacement does
      // NOT silently inherit it — admin picks report permission explicitly
      // at creation, so inheriting it here would grant a permission nobody
      // chose. If the outgoing tech was a reporter, the replacement takes
      // that slot; otherwise neither is a reporter.
      const repIds   = (rec.reportAllowedWorkerIds||[]).slice();
      const repNames = (rec.reportAllowedWorkerNames||[]).slice();
      const repIdx = repIds.indexOf(outgoingId);
      if(repIdx !== -1){ repIds[repIdx] = incomingWorker.id; repNames[repIdx] = incomingWorker.name; }

      const strip = (arr)=> (arr||[]).filter(id=> id !== outgoingId);
      const change = {
        assignedWorkerIds: assigned,
        assignedWorkerNames: names,
        reportAllowedWorkerIds: repIds,
        reportAllowedWorkerNames: repNames,
        // Progress belonging to the departing person goes with them.
        acknowledgedBy: strip(rec.acknowledgedBy),
        // Why a swap happened matters weeks later when someone asks why a
        // job ran long. Cheap to keep, impossible to reconstruct.
        removedWorkers: (rec.removedWorkers||[]).concat([{
          id: outgoingId, name: outgoingName,
          replacedById: incomingWorker.id, replacedByName: incomingWorker.name,
          reason: (reason||'').trim() || null,
          removedAt: serverNowISO(),
          removedBy: currentUser.name || 'Admin',
          // Frozen copy of the ticket as it stood when they were taken off.
          // Their record has to stop here: once replaced they have no part
          // in what happens next, and showing them the job continuing to
          // move — new reports, a different crew arriving, a later closure —
          // would misrepresent what they were actually involved in. Only the
          // fields their card and overlay render are kept, so a 40-unit
          // ticket doesn't multiply its jsonb on every swap.
          snapshot: {
            status: rec.status,
            equipmentList: rec.equipmentList || [],
            assignedWorkerNames: (rec.assignedWorkerNames||[]).slice(),
            acknowledgedBy: (rec.acknowledgedBy||[]).slice(),
            arrivedAt: rec.arrivedAt || null,
            remarks: rec.remarks || null,
            date: rec.date, expectedTime: rec.expectedTime || null
          }
        }]),
        // Id-only mirror of the above. RLS reads THIS (dispatch_select_assigned)
        // to keep the replaced technician's read access alive — without it the
        // ticket disappears from their app the instant they're swapped out,
        // with no closing record and no reason. Deduped because the same
        // person can be swapped off a ticket, re-added, and swapped off again.
        removedWorkerIds: Array.from(new Set((rec.removedWorkerIds||[]).concat([outgoingId])))
      };

      // Removing an acknowledgement can move the ticket BACKWARDS — if the
      // crew was fully acknowledged and the replacement hasn't confirmed,
      // the ticket is no longer En Route and must say so. A ticket already
      // in Work in Progress stays there: somebody arrived on site, and
      // arrivedAt (which the Service Report's Time In reads) records the
      // visit, not the person.
      const stillAllAcked = assigned.length>0 && assigned.every(w=> change.acknowledgedBy.includes(w));
      if(rec.status==='acknowledged' && !stillAllAcked) change.status = 'preparing';

      const merged = Object.assign({}, rec, change);
      const { data: rows, error } = await db.from('dispatch_tickets')
        .update({ status: merged.status, data: merged }).eq('id', ticketId).select('id');
      if(error) throw error;
      if(!rows || !rows.length){ toast('This job order changed elsewhere — refreshing'); return false; }

      // The replacement needs to know they have a job today. Best-effort,
      // exactly like dtCreateTicket's notifications — a failed push must
      // never roll back a completed reassignment.
      if(typeof notifyUser === 'function'){
        try{
          notifyUser(incomingWorker.id, 'New job order assigned to you',
            rec.jobOrderNo+' — '+(rec.custName||'')+' on '+leaveFmtDate(rec.date)+
            '. You are covering for '+outgoingName+'.', 'jo-reassign');
          notifyUser(outgoingId, 'You were removed from a job order',
            rec.jobOrderNo+' has been reassigned to '+incomingWorker.name+'.', 'jo-reassign');
        }catch(e){}
      }
      toast(outgoingName+' replaced by '+incomingWorker.name);
      return true;
    }catch(e){
      console.error('dispatch reassign failed', describeCloudError(e));
      toast('Could not reassign — please try again');
      return false;
    }
  }

  // ---------- Admin: reassignment UI ----------
  // One row per currently assigned technician, each showing whether they've
  // acknowledged yet — because that's the whole reason admin is on this
  // screen. Someone who already acknowledged and is working needs a
  // different decision from someone who hasn't responded all morning, and a
  // bare list of names doesn't distinguish them.
  async function dtRenderReassignSection(rec){
    const sec = $('dtReassignSection');
    if(!sec) return;
    const isAdmin = currentUser && currentUser.role==='admin';
    const finalized = rec.status==='closed' || rec.status==='cancelled' || dtIsExpired(rec);
    if(!isAdmin || finalized){ sec.style.display='none'; sec.innerHTML=''; return; }

    const box = $('dtReassignList');
    const assignedIds = rec.assignedWorkerIds || [];
    const assignedNames = rec.assignedWorkerNames || [];
    if(assignedIds.length===0){ sec.style.display='none'; return; }

    sec.style.display = '';
    box.innerHTML = '<div class="empty-state">Loading technicians…</div>';
    const users = (await cloudListUsers()) || [];
    // Anyone already on the ticket can't also be their own replacement.
    const candidates = users.filter(u=> u.active!==false && !assignedIds.includes(u.id))
      .sort((a,b)=> a.name.localeCompare(b.name));

    box.innerHTML = '';
    assignedIds.forEach((wid, i)=>{
      const acked = (rec.acknowledgedBy||[]).includes(wid);
      const isReporter = (rec.reportAllowedWorkerIds||[]).includes(wid);
      const row = document.createElement('div');
      row.className = 'leave-comment';
      row.style.marginBottom = '8px';
      row.innerHTML =
        '<div style="display:flex; justify-content:space-between; align-items:center; gap:8px;">'+
          '<div>'+
            '<b>'+escapeHtml(assignedNames[i]||'Technician')+'</b>'+
            '<div class="u-status" style="font-size:11px;">'+
              (acked ? 'Acknowledged' : 'Not yet acknowledged')+
              (isReporter ? ' · can file report' : '')+
            '</div>'+
          '</div>'+
          '<button type="button" class="btn btn-secondary dt-reassign-open" '+
            'data-wid="'+escapeHtml(wid)+'" style="flex:none; padding:6px 12px; font-size:12px;">Replace</button>'+
        '</div>'+
        '<div class="dt-reassign-form" style="display:none; margin-top:8px;">'+
          (candidates.length===0
            ? '<div class="empty-state">No other active technician is available.</div>'
            : '<select class="dt-reassign-pick" style="margin-bottom:8px;">'+
                '<option value="">Select replacement…</option>'+
                candidates.map(c=> '<option value="'+escapeHtml(c.id)+'" data-name="'+escapeHtml(c.name)+'">'+escapeHtml(c.name)+'</option>').join('')+
              '</select>'+
              '<input type="text" class="dt-reassign-reason" placeholder="Reason (optional) — e.g. sick leave" style="margin-bottom:8px;">'+
              '<button type="button" class="btn btn-primary dt-reassign-confirm" style="width:100%;">Confirm Replacement</button>')+
        '</div>';
      box.appendChild(row);
    });

    box.querySelectorAll('.dt-reassign-open').forEach(btn=>{
      btn.onclick = ()=>{
        const form = btn.closest('.leave-comment').querySelector('.dt-reassign-form');
        const opening = form.style.display === 'none';
        // Only one open at a time — two half-filled swap forms on screen is
        // how the wrong person gets replaced.
        box.querySelectorAll('.dt-reassign-form').forEach(f=> f.style.display='none');
        box.querySelectorAll('.dt-reassign-open').forEach(b=> b.textContent='Replace');
        if(opening){ form.style.display=''; btn.textContent='Cancel'; }
      };
    });

    box.querySelectorAll('.dt-reassign-confirm').forEach(btn=>{
      btn.onclick = async ()=>{
        const row = btn.closest('.leave-comment');
        const outgoingId = row.querySelector('.dt-reassign-open').dataset.wid;
        const pick = row.querySelector('.dt-reassign-pick');
        const incomingId = pick.value;
        if(!incomingId){ toast('Select a replacement'); return; }
        const incomingName = pick.options[pick.selectedIndex].dataset.name;
        const reason = row.querySelector('.dt-reassign-reason').value;
        const outgoingName = row.querySelector('b').textContent;
        if(!confirm('Replace '+outgoingName+' with '+incomingName+' on this job order?')) return;
        btn.disabled = true; btn.textContent = 'Replacing…';
        const ok = await dtReassignWorker(rec.id, outgoingId, { id: incomingId, name: incomingName }, reason);
        btn.disabled = false; btn.textContent = 'Confirm Replacement';
        if(ok){
          // Re-read rather than patching the local copy: the swap may have
          // moved the ticket backwards out of 'acknowledged', and the
          // status pill and close gate both read from it.
          const fresh = await dtGetTicket(rec.id);
          if(fresh) dtOpenTicketOverlay(fresh.id);
        }
      };
    });
  }

  // ---------- Acknowledge ----------
  // Gated to the scheduled day in BOTH directions. The upper bound was
  // already here (an expired ticket can't be acknowledged); the lower bound
  // is new — a technician could previously acknowledge a job order dated
  // next week, which told the customer someone was en route days early and
  // unlocked its Service Report before the visit.
  //
  // Checked here rather than only by hiding the button because a list
  // rendered before midnight can still be on screen after the date rolled,
  // and tapping it then would record a visit that never happened.
  async function dtAcknowledge(id){
    // Offline, the online guards can't run — so the ones that matter are
    // re-checked here against the local copy before queueing. The date lock
    // especially: it's the whole point of the stage, and a technician with
    // no signal should not be able to bypass it by going offline.
    if(!(await ensureCloud())){
      const rec = dtLastTicketsById[id] || (await dtGetTicket(id));
      if(!rec){ toast('Open this job order once while online first'); return; }
      if(dtIsExpired(rec)){ toast('This job order expired — ask your admin to issue a new one'); return; }
      if(dtIsFuture(rec)){ toast('You can acknowledge this from '+dtWindowOpensText(rec)); return; }
      if((rec.acknowledgedBy||[]).includes(currentUser.id)){ toast('You already acknowledged this'); return; }
      const queued = await dtQueueOfflineAction(id, 'ack');
      toast(queued ? 'Acknowledged — will sync when you are back online' : 'Could not save offline');
      dtRenderTechList();
      return;
    }
    let becameAcknowledged = false;
    const ok = await dtApplyWorkerChange(id, (rec, assigned)=>{
      if(dtIsExpired(rec)){ toast('This job order expired — ask your admin to issue a new one'); return null; }
      if(dtIsFuture(rec)){
        toast('You can acknowledge this from '+dtWindowOpensText(rec));
        return null;
      }
      const ackBy = new Set(rec.acknowledgedBy||[]);
      if(ackBy.has(currentUser.id)){ toast('You already acknowledged this'); return null; }
      ackBy.add(currentUser.id);
      const list = Array.from(ackBy);
      // A multi-worker ticket only reaches En Route once EVERYONE assigned
      // has confirmed; until then it stays Preparing so the remaining
      // technicians still see the Acknowledge button. If someone can't make
      // it, admin replaces them (dtReassignWorker) rather than the ticket
      // sitting stuck.
      const everyone = assigned.length>0 && assigned.every(w=> list.includes(w));
      if(everyone) becameAcknowledged = true;
      return {
        acknowledgedBy: list,
        acknowledgedAt: rec.acknowledgedAt || serverNowISO(),
        status: everyone ? 'acknowledged' : 'preparing'
      };
    });
    if(ok) toast(becameAcknowledged ? 'Acknowledged — customer notified you are on the way' : 'Acknowledged — waiting for the other assigned technician(s)');
    // Full acknowledgement is what now drives the customer's card to En
    // Route. This used to fire srMarkInProgressByTicket, which jumped the
    // customer straight to "In Progress" before anyone had arrived.
    if(ok && becameAcknowledged){
      if(typeof srMarkEnRouteByTicket === 'function') srMarkEnRouteByTicket(id).catch(()=>{});
      const t = dtLastTicketsById[id];
      if(t && t.custId && typeof notifyCustomer === 'function'){
        notifyCustomer(t.custId, 'Your technician is on the way',
          'Your service team has confirmed and is heading to your site.', 'jo-enroute');
      }
      if(typeof notifyAdmins === 'function'){
        notifyAdmins('Job order acknowledged', (t ? t.jobOrderNo : id)+' — crew is en route.', 'jo-ack');
      }
    }
    dtRenderTechList();
  }

  // ---------- Arrived at Site ----------
  // ONE tap from ANY assigned technician moves the whole ticket to Work in
  // Progress — unlike Acknowledge, this is not a per-person gate. Whoever
  // gets there first starts the clock for the crew.
  //
  // arrivedAt is the single source of truth for the Service Report's Time
  // In, which is why it is stamped from server time rather than the
  // device's: a phone running minutes fast would otherwise write a start
  // time into a report that doesn't match when work actually began.
  async function dtMarkArrived(id, btn){
    if(!(await ensureCloud())){
      const rec = dtLastTicketsById[id] || (await dtGetTicket(id));
      if(!rec){ toast('Open this job order once while online first'); return; }
      if(rec.arrivedAt){ toast('Arrival already recorded for this job order'); return; }
      if(dtIsExpired(rec)){ toast('This job order expired — ask your admin to issue a new one'); return; }
      if(!(rec.acknowledgedBy||[]).includes(currentUser.id)){ toast('Acknowledge this job order first'); return; }
      if(rec.status !== 'acknowledged'){ toast('Waiting for the other assigned technician(s) to acknowledge'); return; }
      const queued = await dtQueueOfflineAction(id, 'arrived');
      // Said plainly: the Service Report needs this timestamp, and the
      // technician should know it came from their own device.
      toast(queued ? 'Arrival recorded on this device — will sync when you are back online' : 'Could not save offline');
      dtRenderTechList();
      return;
    }
    if(btn){ btn.disabled = true; btn.textContent = 'Recording…'; }
    let becameInProgress = false;
    const ok = await dtApplyWorkerChange(id, (rec)=>{
      if(rec.arrivedAt){ toast('Arrival already recorded for this job order'); return null; }
      if(dtIsExpired(rec)){ toast('This job order expired — ask your admin to issue a new one'); return null; }
      const ackBy = rec.acknowledgedBy || [];
      if(currentUser.role!=='admin'){
        if(!ackBy.includes(currentUser.id)){
          toast('Acknowledge this job order first'); return null;
        }
        // Guarded here as well as by hiding the button: a card rendered
        // before a colleague acknowledged can still be on screen, and
        // arriving out of order would skip the customer's En Route stage.
        if(rec.status !== 'acknowledged'){
          toast('Waiting for the other assigned technician(s) to acknowledge'); return null;
        }
      }
      becameInProgress = true;
      return {
        arrivedAt: serverNowISO(),
        arrivedBy: currentUser.name || null,
        arrivedById: currentUser.id,
        status: 'in_progress'
      };
    });
    if(btn){ btn.disabled = false; btn.textContent = 'Arrived at Site'; }
    if(ok && becameInProgress){
      if(typeof srMarkInProgressByTicket === 'function') srMarkInProgressByTicket(id).catch(()=>{});
      const t = dtLastTicketsById[id];
      if(t && t.custId && typeof notifyCustomer === 'function'){
        notifyCustomer(t.custId, 'Your technician has arrived',
          'Work has started on your service.', 'jo-started');
      }
      if(typeof notifyAdmins === 'function'){
        notifyAdmins('Technician on site', (t ? t.jobOrderNo : id)+' — work has started.', 'jo-arrived');
      }
      toast('Arrival recorded — this fills Time In on the Service Report');
    }
    dtRenderTechList();
  }

  // ---------- Auto-complete ----------
  // Completion is no longer a button. A job order is finished when every
  // equipment line has been RESOLVED — either a Service Report was filed
  // against it, or the technician flagged it as not done with a reason.
  // Nothing else can mark it complete, so a ticket can't be closed out with
  // units left silently unreported (which the old "Mark Completed" tap
  // allowed: it checked acknowledgement and nothing else).
  //
  // Called after every dtMarkEquipmentReported and dtMarkEquipmentNotDone.
  // Safe to call repeatedly — it no-ops unless the last unit just landed.
  function dtAllUnitsResolved(rec){
    const units = rec.equipmentList || [];
    // A ticket with NO equipment lines can never satisfy "every unit
    // resolved", so it would sit in Work in Progress forever waiting for a
    // condition that cannot occur. Only legacy tickets predating
    // equipmentList can be in this state — dtCreateTicket requires at least
    // one unit — but "forever" is the wrong answer for any of them, and
    // admin shouldn't have to notice a stuck ticket to rescue it. Treating
    // it as resolved sends it to Review, where admin closes it normally.
    if(units.length === 0) return true;
    return units.every(it=> it.reportSrNo || it.notDone);
  }
  async function dtCheckAutoComplete(ticketId){
    // Offline, the report itself is queued and this simply doesn't run —
    // the next report filed while online re-checks and completes the ticket
    // then. Without the guard, db is null here and the throw would surface
    // as a scary error on an otherwise successful save.
    if(!(await ensureCloud())) return false;
    try{
      const rec = await dtGetTicket(ticketId);
      if(!rec) return false;
      if(['completed','closed','cancelled'].includes(rec.status)) return false;
      if(!dtAllUnitsResolved(rec)) return false;
      // Only the two status fields are written, NOT the whole data blob.
      // Two technicians filing the last two reports at once would otherwise
      // race: each re-reads, each writes its own copy of equipmentList, and
      // the slower write erases the faster one's reportSrNo — losing a
      // filed report from the ticket while the report row itself survives.
      // Merging into the stored row server-side keeps both.
      const { error } = await db.rpc('dispatch_mark_completed', { p_ticket_id: ticketId, p_completed_at: serverNowISO() });
      if(error) throw error;
      // The customer's request only reaches 'completed' when every unit was
      // actually reported. If any were flagged not done, the work isn't
      // finished from their side — it stays in progress until admin either
      // closes it or raises a continuation ticket.
      const hasExceptions = (rec.equipmentList||[]).some(it=> it.notDone);
      if(!hasExceptions && typeof srMarkCompletedByTicket === 'function'){
        srMarkCompletedByTicket(ticketId).catch(()=>{});
      }
      if(typeof notifyAdmins === 'function'){
        notifyAdmins('Job order ready for review',
          rec.jobOrderNo+' — all equipment resolved'+(hasExceptions ? ' (with exceptions)' : '')+'. Review and close it.', 'jo-review');
      }
      toast('All equipment resolved — job order sent to admin for review');
      return true;
    }catch(e){
      console.error('auto-complete check failed', describeCloudError(e));
      return false;
    }
  }

  // ---------- Flag a unit as not done ----------
  // Moved AHEAD of completion. It used to live only in the Close Job Order
  // checklist, which created a deadlock under the new rules: a unit that
  // can never be reported (site inaccessible, customer declined, parts
  // missing) would stop the ticket ever reaching Completed, and Close was
  // gated behind Completed. Resolving it here is what keeps the lifecycle
  // moving.
  async function dtMarkEquipmentNotDone(ticketId, equipId, reason){
    if(!reason || !reason.trim()){ toast('Give a reason so admin knows what happened'); return false; }
    if(!currentUser) return false;
    if(!(await ensureCloud())){ toast('This needs a connection — try again when online'); return false; }
    let ok = false;
    try{
      const rec = await dtGetTicket(ticketId);
      if(!rec){ toast('Job order not found'); return false; }
      if(currentUser.role!=='admin' && !(rec.assignedWorkerIds||[]).includes(currentUser.id)){
        toast('This job order is not assigned to you'); return false;
      }
      const target = (rec.equipmentList||[]).find(it=> it.id===equipId);
      if(!target){ toast('Unit not found on this job order'); return false; }
      if(target.reportSrNo){ toast('This unit already has a Service Report'); return false; }
      // Per-unit patch rather than a whole-list write, so a colleague
      // filing a report for a different unit at the same moment isn't
      // clobbered — see dispatch_set_equipment_state.
      const { error } = await db.rpc('dispatch_set_equipment_state', {
        p_ticket_id: ticketId, p_equip_id: equipId,
        p_patch: {
          notDone: true,
          notDoneReason: reason.trim(),
          notDoneBy: currentUser.name || null,
          notDoneAt: serverNowISO()
        }
      });
      if(error) throw error;
      ok = true;
    }catch(e){
      console.error('mark equipment not done failed', describeCloudError(e));
      toast('Could not save — please try again');
      return false;
    }
    if(ok){
      toast('Marked as not done');
      await dtCheckAutoComplete(ticketId);
      dtRenderTechList();
    }
    return ok;
  }

  // ---------- Undo a Not Yet Done flag ----------
  // Same-visit correction. A technician flags a unit because the customer
  // is unavailable or a panel is locked, and half an hour later the
  // situation clears — without this they are stuck: the report picker hides
  // a flagged unit, so no report can ever be filed against it, and the job
  // order would auto-complete claiming a unit was undone that actually got
  // done. The flag is the technician's own statement about their own
  // visit, so they can withdraw it.
  //
  // Only while the ticket is still in progress. Once it reaches Completed
  // the job order is in admin's review queue, and quietly reopening a unit
  // underneath that review is how two people end up working from different
  // pictures of the same job — from there it is a conversation in the
  // thread, not a silent edit.
  async function dtClearEquipmentNotDone(ticketId, equipId){
    if(!currentUser) return false;
    if(!(await ensureCloud())){ toast('This needs a connection — try again when online'); return false; }
    let ok = false;
    try{
      const rec = await dtGetTicket(ticketId);
      if(!rec){ toast('Job order not found'); return false; }
      if(currentUser.role!=='admin' && !(rec.assignedWorkerIds||[]).includes(currentUser.id)){
        toast('This job order is not assigned to you'); return false;
      }
      if(dtEffectiveStatus(rec) !== 'in_progress'){
        toast('This job order has moved on — ask admin to reopen the unit'); return false;
      }
      const target = (rec.equipmentList||[]).find(it=> it.id === equipId);
      if(!target || !target.notDone){ toast('That unit is not flagged'); return false; }
      // Keys removed, not set false: a leftover notDoneBy on an un-flagged
      // unit still reads as flagged anywhere that checks for the field.
      const { error } = await db.rpc('dispatch_set_equipment_state', {
        p_ticket_id: ticketId, p_equip_id: equipId, p_patch: {},
        p_clear_keys: ['notDone','notDoneReason','notDoneBy','notDoneAt']
      });
      if(error) throw error;
      ok = true;
    }catch(e){
      console.error('clear not-done failed', describeCloudError(e));
      toast('Could not save — please try again');
      return false;
    }
    if(ok){
      toast('Unit reopened — you can file its Service Report now');
      dtRenderTechList();
      if(typeof srRenderJobOrderPicker === 'function') srRenderJobOrderPicker();
    }
    return ok;
  }

  // Set when admin opens a Service Report from a job order's review
  // section, so the report screen can offer a way back to the job order
  // they were reviewing. Cleared once used or once they navigate elsewhere.
  let dtReviewReturnTicketId = null;
  function dtShowReviewReturnBanner(){
    const banner = $('dtReviewReturnBanner');
    if(!banner) return;
    if(!dtReviewReturnTicketId){ banner.style.display = 'none'; return; }
    const t = dtLastTicketsById[dtReviewReturnTicketId];
    $('dtReviewReturnText').innerHTML = icon('clipboard')+' Reviewing '+
      escapeHtml(t ? t.jobOrderNo : 'a job order')+' — go back when you are done with this report.';
    banner.style.display = '';
  }
  async function dtReviewReturn(){
    const id = dtReviewReturnTicketId;
    dtReviewReturnTicketId = null;
    const banner = $('dtReviewReturnBanner');
    if(banner) banner.style.display = 'none';
    if(!id) return;
    await showDispatchView('all');
    dtOpenTicketOverlay(id);
  }

  // ---------- Admin review: the reports filed against a job order ----------
  // Closing is admin's review step, and admin cannot review what they
  // cannot see. Before this, the overlay showed which units were reported
  // but not WHAT was reported — so "close the job order" meant trusting the
  // count rather than reading the work. This lists each report filed
  // against the ticket, tapping through to the full report.
  //
  // Fetched per unit from the ticket's own equipmentList rather than
  // querying service_reports by ticket: the ticket is the authority on
  // which reports belong to it (reportSrNo is written there when the
  // report saves), and a report can be edited or re-filed afterwards
  // without that link changing.
  async function dtFetchTicketReports(rec){
    const srNos = (rec.equipmentList||[]).map(it=> it.reportSrNo).filter(Boolean);
    if(srNos.length===0) return [];
    if(!(await ensureCloud())) return [];
    try{
      const { data, error } = await db.from('service_reports')
        .select('sr_no, date, technician_name, equip_type, equip_location, trouble_call, completed, findings')
        .in('sr_no', srNos);
      if(error) throw error;
      return data || [];
    }catch(e){ console.error('load ticket reports failed', describeCloudError(e)); return []; }
  }

  async function dtRenderReviewSection(rec){
    const sec = $('dtReviewSection');
    if(!sec) return;
    const isAdmin = currentUser && currentUser.role==='admin';
    const units = rec.equipmentList || [];
    const anyResolved = units.some(it=> it.reportSrNo || it.notDone);
    // Only worth showing once there is something to review. A job order
    // still being worked has nothing filed against it yet.
    if(!isAdmin || !anyResolved){ sec.style.display='none'; sec.innerHTML=''; return; }

    sec.style.display = '';
    sec.innerHTML = '<div class="field"><label>Service Reports on this Job Order</label>'+
      '<div id="dtReviewList"><div class="empty-state">Loading…</div></div></div>';
    const reports = await dtFetchTicketReports(rec);
    const byNo = {};
    reports.forEach(rp=> byNo[rp.sr_no] = rp);

    const rows = units.map(it=>{
      const label = escapeHtml(dtEquipSummaryLine(it));
      if(it.reportSrNo){
        const rp = byNo[it.reportSrNo];
        return '<div class="leave-comment" style="margin-bottom:6px;">'+
            '<div style="display:flex; justify-content:space-between; align-items:center; gap:8px;">'+
              '<div>'+
                '<b>'+escapeHtml(it.reportSrNo)+'</b> · '+label+
                '<div class="u-status" style="font-size:11px;">'+
                  (rp ? escapeHtml([rp.technician_name, rp.date ? leaveFmtDate(rp.date) : '', rp.trouble_call || ''].filter(Boolean).join(' · '))
                      : 'Report details unavailable offline')+
                '</div>'+
              '</div>'+
              '<button type="button" class="btn btn-secondary dt-review-open" data-sr="'+escapeHtml(it.reportSrNo)+'" '+
                'style="flex:none; padding:6px 12px; font-size:12px;">Open</button>'+
            '</div>'+
          '</div>';
      }
      if(it.notDone){
        // The exceptions are the part admin actually has to act on, so they
        // are called out rather than listed the same as a filed report.
        return '<div class="leave-comment" style="margin-bottom:6px; border-left:3px solid var(--amber);">'+
            '<b style="color:var(--amber);">&#9888; Not yet done</b> · '+label+
            '<div class="u-status" style="font-size:11px;">Reason: '+escapeHtml(it.notDoneReason||'—')+
              (it.notDoneBy ? (' · flagged by '+escapeHtml(it.notDoneBy)) : '')+'</div>'+
          '</div>';
      }
      return '<div class="leave-comment" style="margin-bottom:6px;">'+
          '<span class="u-status">Not yet resolved</span> · '+label+
        '</div>';
    }).join('');

    const exceptions = units.filter(it=> it.notDone).length;
    $('dtReviewList').innerHTML = rows +
      (exceptions>0
        ? '<div class="u-status" style="margin-top:6px;">'+exceptions+' unit(s) flagged. Use the thread below to sort it out with the technician, or close the job order and raise a follow-up for the remaining work.</div>'
        : '');

    sec.querySelectorAll('.dt-review-open').forEach(btn=>{
      btn.onclick = async ()=>{
        const srNo = btn.dataset.sr;
        btn.disabled = true; btn.textContent = 'Opening…';
        try{
          // Same path the Report History list uses, so admin lands in the
          // identical read-only view rather than a second, diverging one.
          const rec = await cloudGetReport(srNo);
          if(!rec){ toast('Could not load '+srNo); return; }
          // openReport switches the whole view, so the overlay has to go.
          // Remembering which job order we came from lets the report screen
          // offer a way back — reviewing five reports on one job order
          // otherwise means finding and reopening that ticket five times.
          dtReviewReturnTicketId = dtOverlayTicket ? dtOverlayTicket.id : null;
          $('dtTicketOverlay').classList.remove('open');
          await openReport(rec);
          dtShowReviewReturnBanner();
        }catch(e){
          console.error('open ticket report failed', describeCloudError(e));
          toast('Could not open '+srNo);
        }finally{
          btn.disabled = false; btn.textContent = 'Open';
        }
      };
    });
  }

  // ---------- Job Order detail overlay: close-with-exceptions + inquiry thread ----------
  // Opened via the "Open Job Order" button on any ticket card (admin or
  // technician). Two things live here that don't belong on the card list
  // itself: the "Close Job Order" flow (report any scope that wasn't done,
  // then close), and a small message thread scoped to this one ticket.
  let dtOverlayTicket = null;
  let dtMsgChannel = null;

  function dtCloseTicketOverlay(){
    const overlay = $('dtTicketOverlay');
    if(overlay) overlay.classList.remove('open');
    if(dtMsgChannel && db){ try{ db.removeChannel(dtMsgChannel); }catch(e){} }
    dtMsgChannel = null;
    dtOverlayTicket = null;
    // Opening a thread marks it read (dtRefreshMessages), but the inbox row
    // behind the overlay still showed its old unread count — so a thread
    // just read appeared unread until the list was rebuilt some other way.
    if(currentUser){
      const onInbox = (currentUser.role==='admin') ? dtAdminFilter==='messages' : dtTechListTab==='inbox';
      if(onInbox) dtRenderChatInbox();
    }
  }

  function dtRenderCloseChecklist(rec){
    const items = rec.equipmentList || [];
    if(items.length===0) return '<div class="empty-state">No equipment on this ticket.</div>';
    return items.map((it,i)=>{
      const reportStatus = it.reportSrNo
        ? ('Reported ('+escapeHtml(it.reportSrNo)+')')
        : (it.draftSrNo ? 'Draft saved' : 'Not started');
      const checked = it.notDone ? 'checked' : '';
      return '<div class="dt-close-row" data-idx="'+i+'">'+
        '<div style="font-weight:600;">'+escapeHtml(dtEquipSummaryLine(it))+'</div>'+
        '<div class="u-status" style="margin-bottom:6px;">'+reportStatus+'</div>'+
        '<label class="chk"><input type="checkbox" class="dt-notdone-chk" '+checked+'><span>Scope not completed on this unit</span></label>'+
        '<textarea class="dt-notdone-reason" rows="2" placeholder="Reason (e.g. parts needed, access denied, unit not operational)" '+
          'style="display:'+(it.notDone ? '' : 'none')+';">'+escapeHtml(it.notDoneReason||'')+'</textarea>'+
      '</div>';
    }).join('');
  }

  function dtCanActOnTicket(rec){
    if(!currentUser) return false;
    if(currentUser.role==='admin') return true;
    return (rec.assignedWorkerIds||[]).includes(currentUser.id);
  }

  async function dtOpenTicketOverlay(ticketId){
    const live = await dtGetTicket(ticketId);
    if(!live){ toast('Ticket not found'); return; }
    // A replaced technician opens their frozen copy. Admin and the current
    // crew always get the live record — dtViewFor only substitutes for a
    // viewer who was actually taken off this ticket.
    const rec = currentUser ? dtViewFor(live, currentUser.id) : live;
    dtOverlayTicket = rec;
    dtLastTicketsById[rec.id] = rec; // equipment "View details" rows resolve against this — frozen for a replaced viewer, live for everyone else
    const canAct = dtCanActOnTicket(rec);
    const alreadyClosed = dtEffectiveStatus(rec)==='closed';
    const isCancelled = rec.status==='cancelled';

    $('dtTicketTitle').textContent = rec.jobOrderNo+' — '+rec.custName;
    $('dtTicketStatusWrap').innerHTML = dtStatusPill(rec);
    $('dtTicketSummary').innerHTML = dtCardHtml(rec, currentUser && currentUser.role==='admin', undefined, true);
    // This overlay IS the detail view, so its embedded card summary should
    // show fully expanded, not the collapsed list-row state — force the
    // body open and drop the tap-to-toggle affordance from its header.
    const joSummaryBody = $('dtTicketSummary').querySelector('.jo-card-body');
    if(joSummaryBody) joSummaryBody.style.display = '';
    const joSummaryHead = $('dtTicketSummary').querySelector('.jo-card-toggle');
    if(joSummaryHead){ joSummaryHead.classList.remove('jo-card-toggle'); joSummaryHead.removeAttribute('data-jo-toggle'); }

    // Cancel Dispatch — admin-only, only reachable before anyone arrives
    // on site (see dtCancelTicket's own comment for why). Independent container
    // from dtCloseSection since its visibility condition is different.
    const cancelSecEl = $('dtCancelSection');
    if(cancelSecEl){
      const cancellable = ['preparing','open','acknowledged'].includes(rec.status);
      if(currentUser && currentUser.role==='admin' && !isCancelled && !alreadyClosed && cancellable){
        cancelSecEl.innerHTML = '<div class="field"><label style="color:var(--danger);">Cancel this dispatch</label>'+
          '<select id="dtCancelReasonSelect" style="margin-bottom:8px;"><option value="">Select a reason…</option>'+
            (typeof SR_CANCEL_REASONS!=='undefined' ? SR_CANCEL_REASONS.map(r=>'<option value="'+r.value+'">'+escapeHtml(r.label)+'</option>').join('') : '')+
          '</select>'+
          '<textarea id="dtCancelReasonOther" rows="2" placeholder="Please specify…" style="display:none; margin-bottom:8px;"></textarea>'+
          '<button type="button" class="btn btn-secondary" id="dtCancelSubmitBtn" style="width:100%; color:var(--danger);">Cancel Dispatch</button>'+
        '</div>';
        cancelSecEl.style.display = '';
        const dtCancelSelect = cancelSecEl.querySelector('#dtCancelReasonSelect');
        const dtCancelOther = cancelSecEl.querySelector('#dtCancelReasonOther');
        dtCancelSelect.onchange = ()=>{ dtCancelOther.style.display = dtCancelSelect.value==='other' ? '' : 'none'; };
        cancelSecEl.querySelector('#dtCancelSubmitBtn').onclick = async ()=>{
          const picked = (typeof SR_CANCEL_REASONS!=='undefined' ? SR_CANCEL_REASONS : []).find(r=> r.value===dtCancelSelect.value);
          if(!picked){ toast('Select a reason'); return; }
          let reason = picked.label;
          if(picked.value==='other'){
            const other = dtCancelOther.value.trim();
            if(!other){ toast('Please specify a reason'); dtCancelOther.focus(); return; }
            reason = 'Other: '+other;
          }
          if(!confirm('Cancel this dispatch? The customer will be notified and this cannot be undone.')) return;
          const ok = await dtCancelTicket(rec.id, reason);
          if(ok){
            if(typeof srCancelByTicket==='function') srCancelByTicket(rec.id, reason).catch(()=>{});
            toast('Dispatch cancelled');
            dtCloseTicketOverlay();
            if(currentUser.role==='admin') dtRenderAdminList(); else dtRenderTechList();
          } else toast('Could not cancel — try again');
        };
      } else {
        cancelSecEl.style.display = 'none';
        cancelSecEl.innerHTML = '';
      }
    }

    await dtRenderReassignSection(rec);
    await dtRenderReviewSection(rec);

    if(isCancelled){
      $('dtCloseSection').innerHTML = '<div class="leave-comment"><b>Cancelled</b>'+
        escapeHtml(rec.cancelledBy||'—')+' · '+(rec.cancelledAt ? leaveFmtDate(rec.cancelledAt.slice(0,10)) : '')+
        (rec.cancelReason ? ('<br>'+escapeHtml(rec.cancelReason)) : '')+'</div>';
      $('dtCloseSubmitBtn').style.display = 'none';
    }else if(alreadyClosed){
      const closedNote = '<div class="leave-comment"><b>Closed</b>'+
        escapeHtml(rec.closedBy||'—')+' · '+(rec.closedAt ? leaveFmtDate(rec.closedAt.slice(0,10)) : '')+
        (rec.closeRemarks ? ('<br>'+escapeHtml(rec.closeRemarks)) : '')+'</div>';
      const exceptionItems = (rec.equipmentList||[]).filter(it=> it.notDone);
      let continueHtml = '';
      if(exceptionItems.length>0){
        continueHtml = rec.continuedTicketId
          ? '<div class="leave-comment"><b>Continuation</b>Continued as '+escapeHtml(rec.continuedTicketId)+'</div>'
          // Admin only, and not merely because closing is: continuing opens
          // the Create Dispatch Ticket form, which is itself admin-only.
          // dtCanActOnTicket includes assigned technicians, so this used to
          // offer a button that dead-ended for them.
          : ((currentUser && currentUser.role==='admin')
              ? '<button type="button" class="btn btn-primary" id="dtContinueBtn" style="width:100%; margin-top:8px;">Continue Tomorrow ('+exceptionItems.length+' unit'+(exceptionItems.length===1?'':'s')+' remaining)</button>'
              : '<div class="u-status">'+exceptionItems.length+' unit(s) left unfinished — admin will raise the follow-up job order.</div>');
      }
      $('dtCloseSection').innerHTML = closedNote + continueHtml + '<div style="margin-top:10px;">'+dtRenderCloseChecklist(rec)+'</div>';
      $$('#dtCloseSection .dt-notdone-chk, #dtCloseSection .dt-close-row textarea', document).forEach(el=> el.disabled = true);
      $('dtCloseSubmitBtn').style.display = 'none';
      const continueBtn = $('dtCloseSection').querySelector('#dtContinueBtn');
      if(continueBtn) continueBtn.onclick = ()=>{ dtCloseTicketOverlay(); dtContinueClosedTicket(rec); };
    }else if(canAct){
      // Closing used to be reachable straight from "Open", skipping
      // Acknowledge entirely — which made that step optional in practice
      // even though the step tracker implies it's required. Close Job Order now
      // only unlocks once every assigned technician has marked their part
      // completed (rec.status==='completed'); until then this section
      // explains which of the two steps to do next instead of showing the
      // close form. Admin keeps the ability to close directly as an
      // override (e.g. a tech is unavailable to complete the app flow).
      // Closing belongs to admin now — a technician opening this overlay
      // sees where the job order stands instead of a form they can't use.
      if(currentUser.role!=='admin'){
        const st = dtEffectiveStatus(rec);
        const units = rec.equipmentList || [];
        const left = units.filter(it=> !it.reportSrNo && !it.notDone).length;
        const msg = st==='completed'
          ? 'All units resolved. Admin is reviewing this job order and will close it.'
          : (left>0
              ? left+' unit(s) still need a Service Report, or to be flagged as not done.'
              : 'Acknowledge and arrive on site before filing reports for this job order.');
        $('dtCloseSection').innerHTML =
          '<div class="empty-state">'+icon('lock')+' '+escapeHtml(msg)+
          '<br><span class="dt-jo-empty-sub">Job orders are closed by admin after review. Use the thread below if something needs sorting out.</span></div>';
        $('dtCloseSubmitBtn').style.display = 'none';
      }else{
        $('dtCloseSection').innerHTML =
          '<div id="dtCloseChecklist">'+dtRenderCloseChecklist(rec)+'</div>'+
          '<div class="field" style="margin-top:8px;"><label>Overall Remarks (optional)</label>'+
          '<textarea id="dtCloseRemarks" rows="2" placeholder="Anything else worth noting before closing"></textarea></div>';
        $('dtCloseSubmitBtn').style.display = '';
      }
    }else{
      // A replaced technician gets the real reason rather than the generic
      // permission line, which would read as if they'd been left off by
      // mistake.
      const myRemoval = currentUser ? dtRemovalFor(live, currentUser.id) : null;
      $('dtCloseSection').innerHTML = myRemoval
        ? '<div class="empty-state">'+icon('lock')+' This job order closed on your side when you were replaced'+
          (myRemoval.replacedByName ? ' by '+escapeHtml(myRemoval.replacedByName) : '')+
          '.<br><span class="dt-jo-empty-sub">Reason: '+escapeHtml(myRemoval.reason || 'Admin input')+'</span></div>'
        : '<div class="empty-state">Only the assigned technician(s) or admin can close this ticket.</div>';
      $('dtCloseSubmitBtn').style.display = 'none';
    }

    // The message thread belongs to the people currently working the job.
    // A replaced technician keeps read access to their record but has no
    // business posting into a ticket they're no longer on — and the insert
    // would be a silent write into someone else's live coordination thread.
    const myRemovalForChat = currentUser ? dtRemovalFor(live, currentUser.id) : null;
    if($('dtMsgInput')){
      $('dtMsgInput').disabled = !!myRemovalForChat;
      $('dtMsgInput').placeholder = myRemovalForChat
        ? 'You were replaced on this job order'
        : 'Ask a question about this Job Order…';
    }
    if($('dtMsgSendBtn')) $('dtMsgSendBtn').style.display = myRemovalForChat ? 'none' : '';

    $('dtTicketOverlay').classList.add('open');
    await dtRefreshMessages();
    if(dtMsgChannel && db){ try{ db.removeChannel(dtMsgChannel); }catch(e){} dtMsgChannel = null; }
    if(await ensureCloud()){
      dtMsgChannel = db.channel('dt-messages-'+ticketId)
        .on('postgres_changes', { event:'INSERT', schema:'public', table:'dispatch_ticket_messages', filter:'ticket_id=eq.'+ticketId }, ()=> dtRefreshMessages())
        .subscribe();
    }
  }
  $('closeDtTicketOverlay').addEventListener('click', dtCloseTicketOverlay);
  if($('dtReviewReturnBtn')) $('dtReviewReturnBtn').addEventListener('click', dtReviewReturn);
  $('dtTicketOverlay').addEventListener('click', (e)=>{ if(e.target.id==='dtTicketOverlay') dtCloseTicketOverlay(); });

  // Toggle a unit's reason textarea as its "not completed" checkbox changes.
  $('dtCloseSection').addEventListener('change', (e)=>{
    if(!e.target.classList.contains('dt-notdone-chk')) return;
    const row = e.target.closest('.dt-close-row');
    const ta = row && row.querySelector('.dt-notdone-reason');
    if(ta) ta.style.display = e.target.checked ? '' : 'none';
  });

  // "Continue Tomorrow" — opens a fresh Create Dispatch Ticket form for the
  // remaining work on a closed ticket that had one or more units marked
  // "scope not completed" (see dtRenderCloseChecklist/dtCloseTicket above).
  // Unlike dtPrefillCreateFromServiceRequest (which prefills from a
  // customer's original request), this prefills straight from the CLOSED
  // TICKET itself — customer, site, contact, access requirements are all
  // already sitting on it, no need to go back to the request. Only the
  // outstanding equipment items are carried forward, each seeded with a
  // scope line built from its notDoneReason so the next technician knows
  // exactly what's left. Admin reviews/adjusts (date, workers) and saves
  // it through the normal dtCreateTicket() path, same as any other ticket.
  async function dtContinueClosedTicket(ticket){
    const notDoneItems = (ticket.equipmentList||[]).filter(it=> it.notDone);
    if(notDoneItems.length===0){ toast('Nothing left to continue — every unit was completed'); return; }
    if(ticket.continuedTicketId){ toast('Already continued as '+ticket.continuedTicketId); return; }
    await showDispatchView('new'); // resets the form via dtResetForm()
    dtSourceServiceRequestId = ticket.sourceServiceRequestId || null;
    dtContinuedFromTicketId = ticket.id;
    // Same kind of work as the visit it continues. Legacy tickets without
    // one leave it unset, so admin is still made to pick.
    dtSetCategory(ticket.category || null);
    $('dtCustName').value = ticket.custName || '';
    if(ticket.custId) $('dtCustName').dataset.customerId = ticket.custId;
    $('dtSiteAddress').value = ticket.siteAddress || '';
    $('dtContactName').value = ticket.contactName || '';
    $('dtContactNo').value = ticket.contactNo || '';
    if(ticket.custId) await dtLoadCustomerEquipment(ticket.custId);
    $('dtDate').value = todayISO(); // next visit — admin adjusts if it's not tomorrow specifically
    $('dtRemarks').value = 'Continuation of '+ticket.jobOrderNo+' — remaining work:\n'+
      notDoneItems.map(it=> '\u2022 '+dtEquipSummaryLine(it)+': '+(it.notDoneReason||'\u2014')).join('\n');
    if(ticket.requirements){
      $('dtReqWorkPermit').checked = !!ticket.requirements.workPermit;
      $('dtReqGatePass').checked = !!ticket.requirements.gatePass;
      $('dtReqSafety').checked = !!ticket.requirements.safety;
      $('dtReqOthers').checked = !!ticket.requirements.others;
      if(ticket.requirements.others){
        $('dtReqOthersDetail').value = ticket.requirements.othersDetail || '';
        $('dtReqOthersDetailWrap').style.display = '';
      }
    }
    notDoneItems.forEach(oldItem=>{
      const item = Object.assign({id: dtGenEquipId(), equipmentId: oldItem.equipmentId || null}, dtPickEquipFields(oldItem));
      dtDraftEquipItems.push(item);
      dtAppendEquipItemCard(item); // auto-seeds one empty scope row from Default Scope (empty here)
      const scopeBox = $('dtEquipScope-'+item.id);
      if(scopeBox){
        scopeBox.innerHTML = ''; // drop the auto-seeded empty row
        dtAddSimpleRow(scopeBox.id, 'Remaining from '+ticket.jobOrderNo+': '+(oldItem.notDoneReason||'not completed'));
        (oldItem.scope||[]).forEach(s=> dtAddSimpleRow(scopeBox.id, s));
      }
    });
    dtEquipCountLabel();
    toast('Review and create the continuation job order for the '+notDoneItems.length+' remaining unit'+(notDoneItems.length===1?'':'s'));
  }

  // Admin aborts an ongoing dispatch outright — wrong dispatch, customer
  // unreachable, no longer needed, etc. Only reachable while the ticket is
  // Preparing or En Route: once a technician has arrived on site, the work
  // happened and Close Job Order is the correct way to wind it down. Called from dtCancelSection's button below, and
  // cross-called from service-requests.js's srAdminCancelActive when
  // admin cancels from the request side instead of the ticket side.
  async function dtCancelTicket(ticketId, reason){
    if(!currentUser || currentUser.role!=='admin'){ toast('Only admin can cancel a dispatch'); return false; }
    if(!(await ensureCloud())){ toast('This needs a connection — try again when online'); return false; }
    try{
      const rec = await dtGetTicket(ticketId);
      if(!rec){ toast('Ticket not found'); return false; }
      // 'open' is the pre-lifecycle name for 'preparing' and is kept so
      // tickets created before the change can still be cancelled. Cancelling
      // stays unavailable from Work in Progress onward: once technicians
      // have actually done work, Close Job Order (with its per-unit notDone
      // reasons) is the honest way to wind it down, not a blunt cancel that
      // erases the visit.
      if(!['preparing','open','acknowledged'].includes(rec.status)){
        toast('This dispatch has already moved past the point it can be cancelled directly'); return false;
      }
      const merged = Object.assign({}, rec, {
        status: 'cancelled',
        cancelledBy: currentUser.name,
        cancelledById: currentUser.id,
        cancelledAt: serverNowISO(),
        cancelReason: reason || ''
      });
      const { data: rows, error } = await db.from('dispatch_tickets')
        .update({ status: 'cancelled', data: merged }).eq('id', ticketId).select('id');
      if(error) throw error;
      if(!rows || !rows.length){ toast('This ticket changed elsewhere — refreshing'); return false; }
      return true;
    }catch(e){
      console.error('cancel ticket failed', describeCloudError(e));
      toast('Could not cancel — please try again');
      return false;
    }
  }

  async function dtCloseTicket(ticketId, equipmentList, remarks){
    if(!currentUser){ toast('Please sign in again'); return false; }
    if(!(await ensureCloud())){ toast('This needs a connection — try again when online'); return false; }
    try{
      const rec = await dtGetTicket(ticketId);
      if(!rec){ toast('Ticket not found'); return false; }
      // Closing is ADMIN-ONLY. It is the review step: admin reads the
      // Service Report(s) filed against the job order, resolves anything
      // flagged not done (usually through the ticket's chat thread), and
      // only then closes it. A technician finishing their units moves the
      // ticket to Completed automatically — that is as far as they take it.
      //
      // Enforced in three places, not one: the button is hidden, this
      // function refuses, and guard_dispatch_worker_fields in the database
      // normalises a non-admin 'closed' write back to the old status. A
      // hidden button alone is not a permission.
      if(currentUser.role!=='admin'){
        toast('Only admin can close a job order'); return false;
      }
      if(dtEffectiveStatus(rec)==='closed'){ toast('Already closed'); return false; }
      const merged = Object.assign({}, rec, {
        equipmentList,
        status: 'closed',
        closedBy: currentUser.name,
        closedById: currentUser.id,
        closedAt: serverNowISO(),
        closeRemarks: remarks || ''
      });
      const { data: rows, error } = await db.from('dispatch_tickets')
        .update({ status: 'closed', data: merged }).eq('id', ticketId).select('id');
      if(error) throw error;
      if(!rows || !rows.length){ toast('This ticket changed elsewhere — refreshing'); return false; }
      // This ticket's own status only ever tracks TODAY's job order. The
      // linked service request (the customer-facing job as a whole) only
      // moves to 'completed' if every unit closed out clean — otherwise it
      // stays exactly where it was (normally 'in_progress'), and admin picks
      // up the outstanding units via Continue Tomorrow (dtContinueClosedTicket).
      const stillHasWork = equipmentList.some(it=> it.notDone);
      // Admin closing is the customer's last stage too, so their card
      // reaches Closed rather than stopping at Completed. A job order with
      // units left not done still closes on the ticket side — but the
      // customer's request stays where it is, because the work as a whole
      // isn't finished; admin carves the remainder off with Continue
      // Tomorrow (dtContinueClosedTicket).
      if(!stillHasWork && typeof srMarkClosedByTicket === 'function'){
        srMarkClosedByTicket(ticketId).catch(()=>{});
      }
      if(typeof notifyAdmins === 'function'){
        notifyAdmins(stillHasWork ? 'Job order closed with remaining work' : 'Job order completed',
          (rec.jobOrderNo||ticketId)+' \u2014 '+(rec.custName||''), 'jo-closed');
      }
      if(!stillHasWork && rec.custId && typeof notifyCustomer === 'function'){
        notifyCustomer(rec.custId, 'Your service is complete',
          'The work has been finished and closed out. Thank you!', 'jo-done');
      }
      return true;
    }catch(e){
      console.error('close ticket failed', describeCloudError(e));
      toast('Could not close — please try again');
      return false;
    }
  }
  $('dtCloseSubmitBtn').addEventListener('click', async ()=>{
    if(!dtOverlayTicket) return;
    const rows = $$('#dtCloseChecklist .dt-close-row');
    const equipmentList = (dtOverlayTicket.equipmentList||[]).slice();
    for(let i=0; i<rows.length; i++){
      const chk = rows[i].querySelector('.dt-notdone-chk');
      const reasonEl = rows[i].querySelector('.dt-notdone-reason');
      const notDone = chk.checked;
      const reason = reasonEl.value.trim();
      if(notDone && !reason){
        toast('Add a reason for every unit marked "not completed"');
        reasonEl.focus();
        return;
      }
      const base = Object.assign({}, equipmentList[i]);
      if(notDone){
        base.notDone = true;
        base.notDoneReason = reason;
        // Preserve who flagged it and when if the technician already did so
        // during the visit; stamp admin only when this is a new flag.
        if(!equipmentList[i].notDone){
          base.notDoneBy = currentUser ? (currentUser.name || 'Admin') : 'Admin';
          base.notDoneAt = serverNowISO();
        }
      }else{
        // Cleared outright rather than set to false — leaving notDoneBy /
        // notDoneAt behind on an un-flagged unit meant the review section
        // and the audit trail still showed a technician as having flagged
        // a unit that is no longer flagged.
        delete base.notDone; delete base.notDoneReason;
        delete base.notDoneBy; delete base.notDoneAt;
      }
      equipmentList[i] = base;
    }
    // Every unit must end up either REPORTED or FLAGGED. Unchecking a box
    // here used to leave a unit that has no Service Report and no reason —
    // closed out in limbo, which is exactly the hole the whole lifecycle
    // change was meant to shut. Auto-completion enforces this invariant on
    // the way in; closing has to enforce it on the way out too, because
    // admin can uncheck a flag a technician set.
    const unresolved = equipmentList.filter(it=> !it.reportSrNo && !it.notDone);
    if(unresolved.length > 0){
      toast(unresolved.length+' unit(s) have no Service Report — tick "Scope not completed" and give a reason, or ask the technician to file the report');
      return;
    }
    const exceptionCount = equipmentList.filter(it=>it.notDone).length;
    const confirmMsg = exceptionCount>0
      ? ('Close this Job Order with '+exceptionCount+' unit'+(exceptionCount===1?'':'s')+' marked as not completed? The customer\'s service request will stay in progress — you can open the next visit for the remaining unit(s) with Continue Tomorrow once this closes.')
      : 'Close this Job Order? This marks it — and the customer\'s service request — as fully done.';
    if(!confirm(confirmMsg)) return;
    // Scoped lookup, NOT $(): dtCloseSection's innerHTML is rebuilt every
    // time a ticket overlay opens, and $() caches a node by id forever —
    // so from the second ticket onward it returns a detached element and
    // the remarks typed here would be silently dropped. (Same trap the
    // srFeeAcceptBtn comment in service-requests.js calls out.)
    const remarksEl = document.getElementById('dtCloseRemarks');
    const remarks = remarksEl ? remarksEl.value.trim() : '';
    $('dtCloseSubmitBtn').disabled = true;
    const ok = await dtCloseTicket(dtOverlayTicket.id, equipmentList, remarks);
    $('dtCloseSubmitBtn').disabled = false;
    if(ok){
      toast('Job Order closed');
      dtCloseTicketOverlay();
      if(currentUser && currentUser.role==='admin') dtRenderAdminList(); else dtRenderTechList();
    }
  });

  // ---- Job Order inquiry thread ----
  async function dtLoadMessages(ticketId){
    if(!(await ensureCloud())) return [];
    try{
      const { data, error } = await db.from('dispatch_ticket_messages').select('*')
        .eq('ticket_id', ticketId).order('created_at', {ascending:true});
      if(error) throw error;
      return data || [];
    }catch(e){ console.error('load JO messages failed', describeCloudError(e)); return []; }
  }
  function dtRenderMessages(msgs){
    const list = $('dtMsgList');
    if(!list) return;
    if(msgs.length===0){
      list.innerHTML = '<div class="empty-state">No messages yet — ask a question about this Job Order here.</div>';
      return;
    }
    list.innerHTML = msgs.map(m=>{
      const mine = currentUser && m.sender_id===currentUser.id;
      const time = new Date(m.created_at).toLocaleString([], {month:'short', day:'numeric', hour:'2-digit', minute:'2-digit'});
      return '<div class="dt-msg-row" style="text-align:'+(mine?'right':'left')+';">'+
        '<div class="dt-msg-meta">'+escapeHtml(m.sender_name)+' · '+time+'</div>'+
        '<div class="dt-msg-bubble" style="background:'+(mine?'var(--green)':'#EEF1EE')+'; color:'+(mine?'#fff':'var(--text)')+';">'+escapeHtml(m.body)+'</div>'+
      '</div>';
    }).join('');
    list.scrollTop = list.scrollHeight;
  }
  // ---- Unread tracking (device-local — no "read receipts" table exists,
  // so this is per-device, not synced across a technician's other phones) ----
  function dtLastReadKey(ticketId){ return 'jo-lastread:'+(currentUser?currentUser.id:'')+':'+ticketId; }
  function dtGetLastRead(ticketId){ try{ return localStorage.getItem(dtLastReadKey(ticketId)); }catch(e){ return null; } }
  function dtMarkRead(ticketId, iso){ try{ localStorage.setItem(dtLastReadKey(ticketId), iso); }catch(e){} }

  async function dtRefreshMessages(){
    if(!dtOverlayTicket) return;
    const msgs = await dtLoadMessages(dtOverlayTicket.id);
    dtRenderMessages(msgs);
    // Viewing the thread marks everything in it read up to this point.
    if(msgs.length>0){
      dtMarkRead(dtOverlayTicket.id, msgs[msgs.length-1].created_at);
      refreshUnreadMsgBadges();
    }
  }
  // Dashboard tile: how many messages across ALL of my tickets arrived after
  // I last opened that specific ticket's thread, from someone other than me.
  // One query covers every ticket — RLS on dispatch_ticket_messages already
  // limits what comes back to messages on tickets I'm actually assigned to
  // (or every ticket, for admin), so no per-ticket filtering is needed here.
  async function dtCountUnreadMessages(){
    if(!currentUser) return 0;
    if(!(await ensureCloud())) return 0;
    try{
      const { data, error } = await db.from('dispatch_ticket_messages').select('ticket_id,sender_id,created_at');
      if(error) throw error;
      let count = 0;
      (data||[]).forEach(m=>{
        if(m.sender_id===currentUser.id) return;
        const lastRead = dtGetLastRead(m.ticket_id);
        if(!lastRead || new Date(m.created_at) > new Date(lastRead)) count++;
      });
      return count;
    }catch(e){ console.error('unread JO message count failed', describeCloudError(e)); return 0; }
  }
  // ---------- Central chat inbox ----------
  // Every job order carries its own thread, which is the right place for a
  // conversation about that job — but it also means an unanswered question
  // is invisible unless you happen to open that ticket. Admin coordinating
  // with technicians is now the ONLY reminder mechanism in the lifecycle
  // (there is no automated nag to technicians, because they cannot close a
  // job order themselves), so a message nobody notices stalls the job.
  //
  // This gathers every thread with something waiting into one list. Built
  // on the same single query that already feeds the unread badge — RLS
  // scopes it per role, so a technician sees only their own tickets'
  // threads and admin sees all of them.
  async function dtLoadChatInbox(){
    if(!currentUser || !(await ensureCloud())) return [];
    try{
      const { data, error } = await db.from('dispatch_ticket_messages')
        .select('ticket_id, sender_id, sender_name, body, created_at')
        .order('created_at', { ascending:false })
        .limit(300);
      if(error) throw error;
      // Newest first from the query, so the FIRST row seen for a ticket is
      // its latest message — no per-thread sorting needed.
      const threads = {};
      (data||[]).forEach(m=>{
        let t = threads[m.ticket_id];
        if(!t){
          t = threads[m.ticket_id] = { ticketId: m.ticket_id, last: m, unread: 0 };
        }
        const lastRead = dtGetLastRead(m.ticket_id);
        if(m.sender_id !== currentUser.id && (!lastRead || new Date(m.created_at) > new Date(lastRead))) t.unread++;
      });
      const list = Object.values(threads);
      // Resolve job order numbers from tickets already in hand where
      // possible; only fetch the ones that aren't, so opening the inbox
      // doesn't re-page the whole ticket table.
      const missing = list.filter(t=> !dtLastTicketsById[t.ticketId]).map(t=> t.ticketId);
      if(missing.length){
        try{
          const { data: rows } = await db.from('dispatch_tickets').select('data').in('id', missing);
          (rows||[]).forEach(r=>{ const n = dtNormalizeTicket(r.data); if(n && n.id) dtLastTicketsById[n.id] = n; });
        }catch(e){ console.error('inbox ticket lookup failed', describeCloudError(e)); }
      }
      list.forEach(t=>{
        const tk = dtLastTicketsById[t.ticketId];
        t.jobOrderNo = tk ? tk.jobOrderNo : t.ticketId;
        t.custName = tk ? tk.custName : '';
        t.status = tk ? dtEffectiveStatus(tk) : null;
      });
      // Unread first — the whole point is surfacing what needs an answer —
      // then most recent. Read threads stay listed so a conversation can be
      // picked back up without hunting for its ticket.
      list.sort((a,b)=>{
        if((b.unread>0) !== (a.unread>0)) return b.unread - a.unread;
        return String(b.last.created_at).localeCompare(String(a.last.created_at));
      });
      return list;
    }catch(e){ console.error('chat inbox load failed', describeCloudError(e)); return []; }
  }

  async function dtRenderChatInbox(){
    // Admin and technician views have their own container; only one is on
    // screen at a time, so the renderer targets whichever is visible rather
    // than each view keeping its own copy of this logic.
    const el = (currentUser && currentUser.role==='admin') ? $('dtAdminInboxList') : $('dtInboxList');
    if(!el) return;
    el.innerHTML = '<div class="empty-state">Loading…</div>';
    const threads = await dtLoadChatInbox();
    if(threads.length===0){
      el.innerHTML = '<div class="empty-state">No job order messages yet.</div>';
      return;
    }
    el.innerHTML = threads.map(t=>{
      const preview = (t.last.body||'').length>90 ? (t.last.body.slice(0,90)+'…') : (t.last.body||'');
      const who = t.last.sender_id===currentUser.id ? 'You' : (t.last.sender_name||'Technician');
      return '<div class="user-card dt-inbox-row" data-ticket-id="'+escapeHtml(t.ticketId)+'" style="cursor:pointer;">'+
          '<div style="display:flex; justify-content:space-between; align-items:flex-start; gap:8px;">'+
            '<div style="min-width:0;">'+
              '<b>'+escapeHtml(t.jobOrderNo)+'</b>'+(t.custName ? ' · '+escapeHtml(t.custName) : '')+
              '<div class="u-status" style="font-size:12px;">'+escapeHtml(who)+': '+escapeHtml(preview)+'</div>'+
            '</div>'+
            (t.unread>0 ? '<span class="status-pill" style="background:var(--danger); color:#fff; flex:none;">'+t.unread+'</span>' : '')+
          '</div>'+
        '</div>';
    }).join('');
    el.querySelectorAll('.dt-inbox-row').forEach(row=>{
      row.onclick = ()=> dtOpenTicketOverlay(row.dataset.ticketId);
    });
  }

  async function dtSendMessage(){
    if(!dtOverlayTicket) return;
    const input = $('dtMsgInput');
    const body = input.value.trim();
    if(!body) return;
    if(!currentUser){ toast('Please sign in again'); return; }
    if(!(await ensureCloud())){ toast('This needs a connection — try again when online'); return; }
    $('dtMsgSendBtn').disabled = true;
    try{
      const { error } = await db.from('dispatch_ticket_messages').insert({
        ticket_id: dtOverlayTicket.id, sender_id: currentUser.id,
        sender_name: currentUser.name, sender_role: currentUser.role,
        body
      });
      if(error) throw error;
      input.value = '';
      await dtRefreshMessages();
      // Realtime only reaches someone who already has THIS ticket's overlay
      // open. Chat is the sole channel admin has to chase an unresolved job
      // order, so a message nobody is notified about is a coordination loop
      // that stalls silently. Best-effort: a failed push must not look like
      // a failed send, since the message itself is already saved.
      try{
        const t = dtOverlayTicket;
        const preview = body.length > 80 ? body.slice(0,80)+'…' : body;
        if(currentUser.role === 'admin'){
          const targets = new Set([].concat(t.assignedWorkerIds||[], t.reportAllowedWorkerIds||[]));
          targets.forEach(id=>{
            if(typeof notifyUser === 'function') notifyUser(id, 'Message on '+t.jobOrderNo, preview, 'jo-chat-'+t.id);
          });
        }else if(typeof notifyAdmins === 'function'){
          notifyAdmins('Message on '+t.jobOrderNo,
            (currentUser.name||'A technician')+': '+preview, 'jo-chat-'+t.id);
        }
      }catch(e){ console.error('JO chat notify failed', e); }
    }catch(e){ console.error('send JO message failed', describeCloudError(e)); toast('Could not send — try again'); }
    $('dtMsgSendBtn').disabled = false;
  }
  $('dtMsgSendBtn').addEventListener('click', dtSendMessage);
  $('dtMsgInput').addEventListener('keydown', (e)=>{
    if(e.key==='Enter' && !e.shiftKey){ e.preventDefault(); dtSendMessage(); }
  });

  // ---------- Schedule Calendar ----------
  // One rendering engine, used both by the Dispatch > Calendar tab (full
  // size, admin-only) and the compact widget on the admin dashboard. Each
  // caller passes its own id "prefix" (e.g. "dtCal" or "homeCal") matching
  // <prefix>Grid / <prefix>MonthLabel / <prefix>DayDetailHead / <prefix>DayList
  // in the HTML, plus the ticket list to draw from — the dashboard widget
  // reuses the tickets renderHomeOverview() already fetched rather than
  // querying again. State (which month/day is showing) is kept per prefix
  // so the two widgets can be on different months at once.
  // Keys are dtEffectiveStatus values, so every stage the pill can show has
  // a dot. 'open' stays mapped for tickets created before the lifecycle
  // change; anything unmatched falls back to grey at the call site.
  const DT_CAL_STATUS_COLORS = {
    scheduled:'#8A9089', preparing:'#B9791F', open:'#B9791F',
    acknowledged:'#1F7A50', in_progress:'#1F6F7A', completed:'#154D34',
    closed:'#8A9089', expired:'#B3402D', cancelled:'#B3402D'
  };
  const dtCalStates = {};
  function dtCalState(prefix){
    if(!dtCalStates[prefix]){
      const n = new Date();
      dtCalStates[prefix] = { year: n.getFullYear(), month: n.getMonth(), selected: todayISO() };
    }
    return dtCalStates[prefix];
  }
  function dtCalPrev(prefix){ const s=dtCalState(prefix); s.month--; if(s.month<0){ s.month=11; s.year--; } }
  function dtCalNext(prefix){ const s=dtCalState(prefix); s.month++; if(s.month>11){ s.month=0; s.year++; } }
  function dtCalGoToday(prefix){ const s=dtCalState(prefix); const n=new Date(); s.year=n.getFullYear(); s.month=n.getMonth(); s.selected=todayISO(); }
  function dtBuildTicketsByDate(tickets){
    const map = {};
    (tickets||[]).forEach(r=>{ if(r.date) (map[r.date] = map[r.date] || []).push(r); });
    return map;
  }
  function dtCalRenderDayList(prefix, tickets){
    const state = dtCalState(prefix);
    const headEl = $(prefix+'DayDetailHead');
    const listEl = $(prefix+'DayList');
    if(!listEl) return;
    const items = dtBuildTicketsByDate(tickets)[state.selected] || [];
    if(headEl) headEl.textContent = leaveFmtDate(state.selected) + (items.length ? ' \u00b7 '+items.length+' scheduled' : '');
    items.forEach(r=> dtLastTicketsById[r.id] = r);
    if(items.length===0){ listEl.innerHTML = '<div class="empty-state">No dispatch tickets scheduled this day.</div>'; return; }
    listEl.innerHTML = '';
    items.forEach(r=>{
      const card = document.createElement('div');
      card.className = 'user-card';
      card.innerHTML = dtCardHtml(r, true);
      listEl.appendChild(card);
    });
  }
  function dtCalRender(prefix, tickets){
    const grid = $(prefix+'Grid');
    if(!grid) return;
    const state = dtCalState(prefix);
    const byDate = dtBuildTicketsByDate(tickets);
    const y = state.year, m = state.month;
    const labelEl = $(prefix+'MonthLabel');
    if(labelEl) labelEl.textContent = new Date(y,m,1).toLocaleDateString('en-US',{month:'long', year:'numeric'});
    const firstDow = new Date(y,m,1).getDay();
    const daysInMonth = new Date(y,m+1,0).getDate();
    const daysInPrevMonth = new Date(y,m,0).getDate();
    const today = todayISO();
    const cells = [];
    for(let i=0;i<firstDow;i++) cells.push({ label: daysInPrevMonth-firstDow+1+i, otherMonth:true });
    for(let d=1; d<=daysInMonth; d++){
      cells.push({ dateStr: y+'-'+String(m+1).padStart(2,'0')+'-'+String(d).padStart(2,'0'), label:d, otherMonth:false });
    }
    let trailing = 1;
    while(cells.length % 7 !== 0){ cells.push({ label: trailing++, otherMonth:true }); }
    grid.innerHTML = cells.map(c=>{
      if(c.otherMonth) return '<div class="cal-cell cal-cell-muted"><span class="cal-cell-num">'+c.label+'</span></div>';
      const dayTickets = byDate[c.dateStr] || [];
      const statuses = {};
      dayTickets.forEach(t=> statuses[dtEffectiveStatus(t)] = true);
      const dots = Object.keys(statuses).slice(0,4)
        .map(s=> '<span class="cal-dot" style="background:'+(DT_CAL_STATUS_COLORS[s]||'#8A9089')+'"></span>').join('');
      const isToday = c.dateStr===today, isSelected = c.dateStr===state.selected;
      return '<button type="button" class="cal-cell'+(isToday?' cal-cell-today':'')+(isSelected?' cal-cell-selected':'')+'" data-date="'+c.dateStr+'">'+
        '<span class="cal-cell-num">'+c.label+'</span>'+
        (dayTickets.length ? '<span class="cal-cell-dots">'+dots+'</span><span class="cal-cell-count">'+dayTickets.length+'</span>' : '')+
        '</button>';
    }).join('');
    grid.querySelectorAll('.cal-cell[data-date]').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        state.selected = btn.dataset.date;
        dtCalRender(prefix, tickets);
      });
    });
    dtCalRenderDayList(prefix, tickets);
  }
  $('dtCalPrevBtn').addEventListener('click', ()=>{ dtCalPrev('dtCal'); dtCalRender('dtCal', dtCalTicketsCache); });
  $('dtCalNextBtn').addEventListener('click', ()=>{ dtCalNext('dtCal'); dtCalRender('dtCal', dtCalTicketsCache); });
  $('dtCalTodayBtn').addEventListener('click', ()=>{ dtCalGoToday('dtCal'); dtCalRender('dtCal', dtCalTicketsCache); });
  $('dtCalDayList').addEventListener('click', dtHandleEquipRowClick);
  let dtCalTicketsCache = [];
  async function dtRenderCalendarTab(){
    $('dtCalGrid').innerHTML = '<div class="empty-state">Loading…</div>';
    dtCalTicketsCache = await dtListAll();
    dtCalRender('dtCal', dtCalTicketsCache);
  }

  async function showDispatchView(initialTab){
    document.body.classList.remove('dashboard-active');
    $('homeScreen').style.display = 'none';
    $('serviceReportView').style.display = 'none';
    $('dtrView').style.display = 'none';
    $('leaveView').style.display = 'none';
    $('cashAdvanceView').style.display = 'none';
    $('equipmentManagerView').style.display = 'none';
    $('customersManagerView').style.display = 'none';
    $('serviceReportsManagerView').style.display = 'none';
    $('messagesView').style.display = 'none';
    $('documentsView').style.display = 'none';
    if($('financeHrView')) $('financeHrView').style.display = 'none';
    $('customerHistoryView').style.display = 'none';
    $('serviceRequestsView').style.display = 'none';
    $('dispatchView').style.display = '';
    $('footerBar').style.display = 'none';
    $('metaBar').style.display = 'none';
    $('homeBtn').style.display = '';
    setHeaderTitle(
      (currentUser && currentUser.role==='admin') ? 'Service Dispatch Ticket' : 'My Job Order',
      'Assign and track field jobs'
    );
    window.scrollTo({top:0});
    // customersCache (used by the customer combo below) is only populated by
    // whichever screen happens to load it first — Service Report's startup
    // sequence, or Manage Customers. If Dispatch is the first screen opened
    // after logging in, that cache is still empty here, so the customer
    // suggestion list had nothing to show — looked exactly like a missing
    // dropdown. Loading it here too means it's always populated by the time
    // the combo is set up, regardless of what screen was visited first.
    if(!customersCache || customersCache.length===0) await loadCustomers();
    dtSetupCustomerCombo();
    if(currentUser && currentUser.role==='admin'){
      $('dispatchTechArea').style.display = 'none';
      $('dispatchAdminArea').style.display = '';
      dtShowAdminTab(initialTab || 'new');
    }else{
      $('dispatchAdminArea').style.display = 'none';
      $('dispatchTechArea').style.display = '';
      // dtTechListTab is module-level, so leaving and returning keeps the
      // tab you were on — including Messages. Rendering the job order list
      // unconditionally painted it into a container the inbox had hidden,
      // leaving stale threads on screen that never refreshed.
      dtSetTechListTab(dtTechListTab);
    }
    // Safe to call on every view open — dtSubscribeTickets drops any
    // previous channel before opening a new one, so repeated navigation
    // can't stack subscriptions.
    dtSubscribeTickets();
  }

  async function showLeaveView(){
    document.body.classList.remove('dashboard-active');
    $('homeScreen').style.display = 'none';
    $('serviceReportView').style.display = 'none';
    $('dtrView').style.display = 'none';
    $('cashAdvanceView').style.display = 'none';
    $('dispatchView').style.display = 'none';
    $('equipmentManagerView').style.display = 'none';
    $('customersManagerView').style.display = 'none';
    $('serviceReportsManagerView').style.display = 'none';
    $('messagesView').style.display = 'none';
    $('documentsView').style.display = 'none';
    if($('financeHrView')) $('financeHrView').style.display = 'none';
    $('customerHistoryView').style.display = 'none';
    $('serviceRequestsView').style.display = 'none';
    $('leaveView').style.display = '';
    $('footerBar').style.display = 'none';
    $('metaBar').style.display = 'none';
    $('homeBtn').style.display = '';
    setHeaderTitle('Leave Form', 'File and track leave requests');
    window.scrollTo({top:0});
    if(currentUser && currentUser.role==='admin'){
      $('leaveTechArea').style.display = 'none';
      $('leaveAdminArea').style.display = '';
      leaveRenderAdminList();
    }else{
      $('leaveTechArea').style.display = '';
      $('leaveAdminArea').style.display = 'none';
      leaveShowTab('new');
    }
  }
