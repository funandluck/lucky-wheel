import { initBackend } from "./backend.js";
import * as CFG from "./config.js";
const SITE_NAME = CFG.SITE_NAME || "Lucky Wheel";

/* ---------------- state & helpers ---------------- */
const S = { user: undefined, wheels: [], wheelsLoaded: false, numbers: [], requests: [], selected: new Set(), selWheel: null, autoDrawDone: new Set(), shownWinnerFor: new Set() };
let api, view = null, routeName = "", routeId = null, reqUnsub = null;
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const isAdm = () => !!S.user?.isAdmin;
const myId = () => S.user?.uid || "";
const W = (id) => S.wheels.find((w) => w.id === id);
const money = (v, w) => { const c = (w && w.currency) || "$"; const n = Number(v) || 0; const t = Number.isInteger(n) ? n.toLocaleString("en-US") : n.toFixed(2); return c === "$" ? "$" + t : t + " " + c; };
const total = (w) => Math.max(1, Math.min(100, Number(w?.totalNumbers) || 100));
const numsOf = (wid) => S.numbers.filter((d) => d.wheelId === wid);
const numMap = (wid) => { const m = {}; numsOf(wid).forEach((d) => (m[d.n] = d)); return m; };
const paid = (w) => numsOf(w.id).filter((d) => d.status === "paid" && d.n <= total(w)).sort((a, b) => a.n - b.n);
const soldOut = (w) => paid(w).length >= total(w);
const reqOf = (id) => S.requests.find((r) => r.id === id);
const pendingReqs = (wid) => S.requests.filter((r) => r.status === "pending" && (!wid || r.wheelId === wid)).sort((a, b) => a.createdAt - b.createdAt);
const toast = (msg) => { const t = $("#toast"); t.textContent = msg; t.classList.add("show"); clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove("show"), 2800); };
const fmtDate = (ms) => new Date(ms).toLocaleString([], { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const ago = (ms) => { const m = Math.round((Date.now() - ms) / 6e4); return m < 1 ? "just now" : m < 60 ? m + " min ago" : m < 1440 ? Math.round(m / 60) + " h ago" : new Date(ms).toLocaleDateString(); };
const sortedWheels = () => [...S.wheels].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
const imgStyle = (w) => (w.prizeImage ? `background-image:url(&quot;${esc(String(w.prizeImage).replace(/"/g, "%22"))}&quot;)` : "");
const lsGet = (k) => { try { return localStorage.getItem("lw_" + k); } catch (e) { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem("lw_" + k, v); } catch (e) {} };

// status of a wheel: open | soldout | scheduled | ready | spinning | done
function wheelStatus(w) {
  const now = Date.now();
  if (w.draw && w.draw.startedAt) return now - w.draw.startedAt < spinTotal(w.draw) ? "spinning" : "done";
  if (!soldOut(w)) return "open";
  if (!w.drawAt) return "soldout";
  return now < w.drawAt ? "scheduled" : "ready";
}
const STATUS_LABEL = { open: ["Open", "green"], soldout: ["Sold out", "amber"], scheduled: ["Draw scheduled", "amber"], ready: ["Draw time!", "red"], spinning: ["LIVE now", "red"], done: ["Finished", ""] };
const statusChip = (w) => { const [t, c] = STATUS_LABEL[wheelStatus(w)]; return `<span class="chip ${c}">${t}</span>`; };

// thin scrolling bar of sponsor logos (nothing when the wheel has no sponsors)
function sponsorStrip(w) {
  const sp = Array.isArray(w?.sponsors) ? w.sponsors.filter((x) => x && x.img) : [];
  if (!sp.length) return "";
  const one = sp.map((x) => `<img src="${esc(x.img)}" alt="${esc(x.name || "Sponsor")}" loading="lazy">`).join("");
  const reps = Math.max(1, Math.ceil(8 / sp.length)), half = one.repeat(reps);
  return `<div class="sponsors" aria-label="Sponsors"><div class="sp-track" style="animation-duration:${Math.max(14, reps * sp.length * 3)}s">${half}${half}</div></div>`;
}
// "Sponsored by" on the left and right of the numbers page (side rails on big screens, two columns on phones)
function sponsorSides(w) {
  const sp = Array.isArray(w?.sponsors) ? w.sponsors.filter((x) => x && x.img) : [];
  if (!sp.length) return "";
  const img = (x) => `<img src="${esc(x.img)}" alt="${esc(x.name || "Sponsor")}" loading="lazy">`;
  const left = sp.filter((_, i) => i % 2 === 0), right = sp.length > 1 ? sp.filter((_, i) => i % 2 === 1) : left;
  return `<aside class="sp-rail left" aria-label="Sponsors"><div class="sp-by">Sponsored by:</div>${left.map(img).join("")}</aside>
    <aside class="sp-rail right" aria-hidden="${sp.length > 1 ? "false" : "true"}"><div class="sp-by">Sponsored by:</div>${right.map(img).join("")}</aside>
    <section class="card sp-card" aria-label="Sponsors"><div class="sp-by">Sponsored by:</div><div class="sp-cols"><div>${left.map(img).join("")}</div><div>${(sp.length > 1 ? right : []).map(img).join("")}</div></div></section>`;
}
function setHtml(node, html) { if (node && node.dataset.h !== html) { node.innerHTML = html; node.dataset.h = html; } }

function wheelTabs(w, active) {
  return `<div class="wheel-tabs"><a href="#/home" class="back">← All wheels</a><div class="row" style="gap:6px">
    <a href="#/w/${w.id}" class="${active === "w" ? "on" : ""}">Numbers</a><a href="#/draw/${w.id}" class="${active === "draw" ? "on" : ""}">Wheel</a>${isAdm() ? `<a href="#/admin/${w.id}" class="${active === "admin" ? "on" : ""}">Manage</a>` : ""}</div></div>`;
}
const notFound = (el) => (el.innerHTML = `<div class="card banner"><h2>Wheel not found</h2><p class="muted">It may have been deleted.</p><a class="btn gold" href="#/home">All wheels</a></div>`);

/* ---------------- WhatsApp ---------------- */
const TPL_THANKS = "شكراً {name} 🙏\nتم تأكيد دفعتك وحجز أرقامك بدولاب {prize}: {numbers}\nمنبلّغك بموعد السحب قريباً.\nتابع الدولاب من هون:\n{link}\n{group}\nبالتوفيق 🍀";
const TPL_DRAW = "مرحبا {name} 👋\nانباعت كل أرقام دولاب {prize}! 🎉\nالسحب: {date}\nأرقامك: {numbers}\nفوت عالموقع بهالوقت لتشوف الدولاب عم يبرم مباشرة:\n{link}\nحظاً سعيداً 🍀";
const TPL_GROUP = "مرحبا 👋\nانباعت كل أرقام دولاب {prize}! 🎉\nالسحب: {date}\nفوتوا عالموقع بهالوقت لتشوفوا الدولاب عم يبرم مباشرة:\n{link}\nحظاً سعيداً للكل 🍀";
const tpl = (k) => lsGet("tpl_" + k) || (k === "thanks" ? TPL_THANKS : TPL_DRAW);
const fmtDateAr = (ms) => new Date(ms).toLocaleString("ar-LB-u-nu-latn", { weekday: "long", day: "numeric", month: "long", hour: "numeric", minute: "2-digit" });
const drawLink = (wid) => location.origin + location.pathname.replace(/index\.html$/, "") + "#/draw/" + wid;
// Lebanese numbers by default: 70 123 456 / 03 123 456 / +961 ... → 96170123456
function intlPhone(raw) {
  let d = String(raw || "").replace(/\D/g, "");
  if (!d) return "";
  if (d.startsWith("00")) d = d.slice(2);
  if (d.startsWith("961")) return d.length >= 10 ? d : "";
  if (d.startsWith("0")) d = d.slice(1);
  if (d.length === 7 || d.length === 8) return "961" + d;
  return d.length >= 10 ? d : "";
}
function fillMsg(t, { name, w, nums }) {
  const g = w?.groupLink ? "\nفوت على جروب الدولاب ليوصلك موعد السحب 👇\n" + w.groupLink + "\n" : "\n📲 احفظ رقمي عندك ليوصلك موعد السحب\n";
  return t.replace(/\{name\}/g, name || "").replace(/\{prize\}/g, w?.prizeTitle || "").replace(/\{date\}/g, w?.drawAt ? fmtDateAr(w.drawAt) : "قريباً")
    .replace(/\{numbers\}/g, [...nums].sort((a, b) => a - b).join("، ")).replace(/\{link\}/g, w ? drawLink(w.id) : "").replace(/\{group\}/g, g)
    .replace(/\n{3,}/g, "\n\n").trim();
}
// the thank-you always invites to the wheel's WhatsApp group when it has one
const thanksTpl = () => { const t = tpl("thanks"); return t.includes("{group}") ? t : t + "\n{group}"; };
const waLink = (phone, text) => { const p = intlPhone(phone); return p ? `https://wa.me/${p}?text=${encodeURIComponent(text)}` : ""; };
function copyRaw(t, msg) {
  (navigator.clipboard?.writeText(t) || Promise.reject()).then(() => toast(msg), () => {
    const i = document.createElement("textarea"); i.value = t; document.body.appendChild(i); i.select();
    try { document.execCommand("copy"); toast(msg); } catch (e) { toast("Couldn't copy"); } i.remove();
  });
}
const who = (name) => String(name || "").trim().toLowerCase();
function colorFor(i) { const h = (i * 137.508 + 12) % 360; return `hsl(${h.toFixed(0)} 78% ${i % 2 ? 56 : 48}%)`; }
function colorMap(entries) { const m = {}; let k = 0; entries.forEach((e) => { const id = who(e.name); if (!(id in m)) m[id] = colorFor(k++); }); return m; }

function modal(html, { onMount, dismiss = true } = {}) {
  const root = $("#modalRoot");
  root.innerHTML = `<div class="modal-back"><div class="modal">${html}</div></div>`;
  const back = root.firstElementChild;
  const close = () => (root.innerHTML = "");
  if (dismiss) back.addEventListener("click", (e) => { if (e.target === back) close(); });
  $$("[data-close]", back).forEach((b) => b.addEventListener("click", close));
  onMount && onMount(back, close);
  return close;
}


function askConfirm(msg, { ok = "Yes", danger = false, typeText = "" } = {}) {
  return new Promise((res) => {
    let done = false; const fin = (v) => { if (!done) { done = true; res(v); } };
    modal(`<h3>${esc(msg)}</h3>${typeText ? `<label class="field"><span>Type <b>${esc(typeText)}</b> to confirm</span><input id="cfType" autocomplete="off"></label>` : ""}
      <div class="row" style="margin-top:14px"><button class="btn ghost grow" id="cfNo">Cancel</button><button class="btn ${danger ? "red" : "gold"} grow" id="cfYes">${esc(ok)}</button></div>`, {
      onMount(m, close) {
        $("#cfNo", m).onclick = () => { close(); fin(false); };
        $("#cfYes", m).onclick = () => { if (typeText && $("#cfType", m).value.trim().toUpperCase() !== typeText) { $("#cfType", m).focus(); return; } close(); fin(true); };
        m.addEventListener("click", (e) => { if (e.target === m) fin(false); });
      },
    });
  });
}



/* ---------------- boot ---------------- */
async function boot() {
  document.title = SITE_NAME; $("#brandName").textContent = SITE_NAME;
  try { api = await initBackend(); }
  catch (e) { $("#view").innerHTML = `<div class="card banner"><h2>Can't connect</h2><p class="muted">${esc(e.message)}</p></div>`; return; }
  if (api.mode === "demo") $("#demoBanner").hidden = false;
  api.onAuth((u) => {
    const first = S.user === undefined, wasAdmin = isAdm(); S.user = u;
    if (isAdm() && !reqUnsub) reqUnsub = api.onRequests((l) => { S.requests = l; refresh(); });
    if (!isAdm() && reqUnsub) { try { reqUnsub(); } catch (e) {} reqUnsub = null; S.requests = []; }
    if (first || wasAdmin !== isAdm()) route(); else refresh();
  });
  api.onWheels((list) => {
    const prev = {}; S.wheels.forEach((w) => (prev[w.id] = w.draw?.startedAt));
    S.wheels = list; S.wheelsLoaded = true;
    // a spin just started → bring the people of that wheel to it, live
    list.forEach((w) => {
      const st = w.draw?.startedAt;
      if (!st || prev[w.id] === st || Date.now() - st > spinTotal(w.draw)) return;
      const involved = routeId === w.id || numsOf(w.id).some((d) => d.uid === myId());
      if (involved && !(routeName === "draw" && routeId === w.id)) location.hash = "#/draw/" + w.id;
    });
    refresh();
  });
  api.onNumbers((l) => { S.numbers = l; refresh(); });
  window.addEventListener("hashchange", route);
  setupInstall();
  route();
}

function route() {
  let [r, id] = location.hash.replace(/^#\/?/, "").split("?")[0].split("/");
  r = r || "home"; id = id || null;
  if (!["home", "w", "draw", "admin"].includes(r)) r = "home";
  if ((r === "w" || r === "draw") && !id) r = "home";
  const h = "#/" + r + (id ? "/" + id : "");
  if (location.hash !== h) { try { history.replaceState(null, "", h); } catch (e) {} }
  if (view && view.unmount) view.unmount();
  routeName = r; routeId = id;
  if (r !== "w" || S.selWheel !== id) { S.selected.clear(); S.selWheel = id; }
  if (r === "admin" && S.user === undefined) { view = { mount: (el) => (el.innerHTML = `<div class="loading">Loading…</div>`) }; }
  else view = r === "home" ? WheelsView() : r === "w" ? NumbersView(id) : r === "draw" ? DrawView(id) : !isAdm() ? AdminLoginView() : id ? WheelAdminView(id) : AdminView();
  $("#modalRoot").innerHTML = "";
  view.mount($("#view"));
  window.scrollTo(0, 0);
  refresh();
}

function refresh() {
  renderNav();
  if (!view || !S.wheelsLoaded) return;
  if (routeName === "w") { const w = W(routeId); if (w && soldOut(w) && !S.autoDrawDone.has(w.id)) { S.autoDrawDone.add(w.id); location.hash = "#/draw/" + w.id; return; } }
  view.update && view.update();
}

function renderNav() {
  const nav = $("#nav");
  const a = (r, label, on) => `<a href="#/${r}" class="${on ? "active" : ""}">${label}</a>`;
  const pend = isAdm() ? pendingReqs().length : 0;
  const html = a("home", "Wheels", routeName !== "admin") + (isAdm() ? a("admin", `Admin${pend ? `<span class="badge">${pend}</span>` : ""}`, routeName === "admin") : "") + installBtnHtml() + (isAdm() ? `<button id="logout" title="Log out">Log out</button>` : "");
  if (nav.dataset.h === html) return; nav.dataset.h = html; nav.innerHTML = html;
  const lo = $("#logout"); if (lo) lo.onclick = async () => { if (await askConfirm("Log out of admin?", { ok: "Log out" })) { await api.signOut(); location.hash = "#/home"; } };
  bindInstall();
}
/* ---------------- install (PWA) ---------------- */
let deferredPrompt = null;
const isStandalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
function setupInstall() {
  window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); deferredPrompt = e; renderNav(); });
  window.addEventListener("appinstalled", () => { deferredPrompt = null; toast("App installed ✓"); renderNav(); });
  if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
    try { navigator.serviceWorker.register("sw.js").catch(() => {}); } catch (e) {}
  }
}
const installBtnHtml = () => (!isStandalone() && (deferredPrompt || isIOS()) ? `<button class="install" id="installBtn">Install</button>` : "");
function bindInstall() {
  const b = $("#installBtn"); if (!b) return;
  b.onclick = async () => {
    if (deferredPrompt) { deferredPrompt.prompt(); await deferredPrompt.userChoice.catch(() => {}); deferredPrompt = null; renderNav(); return; }
    modal(`<h3>Install the app</h3><ol class="steps"><li>Tap the <b>Share</b> button <span style="font-size:18px">⎙</span> in Safari.</li><li>Choose <b>Add to Home Screen</b>.</li><li>Tap <b>Add</b>. The app icon appears on your home screen.</li></ol><button class="btn gold block" data-close>Got it</button>`);
  };
}


