// TV Time Quick Tracker - Background SW v6
const API = "https://api2.tozelabs.com/v2";
const MSAPI = "https://msapi.tvtime.com";
const SEARCH_API = "https://search.tvtime.com/v1/search";
const SEARCH_API_KEY = "LhqxB7GE9a95beFHqiNC85GHdrX8hNi34H2uQ7QG";
const AUTH_KEYS = ["auth", "uid", "bearer"];
const LEGACY_AUTH_KEYS = ["auth", "uid", "bearer", "udata"];
const SHOW_ENRICH_LIMIT = 24;
const SHOW_ENRICH_CONCURRENCY = 4;
const UPNEXT_ENRICH_LIMIT = 40;
const UPNEXT_ENRICH_CONCURRENCY = 4;
const UPNEXT_NAME_ENRICH_LIMIT = 25;
const UPNEXT_NAME_ENRICH_CONCURRENCY = 3;
const EPISODE_DETAILS_CONCURRENCY = 6;
const WATCHLIST_FILTERS = new Set([
  "continue_watching",
  "not_watched_for_a_while",
  "not_started_yet",
  "for_later",
]);
const showDetailsCacheStore = new Map(); // { value, ts }
const SHOW_DETAILS_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const showDetailsCache = {
  has(key) {
    const entry = showDetailsCacheStore.get(key);
    if (!entry) return false;
    if (Date.now() - entry.ts > SHOW_DETAILS_CACHE_TTL_MS) {
      showDetailsCacheStore.delete(key);
      return false;
    }
    return true;
  },
  get(key) {
    return showDetailsCacheStore.get(key)?.value;
  },
  set(key, value) {
    showDetailsCacheStore.set(key, { value, ts: Date.now() });
  },
  delete(key) {
    showDetailsCacheStore.delete(key);
  },
  clear() {
    showDetailsCacheStore.clear();
  },
};
const showNamePosterCache = new Map();
const seasonProbePosterCache = new Map();
const responseCache = new Map();
const inflightResponseCache = new Map();
const WATCHLIST_CACHE_TTL_MS = 120 * 1000; // 2 minutes
const UPCOMING_CACHE_TTL_MS = 120 * 1000;
const WATCHING_SHOWS_CACHE_TTL_MS = 120 * 1000;
const SEASONS_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const SEASON_EPISODES_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const ALL_EPISODES_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const DEBUG_LOGS = false;

function logDebug(...args) {
  if (DEBUG_LOGS) {
    console.log(...args);
  }
}

function clonePayload(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}

function getCachedResponse(key, ttlMs) {
  const entry = responseCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > ttlMs) {
    responseCache.delete(key);
    return null;
  }
  return clonePayload(entry.value);
}

function setCachedResponse(key, payload) {
  responseCache.set(key, { ts: Date.now(), value: clonePayload(payload) });
}

function clearResponseCaches() {
  responseCache.clear();
  inflightResponseCache.clear();
  showDetailsCacheStore.clear();
}

async function withCachedResponse({ key, ttlMs, force }, fetcher) {
  if (!force) {
    const cached = getCachedResponse(key, ttlMs);
    if (cached && !cached.error) return { ...cached, cached: true };
  }

  if (inflightResponseCache.has(key)) {
    return inflightResponseCache.get(key);
  }

  const pending = (async () => {
    const fresh = await fetcher();
    if (fresh && typeof fresh === "object" && !fresh.error) {
      setCachedResponse(key, fresh);
    }
    return fresh;
  })().finally(() => {
    inflightResponseCache.delete(key);
  });

  inflightResponseCache.set(key, pending);
  return pending;
}

function fetchT(url, opts = {}, ms = 15000) {
  const { signal: externalSignal, ...rest } = opts;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  if (externalSignal) {
    externalSignal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  return fetch(url, { ...rest, signal: controller.signal }).finally(() => clearTimeout(timer));
}

function basicH(u, p) {
  return "Basic " + btoa(unescape(encodeURIComponent(`${u}:${p}`)));
}

function authStore() {
  return chrome.storage.local;
}

function hasSessionStore() {
  return Boolean(chrome.storage.session);
}

async function clearAuthStorage() {
  const tasks = [chrome.storage.local.remove(LEGACY_AUTH_KEYS)];
  if (hasSessionStore()) {
    tasks.push(chrome.storage.session.remove(AUTH_KEYS));
  }
  await Promise.all(tasks);
}

async function getAuth() {
  const local = await chrome.storage.local.get(AUTH_KEYS);
  if (local.uid && (local.bearer || local.auth)) {
    const safeAuth = local.bearer ? "" : (local.auth || "");
    if (local.bearer && local.auth) {
      await chrome.storage.local.set({ auth: "" });
    }
    return {
      uid: local.uid,
      bearer: local.bearer || "",
      auth: safeAuth,
    };
  }

  if (hasSessionStore()) {
    // One-time migration from session storage to persistent storage.
    const session = await chrome.storage.session.get(AUTH_KEYS);
    if (session.uid && (session.bearer || session.auth)) {
      const safeAuth = session.bearer ? "" : (session.auth || "");
      const migrated = {
        uid: session.uid,
        bearer: session.bearer || "",
        auth: safeAuth,
      };
      await chrome.storage.local.set(migrated);
      await chrome.storage.session.remove(AUTH_KEYS);
      return migrated;
    }
  }
  return null;
}

function parseJSON(txt) {
  try {
    return JSON.parse(txt);
  } catch {
    return txt;
  }
}

async function req(path, opts = {}) {
  const a = await getAuth();
  if (!a) throw new Error("NOT_LOGGED_IN");

  const {
    timeout = 15000,
    method = "GET",
    headers = {},
    forceBasic = false,
    noAuthClear = false,
    ...fetchOpts
  } = opts;

  const url = path.startsWith("http") ? path : `${API}${path}`;
  logDebug(`[TV] ${method} ${url.substring(0, 120)}`);

  const authHeaders = [];
  if (forceBasic && a.auth) {
    authHeaders.push(a.auth);
  } else {
    if (a.bearer) authHeaders.push(`Bearer ${a.bearer}`);
    if (a.auth) authHeaders.push(a.auth);
  }
  if (!authHeaders.length) throw new Error("NOT_LOGGED_IN");

  for (let i = 0; i < authHeaders.length; i++) {
    const authorization = authHeaders[i];
    const r = await fetchT(url, {
      ...fetchOpts,
      method,
      headers: {
        Authorization: authorization,
        ...headers,
      },
    }, timeout);
    const txt = await r.text();
    logDebug(`[TV] ${method} ${url.substring(0, 120)} -> ${r.status}`);

    if ((r.status === 401 || r.status === 403) && i < authHeaders.length - 1) {
      continue;
    }
    if (r.status === 401 || r.status === 403) {
      // noAuthClear: don't wipe credentials when trying alternate endpoints (e.g. msapi)
      if (noAuthClear) {
        throw new Error("AUTH_REJECTED");
      }
      await clearAuthStorage();
      throw new Error("AUTH_EXPIRED");
    }
    return parseJSON(txt);
  }

  if (noAuthClear) {
    throw new Error("AUTH_REJECTED");
  }
  await clearAuthStorage();
  throw new Error("AUTH_EXPIRED");
}

function authHeadersForRequest(a, forceBasic = false) {
  const headers = [];
  if (forceBasic && a.auth) {
    headers.push(a.auth);
  } else {
    if (a.bearer) headers.push(`Bearer ${a.bearer}`);
    if (a.auth) headers.push(a.auth);
  }
  return headers;
}

function mutationErrorFromPayload(status, payload) {
  if (payload && typeof payload === "object") {
    const msg = payload.message || payload.error || payload.reason;
    if (msg) return String(msg);
    if (payload.result === "KO") return "KO";
  }
  return `HTTP_${status}`;
}

function isLikelyPlaceholderPoster(url) {
  const s = String(url || "").toLowerCase();
  if (!s) return false;
  if (s.startsWith("data:image/")) return true;
  return (
    s.includes("/default-images/") ||
    s.includes("placeholder") ||
    s.includes("/default-") ||
    s.includes("landscape-default") ||
    s.includes("noimage") ||
    s.includes("no-image") ||
    s.includes("missing") ||
    s.includes("notfound")
  );
}

function safeMediaUrl(raw) {
  if (!raw || typeof raw !== "string") return "";
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("http")) return trimmed;

  try {
    const absolute = trimmed.startsWith("//") ? `https:${trimmed}` :
      (trimmed.startsWith("/") ? trimmed : `/${trimmed}`);

    // Prioritize TV Time CDN
    let base = "https://statics.tvtime.com/";
    if (absolute.includes("banners/")) {
      base = "https://artworks.thetvdb.com/";
    }

    const url = new URL(absolute, base);
    return url.href;
  } catch {
    return "";
  }
}

