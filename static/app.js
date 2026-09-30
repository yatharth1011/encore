"use strict";

const $ = (id) => document.getElementById(id);

const SORTS = [
  { key: "views", label: "Views", dir: "desc", get: (v) => v.views },
  { key: "likes", label: "Likes", dir: "desc", get: (v) => v.likes },
  { key: "comments", label: "Comments", dir: "desc", get: (v) => v.comments },
  { key: "ratio", label: "Like rate", dir: "desc", get: (v) => (v.views && v.likes != null ? v.likes / v.views : null) },
  { key: "duration", label: "Length", dir: "desc", get: (v) => v.duration },
  { key: "published", label: "Upload date", dir: "desc", get: (v) => (v.publishedAt ? Date.parse(v.publishedAt) : null) },
  { key: "title", label: "Title", dir: "asc", get: (v) => v.title.toLowerCase() },
  { key: "original", label: "Original", dir: "asc", get: (v) => v.position },
];
const SORT_BY_KEY = Object.fromEntries(SORTS.map((s) => [s.key, s]));
const DIR_LABEL = { views: "views", likes: "likes", comments: "comments", ratio: "like rate", duration: "length", published: "upload date", title: "title", original: "original order" };
const PENDING_KEY = "encore.pending";
const QUOTA_DAILY = 10000;

const state = {
  playlist: null,
  videos: [],
  sort: "views",
  dir: "desc",
  titleTouched: false,
  busy: false,
};

// ---------- utils ----------

const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

const compactFmt = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const fullFmt = new Intl.NumberFormat("en");
const compact = (n) => (n == null ? '<span class="na">—</span>' : `<span title="${fullFmt.format(n)}">${compactFmt.format(n)}</span>`);

function duration(sec) {
  if (sec == null) return '<span class="na">—</span>';
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

function uploaded(iso) {
  if (!iso) return '<span class="na">—</span>';
  const d = new Date(iso);
  return `<span title="${d.toLocaleDateString()}">${d.getFullYear()}</span>`;
}

function ratio(v) {
  const r = SORT_BY_KEY.ratio.get(v);
  return r == null ? '<span class="na">—</span>' : `${(r * 100).toFixed(r < 0.01 ? 2 : 1)}%`;
}

let toastTimer;
function toast(msg, bad = false) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.toggle("bad", bad);
  t.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 4500);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: opts.body ? { "Content-Type": "application/json" } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    boot();
    throw new Error(data.error || "Signed out");
  }
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function show(view) {
  for (const id of ["viewSetup", "viewSignin", "viewMain"]) $(id).classList.toggle("hidden", id !== view);
  $("dock").classList.toggle("hidden", view !== "viewMain" || !state.playlist);
}

function playlistIdFrom(text) {
  const t = text.trim();
  if (!t) return null;
  try {
    const u = new URL(t);
    return u.searchParams.get("list");
  } catch {
    return /^[\w-]{10,64}$/.test(t) ? t : null;
  }
}

// ---------- boot / auth ----------

async function boot() {
  const params = new URLSearchParams(location.search);
  if (params.has("error")) {
    history.replaceState(null, "", "/");
    const e = params.get("error");
    $("signinError").textContent =
      e === "state"
        ? "Sign-in link expired — try again."
        : e === "access_denied"
          ? "Google blocked the sign-in (access_denied). In Google Cloud → Google Auth Platform → Audience, either click “Publish app” or add your Google account under “Test users”, then try again."
          : `Google said: ${e}`;
    $("signinError").classList.remove("hidden");
  }

  let status;
  try {
    status = await (await fetch("/api/status")).json();
  } catch {
    // Server not up yet (e.g. just restarted) — keep retrying and pick up when it's back.
    toast("Waiting for the Encore server…", true);
    setTimeout(boot, 2000);
    return;
  }
  $("toast").classList.add("hidden");

  $("account").classList.toggle("hidden", !status.authed);
  // Offer sign-in for the next backup client that's set up but not yet connected.
  const backup = status.slots?.find((x) => x.slot > 1 && x.configured && !x.authed);
  $("backupLink").classList.toggle("hidden", !(status.authed && backup));
  if (backup) {
    $("backupLink").href = `/auth?slot=${backup.slot}`;
    $("backupLink").textContent = `Connect backup client ${backup.slot}`;
  }
  if (!status.configured) {
    $("redirectUri").textContent = status.redirectUri;
    return show("viewSetup");
  }
  if (!status.authed) return show("viewSignin");

  $("accountName").textContent = status.channel?.title || "";
  if (status.channel?.thumb) $("accountThumb").src = status.channel.thumb;
  show("viewMain");
  loadPlaylists();
  // A build (running or paused for quota) is shown even before any playlist loads.
  if (store.get(PENDING_KEY)) $("dock").classList.remove("hidden");
  watchJob();
}