/* ---------------- WHEELS LIST (main page) ---------------- */
function WheelsView() {
  let el, tick = 0;
  return {
    mount(root) {
      el = root;
      el.innerHTML = `<section class="hero"><h1>Pick your lucky number 🎡</h1><p class="muted">Choose a prize, pick your numbers, pay with Whish, and watch the wheel live on draw day.</p></section>
        <div class="row" style="justify-content:space-between;margin-bottom:12px"><h2 class="section-title">Prizes</h2>${isAdm() ? `<button class="btn gold sm" id="addW">+ Add wheel</button>` : ""}</div>
        <div class="wheel-list" id="list"></div>`;
      const b = $("#addW", el); if (b) b.onclick = () => openAddWheel();
      tick = setInterval(() => this.update(), 5000);
    },
    unmount() { clearInterval(tick); },
    update() {
      const list = sortedWheels();
      if (!list.length) {
        $("#list", el).dataset.h = ""; $("#list", el).innerHTML = `<div class="card banner" style="grid-column:1/-1"><div style="font-size:44px">🎡</div><h2>No prizes yet</h2><p class="muted">${isAdm() ? "Add your first wheel to start." : "Come back soon!"}</p>${isAdm() ? `<button class="btn gold" id="addW2">+ Add wheel</button>` : ""}</div>`;
        const b = $("#addW2", el); if (b) b.onclick = () => openAddWheel();
        return;
      }
      setHtml($("#list", el), list.map((w) => {
        const T = total(w), taken = numsOf(w.id).filter((d) => d.n <= T).length, pd = paid(w).length, st = wheelStatus(w);
        const mine = numsOf(w.id).filter((d) => d.uid === myId()).length;
        const href = st === "open" ? `#/w/${w.id}` : `#/draw/${w.id}`;
        const cta = st === "open" ? "Pick numbers →" : st === "done" ? "See the result →" : "Watch the wheel →";
        return `<a class="card wheel-card" href="${href}">${sponsorStrip(w)}
          <div class="prize-img" style="${imgStyle(w)}">${w.prizeImage ? "" : "🎁"}</div>
          <div class="wc-body"><div class="row" style="justify-content:space-between;gap:6px">${statusChip(w)}${mine && !isAdm() ? `<span class="chip green">Yours: ${mine}</span>` : ""}</div>
            <h2>${esc(w.prizeTitle)}</h2>
            <div class="small muted">${money(w.price, w)} per number · ${Math.max(0, T - taken)} of ${T} left</div>
            ${st === "done" ? `<div class="small" style="margin-top:6px">🏆 Winner: <b style="color:var(--gold)">${esc(w.draw?.winner?.name)} #${w.draw?.winner?.n}</b></div>` : w.drawAt ? `<div class="small muted" style="margin-top:4px">Draw: ${esc(fmtDate(w.drawAt))}</div>` : ""}
            <div class="progress"><div style="width:${(pd / T) * 100}%"></div></div>
            <div class="wc-cta">${cta}</div></div></a>`;
      }).join(""));
    },
  };
}

/* ---------------- NUMBERS of one wheel ---------------- */
function NumbersView(wid) {
  let el, mounted = false, self;
  const build = (w) => {
    el.innerHTML = wheelTabs(w, "w") + `<div id="spBar"></div><section class="card"><div class="prize"><div class="prize-img" id="pImg">🎁</div><div>
          <div class="label">Prize</div><h1 id="pTitle"></h1><div class="muted" id="pDesc"></div>
          <div class="stats"><div class="stat"><b id="stPrice"></b><small>per number</small></div><div class="stat"><b id="stLeft"></b><small>numbers left</small></div><div class="stat"><b id="stDraw"></b><small>draw</small></div></div>
          <div class="progress"><div id="prog"></div></div></div></div></section>
        <section id="soldBanner"></section>
        <section class="card" id="howCard"><h2>How it works</h2>
          <ol class="steps"><li>Tap the numbers you want, then tap <b>OK</b>.</li><li>Send the total with <b>Whish</b> to <b id="wNum1"></b>.</li><li>Write your name and phone number and confirm.</li><li>Once the admin approves, the numbers are yours and you get a WhatsApp message.</li></ol></section>
        <div id="spSides"></div>
        <section class="card"><div class="row" style="justify-content:space-between"><h2 style="margin:0">Choose your numbers</h2><span class="small muted" id="selInfo"></span></div><div class="spacer"></div>
          <div class="legend"><span><i style="background:rgba(255,255,255,.14)"></i>Free</span><span><i style="background:var(--gold)"></i>Selected</span><span><i style="background:var(--red)"></i>Taken</span><span><i style="background:var(--green)"></i>Yours</span></div>
          <div class="numgrid" id="grid"></div></section>
        <section class="card" id="mineCard" hidden><h2>Your numbers</h2><div id="mine"></div></section>
        <div class="buybar" id="buybar"><div class="inner"><div class="grow"><div class="chips" id="selChips"></div><div class="small muted" id="selTotal" style="margin-top:4px"></div></div><button class="btn gold okbtn" id="okBtn">OK</button></div></div>`;
    $("#grid", el).addEventListener("click", (e) => {
      const b = e.target.closest(".num"); if (!b || b.disabled) return;
      const n = Number(b.dataset.n); S.selected.has(n) ? S.selected.delete(n) : S.selected.add(n); self.update();
    });
    $("#okBtn", el).onclick = () => openRequest(W(wid));
  };
  return self = {
    mount(root) { el = root; },
    update() {
      const w = W(wid); if (!w) { mounted = false; return notFound(el); }
      if (!mounted) { build(w); mounted = true; }
      setHtml($("#spBar", el), sponsorStrip(w));
      setHtml($("#spSides", el), sponsorSides(w));
      const T = total(w), m = numMap(wid), me = myId(), locked = !!w.draw;
      $("#pTitle", el).textContent = w.prizeTitle || "Prize";
      $("#pDesc", el).textContent = w.prizeDesc || "";
      const img = $("#pImg", el); if (w.prizeImage) { img.style.backgroundImage = `url("${String(w.prizeImage).replace(/"/g, "%22")}")`; img.textContent = ""; } else { img.style.backgroundImage = ""; img.textContent = "🎁"; }
      const taken = numsOf(wid).filter((d) => d.n <= T).length, pd = paid(w).length;
      $("#stPrice", el).textContent = money(w.price, w); $("#stLeft", el).textContent = Math.max(0, T - taken) + " / " + T;
      $("#stDraw", el).textContent = w.drawAt ? new Date(w.drawAt).toLocaleDateString([], { day: "numeric", month: "short" }) : "TBA";
      $("#prog", el).style.width = (pd / T) * 100 + "%";
      $("#wNum1", el).textContent = w.whishNumber || "—";
      const full = soldOut(w) || locked;
      $("#soldBanner", el).innerHTML = full ? `<div class="card banner"><div style="font-size:44px">🎉</div><h2>All numbers are sold!</h2><p class="muted">${w.drawAt ? "Draw: " + esc(fmtDate(w.drawAt)) : "The draw time will be announced soon."}</p><a class="btn gold" href="#/draw/${w.id}">Go to the wheel 🎡</a></div>` : "";
      $("#howCard", el).hidden = full;
      [...S.selected].forEach((n) => { if (m[n] || n > T || locked) S.selected.delete(n); });
      let html = "";
      for (let n = 1; n <= T; n++) {
        const d = m[n]; let cls = "num", dis = false, title = "Free";
        if (d && d.uid === me && !isAdm()) { cls += " mine"; dis = true; title = d.status === "paid" ? "Yours (approved)" : "Yours (waiting for approval)"; }
        else if (d) { cls += " taken"; dis = true; title = "Taken"; }
        else if (S.selected.has(n)) cls += " sel";
        if (locked && !d) dis = true;
        html += `<button class="${cls}" data-n="${n}" ${dis ? "disabled" : ""} title="${title}" aria-label="Number ${n}: ${title}">${n}</button>`;
      }
      const grid = $("#grid", el); if (grid.dataset.h !== html) { grid.innerHTML = html; grid.dataset.h = html; }
      const sel = [...S.selected].sort((a, b) => a - b);
      $("#selInfo", el).textContent = sel.length ? sel.length + " selected" : "";
      $("#selChips", el).innerHTML = sel.map((n) => `<span class="chip">${n}</span>`).join("");
      $("#selTotal", el).textContent = sel.length ? `${sel.length} × ${money(w.price, w)} = ${money(sel.length * w.price, w)}` : "";
      $("#buybar", el).classList.toggle("show", sel.length > 0);
      const mine = isAdm() ? [] : numsOf(wid).filter((d) => d.uid === me).sort((a, b) => a.n - b.n);
      $("#mineCard", el).hidden = !mine.length;
      const joinBtn = w.groupLink && mine.some((d) => d.status === "paid") ? `<a class="btn green block" style="margin-top:12px;text-align:center" href="${esc(w.groupLink)}" target="_blank" rel="noopener">Join the WhatsApp group for the draw</a>` : "";
      $("#mine", el).innerHTML = joinBtn + `<div class="chips">${mine.map((d) => `<span class="chip ${d.status === "paid" ? "green" : "amber"}">#${d.n} · ${d.status === "paid" ? "approved ✓" : "waiting for approval"}</span>`).join("")}</div>${mine.some((d) => d.status !== "paid") ? `<p class="small muted" style="margin:10px 0 0">The admin checks your Whish payment, then confirms on WhatsApp.</p>` : ""}`;
    },
  };
}

function openRequest(w) {
  if (!w) return;
  const sel = [...S.selected].sort((a, b) => a - b); if (!sel.length) return;
  const amount = money(sel.length * w.price, w);
  modal(`<h3>Confirm your numbers</h3>
    <div class="chips" style="margin:4px 0 12px">${sel.map((n) => `<span class="chip gold">${n}</span>`).join("")}</div>
    <div class="whish" style="margin-bottom:14px"><div class="logo">whish</div><div class="grow"><div class="small muted">Send <b style="font-size:17px;color:var(--text)">${esc(amount)}</b> to</div><b>${esc(w.whishNumber || "—")}</b><div class="small muted">${w.whishName ? "Name: " + esc(w.whishName) : ""}</div></div><button type="button" class="btn sm ghost" id="mCopy">Copy</button></div>
    <form id="reqForm" novalidate>
      <label class="field"><span>Your full name</span><input name="name" autocomplete="name" maxlength="40" required></label>
      <label class="field"><span>Your cell phone (WhatsApp)</span><input name="phone" type="tel" inputmode="tel" autocomplete="tel" maxlength="20" placeholder="e.g. 70 123 456" required></label>
      <label class="check"><input type="checkbox" name="paidOk"><span>I sent <b>${esc(amount)}</b> by Whish to <b>${esc(w.whishNumber || "")}</b> for ${sel.length > 1 ? "these " + sel.length + " numbers" : "this number"}.</span></label>
      <div class="error" id="reqErr"></div>
      <div class="row"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn gold grow" id="reqOk">OK</button></div></form>`, {
    onMount(m, close) {
      const f = $("#reqForm", m);
      f.name.value = lsGet("myname") || ""; f.phone.value = lsGet("myphone") || "";
      $("#mCopy", m).onclick = () => copyRaw(String(w.whishNumber || "").replace(/\s+/g, ""), "Whish number copied");
      f.onsubmit = async (e) => {
        e.preventDefault(); const err = $("#reqErr", m), b = $("#reqOk", m); err.textContent = "";
        const name = f.name.value.trim(), phone = f.phone.value.trim();
        if (name.length < 2) { err.textContent = "Write your name."; return f.name.focus(); }
        if (!intlPhone(phone)) { err.textContent = "Write a valid phone number (e.g. 70 123 456)."; return f.phone.focus(); }
        if (!f.paidOk.checked) { err.textContent = "Please send the payment by Whish first, then tick the box."; return; }
        b.disabled = true; b.textContent = "Sending…";
        try {
          await api.request(w.id, sel, name, phone);
          lsSet("myname", name); lsSet("myphone", phone);
          S.selected.clear(); close(); refresh();
          modal(`<div style="text-align:center"><div style="font-size:54px">✅</div><h3>Request sent!</h3><p class="muted">Numbers ${sel.map((n) => "<b>#" + n + "</b>").join(", ")} are held under your name. The admin will check your Whish payment and confirm on WhatsApp.</p><button class="btn gold block" data-close>Great</button></div>`);
        } catch (er) {
          if (er.taken) { er.taken.forEach((n) => S.selected.delete(n)); refresh(); }
          err.textContent = er.message; b.disabled = false; b.textContent = "OK";
          if (er.taken && !S.selected.size) setTimeout(close, 2500);
        }
      };
    },
  });
}

/* ---------------- ADMIN LOGIN ---------------- */
function AdminLoginView() {
  return {
    mount(el) {
      el.innerHTML = `<div class="auth"><div class="card"><h2>Admin</h2><p class="muted small" style="margin-top:0">Only for the person who runs the wheels.</p>
        <form id="lf"><label class="field"><span>Email</span><input name="email" type="email" autocomplete="username" required></label>
        <label class="field"><span>Password</span><input name="password" type="password" autocomplete="current-password" required minlength="6"></label>
        <div class="error" id="lErr"></div><button class="btn gold block" id="lBtn">Log in</button>
        ${api.mode === "demo" ? `<p class="small muted" style="margin:12px 0 0">Demo: use <b>admin@demo.com</b> and choose any password (6+ characters) the first time.</p>` : `<p class="small" style="text-align:center;margin:12px 0 0"><a href="#" id="forgot">Forgot password?</a></p>`}</form></div></div>`;
      const f = $("#lf", el);
      const fg = $("#forgot", el); if (fg) fg.onclick = async (e) => { e.preventDefault(); const em = f.email.value.trim(); if (!em) return ($("#lErr", el).textContent = "Write your email first."); try { await api.resetPassword(em); toast("Reset link sent to your email."); } catch (er) { $("#lErr", el).textContent = er.message; } };
      f.onsubmit = async (e) => {
        e.preventDefault(); const b = $("#lBtn", el); b.disabled = true; $("#lErr", el).textContent = "";
        try { await api.adminLogin(f.email.value.trim(), f.password.value); } catch (er) { const le = $("#lErr", el); if (le) le.textContent = er.message; b.disabled = false; console.error(er); }
      };
    },
  };
}
function copy(text) {
  const t = String(text || "").replace(/\s+/g, "");
  (navigator.clipboard?.writeText(t) || Promise.reject()).then(() => toast("Copied: " + t), () => {
    const i = document.createElement("textarea"); i.value = t; document.body.appendChild(i); i.select();
    try { document.execCommand("copy"); toast("Copied: " + t); } catch (e) { toast(t); } i.remove();
  });
}


/* ---------------- WHEEL ---------------- */
const DEF_SPIN = { ramp: 700, cruise: 9300, decel: 5500 }; // fast ~10 s, then slows down ~5.5 s
const spinTotal = (d) => (d.ramp || DEF_SPIN.ramp) + (d.cruise || DEF_SPIN.cruise) + (d.decel || DEF_SPIN.decel);
function spinAngle(t, d, totalAngle) {
  const r = d.ramp, c = d.cruise, k = d.decel;
  const v = totalAngle / (r / 2 + c + k / 3);
  if (t <= 0) return 0;
  if (t < r) return (v * t * t) / (2 * r);
  if (t < r + c) return (v * r) / 2 + v * (t - r);
  if (t < r + c + k) { const x = (t - r - c) / k; return (v * r) / 2 + v * c + ((v * k) / 3) * (1 - Math.pow(1 - x, 3)); }
  return totalAngle;
}
const TAU = Math.PI * 2;
const mod = (a, m) => ((a % m) + m) % m;

/* ---------------- DRAW (the wheel of one prize) ---------------- */
function DrawView(wid) {
  let el, cvs, ctx, off, offKey = "", raf = 0, tick = 0, lastIdx = -1, entries = [], colors = {}, mounted = false;
  const SIZE = 1000;
  const drawOf = () => W(wid)?.draw || null;

  function buildOff() {
    const key = entries.map((e) => e.n + ":" + e.name).join("|");
    if (key === offKey && off) return; offKey = key;
    colors = colorMap(entries);
    off = document.createElement("canvas"); off.width = off.height = SIZE; const c = off.getContext("2d");
    const R = SIZE / 2 - 14, cx = SIZE / 2, N = entries.length;
    c.translate(cx, cx);
    // rim
    c.beginPath(); c.arc(0, 0, R + 12, 0, TAU); c.fillStyle = "#ffc83d"; c.fill();
    c.beginPath(); c.arc(0, 0, R + 4, 0, TAU); c.fillStyle = "#2a1300"; c.fill();
    if (!N) { c.beginPath(); c.arc(0, 0, R, 0, TAU); c.fillStyle = "#2e1d66"; c.fill(); c.fillStyle = "#b7aad8"; c.font = "bold 40px system-ui"; c.textAlign = "center"; c.fillText("No numbers yet", 0, -120); return; }
    const seg = TAU / N;
    for (let i = 0; i < N; i++) {
      const a0 = -Math.PI / 2 + i * seg, a1 = a0 + seg;
      c.beginPath(); c.moveTo(0, 0); c.arc(0, 0, R, a0, a1); c.closePath();
      c.fillStyle = colors[who(entries[i].name)]; c.fill();
      if (N <= 120) { c.strokeStyle = "rgba(255,255,255,.55)"; c.lineWidth = N > 60 ? 1.2 : 2.5; c.stroke(); }
      // label along the radius
      c.save(); c.rotate(a0 + seg / 2);
      const fs = Math.max(11, Math.min(40, seg * R * 0.62));
      c.font = `800 ${fs}px system-ui, sans-serif`; c.textAlign = "right"; c.textBaseline = "middle";
      c.fillStyle = "#fff"; c.shadowColor = "rgba(0,0,0,.55)"; c.shadowBlur = 4;
      const maxW = R * 0.66, tail = `  #${entries[i].n}`; let nm = String(entries[i].name || ""), label = nm + tail;
      while (c.measureText(label).width > maxW && nm.length > 1) { nm = nm.slice(0, -1); label = nm.trimEnd() + "…" + tail; }
      c.fillText(label, R - 16, 0); c.restore();
    }
    // inner ring
    c.beginPath(); c.arc(0, 0, R * 0.18, 0, TAU); c.fillStyle = "rgba(0,0,0,.25)"; c.fill();
  }

  function paint(rot, winIdx) {
    ctx.clearRect(0, 0, SIZE, SIZE);
    ctx.save(); ctx.translate(SIZE / 2, SIZE / 2); ctx.rotate(rot); ctx.drawImage(off, -SIZE / 2, -SIZE / 2);
    if (winIdx != null && entries.length) {
      const seg = TAU / entries.length, a0 = -Math.PI / 2 + winIdx * seg, R = SIZE / 2 - 14;
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, R, a0, a0 + seg); ctx.closePath();
      ctx.lineWidth = 8; ctx.strokeStyle = "#fff"; ctx.shadowColor = "#ffc83d"; ctx.shadowBlur = 30; ctx.stroke();
    }
    ctx.restore();
  }

  const idxAt = (rot) => (entries.length ? Math.floor(mod(-rot, TAU) / (TAU / entries.length)) % entries.length : -1);
  function showNow(i, final) {
    const e = entries[i]; const box = $("#nowName", el);
    box.innerHTML = e ? `${final ? "🏆 " : ""}${esc(e.name)} <span class="n">#${e.n}</span>` : "&nbsp;";
  }
  function targetAngle(d) {
    const N = d.entries.length, seg = TAU / N;
    return d.turns * TAU + mod(-(d.winnerIndex + 0.5 + (d.jitter || 0)) * seg, TAU);
  }


  function loop() {
    raf = requestAnimationFrame(loop);
    const d = drawOf();
    if (!d || !d.startedAt) { if (lastIdx !== -2) { paint(0, null); lastIdx = -2; $("#nowName", el).innerHTML = "&nbsp;"; } return; }
    const T = spinTotal(d), t = Date.now() - d.startedAt, tot = targetAngle(d);
    const rot = spinAngle(Math.min(t, T), d, tot);
    const done = t >= T;
    paint(rot, done ? d.winnerIndex : null);
    const i = idxAt(rot);
    if (i !== lastIdx || done) { lastIdx = i; showNow(done ? d.winnerIndex : i, done); }
    if (done) {
      cancelAnimationFrame(raf); raf = 0; renderStatus(); renderPlayers();
      const key = wid + ":" + d.startedAt;
      if (!S.shownWinnerFor.has(key)) { S.shownWinnerFor.add(key); showWinner(W(wid), t - T < 60000); }
    }
  }
  const startLoop = () => { if (!raf) raf = requestAnimationFrame(loop); };

  function renderStatus() {
    const w = W(wid); if (!w) return;
    const st = $("#status", el), d = w.draw, now = Date.now(), T = total(w), pd = paid(w).length;
    let html = "";
    if (d && d.startedAt) {
      if (now - d.startedAt < spinTotal(d)) html = `<p class="muted">The wheel is spinning… good luck! 🍀</p>`;
      else html = `<p class="muted">Winner: <b style="color:var(--gold)">${esc(d.winner?.name)} #${d.winner?.n}</b></p><button class="btn gold" id="showWin">Show winner 🏆</button>`;
    } else if (!soldOut(w)) {
      html = `<p><b>${pd} / ${T}</b> numbers sold.</p><p class="muted">The draw opens when all numbers are sold.</p><a class="btn gold" href="#/w/${w.id}">Pick a number</a>`;
    } else if (!w.drawAt) {
      html = `<p><b>All numbers sold! 🎉</b></p><p class="muted">Waiting for the admin to set the draw date and time.</p>${isAdm() ? `<a class="btn gold" href="#/admin/${w.id}">Set date &amp; time</a>` : ""}`;
    } else if (now < w.drawAt) {
      const ms = w.drawAt - now, dd = Math.floor(ms / 864e5), hh = Math.floor(ms / 36e5) % 24, mm = Math.floor(ms / 6e4) % 60, ss = Math.floor(ms / 1e3) % 60;
      const p = (v) => String(v).padStart(2, "0");
      html = `<p class="muted" style="margin-bottom:0">Draw on <b style="color:var(--text)">${esc(fmtDate(w.drawAt))}</b></p>
        <div class="countdown"><div><b>${dd}</b><small>days</small></div><div><b>${p(hh)}</b><small>hours</small></div><div><b>${p(mm)}</b><small>min</small></div><div><b>${p(ss)}</b><small>sec</small></div></div>`;
    } else {
      html = isAdm()
        ? `<p class="muted">It's time! Everyone on this page will see the spin live.</p><button class="btn gold start-btn" id="startBtn">START</button>`
        : `<p><b>It's draw time! ⏰</b></p><p class="muted">The admin will start the wheel any moment. Stay on this page.</p>`;
    }
    if (st.dataset.h !== html) { st.innerHTML = html; st.dataset.h = html; }
    const sb = $("#startBtn", el); if (sb) sb.onclick = startDraw;
    const wb = $("#showWin", el); if (wb) wb.onclick = () => showWinner(W(wid), false);
  }

  async function startDraw() {
    const w = W(wid); const list = paid(w); if (!list.length) return;
    if (!(await askConfirm("Start the draw now? Everyone will see it live. This can't be undone.", { ok: "Start 🎡" }))) return;
    const b = $("#startBtn", el); if (b) b.disabled = true;
    const rnd = new Uint32Array(2); crypto.getRandomValues(rnd);
    const winnerIndex = rnd[0] % list.length;
    const jitter = ((rnd[1] / 4294967295) - 0.5) * 0.7;
    const ents = list.map((d) => ({ n: d.n, name: d.name, uid: d.uid }));
    try {
      await api.startDraw(wid, { entries: ents, winnerIndex, winner: { n: ents[winnerIndex].n, name: ents[winnerIndex].name, uid: ents[winnerIndex].uid }, jitter, turns: 30, ...DEF_SPIN });
    } catch (e) { toast(e.message || "Couldn't start"); if (b) b.disabled = false; }
  }

  function renderPlayers() {
    const d = drawOf();
    const groups = {}; entries.forEach((e) => { const id = who(e.name); (groups[id] = groups[id] || { name: e.name, nums: [] }).nums.push(e.n); });
    const winUid = d && d.startedAt && Date.now() - d.startedAt >= spinTotal(d) ? who(d.winner?.name) : null;
    const html = Object.entries(groups).sort((a, b) => b[1].nums.length - a[1].nums.length || a[1].name.localeCompare(b[1].name))
      .map(([id, g]) => `<div class="player ${id === winUid ? "win" : ""}"><span class="dot" style="background:${colors[id]}"></span><div><div><b>${esc(g.name)}</b></div><div class="nums">${g.nums.map((n) => "#" + n).join(" ")}</div></div></div>`).join("");
    $("#players", el).innerHTML = html || `<div class="empty">No confirmed numbers yet.</div>`;
    $("#pCount", el).textContent = Object.keys(groups).length ? `${Object.keys(groups).length} players · ${entries.length} numbers` : "";
  }

  return {
    mount(root) { el = root; tick = setInterval(() => { if (mounted) renderStatus(); }, 1000); },
    unmount() { clearInterval(tick); cancelAnimationFrame(raf); raf = 0; },
    update() {
      const w = W(wid); if (!w) { mounted = false; return notFound(el); }
      if (!mounted) {
        el.innerHTML = wheelTabs(w, "draw") + `<div id="spBar"></div><section class="card" style="text-align:center;padding-top:14px"><div class="small muted" id="wPrize"></div>
          <div class="now-name" id="nowName">&nbsp;</div>
          <div class="wheel-wrap"><div class="pointer"></div><canvas id="wheel" width="${SIZE}" height="${SIZE}"></canvas><div class="hub">★</div></div>
          <div class="draw-status" id="status"></div></section>
          <section class="card"><div class="row" style="justify-content:space-between"><h2 style="margin:0">Players</h2><span class="small muted" id="pCount"></span></div><div class="spacer"></div><div class="players" id="players"></div></section>`;
        cvs = $("#wheel", el); ctx = cvs.getContext("2d"); offKey = ""; mounted = true;
      }
      setHtml($("#spBar", el), sponsorStrip(w));
      entries = w.draw && w.draw.entries ? w.draw.entries : paid(w).map((d) => ({ n: d.n, name: d.name, uid: d.uid }));
      $("#wPrize", el).textContent = "Prize: " + (w.prizeTitle || "");
      buildOff();
      renderStatus(); renderPlayers();
      if (w.draw && w.draw.startedAt) { lastIdx = -3; startLoop(); } else { cancelAnimationFrame(raf); raf = 0; lastIdx = -2; paint(0, null); $("#nowName", el).innerHTML = "&nbsp;"; }
    },
  };
}

function showWinner(w, celebrate = true) {
  const d = w?.draw; if (!d || !d.winner) return;
  const mine = !isAdm() && d.winner.uid && d.winner.uid === myId();
  modal(`<div class="winner-modal"><div class="trophy">🏆</div><div class="congrats">CONGRATULATIONS!</div>
    <div class="wname">${esc(d.winner.name)}</div><div class="wnum">#${d.winner.n}</div>
    <p class="muted">${mine ? "You won! 🎉 The admin will contact you on WhatsApp." : "won the " + esc(w.prizeTitle || "prize") + "!"}</p>
    <button class="btn gold block" data-close>Yay! 🎉</button></div>`);
  confetti(celebrate ? 6000 : 2500);
}

/* ---------------- confetti & fireworks ---------------- */
function confetti(duration = 5000) {
  const c = $("#confetti"), x = c.getContext("2d"), dpr = Math.min(2, devicePixelRatio || 1);
  const resize = () => { c.width = innerWidth * dpr; c.height = innerHeight * dpr; };
  resize();
  const cols = ["#ffc83d", "#ff9f1c", "#2ee59d", "#ff5470", "#5ab0ff", "#c77dff", "#ffffff"];
  const P = []; const W = () => c.width, H = () => c.height;
  const burst = (bx, by, n, spread, up) => { for (let i = 0; i < n; i++) { const a = up ? -Math.PI / 2 + (Math.random() - 0.5) * spread : Math.random() * TAU; const sp = (up ? 10 + Math.random() * 12 : 3 + Math.random() * 8) * dpr; P.push({ x: bx, y: by, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, s: (5 + Math.random() * 6) * dpr, r: Math.random() * TAU, vr: (Math.random() - 0.5) * 0.3, c: cols[(Math.random() * cols.length) | 0], life: 1, spark: !up }); } };
  burst(0, H(), 120, 1.1, true); burst(W(), H(), 120, 1.1, true);
  const t0 = performance.now(); let lastFw = 0;
  cancelAnimationFrame(confetti._raf);
  const step = (now) => {
    const el = now - t0;
    if (el < duration && now - lastFw > 450) { lastFw = now; burst(W() * (0.15 + Math.random() * 0.7), H() * (0.12 + Math.random() * 0.35), 70, 0, false); if (Math.random() < 0.5) burst(Math.random() * W(), H(), 40, 0.8, true); }
    x.clearRect(0, 0, W(), H());
    for (let i = P.length - 1; i >= 0; i--) {
      const p = P[i]; p.vy += 0.25 * dpr; p.vx *= 0.99; p.vy *= p.spark ? 0.97 : 0.995; p.x += p.vx; p.y += p.vy; p.r += p.vr; if (p.spark) p.life -= 0.012;
      if (p.y > H() + 40 || p.life <= 0) { P.splice(i, 1); continue; }
      x.globalAlpha = Math.max(0, p.life); x.fillStyle = p.c;
      if (p.spark) { x.beginPath(); x.arc(p.x, p.y, p.s * 0.35, 0, TAU); x.fill(); }
      else { x.save(); x.translate(p.x, p.y); x.rotate(p.r); x.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2); x.restore(); }
    }
    x.globalAlpha = 1;
    if (P.length || el < duration) confetti._raf = requestAnimationFrame(step); else x.clearRect(0, 0, W(), H());
  };
  confetti._raf = requestAnimationFrame(step);
}



