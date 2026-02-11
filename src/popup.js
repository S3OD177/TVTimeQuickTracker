// ============================================================
// TV Time Quick Tracker - Popup v5
// ============================================================

const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);
const on = (selector, event, handler) => {
  const node = $(selector);
  if (!node) return null;
  node.addEventListener(event, handler);
  return node;
};

let currentTab = "watch-list";
let lastMainTab = "watch-list";
let quickPanelView = "";
let showsCache = null;
let upNextCache = null; // Legacy alias: flattened watch list rows for detail/action syncing.
let upcomingCache = null;
let watchListSearchQuery = "";
let searchTimeout = null;
let preloadScheduled = false;
let detailRequestId = 0;
const seasonEpisodesCache = new Map();
const showDetailStateCache = new Map();
let watchListState = {
  groups: {
    continue_watching: [],
    not_watched_for_a_while: [],
    not_started_yet: [],
    for_later: [],
  },
  loadedFilters: new Set(),
  forLaterRequested: false,
};

const WATCHLIST_FILTERS = Object.freeze({
  CONTINUE: "continue_watching",
  NOT_WATCHED: "not_watched_for_a_while",
  NOT_STARTED: "not_started_yet",
  FOR_LATER: "for_later",
});
const WATCHLIST_GROUP_ORDER = [
  "continue_watching",
  "not_watched_for_a_while",
  "not_started_yet",
  "for_later",
];
const WATCHLIST_GROUP_TITLES = {
  continue_watching: "Watch Next",
  not_watched_for_a_while: "Haven't watched for a while",
  not_started_yet: "Not started yet",
  for_later: "For later",
};
const TO_WATCH_CATEGORY_NOT_WATCHED = "not_watched_for_a_while";

// ========== INIT ==========
document.addEventListener("DOMContentLoaded", () => {
  setupEvents();
  checkAuthAndRoute();
});

function setupEvents() {
  on("#login-form", "submit", handleLogin);
  $$(".tab").forEach(t => t.addEventListener("click", () => switchTab(t.dataset.tab)));
  on("#refresh-btn", "click", refreshCurrentTab);
  on("#logout-btn", "click", handleLogout);
  on("#open-my-shows-btn", "click", () => openQuickPanel("my-shows"));
  on("#open-search-btn", "click", () => openQuickPanel("search"));
  on("#quick-panel-back", "click", closeQuickPanel);
  on("#search-input", "input", handleSearchInput);
  on("#watchlist-search-input", "input", handleWatchListSearchInput);
  on("#detail-back", "click", closeShowDetail);
}

function closeShowDetail() {
  saveDetailViewState();
  detailRequestId += 1;
  const panel = $("#show-detail");
  if (!panel) return;
  panel.classList.add("hidden");
  delete panel.dataset.showId;
}

function scheduleDashboardPreload() {
  if (preloadScheduled) return;
  preloadScheduled = true;
  setTimeout(() => {
    msg({ action: "preloadDashboard" })
      .catch(() => {})
      .finally(() => {
        preloadScheduled = false;
      });
  }, 50);
}