/**
 * Build a resized image URL via the TV Time image proxy.
 * @param {string} rawUrl - Full or relative image URL
 * @param {number} w - Target width
 * @param {number} h - Target height
 * @returns {string} Resized image URL, or rawUrl if input is invalid
 */
function resizedImageUrl(rawUrl, w = 88, h = 120) {
  if (!rawUrl || typeof rawUrl !== "string") return rawUrl || "";
  try {
    const full = rawUrl.startsWith("http") ? rawUrl : safeMediaUrl(rawUrl);
    if (!full) return rawUrl;
    const url = new URL(full);
    const key = `${url.host}${url.pathname}`;
    const payload = JSON.stringify({
      bucket: "tvtime-platform-resize-images",
      key,
      edits: { resize: { fit: "cover", width: w, height: h } },
    });
    return `${MSAPI}/prod/v1/image/raw/${btoa(payload)}`;
  } catch {
    return rawUrl;
  }
}

function normalizePosterToken(url) {
  try {
    const u = new URL(String(url || ""), "https://artworks.thetvdb.com/");
    return `${u.origin}${u.pathname}`.toLowerCase();
  } catch {
    return String(url || "").trim().toLowerCase().split("?")[0].split("#")[0];
  }
}

async function reqMutation(path, opts = {}) {
  const a = await getAuth();
  if (!a) throw new Error("NOT_LOGGED_IN");

  const {
    timeout = 15000,
    method = "POST",
    headers = {},
    body,
    forceBasic = false,
  } = opts;

  const url = path.startsWith("http") ? path : `${API}${path}`;
  const authHeaders = authHeadersForRequest(a, forceBasic);
  if (!authHeaders.length) throw new Error("NOT_LOGGED_IN");

  const isObjBody = body && typeof body === "object" && !(body instanceof FormData);
  const requestBody = isObjBody ? JSON.stringify(body) : body;

  let lastError = new Error("MUTATION_FAILED");
  for (let i = 0; i < authHeaders.length; i++) {
    const authorization = authHeaders[i];
    try {
      const r = await fetchT(url, {
        method,
        headers: {
          Authorization: authorization,
          ...(isObjBody ? { "Content-Type": "application/json" } : {}),
          ...headers,
        },
        ...(requestBody !== undefined ? { body: requestBody } : {}),
      }, timeout);
      const txt = await r.text();
      const payload = parseJSON(txt);
      logDebug(`[TV] ${method} ${url.substring(0, 120)} -> ${r.status}`);

      if ((r.status === 401 || r.status === 403) && i < authHeaders.length - 1) {
        continue;
      }
      if (r.status === 401 || r.status === 403) {
        await clearAuthStorage();
        throw new Error("AUTH_EXPIRED");
      }

      if (r.status >= 200 && r.status < 300) {
        if (payload && typeof payload === "object" && payload.result === "KO") {
          throw new Error(payload.message || "KO");
        }
        // Empty 2xx responses are valid for some mutation endpoints.
        return { status: r.status, payload };
      }

      throw new Error(mutationErrorFromPayload(r.status, payload));
    } catch (e) {
      if (e.message === "NOT_LOGGED_IN" || e.message === "AUTH_EXPIRED") throw e;
      lastError = e;
    }
  }

  throw lastError;
}

async function runMutationCandidates(candidates) {
  let lastError = new Error("MUTATION_FAILED");
  const attempts = [];
  for (const c of candidates) {
    const methods = c.methods?.length ? c.methods : [c.method || "POST"];
    const bodies = c.bodies?.length ? c.bodies : [c.body];
    for (const method of methods) {
      for (const body of bodies) {
        try {
          const res = await reqMutation(c.path, {
            method,
            headers: c.headers,
            body,
            timeout: c.timeout,
            forceBasic: c.forceBasic,
          });
          return { ...res, endpoint: c.path, method };
        } catch (e) {
          if (e.message === "NOT_LOGGED_IN" || e.message === "AUTH_EXPIRED") throw e;
          const bodyTag = body === undefined ? "" : " [body]";
          attempts.push(`${method} ${c.path}${bodyTag} -> ${e.message}`);
          lastError = e;
        }
      }
    }
  }
  if (attempts.length) {
    const hint = attempts.slice(0, 8).join(" | ");
    throw new Error(`Mutation failed: ${hint}`);
  }
  throw lastError;
}

function showId(show) {
  return show?.id || show?.series_id || show?.show_id || "";
}

function showHasPoster(show) {
  return Boolean(
    (typeof show?.poster === "string" && show.poster) ||
    (typeof show?.image === "string" && show.image) ||
    (typeof show?.cover === "string" && show.cover) ||
    (typeof show?.artwork === "string" && show.artwork)
  );
}

function mediaUrlFromCandidate(candidate, depth = 0) {
  if (!candidate || depth > 4) return "";
  if (typeof candidate === "string") {
    const v = candidate.trim();
    return v || "";
  }
  if (Array.isArray(candidate)) {
    for (const item of candidate) {
      const url = mediaUrlFromCandidate(item, depth + 1);
      if (url) return url;
    }
    return "";
  }
  if (typeof candidate !== "object") return "";

  const direct = [
    candidate.url,
    candidate.href,
    candidate.src,
    candidate.path,
    candidate.file,
    candidate.filename,
    candidate.still,
    candidate.screenshot,
    candidate.thumb,
    candidate.thumbnail,
  ];
  for (const v of direct) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }

  const versions = candidate.versions || {};
  for (const v of [versions.medium, versions.small, versions.big, versions.original, candidate.medium, candidate.small, candidate.big]) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }

  const nestedKeys = [
    "poster",
    "image",
    "cover",
    "artwork",
    "banner",
    "thumbnail",
    "fanart",
    "images",
    "all_images",
    "data",
    "items",
  ];
  for (const key of nestedKeys) {
    const url = mediaUrlFromCandidate(candidate[key], depth + 1);
    if (url) return url;
  }

  for (const value of Object.values(candidate)) {
    const url = mediaUrlFromCandidate(value, depth + 1);
    if (url) return url;
  }

  return "";
}

function pickPoster(entity) {
  if (!entity || typeof entity !== "object") return "";
  const candidates = [
    entity.poster,
    entity.image,
    entity.filename,
    entity.screenshot,
    entity.still,
    entity.thumb,
    entity.thumbnail,
    entity.poster_image,
    entity.post_image,
    entity.poster_path,
    entity.image_path,

    entity.images?.poster,
    entity.images?.poster_image,
    entity.images?.filename,
    entity.images?.image,
    entity.images?.still,
    entity.images?.screenshot,
    entity.images,

    entity.all_images?.poster,
    entity.all_images?.poster_image,
    entity.all_images?.filename,
    entity.all_images?.image,
    entity.all_images?.still,
    entity.all_images,

    entity.show_poster,
    entity.poster_path,
    entity.still_path,
    entity.image_url,
    entity.poster_url,
    entity.cover_url,
    entity.show_image,
    entity.artwork,
    entity.cover,

    entity.show?.poster,
    entity.show?.image,
    entity.show?.poster_image,
    entity.show?.cover,
    entity.show?.artwork,
    entity.show?.images?.poster,
    entity.show?.images?.cover,
    entity.show?.all_images?.poster,
    entity.show?.all_images?.cover,
    entity.show?.all_images,
    entity.show,
  ];

  let placeholder = "";
  for (const candidate of candidates) {
    const rawUrl = mediaUrlFromCandidate(candidate);
    if (!rawUrl) continue;

    const url = safeMediaUrl(rawUrl);
    if (!url) continue;

    if (!isLikelyPlaceholderPoster(url)) return url;
    if (!placeholder) placeholder = url;
  }
  return placeholder;
}

