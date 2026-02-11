// ============================================================
// TV Time Quick Tracker - Popup v5
// ============================================================

const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);

let currentTab = "up-next";
let showsCache = null;
let upNextCache = null;
let searchTimeout = null;
let detailRequestId = 0;
const seasonEpisodesCache = new Map();

// ========== INIT ==========
document.addEventListener("DOMContentLoaded", () => {
  setupEvents();
  checkAuthAndRoute();
});

function setupEvents() {
  $("#login-form").addEventListener("submit", handleLogin);
  $$(".tab").forEach(t => t.addEventListener("click", () => switchTab(t.dataset.tab)));
  $("#refresh-btn").addEventListener("click", refreshCurrentTab);
  $("#logout-btn").addEventListener("click", handleLogout);
  $("#search-input").addEventListener("input", handleSearchInput);
  $("#detail-back").addEventListener("click", closeShowDetail);
}

function closeShowDetail() {
  detailRequestId += 1;
  $("#show-detail").classList.add("hidden");
}

// ========== AUTH ==========
async function checkAuthAndRoute() {
  const r = await msg({ action: "checkAuth" });
  if (r.authenticated) {
    showScreen("main-screen");
    loadUpNext();
  } else {
    showScreen("login-screen");
  }
}

async function handleLogin(e) {
  e.preventDefault();
  const btn = $("#login-btn");
  const err = $("#login-error");
  btn.querySelector(".btn-text").classList.add("hidden");
  btn.querySelector(".btn-loader").classList.remove("hidden");
  err.classList.add("hidden");
  btn.disabled = true;

  try {
    const r = await Promise.race([
      msg({ action: "login", username: $("#email").value.trim(), password: $("#password").value }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("TIMEOUT")), 20000)),
    ]);
    if (r.error) throw new Error(r.error);
    if (r.success) {
      showScreen("main-screen");
      loadUpNext();
      return;
    }
    throw new Error("Unexpected response");
  } catch (ex) {
    err.textContent = ex.message.includes("TIMEOUT")
      ? "Connection timed out."
      : `Error: ${ex.message}`;
    err.classList.remove("hidden");
  } finally {
    btn.querySelector(".btn-text").classList.remove("hidden");
    btn.querySelector(".btn-loader").classList.add("hidden");
    btn.disabled = false;
  }
}

async function handleLogout() {
  await msg({ action: "logout" });
  showsCache = null;
  upNextCache = null;
  seasonEpisodesCache.clear();
  closeShowDetail();
  showScreen("login-screen");
}

// ========== NAV ==========
function showScreen(id) {
  $$(".screen").forEach(s => s.classList.add("hidden"));
  $(`#${id}`).classList.remove("hidden");
}

function switchTab(id) {
  currentTab = id;
  $$(".tab").forEach(t => t.classList.remove("active"));
  $(`.tab[data-tab="${id}"]`).classList.add("active");
  $$(".tab-pane").forEach(p => p.classList.remove("active"));
  $(`#tab-${id}`).classList.add("active");

  if (id === "up-next" && !upNextCache) loadUpNext();
  if (id === "my-shows" && !showsCache) loadMyShows();
  if (id === "search") $("#search-input").focus();
}

async function refreshCurrentTab() {
  const btn = $("#refresh-btn");
  btn.classList.add("spinning");
  setTimeout(() => btn.classList.remove("spinning"), 600);
  if (currentTab === "up-next") {
    upNextCache = null;
    await loadUpNext();
  } else if (currentTab === "my-shows") {
    showsCache = null;
    await loadMyShows();
  }
}