// ========== AUTH ==========
async function checkAuthAndRoute() {
  const r = await msg({ action: "checkAuth" });
  if (r.authenticated) {
    showScreen("main-screen");
    upNextCache = null;
    upcomingCache = null;
    watchListState = createEmptyWatchListState();
    switchTab("watch-list");
    scheduleDashboardPreload();
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
      upNextCache = null;
      upcomingCache = null;
      watchListState = createEmptyWatchListState();
      switchTab("watch-list");
      scheduleDashboardPreload();
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
  upcomingCache = null;
  upNextCache = null;
  preloadScheduled = false;
  watchListState = createEmptyWatchListState();
  watchListSearchQuery = "";
  $("#watchlist-search-input").value = "";
  closeQuickPanel();
  seasonEpisodesCache.clear();
  closeShowDetail();
  showDetailStateCache.clear();
  showScreen("login-screen");
}

// ========== NAV ==========
function showScreen(id) {
  $$(".screen").forEach(s => s.classList.add("hidden"));
  const target = $(`#${id}`);
  if (target) target.classList.remove("hidden");
}

function switchTab(id) {
  if (!id || !["watch-list", "upcoming"].includes(id)) return;
  currentTab = id;
  lastMainTab = id;
  $$(".tab").forEach(t => t.classList.remove("active"));
  const tabBtn = $(`.tab[data-tab="${id}"]`);
  if (tabBtn) tabBtn.classList.add("active");
  $$(".tab-pane").forEach(p => p.classList.remove("active"));
  const pane = $(`#tab-${id}`);
  if (pane) pane.classList.add("active");
  if (quickPanelView) closeQuickPanel();

  if (id === "watch-list" && !upNextCache) loadWatchList();
  if (id === "upcoming" && !upcomingCache) loadUpcoming();
}

async function refreshCurrentTab() {
  const btn = $("#refresh-btn");
  btn.classList.add("spinning");
  setTimeout(() => btn.classList.remove("spinning"), 600);
  if (quickPanelView === "my-shows") {
    showsCache = null;
    await loadMyShows({ forceRefresh: true });
    return;
  }
  if (quickPanelView === "search") {
    const searchInput = $("#search-input");
    const q = String(searchInput?.value || "").trim();
    if (q.length >= 2) handleSearchInput({ target: searchInput });
    return;
  }

  if (currentTab === "watch-list") {
    watchListState = createEmptyWatchListState();
    upNextCache = null;
    await loadWatchList({ forceRefresh: true });
  } else if (currentTab === "upcoming") {
    upcomingCache = null;
    await loadUpcoming({ forceRefresh: true });
  }
}

function openQuickPanel(view) {
  if (!["my-shows", "search"].includes(view)) return;
  quickPanelView = view;
  lastMainTab = currentTab;
  const panel = $("#quick-panel");
  if (!panel) return;
  panel.classList.remove("hidden");
  const myShowsPane = $("#quick-pane-my-shows");
  const searchPane = $("#quick-pane-search");
  const title = $("#quick-panel-title");
  if (myShowsPane) myShowsPane.classList.toggle("hidden", view !== "my-shows");
  if (searchPane) searchPane.classList.toggle("hidden", view !== "search");
  if (title) title.textContent = view === "my-shows" ? "My Shows" : "Search";

  if (view === "my-shows" && !showsCache) loadMyShows();
  if (view === "search") $("#search-input")?.focus();
}

function closeQuickPanel() {
  quickPanelView = "";
  const panel = $("#quick-panel");
  if (panel) panel.classList.add("hidden");
  if (lastMainTab !== currentTab) switchTab(lastMainTab);
}

function createEmptyWatchListState() {
  return {
    groups: {
      continue_watching: [],
      not_watched_for_a_while: [],
      not_started_yet: [],
      for_later: [],
    },
    loadedFilters: new Set(),
    forLaterRequested: false,
  };
}

function flattenWatchListEpisodes(state = watchListState) {
  const flat = [];
  for (const filter of WATCHLIST_GROUP_ORDER) {
    const rows = state.groups[filter] || [];
    if (rows.length) flat.push(...rows);
  }
  return flat;
}

function setWatchListGroup(filter, episodes) {
  if (!WATCHLIST_GROUP_ORDER.includes(filter)) return;
  const normalized = (Array.isArray(episodes) ? episodes : []).map(ep => ({
    ...ep,
    toWatchCategory: normalizeToWatchCategory(ep.toWatchCategory || ep.to_watch_category || filter),
  }));
  watchListState.groups[filter] = normalized;
  watchListState.loadedFilters.add(filter);
  upNextCache = flattenWatchListEpisodes();
}

async function fetchWatchListFilter(filter, forceRefresh = false) {
  const r = await msg({
    action: "getWatchList",
    filter,
    offset: 0,
    limit: 100,
    forceRefresh: Boolean(forceRefresh),
  });
  if (r.error) {
    if (r.error === "AUTH_EXPIRED") throw new Error("AUTH_EXPIRED");
    throw new Error(r.error);
  }
  return normalizeWatchListRows(extractEpisodes(r), filter);
}

function normalizeWatchListRows(episodes, filter) {
  return (Array.isArray(episodes) ? episodes : []).map(ep => ({
    ...ep,
    toWatchCategory: normalizeToWatchCategory(ep.toWatchCategory || filter),
  }));
}

// ========== WATCH LIST ==========
async function loadWatchList(opts = {}) {
  const c = $("#watch-list-list");
  if (!c) {
    showToast("UI mismatch: missing watch list container", "error");
    return;
  }
  c.innerHTML = stateHTML("loading", "Loading episodes...");

  try {
    const bundle = await msg({
      action: "getWatchListBundle",
      filters: [WATCHLIST_FILTERS.CONTINUE, WATCHLIST_FILTERS.NOT_WATCHED],
      offset: 0,
      limit: 100,
      forceRefresh: Boolean(opts.forceRefresh),
    });
    if (bundle?.error) {
      if (bundle.error === "AUTH_EXPIRED") throw new Error("AUTH_EXPIRED");
      throw new Error(bundle.error);
    }
    const continueWatching = normalizeWatchListRows(
      bundle?.groups?.[WATCHLIST_FILTERS.CONTINUE] || [],
      WATCHLIST_FILTERS.CONTINUE
    );
    const notWatched = normalizeWatchListRows(
      bundle?.groups?.[WATCHLIST_FILTERS.NOT_WATCHED] || [],
      WATCHLIST_FILTERS.NOT_WATCHED
    );
    setWatchListGroup(WATCHLIST_FILTERS.CONTINUE, continueWatching);
    setWatchListGroup(WATCHLIST_FILTERS.NOT_WATCHED, notWatched);

    if (!continueWatching.length && !notWatched.length) {
      const notStarted = await fetchWatchListFilter(
        WATCHLIST_FILTERS.NOT_STARTED,
        Boolean(opts.forceRefresh)
      );
      setWatchListGroup(WATCHLIST_FILTERS.NOT_STARTED, notStarted);
    } else {
      setWatchListGroup(WATCHLIST_FILTERS.NOT_STARTED, []);
    }
    renderWatchListQueue(c);
  } catch (e) {
    if (e.message === "AUTH_EXPIRED") return checkAuthAndRoute();
    c.innerHTML = stateHTML("error", "Couldn't load episodes", "Try refreshing");
  }
}

function renderWatchListQueue(container) {
  const groups = [];
  const query = watchListSearchQuery;

  for (const filter of WATCHLIST_GROUP_ORDER) {
    const sourceRows = watchListState.groups[filter] || [];
    const rows = filterWatchListEpisodes(sourceRows, query);
    if (!rows.length) continue;
    groups.push(upNextGroupHTML(WATCHLIST_GROUP_TITLES[filter], rows));
  }

  const showForLaterAction = !watchListState.loadedFilters.has(WATCHLIST_FILTERS.FOR_LATER);
  const loadForLaterHTML = showForLaterAction && !query
    ? `
      <div class="watchlist-load-wrap">
        <button id="load-for-later-btn" class="watchlist-load-btn" type="button">
          Load For Later
        </button>
      </div>
    `
    : "";

  if (!groups.length) {
    if (query) {
      container.innerHTML = stateHTML("empty", `No matches for "${query}"`, "Try a different search");
    } else {
      container.innerHTML = stateHTML("empty", "No shows in Watch List", "You're all caught up! 🎉") + loadForLaterHTML;
      const loadForLaterBtn = container.querySelector("#load-for-later-btn");
      if (loadForLaterBtn) loadForLaterBtn.addEventListener("click", loadForLaterGroup);
    }
    return;
  }

  container.innerHTML = `<div class="upnext-queue">${groups.join("")}</div>${loadForLaterHTML}`;
  bindImageFallbacks(container);
  bindWatchListQueueEvents(container);

  const loadForLaterBtn = container.querySelector("#load-for-later-btn");
  if (loadForLaterBtn) {
    loadForLaterBtn.addEventListener("click", loadForLaterGroup);
  }
}

async function loadForLaterGroup() {
  if (watchListState.loadedFilters.has(WATCHLIST_FILTERS.FOR_LATER)) return;
  const list = $("#watch-list-list");
  const btn = $("#load-for-later-btn");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Loading...";
  }
  try {
    const forLater = await fetchWatchListFilter(WATCHLIST_FILTERS.FOR_LATER);
    setWatchListGroup(WATCHLIST_FILTERS.FOR_LATER, forLater);
    watchListState.forLaterRequested = true;
    renderWatchListQueue(list);
    if (!forLater.length) {
      showToast("No shows in For Later");
    }
  } catch (e) {
    if (e.message === "AUTH_EXPIRED") {
      checkAuthAndRoute();
      return;
    }
    showToast("Could not load For Later", "error");
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Load For Later";
    }
  }
}

function handleWatchListSearchInput(e) {
  watchListSearchQuery = String(e?.target?.value || "").trim().toLowerCase();
  if (currentTab !== "watch-list") return;
  const list = $("#watch-list-list");
  if (!list) return;
  renderWatchListQueue(list);
}

