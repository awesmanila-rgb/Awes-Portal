# AWES Admin — User Guide

**For:** Office / dispatch administrators
**Time to cover in orientation:** ~60 minutes

Admin drives the whole workflow. Nothing moves between a customer and a technician without an admin action.

---

## 1. Signing in

Admin signs in with the **admin password** from the staff login screen. Admin keeps the full **sidebar menu** (technicians use a bottom bar instead).

**Sidebar sections:** Dashboard · Technicians · Dispatch · Service Requests · Cash Advance · Liquidation · Reimbursement · Administration

---

## 2. The service request pipeline

This is the core of the system. A customer request moves through stages, and **admin controls every transition**.

**Sidebar → Service Requests.** The badge shows how many need attention.

| Stage | Who acts | What happens |
|---|---|---|
| **New** | Customer submitted | Review it |
| **Acknowledged** | **Admin** | Accept it, with or without a fee |
| **Fee Proposed** | **Admin** | You quote an amount → customer accepts or declines |
| **Fee Accepted** | Customer | Ready to schedule |
| **Schedule Proposed** | **Admin** | You propose a date → customer confirms |
| **Schedule Confirmed** | Customer | Ready to dispatch |
| **Dispatched** | **Admin** | You create the job order |
| **En Route / In Progress** | Technician | Updates automatically |
| **Completed** | Technician | Set when the job order is closed |

### Handling a new request

1. Open it. Check the requested date, the site access requirements, and the contact person.
2. **If a fee applies:** enter the amount and propose it. The customer is notified and must accept before you schedule.
   **If no fee:** acknowledge without one and go straight to scheduling.
3. **If the requested date works**, acknowledge it. **If not**, propose an alternative date — the customer confirms or cancels.
4. Once at **Schedule Confirmed**, create the dispatch ticket.

> The request pauses at every customer step. If a job seems stuck, check whether it's waiting on the customer to accept a fee or confirm a date.

---

## 3. Creating job orders

There are **two ways**, and the difference matters.

### A. From a service request *(preferred)*
Open the request → **Convert to Dispatch Ticket**. The form is pre-filled, and the ticket is automatically linked back to the customer's request — so their progress tracker follows the job.

### B. Directly from Dispatch
**Sidebar → Dispatch → Create.** Use this for preventive maintenance, phone-in jobs, and anything you schedule proactively.

> The system now creates a matching customer-facing record automatically, so the customer still sees the scheduled visit and can track it. This only applies to job orders created **after** this update.

### Filling the ticket

- **Customer** — pick from the list so the equipment and history link up
- **Date and expected time**
- **Technicians** — one or more. *All of them must acknowledge and complete it.*
- **Equipment** — add every unit to be serviced; each needs its own service report
- **Requirements** — work permit, gate pass, safety, other
- **Remarks** — anything the technician needs to know

---

## 4. Monitoring work

**Sidebar → Dispatch.** Filter tabs: Open · Acknowledged · Completed · Expired · Closed · Cancelled · All.

- **Expired** — the date passed with nobody acknowledging. These close automatically and **cannot be revived**; create a new job order instead.
- **Calendar view** shows scheduled tickets by date.
- **Live map** shows where timed-in technicians are.

### Continuing multi-day work

When a technician closes a job order with units marked *"not completed"*, the customer's service stays open. Open that closed ticket and tap **"Continue Tomorrow"** — a new job order opens, pre-filled with just the unfinished units and the technician's notes. Assign technicians, set the date, save.

---

## 5. Cancellations

**Customer requests one on a dispatched job:** it appears in the request's admin actions. **Accept** (cancels both the request and the job order) or **Reject** (work continues).

**Cancelling yourself:** either from the service request, or from the job order's own screen. Both require a reason. Available only before the work is marked completed — after that, use **Close Job Order** and flag what wasn't done.

---

## 6. Finance approvals

| Screen | What you do |
|---|---|
| **Cash Advance** | Approve/decline requests; mark as disbursed |
| **Liquidation** | Review receipts against the advance; approve or return |
| **Reimbursement** | Review claims for money technicians spent themselves |

Receipt photos are stored securely and opened from within each record.

---

## 7. Administration

- **Technicians** — add accounts, set usernames, reset passwords, deactivate leavers
- **Customers** — accounts, contact details, equipment records, portal logins
- **Announcements** — messages shown on technicians' home screens
- **Dropdown lists** — the option lists used across forms

> Customers cannot edit their own details. Corrections come through you.

---

## 8. Notifications

**Sidebar → cloud icon → Shared Cloud Setup → Turn on notifications.**

You'll be alerted about new service requests, confirmed schedules, cancellation requests, and job orders being started or closed — even with the app closed.

---

## 9. Things to watch

**A request is "stuck".** It's almost always waiting on the customer to accept a fee or confirm a date.

**A technician can't file a report.** They haven't tapped **Acknowledge** on that job order. If it expired, issue a new one.

**A job order sat unacknowledged past its date.** It expired and closed itself — this is deliberate, since there's no attendance record to support a visit that didn't happen. Create a replacement.

**A technician reports a red sync bar.** Something was rejected by the server, not a signal problem. Get the reason from **View** — it won't clear on its own.

---

## 10. Daily rhythm

**Morning** — check Service Requests for new submissions; confirm today's dispatch board; check for expired tickets.

**During the day** — respond to fee/schedule steps; watch jobs move to En Route and In Progress; handle cancellation requests.

**End of day** — confirm job orders were closed; raise **Continue Tomorrow** tickets for unfinished work; clear finance approvals.
