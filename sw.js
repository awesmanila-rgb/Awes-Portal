// Bumped to v55 to force every installed device to drop its old cache and
// re-fetch index.html/css/app.css/app.bundle.js again — three changes that
// all need a fresh shell:
//   1. Customer portal Profile screen now shows a "Profile Information"
//      card (name, login email, contact person, contact number, property
//      address) plus Terms and Conditions / Privacy Notice screens
//      (customerLegalScreen) — new markup and new CSS.
//   2. The shared PDF preview overlay gained a Download button next to
//      Close (previewDownloadBtn), so every "View Full Report (PDF)" can
//      save the report without closing the preview.
//   3. Every remaining emoji across the whole system (sidebar nav, admin
//      and technician dashboards, DTR, dispatch, cash advance,
//      liquidation, leave, login) was replaced with inline SVG via the
//      shared icon()/dotIcon() helpers in core.js and the new .ic class in
//      app.css — emoji rendered differently on every OS/font and could not
//      inherit their container's color.
//
// Bumped to v52 to force every installed device to drop its old cache and
// re-fetch css/app.css/app.bundle.js again — reworked the customer Home
// screen's Quick Actions section (My units / Quotes and invoices /
// Service history / Get help) to match a reference screenshot's icon-grid
// menu format: a consistent 3-column grid at every screen width (was
// 2-column cards on tablet+ that collapsed into horizontal list rows
// under ~480px), each tile now centered icon-on-top with a single label
// below and no subtitle. The dynamic counts the old subtitles showed
// ("3 enrolled", "2 on file") are still visible one tap away inside each
// tile's destination screen. See the quick-actions block in
// initCustomerHomeScreen()/renderCustomerHome() (customer-portal.js) and
// .cp-quick-grid/.cp-quick-tile (app.css).
//
// Bumped to v51 to force every installed device to drop its old cache and
// re-fetch index.html/css/app.css again — rebalanced the account-picker
// screen's type scale (greeting/subtitle/label): greeting eased down from
// 32px to 28px, subtitle bumped up from 12.5px to 15px (new
// .cp-greet-sub-lg modifier, scoped to this screen), label eased down
// from 17px to 15px — closer sizes so the subtitle and label read as one
// connected line of copy instead of the subtitle all but disappearing
// under an oversized greeting.
//
// Bumped to v50 to force every installed device to drop its old cache and
// re-fetch index.html again — customer account-picker screen's header now
// also shows "Welcome to AWES customer portal" as a subtitle under the
// greeting, same .cp-greet-sub style already used on Home's own header.
//
// Bumped to v49 to force every installed device to drop its old cache and
// re-fetch index.html/css/app.css again — customer account-picker screen
// (shown once at fresh sign-in for a login linked to more than one
// customer): removed a redundant duplicate instruction ("Choose an
// account to view" in the header subtitle vs. a separate label saying
// almost the same thing), fixed that label sitting on the dark-green
// header with unreadable muted-grey text, then made it bigger/darker and
// bumped the greeting itself up to a large bold headline style (scoped to
// this screen only via .cp-header-picker/.cp-greet-lg — Home's own
// header/hero-card overlap sizing is untouched). Also in this pass:
// app.css now sets overflow-x:hidden on html/body alongside the existing
// overscroll-behavior:none, since the page could still drift sideways on
// a touch drag if anything on it was a pixel wider than the viewport, and
// customer-portal.js adds a hand-rolled pull-to-refresh (drag down from
// the top of Home or the account picker) since overscroll-behavior:none
// also kills Android's native pull-to-refresh as a side effect.
//
// Bumped to v48 to force every installed device to drop its old cache and
// re-fetch index.html/css/app.css/app.bundle.js again — applied the same
// treatment as the equipment detail screen to the request-service screen
// (customerRequestsScreen): wrapped its content in the shared
// .cp-page-content inset (was edge-to-edge, same root cause as the
// equipment detail screen's earlier fix — renamed .cp-detail-content to
// .cp-page-content since it's now shared by both), replaced its emoji
// (🛠️/📋) with inline SVGs, and gave its "‹ Back to Home" text button the
// same emphasized circular icon treatment as the equipment detail screen
// (it had been left as plain text when that change was made, which broke
// under the new .cp-back-btn circle sizing).
//
// Bumped to v47 to force every installed device to drop its old cache and
// re-fetch index.html again — pinch-to-zoom is now disabled
// (maximum-scale=1.0, user-scalable=no on the viewport meta tag), per
// explicit request, reversing an earlier deliberate accessibility
// tradeoff (see the comment on that meta tag in index.html).
//
// Bumped to v46 to force every installed device to drop its old cache and
// re-fetch index.html/css/app.css again — the equipment detail screen's
// "‹ Back to Home" text link is now an icon-only, emphasized circular
// back button (solid green-dark fill, arrow icon) instead of blending in
// as plain body text.
//
// Bumped to v45 to force every installed device to drop its old cache and
// re-fetch index.html/css/app.css again — replaced the equipment detail
// screen's emoji (❄️/📍/📷/📋/＋) with inline SVG icons for a consistent
// look across platforms (emoji rendering varies a lot by OS/browser font).
//
// Bumped to v44 to force every installed device to drop its old cache and
// re-fetch index.html/css/app.css again — the equipment detail screen
// (customerEquipmentDetailScreen) still used the older shared .card
// component with no side inset of its own, so with .cp-screen's -16px
// margin cancelling the base padding, its cards ran edge-to-edge with no
// side margin at all on mobile, and unbounded-width on desktop. Wrapped
// its content in a new .cp-detail-content container (20px inset on
// mobile matching the header/home-screen, wider + centered on desktop).
//
// Bumped to v43 to force every installed device to drop its old cache and
// re-fetch app.bundle.js again — equipDisplayName() now falls back to the
// unit's location before the EQ-XXXXXXXX short id, so an un-labeled unit
// shows something like "Living Room" instead of a raw id whenever a
// location has been recorded for it. See core.js.
//
// Bumped to v42 to force every installed device to drop its old cache and
// re-fetch app.bundle.js again — unit card link now reads "View details"
// instead of "View unit".
//
// Bumped to v41 to force every installed device to drop its old cache and
// re-fetch css/app.css/app.bundle.js again — reworked the home screen to
// match a reference mock: the header is now solid dark green with rounded
// bottom corners and the hero card overlaps up into it as one connected
// block; the "no active service" state now carries its own icon/heading/
// button (the separate booking banner is hidden for that state only); and
// the unit-card layout changed from a full-height edge-to-edge photo to an
// inset photo with a floating state badge and a full-width status/footer
// row. See cpHeroAllClear()/cpUnitCardHtml() in customer-portal.js.
//
// Bumped to v40 to force every installed device to drop its old cache and
// re-fetch css/app.css again — unified the customer portal home screen's
// horizontal spacing (header/hero/booking-banner/sections/billing-card
// were a mix of 16px and 18px insets) to one consistent 20px so the
// greeting text isn't tighter to the edge than the cards below it.
//
// Bumped to v39 to force every installed device to drop its old cache and
// re-fetch app.bundle.js again — fixed "My units" (and every other bottom
// nav tab) sometimes opening to an empty/"No equipment enrolled" screen:
// cpShowScreen() was re-running the full customer-data reload (which
// resets cpEquipment to [] before its fetch resolves) on every tab
// switch, and could paint the tab with that empty array before the real
// data came back. See cpEnterPortalShell() in
// js/modules-src/customer-equipment-history.js.
//
// Bumped to v38 to force every installed device to drop its old cache and
// re-fetch index.html/css/app.css/app.bundle.js again — a stale cached shell
// on some devices was showing a mismatched customer-portal layout (bottom
// nav labels clipped, a leftover full-size logo image below the page
// content) because the cached index.html/CSS predated the customer-portal
// nav fixes below. See the .cp-nav rules in css/app.css.
//
// Bumped to v37 to force every installed device to drop its old cache and
// re-fetch index.html/app.bundle.js again — the customer portal's photo
// gallery now always shows the folder name above each group of photos
// (previously only shown when a unit had more than one folder), so
// customers always know which folder's photos they're looking at.
//
// Bumped to v36 to force every installed device to drop its old cache and
// re-fetch index.html/app.bundle.js again — adds the Equipment Photos
// feature (upload/view/organize per unit): new markup in index.html
// (equipmentPhotoFileInput etc., cpDetailPhotoGrid) and new functions in
// app.bundle.js (equipment-photos.js module) that v35's cached copies
// don't have. Also includes the fix in doLogout()/openCustomerEquipmentDetail()
// (customer-equipment-history.js) for a previous customer's equipment
// photos briefly flashing on screen after a different customer logs in.
//
// Bumped to v35 to force every installed device to drop its old cache and
// re-fetch app.bundle.js again — v34's fix stopped duplicate rows via
// content-comparison, but that comparison itself could reject (or merge)
// two genuinely different units that happen to share every recorded field.
// Equipment identity is now decided once, explicitly, by which action
// added it (picked from "Select Existing", or freshly typed via "+ Add
// New") and carried forward as a real id from that point on — see
// equipPickedId in app.bundle.js — never re-guessed from field content.
const CACHE_NAME = 'awes-sr-v55';