function filterWatchListEpisodes(episodes, query) {
  if (!query) return Array.isArray(episodes) ? episodes : [];
  return (Array.isArray(episodes) ? episodes : []).filter(ep => matchesWatchListEpisodeQuery(ep, query));
}

function matchesWatchListEpisodeQuery(ep, query) {
  const searchText = [
    ep.showName,
    ep.name,
    `S${pad(ep.seasonNumber)}E${pad(ep.number)}`,
    ep.airDate,
    fmtDate(ep.airDate),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return searchText.includes(query);
}

function bindWatchListQueueEvents(container) {
  container.querySelectorAll(".episode-card").forEach(card =>
    card.addEventListener("click", () => {
      if (card.dataset.sid) {
        openShowDetail(card.dataset.sid, card.dataset.sname);
      }
    })
  );

  container.querySelectorAll(".watch-btn").forEach(btn =>
    btn.addEventListener("click", e => {
      e.stopPropagation();
      toggleWatch(btn, btn.dataset.eid);
    })
  );
}

// ========== UPCOMING ==========
async function loadUpcoming(opts = {}) {
  const c = $("#upcoming-list");
  if (!c) {
    showToast("UI mismatch: missing upcoming container", "error");
    return;
  }
  c.innerHTML = stateHTML("loading", "Loading upcoming...");

  try {
    const r = await msg({
      action: "getUpcoming",
      offset: 0,
      showLimit: 100,
      back: 1,
      includeWatched: 0,
      forceRefresh: Boolean(opts.forceRefresh),
    });
    if (r.error) {
      if (r.error === "AUTH_EXPIRED") return checkAuthAndRoute();
      throw new Error(r.error);
    }
    upcomingCache = extractUpcomingEpisodes(r);
    renderUpcomingQueue(c, upcomingCache);
  } catch {
    c.innerHTML = stateHTML("error", "Couldn't load upcoming", "Try refreshing");
  }
}

function renderUpcomingQueue(container, episodes) {
  const grouped = groupUpcomingEpisodes(episodes);
  const groups = [];
  for (const day of grouped) {
    groups.push(`
      <section class="upcoming-day-group">
        <div class="upcoming-day-chip">${esc(day.label)}</div>
        <div class="upcoming-day-list">
          ${day.episodes.map(upcomingCardHTML).join("")}
        </div>
      </section>
    `);
  }

  if (!groups.length) {
    container.innerHTML = stateHTML("empty", "No upcoming episodes", "Nothing scheduled right now");
    return;
  }

  container.innerHTML = `<div class="upcoming-queue">${groups.join("")}</div>`;
  bindImageFallbacks(container);
  bindUpcomingQueueEvents(container);
}

function groupUpcomingEpisodes(episodes) {
  const rows = (Array.isArray(episodes) ? episodes : [])
    .map(ep => ({
      ...ep,
      _parsedAir: parseAirDate(ep.airDateTime || ep.airDate),
      _sortTs: parseAirDate(ep.airDateTime || ep.airDate)?.getTime?.() || Number.POSITIVE_INFINITY,
    }))
    .sort((a, b) => a._sortTs - b._sortTs);

  const buckets = new Map();
  for (const ep of rows) {
    const date = ep._parsedAir;
    const key = date ? localDateKey(date) : "unknown";
    if (!buckets.has(key)) {
      buckets.set(key, {
        key,
        label: date ? upcomingDayLabel(date) : "UPCOMING",
        sortTs: date ? new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime() : Number.POSITIVE_INFINITY,
        episodes: [],
      });
    }
    buckets.get(key).episodes.push(ep);
  }

  return Array.from(buckets.values())
    .sort((a, b) => a.sortTs - b.sortTs)
    .map(bucket => ({
      ...bucket,
      episodes: bucket.episodes.sort((a, b) => a._sortTs - b._sortTs),
    }));
}

function localDateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function upcomingDayLabel(date) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const diff = Math.round((d.getTime() - today.getTime()) / 86400000);
  if (diff === -1) return "YESTERDAY";
  if (diff === 0) return "TODAY";
  if (diff === 1) return "TOMORROW";
  return d.toLocaleDateString("en-US", { weekday: "long" }).toUpperCase();
}

function normalizeToWatchCategory(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const normalized = raw
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[-\s]+/g, "_")
    .toLowerCase();
  if (normalized === "notwatchedforawhile" || normalized === "not_watched_for_a_while") {
    return TO_WATCH_CATEGORY_NOT_WATCHED;
  }
  if (normalized === "continuewatching") return "continue_watching";
  if (normalized === "notstartedyet") return "not_started_yet";
  if (normalized === "forlater") return "for_later";
  return normalized;
}

function upNextGroupHTML(title, episodes) {
  return `
    <section class="upnext-group">
      <div class="upnext-group-header">
        <span class="upnext-group-title">${esc(title)}</span>
        <span class="upnext-group-count">${episodes.length}</span>
      </div>
      <div class="upnext-group-list">
        ${episodes.map(episodeCardHTML).join("")}
      </div>
    </section>
  `;
}

function bindUpcomingQueueEvents(container) {
  container.querySelectorAll(".upcoming-card").forEach(card =>
    card.addEventListener("click", () => {
      if (card.dataset.sid) {
        openShowDetail(card.dataset.sid, card.dataset.sname);
      }
    })
  );

  container.querySelectorAll(".watch-btn").forEach(btn =>
    btn.addEventListener("click", e => {
      e.stopPropagation();
      toggleWatch(btn, btn.dataset.eid);
    })
  );
}

