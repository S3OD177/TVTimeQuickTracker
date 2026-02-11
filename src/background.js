// TV Time Quick Tracker - Background SW v5
const API = "https://api2.tozelabs.com/v2";
const AUTH_KEYS = ["auth", "uid", "bearer"];
const LEGACY_AUTH_KEYS = ["auth", "uid", "bearer", "udata"];
const SHOW_ENRICH_LIMIT = 24;
const SHOW_ENRICH_CONCURRENCY = 4;
const UPNEXT_ENRICH_LIMIT = 40;
const UPNEXT_ENRICH_CONCURRENCY = 4;
const UPNEXT_NAME_ENRICH_LIMIT = 25;
const UPNEXT_NAME_ENRICH_CONCURRENCY = 3;
const API_LAB_SAFE_SHOW_ID = "__tvtime_probe_show__";
const API_LAB_SAFE_EPISODE_ID = "__tvtime_probe_episode__";
const API_LAB_EXPECTED_MUTATION_STATUSES = new Set([400, 404, 405, 409, 410, 422]);
const showDetailsCache = new Map();
const showNamePosterCache = new Map();
const seasonProbePosterCache = new Map();

function fetchT(url, opts = {}, ms = 15000) {
  return Promise.race([
    fetch(url, opts),
    new Promise((_, r) => setTimeout(() => r(new Error("TIMEOUT")), ms)),
  ]);
}

function basicH(u, p) {
  return "Basic " + btoa(unescape(encodeURIComponent(`${u}:${p}`)));
}

function authStore() {
  return chrome.storage.session || chrome.storage.local;
}

function hasSessionStore() {
  return Boolean(chrome.storage.session);
}

async function clearAuthStorage() {
  if (hasSessionStore()) {
    await Promise.all([
      chrome.storage.session.remove(AUTH_KEYS),
      chrome.storage.local.remove(LEGACY_AUTH_KEYS),
    ]);
    return;
  }
  await chrome.storage.local.remove(LEGACY_AUTH_KEYS);
}