function pickShowIdFromEpisode(ep) {
  return ep?.show_id || ep?.series_id || ep?.show?.id || ep?.show?.series_id || "";
}

function pickShowNameFromEpisode(ep) {
  return ep?.show_name || ep?.show?.name || ep?.show?.title || "";
}

function normalizeUpNextEpisode(ep) {
  const show_id = pickShowIdFromEpisode(ep);
  const show_name = pickShowNameFromEpisode(ep);
  const poster = pickPoster(ep);
  return {
    ...ep,
    show_id: show_id || ep?.show_id || "",
    show_name: show_name || ep?.show_name || "",
    poster: poster || ep?.poster || "",
  };
}

function normalizeName(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function pickSearchResults(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];

  const direct = [
    payload.results,
    payload.series,
    payload.shows,
    payload.data,
    payload.items,
    payload.matches,
    payload.hits,
    payload.tv_shows,
    payload.content,
    payload.entities,
    payload.search_results,
    payload.response?.results,
    payload.response?.series,
    payload.response?.shows,
    payload.response?.items,
    payload.data?.results,
    payload.data?.series,
    payload.data?.shows,
    payload.results?.shows,
    payload.results?.series,
    payload.results?.items,
  ];
  for (const candidate of direct) {
    if (Array.isArray(candidate) && candidate.length > 0) return candidate;
  }
  return [];
}

async function searchPosterByName(showName) {
  const key = normalizeName(showName);
  if (!key) return "";
  if (showNamePosterCache.has(key)) return showNamePosterCache.get(key);

  let poster = "";
  try {
    const q = encodeURIComponent(showName);
    const a = await getAuth();
    const authHeaders = a ? authHeadersForRequest(a) : [];
    if (authHeaders.length) {
      for (const authorization of authHeaders) {
        const urls = [
          `${SEARCH_API}/series,movie?q=${q}&offset=0&limit=5`,
          `${SEARCH_API}/series?q=${q}&offset=0&limit=5`,
        ];
        for (const url of urls) {
          const r = await fetchT(url, {
            headers: {
              Authorization: authorization,
              "x-api-key": SEARCH_API_KEY,
            },
          }, 9000);
          if (!r.ok) continue;
          const payload = await r.json();
          const rows = pickSearchResults(payload);
          const exact = rows.find(item => normalizeName(item?.name || item?.title) === key);
          const chosen = exact || rows[0];
          poster = pickPoster(chosen);
          if (poster) break;
        }
        if (poster) break;
      }
    }
  } catch (e) {
    if (e.message === "NOT_LOGGED_IN" || e.message === "AUTH_EXPIRED") throw e;
  }

  if (!poster) {
    try {
      const q = encodeURIComponent(showName);
      const urls = [
        `https://msearch.tvtime.com/v1/search?q=${q}&limit=5`,
        `https://msearch.tvtime.com/v1/search?query=${q}&limit=5`,
      ];
      for (const url of urls) {
        const r = await fetchT(url, {}, 8000);
        if (!r.ok) continue;
        const payload = await r.json();
        const rows = pickSearchResults(payload);
        const exact = rows.find(item => normalizeName(item?.name || item?.title) === key);
        const chosen = exact || rows[0];
        poster = pickPoster(chosen);
        if (poster) break;
      }
    } catch { }
  }

  showNamePosterCache.set(key, poster || "");
  return poster || "";
}

async function probePosterFromSeasonEpisodes(showId) {
  const sid = String(showId || "").trim();
  if (!sid) return "";
  if (seasonProbePosterCache.has(sid)) return seasonProbePosterCache.get(sid);

  let poster = "";
  const encoded = encodeURIComponent(sid);
  for (const ep of [
    `/show/${encoded}/season/1/episodes`,
    `/series/${encoded}/season/1/episodes`,
    `/show/${encoded}/seasons/1/episodes`,
    `/series/${encoded}/seasons/1/episodes`,
  ]) {
    try {
      const payload = await req(ep, { timeout: 10000 });
      const episodes = normalizeEpisodeList(payload);
      if (!episodes.length) continue;
      const first = episodes[0];
      poster = pickPoster(first) || pickPoster(first?.show) || "";
      if (poster) break;
    } catch (e) {
      if (e.message === "NOT_LOGGED_IN" || e.message === "AUTH_EXPIRED") throw e;
    }
  }

  seasonProbePosterCache.set(sid, poster || "");
  return poster || "";
}

function parsePositiveInt(value, fallback = 0) {
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return Math.floor(n);
  if (typeof value === "string") {
    const m = value.match(/\d+/);
    if (m) return Number(m[0]);
  }
  return fallback;
}

function looksLikeEpisode(item) {
  if (!item || typeof item !== "object") return false;
  if ("episode_id" in item || "episode_number" in item) return true;
  if ("is_watched" in item || "seen_date" in item || "seen" in item) return true;
  if ("air_date" in item || "aired" in item) return true;
  if ("number" in item && ("season_number" in item || "season" in item || "show_id" in item)) return true;
  return false;
}

function normalizeSeasons(payload) {
  if (!payload || typeof payload !== "object") return [];
  const candidates = [
    payload.seasons,
    payload.data,
    payload.results,
    payload.items,
    payload.show?.seasons,
    payload.series?.seasons,
  ];
  let raw = [];
  for (const candidate of candidates) {
    if (Array.isArray(candidate) && candidate.length) {
      raw = candidate;
      break;
    }
  }
  if (!raw.length && payload.season_count > 0) {
    raw = Array.from({ length: payload.season_count }, (_, i) => ({ number: i + 1 }));
  }
  if (!raw.length) return [];

  const mapped = raw
    .filter(s => s && typeof s === "object")
    .map((s, i) => {
      const number = parsePositiveInt(
        s.number ?? s.season_number ?? s.position ?? s.order ?? s.index ?? s.season,
        i + 1
      );
      const nbEpisodes = parsePositiveInt(
        s.nb_episodes ?? s.episode_count ?? s.episodes_count ?? s.total_episodes,
        0
      );
      const seenEpisodes = parsePositiveInt(
        s.seen_episodes ??
        s.watched_episodes ??
        s.seen_count ??
        s.watched_count ??
        s.episodes_seen,
        0
      );
      return {
        ...s,
        number,
        season_number: number,
        nb_episodes: nbEpisodes,
        episode_count: nbEpisodes,
        seen_episodes: seenEpisodes,
      };
    });

  const seen = new Set();
  return mapped.filter(s => {
    if (!s.number || seen.has(s.number)) return false;
    seen.add(s.number);
    return true;
  });
}

function normalizeEpisodeList(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];

  const candidates = [
    payload.episodes,
    payload.to_watch,
    payload.up_next,
    payload.next_episodes,
    payload.season_episodes,
    payload.episodes_list,
    payload.data,
    payload.results,
    payload.items,
    payload.show?.episodes,
    payload.series?.episodes,
    payload.season?.episodes,
    payload.user?.episodes,
    payload.user?.to_watch,
    payload.user?.up_next,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate) && candidate.length > 0) return candidate;
  }

  // Last pass for unknown shapes that still include episode-like arrays.
  for (const value of Object.values(payload)) {
    if (!Array.isArray(value) || !value.length) continue;
    const sample = value[0];
    if (looksLikeEpisode(sample)) {
      return value;
    }
  }

  return [];
}