// ========== MY SHOWS ==========
async function loadMyShows(opts = {}) {
  const c = $("#my-shows-list");
  if (!c) return;
  c.innerHTML = stateHTML("loading", "Loading shows...");

  try {
    const r = await msg({
      action: "getWatchingShows",
      forceRefresh: Boolean(opts.forceRefresh),
    });
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
        $("#search-results").innerHTML = stateHTML("empty", `No results for "${q}"`);
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

  saveDetailViewState();
  const panel = $("#show-detail");
  const hero = $("#detail-hero");
  const content = $("#detail-content");
  const requestId = ++detailRequestId;
  panel.dataset.showId = String(showId);

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
    const seasonNumbers = seasons.map(season => Number(season.number) || 0).filter(Boolean);
    const nextEpisode = extractNextEpisode(details, seasonsData);
    const seasonCount = seasons.length || details?.season_count || 0;
    const totalEpisodes = seasons.reduce((sum, season) => sum + (Number(season.episodeCount) || 0), 0);
    const watchedEpisodes = seasons.reduce((sum, season) => sum + (Number(season.watchedCount) || 0), 0);
    renderShowHero(hero, details || {}, showName, {
      seasonCount,
      totalEpisodes,
      watchedEpisodes,
      seasonNumbers,
      nextEpisode,
    });
    bindDetailHeroActions(hero, showId);

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

    const saved = showDetailStateCache.get(String(showId));
    if (saved?.season) {
      const targetSeason = String(saved.season);
      content.querySelectorAll(".season-section").forEach(section => {
        const header = section.querySelector(".season-header");
        const body = section.querySelector(".season-episodes");
        if (!header || !body) return;
        const isTarget = String(section.dataset.season || "") === targetSeason;
        header.classList.toggle("collapsed", !isTarget);
        body.classList.toggle("collapsed", !isTarget);
      });
    }

    const initialSection = content.querySelector(".season-section .season-header:not(.collapsed)")?.closest(".season-section");
    if (initialSection) {
      await ensureSeasonEpisodesLoaded(initialSection, requestId);
    }
    bindSeasonJumpActions(hero, content, requestId);
    if (saved && Number.isFinite(saved.scrollTop)) {
      requestAnimationFrame(() => {
        if (requestId !== detailRequestId) return;
        content.scrollTop = Math.max(0, Number(saved.scrollTop) || 0);
      });
    }
  } catch {
    if (requestId !== detailRequestId) return;
    content.innerHTML = stateHTML("error", "Couldn't load show details");
  }
}

function renderShowHero(hero, details, showName, stats) {
  const poster = purl(details.poster || details.image);
  const fanart = purl(details.fanart || details.all_images?.fanart);
  const network = details.network || details.channel || "";
  const displayName = details.name || showName || "Show";
  const seasonCount = Number(stats?.seasonCount) || 0;
  const totalEpisodes = Number(stats?.totalEpisodes) || 0;
  const watchedEpisodes = Math.min(Number(stats?.watchedEpisodes) || 0, totalEpisodes || Number.POSITIVE_INFINITY);
  const progressValue = totalEpisodes > 0 ? Math.round((watchedEpisodes / totalEpisodes) * 100) : 0;
  const status = details.status || details.show_status || details.production_status || "";
  const year =
    details.year ||
    details.first_air_date?.substring?.(0, 4) ||
    details.release_date?.substring?.(0, 4) ||
    "";
  const seasonNumbers = Array.isArray(stats?.seasonNumbers) ? stats.seasonNumbers : [];
  const nextEpisode = stats?.nextEpisode || null;

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
              ${year ? `<span>${esc(String(year))}</span>` : ""}
              ${seasonCount ? `<span>${seasonCount} season${seasonCount > 1 ? "s" : ""}</span>` : ""}
              ${status ? `<span>${esc(String(status))}</span>` : ""}
            </div>
          </div>
        </div>
      </div>
    `;
  }

  if (seasonCount || totalEpisodes || watchedEpisodes) {
    html += `
      <div class="detail-stats">
        <div class="stat">
          <div class="stat-value">${seasonCount || "--"}</div>
          <div class="stat-label">Seasons</div>
        </div>
        <div class="stat">
          <div class="stat-value">${totalEpisodes || "--"}</div>
          <div class="stat-label">Episodes</div>
        </div>
        <div class="stat">
          <div class="stat-value">${totalEpisodes ? `${progressValue}%` : "--"}</div>
          <div class="stat-label">Progress</div>
        </div>
      </div>
      ${totalEpisodes ? `
        <div class="detail-progress-wrap">
          <div class="detail-progress-label">
            <span>${watchedEpisodes}/${totalEpisodes} watched</span>
            <span>${progressValue}%</span>
          </div>
          <div class="detail-progress-track"><span style="width:${progressValue}%"></span></div>
        </div>
      ` : ""}
    `;
  }

  if (nextEpisode?.id) {
    const nextLabel = `S${pad(nextEpisode.seasonNumber)}E${pad(nextEpisode.number)}`;
    html += `
      <div class="detail-next-card">
        <div class="detail-next-label">Next Episode</div>
        <div class="detail-next-main">
          <div class="detail-next-title">${esc(nextLabel)}${nextEpisode.name ? ` · ${esc(nextEpisode.name)}` : ""}</div>
          <div class="detail-next-meta">
            ${nextEpisode.airDate ? `<span>${fmtDate(nextEpisode.airDate)}</span>` : "<span>No air date</span>"}
            ${airStatusBadgeHTML(nextEpisode.airDate)}
          </div>
        </div>
        <button class="detail-next-btn ${nextEpisode.watched ? "watched" : ""}" data-next-eid="${attr(nextEpisode.id)}" data-next-watched="${nextEpisode.watched ? "1" : "0"}">
          ${nextEpisode.watched ? "Mark Unwatched" : "Mark Watched"}
        </button>
      </div>
    `;
  }

  html += `
    <div class="detail-info-banner">
      <span class="info-dot">i</span>
      <span>${nextEpisode?.id ? "Quick actions sync with your TV Time account instantly." : "Tip: use season actions to mark multiple episodes quickly."}</span>
    </div>
  `;

  if (seasonNumbers.length) {
    html += `
      <div class="season-jump-strip">
        ${seasonNumbers.map(num => `<button type="button" class="season-jump-btn" data-season-jump="${num}">S${num}</button>`).join("")}
      </div>
    `;
  }

  if (details.overview) {
    const summary = esc(details.overview).substring(0, 200);
    const suffix = details.overview.length > 200 ? "..." : "";
    html += `<div class="detail-overview">${summary}${suffix}</div>`;
  }

  hero.innerHTML = html;
  bindImageFallbacks(hero);
}

function buildSeasonShellHTML(showId, season, expanded) {
  const seasonNumber = Number(season.number) || 0;
  const watched = Number(season.watchedCount) || 0;
  const total = Number(season.episodeCount) || 0;
  const badge = total ? `${Math.min(watched, total)}/${total}` : "--";
  const progress = total ? Math.round((Math.min(watched, total) / total) * 100) : 0;

  return `
    <div class="season-section" data-show-id="${attr(showId)}" data-season="${seasonNumber}" data-seen-hint="${Math.max(0, watched)}" data-loaded="false" data-loading="false" data-filter="all">
      <div class="season-header ${expanded ? "" : "collapsed"}" data-season="${seasonNumber}">
        <div class="season-head-main">
          <div class="season-title-row">
            <svg class="chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>
            <span class="season-title">Season ${seasonNumber}</span>
          </div>
          <div class="season-head-meta">
            <span>${badge} watched</span>
            ${total ? `<span>${progress}%</span>` : ""}
          </div>
        </div>
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
    const hydrated = hydrateSeasonEpisodes(section, episodes);
    seasonEpisodesCache.set(key, hydrated);
    renderSeasonEpisodes(section, hydrated);
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
  const allRows = Array.isArray(episodes) ? episodes.map(ep => ({ ...ep })) : [];
  if (!allRows.length) {
    body.innerHTML = '<div class="season-placeholder">No episodes found for this season</div>';
    updateSeasonBadge(section, 0, 0);
    return;
  }

  const showId = section.dataset.showId || "";
  const seasonNumber = Number(section.dataset.season || 0);
  const filter = section.dataset.filter || "all";
  const visibleRows = filterSeasonEpisodeRows(allRows, filter);

  body.innerHTML = `
    <div class="season-tools">
      <div class="season-filter-row">
        ${seasonFilterButtonHTML("all", "All", filter)}
        ${seasonFilterButtonHTML("unwatched", "Unwatched", filter)}
        ${seasonFilterButtonHTML("aired", "Aired", filter)}
        ${seasonFilterButtonHTML("watched", "Watched", filter)}
      </div>
      <div class="season-action-row">
        <button type="button" class="season-action-btn" data-season-action="aired">Mark Aired</button>
        <button type="button" class="season-action-btn" data-season-action="season">Mark Season</button>
      </div>
    </div>
    <div class="season-list">
      ${visibleRows.length
        ? visibleRows.map(ep => seasonEpisodeRowHTML(ep, showId, seasonNumber)).join("")
        : '<div class="season-placeholder">No episodes in this filter</div>'}
    </div>
  `;
  bindImageFallbacks(body);

  body.querySelectorAll(".season-filter-btn").forEach(btn =>
    btn.addEventListener("click", () => {
      const nextFilter = btn.dataset.filter || "all";
      if (nextFilter === section.dataset.filter) return;
      section.dataset.filter = nextFilter;
      const cached = getSeasonEpisodesFromCache(section);
      renderSeasonEpisodes(section, cached);
    })
  );

  body.querySelectorAll(".season-action-btn").forEach(btn =>
    btn.addEventListener("click", () => {
      handleSeasonBulkAction(section, btn.dataset.seasonAction);
    })
  );

  body.querySelectorAll(".ep-before-btn").forEach(btn =>
    btn.addEventListener("click", e => {
      e.stopPropagation();
      const targetNum = Number(btn.dataset.epnum || 0);
      handleMarkBeforeEpisode(section, targetNum);
    })
  );

  body.querySelectorAll(".ep-watch-btn").forEach(btn =>
    btn.addEventListener("click", () => toggleEpWatch(btn, btn.dataset.eid, section))
  );

  const watched = allRows.filter(ep => ep.watched).length;
  updateSeasonBadge(section, watched, allRows.length);
}