$("secretFile").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  if (f) $("secretText").value = await f.text();
});

$("saveSecretBtn").addEventListener("click", async () => {
  const err = $("setupError");
  err.classList.add("hidden");
  let parsed;
  try {
    parsed = JSON.parse($("secretText").value);
  } catch {
    err.textContent = "That isn't valid JSON.";
    return err.classList.remove("hidden");
  }
  try {
    await api("/api/setup", { method: "POST", body: parsed });
    $("secretText").value = "";
    boot();
  } catch (e) {
    err.textContent = e.message;
    err.classList.remove("hidden");
  }
});

$("resetClientBtn").addEventListener("click", () => show("viewSetup"));

$("logoutBtn").addEventListener("click", async () => {
  if (!confirm("Sign out and revoke Encore's access to your YouTube account?")) return;
  await fetch("/api/logout", { method: "POST" });
  state.playlist = null;
  boot();
});

// ---------- loading ----------

async function loadPlaylists() {
  const sel = $("playlistSelect");
  try {
    const { playlists } = await api("/api/playlists");
    playlists.sort((a, b) => a.title.localeCompare(b.title));
    sel.innerHTML =
      '<option value="">Choose a playlist…</option>' +
      playlists.map((p) => `<option value="${esc(p.id)}">${esc(p.title)} · ${p.count}</option>`).join("");
    const last = store.get("encore.last");
    const preferred = playlists.find((p) => p.id === last) || playlists.find((p) => p.title === "ins_grand");
    if (preferred) {
      sel.value = preferred.id;
      if (!state.playlist) loadVideos(preferred.id);
    }
  } catch (e) {
    sel.innerHTML = '<option value="">Couldn\'t load playlists</option>';
    toast(e.message, true);
  }
}

$("playlistSelect").addEventListener("change", (e) => {
  if (e.target.value) {
    $("playlistUrl").value = "";
    loadVideos(e.target.value);
  }
});

$("loadBtn").addEventListener("click", () => {
  const id = playlistIdFrom($("playlistUrl").value) || $("playlistSelect").value;
  if (!id) return toast("Pick a playlist or paste a playlist link.", true);
  loadVideos(id);
});
$("playlistUrl").addEventListener("keydown", (e) => e.key === "Enter" && $("loadBtn").click());

