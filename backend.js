// Data layer: Supabase (real, shared between all devices) or Demo (localStorage, this browser only).
// Visitors need no account: they get an invisible anonymous id. Only the admin logs in.
// Data model:
//   wheels    prize, price, total numbers, Whish number, draw time, draw (spin result)   public
//   numbers   one row per requested/sold number: n, name, status pending|paid            public (shown on the wheel)
//   requests  name + phone + numbers of one request (or admin entry)                     private: admin + its sender
// Tables, security rules and functions: supabase.sql
import { SUPABASE_URL, SUPABASE_ANON_KEY, ADMIN_EMAILS } from "./config.js";

const isAdminEmail = (e) => ADMIN_EMAILS.map((x) => x.toLowerCase()).includes(String(e || "").toLowerCase());

export const DEFAULT_WHEEL = {
  prizeTitle: "New prize", prizeDesc: "Pick your lucky number and win!", prizeImage: "",
  totalNumbers: 100, price: 5, currency: "$", whishNumber: "", whishName: "", drawAt: null, draw: null,
};
const clean = (s, max) => String(s || "").trim().replace(/\s+/g, " ").slice(0, max);

export async function initBackend() {
  if (SUPABASE_URL && SUPABASE_ANON_KEY) return initSupabase();
  return initDemo();
}

