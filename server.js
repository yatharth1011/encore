#!/usr/bin/env node
// Encore — local server.
// Signs in to YouTube once (OAuth refresh token kept in tokens.json next to
// this file), reads a playlist with per-video stats, and writes a sorted copy
// as a new playlist. No npm dependencies; needs Node 18+ for global fetch.
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATIC = path.join(HERE, "static");
// Up to three Google OAuth clients ("slots"), used strictly in order: slot 1
// first, slot 2 when 1's daily YouTube quota is out, slot 3 only as the final
// fallback. Each slot has its own client secret, sign-in token and quota tally.
const SLOTS = [1, 2, 3];
const fileFor = (base, n) => path.join(HERE, n === 1 ? `${base}.json` : `${base}_${n}.json`);
const PORT = Number(process.env.PORT) || 8812;
const HOST = "127.0.0.1";
const ORIGIN = `http://${HOST}:${PORT}`;
const REDIRECT_URI = `${ORIGIN}/oauth2callback`;
const SCOPE = "https://www.googleapis.com/auth/youtube";
const API = "https://www.googleapis.com/youtube/v3/";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

// ---------- small file helpers ----------

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return null;
  }
}

async function writeJson(file, data) {
  await fs.writeFile(file, JSON.stringify(data, null, 2), { mode: 0o600 });
}

let active = 1;
const slotState = Object.fromEntries(SLOTS.map((n) => [n, { tokens: null, quota: null, refreshing: null }]));

async function loadClient(n = active) {
  const raw = await readJson(fileFor("client_secret", n));
  const c = raw?.installed || raw?.web || raw;
  if (!c?.client_id || !c?.client_secret) return null;
  return { id: c.client_id, secret: c.client_secret, project: c.project_id };
}

async function slotTokens(n) {
  return (slotState[n].tokens ??= await readJson(fileFor("tokens", n)));
}

// ---------- OAuth ----------

const pendingStates = new Map(); // state -> slot
let channelCache = null;

class ApiError extends Error {
  constructor(message, status = 500, reason = "error") {
    super(message);
    this.status = status;
    this.reason = reason;
  }
}

async function tokenRequest(params) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(data.error_description || data.error || "token request failed", res.status, data.error || "token");
  }
  return data;
}

async function saveTokens(n, data) {
  const prev = await slotTokens(n);
  slotState[n].tokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token || prev?.refresh_token,
    expiry_date: Date.now() + (data.expires_in || 3600) * 1000,
  };
  await writeJson(fileFor("tokens", n), slotState[n].tokens);
}

async function forgetTokens(n) {
  slotState[n].tokens = null;
  channelCache = null;
  await fs.rm(fileFor("tokens", n), { force: true });
}

async function accessToken(force = false, n = active) {
  const st = slotState[n];
  const tokens = await slotTokens(n);
  if (!tokens?.refresh_token) throw new ApiError("Not signed in", 401, "auth");
  if (!force && tokens.access_token && tokens.expiry_date - 60_000 > Date.now()) {
    return tokens.access_token;
  }
  st.refreshing ??= (async () => {
    const client = await loadClient(n);
    if (!client) throw new ApiError("Google client not configured", 401, "setup");
    try {
      await saveTokens(
        n,
        await tokenRequest({
          client_id: client.id,
          client_secret: client.secret,
          refresh_token: tokens.refresh_token,
          grant_type: "refresh_token",
        })
      );
    } catch (err) {
      if (err.reason === "invalid_grant") {
        await forgetTokens(n);
        throw new ApiError("Google access expired or was revoked — sign in again", 401, "auth");
      }
      throw err;
    }
  })().finally(() => (st.refreshing = null));
  await st.refreshing;
  return st.tokens.access_token;
}

async function anySlotLeft(except) {
  for (const n of SLOTS) {
    if (n !== except && (await slotReady(n)) && (await quotaState(n)).used < QUOTA_LIMIT) return true;
  }
  return false;
}

async function slotReady(n) {
  return Boolean((await loadClient(n)) && (await slotTokens(n))?.refresh_token);
}

// ---------- YouTube API ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- daily quota ledger ----------
// YouTube gives 10,000 units per Pacific-time day: reads cost 1, writes 50.
// We keep our own tally so the UI can say where a run will stop.

const QUOTA_LIMIT = 10000;
const pacificDay = (d = new Date()) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(d);

async function quotaState(n = active) {
  const st = slotState[n];
  st.quota ??= (await readJson(fileFor("quota", n))) || { day: pacificDay(), used: 0 };
  if (st.quota.day !== pacificDay()) st.quota = { day: pacificDay(), used: 0 };
  return st.quota;
}

async function spend(units, n = active) {
  const q = await quotaState(n);
  q.used = Math.min(QUOTA_LIMIT, q.used + units);
  await writeJson(fileFor("quota", n), q);
}