function episodesFromSeasonPayload(payload, seasonNum) {
  if (!payload || typeof payload !== "object") return [];

  const direct = normalizeEpisodeList(payload);
  if (direct.length) return direct;

  const seasons = normalizeSeasons(payload);
  const match = seasons.find(s => parsePositiveInt(s.number || s.season_number, 0) === seasonNum);
  if (!match) return [];
  return normalizeEpisodeList(match);
}

function episodeKey(ep, fallbackSeason = 0) {
  const id = ep?.id || ep?.episode_id;
  if (id) return `id:${id}`;
  const season = parsePositiveInt(ep?.season_number ?? ep?.season?.number ?? ep?.season, fallbackSeason);
  const number = parsePositiveInt(ep?.number ?? ep?.episode_number, 0);
  if (season && number) return `sn:${season}:${number}`;
  return "";
}

function episodeIsWatched(ep) {
  if (!ep || typeof ep !== "object") return false;
  if (ep.watched || ep.is_watched || ep.is_seen) return true;
  if (ep.seen === true || ep.seen === 1 || ep.seen === "1") return true;
  const progress = ep.user_progress || ep.userProgress;
  if (progress?.watched || progress?.seen || progress?.viewed) return true;
  const user = ep.user || ep.user_state || ep.userState;
  if (user?.watched || user?.is_watched || user?.is_seen || user?.seen || user?.viewed) return true;
  if (typeof ep.seen_date === "string" && ep.seen_date.trim()) return true;
  if (typeof ep.watched_at === "string" && ep.watched_at.trim()) return true;
  if (typeof ep.viewed_at === "string" && ep.viewed_at.trim()) return true;
  return false;
}

function episodeHasWatchField(ep) {
  if (!ep || typeof ep !== "object") return false;
  if ("watched" in ep || "is_watched" in ep || "is_seen" in ep || "seen" in ep) return true;
  if ("seen_date" in ep || "watched_at" in ep || "viewed_at" in ep) return true;
  const progress = ep.user_progress || ep.userProgress;
  if (progress && typeof progress === "object") {
    if ("watched" in progress || "seen" in progress || "viewed" in progress || "seen_date" in progress) return true;
  }
  const user = ep.user || ep.user_state || ep.userState;
  if (user && typeof user === "object") {
    if ("watched" in user || "is_watched" in user || "is_seen" in user || "seen" in user || "viewed" in user) return true;
    if ("seen_date" in user || "watched_at" in user || "viewed_at" in user) return true;
  }
  return false;
}

function mergeEpisode(prev, next, fallbackSeason = 0) {
  const merged = {
    ...prev,
    ...next,
  };
  const prevWatched = episodeIsWatched(prev);
  const nextWatched = episodeIsWatched(next);
  if (prevWatched || nextWatched) {
    merged.watched = true;
    merged.is_watched = true;
    if (!merged.seen_date) {
      merged.seen_date = next.seen_date || prev.seen_date || "";
    }
  }

  if (!merged.id && merged.episode_id) merged.id = merged.episode_id;
  if (!merged.episode_id && merged.id) merged.episode_id = merged.id;

  const season = parsePositiveInt(
    merged.season_number ?? merged.season?.number ?? merged.season,
    fallbackSeason
  );
  if (season) merged.season_number = season;
  if (!merged.number && merged.episode_number) merged.number = merged.episode_number;
  if (!merged.episode_number && merged.number) merged.episode_number = merged.number;

  return merged;
}

async function enrichEpisodesWithDetails(episodes) {
  const rows = Array.isArray(episodes) ? episodes.map(ep => ({ ...ep })) : [];
  const byId = new Map();
  rows.forEach((ep, idx) => {
    const id = String(ep?.id || ep?.episode_id || "").trim();
    if (id) byId.set(id, idx);
  });

  const ids = Array.from(byId.keys());
  if (!ids.length) return rows;

  await runWithLimit(ids, EPISODE_DETAILS_CONCURRENCY, async rawId => {
    const id = encodeURIComponent(rawId);
    try {
      const details = await req(
        `/episode/${id}?fields=id,episode_id,name,title,number,episode_number,season_number,is_watched,seen,seen_date,air_date,images,poster_image,screenshot,still`,
        { timeout: 9000 }
      );
      if (!details || typeof details !== "object" || details.result === "KO") return;

      const resolvedId = String(details.id || details.episode_id || rawId).trim();
      const idx = byId.get(resolvedId);
      if (idx === undefined) return;

      const existing = rows[idx];
      const fallbackSeason = parsePositiveInt(
        existing?.season_number ?? existing?.season?.number ?? existing?.season,
        0
      );
      rows[idx] = mergeEpisode(existing, details, fallbackSeason);
    } catch (e) {
      if (e.message === "NOT_LOGGED_IN" || e.message === "AUTH_EXPIRED") throw e;
    }
  });

  return rows;
}

function deriveUpNextFromShows(shows) {
  const out = [];
  for (const show of Array.isArray(shows) ? shows : []) {
    const sid = showId(show);
    const poster = pickPoster(show);
    const showName = show.name || show.title || "";
    const candidates = [
      show.next_episode,
      show.nextEpisode,
      show.up_next_episode,
      show.to_watch_episode,
      show.episode_to_watch,
    ];
    for (const ep of candidates) {
      if (!ep || typeof ep !== "object") continue;
      out.push({
        ...ep,
        id: ep.id || ep.episode_id,
        episode_id: ep.episode_id || ep.id,
        show_id: ep.show_id || sid,
        show_name: ep.show_name || showName,
        poster: pickPoster(ep) || poster,
      });
      break;
    }
  }
  return out;
}

async function enrichUpNextEpisodes(episodes) {
  const normalized = (Array.isArray(episodes) ? episodes : []).map(normalizeUpNextEpisode);

  // Treat obvious/default posters as missing so enrichment can replace them.
  normalized.forEach(ep => {
    if (isLikelyPlaceholderPoster(ep.poster)) {
      ep.poster = "";
    }
  });

  // If one identical poster dominates the list, it is likely a global placeholder.
  const posterCounts = new Map();
  normalized.forEach(ep => {
    const token = normalizePosterToken(ep.poster);
    if (!token) return;
    posterCounts.set(token, (posterCounts.get(token) || 0) + 1);
  });
  const dominant = Array.from(posterCounts.entries())
    .sort((a, b) => b[1] - a[1])[0];
  if (dominant && dominant[1] >= 3 && dominant[1] >= Math.ceil(normalized.length * 0.5)) {
    normalized.forEach(ep => {
      if (normalizePosterToken(ep.poster) === dominant[0]) {
        ep.poster = "";
      }
    });
  }

  const missingByShow = new Map();
  normalized.forEach((ep, index) => {
    if (ep.poster && ep.show_name) return;
    const sid = String(ep.show_id || "");
    if (!sid) return;
    if (!missingByShow.has(sid)) missingByShow.set(sid, []);
    missingByShow.get(sid).push(index);
  });

  const missingShowIds = Array.from(missingByShow.keys()).slice(0, UPNEXT_ENRICH_LIMIT);
  if (!missingShowIds.length) return normalized;

  await runWithLimit(missingShowIds, UPNEXT_ENRICH_CONCURRENCY, async sid => {
    const details = await getShowDetails(sid);
    if (!details?.id || details.result === "KO") return;

    let poster = pickPoster(details);
    if (!poster) {
      poster = await probePosterFromSeasonEpisodes(sid);
    }
    const showName = details.name || details.title || "";
    const targets = missingByShow.get(sid) || [];
    for (const idx of targets) {
      if (!normalized[idx].poster && poster) normalized[idx].poster = poster;
      if (!normalized[idx].show_name && showName) normalized[idx].show_name = showName;
    }
  });

  const missingByName = new Map();
  normalized.forEach((ep, index) => {
    if (ep.poster) return;
    const nameKey = normalizeName(ep.show_name);
    if (!nameKey) return;
    if (!missingByName.has(nameKey)) {
      missingByName.set(nameKey, { name: ep.show_name, indexes: [] });
    }
    missingByName.get(nameKey).indexes.push(index);
  });

  const missingNames = Array.from(missingByName.keys()).slice(0, UPNEXT_NAME_ENRICH_LIMIT);
  await runWithLimit(missingNames, UPNEXT_NAME_ENRICH_CONCURRENCY, async key => {
    const bucket = missingByName.get(key);
    if (!bucket) return;
    const poster = await searchPosterByName(bucket.name);
    if (!poster) return;
    for (const idx of bucket.indexes) {
      if (!normalized[idx].poster) normalized[idx].poster = poster;
    }
  });

  return normalized;
}

