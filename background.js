// TV Time Quick Tracker - Background SW v4
const API = "https://api2.tozelabs.com/v2";

function fetchT(url, opts = {}, ms = 15000) {
  return Promise.race([
    fetch(url, opts),
    new Promise((_, r) => setTimeout(() => r(new Error("TIMEOUT")), ms)),
  ]);
}

function basicH(u, p) {
  return "Basic " + btoa(unescape(encodeURIComponent(`${u}:${p}`)));
}

async function getAuth() {
  const d = await chrome.storage.local.get(["auth", "uid", "bearer"]);
  return d.auth && d.uid ? { h: d.auth, uid: d.uid, bearer: d.bearer } : null;
}

async function req(path, opts = {}) {
  const a = await getAuth();
  if (!a) throw new Error("NOT_LOGGED_IN");
  const url = path.startsWith("http") ? path : `${API}${path}`;
  console.log(`[TV] ${opts.method||"GET"} ${url.substring(0, 120)}`);
  const r = await fetchT(url, {
    ...opts,
    method: opts.method || "GET",
    headers: {
      Authorization: opts.useBearer && a.bearer ? `Bearer ${a.bearer}` : a.h,
      "User-Agent": "TVTime Wrapper",
      ...opts.headers,
    },
  }, opts.timeout || 15000);
  const txt = await r.text();
  console.log(`[TV] ${r.status} ${txt.substring(0, 250)}`);
  if (r.status === 401 || r.status === 403) {
    await chrome.storage.local.clear();
    throw new Error("AUTH_EXPIRED");
  }
  try { return JSON.parse(txt); } catch { return txt; }
}

// ========== LOGIN ==========
async function login(username, password) {
  const h = basicH(username, password);
  const r = await fetchT(`${API}/signin`, {
    method: "POST",
    headers: { Authorization: h, "User-Agent": "TVTime Wrapper" },
  }, 15000);
  const d = await r.json();
  console.log("[TV] Login:", JSON.stringify(d).substring(0, 200));
  if (d.result === "KO") throw new Error(d.message || "Login failed");
  if (!d.id) throw new Error("No user ID");
  await chrome.storage.local.set({ auth: h, uid: d.id, bearer: d.tvst_access_token || "", udata: d });
  return { success: true, userId: d.id };
}

async function checkAuth() {
  const a = await getAuth();
  return a ? { authenticated: true, userId: a.uid } : { authenticated: false };
}

async function logout() {
  await chrome.storage.local.clear();
  return { success: true };
}

// ========== MY SHOWS ==========
async function getWatchingShows() {
  const a = await getAuth();
  if (!a) throw new Error("NOT_LOGGED_IN");
  // shows.limit(-1) returns all shows (no poster/details)
  // shows.fields(...).limit(-1) returns EMPTY — API bug with field filtering
  for (const ep of [`/user/${a.uid}?fields=shows.limit(-1)`, `/user/${a.uid}`]) {
    try {
      const d = await req(ep);
      const shows = d.shows || d.series || (Array.isArray(d) ? d : null);
      if (shows?.length > 0) {
        console.log(`[TV] ✓ ${shows.length} shows`);
        return { shows };
      }
    } catch (e) {
      if (e.message === "NOT_LOGGED_IN" || e.message === "AUTH_EXPIRED") throw e;
    }
  }
  return { shows: [] };
}

// ========== UP NEXT ==========
async function getUpNext() {
  const a = await getAuth();
  if (!a) throw new Error("NOT_LOGGED_IN");
  try {
    const d = await req(`/to_watch`, { timeout: 10000 });
    if (Array.isArray(d) && d.length > 0) return { episodes: d };
    if (d.episodes?.length > 0) return d;
  } catch {}
  return { episodes: [], empty: true };
}

// ========== SHOW DETAIL ==========
async function getShowDetails(id) {
  for (const ep of [`/show/${id}`, `/series/${id}`]) {
    try {
      const d = await req(ep);
      if (d?.id && d.result !== "KO") return d;
    } catch (e) {
      if (e.message === "NOT_LOGGED_IN" || e.message === "AUTH_EXPIRED") throw e;
    }
  }
  return { error: "not_found" };
}

async function getShowSeasons(id) {
  for (const ep of [`/show/${id}/seasons`, `/show/${id}`, `/series/${id}/seasons`]) {
    try {
      const d = await req(ep);
      const seasons = d.seasons || (Array.isArray(d) ? d : null);
      if (seasons?.length > 0) return { seasons };
      if (d.season_count > 0) {
        const gen = [];
        for (let i = 1; i <= d.season_count; i++) gen.push({ number: i });
        return { seasons: gen };
      }
    } catch (e) {
      if (e.message === "NOT_LOGGED_IN" || e.message === "AUTH_EXPIRED") throw e;
    }
  }
  return { seasons: [] };
}