function nextQuotaReset() {
  const now = new Date();
  const pt = new Date(now.toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
  const midnight = new Date(pt);
  midnight.setHours(24, 0, 0, 0);
  return now.getTime() + (midnight - pt);
}

// Use the earliest signed-in slot that can afford the call. If none can,
// stay put and let YouTube answer.
async function pickSlot(cost) {
  for (const n of SLOTS) {
    if (!(await slotReady(n))) continue;
    if (QUOTA_LIMIT - (await quotaState(n)).used >= cost) {
      if (n !== active) console.log(`${new Date().toISOString()} switching to Google client ${n}`);
      active = n;
      return;
    }
  }
}

// Totals count only slots that are signed in, so the UI's "how many videos
// fit today" reflects everything Encore can actually use.
async function quotaInfo() {
  let used = 0, limit = 0;
  const slots = [];
  for (const n of SLOTS) {
    const client = await loadClient(n);
    const ready = await slotReady(n);
    const q = await quotaState(n);
    if (ready) { used += q.used; limit += QUOTA_LIMIT; }
    slots.push({ slot: n, configured: Boolean(client), ready, active: n === active, project: client?.project || null, left: QUOTA_LIMIT - q.used });
  }
  return { used, limit, left: limit - used, resetsAt: nextQuotaReset(), slots };
}

async function yt(method, endpoint, { query = {}, body } = {}) {
  const url = new URL(endpoint, API);
  for (const [k, v] of Object.entries(query)) if (v != null) url.searchParams.set(k, v);
  for (let attempt = 0; ; attempt++) {
    const cost = method === "GET" ? 1 : 50;
    await pickSlot(cost);
    const slot = active;
    await spend(cost, slot);
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${await accessToken(attempt > 0 && attempt < 2, slot)}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return null;
    const data = await res.json().catch(() => null);
    if (res.ok) return data;

    const reason = data?.error?.errors?.[0]?.reason || "error";
    const message = data?.error?.message?.replace(/<[^>]+>/g, "") || res.statusText;
    if (res.status === 401 && attempt === 0) continue; // refresh token once
    // YouTube sometimes aborts rapid playlist writes with 409/5xx; back off and retry.
    if ((res.status === 409 || res.status >= 500) && attempt < 4) {
      await sleep(800 * 2 ** attempt);
      continue;
    }
    if (reason === "quotaExceeded" || reason === "dailyLimitExceeded") {
      await spend(QUOTA_LIMIT, slot);
      if (await anySlotLeft(slot)) continue; // retry on the next client
      throw new ApiError("YouTube daily API quota used up — it resets at midnight Pacific time.", 429, "quotaExceeded");
    }
    throw new ApiError(message, res.status, reason);
  }
}

async function paged(endpoint, query) {
  const items = [];
  let pageToken;
  do {
    const data = await yt("GET", endpoint, { query: { ...query, maxResults: 50, pageToken } });
    items.push(...(data.items || []));
    pageToken = data.nextPageToken;
  } while (pageToken);
  return items;
}

function isoDurationSeconds(iso) {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso || "");
  if (!m) return null;
  const [, d = 0, h = 0, min = 0, s = 0] = m.map((x) => Number(x) || 0);
  return d * 86400 + h * 3600 + min * 60 + s;
}

const num = (v) => (v == null ? null : Number(v));

async function channel() {
  if (channelCache) return channelCache;
  const data = await yt("GET", "channels", { query: { part: "snippet", mine: true } });
  const ch = data.items?.[0];
  channelCache = ch
    ? { id: ch.id, title: ch.snippet.title, thumb: ch.snippet.thumbnails?.default?.url }
    : { id: null, title: "YouTube account", thumb: null };
  return channelCache;
}

async function myPlaylists() {
  const items = await paged("playlists", { part: "snippet,contentDetails", mine: true });
  return items.map((p) => ({
    id: p.id,
    title: p.snippet.title,
    count: p.contentDetails.itemCount,
    thumb: p.snippet.thumbnails?.medium?.url || p.snippet.thumbnails?.default?.url,
  }));
}

async function playlistInfo(id) {
  const data = await yt("GET", "playlists", { query: { part: "snippet", id } });
  const p = data.items?.[0];
  if (!p) throw new ApiError("Playlist not found (it may be private to another account).", 404, "notFound");
  return { id, title: p.snippet.title, owner: p.snippet.channelTitle };
}