async function loadVideos(id) {
  const btn = $("loadBtn");
  btn.disabled = true;
  btn.textContent = "Loading…";
  try {
    const data = await api(`/api/videos?id=${encodeURIComponent(id)}`);
    state.playlist = data.playlist;
    state.videos = data.videos;
    state.titleTouched = false;
    store.set("encore.last", id);
    $("empty").classList.add("hidden");
    $("loaded").classList.remove("hidden");
    $("dock").classList.remove("hidden");
    $("progress").classList.add("hidden");
    render();
    watchJob();
  } catch (e) {
    toast(e.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = "Load";
  }
}

// ---------- sorting & render ----------

function sorted() {
  const { get } = SORT_BY_KEY[state.sort];
  const sign = state.dir === "asc" ? 1 : -1;
  const live = state.videos.filter((v) => v.available);
  const gone = state.videos.filter((v) => !v.available);
  live.sort((a, b) => {
    const x = get(a), y = get(b);
    if (x == null && y == null) return a.position - b.position;
    if (x == null) return 1; // missing stats always sink
    if (y == null) return -1;
    if (x < y) return -sign;
    if (x > y) return sign;
    return a.position - b.position;
  });
  return { live, gone };
}

function outputIds() {
  const { live } = sorted();
  const n = parseInt($("topN").value, 10);
  const seen = new Set();
  const ids = [];
  for (const v of live) if (!seen.has(v.videoId)) seen.add(v.videoId), ids.push(v.videoId);
  return n > 0 ? ids.slice(0, n) : ids;
}

function defaultTitle() {
  const arrow = state.dir === "desc" ? "↓" : "↑";
  const n = parseInt($("topN").value, 10);
  const top = n > 0 ? `top ${n} ` : "";
  return `${state.playlist.title} · ${top}by ${DIR_LABEL[state.sort]} ${arrow}`.slice(0, 150);
}

function renderChips() {
  $("sortChips").innerHTML = SORTS.map(
    (s) => `<button class="chip" role="radio" aria-checked="${s.key === state.sort}" data-key="${s.key}">${s.label}</button>`
  ).join("");
  $("dirBtn").textContent = state.dir === "desc" ? "↓ High to low" : "↑ Low to high";
  if (state.sort === "title") $("dirBtn").textContent = state.dir === "asc" ? "↑ A → Z" : "↓ Z → A";
  if (state.sort === "published") $("dirBtn").textContent = state.dir === "desc" ? "↓ Newest first" : "↑ Oldest first";
  if (state.sort === "original") $("dirBtn").textContent = state.dir === "asc" ? "↑ As saved" : "↓ Reversed";
  document.querySelectorAll(".grid th[data-sort]").forEach((th) => {
    th.classList.toggle("active", th.dataset.sort === state.sort);
    th.classList.toggle("asc", state.dir === "asc");
  });
}

function row(v, rank, cls = "") {
  const s = state.sort;
  const moved = rank && state.sort !== "original" ? v.position - rank : 0;
  const move = moved ? `<span class="moved ${moved > 0 ? "up" : "down"}" title="was #${v.position}">${moved > 0 ? "▲" : "▼"}${Math.abs(moved)}</span>` : "";
  const td = (key, html) => `<td class="c-num${s === key ? " sorted" : ""}">${html}</td>`;
  return `<tr class="${cls}">
    <td class="c-rank">${rank || "✕"}</td>
    <td><div class="video">
      ${v.thumb ? `<img class="thumb" src="${esc(v.thumb)}" loading="lazy" alt="" referrerpolicy="no-referrer">` : '<div class="thumb"></div>'}
      <div class="vmeta">
        <a class="vtitle" href="https://www.youtube.com/watch?v=${esc(v.videoId)}" target="_blank" rel="noopener">${esc(v.title)}</a>
        <div class="vchan">${esc(v.channel || (v.available ? "" : "Unavailable — will be left out"))}${move}</div>
      </div>
    </div></td>
    ${td("views", compact(v.views))}
    ${td("likes", compact(v.likes))}
    ${td("comments", compact(v.comments))}
    ${td("ratio", ratio(v))}
    ${td("duration", duration(v.duration))}
    ${td("published", uploaded(v.publishedAt))}
  </tr>`;
}

function render() {
  renderChips();
  const { live, gone } = sorted();
  const n = parseInt($("topN").value, 10);
  const cut = n > 0 && n < live.length ? n : null;

  let html = "";
  live.forEach((v, i) => {
    if (cut !== null && i === cut) html += `<tr class="cutline"><td colspan="8">Only the ${cut} above go into the new playlist</td></tr>`;
    html += row(v, i + 1, cut !== null && i >= cut ? "cut" : "");
  });
  for (const v of gone) html += row(v, 0, "gone");
  $("rows").innerHTML = html;

  $("plTitle").textContent = state.playlist.title;
  const totalViews = live.reduce((a, v) => a + (v.views || 0), 0);
  const totalSec = live.reduce((a, v) => a + (v.duration || 0), 0);
  const stats = [
    [live.length, "videos"],
    [compactFmt.format(totalViews), "total views"],
    [`${Math.floor(totalSec / 3600)}h ${Math.floor((totalSec % 3600) / 60)}m`, "runtime"],
  ];
  if (gone.length) stats.push([gone.length, "unavailable"]);
  $("stats").innerHTML = stats.map(([b, s]) => `<div class="stat"><b>${esc(b)}</b><span>${s}</span></div>`).join("");

  if (!state.titleTouched) $("newTitle").value = defaultTitle();
  updateQuota();
}

function updateQuota() {
  const count = outputIds().length;
  const cost = 50 + count * 50;
  const days = Math.ceil(cost / (QUOTA_DAILY - 200));
  $("quotaNote").textContent =
    `${count} video${count === 1 ? "" : "s"} → about ${fullFmt.format(cost)} of YouTube's ${fullFmt.format(QUOTA_DAILY)} daily API units.` +
    (days > 1 ? ` That's more than one day's quota — Encore will stop when it runs out and you can resume tomorrow.` : "");
  $("createBtn").disabled = state.busy || (!count && !$("createBtn").dataset.resume);
  $("quotaNote").classList.toggle("hidden", !state.playlist);
}

$("sortChips").addEventListener("click", (e) => {
  const key = e.target.closest(".chip")?.dataset.key;
  if (!key) return;
  if (key === state.sort) state.dir = state.dir === "asc" ? "desc" : "asc";
  else (state.sort = key), (state.dir = SORT_BY_KEY[key].dir);
  render();
});

document.querySelector(".grid thead").addEventListener("click", (e) => {
  const key = e.target.closest("th[data-sort]")?.dataset.sort;
  if (!key) return;
  if (key === state.sort) state.dir = state.dir === "asc" ? "desc" : "asc";
  else (state.sort = key), (state.dir = SORT_BY_KEY[key].dir);
  render();
});

$("dirBtn").addEventListener("click", () => {
  state.dir = state.dir === "asc" ? "desc" : "asc";
  render();
});

$("topN").addEventListener("input", render);
$("newTitle").addEventListener("input", () => (state.titleTouched = true));

// ---------- creating ----------
// The build runs on the server; this just starts it and polls /api/job, so a
// reload or a closed window never loses the run.

let pollTimer = null;
let deadline = null; // ms timestamp the countdown ticks toward
let lastQuota = null;

function clock(ms) {
  const t = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  const p = (n) => String(n).padStart(2, "0");
  return h ? `${p(h)}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
}

setInterval(() => {
  const el = document.getElementById("eta");
  if (el && deadline) el.textContent = clock(deadline - Date.now());
}, 250);

function setProgress(done, total, html) {
  $("progress").classList.remove("hidden");
  $("barFill").style.width = total ? `${(done / total) * 100}%` : "0";
  $("progressText").innerHTML = html;
}

// Re-aim the countdown only when the estimate drifts, so it ticks smoothly.
function aim(target) {
  if (!deadline || Math.abs(deadline - target) > 3000) deadline = target;
}

function setBusy(busy) {
  state.busy = busy;
  $("createBtn").textContent = busy ? "Building…" : "Create playlist";
  updateQuota();
}

function renderJob(job, quota) {
  const openLink = job.url ? ` <a href="${esc(job.url)}" target="_blank" rel="noopener">Open on YouTube ↗</a>` : "";
  const pending = store.get(PENDING_KEY);

  if (job.status === "running") {
    if (pending && job.playlistId && !pending.targetId) store.set(PENDING_KEY, { ...pending, targetId: job.playlistId });
    const remaining = job.total - job.done;
    const per = job.msPerVideo || 1000;
    const fitsToday = Math.floor(quota.left / 50);
    const today = Math.min(remaining, fitsToday);
    aim(Date.now() + today * per);
    const tail =
      today < remaining
        ? `left until today's quota runs out, near ${job.done + today} / ${job.total}. The rest resumes tomorrow.`
        : "left";
    const html = job.playlistId
      ? `Adding videos… ${job.done} / ${job.total} · <b id="eta" class="eta">${clock(deadline - Date.now())}</b> ${tail}${openLink}`
      : "Creating the playlist…";
    return setProgress(job.done, job.total, html);
  }

  if (job.status === "done") {
    store.del(PENDING_KEY);
    deadline = null;
    const note = job.skipped ? ` ${job.skipped} couldn't be added (likely removed or region-blocked).` : "";
    return setProgress(1, 1, `Done — ${job.added} added.${note}${openLink}`);
  }

  if (job.status === "quota") {
    deadline = quota.resetsAt;
    return setProgress(
      job.done,
      job.total,
      `Paused at ${job.done} / ${job.total}: today's YouTube quota is used up. Quota resets in <b id="eta" class="eta">${clock(deadline - Date.now())}</b>, then hit <b>Resume</b>.${openLink}`
    );
  }

  deadline = null;
  setProgress(job.done, job.total, `${esc(job.message || "Something went wrong.")} Added ${job.done} of ${job.total}.${openLink}`);
}