/* ---------------- ADMIN: shared pieces ---------------- */
function openAddWheel() {
  modal(`<h3>Add a wheel</h3><form id="addForm">
    <label class="field"><span>Prize name</span><input name="prizeTitle" required maxlength="60" placeholder="e.g. iPhone 17 Pro"></label>
    <div class="grid2"><label class="field"><span>How many numbers (1–100)</span><input name="totalNumbers" type="number" min="1" max="100" value="100" required></label>
    <label class="field"><span>Price per number</span><input name="price" type="number" min="0" step="0.01" value="5" required></label></div>
    <div class="grid2"><label class="field"><span>Whish number for this wheel</span><input name="whishNumber" type="tel" required></label>
    <label class="field"><span>Name on Whish</span><input name="whishName" maxlength="40"></label></div>
    <p class="small muted" style="margin-top:0">You can add the photo, description and draw time after.</p>
    <div class="error" id="addErr"></div>
    <div class="row"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn gold grow" id="addBtn">Create wheel</button></div></form>`, {
    onMount(m, close) {
      $("#addForm", m).onsubmit = async (e) => {
        e.preventDefault(); const f = e.target, b = $("#addBtn", m); b.disabled = true;
        const tn = Math.round(Number(f.totalNumbers.value));
        if (tn < 1 || tn > 100) { $("#addErr", m).textContent = "Numbers must be between 1 and 100."; b.disabled = false; return; }
        try {
          const last = sortedWheels()[0];
          const id = await api.createWheel({ prizeTitle: f.prizeTitle.value.trim(), totalNumbers: tn, price: Number(f.price.value), currency: last?.currency || "$", whishNumber: f.whishNumber.value.trim(), whishName: f.whishName.value.trim() });
          close(); toast("Wheel created ✓"); location.hash = "#/admin/" + id;
        } catch (er) { $("#addErr", m).textContent = er.message; b.disabled = false; }
      };
    },
  });
}

