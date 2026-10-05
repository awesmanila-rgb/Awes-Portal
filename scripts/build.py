from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "js" / "modules-src"
OUT = ROOT / "js" / "app.bundle.js"
MODULES = [
    "core.js", "equipment-photos.js", "auth.js", "service-report.js", "customers.js", "admin.js",
    "email.js", "ui.js", "pdf.js", "history.js", "leave.js", "dispatch.js", "service-requests.js",
    "cash-advance.js", "push.js", "purchasing.js", "purchase-orders.js", "purchased-items.js", "requisitions.js", "materials-trail.js", "inventory.js", "inventory-moves.js", "inventory-wizard.js", "inventory-reports.js", "tools.js", "payroll.js", "payroll-timesheets.js", "payroll-runs.js", "errands.js", "admin-office.js", "back-entry.js", "admin-priority.js", "home.js", "staff.js", "messenger.js", "ops-dashboard.js", "employees.js", "guide-content.js", "guide.js", "tracker.js", "announcements.js",
    "customer-portal.js", "tech-tools.js", "customer-equipment-history.js"
]
# encoding="utf-8" is required here — without it, Python on Windows falls back
# to the system's regional codepage (often cp1252), which crashes on the
# em-dashes, arrows, and emoji used throughout these source files.
body = "\n\n".join((SRC / name).read_text(encoding="utf-8") for name in MODULES)
OUT.write_text(
    '(function(){\n  "use strict";\n' + body + '\n})();\n',
    encoding="utf-8"
)
print(f"Built {OUT} from {len(MODULES)} source modules")