async function watchJob() {
  clearTimeout(pollTimer);
  let data;
  try {
    data = await api("/api/job");
  } catch {
    pollTimer = setTimeout(watchJob, 2000);
    return;
  }
  const { job, quota } = data;
  lastQuota = quota;
  if (!job) {
    setBusy(false);
    return offerResume();
  }
  renderJob(job, quota);
  if (job.status === "running") {
    setBusy(true);
    pollTimer = setTimeout(watchJob, 1000);
  } else {
    if (state.busy) toast(job.status === "done" ? "Playlist created." : job.message || "Stopped.", job.status !== "done");
    setBusy(false);
    offerResume();
  }
}

async function runCreate(req) {
  setBusy(true);
  deadline = null;
  setProgress(0, req.videoIds.length, "Talking to YouTube…");
  try {
    store.set(PENDING_KEY, req);
    await api("/api/create", { method: "POST", body: req });
    watchJob();
  } catch (e) {
    if (!req.targetId) store.del(PENDING_KEY);
    setProgress(0, 1, esc(e.message));
    toast(e.message, true);
    setBusy(false);
    offerResume();
  }
}

$("createBtn").addEventListener("click", () => {
  if ($("createBtn").dataset.resume) {
    const job = store.get(PENDING_KEY);
    if (job) return runCreate(job);
  }
  const title = $("newTitle").value.trim() || defaultTitle();
  runCreate({
    title,
    description: `Sorted by ${DIR_LABEL[state.sort]} (${state.dir === "desc" ? "high to low" : "low to high"}) from “${state.playlist.title}” with Encore.`,
    privacy: $("privacy").value,
    videoIds: outputIds(),
  });
});

function offerResume() {
  const job = store.get(PENDING_KEY);
  const btn = $("createBtn");
  if (job?.targetId && !state.busy) {
    btn.dataset.resume = "1";
    btn.disabled = false;
    btn.textContent = `Resume “${job.title.slice(0, 28)}${job.title.length > 28 ? "…" : ""}”`;
    if ($("progress").classList.contains("hidden")) {
      const wait = lastQuota && lastQuota.left < 50 ? lastQuota.resetsAt : null;
      deadline = wait;
      setProgress(
        0,
        1,
        (wait ? `An earlier playlist is paused until the quota resets in <b id="eta" class="eta">${clock(wait - Date.now())}</b>. ` : "An earlier playlist didn't finish. ") +
          `<b>Resume</b> adds the rest, or <a href="#" id="discardResume">start fresh</a>.`
      );
      $("discardResume").addEventListener("click", (e) => {
        e.preventDefault();
        store.del(PENDING_KEY);
        delete btn.dataset.resume;
        btn.textContent = "Create playlist";
        deadline = null;
        $("progress").classList.add("hidden");
      });
    }
  } else {
    delete btn.dataset.resume;
  }
}

// ---------- go ----------

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
boot();
