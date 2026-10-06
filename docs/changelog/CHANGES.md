# AWES App — second review round (sw v224)

**Run first:** open `supabase/RUN_THIS_IN_SUPABASE.sql` in the Supabase SQL editor and run it ONCE. It contains every migration from
20261020_01 to 20261030_01 in order (including `20261027_01_site_deliveries.sql`, which was missing from the deployment), and every part
is safe to run again. The screens that need a migration now say "it is inside RUN_THIS_IN_SUPABASE.sql".
**Upload `index.html` together with the script** (this release adds elements the new script uses; the version marker is now 224).

1. **Magielyn's account became a messenger home.** The messenger layout was switched on for ANY office staff holding the My Errands page,
   so a department Head given that page lost the office layout. Now only people whose job is errands get it: a Head, anyone who can set
   errands for others (Errands page) and anyone who can approve something keep the normal office layout; My Errands is just another page in
   their menu. A team member with My Errands (like Erwin) is still a messenger.
2. **Messenger home (Erwin).** Same pattern as the technician home: a "What do you need?" grid under today's errands, grouped — My work · Time
   and pay · Money · Ask the office — with big icons and short labels. Every tile opens the page the Menu already opens.
   It also gets the technician's **Waiting for approval** and **Approved · What happens next** blocks (their own pending cash advances,
   leave and material requests, with the same next-step lines), above the grid. Nothing waiting: no blocks.
3. **Technician home grid.** "Request or check" did not fit (it also held attendance, job orders and calculators), so it is now
   **"What do you need?"**, split into My work · Attendance and leave · Materials and tools · Money. Bigger icon, smaller label, no
   sub-label. A group whose tiles are all hidden hides itself. Every button keeps its id.
4. **"Waiting for approval" showed approved items.** It now lists only what is still waiting for the admin. Approved items move to their own
   **Approved · What happens next** block, each with its next step: material request — "The office is arranging your materials",
   then (from the real progress) "Being bought", "Arrived — collect them from the warehouse"; handed-over requests drop off. Approved cash
   advance — "Admin will release the cash. You will be told when it is ready to collect."
5. **Office cards on a technician home.** The dispatch board / Needs you now cards are now forced hidden on technician and customer screens
   whatever state the page was left in.

---

# AWES App — review comments (sw v223)

**Run first:** `supabase/migrations/20261030_01_dashboard_groups_and_leave_alert.sql` (safe to re-run). Without it the screens work as before:
the tiles stay in their old groups and HR does not get the early leave heads-up.

1. **Dashboard cards re-grouped.** *Operations* now holds Open job orders, Late job orders, New service requests, **Equipment overdue for PM,
   PM due in the next 30 days, Customers**. *Administration* now holds POs waiting to be received, Materials to reorder, **Tools overdue for
   return, Tools overdue for calibration**. Same figures, same permissions, same page each tile opens (database function `dept_dashboard`).
2. **Job order list card (admin / Operations).** The "Open Job Order" button and the "Status: ..." pill are gone from the card. Each progress
   line now has its own label — Acknowledged / On site / Reported / Closed — ticked (✓) when complete, amber when part-way (phones show "Ack").
   Tapping the job order shows the summary, with the status at the top; below it a **More** button opens the full job order.
   Technician cards and the job order screen's own header are unchanged.
3. **"Operations today" card removed** from the Operations home (it repeated the Needs you now list, Job order progress and Technicians status).
4. **Leave requests.** The decision comment now reads "Comment (visible to the employee)" — on leave, and the same wording on cash advance,
   liquidation and reimbursement decisions. A leave request that is still waiting for its Head's endorsement now reaches the **HR approvers**
   at once: it appears in their **Inbox** ("Leave waiting for endorsement · <name> — <type> · waiting for <Head>'s endorsement") and in a new
   **Needs you now** card on their home (leave to decide, waiting for endorsement, and — for a Head — leave to endorse). HR still cannot
   decide it until it is endorsed. The endorsing Head keeps their own "to endorse" item, with no duplicate.

Not done: a push notification to the HR Head the moment leave is filed (today only the Super Admin is pushed; HR sees it in the Inbox and on
Needs you now). It needs the app to know who holds HR approval; say if you want it.

---

# AWES App — faster loading (sw v222)

**Run first:** `supabase/migrations/20261029_01_lite_list_views.sql` (safe to re-run; needs PostgreSQL 15+, which Supabase has).
Without it everything works exactly as before, just not faster.

**Why it was slow.** Every service report stores its two signatures inline as base64 pictures (`data:image/png;base64,...`),
and every cash advance / reimbursement stores its receipt photos inline in `data`. The Super Admin dashboard, the Operations
dashboard and the technician home read EVERY report and EVERY cash advance to count and list things, so they downloaded all those
pictures (many megabytes, growing every week, in serial pages of 200 reports) and then threw them away on the phone.
In a test with 150 reports and 120 cash advances that was about 7 MB + 14 MB of picture data for answers that needed ~40 KB.

