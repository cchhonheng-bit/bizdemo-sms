/* Public shop website v2 (D-96): the behaviour of the six screens. Same origin, no dependencies, no inline script (CSP).
   Messages for the page's language come from <script type="application/json" id="msg">. */
(function () {
  "use strict";
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var body = document.body, page = body.dataset.page, lang = body.dataset.lang;
  var M = {};
  try { M = JSON.parse(($("#msg") || {}).textContent || "{}"); } catch (e) { M = {}; }

  function msg(code) { return M[code] || M.ERROR || code; }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function num(sel) { var v = $(sel) && $(sel).value; return v ? Number(v) : null; }
  function showErr(el, code) { if (!el) return; el.textContent = msg(code); el.hidden = false; if (el.scrollIntoView) el.scrollIntoView({ block: "nearest" }); }
  function hideErr(el) { if (el) el.hidden = true; }
  /** a message goes away as soon as the visitor changes something */
  function clearOnEdit(root, err) { if (!root) return; ["input", "change"].forEach(function (ev) { root.addEventListener(ev, function () { hideErr(err); }); }); }
  function busy(btn, on) {
    if (!btn) return;
    if (on) { btn.dataset.label = btn.textContent; btn.textContent = M.SENDING || "..."; btn.disabled = true; }
    else { btn.textContent = btn.dataset.label || btn.textContent; btn.disabled = false; }
  }
  function send(method, url, data) {
    return fetch(url, { method: method, credentials: "same-origin", headers: data === undefined ? {} : { "content-type": "application/json" }, body: data === undefined ? undefined : JSON.stringify(data) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, status: r.status, json: j || {} }; }); });
  }

  // ---- opened inside Telegram (Mini App): Telegram's own script (the only outside script the CSP allows) → full height;
  //      on the sign-in screen the launch data signs the customer in (the hub checks its signature)
  var inTelegram = /tgWebAppData=/.test(location.hash);
  try { inTelegram = inTelegram || !!sessionStorage.getItem("__telegram__initParams"); } catch (e) { /* storage blocked */ }
  if (inTelegram) {
    var tgs = document.createElement("script");
    tgs.src = "https://telegram.org/js/telegram-web-app.js";
    tgs.async = true;
    tgs.onload = function () {
      var tg = window.Telegram && window.Telegram.WebApp;
      if (!tg) return;
      try { tg.ready(); tg.expand(); } catch (e) { /* older clients */ }
      if (page === "login" && tg.initData) send("POST", "/api/public/tg-login", { init_data: tg.initData }).then(function (r) { if (r.ok) location.replace("/my"); });
    };
    document.head.appendChild(tgs);
  }

  // ---- "use my current location"
  function geo(btn, err) {
    if (!btn) return;
    btn.addEventListener("click", function () {
      if (!navigator.geolocation) return showErr(err, "GPS_FAILED");
      navigator.geolocation.getCurrentPosition(function (p) {
        $("#lat").value = p.coords.latitude.toFixed(6);
        $("#lng").value = p.coords.longitude.toFixed(6);
        btn.classList.add("ok");
        var label = $("span", btn);
        if (label && btn.dataset.ok) label.textContent = btn.dataset.ok + " ✓";
        hideErr(err);
      }, function () { showErr(err, "GPS_FAILED"); }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 });
    });
  }

  // ---- day chips + time slots (server-rendered on the booking screen, drawn here for a reschedule request)
  function bindPicker(root, onPick) {
    var state = { at: null, label: null };
    root.addEventListener("click", function (e) {
      var day = e.target.closest(".day"), slot = e.target.closest(".slot");
      if (day && !day.disabled) {
        $$(".day", root).forEach(function (d) { d.setAttribute("aria-pressed", d === day ? "true" : "false"); });
        $$(".slots", root).forEach(function (s) { s.hidden = s.dataset.for !== day.dataset.day; });
        $$(".slot", root).forEach(function (s) { s.setAttribute("aria-pressed", "false"); });
        var m = $("#month", root) || $("[data-month-label]", root);
        if (m && day.dataset.month) m.textContent = day.dataset.month;
        state.at = null; state.label = null; onPick(state);
      }
      if (slot && !slot.disabled) {
        $$(".slot", root).forEach(function (s) { s.setAttribute("aria-pressed", s === slot ? "true" : "false"); });
        state.at = slot.dataset.at; state.label = slot.dataset.label; onPick(state);
      }
    });
    return state;
  }
  function renderPicker(root, days, titles) {
    var sel = -1;
    var anyFree = function (d) { return d.slots.some(function (s) { return s.free; }); };
    var dayNo = function (d) { return Number(d.date.slice(8, 10)); };
    var monthOf = function (d) { return M.mon[Number(d.date.slice(5, 7)) - 1] + " " + d.date.slice(0, 4); };
    days.forEach(function (d, i) { if (sel < 0 && anyFree(d)) sel = i; });
    var first = days[Math.max(sel, 0)];
    var h = '<div class="hr"><h2 class="h2">' + esc(titles.day) + '</h2><span class="mut" data-month-label>' + (first ? esc(monthOf(first)) : "") + '</span></div><div class="days">';
    days.forEach(function (d, i) {
      h += '<button type="button" class="day" data-day="' + esc(d.date) + '" data-month="' + esc(monthOf(d)) + '" aria-pressed="' + (i === sel) + '"' + (anyFree(d) ? "" : " disabled") + "><small>" + esc(M.wds[d.dow - 1]) + "</small><b>" + dayNo(d) + "</b></button>";
    });
    h += '</div><div class="hr t"><h2 class="h2">' + esc(titles.time) + "</h2></div>";
    days.forEach(function (d, i) {
      h += '<div class="slots" data-for="' + esc(d.date) + '"' + (i === sel ? "" : " hidden") + ">";
      d.slots.forEach(function (s) {
        var label = M.wd[d.dow - 1] + " " + dayNo(d) + " " + M.mon[Number(d.date.slice(5, 7)) - 1] + " · " + s.time;
        h += '<button type="button" class="slot" data-at="' + esc(s.at) + '" data-label="' + esc(label) + '" aria-pressed="false"' + (s.free ? "" : " disabled") + ">" + esc(s.time) + "</button>";
      });
      h += "</div>";
    });
    root.innerHTML = h;
  }

  // ---- 1 · home: the services beyond the first four
  if (page === "home") {
    var more = $("#more");
    if (more) more.addEventListener("click", function () { $$("[data-more]").forEach(function (a) { a.hidden = false; }); more.hidden = true; });
  }

  // ---- 2 + 3 · choose a time → your details → send
  if (page === "book") (function () {
    var s2 = $("#s2"), s3 = $("#s3"), pick = $("#pick"), next = $("#next"), err = $("#err"), err3 = $("#err3");
    var st = bindPicker($("#picker"), function (p) { pick.textContent = p.label || "—"; hideErr(err); });
    geo($("#gps"), err);
    clearOnEdit(s2, err); clearOnEdit(s3, err3);
    function step(n) { s2.hidden = n !== 2; s3.hidden = n !== 3; window.scrollTo(0, 0); }
    if (location.hash === "#details") history.replaceState(null, "", location.pathname + location.search); // a reload starts at the time
    if (next) next.addEventListener("click", function () {
      var addr = $("#addr").value.trim();
      if (!st.at) return showErr(err, "PICK_SLOT");
      if (addr.length < 3 && !$("#lat").value) return showErr(err, "ADDRESS_REQUIRED");
      $("#sum-when").textContent = st.label;
      $("#sum-loc").textContent = addr || ($("#gps").dataset.ok + " ✓");
      history.pushState({ step: 3 }, "", "#details");
      step(3);
    });
    window.addEventListener("popstate", function () { step(location.hash === "#details" && st.at ? 3 : 2); });
    $("[data-back]").addEventListener("click", function (e) { e.preventDefault(); history.back(); });
    /** somebody else took the time: show what is free now, keep what the visitor typed */
    function refresh() {
      return send("GET", "/api/public/slots?service=" + encodeURIComponent(body.dataset.service)).then(function (r) {
        (r.json.days || []).forEach(function (d) {
          var any = false;
          d.slots.forEach(function (s) {
            var b = $('.slot[data-at="' + s.at + '"]');
            if (b) { b.disabled = !s.free; b.setAttribute("aria-pressed", "false"); }
            any = any || s.free;
          });
          var db = $('.day[data-day="' + d.date + '"]');
          if (db) db.disabled = !any;
        });
        st.at = null; st.label = null; pick.textContent = "—";
      }).catch(function () { /* the old grid stays */ });
    }
    $("#send").addEventListener("click", function () {
      var btn = this, name = $("#name").value.trim(), phone = $("#phone").value.trim();
      hideErr(err3);
      if (name.length < 2) return showErr(err3, "NAME_REQUIRED");
      if (phone.replace(/\D/g, "").length < 8) return showErr(err3, "INVALID_PHONE");
      if (!$("#consent").checked) return showErr(err3, "CONSENT_REQUIRED");
      busy(btn, true);
      send("POST", "/api/public/bookings", { service_id: body.dataset.service, at: st.at, address: $("#addr").value.trim(), lat: num("#lat"), lng: num("#lng"), name: name, phone: phone,
        note: $("#note").value.trim(), consent: true, ts: body.dataset.ts, company_url: $("#company_url").value, lang: lang }).then(function (r) {
        if (r.ok) return location.assign(r.json.ref ? "/book/done/" + r.json.ref : "/");
        busy(btn, false);
        var code = r.json.error || "ERROR";
        if (code === "SLOT_TAKEN" || code === "SLOT_INVALID") return refresh().then(function () { history.back(); showErr(err, code); });
        showErr(err3, code);
      }).catch(function () { busy(btn, false); showErr(err3, "ERROR"); });
    });
  })();

  // ---- 5 · quote request: category, up to 5 photos (made smaller in the browser), send
  if (page === "quote") (function () {
    var err = $("#err"), box = $("#photos"), add = $("#add"), file = $("#file"), photos = [];
    var on = $('.chip[aria-pressed="true"]'), category = on ? on.dataset.cat : "other";
    $("#cats").addEventListener("click", function (e) {
      var c = e.target.closest(".chip");
      if (!c) return;
      $$(".chip").forEach(function (x) { x.setAttribute("aria-pressed", x === c ? "true" : "false"); });
      category = c.dataset.cat;
    });
    geo($("#gps"), err);
    clearOnEdit($("main"), err);
    function shrink(f) {
      return new Promise(function (resolve, reject) {
        if (!/^image\//.test(f.type)) return reject(new Error("type"));
        var url = URL.createObjectURL(f), img = new Image();
        img.onload = function () {
          // a fresh JPEG (no camera position, no comments), smaller until it is under ~1 MB
          var steps = [[1600, 0.82], [1280, 0.72], [1024, 0.6]], b64 = "";
          for (var i = 0; i < steps.length; i++) {
            var k = Math.min(1, steps[i][0] / Math.max(img.naturalWidth, img.naturalHeight)), c = document.createElement("canvas");
            c.width = Math.max(1, Math.round(img.naturalWidth * k)); c.height = Math.max(1, Math.round(img.naturalHeight * k));
            c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
            var data = c.toDataURL("image/jpeg", steps[i][1]);
            b64 = data.slice(data.indexOf(",") + 1);
            if (b64.length <= 1300000) break;
          }
          URL.revokeObjectURL(url);
          if (b64.length > 1300000) return reject(new Error("size"));
          resolve(b64);
        };
        img.onerror = function () { URL.revokeObjectURL(url); reject(new Error("image")); };
        img.src = url;
      });
    }
    function draw() {
      $$(".pt", box).forEach(function (n) { n.remove(); });
      photos.forEach(function (b64, i) {
        var d = document.createElement("div"), x = document.createElement("button");
        d.className = "pt"; d.style.backgroundImage = "url(data:image/jpeg;base64," + b64 + ")";
        x.type = "button"; x.textContent = "×"; x.setAttribute("aria-label", box.dataset.remove);
        x.addEventListener("click", function () { photos.splice(i, 1); draw(); });
        d.appendChild(x); box.insertBefore(d, add);
      });
      add.hidden = photos.length >= 5;
    }
    add.addEventListener("click", function () { file.click(); });
    file.addEventListener("change", function () {
      var list = Array.prototype.slice.call(file.files || []);
      file.value = "";
      hideErr(err);
      list.reduce(function (p, f) {
        return p.then(function () {
          if (photos.length >= 5) return showErr(err, "TOO_MANY_PHOTOS");
          return shrink(f).then(function (b64) { photos.push(b64); draw(); }).catch(function () { showErr(err, "BAD_IMAGE"); });
        });
      }, Promise.resolve());
    });
    $("#send").addEventListener("click", function () {
      var btn = this, desc = $("#desc").value.trim(), name = $("#name").value.trim(), phone = $("#phone").value.trim(), loc = $("#addr").value.trim();
      hideErr(err);
      if (desc.length < 5) return showErr(err, "DESCRIPTION_REQUIRED");
      if (name.length < 2) return showErr(err, "NAME_REQUIRED");
      if (phone.replace(/\D/g, "").length < 8) return showErr(err, "INVALID_PHONE");
      if (loc.length < 3 && !$("#lat").value) return showErr(err, "LOCATION_REQUIRED");
      if (!$("#consent").checked) return showErr(err, "CONSENT_REQUIRED");
      busy(btn, true);
      send("POST", "/api/public/quotes", { category: category, description: desc, photos: photos, name: name, phone: phone, location: loc, lat: num("#lat"), lng: num("#lng"),
        service_id: body.dataset.service || null, consent: true, ts: body.dataset.ts, company_url: $("#company_url").value, lang: lang }).then(function (r) {
        if (r.ok) return location.assign("/quote/done");
        busy(btn, false); showErr(err, r.json.error || "ERROR");
      }).catch(function () { busy(btn, false); showErr(err, "ERROR"); });
    });
  })();

  // ---- 6 · customer home: cancel with a reason, ask for another time, sign out
  if (page === "my") (function () {
    $("#logout").addEventListener("click", function () { send("POST", "/api/my/logout", {}).then(function () { location.assign("/"); }); });
    $$("[data-booking]").forEach(function (card) {
      var id = card.dataset.booking, err = $(".err", card), pc = $('[data-panel="cancel"]', card), pm = $('[data-panel="move"]', card), st = null;
      function close() { if (pc) pc.hidden = true; if (pm) pm.hidden = true; hideErr(err); }
      $$("[data-close]", card).forEach(function (b) { b.addEventListener("click", close); });
      var c = $("[data-cancel]", card), cg = $("[data-cancel-go]", card), m = $("[data-move]", card), mg = $("[data-move-go]", card);
      if (c) c.addEventListener("click", function () { close(); pc.hidden = false; $("textarea", pc).focus(); });
      if (cg) cg.addEventListener("click", function () {
        var why = $("textarea", pc).value.trim();
        if (why.length < 3) return showErr(err, "REASON_REQUIRED");
        cg.disabled = true;
        send("POST", "/api/my/bookings/" + id + "/cancel", { reason: why }).then(function (r) {
          if (r.ok) return location.reload();
          cg.disabled = false; showErr(err, r.json.error || "ERROR");
        }).catch(function () { cg.disabled = false; showErr(err, "ERROR"); });
      });
      if (m) m.addEventListener("click", function () {
        close(); pm.hidden = false;
        var pk = $(".pk", pm);
        send("GET", "/api/my/bookings/" + id + "/slots").then(function (r) {
          if (!r.ok) return showErr(err, r.json.error || "ERROR");
          renderPicker(pk, r.json.days || [], { day: pk.dataset.day, time: pk.dataset.time });
          if (st) { st.at = null; st.label = null; } else st = bindPicker(pk, function () { hideErr(err); });
        }).catch(function () { showErr(err, "ERROR"); });
      });
      if (mg) mg.addEventListener("click", function () {
        if (!st || !st.at) return showErr(err, "PICK_SLOT");
        mg.disabled = true;
        send("POST", "/api/my/bookings/" + id + "/reschedule", { at: st.at, reason: $("input", pm).value.trim() }).then(function (r) {
          if (r.ok) return location.reload();
          mg.disabled = false; showErr(err, r.json.error || "ERROR");
        }).catch(function () { mg.disabled = false; showErr(err, "ERROR"); });
      });
    });
  })();
})();