async function playlistVideos(id) {
  const [info, items] = await Promise.all([
    playlistInfo(id),
    paged("playlistItems", { part: "snippet,contentDetails", playlistId: id }),
  ]);

  const ids = [...new Set(items.map((it) => it.contentDetails.videoId))];
  const details = new Map();
  for (let i = 0; i < ids.length; i += 50) {
    const data = await yt("GET", "videos", {
      query: { part: "snippet,statistics,contentDetails", id: ids.slice(i, i + 50).join(",") },
    });
    for (const v of data.items || []) details.set(v.id, v);
  }

  const videos = items.map((it, index) => {
    const vid = it.contentDetails.videoId;
    const v = details.get(vid);
    const st = v?.statistics || {};
    return {
      videoId: vid,
      position: index + 1,
      available: Boolean(v),
      title: v?.snippet.title || it.snippet.title,
      channel: v?.snippet.channelTitle || it.snippet.videoOwnerChannelTitle || "",
      thumb: v?.snippet.thumbnails?.medium?.url || v?.snippet.thumbnails?.default?.url || null,
      publishedAt: v?.snippet.publishedAt || it.contentDetails.videoPublishedAt || null,
      addedAt: it.snippet.publishedAt || null,
      views: num(st.viewCount),
      likes: num(st.likeCount),
      comments: num(st.commentCount),
      duration: isoDurationSeconds(v?.contentDetails?.duration),
    };
  });
  return { playlist: info, videos };
}

// A playlist build runs in the background on the server, so closing or
// reloading the window never interrupts it; the UI polls /api/job.
let job = null;

function publicJob() {
  if (!job) return null;
  const tried = job.added + job.skipped;
  return { ...job, msPerVideo: tried ? Math.round(job.insertMs / tried) : null };
}

async function startJob(req) {
  const { title, description = "", privacy = "private", videoIds, targetId } = await readBody(req);
  if (!Array.isArray(videoIds) || !videoIds.length) throw new ApiError("No videos to add", 400, "bad");
  if (!targetId && !title?.trim()) throw new ApiError("Playlist needs a title", 400, "bad");
  if (job?.status === "running") throw new ApiError("A playlist is already being built — let it finish first.", 409, "busy");

  job = {
    status: "running",
    title: title?.trim() || null,
    playlistId: targetId || null,
    url: targetId ? `https://www.youtube.com/playlist?list=${targetId}` : null,
    total: videoIds.length,
    done: 0,
    added: 0,
    skipped: 0,
    insertMs: 0,
    startedAt: Date.now(),
    finishedAt: null,
    message: null,
  };
  runJob({ title, description, privacy, videoIds, targetId });
  return { job: publicJob(), quota: await quotaInfo() };
}

async function runJob({ title, description, privacy, videoIds, targetId }) {
  try {
    const existing = new Set();
    if (targetId) {
      const items = await paged("playlistItems", { part: "contentDetails", playlistId: targetId });
      for (const it of items) existing.add(it.contentDetails.videoId);
    } else {
      const pl = await yt("POST", "playlists", {
        query: { part: "snippet,status" },
        body: {
          snippet: { title: title.trim().slice(0, 150), description: description.slice(0, 5000) },
          status: { privacyStatus: ["public", "unlisted", "private"].includes(privacy) ? privacy : "private" },
        },
      });
      job.playlistId = pl.id;
      job.url = `https://www.youtube.com/playlist?list=${pl.id}`;
    }

    for (const videoId of videoIds) {
      if (!existing.has(videoId)) {
        const t0 = Date.now();
        try {
          await yt("POST", "playlistItems", {
            query: { part: "snippet" },
            body: { snippet: { playlistId: job.playlistId, resourceId: { kind: "youtube#video", videoId } } },
          });
          job.added++;
        } catch (err) {
          if (err.reason === "quotaExceeded" || err.status === 401) throw err;
          job.skipped++;
        }
        job.insertMs += Date.now() - t0;
      }
      job.done++;
    }
    job.status = "done";
  } catch (err) {
    job.status = err.reason === "quotaExceeded" ? "quota" : "error";
    job.message = err.message;
  }
  job.finishedAt = Date.now();
}

// ---------- HTTP plumbing ----------

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 5_000_000) throw new ApiError("Request too large", 413, "bad");
    chunks.push(c);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new ApiError("Invalid JSON", 400, "bad");
  }
}

function json(res, status, data) {
  res.writeHead(status, { "Content-Type": MIME[".json"], "Cache-Control": "no-store" });
  res.end(JSON.stringify(data));
}

function redirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}

async function serveStatic(res, pathname) {
  const rel = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
  const file = path.join(STATIC, rel);
  if (!file.startsWith(STATIC + path.sep)) return json(res, 403, { error: "forbidden" });
  try {
    const data = await fs.readFile(file);
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-cache" });
    res.end(data);
  } catch {
    json(res, 404, { error: "not found" });
  }
}