// Requests waiting for approval. "Approve" confirms AND opens WhatsApp with the thank-you message.
function requestsHtml(list, showWheel) {
  if (!list.length) return `<div class="empty">No requests waiting. New ones appear here instantly.</div>`;
  return list.map((r) => {
    const w = W(r.wheelId), nums = [...r.nums].sort((a, b) => a - b);
    const link = waLink(r.phone, fillMsg(thanksTpl(), { name: r.name, w, nums }));
    const approve = link
      ? `<a class="btn sm green" data-approve="${r.id}" href="${esc(link)}" target="_blank" rel="noopener">Approve + WhatsApp</a>`
      : `<button class="btn sm green" data-approve="${r.id}">Approve</button>`;
    return `<div class="req">
      ${showWheel ? `<div class="small" style="color:var(--gold);font-weight:700;margin-bottom:4px">🎡 ${esc(w?.prizeTitle || "?")}</div>` : ""}
      <div class="row" style="justify-content:space-between"><b style="font-size:17px">${esc(r.name)}</b><span class="small muted">${ago(r.createdAt)}</span></div>
      <div class="small"><a href="tel:${esc(r.phone)}" style="color:var(--muted)">📞 ${esc(r.phone)}</a></div>
      <div class="chips" style="margin:8px 0">${nums.map((n) => `<span class="chip red">#${n}</span>`).join("")}</div>
      <div class="small muted" style="margin-bottom:10px">Check your Whish (${esc(w?.whishNumber || "")}) for <b style="color:var(--text)">${esc(money(nums.length * (w?.price || 0), w))}</b> from ${esc(r.name)}.</div>
      <div class="row"><button class="btn sm ghost" data-reject="${r.id}">Reject</button><span class="grow"></span>${approve}</div></div>`;
  }).join("");
}
function bindRequestActions(el) {
  el.addEventListener("click", async (e) => {
    const ap = e.target.closest("[data-approve]"), rj = e.target.closest("[data-reject]");
    if (ap) {
      const r = reqOf(ap.dataset.approve); if (!r) return;
      if (ap.tagName !== "A") e.preventDefault();
      ap.classList.add("busy");
      try { await api.approve(r); toast(`Approved ✓ ${r.name}: #${r.nums.join(", #")}`); } catch (er) { toast(er.message); ap.classList.remove("busy"); }
    } else if (rj) {
      const r = reqOf(rj.dataset.reject); if (!r) return;
      if (!(await askConfirm(`Reject ${r.name}'s request? Numbers ${r.nums.join(", ")} become free again.`, { ok: "Reject", danger: true }))) return;
      try { await api.reject(r); toast("Rejected. Numbers are free again."); } catch (er) { toast(er.message); }
    }
  });
}

