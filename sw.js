// Bumped to v99 — the "Apply to this N equipment then edit later" checkbox
// never showed its tick. Its own change handler calls srRenderOpUnitTabs(),
// which rebuilds the unit card via innerHTML — recreating the checkbox
// unchecked in the same tick it was ticked. The copy itself worked; only
// the visual confirmation was lost, so it read as a dead control. The
// checked state now lives in srOpApplyAllChecked, which survives the
// re-render and is rendered back into the input; a new batch resets it.
//
// Bumped to v98 — five fixes:
//  1. Suggestion dropdowns removed from Operating Data. Amperage, voltage,
//     pressure, temperature and airflow are MEASURED off the unit in front
//     of the technician; offering past readings from other units as
//     pickable options is useless and a way to put a wrong number on a
//     report. attachAllCombos now skips the whole 'Operating Data' group.
//  2. Preview in batch mode built only the FIRST report, so the other
//     units' reports went out having never been looked at. It now builds
//     and shows every one, each with its own equipment fields and its own
//     per-unit readings, exactly as submitBatchReports will.
//  3. Preview zoom (50%-300%, +/- and Fit). A report scaled to fit a phone
//     is unreadable, and this is the last look anyone gets before the
//     customer signs.
//  4. Saved Draft tile no longer routes through srShowEntry(null), which
//     re-revealed a form section on the way out and could flash before the
//     panel switched; it hides the entry screens directly.
//  5. The all-units jump list from v97 is reachable from the "View all
//     units" chip in the Operation Parameters header and the counter on
//     the unit card — both appear only in Multiple Reports mode (2+ units).
//
// Bumped to v97 — reading-status visibility on Operation Parameters.
//
// 1. STATUS BADGES (Empty / Partial / Complete, with an n/total count) on
//    the unit card, so a tech can see at a glance which units still need
//    readings. "Required" adapts to the phase toggle: a single-phase unit
//    has no L2/L3 or L23/L31, and counting those would leave every
//    single-phase unit permanently stuck at Partial.
// 2. ALL-UNITS LIST (#srOpListOverlay) as a second way in — from a "View
//    all units" chip in the step header, or the counter on the unit card.
//    Shows every unit with its badge and jumps straight to whichever is
//    tapped, so checking completeness across ten-plus units doesn't mean
//    swiping through them one by one. Opening it stashes whatever is on
//    screen first, or the unit being edited would report its last SAVED
//    status rather than what was just typed.
//    The chip is a separate control rather than the header itself, since
//    the header already toggles the card's collapse.
//
// Bumped to v96 — 3-phase placeholders are now A1/A2/A3 and V1/V2/V3 with
// the numbers as real subscripts, using Unicode U+2081..2083 (A\u2081 etc).
// An input placeholder is plain text, so <sub> markup is not possible
// there; the Unicode characters are the only way to get true subscripts.
// The A/V prefixes also keep each row self-identifying on mobile, where
// the row-label column is hidden. Single-phase still reads "Amps"/"Volts",
// and the static markup now says that too — it previously shipped "L1"/
// "L12", which flashed on screen before srApplyPhaseMode corrected it.
//
// Bumped to v95 — Operation Parameters on a phone. The table carries
// min-width:520px to fit the row-label column plus Before/After, so on a
// narrow screen it either scrolled sideways or squeezed the inputs. On
// mobile (<=700px) the row-label column is now hidden and each field
// identifies itself by its placeholder; desktop keeps the labelled table
// unchanged. Two prerequisites for that: Supply Air Temp and Air Volume
// Flow Rate had NO placeholders at all (they rendered as blank boxes with
// the labels hidden — visible in the report), so they got them; and the
// first box of the amperage/voltage rows now reads "Amps L1" / "Volts L12"
// in 3-phase mode rather than a bare "L1", which without the label column
// said nothing about which measurement the row was.
//
// Bumped to v94 — Operation Parameters reworked.
//
// Multiple Reports: the unit TAB STRIP is replaced by a one-unit card —
// the equipment name, the note "Record all readings for this particular
// unit", a "Unit 2 of 5 · N with readings" counter, left/right arrows to
// step between units, and a switch reading "Apply to this N equipment then
// edit later". The tab strip showed every unit at once, which made it easy
// to lose track of which unit the fields on screen belonged to. The switch
// is a ONE-TIME copy on purpose: "then edit later" means each unit stays
// independently editable afterwards, so a live link would silently
// overwrite those edits. It refuses to copy empty readings.
//
// Electrical fields now default to SINGLE phase — one Amperage box, one
// Voltage box. Three boxes per row applied to every unit regardless, and
// most are single-phase; three empty boxes invite blank or guessed
// readings, and a blank reading on a service report is worse than no row.
// A "This unit is 3-phase" toggle reveals L2/L3 and L23/L31 and switches
// the row labels and placeholders. Switching back CLEARS the extra fields,
// so a hidden box can't put an L2/L3 reading on a report whose author was
// told the unit is single-phase.
//
// Bumped to v93 — Multiple Reports dead-ended on "Step 1 of 8 · Equipment
// Details" with nothing on screen and no Next button. Batch mode fills
// equipment details per unit at submit time, so srApplyJobOrderBatch hides
// that card — but when the wizard was rewritten, srSectionIsSkipped lost
// its batch check, so the wizard still treated section 2 as the current
// step and parked on a hidden card. Restored the skip, and
// srApplyJobOrderBatch now explicitly lands on the first step that
// actually exists. Also refreshed the batch banner text, which still
// referred to "Section 2" and "Section 8" from the pre-wizard numbering
// and said nothing about Operation Parameters being per-unit.
//
// Bumped to v92 — the Single/Multiple "loop" again. v91 fixed the real
// detached-node bug, but the screen still READ as a bounce back to the job
// order list, because the unit list is rendered INSIDE the job order card:
// re-showing that card with every other job order still listed below is
// visually identical to being sent back to "Select From Job Order". Now
// choosing Single or Multiple hides every other job order row, hides the
// chosen row's own header, and retitles the card to "Select unit for this
// report — JO-...", so the unit step reads as its own screen. The
// single-unit case goes through the same path instead of expanding
// inline. srRenderJobOrderPicker restores the original title and rows on
// any re-render.
//
// Bumped to v91 — tapping Single/Multiple bounced straight back to the job
// order list, and picking a job order bounced back to Single/Multiple.
// Both tile handlers called srRenderJobOrderPicker(), which REBUILDS the
// whole list — detaching the pendingWrap element those same handlers close
// over. The units were then appended to an orphaned node (invisible) while
// the screen showed a freshly-rebuilt picker, which read as a loop between
// the two screens. They now render into the EXISTING pendingWrap and just
// re-show the job order card; the setTimeout that papered over the timing
// is gone too. Back on that screen also now returns to the job order list
// it was reached from, instead of the Create New / Saved Draft tiles two
// steps earlier.
//
// Bumped to v90 — REAL cause of admin-dispatched jobs never reaching the
// customer portal: service_requests has NO admin INSERT policy. 20260910_02
// created "customers insert own service requests" (requires the row's
// customer_id to belong to the CALLER via customer_login_links), plus admin
// SELECT and admin UPDATE — but nothing lets an admin INSERT. So
// srCreateForAdminDispatch's insert was refused by RLS with 42501 every
// time, the customer-facing row was never created, and the portal had
// nothing to show. Fixed by 20260916_04_admin_insert_service_requests.sql,
// which must be run.
//
// v89's typed-vs-selected confirm prompt is removed: a ticket is always
// raised against a customer already on file, so that theory was wrong. The
// stale-customerId clearing and the surfaced error toast from v89 are kept
// — the silent failure is what hid this for so long.
//
// Bumped to v89 — a directly-created dispatch ticket still wasn't showing
// on the customer portal. The customer-facing row is only created when
// custId exists, and custId is stamped ONLY by picking a customer from the
// combo's dropdown — typing the name leaves it unset. Every failure along
// that path was silent, so it looked like dispatch simply doesn't reach
// the customer. Three fixes:
//   1. Saving a ticket whose customer was typed rather than selected now
//      warns explicitly that the customer will NOT see it, and asks for
//      confirmation.
//   2. Typing after picking now CLEARS the stored id, which previously
//      left the ticket linked to the PREVIOUS customer while showing the
//      new name.
//   3. srCreateForAdminDispatch reports its error with a toast instead of
//      only console.error, and the caller flags a null result.
//
// Bumped to v88 — equipment location printed twice ("Bible House — Bible
// House · Koppel · ..."). equipDisplayName() (core.js) falls back to
// equipLocation when a unit has no label, and the summary builders then
// listed equipLocation again in the details, so EVERY unlabelled unit —
// which is most of them — showed its location as both the name and the
// first detail. Fixed in all three builders (dtEquipSummaryLine in
// dispatch.js, equipSummaryLine in customers.js, and the customer
// portal's equipment <option>): the location is included in the details
// only when it isn't already serving as the name. A unit WITH a label is
// unaffected and still shows "ACU-1 — Bible House · Koppel".
//
// Bumped to v87 — the "Select From Job Order" card stayed pinned above
// every step of the wizard. Two causes, both fixed:
//   - srShowEntry re-SHOWED it on every srShowEntry(null) call, not just
//     for the Create New tile. It now only ever hides it there; showing it
//     is Create New's job alone.
//   - Nothing hid it once a unit was actually picked. Now hidden in all
//     three paths that put a unit in play — srApplyJobOrder,
//     srApplyJobOrderBatch and srResumeDraft — right where the equipment
//     tab bar is hidden, so choosing a unit moves straight to the first
//     step with nothing left above it.
//
// Bumped to v86 — the equipment Existing / "+ Add New" tab bar was still
// showing after picking a unit. v84's fix was in the wrong place: it
// checked srCurrentTicketId from inside srRevealSections, but that runs
// via revealSectionsAfterCustomer(), which srApplyJobOrder calls BEFORE it
// assigns srCurrentTicketId — so the check read null every time and left
// the bar up. Now hidden inside srApplyJobOrder and srApplyJobOrderBatch,
// immediately after that id is set, and restored to flex by resetForm for
// ad-hoc reports with no job order. Also dropped the leftover
// scrollIntoView to section 1 there: section 1 is no longer a step, and
// srGoToSection already scrolls to the top.
//
// Bumped to v85 — the Saved Draft tile still went nowhere. v82 fixed the
// ARGUMENT ('drafts' -> 'draft') but not the FUNCTION NAME: it called
// showServiceReportTab, which does not exist anywhere in the codebase —
// the real one is srShowTab. Because the call sat behind a
// `typeof ... === 'function'` guard it failed silently instead of
// throwing, which is exactly why it looked like a dead button twice.
// Swept the whole codebase for the same pattern; this was the only one.
//
// Bumped to v84 — selecting an existing unit appeared to jump to
// "+ Add New". It wasn't creating a duplicate: that tab is really just the
// editable-fields panel, and picking a unit fills those fields and stamps
// the record's real id (setEquipPickedId) so saving UPDATES that unit. But
// a tab labelled "+ Add New" showing an existing unit's details reads like
// the app threw the selection away. Inside the wizard the bar is redundant
// anyway — the unit was chosen two screens earlier — so it's hidden
// whenever there's a job order behind the report, leaving Step 1 as a
// plain "review and edit these details". Still shown for an ad-hoc report
// with no job order, where choosing existing-vs-new genuinely applies.
//
// Bumped to v83 — ONE section on screen at a time, everywhere. Three
// places still revealed every section card at once, so despite the wizard
// the old wall of fields came back:
//   - history.js, resuming a SAVED DRAFT (the visible case) — it revealed
//     sec2..sec8 together and expandAllSections()'d them. A draft now
//     resumes inside the wizard at the first step and walks forward, same
//     as a new report; landing at the last step instead would skip
//     whatever the draft is still missing.
//   - customers.js fallback path (wizard helpers unavailable) — now shows
//     only the first step.
//   - ui.js resetForm — its hard-coded list stopped at sec8, so the two
//     signature steps added when Acknowledgment was split (sec9/sec10)
//     stayed on screen after a reset. Now loops every step card.
//
// Bumped to v82 — four wizard fixes from testing:
//
// 1. EVERY STEP OPENED COLLAPSED. srRevealSections showed the step's CARD
//    but these are collapsible cards whose body starts display:none, so
//    the technician had to tap the header open on every single step.
//    Now force-expands the current step's body.
// 2. THREE STACKED PROGRESS INDICATORS -> ONE. The four-stage tracker
//    (Job Order Selected / Details Filled / Signed / Submitted), the
//    "Section X of Y" line and the numbered chip row all rendered at once,
//    saying overlapping things. Replaced by a single section-driven
//    progress line ("Step 3 of 9 · Report Summary" + bar). The chip row is
//    gone: only the CURRENT section is shown, as asked. "of N" counts only
//    the steps that actually exist, so it stays truthful when Installation
//    Parameters is toggled off.
// 3. "SELECT FROM JOB ORDER" WAS VISIBLE UNDER THE ENTRY TILES. It is its
//    own step and is now hidden until Create New is tapped.
// 4. SAVED DRAFT WENT NOWHERE: the tile called showServiceReportTab with
//    'drafts'; the real tab name is 'draft', so it silently matched
//    nothing and left a blank screen.
//
// Bumped to v81 — completes the wizard's two remaining gaps.
//
// 1. MULTIPLE REPORTS now records Operation Parameters PER UNIT. Batch
//    previously copied one set of readings onto every unit, which is
//    fabricating measurements. Done as a unit TAB STRIP inside that one
//    step (srRenderOpUnitTabs/srOpParamsFor in ui.js) rather than a
//    Next-per-unit loop: five units as five near-identical screens gives
//    no sense of progress and makes it easy to tab past one unnoticed.
//    Tabs tick once a unit has readings. submitBatchReports applies each
//    unit's own values and blanks anything unfilled, so no unit ever
//    inherits another's numbers. Everything else stays shared.
// 2. ADD NEW EQUIPMENT on the unit picker: opens the report against the
//    same job order with equipment fields blank and the "+ Add New" tab
//    active. Saving registers it permanently to the customer through
//    cloudAddCustomerEquipment, so it is in their equipment list from then
//    on — not a one-off typed into a single report.
//
// Bumped to v80 — Service Report rebuilt as a step-by-step wizard.
//
// Entry: Report -> "How to file a Service Report" gate with I Understand
// (ONCE PER SESSION, not every tap) -> Create New / Saved Draft tiles ->
// job order list -> Single Report / Multiple Reports tiles -> unit.
//
// The form is now one screen per step with Back and Next on each:
//   1 Equipment Details   2 Report Summary   3 Components / Parts Needed
//   4 Works Done to this unit   5 Operation Parameters
//   6 Installation Parameters (behind a toggle; skipped when off)
//   7 Time & Remarks   8 Technician Signature   9 Customer Acknowledgment
// Section 8 was split into steps 7-9 (Time & Remarks / technician sig /
// customer sig + Preview) keeping every element id identical, so the
// signature pads, preview and PDF code needed no changes. Customer's
// Information is no longer a step at all — it comes from the Job Order and
// the technician cannot edit it. Time In/Out are relabelled Time Started /
// Time Finished.
//
// The Findings, Recommendations and Works Done suggestion dropdowns needed
// no new work: findings/recs/servicesDone were already in FIELD_META and
// already admin-editable through Manage Dropdown Lists. "Services Done"
// is relabelled "Works Done" there to match the new step name.
//
// Bumped to v79 — the Service Report now opens at Section 3 (Report
// Summary) rather than 4. The Job Order prefills that section's trouble
// call, but Findings and Recommendations start empty, so treating it as
// "already filled" let a technician reach the signatures without ever
// being asked for the substance of the report. Sections 1 and 2 are still
// skipped when the Job Order filled them.
//
// Bumped to v78 — two refinements to the progressive Service Report:
//
//   1. ONE SECTION AT A TIME. Revealed sections used to stay on screen, so
//      by the end the page was all eight again — rebuilding the exact wall
//      of fields progressive disclosure exists to avoid. Only the current
//      section's card now renders. Earlier sections stay reachable through
//      a new chip navigator (#srSectionNav) rather than by scrolling past
//      hidden cards.
//   2. SKIP WHAT THE JOB ORDER ALREADY FILLED. srApplyJobOrder populates
//      customer details (sec 1), the equipment fields (sec 2) and the
//      trouble call (sec 3), so the form now opens at the first section
//      that actually needs input — normally 4, Components/Parts — instead
//      of making the technician page through three screens of read-only
//      data they didn't type. srSectionPrefilled/srFirstUnfilledSection in
//      ui.js decide this from the actual field values, so if a Job Order
//      is missing something (no email on file, no trouble call) it still
//      lands on that section rather than skipping past a gap.
//
// The footer now keys off the CURRENT section rather than the furthest
// reached, so it shows only while Acknowledgment is the section on screen.
//
// Bumped to v77 — the Service Report footer ("Save Draft & Create New" /
// "Generate & Share Report") was pinned to the screen for the whole
// "Create New" tab. That was right when every section rendered at once,
// but after v71 made the sections progressive it meant offering to
// generate and share a report while the technician was still on Section 1.
// It now appears only once the last section (8, Acknowledgment — where the
// signatures are) has actually been reached, and stays put after that so
// they can scroll back up to edit and return. srUpdateFooterBar() in ui.js
// owns the decision; resetForm, srRevealSections, srSetAllSectionsRevealed
// and the tab switch in home.js all defer to it. Opening a saved draft
// still shows it immediately, since that reveals every section at once.
//
// Bumped to v76 — pre-deploy review pass. Two real bugs found by checking
// every dynamically-created element that is read through $():
//
// $() memoizes a node by id FOREVER (domCache in core.js). That is fine for
// static markup, but any element destroyed and recreated by an innerHTML
// rebuild keeps returning the ORIGINAL, now-detached node — reads give
// stale values and listeners attach to nothing.
//   - dtCloseRemarks (dispatch.js): dtCloseSection is rebuilt on every
//     ticket overlay open, so from the SECOND job order onward the close
//     remarks a user typed were read off a detached node and silently
//     dropped.
//   - The three customer calculators (customer-portal.js): cpCalcBody is
//     rebuilt each time a calculator opens, so switching between them and
//     back left every input and result element stale.
// Added $live() in core.js (uncached lookup) and switched those 20 reads
// to it. srFeeAcceptBtn was already handled correctly via querySelector.
//
// Also verified this pass: bundle executes cleanly under jsdom for all
// three roles (tech/admin/customer), no duplicate HTML ids, no $() refs to
// elements that never exist, sw.js parses, the VAPID public key in push.js
// matches PUSH_SETUP.md, and every column srCreateForAdminDispatch writes
// is backed by a migration.
//
// Bumped to v75 — CRITICAL FIX for a blank, unresponsive page introduced
// in v71 (the progressive Service Report). ui.js calls resetForm() at load,
// and resetForm() assigns srMaxSection — but that `let` was declared
// further down the file, AFTER its own call site. In a module joined into
// one strict-mode IIFE that leaves it in the temporal dead zone, so load
// threw "Cannot access 'srMaxSection' before initialization", the whole
// bundle aborted, and every screen stayed hidden: static markup like the
// nav bar rendered, nothing else did. srInstallContinueButtons() had the
// same problem via SR_SECTION_TITLES. Both declarations now sit at the top
// of the module, above any load-time call.
//
// Worth remembering: `node --check` does NOT catch this. It is valid
// syntax and only fails when executed, so the bundle has to actually be
// run against a DOM to see it.
//
// Bumped to v74 to force every installed device to drop its old cache and
// re-fetch everything — real Web Push notifications for all three roles.
// Until now every "notify" was in-app only: a Realtime badge/toast that
// only fired while the app was open and focused, which misses exactly the
// moments that matter. Now the device shows a real OS notification (sound,
// lock screen, notification tray) with the app closed.
//
// Pieces: push_subscriptions table (20260916_03), the send-push Edge
// Function (supabase/functions/send-push), the push/notificationclick
// handlers at the bottom of this file, and js/modules-src/push.js.
//
// Events wired: new service request -> admins; fee proposed and schedule
// proposed -> that customer; schedule confirmed and cancellation requested
// -> admins; job order created -> each assigned technician + the customer;
// en route and arrived -> the customer; job order closed -> admins, and
// the customer when it completed with no remaining work.
//
// Notes: sound is NOT forced — leaving `silent` false lets Android play the
// user's own notification sound and honour Do Not Disturb. Permission is
// asked from an in-app toggle (admin cloud sheet / technician profile /
// customer profile), never on load, because a dialog shown before someone
// understands what it's for gets dismissed, and dismissal is sticky.
// Signing out drops only THIS device's subscription. Every send is
// best-effort and never awaited: a failed notification must not stop the
// action that triggered it.
//
// Bumped to v73 to force every installed device to drop its old cache and
// re-fetch js/app.bundle.js again — fixes the runaway pending-sync queue
// of Location Points failing with 42501 (row-level security violation on
// technician_location_history).
//
// That table's INSERT policy is `technician_id = auth.uid()`. The point was
// stamped with currentUser.id, which is restored from localStorage on app
// start and can outlive the auth session it came from — and the outbox is
// device-wide, not per-user, so a point queued by one account could also
// be replayed under another. Either way auth.uid() no longer matches the
// stamped id, the row is refused, and since an RLS rejection is
// deterministic it was then retried forever.
//
//   - New cloudAuthUid() (core.js) reads the LIVE session's user id.
//   - trackerPushLocation stamps points with that instead of
//     currentUser.id, and when there is no session it stops broadcasting
//     rather than queuing rows that can never pass the check.
//   - outboxFlush auto-discards a 'geo' item rejected with 42501: the
//     same row will be refused on every retry, and location data is
//     self-superseding. The reason is still written to the persistent sync
//     log, so the problem stays visible. ONLY 'geo' — a report, DTR entry,
//     leave request or cash advance is the user's actual work and is never
//     auto-discarded, however it failed.
//
// Bumped to v72 to force every installed device to drop its old cache and
// re-fetch js/app.bundle.js again — a dispatch ticket admin creates
// DIRECTLY (preventive maintenance, a phone-in job) never appeared on the
// customer's portal. The customer home screen (renderCustomerHero) is
// driven entirely by service_requests rows, and only tickets CONVERTED
// from an existing customer request ever got one (srLinkTicket). A
// standalone ticket had no row behind it, so the customer saw no
// active-service card, no progress tracker, no technician name, and had
// nothing to message about — even though the job was real and scheduled.
// dtCreateTicket now calls srCreateForAdminDispatch() when there's no
// originating request, inserting a matching row already at 'dispatched'
// and linked to the ticket, so the entire existing customer-facing
// pipeline (hero, tracker, en-route/complete sync, cancellation) works
// for these tickets unchanged. Equipment is carried over only when the
// ticket covers exactly one unit, since the request row holds a single
// equipment_id. Needs 20260916_02_admin_dispatch_origin.sql, which widens
// the origin CHECK to allow 'admin_dispatch'.
//
// Bumped to v71 to force every installed device to drop its old cache and
// re-fetch index.html/css/app.css/js/app.bundle.js again — the Service
// Report form is now progressive. Sections 2-8 used to all appear at once
// the moment a customer was set, which is a wall of fields on a phone in
// the field. Each section body now ends with a Continue button that
// reveals the next one (srInstallContinueButtons/srGoToSection in ui.js),
// grouped by the report's own existing sections rather than any new
// split. Notes:
//   - Only Section 1 gates progress (name/date/valid email — the same
//     fields validate() already required). Every other section continues
//     freely: gating optional sections would make disclosure an obstacle
//     instead of a simplification.
//   - Revealed sections STAY revealed, so going back to change something
//     never means re-walking the form.
//   - The step tracker stays visible throughout and gained a persistent
//     "Section X of 8" progress bar, so progress is legible between the
//     four coarse stages.
//   - Batch mode still skips Section 2 (filled per unit automatically);
//     srNextSection/srRefreshContinueLabels keep the Continue targets and
//     labels correct when it does.
//   - Opening a SAVED DRAFT reveals everything at once
//     (srSetAllSectionsRevealed) — that's reviewing a filled form, not
//     walking a new one.
//
// Bumped to v70 to force every installed device to drop its old cache and
// re-fetch js/app.bundle.js again — cash-advance receipt images moved OUT
// of the cash_advances JSONB row and into a private Storage bucket
// ('liquidation-receipts'; see 20260916_01_liquidation_receipts_storage.sql,
// which must be run before deploying this). Previously every receipt was a
// base64 data URL embedded in the record, which made rows megabytes each
// and forced hard size caps plus an attachment-stripping pass on every
// list query. Now: uploaded on selection, resized to <=150KB first by the
// shared compressImageForUpload(), row keeps only attachmentPath, viewing
// resolves a short-lived signed URL. Applies to BOTH liquidation receipts
// and reimbursement receipts. Image-only now — the resize path is
// canvas-based, so a PDF couldn't be shrunk and would upload at full size.
// Records submitted before this keep their inline base64 and still display:
// the viewer reads whichever form an item has, and the old byte guards
// remain only for drafts started the old way.
//
// Bumped to v69 to force every installed device to drop its old cache and
// re-fetch index.html/css/app.css/js/app.bundle.js again — technician
// account fixes:
//   - Phantom Job Order count: the open-ticket filter excluded only
//     completed/closed, not cancelled or EXPIRED. dtEffectiveStatus()
//     returns 'expired' for any past-dated unacknowledged ticket, so one
//     stale ticket counted as open forever. Fixed in both the home
//     Overview and the Profile sheet.
//   - "On My Way" now records enRouteBy on the TICKET as well as syncing
//     the customer's request, so the technician's own step tracker
//     actually advances. Tracker is now Open -> En Route -> Acknowledged
//     -> Completed -> Closed (was missing En Route entirely, so tapping
//     the button changed nothing on the technician's screen).
//   - Expiry is now TERMINAL, like closed/cancelled (new dtIsTerminal/
//     dtIsExpired). An expired job order can't be acknowledged or have a
//     report filed against it — there's no attendance record for that day,
//     so acting on it would record a visit that never happened. It moves
//     to the Closed tab, shows no action buttons, is blocked inside
//     dtAcknowledge itself (not just by hiding the button, since a list
//     rendered before midnight can still be on screen), and is excluded
//     from the report job-order picker. "How Job Orders Work" rewritten to
//     match, including the new En Route stage.
//   - Admin dispatch list gained a Cancelled filter tab (cancelled
//     tickets were previously only findable under All).
//   - Greeting attendance row alignment: each label+value is its own
//     baseline-aligned unit with tabular numerals, instead of relying on
//     whitespace between text nodes.
//   - Dollar-sign icon replaced with a banknote everywhere (11 in
//     index.html plus the shared icon('cash') helper) — pesos, not dollars.
//
// Bumped to v68 to force every installed device to drop its old cache and
// re-fetch js/app.bundle.js again — sync diagnosability. The outbox is NOT
// only an offline queue: ensureCloud() only checks that the Supabase
// client was constructed, never that the network works, so a write the
// SERVER rejects (RLS, missing table, stale schema cache, bad data) also
// lands in the queue. Those two cases were indistinguishable, and the
// banner called both "waiting for a connection" — so a server rejection
// on a strong signal displayed as a connection problem that no amount of
// signal would ever clear. Fixed three ways:
//   1. outboxQueue() now takes the causing error and records it at queue
//      time, instead of the reason only appearing after a later replay.
//   2. The banner distinguishes rejected-by-server from waiting-for-
//      connection (and reports a mix as "N of M"), and the item list says
//      which each item is.
//   3. New persistent sync-failure log (last 20), shown in the same
//      overlay and kept SEPARATELY from the queue, so it survives
//      discarding an item — previously, discarding a stuck item deleted
//      the only record of why it failed, making it undiagnosable.
//
// Bumped to v67 to force every installed device to drop its old cache and
// re-fetch index.html/css/app.css/js/app.bundle.js again — added prev/next
// arrow buttons either side of the technician Overview carousel's dots.
// The scroll-snap swipe covers touch, but a desktop mouse had no way to
// move between slides except dragging the (hidden) scrollbar. Arrows
// scroll by exactly one slide and disable at the first/last one; a shared
// syncControls() keeps the active dot AND the arrows' disabled state
// correct off the scroll position itself, so all three inputs (swipe,
// dot, arrow) stay in sync. See techInitOverviewCarousel() in home.js.
//
// Bumped to v66 to force every installed device to drop its old cache and
// re-fetch index.html/css/app.css/js/app.bundle.js again — technician
// portal:
//   1. Pull-to-refresh re-enabled. html/body carry overscroll-behavior:
//      none app-wide to kill the "screen moves a little" bounce, which
//      also killed the browser's pull-down-to-refresh gesture. Now
//      re-enabled on the Y axis only, for role-tech only (X stays
//      contained, so the sideways-drift fix that rule exists for is
//      untouched; admin/customer unchanged). Needs a class on <html>
//      itself, not body — applyUserRestrictions() in auth.js mirrors
//      role-tech onto documentElement as role-tech-root for this.
//   2. Email removed from More > Profile — that detail is maintained by
//      admin under the technician's profile, not surfaced here. The
//      db.auth.getUser() call that fetched it is gone too.
//   3. Logout now lives ONLY in More > Profile. Removed from the More
//      sheet itself; the header #userLogoutBtn and the sidebar's
//      #menuLogout were already hidden/unreachable for this role.
//
// Bumped to v65 to force every installed device to drop its old cache and
// re-fetch css/app.css/js/app.bundle.js again — removed the Time In/Out
// reminder banner and the "Today's Job Order" section from the technician
// greeting card. The orientation note is now static (it no longer branches
// on whether today has a job order), the greeting's dtListForWorker() call
// is gone (it was fetching every one of the technician's tickets on each
// home render purely to build that removed section), and the dead
// greet-jo-*/greet-reminder-compact CSS and click handler went with them.
//
// Bumped to v64 to force every installed device to drop its old cache and
// re-fetch index.html/css/app.css/js/app.bundle.js again — technician
// portal refinements:
//   1. Page frame now matches the customer portal exactly (max-width:1200px,
//      centered, .cp-page-content's own 16/24 -> 16/44 -> 28/24 padding
//      steps) instead of a full-bleed padding:16px — applied to the home
//      screen and every other technician screen.
//   2. "What would you like to do?" card (#homeIntroCard) hidden for this
//      role — #techQuickActionsCard fully replaces it. Admin keeps it.
//   3. Greeting card rebalanced: larger/consistent type scale, the
//      attendance strip lost its green fill (plain bordered row now) and
//      became a link into the DTR screen with a clock icon. The Time In/
//      Out VALUES themselves remain display-only.
//   4. Added a contextual orientation note that changes with state — tells
//      the technician to acknowledge a job order to unlock its Service
//      Report, or where to go when nothing is scheduled.
//   5. Dropped the duplicated dashboard-topbar greeting for this role
//      (the Welcome Back card already says it) along with its admin-
//      oriented "field operations today" strapline.
//   6. Overview carousel tiles shortened (padding 18->12px, value 28->21px,
//      smaller icon chip/labels) — one visible slide was eating far too
//      much vertical space.
//   7. Header Home/Logout buttons hidden — Logout now lives under
//      More > Logout in the bottom nav.
//   8. New More > Profile sheet (#techMyProfileSheet) showing the
//      technician's own details, reusing the customer portal's
//      .cp-info-card/.cp-info-row components. NOTE: its ids are prefixed
//      techMyProfile* on purpose — an admin-facing #techProfileOverlay
//      already owns techProfileName/techProfilePhoto/etc., and
//      getElementById returns the FIRST match, so an unprefixed id here
//      silently wrote into that admin overlay instead.
//
// Bumped to v63 to force every installed device to drop its old cache and
// re-fetch js/app.bundle.js again — the "Back to Service Report" banner
// on the Job Orders screen was showing raw <svg>...</svg> markup as
// literal text instead of rendering the icon: dtRenderBackToSrBanner()
// used .textContent instead of .innerHTML to set it, so the icon() helper's
// HTML string never got parsed as markup. One-line fix in dispatch.js.
//
// Bumped to v62 to force every installed device to drop its old cache and
// re-fetch index.html/css/app.css/js/app.bundle.js again — relayout of
// the technician home screen:
//   1. Greeting card compacted to a single-column, minimal-space layout
//      (Time In/Out/OT shown as plain text, never tappable).
//   2. Overview card is now a swipeable carousel (one stat per slide,
//      CSS scroll-snap) with dot indicators — replaces the static grid
//      for this role. Along the way, fixed a real pre-existing bug:
//      renderHomeTechOverview() referenced ovMyFinanceValue/Sub elements
//      that didn't exist in index.html, throwing mid-function and
//      silently skipping everything after it (including populating Next
//      Job Order) on every single render.
//   3. Quick Actions is now one card with 4 tiles in a 2x2 grid (Service
//      Report, Job Order, Finance & HR, Materials Request) — Finance & HR
//      opens a sheet bundling what used to be 5 separate sidebar entries
//      (Attendance/Cash Advance/Leave/Liquidation/Reimbursement).
//   4. The technician sidebar is gone — replaced by a bottom nav bar
//      (#techNav) reusing the customer portal's own .cp-nav component
//      (bottom bar on mobile, top bar on desktop): Home / Job Orders /
//      Report / Finance / More, with a "More" sheet for Messages/
//      Documents/Settings/Logout. Admin's sidebar is completely
//      unaffected — every override is scoped to body.role-tech only.
//
// Bumped to v61 to force every installed device to drop its old cache and
// re-fetch css/app.css/js/app.bundle.js again — the "Active service"
// hero card (dispatched/en route/in progress) now shows the scheduled
// date/time the visit was actually dispatched for, under the description
// line — previously only visible by opening the request detail. See
// cpHeroActive in customer-portal.js / .cp-hero-schedule in app.css.
//
// Bumped to v60 to force every installed device to drop its old cache and
// re-fetch js/app.bundle.js again — fixes equipment tile cover photos
// flickering on the Home and Units screens. Two compounding causes: (1)
// every re-render (notably the customer portal's 30s realtime poll)
// repainted the tiles with an EMPTY photo map first, so an already-loaded
// photo would revert to the icon fallback and pop back in every single
// poll; (2) each photo fetch signed a brand-new URL (fresh token) even
// for the identical file, so even a silent background refetch alone
// would still flash the <img>, since a changed src forces a reload.
// Fixed by caching the signed URL itself for 10 minutes, per equipment id
// (cpCachedCoverPhotoMap/cpFetchCoverPhotoMap in equipment-photos.js) —
// repeat renders now paint straight from that cache (no network, no icon
// flash), and skip the repaint entirely when a refetch didn't actually
// change anything.
//
// Bumped to v59 to force every installed device to drop its old cache and
// re-fetch index.html/css/app.css/js/app.bundle.js again — replaced the
// standalone "Service Fee" billing card (shown below Units) with a
// "Request Status" card in the top-grid, beside the hero, sharing its
// slot with the booking banner. Generalized beyond fee-only: shows
// whichever of fee_proposed/schedule_proposed a request is actually
// awaiting the customer's review on. See cpRequestStatusCard in
// index.html and the Request Status block in renderCustomerHome()
// (customer-portal.js).
//
// Bumped to v58 to force every installed device to drop its old cache and
// re-fetch css/app.css again — the account picker screen (multi-account
// login) was packing 4 cards per row at a 260px minimum width with the
// account name truncated to one line + ellipsis, so several similarly-
// named accounts (differing only near the end of the name) all rendered
// as the same truncated text. Widened the grid to fit ~2 cards per row
// on desktop and let the name wrap onto multiple lines instead of
// truncating, so the differentiating part of the name stays visible.
//
// Bumped to v57 to force every installed device to drop its old cache and
// re-fetch js/app.bundle.js/index.html again — adds a way to cancel an
// ONGOING dispatch (previously: no cancel path at all past 'dispatched'):
//   - Customer, while dispatched/en_route/in_progress: "Request
//     Cancellation" (customer_request_cancel_dispatched_service RPC) sets
//     a pending flag, doesn't change status by itself. Can withdraw it
//     (customer_withdraw_cancel_request RPC) before admin acts.
//   - Admin: sees any pending request (Accept/Reject) in the service
//     request's Admin Actions, or can cancel directly from there, or from
//     the dispatch ticket's own overlay (new Cancel Dispatch section,
//     dtCancelTicket in dispatch.js) — only while the ticket is still
//     'open'/'acknowledged' (before Mark Completed; past that, Close Job
//     Order's per-unit notDone checklist is the right tool instead).
//     Either path cancels BOTH the service request and its linked
//     dispatch ticket, via srAdminCancelActive / srCancelByTicket in
//     service-requests.js. Needs 20260915_01_dispatch_cancellation.sql.
//
// Bumped to v56 to force every installed device to drop its old cache and
// re-fetch js/app.bundle.js again — three changes to the request-service /
// dispatch flow:
//   1. A dispatch ticket's Close Job Order step is now the moment a linked
//      service request is synced to 'completed' — moved off "Mark
//      Completed", which only ever meant "my part of today's visit is
//      done," not "the whole job is done." If Close Job Order finishes with
//      any equipment unit still checked "not completed," the linked request
//      now stays exactly where it was instead of being marked done early.
//   2. New "Continue Tomorrow" action on a closed ticket that still has
//      notDone units — opens a fresh Create Dispatch Ticket form prefilled
//      from that ticket (customer, site, contact, access requirements),
//      seeded with just the outstanding equipment (each carrying its
//      notDoneReason into its scope), and re-links the new ticket to the
//      same originating service request so the customer sees one
//      continuous job across however many visits it takes.
//   3. The customer's cancel-request reason is now a dropdown of suggested
//      reasons (schedule conflict, cost, found another provider, resolved,
//      duplicate) plus an "Other" option that reveals a required free-text
//      box — replacing the old free-text-only textarea. See
//      SR_CANCEL_REASONS in service-requests.js.
//
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
const CACHE_NAME = 'awes-sr-v99';

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