// ========== UP NEXT ==========
async function loadUpNext() {
  const c = $("#up-next-list");
  c.innerHTML = stateHTML("loading", "Loading episodes...");

  try {
    const r = await msg({ action: "getUpNext" });
    if (r.error) {
      if (r.error === "AUTH_EXPIRED") return checkAuthAndRoute();
      throw new Error(r.error);
    }
    const episodes = extractEpisodes(r);
    upNextCache = episodes;

    if (!episodes.length) {
      c.innerHTML = stateHTML("empty", "No episodes up next", "You're all caught up! 🎉");
      return;
    }
    c.innerHTML = episodes.map(episodeCardHTML).join("");
    bindImageFallbacks(c);
    c.querySelectorAll(".episode-card").forEach(card =>
      card.addEventListener("click", () => {
        if (card.dataset.sid) {
          openShowDetail(card.dataset.sid, card.dataset.sname);
        }
      })
    );
    c.querySelectorAll(".watch-btn").forEach(btn =>
      btn.addEventListener("click", e => {
        e.stopPropagation();
        toggleWatch(btn, btn.dataset.eid);
      })
    );
  } catch {
    c.innerHTML = stateHTML("error", "Couldn't load episodes", "Try refreshing");
  }
}

// ========== MY SHOWS ==========
async function loadMyShows() {
  const c = $("#my-shows-list");
  c.innerHTML = stateHTML("loading", "Loading shows...");

  try {
    const r = await msg({ action: "getWatchingShows" });
    if (r.error) {
      if (r.error === "AUTH_EXPIRED") return checkAuthAndRoute();
      throw new Error(r.error);
    }
    const shows = extractShows(r);
    showsCache = shows;

    if (!shows.length) {
      c.innerHTML = stateHTML("empty", "No shows yet", "Search and add shows to track");
      return;
    }
    c.innerHTML = `<div class="shows-grid">${shows.map(showCardHTML).join("")}</div>`;
    bindImageFallbacks(c);
    c.querySelectorAll(".show-card").forEach(card =>
      card.addEventListener("click", () => openShowDetail(card.dataset.sid, card.dataset.sname))
    );
  } catch {
    c.innerHTML = stateHTML("error", "Couldn't load shows", "Try refreshing");
  }
}

// ========== SEARCH ==========
function handleSearchInput(e) {
  const q = e.target.value.trim();
  clearTimeout(searchTimeout);
  if (q.length < 2) {
    $("#search-results").innerHTML = stateHTML("empty", "Search for a TV show");
    return;
  }
  $("#search-results").innerHTML = stateHTML("loading", "Searching...");

  searchTimeout = setTimeout(async () => {
    try {
      const r = await msg({ action: "searchShows", query: q });
      if (r.error) throw new Error(r.error);

      let shows = extractSearchResults(r);
      if (r.local) {
        shows = shows.map(show => ({ ...show, following: true }));
      }
      if (!shows.length) {
        $("#search-results").innerHTML = stateHTML("empty", `No results for "${esc(q)}"`);
        return;
      }

      const header = r.local
        ? '<div style="padding:8px 16px;font-size:11px;color:var(--text-muted);">Showing matches from your library</div>'
        : "";
      $("#search-results").innerHTML = header + shows.map(searchResultHTML).join("");
      bindImageFallbacks($("#search-results"));

      $("#search-results").querySelectorAll(".follow-btn").forEach(btn =>
        btn.addEventListener("click", e => {
          e.stopPropagation();
          handleFollow(btn, btn.dataset.sid);
        })
      );
      $("#search-results").querySelectorAll(".search-result").forEach(row =>
        row.addEventListener("click", () => {
          const sid = row.dataset.sid;
          const sname = row.dataset.sname;
          if (sid) openShowDetail(sid, sname);
        })
      );
    } catch {
      $("#search-results").innerHTML = stateHTML("error", "Search failed");
    }
  }, 400);
}

async function handleFollow(btn, showId) {
  const was = btn.classList.contains("following");
  btn.disabled = true;
  btn.textContent = "...";
  try {
    const r = await msg({ action: was ? "unfollowShow" : "followShow", showId });
    if (r?.error) throw new Error(r.error);
    btn.classList.toggle("following");
    btn.textContent = was ? "+ Follow" : "✓ Following";
    showToast(was ? "Unfollowed" : "Show added!");
    showsCache = null;
  } catch (ex) {
    btn.textContent = was ? "✓ Following" : "+ Follow";
    showToast(ex?.message || "Failed", "error");
  } finally {
    btn.disabled = false;
  }
}

