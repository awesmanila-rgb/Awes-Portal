// ---------- Customer Portal (customer-facing home screen) ----------
// Read-only view for logged-in customer accounts: their enrolled equipment,
// service report history, and open service requests.
//
// SCHEMA NOTES / ASSUMPTIONS (please verify against your Supabase project):
//
// 1. customer_equipment already exists and is keyed by customer_id — this
//    module reuses it as-is (see customers.js: EQUIP_FIELD_TO_COLUMN).
//
// 2. service_reports is matched to a customer via its `customer_id`
//    foreign key (added in 20260904_01_customer_portal.sql, set on every
//    new report by reportToRow() in core.js, and backfilled onto historic
//    rows by 20260908_02_backfill_report_customer_id.sql). This is also
//    what the "customers read own reports" RLS policy checks, so the
//    query below and RLS now agree. Do not switch this back to matching
//    on cust_name (free text) — that was tried first and is fragile: a
//    typo'd or inconsistently-cased name silently excludes reports that
//    RLS would otherwise correctly allow through.
//
// 3. "Status" — PM (preventive maintenance) due, overdue, on schedule, or
//    none scheduled — is derived from customer_equipment.next_pm_date (see
//    supabase/migrations/20260908_03_customer_equipment_next_pm_date.sql),
//    an admin-set tentative date, not anything measured off the equipment
//    itself. See computeEquipmentStatus() below.
//
// 4. Requires a `profiles` row with role='customer' and a `customer_id`
//    column added to profiles, so a logged-in customer account can be
//    resolved to a customers.id row. See customers table already used by
//    customers.js. Also needs a Supabase RLS policy scoping
//    customer_equipment/service_reports SELECT to rows matching the caller's
//    own customer_id — without RLS, any authenticated customer could query
//    another customer's data directly via the JS client.

  let cpEquipment = [];   // this customer's equipment, from customer_equipment
  let cpReports = [];     // this customer's service reports, most recent first
  let cpCustomer = null;  // {id, name, ...} row from customers
  let cpMyRequestsCache = []; // this customer's service_requests, kept fresh by
                              // cpRefreshRequestsBadge() — feeds the home hero,
                              // the notif bell, and the History screen's
                              // Requests segment so none of them re-fetch it
                              // separately on every render.

  // Loads into local variables and swaps them in at the end, in one step.
  // It used to clear cpEquipment/cpReports first and then await the
  // network — and the 30-second refresh (plus the request-badge refresh
  // that runs alongside it) could render in that gap, so sections briefly
  // showed "no units", lost their overdue items, or swapped text. Only a
  // switch to a different account clears first, so one account's data is
  // never shown under another.
  let cpLoadedCustomerId = null;
  let cpLoadSeq = 0;
  async function loadCustomerPortalData(customerId){
    if(customerId !== cpLoadedCustomerId){ cpCustomer = null; cpEquipment = []; cpReports = []; }
    if(!customerId) return;
    if(!(await ensureCloud())) return;
    const seq = ++cpLoadSeq;
    let nCustomer = null, nEquipment = [], nReports = [], failed = false;
    try{
      const { data: custRow, error: custErr } = await db.from('customers')
        .select('*').eq('id', customerId).maybeSingle();
      if(custErr) throw custErr;
      nCustomer = custRow || null;
    }catch(e){ failed = true; console.error('load customer record failed', describeCloudError(e)); }

    try{
      const { data, error } = await db.from('customer_equipment')
        .select('*').eq('customer_id', customerId).order('id');
      if(error) throw error;
      nEquipment = (data||[]).map(row => ({
        id: row.id, equipType: row.equip_type, equipLocation: row.equip_location,
        brand: row.brand, mountType: row.mount_type, coolCap: row.cool_cap,
        modelCU: row.model_cu, serialCU: row.serial_cu, modelFCU: row.model_fcu, serialFCU: row.serial_fcu,
        nextPmDate: row.next_pm_date || '',
        // Inverter yes/no from the unit's Compressor Type (see
        // equipIsInverter, core.js) — used by the Tools calculators.
        compressorType: row.compressor_type || '',
        inverter: equipIsInverter(row.compressor_type),
        // Admin-set display name for this unit (see
        // 20260909_02_customer_equipment_label.sql) — equipDisplayName()
        // (core.js) shows this instead of the raw id once it's set.
        label: row.label || ''
      }));
      // Photo counts — one query for the whole grid rather than one per
      // card. Powers the small "📷 N" badge in cpEquipmentCardHtml below;
      // actual thumbnails only load in the per-unit detail screen (see
      // renderCustomerEquipmentPhotos, customer-equipment-history.js).
      const photoCounts = await cloudGetEquipmentPhotoCounts(customerId);
      nEquipment.forEach(eq=> eq.photoCount = photoCounts[eq.id] || 0);
    }catch(e){ failed = true; console.error('load customer equipment failed', describeCloudError(e)); }

    if(nCustomer){
      try{
        // Matched by service_reports.customer_id, not cust_name — see
        // schema note #2 above. That column now exists, is set on every
        // new report (reportToRow() in core.js) and was backfilled onto
        // historic rows (20260908_02_backfill_report_customer_id.sql), and
        // it's what the "customers read own reports" RLS policy itself
        // checks. Matching cust_name here as well was fragile: a report
        // whose cust_name didn't exactly match customers.name (typo,
        // different casing/whitespace, a nickname a technician typed in)
        // was otherwise fully visible under RLS but got filtered out by
        // this query before ever reaching the equipment history screen —
        // which is why a unit with real recorded visits could still show
        // "0 service visits". Selecting the full set of columns here (not
        // just summary fields) so the equipment history screen can show
        // findings/recommendations/materials/services done per visit
        // without a second round-trip per unit.
        const { data, error } = await db.from('service_reports')
          .select('id, sr_no, date, cust_name, equipment_id, service_category, equip_type, equip_location, model_cu, serial_cu, model_fcu, serial_fcu, trouble_call, remarks, completed, technician_name, findings, recommendations, materials, services_done')
          .eq('customer_id', nCustomer.id)
          .order('date', { ascending:false });
        if(error) throw error;
        nReports = data || [];
      }catch(e){ failed = true; console.error('load customer reports failed', describeCloudError(e)); }
    }

    // Attach each equipment's full matching report history, for the
    // "Last serviced" date and the equipment detail screen (status itself
    // is now computed from next_pm_date, not report history — see
    // computeEquipmentStatus below). Matching logic lives in
    // matchReportHistoryForEquipment() (core.js) — shared with the admin
    // equipment detail overlay's own history section.
    nEquipment.forEach(eq => {
      eq.reportHistory = matchReportHistoryForEquipment(nReports, eq);
      eq.lastReport = eq.reportHistory[0] || null;
      eq.status = computeEquipmentStatus(eq);
    });
    // A newer load started while this one was running — let that one win.
    if(seq !== cpLoadSeq) return;
    // A failed refresh (weak signal, offline) keeps what is already on
    // screen instead of blanking it; a first load still shows what it got.
    if(failed && customerId === cpLoadedCustomerId) return;
    cpCustomer = nCustomer; cpEquipment = nEquipment; cpReports = nReports;
    cpLoadedCustomerId = customerId;
  }

  // ---------- PM (preventive maintenance) due status ----------
  // Admin sets a tentative next-PM date per unit (Manage Equipment List →
  // tap a unit → Next PM Date, see admin.js/customers.js). The status pill
  // below is derived entirely from that date — overdue, due soon, on
  // schedule, or no date set. This replaces the old heuristic that guessed
  // "Needs attention" from whatever text happened to land in the last
  // report's remarks: nobody at AWES is actually monitoring these units
  // remotely, so that implied a kind of live condition-monitoring that
  // never existed. If a unit genuinely needs attention, the customer taps
  // "Request Service" themselves rather than waiting for a pill to notice.
  const PM_DUE_SOON_DAYS = 30;
  function daysUntil(iso){
    if(!iso) return null;
    const target = new Date(iso+'T00:00:00');
    const today = new Date(todayISO()+'T00:00:00');
    return Math.round((target - today) / 86400000);
  }
  function computeEquipmentStatus(eq){
    const days = daysUntil(eq.nextPmDate);
    if(days === null) return { key:'none', label:'No PM Scheduled' };
    if(days < 0) return { key:'overdue', label:'PM Overdue' };
    if(days <= PM_DUE_SOON_DAYS) return { key:'due-soon', label:'PM Due Soon' };
    return { key:'scheduled', label:'On Schedule' };
  }

  function cpStatusPillHtml(status){
    return '<span class="status-pill status-'+status.key+'">'+escapeHtml(status.label)+'</span>';
  }

  function cpUpdateSidebarBadge(id, count){
    const el = $(id);
    if(!el) return;
    if(count > 0){ el.textContent = String(count); el.style.display = ''; }
    else { el.style.display = 'none'; }
  }

  function cpEquipmentCardHtml(eq){
    // Same field order as the admin/technician equipment lines: Location,
    // Brand, Mount type, Equipment type, Capacity.
    const loc = escapeHtml(eq.equipLocation || 'Equipment');
    const details = [eq.brand, eq.mountType, eq.equipType, eq.coolCap].filter(Boolean).map(escapeHtml).join(' · ') || '—';
    const lastDate = eq.lastReport ? fmtDate(eq.lastReport.date) : '—';
    const pmLine = eq.status.key==='none' ? 'No PM scheduled'
      : eq.status.key==='overdue' ? 'PM was due '+escapeHtml(fmtDate(eq.nextPmDate))
      : 'Next PM: '+escapeHtml(fmtDate(eq.nextPmDate));
    // equipDisplayName() (core.js) shows this unit's admin-set label once
    // one exists (see 20260909_02_customer_equipment_label.sql); until
    // then it falls back to a shortened form of the fixed equipment id, so
    // every unit still shows some stable identifier a customer can
    // reference when requesting service.
    const idTag = escapeHtml(equipDisplayName(eq)) + (eq.photoCount ? ' &nbsp;<span style="display:inline-flex; width:11px; height:11px; vertical-align:-1px;">'+CP_ICON.camera+'</span> '+eq.photoCount : '');
    return (
      '<div class="cp-equip-card" data-equip-id="'+eq.id+'">'+
        '<div class="cp-equip-card-top">'+
          '<div class="cp-equip-icon">'+CP_ICON.unit+'</div>'+
          cpStatusPillHtml(eq.status)+
        '</div>'+
        '<div class="cp-unit-tag" style="font-size:11px; font-weight:600; letter-spacing:.02em; color:var(--text-muted); text-transform:uppercase;">'+idTag+'</div>'+
        '<div class="cp-unit-name">'+loc+'</div>'+
        '<div class="cp-unit-loc">'+details+'</div>'+
        '<div class="cp-unit-date">Last serviced '+escapeHtml(lastDate)+'</div>'+
        '<div class="cp-unit-date">'+pmLine+'</div>'+
      '</div>'
    );
  }

  // ---------- Icons ----------
  // Inline SVG only (no emoji, no icon font) so the redesigned screens read
  // as one consistent system — stroke="currentColor" so each icon just
  // picks up whatever color its container sets.
  const CP_ICON = {
    chat:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>',
    home:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9.5 12 3l9 6.5V21a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z"/></svg>',
    grid:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>',
    clock:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>',
    tools:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2-2z"/></svg>',
    person:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>',
    check:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
    calendar:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/></svg>',
    alert:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 2 20h20L12 3z"/><path d="M12 10v4M12 17h.01"/></svg>',
    unit:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="18" height="9" rx="1.5"/><path d="M7 15v3M17 15v3M3 9h18M6 9V7M10 9V7"/></svg>',
    receipt:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/></svg>',
    history:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5M12 7v5l4 2"/></svg>',
    bolt:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 4 14h6l-1 8 9-12h-6z"/></svg>',
    ruler:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8h18v8H3z"/><path d="M7 8v3M11 8v3M15 8v3"/></svg>',
    piggy:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12a6 6 0 0 1 6-6h4a6 6 0 0 1 0 12v3l-3-2H10a6 6 0 0 1-6-6z"/><circle cx="15" cy="10" r=".6" fill="currentColor"/></svg>',
    leaf:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 21c9 0 14-5 14-14V5h-2C8 5 3 10 3 19z"/></svg>',
    book:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z"/><path d="M19 19H6a2 2 0 0 1 0-4h13"/></svg>',
    chevron:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>',
    pin:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/></svg>',
    search:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>',
    camera:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h3l2-2h6l2 2h3v11H4z"/><circle cx="12" cy="13.5" r="3.5"/></svg>',
    // Booking/"no active service" icon — a card-like tile with a horizontal
    // band, matching the reference mock's rounded booking icon.
    card:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M3 10h18"/></svg>',
    bulb:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-3.6 10.8c.7.6 1.1 1.4 1.1 2.2h5c0-.8.4-1.6 1.1-2.2A6 6 0 0 0 12 3z"/></svg>',
    clipboard:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4h6v3H9z"/><path d="M9 12h6M9 16h4"/></svg>',
    flame:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22c4 0 7-2.7 7-6.8 0-3.2-2-5.5-3.6-7.3-.4 2-1.5 3.2-2.9 3.6C13 8 12.2 5 9.5 2.5 9.6 6.2 5 9 5 15.2 5 19.3 8 22 12 22z"/></svg>',
    calculator:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="3" width="14" height="18" rx="2"/><path d="M8 7h8"/><path d="M8 12h.01M12 12h.01M16 12h.01M8 16h.01M12 16h.01M16 16h.01"/></svg>',
    download:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11M7 10l5 5 5-5"/><path d="M5 20h14"/></svg>',
    plus:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>',
    // Swap/exchange arrows — cpQuickAccounts tile (switching between this
    // login's linked customer accounts).
    swap:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 3 3 7l4 4"/><path d="M3 7h13a4 4 0 0 1 4 4v1"/><path d="M17 21l4-4-4-4"/><path d="M21 17H8a4 4 0 0 1-4-4v-1"/></svg>'
  };

  // ---------- Unit card (photo-led, vertical stack) ----------
  // Same card is used on Home (capped list) and the Units screen (full
  // list) — one visual design instead of two, matching this theme's
  // layout. photoMap is an optional {equipmentId: url} lookup (see
  // cpFetchCoverPhotoMap in equipment-photos.js); falls back to the
  // generic tinted unit icon when nothing comes back for a given unit
  // (no cover photo set, or none uploaded yet).
  function cpUnitStateClass(eq){
    if(eq.status.key==='overdue') return 'state-danger';
    if(eq.status.key==='due-soon') return 'state-active';
    if(eq.status.key==='scheduled') return 'state-teal';
    return 'state-good';
  }
  // ---------- Unit card ----------
  // Photo + name/spec row on top, a status badge floating above the card's
  // top-left corner, and a full-width footer row (status pill + view link)
  // below — matches the reference mock's layout (a shorter, inset photo
  // rather than a full-height edge-to-edge one, and the footer no longer
  // squeezed into the text column). cornerLabel (the floating badge) stays
  // the broad ALL-CAPS state; footLabel is a more specific, friendlier
  // phrase for the same state — two different pieces of copy for two
  // different jobs, not the same label repeated twice like the old design.
  function cpUnitCardHtml(eq, photoMap){
    const stateClass = cpUnitStateClass(eq);
    const name = escapeHtml(equipDisplayName(eq));
    // Status words describe the PM date only — the app has no live reading
    // of the unit's condition, so it never says "operating well".
    const cornerLabel = eq.status.key==='overdue' ? 'PM overdue' : eq.status.key==='due-soon' ? 'PM due soon' : eq.status.key==='scheduled' ? 'Up to date' : 'No PM date';
    const footLabel = eq.status.key==='overdue' ? 'PM was due '+escapeHtml(fmtDate(eq.nextPmDate))
      : eq.status.key==='due-soon' ? 'PM due '+escapeHtml(fmtDate(eq.nextPmDate))
      : eq.status.key==='scheduled' ? 'Next PM '+escapeHtml(fmtDate(eq.nextPmDate)) : 'No maintenance date set';
    const specLine = [eq.brand, eq.equipType, eq.coolCap].filter(Boolean).map(escapeHtml).join(' · ') || escapeHtml(eq.equipLocation||'—');
    const lastLine = eq.lastReport ? 'Last service '+escapeHtml(fmtDate(eq.lastReport.date)) : 'No service on record yet';
    const photoUrl = photoMap && photoMap[eq.id];
    return (
      '<div class="cp-unit-card '+stateClass+'" data-equip-id="'+eq.id+'" data-status="'+eq.status.key+'">'+
        '<span class="cp-unit-badge-corner '+stateClass+'">'+cornerLabel+'</span>'+
        '<div class="top">'+
          '<div class="img-wrap">'+
            (photoUrl
              ? '<img src="'+escapeHtml(photoUrl)+'" alt="" loading="lazy">'
              : '<div class="fallback-ic">'+CP_ICON.unit+'</div>')+
          '</div>'+
          '<div class="info">'+
            '<p class="name">'+name+'</p>'+
            '<p class="meta">'+specLine+' · '+lastLine+'</p>'+
          '</div>'+
        '</div>'+
        '<div class="foot">'+
          '<span class="cp-unit-badge '+stateClass+'">'+footLabel+'</span>'+
          '<a class="view-link">View details →</a>'+
        '</div>'+
      '</div>'
    );
  }

  // ---------- Home (redesign) ----------
  // Layout, top to bottom: Action needed (only when something waits on the
  // customer) → Next visit (always the same card) → three main actions →
  // Your units (status summary + the units that need attention) →
  // Upcoming maintenance → Recent service reports → Support.
  //
  // Wording rule for this page: say only what the app actually knows. Unit
  // status comes from the admin-set next PM date, nothing else — nobody is
  // monitoring the equipment remotely, so the page never claims a unit is
  // "operating well" or "being monitored".

  // Support card. Fill these in with the office's real details — the card
  // shows a Call button only when `phone` is set, otherwise it offers
  // Message us instead.
  const CP_SUPPORT = {
    phone: '',                                   // e.g. '(02) 8123 4567' — shown and dialled as typed
    hours: 'Monday to Saturday, 8:00 AM to 6:00 PM'
  };

  // Writes a section only when its markup actually changed. The home page
  // re-renders on every 30-second refresh and on every request update; an
  // unconditional innerHTML swap rebuilt every card and reloaded every
  // photo each time, which is what showed as cards blinking.
  function cpSetHtml(el, html){
    if(!el) return false;
    if(el._cpHtml === html) return false;
    el.innerHTML = html;
    el._cpHtml = html;
    return true;
  }
  function cpShow(el, on){ if(el){ const v = on ? '' : 'none'; if(el.style.display !== v) el.style.display = v; } }
  function cpEquipLabel(eq){ return eq ? escapeHtml(equipDisplayName(eq)) : 'your unit'; }
  function cpFindEquip(id){ return cpEquipment.find(e=> String(e.id)===String(id)); }
  function cpIsActiveStatus(status){
    return ['preparing','dispatched','en_route','in_progress'].includes(status);
  }
  function cpTimeGreeting(){
    const h = new Date().getHours();
    if(h < 12) return 'Good morning';
    if(h < 18) return 'Good afternoon';
    return 'Good evening';
  }
  function cpSetGreetingName(){
    if($('cpGreetTod')) $('cpGreetTod').textContent = cpTimeGreeting();
    const first = String(currentUser.name||'').trim().split(/\s+/)[0];
    $('cpGreetingName').textContent = first || 'there';
  }
  const CP_AVATAR_COLORS = ['#154D34','#1F6F7A','#B9791F','#6B4FA0','#2A6FDB'];
  function cpAvatarColor(name){
    let h = 0; for(let i=0;i<name.length;i++) h = (h*31 + name.charCodeAt(i)) >>> 0;
    return CP_AVATAR_COLORS[h % CP_AVATAR_COLORS.length];
  }
  function cpInitials(name){
    const p = String(name||'').trim().split(/\s+/).filter(Boolean);
    return ((p[0]||'?').charAt(0) + (p.length>1 ? p[p.length-1].charAt(0) : '')).toUpperCase();
  }
  function cpFmtShort(iso){
    if(!iso) return '';
    return new Date(String(iso).slice(0,10)+'T00:00:00').toLocaleDateString('en-PH', {month:'short', day:'numeric'});
  }
  function cpRelDay(iso){
    const d = daysUntil(String(iso||'').slice(0,10));
    const long = new Date(String(iso).slice(0,10)+'T00:00:00').toLocaleDateString('en-PH', {month:'short', day:'numeric'});
    if(d === 0) return 'Today, '+long;
    if(d === 1) return 'Tomorrow, '+long;
    return new Date(String(iso).slice(0,10)+'T00:00:00').toLocaleDateString('en-PH', {weekday:'long', month:'short', day:'numeric'});
  }
  // Customer-facing wording for a unit's PM status.
  function cpPmLine(eq){
    const k = eq.status.key;
    if(k==='overdue') return { tone:'danger', pill:'Overdue', line:'PM was due '+cpFmtShort(eq.nextPmDate) };
    if(k==='due-soon') return { tone:'warn', pill:'Due soon', line:'PM due '+cpFmtShort(eq.nextPmDate) };
    if(k==='scheduled') return { tone:'ok', pill:'Up to date', line:'Next PM '+cpFmtShort(eq.nextPmDate) };
    return { tone:'muted', pill:'No PM date', line:'No maintenance date set' };
  }

  // ---- Action needed ----
  function cpActionItems(rows){
    const items = [];
    rows.forEach(r=>{
      const eq = cpFindEquip(r.equipmentId);
      const what = r.equipmentId ? cpEquipLabel(eq) : 'General request';
      if(r.status==='fee_proposed' && r.feeStatus==='proposed'){
        items.push({ tone:'warn', ic:'receipt', req:r,
          title:'Approve service fee · ₱'+escapeHtml(Number(r.feeAmount||0).toLocaleString('en-PH')),
          sub: what+(r.description ? ' · '+escapeHtml(String(r.description).slice(0,80)) : ''),
          btn:'Review and approve' });
      }else if(r.status==='schedule_proposed'){
        const when = r.proposedScheduleDate ? cpRelDay(r.proposedScheduleDate)+(r.proposedScheduleTime ? ' · '+escapeHtml(r.proposedScheduleTime) : '') : 'A date is waiting for you';
        items.push({ tone:'warn', ic:'calendar', req:r,
          title:'Confirm your visit schedule', sub: when+' · '+what, btn:'Review and confirm' });
      }else if(r.origin==='technician_flag' && !['completed','closed','cancelled','preparing','dispatched','en_route','in_progress','schedule_confirmed'].includes(r.status)){
        items.push({ tone:'info', ic:'alert', req:r,
          title:'Issue found during a visit',
          sub: what+' · '+escapeHtml(String(r.flaggedIssueSummary || r.description || 'Our technician noted something to fix.').slice(0,90))+'. We\u2019ll send a quotation.',
          btn:'View details', secondary:true });
      }
    });
    const overdue = cpEquipment.filter(eq=> eq.status.key==='overdue' &&
      !rows.some(r=> String(r.equipmentId)===String(eq.id) && !['completed','closed','cancelled'].includes(r.status)));
    if(overdue.length===1){
      items.push({ tone:'danger', ic:'calendar', equip:overdue[0], act:'bookOverdue',
        title:'Maintenance overdue', sub: cpEquipLabel(overdue[0])+' · PM was due '+cpFmtShort(overdue[0].nextPmDate), btn:'Book maintenance' });
    }else if(overdue.length>1){
      items.push({ tone:'danger', ic:'calendar', act:'bookOverdueMany', list:overdue,
        title:overdue.length+' units overdue for maintenance', sub: overdue.slice(0,3).map(cpEquipLabel).join(', ')+(overdue.length>3 ? ' and '+(overdue.length-3)+' more' : ''), btn:'Book maintenance' });
    }
    return items;
  }
  function cpRenderActions(rows){
    const items = cpActionItems(rows);
    const need = items.filter(i=> i.tone!=='info').length;
    cpShow($('cpActionWrap'), items.length);
    $('cpActionCount').textContent = need ? need+' item'+(need===1?'':'s') : '';
    cpSetHtml($('cpActionList'), items.map((it, i)=>
      '<div class="cph-card cph-action cph-t-'+it.tone+'">'+
        '<div class="cph-row-top"><span class="cph-ic cph-ic-'+it.tone+'">'+CP_ICON[it.ic]+'</span>'+
        '<div class="cph-text"><p class="cph-title">'+it.title+'</p><p class="cph-sub">'+it.sub+'</p></div></div>'+
        '<button type="button" class="cph-btn'+(it.secondary ? '' : ' cph-btn-primary')+'" data-act-idx="'+i+'">'+it.btn+'</button>'+
      '</div>').join(''));
    $('cpActionList').onclick = (e)=>{
      const b = e.target.closest('[data-act-idx]'); if(!b) return;
      const it = items[Number(b.dataset.actIdx)]; if(!it) return;
      if(it.req){ if(typeof srOpenDetail==='function') srOpenDetail(it.req); return; }
      if(it.act==='bookOverdue') cpBookPm([it.equip]);
      else if(it.act==='bookOverdueMany') cpBookPm(it.list);
    };
  }

  // ---- Next visit ----
  // Customer words for the lifecycle. "On the way" lights up only at
  // en_route — i.e. after the whole crew acknowledged, the same moment the
  // "Your technician is on the way" notification goes out — never at
  // Preparing.
  const CP_TRACK = ['Booked','Confirmed','On the way','Working','Done'];
  function cpTrackIdx(status){
    if(status==='en_route') return 2;
    if(status==='in_progress') return 3;
    if(status==='completed' || status==='closed') return 4;
    return 1; // schedule_confirmed / preparing / dispatched
  }
  function cpTrackHtml(status){
    const cur = cpTrackIdx(status);
    let dots = '<div class="cph-track">';
    CP_TRACK.forEach((_, i)=>{
      if(i) dots += '<span class="cph-track-ln'+(i<=cur ? ' on' : '')+'"></span>';
      dots += '<span class="cph-track-dot'+(i<cur || (i===cur && cur===4) ? ' on' : i===cur ? ' now' : '')+'">'+(i<cur || (i===cur && cur===4) ? CP_ICON.check : (i+1))+'</span>';
    });
    dots += '</div><div class="cph-track-lb">'+CP_TRACK.map((l,i)=> '<span'+(i===cur ? ' class="now"' : '')+'>'+l+'</span>').join('')+'</div>';
    return dots;
  }
  function cpVisitWhen(r){
    const d = r.proposedScheduleDate || r.requestedDate;
    return d ? cpRelDay(d)+(r.proposedScheduleTime ? ' · '+escapeHtml(r.proposedScheduleTime) : '') : 'Date to be confirmed';
  }
  let cpHeroSeq = 0;
  async function renderCustomerHero(rows){
    const hero = $('cpHero');
    if(!hero) return;
    const seq = ++cpHeroSeq;
    rows = rows || [];
    cpRenderActions(rows);

    const live = rows.filter(r=> cpIsActiveStatus(r.status) || r.status==='completed');
    const upcoming = rows.filter(r=> r.status==='schedule_confirmed')
      .sort((a,b)=> String(a.proposedScheduleDate||a.requestedDate||'').localeCompare(String(b.proposedScheduleDate||b.requestedDate||'')));
    const subject = live[0] || upcoming[0] || null;
    const others = live.length + upcoming.length - (subject ? 1 : 0);
    $('cpVisitTitle').textContent = subject && live.length ? 'Current visit' : 'Next visit';
    const more = $('cpVisitMore');
    cpShow(more, others>0);
    more.textContent = others>0 ? '+'+others+' more' : '';
    more.onclick = ()=> cpShowScreen('Requests');

    if(!subject){
      const next = cpEquipment.filter(eq=> eq.nextPmDate && daysUntil(eq.nextPmDate)>=0)
        .sort((a,b)=> a.nextPmDate.localeCompare(b.nextPmDate))[0];
      // No second "Book a service" button here — the main one sits right
      // below this card.
      cpSetHtml(hero,
        '<div class="cph-row-top"><span class="cph-ic cph-ic-muted">'+CP_ICON.calendar+'</span>'+
        '<div class="cph-text"><p class="cph-title">No visit booked</p>'+
        '<p class="cph-sub">'+(next ? 'Next maintenance is due '+escapeHtml(cpRelDay(next.nextPmDate))+' for '+cpEquipLabel(next)+'.' : 'When you book a service, the date and your technician will show here.')+'</p></div></div>');
      hero.onclick = null;
      return;
    }
    const eq = cpFindEquip(subject.equipmentId);
    const techNames = (subject.linkedDispatchTicketId && typeof dtFetchTicketTechNames==='function' && subject.status!=='schedule_confirmed')
      ? await dtFetchTicketTechNames(subject.linkedDispatchTicketId).catch(()=>[]) : [];
    // A newer render started while the names were loading — it owns the card.
    if(seq !== cpHeroSeq) return;
    const doneNote = subject.status==='completed' ? '<p class="cph-note">Work is finished. Your service report will appear below once it\u2019s signed off.</p>' : '';
    const techHtml = techNames && techNames.length
      ? '<div class="cph-tech"><span class="cph-avatar" style="background:'+cpAvatarColor(techNames[0])+'">'+escapeHtml(cpInitials(techNames[0]))+'</span>'+
          '<div class="cph-text"><p class="cph-tech-name">'+escapeHtml(techNames[0])+(techNames.length>1 ? ' + '+(techNames.length-1) : '')+'</p>'+
          '<p class="cph-sub">'+(techNames.length>1 ? 'Assigned technicians' : 'Assigned technician')+'</p></div>'+
          '<button type="button" class="cph-icon-btn" data-hero="msg" aria-label="Message">'+CP_ICON.chat+'</button></div>'
      : '<div class="cph-tech"><span class="cph-avatar cph-avatar-muted">'+CP_ICON.person+'</span>'+
          '<div class="cph-text"><p class="cph-tech-name">Technician to be assigned</p><p class="cph-sub">You\u2019ll see who\u2019s coming once the crew confirms</p></div>'+
          '<button type="button" class="cph-icon-btn" data-hero="msg" aria-label="Message">'+CP_ICON.chat+'</button></div>';
    cpSetHtml(hero,
      '<p class="cph-title">'+cpVisitWhen(subject)+'</p>'+
      '<p class="cph-sub">'+cpEquipLabel(eq)+(subject.description ? ' · '+escapeHtml(String(subject.description).slice(0,90)) : '')+'</p>'+
      techHtml+cpTrackHtml(subject.status)+doneNote+
      '<button type="button" class="cph-link-btn" data-hero="open">View request</button>');
    hero.onclick = (e)=>{
      const a = e.target.closest('[data-hero]'); if(!a) return;
      if(typeof srOpenDetail==='function') srOpenDetail(subject);
    };
  }

  // ---- Units ----
  function cpUnitCounts(){
    const c = { overdue:0, 'due-soon':0, scheduled:0, none:0 };
    cpEquipment.forEach(eq=> c[eq.status.key] = (c[eq.status.key]||0) + 1);
    return c;
  }
  function cpHomeUnitRowHtml(eq, photoMap){
    const pm = cpPmLine(eq);
    const url = photoMap && photoMap[eq.id];
    const spec = [eq.brand, eq.coolCap].filter(Boolean).map(escapeHtml).join(' · ');
    const last = eq.lastReport ? 'last service '+escapeHtml(cpFmtShort(eq.lastReport.date)) : 'no service on record';
    return '<button type="button" class="cph-unit" data-equip-id="'+escapeHtml(String(eq.id))+'">'+
      '<span class="cph-unit-img">'+(url ? '<img src="'+escapeHtml(url)+'" alt="" loading="lazy">' : CP_ICON.unit)+'</span>'+
      '<span class="cph-text"><span class="cph-unit-name">'+cpEquipLabel(eq)+'</span>'+
      '<span class="cph-sub">'+(spec ? spec+' · ' : '')+last+'</span></span>'+
      '<span class="cph-pill cph-pill-'+pm.tone+'">'+pm.pill+'</span></button>';
  }
  function cpRenderUnitsSection(){
    const c = cpUnitCounts();
    const total = cpEquipment.length;
    $('cpUnitsViewAllLink').textContent = total ? 'See all '+total : '';
    const chip = (key, n, label, tone)=> '<button type="button" class="cph-sum-item cph-sum-'+tone+'" data-filter="'+key+'"'+(n ? '' : ' disabled')+'>'+
      '<b>'+n+'</b><span>'+label+'</span></button>';
    cpSetHtml($('cpUnitSummary'), total
      ? chip('overdue', c.overdue, 'PM overdue', 'danger') + chip('due-soon', c['due-soon'], 'Due in 30 days', 'warn') +
        chip('scheduled', c.scheduled, 'Up to date', 'ok') + (c.none ? chip('none', c.none, 'No PM date', 'muted') : '')
      : '');
    $('cpUnitSummary').classList.toggle('cph-sum-4', !!c.none);
    $('cpUnitSummary').onclick = (e)=>{
      const b = e.target.closest('[data-filter]'); if(!b || b.disabled) return;
      cpShowScreen('Units', b.dataset.filter);
    };
    const attention = cpEquipment.filter(eq=> eq.status.key==='overdue' || eq.status.key==='due-soon')
      .sort((a,b)=> (a.status.key==='overdue' ? 0 : 1) - (b.status.key==='overdue' ? 0 : 1) || String(a.nextPmDate).localeCompare(String(b.nextPmDate)));
    const shown = (attention.length ? attention : cpEquipment).slice(0, 3);
    $('cpUnitsSectionTitle').textContent = attention.length ? 'Units needing maintenance' : 'Your units';
    // The status line says only what's true: "nothing overdue" is only
    // claimed when every unit actually has a PM date.
    const statusLine = attention.length ? ''
      : c.none === total ? '<p class="cph-okline cph-okline-muted">'+CP_ICON.calendar+' No maintenance schedule set yet. Book maintenance and we\u2019ll set one up.</p>'
      : '<p class="cph-okline">'+CP_ICON.check+' No unit is overdue or due in the next 30 days.</p>';
    const paint = (photoMap)=>{
      cpSetHtml($('cpUnitScroll'), !total
        ? '<p class="cph-empty">No units are enrolled on this account yet. Your service provider adds them after the first visit.</p>'
        : statusLine + shown.map(eq=> cpHomeUnitRowHtml(eq, photoMap)).join(''));
    };
    const ids = shown.map(eq=> eq.id);
    paint(typeof cpCachedCoverPhotoMap==='function' ? cpCachedCoverPhotoMap(ids) : {});
    if(ids.length && typeof cpFetchCoverPhotoMap === 'function'){
      const before = typeof cpCachedCoverPhotoMap==='function' ? cpCachedCoverPhotoMap(ids) : {};
      cpFetchCoverPhotoMap(ids).then(m=>{ if(JSON.stringify(m)!==JSON.stringify(before)) paint(m); }).catch(()=>{});
    }
    $('cpUnitScroll').onclick = (e)=>{
      const b = e.target.closest('[data-equip-id]'); if(!b) return;
      const eq = cpFindEquip(b.dataset.equipId); if(eq) openCustomerEquipmentDetail(eq);
    };
  }

  // ---- Upcoming maintenance (next 90 days, grouped by date) ----
  function cpRenderPm(){
    const groups = new Map();
    cpEquipment.forEach(eq=>{
      const d = daysUntil(eq.nextPmDate);
      if(d === null || d < 0 || d > 90) return;
      if(!groups.has(eq.nextPmDate)) groups.set(eq.nextPmDate, []);
      groups.get(eq.nextPmDate).push(eq);
    });
    const dates = Array.from(groups.keys()).sort().slice(0, 4);
    cpShow($('cpPmWrap'), dates.length);
    cpSetHtml($('cpPmList'), dates.map(d=>{
      const list = groups.get(d);
      const dt = new Date(d+'T00:00:00');
      const places = Array.from(new Set(list.map(eq=> (eq.equipLocation||'').trim()).filter(Boolean)));
      return '<div class="cph-li">'+
        '<span class="cph-date"><small>'+dt.toLocaleDateString('en-PH',{month:'short'})+'</small><b>'+String(dt.getDate()).padStart(2,'0')+'</b></span>'+
        '<span class="cph-text"><span class="cph-li-title">'+(list.length===1 ? cpEquipLabel(list[0]) : list.length+' units')+'</span>'+
        '<span class="cph-sub">Preventive maintenance'+(list.length>1 && places.length ? ' · '+escapeHtml(places.slice(0,2).join(', '))+(places.length>2 ? '…' : '') : '')+'</span></span>'+
        '<button type="button" class="cph-link-btn" data-pm="'+escapeHtml(d)+'">Book</button></div>';
    }).join(''));
    $('cpPmList').onclick = (e)=>{
      const b = e.target.closest('[data-pm]'); if(b) cpBookPm(groups.get(b.dataset.pm) || []);
    };
  }

  // ---- Recent service reports ----
  function cpRenderReports(){
    const done = cpReports.filter(r=> r.completed !== false).slice(0, 3);
    cpSetHtml($('cpRecentActivity'), done.length ? done.map(r=>{
      const cat = r.service_category && typeof serviceCategoryLabel==='function' ? serviceCategoryLabel(r.service_category) : '';
      const eq = r.equipment_id ? cpFindEquip(r.equipment_id) : null;
      const unit = eq ? equipDisplayName(eq) : (r.equip_location || r.equip_type || 'Service visit');
      const title = (cat || 'Service visit')+' · '+unit;
      return '<div class="cph-li" data-sr-no="'+escapeHtml(r.sr_no||'')+'" data-report-id="'+escapeHtml(String(r.id||''))+'">'+
        '<span class="cph-ic cph-ic-muted">'+CP_ICON.receipt+'</span>'+
        '<span class="cph-text" data-open="1"><span class="cph-li-title">'+escapeHtml(title)+'</span>'+
        '<span class="cph-sub">'+escapeHtml(cpFmtShort(r.date))+(r.sr_no ? ' · '+escapeHtml(r.sr_no) : '')+(r.technician_name ? ' · '+escapeHtml(r.technician_name) : '')+'</span></span>'+
        '<button type="button" class="cph-icon-btn" data-dl="1" aria-label="Download PDF" title="Download PDF">'+CP_ICON.download+'</button></div>';
    }).join('') : '<p class="cph-empty">Reports from completed visits will appear here.</p>');
    $('cpRecentActivity').onclick = (e)=>{
      const row = e.target.closest('[data-report-id]'); if(!row) return;
      if(e.target.closest('[data-dl]')) cpDownloadReport(row.dataset.srNo, row.dataset.reportId);
      else if(typeof openCustomerReportPreview==='function') openCustomerReportPreview(row.dataset.srNo, row.dataset.reportId);
    };
  }
  // Straight-to-file download (the preview overlay stays one tap away on
  // the row itself). Same fetch + buildPdf as openCustomerReportPreview.
  async function cpDownloadReport(sr, reportId){
    try{
      toast('Preparing the PDF…');
      let d = sr ? await cloudGetReport(sr) : null;
      if(!d && reportId) d = await cloudGetReportById(reportId);
      if(!d){ toast('This report couldn\u2019t be opened. Try again in a moment.'); return; }
      const doc = await buildPdf(d);
      doc.save((sr || d.srNo || 'service-report')+'.pdf');
    }catch(err){
      console.error('download customer report failed', err);
      toast('This report couldn\u2019t be downloaded. Try again in a moment.');
    }
  }

  // ---- Support ----
  function cpRenderSupport(){
    const phone = String(CP_SUPPORT.phone||'').trim();
    cpSetHtml($('cpSupportCard'),
      '<span class="cph-ic cph-ic-ok">'+CP_ICON.chat+'</span>'+
      '<span class="cph-text"><span class="cph-li-title">Need help?</span>'+
      '<span class="cph-sub">'+escapeHtml(CP_SUPPORT.hours)+(phone ? ' · '+escapeHtml(phone) : '')+'</span></span>'+
      (phone ? '<a class="cph-btn cph-btn-sm" href="tel:'+escapeHtml(phone.replace(/[^\d+]/g,''))+'">Call</a>'
             : '<button type="button" class="cph-btn cph-btn-sm" data-support="msg">Message us</button>'));
    $('cpSupportCard').onclick = (e)=>{ if(e.target.closest('[data-support]')) cpOpenCentralChat(); };
  }

  // ---- Request shortcuts ----
  function cpOpenNewRequest(opts){
    opts = opts || {};
    cpShowRequestsScreen('new');
    if(opts.equipId != null) $('cpReqEquipment').value = opts.equipId;
    if(opts.urgent) $('cpReqUrgency').value = 'urgent';
    if(opts.description != null) $('cpReqDescription').value = opts.description;
    const banner = $('cpReqProblemBanner');
    if(banner) banner.style.display = opts.urgent ? '' : 'none';
    if(opts.focus) setTimeout(()=>{ try{ $('cpReqDescription').focus(); }catch(e){} }, 60);
  }
  // Books preventive maintenance for one or more units: one unit is
  // preselected; several get a general request with the units listed.
  function cpBookPm(list){
    list = list || [];
    if(list.length===1) cpOpenNewRequest({ equipId:list[0].id, description:'Preventive maintenance' });
    else cpOpenNewRequest({ description:'Preventive maintenance for: '+list.map(eq=> equipDisplayName(eq)).join(', ') });
  }

  function renderCustomerHome(){
    const n = cpEquipment.length;
    const list = currentUser.customerList || [];
    const active = list.find(c=> String(c.id)===String(currentUser.customerId));
    const acctName = (active && active.name) || (cpCustomer && cpCustomer.name) || '';
    $('cpGreetSub').textContent = [acctName, n ? n+' unit'+(n===1?'':'s') : 'No units yet'].filter(Boolean).join(' · ');
    $('cpAcctCaret').style.display = list.length > 1 ? '' : 'none';
    $('cpAcctChip').classList.toggle('cph-acct-static', list.length <= 1);
    $('cpAcctChip').onclick = ()=>{ if(list.length > 1 && typeof showCustomerAccountPicker==='function') showCustomerAccountPicker(); };
    if($('cpAvatarBtn')) $('cpAvatarBtn').textContent = cpInitials(currentUser && currentUser.name);

    $('cpActBookIc').innerHTML = CP_ICON.calendar;
    $('cpActProblemIc').innerHTML = CP_ICON.alert;
    $('cpActMsgIc').innerHTML = CP_ICON.chat;

    $('customerHomeScreen').classList.remove('cph-loading');
    renderCustomerHero(cpMyRequestsCache);
    cpRenderUnitsSection();
    cpRenderPm();
    cpRenderReports();
    cpRenderSupport();
    $('cpActivityFullHistoryLink').onclick = ()=> cpShowScreen('History', 'Visits');

    if(cpCustomer && cpCustomer.id) cpRefreshRequestsBadge(cpCustomer.id);
  }

  // ---------- Marketing banner (auto-sliding) ----------
  // Edit this list to change the slides. `img` is any image in the app
  // folder (a designed JPG/PNG works too — for an image that already has
  // its own text baked in, leave title/text/cta empty). A tap anywhere on
  // the slide runs `action`: it opens the request form with `request`
  // prefilled, so the office gets a ready-to-answer inquiry.
  const CP_BANNERS = [
    { img:'img/banners/pm-plan.svg', alt:'Split aircon unit with a maintenance calendar',
      title:'Keep every unit running at its best',
      text:'Preventive maintenance: cleaning, checks and a service report every visit.',
      cta:'Book maintenance', request:'Preventive maintenance' },
    { img:'img/banners/installation.svg', alt:'Outdoor aircon unit connected to an indoor unit',
      title:'New aircon? We supply and install it.',
      text:'Split, floor-mounted and ducted systems, sized for your space.',
      cta:'Request a quote', request:'Quotation request: aircon supply and installation' },
    { img:'img/banners/fire-protection.svg', alt:'Fire sprinkler, smoke detector and alarm bell',
      title:'Fire protection you can rely on',
      text:'Sprinkler (AFSS) and fire alarm (FDAS) installation, testing and maintenance.',
      cta:'Ask about fire protection', request:'Inquiry: fire protection (AFSS / FDAS) service' }
  ];
  const CP_BANNER_MS = 5500;       // time on each slide
  const CP_BANNER_RESUME_MS = 9000; // pause after the customer swipes or taps
  let cpBannerIdx = 0, cpBannerTimer = null, cpBannerPausedUntil = 0;

  function cpBannerInit(){
    const track = $('cpBannerTrack'), dots = $('cpBannerDots');
    if(!track || !dots) return;
    if(!CP_BANNERS.length){ $('cpBanner').style.display = 'none'; return; }
    track.innerHTML = CP_BANNERS.map((b, i)=>
      '<div class="cph-slide" role="group" aria-roledescription="slide" aria-label="'+(i+1)+' of '+CP_BANNERS.length+'" data-slide="'+i+'">'+
        '<img src="'+escapeHtml(b.img)+'" alt="'+escapeHtml(b.alt||'')+'" '+(i===0 ? '' : 'loading="lazy" ')+'decoding="async">'+
        (b.title ? '<div class="cph-slide-copy">'+
          '<p class="cph-slide-title">'+escapeHtml(b.title)+'</p>'+
          (b.text ? '<p class="cph-slide-text">'+escapeHtml(b.text)+'</p>' : '')+
          (b.cta ? '<span class="cph-slide-cta">'+escapeHtml(b.cta)+' ›</span>' : '')+
        '</div>' : '')+
      '</div>').join('');
    dots.innerHTML = CP_BANNERS.length > 1 ? CP_BANNERS.map((_, i)=>
      '<button type="button" class="cph-dot'+(i===0 ? ' on' : '')+'" role="tab" aria-label="Slide '+(i+1)+'" data-dot="'+i+'"></button>').join('') : '';

    // Keep the dots in step with manual swipes.
    let raf = 0;
    track.addEventListener('scroll', ()=>{
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(()=>{
        const i = Math.round(track.scrollLeft / Math.max(1, track.clientWidth));
        if(i !== cpBannerIdx){ cpBannerIdx = i; cpBannerMarkDot(); }
      });
    }, { passive:true });
    const pause = ()=>{ cpBannerPausedUntil = Date.now() + CP_BANNER_RESUME_MS; };
    track.addEventListener('pointerdown', pause, { passive:true });
    track.addEventListener('touchstart', pause, { passive:true });
    track.addEventListener('click', (e)=>{
      const s = e.target.closest('[data-slide]'); if(!s) return;
      const b = CP_BANNERS[Number(s.dataset.slide)];
      if(b && b.request != null) cpOpenNewRequest({ description:b.request });
      else if(b) cpOpenNewRequest();
    });
    dots.addEventListener('click', (e)=>{
      const d = e.target.closest('[data-dot]'); if(!d) return;
      pause(); cpBannerGo(Number(d.dataset.dot));
    });
    // Rotating the phone or resizing the window changes the slide width;
    // snap back to the current slide so image and dots stay in step.
    window.addEventListener('resize', ()=>{
      track.scrollTo({ left: cpBannerIdx * track.clientWidth, behavior:'auto' });
    }, { passive:true });
    cpBannerStart();
  }
  function cpBannerMarkDot(){
    $$('#cpBannerDots .cph-dot').forEach((d, i)=> d.classList.toggle('on', i===cpBannerIdx));
  }
  function cpBannerGo(i){
    const track = $('cpBannerTrack'); if(!track) return;
    cpBannerIdx = (i + CP_BANNERS.length) % CP_BANNERS.length;
    track.scrollTo({ left: cpBannerIdx * track.clientWidth, behavior:'smooth' });
    cpBannerMarkDot();
  }
  // Auto-advance only while Home is on screen, the app is in front, the
  // customer isn't touching it, and the phone isn't set to reduce motion.
  function cpBannerStart(){
    if(cpBannerTimer || CP_BANNERS.length < 2) return;
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if(reduce) return;
    cpBannerTimer = setInterval(()=>{
      const home = $('customerHomeScreen');
      if(document.hidden || !home || home.style.display === 'none') return;
      if(Date.now() < cpBannerPausedUntil) return;
      cpBannerGo(cpBannerIdx + 1);
    }, CP_BANNER_MS);
  }
  cpBannerInit();

  function cpRenderSwitcher(){
    const field = $('cpSwitcherField');
    const sel = $('cpCustomerSwitcher');
    const box = $('cpSwitcherBox');
    if(!field || !sel) return;
    const list = currentUser.customerList || [];
    if(!list.length){ field.style.display = 'none'; return; }
    field.style.display = '';
    sel.innerHTML = list.map(c=> '<option value="'+c.id+'" '+(String(c.id)===String(currentUser.customerId)?'selected':'')+'>'+escapeHtml(c.name)+'</option>').join('');
    sel.disabled = list.length <= 1;
    if(box) box.classList.toggle('single', list.length <= 1);

    // Visible name + Switch badge (the <select> above is hidden — see the
    // markup comment on .cp-viewing-bar). The badge carries the linked-
    // account count and opens the same picker screen sign-in uses, so
    // there's exactly one account-choosing UI in the app rather than a
    // dropdown here and cards there.
    const active = list.find(c=> String(c.id)===String(currentUser.customerId));
    const nameEl = $('cpViewingName');
    if(nameEl) nameEl.textContent = (active && active.name) ? active.name : 'Unnamed account';
    const switchBtn = $('cpViewingSwitchBtn');
    if(switchBtn){
      if(list.length > 1){
        switchBtn.style.display = '';
        const countEl = $('cpViewingSwitchCount');
        if(countEl) countEl.textContent = list.length;
        switchBtn.onclick = ()=>{ if(typeof showCustomerAccountPicker === 'function') showCustomerAccountPicker(); };
      } else {
        switchBtn.style.display = 'none';
      }
    }
  }
  async function cpSwitchActiveCustomer(customerId){
    currentUser.customerId = customerId;
    try{ localStorage.setItem('cust-active-customer:'+currentUser.id, customerId); }catch(e){}
    try{ localStorage.setItem('current-user', JSON.stringify(currentUser)); }catch(e){}
    $('cpUnitScroll').innerHTML = '<div class="empty-state">Loading…</div>';
    $('cpRecentActivity').innerHTML = '<div class="empty-state">Loading…</div>';
    await loadCustomerPortalData(customerId);
    cpSetGreetingName();
    renderCustomerHome();
    cpInitRealtime(customerId);
  }
  $('cpCustomerSwitcher').addEventListener('change', (e)=> cpSwitchActiveCustomer(e.target.value));

  // ---------- Account picker (every customer login, shown once at fresh
  // sign-in) ----------
  // Cards for every customer this login can see — see enterApp() in
  // home.js, which now calls this instead of showHome() for any customer
  // login (including one linked to just a single customer record), not
  // only logins with 2+ linked accounts. Picking a card is the same
  // underlying action as the Home screen's own cpSwitchActiveCustomer
  // switcher (persist the choice per device, then load that customer's
  // data) — this just fronts it with a one-time, easier-to-scan chooser
  // instead of dropping the customer straight onto whichever account
  // happened to be picked last.
  function cpGreetingTod(){
    const h = new Date().getHours();
    return h < 12 ? 'Good morning' : (h < 18 ? 'Good afternoon' : 'Good evening');
  }
  function cpRenderAccountPickerCards(){
    const wrap = $('cpAccountPickerList');
    if(!wrap) return;
    const list = currentUser.customerList || [];
    wrap.innerHTML = list.map(c=>
      '<button type="button" class="cp-account-card" data-cust-id="'+escapeHtml(String(c.id))+'">'+
        '<span class="cp-account-card-badge">'+escapeHtml((c.name||'?').trim().charAt(0).toUpperCase()||'?')+'</span>'+
        '<span class="cp-account-card-name">'+escapeHtml(c.name||'Unnamed account')+'</span>'+
        '<span class="cp-account-card-chevron">›</span>'+
      '</button>'
    ).join('');
    $$('.cp-account-card', wrap).forEach(btn=>{
      btn.addEventListener('click', ()=> cpPickAccount(btn.dataset.custId));
    });
  }
  // Picking a card: same persistence cpSwitchActiveCustomer uses (so the
  // choice sticks for next time on this device), then straight into the
  // normal home screen, which does its own data load.
  function cpPickAccount(customerId){
    currentUser.customerId = customerId;
    try{ localStorage.setItem('cust-active-customer:'+currentUser.id, customerId); }catch(e){}
    try{ localStorage.setItem('current-user', JSON.stringify(currentUser)); }catch(e){}
    $('customerAccountPickerScreen').style.display = 'none';
    showCustomerHome();
  }
  function showCustomerAccountPicker(){
    document.body.classList.add('dashboard-active');
    // Hide every other view this session could conceivably still be
    // showing (belt-and-suspenders — a fresh sign-in should always be a
    // blank slate, same reasoning as doLogout()'s own explicit hides in
    // auth.js) plus the shared nav, which has nothing to navigate to yet.
    ['homeScreen','customerHomeScreen','customerEquipmentDetailScreen','customerRequestsScreen',
     'customerUnitsScreen','customerHistoryScreen','customerToolsScreen','customerCalcScreen','customerProfileScreen',
     'customerLegalScreen'
    ].forEach(id=>{ const el = $(id); if(el) el.style.display = 'none'; });
    if($('footerBar')) $('footerBar').style.display = 'none';
    if($('metaBar')) $('metaBar').style.display = 'none';
    if($('homeBtn')) $('homeBtn').style.display = 'none';
    if($('cpNav')) $('cpNav').style.display = 'none';
    $('cpPickerGreetTod').textContent = cpGreetingTod();
    $('cpPickerGreetName').textContent = (currentUser.name||'there');
    cpRenderAccountPickerCards();
    $('customerAccountPickerScreen').style.display = '';
    window.scrollTo({top:0});
  }

  // Entry point — call this after a customer logs in and homeScreen (or a
  // dedicated customerHomeScreen, see the HTML snippet) is shown.
  // currentUser is expected to carry a `customerId` (the one currently
  // being viewed) and a `customerList` (every customer this login can see)
  // when role==='customer' — see auth.js.
  async function initCustomerHomeScreen(){
    if(!currentUser || currentUser.role !== 'customer' || !currentUser.customerId) return;
    cpSetGreetingName();
    cpRenderSwitcher();
    // First load of this account: show the placeholder instead of empty
    // sections filling in one by one. A refresh of the same account keeps
    // what is on screen until the new data is ready.
    if(currentUser.customerId !== cpLoadedCustomerId) $('customerHomeScreen').classList.add('cph-loading');
    await loadCustomerPortalData(currentUser.customerId);
    renderCustomerHome();
    cpInitRealtime(currentUser.customerId);
  }

  // ---------- Live updates (customer portal) ----------
  // Same push+poll pattern as tracker.js's admin channel: a Supabase
  // realtime subscription for the instant case, plus a slower poll as the
  // offline-safe fallback. Scoped with a customer_id filter so a customer
  // login with access to multiple customers (see cpSwitchActiveCustomer)
  // only gets pushes for whichever one is currently being viewed — RLS
  // would block anything else anyway, but the filter also keeps this
  // login from re-rendering on another of its own customers' changes
  // while looking at a different one.
  let cpRealtimeChannel = null;
  let cpRealtimePollTimer = null;
  let cpRealtimeCustomerId = null;

  function cpInitRealtime(customerId){
    if(cpRealtimeChannel && cpRealtimeCustomerId === customerId) return; // already watching this customer
    cpTeardownRealtime();
    cpRealtimeCustomerId = customerId;
    if(!db) return;
    const onChange = ()=>{
      // Reload+re-render rather than patch state in place — same as every
      // other screen's realtime handler (dispatch.js, tracker.js) — so a
      // push doesn't have to duplicate loadCustomerPortalData's merge logic.
      loadCustomerPortalData(customerId).then(renderCustomerHome);
    };
    // A status change on one of this customer's own requests (e.g. admin
    // acknowledges/schedules/completes it) should update "My Requests" and
    // the sidebar badge the instant it happens — cheap to always run both
    // here since they're no-op-safe even when the requests screen isn't
    // currently visible.
    const onRequestChange = ()=>{
      if(typeof cpRenderMyRequests === 'function') cpRenderMyRequests(customerId);
      cpRefreshRequestsBadge(customerId);
    };
    cpRealtimeChannel = db.channel('customer-portal-'+customerId)
      .on('postgres_changes', { event:'*', schema:'public', table:'customer_equipment', filter:'customer_id=eq.'+customerId }, onChange)
      .on('postgres_changes', { event:'*', schema:'public', table:'service_reports', filter:'customer_id=eq.'+customerId }, onChange)
      .on('postgres_changes', { event:'*', schema:'public', table:'service_requests', filter:'customer_id=eq.'+customerId }, onRequestChange)
      .subscribe();
    if(!cpRealtimePollTimer) cpRealtimePollTimer = setInterval(()=>{ onChange(); onRequestChange(); }, 30000);
  }

  // Called on logout, and internally when switching to a different
  // customer_id, so no stale channel/poll from a previous session or a
  // previously-viewed customer keeps running.
  function cpTeardownRealtime(){
    if(cpRealtimePollTimer){ clearInterval(cpRealtimePollTimer); cpRealtimePollTimer = null; }
    if(cpRealtimeChannel && db){ try{ db.removeChannel(cpRealtimeChannel); }catch(e){} }
    cpRealtimeChannel = null;
    cpRealtimeCustomerId = null;
    // The service-request detail overlay is shared with admin (see
    // srOpenDetail/srCloseDetail in service-requests.js) and can be left
    // open on logout too — close it so its own message-thread channel
    // doesn't keep running past this session.
    if(typeof srCloseDetail === 'function') srCloseDetail();
  }

  // "My Requests" data refresh — feeds the notif bell, the home hero, and
  // (when that screen is open) the History screen's Requests segment.
  async function cpRefreshRequestsBadge(customerId){
    const rows = await srListForCustomer(customerId);
    cpMyRequestsCache = rows;
    cpRefreshNotifBell(rows);
    renderCustomerHero(rows);
  }

  // Header chat/notification icon — the intended entry point into
  // messaging, since every job's thread lives inside its service_request's
  // detail overlay (srOpenDetail/srMsgList) rather than a separate global
  // inbox — there's no messaging model in this app that isn't tied to a
  // specific request yet. Badged whenever something is waiting on the
  // customer specifically (a fee proposed, or a schedule proposed).
  //
  // Previously this always routed to the History screen's Requests list —
  // a browsing/filter view, not a conversation — so a tap on a *chat* icon
  // never actually opened a chat; it opened a list the customer then had
  // to tap into themselves. Now it jumps straight into the one request
  // that's actually live right now (a technician dispatched/en route/on
  // site) or waiting on the customer's response (fee or schedule
  // proposed) — same priority order the badge dot above uses to decide
  // whether to show at all — landing directly in that request's message
  // thread. Only when nothing fits that (nothing currently active or
  // awaiting a response) does it fall back to the Requests list, since
  // there's no single conversation to jump into.
  function cpOpenCentralChat(){
    const rows = cpMyRequestsCache || [];
    const target = rows.find(r=> cpIsActiveStatus(r.status))
      || rows.find(r=> r.feeStatus==='proposed' || r.status==='schedule_proposed');
    if(target && typeof srOpenDetail === 'function') srOpenDetail(target);
    else if(rows.length) cpShowScreen('Requests');
    else cpOpenNewRequest({ focus:true });
  }
  function cpRefreshNotifBell(rows){
    const bell = $('cpNotifBell');
    if(!bell) return;
    const needsAttention = rows.filter(r=> r.feeStatus==='proposed' || r.status==='schedule_proposed').length;
    bell.style.display = '';
    bell.innerHTML = CP_ICON.chat + (needsAttention>0 ? '<span class="cp-badge-dot"></span>' : '');
  }
  $('cpNotifBell').addEventListener('click', cpOpenCentralChat);

  // ---------- Header profile menu ----------
  // Account settings / Notifications / Sign out — see the redesign spec's
  // "Header" section ("Replace the standalone profile initial with a
  // profile menu"). The Profile tab in the shared cp-nav still exists and
  // still works on its own; this is just a faster path to it (plus
  // sign-out) from the home screen's own header.
  function cpCloseProfileMenu(){
    const menu = $('cpProfileMenu');
    if(!menu) return;
    menu.style.display = 'none';
    if($('cpAvatarBtn')) $('cpAvatarBtn').setAttribute('aria-expanded', 'false');
  }
  function cpToggleProfileMenu(e){
    e.stopPropagation();
    const menu = $('cpProfileMenu');
    if(!menu) return;
    const opening = menu.style.display === 'none';
    menu.style.display = opening ? '' : 'none';
    $('cpAvatarBtn').setAttribute('aria-expanded', opening ? 'true' : 'false');
  }
  $('cpAvatarBtn').addEventListener('click', cpToggleProfileMenu);
  document.addEventListener('click', (e)=>{
    const wrap = $('cpProfileMenuWrap');
    if(wrap && !wrap.contains(e.target)) cpCloseProfileMenu();
  });
  document.addEventListener('keydown', (e)=>{ if(e.key === 'Escape') cpCloseProfileMenu(); });
  if($('cpProfileMenu')) $('cpProfileMenu').addEventListener('click', (e)=>{
    const btn = e.target.closest('[data-menu-action]');
    if(!btn) return;
    cpCloseProfileMenu();
    const action = btn.dataset.menuAction;
    if(action === 'settings') cpShowScreen('Profile');
    else if(action === 'notifications') cpShowScreen('History', 'Requests');
    else if(action === 'signout'){ if(typeof doLogout==='function') doLogout(); }
  });

  // ---------- Request Service (customer-side) ----------
  // New Request form + My Requests history, reached via custNavRequests or
  // cpRequestServiceBtn (see customer-equipment-history.js wiring). Backend
  // functions (srCreate, srListForCustomer, srStatusLabel) live in
  // service-requests.js — this is just the customer-facing screen.
  function cpShowRequestsScreen(tab){
    $('customerHomeScreen').style.display = 'none';
    $('customerEquipmentDetailScreen').style.display = 'none';
    $('customerUnitsScreen').style.display = 'none';
    $('customerHistoryScreen').style.display = 'none';
    $('customerToolsScreen').style.display = 'none';
    $('customerCalcScreen').style.display = 'none';
    $('customerProfileScreen').style.display = 'none';
    $('customerLegalScreen').style.display = 'none';
    $('customerRequestsScreen').style.display = '';
    if(typeof cpSetNavActive === 'function') cpSetNavActive('Requests');
    if($('cpReqProblemBanner')) $('cpReqProblemBanner').style.display = 'none';
    cpReqShowTab(tab === 'history' ? 'history' : 'new');
    cpPopulateReqEquipmentOptions();
    cpRenderMyRequests(currentUser.customerId);
    window.scrollTo({top:0});
  }
  // Opens the New Request form with a specific unit already selected —
  // called from the "＋ Request Service for This Unit" button on the
  // equipment detail page (customer-equipment-history.js).
  function cpRequestServiceForEquip(eq){
    cpShowRequestsScreen();
    $('cpReqEquipment').value = eq.id;
  }
  $('cpDetailRequestServiceBtn').addEventListener('click', ()=>{
    if(cpDetailEquip && typeof cpRequestServiceForEquip === 'function') cpRequestServiceForEquip(cpDetailEquip);
  });
  function cpReqShowTab(tab){
    $('cpReqTabNew').classList.toggle('active', tab==='new');
    $('cpReqTabHistory').classList.toggle('active', tab==='history');
    $('cpReqNewPanel').style.display = tab==='new' ? '' : 'none';
    $('cpReqHistoryPanel').style.display = tab==='history' ? '' : 'none';
  }
  function cpPopulateReqEquipmentOptions(){
    const sel = $('cpReqEquipment');
    const generalOpt = '<option value="">General inquiry (not a specific unit)</option>';
    sel.innerHTML = generalOpt + cpEquipment.map(eq=>
      // equipDisplayName() already falls back to equipLocation for an
      // unlabelled unit, so only append the location when it differs.
      '<option value="'+eq.id+'">'+escapeHtml(equipDisplayName(eq))+
        ((eq.equipLocation||'').trim() && (eq.equipLocation||'').trim()!==equipDisplayName(eq)
          ? ' — '+escapeHtml(eq.equipLocation) : '')+'</option>'
    ).join('');
  }
  // Takes the full request (not just .status) because a fee_proposed row
  // reads very differently depending on feeStatus: 'proposed' means a price
  // is genuinely waiting on the customer to review (needs-attention red,
  // same as home-screen state D3), while 'declined' just means it looped
  // back to admin to try again (same "in the queue" teal as a brand-new
  // request). Colors follow the same rule as the home screen hero:
  //   teal   = in the queue / waiting, nothing wrong yet
  //   red    = the customer specifically needs to do something now
  //   amber  = a technician is actively on the job right now
  //   green  = done
  //   gray   = closed (cancelled) — not a problem for the customer anymore
  function cpReqStatusPillClass(r){
    // 'closed' is the admin sign-off after 'completed'. Without it here a
    // closed request fell through to status-sr-open and rendered as if it
    // were still waiting on someone.
    if(r.status==='completed' || r.status==='closed') return 'status-sr-done';
    if(r.status==='cancelled') return 'status-sr-cancelled';
    if(cpIsActiveStatus(r.status)) return 'status-sr-active';
    if(r.status==='fee_proposed' && r.feeStatus==='proposed') return 'status-sr-urgent';
    return 'status-sr-open'; // new, acknowledged, fee_accepted, schedule_proposed/confirmed, or a declined fee back with admin
  }
  function cpReqRowHtml(r){
    // "General inquiry" only when the customer genuinely didn't pick a
    // unit (equipmentId null). If they did pick one but it's not found in
    // cpEquipment (e.g. it was later merged/removed), say so distinctly —
    // showing "General inquiry" in that case would misrepresent what they
    // actually submitted.
    let eqLabel;
    if(!r.equipmentId){
      eqLabel = 'General inquiry';
    } else {
      const eq = cpEquipment.find(e=> String(e.id)===String(r.equipmentId));
      eqLabel = eq ? escapeHtml(equipDisplayName(eq)) : 'Selected equipment';
    }
    return (
      '<div class="cp-row" style="align-items:flex-start;" data-req-id="'+r.id+'">'+
        '<div class="cp-row-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2-2z"/></svg></div>'+
        '<div class="cp-row-body">'+
          '<div class="cp-row-title">'+eqLabel+'</div>'+
          '<div class="cp-row-sub">'+escapeHtml(r.description||'')+'</div>'+
          '<div class="cp-row-sub">'+fmtDateTime(r.createdAt)+
            (r.feeAmount!=null ? ' · Quote: ₱'+escapeHtml(String(r.feeAmount)) : '')+'</div>'+
        '</div>'+
        '<span class="status-pill '+cpReqStatusPillClass(r)+'">'+escapeHtml(srStatusLabel(r.status))+'</span>'+
      '</div>'
    );
  }
  async function cpRenderMyRequests(customerId, targetId){
    const list = $(targetId || 'cpReqHistoryList');
    if(!list || !customerId) return;
    const rows = await srListForCustomer(customerId);
    cpMyRequestsCache = rows;
    list.innerHTML = rows.length
      ? rows.map(cpReqRowHtml).join('')
      : '<div class="empty-state">No service requests yet.</div>';
    $$('.cp-row', list).forEach(row=>{
      row.style.cursor = 'pointer';
      row.onclick = ()=>{
        const req = rows.find(r=> String(r.id)===row.dataset.reqId);
        if(req && typeof srOpenDetail === 'function') srOpenDetail(req);
      };
    });
  }
  async function cpSubmitRequest(){
    const description = $('cpReqDescription').value.trim();
    if(!description){ toast('Please describe the issue'); return; }
    if(!currentUser || !currentUser.customerId){ toast('Please sign in again'); return; }
    $('cpReqSubmitBtn').disabled = true; $('cpReqSubmitBtn').textContent = 'Submitting…';
    const result = await srCreate({
      customerId: currentUser.customerId,
      equipmentId: $('cpReqEquipment').value || null,
      description,
      urgency: $('cpReqUrgency').value || 'normal',
      requestedDate: $('cpReqDate').value || null,
      accessGatePass: $('cpReqAccessGatePass').checked,
      accessLadder: $('cpReqAccessLadder').checked,
      accessWorkPermit: $('cpReqAccessWorkPermit').checked,
      accessOthers: $('cpReqAccessOthers').checked,
      accessOthersDetail: $('cpReqAccessOthersDetail').value.trim() || null,
      contactPerson: $('cpReqContactPerson').value.trim() || null,
      contactNumber: $('cpReqContactNumber').value.trim() || null
    });
    $('cpReqSubmitBtn').disabled = false; $('cpReqSubmitBtn').textContent = 'Submit Request';
    if(!result){ toast('Could not submit — check your connection and try again'); return; }
    toast('Request submitted — we\'ll be in touch');
    $('cpReqDescription').value = '';
    $('cpReqUrgency').value = 'normal';
    if($('cpReqProblemBanner')) $('cpReqProblemBanner').style.display = 'none';
    $('cpReqDate').value = '';
    $('cpReqEquipment').value = '';
    ['cpReqAccessGatePass','cpReqAccessLadder','cpReqAccessWorkPermit','cpReqAccessOthers'].forEach(id=> $(id).checked=false);
    $('cpReqAccessOthersDetail').value = '';
    $('cpReqAccessOthersDetailWrap').style.display = 'none';
    $('cpReqContactPerson').value = '';
    $('cpReqContactNumber').value = '';
    cpReqShowTab('history');
    cpRenderMyRequests(currentUser.customerId);
    cpRefreshRequestsBadge(currentUser.customerId);
  }
  $('cpReqBackBtn').addEventListener('click', ()=>{ if(typeof showCustomerHome === 'function') showCustomerHome(); });
  $('cpReqTabNew').addEventListener('click', ()=> cpReqShowTab('new'));
  $('cpReqTabHistory').addEventListener('click', ()=>{ cpReqShowTab('history'); cpRenderMyRequests(currentUser.customerId); });
  $('cpReqSubmitBtn').addEventListener('click', cpSubmitRequest);
  $('cpReqAccessOthers').addEventListener('change', function(){
    $('cpReqAccessOthersDetailWrap').style.display = this.checked ? '' : 'none';
  });

  // ---------- Shared nav (bottom tabs mobile / top bar desktop) ----------
  // Requests has its own tab (the thing customers use most); Tools moved
  // into Account as a row (cpProfileRowTools). The Profile screen keeps
  // its internal key but reads "Account" on the tab.
  const CP_NAV_ITEMS = [
    { screen:'Home', id:'cpNavHome', icon:'home' },
    { screen:'Units', id:'cpNavUnits', icon:'grid' },
    { screen:'Requests', id:'cpNavRequests', icon:'clipboard' },
    { screen:'Tools', id:'cpNavTools', icon:'bulb' },
    { screen:'Profile', id:'cpNavProfile', icon:'person', label:'Account' }
  ];
  function cpInitNav(){
    CP_NAV_ITEMS.forEach(item=>{
      const btn = $(item.id);
      if(!btn) return;
      btn.innerHTML = CP_ICON[item.icon]+'<span>'+(item.label || item.screen)+'</span>';
      btn.addEventListener('click', ()=> cpShowScreen(item.screen));
    });
  }
  function cpSetNavActive(screen){
    CP_NAV_ITEMS.forEach(item=> { const btn = $(item.id); if(btn) btn.classList.toggle('active', item.screen===screen); });
  }

  // Central router for the five redesigned screens. `sub` is an optional
  // sub-selection some screens understand (History's initial category
  // filter — see renderCustomerHistoryScreen's 'Visits'/'Requests' mapping
  // below). Routes 'Home' through the real showCustomerHome() (fresh
  // data reload + render), and every other tab through the lightweight
  // cpEnterPortalShell() (DOM show/hide only) so the very long "hide every
  // other view" list still only needs to live in one place
  // (customer-equipment-history.js) — without re-triggering a full data
  // reload (and the cpEquipment=[] reset it starts with) on every tab tap.
  // See cpEnterPortalShell()'s comment for the bug this fixes.
  function cpShowScreen(screen, sub){
    if(screen==='Home'){ showCustomerHome(); return; }
    if(screen==='Requests'){
      if(typeof cpEnterPortalShell === 'function') cpEnterPortalShell();
      cpShowRequestsScreen(sub || 'history');
      return;
    }
    if(typeof cpEnterPortalShell === 'function') cpEnterPortalShell();
    $('customerHomeScreen').style.display = 'none';
    cpSetNavActive(screen);
    if(screen==='Units'){ $('customerUnitsScreen').style.display = ''; cpUnitsSetStatusFilter(sub || 'all', true); renderCustomerUnitsScreen(); }
    else if(screen==='History'){ $('customerHistoryScreen').style.display = ''; renderCustomerHistoryScreen(sub); }
    else if(screen==='Tools'){ $('customerToolsScreen').style.display = ''; renderCustomerToolsScreen(); }
    else if(screen==='Profile'){ $('customerProfileScreen').style.display = ''; renderCustomerProfileScreen(); }
    window.scrollTo({top:0});
  }

  // ---------- Units screen (full grid) ----------
  // Filter used by both the search box below and paint() — pulled out so
  // paint() (which re-runs once cover photos arrive, see cpFetchCoverPhotoMap
  // below) can reapply whatever the person already typed instead of the
  // photo repaint silently wiping it back to "show everything".
  // Status filter chips (All / PM overdue / Due soon / Up to date / No PM
  // date) — the Home unit summary opens this screen with one preselected.
  let cpUnitsStatus = 'all';
  function cpUnitsSetStatusFilter(key, silent){
    cpUnitsStatus = key || 'all';
    $$('#cpUnitsStatusChips [data-status]').forEach(b=> b.classList.toggle('active', b.dataset.status===cpUnitsStatus));
    if(!silent) cpUnitsApplyFilter();
  }
  function cpUnitsRenderChips(){
    const c = { all:cpEquipment.length, overdue:0, 'due-soon':0, scheduled:0, none:0 };
    cpEquipment.forEach(eq=> c[eq.status.key]++);
    const chips = [['all','All'],['overdue','PM overdue'],['due-soon','Due soon'],['scheduled','Up to date'],['none','No PM date']];
    $('cpUnitsStatusChips').innerHTML = chips.filter(([k])=> k==='all' || c[k] || k===cpUnitsStatus).map(([k,l])=>
      '<button type="button" class="cp-filter-chip'+(k===cpUnitsStatus ? ' active' : '')+'" data-status="'+k+'">'+l+' <span>'+c[k]+'</span></button>').join('');
  }
  function cpUnitsApplyFilter(){
    const q = ($('cpUnitsSearch').value||'').trim().toLowerCase();
    $$('.cp-unit-card', $('cpUnitsGrid')).forEach(el=>{
      const okStatus = cpUnitsStatus==='all' || el.dataset.status===cpUnitsStatus;
      el.style.display = okStatus && el.textContent.toLowerCase().includes(q) ? '' : 'none';
    });
  }
  function renderCustomerUnitsScreen(){
    $('cpUnitsScreenSub').textContent = cpEquipment.length+' unit'+(cpEquipment.length===1?'':'s')+' enrolled';
    cpUnitsRenderChips();
    function paint(photoMap){
      $('cpUnitsGrid').innerHTML = cpEquipment.length
        ? cpEquipment.map(eq=> cpUnitCardHtml(eq, photoMap)).join('')
        : '<div class="empty-state">No equipment enrolled yet.</div>';
      $$('.cp-unit-card', $('cpUnitsGrid')).forEach(card=>{
        card.onclick = ()=>{ const eq = cpFindEquip(card.dataset.equipId); if(eq) openCustomerEquipmentDetail(eq); };
      });
      cpUnitsApplyFilter();
    }
    const equipIds = cpEquipment.map(eq=>eq.id);
    paint(typeof cpCachedCoverPhotoMap==='function' ? cpCachedCoverPhotoMap(equipIds) : {});
    if(cpEquipment.length && typeof cpFetchCoverPhotoMap === 'function'){
      const beforeMap = typeof cpCachedCoverPhotoMap==='function' ? cpCachedCoverPhotoMap(equipIds) : {};
      cpFetchCoverPhotoMap(equipIds).then(photoMap=>{
        if(JSON.stringify(photoMap)!==JSON.stringify(beforeMap)) paint(photoMap);
      });
    }
  }
  // Matches each card's full visible text — name/label, brand, equipment
  // type, capacity, location, and status — against the query, so searching
  // "leak" or "3rd floor" or "carrier" all work, not just the unit's name.
  // Wired once at module load (not inside renderCustomerUnitsScreen, which
  // re-runs every time this tab is opened) so repeat visits don't stack
  // duplicate 'input' listeners on the same search box.
  $('cpUnitsSearch').addEventListener('input', cpUnitsApplyFilter);
  $('cpUnitsStatusChips').addEventListener('click', (e)=>{
    const b = e.target.closest('[data-status]'); if(b) cpUnitsSetStatusFilter(b.dataset.status);
  });

  // ---------- History screen (unified chronological timeline) ----------
  // Replaces the old two-tab Visits/Requests segment with one merged,
  // filterable feed — every service visit, request, and quotation for
  // this account, newest first, with category chips to narrow it down.
  //
  // DATA-AVAILABILITY NOTE (please read before adding a category here):
  // This app has no invoicing or payment-gateway feature — see the
  // "Quotes and invoices" quick-action comment above (renderCustomerHome)
  // and the "Pay now — coming soon" placeholder on the billing card.
  // service_requests.fee_amount + fee_status together ARE the quotation;
  // there is no separate invoice_sent_at column or payment record
  // anywhere in the schema. So 'invoice' and 'payment' below are real,
  // selectable filter categories (the page needs to have them), but they
  // will only ever contain rows once/if this app grows an actual
  // invoicing step and a payment gateway on top of service_requests.
  // Until then they correctly render empty with an honest explanation
  // (see cpHistEmptyMsg) — do NOT backfill them from fee_amount/
  // fee_status, since that would misrepresent an unsent, unpaid quote as
  // a sent invoice or a completed payment.
  const CP_HIST_CATS = ['all','visit','request','quotation','invoice','payment'];
  const CP_HIST_ICON = { visit:'check', request:'tools', quotation:'receipt', invoice:'book', payment:'piggy' };
  let cpHistFilter = 'all';

  // Builds the merged, sorted timeline from data already loaded for this
  // customer (cpReports, cpMyRequestsCache) — no extra network round trip
  // beyond the fresh cpMyRequestsCache fetch in renderCustomerHistoryScreen.
  function cpHistTimelineEntries(){
    const entries = [];
    cpReports.forEach(r=>{
      entries.push({
        cat:'visit', date:r.date,
        title: (r.trouble_call && r.trouble_call.trim()) ? r.trouble_call : (r.equip_type||'Service visit'),
        sub: [r.sr_no, r.equip_location].filter(Boolean).join(' · '),
        srNo:r.sr_no, reportId:r.id
      });
    });
    cpMyRequestsCache.forEach(r=>{
      const eq = r.equipmentId ? cpEquipment.find(e=> String(e.id)===String(r.equipmentId)) : null;
      const eqLabel = r.equipmentId ? (eq ? equipDisplayName(eq) : 'Selected equipment') : 'General inquiry';
      entries.push({
        cat:'request', date:r.createdAt,
        title:'Service requested — '+eqLabel,
        sub:r.description||'',
        reqId:r.id
      });
      // A quotation exists once admin has proposed a fee, whatever the
      // customer has since done with it (proposed/accepted/declined) —
      // this row records that it was sent, not its current state.
      // updatedAt is the closest timestamp this schema has for "when the
      // fee was proposed" (there's no dedicated fee_proposed_at column),
      // so it's an approximation when a request has moved on since.
      if(r.feeAmount!=null){
        entries.push({
          cat:'quotation', date:r.updatedAt||r.createdAt,
          title:'Quotation sent — ₱'+r.feeAmount,
          sub:eqLabel,
          reqId:r.id
        });
      }
    });
    entries.sort((a,b)=> new Date(b.date) - new Date(a.date));
    return entries;
  }

  function cpHistRowHtml(e){
    return (
      '<div class="cp-row" data-cat="'+e.cat+'"'+
        (e.srNo!=null ? ' data-sr-no="'+escapeHtml(String(e.srNo))+'"' : '')+
        (e.reportId!=null ? ' data-report-id="'+escapeHtml(String(e.reportId))+'"' : '')+
        (e.reqId!=null ? ' data-req-id="'+escapeHtml(String(e.reqId))+'"' : '')+'>'+
        '<div class="cp-row-icon cat-'+e.cat+'">'+CP_ICON[CP_HIST_ICON[e.cat]]+'</div>'+
        '<div class="cp-row-body">'+
          '<div class="cp-row-title">'+escapeHtml(e.title)+'</div>'+
          (e.sub ? '<div class="cp-row-sub">'+escapeHtml(e.sub)+'</div>' : '')+
          '<div class="cp-row-sub">'+fmtDateTime(e.date)+'</div>'+
        '</div>'+
        '<div class="cp-row-chev">›</div>'+
      '</div>'
    );
  }

  function cpHistEmptyMsg(cat){
    // Invoices/Payments get an honest explanation instead of a generic
    // "nothing here" — see the data-availability note above.
    if(cat==='invoice') return 'Invoicing isn\u2019t set up yet \u2014 your quotation serves as your official quote for now.';
    if(cat==='payment') return 'Online payments aren\u2019t available yet \u2014 see your service fee under Quotations.';
    if(cat==='visit') return 'No service visits yet.';
    if(cat==='request') return 'No service requests yet.';
    if(cat==='quotation') return 'No quotations yet.';
    return 'No activity yet \u2014 your visits, requests, and quotes will show up here.';
  }

  function cpRenderHistoryDashboard(){
    const openStatuses = ['new','acknowledged','fee_proposed','fee_accepted','schedule_proposed','schedule_confirmed','preparing','dispatched','en_route','in_progress','completed'];
    $('cpHistStatVisits').textContent = String(cpReports.length);
    $('cpHistStatOpenReq').textContent = String(cpMyRequestsCache.filter(r=> openStatuses.includes(r.status)).length);
    $('cpHistStatQuotes').textContent = String(cpMyRequestsCache.filter(r=> r.feeAmount!=null).length);
  }

  function cpRenderHistoryList(){
    const all = cpHistTimelineEntries();
    const filtered = cpHistFilter==='all' ? all : all.filter(e=> e.cat===cpHistFilter);
    const list = $('cpHistList');
    list.innerHTML = filtered.length ? filtered.map(cpHistRowHtml).join('') : '<div class="empty-state">'+escapeHtml(cpHistEmptyMsg(cpHistFilter))+'</div>';
    $$('.cp-row', list).forEach(row=>{
      row.style.cursor = 'pointer';
      row.onclick = ()=>{
        if(row.dataset.srNo || row.dataset.reportId){
          if(typeof openCustomerReportPreview==='function') openCustomerReportPreview(row.dataset.srNo, row.dataset.reportId);
        } else if(row.dataset.reqId){
          const req = cpMyRequestsCache.find(r=> String(r.id)===row.dataset.reqId);
          if(req && typeof srOpenDetail==='function') srOpenDetail(req);
        }
      };
    });
  }

  function cpHistShowFilter(cat){
    cpHistFilter = CP_HIST_CATS.includes(cat) ? cat : 'all';
    $$('.cp-filter-chip', $('cpHistFilterChips')).forEach(chip=> chip.classList.toggle('active', chip.dataset.cat===cpHistFilter));
    cpRenderHistoryList();
  }

  async function renderCustomerHistoryScreen(sub){
    // Old callers pass 'Visits' or 'Requests' (nav shortcuts from before
    // the unified timeline existed — Home's quick actions, the notif
    // bell, Profile's "My service requests" row) — map them onto the
    // closest matching category so those entry points still land
    // somewhere relevant instead of always opening on "All".
    const initial = sub==='Requests' ? 'request' : sub==='Visits' ? 'visit' : sub==='Quotations' ? 'quotation' : 'all';
    cpHistFilter = initial;
    $$('.cp-filter-chip', $('cpHistFilterChips')).forEach(chip=> chip.classList.toggle('active', chip.dataset.cat===initial));
    $('cpHistList').innerHTML = '<div class="empty-state">Loading…</div>';
    // Fetch fresh rather than trusting whatever's already in
    // cpMyRequestsCache — a customer could land here as their first
    // screen after signing in, before Home's own load has populated it.
    if(currentUser && currentUser.customerId){
      cpMyRequestsCache = await srListForCustomer(currentUser.customerId);
    }
    cpRenderHistoryDashboard();
    cpRenderHistoryList();
  }
  $$('.cp-filter-chip', $('cpHistFilterChips')).forEach(chip=>{
    chip.addEventListener('click', ()=> cpHistShowFilter(chip.dataset.cat));
  });

  // ---------- Tools: calculators + tips ----------
  // Every calculator screen has the same shape: a live result card on top,
  // large inputs below, a "How this is calculated" section that lists every
  // assumption, and one next-step button. Figures are estimates and say so;
  // every assumption is visible and most are editable.

  // Electricity rate default — Meralco's overall rate for a typical
  // household, September 2026 (₱14.7424/kWh). Update when rates move; the
  // customer can always type the rate from their own bill (remembered on
  // their device).
  const CP_DEFAULT_RATE = 14.74;
  // Rated efficiency assumed when a unit's own label figure isn't known.
  // EER 10 BTU/h per watt ≈ a typical non-inverter split/window unit.
  const CP_EER_DEFAULT = 10;
  // Share of running hours the compressor is actually on (non-inverter
  // units cycle on and off to hold the set temperature).
  const CP_DUTY = 0.8;
  // Inverter units use roughly 30–50% less energy than non-inverter units
  // of the same capacity; 35% less is used as a middle, conservative value.
  const CP_INVERTER_FACTOR = 0.65;

  // Philippine aircon "HP" is a trade size, not true horsepower: 1 HP is
  // about 9,000 BTU/h and the common sizes don't scale exactly by HP.
  const CP_HP_BTU = { 0.5:5000, 0.75:7000, 1:9000, 1.5:12000, 2:18000, 2.5:22000, 3:27000, 4:36000, 5:45000 };
  const CP_BTU_PER_TR = 12000, CP_BTU_PER_KW = 3412;
  function cpHpToBtu(hp){ return CP_HP_BTU[hp] || hp * 9000; }
  function cpToBtu(value, unit){
    const v = Number(value) || 0;
    if(unit==='tr') return v * CP_BTU_PER_TR;
    if(unit==='kw') return v * CP_BTU_PER_KW;
    if(unit==='btu') return v;
    return cpHpToBtu(v);
  }
  // Reads a unit's capacity from its record ("5.0TR", "1.5 HP", "24000 BTU",
  // "7.1 kW"). Returns BTU/h, or 0 when it can't tell.
  function cpParseCapacity(text){
    const t = String(text||'').toLowerCase().replace(/,/g,'');
    const m = /([\d.]+)\s*(tr|ton|tons|hp|btu|kbtu|kw)?/.exec(t);
    if(!m) return 0;
    const v = parseFloat(m[1]); if(!(v>0)) return 0;
    const u = m[2] || (v >= 1000 ? 'btu' : '');
    if(u==='tr' || u==='ton' || u==='tons') return v * CP_BTU_PER_TR;
    if(u==='kbtu') return v * 1000;
    if(u==='btu') return v;
    if(u==='kw') return v * CP_BTU_PER_KW;
    if(u==='hp') return cpHpToBtu(v);
    return 0;
  }
  function cpFmtCap(btu){
    if(btu >= 24000) return (Math.round(btu/CP_BTU_PER_TR*10)/10)+' TR';
    const hp = Object.keys(CP_HP_BTU).map(Number).find(h=> CP_HP_BTU[h]===btu);
    return hp ? hp+' HP' : Math.round(btu).toLocaleString('en-PH')+' BTU/h';
  }
  const cpPeso = (n)=> '₱'+Math.round(n).toLocaleString('en-PH');
  const cpNum = (id)=>{ const el = $live(id); return el ? (parseFloat(el.value)||0) : 0; };
  // Small device-local memory for inputs the customer typed (rate, hours,
  // inverter yes/no per unit), so they don't re-enter them every visit.
  function cpPref(key, fallback){ try{ const v = localStorage.getItem('cp-tools:'+key); return v===null ? fallback : JSON.parse(v); }catch(e){ return fallback; } }
  function cpSetPref(key, val){ try{ localStorage.setItem('cp-tools:'+key, JSON.stringify(val)); }catch(e){} }

  // Monthly kWh for one unit.
  function cpUnitKwh(btu, inverter, hours, days, watts){
    const kw = watts > 0 ? watts/1000 : btu / CP_EER_DEFAULT / 1000;
    const base = kw * CP_DUTY * hours * days;
    return inverter ? base * CP_INVERTER_FACTOR : base;
  }
  // Each of the customer's units with its capacity and inverter status.
  // `recorded` = the inverter yes/no came from the unit record (set by
  // admin or a technician); otherwise the customer's own choice on this
  // device is used, defaulting to non-inverter.
  function cpMyUnits(){
    return cpEquipment.map(eq=>{
      const recorded = eq.inverter === true || eq.inverter === false;
      return { eq, btu: cpParseCapacity(eq.coolCap), recorded,
        inverter: recorded ? eq.inverter : !!cpPref('inv:'+eq.id, false) };
    });
  }

  // ---- shared calculator screen parts ----
  function cpCalcShell(id, o){
    $live('cpCalcTitle').textContent = o.title;
    $live('cpCalcBody').innerHTML =
      '<div class="ct-result" id="ctResult"></div>'+
      '<div class="ct-card ct-form">'+o.form+'</div>'+
      (o.extra || '')+
      '<details class="ct-how"><summary>How this is calculated</summary><div>'+o.how+'</div></details>'+
      (o.cta ? '<button type="button" class="ct-cta" id="ctCta">'+o.cta+'</button>' : '');
    if(o.cta && o.onCta) $live('ctCta').onclick = o.onCta;
    const run = ()=>{ try{ o.calc(); }catch(e){ console.error('calc failed', e); } };
    $live('cpCalcBody').oninput = run;
    $live('cpCalcBody').onchange = run;
    $live('cpCalcBody').onclick = (e)=>{
      const seg = e.target.closest('[data-seg]');
      if(seg){
        const group = seg.parentElement;
        $$('[data-seg]', group).forEach(b=> b.classList.toggle('on', b===seg));
        group.dataset.value = seg.dataset.seg;
        if(o.onSeg) o.onSeg(group.id, seg.dataset.seg);
        run();
      }
    };
    run();
    cpShowCalcScreen();
  }
  function cpSeg(id, options, value){
    return '<div class="ct-seg" id="'+id+'" data-value="'+value+'">'+options.map(([v,l])=>
      '<button type="button" data-seg="'+v+'" class="'+(v===value ? 'on' : '')+'">'+l+'</button>').join('')+'</div>';
  }
  function cpSegVal(id){ const el = $live(id); return el ? el.dataset.value : ''; }
  function cpField(label, input, hint){
    return '<div class="ct-field"><label>'+label+'</label>'+input+(hint ? '<p class="ct-hint">'+hint+'</p>' : '')+'</div>';
  }
  function cpInput(id, value, suffix, attrs){
    return '<div class="ct-input"><input type="number" inputmode="decimal" id="'+id+'" value="'+value+'" '+(attrs||'min="0"')+'>'+(suffix ? '<span>'+suffix+'</span>' : '')+'</div>';
  }
  function cpResult(main, label, rows, tone){
    $live('ctResult').className = 'ct-result'+(tone ? ' ct-result-'+tone : '');
    $live('ctResult').innerHTML = '<p class="ct-result-l">'+label+'</p><p class="ct-result-n">'+main+'</p>'+
      (rows && rows.length ? '<div class="ct-result-rows">'+rows.map(r=> '<span>'+r+'</span>').join('')+'</div>' : '');
  }
  const cpCapUnitSel = (id, val)=> '<select id="'+id+'">'+[['hp','HP'],['tr','TR (tons)'],['btu','BTU/h'],['kw','kW']].map(([v,l])=>
    '<option value="'+v+'"'+(v===val?' selected':'')+'>'+l+'</option>').join('')+'</select>';

  // ---- 1. Electricity cost ----
  function cpCalcElectricity(){
    const mine = cpMyUnits().filter(u=> u.btu>0);
    const mode0 = mine.length ? 'mine' : 'manual';
    const unknown = mine.filter(u=> !u.recorded).length;
    const rows = mine.map((u,i)=>
      '<div class="ct-unit"><div class="ct-unit-t"><b>'+cpEquipLabel(u.eq)+'</b><span>'+escapeHtml(cpFmtCap(u.btu))+
        (u.recorded ? ' · '+(u.inverter ? 'Inverter' : 'Non-inverter')+' (on record)' : ' · type not on record')+'</span></div>'+
        cpSeg('ceInv'+i, [['0','Non-inverter'],['1','Inverter']], u.inverter ? '1' : '0')+
        '<span class="ct-unit-cost" id="ceCost'+i+'">—</span></div>'
    ).join('')+(unknown ? '<p class="ct-hint">Not sure which type you have? It\u2019s usually printed on the unit\u2019s label or remote. We record it on your next service visit.</p>' : '');
    const skipped = cpEquipment.length - mine.length;
    cpCalcShell('electricity', {
      title:'Electricity cost',
      form:
        (mine.length ? cpField('Which units', cpSeg('ceMode', [['mine','My units ('+mine.length+')'],['manual','Enter manually']], mode0)) : '')+
        '<div id="ceMine"'+(mode0==='mine' ? '' : ' style="display:none"')+'>'+rows+
          (skipped ? '<p class="ct-hint">'+skipped+' unit'+(skipped===1?' has':'s have')+' no capacity on record, so '+(skipped===1?'it is':'they are')+' left out.</p>' : '')+'</div>'+
        '<div id="ceManual"'+(mode0==='manual' ? '' : ' style="display:none"')+'>'+
          '<div class="ct-row2">'+cpField('Capacity', cpInput('ceCap', cpPref('ceCap', 1.5), '', 'min="0" step="0.5"'))+cpField('Unit', cpCapUnitSel('ceCapUnit', cpPref('ceCapUnit','hp')))+'</div>'+
          '<div class="ct-row2">'+cpField('Type', cpSeg('ceType', [['0','Non-inverter'],['1','Inverter']], '0'))+cpField('How many', cpInput('ceQty', 1, 'units', 'min="1" step="1"'))+'</div>'+
          cpField('Rated power (optional)', cpInput('ceWatts', '', 'watts'), 'From the label or spec sheet ("Power input"). Leave blank if you don\u2019t have it.')+
        '</div>'+
        '<div class="ct-row2">'+cpField('Hours per day', cpInput('ceHours', cpPref('ceHours', 8), 'hrs', 'min="0" max="24"'))+cpField('Days per month', cpInput('ceDays', cpPref('ceDays', 30), 'days', 'min="0" max="31"'))+'</div>'+
        cpField('Electricity rate', cpInput('ceRate', cpPref('ceRate', CP_DEFAULT_RATE), '₱ per kWh', 'min="0" step="0.01"'), 'Use the rate on your latest bill. Default is Meralco\u2019s typical household rate for September 2026.'),
      extra:'<div class="ct-card ct-note" id="ceInvNote" style="display:none"></div>',
      how:
        '<p>Power used = cooling capacity ÷ efficiency. Without a rated power figure we assume <b>EER 10</b> (10 BTU/h per watt), typical of a non-inverter unit, so a 5 TR unit (60,000 BTU/h) draws about 6 kW.</p>'+
        '<p>The compressor is assumed to run <b>80%</b> of the hours you enter, since it cycles off once the room is cool.</p>'+
        '<p>Inverter units are counted at <b>35% less</b> energy than non-inverter units of the same size; real savings are usually 30–50%.</p>'+
        '<p>Monthly cost = kWh × your rate. Actual bills vary with the set temperature, outdoor heat, how well the room is sealed, and how clean the unit is.</p>',
      cta:'Book maintenance', onCta:()=> cpOpenNewRequest({ description:'Preventive maintenance' }),
      onSeg:(gid, v)=>{
        if(gid==='ceMode'){ $live('ceMine').style.display = v==='mine' ? '' : 'none'; $live('ceManual').style.display = v==='manual' ? '' : 'none'; }
        // Only remember the customer's pick for units with no type on
        // record — a recorded type stays the default, a switch there is
        // just a "what if".
        const m = /^ceInv(\d+)$/.exec(gid);
        if(m && !mine[Number(m[1])].recorded) cpSetPref('inv:'+mine[Number(m[1])].eq.id, v==='1');
      },
      calc:()=>{
        const hours = Math.min(24, cpNum('ceHours')), days = Math.min(31, cpNum('ceDays')), rate = cpNum('ceRate');
        cpSetPref('ceHours', hours); cpSetPref('ceDays', days); cpSetPref('ceRate', rate);
        let kwh = 0, kwhAllInv = 0, nonInv = 0;
        if((cpSegVal('ceMode') || mode0) === 'mine' && mine.length){
          mine.forEach((u,i)=>{
            const inv = cpSegVal('ceInv'+i) === '1';
            const k = cpUnitKwh(u.btu, inv, hours, days, 0);
            kwh += k; kwhAllInv += cpUnitKwh(u.btu, true, hours, days, 0); if(!inv) nonInv++;
            const c = $live('ceCost'+i); if(c) c.textContent = cpPeso(k*rate)+'/mo';
          });
        } else {
          const btu = cpToBtu(cpNum('ceCap'), $live('ceCapUnit').value), qty = Math.max(1, Math.round(cpNum('ceQty')));
          cpSetPref('ceCap', cpNum('ceCap')); cpSetPref('ceCapUnit', $live('ceCapUnit').value);
          const inv = cpSegVal('ceType') === '1', watts = cpNum('ceWatts');
          kwh = cpUnitKwh(btu, inv, hours, days, watts) * qty;
          kwhAllInv = inv ? kwh : cpUnitKwh(btu, false, hours, days, watts) * CP_INVERTER_FACTOR * qty;
          nonInv = inv ? 0 : qty;
        }
        const cost = kwh * rate;
        cpResult(cpPeso(cost), 'Estimated per month', [
          Math.round(kwh).toLocaleString('en-PH')+' kWh',
          cpPeso(days ? cost/days : 0)+' a day',
          cpPeso(cost*12)+' a year'
        ]);
        const note = $live('ceInvNote');
        const save = (kwh - kwhAllInv) * rate;
        if(nonInv && save > 0){
          note.style.display = '';
          note.innerHTML = '<b>Switching '+(nonInv===1 ? 'this unit' : 'these '+nonInv+' units')+' to inverter</b><span>could save about '+cpPeso(save)+' a month ('+cpPeso(save*12)+' a year). See the Inverter upgrade calculator for payback.</span>';
        } else note.style.display = 'none';
      }
    });
  }

  // ---- 2. Right size for a room ----
  const CP_SIZES = [[9000,'1 HP'],[12000,'1.5 HP'],[18000,'2 HP'],[22000,'2.5 HP'],[27000,'3 HP']];
  function cpCalcCapacity(){
    cpCalcShell('capacity', {
      title:'Right size for a room',
      form:
        '<div class="ct-row2">'+cpField('Floor area', cpInput('ccArea', 20, 'sqm'))+cpField('Ceiling height', cpInput('ccHeight', 2.7, 'm', 'min="2" step="0.1"'))+'</div>'+
        cpField('Sun on the room', cpSeg('ccSun', [['shade','Mostly shaded'],['normal','Normal'],['hot','Afternoon sun / top floor']], 'normal'))+
        '<div class="ct-row2">'+cpField('People usually inside', cpInput('ccPeople', 2, '', 'min="0" step="1"'))+cpField('Equipment heat', cpInput('ccWatts', 0, 'watts'))+'</div>'+
        '<p class="ct-hint">Equipment heat: add up the wattage of things that run in the room — computers, lights, dental chairs, sterilizers, fridges. A desktop PC is about 150 W.</p>',
      how:
        '<p>Base: <b>600 BTU/h per square meter</b> for a typical Philippine room with a 2.7 m ceiling.</p>'+
        '<p>Taller ceilings scale it up by height. Mostly shaded rooms take 10% less; afternoon sun or a top floor adds 15%.</p>'+
        '<p>Each person beyond two adds <b>600 BTU/h</b>. Equipment adds <b>3.41 BTU/h per watt</b> — every watt used in the room ends up as heat.</p>'+
        '<p>Aircon sizes: 1 HP ≈ 9,000 BTU/h, 1.5 HP ≈ 12,000, 2 HP ≈ 18,000, 2.5 HP ≈ 22,000, 3 HP ≈ 27,000. 1 TR = 12,000 BTU/h. This is a starting point, not a full heat-load survey.</p>',
      cta:'Ask for a site survey', onCta:()=> cpOpenNewRequest({ description:'Site survey / aircon sizing for a room of '+cpNum('ccArea')+' sqm' }),
      calc:()=>{
        const area = cpNum('ccArea'), h = Math.max(2, cpNum('ccHeight')||2.7);
        const sun = { shade:0.9, normal:1, hot:1.15 }[cpSegVal('ccSun')] || 1;
        const btu = area * 600 * Math.max(1, h/2.7) * sun + Math.max(0, cpNum('ccPeople')-2) * 600 + cpNum('ccWatts') * 3.412;
        if(area <= 0){ cpResult('—', 'Suggested size', []); return; }
        const kw = btu / CP_BTU_PER_KW, tr = btu / CP_BTU_PER_TR;
        const fit = CP_SIZES.find(s=> s[0] >= btu * 0.95);
        if(fit){
          cpResult(fit[1], 'Suggested size', [Math.round(btu).toLocaleString('en-PH')+' BTU/h needed', (Math.round(tr*10)/10)+' TR', (Math.round(kw*10)/10)+' kW']);
        } else {
          const trNeed = Math.ceil(tr*2)/2;
          cpResult(trNeed+' TR total', 'More than one wall unit can cover', [Math.round(btu).toLocaleString('en-PH')+' BTU/h', (Math.round(kw*10)/10)+' kW',
            'e.g. '+Math.ceil(btu/27000)+' × 3 HP units, or a ducted / floor-mounted system']);
        }
      }
    });
  }

  // ---- 3. Maintenance value ----
  function cpCalcSavings(){
    const mine = cpMyUnits().filter(u=> u.btu>0);
    const avgKwh = mine.length ? mine.reduce((s,u)=> s + cpUnitKwh(u.btu, u.inverter, cpPref('ceHours',8), cpPref('ceDays',30), 0), 0) / mine.length : cpUnitKwh(12000, false, 8, 30, 0);
    const energy0 = Math.round(avgKwh * cpPref('ceRate', CP_DEFAULT_RATE) / 10) * 10;
    cpCalcShell('savings', {
      title:'Maintenance value',
      form:
        '<div class="ct-row2">'+cpField('Number of units', cpInput('csUnits', cpEquipment.length||1, '', 'min="1" step="1"'))+cpField('PM visits a year', cpInput('csVisits', 4, 'per unit', 'min="0" step="1"'))+'</div>'+
        '<div class="ct-row2">'+cpField('PM cost per visit', cpInput('csPmCost', 1500, '₱'))+cpField('Typical repair cost', cpInput('csRepair', 8000, '₱'))+'</div>'+
        cpField('Electricity cost per unit', cpInput('csEnergy', energy0, '₱ a month'), mine.length ? 'Estimated from your units in the Electricity cost calculator.' : 'Use the Electricity cost calculator, or your bill.')+
        '<p class="ct-sub">Assumptions — change them if you know better</p>'+
        '<div class="ct-row2">'+cpField('Breakdown chance without PM', cpInput('csPNo', 30, '% a year'))+cpField('Breakdown chance with PM', cpInput('csPYes', 10, '% a year'))+'</div>'+
        cpField('Extra energy used by a dirty unit', cpInput('csLoss', 10, '%')),
      how:
        '<p><b>Repairs avoided</b> = units × (breakdown chance without PM − with PM) × repair cost. The defaults (30% vs 10% a year) are an illustration, not a guarantee — adjust them to what you\u2019ve seen.</p>'+
        '<p><b>Energy saved</b> = units × monthly electricity × 12 × the extra energy a dirty unit uses. Dust on the filter and coils makes the unit work harder; 5–15% is commonly seen, 10% is used here.</p>'+
        '<p><b>Net</b> = repairs avoided + energy saved − PM cost. If the net is negative, PM still buys fewer surprise breakdowns, cleaner air, a longer unit life, and the service records most warranties require.</p>',
      cta:'Book maintenance', onCta:()=> cpOpenNewRequest({ description:'Preventive maintenance' }),
      calc:()=>{
        const n = Math.max(0, cpNum('csUnits'));
        const pm = n * cpNum('csVisits') * cpNum('csPmCost');
        const repairs = n * Math.max(0, cpNum('csPNo') - cpNum('csPYes')) / 100 * cpNum('csRepair');
        const energy = n * cpNum('csEnergy') * 12 * cpNum('csLoss') / 100;
        const net = repairs + energy - pm;
        cpResult((net < 0 ? '−' : '')+cpPeso(Math.abs(net)), net >= 0 ? 'Estimated net savings a year' : 'PM costs more than it saves in money', [
          'Repairs avoided '+cpPeso(repairs), 'Energy saved '+cpPeso(energy), 'PM cost '+cpPeso(pm)
        ], net >= 0 ? '' : 'warn');
      }
    });
  }

  // ---- 4. Inverter upgrade payback ----
  function cpCalcInverter(){
    const mine = cpMyUnits().filter(u=> u.btu>0 && !u.inverter);
    const cap0 = mine.length ? mine.reduce((s,u)=> s+u.btu, 0) / mine.length : 12000;
    cpCalcShell('inverter', {
      title:'Inverter upgrade',
      form:
        (mine.length ? '<p class="ct-hint" style="margin-top:0">Filled in from your '+mine.length+' non-inverter unit'+(mine.length===1?'':'s')+'.</p>' : '')+
        '<div class="ct-row2">'+cpField('Capacity per unit', cpInput('ciCap', Math.round(cap0), 'BTU/h', 'min="0" step="1000"'))+cpField('How many units', cpInput('ciQty', mine.length || 1, '', 'min="1" step="1"'))+'</div>'+
        '<div class="ct-row2">'+cpField('Hours per day', cpInput('ciHours', cpPref('ceHours', 8), 'hrs'))+cpField('Days per month', cpInput('ciDays', cpPref('ceDays', 30), 'days'))+'</div>'+
        cpField('Electricity rate', cpInput('ciRate', cpPref('ceRate', CP_DEFAULT_RATE), '₱ per kWh', 'min="0" step="0.01"'))+
        cpField('Price of a new inverter unit', cpInput('ciPrice', 45000, '₱ per unit, installed'), 'Use the quotation you received. Ask us for one if you don\u2019t have it.')+
        cpField('Energy saved by inverter', cpInput('ciSave', 35, '%'), 'Typically 30–50% compared with a non-inverter unit.'),
      how:
        '<p>Current use: capacity ÷ EER 10 × 80% running × hours × days (same as the Electricity cost calculator).</p>'+
        '<p>Inverter use: the same, minus the energy saved (35% by default).</p>'+
        '<p><b>Payback</b> = total price of the new units ÷ money saved each month. It doesn\u2019t count repair costs avoided on an ageing unit, which usually shortens the payback.</p>',
      cta:'Request a quote', onCta:()=> cpOpenNewRequest({ description:'Quotation request: inverter aircon replacement ('+Math.max(1,Math.round(cpNum('ciQty')))+' unit/s)' }),
      calc:()=>{
        const qty = Math.max(1, Math.round(cpNum('ciQty')));
        const kwhNow = cpUnitKwh(cpNum('ciCap'), false, cpNum('ciHours'), cpNum('ciDays'), 0) * qty;
        const monthly = kwhNow * cpNum('ciSave') / 100 * cpNum('ciRate');
        const price = cpNum('ciPrice') * qty;
        if(monthly <= 0){ cpResult('—', 'Payback time', []); return; }
        const months = price / monthly;
        const txt = months < 1 ? 'Under a month' : months < 24 ? Math.round(months)+' months' : (Math.round(months/12*10)/10)+' years';
        cpResult(txt, 'Payback time', [cpPeso(monthly)+' saved a month', cpPeso(monthly*12)+' a year', cpPeso(price)+' total price']);
      }
    });
  }

  // ---- 5. Unit converter ----
  function cpCalcConvert(){
    cpCalcShell('convert', {
      title:'Unit converter',
      form: '<div class="ct-row2">'+cpField('Value', cpInput('cvVal', 1, '', 'min="0" step="any"'))+cpField('From', cpCapUnitSel('cvUnit','tr'))+'</div>'+
        '<div class="ct-conv" id="cvOut"></div>',
      how:
        '<p>1 TR (ton of refrigeration) = 12,000 BTU/h = 3.52 kW of cooling.</p>'+
        '<p>Aircon "HP" in the Philippines is a trade size, not engine horsepower: 1 HP ≈ 9,000 BTU/h, 1.5 HP ≈ 12,000, 2 HP ≈ 18,000, 2.5 HP ≈ 22,000, 3 HP ≈ 27,000. Brands differ slightly — check the BTU/h or kW on the spec sheet when comparing quotations.</p>'+
        '<p>kW here means cooling output, not electricity used.</p>',
      calc:()=>{
        const btu = cpToBtu(cpNum('cvVal'), $live('cvUnit').value);
        const hp = btu / 9000;
        const near = CP_SIZES.slice().sort((a,b)=> Math.abs(a[0]-btu) - Math.abs(b[0]-btu))[0];
        cpResult(Math.round(btu).toLocaleString('en-PH')+' BTU/h', 'Cooling capacity', []);
        $live('cvOut').innerHTML = [
          ['TR', (Math.round(btu/CP_BTU_PER_TR*100)/100)],
          ['kW', (Math.round(btu/CP_BTU_PER_KW*100)/100)],
          ['HP (approx.)', (Math.round(hp*100)/100)+(btu<=30000 && near ? ' · nearest size '+near[1] : '')]
        ].map(([l,v])=> '<div><span>'+l+'</span><b>'+v+'</b></div>').join('');
      }
    });
  }

  // ---- 6. Maintenance schedule ----
  function cpCalcSchedule(){
    const lastDates = cpEquipment.map(eq=> eq.lastReport && eq.lastReport.date).filter(Boolean).sort();
    const last = lastDates.length ? lastDates[lastDates.length-1] : '';
    cpCalcShell('schedule', {
      title:'Maintenance schedule',
      form:
        cpField('Type of place', cpSeg('smPlace', [['home','Home'],['office','Office / shop'],['clinic','Clinic'],['food','Restaurant']], cpEquipment.length > 2 ? 'office' : 'home'))+
        cpField('Hours used a day', cpSeg('smHours', [['low','Under 6'],['mid','6 to 12'],['high','Over 12']], 'mid'))+
        cpField('Surroundings', cpSeg('smDust', [['clean','Clean'],['dusty','Dusty / near a road'],['build','Construction nearby']], 'clean'))+
        cpField('Last service', '<div class="ct-input"><input type="date" id="smLast" value="'+escapeHtml(String(last).slice(0,10))+'"></div>', last ? 'From your latest service report.' : ''),
      how:
        '<p>Starting points: homes every 6 months, offices and shops every 4, clinics every 3 (cleaner air matters more), restaurants every 2 (grease and smoke clog coils quickly).</p>'+
        '<p>Use over 12 hours a day, or a dusty site, brings it forward by a month; construction nearby by two. Never more often than monthly or less often than every 6 months.</p>'+
        '<p>Clean the filters yourself in between — every 2 to 4 weeks.</p>',
      cta:'Book maintenance', onCta:()=> cpOpenNewRequest({ description:'Preventive maintenance' }),
      calc:()=>{
        let m = { home:6, office:4, clinic:3, food:2 }[cpSegVal('smPlace')] || 4;
        if(cpSegVal('smHours')==='high') m -= 1;
        if(cpSegVal('smHours')==='low' && cpSegVal('smPlace')==='home') m = 6;
        if(cpSegVal('smDust')==='dusty') m -= 1;
        if(cpSegVal('smDust')==='build') m -= 2;
        m = Math.max(1, Math.min(6, m));
        const lastV = ($live('smLast') && $live('smLast').value) || '';
        const rows = ['About '+Math.round(12/m)+' visits a year'];
        if(lastV){
          const d = new Date(lastV+'T00:00:00'); d.setMonth(d.getMonth()+m);
          const iso = d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
          const du = daysUntil(iso);
          rows.push('Next due '+d.toLocaleDateString('en-PH',{month:'long', day:'numeric', year:'numeric'})+(du < 0 ? ' (overdue)' : ''));
        }
        cpResult('Every '+m+' month'+(m===1?'':'s'), 'Recommended PM', rows);
      }
    });
  }

  const CP_CALCULATORS = [
    { id:'electricity', icon:'bolt', tone:'amber', title:'Electricity cost', desc:'Monthly bill for your units', run:cpCalcElectricity },
    { id:'capacity', icon:'ruler', tone:'teal', title:'Right size for a room', desc:'HP or TR for your space', run:cpCalcCapacity },
    { id:'savings', icon:'tools', tone:'green', title:'Maintenance value', desc:'PM cost vs. what it saves', run:cpCalcSavings },
    { id:'inverter', icon:'swap', tone:'blue', title:'Inverter upgrade', desc:'How fast it pays back', run:cpCalcInverter },
    { id:'convert', icon:'calculator', tone:'violet', title:'Unit converter', desc:'HP · TR · BTU/h · kW', run:cpCalcConvert },
    { id:'schedule', icon:'calendar', tone:'rose', title:'Maintenance schedule', desc:'How often to book PM', run:cpCalcSchedule }
  ];
  function cpOpenCalc(id){ const c = CP_CALCULATORS.find(x=> x.id===id); if(c) c.run(); }

  // ---- Tips ----
  const CP_TIP_CATS = [['all','All'],['energy','Save energy'],['care','Care'],['signs','Warning signs'],['buying','Buying guide'],['fire','Fire safety']];
  const CP_TIP_ICON = { energy:'bolt', care:'leaf', signs:'alert', buying:'book', fire:'flame' };
  const UL = (items)=> '<ul>'+items.map(i=> '<li>'+i+'</li>').join('')+'</ul>';
  const CP_TIPS = [
    { id:'temp', cat:'energy', title:'Set it to 24–26°C, not 18°C', short:'A lower setting doesn\u2019t cool the room faster — it only keeps the compressor running longer.', body:[
      'The unit cools at the same speed whatever number you set; a lower setting just means it runs longer before it stops. 24–26°C is comfortable for most people and uses noticeably less power.',
      'Use <b>Auto</b> fan speed, and <b>Sleep</b> mode at night — it raises the setting slowly while you sleep.',
      'If the room never gets cool even at a low setting, the unit likely needs cleaning or a check — not a lower number.' ]},
    { id:'fan', cat:'energy', title:'Use an electric fan with the aircon', short:'Moving air feels 2–3°C cooler, so you can set the aircon higher.', body:[
      'A fan uses a small fraction of an aircon\u2019s power. Air moving over your skin feels cooler, so the room is just as comfortable at a higher setting.',
      'Point the fan to spread the cool air across the room rather than straight at the aircon.' ]},
    { id:'sun', cat:'energy', title:'Block the afternoon sun', short:'Close curtains or blinds on west-facing windows before 1 PM.', body:[
      'Sun through glass is one of the biggest heat loads in a room. Closing curtains, blinds or tinting on west- and south-facing windows keeps that heat out before the aircon has to remove it.',
      'Light-colored curtains reflect more heat than dark ones.' ]},
    { id:'doors', cat:'energy', title:'Keep doors and windows closed', short:'Every open door lets cool air out and hot, humid air in.', body:[
      'In shops and clinics, doors propped open are a common reason units run all day without keeping up. A door closer helps.',
      'Seal gaps under doors and around window-type units. Turn off the aircon if a room will stay open for a long time.' ]},
    { id:'outdoor', cat:'energy', title:'Give the outdoor unit room to breathe', short:'Keep plants, boxes and walls away from it.', body:[
      'The outdoor unit pushes the room\u2019s heat out. If the air around it is blocked or hot, it works harder and uses more power.',
      UL(['Keep the sides and back clear — check the manual for the exact spacing, usually at least 30 cm.','Don\u2019t store things on top of it or cover it while it runs.','Shade from a roof overhang helps, but don\u2019t enclose it in a box or cabinet.','Keep it level and firmly mounted.']) ]},
    { id:'filter', cat:'care', title:'Clean your air filter every month', short:'The easiest way to keep a unit cold and efficient.', body:[
      'The filter is the mesh just behind the front panel. When it clogs, less air passes through: the unit cools less, runs longer and works harder.',
      '<b>How often:</b> every 2–4 weeks with daily use; more often in dusty areas, with pets, or near construction.',
      UL(['Turn the unit off, and off at the breaker if you can.','Open the front panel and slide the filter out.','Vacuum the dust, then rinse with running water. Use a soft brush for stuck dirt.','Let it dry completely out of direct sun, then put it back.']),
      'Replace a filter that is torn, brittle or won\u2019t come clean.' ]},
    { id:'typhoon', cat:'care', title:'Before and after a typhoon', short:'Switch off, secure the outdoor unit, and don\u2019t restart a flooded unit.', body:[
      UL(['<b>Before:</b> turn units off at the breaker. Check that the outdoor unit\u2019s bracket and bolts are tight.','Don\u2019t wrap the outdoor unit tightly in plastic — trapped moisture can do more harm than rain.','<b>After:</b> if the outdoor unit was underwater or has debris inside, <b>don\u2019t switch it on</b>. Water in the electrical parts can cause a short. Request a check first.','Clear leaves and debris from around the unit before using it again.']) ]},
    { id:'brownout', cat:'care', title:'During brownouts and power fluctuations', short:'Switch off at the unit, and wait a few minutes before turning it back on.', body:[
      'Power that flickers or comes back in surges is hard on the compressor and the control board.',
      UL(['When power goes out, turn the aircon off with the remote and at the breaker.','When power returns, wait 3–5 minutes before switching it on, so the pressure in the system settles.','If brownouts are frequent in your area, ask us about a voltage protector for your units.']) ]},
    { id:'smell', cat:'care', title:'Stop musty smells', short:'Run Fan mode for 10–15 minutes before switching off.', body:[
      'Cooling leaves the inside of the unit damp. Switched off right away, that moisture can grow mold and smell musty.',
      'Running <b>Fan</b> mode (or the unit\u2019s drying or self-clean function) for 10–15 minutes before turning it off dries the coil.',
      'If the smell stays after cleaning the filter, the coil or drain needs a professional cleaning.' ]},
    { id:'signs', cat:'signs', title:'Signs your unit needs service', short:'What to watch and listen for between PM visits.', body:[
      'Most breakdowns give a warning first. Request a visit if you notice:',
      UL(['<b>Weak airflow or warm air</b> — a dirty filter or coil, a fan problem, or low refrigerant.','<b>Unusual noises</b> — rattling from a loose part; hissing can mean a refrigerant leak.','<b>Water dripping</b> from the indoor unit — usually a blocked drain line.','<b>Ice</b> on the indoor coil or outdoor pipes — keep running it and the compressor can be damaged.','<b>Short cycling</b> — turning on and off in quick bursts.','<b>A higher bill</b> with no change in use.']),
      'These are cheaper to fix early: a blocked drain is quick to clear, the water damage it causes later isn\u2019t.' ]},
    { id:'danger', cat:'signs', title:'When to switch off right away', short:'Burning smell, sparks, or a breaker that keeps tripping.', body:[
      'Turn the unit off <b>at the breaker</b> and request a visit if you notice:',
      UL(['A burning or electrical smell','Sparks, smoke, or scorch marks at the unit, plug or outlet','A breaker that trips again after you reset it','Wires or the power cord getting hot']),
      'Don\u2019t keep resetting a breaker that trips — it is protecting the wiring from a fault.' ]},
    { id:'pm', cat:'buying', title:'What a PM visit covers', short:'A check-up that catches small problems before they become repairs.', body:[
      'A preventive maintenance visit is a scheduled check-up, not a repair. It usually covers:',
      UL(['Washing the indoor and outdoor coils','Cleaning or replacing filters','Checking refrigerant pressure','Clearing the drain line','Checking electrical connections, the capacitor and fan motors','Checking airflow and cooling performance']),
      '<b>How often:</b> every 3 months for heavy or all-day use, 4–6 months for a typical home. The Maintenance schedule calculator gives a suggestion for your place.',
      'Most manufacturers ask for maintenance records to honor the compressor warranty — your service reports here are those records.' ]},
    { id:'inverter', cat:'buying', title:'Inverter vs. non-inverter', short:'The one spec that changes your electricity bill the most.', body:[
      '<b>Non-inverter:</b> the compressor runs at full speed, then switches off, then on again. Cheaper to buy, costlier to run.',
      '<b>Inverter:</b> the compressor slows down once the room is cool instead of switching off. It typically uses 30–50% less electricity, and the room temperature stays steadier.',
      'On the Philippine Energy Label, a higher EER or CSPF means more cooling per peso of electricity. Compare those numbers across brands.' ]},
    { id:'bigger', cat:'buying', title:'Bigger isn\u2019t better', short:'An oversized unit cools fast but leaves the room damp and clammy.', body:[
      'An aircon removes humidity as well as heat — but only while it runs. A unit that is too big cools the room in short bursts and switches off before it has dried the air, so the room feels cold and clammy.',
      'Too small is a problem too: it runs non-stop and never quite gets there. Use the Right size calculator as a guide, and ask for a site survey for large or unusual spaces.' ]},
    { id:'replace', cat:'buying', title:'Repair or replace?', short:'How to decide once a repair estimate is on the table.', body:[
      UL(['<b>Age:</b> a well-maintained split unit usually lasts 10–15 years. A big repair on an old unit is worth weighing against a new, more efficient one.','<b>Repair cost:</b> if one repair is a large share of a new unit\u2019s price, replacing is often better.','<b>How often it breaks:</b> repeat calls within a year usually mean replacing costs less.','<b>Refrigerant:</b> units using phased-out refrigerant (R-22) cost more to service.']),
      'Ask your technician — they can tell you the condition of the whole unit, not just the part that failed. The Inverter upgrade calculator shows how fast a new unit pays back.' ]},
    { id:'extinguisher', cat:'fire', title:'Check your fire extinguisher monthly', short:'Gauge in the green, pin in place, easy to reach.', body:[
      'A quick look once a month:',
      UL(['The pressure gauge needle is in the <b>green</b>.','The safety pin and seal are in place.','No dents, rust, or a cracked hose.','It is mounted where people can see and reach it — not behind boxes.']),
      '<b>Using it — P.A.S.S.:</b> <b>P</b>ull the pin, <b>A</b>im at the base of the fire, <b>S</b>queeze the handle, <b>S</b>weep side to side.',
      'Have extinguishers serviced and refilled on schedule, and right away after any use.' ]},
    { id:'smoke', cat:'fire', title:'Test smoke detectors and alarms', short:'Press the test button once a month.', body:[
      UL(['Press and hold the test button on battery-type detectors monthly; replace batteries at least once a year or when they chirp.','Never paint over, cover, or tape a detector — including during renovations.','For a building fire alarm system (FDAS), don\u2019t silence a trouble signal and forget it. A trouble light or beeping on the panel means something needs checking — request a visit.']) ]},
    { id:'sprinkler', cat:'fire', title:'Keep sprinklers clear', short:'Leave space under every sprinkler head. Never hang things on it.', body:[
      UL(['Keep storage at least <b>45 cm (18 in)</b> below sprinkler heads so the water can spread.','Never hang things from sprinkler heads or pipes, and never paint them — paint can stop a head from opening.','Report heads that are leaking, corroded, bent or damaged.','Keep the fire alarm panel, sprinkler valves and exits unblocked.']) ]},
    { id:'fsic', cat:'fire', title:'Fire safety inspection (FSIC)', short:'Establishments renew their Fire Safety Inspection Certificate every year.', body:[
      'Under the Fire Code of the Philippines, businesses need a Fire Safety Inspection Certificate from the Bureau of Fire Protection, renewed yearly with the business permit.',
      'Inspectors look for working extinguishers, alarms, sprinklers and exits. Having your fire protection systems tested and maintained before the inspection — with records to show — avoids delays.',
      'We can inspect and test your sprinkler (AFSS) and fire alarm (FDAS) systems and give you the service report.' ]}
  ];
  let cpTipCat = 'all';
  function cpTipOfDay(){
    const d = new Date(); const n = Math.floor((d - new Date(d.getFullYear(),0,0)) / 864e5);
    return CP_TIPS[n % CP_TIPS.length];
  }
  function renderCustomerToolsScreen(){
    $live('cpToolsSearchIc').innerHTML = CP_ICON.search;
    const tod = cpTipOfDay();
    $live('cpTipOfDay').innerHTML =
      '<p class="ct-tod-l">'+CP_ICON.bulb+' Tip of the day</p>'+
      '<p class="ct-tod-t">'+escapeHtml(tod.title)+'</p><p class="ct-tod-d">'+escapeHtml(tod.short)+'</p>'+
      '<button type="button" class="ct-link" data-tip="'+tod.id+'">Read more</button>';
    $live('cpCalcGrid').innerHTML = CP_CALCULATORS.map(c=>
      '<button type="button" class="ct-calc" data-calc="'+c.id+'">'+
        '<span class="ct-ic ct-'+c.tone+'">'+(CP_ICON[c.icon]||'')+'</span>'+
        '<span class="ct-calc-t">'+c.title+'</span><span class="ct-calc-d">'+c.desc+'</span>'+
      '</button>').join('');
    $live('cpTipChips').innerHTML = CP_TIP_CATS.map(([k,l])=> '<button type="button" class="ct-chip'+(k===cpTipCat?' on':'')+'" data-cat="'+k+'">'+l+'</button>').join('');
    $live('cpArticleList').innerHTML = CP_TIPS.map(t=>
      '<button type="button" class="ct-tip" data-tip="'+t.id+'" data-cat="'+t.cat+'">'+
        '<span class="ct-ic ct-sm ct-cat-'+t.cat+'">'+(CP_ICON[CP_TIP_ICON[t.cat]]||'')+'</span>'+
        '<span class="ct-text"><span class="ct-tip-t">'+escapeHtml(t.title)+'</span><span class="ct-tip-d">'+escapeHtml(t.short)+'</span></span>'+
        '<span class="ct-chev">›</span></button>').join('');
    const phone = String(CP_SUPPORT.phone||'').trim();
    $live('cpToolsHelp').innerHTML = '<span class="ct-ic ct-green">'+CP_ICON.chat+'</span><span class="ct-text"><span class="ct-tip-t">Not sure what your unit needs?</span><span class="ct-tip-d">Ask us — we\u2019ll check it for you.</span></span>'+
      (phone ? '<a class="ct-mini" href="tel:'+escapeHtml(phone.replace(/[^\d+]/g,''))+'">Call</a>' : '<button type="button" class="ct-mini" data-help="1">Message us</button>');
    cpToolsFilter();
  }
  function cpToolsFilter(){
    const q = ($live('cpToolsSearch').value||'').trim().toLowerCase();
    let calcs = 0, tips = 0;
    $$('.ct-calc', $live('cpCalcGrid')).forEach(el=>{ const ok = !q || el.textContent.toLowerCase().includes(q); el.style.display = ok ? '' : 'none'; if(ok) calcs++; });
    $$('.ct-tip', $live('cpArticleList')).forEach(el=>{
      const t = CP_TIPS.find(x=> x.id===el.dataset.tip);
      const hay = (t.title+' '+t.short+' '+t.body.join(' ')).replace(/<[^>]+>/g,' ').toLowerCase();
      const ok = (cpTipCat==='all' || el.dataset.cat===cpTipCat) && (!q || hay.includes(q));
      el.style.display = ok ? '' : 'none'; if(ok) tips++;
    });
    $live('cpTipCount').textContent = tips+' tip'+(tips===1?'':'s');
    $live('cpArticleList').style.display = tips ? '' : 'none';
    $live('cpToolsEmpty').style.display = (!calcs && !tips) || (!tips && cpTipCat!=='all') ? '' : 'none';
    $live('cpToolsEmpty').textContent = !tips && cpTipCat!=='all' && !q ? 'No tips in this category yet.' : 'Nothing matches your search.';
    $live('cpTipOfDay').style.display = q ? 'none' : '';
  }
  $live('cpToolsSearch').addEventListener('input', cpToolsFilter);
  $live('customerToolsScreen').addEventListener('click', (e)=>{
    const c = e.target.closest('[data-calc]'); if(c){ cpOpenCalc(c.dataset.calc); return; }
    const t = e.target.closest('[data-tip]'); if(t){ cpOpenArticle(t.dataset.tip); return; }
    const ch = e.target.closest('[data-cat]');
    if(ch && ch.classList.contains('ct-chip')){
      cpTipCat = ch.dataset.cat;
      $$('.ct-chip', $live('cpTipChips')).forEach(b=> b.classList.toggle('on', b===ch));
      cpToolsFilter(); return;
    }
    if(e.target.closest('[data-help]')) cpOpenCentralChat();
  });

  function cpShowCalcScreen(){
    $live('customerToolsScreen').style.display = 'none';
    $live('customerCalcScreen').style.display = '';
    if(typeof cpSetNavActive === 'function') cpSetNavActive('Tools');
    window.scrollTo({top:0});
  }
  $live('cpCalcBackBtn').addEventListener('click', ()=>{
    $live('customerCalcScreen').style.display = 'none';
    $live('customerToolsScreen').style.display = '';
    window.scrollTo({top:0});
  });

  function cpOpenArticle(id){
    const t = CP_TIPS.find(x=> x.id===id);
    if(!t) return;
    const cat = (CP_TIP_CATS.find(c=> c[0]===t.cat)||[])[1] || '';
    $live('cpCalcTitle').textContent = t.title;
    const more = CP_TIPS.filter(x=> x.cat===t.cat && x.id!==t.id).slice(0,3);
    $live('cpCalcBody').oninput = null; $live('cpCalcBody').onchange = null;
    $live('cpCalcBody').innerHTML =
      '<div class="ct-card ct-article">'+
        '<span class="ct-badge ct-cat-'+t.cat+'">'+(CP_ICON[CP_TIP_ICON[t.cat]]||'')+escapeHtml(cat)+'</span>'+
        '<p class="ct-lead">'+escapeHtml(t.short)+'</p>'+
        t.body.map(b=> b.trim().startsWith('<ul') ? b : '<p>'+b+'</p>').join('')+
        '<p class="ct-fine">General guidance for typical units — your unit\u2019s manual may say otherwise for your model. When in doubt, ask us.</p>'+
      '</div>'+
      (more.length ? '<div class="ct-sec"><h2>More on '+escapeHtml(cat.toLowerCase())+'</h2></div><div class="ct-card ct-list">'+more.map(x=>
        '<button type="button" class="ct-tip" data-tip="'+x.id+'"><span class="ct-text"><span class="ct-tip-t">'+escapeHtml(x.title)+'</span><span class="ct-tip-d">'+escapeHtml(x.short)+'</span></span><span class="ct-chev">›</span></button>').join('')+'</div>' : '')+
      '<button type="button" class="ct-cta" data-cta="1">'+(t.cat==='fire' ? 'Ask about fire protection' : 'Request a visit')+'</button>';
    $live('cpCalcBody').onclick = (e)=>{
      const x = e.target.closest('[data-tip]'); if(x){ cpOpenArticle(x.dataset.tip); return; }
      if(e.target.closest('[data-cta]')) cpOpenNewRequest({ description: t.cat==='fire' ? 'Inquiry: fire protection (AFSS / FDAS) service' : '' });
    };
    cpShowCalcScreen();
  }

  // ---------- Profile screen ----------
  function renderCustomerProfileScreen(){
    const name = (currentUser && currentUser.name) || 'there';
    $('cpProfileAvatar').textContent = name.trim().charAt(0).toUpperCase() || '?';
    $('cpProfileName').textContent = name;
    $('cpProfileSub').textContent = (cpCustomer && cpCustomer.name) ? cpCustomer.name : '';
    const field = $('cpProfileSwitcherField');
    const sel = $('cpProfileSwitcher');
    const list = (currentUser && currentUser.customerList) || [];
    if(list.length > 1){
      field.style.display = '';
      sel.innerHTML = list.map(c=> '<option value="'+c.id+'" '+(String(c.id)===String(currentUser.customerId)?'selected':'')+'>'+escapeHtml(c.name)+'</option>').join('');
      sel.onchange = (e)=> cpSwitchActiveCustomer(e.target.value);
    } else {
      field.style.display = 'none';
    }

    // Personal/account information card — currentUser carries the login
    // identity (name + auth email, see auth.js), cpCustomer is the raw
    // `customers` row (select('*')) already loaded by
    // loadCustomerPortalData for the property currently being viewed, so
    // switching accounts via the switcher above also updates these fields.
    // No self-serve editing here (read-only login) — anything missing
    // shows "Not on file" rather than being hidden, as a cue to contact
    // the service provider to have it added.
    const na = 'Not on file';
    $('cpInfoName').textContent = name;
    $('cpInfoEmail').textContent = (currentUser && currentUser.email) || na;
    $('cpInfoContactPerson').textContent = (cpCustomer && cpCustomer.contact_person) || na;
    $('cpInfoContactNo').textContent = (cpCustomer && cpCustomer.contact_no) || na;
    $('cpInfoAddress').textContent = (cpCustomer && cpCustomer.address) || na;
  }
  $('cpProfileRowRequests').addEventListener('click', ()=> cpShowScreen('Requests'));
  $('cpProfileRowTerms').addEventListener('click', ()=> cpShowLegalScreen('terms'));
  $('cpProfileRowPrivacy').addEventListener('click', ()=> cpShowLegalScreen('privacy'));
  $('cpProfileRowLogout').addEventListener('click', ()=>{ if(typeof doLogout==='function') doLogout(); });

  // ---------- Terms and Conditions / Privacy Notice ----------
  // Static, generated copy describing what the customer portal itself
  // actually does (equipment records, service history, service requests
  // and their message threads, account credentials) — not a generic
  // boilerplate template. Content lives here as data so it's one place to
  // update if the portal's scope changes; nothing here is fetched or
  // user-editable.
  const CP_LEGAL_UPDATED = 'Last updated September 2026';
  const CP_LEGAL = {
    terms: {
      title: 'Terms and Conditions',
      body: [
        ['Purpose of this portal',
         'This Customer Portal is provided by your HVAC and fire protection service provider so you can review your enrolled equipment, service history, and service reports, and submit and track service requests for your property.'],
        ['Your account',
         'Portal logins are issued by your service provider and linked to one or more of your properties. Keep your email and password confidential — you are responsible for activity under your login. Contact your service provider if you suspect unauthorized access.'],
        ['Service requests',
         'Submitting a request through this portal is a request for service, not a confirmed appointment. Scheduling, fees, and completion are coordinated through the request\u2019s message thread and confirmed by your service provider.'],
        ['Accuracy of information',
         'Equipment records, service history, and account details shown here are maintained by your service provider based on completed service visits and account setup. If something looks incorrect or out of date, let your service provider know so it can be corrected.'],
        ['Availability',
         'The portal is offered as a convenience and may be occasionally unavailable for maintenance or connectivity reasons. It is not a substitute for calling your service provider directly in an urgent situation.'],
        ['Changes to these terms',
         'These terms may be updated from time to time as the portal\u2019s features change. Continued use of the portal after an update means you accept the revised terms.']
      ]
    },
    privacy: {
      title: 'Privacy Notice',
      body: [
        ['Information we hold',
         'Your service provider maintains your contact information (name, email, contact number, and property address), your enrolled equipment records, service reports and history, and any service requests and messages you submit through this portal.'],
        ['How it\u2019s used',
         'This information is used to schedule and carry out HVAC and fire protection service at your property, to respond to your service requests, to keep an accurate maintenance history for your equipment, and to contact you about visits, quotes, and account matters.'],
        ['Who can see it',
         'Your account and property information is visible only to your own portal login and to your service provider\u2019s admin and technician staff who work on your account. It is not sold or shared with unrelated third parties.'],
        ['Photos and service records',
         'Photos, findings, and notes attached to a service visit or a service request are kept as part of your equipment\u2019s maintenance record and are visible to you in this portal and to your service provider\u2019s staff.'],
        ['Data retention',
         'Your records are retained for as long as you remain an active customer of your service provider, and as needed afterward for warranty, maintenance-history, and legal/record-keeping purposes.'],
        ['Your choices',
         'You can ask your service provider to review, correct, or remove your account information at any time; some information (such as completed service history) may need to be retained as part of the equipment\u2019s maintenance record even after a request is honored.']
      ]
    }
  };
  function cpShowLegalScreen(type){
    const doc = CP_LEGAL[type] || CP_LEGAL.terms;
    $('cpLegalTitle').textContent = doc.title;
    $('cpLegalUpdated').textContent = CP_LEGAL_UPDATED;
    $('cpLegalBody').innerHTML = doc.body.map(function(section){
      return '<h3>'+escapeHtml(section[0])+'</h3><p>'+escapeHtml(section[1])+'</p>';
    }).join('');
    $('customerProfileScreen').style.display = 'none';
    $('customerLegalScreen').style.display = '';
    window.scrollTo({top:0});
  }
  $('cpLegalBackBtn').addEventListener('click', ()=>{
    $('customerLegalScreen').style.display = 'none';
    $('customerProfileScreen').style.display = '';
    if(typeof cpSetNavActive === 'function') cpSetNavActive('Profile');
    window.scrollTo({top:0});
  });

  // ---------- Wire the pieces the old sidebar used to own ----------
  $('cpRequestServiceBtn').addEventListener('click', ()=> cpOpenNewRequest());
  // Report a problem: the same request form, preset to Urgent with a short
  // note on top — it lands in admin's urgent tier after 60 min unanswered.
  $('cpReportProblemBtn').addEventListener('click', ()=> cpOpenNewRequest({ urgent:true, focus:true }));
  $('cpMessageUsBtn').addEventListener('click', ()=> cpOpenCentralChat());
  $('cpProfileRowHistory').addEventListener('click', ()=>{ cpShowScreen('History'); cpSetNavActive('Profile'); });
  $('cpUnitsViewAllLink').addEventListener('click', (e)=>{ e.preventDefault(); cpShowScreen('Units'); });
  cpInitNav();

  // ---------- Pull-to-refresh ----------
  // overscroll-behavior:none in app.css deliberately kills the native
  // bounce (and, on Android Chrome, the native pull-to-refresh that rides
  // on top of it — see that CSS rule's own comment for why it's disabled
  // app-wide). This is the hand-rolled replacement: drag down from the
  // very top of a screen that's opted in, and this reproduces the same
  // gesture — indicator + a bit of content travel — without bringing the
  // rubber-band jitter back everywhere else. Generic so any screen can opt
  // in later with one call; only Home does for now.
  function attachPullToRefresh(screenId, onRefresh){
    const THRESHOLD = 56;   // px of drag before a release triggers a refresh
    const MAX_PULL = 90;    // px cap on how far the screen visually travels
    const SETTLE_PULL = 48; // px the screen holds at while the refresh runs
    const indicator = $('ptrIndicator');
    if(!indicator) return;
    let startY = null, dragging = false, moved = false, refreshing = false, lastPull = 0;

    function screenEl(){ return $(screenId); }
    function isEligible(){
      const el = screenEl();
      return el && el.style.display !== 'none' && !refreshing;
    }
    function atTop(){
      return (window.scrollY || document.documentElement.scrollTop || 0) <= 0;
    }
    function setPull(px){
      lastPull = px;
      const el = screenEl();
      if(el) el.style.transform = px ? 'translateY('+px+'px)' : '';
      const ratio = Math.min(1, px / THRESHOLD);
      indicator.style.opacity = String(ratio);
      indicator.style.transform = 'translate(-50%,'+(-46 + ratio*56)+'px) rotate('+(ratio*180)+'deg)';
    }
    function setAnimated(on){
      const el = screenEl();
      if(el) el.style.transition = on ? 'transform .22s ease' : '';
      indicator.classList.toggle('ptr-animating', on);
    }

    window.addEventListener('touchstart', (e)=>{
      if(!isEligible() || !atTop() || e.touches.length !== 1) return;
      startY = e.touches[0].clientY;
      dragging = true; moved = false;
    }, {passive:true});

    window.addEventListener('touchmove', (e)=>{
      if(!dragging || startY == null) return;
      const dy = e.touches[0].clientY - startY;
      if(dy <= 0 || !atTop()){ dragging = false; if(moved){ setAnimated(true); setPull(0); moved=false; } return; }
      moved = true;
      setAnimated(false);
      setPull(Math.min(MAX_PULL, dy * 0.5));
      e.preventDefault();
    }, {passive:false});

    window.addEventListener('touchend', ()=>{
      if(!dragging){ return; }
      dragging = false; startY = null;
      if(!moved) return;
      moved = false;
      if(lastPull >= THRESHOLD){
        refreshing = true;
        indicator.classList.add('ptr-refreshing');
        setAnimated(true);
        setPull(SETTLE_PULL);
        const started = Date.now();
        Promise.resolve(onRefresh()).catch(()=>{}).then(()=>{
          // Hold the spinner for a minimum stretch even if the reload was
          // instant (e.g. served from a warm cache) — releasing the instant
          // the promise resolves would read as a flicker, not a refresh.
          const wait = Math.max(0, 400 - (Date.now() - started));
          setTimeout(()=>{
            setAnimated(true);
            setPull(0);
            indicator.classList.remove('ptr-refreshing');
            setTimeout(()=>{ setAnimated(false); refreshing = false; }, 240);
          }, wait);
        });
      } else {
        setAnimated(true);
        setPull(0);
        setTimeout(()=> setAnimated(false), 240);
      }
    }, {passive:true});
  }
  attachPullToRefresh('customerHomeScreen', initCustomerHomeScreen);
  // Account picker (see showCustomerAccountPicker() above) refetches this
  // login's customer list rather than just re-rendering the cards already
  // in currentUser.customerList — the point of a refresh here is to pick
  // up an account that was just linked/unlinked server-side, not to
  // redraw what's already in memory.
  async function cpRefreshAccountPicker(){
    if(!currentUser || !currentUser.id) return;
    const list = await fetchCustomerLinks(currentUser.id);
    if(list && list.length) currentUser.customerList = list;
    cpRenderAccountPickerCards();
  }
  attachPullToRefresh('customerAccountPickerScreen', cpRefreshAccountPicker);