// ---------------------------------------------------------------------
// Web Push
//
// This is what makes a notification appear on the device's own screen —
// lock screen and notification tray, with the device's default sound —
// even when the app is closed. The in-app badges and toasts elsewhere in
// this codebase only ever worked while the app was open and focused.
//
// Sound is NOT set here on purpose: as long as `silent` is false (the
// default), Android plays the user's chosen notification sound and honours
// their Do Not Disturb and per-channel settings. Forcing a custom sound
// would override preferences people set deliberately.
// ---------------------------------------------------------------------
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = {}; }

  const title = data.title || 'AWES';
  const options = {
    body: data.body || '',
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    // Vibration is a request, not a command — the OS ignores it under Do
    // Not Disturb or if the user has vibration off, which is correct.
    vibrate: [180, 80, 180],
    // Same tag replaces an earlier notification instead of stacking a
    // second one, so a technician doesn't come back to fifteen copies of
    // the same job-order update.
    tag: data.tag || 'awes',
    renotify: true,
    // Stays on screen until acted on. Field work means the phone is
    // often in a pocket when this arrives.
    requireInteraction: false,
    data: { url: data.url || '/' }
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/';

  // Focus an already-open tab rather than opening a duplicate — and
  // navigate it to whatever the notification was about.
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          if ('navigate' in client && target && target !== '/') {
            return client.navigate(target).then((c) => c && c.focus());
          }
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(target);
    })
  );
});

// A push service can rotate a subscription on its own. When that happens
// the old endpoint stops working, so the app must re-subscribe — the page
// does that on next load (pushInit in push.js); this just makes sure the
// stale one isn't left looking valid.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    self.clients.matchAll({ includeUncontrolled: true }).then((clients) => {
      clients.forEach((c) => c.postMessage({ type: 'push-subscription-changed' }));
    })
  );
});