// ========== SHOW DETAIL ==========
async function openShowDetail(showId, showName) {
  if (!showId) return;

  const panel = $("#show-detail");
  const hero = $("#detail-hero");
  const content = $("#detail-content");
  const requestId = ++detailRequestId;

  $("#detail-title").textContent = showName || "Show";
  panel.classList.remove("hidden");
  hero.innerHTML = "";
  content.innerHTML = stateHTML("loading", "Loading show...");

  try {
    const [details, seasonsData] = await Promise.all([
      msg({ action: "getShowDetails", showId }),
      msg({ action: "getShowSeasons", showId }),
    ]);
    if (requestId !== detailRequestId) return;

    if (details?.error === "AUTH_EXPIRED" || seasonsData?.error === "AUTH_EXPIRED") {
      closeShowDetail();
      return checkAuthAndRoute();
    }

    const seasons = extractSeasons(seasonsData);
    const seasonCount = seasons.length || details?.season_count || 0;
    renderShowHero(hero, details || {}, showName, seasonCount);

    if (!seasons.length) {
      content.innerHTML = stateHTML("empty", "No season data");
      return;
    }

    content.innerHTML = seasons.map((season, i) =>
      buildSeasonShellHTML(showId, season, i === seasons.length - 1)
    ).join("");

    content.querySelectorAll(".season-section").forEach(section => {
      const header = section.querySelector(".season-header");
      if (!header) return;
      header.addEventListener("click", () => {
        toggleSeasonSection(section, requestId);
      });
    });

    const initialSection = content.querySelector(".season-section .season-header:not(.collapsed)")?.closest(".season-section");
    if (initialSection) {
      await ensureSeasonEpisodesLoaded(initialSection, requestId);
    }
  } catch {
    if (requestId !== detailRequestId) return;
    content.innerHTML = stateHTML("error", "Couldn't load show details");
  }
}

function renderShowHero(hero, details, showName, seasonCount) {
  const poster = purl(details.poster || details.image);
  const fanart = purl(details.fanart || details.all_images?.fanart);
  const network = details.network || details.channel || "";
  const displayName = details.name || showName || "Show";

  let html = "";
  if (fanart || poster) {
    html += `
      <div class="detail-hero">
        <img class="hero-bg" src="${fanart || poster}" alt="" data-fallback="hide">
        <div class="hero-gradient"></div>
        <div class="hero-content">
          ${poster ? `<div class="hero-poster"><img src="${poster}" alt="${esc(displayName)} poster" data-fallback="poster-fallback"></div>` : ""}
          <div class="hero-info">
            <div class="hero-title">${esc(displayName)}</div>
            <div class="hero-meta">
              ${network ? `<span>${esc(network)}</span>` : ""}
              ${seasonCount ? `<span>${seasonCount} season${seasonCount > 1 ? "s" : ""}</span>` : ""}
            </div>
          </div>
        </div>
      </div>
    `;
  }

  if (details.overview) {
    const summary = esc(details.overview).substring(0, 200);
    const suffix = details.overview.length > 200 ? "..." : "";
    html += `<div style="padding:12px 16px;font-size:12px;color:var(--text-secondary);line-height:1.6;">${summary}${suffix}</div>`;
  }

  hero.innerHTML = html;
  bindImageFallbacks(hero);
}

function buildSeasonShellHTML(showId, season, expanded) {
  const seasonNumber = Number(season.number) || 0;
  const watched = Number(season.watchedCount) || 0;
  const total = Number(season.episodeCount) || 0;
  const badge = total ? `${Math.min(watched, total)}/${total}` : "--";

  return `
    <div class="season-section" data-show-id="${attr(showId)}" data-season="${seasonNumber}" data-seen-hint="${Math.max(0, watched)}" data-loaded="false" data-loading="false">
      <div class="season-header ${expanded ? "" : "collapsed"}" data-season="${seasonNumber}">
        <svg class="chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>
        Season ${seasonNumber}
        <span class="season-badge">${badge}</span>
      </div>
      <div class="season-episodes ${expanded ? "" : "collapsed"}">
        <div class="season-placeholder">${expanded ? "Loading episodes..." : "Expand to load episodes"}</div>
      </div>
    </div>
  `;
}