function TemplatesCard() {
  return `<section class="card"><h2>WhatsApp messages</h2>
    <p class="muted small" style="margin-top:0">Messages open in WhatsApp ready to send, from the WhatsApp on the device you use. {name} {prize} {numbers} {date} {link} are filled in for each person.</p>
    <label class="field"><span>After you approve (thank you)</span><textarea id="tplThanks" dir="auto" style="min-height:150px"></textarea></label>
    <label class="field"><span>Before the draw (date &amp; time)</span><textarea id="tplDraw" dir="auto" style="min-height:170px"></textarea></label>
    <button class="btn ghost sm" id="tplReset">Back to default messages</button></section>`;
}
function bindTemplates(el) {
  const t1 = $("#tplThanks", el), t2 = $("#tplDraw", el);
  t1.value = tpl("thanks"); t2.value = tpl("draw");
  t1.oninput = () => { lsSet("tpl_thanks", t1.value); refresh(); };
  t2.oninput = () => { lsSet("tpl_draw", t2.value); refresh(); };
  $("#tplReset", el).onclick = () => { lsSet("tpl_thanks", ""); lsSet("tpl_draw", ""); t1.value = TPL_THANKS; t2.value = TPL_DRAW; refresh(); toast("Default messages restored"); };
}

/* ---------------- ADMIN: overview ---------------- */
function AdminView() {
  let el;
  return {
    mount(root) {
      el = root;
      el.innerHTML = `<div class="row" style="justify-content:space-between;margin-bottom:14px"><h1 class="page-title">Admin</h1><button class="btn gold sm" id="addW">+ Add wheel</button></div>
        <section class="card"><h2>Requests to approve <span class="muted" id="pendCount"></span></h2><div id="pending"></div></section>
        <section class="card" id="notifCard"><h2>🔔 Notifications</h2><p class="muted small" style="margin-top:0">Get a notification on this phone for every new request, even when the app is closed.</p><div id="notifBody"></div></section>
        <section class="card"><h2>Wheels <span class="muted" id="wCount"></span></h2><div id="wheels"></div></section>
        ${TemplatesCard()}`;
      $("#addW", el).onclick = () => openAddWheel();
      bindRequestActions(el); bindTemplates(el); renderNotif($("#notifBody", el));
    },
    update() {
      const list = sortedWheels(), pend = pendingReqs();
      $("#pendCount", el).textContent = pend.length ? `(${pend.length})` : "";
      const ph = requestsHtml(pend, true), pe = $("#pending", el); if (pe.dataset.h !== ph) { pe.innerHTML = ph; pe.dataset.h = ph; }
      $("#wCount", el).textContent = `(${list.length})`;
      $("#wheels", el).innerHTML = list.length ? `<div class="table-wrap"><table><tr><th>Prize</th><th>Sold</th><th>Price</th><th>Whish</th><th>Status</th></tr>${list.map((w) => {
        const p = pendingReqs(w.id).length;
        return `<tr><td><a href="#/admin/${w.id}" style="color:var(--text);font-weight:700">${esc(w.prizeTitle)}</a></td><td>${paid(w).length}/${total(w)}${p ? ` <span class="chip red">${p} new</span>` : ""}</td><td>${esc(money(w.price, w))}</td><td class="small" style="white-space:nowrap">${esc(w.whishNumber)}</td><td>${statusChip(w)}</td></tr>`;
      }).join("")}</table></div><p class="small muted" style="margin-bottom:0">Tap a prize to manage it.</p>` : `<div class="empty">No wheels yet. Tap “+ Add wheel”.</div>`;
    },
  };
}