// Split into two lists on purpose.
//
// Previously everything below lived in one array passed to cache.addAll(), which
// is atomic: if a SINGLE entry fails, the whole promise rejects and nothing at
// all gets cached. Two entries — icon-192.png and icon-512.png — did not exist
// in the package, so the rejection was guaranteed, and it was swallowed by a
// bare .catch(()=>{}). The result was a service worker that installed
// "successfully" while caching precisely nothing, so the app never actually
// worked offline. It only appeared to, because the runtime fetch handler
// gradually filled the cache while the phone still had signal.
const LOCAL_SHELL = [
  './index.html',
  './manifest.json',
  './logo.png',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
  './css/app.css',
  './js/app.bundle.js'
];

const CDN_SHELL = [
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.5.25/jspdf.plugin.autotable.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/signature_pad/5.1.3/signature_pad.umd.min.js',
  'https://cdn.jsdelivr.net/npm/@emailjs/browser@4/dist/email.min.js',
  // Not precached: it's only fetched the first time someone actually taps
  // "Scan Nameplate", and it's multiple MB (JS + WASM + trained data) —
  // precaching it on install would slow first load for everyone to help
  // only the technicians who use that one feature.
];

function isAppShellDoc(url){
  return url.endsWith('index.html') || url.endsWith('manifest.json')
      || url.endsWith('app.bundle.js') || url.endsWith('app.css') || url.endsWith('/');
}

