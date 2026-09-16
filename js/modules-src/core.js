
  // ---------- Icons ----------
  // Inline SVG only (no emoji) across the whole system — sidebar nav, admin
  // dashboard, DTR, dispatch, cash advance, etc. — same reasoning and same
  // stroke="currentColor" line-icon style already used for the customer
  // portal's own CP_ICON set (customer-portal.js): emoji render as a
  // different picture on every OS/font (an Android phone, an iPhone, and a
  // desktop browser each draw something different for the same codepoint),
  // can't take the surrounding text's color, and read as inconsistent next
  // to a deliberately designed UI. icon(name) below returns a ready-to-use
  // <svg> string sized at 1em so it drops into any existing emoji-sized
  // container (.menu-ico, .card-head span, .home-tile-icon,
  // .overview-stat-icon, etc.) without needing new CSS at each call site —
  // see the .ic rule in app.css.
  const ICON = {
    home:'<path d="M3 9.5 12 3l9 6.5V21a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z"/>',
    clipboard:'<path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1"/>',
    receipt:'<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/>',
    clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/>',
    calendar:'<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/>',
    chat:'<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>',
    folder:'<path d="M4 6a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/>',
    settings:'<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
    cash:'<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 10v4M18 10v4"/>',
    calculator:'<rect x="4" y="2" width="16" height="20" rx="2"/><path d="M8 6h8"/><path d="M8 10h.01M12 10h.01M16 10h.01M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01M16 18h.01"/>',
    handshake:'<path d="M11 12 7 8 3 12l4 4z"/><path d="M13 12l4-4 4 4-4 4z"/><path d="M7 8l3-3 2 2 2-2 3 3"/>',
    archive:'<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>',
    truck:'<rect x="1" y="6" width="14" height="10" rx="1"/><path d="M15 10h4l3 3v3h-7z"/><circle cx="6" cy="18" r="1.5"/><circle cx="17.5" cy="18" r="1.5"/>',
    tools:'<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2-2z"/>',
    building:'<rect x="4" y="2" width="16" height="20" rx="1"/><path d="M9 22v-4h6v4"/><path d="M8 6h2M14 6h2M8 10h2M14 10h2M8 14h2M14 14h2"/>',
    toolbox:'<rect x="2" y="9" width="20" height="11" rx="2"/><path d="M8 9V6a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v3"/><path d="M2 14h20"/>',
    person:'<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
    people:'<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.5 3-6 6.5-6s6.5 2.5 6.5 6"/><circle cx="17" cy="9" r="3"/><path d="M15 14.2c2.8.5 5 2.6 5 5.8"/>',
    megaphone:'<path d="M3 10v4a1 1 0 0 0 1 1h2l4 4 1-1-3-4h6l6 3V6l-6 3H6a1 1 0 0 0-1 1z"/>',
    key:'<circle cx="8" cy="15" r="4"/><path d="M10.5 12.5 20 3"/><path d="M17 6l2 2"/><path d="M14 9l2 2"/>',
    snowflake:'<path d="M12 2v20M2 12h20M5 5l14 14M19 5 5 19"/>',
    file:'<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
    logOut:'<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/>',
    wave:'<path d="M8 13V6a1.5 1.5 0 0 1 3 0v5"/><path d="M11 11V4a1.5 1.5 0 0 1 3 0v7"/><path d="M14 11V5a1.5 1.5 0 0 1 3 0v8"/><path d="M17 13V8a1.5 1.5 0 0 1 3 0v6a6 6 0 0 1-6 6h-2a6 6 0 0 1-5-2.7L4 15a1.4 1.4 0 0 1 2-2l2 1.8"/>',
    search:'<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
    bell:'<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>',
    barChart:'<path d="M3 3v18h18"/><rect x="7" y="12" width="3" height="6"/><rect x="12" y="8" width="3" height="10"/><rect x="17" y="5" width="3" height="13"/>',
    radio:'<circle cx="12" cy="12" r="2"/><path d="M16.24 7.76a6 6 0 0 1 0 8.49M7.76 16.24a6 6 0 0 1 0-8.49M19.07 4.93a10 10 0 0 1 0 14.14M4.93 19.07a10 10 0 0 1 0-14.14"/>',
    bolt:'<path d="M13 2 3 14h7l-1 8 10-12h-7z"/>',
    compass:'<circle cx="12" cy="12" r="10"/><path d="m16 8-2 6-6 2 2-6z"/>',
    package:'<path d="m21 8-9-5-9 5 9 5 9-5z"/><path d="M3 8v8l9 5 9-5V8"/><path d="M12 13v8"/>',
    camera:'<path d="M4 8h3l2-2h6l2 2h3v11H4z"/><circle cx="12" cy="13.5" r="3.5"/>',
    car:'<path d="M5 11 6.5 6.5A2 2 0 0 1 8.4 5h7.2a2 2 0 0 1 1.9 1.5L19 11"/><rect x="3" y="11" width="18" height="6" rx="2"/><circle cx="7.5" cy="17" r="1.5"/><circle cx="16.5" cy="17" r="1.5"/>',
    paperclip:'<path d="m21 11.5-8.5 8.5a4 4 0 0 1-5.7-5.7l9-9a2.5 2.5 0 0 1 3.6 3.6l-8.7 8.7a1 1 0 0 1-1.4-1.4l7.8-7.8"/>',
    edit:'<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
    checkCircle:'<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
    download:'<path d="M12 3v12"/><path d="m7 11 5 5 5-5"/><path d="M5 21h14"/>',
    eye:'<path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/>',
    lock:'<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
    checkSquare:'<rect x="3" y="3" width="18" height="18" rx="2"/><path d="m8 12 3 3 5-6"/>',
    check:'<path d="m5 12 5 5L20 7"/>',
    alert:'<path d="M12 2 1 21h22z"/><path d="M12 9v5"/><path d="M12 17h.01"/>',
    inbox:'<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
    pin:'<path d="M21 10c0 7-9 12-9 12s-9-5-9-12a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>',
    flag:'<path d="M4 3v18"/><path d="M4 4h13l-3 5 3 5H4"/>',
    cloud:'<path d="M17.5 19a4.5 4.5 0 0 0 0-9 6 6 0 0 0-11.4-1.5A5 5 0 0 0 6.5 19z"/>',
    menu:'<path d="M4 6h16M4 12h16M4 18h16"/>',
    close:'<path d="m18 6-12 12"/><path d="m6 6 12 12"/>',
    star:'<path d="m12 2 3 7 7 .5-5.5 4.5 2 7-6.5-4-6.5 4 2-7L2 9.5 9 9z"/>',
    lightbulb:'<path d="M9 18h6"/><path d="M10 22h4"/><path d="M12 2a6 6 0 0 0-4 10.5c.6.6 1 1.4 1 2.5h6c0-1.1.4-1.9 1-2.5A6 6 0 0 0 12 2z"/>',
    info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/>',
    caretDown:'<path d="m6 9 6 6 6-6"/>',
    expand:'<path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="M21 3l-7 7"/><path d="M3 21l7-7"/>',
    externalLink:'<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14 21 3"/>'
  };
  // Wraps an ICON path into a ready-to-use <svg>. `attrs` is an optional
  // string of extra attributes (e.g. 'fill="currentColor" stroke="none"'
  // for the solid status dots, or a style override) appended to the tag.
  function icon(name, attrs){
    const body = ICON[name] || '';
    return '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"'+(attrs?(' '+attrs):'')+'>'+body+'</svg>';
  }
  // Small solid circle for status dots (🟢/🔴/🟠/⚫) — these were never
  // line-art, just a colored disc, so this is fill="currentColor" instead
  // of going through icon()'s stroke-based wrapper.
  function dotIcon(colorVar){
    return '<svg class="ic" viewBox="0 0 24 24" style="color:'+colorVar+';"><circle cx="12" cy="12" r="8" fill="currentColor"/></svg>';
  }

  // ---------- helpers ----------
  const domCache = Object.create(null);
  const $ = (id) => domCache[id] || (domCache[id] = document.getElementById(id));
  const $$ = (selector, root=document) => Array.from(root.querySelectorAll(selector));


  // Shared HTML escaping helper. Keep this in one place so modules do not each
  // maintain their own copy.
  function escapeHtml(s){
    return String(s==null?'':s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }
  function toast(msg){
    const t = $('toast'); t.textContent = msg; t.classList.add('show');
    setTimeout(()=>t.classList.remove('show'), 2200);
  }
  // IMPORTANT: must return the device's LOCAL calendar date, not UTC.
  // toISOString() always converts to UTC first — for Philippine time (UTC+8),
  // that meant anyone clocking in before 8:00 AM local time got their DTR
  // entry filed under YESTERDAY's date, while clocking out later the same
  // local day (after the UTC rollover) looked up TODAY's date instead and
  // found no matching record — blocking Time Out or creating a duplicate,
  // separate entry. Using local getters instead avoids this entirely.
  function todayISO(){
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth()+1).padStart(2,'0');
    const day = String(d.getDate()).padStart(2,'0');
    return y+'-'+m+'-'+day;
  }
  function fmtDate(iso){
    if(!iso) return '—';
    const d = new Date(iso+'T00:00:00');
    return d.toLocaleDateString('en-PH', {year:'numeric', month:'short', day:'numeric'});
  }
  // For full timestamptz values (e.g. created_at) — NOT plain date columns.
  // fmtDate() above assumes a bare "YYYY-MM-DD" string and appends
  // 'T00:00:00' itself; feeding it an already-complete ISO timestamp (with
  // its own time + offset, e.g. "2026-09-10T09:23:45.123+00:00") produces
  // a malformed "...+00:00T00:00:00" string that new Date() can't parse,
  // which is why service-requests.js's "created" timestamps were showing
  // as Invalid Date before this existed.
  function fmtDateTime(iso){
    if(!iso) return '—';
    const d = new Date(iso);
    if(isNaN(d.getTime())) return '—';
    return d.toLocaleDateString('en-PH', {year:'numeric', month:'short', day:'numeric'})
      +' '+d.toLocaleTimeString('en-PH', {hour:'numeric', minute:'2-digit'});
  }
  // Matches a piece of equipment to its own service-report visit history out
  // of a customer's full report list. Shared by the customer portal's
  // equipment detail screen (customer-equipment-history.js) and the admin
  // "Manage Equipment List" detail overlay (admin.js) so both show the
  // identical history for the same unit rather than two independently
  // maintained copies of this logic drifting apart.
  // Matched by equipment_id first when a report has one (set at save time —
  // see saveReport() in ui.js and reportToRow() above) — a stable link that
  // survives later edits to the equipment record's own fields entirely.
  // Falls back to serial number (serial_cu / serial_fcu) when the report
  // predates equipment_id, and to location+type text only when the
  // equipment record has no serial on file either. Returns newest first.
  function matchReportHistoryForEquipment(reports, eq){
    const hasSerial = !!(eq.serialCU || eq.serialFCU);
    return (reports||[]).filter(r=>{
      if(eq.id && r.equipment_id) return r.equipment_id === eq.id;
      if(hasSerial){
        return (eq.serialCU && r.serial_cu === eq.serialCU) ||
               (eq.serialFCU && r.serial_fcu === eq.serialFCU);
      }
      return (r.equip_location||'') === (eq.equipLocation||'') &&
             (r.equip_type||'') === (eq.equipType||'');
    }).sort((a,b)=> (b.date||'').localeCompare(a.date||''));
  }

  // Human-readable form of a customer_equipment row's fixed id — the same
  // uuid service_reports.equipment_id matches against (see
  // matchReportHistoryForEquipment above), just shortened for display: a
  // full 36-character uuid is unreadable inline in a list row. Always
  // reflects the actual id, never the customer-assigned label — use this
  // specifically where the raw, permanent identifier itself needs to be
  // shown (e.g. an "Equipment ID" detail row), not as a friendly title.
  function equipShortId(eq){
    if(!eq || !eq.id) return '—';
    const id = String(eq.id);
    return 'EQ-' + (id.length>8 ? id.slice(0,8) : id).toUpperCase();
  }
  // The name to show for a unit wherever an equipment list or title needs
  // ONE identifying string. Priority: the customer-set label (see
  // 20260909_02_customer_equipment_label.sql and the "Customer Label"
  // field in admin.js's equipment detail overlay) → the unit's location
  // (e.g. "Living Room") → equipShortId() as a last resort, so every list
  // row still shows *some* stable identifier rather than nothing.
  function equipDisplayName(eq){
    if(!eq) return '';
    const label = (eq.label||'').trim();
    if(label) return label;
    const loc = (eq.equipLocation||'').trim();
    if(loc) return loc;
    return equipShortId(eq);
  }

  // ---------- shared cloud (Supabase) ----------
  let cloudReady = false;
  let cloudInitPromise = null;
  let db = null; // Supabase client (supabase-js), was a Firestore ref before

  // The app now connects automatically using AWES's Supabase project — no
  // manual setup needed for day-to-day use. (Recovery path: the "tap to set
  // up Shared Cloud" link on the login screen still opens the config screen,
  // in case this project ever needs to change.)
  const DEFAULT_CLOUD_CONFIG = {
    url: 'https://ugxrrgocjpkzumhghzat.supabase.co',
    anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVneHJyZ29janBrenVtaGdoemF0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY5NjA3NjEsImV4cCI6MjEwMjUzNjc2MX0.y6Q9rCb_pKretcptgHwcGb0-YpUYC3_JQhY2PGJqGWk'
  };
  function getCloudConfig(){
    try{
      const raw = localStorage.getItem('cloud-config');
      if(raw) return JSON.parse(raw); // {url, anonKey}
    }catch(e){
      // A corrupt override used to fail completely silently, so the app would
      // quietly fall back to the built-in project with no clue why the custom
      // one was ignored. Log it and clear the bad value so it stops happening.
      console.warn('Ignoring unreadable cloud-config override, using defaults', e);
      try{ localStorage.removeItem('cloud-config'); }catch(_){}
    }
    return DEFAULT_CLOUD_CONFIG;
  }
  function setCloudStatusUI(connected){
    const btn = $('cloudBtn');
    if(btn){ btn.innerHTML = icon('cloud')+(connected ? ' Connected' : ' Not Connected'); btn.classList.toggle('cloud-connected', connected); }
  }
  async function doCloudInit(){
    const cfg = getCloudConfig();
    if(!cfg || !cfg.url || !cfg.anonKey){ setCloudStatusUI(false); return false; }
    if(!window.supabase){
      try{ await loadAwesScript('supabase', awesLibs.supabase); }
      catch(e){ setCloudStatusUI(false); return false; }
    }
    try{
      // A custom fetch that forces cache:'no-store' on every request the
      // Supabase client makes. Without this, the browser's own HTTP cache
      // can serve an identical earlier GET request's response instead of
      // hitting the network fresh — which was causing screens (Today's DTR
      // status, History, etc.) to intermittently show stale data right
      // after a save, until the user navigated away and back.
      const noCacheFetch = (url, options) => fetch(url, { ...options, cache: 'no-store' });
      db = window.supabase.createClient(cfg.url, cfg.anonKey, { global: { fetch: noCacheFetch } });
      cloudReady = true;
      setCloudStatusUI(true);
      return true;
    }catch(e){
      console.error('Cloud connect failed', describeCloudError(e));
      cloudReady = false;
      setCloudStatusUI(false);
      return false;
    }
  }
  function initCloud(){
    if(!cloudInitPromise){
      // If this attempt fails (e.g. a brief signal drop while the Supabase
      // library was loading), don't permanently cache the failure — clear
      // the promise so the NEXT call retries fresh instead of silently
      // falling back to this device's local-only data for the rest of the
      // session (which is how technicians ended up seeing an incomplete
      // list, or just themselves, on flaky field connections).
      cloudInitPromise = doCloudInit().then(ok=>{
        if(!ok) cloudInitPromise = null;
        return ok;
      });
    }
    return cloudInitPromise;
  }
  async function ensureCloud(){
    if(cloudReady) return true;
    return await initCloud();
  }

  // Supabase errors (PostgrestError) are plain objects, so console.error(...e)
  // just prints "[object Object]" in some console viewers. Pull out the
  // fields that actually explain what went wrong (message/code/details/hint
  // for Postgrest errors, or message/name for anything else) so failures are
  // debuggable instead of opaque.
  function describeCloudError(e){
    if(!e) return 'unknown error';
    if(e.message || e.code || e.details || e.hint){
      return [e.code, e.message, e.details, e.hint].filter(Boolean).join(' | ');
    }
    try{ return JSON.stringify(e); }catch(_){ return String(e); }
  }

  // The signed-in user id according to the LIVE Supabase session, or null.
  // Deliberately distinct from currentUser.id: currentUser is restored from
  // localStorage on app start and can easily outlive the auth session
  // (expired refresh token, cleared storage, signed out in another tab).
  // Any write governed by an `auth.uid()` RLS check must be validated
  // against this, not against currentUser — otherwise the row is rejected
  // with 42501 and, for a queued write, retried forever.
  async function cloudAuthUid(){
    if(!(await ensureCloud())) return null;
    try{
      const { data } = await db.auth.getSession();
      return (data && data.session && data.session.user) ? data.session.user.id : null;
    }catch(e){ return null; }
  }

  // ---- Generic settings key-value store (table: app_settings) ----
  // Used for things like field-lists dropdowns and EmailJS config.
  // NOTE: admin password is no longer stored here — see loginAdmin/changeAdminPassword,
  // which now use real Supabase Auth instead of a settings/adminPin document.
  async function cloudGetDoc(key){
    if(!(await ensureCloud())) return null;
    try{
      const { data, error } = await db.from('app_settings').select('value').eq('key', key).maybeSingle();
      if(error) throw error;
      return data ? data.value : null;
    }catch(e){ console.error('cloud get failed', key, describeCloudError(e)); return null; }
  }
  async function cloudSetDoc(key, value){
    if(!(await ensureCloud())) return false;
    try{
      const { error } = await db.from('app_settings').upsert({ key, value }, { onConflict: 'key' });
      if(error) throw error;
      return true;
    }catch(e){ console.error('cloud set failed', key, describeCloudError(e)); return false; }
  }

  // ---- Service Reports (table: service_reports) ----
  // Maps the report object built by gatherData() <-> the Postgres snake_case
  // columns.
  //
  // IMPORTANT: the key names below MUST match what gatherData() in ui.js
  // actually produces, and what pdf.js / history.js actually read back. They
  // previously did not: reportToRow looked for data.recommendations,
  // data.installation, data.customerSignature, data.customerPrintedName and
  // data.technicianName, while gatherData emits recs, install, sigCustomer,
  // custPrintedName and techName. The result was that on EVERY cloud save the
  // recommendations, both signatures, both printed names and all installation
  // data were written as empty and permanently lost — invisible on the
  // technician's own phone because the local copy keeps the correct shape.
  // Do not "tidy" these names without changing gatherData/pdf.js to match.
  const REPORT_STRING_FIELDS = [
    ['sr_no','srNo'], ['technician_id','technicianId'], ['date','date'],
    ['cust_name','custName'], ['cust_address','custAddress'], ['contact_no','contactNo'],
    ['contact_person','contactPerson'], ['cust_email','custEmail'], ['equip_type','equipType'],
    ['model_cu','modelCU'], ['serial_cu','serialCU'], ['model_fcu','modelFCU'], ['serial_fcu','serialFCU'],
    ['cool_cap','coolCap'], ['mount_type','mountType'], ['brand','brand'], ['refrigerant_type','refrigerantType'],
    ['compressor_type','compressorType'], ['equip_location','equipLocation'], ['trouble_call','troubleCall'],
    ['time_in','timeIn'], ['time_out','timeOut'], ['remarks','remarks'],
    ['customer_printed_name','custPrintedName'], ['technician_name','techName']
  ];
  function reportToRow(data){
    const row = {};
    REPORT_STRING_FIELDS.forEach(([col, key])=>{ row[col] = data[key] != null ? data[key] : null; });
    // Resolves this report's cust_name (free text, typed/picked at filing
    // time) to a customers.id. This matters because the customer portal's
    // RLS read policy (supabase/migrations/20260904_01_customer_portal.sql,
    // widened in 20260905_customer_portal_multi_link.sql) filters on
    // service_reports.customer_id — NOT cust_name. Without this line every
    // report ever saved left customer_id null (20260904's own migration
    // only backfilled rows that already existed at that moment), so no
    // report filed since has ever been visible in a customer's "Recent
    // Service Reports". See supabase/migrations/20260908_02_backfill_
    // report_customer_id.sql for the one-time fix to reports already saved
    // before this line existed. Left null (same as before) when the name
    // doesn't match anything in customersCache — e.g. a typo'd/one-off
    // customer not in Manage Customers — same "spot-check and fix by hand"
    // case 20260904's own backfill comment already called out.
    const custMatch = (customersCache||[])
      .find(c=> (c.name||'').trim().toLowerCase() === (data.custName||'').trim().toLowerCase());
    row.customer_id = custMatch ? custMatch.id : null;
    // Stable link to the specific customer_equipment row this visit was
    // for — resolved in saveReport() (ui.js) via cloudAddCustomerEquipment()
    // before the report is saved. Preferred over serial/location+type
    // matching wherever it's present; see matchReportHistoryForEquipment()
    // below and its comment for why. Left null for reports saved before
    // this existed, or saved fully offline (no durable id available yet) —
    // those still fall back to the legacy matching for this same reason.
    row.equipment_id = data.equipmentId || null;
    row.findings      = data.findings || [];
    row.recommendations = data.recs || [];
    row.materials     = data.materials || [];
    row.services_done = data.servicesDone || [];
    row.before_data   = data.before || {};
    row.after_data    = data.after || {};
    row.is_install    = !!data.isInstall;
    row.installation  = data.install || {};
    // Signatures are PNG data-URL strings. Default to null, never {} — an
    // empty object is indistinguishable from "signature was lost in transit".
    row.customer_signature   = data.sigCustomer || null;
    row.technician_signature = data.sigTech || null;
    row.completed = !!data.completed;
    return row;
  }
  function rowToReport(row){
    if(!row) return null;
    const data = {};
    REPORT_STRING_FIELDS.forEach(([col, key])=>{ data[key] = row[col]; });
    data.findings     = row.findings || [];
    data.recs         = row.recommendations || [];
    data.materials    = row.materials || [];
    data.servicesDone = row.services_done || [];
    data.before       = normalizeOperatingData(row.before_data);
    data.after        = normalizeOperatingData(row.after_data);
    data.isInstall    = !!row.is_install;
    data.install      = normalizeInstallData(row.installation);
    data.sigCustomer  = asSignature(row.customer_signature);
    data.sigTech      = asSignature(row.technician_signature);
    data.completed    = !!row.completed;
    data.equipmentId  = row.equipment_id || null;
    return data;
  }
  // Legacy rows may hold {} (or a stray object) where a data-URL string was
  // expected, because of the field-name bug described above. Treat anything
  // that is not a data URL as "no signature" rather than handing jsPDF a
  // value it will throw on.
  function asSignature(v){
    return (typeof v === 'string' && v.indexOf('data:image') === 0) ? v : null;
  }
  // pdf.js calls .join() on these arrays, so guarantee their shape even for
  // rows written by older versions of the app.
  function normalizeOperatingData(d){
    d = d || {};
    return {
      amp:      Array.isArray(d.amp) ? d.amp : ['','',''],
      volt:     Array.isArray(d.volt) ? d.volt : ['','',''],
      pressure: Array.isArray(d.pressure) ? d.pressure : ['',''],
      temp:     d.temp || '',
      airflow:  d.airflow || ''
    };
  }
  function normalizeInstallData(d){
    d = d || {};
    return {
      pd: Array.isArray(d.pd) ? d.pd : ['','',''],
      pl: Array.isArray(d.pl) ? d.pl : ['',''],
      ws: Array.isArray(d.ws) ? d.ws : ['',''],
      pi: Array.isArray(d.pi) ? d.pi : ['',''],
      breaker: d.breaker || '', riser: d.riser || '',
      ptrap: d.ptrap || '', bracketType: d.bracketType || ''
    };
  }
  async function cloudSaveReport(srNo, data){
    if(!(await ensureCloud())) return false;
    try{
      data.srNo = srNo;
      const { error } = await db.from('service_reports').upsert(reportToRow(data), { onConflict: 'sr_no' });
      if(error) throw error;
      return true;
    }catch(e){ console.error('cloud save report failed', describeCloudError(e)); return false; }
  }
  // Reports store the customer's name as free text captured at filing time,
  // not a reference to the customers row — so renaming a customer in Manage
  // Customers leaves every past report under the old name, and they silently
  // drop out of that customer's History tab (its equipment-history match is
  // keyed on name). Called from the customer-edit save handler whenever the
  // name actually changes, so renames stay self-healing instead of quietly
  // orphaning history. Matches case/whitespace-insensitively client-side
  // (rather than via .ilike, which would misfire on names containing SQL
  // wildcard characters like % or _) and returns how many rows were updated.
  async function cloudRenameReportsCustomer(oldName, newName){
    if(!(await ensureCloud())) return 0;
    const target = (oldName||'').trim().toLowerCase();
    if(!target) return 0;
    try{
      const { data, error } = await db.from('service_reports').select('sr_no, cust_name');
      if(error) throw error;
      const srNos = (data||[])
        .filter(r=> (r.cust_name||'').trim().toLowerCase() === target)
        .map(r=> r.sr_no);
      if(srNos.length===0) return 0;
      const { error: updErr } = await db.from('service_reports').update({ cust_name: newName }).in('sr_no', srNos);
      if(updErr) throw updErr;
      return srNos.length;
    }catch(e){ console.error('rename reports customer failed', describeCloudError(e)); return 0; }
  }
  async function cloudDeleteReport(srNo){
    if(!(await ensureCloud())) return false;
    try{
      // .select() makes Postgrest return the rows it actually deleted. Without
      // it, a delete blocked by RLS (or a srNo that doesn't exist) comes back
      // with no error and looks identical to a real delete — the row silently
      // survives and reappears the next time the list reloads from the cloud.
      const { data, error } = await db.from('service_reports').delete().eq('sr_no', srNo).select('sr_no');
      if(error) throw error;
      return !!(data && data.length > 0);
    }catch(e){ console.error('cloud delete report failed', srNo, describeCloudError(e)); return false; }
  }
  async function cloudGetReport(srNo){
    if(!(await ensureCloud())) return null;
    try{
      const { data, error } = await db.from('service_reports').select('*').eq('sr_no', srNo).maybeSingle();
      if(error) throw error;
      return rowToReport(data);
    }catch(e){ console.error('cloud get report failed', srNo, describeCloudError(e)); return null; }
  }
  // Fallback lookup by primary key — used by the customer portal's
  // "Recent Service Reports" tile when a row's sr_no didn't resolve a
  // match via cloudGetReport (e.g. a duplicate/edited sr_no elsewhere in
  // the table breaking maybeSingle()'s single-row assumption). id is
  // always present and unique, so this path always finds the row if it
  // still exists.
  async function cloudGetReportById(id){
    if(!id || !(await ensureCloud())) return null;
    try{
      const { data, error } = await db.from('service_reports').select('*').eq('id', id).maybeSingle();
      if(error) throw error;
      return rowToReport(data);
    }catch(e){ console.error('cloud get report by id failed', id, describeCloudError(e)); return null; }
  }
  // History used to be hard-capped at the newest 150 reports with no indication
  // that anything had been cut off, so older jobs simply became invisible in the
  // app even though they were sitting in the database. Page through instead.
  const REPORT_PAGE = 200;      // Supabase caps a single response at 1000 rows
  const REPORT_MAX_ROWS = 5000; // hard stop so a huge table can't exhaust memory
  async function cloudListReports(){
    if(!(await ensureCloud())) return null;
    try{
      const rows = [];
      for(let from = 0; from < REPORT_MAX_ROWS; from += REPORT_PAGE){
        const { data, error } = await db.from('service_reports')
          .select('*')
          .order('date',{ascending:false})
          .order('sr_no',{ascending:false})   // stable tiebreak: without it, rows
                                              // sharing a date can repeat or be
                                              // skipped across page boundaries
          .range(from, from + REPORT_PAGE - 1);
        if(error) throw error;
        const batch = data || [];
        rows.push(...batch);
        if(batch.length < REPORT_PAGE) break;
      }
      return rows.map(rowToReport);
    }catch(e){ console.error('cloud list failed', describeCloudError(e)); return null; }
  }
  async function cloudNextSrNo(dateStr){
    if(!(await ensureCloud())) return null;
    try{
      // dateStr comes in as 'YYYYMMDD'; the Postgres function takes a real date.
      const iso = dateStr.slice(0,4)+'-'+dateStr.slice(4,6)+'-'+dateStr.slice(6,8);
      const { data, error } = await db.rpc('next_sr_no', { p_date: iso });
      if(error) throw error;
      return data;
    }catch(e){ console.error('cloud SR counter failed', describeCloudError(e)); return null; }
  }

  // ---------- password prompt ----------
  // window.prompt() was used for every admin-password gate. On iOS Safari that
  // dialog shows the typed password in clear text (and in screenshots), it can't
  // be styled to match the app, and several in-app browsers (Facebook, Messenger,
  // Gmail) block it outright — in which case prompt() returns null and the admin
  // could never get past the gate. This overlay is a proper masked input.
  function askPassword(opts){
    opts = opts || {};
    const overlay = $('adminPwOverlay');
    if(!overlay){
      // Extremely defensive: if the markup is missing, fall back rather than
      // leaving the caller hanging on a promise that never settles.
      return Promise.resolve(window.prompt(opts.label || 'Enter Admin Password') || null);
    }
    const input = $('adminPwInput'), msg = $('adminPwMsg');
    $('adminPwTitle').textContent = opts.title || 'Admin Password';
    $('adminPwLabel').textContent = opts.label || 'Enter Admin Password';
    input.placeholder = opts.placeholder || 'Password';
    input.value = '';
    msg.textContent = opts.message || '';
    overlay.classList.add('open');
    setTimeout(()=>{ try{ input.focus(); }catch(e){} }, 60);

    return new Promise(resolve=>{
      let done = false;
      function finish(value){
        if(done) return;
        done = true;
        overlay.classList.remove('open');
        input.value = '';   // never leave the password sitting in the DOM
        msg.textContent = '';
        cleanup();
        resolve(value);
      }
      const onOk = ()=> finish(input.value ? input.value : null);
      const onCancel = ()=> finish(null);
      const onKey = (e)=>{
        if(e.key==='Enter'){ e.preventDefault(); onOk(); }
        else if(e.key==='Escape'){ e.preventDefault(); onCancel(); }
      };
      const onBackdrop = (e)=>{ if(e.target===overlay) onCancel(); };
      function cleanup(){
        $('adminPwOk').removeEventListener('click', onOk);
        $('adminPwCancel').removeEventListener('click', onCancel);
        $('adminPwCancel2').removeEventListener('click', onCancel);
        input.removeEventListener('keydown', onKey);
        overlay.removeEventListener('click', onBackdrop);
      }
      $('adminPwOk').addEventListener('click', onOk);
      $('adminPwCancel').addEventListener('click', onCancel);
      $('adminPwCancel2').addEventListener('click', onCancel);
      input.addEventListener('keydown', onKey);
      overlay.addEventListener('click', onBackdrop);
    });
  }

  // ---------- outbox: pending cloud writes ----------
  // Anything saved while the phone has no usable connection used to be written
  // to local storage only and then forgotten: History falls back to local data
  // ONLY while still offline, so as soon as signal returned the offline work
  // became invisible and was never uploaded. The only recovery was the manual
  // "upload this device's data" button, which covered reports and field lists
  // but not DTR, customers, leave, cash advances or dispatch tickets.
  //
  // Every save helper now queues a pending operation instead, and the outbox is
  // flushed on app start, whenever the browser fires 'online', and after any
  // successful cloud call.
  const OUTBOX_PREFIX = 'outbox:';
  const SAVE_CLOUD  = 'cloud';   // written straight to the shared cloud
  const SAVE_QUEUED = 'queued';  // saved on this device, queued for upload
  const SAVE_FAILED = 'failed';  // could not be stored at all
  const outboxHandlers = Object.create(null);

  // Each module registers how to replay its own kind of pending write.
  // handler(id, payload) must throw if the cloud rejected the write; returning
  // normally is treated as success.
  function registerOutboxHandler(kind, handler){ outboxHandlers[kind] = handler; }

  function outboxKey(kind, id){
    // ':' is used as the separator, so keep ids from splitting the key.
    return OUTBOX_PREFIX + kind + ':' + String(id).replace(/:/g, '_');
  }
  // queueError: the error that caused this write to fall back to the queue,
  // when there WAS one. Queuing happens for two very different reasons —
  // genuinely offline (no error; the write was never attempted), or the
  // server rejected the write (RLS, a missing table, a stale schema cache,
  // bad data). Those used to look identical here, and the reason was only
  // captured later, on a replay attempt — so a strong-signal rejection
  // still displayed as "waiting for a connection", and discarding the item
  // before any retry threw the reason away with it. Recording it up front
  // means the banner tells the truth immediately.
  async function outboxQueue(kind, id, payload, queueError){
    try{
      const rec = { kind, id, payload, queuedAt: new Date().toISOString() };
      if(queueError){
        rec.lastError = typeof queueError === 'string' ? queueError : describeCloudError(queueError);
        rec.lastTriedAt = rec.queuedAt;
        syncLogRecord(kind, id, rec.lastError);
      }
      await window.storage.set(outboxKey(kind, id), JSON.stringify(rec), false);
      updateOutboxBadge();
      return true;
    }catch(e){ console.error('could not queue pending write', kind, id, describeCloudError(e)); return false; }
  }
  // ---- Persistent sync-failure log ----
  // Separate from the queue itself ON PURPOSE. Discarding a stuck item
  // deletes its recorded error along with it, which makes a failure
  // impossible to diagnose afterwards — exactly what happens when someone
  // in the field clears a banner to get on with their day. These entries
  // outlive the items they describe. Rolling cap so a device that's been
  // failing for days can't grow this without bound.
  const SYNC_LOG_KEY = 'sync-failure-log';
  const SYNC_LOG_MAX = 20;
  async function syncLogRecord(kind, id, errMsg){
    try{
      let log = [];
      try{
        const raw = await window.storage.get(SYNC_LOG_KEY, false);
        if(raw) log = JSON.parse(raw.value) || [];
      }catch(e){}
      log.unshift({ kind, id: String(id), error: String(errMsg||''), at: new Date().toISOString() });
      await window.storage.set(SYNC_LOG_KEY, JSON.stringify(log.slice(0, SYNC_LOG_MAX)), false);
    }catch(e){ /* logging must never break the thing it's logging about */ }
  }
  async function syncLogList(){
    try{
      const raw = await window.storage.get(SYNC_LOG_KEY, false);
      return raw ? (JSON.parse(raw.value) || []) : [];
    }catch(e){ return []; }
  }

  async function outboxList(){
    try{
      const res = await window.storage.list(OUTBOX_PREFIX, false);
      const items = [];
      for(const key of (res.keys||[])){
        try{
          const item = await window.storage.get(key, false);
          if(item) items.push(Object.assign(JSON.parse(item.value), {storageKey: key}));
        }catch(e){ /* skip an unreadable entry rather than stalling the queue */ }
      }
      // Oldest first, so work reaches the cloud in the order it was done.
      // String() matters: an entry written by an older build (or hand-edited)
      // could carry a numeric timestamp, and calling localeCompare on a number
      // throws — which the catch below would turn into an empty queue, hiding
      // the pending-sync banner and silently abandoning the user's offline work.
      items.sort((a,b)=> String(a.queuedAt||'').localeCompare(String(b.queuedAt||'')));
      return items;
    }catch(e){
      console.error('could not read the pending-sync queue', e);
      return [];
    }
  }
  async function outboxCount(){ return (await outboxList()).length; }

  // Wraps a single outbox handler call with a hard deadline. Without this, a
  // request that hangs instead of failing cleanly (common on mobile: a
  // WiFi->cellular handoff mid-request, a weak signal, a captive portal that
  // silently swallows HTTPS) never resolves AND never rejects — which used to
  // leave outboxFlushing stuck at true forever, since the surrounding
  // try/finally never gets to run. Every future call (the 30s timer, the
  // 'online' event, coming back to the foreground, and the Sync now button)
  // would then hit the very first line of outboxFlush and bail out silently,
  // making the button look like it had stopped working — with no way to
  // recover short of fully restarting the app. Racing each call against a
  // timeout guarantees the loop always moves on and the lock always clears.
  const OUTBOX_ITEM_TIMEOUT_MS = 20000;
  function withTimeout(promise, ms){
    return new Promise((resolve, reject)=>{
      const t = setTimeout(()=> reject(new Error('Timed out waiting for a response ('+Math.round(ms/1000)+'s)')), ms);
      promise.then(
        (v)=>{ clearTimeout(t); resolve(v); },
        (e)=>{ clearTimeout(t); reject(e); }
      );
    });
  }

  let outboxFlushing = false;
  async function outboxFlush(opts){
    opts = opts || {};
    if(outboxFlushing) return {sent:0, left:await outboxCount(), stuck:true};
    if(!(await ensureCloud())) return {sent:0, left:await outboxCount()};
    outboxFlushing = true;
    // A phone that's been asleep or backgrounded for a while can wake up with
    // a stale access token — supabase-js only auto-refreshes on a timer that
    // needs the tab to stay alive, so a long suspension can outlast it. Force
    // a refresh now, while we know we're online, before replaying anything —
    // otherwise every item in the queue fails with what looks like a
    // permissions error (RLS treats an expired token as unauthenticated) even
    // though the actual problem is just an out-of-date token.
    try{ await db.auth.refreshSession(); }catch(e){ /* fall through — the per-item attempts below will surface any real auth problem */ }
    let sent = 0, left = 0, lastError = null;
    try{
      const items = await outboxList();
      for(const item of items){
        const handler = outboxHandlers[item.kind];
        if(!handler){ left++; continue; }
        let ok = false, errMsg = null;
        try{ await withTimeout(handler(item.id, item.payload), OUTBOX_ITEM_TIMEOUT_MS); ok = true; }
        catch(e){ errMsg = describeCloudError(e); console.error('outbox replay failed', item.kind, item.id, errMsg); syncLogRecord(item.kind, item.id, errMsg); }
        if(ok){
          sent++;
          try{ await window.storage.delete(item.storageKey); }catch(e){}
        }else if(item.kind==='geo' && /42501|row-level security/i.test(errMsg||'')){
          // An RLS rejection is deterministic: this exact row will be
          // refused on every future retry too, so keeping it queued just
          // grows the queue forever and buries genuinely recoverable
          // failures behind hundreds of location points. Location data is
          // also self-superseding — the next successful point replaces
          // what this one would have said. The reason is already in the
          // persistent sync log, so the problem stays visible.
          //
          // ONLY 'geo'. A report, DTR entry, leave request or cash advance
          // is the user's actual work and is never auto-discarded, however
          // it failed.
          console.warn('outbox: discarding permanently-rejected location point', item.id, errMsg);
          try{ await window.storage.delete(item.storageKey); }catch(e){}
        }else{
          left++;
          lastError = errMsg;
          // Record the failure reason on the item itself (surfaced in the
          // "View" list) instead of only logging it to the console, since a
          // technician in the field has no way to open devtools. Previously
          // this loop also stopped at the very first failure on the
          // assumption that any failure meant the connection had dropped —
          // but a failure can just as easily be that ONE item's data being
          // rejected (e.g. a validation or permissions error on the server),
          // which used to permanently block every other, perfectly fine,
          // item queued behind it. Now every item gets its own attempt.
          try{
            await window.storage.set(item.storageKey, JSON.stringify(Object.assign(
              {}, item, {lastError: errMsg, lastTriedAt: new Date().toISOString()}
            )), false);
          }catch(e){}
        }
      }
    }finally{
      outboxFlushing = false;
    }
    if(sent && !opts.quiet) toast('Uploaded '+sent+' pending item'+(sent===1?'':'s')+' to the shared cloud');
    updateOutboxBadge();
    return {sent, left, lastError};
  }
  async function updateOutboxBadge(){
    const el = $('pendingSyncBanner');
    if(!el) return;
    const items = await outboxList();
    const n = items.length;
    el.style.display = n ? 'flex' : 'none';
    const label = $('pendingSyncText');
    if(label){
      const failed = items.filter(it=> it.lastError).length;
      // Three distinct states, because "unsent" has two very different
      // causes and conflating them is actively misleading: an item the
      // server REJECTED will never go through on its own no matter how
      // good the signal gets, and telling someone to wait for a connection
      // they already have just hides a real error.
      if(failed && failed === n){
        label.textContent = n+' item'+(n===1?'':'s')+' rejected by the server — tap View for the reason';
      }else if(failed){
        label.textContent = failed+' of '+n+' items rejected by the server — tap View for the reason';
      }else{
        label.textContent = n+' item'+(n===1?'':'s')+' saved on this device only — waiting for a connection';
      }
      el.style.background = failed ? '#8A2020' : '#8A5A00';
    }
  }
  window.addEventListener('online', ()=>{ outboxFlush(); });
  // Also retry when the app is brought back to the foreground, since phones
  // often reconnect while the screen is off and never fire 'online' again.
  document.addEventListener('visibilitychange', ()=>{
    if(document.visibilityState==='visible') outboxFlush({quiet:true});
  });
  // Safety net: the 'online' event is not reliable on mobile — a phone can
  // reconnect to wifi (especially waking from sleep, or switching between
  // wifi and cellular) without the browser ever firing it, which is what
  // made syncing look like it depended on manually tapping "Sync now".
  // Retry quietly in the background on a timer whenever something is
  // actually pending, so a restored connection gets picked up on its own.
  setInterval(()=>{
    outboxCount().then(n=>{ if(n) outboxFlush({quiet:true}); });
  }, 30000);
  // Reveal stranded offline work as soon as the bundle runs. This deliberately
  // does NOT wait for the startup data load: that chain can block for up to 12
  // seconds behind the CDN script timeout, and a technician who opens the app to
  // check whether yesterday's report went through should not stare at a screen
  // that says nothing for 12 seconds.
  updateOutboxBadge();

  const pendingSyncBtn = $('pendingSyncBtn');
  if(pendingSyncBtn) pendingSyncBtn.addEventListener('click', async ()=>{
    const res = await outboxFlush();
    if(!res.sent){
      if(res.stuck) toast('Still working on a previous sync — try again in a moment');
      else toast(res.left ? (res.lastError ? 'Upload failed: '+res.lastError : 'Still no connection — will keep trying') : 'Nothing pending');
    }
  });

  // Human-readable labels for each outbox "kind" — used only in the list below.
  const OUTBOX_KIND_LABELS = {
    'report': 'Service Report', 'dtr': 'DTR', 'leave': 'Leave Request',
    'cash-advance': 'Cash Advance', 'dispatch': 'Dispatch Ticket',
    'geo': 'Location Point'
  };
  async function renderPendingSyncList(){
    const listEl = $('pendingSyncList');
    if(!listEl) return;
    const items = await outboxList();
    const logHtml = await renderSyncLogHtml();
    if(!items.length){
      listEl.innerHTML = '<div class="empty-state">Nothing pending — everything on this device has synced.</div>' + logHtml;
      $('pendingSyncClearAllBtn').style.display = 'none';
      return;
    }
    $('pendingSyncClearAllBtn').style.display = '';
    listEl.innerHTML = items.map(item=>{
      const label = OUTBOX_KIND_LABELS[item.kind] || item.kind;
      const when = item.queuedAt ? new Date(item.queuedAt).toLocaleString() : '';
      const errorLine = item.lastError
        ? '<div style="font-size:12px; color:var(--danger); margin-top:2px;">Rejected: '+escapeHtml(item.lastError)+'</div>'
        : '<div style="font-size:12px; color:var(--text-muted); margin-top:2px;">Not sent yet — waiting for a connection</div>';
      return '<div style="display:flex; align-items:flex-start; justify-content:space-between; gap:10px; padding:10px 0; border-bottom:1px solid var(--border);">'
        + '<div><div style="font-weight:700; font-size:13.5px;">'+escapeHtml(label)+'</div>'
        + '<div style="font-size:12px; color:var(--text-muted);">'+escapeHtml(String(item.id))+(when?' · '+escapeHtml(when):'')+'</div>'
        + errorLine + '</div>'
        + '<button type="button" class="btn pendingSyncDeleteBtn" data-key="'+escapeHtml(item.storageKey)+'" style="flex:0 0 auto; padding:6px 10px; font-size:12.5px; background:#fdeceb; color:var(--danger);">Discard</button>'
        + '</div>';
    }).join('') + logHtml;
  }
  // Recent failures — shown whether or not anything is still queued, since
  // the whole point is that it outlives the items themselves.
  async function renderSyncLogHtml(){
    const log = await syncLogList();
    if(!log.length) return '';
    return '<div style="margin-top:18px; padding-top:12px; border-top:2px solid var(--border);">'
      + '<div style="font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:.4px; color:var(--text-muted); margin-bottom:8px;">Recent sync failures (last '+log.length+')</div>'
      + log.map(e=>
          '<div style="padding:7px 0; border-bottom:1px solid var(--border);">'
          + '<div style="font-size:12.5px; font-weight:700;">'+escapeHtml(OUTBOX_KIND_LABELS[e.kind]||e.kind)+'</div>'
          + '<div style="font-size:11.5px; color:var(--text-muted);">'+escapeHtml(e.at ? new Date(e.at).toLocaleString() : '')+'</div>'
          + '<div style="font-size:11.5px; color:var(--danger); word-break:break-word;">'+escapeHtml(e.error)+'</div>'
          + '</div>'
        ).join('')
      + '<button type="button" class="btn btn-secondary" id="syncLogClearBtn" style="width:100%; margin-top:10px; font-size:12.5px; padding:8px;">Clear this log</button>'
      + '</div>';
  }
  const pendingSyncViewBtn = $('pendingSyncViewBtn');
  if(pendingSyncViewBtn) pendingSyncViewBtn.addEventListener('click', async ()=>{
    await renderPendingSyncList();
    $('pendingSyncOverlay').classList.add('open');
  });
  const closePendingSyncBtn = $('closePendingSync');
  if(closePendingSyncBtn) closePendingSyncBtn.addEventListener('click', ()=> $('pendingSyncOverlay').classList.remove('open'));
  const pendingSyncOverlayEl = $('pendingSyncOverlay');
  if(pendingSyncOverlayEl) pendingSyncOverlayEl.addEventListener('click', (e)=>{
    if(e.target.id==='pendingSyncOverlay') pendingSyncOverlayEl.classList.remove('open');
  });
  const pendingSyncListEl = $('pendingSyncList');
  if(pendingSyncListEl) pendingSyncListEl.addEventListener('click', async (e)=>{
    if(e.target.closest('#syncLogClearBtn')){
      try{ await window.storage.delete(SYNC_LOG_KEY); }catch(err){}
      await renderPendingSyncList();
      return;
    }
    const btn = e.target.closest('.pendingSyncDeleteBtn');
    if(!btn) return;
    if(!confirm('Discard this item? It will NOT be uploaded and cannot be recovered.')) return;
    try{ await window.storage.delete(btn.dataset.key); }catch(err){}
    await renderPendingSyncList();
    updateOutboxBadge();
  });
  const pendingSyncClearAllBtn = $('pendingSyncClearAllBtn');
  if(pendingSyncClearAllBtn) pendingSyncClearAllBtn.addEventListener('click', async ()=>{
    const items = await outboxList();
    if(!items.length) return;
    if(!confirm('Discard all '+items.length+' pending item'+(items.length===1?'':'s')+'? None of it will be uploaded, and this cannot be undone.')) return;
    for(const item of items){ try{ await window.storage.delete(item.storageKey); }catch(err){} }
    await renderPendingSyncList();
    updateOutboxBadge();
  });