function seasonFilterButtonHTML(id, label, activeFilter) {
  return `<button type="button" class="season-filter-btn ${activeFilter === id ? "active" : ""}" data-filter="${id}">${label}</button>`;
}

function filterSeasonEpisodeRows(rows, filter) {
  if (filter === "unwatched") {
    return rows.filter(ep => !ep.watched);
  }
  if (filter === "watched") {
    return rows.filter(ep => ep.watched);
  }
  if (filter === "aired") {
    return rows.filter(ep => isEpisodeAired(ep.airDate));
  }
  return rows;
}

function seasonEpisodeRowHTML(ep, showId, seasonNumber) {
  const airDate = ep.airDate ? fmtDate(ep.airDate) : "";
  return `
    <div class="ep-row">
      <div class="ep-thumb">
        ${ep.thumbnail ? `<img src="${ep.thumbnail}" alt="" data-fallback="thumb-fallback">` : "EP"}
      </div>
      <div class="ep-main">
        <div class="ep-top-row">
          <span class="ep-number">E${String(ep.number).padStart(2, "0")}</span>
          <span class="ep-name" title="${esc(ep.name || `Episode ${ep.number}`)}">${esc(ep.name || `Episode ${ep.number}`)}</span>
        </div>
        <div class="ep-sub-row">
          ${airDate ? `<span class="ep-date">${airDate}</span>` : ""}
          ${airStatusBadgeHTML(ep.airDate)}
        </div>
      </div>
      <button class="ep-before-btn" type="button" data-epnum="${attr(ep.number)}" title="Mark all before this watched">Before</button>
      <button class="ep-watch-btn ${ep.watched ? "watched" : ""}" data-eid="${attr(ep.id)}" data-sid="${attr(showId)}" data-season="${attr(seasonNumber)}" title="${ep.watched ? "Unwatch" : "Watch"}">
        ${ep.watched ? checkSVG : ""}
      </button>
    </div>
  `;
}

function hydrateSeasonEpisodes(section, episodes) {
  const rows = (Array.isArray(episodes) ? episodes : []).map(ep => ({ ...ep }));
  const seenHint = Number(section.dataset.seenHint || 0);
  const watchedCount = rows.filter(ep => ep.watched).length;
  if (watchedCount === 0 && seenHint > 0) {
    return rows
      .sort((a, b) => (Number(a.number) || 0) - (Number(b.number) || 0))
      .map((ep, index) => ({
        ...ep,
        watched: index < seenHint,
      }));
  }
  return rows;
}

function getSeasonEpisodesFromCache(section) {
  const key = seasonCacheKey(section?.dataset?.showId, Number(section?.dataset?.season || 0));
  return seasonEpisodesCache.get(key) || [];
}

function setSeasonEpisodesCache(section, rows) {
  const key = seasonCacheKey(section?.dataset?.showId, Number(section?.dataset?.season || 0));
  seasonEpisodesCache.set(key, rows);
}

function seasonCacheKey(showId, seasonNumber) {
  return `${showId}:${seasonNumber}`;
}

// ========== EPISODE ACTIONS ==========
function syncWatchListAfterToggle(episodeId, nextWatched) {
  const targetId = String(episodeId);
  for (const filter of WATCHLIST_GROUP_ORDER) {
    const rows = watchListState.groups[filter] || [];
    if (!rows.length) continue;
    const updated = [];
    for (const ep of rows) {
      if (String(ep.id) !== targetId) {
        updated.push(ep);
        continue;
      }
      if (!nextWatched) {
        updated.push({ ...ep, watched: false });
      }
    }
    watchListState.groups[filter] = updated;
  }
  upNextCache = flattenWatchListEpisodes();
}