/* ============================ SUPABASE ============================ */
async function initSupabase() {
  const { createClient } = await import("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm");
  const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: true, autoRefreshToken: true } });
  let current = null;

  const wheelFrom = (r) => ({ id: r.id, prizeTitle: r.prize_title, prizeDesc: r.prize_desc, prizeImage: r.prize_image, totalNumbers: r.total_numbers, price: Number(r.price), currency: r.currency, whishNumber: r.whish_number, whishName: r.whish_name, drawAt: r.draw_at == null ? null : Number(r.draw_at), draw: r.draw || null, createdAt: Number(r.created_at) });
  const WHEEL_COLS = { prizeTitle: "prize_title", prizeDesc: "prize_desc", prizeImage: "prize_image", totalNumbers: "total_numbers", price: "price", currency: "currency", whishNumber: "whish_number", whishName: "whish_name", drawAt: "draw_at", draw: "draw" };
  const wheelTo = (d) => { const o = {}; for (const k in d) if (WHEEL_COLS[k]) o[WHEEL_COLS[k]] = d[k]; return o; };
  const numFrom = (r) => ({ wheelId: r.wheel_id, n: r.n, name: r.name, status: r.status, reqId: r.req_id, uid: r.uid, createdAt: Number(r.created_at) });
  const reqFrom = (r) => ({ id: r.id, wheelId: r.wheel_id, nums: r.nums || [], name: r.name, phone: r.phone, status: r.status, source: r.source, note: r.note, uid: r.uid, createdAt: Number(r.created_at) });

  const errMsg = (e) => {
    const m = (e && (e.message || e.error_description)) || "";
    if (/Invalid login credentials/i.test(m)) return "Wrong email or password.";
    if (/Anonymous sign-ins are disabled/i.test(m)) return "Anonymous sign-ins are off in Supabase (see README).";
    if (/row-level security|permission denied/i.test(m)) return "Not allowed (" + m + ").";
    if (/Failed to fetch|NetworkError/i.test(m)) return "No connection. Check your internet and try again.";
    return m || "Something went wrong.";
  };
  const ok = ({ data, error }) => { if (error) throw new Error(errMsg(error)); return data; };

  // live table: load all rows, reload on any change (and when the app comes back to the screen)
  const loaders = [];
  function live(table, map, cb) {
    let alive = true, t = 0;
    const load = async () => { const { data, error } = await sb.from(table).select("*"); if (alive && !error) cb(data.map(map)); };
    const soon = () => { clearTimeout(t); t = setTimeout(load, 120); };
    const ch = sb.channel("lw-" + table + "-" + Math.random().toString(36).slice(2)).on("postgres_changes", { event: "*", schema: "public", table }, soon).subscribe((st) => { if (st === "SUBSCRIBED") soon(); });
    loaders.push(soon); load();
    return () => { alive = false; sb.removeChannel(ch); const i = loaders.indexOf(soon); if (i >= 0) loaders.splice(i, 1); };
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden) loaders.forEach((f) => f()); });
  window.addEventListener("online", () => loaders.forEach((f) => f()));

  // make sure this visitor has its invisible anonymous session before taking numbers
  let visitorP = null;
  async function ensureVisitor(force) {
    const { data } = await sb.auth.getSession();
    if (data?.session && !force) return;
    if (!visitorP) visitorP = (async () => {
      if (force) { try { await sb.auth.refreshSession(); const s = await sb.auth.getSession(); if (s.data?.session) return; } catch (e) {} }
      const { error } = await sb.auth.signInAnonymously();
      if (error) throw new Error(/rate limit|too many/i.test(error.message) ? "Too many people right now. Wait a minute and try again." : "Couldn't connect (" + error.message + "). Try again.");
    })().finally(() => { visitorP = null; });
    await visitorP;
  }

  async function claim(wid, nums, name, phone, note, asAdmin) {
    if (!asAdmin) await ensureVisitor(false);
    const call = () => sb.rpc("claim_numbers", { p_wheel: wid, p_nums: nums, p_name: name, p_phone: phone, p_note: note || "", p_as_admin: asAdmin });
    let { data, error } = await call();
    if (error && /reload the page/i.test(error.message || "") && !asAdmin) { await ensureVisitor(true); ({ data, error } = await call()); }
    if (error) {
      const m = error.message || "";
      if (m.startsWith("TAKEN:")) { const t = m.slice(6).split(",").filter(Boolean).map(Number); const e = new Error(`Sorry, ${t.length > 1 ? "numbers " + t.join(", ") + " were" : "number " + t[0] + " was"} just taken by someone else. Pick another.`); e.taken = t; throw e; }
      throw new Error(errMsg(error));
    }
    loaders.forEach((f) => f());
    return data;
  }
  const after = async (p) => { const r = ok(await p); loaders.forEach((f) => f()); return r; };

  return {
    mode: "supabase",
    onAuth(cb) {
      const set = async (session) => {
        const u = session?.user;
        if (!u) {
          current = null; cb(null);
          try { await ensureVisitor(false); } catch (e) { console.warn("Visitor sign-in failed:", e.message); }
          return;
        }
        current = { uid: u.id, email: u.email || "", isAdmin: !u.is_anonymous && isAdminEmail(u.email) };
        cb(current);
      };
      const { data } = sb.auth.onAuthStateChange((event, session) => { if (["INITIAL_SESSION", "SIGNED_IN", "SIGNED_OUT", "USER_UPDATED"].includes(event)) setTimeout(() => set(session), 0); });
      return () => data.subscription.unsubscribe();
    },
    async adminLogin(email, password) {
      if (!isAdminEmail(email)) throw new Error("This email is not an admin.");
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw new Error(errMsg(error));
    },
    async resetPassword(email) { const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname + "#/admin" }); if (error) throw new Error(errMsg(error)); },
    signOut: () => sb.auth.signOut(),

    onWheels: (cb) => live("wheels", wheelFrom, cb),
    onNumbers: (cb) => live("numbers", numFrom, cb),
    onRequests: (cb) => live("requests", reqFrom, cb),
    async createWheel(data) { const r = await after(sb.from("wheels").insert(wheelTo({ ...DEFAULT_WHEEL, ...data, draw: null, drawAt: null })).select("id").single()); return r.id; },
    saveWheel: (id, data) => after(sb.from("wheels").update(wheelTo(data)).eq("id", id)),
    deleteWheel: (id) => after(sb.from("wheels").delete().eq("id", id)),

    request: (wid, nums, name, phone) => claim(wid, nums, clean(name, 40), clean(phone, 20), "", false),
    adminAdd: (wid, nums, name, phone, note) => claim(wid, nums, clean(name, 40), clean(phone, 20), clean(note, 80), true),
    async approve(req) {
      ok(await sb.from("numbers").update({ status: "paid" }).eq("wheel_id", req.wheelId).in("n", req.nums));
      await after(sb.from("requests").update({ status: "paid" }).eq("id", req.id));
    },
    reject: (req) => after(sb.from("requests").delete().eq("id", req.id)),   // its numbers are freed with it
    async removeNumber(wid, n, req) {
      ok(await sb.from("numbers").delete().eq("wheel_id", wid).eq("n", n));
      if (req) { const rest = req.nums.filter((x) => x !== n); await after(rest.length ? sb.from("requests").update({ nums: rest }).eq("id", req.id) : sb.from("requests").delete().eq("id", req.id)); }
      else loaders.forEach((f) => f());
    },
    startDraw: (wid, data) => after(sb.rpc("start_draw", { p_wheel: wid, p_data: data })),

    // push notifications for the admin (see notifications.sql + supabase/functions/notify-admin)
    push: true,
    async savePush(sub) { ok(await sb.from("push_subs").upsert({ endpoint: sub.endpoint, sub }, { onConflict: "endpoint" })); },
    async removePush(endpoint) { ok(await sb.from("push_subs").delete().eq("endpoint", endpoint)); },
    async testPush(url) {
      const { data, error } = await sb.functions.invoke("notify-admin", { body: { test: true, url } });
      if (error) { let m = error.message; try { const j = await error.context.json(); m = j.error || m; } catch (e) {} throw new Error(m); }
      return data;
    },
    async resetRound(wid) {
      ok(await sb.from("requests").delete().eq("wheel_id", wid));
      ok(await sb.from("numbers").delete().eq("wheel_id", wid));
      await after(sb.from("wheels").update({ draw: null, draw_at: null }).eq("id", wid));
    },
    fillDemo: null,
  };
}