async function toggleSeasonSection(section, requestId = detailRequestId) {
  const header = section.querySelector(".season-header");
  const body = section.querySelector(".season-episodes");
  if (!header || !body) return;

  const expanding = header.classList.contains("collapsed");
  header.classList.toggle("collapsed");
  body.classList.toggle("collapsed");

  if (expanding) {
    await ensureSeasonEpisodesLoaded(section, requestId);
  }
}

async function ensureSeasonEpisodesLoaded(section, requestId = detailRequestId) {
  if (!section || section.dataset.loaded === "true" || section.dataset.loading === "true") return;

  const showId = section.dataset.showId;
  const seasonNumber = Number(section.dataset.season || 0);
  const body = section.querySelector(".season-episodes");
  if (!showId || !body) return;

  const key = seasonCacheKey(showId, seasonNumber);
  const cached = seasonEpisodesCache.get(key);
  if (cached) {
    renderSeasonEpisodes(section, cached);
    return;
  }

  section.dataset.loading = "true";
  body.innerHTML = '<div class="season-placeholder loading"><span class="spinner"></span><span>Loading episodes...</span></div>';

  try {
    const res = await msg({ action: "getSeasonEpisodes", showId, seasonNumber });
    if (requestId !== detailRequestId) return;

    if (res.error) {
      if (res.error === "AUTH_EXPIRED") {
        closeShowDetail();
        await checkAuthAndRoute();
        return;
      }
      throw new Error(res.error);
    }

    const episodes = extractSeasonEpisodes(res);
    seasonEpisodesCache.set(key, episodes);
    renderSeasonEpisodes(section, episodes);
  } catch {
    if (requestId !== detailRequestId) return;
    body.innerHTML = '<div class="season-placeholder">Could not load episodes</div>';
  } finally {
    section.dataset.loading = "false";
  }
}

function renderSeasonEpisodes(section, episodes) {
  const body = section.querySelector(".season-episodes");
  if (!body) return;

  section.dataset.loaded = "true";
  if (!episodes.length) {
    body.innerHTML = '<div class="season-placeholder">No episodes found for this season</div>';
    updateSeasonBadge(section, 0, 0);
    return;
  }

  let rows = episodes.map(ep => ({ ...ep }));
  const seenHint = Number(section.dataset.seenHint || 0);
  const watchedCount = rows.filter(ep => ep.watched).length;
  if (watchedCount === 0 && seenHint > 0) {
    rows = rows
      .sort((a, b) => (Number(a.number) || 0) - (Number(b.number) || 0))
      .map((ep, index) => ({
        ...ep,
        watched: index < seenHint,
      }));
  }

  body.innerHTML = rows.map(seasonEpisodeRowHTML).join("");
  body.querySelectorAll(".ep-watch-btn").forEach(btn =>
    btn.addEventListener("click", () => toggleEpWatch(btn, btn.dataset.eid))
  );

  const watched = rows.filter(ep => ep.watched).length;
  updateSeasonBadge(section, watched, rows.length);
}

function seasonEpisodeRowHTML(ep) {
  return `
    <div class="ep-row">
      <span class="ep-number">E${String(ep.number).padStart(2, "0")}</span>
      <span class="ep-name" title="${esc(ep.name || `Episode ${ep.number}`)}">${esc(ep.name || `Episode ${ep.number}`)}</span>
      ${ep.airDate ? `<span class="ep-date">${fmtDate(ep.airDate)}</span>` : ""}
      <button class="ep-watch-btn ${ep.watched ? "watched" : ""}" data-eid="${attr(ep.id)}" title="${ep.watched ? "Unwatch" : "Watch"}">
        ${ep.watched ? checkSVG : ""}
      </button>
    </div>
  `;
}

function seasonCacheKey(showId, seasonNumber) {
  return `${showId}:${seasonNumber}`;
}