function syncUpcomingAfterToggle(episodeId, nextWatched) {
  if (!Array.isArray(upcomingCache)) return;
  const targetId = String(episodeId);
  if (nextWatched) {
    upcomingCache = upcomingCache.filter(ep => String(ep.id) !== targetId);
    return;
  }
  upcomingCache = upcomingCache.map(ep => (
    String(ep.id) === targetId ? { ...ep, watched: false } : ep
  ));
}

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
    const nextWatched = !was;
    btn.classList.toggle("watched");
    btn.innerHTML = nextWatched ? checkSVG : playSVG;
    showToast(was ? "Unwatched" : "Watched!");

    syncWatchListAfterToggle(episodeId, nextWatched);
    syncUpcomingAfterToggle(episodeId, nextWatched);

    if (currentTab === "watch-list") {
      const list = $("#watch-list-list");
      if (list) renderWatchListQueue(list);
    } else if (currentTab === "upcoming") {
      const list = $("#upcoming-list");
      if (list) renderUpcomingQueue(list, upcomingCache || []);
    }
  } catch (ex) {
    btn.innerHTML = was ? checkSVG : playSVG;
    showToast(ex?.message || "Failed", "error");
  } finally {
    btn.disabled = false;
  }
}

async function toggleEpWatch(btn, episodeId, section = null) {
  if (!episodeId) {
    showToast("Episode ID missing", "error");
    return;
  }
  const was = btn.classList.contains("watched");
  btn.disabled = true;
  try {
    const r = await msg({ action: was ? "markUnwatched" : "markWatched", episodeId });
    if (r?.error) throw new Error(r.error);
    const nextWatched = !was;
    btn.classList.toggle("watched");
    btn.innerHTML = nextWatched ? checkSVG : "";
    showToast(was ? "Unwatched" : "Watched!");
    syncWatchListAfterToggle(episodeId, nextWatched);
    syncUpcomingAfterToggle(episodeId, nextWatched);
    const seasonSection = section || btn.closest(".season-section");
    if (seasonSection) {
      const cached = getSeasonEpisodesFromCache(seasonSection);
      const updated = cached.map(ep => (
        String(ep.id) === String(episodeId)
          ? { ...ep, watched: nextWatched }
          : ep
      ));
      setSeasonEpisodesCache(seasonSection, updated);
      renderSeasonEpisodes(seasonSection, updated);
    }
    if (currentTab === "watch-list") {
      const list = $("#watch-list-list");
      if (list) renderWatchListQueue(list);
    } else if (currentTab === "upcoming") {
      const list = $("#upcoming-list");
      if (list) renderUpcomingQueue(list, upcomingCache || []);
    }
  } catch (ex) {
    showToast(ex?.message || "Failed", "error");
  } finally {
    btn.disabled = false;
  }
}

async function handleSeasonBulkAction(section, action) {
  const rows = getSeasonEpisodesFromCache(section);
  if (!rows.length) return;

  let targets = [];
  if (action === "aired") {
    targets = rows.filter(ep => !ep.watched && isEpisodeAired(ep.airDate));
  } else if (action === "season") {
    targets = rows.filter(ep => !ep.watched);
  }

  if (!targets.length) {
    showToast("No episodes to update");
    return;
  }

  const result = await markEpisodesWatchedBulk(targets.map(ep => ep.id), section);
  if (!result.updatedIds.size) {
    showToast("No episodes updated", "error");
    return;
  }

  const updated = rows.map(ep => (
    result.updatedIds.has(String(ep.id)) ? { ...ep, watched: true } : ep
  ));
  setSeasonEpisodesCache(section, updated);
  renderSeasonEpisodes(section, updated);
  for (const id of result.updatedIds) {
    syncWatchListAfterToggle(id, true);
    syncUpcomingAfterToggle(id, true);
  }
  if (currentTab === "watch-list") {
    const list = $("#watch-list-list");
    if (list) renderWatchListQueue(list);
  } else if (currentTab === "upcoming") {
    const list = $("#upcoming-list");
    if (list) renderUpcomingQueue(list, upcomingCache || []);
  }
  showToast(
    result.failed > 0
      ? `Updated ${result.updatedIds.size}, failed ${result.failed}`
      : `Updated ${result.updatedIds.size} episode${result.updatedIds.size > 1 ? "s" : ""}`
  );
}

async function handleMarkBeforeEpisode(section, episodeNumber) {
  if (!section || !episodeNumber) return;
  const rows = getSeasonEpisodesFromCache(section);
  if (!rows.length) return;

  const targets = rows.filter(ep => !ep.watched && Number(ep.number || 0) < episodeNumber);
  if (!targets.length) {
    showToast("No previous episodes to mark");
    return;
  }

  const result = await markEpisodesWatchedBulk(targets.map(ep => ep.id), section);
  if (!result.updatedIds.size) {
    showToast("No episodes updated", "error");
    return;
  }

  const updated = rows.map(ep => (
    result.updatedIds.has(String(ep.id)) ? { ...ep, watched: true } : ep
  ));
  setSeasonEpisodesCache(section, updated);
  renderSeasonEpisodes(section, updated);
  for (const id of result.updatedIds) {
    syncWatchListAfterToggle(id, true);
    syncUpcomingAfterToggle(id, true);
  }
  if (currentTab === "watch-list") {
    const list = $("#watch-list-list");
    if (list) renderWatchListQueue(list);
  } else if (currentTab === "upcoming") {
    const list = $("#upcoming-list");
    if (list) renderUpcomingQueue(list, upcomingCache || []);
  }
  showToast(
    result.failed > 0
      ? `Marked ${result.updatedIds.size}, failed ${result.failed}`
      : `Marked ${result.updatedIds.size} previous episode${result.updatedIds.size > 1 ? "s" : ""}`
  );
}

async function markEpisodesWatchedBulk(episodeIds, section) {
  const ids = (Array.isArray(episodeIds) ? episodeIds : []).filter(Boolean).map(id => String(id));
  if (!ids.length) return { updatedIds: new Set(), failed: 0 };

  setSeasonActionsDisabled(section, true);
  const updatedIds = new Set();
  let failed = 0;
  for (const id of ids) {
    const res = await msg({ action: "markWatched", episodeId: id });
    if (res?.error) {
      failed += 1;
      continue;
    }
    updatedIds.add(id);
  }
  setSeasonActionsDisabled(section, false);
  return { updatedIds, failed };
}

function setSeasonActionsDisabled(section, disabled) {
  if (!section) return;
  section.querySelectorAll(".season-action-btn, .ep-before-btn, .ep-watch-btn, .season-filter-btn").forEach(btn => {
    btn.disabled = Boolean(disabled);
  });
}