/* ============================ DEMO (localStorage) ============================ */
function initDemo() {
  const P = "raffle3_", mem = {};
  const store = {
    get(k, d) { try { const v = localStorage.getItem(P + k); return v ? JSON.parse(v) : d; } catch (e) { return k in mem ? mem[k] : d; } },
    set(k, v) { try { localStorage.setItem(P + k, JSON.stringify(v)); } catch (e) { mem[k] = v; } },
  };
  const subs = {};
  const emit = (k) => (subs[k] || []).forEach((f) => f());
  const sub = (k, fn) => { (subs[k] = subs[k] || []).push(fn); fn(); return () => (subs[k] = subs[k].filter((f) => f !== fn)); };
  let bc = null; try { bc = new BroadcastChannel("raffle3"); bc.onmessage = (e) => emit(e.data); } catch (e) {}
  const save = (k, v) => { store.set(k, v); emit(k); try { bc && bc.postMessage(k); } catch (e) {} };
  window.addEventListener("storage", (e) => { if (e.key && e.key.startsWith(P)) emit(e.key.slice(P.length)); });
  const rid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  // each browser = one visitor id (like Supabase anonymous sign-in)
  let visitor; try { visitor = localStorage.getItem(P + "visitor") || "v" + rid(); localStorage.setItem(P + "visitor", visitor); } catch (e) { visitor = "v" + rid(); }
  const wheels = () => store.get("wheels", {});
  const me = () => (store.get("admin", false) ? { uid: "admin", email: "admin@demo.com", isAdmin: true } : { uid: visitor, email: "", isAdmin: false });

  async function claim(wid, nums, { name, phone, status, source, note }) {
    const w = wheels()[wid]; if (!w) throw new Error("Wheel not found."); if (w.draw) throw new Error("The draw already happened.");
    const all = store.get("numbers", {}); const taken = nums.filter((n) => all[`${wid}_${n}`]);
    if (taken.length) { const err = new Error(`Sorry, ${taken.length > 1 ? "numbers " + taken.join(", ") + " were" : "number " + taken[0] + " was"} just taken by someone else. Pick another.`); err.taken = taken; throw err; }
    const id = "r" + rid(), now = Date.now(), uid = me().uid;
    nums.forEach((n) => (all[`${wid}_${n}`] = { wheelId: wid, n, name, status, reqId: id, uid, createdAt: now }));
    save("numbers", all);
    save("requests", { ...store.get("requests", {}), [id]: { wheelId: wid, nums, name, phone, status, source, note: note || "", uid, createdAt: now } });
    return id;
  }
  return {
    mode: "demo",
    onAuth: (cb) => sub("admin", () => cb(me())),
    async adminLogin(email, password) {
      if (!isAdminEmail(email)) throw new Error("This email is not an admin.");
      const pw = store.get("adminpw", null);
      if (password.length < 6) throw new Error("Password must be at least 6 characters.");
      if (pw && pw !== password) throw new Error("Wrong email or password.");
      if (!pw) store.set("adminpw", password);
      save("admin", true);
    },
    async resetPassword() { throw new Error("Not available in demo mode."); },
    async signOut() { save("admin", false); },

    onWheels: (cb) => sub("wheels", () => cb(Object.entries(wheels()).map(([id, w]) => ({ ...DEFAULT_WHEEL, ...w, id })))),
    async createWheel(data) { const id = "w" + rid(); save("wheels", { ...wheels(), [id]: { ...DEFAULT_WHEEL, ...data, draw: null, drawAt: null, createdAt: Date.now() } }); return id; },
    async saveWheel(id, data) { const all = wheels(); if (!all[id]) throw new Error("Wheel not found."); all[id] = { ...all[id], ...data }; save("wheels", all); },
    async deleteWheel(id) { await this.resetRound(id); const all = wheels(); delete all[id]; save("wheels", all); },

    onNumbers: (cb) => sub("numbers", () => cb(Object.values(store.get("numbers", {})))),
    onRequests: (cb) => sub("requests", () => cb(Object.entries(store.get("requests", {})).map(([id, r]) => ({ id, ...r })))),
    request: (wid, nums, name, phone) => claim(wid, nums, { name: clean(name, 40), phone: clean(phone, 20), status: "pending", source: "site" }),
    adminAdd: (wid, nums, name, phone, note) => claim(wid, nums, { name: clean(name, 40), phone: clean(phone, 20), status: "paid", source: "admin", note: clean(note, 80) }),
    async approve(req) {
      const all = store.get("numbers", {}); req.nums.forEach((n) => { const d = all[`${req.wheelId}_${n}`]; if (d) d.status = "paid"; }); save("numbers", all);
      const rs = store.get("requests", {}); if (rs[req.id]) rs[req.id].status = "paid"; save("requests", rs);
    },
    async reject(req) {
      const all = store.get("numbers", {}); req.nums.forEach((n) => delete all[`${req.wheelId}_${n}`]); save("numbers", all);
      const rs = store.get("requests", {}); delete rs[req.id]; save("requests", rs);
    },
    async removeNumber(wid, n, req) {
      const all = store.get("numbers", {}); delete all[`${wid}_${n}`]; save("numbers", all);
      if (req) { const rs = store.get("requests", {}); const r = rs[req.id]; if (r) { r.nums = r.nums.filter((x) => x !== n); if (!r.nums.length) delete rs[req.id]; } save("requests", rs); }
    },
    async startDraw(wid, data) { await this.saveWheel(wid, { draw: { ...data, startedAt: Date.now() } }); },
    push: false,
    async resetRound(wid) {
      const all = store.get("numbers", {}); Object.keys(all).forEach((k) => all[k].wheelId === wid && delete all[k]); save("numbers", all);
      const rs = store.get("requests", {}); Object.keys(rs).forEach((k) => rs[k].wheelId === wid && delete rs[k]); save("requests", rs);
      if (wheels()[wid]) await this.saveWheel(wid, { draw: null, drawAt: null });
    },
    async fillDemo(wid, total) {
      const names = ["Ali", "Maya", "Hassan", "Rita", "Karim", "Nour", "Omar", "Lara", "Joe", "Sara", "Rami", "Yara", "Elie", "Dana", "Fadi", "Hiba"];
      const all = store.get("numbers", {}), rs = store.get("requests", {});
      for (let n = 1; n <= total; n++) if (!all[`${wid}_${n}`]) {
        const name = names[Math.floor(Math.random() * names.length)], id = "r" + rid();
        all[`${wid}_${n}`] = { wheelId: wid, n, name, status: "paid", reqId: id, uid: "demo", createdAt: Date.now() };
        rs[id] = { wheelId: wid, nums: [n], name, phone: "", status: "paid", source: "admin", note: "demo", uid: "demo", createdAt: Date.now() };
      }
      save("numbers", all); save("requests", rs);
    },
  };
}