async function getAuth() {
  const store = authStore();
  const session = await store.get(AUTH_KEYS);
  if (session.uid && (session.bearer || session.auth)) {
    return {
      uid: session.uid,
      bearer: session.bearer || "",
      auth: session.auth || "",
    };
  }

  if (hasSessionStore()) {
    // One-time migration from persistent local storage.
    const legacy = await chrome.storage.local.get(AUTH_KEYS);
    if (legacy.uid && (legacy.bearer || legacy.auth)) {
      const migrated = {
        uid: legacy.uid,
        bearer: legacy.bearer || "",
        auth: legacy.auth || "",
      };
      await store.set(migrated);
      await chrome.storage.local.remove(LEGACY_AUTH_KEYS);
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
    ...fetchOpts
  } = opts;

  const url = path.startsWith("http") ? path : `${API}${path}`;
  console.log(`[TV] ${method} ${url.substring(0, 120)}`);

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
    console.log(`[TV] ${r.status} ${txt.substring(0, 250)}`);

    if ((r.status === 401 || r.status === 403) && i < authHeaders.length - 1) {
      continue;
    }
    if (r.status === 401 || r.status === 403) {
      await clearAuthStorage();
      throw new Error("AUTH_EXPIRED");
    }
    return parseJSON(txt);
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
  return (
    s.includes("placeholder") ||
    s.includes("default") ||
    s.includes("noimage") ||
    s.includes("no-image") ||
    s.includes("missing") ||
    s.includes("notfound")
  );
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
      console.log(`[TV] ${method} ${url.substring(0, 120)} -> ${r.status} ${txt.substring(0, 250)}`);

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

function looksLikeShow(item) {
  if (!item || typeof item !== "object") return false;
  if (looksLikeEpisode(item)) return false;
  const hasId = ("id" in item) || ("series_id" in item) || ("show_id" in item);
  const hasName = ("name" in item) || ("title" in item);
  return hasId && hasName;
}

function normalizeShowList(payload) {
  if (Array.isArray(payload)) {
    const sample = payload.find(item => item && typeof item === "object");
    return looksLikeShow(sample) ? payload : [];
  }
  if (!payload || typeof payload !== "object") return [];

  const candidates = [
    payload.shows,
    payload.series,
    payload.results,
    payload.data,
    payload.items,
    payload.user?.shows,
    payload.user?.series,
  ];
  for (const candidate of candidates) {
    if (!Array.isArray(candidate) || candidate.length === 0) continue;
    const sample = candidate.find(item => item && typeof item === "object");
    if (looksLikeShow(sample)) return candidate;
  }
  return [];
}

function topLevelKeys(payload) {
  if (Array.isArray(payload)) {
    const first = payload.find(item => item && typeof item === "object");
    const firstKeys = first ? Object.keys(first).slice(0, 19) : [];
    return [`[array:${payload.length}]`, ...firstKeys];
  }
  if (payload && typeof payload === "object") {
    return Object.keys(payload).slice(0, 20);
  }
  return [`[${typeof payload}]`];
}

function sampleObjectKeys(list) {
  const sample = (Array.isArray(list) ? list : []).find(item => item && typeof item === "object");
  return sample ? Object.keys(sample).slice(0, 20) : [];
}

function showHasPoster(show) {
  return Boolean(show?.poster || show?.image || show?.cover || show?.artwork);
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

  const direct = [candidate.url, candidate.href, candidate.src, candidate.path, candidate.file];
  for (const v of direct) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }

  const versions = candidate.versions || {};
  for (const v of [versions.medium, versions.small, versions.big, versions.original]) {
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

  return "";
}

function pickPoster(entity) {
  if (!entity || typeof entity !== "object") return "";
  const candidates = [
    entity.poster,
    entity.image,
    entity.cover,
    entity.artwork,
    entity.banner,
    entity.poster_url,
    entity.image_url,
    entity.cover_url,
    entity.show_poster,
    entity.show_image,
    entity.show?.poster,
    entity.show?.image,
    entity.show?.cover,
    entity.show?.artwork,
    entity.images?.poster,
    entity.images?.cover,
    entity.images?.image,
    entity.all_images?.poster,
    entity.all_images?.cover,
    entity.all_images,
    entity.show?.all_images,
    entity.show,
  ];

  for (const candidate of candidates) {
    const url = mediaUrlFromCandidate(candidate);
    if (url) return url;
  }
  return "";
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
  } catch {}

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
  if (ep.watched === true || ep.is_watched === true || ep.is_seen === true) return true;
  if (ep.seen === true || ep.seen === 1 || ep.seen === "1") return true;
  if (typeof ep.seen_date === "string" && ep.seen_date.trim()) return true;
  if (typeof ep.watched_at === "string" && ep.watched_at.trim()) return true;
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
    if (ep.poster) return;
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
  const normalized = (Array.isArray(shows) ? shows : []).map(s => ({
    ...s,
    following: true,
    is_following: true,
    is_followed: true,
  }));

  const missingPosters = normalized
    .map((s, index) => ({ index, id: showId(s), hasPoster: showHasPoster(s) }))
    .filter(s => s.id && !s.hasPoster)
    .slice(0, SHOW_ENRICH_LIMIT);

  try {
    await runWithLimit(missingPosters, SHOW_ENRICH_CONCURRENCY, async item => {
      const details = await getShowDetails(item.id);
      if (!details?.id || details.result === "KO") return;

      const poster = details.poster || details.image || details.cover || "";
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
  console.log("[TV] Login:", JSON.stringify(d).substring(0, 200));
  if (d.result === "KO") throw new Error(d.message || "Login failed");
  if (!d.id) throw new Error("No user ID");

  await authStore().set({
    auth: h,
    uid: d.id,
    bearer: d.tvst_access_token || d.access_token || "",
  });
  if (hasSessionStore()) {
    await chrome.storage.local.remove(LEGACY_AUTH_KEYS);
  }

  return { success: true, userId: d.id };
}

async function checkAuth() {
  const a = await getAuth();
  return a ? { authenticated: true, userId: a.uid } : { authenticated: false };
}

async function logout() {
  await clearAuthStorage();
  return { success: true };
}

// ========== MY SHOWS ==========
async function getWatchingShows() {
  const a = await getAuth();
  if (!a) throw new Error("NOT_LOGGED_IN");

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
        console.log(`[TV] ✓ ${enriched.length} shows`);
        return { shows: enriched };
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

  const endpoints = [
    `/user/${a.uid}/to_watch`,
    `/user/${a.uid}?fields=to_watch.limit(-1)`,
    "/to_watch",
    `/user/${a.uid}/up_next`,
    `/user/${a.uid}?fields=up_next.limit(-1)`,
    "/up_next",
    `/user/${a.uid}?fields=next_episodes.limit(-1)`,
  ];

  let lastError = null;
  for (const ep of endpoints) {
    try {
      const d = await req(ep, { timeout: 10000 });
      const episodes = normalizeEpisodeList(d);
      if (episodes.length > 0) {
        const enriched = await enrichUpNextEpisodes(episodes);
        const withPoster = enriched.filter(item => Boolean(item.poster)).length;
        console.log(`[TV] ✓ up next ${enriched.length} episodes (${ep}) posters:${withPoster}`);
        return { episodes: enriched };
      }
    } catch (e) {
      if (e.message === "NOT_LOGGED_IN" || e.message === "AUTH_EXPIRED") throw e;
      lastError = e;
    }
  }

  // Fallback when API endpoint is sparse but tracked shows contain next episode.
  try {
    const watching = await getWatchingShows();
    const derived = deriveUpNextFromShows(watching.shows);
    if (derived.length > 0) {
      console.log(`[TV] ✓ derived up next ${derived.length} episodes from tracked shows`);
      return { episodes: derived, derived: true };
    }
  } catch (e) {
    if (e.message === "NOT_LOGGED_IN" || e.message === "AUTH_EXPIRED") throw e;
  }

  if (lastError) {
    console.log(`[TV] up next fallback empty after error: ${lastError.message}`);
  }

  return { episodes: [], empty: true };
}

// ========== SHOW DETAIL ==========
async function getShowDetails(id) {
  const sid = String(id || "");
  if (!sid) return { error: "not_found" };
  if (showDetailsCache.has(sid)) return showDetailsCache.get(sid);

  for (const ep of [`/show/${sid}`, `/series/${sid}`]) {
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

async function getShowSeasons(id) {
  const a = await getAuth();
  if (!a) throw new Error("NOT_LOGGED_IN");

  const endpoints = [
    `/user/${a.uid}/show/${id}/seasons`,
    `/user/${a.uid}/series/${id}/seasons`,
    `/user/${a.uid}/shows/${id}/seasons`,
    `/user/${a.uid}/show/${id}`,
    `/user/${a.uid}/series/${id}`,
    `/show/${id}/seasons`,
    `/series/${id}/seasons`,
    `/show/${id}`,
    `/series/${id}`,
  ];

  const bySeason = new Map();
  for (const ep of endpoints) {
    try {
      const d = await req(ep);
      const seasons = normalizeSeasons(d);
      if (!seasons?.length) continue;
      for (const season of seasons) {
        const num = parsePositiveInt(season.number || season.season_number, 0);
        if (!num) continue;
        const prev = bySeason.get(num) || {};
        bySeason.set(num, {
          ...prev,
          ...season,
          number: num,
          season_number: num,
          // Keep the best progress signal seen across endpoints.
          seen_episodes: Math.max(
            parsePositiveInt(prev.seen_episodes, 0),
            parsePositiveInt(season.seen_episodes, 0)
          ),
          nb_episodes: Math.max(
            parsePositiveInt(prev.nb_episodes ?? prev.episode_count, 0),
            parsePositiveInt(season.nb_episodes ?? season.episode_count, 0)
          ),
        });
      }
    } catch (e) {
      if (e.message === "NOT_LOGGED_IN" || e.message === "AUTH_EXPIRED") throw e;
    }
  }

  const seasons = Array.from(bySeason.values())
    .sort((a, b) => a.number - b.number);
  return { seasons };
}

async function getSeasonEpisodes(showId, seasonNum) {
  const a = await getAuth();
  if (!a) throw new Error("NOT_LOGGED_IN");

  const n = parsePositiveInt(seasonNum, 0);
  if (!n) return { episodes: [] };

  const endpoints = [
    `/user/${a.uid}/show/${showId}/season/${n}/episodes`,
    `/user/${a.uid}/series/${showId}/season/${n}/episodes`,
    `/user/${a.uid}/show/${showId}/seasons/${n}/episodes`,
    `/user/${a.uid}/series/${showId}/seasons/${n}/episodes`,
    `/user/${a.uid}/shows/${showId}/season/${n}/episodes`,
    `/user/${a.uid}/shows/${showId}/seasons/${n}/episodes`,
    `/user/${a.uid}/show/${showId}/episodes`,
    `/user/${a.uid}/series/${showId}/episodes`,
    `/user/${a.uid}/shows/${showId}/episodes`,
    `/user/${a.uid}/show/${showId}/episodes?season=${n}`,
    `/user/${a.uid}/series/${showId}/episodes?season=${n}`,
    `/user/${a.uid}/shows/${showId}/episodes?season=${n}`,
    `/user/${a.uid}/show/${showId}?fields=seasons.limit(-1)`,
    `/user/${a.uid}/series/${showId}?fields=seasons.limit(-1)`,
    `/show/${showId}/season/${n}/episodes`,
    `/series/${showId}/season/${n}/episodes`,
    `/show/${showId}/seasons/${n}/episodes`,
    `/series/${showId}/seasons/${n}/episodes`,
    `/show/${showId}/season/${n}/episodes?fields=episodes.fields(id,episode_id,name,title,number,episode_number,season_number,air_date,is_watched,seen,seen_date)`,
    `/series/${showId}/season/${n}/episodes?fields=episodes.fields(id,episode_id,name,title,number,episode_number,season_number,air_date,is_watched,seen,seen_date)`,
    `/show/${showId}/season/${n}`,
    `/series/${showId}/season/${n}`,
    `/show/${showId}`,
    `/series/${showId}`,
  ];

  const byEpisode = new Map();
  for (const ep of endpoints) {
    try {
      const d = await req(ep);
      let episodes = episodesFromSeasonPayload(d, n);

      // Some endpoints return whole-show episode arrays.
      if (!episodes.length) {
        const allEpisodes = normalizeEpisodeList(d);
        if (allEpisodes.length) {
          episodes = allEpisodes.filter(item => {
            const sn = parsePositiveInt(item.season_number ?? item.season?.number ?? item.season, 0);
            return sn === n;
          });
        }
      }
      if (!episodes?.length) continue;

      for (const item of episodes) {
        const key = episodeKey(item, n);
        if (!key) continue;
        const prev = byEpisode.get(key) || {};
        byEpisode.set(key, mergeEpisode(prev, item, n));
      }
    } catch (e) {
      if (e.message === "NOT_LOGGED_IN" || e.message === "AUTH_EXPIRED") throw e;
    }
  }

  const merged = Array.from(byEpisode.values())
    .sort((a, b) => parsePositiveInt(a.number ?? a.episode_number, 0) - parsePositiveInt(b.number ?? b.episode_number, 0));
  return { episodes: merged };
}

// ========== API INSPECTOR / API LAB ==========
function nowMs() {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

function payloadSnapshot(payload) {
  const shows = normalizeShowList(payload);
  const episodes = normalizeEpisodeList(payload);
  const seasons = normalizeSeasons(payload);
  return {
    topKeys: topLevelKeys(payload),
    counts: {
      shows: shows.length,
      episodes: episodes.length,
      seasons: seasons.length,
    },
    sampleKeys: {
      show: sampleObjectKeys(shows),
      episode: sampleObjectKeys(episodes),
      season: sampleObjectKeys(seasons),
    },
  };
}

function serializeProbeBody(body) {
  if (body === undefined) return "";
  try {
    return JSON.stringify(body);
  } catch {
    return String(body);
  }
}

function dedupeProbes(probes) {
  const seen = new Set();
  const out = [];
  for (const probe of probes) {
    const endpoint = probe.url || probe.path || "";
    const key = `${probe.method || "GET"}|${endpoint}|${serializeProbeBody(probe.body)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(probe);
  }
  return out;
}

async function fetchAuthorizedDetailed(path, opts = {}) {
  const a = await getAuth();
  if (!a) throw new Error("NOT_LOGGED_IN");

  const {
    timeout = 15000,
    method = "GET",
    headers = {},
    body,
    forceBasic = false,
  } = opts;

  const url = path.startsWith("http") ? path : `${API}${path}`;
  const authHeaders = authHeadersForRequest(a, forceBasic);
  if (!authHeaders.length) throw new Error("NOT_LOGGED_IN");

  const isObjBody = body && typeof body === "object" && !(body instanceof FormData);
  const requestBody = isObjBody ? JSON.stringify(body) : body;

  for (let i = 0; i < authHeaders.length; i++) {
    const authorization = authHeaders[i];
    const r = await fetchT(url, {
      method,
      headers: {
        Authorization: authorization,
        "User-Agent": "TVTime Wrapper",
        ...(isObjBody ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      ...(requestBody !== undefined ? { body: requestBody } : {}),
    }, timeout);
    const text = await r.text();
    const payload = parseJSON(text);

    if ((r.status === 401 || r.status === 403) && i < authHeaders.length - 1) {
      continue;
    }
    if (r.status === 401 || r.status === 403) {
      await clearAuthStorage();
      throw new Error("AUTH_EXPIRED");
    }

    return {
      status: r.status,
      payload,
      text,
      url,
      method,
    };
  }

  await clearAuthStorage();
  throw new Error("AUTH_EXPIRED");
}

function normalizeProbeResult(result) {
  const normalized = {
    ...result,
    durationMs: Math.max(0, Math.round(Number(result.durationMs) || 0)),
  };
  normalized.ok = normalized.outcome === "ok" || normalized.outcome === "reachable";
  return normalized;
}

function inspectModeFromProbe(probe) {
  if (probe.kind === "mutation") {
    return probe.safeRouteCheck ? "safe-route" : "live";
  }
  return "read";
}

async function runProbeDetailed(probe, timeout = 12000) {
  if (probe.skipReason) {
    return normalizeProbeResult({
      endpoint: probe.url || probe.path || "",
      method: probe.method || "GET",
      group: probe.group || "misc",
      kind: probe.kind || "read",
      mode: inspectModeFromProbe(probe),
      status: 0,
      durationMs: 0,
      outcome: "skipped",
      error: probe.skipReason,
      topKeys: [],
      counts: { shows: 0, episodes: 0, seasons: 0 },
      sampleKeys: { show: [], episode: [], season: [] },
    });
  }

  const start = nowMs();
  const endpoint = probe.url || probe.path || "";
  try {
    let status = 0;
    let payload = null;
    if (probe.public) {
      const r = await fetchT(endpoint, { headers: { "User-Agent": "TVTime Wrapper" } }, timeout);
      const text = await r.text();
      payload = parseJSON(text);
      status = r.status;
    } else {
      const res = await fetchAuthorizedDetailed(probe.path, {
        method: probe.method || "GET",
        body: probe.body,
        timeout,
      });
      payload = res.payload;
      status = res.status;
    }

    const snapshot = payloadSnapshot(payload);
    const payloadKo = payload && typeof payload === "object" && payload.result === "KO";
    const payloadError = payloadKo ? String(payload.message || payload.error || "KO") : "";
    let outcome = status >= 200 && status < 300 && !payloadKo ? "ok" : "error";
    if (probe.kind === "mutation" && probe.safeRouteCheck && API_LAB_EXPECTED_MUTATION_STATUSES.has(status)) {
      outcome = "reachable";
    }

    return normalizeProbeResult({
      endpoint,
      method: probe.method || "GET",
      group: probe.group || "misc",
      kind: probe.kind || "read",
      mode: inspectModeFromProbe(probe),
      status,
      durationMs: nowMs() - start,
      outcome,
      ...(payloadError ? { error: payloadError } : {}),
      topKeys: snapshot.topKeys,
      counts: snapshot.counts,
      sampleKeys: snapshot.sampleKeys,
      body: probe.body !== undefined ? serializeProbeBody(probe.body) : "",
    });
  } catch (e) {
    return normalizeProbeResult({
      endpoint,
      method: probe.method || "GET",
      group: probe.group || "misc",
      kind: probe.kind || "read",
      mode: inspectModeFromProbe(probe),
      status: 0,
      durationMs: nowMs() - start,
      outcome: "error",
      error: e.message || "UNKNOWN_ERROR",
      topKeys: [],
      counts: { shows: 0, episodes: 0, seasons: 0 },
      sampleKeys: { show: [], episode: [], season: [] },
      body: probe.body !== undefined ? serializeProbeBody(probe.body) : "",
    });
  }
}

function summarizeProbeResults(results) {
  const summary = {
    total: results.length,
    ok: 0,
    reachable: 0,
    error: 0,
    skipped: 0,
    avgLatencyMs: 0,
    statusHistogram: {},
    byGroup: {},
  };
  let latencySum = 0;
  let latencyCount = 0;

  for (const probe of results) {
    if (probe.outcome === "ok") summary.ok += 1;
    else if (probe.outcome === "reachable") summary.reachable += 1;
    else if (probe.outcome === "skipped") summary.skipped += 1;
    else summary.error += 1;

    if (probe.status > 0) {
      const key = String(probe.status);
      summary.statusHistogram[key] = (summary.statusHistogram[key] || 0) + 1;
    }

    if (probe.durationMs > 0) {
      latencySum += probe.durationMs;
      latencyCount += 1;
    }

    const group = probe.group || "misc";
    if (!summary.byGroup[group]) {
      summary.byGroup[group] = { total: 0, ok: 0, reachable: 0, error: 0, skipped: 0 };
    }
    const bucket = summary.byGroup[group];
    bucket.total += 1;
    if (probe.outcome === "ok") bucket.ok += 1;
    else if (probe.outcome === "reachable") bucket.reachable += 1;
    else if (probe.outcome === "skipped") bucket.skipped += 1;
    else bucket.error += 1;
  }

  summary.avgLatencyMs = latencyCount ? Math.round(latencySum / latencyCount) : 0;
  return summary;
}

async function resolveApiLabContext(authUserId) {
  const context = {
    uid: String(authUserId || ""),
    sampleShowId: "",
    sampleEpisodeId: "",
    sampleSeasonNumber: 1,
  };

  try {
    const watching = await getWatchingShows();
    context.sampleShowId = String(showId((watching.shows || [])[0]) || "");
  } catch {}

  try {
    const upNext = await getUpNext();
    const first = (normalizeEpisodeList(upNext) || [])[0] || {};
    context.sampleEpisodeId = String(first.id || first.episode_id || "");
    const fromEpisode = String(
      first.show_id ||
      first.series_id ||
      first.show?.id ||
      first.show?.series_id ||
      ""
    );
    if (!context.sampleShowId && fromEpisode) {
      context.sampleShowId = fromEpisode;
    }
    const season = parsePositiveInt(
      first.season_number ?? first.season?.number ?? first.season,
      1
    );
    if (season > 0) context.sampleSeasonNumber = season;
  } catch {}

  return context;
}

function buildReadProbes(uid, context, query = "game") {
  const q = encodeURIComponent(query || "game");
  const sid = encodeURIComponent(context.sampleShowId || API_LAB_SAFE_SHOW_ID);
  const n = parsePositiveInt(context.sampleSeasonNumber, 1) || 1;

  return dedupeProbes([
    { kind: "read", group: "account", method: "GET", path: `/user/${uid}` },
    { kind: "read", group: "account", method: "GET", path: `/user/${uid}?fields=shows.fields(id,series_id,name,title,poster,image,is_following,is_followed).limit(-1)` },
    { kind: "read", group: "account", method: "GET", path: `/user/${uid}?fields=shows.limit(-1)` },
    { kind: "read", group: "account", method: "GET", path: `/user/${uid}?fields=to_watch.limit(-1)` },
    { kind: "read", group: "account", method: "GET", path: `/user/${uid}?fields=up_next.limit(-1)` },
    { kind: "read", group: "account", method: "GET", path: `/user/${uid}?fields=next_episodes.limit(-1)` },
    { kind: "read", group: "upnext", method: "GET", path: `/user/${uid}/to_watch` },
    { kind: "read", group: "upnext", method: "GET", path: `/user/${uid}/up_next` },
    { kind: "read", group: "upnext", method: "GET", path: "/to_watch" },
    { kind: "read", group: "upnext", method: "GET", path: "/up_next" },
    { kind: "read", group: "search", method: "GET", path: `/show/search?q=${q}` },
    { kind: "read", group: "search", method: "GET", path: `/search?q=${q}` },
    { kind: "read", group: "search", method: "GET", path: `/series/search?q=${q}` },
    { kind: "read", group: "search", method: "GET", path: `/search/shows?q=${q}` },
    { kind: "read", group: "search", method: "GET", public: true, url: `https://msearch.tvtime.com/v1/search?q=${q}&limit=5` },
    { kind: "read", group: "show", method: "GET", path: `/show/${sid}` },
    { kind: "read", group: "show", method: "GET", path: `/series/${sid}` },
    { kind: "read", group: "show", method: "GET", path: `/show/${sid}/seasons` },
    { kind: "read", group: "show", method: "GET", path: `/series/${sid}/seasons` },
    { kind: "read", group: "show", method: "GET", path: `/user/${uid}/show/${sid}/seasons` },
    { kind: "read", group: "show", method: "GET", path: `/user/${uid}/series/${sid}/seasons` },
    { kind: "read", group: "show", method: "GET", path: `/user/${uid}/shows/${sid}/seasons` },
    { kind: "read", group: "show", method: "GET", path: `/user/${uid}/show/${sid}` },
    { kind: "read", group: "show", method: "GET", path: `/user/${uid}/series/${sid}` },
    { kind: "read", group: "season", method: "GET", path: `/user/${uid}/show/${sid}/season/${n}/episodes` },
    { kind: "read", group: "season", method: "GET", path: `/user/${uid}/series/${sid}/season/${n}/episodes` },
    { kind: "read", group: "season", method: "GET", path: `/user/${uid}/show/${sid}/seasons/${n}/episodes` },
    { kind: "read", group: "season", method: "GET", path: `/user/${uid}/series/${sid}/seasons/${n}/episodes` },
    { kind: "read", group: "season", method: "GET", path: `/user/${uid}/shows/${sid}/season/${n}/episodes` },
    { kind: "read", group: "season", method: "GET", path: `/user/${uid}/shows/${sid}/seasons/${n}/episodes` },
    { kind: "read", group: "season", method: "GET", path: `/user/${uid}/show/${sid}/episodes` },
    { kind: "read", group: "season", method: "GET", path: `/user/${uid}/series/${sid}/episodes` },
    { kind: "read", group: "season", method: "GET", path: `/user/${uid}/shows/${sid}/episodes` },
    { kind: "read", group: "season", method: "GET", path: `/user/${uid}/show/${sid}/episodes?season=${n}` },
    { kind: "read", group: "season", method: "GET", path: `/user/${uid}/series/${sid}/episodes?season=${n}` },
    { kind: "read", group: "season", method: "GET", path: `/user/${uid}/shows/${sid}/episodes?season=${n}` },
    { kind: "read", group: "season", method: "GET", path: `/user/${uid}/show/${sid}?fields=seasons.limit(-1)` },
    { kind: "read", group: "season", method: "GET", path: `/user/${uid}/series/${sid}?fields=seasons.limit(-1)` },
    { kind: "read", group: "season", method: "GET", path: `/show/${sid}/season/${n}/episodes` },
    { kind: "read", group: "season", method: "GET", path: `/series/${sid}/season/${n}/episodes` },
    { kind: "read", group: "season", method: "GET", path: `/show/${sid}/seasons/${n}/episodes` },
    { kind: "read", group: "season", method: "GET", path: `/series/${sid}/seasons/${n}/episodes` },
    { kind: "read", group: "season", method: "GET", path: `/show/${sid}/season/${n}/episodes?fields=episodes.fields(id,episode_id,name,title,number,episode_number,season_number,air_date,is_watched,seen,seen_date)` },
    { kind: "read", group: "season", method: "GET", path: `/series/${sid}/season/${n}/episodes?fields=episodes.fields(id,episode_id,name,title,number,episode_number,season_number,air_date,is_watched,seen,seen_date)` },
    { kind: "read", group: "season", method: "GET", path: `/show/${sid}/season/${n}` },
    { kind: "read", group: "season", method: "GET", path: `/series/${sid}/season/${n}` },
  ]);
}

function mutationMatrixForAudit(encodedShowId, encodedEpisodeId) {
  return [
    {
      group: "mutation-episode",
      path: `/episodes/${encodedEpisodeId}/watched`,
      methods: ["PUT", "POST"],
      bodies: [undefined, { watched: true }, { is_watched: true }, { seen: true }],
    },
    {
      group: "mutation-episode",
      path: `/episode/${encodedEpisodeId}/watched`,
      methods: ["PUT", "POST"],
      bodies: [undefined, { watched: true }, { is_watched: true }, { seen: true }],
    },
    {
      group: "mutation-episode",
      path: `/episodes/${encodedEpisodeId}/seen`,
      methods: ["PUT", "POST"],
      bodies: [undefined, { seen: true }, { is_watched: true }],
    },
    {
      group: "mutation-episode",
      path: `/episode/${encodedEpisodeId}/seen`,
      methods: ["PUT", "POST"],
      bodies: [undefined, { seen: true }, { is_watched: true }],
    },
    {
      group: "mutation-episode",
      path: `/episodes/${encodedEpisodeId}/watched`,
      methods: ["DELETE"],
      bodies: [undefined],
    },
    {
      group: "mutation-episode",
      path: `/episode/${encodedEpisodeId}/watched`,
      methods: ["DELETE"],
      bodies: [undefined],
    },
    {
      group: "mutation-episode",
      path: `/episodes/${encodedEpisodeId}/seen`,
      methods: ["DELETE", "POST", "PUT"],
      bodies: [undefined, { seen: false }, { is_watched: false }],
    },
    {
      group: "mutation-episode",
      path: `/episode/${encodedEpisodeId}/seen`,
      methods: ["DELETE", "POST", "PUT"],
      bodies: [undefined, { seen: false }, { is_watched: false }],
    },
    {
      group: "mutation-show",
      path: `/show/${encodedShowId}/follow`,
      methods: ["PUT", "POST"],
      bodies: [undefined],
    },
    {
      group: "mutation-show",
      path: `/series/${encodedShowId}/follow`,
      methods: ["PUT", "POST"],
      bodies: [undefined],
    },
    {
      group: "mutation-show",
      path: `/show/${encodedShowId}/following`,
      methods: ["PUT", "POST"],
      bodies: [undefined, { following: true }, { is_following: true }],
    },
    {
      group: "mutation-show",
      path: `/series/${encodedShowId}/following`,
      methods: ["PUT", "POST"],
      bodies: [undefined, { following: true }, { is_following: true }],
    },
    {
      group: "mutation-show",
      path: `/show/${encodedShowId}/follow`,
      methods: ["DELETE"],
      bodies: [undefined],
    },
    {
      group: "mutation-show",
      path: `/series/${encodedShowId}/follow`,
      methods: ["DELETE"],
      bodies: [undefined],
    },
    {
      group: "mutation-show",
      path: `/show/${encodedShowId}/following`,
      methods: ["DELETE", "POST", "PUT"],
      bodies: [undefined, { following: false }, { is_following: false }],
    },
    {
      group: "mutation-show",
      path: `/series/${encodedShowId}/following`,
      methods: ["DELETE", "POST", "PUT"],
      bodies: [undefined, { following: false }, { is_following: false }],
    },
  ];
}

function buildMutationProbes(context, options = {}) {
  if (options.includeMutationRoutes === false) {
    return { probes: [], mode: "disabled", notes: ["Mutation route checks disabled by user option."] };
  }

  const notes = [];
  let mode = options.mutationMode === "live" ? "live" : "safe";
  let showId = String(context.sampleShowId || "");
  let episodeId = String(context.sampleEpisodeId || "");

  if (mode === "live" && (!showId || !episodeId)) {
    notes.push("Live mutation mode requested but sample IDs were missing. Falling back to safe mode.");
    mode = "safe";
  }

  if (mode === "safe") {
    showId = API_LAB_SAFE_SHOW_ID;
    episodeId = API_LAB_SAFE_EPISODE_ID;
    notes.push("Safe mutation mode uses placeholder IDs to avoid changing your account state.");
  }

  const sid = encodeURIComponent(showId || API_LAB_SAFE_SHOW_ID);
  const eid = encodeURIComponent(episodeId || API_LAB_SAFE_EPISODE_ID);
  const templates = mutationMatrixForAudit(sid, eid);
  const probes = [];
  for (const template of templates) {
    const methods = template.methods?.length ? template.methods : ["POST"];
    const bodies = template.bodies?.length ? template.bodies : [undefined];
    for (const method of methods) {
      for (const body of bodies) {
        probes.push({
          kind: "mutation",
          group: template.group,
          method,
          path: template.path,
          body,
          safeRouteCheck: mode !== "live",
        });
      }
    }
  }
  return { probes: dedupeProbes(probes), mode, notes };
}

async function inspectEndpoint(path, timeout = 12000) {
  const probe = path.startsWith("https://")
    ? { kind: "read", group: "inspect", method: "GET", public: true, url: path }
    : { kind: "read", group: "inspect", method: "GET", path };
  const result = await runProbeDetailed(probe, timeout);
  if (result.outcome === "error" || result.outcome === "skipped") {
    return {
      endpoint: path,
      ok: false,
      status: result.status,
      durationMs: result.durationMs,
      error: result.error || "UNKNOWN_ERROR",
    };
  }
  return {
    endpoint: path,
    ok: true,
    status: result.status,
    durationMs: result.durationMs,
    topKeys: result.topKeys,
    counts: result.counts,
    sampleKeys: result.sampleKeys,
  };
}

async function inspectApiSurface() {
  const a = await getAuth();
  if (!a) throw new Error("NOT_LOGGED_IN");

  const probes = [
    `/user/${a.uid}`,
    `/user/${a.uid}?fields=shows.limit(-1)`,
    `/user/${a.uid}?fields=to_watch.limit(-1)`,
    `/user/${a.uid}?fields=up_next.limit(-1)`,
    `/user/${a.uid}/to_watch`,
    `/user/${a.uid}/up_next`,
    "/to_watch",
    "/up_next",
    "/search?q=game",
    "/show/search?q=game",
    "https://msearch.tvtime.com/v1/search?q=game&limit=3",
  ];

  let sampleShowId = "";
  try {
    const watching = await getWatchingShows();
    sampleShowId = String(showId((watching.shows || [])[0]) || "");
  } catch {}

  if (sampleShowId) {
    probes.push(`/show/${sampleShowId}`);
    probes.push(`/show/${sampleShowId}/seasons`);
    probes.push(`/show/${sampleShowId}/season/1/episodes`);
    probes.push(`/user/${a.uid}/show/${sampleShowId}/seasons`);
    probes.push(`/user/${a.uid}/show/${sampleShowId}/season/1/episodes`);
    probes.push(`/user/${a.uid}/show/${sampleShowId}/episodes`);
  }

  const results = [];
  for (const path of probes) {
    results.push(await inspectEndpoint(path));
  }

  return {
    generatedAt: new Date().toISOString(),
    userId: a.uid,
    sampleShowId,
    probes: results,
  };
}

async function runApiLab(options = {}) {
  const a = await getAuth();
  if (!a) throw new Error("NOT_LOGGED_IN");

  const timeout = Math.max(4000, Math.min(parsePositiveInt(options.timeout, 12000), 30000));
  const concurrency = Math.max(1, Math.min(parsePositiveInt(options.concurrency, 4), 8));
  const query = String(options.query || "game").trim() || "game";

  const context = await resolveApiLabContext(a.uid);
  const readProbes = buildReadProbes(a.uid, context, query);
  const mutationPlan = buildMutationProbes(context, {
    includeMutationRoutes: options.includeMutationRoutes !== false,
    mutationMode: options.mutationMode,
  });
  const allProbes = dedupeProbes([...readProbes, ...mutationPlan.probes]);

  const indexed = allProbes.map((probe, index) => ({ probe, index }));
  const results = new Array(indexed.length);
  await runWithLimit(indexed, concurrency, async item => {
    results[item.index] = await runProbeDetailed(item.probe, timeout);
  });

  const sorted = results.slice().sort((a, b) => {
    if ((a.group || "") !== (b.group || "")) return String(a.group || "").localeCompare(String(b.group || ""));
    if ((a.endpoint || "") !== (b.endpoint || "")) return String(a.endpoint || "").localeCompare(String(b.endpoint || ""));
    return String(a.method || "").localeCompare(String(b.method || ""));
  });

  return {
    generatedAt: new Date().toISOString(),
    userId: a.uid,
    options: {
      includeMutationRoutes: options.includeMutationRoutes !== false,
      mutationMode: mutationPlan.mode,
      timeout,
      concurrency,
      query,
    },
    context,
    notes: mutationPlan.notes,
    summary: summarizeProbeResults(sorted),
    probes: sorted,
  };
}

// ========== EPISODE ACTIONS ==========
async function markWatched(episodeId) {
  const rawId = String(episodeId || "").trim();
  const id = encodeURIComponent(rawId);
  if (!id) throw new Error("INVALID_EPISODE_ID");

  return runMutationCandidates([
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
}

async function markUnwatched(episodeId) {
  const rawId = String(episodeId || "").trim();
  const id = encodeURIComponent(rawId);
  if (!id) throw new Error("INVALID_EPISODE_ID");

  return runMutationCandidates([
    { path: `/episodes/${id}/watched`, methods: ["DELETE"] },
    { path: `/episode/${id}/watched`, methods: ["DELETE"] },
    { path: `/episodes/${id}/seen`, methods: ["DELETE", "POST", "PUT"], bodies: [undefined, { seen: false }, { is_watched: false }] },
    { path: `/episode/${id}/seen`, methods: ["DELETE", "POST", "PUT"], bodies: [undefined, { seen: false }, { is_watched: false }] },
  ]);
}

// ========== SEARCH ==========
async function searchShows(query) {
  const q = encodeURIComponent(query);

  // 1) msearch
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
      if (arr.length > 0) return { results: arr, remote: "msearch" };
    }
  } catch {}

  // 2) API search endpoints
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
        if (arr.length > 0) return { results: arr, remote: "api" };
      }
    } catch (e) {
      if (e.message === "NOT_LOGGED_IN" || e.message === "AUTH_EXPIRED") throw e;
    }
  }

  // 3) Local search fallback against tracked shows
  try {
    const showsResult = await getWatchingShows();
    if (showsResult.shows?.length > 0) {
      const ql = query.toLowerCase();
      const matches = showsResult.shows.filter(s => (s.name || s.title || "").toLowerCase().includes(ql));
      if (matches.length > 0) return { results: matches, local: true };
    }
  } catch {}

  return { results: [] };
}

// ========== FOLLOW ==========
async function followShow(id) {
  const rawSid = String(id || "").trim();
  const sid = encodeURIComponent(rawSid);
  if (!sid) throw new Error("INVALID_SHOW_ID");

  return runMutationCandidates([
    { path: `/show/${sid}/follow`, methods: ["PUT", "POST"] },
    { path: `/series/${sid}/follow`, methods: ["PUT", "POST"] },
    { path: `/show/${sid}/following`, methods: ["PUT", "POST"], bodies: [undefined, { following: true }, { is_following: true }] },
    { path: `/series/${sid}/following`, methods: ["PUT", "POST"], bodies: [undefined, { following: true }, { is_following: true }] },
  ]);
}

async function unfollowShow(id) {
  const rawSid = String(id || "").trim();
  const sid = encodeURIComponent(rawSid);
  if (!sid) throw new Error("INVALID_SHOW_ID");

  return runMutationCandidates([
    { path: `/show/${sid}/follow`, methods: ["DELETE"] },
    { path: `/series/${sid}/follow`, methods: ["DELETE"] },
    { path: `/show/${sid}/following`, methods: ["DELETE", "POST", "PUT"], bodies: [undefined, { following: false }, { is_following: false }] },
    { path: `/series/${sid}/following`, methods: ["DELETE", "POST", "PUT"], bodies: [undefined, { following: false }, { is_following: false }] },
  ]);
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
        case "inspectApi": return await inspectApiSurface();
        case "runApiLab": return await runApiLab(request.options || {});
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

console.log("[TV] SW v5 loaded");
