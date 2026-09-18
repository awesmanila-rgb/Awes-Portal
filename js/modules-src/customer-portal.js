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

  async function loadCustomerPortalData(customerId){
    cpCustomer = null; cpEquipment = []; cpReports = [];
    if(!customerId) return;
    if(!(await ensureCloud())) return;
    try{
      const { data: custRow, error: custErr } = await db.from('customers')
        .select('*').eq('id', customerId).maybeSingle();
      if(custErr) throw custErr;
      cpCustomer = custRow || null;
    }catch(e){ console.error('load customer record failed', describeCloudError(e)); }

    try{
      const { data, error } = await db.from('customer_equipment')
        .select('*').eq('customer_id', customerId).order('id');
      if(error) throw error;
      cpEquipment = (data||[]).map(row => ({
        id: row.id, equipType: row.equip_type, equipLocation: row.equip_location,
        brand: row.brand, mountType: row.mount_type, coolCap: row.cool_cap,
        modelCU: row.model_cu, serialCU: row.serial_cu, modelFCU: row.model_fcu, serialFCU: row.serial_fcu,
        nextPmDate: row.next_pm_date || '',
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
      cpEquipment.forEach(eq=> eq.photoCount = photoCounts[eq.id] || 0);
    }catch(e){ console.error('load customer equipment failed', describeCloudError(e)); }

    if(cpCustomer){
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
          .select('id, sr_no, date, cust_name, equipment_id, equip_type, equip_location, model_cu, serial_cu, model_fcu, serial_fcu, trouble_call, remarks, completed, technician_name, findings, recommendations, materials, services_done')
          .eq('customer_id', cpCustomer.id)
          .order('date', { ascending:false });
        if(error) throw error;
        cpReports = data || [];
      }catch(e){ console.error('load customer reports failed', describeCloudError(e)); }
    }

    // Attach each equipment's full matching report history, for the
    // "Last serviced" date and the equipment detail screen (status itself
    // is now computed from next_pm_date, not report history — see
    // computeEquipmentStatus below). Matching logic lives in
    // matchReportHistoryForEquipment() (core.js) — shared with the admin
    // equipment detail overlay's own history section.
    cpEquipment.forEach(eq => {
      eq.reportHistory = matchReportHistoryForEquipment(cpReports, eq);
      eq.lastReport = eq.reportHistory[0] || null;
      eq.status = computeEquipmentStatus(eq);
    });
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
    const cornerLabel = eq.status.key==='overdue' ? 'NEEDS ATTENTION' : eq.status.key==='due-soon' ? 'DUE SOON' : eq.status.key==='scheduled' ? 'SCHEDULED' : 'OPERATING WELL';
    const footLabel = eq.status.key==='overdue' ? 'Needs attention' : eq.status.key==='due-soon' ? 'Filter check needed' : eq.status.key==='scheduled' ? 'Visit scheduled' : 'Good health';
    const specLine = [eq.brand, eq.equipType, eq.coolCap].filter(Boolean).map(escapeHtml).join(' · ') || escapeHtml(eq.equipLocation||'—');
    const lastLine = eq.lastReport ? 'Last service '+escapeHtml(fmtDate(eq.lastReport.date)) : 'No service on record yet';
    const photoUrl = photoMap && photoMap[eq.id];
    return (
      '<div class="cp-unit-card '+stateClass+'" data-equip-id="'+eq.id+'">'+
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

  // ---------- Home hero (state engine) ----------
  // One hero card, one of six looks depending on what's true right now,
  // in this priority order (highest first): a technician-flagged issue
  // (D2/D3) > an overdue unit with no request open yet (D1) > active
  // on-site work (C) > a confirmed upcoming visit (B) > nothing pending (A).
  // Many units + many flagged issues collapses to a summary card instead of
  // picking just one. `rows` is this customer's service_requests (may be
  // empty on the very first paint, before cpRefreshRequestsBadge's fetch
  // resolves — the hero just reflects equipment status alone until then,
  // then re-renders with the fuller picture a moment later).
  function cpEquipLabel(eq){ return eq ? escapeHtml(equipDisplayName(eq)) : 'your unit'; }

  function cpHeroAllClear(){
    // Matches the reference mock: icon + heading + subtext + the primary
    // CTA all live inside this one card now, instead of the CTA sitting in
    // a separate "Need service for another unit?" banner below — see
    // renderCustomerHero()'s cpBookingBanner toggle, which hides that
    // separate banner specifically for this state so the CTA isn't
    // duplicated on screen.
    return (
      '<div class="cp-hero-allclear">'+
        '<div class="ic">'+CP_ICON.card+'</div>'+
        '<p class="cp-hero-name">No active service right now</p>'+
        '<p class="cp-hero-sub">Your AC units are being monitored. When you need help, you can book a service in just a few taps.</p>'+
        '<button type="button" class="cp-hero-btn primary" data-action="requestService">'+CP_ICON.plus+' Book a service</button>'+
      '</div>'
    );
  }
  // Deterministic small color per technician so the same person's avatar
  // is always the same color across renders (not random each time).
  const CP_AVATAR_COLORS = ['#154D34','#1F6F7A','#B9791F','#6B4FA0','#2A6FDB'];
  function cpAvatarColor(name){
    let h = 0; for(let i=0;i<name.length;i++) h = (h*31 + name.charCodeAt(i)) >>> 0;
    return CP_AVATAR_COLORS[h % CP_AVATAR_COLORS.length];
  }
  function cpTechAvatarsHtml(names){
    if(!names || !names.length) return '';
    const shown = names.slice(0,2);
    const extra = names.length - shown.length;
    return '<div class="cp-hero-techs">' +
      shown.map(n=> '<div class="cp-hero-tech-avatar" style="background:'+cpAvatarColor(n)+'" title="'+escapeHtml(n)+'">'+escapeHtml((n||'?').trim().charAt(0).toUpperCase())+'</div>').join('') +
      (extra>0 ? '<div class="cp-hero-tech-avatar" style="background:var(--text-muted)">+'+extra+'</div>' : '') +
      '</div>';
  }
  // Three-stage dot/segment tracker for the Active hero — Received / En
  // route / In progress (this is what .cp-hero-track/.cp-hero-labels in
  // app.css are actually styled for). Completed ends the active-service
  // hero entirely (renderCustomerHero stops treating the request as
  // "active" once status is completed), so this never needs a 4th stage.
  // The plain bar tracker in service-requests.js's srProgressStepsHtml is
  // a separate, simpler version used in the admin/customer detail
  // overlay, which isn't built to this visual theme.
  // A service the crew is actively working through, in the order the
  // customer sees it. 'dispatched' is the pre-lifecycle name for
  // 'preparing' and is accepted on every READ path so rows written before
  // the migration still register as active; nothing writes it any more.
  // 'completed' is NOT here — the work is done, it is waiting on admin's
  // close, and the card should stop presenting it as in-flight.
  function cpIsActiveStatus(status){
    return ['preparing','dispatched','en_route','in_progress'].includes(status);
  }

  function cpHeroTrackHtml(status){
    // Five stages now, matching the technician's tracker and the job order
    // help card word for word — a customer on the phone to the crew hears
    // the same status they can see.
    const steps = ['preparing','en_route','in_progress','completed','closed'];
    const labels = ['Preparing','En route','Work in progress','Completed','Closed'];
    // Legacy rows carry the pre-lifecycle name for the first stage.
    if(status==='dispatched') status = 'preparing';
    // A confirmed schedule shows the same track with nothing lit yet: the
    // visit is booked but the day hasn't come. -1 leaves every dot dim.
    const idx = status==='schedule_confirmed' ? -1 : steps.indexOf(status);
    if(idx < -1 || (idx===-1 && status!=='schedule_confirmed')) return '';
    let dots = '';
    steps.forEach((s,i)=>{
      dots += '<i class="pt'+(i<idx?' on':i===idx?' now':'')+'"></i>';
      if(i<steps.length-1) dots += '<i class="seg'+(i<idx?' on':'')+'"></i>';
    });
    const labelsHtml = labels.map((l,i)=> '<span'+(i===idx?' class="cur"':'')+'>'+l+'</span>').join('');
    return '<div class="cp-hero-track">'+dots+'</div><div class="cp-hero-labels">'+labelsHtml+'</div>';
  }
  // ONE card for the whole life of a service, rather than a separate
  // "Scheduled" card that vanished and was replaced by a different card on
  // the day. A confirmed-but-not-yet-started visit renders here too, with
  // the tracker sitting before step 1 — so the customer watches a single
  // card fill in rather than cards swapping underneath them.
  function cpHeroActive(req, eq, techNames){
    const notStarted = req.status === 'schedule_confirmed';
    const finished = req.status === 'completed';
    const label = notStarted ? 'Scheduled' : srStatusLabel(req.status);
    // 'on the way' is wrong in both directions — before the day, and after
    // the work is done and only admin's sign-off is outstanding.
    const techLine = notStarted
      ? 'Your technician will be assigned on the day'
      : (finished
          ? 'Work finished — being reviewed before sign-off'
          : (techNames && techNames.length
              ? (techNames.length===1 ? techNames[0]+' is on the way' : techNames.length+' technicians assigned')
              : 'A technician is on the way'));
    // Scheduled date/time this visit was actually dispatched for — the
    // confirmed proposed schedule normally, falling back to the original
    // requested date on the off chance a request reached 'dispatched'
    // without one ever being proposed.
    const schedDate = req.proposedScheduleDate || req.requestedDate;
    const scheduleLine = schedDate
      ? fmtDate(schedDate) + (req.proposedScheduleTime ? ' · '+escapeHtml(req.proposedScheduleTime) : '')
      : '';
    return (
      '<div data-req-id="'+req.id+'">'+
        '<div class="cp-hero-head">'+
          '<div>'+
            '<p class="cp-hero-eyebrow '+(notStarted?'teal':(finished?'teal':'amber'))+'">'+
              (notStarted?'Upcoming service':(finished?'Service complete':'Active service'))+' · '+escapeHtml(label)+'</p>'+
            '<p class="cp-hero-name">'+cpEquipLabel(eq)+'</p>'+
            '<p class="cp-hero-sub">'+escapeHtml(req.description||'Technician assigned')+'</p>'+
            (scheduleLine ? '<p class="cp-hero-sub cp-hero-schedule">'+CP_ICON.calendar+' '+scheduleLine+'</p>' : '')+
          '</div>'+
        '</div>'+
        (!notStarted && techNames && techNames.length ? cpTechAvatarsHtml(techNames) : '')+
        cpHeroTrackHtml(req.status)+
        '<div class="cp-hero-foot">'+
          '<span class="loc">'+CP_ICON.pin+' '+escapeHtml(techLine)+'</span>'+
          '<a data-action="message">'+CP_ICON.chat+' Message</a>'+
        '</div>'+
      '</div>'
    );
  }
  function cpHeroDanger(kind, req, eq){
    // kind: 'overdue' (D1, no request open yet) | 'pending' (D2) | 'ready' (D3)
    const cfg = {
      overdue:{ title:'Overdue for service', sub:cpEquipLabel(eq)+' — overdue for preventive maintenance.', cta:'Book service now' },
      pending:{ title:'Issue flagged during last visit', sub:(req&&req.flaggedIssueSummary) || (req&&req.description) || 'A technician noted an issue on '+cpEquipLabel(eq)+'.', cta:null },
      ready:{ title:'Quotation ready for review', sub:'A quote is ready for '+cpEquipLabel(eq)+'.', cta:'Review quotation' }
    }[kind];
    return (
      '<div data-req-id="'+(req?req.id:'')+'" data-equip-id="'+(eq?eq.id:'')+'" data-kind="'+kind+'">'+
        '<div class="cp-hero-danger-body">'+
          '<div class="ic">'+CP_ICON.alert+'</div>'+
          '<div><p class="cp-hero-eyebrow danger">Needs attention</p><p class="cp-hero-name">'+cfg.title+'</p>'+
          '<p class="cp-hero-sub">'+escapeHtml(cfg.sub)+'</p></div>'+
        '</div>'+
        (cfg.cta
          ? '<div class="cp-hero-danger-cta"><button type="button" class="cp-hero-btn danger" data-action="'+kind+'">'+cfg.cta+'</button></div>'
          : '<div class="cp-hero-muted-note">We\'ll notify you as soon as a quotation is ready.</div>')+
      '</div>'
    );
  }
  function cpHeroSummary(count, kind){
    // Many units flagged at once (property-management scale case) — link
    // out to Units (filtered mentally by the person, no separate filtered
    // view built yet) rather than trying to pick just one to feature.
    const label = kind==='danger' ? count+' units need attention' : count+' units in service today';
    const eyebrowClass = kind==='danger' ? 'danger' : 'amber';
    return (
      '<div data-action="viewUnits">'+
        '<div class="cp-hero-danger-body">'+
          '<div class="ic">'+CP_ICON.alert+'</div>'+
          '<div><p class="cp-hero-eyebrow '+eyebrowClass+'">Across your units</p><p class="cp-hero-name">'+label+'</p>'+
          '<p class="cp-hero-sub">Tap to see which units and what\'s needed.</p></div>'+
        '</div>'+
      '</div>'
    );
  }

  function cpFindEquip(id){ return cpEquipment.find(e=> String(e.id)===String(id)); }

  async function renderCustomerHero(rows){
    const hero = $('cpHero');
    if(!hero) return;
    rows = rows || [];

    const flagged = rows.filter(r=> r.origin==='technician_flag' && !['completed','closed','cancelled','preparing','dispatched','en_route','in_progress'].includes(r.status));
    // Includes 'completed' deliberately, which cpIsActiveStatus does NOT:
    // work is finished but admin hasn't closed the job order yet, and the
    // card disappearing in that gap told the customer their service had
    // stopped existing. cpIsActiveStatus still means "crew is working on
    // it" for cancellation and the list badge, which is a different
    // question — a finished service can't be cancelled.
    const active = rows.filter(r=> cpIsActiveStatus(r.status) || r.status==='completed');
    const overdueNoRequest = cpEquipment.filter(eq=>{
      if(eq.status.key!=='overdue') return false;
      return !rows.some(r=> String(r.equipmentId)===String(eq.id) && r.status!=='completed' && r.status!=='cancelled');
    });
    const scheduled = rows.filter(r=> r.status==='schedule_confirmed');

    let html, danger = false, isAllClear = false;
    if(flagged.length > 1 || overdueNoRequest.length + flagged.length > 1){
      // More than one thing needs attention at once — summarize rather
      // than arbitrarily feature one unit over another.
      html = cpHeroSummary(flagged.length + overdueNoRequest.length, 'danger'); danger = true;
    } else if(flagged.length === 1){
      const req = flagged[0];
      const ready = req.feeStatus === 'proposed';
      html = cpHeroDanger(ready ? 'ready' : 'pending', req, cpFindEquip(req.equipmentId)); danger = true;
    } else if(overdueNoRequest.length === 1){
      html = cpHeroDanger('overdue', null, overdueNoRequest[0]); danger = true;
    } else if(active.length > 0 || scheduled.length > 0){
      // Scheduled and in-flight share ONE card. An in-flight service wins
      // if somehow both exist, since it's the one actually happening.
      const subject = active.length > 0 ? active[0] : scheduled[0];
      // Technician names live on the linked dispatch ticket, not the
      // request row itself — a separate fetch, so the hero shows without
      // them for a moment on first paint, then fills in.
      const techNames = (subject.linkedDispatchTicketId && typeof dtFetchTicketTechNames==='function')
        ? await dtFetchTicketTechNames(subject.linkedDispatchTicketId) : [];
      html = cpHeroActive(subject, cpFindEquip(subject.equipmentId), techNames);
    } else {
      html = cpHeroAllClear(); isAllClear = true;
    }

    hero.className = 'cp-hero' + (danger ? ' cp-hero-danger' : '');
    hero.innerHTML = html;
    // The all-clear card now carries its own "Book a service" CTA (see
    // cpHeroAllClear()), so the separate banner would just be a duplicate
    // button sitting right underneath it — hide it for this state only.
    if($('cpBookingBanner')) $('cpBookingBanner').style.display = isAllClear ? 'none' : '';
    hero.onclick = (e)=>{
      const actionEl = e.target.closest('[data-action]');
      const action = actionEl ? actionEl.dataset.action : null;
      if(action==='requestService'){ if(typeof cpShowRequestsScreen === 'function') cpShowRequestsScreen(); return; }
      if(action==='overdue'){ const eq = overdueNoRequest[0]; if(eq) cpRequestServiceForEquip(eq); return; }
      if(action==='ready'){ if(flagged[0] && typeof srOpenDetail==='function') srOpenDetail(flagged[0]); return; }
      // Both actions now resolve against whichever request the single card
      // is showing — active if there is one, otherwise the scheduled one.
      const heroSubject = active[0] || scheduled[0];
      if(action==='message' || action==='reschedule'){
        if(heroSubject && typeof srOpenDetail==='function') srOpenDetail(heroSubject);
        return;
      }
      if(action==='viewUnits'){ cpShowScreen('Units'); return; }
      // Tap anywhere else on the card: open whichever single job it
      // represents, if any (all-clear has nothing to open).
      if(active[0] && typeof srOpenDetail==='function') srOpenDetail(active[0]);
      else if(scheduled[0] && typeof srOpenDetail==='function') srOpenDetail(scheduled[0]);
      else if(flagged[0] && typeof srOpenDetail==='function') srOpenDetail(flagged[0]);
    };
  }

  // Time-of-day greeting for the home header — see AWES_App_enroute
  // redesign spec's "Welcome section" ("Good afternoon, Ms. Jhen").
  // Local device time; no timezone handling needed since this is a
  // customer's own portal on their own device.
  function cpTimeGreeting(){
    const h = new Date().getHours();
    if(h < 12) return 'Good morning';
    if(h < 18) return 'Good afternoon';
    return 'Good evening';
  }
  function cpSetGreetingName(){
    if($('cpGreetTod')) $('cpGreetTod').textContent = cpTimeGreeting();
    $('cpGreetingName').textContent = currentUser.name || 'there';
  }

  function renderCustomerHome(){
    // Header
    $('cpGreetSub').textContent = cpEquipment.length
      ? cpEquipment.length+' unit'+(cpEquipment.length===1?'':'s')+' enrolled'
      : 'No units enrolled yet';
    const initials = (currentUser && currentUser.name ? currentUser.name.trim().charAt(0) : '?').toUpperCase();
    if($('cpAvatarBtn')) $('cpAvatarBtn').textContent = initials;

    // Hero — initial pass off equipment status alone; cpRefreshRequestsBadge
    // (fired below) re-renders it a moment later with request data too.
    renderCustomerHero(cpMyRequestsCache);

    // Unit stack — most-attention-needed first, capped at 3 on Home with a
    // "Manage units" link into the full Units screen (see
    // cpUnitsSectionTitle below for the many-units retitle). Cover photos
    // are fetched in one batch and swapped in once they arrive — the
    // stack renders immediately with icon fallbacks so photos loading
    // slowly never blocks the rest of the screen.
    const sorted = cpEquipment.slice().sort((a,b)=>{
      const rank = { overdue:0, 'due-soon':1, scheduled:2, none:3 };
      return (rank[a.status.key]??3) - (rank[b.status.key]??3);
    });
    const shown = sorted.slice(0,3);
    const flaggedCount = cpEquipment.filter(e=> e.status.key==='overdue' || e.status.key==='due-soon').length;
    $('cpUnitsSectionTitle').textContent = flaggedCount>1 ? 'Units needing attention' : 'Your units';
    function paintUnitStack(photoMap){
      $('cpUnitScroll').innerHTML = shown.length
        ? shown.map(eq=> cpUnitCardHtml(eq, photoMap)).join('')
        : '<div class="empty-state">No equipment enrolled yet.</div>';
      $$('.cp-unit-card', $('cpUnitScroll')).forEach(card=>{
        card.onclick = ()=>{ const eq = cpFindEquip(card.dataset.equipId); if(eq) openCustomerEquipmentDetail(eq); };
      });
    }
    paintUnitStack(typeof cpCachedCoverPhotoMap==='function' ? cpCachedCoverPhotoMap(shown.map(eq=>eq.id)) : {});
    if(shown.length && typeof cpFetchCoverPhotoMap === 'function'){
      const beforeMap = typeof cpCachedCoverPhotoMap==='function' ? cpCachedCoverPhotoMap(shown.map(eq=>eq.id)) : {};
      cpFetchCoverPhotoMap(shown.map(eq=>eq.id)).then(photoMap=>{
        // Skip the repaint (and the fresh <img> nodes it would create)
        // when the fetch resolved to exactly what was already on screen
        // — e.g. every routine 30s poll once photos are cached.
        if(JSON.stringify(photoMap)!==JSON.stringify(beforeMap)) paintUnitStack(photoMap);
      });
    }

    // Quick actions — four real destinations only; nothing here is
    // fabricated (no separate "Invoices" tile, since there's no invoicing
    // feature distinct from the fee already shown on a request/billing
    // card — see cpQuickQuotes below).
    // Icon + single label only (no subtitle) — matches the reference
    // screenshot's icon-grid format (centered icon, label below, no
    // secondary line). The live counts these subtitles used to show
    // ("3 enrolled", "2 on file") are still visible one tap away, inside
    // each tile's own destination screen — nothing is lost, just moved
    // off the tile itself to match the requested look.
    $('cpQuickUnits').innerHTML = ''+CP_ICON.grid+'<p class="t">My units</p>';
    $('cpQuickUnits').onclick = ()=> cpShowScreen('Units');
    $('cpQuickQuotes').innerHTML = ''+CP_ICON.receipt+'<p class="t">Quotes and invoices</p>';
    $('cpQuickQuotes').onclick = ()=> cpShowScreen('History', 'Quotations');
    $('cpQuickHistory').innerHTML = ''+CP_ICON.history+'<p class="t">Service history</p>';
    $('cpQuickHistory').onclick = ()=> cpShowScreen('History', 'Visits');
    $('cpQuickHelp').innerHTML = ''+CP_ICON.chat+'<p class="t">Get help</p>';
    // No standalone support inbox exists yet (see the chat-model note on
    // cpNotifBell) — "Get help" opens the same request form as "Book a
    // service" so a person can describe their situation either way,
    // rather than promising a contact channel that isn't built.
    $('cpQuickHelp').onclick = ()=>{ if(typeof cpShowRequestsScreen === 'function') cpShowRequestsScreen(); };
    $('cpQuickTools').innerHTML = ''+CP_ICON.tools+'<p class="t">Calculators</p>';
    $('cpQuickTools').onclick = ()=> cpShowScreen('Tools');

    // Accounts — a fifth tile, always shown for any logged-in customer
    // (previously hidden below 2 linked customers, same condition
    // cpRenderSwitcher uses for its own dropdown — but that "nothing to
    // switch to" reasoning doesn't hold here: the destination screen also
    // carries the "contact Admin to add an account" note, so even a
    // single-account login has somewhere useful to land). Jumps to the
    // same picker screen shown at every customer sign-in rather than
    // duplicating its logic in a second place; the badge shows the
    // linked-account count (1 when there's just the one), which is
    // useful context in itself, not just a "something's new" flag like
    // this app's other badges.
    const cpAccountsTile = $('cpQuickAccounts');
    if(cpAccountsTile){
      const acctList = currentUser.customerList || [];
      if(acctList.length){
        cpAccountsTile.style.display = '';
        cpAccountsTile.innerHTML = ''+CP_ICON.swap+'<span class="cp-quick-badge">'+acctList.length+'</span><p class="t">Switch account</p>';
        cpAccountsTile.onclick = ()=>{
          if(typeof showCustomerAccountPicker === 'function') showCustomerAccountPicker();
        };
      } else {
        cpAccountsTile.style.display = 'none';
      }
    }

    // Request Status — beside the hero, in the top-grid's second slot
    // (shares it with #cpBookingBanner; only one of the two shows at a
    // time). Generalizes the old fee-only billing card: surfaces whatever
    // is actually awaiting the CUSTOMER'S review right now — a proposed
    // fee or a proposed schedule — not just a fee. Deliberately narrower
    // than "any active request" (dispatched/en_route/in_progress already
    // has its own full treatment in the hero itself; nothing extra for
    // the customer to review there). Only ever a real request's own
    // numbers — never fabricated.
    const needsReview = cpMyRequestsCache.find(r=>
      (r.status==='fee_proposed' && r.feeStatus==='proposed') || r.status==='schedule_proposed'
    );
    const statusCard = $('cpRequestStatusCard');
    if(statusCard){
      if(needsReview){
        const isFee = needsReview.status==='fee_proposed';
        $('cpReqStatusLabel').textContent = isFee ? 'Service Fee' : 'Proposed Schedule';
        $('cpReqStatusValue').textContent = isFee
          ? '₱'+needsReview.feeAmount
          : (needsReview.proposedScheduleDate ? fmtDate(needsReview.proposedScheduleDate) : 'Date to be confirmed')+
            (needsReview.proposedScheduleTime ? ' · '+needsReview.proposedScheduleTime : '');
        $('cpReqStatusSub').textContent = 'Awaiting your review';
        $('cpReqStatusBtn').onclick = (e)=>{
          e.stopPropagation();
          if(typeof srOpenDetail==='function') srOpenDetail(needsReview);
        };
        statusCard.style.display = '';
        if($('cpBookingBanner')) $('cpBookingBanner').style.display = 'none';
      } else {
        statusCard.style.display = 'none';
      }
    }

    // Recent activity — last 3 reports, newest first (already sorted by
    // loadCustomerPortalData's query).
    $('cpActivityFullHistoryLink').onclick = ()=> cpShowScreen('History', 'Visits');
    $('cpRecentActivity').innerHTML = cpReports.length
      ? cpReports.slice(0,3).map(r=>{
          const title = escapeHtml((r.trouble_call && r.trouble_call.trim()) ? r.trouble_call : (r.equip_type||'Service visit'));
          const warn = !!(r.trouble_call && r.trouble_call.trim());
          return '<div class="cp-activity-row" data-sr-no="'+escapeHtml(r.sr_no||'')+'" data-report-id="'+escapeHtml(r.id||'')+'">'+
            '<span class="cp-activity-dot'+(warn?' warn':'')+'"></span>'+
            '<div><p class="t">'+title+'</p><p class="s">'+escapeHtml(r.equip_location||'')+'</p></div>'+
            '<span class="date">'+fmtDate(r.date)+'</span>'+
          '</div>';
        }).join('')
      : '<div class="empty-state">No activity yet.</div>';
    $$('.cp-activity-row', $('cpRecentActivity')).forEach(row=>{
      row.onclick = ()=>{
        const sr = row.dataset.srNo, reportId = row.dataset.reportId;
        if((sr||reportId) && typeof openCustomerReportPreview==='function') openCustomerReportPreview(sr, reportId);
      };
    });

    if(cpCustomer && cpCustomer.id) cpRefreshRequestsBadge(cpCustomer.id);
  }

  // "Viewing: [customer ▾]" switcher — always shown once currentUser.
  // customerList is known (populated at login/session-restore from
  // customer_login_links — see auth.js), even for a login linked to just
  // one customer. Previously hidden outright below 2 entries, which meant
  // most customers — anyone with a single-customer login — never saw any
  // on-screen confirmation of which company/site account they were
  // viewing. Below 2 entries the <select> is disabled and restyled to
  // read as a plain name chip (see .cp-switcher-box.single in app.css)
  // rather than presenting a dropdown with nothing to switch to. Picking a
  // different customer re-scopes the whole home screen (equipment,
  // reports, stat strip) to that customer, and is remembered per device so
  // it's still selected next time this login signs in here.
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
    else cpShowScreen('History', 'Requests');
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
  function cpShowRequestsScreen(){
    $('customerHomeScreen').style.display = 'none';
    $('customerEquipmentDetailScreen').style.display = 'none';
    $('customerUnitsScreen').style.display = 'none';
    $('customerHistoryScreen').style.display = 'none';
    $('customerToolsScreen').style.display = 'none';
    $('customerCalcScreen').style.display = 'none';
    $('customerProfileScreen').style.display = 'none';
    $('customerLegalScreen').style.display = 'none';
    $('customerRequestsScreen').style.display = '';
    cpReqShowTab('new');
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
  const CP_NAV_ITEMS = [
    { screen:'Home', id:'cpNavHome', icon:'home' },
    { screen:'Units', id:'cpNavUnits', icon:'grid' },
    { screen:'History', id:'cpNavHistory', icon:'clock' },
    { screen:'Tools', id:'cpNavTools', icon:'tools' },
    { screen:'Profile', id:'cpNavProfile', icon:'person' }
  ];
  function cpInitNav(){
    CP_NAV_ITEMS.forEach(item=>{
      const btn = $(item.id);
      if(!btn) return;
      btn.innerHTML = CP_ICON[item.icon]+'<span>'+item.screen+'</span>';
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
    if(typeof cpEnterPortalShell === 'function') cpEnterPortalShell();
    $('customerHomeScreen').style.display = 'none';
    cpSetNavActive(screen);
    if(screen==='Units'){ $('customerUnitsScreen').style.display = ''; renderCustomerUnitsScreen(); }
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
  function cpUnitsApplyFilter(){
    const q = ($('cpUnitsSearch').value||'').trim().toLowerCase();
    $$('.cp-unit-card', $('cpUnitsGrid')).forEach(el=> el.style.display = el.textContent.toLowerCase().includes(q) ? '' : 'none');
  }
  function renderCustomerUnitsScreen(){
    $('cpUnitsScreenSub').textContent = cpEquipment.length+' unit'+(cpEquipment.length===1?'':'s')+' enrolled';
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

  // ---------- Tools & learning ----------
  // Kept intentionally simple v1 calculators — real formulas, no account
  // data required — plus a short reference-guide article list. Both lists
  // are static content owned here; extend CP_CALCULATORS/CP_ARTICLES to add
  // more without touching the screen-rendering code below.
  const CP_CALCULATORS = [
    { id:'electricity', icon:'bolt', title:'Electricity cost', desc:'Estimate monthly running cost from your unit\'s capacity and hours used.' },
    { id:'capacity', icon:'ruler', title:'Capacity guide', desc:'How many HP/kW you need for a room of a given size.' },
    { id:'savings', icon:'piggy', title:'Maintenance savings', desc:'What regular PM saves you vs. reactive repairs over a year.' }
  ];
  const CP_ARTICLES = [
    { id:'filter', icon:'leaf', title:'Cleaning your air filter', desc:'A simple monthly habit that keeps your unit efficient.', body:[
      'The air filter is the mesh screen just behind the front panel of the indoor unit. Its job is to catch dust and lint before air passes over the evaporator coil. When it clogs, less air moves through the unit — it cools less, runs longer to hit your set temperature, and uses more electricity in the process. A dirty filter is also one of the most common causes of a coil icing up.',
      '<b>How often:</b> every 2–4 weeks with regular daily use, more often if the unit runs constantly, if the room is dusty, or if there\'s ongoing construction or pets nearby. Once a month is a safe default for most households.',
      '<b>How to clean it:</b>',
      '<ul style="margin:6px 0 0; padding-left:18px; font-size:13px; line-height:1.7;">'+
        '<li>Turn off the unit at the remote and, if possible, at the breaker.</li>'+
        '<li>Open the front panel and slide the filter(s) out — most split-type indoor units have one or two.</li>'+
        '<li>Vacuum off loose dust first, then rinse with running water. A soft brush helps with caked-on grime.</li>'+
        '<li>Let it air-dry completely out of direct sunlight before reinserting — sunlight can warp the plastic frame, and reinserting it wet encourages mold.</li>'+
        '<li>Close the panel and power the unit back on.</li>'+
      '</ul>',
      'If the filter looks torn, brittle, or won\'t come clean after washing, it\'s time to replace it rather than keep reusing it.'
    ]},
    { id:'signs', icon:'alert', title:'Signs your unit needs service', desc:'What to watch and listen for between PM visits.', body:[
      'Most breakdowns give some warning first. If you notice any of the following, it\'s worth requesting a visit rather than waiting for the next scheduled PM:',
      '<ul style="margin:6px 0 0; padding-left:18px; font-size:13px; line-height:1.7;">'+
        '<li><b>Weaker airflow or warm air</b> blowing even with the unit set to cool — can point to a dirty filter/coil, a fan issue, or low refrigerant.</li>'+
        '<li><b>Unusual noises</b> — rattling or buzzing often means a loose part; a hissing sound can indicate a refrigerant leak and is worth flagging promptly.</li>'+
        '<li><b>Water dripping or pooling</b> from the indoor unit — usually a clogged condensate drain line.</li>'+
        '<li><b>Musty or foul odor</b> when the unit runs — often mold or mildew buildup inside the unit.</li>'+
        '<li><b>Ice forming</b> on the indoor coil or outdoor pipes — a sign of restricted airflow or a refrigerant problem, and running it further in that state can damage the compressor.</li>'+
        '<li><b>Short cycling</b> — the unit turns on and off in short bursts instead of running a normal cycle.</li>'+
        '<li><b>A noticeably higher bill</b> without a change in how much you\'re using the unit.</li>'+
      '</ul>',
      'None of these are emergencies on their own, but they\'re cheaper to fix early than after they cause a bigger failure — a stuck-open drain line, for instance, is a quick fix; the water damage it eventually causes isn\'t.'
    ]},
    { id:'pm', icon:'calendar', title:'Why preventive maintenance matters', desc:'What a PM visit actually covers, and how often you need one.', body:[
      'A preventive maintenance (PM) visit is a scheduled check-up rather than a repair — the goal is to catch small issues and keep the unit running efficiently before something forces a breakdown.',
      '<b>What\'s typically covered:</b>',
      '<ul style="margin:6px 0 0; padding-left:18px; font-size:13px; line-height:1.7;">'+
        '<li>Cleaning/washing the indoor evaporator coil and outdoor condenser coil</li>'+
        '<li>Cleaning or replacing air filters</li>'+
        '<li>Checking refrigerant pressure and topping up if needed</li>'+
        '<li>Clearing the condensate drain line</li>'+
        '<li>Inspecting electrical connections, the capacitor, and the fan motor</li>'+
        '<li>Checking overall airflow and cooling performance</li>'+
      '</ul>',
      '<b>How often:</b> as a general guide, every 3 months for units that run heavily or continuously (e.g. commercial or always-on residential use), and every 4–6 months for typical household use. Units in dusty areas, near construction, or with visible performance dips benefit from more frequent visits — your technician can recommend an interval based on how the unit is actually used.',
      'Regular PM matters because dust buildup on the coils is one of the biggest, most avoidable drags on efficiency, and because most manufacturers require documented maintenance to honor a compressor warranty. It also tends to extend how long the unit lasts before a major repair or replacement is needed.'
    ]},
    { id:'inverter', icon:'bolt', title:'Inverter vs. non-inverter: what it means for your bill', desc:'The one spec that changes your electricity cost the most.', body:[
      'Both types cool the room the same way — the difference is how the compressor runs.',
      '<b>Non-inverter:</b> the compressor runs at a fixed speed. To hold your set temperature, it switches fully on and off in cycles. It\'s cheaper to buy, but running at full power every time it kicks in uses more electricity over the course of a day.',
      '<b>Inverter:</b> the compressor speed adjusts continuously to match how much cooling the room actually needs, instead of switching fully off. Once the room reaches temperature, it idles at a low speed rather than cycling — which is why inverter units commonly use meaningfully less electricity than a non-inverter unit of the same HP rating, especially when it runs for long stretches. They cost more upfront, and that gap is usually made up over a few years of regular use through lower bills.',
      'When comparing units, the Philippine Energy Label on the box or spec sheet lists the CSPF/EER rating — a higher number means more cooling per watt, which is a more precise gauge than "inverter" alone since efficiency also varies by brand and model.'
    ]},
    { id:'repair-replace', icon:'piggy', title:'When to repair vs. replace your unit', desc:'How to decide once a repair estimate is on the table.', body:[
      'A few practical factors, together, usually make the decision clearer than any single rule:',
      '<ul style="margin:6px 0 0; padding-left:18px; font-size:13px; line-height:1.7;">'+
        '<li><b>Age.</b> A well-maintained split-type unit typically lasts around 10–15 years before efficiency drops off and parts get harder to source. A costly repair on a unit already near or past that range is worth weighing against a new, more efficient replacement.</li>'+
        '<li><b>Repair cost relative to a new unit.</b> If a single repair runs close to a large fraction of what a new comparable unit costs, replacement often makes more sense, especially on an older unit.</li>'+
        '<li><b>Repair frequency.</b> A unit needing repeat service calls within a year is usually cheaper to replace than to keep patching.</li>'+
        '<li><b>Refrigerant type.</b> Older units using phased-out refrigerants (like R-22) can be more expensive to service since the refrigerant itself is costlier and less available.</li>'+
      '</ul>',
      'If you\'re unsure where a specific repair estimate falls, it\'s worth asking your technician directly — they can tell you what shape the rest of the unit is in, not just the part that failed.'
    ]}
  ];
  function renderCustomerToolsScreen(){
    $('cpCalcGrid').innerHTML = CP_CALCULATORS.map(c=>
      '<button type="button" class="cp-tool-card" data-calc="'+c.id+'">'+
        '<div class="ic">'+CP_ICON[c.icon]+'</div>'+
        '<p class="t">'+c.title+'</p><p class="d">'+c.desc+'</p>'+
      '</button>'
    ).join('');
    $$('.cp-tool-card', $('cpCalcGrid')).forEach(btn=> btn.onclick = ()=> cpOpenCalc(btn.dataset.calc));
    $('cpArticleList').innerHTML = CP_ARTICLES.map(a=>
      '<button type="button" class="cp-article-row" data-article="'+a.id+'">'+
        '<div class="ic">'+CP_ICON[a.icon]+'</div>'+
        '<div><p class="t">'+a.title+'</p><p class="d">'+a.desc+'</p></div>'+
        '<span class="chev">'+CP_ICON.chevron+'</span>'+
      '</button>'
    ).join('');
    $$('.cp-article-row', $('cpArticleList')).forEach(btn=> btn.onclick = ()=> cpOpenArticle(btn.dataset.article));
  }
  $('cpToolsSearch').addEventListener('input', function(){
    const q = this.value.trim().toLowerCase();
    $$('.cp-tool-card', $('cpCalcGrid')).forEach(el=> el.style.display = el.textContent.toLowerCase().includes(q) ? '' : 'none');
    $$('.cp-article-row', $('cpArticleList')).forEach(el=> el.style.display = el.textContent.toLowerCase().includes(q) ? '' : 'none');
  });

  function cpShowCalcScreen(){
    $('customerToolsScreen').style.display = 'none';
    $('customerCalcScreen').style.display = '';
    window.scrollTo({top:0});
  }
  $('cpCalcBackBtn').addEventListener('click', ()=>{
    $('customerCalcScreen').style.display = 'none';
    $('customerToolsScreen').style.display = '';
  });

  function cpOpenArticle(id){
    const a = CP_ARTICLES.find(x=> x.id===id);
    if(!a) return;
    const bodyHtml = (a.body||[]).map(block=>
      block.trim().startsWith('<ul') ? block : '<p style="font-size:13px; line-height:1.7; margin:0 0 12px;">'+block+'</p>'
    ).join('');
    $('cpCalcBody').innerHTML =
      '<h2 style="font-size:15px; margin:0 0 10px;">'+a.title+'</h2>'+
      '<p style="font-size:13px; color:var(--text-muted); line-height:1.6; margin:0 0 14px;">'+a.desc+'</p>'+
      bodyHtml+
      '<p style="font-size:11px; color:var(--text-muted); margin-top:6px;">General guidance for typical split-type units — your unit\'s manual may have model-specific instructions. If anything is unclear or your unit needs attention, request a visit and a technician can take a look on-site.</p>';
    cpShowCalcScreen();
  }

  // Every calculator follows the same shape: render inputs + a live
  // result, recompute on any input change. Kept as one function per tool
  // rather than a generic config-driven form, since each one's inputs and
  // formula are different enough that a generic version would be harder
  // to read than just writing the three out.
  function cpOpenCalc(id){
    if(id==='electricity') return cpCalcElectricity();
    if(id==='capacity') return cpCalcCapacity();
    if(id==='savings') return cpCalcSavings();
  }
  function cpCalcElectricity(){
    // Previous v1 formula multiplied HP by 0.746 (the pure mechanical
    // HP→kW conversion) and treated that as the electrical draw. That
    // understates real consumption — a compressor's electrical input is
    // higher than its mechanical output — and it ignored the single
    // biggest factor in real bills: inverter units modulate compressor
    // speed instead of running at full rated draw the whole time, so
    // they use meaningfully less power than a non-inverter unit of the
    // same HP. This version uses typical input-wattage-per-HP figures
    // for each type instead of the mechanical conversion, and lets the
    // person pick which kind of unit they have.
    $('cpCalcBody').innerHTML =
      '<h2 style="font-size:15px; margin:0 0 12px;">Electricity cost</h2>'+
      '<div class="field"><label>Unit capacity (HP)</label><input type="number" id="ceHp" value="1.5" step="0.5" min="0.5"></div>'+
      '<div class="field"><label>Unit type</label><select id="ceType"><option value="inverter" selected>Inverter</option><option value="noninverter">Non-inverter (window/standard split)</option></select></div>'+
      '<div class="field"><label>Hours used per day</label><input type="number" id="ceHours" value="8" min="0"></div>'+
      '<div class="field"><label>Your rate (₱ per kWh, from your bill)</label><input type="number" id="ceRate" value="12" step="0.5" min="0"></div>'+
      '<div class="cp-calc-result"><p class="n" id="ceResult">—</p><p class="l">Estimated cost per month</p></div>'+
      '<p style="font-size:11px; color:var(--text-muted); margin-top:10px;">Estimate based on typical input wattage per HP for each unit type, assuming it runs continuously at that load for the hours entered. Actual draw varies by brand, EER/CSPF rating, set temperature, insulation, and how often the compressor cycles or idles once the room is cool — so real bills are often lower than this, especially for inverter units in a well-sized room.</p>';
    const calc = ()=>{
      const hp = parseFloat($live('ceHp').value)||0, hours = parseFloat($live('ceHours').value)||0, rate = parseFloat($live('ceRate').value)||0;
      const type = $live('ceType').value;
      // Typical full-load electrical input for a non-inverter unit runs
      // roughly 750-900W per HP (not the ~746W mechanical-only figure);
      // 800W/HP is the midpoint. Inverter units modulate and average
      // roughly 55-65% of that once steady, vs the 30-50% savings
      // commonly cited for inverter over non-inverter — 60% is used here.
      const wattsPerHp = 800;
      const watts = hp * wattsPerHp * (type === 'inverter' ? 0.6 : 1);
      const monthly = (watts/1000) * hours * 30 * rate;
      $live('ceResult').textContent = '₱'+monthly.toLocaleString(undefined,{maximumFractionDigits:0});
    };
    ['ceHp','ceHours','ceRate'].forEach(id=> $(id).addEventListener('input', calc));
    $live('ceType').addEventListener('change', calc);
    calc();
    cpShowCalcScreen();
  }
  function cpCalcCapacity(){
    // Rule-of-thumb sizing: ~600 BTU/hr of cooling per sqm for a
    // standard Philippine room (moderate ceiling height, typical sun
    // exposure), rounded up to the nearest standard aircon HP rating
    // (1 HP ≈ 9,000 BTU/hr). This is a starting point, not a load
    // calculation — a proper one accounts for ceiling height, window
    // area/orientation, insulation, and occupancy/heat-generating
    // equipment, which is why the guide below still points to a
    // technician for anything borderline or unusual.
    $('cpCalcBody').innerHTML =
      '<h2 style="font-size:15px; margin:0 0 12px;">Capacity guide</h2>'+
      '<div class="field"><label>Room floor area (sqm)</label><input type="number" id="ccArea" value="15" min="1"></div>'+
      '<div class="cp-calc-result"><p class="n" id="ccResult">—</p><p class="l" id="ccResultLabel">Suggested capacity</p></div>'+
      '<p style="font-size:11px; color:var(--text-muted); margin-top:10px;">Based on roughly 600 BTU/hr per sqm, rounded to the nearest standard HP size. Higher ceilings, west/afternoon sun exposure, more occupants, or heat-generating equipment in the room push the real requirement higher — a technician can confirm the right size on-site.</p>';
    const calc = ()=>{
      const area = parseFloat($live('ccArea').value)||0;
      const btu = area * 600;
      // Table only covers sizes a single split-type indoor unit actually
      // ships as. The old version had no upper bound, so anything past
      // ~35 sqm silently kept returning "3 HP" no matter how large the
      // area got (e.g. 1500 sqm also came back as "3 HP" — off by
      // roughly two orders of magnitude, since no single unit that size
      // exists). Past the largest common single-unit tier, this now
      // switches to a total-load figure and a rough unit count instead
      // of pretending one unit covers it.
      const TIERS = [[6500,0.75],[9500,1.0],[13500,1.5],[18500,2.0],[22500,2.5],[27000,3.0]];
      const tier = area>0 ? TIERS.find(t=> btu<=t[0]) : null;
      if(area<=0){
        $live('ccResult').textContent = '—';
        $live('ccResultLabel').textContent = 'Suggested capacity';
      } else if(tier){
        $live('ccResult').textContent = tier[1]+' HP';
        $live('ccResultLabel').textContent = 'Suggested capacity (~'+Math.round(btu).toLocaleString()+' BTU/hr)';
      } else {
        // Beyond one unit's range: give the total load and a ballpark
        // unit count using a common per-zone size (2.0 HP ≈ 18,000
        // BTU/hr) rather than one oversized HP number.
        const zones = Math.ceil(btu/18000);
        $live('ccResult').textContent = '~'+Math.round(btu).toLocaleString()+' BTU/hr total';
        $live('ccResultLabel').textContent = 'Too large for one unit — plan for roughly '+zones+' × 2.0 HP units (or fewer, larger/ducted units) across zones';
      }
    };
    $live('ccArea').addEventListener('input', calc);
    calc();
    cpShowCalcScreen();
  }
  function cpCalcSavings(){
    $('cpCalcBody').innerHTML =
      '<h2 style="font-size:15px; margin:0 0 12px;">Maintenance savings</h2>'+
      '<div class="field"><label>Number of units</label><input type="number" id="csUnits" value="'+(cpEquipment.length||1)+'" min="1"></div>'+
      '<div class="field"><label>PM visits per year, per unit</label><input type="number" id="csVisits" value="2" min="1"></div>'+
      '<div class="field"><label>Typical PM cost per visit (₱)</label><input type="number" id="csPmCost" value="1500" min="0"></div>'+
      '<div class="field"><label>Typical reactive repair cost (₱)</label><input type="number" id="csRepairCost" value="8000" min="0"></div>'+
      '<div class="cp-calc-result"><p class="n" id="csResult">—</p><p class="l">Estimated yearly savings vs. skipping PM</p></div>'+
      '<p style="font-size:11px; color:var(--text-muted); margin-top:10px;">Assumes one avoided major repair per unit per year without regular PM — a common, conservative rule of thumb, not a guarantee.</p>';
    const calc = ()=>{
      const units = parseFloat($live('csUnits').value)||0, visits = parseFloat($live('csVisits').value)||0;
      const pmCost = parseFloat($live('csPmCost').value)||0, repairCost = parseFloat($live('csRepairCost').value)||0;
      const pmTotal = units * visits * pmCost;
      const avoidedRepairs = units * repairCost;
      const savings = avoidedRepairs - pmTotal;
      $live('csResult').textContent = '₱'+Math.max(0,savings).toLocaleString(undefined,{maximumFractionDigits:0});
    };
    ['csUnits','csVisits','csPmCost','csRepairCost'].forEach(id=> $(id).addEventListener('input', calc));
    calc();
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
  $('cpProfileRowRequests').addEventListener('click', ()=> cpShowScreen('History', 'Requests'));
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
  $('cpRequestServiceBtn').addEventListener('click', ()=>{
    if(typeof cpShowRequestsScreen === 'function') cpShowRequestsScreen();
  });
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