async function runWithLimit(items, limit, task) {
  if (!items.length) return;
  let cursor = 0;
  const workerCount = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (cursor < items.length) {
      const item = items[cursor];
      cursor += 1;
      await task(item);
    }
  }));
}

async function enrichShows(shows) {
  const normalized = (Array.isArray(shows) ? shows : []).map(s => {
    const posterStr = pickPoster(s);
    return {
      ...s,
      poster: posterStr || s.poster || "",
      following: true,
      is_following: true,
      is_followed: true,
    };
  });

  const missingPosters = normalized
    .map((s, index) => ({ index, id: showId(s), hasPoster: showHasPoster(s) }))
    .filter(s => s.id && !s.hasPoster)
    .slice(0, SHOW_ENRICH_LIMIT);

  try {
    await runWithLimit(missingPosters, SHOW_ENRICH_CONCURRENCY, async item => {
      const details = await getShowDetails(item.id);
      if (!details?.id || details.result === "KO") return;

      const poster = pickPoster(details);
      if (poster && !showHasPoster(normalized[item.index])) {
        normalized[item.index].poster = poster;
      }
      if (!normalized[item.index].name && details.name) {
        normalized[item.index].name = details.name;
      }
    });
  } catch (e) {
    if (e.message === "NOT_LOGGED_IN" || e.message === "AUTH_EXPIRED") throw e;
  }

  return normalized;
}

// ========== LOGIN ==========
async function login(username, password) {
  const h = basicH(username, password);
  const r = await fetchT(`${API}/signin`, {
    method: "POST",
    headers: { Authorization: h },
  }, 15000);
  const d = await r.json();
  logDebug("[TV] Login response received");
  if (d.result === "KO") throw new Error(d.message || "Login failed");
  if (!d.id) throw new Error("No user ID");

  clearResponseCaches();
  const bearer = d.tvst_access_token || d.access_token || "";
  await authStore().set({
    auth: bearer ? "" : h,
    uid: d.id,
    bearer,
  });
  if (hasSessionStore()) {
    await chrome.storage.session.remove(AUTH_KEYS);
  }

  return { success: true, userId: d.id };
}

async function checkAuth() {
  const a = await getAuth();
  return a ? { authenticated: true, userId: a.uid } : { authenticated: false };
}

async function logout() {
  await clearAuthStorage();
  clearResponseCaches();
  return { success: true };
}

// ========== MY SHOWS ==========
async function getWatchingShows(opts = {}) {
  const a = await getAuth();
  if (!a) throw new Error("NOT_LOGGED_IN");

  const force = Boolean(opts.forceRefresh || opts.noCache);
  const cacheKey = `watching-shows:${a.uid}`;
  return withCachedResponse({ key: cacheKey, ttlMs: WATCHING_SHOWS_CACHE_TTL_MS, force }, async () => {
    const endpoints = [
      `/user/${a.uid}?fields=shows.fields(id,series_id,name,title,poster,image,is_following,is_followed).limit(-1)`,
      `/user/${a.uid}?fields=shows.limit(-1)`,
      `/user/${a.uid}`,
    ];

    for (const ep of endpoints) {
      try {
        const d = await req(ep);
        const shows = d.shows || d.series || (Array.isArray(d) ? d : null);
        if (shows?.length > 0) {
          const enriched = await enrichShows(shows);
          logDebug(`[TV] watching shows loaded: ${enriched.length}`);
          return { shows: enriched };
        }
      } catch (e) {
        if (e.message === "NOT_LOGGED_IN" || e.message === "AUTH_EXPIRED") throw e;
      }
    }
    return { shows: [] };
  });
}

function normalizeWatchListFilter(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";
  const normalized = raw
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[-\s]+/g, "_")
    .toLowerCase();
  if (WATCHLIST_FILTERS.has(normalized)) return normalized;
  if (normalized === "continuewatching") return "continue_watching";
  if (normalized === "notwatchedforawhile") return "not_watched_for_a_while";
  if (normalized === "notstartedyet") return "not_started_yet";
  if (normalized === "forlater") return "for_later";
  return "";
}

function withWatchListCategory(episodes, filter) {
  const normalizedFilter = normalizeWatchListFilter(filter);
  return (Array.isArray(episodes) ? episodes : []).map(ep => ({
    ...ep,
    ...(normalizedFilter &&
      !normalizeWatchListFilter(ep?.to_watch_category || ep?.toWatchCategory)
      ? { to_watch_category: normalizedFilter }
      : {}),
  }));
}

function collectEpisodeLikeArrays(payload, out = [], depth = 0) {
  if (!payload || depth > 5) return out;
  if (Array.isArray(payload)) {
    if (payload.length && looksLikeEpisode(payload[0])) {
      out.push(payload);
    } else {
      for (const item of payload) {
        collectEpisodeLikeArrays(item, out, depth + 1);
      }
    }
    return out;
  }
  if (typeof payload !== "object") return out;
  for (const value of Object.values(payload)) {
    collectEpisodeLikeArrays(value, out, depth + 1);
  }
  return out;
}

function normalizeUpcomingEpisode(ep) {
  const base = normalizeUpNextEpisode(ep);
  return {
    ...base,
    channel:
      ep?.channel ||
      ep?.channel_name ||
      ep?.broadcast_channel ||
      ep?.network ||
      ep?.show?.network ||
      ep?.show?.channel ||
      "",
    air_time:
      ep?.air_time ||
      ep?.time ||
      ep?.local_time ||
      ep?.airing_time ||
      "",
    air_datetime:
      ep?.air_datetime ||
      ep?.airing_at ||
      ep?.air_at ||
      ep?.air_date ||
      ep?.aired ||
      "",
  };
}

function normalizeUpcomingEpisodeList(payload) {
  const rows = [];
  const direct = normalizeEpisodeList(payload);
  if (direct.length) rows.push(...direct);
  for (const arr of collectEpisodeLikeArrays(payload)) {
    rows.push(...arr);
  }
  if (!rows.length) return [];

  const seen = new Set();
  const out = [];
  for (const ep of rows) {
    const key =
      ep?.id ||
      ep?.episode_id ||
      `${pickShowIdFromEpisode(ep)}:${ep?.season_number || ep?.season || ""}:${ep?.episode_number || ep?.number || ""}:${ep?.air_date || ep?.aired || ep?.air_datetime || ""}`;
    const token = String(key || "").trim();
    if (!token || seen.has(token)) continue;
    seen.add(token);
    out.push(normalizeUpcomingEpisode(ep));
  }
  return out;
}