function bindDetailHeroActions(hero, showId) {
  if (!hero) return;
  hero.querySelectorAll(".detail-next-btn").forEach(btn =>
    btn.addEventListener("click", e => {
      e.stopPropagation();
      handleDetailNextEpisodeAction(btn, showId);
    })
  );
}

function bindSeasonJumpActions(hero, content, requestId) {
  if (!hero || !content) return;
  const jumpButtons = hero.querySelectorAll(".season-jump-btn");
  if (!jumpButtons.length) return;

  const setActive = season => {
    jumpButtons.forEach(btn => btn.classList.toggle("active", String(btn.dataset.seasonJump || "") === String(season || "")));
  };

  jumpButtons.forEach(btn =>
    btn.addEventListener("click", async () => {
      const season = String(btn.dataset.seasonJump || "");
      const target = content.querySelector(`.season-section[data-season="${season}"]`);
      if (!target) return;

      setActive(season);
      const header = target.querySelector(".season-header");
      const body = target.querySelector(".season-episodes");
      if (header && body && header.classList.contains("collapsed")) {
        await toggleSeasonSection(target, requestId);
      } else {
        await ensureSeasonEpisodesLoaded(target, requestId);
      }

      content.scrollTo({ top: Math.max(0, target.offsetTop - 6), behavior: "smooth" });
    })
  );

  const openSection = content.querySelector(".season-section .season-header:not(.collapsed)")?.closest(".season-section");
  if (openSection?.dataset?.season) {
    setActive(openSection.dataset.season);
  }
}

async function handleDetailNextEpisodeAction(btn, showId) {
  const episodeId = btn.dataset.nextEid;
  if (!episodeId) return;
  const was = btn.dataset.nextWatched === "1";
  btn.disabled = true;
  try {
    const res = await msg({ action: was ? "markUnwatched" : "markWatched", episodeId });
    if (res?.error) throw new Error(res.error);

    const nowWatched = !was;
    btn.dataset.nextWatched = nowWatched ? "1" : "0";
    btn.classList.toggle("watched", nowWatched);
    btn.textContent = nowWatched ? "Mark Unwatched" : "Mark Watched";
    showToast(nowWatched ? "Watched!" : "Unwatched!");
    syncWatchListAfterToggle(episodeId, nowWatched);
    syncUpcomingAfterToggle(episodeId, nowWatched);

    if (showId) {
      const prefix = `${showId}:`;
      for (const [key, episodes] of seasonEpisodesCache.entries()) {
        if (!key.startsWith(prefix)) continue;
        const updated = episodes.map(ep => (
          String(ep.id) === String(episodeId) ? { ...ep, watched: nowWatched } : ep
        ));
        seasonEpisodesCache.set(key, updated);
      }
      const detailContent = $("#detail-content");
      detailContent?.querySelectorAll('.season-section[data-loaded="true"]').forEach(section => {
        if (String(section.dataset.showId || "") !== String(showId)) return;
        renderSeasonEpisodes(section, getSeasonEpisodesFromCache(section));
      });
    }
    if (currentTab === "watch-list") {
      const list = $("#watch-list-list");
      if (list) renderWatchListQueue(list);
    } else if (currentTab === "upcoming") {
      const list = $("#upcoming-list");
      if (list) renderUpcomingQueue(list, upcomingCache || []);
    }
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
    const rows = getSeasonEpisodesFromCache(section);
    total = rows.length;
    watched = rows.filter(ep => ep.watched).length;
  }
  const ratio = total ? `${watched}/${total}` : "--";
  const progress = total ? `${Math.round((watched / total) * 100)}%` : "";
  badge.textContent = ratio;

  const meta = section.querySelector(".season-head-meta");
  if (meta) {
    const chips = meta.querySelectorAll("span");
    if (chips[0]) chips[0].textContent = total ? `${ratio} watched` : "--";
    if (chips[1]) {
      chips[1].textContent = progress;
      chips[1].style.display = progress ? "" : "none";
    }
    if (!chips[1] && progress) {
      const extra = document.createElement("span");
      extra.textContent = progress;
      meta.appendChild(extra);
    }
  }
}

function saveDetailViewState() {
  const panel = $("#show-detail");
  const content = $("#detail-content");
  if (!panel || !content || panel.classList.contains("hidden")) return;
  const showId = String(panel.dataset.showId || "");
  if (!showId) return;

  const openSection = content.querySelector(".season-section .season-header:not(.collapsed)")?.closest(".season-section");
  showDetailStateCache.set(showId, {
    season: openSection?.dataset?.season || "",
    scrollTop: content.scrollTop || 0,
  });
}

function extractNextEpisode(...sources) {
  const candidates = [];
  for (const source of sources) {
    if (!source || typeof source !== "object") continue;
    candidates.push(
      source.next_episode_to_watch,
      source.next_episode,
      source.nextEpisode,
      source.next_media_to_watch,
      source.up_next_episode,
      Array.isArray(source.to_watch_episodes) ? source.to_watch_episodes[0] : null,
      source.data?.next_episode_to_watch,
      source.data?.next_episode
    );
  }

  for (const raw of candidates) {
    const item = Array.isArray(raw) ? raw[0] : raw;
    if (!item || typeof item !== "object") continue;
    const id = item.id || item.episode_id;
    if (!id) continue;
    return {
      id,
      name: item.name || item.title || "",
      number: item.number || item.episode_number || 0,
      seasonNumber: item.season_number || item.season?.number || item.season || 0,
      airDate: item.air_date || item.aired || "",
      watched: Boolean(
        item.watched ||
        item.is_watched ||
        item.is_seen ||
        item.seen === true ||
        item.seen === 1 ||
        item.seen === "1" ||
        item.seen_date
      ),
    };
  }

  return null;
}

function isEpisodeAired(airDate) {
  const parsed = parseAirDate(airDate);
  if (!parsed) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const aired = new Date(parsed);
  aired.setHours(0, 0, 0, 0);
  return aired.getTime() <= today.getTime();
}

function airStatusToken(airDate) {
  const parsed = parseAirDate(airDate);
  if (!parsed) return { label: "No Date", className: "none" };

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const aired = new Date(parsed);
  aired.setHours(0, 0, 0, 0);
  const dayDiff = Math.round((aired.getTime() - today.getTime()) / 86400000);

  if (dayDiff < 0) return { label: "Aired", className: "aired" };
  if (dayDiff === 0) return { label: "Today", className: "today" };
  if (dayDiff === 1) return { label: "Tomorrow", className: "tomorrow" };
  return { label: "Upcoming", className: "upcoming" };
}

