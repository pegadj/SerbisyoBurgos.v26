/**
 * Shared "credentials shown once" dialog for resident logins.
 *
 * Used by Resident Accounts (issue login / reset password) and Resident Profiling
 * (when a resident is added with "Also issue a login now" ticked).
 *
 * Usage:  SB_CREDS.show({ residentId, password }, "Juan Dela Cruz", "Login issued");
 *
 * The dialog injects its own styles and markup the first time it is shown, so a page
 * only needs to include this script.
 */
(function () {
    "use strict";

    var lastCreds = null;
    var built = false;

    function esc(value) {
        return String(value == null ? "" : value).replace(/[&<>"']/g, function (ch) {
            return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
        });
    }

    function $(id) {
        return document.getElementById(id);
    }

    function build() {
        if (built) return;
        built = true;

        var style = document.createElement("style");
        style.textContent =
            "#sbCredOverlay{display:none;position:fixed;inset:0;background:rgba(15,23,42,.55);z-index:3000;align-items:center;justify-content:center;padding:1rem;}" +
            "#sbCredOverlay.show{display:flex;}" +
            "#sbCredOverlay .sbc-box{background:#fff;border-radius:16px;width:min(460px,100%);max-height:92vh;overflow-y:auto;padding:1.5rem;font-family:inherit;}" +
            "#sbCredOverlay h2{margin:0 0 .25rem;color:var(--brand-dark,#043d2e);font-size:1.25rem;}" +
            "#sbCredOverlay .sbc-hint{color:var(--text-muted,#64748b);font-size:.85rem;line-height:1.5;margin:.5rem 0;}" +
            "#sbCredOverlay .sbc-cred{border:2px dashed #16a34a;background:#f0fdf4;border-radius:12px;padding:.85rem 1.1rem;margin:.75rem 0;}" +
            "#sbCredOverlay .sbc-row{display:flex;justify-content:space-between;align-items:center;gap:1rem;padding:.4rem 0;font-size:.9rem;color:#334155;}" +
            "#sbCredOverlay .sbc-row b{font-family:ui-monospace,Consolas,monospace;font-size:1.05rem;color:#0f172a;word-break:break-all;text-align:right;}" +
            "#sbCredOverlay .sbc-actions{display:flex;gap:.75rem;justify-content:flex-end;flex-wrap:wrap;margin-top:1rem;}" +
            "#sbCredOverlay .sbc-btn{font:inherit;font-weight:600;padding:.6rem 1.1rem;border-radius:10px;border:1px solid #cbd5e1;background:#fff;cursor:pointer;}" +
            "#sbCredOverlay .sbc-btn.primary{background:var(--brand-green,#16a34a);border-color:var(--brand-green,#16a34a);color:#fff;}";
        document.head.appendChild(style);

        var overlay = document.createElement("div");
        overlay.id = "sbCredOverlay";
        overlay.setAttribute("role", "dialog");
        overlay.setAttribute("aria-modal", "true");
        overlay.setAttribute("aria-labelledby", "sbCredTitle");
        overlay.innerHTML =
            '<div class="sbc-box">' +
            '<h2 id="sbCredTitle">Login ready</h2>' +
            '<p class="sbc-hint" id="sbCredFor"></p>' +
            '<p class="sbc-hint" id="sbCredSms" style="display:none;font-weight:600;"></p>' +
            '<div class="sbc-cred">' +
            '<div class="sbc-row"><span>Resident ID</span><b id="sbCredId"></b></div>' +
            '<div class="sbc-row"><span>Password</span><b id="sbCredPw"></b></div>' +
            "</div>" +
            '<p class="sbc-hint"><strong>This password is shown only once.</strong> Print the slip or copy it now and give it to the resident. ' +
            "Type it exactly as shown (capital letters, with the dash). At first login they will be asked to choose their own password, so only they will know it.</p>" +
            '<div class="sbc-actions">' +
            '<button class="sbc-btn" id="sbCredCopy" type="button">Copy</button>' +
            '<button class="sbc-btn" id="sbCredPrint" type="button">Print slip</button>' +
            '<button class="sbc-btn primary" id="sbCredDone" type="button">Done</button>' +
            "</div></div>";
        document.body.appendChild(overlay);

        $("sbCredDone").addEventListener("click", close);

        $("sbCredCopy").addEventListener("click", function () {
            if (!lastCreds) return;
            var btn = $("sbCredCopy");
            var text = "Resident ID: " + lastCreds.residentId + "\nPassword: " + lastCreds.password;
            var done = function (label) {
                btn.textContent = label;
                setTimeout(function () { btn.textContent = "Copy"; }, 1500);
            };
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(text).then(function () { done("Copied!"); }, function () { done("Copy failed"); });
            } else {
                done("Copy failed");
            }
        });

        $("sbCredPrint").addEventListener("click", printSlip);
    }

    function close() {
        var overlay = $("sbCredOverlay");
        if (overlay) overlay.classList.remove("show");
        if ($("sbCredPw")) $("sbCredPw").textContent = "";
        lastCreds = null;
    }

    function printSlip() {
        if (!lastCreds) return;
        var loginUrl = new URL("../login.html", window.location.href).href;
        var w = window.open("", "_blank", "width=520,height=700");
        if (!w) {
            alert("Please allow pop-ups to print the slip.");
            return;
        }
        w.document.write(
            '<!doctype html><html><head><meta charset="utf-8"><title>Resident account slip</title>' +
            "<style>body{font-family:system-ui,Arial,sans-serif;padding:32px;color:#0f172a}h1{font-size:20px;margin:0 0 4px;color:#043d2e}" +
            ".sub{color:#64748b;font-size:13px;margin-bottom:24px}.box{border:2px dashed #16a34a;border-radius:12px;padding:18px 22px;background:#f0fdf4}" +
            ".row{display:flex;justify-content:space-between;padding:8px 0;font-size:15px}.row b{font-family:ui-monospace,Consolas,monospace;font-size:18px}" +
            "ol{font-size:13px;color:#334155;line-height:1.7;padding-left:18px}.foot{margin-top:28px;font-size:12px;color:#64748b}</style></head><body>" +
            "<h1>SerbisyoBurgos — Resident Account</h1><div class=\"sub\">Barangay Burgos online services</div>" +
            "<p><strong>" + esc(lastCreds.fullName) + "</strong></p>" +
            '<div class="box"><div class="row"><span>Resident ID</span><b>' + esc(lastCreds.residentId) + "</b></div>" +
            '<div class="row"><span>Password</span><b>' + esc(lastCreds.password) + "</b></div></div>" +
            "<ol><li>Open <strong>" + esc(loginUrl) + "</strong></li><li>Enter your Resident ID and this password, then log in.</li>" +
            "<li>You will be asked to choose your own new password. Do this right away.</li><li>Keep this slip private. Do not share your password.</li></ol>" +
            '<div class="foot">Lost your password? Visit the barangay office to get a new one.</div>'
        );
        w.document.close();
        w.focus();
        setTimeout(function () { w.print(); }, 250);
    }

    // Plain-English line for the "text the credentials" result returned by the server.
    function smsLine(sms) {
        if (!sms || sms === "not requested") return null;
        if (sms === "sent") return { ok: true, text: "✓ The Resident ID and password were also texted to the resident." };
        return { ok: false, text: "✗ Not texted: " + sms + ". Give the password to the resident another way." };
    }

    function show(creds, who, title, sms) {
        build();
        var c = creds || {};
        lastCreds = { residentId: c.residentId || "", password: c.password || "", fullName: who || "" };
        $("sbCredTitle").textContent = title || "Login ready";
        $("sbCredFor").textContent = who || "";
        $("sbCredId").textContent = c.residentId || "—";
        $("sbCredPw").textContent = c.password || "";
        var line = smsLine(sms);
        var smsEl = $("sbCredSms");
        smsEl.style.display = line ? "" : "none";
        smsEl.textContent = line ? line.text : "";
        smsEl.style.color = line && line.ok ? "#15803d" : "#b91c1c";
        $("sbCredOverlay").classList.add("show");
    }

    // ---- Bulk helpers: list = [{ residentId, fullName, password }] ----
    function csvCell(value) {
        var t = String(value == null ? "" : value);
        if (/^[=+\-@\t\r]/.test(t)) t = "'" + t; // stop spreadsheet formula injection from names
        return '"' + t.replace(/"/g, '""') + '"';
    }

    function downloadCsv(list, filename) {
        var withSms = (list || []).some(function (x) { return x.sms && x.sms !== "not requested"; });
        var head = ["Resident ID", "Name", "Password"].concat(withSms ? ["Text message"] : []);
        var rows = [head].concat(
            (list || []).map(function (x) { return [x.residentId, x.fullName, x.password].concat(withSms ? [x.sms || ""] : []); })
        );
        var text = "\ufeff" + rows.map(function (r) { return r.map(csvCell).join(","); }).join("\r\n");
        var blob = new Blob([text], { type: "text/csv;charset=utf-8" });
        var url = URL.createObjectURL(blob);
        var a = document.createElement("a");
        a.href = url;
        a.download = filename || "resident-logins.csv";
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
    }

    function printMany(list) {
        if (!list || !list.length) return;
        var loginUrl = new URL("../login.html", window.location.href).href;
        var w = window.open("", "_blank", "width=900,height=800");
        if (!w) {
            alert("Please allow pop-ups to print the slips.");
            return;
        }
        var slips = list.map(function (x) {
            return '<div class="slip"><h1>SerbisyoBurgos — Resident Account</h1>' +
                "<p class=\"name\">" + esc(x.fullName) + "</p>" +
                '<div class="box"><div class="row"><span>Resident ID</span><b>' + esc(x.residentId) + "</b></div>" +
                '<div class="row"><span>Password</span><b>' + esc(x.password) + "</b></div></div>" +
                '<p class="how">Log in at <strong>' + esc(loginUrl) + "</strong> with your Resident ID and this password (capital letters, with the dash). " +
                "You will then choose your own password. Keep this slip private.</p></div>";
        }).join("");
        w.document.write(
            '<!doctype html><html><head><meta charset="utf-8"><title>Resident account slips</title>' +
            "<style>body{font-family:system-ui,Arial,sans-serif;margin:16px;color:#0f172a}" +
            ".grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}" +
            ".slip{border:1px dashed #94a3b8;border-radius:10px;padding:12px 14px;page-break-inside:avoid;break-inside:avoid}" +
            "h1{font-size:13px;margin:0 0 4px;color:#043d2e}.name{font-weight:700;font-size:14px;margin:0 0 8px}" +
            ".box{border:2px dashed #16a34a;border-radius:8px;padding:6px 12px;background:#f0fdf4}" +
            ".row{display:flex;justify-content:space-between;padding:4px 0;font-size:13px}" +
            ".row b{font-family:ui-monospace,Consolas,monospace;font-size:16px}.how{font-size:11px;color:#475569;line-height:1.5;margin:8px 0 0}" +
            "</style></head><body><div class=\"grid\">" + slips + "</div>"
        );
        w.document.close();
        w.focus();
        setTimeout(function () { w.print(); }, 300);
    }

    window.SB_CREDS = { show: show, smsLine: smsLine, close: close, downloadCsv: downloadCsv, printMany: printMany };
})();