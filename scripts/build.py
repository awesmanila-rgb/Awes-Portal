from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "js" / "modules-src"
OUT = ROOT / "js" / "app.bundle.js"
MODULES = [
    "core.js", "equipment-photos.js", "auth.js", "service-report.js", "customers.js", "admin.js",
    "email.js", "ui.js", "pdf.js", "history.js", "leave.js", "dispatch.js", "service-requests.js",
    "cash-advance.js", "push.js", "purchasing.js", "purchase-orders.js", "purchased-items.js", "requisitions.js", "materials-trail.js", "inventory.js", "inventory-moves.js", "inventory-wizard.js", "site-deliveries.js", "inventory-reports.js", "tools.js", "payroll.js", "payroll-timesheets.js", "payroll-runs.js", "errands.js", "admin-office.js", "back-entry.js", "admin-priority.js", "home.js", "staff.js", "messenger.js", "ops-dashboard.js", "employees.js", "guide-content.js", "guide.js", "tracker.js", "announcements.js",
    "customer-portal.js", "tech-tools.js", "customer-equipment-history.js"
]
# encoding="utf-8" is required here — without it, Python on Windows falls back
# to the system's regional codepage (often cp1252), which crashes on the
# em-dashes, arrows, and emoji used throughout these source files.
# index.html and the bundle ship together. If they are from different releases the app can stop part-way
# through starting (a blank white page), so the very first thing the bundle does is check the version
# marker in index.html (<meta name="awes-index-version">) and show a clear message when it is too old.
# Bump INDEX_MIN only in a release that changes index.html, and update the meta tag to match.
INDEX_MIN = 224
GUARD = """
  (function(){
    var NEED = %d;
    function show(msg){
      try{
        var d = document.createElement('div');
        d.setAttribute('role', 'alert');
        d.style.cssText = 'position:fixed;left:0;right:0;top:0;z-index:2147483647;background:#B3402D;color:#fff;padding:14px 18px;font:600 15px/1.4 system-ui,sans-serif;text-align:center;';
        d.textContent = msg;
        (document.body || document.documentElement).appendChild(d);
      }catch(e){}
    }
    var m = document.querySelector('meta[name="awes-index-version"]');
    var have = m ? parseInt(m.getAttribute('content'), 10) : 0;
    if(!(have >= NEED)) show('The app files are out of date: upload the latest index.html together with the rest, then reload the page (clear the site data if it still looks the same).');
  })();
""" % INDEX_MIN
body = GUARD + "\n\n".join((SRC / name).read_text(encoding="utf-8") for name in MODULES)
OUT.write_text(
    '(function(){\n  "use strict";\n' + body + '\n})();\n',
    encoding="utf-8"
)
print(f"Built {OUT} from {len(MODULES)} source modules")