/* ---------------- push notifications (admin) ---------------- */
function b64ToBytes(b64) { const p = "=".repeat((4 - (b64.length % 4)) % 4); const raw = atob((b64 + p).replace(/-/g, "+").replace(/_/g, "/")); return Uint8Array.from([...raw].map((c) => c.charCodeAt(0))); }
async function swReg() {
  if (!("serviceWorker" in navigator)) return null;
  try { await navigator.serviceWorker.register("sw.js"); } catch (e) {}
  return Promise.race([navigator.serviceWorker.ready, new Promise((r) => setTimeout(() => r(null), 6000))]);
}
async function renderNotif(box) {
  if (!box) return;
  const say = (html) => (box.innerHTML = html);
  if (!api.push) return say(`<div class="empty">Notifications work once the site is connected to Supabase.</div>`);
  if (!CFG.VAPID_PUBLIC_KEY) return say(`<div class="empty">Add your VAPID public key in <b>config.js</b> to turn this on (see README).</div>`);
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
    return say(isIOS() && !isStandalone()
      ? `<p class="small">On iPhone: open this site in Safari → <b>Share</b> → <b>Add to Home Screen</b>. Then open the app from the home screen, come back here, and turn notifications on.</p>`
      : `<div class="empty">This browser can't receive notifications. Use Chrome on Android, or the installed app on iPhone.</div>`);
  }
  if (Notification.permission === "denied") return say(`<p class="small" style="color:var(--amber)">Notifications are blocked for this site. Allow them in the browser / phone settings for this site, then reload.</p>`);
  say(`<div class="muted small">Checking…</div>`);
  const reg = await swReg();
  const sub = reg && (await reg.pushManager.getSubscription());
  if (sub) {
    say(`<p style="margin:0 0 10px"><span class="chip green">On for this device ✓</span></p><div class="row"><button class="btn ghost sm" id="nTest">Send a test</button><button class="btn ghost sm" id="nOff">Turn off</button></div>`);
    $("#nTest", box).onclick = async (e) => { e.target.disabled = true; try { const r = await api.testPush(location.origin + location.pathname + "#/admin"); toast(r && r.sent ? `Test sent to ${r.sent} device${r.sent > 1 ? "s" : ""} ✓` : "Sent, but no device is registered yet."); } catch (er) { toast("Test failed: " + er.message); } e.target.disabled = false; };
    $("#nOff", box).onclick = async () => { try { await api.removePush(sub.endpoint); } catch (e) {} await sub.unsubscribe().catch(() => {}); toast("Notifications off"); renderNotif(box); };
  } else {
    say(`<button class="btn gold" id="nOn">🔔 Turn on notifications</button>`);
    $("#nOn", box).onclick = async (e) => {
      e.target.disabled = true;
      try {
        const perm = await Notification.requestPermission();
        if (perm !== "granted") throw new Error("Permission not given.");
        const r = reg || (await swReg()); if (!r) throw new Error("The app is not ready. Reload and try again.");
        const s = await r.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(CFG.VAPID_PUBLIC_KEY) });
        await api.savePush(s.toJSON());
        toast("Notifications on ✓");
      } catch (er) { toast(er.message || "Couldn't turn on"); }
      renderNotif(box);
    };
  }
}