async function getSeasonEpisodes(showId, seasonNum) {
  for (const ep of [
    `/show/${showId}/season/${seasonNum}/episodes`,
    `/series/${showId}/season/${seasonNum}/episodes`,
  ]) {
    try {
      const d = await req(ep);
      const episodes = d.episodes || (Array.isArray(d) ? d : null);
      if (episodes?.length > 0) return { episodes };
    } catch (e) {
      if (e.message === "NOT_LOGGED_IN" || e.message === "AUTH_EXPIRED") throw e;
    }
  }
  return { episodes: [] };
}

// ========== EPISODE ACTIONS ==========
async function markWatched(episodeId) {
  for (const [ep, method] of [
    [`/episodes/${episodeId}/watched`, "PUT"],
    [`/episodes/${episodeId}/watched`, "POST"],
  ]) {
    try {
      const d = await req(ep, { method });
      if (d && d.result !== "KO") return d;
    } catch (e) {
      if (e.message === "NOT_LOGGED_IN" || e.message === "AUTH_EXPIRED") throw e;
    }
  }
  throw new Error("Could not mark watched");
}

async function markUnwatched(episodeId) {
  return req(`/episodes/${episodeId}/watched`, { method: "DELETE" });
}

// ========== SEARCH ==========
async function searchShows(query) {
  const q = encodeURIComponent(query);

  // 1. msearch
  try {
    const r = await fetchT(`https://msearch.tvtime.com/v1/search?q=${q}&limit=15`,
      { headers: { "User-Agent": "TVTime Wrapper" } }, 8000);
    if (r.ok) {
      const d = await r.json();
      const arr = Array.isArray(d) ? d : d.results || d.series || [];
      if (arr.length > 0) return { results: arr };
    }
  } catch {}

  // 2. API search endpoints
  for (const ep of [`/show/search?q=${q}`, `/search?q=${q}`]) {
    try {
      const d = await req(ep);
      if (d && d.code !== 404 && d.result !== "KO") {
        const arr = d.results || d.series || d.shows || (Array.isArray(d) ? d : []);
        if (arr.length > 0) return { results: arr };
      }
    } catch (e) {
      if (e.message === "NOT_LOGGED_IN" || e.message === "AUTH_EXPIRED") throw e;
    }
  }

  // 3. Local search fallback — search user's own shows
  try {
    const showsResult = await getWatchingShows();
    if (showsResult.shows?.length > 0) {
      const ql = query.toLowerCase();
      const matches = showsResult.shows.filter(s => (s.name || "").toLowerCase().includes(ql));
      if (matches.length > 0) return { results: matches, local: true };
    }
  } catch {}

  return { results: [] };
}

// ========== FOLLOW ==========
async function followShow(id) {
  for (const [ep, method] of [[`/show/${id}/follow`, "PUT"], [`/show/${id}/follow`, "POST"]]) {
    try {
      const d = await req(ep, { method });
      if (d && d.result !== "KO") return d;
    } catch (e) {
      if (e.message === "NOT_LOGGED_IN" || e.message === "AUTH_EXPIRED") throw e;
    }
  }
  throw new Error("Could not follow");
}

async function unfollowShow(id) {
  try { return await req(`/show/${id}/follow`, { method: "DELETE" }); } catch {}
  return req(`/series/${id}/follow`, { method: "DELETE" });
}

// ========== MESSAGE ROUTER ==========
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log("[TV] msg:", request.action);
  (async () => {
    try {
      switch (request.action) {
        case "login": return await login(request.username, request.password);
        case "checkAuth": return await checkAuth();
        case "logout": return await logout();
        case "getWatchingShows": return await getWatchingShows();
        case "getUpNext": return await getUpNext();
        case "getShowDetails": return await getShowDetails(request.showId);
        case "getShowSeasons": return await getShowSeasons(request.showId);
        case "getSeasonEpisodes": return await getSeasonEpisodes(request.showId, request.seasonNumber);
        case "markWatched": return await markWatched(request.episodeId);
        case "markUnwatched": return await markUnwatched(request.episodeId);
        case "searchShows": return await searchShows(request.query);
        case "followShow": return await followShow(request.showId);
        case "unfollowShow": return await unfollowShow(request.showId);
        default: throw new Error("Unknown action");
      }
    } catch (e) {
      console.error("[TV] ERR:", e.message);
      return { error: e.message };
    }
  })().then(sendResponse);
  return true;
});

console.log("[TV] SW v4 loaded");