function airStatusBadgeHTML(airDate) {
  const token = airStatusToken(airDate);
  return `<span class="air-badge ${token.className}">${token.label}</span>`;
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
    airDate: ep.air_date || ep.aired || ep.air_datetime || ep.airing_at || "",
    airDateTime: ep.air_datetime || ep.airing_at || ep.air_at || ep.air_date || ep.aired || "",
    channel:
      ep.channel ||
      ep.channel_name ||
      ep.broadcast_channel ||
      ep.network ||
      ep.show?.network ||
      ep.show?.channel ||
      "",
    airTime:
      ep.air_time ||
      ep.time ||
      ep.local_time ||
      ep.airing_time ||
      "",
    toWatchCategory: ep.to_watch_category || ep.toWatchCategory || "",
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

function extractUpcomingEpisodes(data) {
  const rows = [...extractEpisodes(data)];
  for (const arr of collectEpisodeArrays(data)) {
    rows.push(...extractEpisodes({ episodes: arr }));
  }

  const seen = new Set();
  return rows
    .filter(ep => {
      const key = String(
        ep.id ||
        `${ep.showId}:${ep.seasonNumber}:${ep.number}:${ep.airDateTime || ep.airDate || ""}`
      );
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map(ep => ({
    ...ep,
    airDateTime: ep.airDateTime || ep.airDate || "",
    channel: ep.channel || "",
    airTime: ep.airTime || "",
  }));
}

function collectEpisodeArrays(payload, out = [], depth = 0) {
  if (!payload || depth > 5) return out;
  if (Array.isArray(payload)) {
    if (payload.length && looksLikeEpisodeShape(payload[0])) {
      out.push(payload);
    } else {
      for (const item of payload) {
        collectEpisodeArrays(item, out, depth + 1);
      }
    }
    return out;
  }
  if (typeof payload !== "object") return out;
  for (const value of Object.values(payload)) {
    collectEpisodeArrays(value, out, depth + 1);
  }
  return out;
}

function looksLikeEpisodeShape(item) {
  if (!item || typeof item !== "object") return false;
  if ("episode_id" in item || "episode_number" in item) return true;
  if ("air_date" in item || "air_datetime" in item || "aired" in item) return true;
  if ("show_id" in item || "show_name" in item) return true;
  return false;
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
    thumbnail: purl(
      ep.thumbnail ||
      ep.screenshot ||
      ep.still ||
      ep.still_path ||
      ep.image ||
      ep.poster ||
      ep.all_images?.screenshot ||
      ep.all_images?.still ||
      ep.all_images?.poster ||
      ep.all_images
    ),
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
  const safeTitle = esc(String(title || ""));
  const safeSub = sub ? esc(String(sub)) : "";
  return `<div class="state-msg ${type}">
    ${type === "loading" ? '<div class="spinner"></div>' : `<div class="state-icon">${icons[type]}</div>`}
    <div class="state-title">${safeTitle}</div>
    ${safeSub ? `<div class="state-sub">${safeSub}</div>` : ""}
  </div>`;
}

function episodeCardHTML(ep) {
  return `
    <div class="episode-card" data-sid="${attr(ep.showId)}" data-sname="${esc(ep.showName)}">
      <div class="ep-poster">${ep.poster ? `<img src="${ep.poster}" alt="" data-fallback="hide">` : "📺"}</div>
      <div class="ep-info">
        <div class="ep-show">${esc(ep.showName)}</div>
        <div class="ep-title">${esc(ep.name || `Episode ${ep.number}`)}</div>
        <div class="ep-meta">
          <span>S${pad(ep.seasonNumber)}E${pad(ep.number)}${ep.airDate ? " · " + fmtDate(ep.airDate) : ""}</span>
          ${airStatusBadgeHTML(ep.airDate)}
        </div>
      </div>
      <button class="watch-btn ${ep.watched ? "watched" : ""}" data-eid="${attr(ep.id)}">${ep.watched ? checkSVG : playSVG}</button>
    </div>
  `;
}

function upcomingCardHTML(ep) {
  const rightTime = formatUpcomingTime(ep);
  const rightChannel = String(ep.channel || "").trim();
  return `
    <div class="upcoming-card" data-sid="${attr(ep.showId)}" data-sname="${esc(ep.showName)}">
      <div class="ep-poster">${ep.poster ? `<img src="${ep.poster}" alt="" data-fallback="hide">` : "📺"}</div>
      <div class="upcoming-main">
        <div class="ep-show">${esc(ep.showName)}</div>
        <div class="ep-title">${esc(ep.name || `Episode ${ep.number}`)}</div>
        <div class="ep-meta">
          <span>S${pad(ep.seasonNumber)}E${pad(ep.number)}</span>
          ${airStatusBadgeHTML(ep.airDateTime || ep.airDate)}
        </div>
      </div>
      <div class="upcoming-right">
        <div class="upcoming-time">${esc(rightTime)}</div>
        <div class="upcoming-channel">${esc(rightChannel || "")}</div>
        <button class="watch-btn ${ep.watched ? "watched" : ""}" data-eid="${attr(ep.id)}">
          ${ep.watched ? checkSVG : playSVG}
        </button>
      </div>
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
        <div class="search-meta">${esc(String(show.year || ""))}</div>
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
    try {
      chrome.runtime.sendMessage(data, r => {
        if (chrome.runtime.lastError) {
          resolve({ error: chrome.runtime.lastError.message || "No response" });
          return;
        }
        resolve(r || { error: "No response" });
      });
    } catch (e) {
      resolve({ error: e?.message || "No response" });
    }
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
        return;
      }
      if (mode === "thumb-fallback") {
        if (img.parentElement) {
          img.parentElement.textContent = "EP";
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

function parseAirDate(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;

  const text = String(value).trim();
  if (!text) return null;

  const dateOnly = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnly) {
    const [, y, m, d] = dateOnly;
    const parsed = new Date(Number(y), Number(m) - 1, Number(d), 12, 0, 0, 0);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function fmtDate(s) {
  if (!s) return "";
  try {
    const parsed = parseAirDate(s);
    if (!parsed) return "";
    return parsed.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  } catch {
    return s;
  }
}

function formatUpcomingTime(ep) {
  const explicit = String(ep?.airTime || "").trim();
  if (explicit) {
    const parsedExplicit = parseAirDate(`1970-01-01T${explicit}`);
    if (parsedExplicit) {
      return parsedExplicit.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    }
    return explicit;
  }

  const parsed = parseAirDate(ep?.airDateTime || ep?.airDate || "");
  if (!parsed) return "";
  return parsed.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
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