**What changed**
- Two read-only views, `service_reports_lite` and `cash_advance_requests_lite`: the same rows without the pictures
  (security_invoker, so row-level security is exactly the real tables'). Nothing is moved or deleted; a report or an attachment is
  still fetched whole when someone opens it.
- The admin dashboard, the Operations dashboard and the technician home read the lite views; the lite report list pages by 1000
  (2,300 reports = 3 requests instead of 12). History, customer history and anything that prints a signature still read the full table.
- `index.html`: the Google Fonts stylesheet no longer blocks the first paint, and the Supabase library starts downloading in parallel
  with the app script instead of after it.

**Checked and not the cause:** the new Materials Monitor (0.45 s for 600 requests, 22 ms for a screenful) and the app script
itself (about 0.5 s of work on a phone-class processor).

**Measure your own data** (Supabase SQL editor):
`select count(*) as reports, pg_size_pretty(sum(pg_column_size(customer_signature) + pg_column_size(technician_signature))) as signature_bytes from service_reports;`
`select count(*) as requests, pg_size_pretty(sum(pg_column_size(data))) as data_bytes from cash_advance_requests;`

**Still open (not done):** minifying the 2.4 MB script (about a third smaller to download, but harder to read in error messages), and
moving signatures / receipt photos out of the database rows into Storage for good (the long-term fix).

---

# AWES App — no more blank white screen when files are out of step (sw v221)

**Symptom fixed:** the Super Admin dashboard stayed empty under the stale header "Technician's Homepage". Cause: the new scripts were
deployed without the matching `index.html`. The scripts bind buttons and panels that only exist in the newer `index.html`; when one
was missing, the browser threw an error while the app was starting and nothing after that point ran.

- **index.html and app.bundle.js must always be deployed together.** Every release zip that changes the screens contains both.
- The bundle now checks `index.html` first (`<meta name="awes-index-version" content="221">`). If it is older, a red bar
  appears at the top: "The app files are out of date: upload the latest index.html together with the rest, then reload."
- Three start-up bindings that depended on the newest `index.html` (Purchased Items page, My Materials deliveries list, the
  technician "My deliveries" tile) are now skipped when their element is missing instead of stopping the app.
- Rule for later releases: bump `INDEX_MIN` in `scripts/build.py` and the meta tag together, only in a release that changes `index.html`.

---

# AWES App — Stock Movements design adopted (sw v220)

**Run first:** `supabase/migrations/20261028_01_issue_item_confirmation.sql` (safe to re-run). Without it the screens still work:
a worker can sign a slip with no differences the old way, and is told to run the migration to record differences.

Adopted from the "Stock movements" design, adjusted to fit the current system:

- **One colour per movement** — Receive green, Issue blue, Return red, Transfer orange — on the stepper, the route, the
  selected tiles and the main button, so a person always knows which movement they are in.
- **Switcher + plain definition** at the top of Receive, Issue, Return and Transfer: four drawn buttons (truck > warehouse,
  warehouse > worker, ...) to jump between movements, and a line saying what the movement is and when to use it
  ("Issue: items given to a worker to use. Use it when a worker takes items from a warehouse...").
- **Drawn From > To route** replaces the chips: each end shows its drawing (warehouse with its own code, purchase order, delivery
  truck, construction site, worker) with "From" / "To" and the chosen name.
- **Sticky action bar on phones:** Back / Next stay at the bottom of the screen while the page scrolls.
- **The receiver confirms item by item** (My Materials): for every item the worker ticks it, sets how many they actually
  received, and can mark it Damaged; a summary shows "3 units short, 1 damaged"; a remark is REQUIRED when anything differs;
  then they sign (the signature pad is unchanged). It saves as **received with differences**; the issuer and the admins are told.
  Nothing is received at all? They are told to speak to the storekeeper instead of signing. A difference does NOT change stock:
  the issue is already booked out, so the storekeeper follows up (a return or a recount).
- **My Materials is one inbox:** site deliveries assigned to the worker appear as "Deliveries to receive" beside the slips waiting
  for their signature; tapping a delivery opens its receive form. The home-screen badge counts both ("2 to receive").
- **Slips & History:** each movement row has its colour; an issue slip reads awaiting signature / signed / received with
  differences; its detail shows how many of each item were received, short and damaged marks, and the remark.

Not adopted (it needs a decision first): the design posts every movement as PENDING until the receiving side confirms and only
then moves stock ("in transit"); warehouse receipts, returns and transfers here are posted by the person who physically
receives them and move stock immediately. Also not adopted: its separate account per site, the demo account switcher, and its
fonts / hazard-stripe branding (the AWES look is kept).

---

# AWES App — Supplier as a source: site deliveries with photo proof (sw v219)

**Run first:** `supabase/migrations/20261027_01_site_deliveries.sql` (safe to re-run). It creates the delivery tables, a PRIVATE
photo bucket (`delivery-proofs`) and three functions. Without it the new screens say which migration to run.

A supplier can now deliver STRAIGHT TO A SITE. The office assigns a worker to receive it; the worker confirms what arrived and
uploads photos as proof.

- **Office:** Receive Stock > step 1 > **Supplier delivering to a site** (a third way in, beside Purchase order and
  Delivery without a PO). A four-step screen: Supplier (a PO, or a supplier + reference) > Site and receiver (project, job order
  or address, expected date, the worker, a note) > Items (a PO's remaining lines, or typed items) > Review > **Assign the delivery**.
  The worker is notified. A **Deliveries** tab lists them (To receive / Received / Cancelled), shows each one's items, the
  quantities that arrived, and the **proof photos** (tap to enlarge), and can cancel one that has not been received (reason required).
- **Worker:** **My Deliveries** (technician home tile, staff sidebar, messenger Menu). Shows what is assigned to them. "I received
  it" opens: how many of each item arrived (starts at what was expected), **at least one photo (required, up to 12)**, an optional
  note. Photos are compressed before upload; if saving fails, the photos are kept and not uploaded again on retry. The office person
  who assigned it, and the admins, are told.
- **Rules (in the database):** only the assigned worker can record a delivery; only Super Admin / staff with Edit on Receive Stock
  can assign or cancel; a worker can't receive more than expected, nor record "0 of everything" (tell the office instead); a PO line
  can't be over-assigned (counting what is already assigned to others) nor over-received; photos must be the worker's own uploads;
  a delivery can't be recorded twice or after it is cancelled.
- **Effect on stock:** none. Nothing goes into a warehouse. For lines on a PO, what arrived is added to that PO line (so the PO can
  complete) and recorded as a worker receipt, so it shows in Purchased Items by the day received, "Received by <worker>".
- Photos: a private bucket; a worker can only write into their own folder, nobody can edit or delete a photo, and the office reads
  them through short-lived signed links.

---

# AWES App — warehouse movements: one clean four-step screen (sw v218)

No database changes. Receive Stock, Issue to Worker, Return to Stock and Transfer now share one layout
(`inventory-wizard.js`, replacing the tile layer of v217). How stock is posted is unchanged: the real fields are MOVED
into the steps and keep their ids, and the last step presses the original Post button.

- **Four steps:** From > To > Items > Review. A stepper shows where you are (tap a finished step to go back), and a line
  under it fills in as you choose ("Warehouse MAIN > Pedro Tech > 2 items"). It opens on step 1 every time.
- **The person doing it is the signed-in account** and is shown as a badge (name + Receiver / Issuer / Returner / Transferer);
  there is no "issued by / returned by" field. In Return the worker is where the materials are ("Whose custody is it in?").
- **Warehouses are drawn** with their own code on the sign; Source choices (Against a PO / Without a PO, From an approved
  request / Direct) are two equal cards. Receive and Return offer any warehouse; Issue and Transfer-from only your own.
- **Each step checks before moving on**, with the same rules as before (request chosen, worker chosen, direct-to-project
  needs a project or job, quantity above 0, no more than is in stock or held, a different destination for a transfer).
- **Review** lists From, To, who is doing it, every item with its quantity, and what will change (stock up / down, who is asked
  to sign, damaged items not restocked). It replaces the second "are you sure?" dialog; nothing is posted until you press
  the final button, which says what it does ("Issue 2 items").
- Phones: one column, three warehouse tiles per row, Back and Next side by side.

Not built (waiting on your answers): Other workers (hand over between workers), Issue straight to a project with no worker,
Return from a project, Own purchase without a request.

---


# AWES App — Materials Monitor: the simple view (sw v216)

**Run first:** `supabase/migrations/20261026_01_materials_monitor.sql` (after 20261025_01). Safe to re-run.

The materials flow was too detailed for everyday use, so there is now ONE simple view built on five plain stages:
**To approve > Being bought > Ready to hand over > Waiting for signature > Done**, and one answer per request:
**who has to act next, and for how many days.**

- **Office (Material Requisitions page):** it now opens on **Monitor** — five tiles with a count each (tap one to filter,
  tap again to clear) and one list of everything not done, late requests first. Each row: request no., requester,
  the stage, "Waiting on <who> · <N days>", job order and, for several items, "2 of 3 items done". Urgent and Late are flagged.
  The old detailed list is the **All requests** tab.
- **Workers (My Requests):** three tiles — Waiting, Ready for you, Done — and a plain line on each request
  ("Ready to collect — waiting on the warehouse"). Their own words: Waiting for approval / Being bought / Ready to collect /
  Sign for it / Done.
- A request with several items shows the EARLIEST stage any item is in (what is holding it up).
- Inside a request, the step-by-step view of each item is folded away behind "Show each item's steps"; it opens by
  itself only when the person has something to do there (I received this / I bought this). The little 5-dot paths on the
  lists were removed.
- Access is the same as before (requester, collector, office, Super Admin, storekeepers for approved requests). Names and
  counts only — no prices. Finished requests older than 60 days drop off; open ones never do.

---

# AWES App — materials flow, finished (sw v215)

**Run in order (Supabase SQL editor / `supabase db push`), after 20261020_01 and 20261021_01:**
`20261022_01_purchased_items_received_date.sql`, `20261023_01_warehouse_rules.sql`,
`20261024_01_worker_purchase_receive.sql`, `20261025_01_materials_trail_and_issue.sql`. All safe to re-run.
The app keeps working if a migration is missing (screens say which one to run; Issue/Return and warehouse lists fall back).

**1. Purchased Items counts by the DATE GOODS WERE RECEIVED** (Philippine day). One row per received line, so a PO delivered in
three parts appears three times. Includes warehouse receipts, goods a worker received on site, and items a worker bought
(by purchase date). Goods received with no PO are not included. New columns: Date received, Receipt, Received at.

**2. Warehouse rules.** Stock IN (Receive, Returns, the "to" of a Transfer): any warehouse — Super Admin, any warehouseman,
staff with Edit on the page. Stock OUT (Issue, the "from" of a Transfer): only your own warehouses; office staff are assigned like
storekeepers or get "all warehouses". Everyone who holds an Inventory page today is switched to "all warehouses" so nobody
loses access. Super Admin: Employees > person > **Warehouses** card. Tools & Equipment keep their old rule.

**3. Workers buy and receive.** Request form: **Who will collect the materials?** (any worker; default the requester; the office
can change it). Office, when marking lines "tech buys": **Who buys?** (any worker). The buyer records store, price, date and a
receipt photo (**I bought this**). The requester or collector records **I received this** on a PO line: it counts toward the PO
being complete but adds NO warehouse stock. The office is told.

**4. Per-item trail** (Request > Approve > Buy > Arrive > Hand over > Return) on the request detail for the requester,
collector and office, plus one small path per item on the request lists. Names and quantities only; peso amounts only for people
who may see prices. Returns are matched to an item by worker + item + job (the Returns screen does not record the issue slip).

**5. Issue to Worker**: lines covered by a PO can now be issued against the request once the goods are in the warehouse;
a PO line keeps its route (it used to turn into "stock"). The recipient is pre-filled with the collector, else the requester.

**6. PO receipt status**: Not received / Partly received / Fully received badge on every issued PO, with a filter. The PO's own
status (draft / issued / cancelled) is unchanged.

**7. Notifications**: goods arrive on a PO -> the requester and the collector; materials issued -> the requester (the recipient
is asked to sign, as before); materials returned -> the requester and the office. Nobody is told twice.

Not built: short-closing a PO line the supplier will never deliver; showing on-hand stock beside each line when approving.

---

# AWES App — Purchased Items page; materials rules for every worker (sw v214)

**Run first, in order (Supabase SQL editor / `supabase db push`):**
`20261020_01_purchased_items.sql`, then `20261021_01_requests_for_all_workers.sql`. Both are safe to re-run.
Without them the new page says to run its migration, and the app keeps working as before (the Issue and Return
lists fall back to technicians only).

**1. Purchased Items** (Purchasing, new page `pur.purchased_items` — the department Head gives it like any page)
- Every item bought over a **month** (with previous / next arrows) or any **date range** (presets: this month,
  last month, this year). Source: the lines of ISSUED purchase orders, by PO date; drafts and cancelled POs are left out.
- **Totals per item** (quantity, number of POs, amount) or **Every line** (date, PO no., supplier, item, qty, unit,
  unit price, received, amount); filter by supplier and search by item, code or PO no.
- **Download PDF** (landscape A4, company header, coverage, filters used, totals, page numbers) of exactly the view on screen.
- Peso values only for the Super Admin and staff who can already see prices (Purchase Orders, or "See peso values");
  everyone else gets quantities only, on screen and in the PDF.
- Not included yet: items a worker bought on their own ("tech buys") — those purchases are not recorded anywhere yet.
  The database function returns a `source` column so they can be added.

**2. Every worker can request materials**
- Staff sidebar: **Request Materials** (Requests section) for all office staff; messenger Menu: **Request materials**.
- Anyone holding Dispatch (View) — the Operations head, Operations staff — can link a request to ANY open job
  order; everyone else still only the job orders they are on (`mr_check_job_order`).

**3. Nobody reviews their own request**
- The screen already stopped staff approving their own request (`own_record`). Now the database enforces it too,
  for approve, reject, return AND approved quantities. The Super Admin and server-side jobs are exempt. The review
  buttons are hidden on your own request, with a note.

**4. Issue to Worker / Returns list every worker** (`inv_workers()`): active technicians and office staff
(messengers, the Operations head, …), not only technicians.

Still to come (agreed, not built): warehouse choice and limits (stock IN: any warehouse; issue/transfer-out:
the person's own warehouses, with an "all warehouses" option), workers recording a purchase and a receipt on site,
notifications when PO goods arrive and when materials are returned, issuing PO goods against the request line,
a received status on POs, and the per-item trail.

---

# AWES App — customer status card counts the whole crew (sw v213)

**Run first:** `supabase/migrations/20261019_01_customer_ticket_crew_names.sql` (replaces
`customer_ticket_tech_names()` from 20261017_01; safe to re-run). Without it the card keeps its old count.

- **Bug:** a job order with 5 technicians assigned showed "Jason Pascua + 1" under "Assigned technicians".
  20261017_01 returned only the "Can Create Service Report" technicians whenever a ticket had any (2 of the 5).
- **Now:** the report writers first (the card still shows the first name), then every other assigned
  technician, nobody twice (by id; by name only on older tickets with no ids) -> "Jason Pascua + 4".
  Tickets with no designated report writer behave as before. Same access rules, names only.
- `dispatch.js dtFetchTicketTechNames`: the direct-read fallback orders the names the same way.

---

# AWES App — equipment totals on the admin Equipment and Customers pages (sw v212)

No database changes.

- **Equipment page** (Manage Equipment List): a "Total equipment on file" bar at the top (units, and how many
  customers have equipment); every customer in the picker shows their count, e.g. "Alpha Corp (5)"; picking a
  customer shows "5 units for this customer", or "3 of 5 units match" while searching.
- **Customers page** (Manage Customers): the same total bar, and a "5 units" badge on every customer card.
- The count (`loadEquipmentCounts`, customers.js) reads only `customer_id` in pages of 1000, because the
  server returns at most 1000 rows per request and one query would silently stop there. It is cached for a minute,
  cleared when equipment or a customer is added or deleted, and always re-read when either page opens.
  A failed read shows "Couldn't count the equipment right now" instead of a number; offline it counts this
  device's saved lists and says so.

---

# AWES App — Operations dashboard on the staff home (sw v209, layout v211)

Office staff who hold an Operations page now see the Super Admin's dashboard on their own homepage,
limited to what their access allows. No database changes. The Super Admin dashboard is not changed.

**Who gets it:** staff (not messengers) with View on at least one of Dispatch, Service Requests,
Service Reports or Live Tracker. Everyone else's home is unchanged.

**What each page unlocks** (the database enforces the same rules through has_perm / RLS):

| Card | Needs (View) |
|---|---|
| Operations today (tiles) | one tile per page held: Live job orders / Late today / Missed / Awaiting review = Dispatch; New service requests = Service Requests; Service reports = Service Reports; Technicians timed in = Technician Attendance |
| Needs you now | Dispatch, Service Requests or Service Reports - and only the items from those pages |
| Today's dispatch board, Technicians today, Job order progress, Schedule calendar | Dispatch |
| Live tracker + technician list | Live Tracker |
| Time-in / time-out on Technicians today | Technician Attendance (without it the card shows job orders only) |

Hidden for everyone on this screen: finance, leave, purchasing, announcements, activity log, charts.
Those items stay in the staff Inbox and on their own pages (e.g. leave decisions are not shown here).

- **How:** `ops-dashboard.js` MOVES `#adminDash` into the staff home (so styles, ids and handlers keep
  working) and puts it back before the staff home is redrawn, when any other home opens, and on sign out.
  Cards not allowed are hidden; no request is made for data a person may not read.
- **Live:** refreshes within ~1.5 s of a dispatch / time-in change (real-time, when those tables are
  published), every 60 s, and when the app returns to the front. A failed background refresh keeps the screen.
- Tiles open their page through the staff page opener (also by keyboard: Enter / Space).
- `css/app.css`: re-flows the admin grid for this screen: tiles, Needs you now, dispatch board, then the live map
  with **Job order progress beside it** and the **Technicians status table full-width below** (v211 — the table has
  6 columns and was cut off at half width), then the calendar. Without Live Tracker, Job order progress and the table
  sit side by side (table in the wider column); with only Live Tracker the map is full width. One column on phones
  (map, Job order progress, Technicians status).

---

# AWES App — messenger live updates + notifications prompt (sw v208)

Messenger accounts (staff with My Errands) only. Includes ONE new migration.

- **Run first (Supabase SQL editor or `supabase db push`):** `supabase/migrations/20261018_01_errands_realtime.sql`
  adds `public.errands` to the `supabase_realtime` publication. Safe to re-run. Without it everything
  below except the instant push still works (items 2 and 3).
- **1. Real-time:** the app subscribes to errands assigned to the signed-in messenger
  (`assigned_to=eq.<id>`, RLS `errands_read` applies). A change refreshes the screen within ~1 second.
  A dropped connection retries with a growing pause (5 s up to 5 min); sign out closes it.
- **2. Refresh on return:** when the app comes back to the front, the phone comes back online, or the
  page is restored.
- **3. Quiet refresh about once a minute** while Home, the Errands tab or Alerts is open.
- Only those three list screens ever refresh; a guided errand step, an open dialog (signature box,
  confirm) and the Menu are never redrawn underneath him. A background refresh never shows "Loading"
  and never replaces a good screen with an error.
- A newly assigned errand shows a toast ("New errand: ...") and a short vibration.
- **Notifications prompt on Home** (it was missing from the messenger Home): a big TURN ON card while
  permission is undecided ("Not now" hides it for 7 days, same rule as the rest of the app) and a
  warning when notifications are blocked. Push is how he hears about an errand while the app is closed.
- `auth.js`: sign out also closes the messenger live channel.

---

# AWES App — messenger Alerts, Errands tab, Cash tab, hand-over name (sw v207)

Phase 3 — completes the simplified messenger experience (v205 Home/bar/Menu/Account, v206 guided errand).
Same accounts (staff with My Errands). No database changes.

- **Alerts (the bell)**: one card per thing waiting on him, most urgent first (Escalated / Overdue, then
  waiting), each with an Open button that goes to the page (an assigned errand opens that errand).
  Includes his own cash advances still to be liquidated. The bell / Menu counts now count EVERY Inbox
  item — in the Inbox 'waiting' is only the freshest urgency level, and a newly assigned errand
  (`errand_todo`) is always 'waiting', so the old attention-only count would never have shown it.
  A push-notification tap (?inbox=1) opens Alerts for messengers.
- **Errands tab**: To do (in order, late banner), Done today, Earlier; tapping opens the guided errand.
- **Cash tab**: three plain choices — Ask for cash, Send in your receipts, Money I paid first — each opens
  the existing cash advance / liquidation / reimbursement screen, with counts.
- **Hand-over**: "They sign on my phone" now goes to an Ask-them-to-sign screen (receiver name pre-filled
  from the errand, typed on the screen) instead of two pop-up questions. `erDeliver(preHow, preName)`.
- Not built: an info-only alerts section (leave approved, memos) — the app has no feed for those yet.

---

# AWES App — messenger guided errand (sw v206)

Phase 2 of the simplified messenger experience (builds on v205: Home, bottom bar, Menu, My account).
Same accounts as v205 (staff with My Errands). No database changes.

- **One instruction per screen** for the messenger's own errand while it is assigned or in progress
  (`messenger.js` guided section, hooked from `errands.js erRenderDetail`):
  Ready → one screen per checklist step (Take photo / Sign here / Done, whichever the step needs next) →
  How did they receive it? (They sign on my phone / They stamp a copy) → Finish errand → Errand complete
  (with Next errand). Step progress bar + "Step N of M", "When you tap:" line on every screen,
  Errand details (directions, call, instructions, cash), Add a receipt or photo, Go back one step.
- **Couldn't complete**: tap a reason (nobody there, office closed, wrong address, papers missing) or
  "Something else" to type one; confirms first; then an "office has been told" screen.
- Uses the existing server actions unchanged (errand_start / errand_step / errand_add_file /
  errand_deliver / errand_complete / errand_fail). `erDeliver(preHow)` now accepts the answer from the
  new choice screen. Done / failed errands still open the old read-only page.
- Receiver name and the two signatures still use the existing prompt and signature boxes.

---

# AWES App — messenger / liaison home, bottom bar, Menu, My account (sw v205)

Phase 1 of the simplified messenger experience. Applies to staff accounts that have the
My Errands page (adm.my_errands) — the same rule the time in / out location check already uses.
Admin, technician, customer and other staff accounts are unchanged. No database changes.

- **Persistent bottom bar** (`#msgrNav`: Home · Errands · Cash · Menu) on every screen for these
  accounts; the sidebar, hamburger and header Logout/Home buttons are hidden for them (`body.role-messenger`).
- **Home** (`messenger.js`): today's errands in recommended order with ONE big next action —
  Time in → Start errand → Continue errand → Time out. Status chips, progress bar, "When you tap" line,
  bell with the count of items waiting on the messenger (opens the existing Inbox for now).
- **Menu**: every page the old staff sidebar had, in plain-word groups; office-granted pages become
  department folders (listed directly when 3 or fewer); counts per row; the name card opens **My account**
  (Change password, My activity, Sign out with a confirm).
- Hooks: `staff.js` (panels, home branch, `msgrApply`), `home.js` (`msgrOnHeader`), `errands.js`
  (`er.pendingOpen` opens a chosen errand), `index.html` (`#msgrNav`, two panels), `css/app.css`
  (messenger block at the end), `scripts/build.py` (messenger.js), `sw.js` (v205).
- Not yet built: guided one-step-per-screen errand flow, redesigned Alerts screen, Cash / Errands tab pages.

---

# AWES App — admin sidebar counts (sw v204)

Admin sidebar: every page and every category now shows a number for what is
waiting on the admin there. Red = late/escalated, amber = needs action,
grey = heads-up only (e.g. below reorder level). Category = total of its pages.
Counts come from the same data as "Needs you now" (admin-priority.js
`prioSidebarCounts`), so the two always agree. No database changes.

- `admin-priority.js`: new `prioSidebarCounts`, `PRIO_COVERED`, `SB_MODULE_LINK`.
  Technician-page Inbox rows (`hr.staff_attendance`, `hr.tech_profiles`,
  `ops.technicians`) map to the Technicians link. Service Requests keeps its own badge.
- `css/app.css`: grey `is-watch` style, red category count, lighter grey on the collapsed rail.
- `sw.js`: cache `awes-sr-v204`.
- `scripts/build.py`: `ROOT` now the project root, so `python3 scripts/build.py`
  and `npm run build` work from anywhere.

---

# AWES App — corrections applied

Companion to the code review. Every item below is implemented in this package.
Source of truth is `js/modules-src/`; `js/app.bundle.js` is generated — run
`python3 build.py` after editing any module.

## Apply in this order

1. **Run the database migration first:** `supabase/migrations/20260822_security_and_schema.sql`
   (via `supabase db push`, or paste it into the SQL editor). It adds columns the
   new bundle expects and turns on Row Level Security.
2. **Deploy the new Edge Function:** `supabase functions deploy list-technicians --no-verify-jwt`
   and set `ALLOWED_ORIGINS` inside it to your real hosting origin.
3. **Then deploy the web files.** The service worker cache name changed, so
   installed phones pick up the new shell automatically.
4. **Work through the post-migration checklist** at the bottom of the SQL file —
   it includes backfilling `technician_id` and rotating the EmailJS keys.

## Critical

- **Reports were saving blank fields.** `reportToRow()` read `data.recs`,
  `data.install`, `data.sigCustomer` etc. under the wrong names, so
  recommendations, the installation checklist, both signatures and both printed
  names were written to the database as null. Field names now match
  `gatherData()`, verified against the full field list.
- **History PDF crashed** on any report missing a section. Reports are now
  normalised before rendering, and a failed save aborts PDF generation with a
  message instead of producing a PDF of an unsaved report.
- **Admin password check hijacked the session.** `verifyAdminPassword()` signed
  in as the admin on the technician's own client, silently replacing their
  session. It now uses a throwaway client with `persistSession:false`.

## Security

- Row Level Security on all ten tables. Previously every rule lived in the
  browser, and the anon key in the page source let anyone read every employee's
  reports, time records, leave and cash advances — or approve their own request.
- Approval/disbursement fields are admin-only, enforced by triggers that cover
  both the promoted columns and the copies nested in the JSONB blob.
- Anonymous read access to `profiles` revoked; the login screen now calls the
  `list-technicians` function, which returns only `{id, name}`.
- EmailJS credentials in `app_settings` are no longer world-readable. **Treat the
  existing keys as compromised and rotate them.**
- Technicians can no longer promote themselves to admin or clear their own DTR
  device lock.
- Escaped every HTML sink that renders a name, customer or remark.

## Offline correctness

- **Offline work no longer disappears.** Saves made without signal were written
  to the phone only, and History switches to cloud data the moment signal
  returns — so the work vanished from view. There is now a pending-sync outbox
  with a banner, automatic retry on reconnect and foreground, and a Sync now
  button. Saves report honestly: synced, queued, or failed.
- Offline reports get a provisional SR number and are assigned a real sequential
  one when they reach the cloud.

## Reliability

- **The service worker cached nothing at all.** `APP_SHELL` listed two icon files
  that did not exist; `cache.addAll()` is atomic, so the whole precache rejected
  and the failure was swallowed. Icons are now generated and present, entries are
  cached individually, failures are logged, and API traffic is never cached.
- List views were hard-capped (150 reports, 200 leave/CA rows) with no indication
  anything was hidden — older records were simply invisible. All paginate now.
- Admin actions use targeted, guarded updates instead of read-modify-write of the
  whole row, which could silently overwrite a concurrent change.
- Dispatch tickets track acknowledgement and completion per worker; a shared
  ticket only closes once every assigned worker has finished.
- Cash-advance receipts have enforced size limits and open via blob URLs, since
  browsers block `window.open()` on a data URL.

## Usability

- Password entry is a proper masked in-app dialog. `prompt()` shows the password
  in clear text on iOS and is blocked outright in several in-app browsers, which
  made the admin gate unusable there.
- Pinch-to-zoom re-enabled (`user-scalable=no` was blocking it entirely).
- Cloud status indicator added to the header — the code had always written to an
  element that was never in the markup.
- Reverse geocoding identifies itself and caches results, so Nominatim does not
  block the app for policy violations.
- Minimum admin password raised to 8 characters.
- "Ask your Claude chat for the EmailJS guide" now opens the real EmailJS docs.
- Removed the duplicated inline logo (~44KB of base64 in the HTML) and deleted
  the dead `js/app.js`.

## Known limitations

- The Supabase anon key is still in the page. That is normal and unavoidable for
  a browser app; the migration is what makes it safe.
- `technician_id` needs backfilling on pre-existing rows or RLS will hide them
  from everyone but the admin. See the checklist in the SQL file.
- The migration was validated against the PostgreSQL grammar but not executed
  against your live database — apply it to a branch or backup first.

---

## Correction and verification — 22 Aug 2026

I connected to the live Supabase project, read the real schema and the real
policy set, then rebuilt that schema in a throwaway PostgreSQL database and ran
the migration against it. Several claims in my original review were wrong, and
the first draft of the migration was written against a database that does not
exist. Both are corrected below.

### What I got wrong

My review said access control "lived only in the browser." That is not true.
**Row-level security is already enabled on all twelve public tables**, `is_admin()`
already exists, and most policies are sensible. Specifically, these were already
blocked before any of my changes, verified by attempting each one as a technician:

| Claim in my review | Reality |
| --- | --- |
| Technician can approve their own leave | Already blocked by `leave_update_admin_only` |
| Technician can approve/disburse their own cash advance | Already blocked by `cash_update_admin_only` |
| Technician can promote themselves to admin | Already blocked by `profiles_admin_write` |
| Technician can read other technicians' reports/DTR | Already blocked by the `*_own_or_admin` policies |
| Technician can delete another technician's device lock | Already blocked by `locks_delete_own_or_admin` |
| EmailJS credentials exposed in `app_settings`; rotate keys | `app_settings` holds exactly one row, `settings/fieldLists`. **No credentials are stored there. No key rotation is needed.** |
| Technician emails exposed via `profiles` | `profiles` has no email column. Names and flags were exposed; email addresses were not. |

The first migration draft also assumed a `restrictions` jsonb column on
`profiles` (it does not exist — restrictions are three boolean columns), assumed
the signature columns were `text` (they are `jsonb`), and dropped policies using
only the new names, which would have left the dangerous existing policies in
place. Because PostgreSQL OR's permissive policies together, applying that draft
would have changed almost nothing while appearing to succeed.

### What is genuinely broken, reproduced against the replica

| # | Finding | Evidence |
| --- | --- | --- |
| 1 | `dispatch_tickets` carries a policy named **"anon full access"** (`FOR ALL`, `USING true`, `WITH CHECK true`). The anon key ships in the client bundle, so anyone can read, edit and delete every job order. | As `anon`: read 5 of 5 tickets, then **successfully deleted one**. |
| 2 | `jo_counters` has the same "anon full access" policy. | As `anon`: read and wrote it. |
| 3 | `profiles_select_technicians_public` lets **anonymous** callers list every technician's id, name and restriction flags. | As `anon`: read all 7 technician rows. |
| 4 | **`next_sr_no()` is SECURITY INVOKER while `sr_counters` is admin-only, so technicians cannot get a service report number at all.** This is a live outage, not a hardening issue. | As technician: `42501 new row violates row-level security policy for table "sr_counters"`. |
| 5 | **`cash_update_admin_only` blocks every technician UPDATE, so submitting a liquidation silently fails.** The feature is dead in production. | As technician: liquidation write affected 0 rows. |
| 6 | A technician cannot correct their own still-pending leave request. | No technician UPDATE policy on `leave_requests`. |

### Migration rewritten

The migration was rewritten from 621 lines of guesswork into a targeted migration,
now split into two stages because of an ordering dependency:

- **`20260822_01_fixes_and_hardening.sql`** — safe to run against production
  *right now, with the current app bundle still live*. Closes the anon
  read/write/delete hole on `dispatch_tickets`, locks down both counter tables,
  and fixes SR numbering and liquidation submission.
- **`20260822_02_close_anon_roster.sql`** — closes the anonymous roster read.
  Must wait until the `list-technicians` Edge Function is deployed *and* the new
  bundle is being served, because the sign-in screen builds its technician
  dropdown while still anonymous. Contains an inline rollback.

Verified on the replica: with Part 1 applied alone, an anonymous visitor still
reads the 7-technician roster (so the old sign-in screen keeps working) but reads
0 dispatch tickets. After Part 2, the roster read is denied. Both files were
re-run back-to-back with no errors, confirming they are idempotent.

The migration that only changes the six items above.
It drops the dangerous policies **by their real names**, makes both counter RPCs
`SECURITY DEFINER` with a pinned `search_path`, replaces the admin-only update
policies with ownership rules backed by `BEFORE` triggers that *normalise*
privileged fields rather than raising (so a hostile write is neutralised without
ever breaking a legitimate one), adds the missing `is_install` column, and adds
the indexes the app's query patterns need — including a GIN index on
`data->'assignedWorkerIds'`, which `dispatch.js` filters on with `.contains()`.

It deliberately does **not** add `FORCE ROW LEVEL SECURITY`: `is_admin()` is
`SECURITY DEFINER` and reads `profiles`, while the `profiles` policies call
`is_admin()`. Forcing RLS on the owner would make that pair recurse and would
also break the counter RPCs.

### Pre-existing `technician_id` rows — audited, no backfill needed

Run read-only against production:

| Table | Rows | `technician_id` NULL | Orphaned (no matching profile) |
| --- | --- | --- | --- |
| `service_reports` | 1 | 0 | 0 |
| `dtr_records` | 18 | 0 | 0 |
| `leave_requests` | 0 | 0 | 0 |
| `cash_advance_requests` | 0 | 0 | 0 |
| `device_locks` | 4 | 0 | 0 |
| `dispatch_tickets` | 5 | n/a | 0 missing `assignedWorkerIds` |

All 8 profiles are active with a matching `auth.users` row: 1 admin, 7
technicians, no restriction flags set. Every `technician_id` already points at a
valid profile, so the new ownership policies will not orphan any existing row and
**no data migration is required.**

### Before / after, same probe suite

| Probe | Before | After |
| --- | --- | --- |
| anon reads dispatch tickets | 5 | 0 |
| anon deletes a dispatch ticket | **succeeded** | blocked |
| anon reads technician roster | 7 rows | permission denied |
| anon reads `jo_counters` | 3 rows | permission denied |
| technician draws an SR number | **fails, 42501** | `SR-20260821-001` |
| technician submits a liquidation | **fails silently** | saved |
| technician self-approves that liquidation | n/a | neutralised, stays `pending` |
| technician inserts a pre-approved leave request | n/a | forced to `pending`, `decidedBy` cleared |
| technician edits their own pending leave dates | blocked | works |
| technician reassigns a ticket they are on | n/a | neutralised, assignment preserved |
| technician sets a bogus ticket status | n/a | reverted |
| technician acknowledges their own ticket | works | works |
| technician sees only assigned tickets | 4 of 5 | 1 of 5 |
| admin: decisions, disbursement, liquidation, settings, SR number | works | works |

### Still outstanding — needs you

Section 7 of the migration (closing the anonymous roster read) **must be applied
together with deploying the `list-technicians` Edge Function**, because the
sign-in screen builds its technician dropdown while still anonymous. Apply
section 7 without deploying that function and the dropdown comes up empty. The
migration contains a copy-paste rollback for just that section.

I have **not** applied anything to your production database. Everything above was
rehearsed on a local replica.


---

## Deployment status — 22 Aug 2026, 01:45 PST

**Part 1 has been applied to production** (`ugxrrgocjpkzumhghzat`), recorded in
Supabase migration history as `awes_security_fixes_part1`.

Verified against the live database afterwards: 35 policies (up from 32), no
`anon full access` policy remaining anywhere, four correct `dispatch_*` policies,
both counter RPCs now `SECURITY DEFINER`, all four guard triggers present,
`is_install` column added, 7 new indexes created. Row counts unchanged —
5 dispatch tickets, 18 DTR, 1 report, 8 profiles, 3 customers, 4 device locks.

End-to-end check over HTTPS using the anon key that ships in the client bundle:

| Request as `anon` | Result |
| --- | --- |
| `GET /dispatch_tickets` | `200 []` — closed (was returning all 5) |
| `DELETE /dispatch_tickets?id=eq...` | 0 rows affected — closed |
| `GET /jo_counters` | `401` / `42501` |
| `GET /sr_counters` | `401` / `42501` |
| `GET /app_settings` | `401` / `42501` |
| `GET /profiles` | still readable — **expected, this is Part 2** |

A tested rollback for Part 1 is at
`supabase/migrations/ROLLBACK_20260822_01.sql`. On the replica it restored the
original 32-policy set byte-for-byte (32 -> 35 -> 32).

**Still to do (needs your hands):** publish the new bundle to GitHub Pages, deploy
the `list-technicians` Edge Function, then apply Part 2.
`ALLOWED_ORIGINS` in the function is now set to `https://awesmanila-rgb.github.io`.

## Technician homepage — "Need to do now" (2026-09-24)
- Replaced the swipeable Overview carousel with **Need to do now**: every action waiting on the technician as its own card (step tag, icon, large title, one plain sentence, full-width button), ranked so Step 1 is always what to do first.
- Ranking: Time in → finish service reports (Work in Progress) → Arrived at Site (En Route) → Acknowledge (late first) → report drafts → material request to fix/submit → sign tool / material slips → return overdue tools → liquidation → unread messages → Time out.
- Acknowledge and Arrived at Site run directly from the homepage after a confirm, using the same dtAcknowledge / dtMarkArrived as My Job Order (same customer/admin notifications). Time In is ranked first but does not block other actions.
- Job-order tasks show a 3-step tracker: Accept → Arrive at site → Report.
- New sections: **Waiting for approval** (pending cash advances, reimbursements, liquidations, leaves, material requests), **Coming up** (next 3 scheduled job orders), and **Request or check** (10 labelled tiles incl. Attendance, Messages, Cash advance, Reimbursement, Leave; Finance & HR tile removed — each item has its own tile).
- Greeting rebuilt: large greeting, date, and an attendance strip (Time in / Time out) that opens DTR. Fixed instruction paragraph removed.
- Larger type throughout (greeting 26px, section titles 21px, task titles 18–20px), single centered 760px column for the technician home. No migration needed.

## Customer portal homepage redesign (2026-09-24)
- New layout: white header with company mark, greeting and account chip (switch accounts from the chip); **Action needed** (fee to approve, schedule to confirm, issue found on a visit, PM overdue with no request); **Next / Current visit** (date and time, assigned technician, 5-step tracker Booked → Confirmed → On the way → Working → Done); three main actions (Book a service, Report a problem, Message us); **Your units** (status summary + units needing maintenance); **Upcoming maintenance** (next 90 days, grouped by date, one-tap Book); **Recent service reports** (with PDF download); **Support** card. Two columns on desktop.
- Honest wording: removed "Your AC units are being monitored", "Operating well / Good health", "Filter check needed", and the "Quotes and invoices" tile. Unit status now describes the PM date only. "On the way" lights up only at En Route (after the crew acknowledges).
- Tabs: Home, Units, Requests, History, Account. Tools moved to Account → Tools and calculators.
- Report a problem: opens the request form preset to Urgent with guidance.
- Units screen: status filter chips (PM overdue / Due soon / Up to date / No PM date) with counts; Home summary opens it pre-filtered.
- Arrival notice: the "on the way" push now names the technician(s), the job order, and the expected arrival time.
- PM reminders: new pm-reminders Edge Function + migration 20260924_05_pm_reminders.sql + setup/pm_reminders_cron.sql (daily 8:00 AM). One push per account for units due within 7 days, once per PM date, skipped when a request is already open.
- Fix (in the same migration): push_subscriptions.customer_id was bigint while customer ids are uuid, which blocked customer devices from registering for push. Converted to uuid, only if still bigint.
- Support card: set CP_SUPPORT.phone / hours in customer-portal.js; a Call button shows only when a phone number is set.

## Customer portal — Tools redesign + inverter field (2026-09-25)
- Bottom bar: Home, Units, Requests, **Tools**, Account (History moved to Account → Service history; the Home "Full history" link stays). Five equal tabs, same icon size.
- Tools page redesigned to match Home: white header, search, tip of the day, 6 calculators in an even 2-column grid, 19 tips with category chips (Save energy, Care, Warning signs, Buying guide, Fire safety), help card. Two columns on desktop.
- Calculators — result card on top, large inputs, "How this is calculated", one next-step button:
  - Electricity cost: reads the customer's units (HP / TR / BTU / kW), per-unit inverter toggle, hours + days, rate default ₱14.74 (Meralco Sept 2026), optional rated watts; monthly / daily / yearly and inverter savings. Fixes: old ₱12 rate, HP-only input (5 TR units undercounted by a third), 30-day full-load assumption.
  - Right size for a room: adds ceiling height, sun exposure, people, equipment watts; answers in HP, TR and kW; large spaces get a TR total.
  - Maintenance value: rebuilt — adjustable breakdown chance with/without PM, energy lost to dirty coils; shows a negative net honestly (old version assumed one avoided repair per unit per year and hid losses as ₱0).
  - New: Inverter upgrade payback, Unit converter (HP · TR · BTU/h · kW), Maintenance schedule (interval + next due date).
- Inverter yes/no: uses the existing Compressor Type field (Inverter / Non-Inverter). Admin equipment detail now edits it as Inverter / Non-inverter / Not known; the customer portal loads it, shows it on the unit detail, and the calculators use it (customer can still set it for units with no type on record). No migration.
- Desktop top bar brand: "AWES Customer Portal".


## New: Technician Calculators (js/modules-src/tech-tools.js)

A "Calculators" tile on the technician Home screen (Quick Actions) opens a
new screen with the same visual design as the customer portal's Tools
screen, reusing its calculator shell (`cpCalcShell` in customer-portal.js,
now host-aware via `cpCalcHostTech`) so both stay in sync with one code path.

Calculators:
- **Ductulator** — round & rectangular duct sizing by velocity or by the
  equal-friction method, using real duct airflow physics (Darcy-Weisbach
  with the Swamee-Jain friction factor for galvanized duct), not a rough
  curve fit. Rectangular sizing uses the ASHRAE/Huebscher equivalent-diameter
  equation.
- **Wire & breaker sizing** — exact sizing from a nameplate FLA/MCA, using
  the 125%-of-FLA continuous-load rule (NEC 440 / PEC) against the standard
  75°C copper THHN ampacity table.

Reference tables:
- **Heat load standards** — BTU/hr for people (sensible/latent by activity),
  lighting (with ballast/driver factors), and common office equipment.
- **Refrigerant pressures** — P-T chart for R-22, R-410A, R-32, R-134a,
  R-290 and R-600a, computed from a Peng-Robinson equation of state fit to
  each fluid's published boiling curve (typically within ~1–1.5% of a
  manufacturer chart).
- **Electrical standards** — typical breaker/wire ranges by HP/TR, plus
  control and VRF communication wiring notes.
- **Pipe sizing** — liquid/suction line OD by capacity, 1 HP to 10 TR.
- **Troubleshooting & error codes** — symptom → likely cause → checks
  (not cooling, electrical, noise, water/drainage), plus commonly seen
  error-code meanings for Daikin, Carrier/Midea-built inverters, LG and
  Samsung — all clearly flagged as typical/reference, not a substitute for
  the specific unit's own nameplate or manual.

### Accuracy review before merging (corrected in this version)

- **Wire & breaker:** the ampacity table holds the **60°C** copper values (the safe default for circuits
  up to 100 A under NEC 110.14(C)) but was labelled 75°C — label and help text corrected. Code
  references fixed: wire at 125% of rated current is **NEC 440.32**; the breaker maximum is the
  nameplate **MOCP** (up to 175%, NEC 440.22). The result now shows the maximum-breaker reminder.
- **Refrigerant P-T chart:** replaced with reference values (CoolProp / REFPROP-grade equations of
  state). The earlier values were within about 1%.
- **Heat load (people):** rows re-matched to ASHRAE Fundamentals — "seated, light office work" was the
  "seated, very light work" row; "heavy work" was really "moderate dancing"; standing latent was 200
  (should be 250). Added office, restaurant and true heavy-work rows.
- **Pipe sizing:** small splits were one size too big (e.g. 1 HP is 1/4" x 3/8", not 1/2" suction —
  an oversized suction line hurts oil return); removed 1" (not a standard ACR size); added BTU/h.
- **Electrical ranges (5–10 TR):** were about 20% low; recomputed at 1.0–1.3 kW input per TR.
- **Error codes:** corrected several wrong meanings — Daikin (C9, J-series, U5), LG CH01/CH02/CH03/CH05,
  Samsung E121/E162/E458, and the Midea-platform list.
- **Ductulator:** math verified against a full Colebrook-White solution (matches to within 0.3%);
  added a warning when a rectangular duct is flatter than 4:1.
- **Icons:** the Ductulator, Pipe sizing and Heat load tiles used icons that don't exist in the app
  (blank tiles) — added them.