// ========== EPISODE ACTIONS ==========
async function toggleWatch(btn, episodeId) {
  if (!episodeId) {
    showToast("Episode ID missing", "error");
    return;
  }
  const was = btn.classList.contains("watched");
  btn.innerHTML = '<span class="spinner" style="width:14px;height:14px;border-width:2px;"></span>';
  btn.disabled = true;
  try {
    const r = await msg({ action: was ? "markUnwatched" : "markWatched", episodeId });
    if (r?.error) throw new Error(r.error);
    btn.classList.toggle("watched");
    btn.innerHTML = was ? playSVG : checkSVG;
    showToast(was ? "Unwatched" : "Watched!");
    upNextCache = null;
  } catch (ex) {
    btn.innerHTML = was ? checkSVG : playSVG;
    showToast(ex?.message || "Failed", "error");
  } finally {
    btn.disabled = false;
  }
}

async function toggleEpWatch(btn, episodeId) {
  if (!episodeId) {
    showToast("Episode ID missing", "error");
    return;
  }
  const was = btn.classList.contains("watched");
  btn.disabled = true;
  try {
    const r = await msg({ action: was ? "markUnwatched" : "markWatched", episodeId });
    if (r?.error) throw new Error(r.error);
    btn.classList.toggle("watched");
    btn.innerHTML = was ? "" : checkSVG;
    showToast(was ? "Unwatched" : "Watched!");
    upNextCache = null;
    updateSeasonBadge(btn.closest(".season-section"));
  } catch (ex) {
    showToast(ex?.message || "Failed", "error");
  } finally {
    btn.disabled = false;
  }
}

function updateSeasonBadge(section, watchedCount = null, totalCount = null) {
  if (!section) return;
  const badge = section.querySelector(".season-badge");
  if (!badge) return;

  let watched = watchedCount;
  let total = totalCount;
  if (watched === null || total === null) {
    total = section.querySelectorAll(".ep-watch-btn").length;
    watched = section.querySelectorAll(".ep-watch-btn.watched").length;
  }
  badge.textContent = total ? `${watched}/${total}` : "--";
}

// ========== DATA EXTRACTION ==========
function purl(p) {
  if (!p) return "";
  const raw = mediaFromValue(p);
  const url = safeMediaUrl(raw);
  return isPlaceholderMediaUrl(url) ? "" : url;
}

function mediaFromValue(value, depth = 0) {
  if (!value || depth > 4) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const out = mediaFromValue(item, depth + 1);
      if (out) return out;
    }
    return "";
  }
  if (typeof value !== "object") return "";

  const direct = [value.url, value.href, value.src, value.path, value.file];
  for (const v of direct) {
    if (typeof v === "string" && v.trim()) return v;
  }

  const versions = value.versions || {};
  for (const v of [versions.medium, versions.small, versions.big, versions.original, value.medium, value.small, value.big]) {
    if (typeof v === "string" && v.trim()) return v;
  }

  for (const key of ["poster", "image", "cover", "artwork", "banner", "thumbnail", "fanart", "images", "all_images", "data", "items"]) {
    const out = mediaFromValue(value[key], depth + 1);
    if (out) return out;
  }

  for (const nested of Object.values(value)) {
    const out = mediaFromValue(nested, depth + 1);
    if (out) return out;
  }

  return "";
}

function extractEpisodes(data) {
  if (!data) return [];
  const list = data.episodes || data.data || (Array.isArray(data) ? data : []);
  return (Array.isArray(list) ? list : []).map(ep => ({
    id: ep.id || ep.episode_id,
    name: ep.name || ep.title || "",
    number: ep.number || ep.episode_number || 0,
    seasonNumber: ep.season_number || ep.season?.number || ep.season || 0,
    showName: ep.show_name || ep.show?.name || ep.show?.title || "",
    showId: ep.show_id || ep.series_id || ep.show?.id || ep.show?.series_id || "",
    poster: purl(
      ep.poster ||
      ep.show_poster ||
      ep.show?.poster ||
      ep.show?.image ||
      ep.show?.cover ||
      ep.show?.all_images ||
      ep.images?.poster ||
      ep.images?.cover ||
      ep.all_images?.poster ||
      ep.all_images?.cover ||
      ep.image ||
      ep.cover ||
      ep.all_images
    ),
    airDate: ep.air_date || ep.aired || "",
    watched: Boolean(
      ep.watched ||
      ep.is_watched ||
      ep.is_seen ||
      ep.seen === true ||
      ep.seen === 1 ||
      ep.seen === "1" ||
      ep.seen_date
    ),
  }));
}