async function getWatchList(opts = {}) {
  const a = await getAuth();
  if (!a) throw new Error("NOT_LOGGED_IN");

  const offset = Math.max(0, Number(opts.offset) || 0);
  const limit = Math.max(1, Math.min(200, parsePositiveInt(opts.limit, 100)));
  const filter = normalizeWatchListFilter(opts.filter);
  const force = Boolean(opts.forceRefresh || opts.noCache);
  const cacheKey = `watch-list:${a.uid}:${filter || "all"}:${offset}:${limit}`;
  return withCachedResponse({ key: cacheKey, ttlMs: WATCHLIST_CACHE_TTL_MS, force }, async () => {
    const filterQ = filter ? `&filter=${encodeURIComponent(filter)}` : "";
    const endpoints = [
      `/user/${a.uid}/to_watch?limit=${limit}${filterQ}&include_country=1`,
      `/user/${a.uid}/to_watch`,
    ];

    let lastError = null;
    for (const ep of endpoints) {
      try {
        const d = await req(ep, { timeout: 10000 });
        let episodes = normalizeEpisodeList(d);
        if (!episodes.length) continue;
        episodes = withWatchListCategory(episodes, filter);
        const enriched = await enrichUpNextEpisodes(episodes);
        const withPoster = enriched.filter(item => Boolean(item.poster)).length;
        logDebug(
          `[TV] watch list loaded: ${enriched.length} episodes posters:${withPoster}${filter ? ` filter:${filter}` : ""}`
        );
        return { episodes: enriched, filter: filter || "", source: ep };
      } catch (e) {
        if (e.message === "NOT_LOGGED_IN" || e.message === "AUTH_EXPIRED") throw e;
        lastError = e;
      }
    }

    if (lastError) {
      logDebug(`[TV] watch list empty after error: ${lastError.message}`);
    }
    return { episodes: [], filter: filter || "", empty: true };
  });
}

async function getUpcoming(opts = {}) {
  const a = await getAuth();
  if (!a) throw new Error("NOT_LOGGED_IN");

  const offset = Math.max(0, Number(opts.offset) || 0);
  const showLimit = Math.max(1, Math.min(300, parsePositiveInt(opts.showLimit, 100)));
  const back = Math.max(0, Number(opts.back ?? 1) || 1);
  const includeWatched = Number(opts.includeWatched ?? 0) ? 1 : 0;
  const force = Boolean(opts.forceRefresh || opts.noCache);
  const cacheKey = `upcoming:${a.uid}:${offset}:${showLimit}:${back}:${includeWatched}`;
  return withCachedResponse({ key: cacheKey, ttlMs: UPCOMING_CACHE_TTL_MS, force }, async () => {
    const endpoints = [
      `/user/${a.uid}/tocome?show_limit=${showLimit}&back=${back}&include_watched=${includeWatched}`,
      `/user/${a.uid}/tocome`,
    ];

    let sawSuccess = false;
    let lastError = null;
    for (const ep of endpoints) {
      try {
        const d = await req(ep, { timeout: 10000 });
        sawSuccess = true;
        const episodes = normalizeUpcomingEpisodeList(d);
        if (!episodes.length) continue;
        const enriched = await enrichUpNextEpisodes(episodes);
        logDebug(`[TV] upcoming loaded: ${enriched.length} episodes`);
        return { episodes: enriched, source: ep };
      } catch (e) {
        if (e.message === "NOT_LOGGED_IN" || e.message === "AUTH_EXPIRED") throw e;
        lastError = e;
      }
    }

    if (lastError) {
      logDebug(`[TV] upcoming empty after error: ${lastError.message}`);
    }
    return { episodes: [], empty: true, sawSuccess };
  });
}

// Backward compatibility alias used by older popup builds.
async function getUpNext() {
  return getWatchList({ filter: "continue_watching", offset: 0, limit: 100 });
}

function updateBadgeCount(groups) {
  try {
    const unwatched = Object.values(groups || {}).reduce((sum, eps) => {
      return sum + (Array.isArray(eps) ? eps.filter(ep => !ep.watched && !ep.is_watched && !ep.is_seen).length : 0);
    }, 0);
    const text = unwatched > 0 ? (unwatched > 99 ? "99+" : String(unwatched)) : "";
    chrome.action.setBadgeText({ text });
    chrome.action.setBadgeBackgroundColor({ color: "#f5c518" });
  } catch { /* badge API may not be available */ }
}

async function getWatchListBundle(opts = {}) {
  const requested = Array.isArray(opts.filters)
    ? opts.filters.map(normalizeWatchListFilter).filter(Boolean)
    : [];
  const filters = requested.length
    ? Array.from(new Set(requested))
    : ["continue_watching", "not_watched_for_a_while"];

  const groups = {};
  await Promise.all(filters.map(async filter => {
    const res = await getWatchList({ ...opts, filter });
    groups[filter] = Array.isArray(res?.episodes) ? res.episodes : [];
  }));

  updateBadgeCount(groups);
  return { groups, filters };
}

async function preloadDashboard(opts = {}) {
  const tasks = [
    getWatchList({ filter: "continue_watching", offset: 0, limit: 100 }),
    getWatchList({ filter: "not_watched_for_a_while", offset: 0, limit: 100 }),
    getUpcoming({ offset: 0, showLimit: 100, back: 1, includeWatched: 0 }),
    getWatchingShows(),
  ];
  if (opts.includeForLater) {
    tasks.push(getWatchList({ filter: "for_later", offset: 0, limit: 100 }));
  }

  const settled = await Promise.allSettled(tasks);
  const warmed = settled.filter(item => item.status === "fulfilled").length;
  const errors = settled
    .filter(item => item.status === "rejected")
    .map(item => item.reason?.message || "PRELOAD_FAILED");

  return {
    success: true,
    warmed,
    failed: errors.length,
    errors: errors.slice(0, 3),
  };
}

// ========== SHOW DETAIL ==========
async function getShowDetails(id) {
  const sid = String(id || "");
  if (!sid) return { error: "not_found" };
  if (showDetailsCache.has(sid)) return showDetailsCache.get(sid);

  // Try the confirmed msapi endpoint first (from official web app)
  try {
    const d = await req(`${MSAPI}/v1/series/${sid}`, { timeout: 10000, noAuthClear: true });
    if (d && typeof d === "object" && !d.error && d.result !== "KO") {
      // Normalize id field
      if (!d.id && d.series_id) d.id = d.series_id;
      if (d.id || d.name || d.title) {
        showDetailsCache.set(sid, d);
        return d;
      }
    }
  } catch (e) {
    if (e.message === "NOT_LOGGED_IN" || e.message === "AUTH_EXPIRED") throw e;
    // AUTH_REJECTED from msapi is non-fatal — fall through to legacy endpoints
    logDebug(`[TV] msapi show details failed for ${sid}: ${e.message}`);
  }

  // Fallback to legacy api2 endpoints
  for (const ep of [`/show/${sid}?fields=id,name,title,images,poster_image`, `/series/${sid}?fields=id,name,title,images,poster_image`]) {
    try {
      const d = await req(ep);
      if (d?.id && d.result !== "KO") {
        showDetailsCache.set(sid, d);
        return d;
      }
    } catch (e) {
      if (e.message === "NOT_LOGGED_IN" || e.message === "AUTH_EXPIRED") throw e;
    }
  }

  const miss = { error: "not_found" };
  showDetailsCache.set(sid, miss);
  return miss;
}

/**
 * Fetch ALL episodes for a show in a single request (confirmed from official web app).
 * Returns { seasons: [...], episodesBySeason: { 1: [...], 2: [...], ... } }
 */
