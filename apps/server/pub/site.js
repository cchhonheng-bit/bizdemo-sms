/* Public shop website (D-96 · final combined brief D-106): the behaviour of the screens. Same origin, no dependencies, no inline
   script (CSP). Messages for the page's language come from <script type="application/json" id="msg">, the catalog of the page
   from <script type="application/json" id="items">. */
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
    if (on) { btn.dataset.html = btn.innerHTML; btn.textContent = M.SENDING || "..."; btn.disabled = true; }
    else { if (btn.dataset.html) btn.innerHTML = btn.dataset.html; btn.disabled = false; }
  }
  function send(method, url, data) {
    return fetch(url, { method: method, credentials: "same-origin", headers: data === undefined ? {} : { "content-type": "application/json" }, body: data === undefined ? undefined : JSON.stringify(data) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, status: r.status, json: j || {} }; }); });
  }
  function money(c) { return "$" + (c / 100).toLocaleString("en-US", { minimumFractionDigits: c % 100 ? 2 : 0, maximumFractionDigits: 2 }); }

  // ---- D-121: a service worker left at "/" by the staff app of before D-96 answered customer pages with the old staff screen —
  //      remove it wherever it is still registered (the staff app's own worker lives under /app/ and stays)
  try {
    if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) navigator.serviceWorker.getRegistrations().then(function (rs) {
      rs.forEach(function (r) { try { if (new URL(r.scope).pathname === "/") r.unregister(); } catch (e) { /* ignore */ } });
    }).catch(function () { /* blocked */ });
  } catch (e) { /* no service workers */ }

  // ---- opened inside Telegram (Mini App): Telegram puts the launch data in the address (#tgWebAppData=…). It is read at once —
  //      nothing waits for Telegram's own script (D-121); that script (the only outside script the CSP allows) still loads, for
  //      the full height. The launch data signs the customer in (checked by the hub) and links a new booking at once.
  var TG = null;
  function launchData() {
    var v = null;
    try { v = new URLSearchParams(location.hash.slice(1)).get("tgWebAppData"); } catch (e) { v = null; }
    if (!v) try { var p = JSON.parse(sessionStorage.getItem("__telegram__initParams") || "null"); v = p && p.tgWebAppData; } catch (e) { v = null; }
    if (!v && TG && TG.initData) v = TG.initData;
    return v || null;
  }
  var initData = launchData, inTelegram = !!launchData();
  if (inTelegram) (function () {
    var sc = document.createElement("script");
    sc.src = "https://telegram.org/js/telegram-web-app.js";
    sc.async = true;
    sc.onload = function () { TG = window.Telegram && window.Telegram.WebApp; try { if (TG) { TG.ready(); TG.expand(); } } catch (e) { /* older clients */ } };
    document.head.appendChild(sc);
  })();
  function tgAuth() { return send("POST", "/api/customer/tg-auth", { init_data: launchData() }); }
  // a chat whose menu button still opens "/" (set before D-121): inside Telegram the menu button is the customer home
  if (inTelegram && page === "home" && location.pathname === "/" && !location.search) return location.replace("/my" + location.hash);

  // ---- D-121: a customer page without a session shows only the skeleton. Inside Telegram: ONE call signs in from the launch data,
  //      then the same address loads again (now with the session). Outside Telegram: the sign-in page. A login form never comes first.
  if (page === "gate") (function () {
    var next = body.dataset.next || "/my";
    if (!inTelegram) return location.replace("/my/login?next=" + encodeURIComponent(next));
    var box = $("#gate-err"), m = $("#gate-msg"), retry = $("#gate-retry"), toBot = $("#gate-bot");
    function cards(on) { $$(".sk").forEach(function (x) { x.hidden = !on; }); }
    function fail(code) {
      cards(false);
      if (code === "NOT_LINKED" && m && m.dataset.start) { m.textContent = m.dataset.start; if (toBot) toBot.hidden = false; }
      box.hidden = false;
    }
    // signed in a moment ago and still here = this browser keeps no cookie (e.g. Telegram Web in a frame): say so, never loop
    var again = /(^|&)ot_gate=1(&|$)/.test(location.hash.slice(1));
    function go() {
      box.hidden = true; cards(true);
      tgAuth().then(function (r) {
        if (!r.ok) return fail(r.json.error);
        if (again) return fail("ERROR");
        location.replace(next + (location.hash ? location.hash + "&ot_gate=1" : "#ot_gate=1"));
      }).catch(function () { fail("ERROR"); });
    }
    if (retry) retry.addEventListener("click", go);
    go();
  })();
  if (page === "gate") return;

  // ---- D-121: the booking screens are public — inside Telegram without a session they sign in in the background, so the form
  //      knows the customer (name + phone filled in when still empty); nothing waits for it and nothing is a login screen
  if (inTelegram && body.dataset.signed !== "1" && (page === "home" || page === "book" || page === "quote")) tgAuth().then(function (r) {
    if (!r.ok) return;
    var nm = $("#name"), ph = $("#phone");
    if (nm && !nm.value && r.json.name) nm.value = r.json.name;
    if (ph && !ph.value && r.json.phone) ph.value = r.json.phone;
  }).catch(function () { /* the form works without it */ });

  // ---- after saving: to the shop bot with the single-use link; the history entry becomes the «sent» screen (back from
  //      Telegram lands there) and, when Telegram opened as an app, the page itself turns into it
  function toTelegram(link, donePath) {
    try { history.replaceState(null, "", donePath); } catch (e) { /* old browser */ }
    location.href = link;
    setTimeout(function () { location.replace(donePath); }, 1800);
  }

  // ---- category tiles + item lines (home, quote)
  function linesUI(onChange) {
    var box = $("#lines");
    if (!box) return null;
    var items = [], byId = {};
    try { items = JSON.parse(($("#items") || {}).textContent || "[]"); } catch (e) { items = []; }
    items.forEach(function (i) { byId[i.id] = i; });
    var max = Number(box.dataset.max || 8), maxq = Number(box.dataset.maxq || 20), optional = box.dataset.optional === "true";
    var tmpl = $(".line", box).cloneNode(true);
    var on = $(".cat[aria-pressed='true']"), cat = on ? on.dataset.cat : (body.dataset.cat || null);
    var rows = function () { return $$(".line", box); };
    var firstOf = function (c) {
      var list = items.filter(function (i) { return i.c === c; });
      return (list.filter(function (i) { return !i.q && i.p != null; })[0] || list.filter(function (i) { return !i.q; })[0] || list[0] || {}).id || "";
    };
    function state() {
      return rows().map(function (r) { return { id: $("select", r).value, qty: Number($("[data-qty]", r).textContent) || 1 }; }).filter(function (l) { return l.id && byId[l.id]; });
    }
    function sync() {
      var last = rows()[rows().length - 1], it = last && byId[$("select", last).value];
      if (it) cat = it.c;
      $$(".cat").forEach(function (c) { c.setAttribute("aria-pressed", c.dataset.cat === cat ? "true" : "false"); });
      $$("[data-remove]", box).forEach(function (b) { b.hidden = rows().length < 2; });
      var add = $("#addl"); if (add) add.hidden = rows().length >= max;
      onChange(state(), byId, cat);
    }
    $$(".cat").forEach(function (c) {
      c.addEventListener("click", function () {
        cat = c.dataset.cat;
        var last = rows()[rows().length - 1];
        if (last) $("select", last).value = firstOf(cat) || (optional ? "" : $("select", last).value);
        sync();
      });
    });
    box.addEventListener("click", function (e) {
      var q = e.target.closest("[data-q]"), x = e.target.closest("[data-remove]");
      if (q) { var out = $("[data-qty]", q.closest(".line")), v = Math.min(maxq, Math.max(1, (Number(out.textContent) || 1) + Number(q.dataset.q))); out.textContent = v; sync(); }
      if (x && rows().length > 1) { x.closest(".line").remove(); sync(); }
    });
    box.addEventListener("change", sync);
    var add = $("#addl");
    if (add) add.addEventListener("click", function () {
      if (rows().length >= max) return;
      var r = tmpl.cloneNode(true);
      $("[data-qty]", r).textContent = "1";
      box.appendChild(r);
      $("select", r).value = firstOf(cat) || "";
      sync();
      $("select", r).focus();
    });
    sync();
    return { state: state, cat: function () { return cat; } };
  }
  var param = function (lines) { return lines.map(function (l) { return l.id + ":" + l.qty; }).join(","); };

  // ---- "use my current location": Telegram's location inside the Mini App, else the browser (high accuracy, 10 s);
  //      failing that, a pasted Google Maps link; the address text stays optional
  function locUI(err) {
    var btn = $("#gps");
    if (!btn) return null;
    var okBox = $("#loc-ok"), paste = $("#paste");
    function ok(lat, lng, acc) {
      $("#lat").value = Number(lat).toFixed(6); $("#lng").value = Number(lng).toFixed(6); $("#acc").value = acc == null ? "" : Math.round(acc);
      $("#loc-acc").textContent = acc == null ? "" : " (±" + Math.round(acc) + " m)";
      $("#loc-map").href = "https://www.google.com/maps?q=" + Number(lat).toFixed(6) + "," + Number(lng).toFixed(6);
      okBox.hidden = false; btn.classList.add("got"); paste.hidden = true; hideErr(err);
    }
    function fail() { showErr(err, "GPS_FAILED"); paste.hidden = false; }
    function browser() {
      if (!navigator.geolocation) return fail();
      navigator.geolocation.getCurrentPosition(function (p) { ok(p.coords.latitude, p.coords.longitude, p.coords.accuracy); }, fail, { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 });
    }
    btn.addEventListener("click", function () {
      hideErr(err);
      var lm = TG && TG.LocationManager && TG.isVersionAtLeast && TG.isVersionAtLeast("8.0") ? TG.LocationManager : null;
      if (!lm) return browser();
      try {
        lm.init(function () {
          if (!lm.isLocationAvailable) return browser();
          lm.getLocation(function (l) { if (l) ok(l.latitude, l.longitude, l.horizontal_accuracy); else fail(); });
        });
      } catch (e) { browser(); }
    });
    $("#paste-open").addEventListener("click", function () { paste.hidden = false; $("#paste-url").focus(); });
    function parse(s) {
      var d = decodeURIComponent(s), m;
      var pats = [/@(-?\d{1,2}\.\d+),\s*(-?\d{1,3}\.\d+)/, /!3d(-?\d{1,2}\.\d+)!4d(-?\d{1,3}\.\d+)/, /[?&](?:q|query|ll|destination|center)=(-?\d{1,2}\.\d+),\s*(-?\d{1,3}\.\d+)/, /^\s*(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)\s*$/];
      for (var i = 0; i < pats.length; i++) { m = pats[i].exec(d); if (m && Math.abs(+m[1]) <= 90 && Math.abs(+m[2]) <= 180) return [+m[1], +m[2]]; }
      return null;
    }
    $("#paste-go").addEventListener("click", function () {
      var v = $("#paste-url").value.trim(), p = parse(v), go = this;
      if (p) return ok(p[0], p[1], null);
      if (!/^https?:\/\//i.test(v)) return showErr(err, "MAP_LINK_INVALID");
      go.disabled = true;
      send("POST", "/api/public/maps", { url: v }).then(function (r) {
        go.disabled = false;
        if (r.ok && typeof r.json.lat === "number") ok(r.json.lat, r.json.lng, null); else showErr(err, r.json.error || "MAP_LINK_INVALID");
      }).catch(function () { go.disabled = false; showErr(err, "MAP_LINK_INVALID"); });
    });
    return { has: function () { return !!$("#lat").value; }, value: function () { return { lat: num("#lat"), lng: num("#lng"), accuracy: num("#acc") }; } };
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

  // ---- 1 · home: category tiles → item + quantity (+ more lines) → «book» (or «request a quote» for quote-only items)
  if (page === "home") linesUI(function (lines, byId) {
    var go = $("#go"), price = $("#price");
    if (!go) return;
    var quote = lines.some(function (l) { return byId[l.id].q; });
    var priced = lines.length && lines.every(function (l) { return byId[l.id].p != null; });
    if (price) price.textContent = priced ? String(M.price_from).replace("{p}", money(lines.reduce(function (a, l) { return a + byId[l.id].p * l.qty; }, 0))) : M.price_contact;
    go.href = lines.length ? (quote ? "/quote" : "/book") + "?items=" + param(lines) : "/quote";
    var label = $("span", go); if (label) label.textContent = quote || !lines.length ? M.quote : M.book;
  });

  // ---- 2 + 3 · choose a time + location → your details → ONE tap: book + Telegram
  if (page === "book") (function () {
    var s2 = $("#s2"), s3 = $("#s3"), pick = $("#pick"), next = $("#next"), err = $("#err"), err3 = $("#err3");
    var st = bindPicker($("#picker"), function (p) { pick.textContent = p.label || "—"; hideErr(err); });
    var loc = locUI(err);
    clearOnEdit(s2, err); clearOnEdit(s3, err3);
    function step(n) { s2.hidden = n !== 2; s3.hidden = n !== 3; window.scrollTo(0, 0); }
    if (location.hash === "#details") history.replaceState(null, "", location.pathname + location.search); // a reload starts at the time
    if (next) next.addEventListener("click", function () {
      var addr = $("#addr").value.trim();
      if (!st.at) return showErr(err, "PICK_SLOT");
      if (addr.length < 3 && !loc.has()) return showErr(err, "ADDRESS_REQUIRED");
      $("#sum-when").textContent = st.label;
      $("#sum-loc").textContent = addr || (M.gps_ok + " ✓");
      history.pushState({ step: 3 }, "", "#details");
      step(3);
    });
    window.addEventListener("popstate", function () { step(location.hash === "#details" && st.at ? 3 : 2); });
    $("[data-back]").addEventListener("click", function (e) { e.preventDefault(); history.back(); });
    /** somebody else took the time: show what is free now, keep what the visitor typed */
    function refresh() {
      return send("GET", "/api/public/slots?items=" + encodeURIComponent(body.dataset.items)).then(function (r) {
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
      busy(btn, true);
      var where = loc.value();
      send("POST", "/api/public/bookings", { items: body.dataset.items, at: st.at, address: $("#addr").value.trim(), lat: where.lat, lng: where.lng, accuracy: where.accuracy, name: name, phone: phone,
        note: $("#note").value.trim(), consent: true, ts: body.dataset.ts, company_url: $("#company_url").value, lang: lang, init_data: initData() }).then(function (r) {
        if (r.ok) {
          if (!r.json.ref) return location.assign("/");
          var done = "/book/done/" + r.json.ref;
          if (r.json.link && !r.json.linked) return toTelegram(r.json.link, done);
          return location.assign(done);
        }
        busy(btn, false);
        var code = r.json.error || "ERROR";
        if (code === "SLOT_TAKEN" || code === "SLOT_INVALID") return refresh().then(function () { history.back(); showErr(err, code); });
        showErr(err3, code);
      }).catch(function () { busy(btn, false); showErr(err3, "ERROR"); });
    });
  })();

  // ---- 4 · request sent: while it waits for the answer, the screen refreshes itself
  if (page === "done" && body.dataset.state === "pending") setInterval(function () { if (document.visibilityState === "visible") location.reload(); }, 30000);

  // ---- 5 · quote request: tiles + items (optional), description, up to 5 photos (made smaller in the browser), location, ONE tap
  if (page === "quote") (function () {
    var err = $("#err"), box = $("#photos"), add = $("#add"), file = $("#file"), photos = [];
    var ui = linesUI(function () { /* nothing to show */ });
    var loc = locUI(err);
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
      var btn = this, desc = $("#desc").value.trim(), name = $("#name").value.trim(), phone = $("#phone").value.trim(), addr = $("#addr").value.trim();
      var lines = ui ? ui.state() : [];
      hideErr(err);
      if (desc.length < 5 && !lines.length) return showErr(err, "DESCRIPTION_REQUIRED");
      if (name.length < 2) return showErr(err, "NAME_REQUIRED");
      if (phone.replace(/\D/g, "").length < 8) return showErr(err, "INVALID_PHONE");
      if (addr.length < 3 && !loc.has()) return showErr(err, "LOCATION_REQUIRED");
      busy(btn, true);
      var where = loc.value();
      send("POST", "/api/public/quotes", { items: lines.length ? param(lines) : null, category: (ui && ui.cat()) || body.dataset.cat || "other", description: desc, photos: photos, name: name, phone: phone,
        location: addr, lat: where.lat, lng: where.lng, accuracy: where.accuracy, consent: true, ts: body.dataset.ts, company_url: $("#company_url").value, lang: lang, init_data: initData() }).then(function (r) {
        if (r.ok) {
          if (!r.json.ref) return location.assign("/");
          var done = "/quote/done/" + r.json.ref;
          if (r.json.link && !r.json.linked) return toTelegram(r.json.link, done);
          return location.assign(done);
        }
        busy(btn, false); showErr(err, r.json.error || "ERROR");
      }).catch(function () { busy(btn, false); showErr(err, "ERROR"); });
    });
  })();

  // ---- sign in: phone + password (a new password comes from the bot — «forgot password» is a link to it)
  if (page === "login") (function () {
    var next = body.dataset.next || "/my";
    if (inTelegram) return location.replace(next + location.hash); // inside Telegram the launch data signs in — never this form (D-121)
    var err = $("#err"), go = $("#login");
    clearOnEdit($("main"), err);
    go.addEventListener("click", function () {
      var pw = $("#pw").value;
      if ($("#phone").value.replace(/\D/g, "").length < 8) return showErr(err, "INVALID_PHONE");
      if (!pw) return showErr(err, "INVALID_CREDENTIALS");
      busy(go, true);
      send("POST", "/api/public/login", { phone: $("#phone").value.trim(), password: pw }).then(function (r) {
        if (r.ok) return location.assign(next);
        busy(go, false);
        var code = r.json.error || "ERROR";
        showErr(err, code);
        if (code === "LOCKED" && r.json.details) err.textContent = msg(code).replace("{n}", r.json.details.minutes);
      }).catch(function () { busy(go, false); showErr(err, "ERROR"); });
    });
    $("#pw").addEventListener("keydown", function (e) { if (e.key === "Enter") go.click(); });
  })();

  // ---- privacy / terms: back = the previous page, else "/"
  if (page === "legal") { var lb = $("[data-legal-back]"); if (lb) lb.addEventListener("click", function (e) {
    var ref = ""; try { ref = document.referrer ? new URL(document.referrer).origin : ""; } catch (x) { ref = ""; }
    if (ref === location.origin && history.length > 1) { e.preventDefault(); history.back(); } // came from this site: back; else the link goes to "/"
  }); }

  // ---- 6 · customer home: notifications, password, sign out, cancel with a reason, ask for another time
  if (page === "my") (function () {
    var out = $("#logout");
    if (out) out.addEventListener("click", function () { send("POST", "/api/my/logout", {}).then(function () { location.assign("/"); }); });
    // notification settings — the shop bot's subscription (service messages / promotions)
    var ns = $("#n-service"), np = $("#n-promo"), nok = $("#n-ok"), nerr = $("#n-err");
    function savePrefs() {
      nok.hidden = true; hideErr(nerr);
      var want = { service: ns.checked, promo: ns.checked && np.checked };
      send("POST", "/api/my/prefs", want).then(function (r) {
        if (!r.ok) throw new Error(r.json.error || "HUB_DOWN");
        ns.checked = !!r.json.service; np.checked = !!r.json.promo; np.disabled = !r.json.service; nok.hidden = false;
      }).catch(function (e) { ns.checked = !want.service; showErr(nerr, (e && e.message) || "HUB_DOWN"); });
    }
    if (ns) ns.addEventListener("change", function () { if (!ns.checked) np.checked = false; np.disabled = !ns.checked; savePrefs(); });
    if (np) np.addEventListener("change", savePrefs);
    // profile → change password (needs the current one)
    var card = $("#pw-card"), perr = $("#pw-err"), pok = $("#pw-ok");
    if (card) {
    $("#pw-open").addEventListener("click", function () { card.hidden = !card.hidden; pok.hidden = true; hideErr(perr); if (!card.hidden) $("#pw-cur").focus(); });
    $("#pw-close").addEventListener("click", function () { card.hidden = true; });
    clearOnEdit(card, perr);
    $("#pw-save").addEventListener("click", function () {
      var btn = this, cur = $("#pw-cur").value, next = $("#pw-new").value;
      pok.hidden = true;
      if (next.length < 4) return showErr(perr, "PASSWORD_TOO_SHORT");
      btn.disabled = true;
      send("POST", "/api/my/password", { current: cur, next: next }).then(function (r) {
        btn.disabled = false;
        if (!r.ok) return showErr(perr, r.json.error || "ERROR");
        $("#pw-cur").value = ""; $("#pw-new").value = ""; hideErr(perr); pok.hidden = false;
      }).catch(function () { btn.disabled = false; showErr(perr, "ERROR"); });
    });
    }
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