// Caches each entry independently so one bad URL can never wipe out the rest,
// and logs whatever failed instead of hiding it.
async function precache(cache, urls, opts){
  const failed = [];
  await Promise.all(urls.map(async (url)=>{
    try{
      // CDN responses are opaque cross-origin; request them explicitly in
      // no-cors mode so they can still be stored.
      const req = /^https?:\/\//.test(url) ? new Request(url, {mode:'no-cors'}) : url;
      await cache.add(req);
    }catch(e){
      failed.push(url);
    }
  }));
  if(failed.length) console.warn('[sw] could not precache', opts && opts.label, failed);
  return failed;
}

self.addEventListener('install', (event) => {
  event.waitUntil((async ()=>{
    const cache = await caches.open(CACHE_NAME);
    // The local files are what make the app usable offline, so treat a failure
    // here as loud. The CDN libraries are best-effort: the fetch handler will
    // pick them up later if they are missing.
    const missing = await precache(cache, LOCAL_SHELL, {label:'local shell'});
    if(missing.length) console.error('[sw] app shell incomplete, offline use may be degraded:', missing);
    await precache(cache, CDN_SHELL, {label:'CDN libraries'});
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async ()=>{
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

// SKIP_WAITING message support — lets index.html's "new version available"
// banner apply an update immediately instead of waiting for all tabs to close.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = event.request.url;

  // Never touch API traffic. Supabase REST/Auth/Storage/Functions calls and the
  // reverse-geocode lookup must always go to the network: caching them would
  // serve stale reports and stale auth responses, and a cached POST-like GET
  // could show one technician another's data.
  if (/\/(rest|auth|storage|functions|realtime)\/v1\//.test(url)
      || url.includes('nominatim.openstreetmap.org')
      || url.includes('api.emailjs.com')) {
    return;
  }

  if (event.request.mode === 'navigate' || isAppShellDoc(url)) {
    // Network-first for the app shell — always show the latest deploy when
    // online, fall back to cache only when offline.
    event.respondWith(
      fetch(event.request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200 && networkResponse.type !== 'opaque') {
            const clone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone)).catch(()=>{});
          }
          return networkResponse;
        })
        .catch(async () => {
          const cached = await caches.match(event.request);
          // A navigation with nothing cached for that exact URL still needs a
          // document, otherwise the browser shows its own offline error page.
          return cached || await caches.match('./index.html') || Response.error();
        })
    );
    return;
  }

  // Cache-first for CDN libraries — they change rarely, prefer speed/offline.
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const fetchPromise = fetch(event.request)
        .then((networkResponse) => {
          if (networkResponse && (networkResponse.status === 200 || networkResponse.type === 'opaque')) {
            const clone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone)).catch(()=>{});
          }
          return networkResponse;
        })
        .catch(() => cached);
      return cached || fetchPromise;
    })
  );
});