function extractShows(data) {
  if (!data) return [];
  const list = data.shows || data.series || (Array.isArray(data) ? data : []);
  return (Array.isArray(list) ? list : []).map(s => ({
    id: s.id || s.series_id || s.show_id,
    name: s.name || s.title || "",
    poster: purl(
      s.poster ||
      s.image ||
      s.cover ||
      s.all_images?.poster ||
      s.all_images?.cover ||
      s.all_images
    ),
    following: s.following || s.is_following || s.is_followed || true,
  }));
}

function extractSearchResults(data) {
  if (!data) return [];
  const list =
    data.results ||
    data.series ||
    data.shows ||
    data.data ||
    data.items ||
    data.matches ||
    (Array.isArray(data) ? data : []);
  return (Array.isArray(list) ? list : []).map(s => ({
    id: s.id || s.series_id || s.show_id,
    name: s.name || s.title || "",
    poster: purl(
      s.poster ||
      s.image ||
      s.cover ||
      s.all_images?.poster ||
      s.all_images?.cover ||
      s.all_images
    ),
    year:
      s.year ||
      s.release_year ||
      s.first_air_date?.substring?.(0, 4) ||
      s.release_date?.substring?.(0, 4) ||
      "",
    following: s.following || s.is_following || s.is_followed || false,
  }));
}

function extractSeasons(data) {
  if (!data) return [];
  const list = data.seasons || (Array.isArray(data) ? data : []);
  return (Array.isArray(list) ? list : [])
    .map((s, i) => ({
      number: parseSeasonNum(s.number || s.season_number, i + 1),
      episodeCount: s.episode_count || s.nb_episodes || 0,
      watchedCount: s.seen_episodes || 0,
    }))
    .filter(s => s.number > 0);
}

function extractSeasonEpisodes(data) {
  if (!data) return [];
  const list = data.episodes || (Array.isArray(data) ? data : []);
  return (Array.isArray(list) ? list : []).map(ep => ({
    id: ep.id || ep.episode_id,
    number: ep.number || ep.episode_number || 0,
    name: ep.name || ep.title || "",
    airDate: ep.air_date || ep.aired || "",
    watched: Boolean(
      ep.watched ||
      ep.is_watched ||
      ep.is_seen ||
      ep.seen === true ||
      ep.seen === 1 ||
      ep.seen === "1" ||
      ep.seen_date
    ),
  }));
}

// ========== HTML TEMPLATES ==========
function stateHTML(type, title, sub) {
  const icons = { loading: "", empty: "📺", error: "⚠️" };
  return `<div class="state-msg ${type}">
    ${type === "loading" ? '<div class="spinner"></div>' : `<div class="state-icon">${icons[type]}</div>`}
    <div class="state-title">${title || ""}</div>
    ${sub ? `<div class="state-sub">${sub}</div>` : ""}
  </div>`;
}

function episodeCardHTML(ep) {
  return `
    <div class="episode-card" data-sid="${attr(ep.showId)}" data-sname="${esc(ep.showName)}">
      <div class="ep-poster">${ep.poster ? `<img src="${ep.poster}" alt="" data-fallback="hide">` : "📺"}</div>
      <div class="ep-info">
        <div class="ep-show">${esc(ep.showName)}</div>
        <div class="ep-title">${esc(ep.name || `Episode ${ep.number}`)}</div>
        <div class="ep-meta">S${pad(ep.seasonNumber)}E${pad(ep.number)}${ep.airDate ? " · " + fmtDate(ep.airDate) : ""}</div>
      </div>
      <button class="watch-btn ${ep.watched ? "watched" : ""}" data-eid="${attr(ep.id)}">${ep.watched ? checkSVG : playSVG}</button>
    </div>
  `;
}