async function getShowAllEpisodes(showId) {
  const sid = String(showId || "");
  if (!sid) return { seasons: [], episodesBySeason: {} };

  const cacheKey = `all-episodes:${sid}`;
  return withCachedResponse({ key: cacheKey, ttlMs: ALL_EPISODES_CACHE_TTL_MS }, async () => {
    let allEpisodes = [];

    // Primary: msapi single-request endpoint (confirmed from web app)
    try {
      const d = await req(`${MSAPI}/v1/series/${sid}/episodes`, { timeout: 12000, noAuthClear: true });
      allEpisodes = normalizeEpisodeList(d);
    } catch (e) {
      if (e.message === "NOT_LOGGED_IN" || e.message === "AUTH_EXPIRED") throw e;
      logDebug(`[TV] msapi episodes failed for ${sid}: ${e.message}`);
    }

    // Fallback: legacy api2 endpoint (2 attempts max)
    if (!allEpisodes.length) {
      const a = await getAuth();
      if (!a) throw new Error("NOT_LOGGED_IN");
      for (const ep of [
        `/user/${a.uid}/show/${sid}/episodes`,
        `/show/${sid}/episodes`,
      ]) {
        try {
          const d = await req(ep, { timeout: 10000 });
          allEpisodes = normalizeEpisodeList(d);
          if (allEpisodes.length) break;
        } catch (e) {
          if (e.message === "NOT_LOGGED_IN" || e.message === "AUTH_EXPIRED") throw e;
        }
      }
    }

    const hasWatchFields = allEpisodes.some(episodeHasWatchField);

    // Group episodes by season
    const episodesBySeason = {};
    const seasonMeta = new Map();
    for (const ep of allEpisodes) {
      const sn = parsePositiveInt(ep.season_number ?? ep.season?.number ?? ep.season, 0);
      if (!sn) continue;
      if (!episodesBySeason[sn]) episodesBySeason[sn] = [];
      episodesBySeason[sn].push(ep);
      const meta = seasonMeta.get(sn) || { total: 0, watched: 0 };
      meta.total++;
      if (episodeIsWatched(ep)) meta.watched++;
      seasonMeta.set(sn, meta);
    }

    // Sort episodes within each season
    for (const sn of Object.keys(episodesBySeason)) {
      episodesBySeason[sn].sort(
        (a, b) => parsePositiveInt(a.number ?? a.episode_number, 0) - parsePositiveInt(b.number ?? b.episode_number, 0)
      );
    }

    // Build seasons array
    const seasons = Array.from(seasonMeta.entries())
      .sort(([a], [b]) => a - b)
      .map(([num, meta]) => ({
        number: num,
        season_number: num,
        nb_episodes: meta.total,
        episode_count: meta.total,
        seen_episodes: meta.watched,
      }));

    return { seasons, episodesBySeason, hasWatchFields };
  });
}

async function getShowSeasons(id, opts = {}) {
  const a = await getAuth();
  if (!a) throw new Error("NOT_LOGGED_IN");

  const minSeasons = Math.max(0, Number(opts.minSeasons || 0));
  let force = Boolean(opts.forceRefresh || opts.noCache);
  const cacheKey = `show-seasons:${id}`;

  if (!force && minSeasons > 0) {
    const cached = getCachedResponse(cacheKey, SEASONS_CACHE_TTL_MS);
    if (cached && !cached.error && Array.isArray(cached.seasons) && cached.seasons.length >= minSeasons) {
      return { ...cached, cached: true };
    }
    force = true;
  }

  return withCachedResponse({ key: cacheKey, ttlMs: SEASONS_CACHE_TTL_MS, force }, async () => {
    // Try the fast all-episodes path first — derives seasons from episode data
    let fallbackSeasons = [];
    try {
      const result = await getShowAllEpisodes(id);
      if (
        result.seasons?.length > 0 &&
        result.hasWatchFields &&
        (!minSeasons || result.seasons.length >= minSeasons)
      ) {
        return { seasons: result.seasons };
      }
      if (result.seasons?.length > 0) {
        fallbackSeasons = result.seasons;
      }
    } catch (e) {
      if (e.message === "NOT_LOGGED_IN" || e.message === "AUTH_EXPIRED") throw e;
      logDebug(`[TV] all-episodes seasons derivation failed: ${e.message}`);
    }

    // Fallback: legacy season endpoints (3 most reliable)
    for (const ep of [
      `/user/${a.uid}/show/${id}/seasons`,
      `/show/${id}/seasons`,
      `/series/${id}/seasons`,
    ]) {
      try {
        const d = await req(ep, { timeout: 10000 });
        const seasons = normalizeSeasons(d);
        if (seasons?.length && (!minSeasons || seasons.length >= minSeasons)) {
          return { seasons };
        }
        if (seasons?.length && seasons.length > fallbackSeasons.length) {
          fallbackSeasons = seasons;
        }
      } catch (e) {
        if (e.message === "NOT_LOGGED_IN" || e.message === "AUTH_EXPIRED") throw e;
      }
    }

    if (fallbackSeasons.length) return { seasons: fallbackSeasons };
    return { seasons: [] };
  });
}

async function getSeasonEpisodes(showId, seasonNum) {
  const a = await getAuth();
  if (!a) throw new Error("NOT_LOGGED_IN");

  const n = parsePositiveInt(seasonNum, 0);
  if (!n) return { episodes: [] };

  const cacheKey = `season-episodes:${showId}:${n}`;
  return withCachedResponse({ key: cacheKey, ttlMs: SEASON_EPISODES_CACHE_TTL_MS }, async () => {
    // Try to get from the all-episodes cache (single request for entire show)
    try {
      const all = await getShowAllEpisodes(showId);
      if (all.episodesBySeason && all.episodesBySeason[n]?.length) {
        let episodes = all.episodesBySeason[n];
        const hasWatchFields = typeof all.hasWatchFields === "boolean"
          ? all.hasWatchFields
          : episodes.some(episodeHasWatchField);
        if (!hasWatchFields) {
          throw new Error("MISSING_WATCH_FIELDS");
        }

        // Apply show poster to episodes missing one
        try {
          const showDetails = await getShowDetails(showId);
          if (showDetails && !showDetails.error) {
            const showPoster = pickPoster(showDetails);
            const showName = showDetails.name || showDetails.title || "";
            episodes = episodes.map(ep => ({
              ...ep,
              poster: (ep.poster && !isLikelyPlaceholderPoster(ep.poster))
                ? ep.poster
                : (pickPoster(ep) || showPoster || ep.poster || ""),
              show_name: ep.show_name || showName,
            }));
          }
        } catch { /* show details optional */ }

        return { episodes };
      }
    } catch (e) {
      if (e.message === "NOT_LOGGED_IN" || e.message === "AUTH_EXPIRED") throw e;
      logDebug(`[TV] all-episodes season filter failed: ${e.message}`);
    }

    // Fallback: legacy per-season endpoints (3 most reliable)
    for (const ep of [
      `/user/${a.uid}/show/${showId}/season/${n}/episodes`,
      `/show/${showId}/season/${n}/episodes`,
      `/series/${showId}/season/${n}/episodes`,
    ]) {
      try {
        const d = await req(ep, { timeout: 10000 });
        const episodes = episodesFromSeasonPayload(d, n);
        if (episodes?.length) {
          const enriched = await enrichEpisodesWithDetails(episodes);
          return { episodes: enriched };
        }
      } catch (e) {
        if (e.message === "NOT_LOGGED_IN" || e.message === "AUTH_EXPIRED") throw e;
      }
    }

    return { episodes: [] };
  });
}

// ========== EPISODE ACTIONS ==========
async function markWatched(episodeId) {
  const rawId = String(episodeId || "").trim();
  const id = encodeURIComponent(rawId);
  if (!id) throw new Error("INVALID_EPISODE_ID");

  const result = await runMutationCandidates([
    {
      path: `/watched_episodes/episode/${id}?is_rewatch=0`,
      methods: ["POST"],
    },
    {
      path: `/watched_episodes/episode/${id}`,
      methods: ["POST"],
      bodies: [undefined, { is_rewatch: 0 }, { is_rewatch: false }],
    },
    {
      path: `/episodes/${id}/watched`,
      methods: ["PUT", "POST"],
      bodies: [undefined, { watched: true }, { is_watched: true }, { seen: true }],
    },
    {
      path: `/episode/${id}/watched`,
      methods: ["PUT", "POST"],
      bodies: [undefined, { watched: true }, { is_watched: true }, { seen: true }],
    },
    {
      path: `/episodes/${id}/seen`,
      methods: ["PUT", "POST"],
      bodies: [undefined, { seen: true }, { is_watched: true }],
    },
    {
      path: `/episode/${id}/seen`,
      methods: ["PUT", "POST"],
      bodies: [undefined, { seen: true }, { is_watched: true }],
    },
  ]);
  clearResponseCaches();
  return result;
}