const routes = {
  "GET /api/status": async () => {
    const slots = [];
    for (const n of SLOTS) slots.push({ slot: n, configured: Boolean(await loadClient(n)), authed: await slotReady(n) });
    if (!slots.some((x) => x.configured)) return { configured: false, authed: false, redirectUri: REDIRECT_URI, slots };
    // Use the first client that is still signed in (and can afford a call).
    for (const n of SLOTS) {
      if (!slots[n - 1].authed) continue;
      try {
        await accessToken(false, n);
        if (n !== active && (await quotaState(active)).used >= QUOTA_LIMIT) active = n;
        // Name/avatar are cosmetic: don't fail (or sign the user out) if quota is empty.
        const who = await channel().catch(() => ({ id: null, title: "YouTube account", thumb: null }));
        return { configured: true, authed: true, channel: who, slots };
      } catch (err) {
        if (err.status !== 401) throw err;
        slots[n - 1].authed = false;
      }
    }
    return { configured: true, authed: false, slots };
  },

  "POST /api/setup": async (req, res, url) => {
    const n = Number(url.searchParams.get("slot")) || 1;
    if (!SLOTS.includes(n)) throw new ApiError("Unknown client slot", 400, "bad");
    const body = await readBody(req);
    const c = body?.installed || body?.web || body;
    if (!c?.client_id || !c?.client_secret) {
      throw new ApiError("That JSON has no client_id / client_secret. Download the OAuth client JSON from Google Cloud.", 400, "bad");
    }
    await writeJson(fileFor("client_secret", n), body);
    await forgetTokens(n);
    return { ok: true };
  },

  "POST /api/logout": async () => {
    for (const n of SLOTS) {
      const t = await slotTokens(n);
      if (t?.refresh_token) {
        await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(t.refresh_token)}`, { method: "POST" }).catch(() => {});
      }
      await forgetTokens(n);
    }
    return { ok: true };
  },

  "GET /api/playlists": async () => ({ playlists: await myPlaylists() }),

  "GET /api/job": async () => ({ job: publicJob(), quota: await quotaInfo() }),

  "POST /api/create": async (req) => startJob(req),

  "GET /api/videos": async (req, res, url) => {
    const id = url.searchParams.get("id");
    if (!id || !/^[\w-]{10,64}$/.test(id)) throw new ApiError("Invalid playlist id", 400, "bad");
    return playlistVideos(id);
  },
};

async function handle(req, res) {
  const url = new URL(req.url, ORIGIN);
  const { pathname } = url;

  if (req.method === "GET" && pathname === "/auth") {
    const slot = Number(url.searchParams.get("slot")) || 1;
    const client = SLOTS.includes(slot) && (await loadClient(slot));
    if (!client) return redirect(res, "/");
    const state = crypto.randomBytes(16).toString("hex");
    pendingStates.set(state, slot);
    const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    auth.search = new URLSearchParams({
      client_id: client.id,
      redirect_uri: REDIRECT_URI,
      response_type: "code",
      scope: SCOPE,
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
      state,
    });
    return redirect(res, auth.toString());
  }

  if (req.method === "GET" && pathname === "/oauth2callback") {
    const state = url.searchParams.get("state");
    const code = url.searchParams.get("code");
    const slot = pendingStates.get(state);
    if (!state || !pendingStates.delete(state)) return redirect(res, "/?error=state");
    if (!code) return redirect(res, `/?error=${encodeURIComponent(url.searchParams.get("error") || "denied")}`);
    const client = await loadClient(slot);
    const data = await tokenRequest({
      code,
      client_id: client.id,
      client_secret: client.secret,
      redirect_uri: REDIRECT_URI,
      grant_type: "authorization_code",
    });
    channelCache = null;
    await saveTokens(slot, data);
    return redirect(res, "/");
  }

  if (pathname.startsWith("/api/")) {
    const route = routes[`${req.method} ${pathname}`];
    if (!route) return json(res, 404, { error: "not found" });
    return json(res, 200, await route(req, res, url));
  }

  if (req.method === "GET") return serveStatic(res, pathname);
  json(res, 405, { error: "method not allowed" });
}

http
  .createServer(async (req, res) => {
    // Only this machine's pages may call the API.
    const origin = req.headers.origin;
    if (origin && origin !== ORIGIN && req.method !== "GET") {
      return json(res, 403, { error: "cross-origin request refused" });
    }
    try {
      await handle(req, res);
    } catch (err) {
      console.error(new Date().toISOString(), req.method, req.url, err.message);
      if (res.headersSent) return res.end();
      json(res, err.status || 500, { error: err.message, reason: err.reason || "error" });
    }
  })
  .on("error", (err) => {
    if (err.code !== "EADDRINUSE") throw err;
    console.log(`${new Date().toISOString()} Encore is already running on ${ORIGIN}`);
    process.exit(0);
  })
  .listen(PORT, HOST, () => console.log(`${new Date().toISOString()} Encore on ${ORIGIN}`));