function showCardHTML(show) {
  return `
    <div class="show-card" data-sid="${attr(show.id)}" data-sname="${esc(show.name)}">
      ${show.poster
        ? `<img src="${show.poster}" alt="${esc(show.name)}" loading="lazy" data-fallback="show-next">`
        : ""}
      <div class="card-placeholder" ${show.poster ? 'style="display:none"' : ""}>📺</div>
      <div class="card-overlay"><div class="card-name">${esc(show.name)}</div></div>
    </div>
  `;
}

function searchResultHTML(show) {
  return `
    <div class="search-result" data-sid="${attr(show.id)}" data-sname="${esc(show.name)}">
      ${show.poster
        ? `<img class="search-poster" src="${show.poster}" alt="" loading="lazy" data-fallback="hide">`
        : '<div class="search-poster">📺</div>'}
      <div class="search-info">
        <div class="search-title">${esc(show.name)}</div>
        <div class="search-meta">${show.year || ""}</div>
      </div>
      <button class="follow-btn ${show.following ? "following" : ""}" data-sid="${attr(show.id)}">
        ${show.following ? "✓ Following" : "+ Follow"}
      </button>
    </div>
  `;
}

const checkSVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>';
const playSVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21"/></svg>';

// ========== UTILS ==========
function msg(data) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage(data, r => resolve(r || { error: "No response" }));
  });
}

function esc(s) {
  if (!s) return "";
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

function attr(v) {
  return esc(String(v ?? ""));
}

function safeMediaUrl(raw) {
  if (!raw || typeof raw !== "string") return "";
  const trimmed = raw.trim();
  if (!trimmed) return "";

  try {
    const absolute = trimmed.startsWith("//") ? `https:${trimmed}` : trimmed;
    const url = new URL(absolute, "https://artworks.thetvdb.com/");
    if (url.protocol !== "https:" && url.protocol !== "http:") return "";
    return url.href;
  } catch {
    return "";
  }
}

function isPlaceholderMediaUrl(url) {
  const s = String(url || "").toLowerCase();
  if (!s) return true;
  return (
    s.startsWith("data:image/") ||
    s.includes("/default-images/") ||
    s.includes("placeholder") ||
    s.includes("landscape-default") ||
    s.includes("noimage") ||
    s.includes("no-image") ||
    s.includes("missing") ||
    s.includes("notfound")
  );
}

function bindImageFallbacks(root) {
  if (!root) return;
  root.querySelectorAll("img[data-fallback]").forEach(img => {
    if (img.dataset.bound === "1") return;
    img.dataset.bound = "1";

    const applyFallback = () => {
      const mode = img.dataset.fallback;
      if (mode === "hide") {
        img.style.display = "none";
        return;
      }
      if (mode === "show-next") {
        img.style.display = "none";
        if (img.nextElementSibling) img.nextElementSibling.style.display = "flex";
        return;
      }
      if (mode === "poster-fallback") {
        if (img.parentElement) {
          img.parentElement.textContent = "TV";
        }
      }
    };

    img.addEventListener("error", applyFallback, { once: true });
    if (img.complete && img.naturalWidth === 0) {
      applyFallback();
    }
  });
}

function pad(n) {
  return String(n || 0).padStart(2, "0");
}

function parseSeasonNum(value, fallback = 0) {
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return Math.floor(n);
  if (typeof value === "string") {
    const m = value.match(/\d+/);
    if (m) return Number(m[0]);
  }
  return fallback;
}

function fmtDate(s) {
  if (!s) return "";
  try {
    return new Date(s).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  } catch {
    return s;
  }
}

function showToast(message, type = "success") {
  document.querySelector(".toast")?.remove();
  const t = document.createElement("div");
  t.className = `toast ${type}`;
  t.textContent = message;
  document.body.appendChild(t);
  requestAnimationFrame(() => {
    t.classList.add("show");
    setTimeout(() => {
      t.classList.remove("show");
      setTimeout(() => t.remove(), 300);
    }, 2000);
  });
}