async function markUnwatched(episodeId) {
  const rawId = String(episodeId || "").trim();
  const id = encodeURIComponent(rawId);
  if (!id) throw new Error("INVALID_EPISODE_ID");

  const result = await runMutationCandidates([
    { path: `/watched_episodes/episode/${id}`, methods: ["DELETE"] },
    { path: `/episodes/${id}/watched`, methods: ["DELETE"] },
    { path: `/episode/${id}/watched`, methods: ["DELETE"] },
    { path: `/episodes/${id}/seen`, methods: ["DELETE", "POST", "PUT"], bodies: [undefined, { seen: false }, { is_watched: false }] },
    { path: `/episode/${id}/seen`, methods: ["DELETE", "POST", "PUT"], bodies: [undefined, { seen: false }, { is_watched: false }] },
  ]);
  clearResponseCaches();
  return result;
}

// ========== SEARCH ==========
async function searchShows(query) {
  const a = await getAuth();
  if (!a) throw new Error("NOT_LOGGED_IN");

  const q = encodeURIComponent(query);

  const tagFollowing = async results => {
    if (!Array.isArray(results) || results.length === 0) return results;
    try {
      const showsResult = await getWatchingShows();
      const followedIds = new Set(
        (showsResult.shows || [])
          .map(s => showId(s))
          .filter(Boolean)
          .map(id => String(id))
      );
      if (!followedIds.size) return results;

      for (const item of results) {
        const candidateId =
          showId(item) ||
          showId(item?.show) ||
          showId(item?.series) ||
          showId(item?.tv_show) ||
          showId(item?.content);
        if (candidateId && followedIds.has(String(candidateId))) {
          item.following = true;
          item.is_following = true;
          item.is_followed = true;
        }
      }
    } catch { /* ignore follow tagging failures */ }
    return results;
  };

  // 1) TV Time search microservice (global shows/movies search)
  try {
    const authHeaders = authHeadersForRequest(a);
    if (authHeaders.length) {
      for (const authorization of authHeaders) {
        const urls = [
          `${SEARCH_API}/series,movie?q=${q}&offset=0&limit=20`,
          `${SEARCH_API}/series?q=${q}&offset=0&limit=20`,
        ];
        for (const url of urls) {
          const r = await fetchT(url, {
            headers: {
              Authorization: authorization,
              "x-api-key": SEARCH_API_KEY,
            },
          }, 10000);
          if (!r.ok) continue;
          const d = await r.json();
          if (d?.status === "fail" || d?.status === "error") continue;
          const arr = pickSearchResults(d);
          if (arr.length > 0) {
            await tagFollowing(arr);
            return { results: arr, remote: "search-service" };
          }
        }
      }
    }
  } catch { }

  // 2) msearch
  try {
    const urls = [
      `https://msearch.tvtime.com/v1/search?q=${q}&limit=20`,
      `https://msearch.tvtime.com/v1/search?query=${q}&limit=20`,
    ];
    for (const url of urls) {
      const r = await fetchT(url, {}, 8000);
      if (!r.ok) continue;
      const d = await r.json();
      const arr = pickSearchResults(d);
      if (arr.length > 0) {
        await tagFollowing(arr);
        return { results: arr, remote: "msearch" };
      }
    }
  } catch { }

  // 3) Legacy API search endpoints
  for (const ep of [
    `/show/search?q=${q}`,
    `/search?q=${q}`,
    `/series/search?q=${q}`,
    `/search/shows?q=${q}`,
  ]) {
    try {
      const d = await req(ep);
      if (d && d.code !== 404 && d.result !== "KO") {
        const arr = pickSearchResults(d);
        if (arr.length > 0) {
          await tagFollowing(arr);
          return { results: arr, remote: "api" };
        }
      }
    } catch (e) {
      if (e.message === "NOT_LOGGED_IN" || e.message === "AUTH_EXPIRED") throw e;
    }
  }

  // 4) Local search fallback against tracked shows
  try {
    const showsResult = await getWatchingShows();
    if (showsResult.shows?.length > 0) {
      const ql = query.toLowerCase();
      const matches = showsResult.shows.filter(s => (s.name || s.title || "").toLowerCase().includes(ql));
      if (matches.length > 0) return { results: matches, local: true };
    }
  } catch { }

  return { results: [] };
}

// ========== FOLLOW ==========
async function followShow(id) {
  const a = await getAuth();
  if (!a) throw new Error("NOT_LOGGED_IN");

  const rawSid = String(id || "").trim();
  const sid = encodeURIComponent(rawSid);
  if (!sid) throw new Error("INVALID_SHOW_ID");

  const result = await runMutationCandidates([
    { path: `/user/${a.uid}/followed_show?show_id=${sid}`, methods: ["PUT"] },
    {
      path: `/user/${a.uid}/followed_show`,
      methods: ["PUT"],
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `show_id=${sid}`,
    },
    { path: `/show/${sid}/follow`, methods: ["PUT", "POST"] },
    { path: `/series/${sid}/follow`, methods: ["PUT", "POST"] },
    { path: `/show/${sid}/following`, methods: ["PUT", "POST"], bodies: [undefined, { following: true }, { is_following: true }] },
    { path: `/series/${sid}/following`, methods: ["PUT", "POST"], bodies: [undefined, { following: true }, { is_following: true }] },
  ]);
  clearResponseCaches();
  return result;
}

async function unfollowShow(id) {
  const a = await getAuth();
  if (!a) throw new Error("NOT_LOGGED_IN");

  const rawSid = String(id || "").trim();
  const sid = encodeURIComponent(rawSid);
  if (!sid) throw new Error("INVALID_SHOW_ID");

  const result = await runMutationCandidates([
    { path: `/user/${a.uid}/followed_show?show_id=${sid}`, methods: ["DELETE"] },
    {
      path: `/user/${a.uid}/followed_show`,
      methods: ["DELETE"],
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `show_id=${sid}`,
    },
    { path: `/show/${sid}/follow`, methods: ["DELETE"] },
    { path: `/series/${sid}/follow`, methods: ["DELETE"] },
    { path: `/show/${sid}/following`, methods: ["DELETE", "POST", "PUT"], bodies: [undefined, { following: false }, { is_following: false }] },
    { path: `/series/${sid}/following`, methods: ["DELETE", "POST", "PUT"], bodies: [undefined, { following: false }, { is_following: false }] },
  ]);
  clearResponseCaches();
  return result;
}

// ========== MESSAGE ROUTER ==========
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const action = request?.action || "";
  logDebug("[TV] msg:", action);
  (async () => {
    try {
      switch (action) {
        case "login": return await login(request.username, request.password);
        case "checkAuth": return await checkAuth();
        case "logout": return await logout();
        case "getWatchingShows": return await getWatchingShows(request);
        case "getWatchList": return await getWatchList(request);
        case "getWatchListBundle": return await getWatchListBundle(request);
        case "getUpcoming": return await getUpcoming(request);
        case "preloadDashboard": return await preloadDashboard(request);
        case "getUpNext": return await getUpNext();
        case "getShowDetails": return await getShowDetails(request.showId);
        case "getShowAllEpisodes": return await getShowAllEpisodes(request.showId);
        case "getShowSeasons": return await getShowSeasons(request.showId, request);
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

logDebug("[TV] SW v6 loaded");

// ========== CONTEXT MENU ==========
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "search-tvtime",
    title: "Search '%s' on TV Time",
    contexts: ["selection"],
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "search-tvtime" && info.selectionText) {
    const query = info.selectionText.trim();
    chrome.storage.local.set({ pendingSearch: query }, () => {
      chrome.action.openPopup();
    });
  }
});