/* ---------------- ADMIN: one wheel ---------------- */
function WheelAdminView(wid) {
  let el, mounted = false, imgData = null;
  const pick = new Set();
  const toLocalInput = (ms) => { if (!ms) return ""; const d = new Date(ms); const p = (v) => String(v).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };
  const participants = (w) => {
    const by = {};
    paid(w).forEach((d) => {
      const r = reqOf(d.reqId), key = intlPhone(r?.phone) || "n:" + who(d.name);
      const p = (by[key] = by[key] || { key, name: d.name, phone: r?.phone || "", nums: [] }); p.nums.push(d.n);
    });
    return Object.values(by).sort((a, b) => a.name.localeCompare(b.name));
  };

  function build(w) {
    el.innerHTML = wheelTabs(w, "admin") + `
      <section class="card"><h2>Requests to approve <span class="muted" id="pendCount"></span></h2><div id="pending"></div></section>

      <section class="card"><h2>Add numbers yourself</h2>
        <p class="muted small" style="margin-top:0">For people who pay you directly. Tap free numbers, write the name, and add. Tap a red number to see who has it.</p>
        <div class="numgrid admin" id="aGrid"></div>
        <form id="aForm" class="spacer" style="height:auto;margin-top:14px">
          <div class="grid2"><label class="field"><span>Name</span><input name="name" maxlength="40" required></label>
          <label class="field"><span>Phone (optional, for WhatsApp)</span><input name="phone" type="tel" maxlength="20" placeholder="70 123 456"></label></div>
          <div class="error" id="aErr"></div>
          <button class="btn gold block" id="aBtn" disabled>Select numbers above</button></form></section>

      <section class="card"><h2>Sold numbers <span class="muted" id="soldCount"></span></h2><div class="table-wrap" id="sold"></div></section>

      <section class="card" id="notifyCard"><h2>📣 Tell everyone the draw time</h2>
        <p class="muted small" style="margin-top:0"><span id="notifyHint"></span></p>
        <button class="btn gold block" id="nGroup" style="font-size:18px">📋 Copy the message</button>
        <p class="small muted" style="margin:10px 0 0">Then paste it in your WhatsApp broadcast (or group) and press Send.</p>
        <div id="notifyList" hidden></div></section>

      <section class="card"><h2>Draw date &amp; time</h2><p class="muted small" style="margin-top:0">When this time comes, the <b>START</b> button appears on the wheel page (only for you). Everyone sees the spin live.</p>
        <div class="row"><input type="datetime-local" id="drawAt" class="grow" style="width:auto"><button class="btn gold" id="saveDraw">Save</button><button class="btn ghost" id="clearDraw">Clear</button></div>
        <p class="small" id="drawInfo"></p><a class="btn ghost sm" href="#/draw/${w.id}">Open the wheel →</a></section>

      <section class="card"><h2>Sponsors</h2>
        <p class="muted small" style="margin-top:0">Their logos scroll in a thin bar above this prize. No logos = no bar.</p>
        <div class="sp-admin" id="spList"></div>
        <label class="btn gold" style="cursor:pointer;margin-top:10px">+ Add sponsor logo<input type="file" id="spFile" accept="image/*" multiple hidden></label>
        <div id="spPrev" style="margin-top:14px"></div></section>

      <section class="card"><h2>Prize &amp; price</h2><form id="setForm">
        <label class="field"><span>Prize name</span><input name="prizeTitle" maxlength="60" required></label>
        <label class="field"><span>Description</span><textarea name="prizeDesc" maxlength="300"></textarea></label>
        <label class="field"><span>Prize photo (optional)</span><input type="file" name="img" accept="image/*"></label>
        <div id="imgPrev" class="row" style="margin:-4px 0 12px"></div>
        <div class="grid2">
          <label class="field"><span>How many numbers (1–100)</span><input name="totalNumbers" type="number" min="1" max="100" required></label>
          <label class="field"><span>Price per number</span><div class="row" style="flex-wrap:nowrap"><input name="price" type="number" min="0" step="0.01" required><input name="currency" maxlength="5" style="width:80px" placeholder="$"></div></label>
          <label class="field"><span>Whish number for this wheel</span><input name="whishNumber" type="tel" required></label>
          <label class="field"><span>Name on Whish</span><input name="whishName" maxlength="40"></label>
        </div>
        <div class="error" id="setErr"></div><button class="btn gold">Save</button></form></section>

      <section class="card"><h2>Round</h2><p class="muted small" style="margin-top:0">New round: deletes this wheel's numbers, requests and winner, keeps its settings.</p>
        <div class="row"><button class="btn ghost" id="reset">Start new round</button>${api.mode === "demo" ? `<button class="btn ghost" id="fill">Fill remaining numbers (demo test)</button>` : ""}<button class="btn red" id="delW">Delete wheel</button></div></section>`;

    // settings
    const f = $("#setForm", el);
    ["prizeTitle", "prizeDesc", "totalNumbers", "price", "currency", "whishNumber", "whishName"].forEach((k) => (f[k].value = w[k] ?? ""));
    $("#drawAt", el).value = toLocalInput(w.drawAt);
    f.img.onchange = async () => {
      const file = f.img.files[0]; if (!file) return;
      try { imgData = await resizeImage(file, 700); $("#imgPrev", el).innerHTML = `<img src="${imgData}" style="height:70px;border-radius:10px"><span class="small muted">Saved when you tap Save</span>`; }
      catch (e) { toast("Couldn't read that image"); }
    };
    f.onsubmit = async (e) => {
      e.preventDefault(); $("#setErr", el).textContent = "";
      const tn = Math.round(Number(f.totalNumbers.value)), maxUsed = Math.max(0, ...numsOf(wid).map((d) => d.n));
      if (tn < 1 || tn > 100) return ($("#setErr", el).textContent = "Numbers must be between 1 and 100.");
      if (tn < maxUsed) return ($("#setErr", el).textContent = `Number ${maxUsed} is already taken, so the total can't be less than ${maxUsed}.`);
      const data = { prizeTitle: f.prizeTitle.value.trim(), prizeDesc: f.prizeDesc.value.trim(), totalNumbers: tn, price: Number(f.price.value), currency: f.currency.value.trim() || "$", whishNumber: f.whishNumber.value.trim(), whishName: f.whishName.value.trim() };
      if (imgData) data.prizeImage = imgData;
      try { await api.saveWheel(wid, data); imgData = null; $("#imgPrev", el).innerHTML = ""; f.img.value = ""; toast("Saved ✓"); } catch (er) { $("#setErr", el).textContent = er.message; }
    };
    $("#saveDraw", el).onclick = async () => {
      const v = $("#drawAt", el).value; if (!v) return toast("Choose a date and time");
      const ms = new Date(v).getTime(); if (isNaN(ms)) return toast("Invalid date");
      await api.saveWheel(wid, { drawAt: ms }); toast("Draw time saved ✓");
    };
    $("#clearDraw", el).onclick = async () => { await api.saveWheel(wid, { drawAt: null }); $("#drawAt", el).value = ""; toast("Draw time cleared"); };
    $("#reset", el).onclick = async () => {
      if (!(await askConfirm("Start a new round for this wheel? Its numbers, requests and winner will be deleted.", { ok: "Delete & restart", danger: true, typeText: "RESET" }))) return;
      await api.resetRound(wid); S.autoDrawDone.delete(wid); $("#drawAt", el).value = ""; toast("New round started");
    };
    $("#delW", el).onclick = async () => {
      if (!(await askConfirm(`Delete the wheel “${W(wid)?.prizeTitle}” with all its numbers?`, { ok: "Delete wheel", danger: true, typeText: "DELETE" }))) return;
      await api.deleteWheel(wid); toast("Wheel deleted"); location.hash = "#/admin";
    };
    const fill = $("#fill", el); if (fill) fill.onclick = () => api.fillDemo(wid, total(W(wid)));
    $("#spFile", el).onchange = async (e) => {
      const files = [...e.target.files]; e.target.value = ""; if (!files.length) return;
      const cur = [...(W(wid)?.sponsors || [])];
      if (cur.length + files.length > 12) return toast("Up to 12 sponsors per wheel.");
      try {
        for (const f of files) cur.push({ img: await resizeLogo(f), name: f.name.replace(/\.[^.]+$/, "").slice(0, 40) });
        await api.saveWheel(wid, { sponsors: cur }); toast(files.length > 1 ? files.length + " logos added ✓" : "Logo added ✓");
      } catch (er) { toast(er.message || "Couldn't add the logo"); }
    };
    $("#spList", el).addEventListener("click", async (e) => {
      const b = e.target.closest("[data-sp]"); if (!b) return;
      if (!(await askConfirm("Remove this sponsor?", { ok: "Remove", danger: true }))) return;
      const cur = [...(W(wid)?.sponsors || [])]; cur.splice(Number(b.dataset.sp), 1);
      try { await api.saveWheel(wid, { sponsors: cur }); toast("Removed"); } catch (er) { toast(er.message); }
    });

    // add numbers yourself
    $("#aGrid", el).addEventListener("click", (e) => {
      const b = e.target.closest(".num"); if (!b) return;
      const n = Number(b.dataset.n), d = numMap(wid)[n];
      if (d) return showNumber(d);
      if (W(wid)?.draw) return toast("The draw already happened.");
      pick.has(n) ? pick.delete(n) : pick.add(n); renderAdd();
    });
    const af = $("#aForm", el);
    af.onsubmit = async (e) => {
      e.preventDefault(); const err = $("#aErr", el), b = $("#aBtn", el); err.textContent = "";
      const nums = [...pick].sort((a, b) => a - b), name = af.name.value.trim(), phone = af.phone.value.trim();
      if (!nums.length) return; if (name.length < 2) { err.textContent = "Write the name."; return af.name.focus(); }
      if (phone && !intlPhone(phone)) { err.textContent = "That phone number doesn't look right."; return af.phone.focus(); }
      b.disabled = true;
      try {
        await api.adminAdd(wid, nums, name, phone);
        pick.clear(); af.reset(); renderAdd();
        const link = waLink(phone, fillMsg(thanksTpl(), { name, w: W(wid), nums }));
        modal(`<div style="text-align:center"><div style="font-size:48px">✅</div><h3>Added</h3><p class="muted">${nums.map((n) => "#" + n).join(", ")} are now sold to <b>${esc(name)}</b>.</p>${link ? `<a class="btn green block" href="${esc(link)}" target="_blank" rel="noopener" data-close>Send thank-you on WhatsApp</a><div class="spacer"></div>` : ""}<button class="btn ghost block" data-close>Done</button></div>`);
      } catch (er) { err.textContent = er.message; if (er.taken) { er.taken.forEach((n) => pick.delete(n)); } renderAdd(); }
    };
    void 0; if ($("#nAll", el)) $("#nAll", el).onclick = () => sendToAll();
    $("#nGroup", el).onclick = () => { const w = W(wid); copyRaw(fillMsg(TPL_GROUP, { name: "", w, nums: [] }), "Copied ✓ Paste it in WhatsApp and Send."); };
    void 0; if ($("#nVcf", el)) $("#nVcf", el).onclick = () => {
      const w = W(wid), ps = participants(w).filter((p) => intlPhone(p.phone));
      if (!ps.length) return toast("No phone numbers yet");
      const clean = (t) => String(t).replace(/[\r\n;,]/g, " ");
      const vcf = ps.map((p) => `BEGIN:VCARD\r\nVERSION:3.0\r\nFN:${clean(p.name)} (${clean(w.prizeTitle)})\r\nN:${clean(p.name)};;;;\r\nTEL;TYPE=CELL:+${intlPhone(p.phone)}\r\nNOTE:Lucky Wheel ${clean(w.prizeTitle)} #${p.nums.join(" #")}\r\nEND:VCARD`).join("\r\n");
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([vcf], { type: "text/vcard" }));
      a.download = `lucky-wheel-${String(w.prizeTitle).replace(/[^\w]+/g, "-").slice(0, 30)}.vcf`;
      document.body.appendChild(a); a.click(); a.remove();
      toast(ps.length + " contacts downloaded. Open the file to add them.");
    };
    void 0; if ($("#nCopyAll", el)) $("#nCopyAll", el).onclick = () => { const ps = participants(W(wid)).map((p) => intlPhone(p.phone)).filter(Boolean); if (!ps.length) return toast("No phone numbers yet"); copyRaw(ps.map((x) => "+" + x).join("\n"), ps.length + " numbers copied"); };
    $("#notifyList", el).addEventListener("click", (e) => { const a = e.target.closest("a[data-key]"); if (!a) return; const k = "sent_" + wid + "_" + (W(wid)?.drawAt || 0); const m = JSON.parse(lsGet(k) || "{}"); m[a.dataset.key] = 1; lsSet(k, JSON.stringify(m)); setTimeout(() => refresh(), 300); });
    $("#sold", el).addEventListener("click", (e) => { const b = e.target.closest("[data-n]"); if (b) { const d = numMap(wid)[Number(b.dataset.n)]; if (d) showNumber(d); } });
    bindRequestActions(el);
  }

  function showNumber(d) {
    const r = reqOf(d.reqId), w = W(wid);
    modal(`<h3>Number #${d.n}</h3>
      <p style="margin:0 0 4px"><b style="font-size:18px">${esc(d.name)}</b></p>
      <p class="small muted" style="margin:0 0 4px">${r?.phone ? `📞 <a href="tel:${esc(r.phone)}" style="color:var(--muted)">${esc(r.phone)}</a>` : "No phone"}</p>
      <p class="small muted" style="margin:0 0 14px">${d.status === "paid" ? "Sold ✓" : "Waiting for approval"} · ${r?.source === "admin" ? "added by you" : "from the site"} · ${ago(d.createdAt)}</p>
      <div class="row"><button class="btn ghost grow" data-close>Close</button><button class="btn red grow" id="rmN">Remove</button></div>`, {
      onMount(m, close) {
        $("#rmN", m).onclick = async () => {
          if (w?.draw) return toast("The draw already happened. Start a new round first.");
          if (!(await askConfirm(`Remove #${d.n} from ${d.name}? It becomes free again.`, { ok: "Remove", danger: true }))) return;
          try { await api.removeNumber(wid, d.n, r); toast("Removed"); } catch (er) { toast(er.message); }
        };
      },
    });
  }

  function renderAdd() {
    const w = W(wid); if (!w) return;
    const m = numMap(wid), T = total(w);
    [...pick].forEach((n) => { if (m[n] || n > T) pick.delete(n); });
    let html = "";
    for (let n = 1; n <= T; n++) {
      const d = m[n];
      const cls = d ? (d.status === "paid" ? "num taken" : "num pending") : pick.has(n) ? "num sel" : "num";
      html += `<button type="button" class="${cls}" data-n="${n}" title="${d ? esc(d.name) : "Free"}">${n}</button>`;
    }
    const g = $("#aGrid", el); if (g.dataset.h !== html) { g.innerHTML = html; g.dataset.h = html; }
    const b = $("#aBtn", el), nums = [...pick].sort((a, b) => a - b);
    b.disabled = !nums.length;
    b.textContent = nums.length ? `Add ${nums.length > 1 ? nums.length + " numbers" : "#" + nums[0]} as sold (${money(nums.length * w.price, w)})` : "Select numbers above";
  }

  // one tap per person, automatically moves to the next one
  function sendToAll() {
    const w = W(wid); if (!w) return;
    const key = "sent_" + wid + "_" + (w.drawAt || 0);
    const getSent = () => JSON.parse(lsGet(key) || "{}");
    const all = participants(w).filter((p) => intlPhone(p.phone));
    if (!all.length) return toast("No phone numbers yet");
    let skipped = new Set();
    modal(`<div id="qBox"></div>`, {
      onMount(m, close) {
        const box = $("#qBox", m);
        const draw = () => {
          const sent = getSent(), left = all.filter((p) => !sent[p.key] && !skipped.has(p.key)), done = all.length - left.length;
          if (!left.length) {
            box.innerHTML = `<div style="text-align:center"><div style="font-size:50px">✅</div><h3>Everyone got the message</h3><p class="muted">${Object.keys(sent).length} of ${all.length} sent.${skipped.size ? " " + skipped.size + " skipped." : ""}</p><button class="btn gold block" id="qDone">Done</button></div>`;
            $("#qDone", box).onclick = () => { close(); refresh(); };
            return;
          }
          const p = left[0], link = waLink(p.phone, fillMsg(tpl("draw"), { name: p.name, w, nums: p.nums }));
          box.innerHTML = `<h3>📣 Send to everyone</h3>
            ${!w.drawAt ? `<p class="small" style="color:var(--amber)">No draw date yet: the message will say “قريباً”.</p>` : ""}
            <div class="progress" style="margin:6px 0 14px"><div style="width:${(done / all.length) * 100}%"></div></div>
            <p class="muted small" style="margin:0">${done + 1} of ${all.length}</p>
            <p style="margin:4px 0 2px;font-size:22px;font-weight:800">${esc(p.name)}</p>
            <p class="small muted" style="margin:0 0 14px">${esc(p.phone)} · ${p.nums.map((n) => "#" + n).join(" ")}</p>
            <a class="btn green block" id="qGo" href="${esc(link)}" target="_blank" rel="noopener" style="text-align:center;font-size:18px">Send on WhatsApp ▶</a>
            <p class="small muted" style="margin:10px 0 12px">Tap, press Send in WhatsApp, come back here. The next person is ready automatically.</p>
            <div class="row"><button class="btn ghost sm" id="qSkip">Skip</button><span class="grow"></span><button class="btn ghost sm" id="qStop">Stop</button></div>`;
          $("#qGo", box).onclick = () => { const s2 = getSent(); s2[p.key] = 1; lsSet(key, JSON.stringify(s2)); setTimeout(draw, 400); };
          $("#qSkip", box).onclick = () => { skipped.add(p.key); draw(); };
          $("#qStop", box).onclick = () => { close(); refresh(); };
        };
        draw();
      },
      dismiss: false,
    });
  }

  function renderNotify() {
    const w = W(wid), ps = participants(w), sent = JSON.parse(lsGet("sent_" + wid + "_" + (w.drawAt || 0)) || "{}");
    $("#notifyHint", el).innerHTML = !soldOut(w) ? `<b style="color:var(--amber)">Not all numbers are sold yet.</b>` : !w.drawAt ? `<b style="color:var(--amber)">Set the draw date &amp; time first (below).</b>` : `<b style="color:var(--green)">All sold and the draw time is set. Ready to send ✓</b>`;
    const html = ps.length ? ps.map((p) => {
      const link = waLink(p.phone, fillMsg(tpl("draw"), { name: p.name, w, nums: p.nums }));
      const btn = link ? `<a class="btn sm ${sent[p.key] ? "ghost" : "green"}" data-key="${esc(p.key)}" href="${esc(link)}" target="_blank" rel="noopener">${sent[p.key] ? "Sent ✓" : "WhatsApp"}</a>` : `<span class="small muted">No phone</span>`;
      return `<div class="player" style="justify-content:space-between;margin-bottom:8px"><div><div><b>${esc(p.name)}</b> <span class="small muted">${esc(p.phone)}</span></div><div class="nums">${p.nums.map((n) => "#" + n).join(" ")}</div></div>${btn}</div>`;
    }).join("") : `<div class="empty">No sold numbers yet.</div>`;
    const box = $("#notifyList", el); if (box.dataset.h !== html) { box.innerHTML = html; box.dataset.h = html; }
  }

  return {
    mount(root) { el = root; },
    update() {
      const w = W(wid); if (!w) { mounted = false; return notFound(el); }
      if (!mounted) { build(w); mounted = true; }
      const sp = w.sponsors || [];
      setHtml($("#spList", el), sp.length ? sp.map((x, i) => `<div class="sp-tile"><img src="${esc(x.img)}" alt="${esc(x.name || "Sponsor")}"><button type="button" class="sp-x" data-sp="${i}" aria-label="Remove ${esc(x.name || "sponsor")}">×</button></div>`).join("") : `<div class="empty">No sponsors yet.</div>`);
      setHtml($("#spPrev", el), sp.length ? `<div class="small muted" style="margin-bottom:6px">Preview</div>` + sponsorStrip(w) : "");
      $("#drawInfo", el).innerHTML = w.drawAt ? `Current: <b>${esc(fmtDate(w.drawAt))}</b>${w.draw ? " · <span style='color:var(--green)'>draw done ✓</span>" : ""}` : `<span class="muted">No date set yet.</span>`;
      const pend = pendingReqs(wid);
      $("#pendCount", el).textContent = pend.length ? `(${pend.length})` : "";
      const ph = requestsHtml(pend, false), pe = $("#pending", el); if (pe.dataset.h !== ph) { pe.innerHTML = ph; pe.dataset.h = ph; }
      renderAdd(); renderNotify();
      const sold = paid(w);
      $("#soldCount", el).textContent = `(${sold.length} / ${total(w)})`;
      const sh = sold.length ? `<table><tr><th>#</th><th>Name</th><th>Phone</th><th>From</th></tr>${sold.map((d) => {
        const r = reqOf(d.reqId);
        return `<tr data-n="${d.n}" style="cursor:pointer"><td><b>${d.n}</b></td><td>${esc(d.name)}</td><td style="white-space:nowrap">${esc(r?.phone || "")}</td><td class="small muted">${r?.source === "admin" ? "You" : "Site"}</td></tr>`;
      }).join("")}</table>` : `<div class="empty">Nothing sold yet.</div>`;
      const so = $("#sold", el); if (so.dataset.h !== sh) { so.innerHTML = sh; so.dataset.h = sh; }
    },
  };
}
function resizeLogo(file) {
  return new Promise((res, rej) => {
    const img = new Image(), url = URL.createObjectURL(file);
    img.onload = () => {
      const k = Math.min(1, 96 / img.height, 320 / img.width), c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(img.width * k)); c.height = Math.max(1, Math.round(img.height * k));
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url);
      let d = c.toDataURL("image/webp", 0.85); if (!d.startsWith("data:image/webp")) d = c.toDataURL("image/png");
      res(d);
    };
    img.onerror = () => rej(new Error("That file is not an image."));
    img.src = url;
  });
}
function resizeImage(file, max) {
  return new Promise((res, rej) => {
    const img = new Image(); const url = URL.createObjectURL(file);
    img.onload = () => { const k = Math.min(1, max / Math.max(img.width, img.height)); const c = document.createElement("canvas"); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k); c.getContext("2d").drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url); res(c.toDataURL("image/jpeg", 0.8)); };
    img.onerror = rej; img.src = url;
  });
}

boot();
