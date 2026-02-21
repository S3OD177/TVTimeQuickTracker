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

const esc = s => s ? String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;") : "";
const attr = s => s ? String(s).replace(/"/g, "&quot;") : "";

/**
 * Sanitizes and normalizes media URLs, ignoring non-paths
 * @param {string} raw - Raw URL string
 * @returns {string} - Clean absolute URL or empty string
 */
function safeMediaUrl(raw) {
  if (!raw || typeof raw !== "string") return "";
  const trimmed = raw.trim();
  if (!trimmed) return "";

  // If it's already a full URL, just return it
  if (trimmed.startsWith("http")) return trimmed;

  // TV Time endpoints often return paths like "/posters/123.jpg" 
  // or relative filenames like "456x789/789.jpg"
  try {
    const absolute = trimmed.startsWith("//") ? `https:${trimmed}` :
      (trimmed.startsWith("/") ? trimmed : `/${trimmed}`);

    // TV Time images can be on either TVDB or their own statics host
    let base = "https://artworks.thetvdb.com/";
    if (absolute.includes("/nb_episodes/") || absolute.includes("/show-") || !absolute.includes("banners/")) {
      base = "https://statics.tvtime.com/";
    }

    const url = new URL(absolute, base);
    return url.href;
  } catch {
    return "";
  }
}


// ========== INIT ==========
document.addEventListener("DOMContentLoaded", () => {
  setupEvents();
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
  on("#upcoming-view-btn", "click", toggleUpcomingView);

  on("#toggle-password", "click", () => {
    const input = $("#password");
    if (!input) return;
    const type = input.getAttribute("type") === "password" ? "text" : "password";
    input.setAttribute("type", type);
    const btn = $("#toggle-password");
    if (type === "text") {
      btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;
    } else {
      btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
    }
  });

  // Watch List Toolbar
  document.body.addEventListener("click", (e) => {
    if (e.target.closest(".state-retry-btn")) {
      const btn = document.querySelector("#refresh-btn");
      if (btn) btn.click();
    }
  });

  setupHeroEvents();
}

function setupHeroEvents() {
  const hero = $("#hero");
  if (!hero) return;

  const detailPanel = $("#show-detail");
  if (detailPanel) {
    detailPanel.classList.add("show-detail-panel");
    detailPanel.addEventListener("scroll", () => {
      const isScrolled = detailPanel.scrollTop > 10;
      detailPanel.classList.toggle("scrolled", isScrolled);
    });
  }

  // Simplified hero: remove tabs logic
  const heroTabs = hero.querySelector(".hero-tabs");
  if (heroTabs) heroTabs.remove();
  const heroContent = hero.querySelector(".hero-content");
  if (heroContent) heroContent.classList.add("no-tabs");
}

checkAuthAndRoute();

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
      .catch(() => { })
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


    // Check local storage for pending search (from context menu)
    chrome.storage.local.get("pendingSearch", async (data) => {
      const storageQuery = data.pendingSearch;
      if (storageQuery) {
        await chrome.storage.local.remove("pendingSearch");
        handleSmartSearch(storageQuery);
        return;
      }

      // Check URL param as fallback (though likely unused now)
      const urlParams = new URLSearchParams(window.location.search);
      const urlQuery = urlParams.get("search");
      if (urlQuery) {
        handleSmartSearch(urlQuery);
      }
    });

    // Helper for smart search logic
    async function handleSmartSearch(query) {
      await loadWatchList();
      const allWatched = flattenWatchListEpisodes();
      const qLower = query.toLowerCase().trim();

      const match = allWatched.find(ep =>
        (ep.showName || "").toLowerCase() === qLower ||
        (ep.showName || "").toLowerCase().includes(qLower)
      );

      if (match && match.showId) {
        showToast(`Found "${match.showName}" in your list!`);
        openShowDetail(match.showId, match.showName);
      } else {
        openQuickPanel("search");
        const input = $("#search-input");
        if (input) {
          input.value = query;
          handleSearchInput({ target: input });
        }
      }
    }
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
      msg({ action: "login", username: $("#username").value.trim(), password: $("#password").value }),
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
      extractEpisodes(bundle?.groups?.[WATCHLIST_FILTERS.CONTINUE] || []),
      WATCHLIST_FILTERS.CONTINUE
    );
    const notWatched = normalizeWatchListRows(
      extractEpisodes(bundle?.groups?.[WATCHLIST_FILTERS.NOT_WATCHED] || []),
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



function renderWatchListQueue(container = $("#watch-list-list")) {
  if (!container) return;
  const query = watchListSearchQuery;

  const allEpisodes = flattenWatchListEpisodes();

  // Filter
  let rows = query ? filterWatchListEpisodes(allEpisodes, query) : allEpisodes;

  if (!rows.length) {
    if (query) {
      container.innerHTML = stateHTML("empty", `No matches for "${query}"`, "Try a different search");
    } else {
      container.innerHTML = stateHTML("empty", "No shows in Watch List", "You're all caught up! 🎉");
    }
    return;
  }

  container.innerHTML = `<div class="upnext-queue">${rows.map(ep => watchListCardHTML(ep)).join("")}</div>`;

  bindImageFallbacks(container);
  bindWatchListQueueEvents(container);
}





function watchListCardHTML(ep) {
  const cardHtml = episodeCardHTML(ep);
  const actionsHtml = `
    <div class="item-quick-actions">
      <button class="qa-btn" data-qa="hide-show" data-sid="${attr(ep.showId)}" title="Hide Show" aria-label="Hide Show">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>
      </button>
      <button class="qa-btn" data-qa="remove-show" data-sid="${attr(ep.showId)}" title="Stop Watching" aria-label="Stop Watching">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
      </button>
    </div>
  `;
  return cardHtml.replace('</div>', `${actionsHtml}</div>`);
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

  // Quick Actions
  container.querySelectorAll(".qa-btn").forEach(btn =>
    btn.addEventListener("click", async e => {
      e.stopPropagation();
      const action = btn.dataset.qa;
      const sid = btn.dataset.sid;
      if (!sid) return;

      if (action === "hide-show") {
        // Not fully implemented in background yet, but let's assume we have an action or just Archive
        // For now, let's just toast
        showToast("Hide feature coming soon!");
      } else if (action === "remove-show") {
        if (confirm("Stop watching this show?")) {
          // call background to stop watching
          const r = await msg({ action: "stopWatching", showId: sid });
          if (!r.error) {
            showToast("Show removed");
            // refresh
            refreshCurrentTab();
          } else {
            showToast("Failed to remove show", "error");
          }
        }
      }
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

  if (upcomingViewMode === "calendar") {
    renderUpcomingCalendar(episodes);
  }
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
let currentSearchQuery = "";
let currentSearchOffset = 0;
let isSearchingMore = false;

function handleSearchInput(e) {
  const q = e.target.value.trim();
  clearTimeout(searchTimeout);

  if (q === currentSearchQuery) return; // avoid reloading on exactly same query

  if (q.length < 2) {
    currentSearchQuery = "";
    $("#search-results").innerHTML = stateHTML("empty", "Search for a TV show");
    return;
  }

  $("#search-results").innerHTML = stateHTML("loading", "Searching...");

  searchTimeout = setTimeout(async () => {
    try {
      currentSearchQuery = q;
      currentSearchOffset = 0;
      const r = await msg({ action: "searchShows", query: q, offset: 0 });
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

      const hasMore = shows.length === 20 && !r.local;
      const loadMoreBtn = hasMore ? `<button id="search-load-more" class="load-more-btn">Load More</button>` : "";

      $("#search-results").innerHTML = header + `<div id="search-results-list">` + shows.map(searchResultHTML).join("") + `</div>` + loadMoreBtn;

      bindSearchResultsEvents($("#search-results-list"));

      if (hasMore) {
        $("#search-load-more").addEventListener("click", handleSearchLoadMore);
      }
    } catch {
      $("#search-results").innerHTML = stateHTML("error", "Search failed");
    }
  }, 400);
}

function bindSearchResultsEvents(container) {
  bindImageFallbacks(container);
  container.querySelectorAll(".follow-btn:not(.bound)").forEach(btn => {
    btn.classList.add("bound");
    btn.addEventListener("click", e => {
      e.stopPropagation();
      handleFollow(btn, btn.dataset.sid);
    });
  });
  container.querySelectorAll(".search-result:not(.bound)").forEach(row => {
    row.classList.add("bound");
    row.addEventListener("click", () => {
      const sid = row.dataset.sid;
      const sname = row.dataset.sname;
      if (sid) openShowDetail(sid, sname);
    });
  });
}

async function handleSearchLoadMore(e) {
  const btn = e.target;
  if (isSearchingMore) return;
  isSearchingMore = true;
  const originalText = btn.textContent;
  btn.textContent = "Loading...";
  btn.disabled = true;

  try {
    currentSearchOffset += 20;
    const r = await msg({ action: "searchShows", query: currentSearchQuery, offset: currentSearchOffset });
    if (r.error) throw new Error(r.error);

    let shows = extractSearchResults(r);
    if (!shows.length) {
      btn.remove();
      return;
    }

    const list = $("#search-results-list");
    const temp = document.createElement("div");
    temp.innerHTML = shows.map(searchResultHTML).join("");

    bindSearchResultsEvents(temp);

    while (temp.firstChild) {
      list.appendChild(temp.firstChild);
    }

    if (shows.length === 20) {
      btn.textContent = originalText;
      btn.disabled = false;
    } else {
      btn.remove();
    }

  } catch (err) {
    showToast("Failed to load more results", "error");
    btn.textContent = originalText;
    btn.disabled = false;
  } finally {
    isSearchingMore = false;
  }
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
    const [detailsResp, seasonsData] = await Promise.all([
      msg({ action: "getShowDetails", showId }),
      msg({ action: "getShowSeasons", showId }),
    ]);
    if (requestId !== detailRequestId) return;

    // Merge seasonal show info if the main details are sparse
    const d1 = seasonsData?.show || {};
    const d2 = detailsResp || {};

    // Try to find the show in our local cache (My Shows or Watch List)
    // The user explicitly requested to use the cached poster if available.
    const sidStr = String(showId);
    let cachedPoster = "";
    let cachedName = "";

    // Check "My Shows" cache
    const s1 = (showsCache || []).find(x => String(x.id) === sidStr);
    if (s1) {
      if (s1.poster) cachedPoster = s1.poster;
      if (s1.name) cachedName = s1.name;
    }

    // Check "Watch List" cache
    const s2 = (upNextCache || []).find(x => String(x.showId || x.show_id) === sidStr);
    if (!cachedPoster && s2) {
      if (s2.poster) cachedPoster = s2.poster;
      if (s2.name && !cachedName) cachedName = s2.name;
    }

    const details = { ...d1, ...d2 };
    details.following = !!(s1 || s2);

    // STRICT PRIORITY: If we have a cached poster, USE IT.
    if (cachedPoster) {
      details.poster = cachedPoster;
    } else {
      details.poster = pickPoster(details) || d1.poster || d2.poster;
    }

    if (!details.name) details.name = cachedName || d1.name || d2.name;

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

    const tabsHTML = "";

    content.innerHTML = tabsHTML + seasons.map((season, i) =>
      buildSeasonShellHTML(showId, season, i === seasons.length - 1)
    ).join("");

    content.querySelectorAll(".season-section").forEach(section => {
      const header = section.querySelector(".season-header");
      if (!header) return;

      header.addEventListener("click", (e) => {
        // Stop toggle if clicking on the watch button
        if (e.target.closest(".season-watch-btn")) return;
        toggleSeasonSection(section, requestId);
      });

      const watchBtn = section.querySelector(".season-watch-btn");
      if (watchBtn) {
        watchBtn.addEventListener("click", async (e) => {
          e.stopPropagation();
          watchBtn.classList.add("loading");
          try {
            await ensureSeasonEpisodesLoaded(section, requestId);
            await handleSeasonBulkAction(section, "season");
          } finally {
            watchBtn.classList.remove("loading");
          }
        });
      }
    });

    const saved = showDetailStateCache.get(String(showId));
    if (saved?.season) {
      const targetSeason = String(saved.season);
      content.querySelectorAll(".season-section").forEach(section => {
        const header = section.querySelector(".season-header");
        const body = section.querySelector(".season-episodes");
        if (!header || !body) return;
        const isTarget = String(section.dataset.season || "") === targetSeason;
        header.classList.toggle("expanded", isTarget); // Changed from collapsed logic to expanded
        body.classList.toggle("collapsed", !isTarget);
      });
    }

    const initialSection = content.querySelector(".season-section .season-header.expanded")?.closest(".season-section");
    if (initialSection) {
      await ensureSeasonEpisodesLoaded(initialSection, requestId);
    }

    if (saved && Number.isFinite(saved.scrollTop)) {
      requestAnimationFrame(() => {
        if (requestId !== detailRequestId) return;
        const scroller = $("#show-detail");
        if (scroller) scroller.scrollTop = Math.max(0, Number(saved.scrollTop) || 0);
      });
    }
  } catch (e) {
    if (requestId !== detailRequestId) return;
    console.error(e);
    content.innerHTML = stateHTML("error", "Couldn't load show details", e?.message || "Unknown error");
  }
}

function renderShowHero(hero, details, showName, stats) {
  const poster = purl(details?.poster);
  const fanart = purl(
    details.fanart || details.all_images?.fanart ||
    details.backdrop || details.backdrop_path ||
    details.images?.fanart || details.images?.backdrop ||
    details.banner || details.background ||
    details.all_images?.banner || details.all_images?.background || ""
  );
  const network = details.network || details.channel || "";
  const displayName = details.name || showName || "Show";
  const seasonCount = Number(stats?.seasonCount) || 0;
  const totalEpisodes = Number(stats?.totalEpisodes) || 0;
  let watchedEpisodes = Math.min(Number(stats?.watchedEpisodes) || 0, totalEpisodes || 0);

  // Fallback for missing season-level progress in the API
  if (watchedEpisodes === 0 && totalEpisodes > 0) {
    watchedEpisodes = Math.min(
      Number(
        details.user_progress?.seen_count ??
        details.user_progress?.watched ??
        details.user_progress?.viewed_count ??
        details.seen_episodes ??
        0
      ),
      totalEpisodes
    );
  }

  const progressValue = totalEpisodes > 0 ? Math.round((watchedEpisodes / totalEpisodes) * 100) : 0;
  const status = details.status || details.show_status || details.production_status || "";
  const year =
    details.year ||
    details.first_air_date?.substring?.(0, 4) ||
    details.release_date?.substring?.(0, 4) ||
    "";

  // New: extract extra API fields
  const rating = Number(details.rating || details.vote_average || details.imdb_rating || 0);
  const rawGenres = details.genres || details.genre || details.genre_list || [];
  const genres = (Array.isArray(rawGenres) ? rawGenres : String(rawGenres).split(","))
    .map(g => typeof g === "object" ? (g.name || g.label || "") : String(g).trim())
    .filter(Boolean);
  const runtime = Number(details.runtime || details.episode_runtime?.[0] || details.episode_run_time?.[0] || details.average_runtime || 0);
  const remaining = Math.max(0, totalEpisodes - watchedEpisodes);

  let timeStr = "";
  if (remaining > 0 && runtime > 0) {
    const totalMins = remaining * runtime;
    const hrs = Math.floor(totalMins / 60);
    const mins = totalMins % 60;
    timeStr = hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;
  }

  // PREMIUM TRACKTV LAYOUT HTML
  let html = `
    <div class="premium-hero">
      <div class="hero-backdrop">
        <img src="${fanart || poster}" alt="Backdrop" data-fallback="fanart-fallback">
        <div class="hero-gradient-top"></div>
        <div class="hero-gradient-bottom"></div>
      </div>
      
      <div class="hero-main">
        <div class="hero-meta-badges">
          ${status ? `<span class="hero-badge">${esc(status)}</span>` : ""}
          <span class="hero-badge hero-badge--secondary">${seasonCount} Seasons</span>
        </div>
        
        <h1 class="hero-title">${esc(displayName)}</h1>
        
        <div class="hero-sub-meta">
          <span>${year}</span>
          <span class="dot"></span>
          <span>${esc(network)}</span>
          <span class="dot"></span>
          <span class="rating">
            <span class="material-symbols-outlined" style="font-size:16px; font-variation-settings:'FILL' 1">star</span>
            ${rating > 0 ? rating.toFixed(1) : "N/A"}
          </span>
        </div>

        <p class="hero-overview">${esc(details.overview || "")}</p>

        <div class="hero-actions">
           <button class="btn-primary" id="hero-resume-btn" 
                   data-next-season="${stats.nextEpisode?.seasonNumber || ""}" 
                   data-next-number="${stats.nextEpisode?.number || ""}">
             <span class="material-symbols-outlined">play_arrow</span>
             <span>Watch Next</span>
           </button>
           <button class="btn-icon-only ${details.following ? "active following" : ""}" id="hero-follow-btn">
             <span class="material-symbols-outlined">${details.following ? "check" : "add"}</span>
           </button>
           <button class="btn-icon-only" id="hero-share-btn" data-share-url="https://www.tvtime.com/show/${details.id}">
             <span class="material-symbols-outlined">share</span>
           </button>
        </div>
      </div>
    </div>
  `;

  hero.innerHTML = html;
  bindImageFallbacks(hero);

  // Bind text toggle
  const toggle = hero.querySelector(".overview-toggle");
  if (toggle) {
    toggle.addEventListener("click", () => {
      const full = hero.querySelector(".overview-full");
      const short = hero.querySelector(".overview-text");
      if (full.style.display === "none") {
        full.style.display = "inline";
        short.style.display = "none";
        toggle.textContent = "Show less";
      } else {
        full.style.display = "none";
        short.style.display = "inline";
        toggle.textContent = "Read more";
      }
    });
  }

  // Scroll effect binding (can be done here or mainly in scroll listener)
  const panel = document.querySelector("#show-detail");
  const title = document.querySelector("#detail-title");
  if (panel && title) {
    title.textContent = displayName;
    // We rely on CSS .scrolled class on panel for transition
  }
}

function buildSeasonShellHTML(showId, season, expanded) {
  const seasonNumber = Number(season.number) || 0;
  const watched = Number(season.watchedCount) || 0;
  const total = Number(season.episodeCount) || 0;
  const progress = total ? Math.round((Math.min(watched, total) / total) * 100) : 0;
  const remaining = Math.max(0, total - watched);
  const isCompleted = total > 0 && remaining === 0;

  return `
    <div class="season-section-v2 season-section" data-show-id="${attr(showId)}" data-season="${seasonNumber}" data-seen-hint="${Math.max(0, watched)}" data-loaded="false" data-loading="false" data-filter="all">
      <div class="season-header-v2 season-header ${expanded ? "expanded" : ""}">
        <div class="season-num-badge ${isCompleted ? 'completed' : ''}">${seasonNumber}</div>
        <div class="season-info-v2">
          <div class="season-name-v2">Season ${seasonNumber}</div>
          <div class="season-stats-v2">${watched} of ${total} eps • ${progress}% watched</div>
        </div>
        <div class="season-progress-v2">
          <div class="progress-bar-v2">
            <div class="progress-bar-fill-v2" style="width: ${progress}%"></div>
          </div>
        </div>
      </div>
      
      <div class="season-episodes ${expanded ? "" : "collapsed"}">
        <div class="season-placeholder">${expanded ? "Loading episodes..." : "Expand to load episodes"}</div>
      </div>
    </div>
  `;
}

async function toggleSeasonSection(section, requestId) {
  const header = section.querySelector(".season-header");
  const body = section.querySelector(".season-episodes");
  if (!header || !body) return;

  const wasExpanded = header.classList.contains("expanded");
  // Toggle
  if (wasExpanded) {
    header.classList.remove("expanded");
    body.classList.add("collapsed");
  } else {
    // Close others (accordion style) - optional, but nice for cleaner UI
    const content = $("#detail-content");
    if (content) {
      content.querySelectorAll(".season-section").forEach(s => {
        if (s !== section) {
          s.querySelector(".season-header")?.classList.remove("expanded");
          s.querySelector(".season-episodes")?.classList.add("collapsed");
        }
      });
    }

    header.classList.add("expanded");
    body.classList.remove("collapsed");
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
    body.innerHTML = `
        <div class="season-placeholder error">
          <div style="margin-bottom:8px">Failed to load episodes</div>
          <button class="season-action-btn" onclick="this.closest('.season-section').dataset.loading='false';this.closest('.season-section').querySelector('.season-header-modern').click();">Retry</button>
        </div>
      `;
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
  const searchTerm = (section.dataset.searchTerm || "").toLowerCase().trim();
  const searchedRows = searchTerm
    ? allRows.filter(ep => ep.name?.toLowerCase().includes(searchTerm) || String(ep.number).includes(searchTerm))
    : allRows;

  const visibleRows = filterSeasonEpisodeRows(searchedRows, filter);

  // Partial render logic: ONLY create controls if they don't exist
  let controls = body.querySelector(".season-controls");
  if (!controls) {
    body.innerHTML = `
      <div class="season-controls">
        <div class="season-search-bar">
          <input type="text" class="season-search-input" placeholder="Search episode..." value="${esc(section.dataset.searchTerm || "")}">
          <span class="material-symbols-outlined search-icon">search</span>
        </div>
        <div class="season-filter-row">
          ${seasonFilterButtonHTML("all", "All", filter)}
          ${seasonFilterButtonHTML("unwatched", "Unwatched", filter)}
          ${seasonFilterButtonHTML("aired", "Aired", filter)}
          ${seasonFilterButtonHTML("watched", "Watched", filter)}
        </div>
      </div>
      <div class="season-list"></div>
    `;
    controls = body.querySelector(".season-controls");

    // Bind control events ONCE
    const searchInput = controls.querySelector(".season-search-input");
    if (searchInput) {
      searchInput.addEventListener("input", () => {
        section.dataset.searchTerm = searchInput.value;
        const cached = getSeasonEpisodesFromCache(section);
        renderSeasonEpisodes(section, cached);
      });
    }

    controls.querySelectorAll(".season-filter-btn").forEach(btn =>
      btn.addEventListener("click", () => {
        const nextFilter = btn.dataset.filter || "all";
        if (nextFilter === section.dataset.filter) return;
        section.dataset.filter = nextFilter;

        // Update active class immediately
        controls.querySelectorAll(".season-filter-btn").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");

        const cached = getSeasonEpisodesFromCache(section);
        renderSeasonEpisodes(section, cached);
      })
    );
  }

  // Update visible list
  const list = body.querySelector(".season-list");
  if (list) {
    list.innerHTML = visibleRows.length
      ? visibleRows.map(ep => seasonEpisodeRowHTML(ep, showId, seasonNumber)).join("")
      : '<div class="season-placeholder">No episodes found' + (searchTerm ? ` for "${searchTerm}"` : "") + '</div>';

    bindImageFallbacks(list);

    list.querySelectorAll(".ep-before-btn").forEach(btn =>
      btn.addEventListener("click", e => {
        e.stopPropagation();
        const targetNum = Number(btn.dataset.epnum || 0);
        handleMarkBeforeEpisode(section, targetNum);
      })
    );

    list.querySelectorAll(".ep-watch-btn").forEach(btn =>
      btn.addEventListener("click", () => {
        const eid = btn.dataset.eid;
        const isWatched = btn.classList.contains("watched");
        btn.setAttribute("aria-pressed", !isWatched);
        toggleEpWatch(btn, eid, section);
      })
    );
  }

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
  const epNumLabel = String(ep.number).padStart(2, "0");
  const epTitle = (ep.name || `Episode ${ep.number}`).trim();

  // Avoid "E01 Episode 1" redundancy
  const showEpNum = !epTitle.toLowerCase().includes(`episode ${ep.number}`);

  return `
    <div class="ep-row-v2 ep-row ${ep.watched ? "watched" : ""}" data-eid="${attr(ep.id)}">
      <div class="ep-thumb-container-v2">
        ${ep.poster
      ? `<img src="${ep.poster}" alt="" data-fallback="thumb-fallback" loading="lazy">`
      : `<div class="ep-thumb-placeholder">E${epNumLabel}</div>`}
        ${ep.watched ? "" : `<div class="ep-play-overlay-v2"><span class="material-symbols-outlined">play_arrow</span></div>`}
      </div>
      
      <div class="ep-content-v2">
        <div class="ep-main-v2">
          <div class="ep-info-v2">
            <div class="ep-name-v2">${showEpNum ? `<span class="ep-num-v2">E${epNumLabel}</span> ` : ""}${esc(epTitle)}</div>
            <div class="ep-meta-v2">
              ${airDate ? `<span>${airDate}</span>` : ""}
              ${airStatusBadgeHTML(ep.airDate)}
            </div>
          </div>
          
          <button class="ep-watch-v2 ep-watch-btn ${ep.watched ? "watched" : ""}" 
                  data-eid="${attr(ep.id)}" 
                  data-sid="${attr(showId)}" 
                  data-season="${attr(seasonNumber)}" 
                  title="${ep.watched ? "Unwatch" : "Watch"}">
            ${ep.watched ? checkSVG : playSVG}
          </button>
        </div>
        
        ${ep.overview ? `<div class="ep-desc-v2">${esc(ep.overview)}</div>` : ""}
      </div>
      
      <div class="ep-actions-wrap" style="display:none;">
        <button class="ep-before-btn" type="button" data-epnum="${attr(ep.number)}">Before</button>
      </div>
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
  const card = btn.closest(".episode-card");
  const showId = card?.dataset.sid;
  const showName = card?.dataset.sname || "";

  btn.innerHTML = '<span class="spinner" style="width:14px;height:14px;border-width:2px;"></span>';
  btn.disabled = true;
  try {
    const r = await msg({ action: was ? "markUnwatched" : "markWatched", episodeId });
    if (r?.error) throw new Error(r.error);
    const nextWatched = !was;

    syncWatchListAfterToggle(episodeId, nextWatched);
    syncUpcomingAfterToggle(episodeId, nextWatched);

    if (currentTab === "watch-list" && nextWatched && card && showId) {
      // Fade out the watched card
      card.style.transition = "opacity .25s, max-height .3s";
      card.style.opacity = "0";

      // Fetch next episode for this show in background
      try {
        const fresh = await msg({
          action: "getWatchList",
          filter: "continue_watching",
          offset: 0,
          limit: 10,
          forceRefresh: true,
        });
        const episodes = extractEpisodes(fresh);
        const nextEp = episodes.find(ep => String(ep.showId) === String(showId));

        if (nextEp) {
          // Swap card with next episode
          setTimeout(() => {
            const newCard = document.createElement("div");
            newCard.innerHTML = watchListCardHTML(nextEp);
            const replacement = newCard.firstElementChild;
            replacement.style.opacity = "0";
            replacement.style.transition = "opacity .25s";
            card.replaceWith(replacement);
            bindImageFallbacks(replacement);
            // Bind events on the new card
            replacement.addEventListener("click", () => {
              openShowDetail(replacement.dataset.sid, replacement.dataset.sname);
            });
            const newBtn = replacement.querySelector(".watch-btn");
            if (newBtn) {
              newBtn.addEventListener("click", e => {
                e.stopPropagation();
                toggleWatch(newBtn, newBtn.dataset.eid);
              });
            }
            // Update local state
            for (const filter of WATCHLIST_GROUP_ORDER) {
              const rows = watchListState.groups[filter] || [];
              const hasShow = rows.some(ep => String(ep.showId) === String(showId));
              if (hasShow || filter === "continue_watching") {
                const withoutOld = rows.filter(ep => String(ep.id) !== String(episodeId));
                if (!withoutOld.some(ep => String(ep.showId) === String(showId))) {
                  withoutOld.push(nextEp);
                }
                watchListState.groups[filter] = withoutOld;
              }
            }
            upNextCache = flattenWatchListEpisodes();
            requestAnimationFrame(() => { replacement.style.opacity = "1"; });
          }, 250);
        } else {
          // No next episode — remove card
          setTimeout(() => {
            card.style.maxHeight = card.offsetHeight + "px";
            requestAnimationFrame(() => { card.style.maxHeight = "0"; card.style.overflow = "hidden"; });
            setTimeout(() => card.remove(), 300);
          }, 250);
        }
      } catch {
        // Silently fail — the card is already faded, just remove it
        setTimeout(() => card.remove(), 250);
      }
    } else {
      // Unwatching or on another tab — just update UI
      btn.classList.toggle("watched");
      btn.innerHTML = nextWatched ? checkSVG : playSVG;
      if (currentTab === "watch-list") {
        const list = $("#watch-list-list");
        if (list) renderWatchListQueue(list);
      } else if (currentTab === "upcoming") {
        const list = $("#upcoming-list");
        if (list) renderUpcomingQueue(list, upcomingCache || []);
      }
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
    btn.innerHTML = nextWatched ? checkSVG : playSVG;
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

  // Process in chunks of 5 to speed up the network calls without rate-limiting
  const chunkSize = 5;
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    const promises = chunk.map(async (id) => {
      try {
        const res = await msg({ action: "markWatched", episodeId: id });
        return { id, success: !res?.error };
      } catch (err) {
        return { id, success: false };
      }
    });

    const results = await Promise.all(promises);
    for (const r of results) {
      if (r.success) updatedIds.add(r.id);
      else failed += 1;
    }
  }

  setSeasonActionsDisabled(section, false);
  return { updatedIds, failed };
}

function setSeasonActionsDisabled(section, disabled) {
  if (!section) return;
  section.querySelectorAll(".season-action-btn, .ep-before-btn, .ep-watch-btn, .season-filter-btn, .season-watch-btn").forEach(btn => {
    btn.disabled = Boolean(disabled);
  });
}

function bindDetailHeroActions(hero, showId) {
  if (!hero) return;

  // 1. Resume / Watch Next button
  const resumeBtn = hero.querySelector("#hero-resume-btn");
  if (resumeBtn) {
    resumeBtn.addEventListener("click", () => {
      const s = resumeBtn.dataset.nextSeason;
      const n = resumeBtn.dataset.nextNumber;
      if (!s) {
        showToast("All caught up!");
        return;
      }

      // Look for the season section first
      const container = document.querySelector("#detail-content");
      const section = container?.querySelector(`.season-section[data-season="${s}"]`);
      if (section) {
        // Expand if collapsed
        const body = section.querySelector(".season-episodes");
        if (body?.classList.contains("collapsed")) {
          const header = section.querySelector(".season-header");
          header?.click();
        }

        // Scroll to it
        section.scrollIntoView({ behavior: "smooth", block: "start" });

        // Find the specific episode row if possible
        setTimeout(() => {
          const epRow = section.querySelector(`.ep-row[data-epnum="${n}"]`);
          if (epRow) {
            epRow.classList.add("highlight-flash");
            setTimeout(() => epRow.classList.remove("highlight-flash"), 2000);
          }
        }, 400);
      } else {
        showToast(`Next is Season ${s} Episode ${n}`);
      }
    });
  }

  // 2. Follow / Add button
  const followBtn = hero.querySelector("#hero-follow-btn");
  if (followBtn) {
    followBtn.addEventListener("click", async () => {
      const isFollowing = followBtn.classList.contains("following");
      followBtn.disabled = true;
      try {
        const res = await msg({ action: isFollowing ? "unfollowShow" : "followShow", showId });
        if (res?.error) throw new Error(res.error);

        followBtn.classList.toggle("following");
        followBtn.classList.toggle("active");
        const icon = followBtn.querySelector(".material-symbols-outlined");
        if (icon) icon.textContent = followBtn.classList.contains("following") ? "check" : "add";

        showToast(isFollowing ? "Removed from watchlist" : "Added to watchlist!");
        // Refresh watchlist in background if visible
        renderWatchListQueue();
      } catch (e) {
        showToast("Error updating watchlist");
      } finally {
        followBtn.disabled = false;
      }
    });
  }

  // 3. Share button
  const shareBtn = hero.querySelector("#hero-share-btn");
  if (shareBtn) {
    shareBtn.addEventListener("click", () => {
      const url = shareBtn.dataset.shareUrl;
      if (url) {
        navigator.clipboard.writeText(url);
        showToast("Link copied to clipboard!");
      }
    });
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

  let watched = watchedCount;
  let total = totalCount;
  if (watched === null || total === null) {
    const rows = getSeasonEpisodesFromCache(section);
    total = rows.length;
    watched = rows.filter(ep => ep.watched).length;
  }

  const progress = total ? Math.round((Math.min(watched, total) / total) * 100) : 0;
  const remaining = Math.max(0, total - watched);
  const isCompleted = total > 0 && remaining === 0;

  // 1. Update the 'X left' / 'Completed' tag (v1)
  const progressText = section.querySelector(".season-progress");
  if (progressText) {
    if (remaining > 0) {
      progressText.textContent = `${remaining} left`;
      progressText.style.color = "";
    } else {
      progressText.textContent = "Completed";
      progressText.style.color = "var(--success)";
    }
  }

  // 2. Update the fraction text (v1)
  const fractionDiv = section.querySelector(".season-header-actions > div");
  if (fractionDiv) {
    fractionDiv.textContent = `${watched}/${total}`;
  }

  // 3. Update the Season Watch checkmark button (v1)
  const watchBtn = section.querySelector(".season-watch-btn");
  if (watchBtn) {
    watchBtn.classList.toggle("watched", isCompleted);
  }

  // --- V2 UI Updates ---

  // 4. Update the stats text (v2)
  const statsV2 = section.querySelector(".season-stats-v2");
  if (statsV2) {
    statsV2.textContent = `${watched} of ${total} eps • ${progress}% watched`;
  }

  // 5. Update the progress bar (v2)
  const fillV2 = section.querySelector(".progress-bar-fill-v2");
  if (fillV2) {
    fillV2.style.width = `${progress}%`;
  }

  // 6. Update the number badge (v2)
  const badgeV2 = section.querySelector(".season-num-badge");
  if (badgeV2) {
    badgeV2.classList.toggle("completed", isCompleted);
  }
}

function saveDetailViewState() {
  const panel = $("#show-detail");
  const content = $("#detail-content");
  if (!panel || !content || panel.classList.contains("hidden")) return;
  const showId = String(panel.dataset.showId || "");
  if (!showId) return;

  const scroller = $("#show-detail");
  const openSection = content.querySelector(".season-section .season-header.expanded")?.closest(".season-section");
  showDetailStateCache.set(showId, {
    season: openSection?.dataset?.season || "",
    scrollTop: scroller?.scrollTop || 0,
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
    if (!raw) continue;
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
        item.is_watched ||
        item.seen ||
        item.watched ||
        item.user_progress?.watched ||
        item.user_progress?.seen ||
        item.user_progress?.viewed
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
        img.style.display = "none";
        const placeholder = document.createElement("div");
        placeholder.className = "ep-thumb-fallback-text";
        placeholder.textContent = "EP";
        img.after(placeholder);
        return;
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



function toggleUpcomingView() {
  upcomingViewMode = upcomingViewMode === "list" ? "calendar" : "list";
  const btn = $("#upcoming-view-btn");
  const list = $("#upcoming-list");
  const calendar = $("#upcoming-calendar");

  if (btn) {
    btn.querySelector(".icon-list").classList.toggle("hidden", upcomingViewMode === "list");
    btn.querySelector(".icon-calendar").classList.toggle("hidden", upcomingViewMode === "calendar");
  }

  if (upcomingViewMode === "calendar") {
    list.classList.add("hidden");
    calendar.classList.remove("hidden");
    if (!calendar.innerHTML && upcomingCache) {
      renderUpcomingCalendar(upcomingCache);
    }
  } else {
    list.classList.remove("hidden");
    calendar.classList.add("hidden");
  }
}

function renderUpcomingCalendar(episodes) {
  const container = $("#upcoming-calendar");
  if (!container) return;

  const rows = Array.isArray(episodes) ? episodes : [];
  const today = new Date();
  const year = today.getFullYear();
  const month = today.getMonth();

  // Get start of the week for the first day of the month
  const firstDayOfMonth = new Date(year, month, 1);
  const startDay = firstDayOfMonth.getDay(); // 0 is Sunday
  const startDate = new Date(firstDayOfMonth);
  startDate.setDate(startDate.getDate() - startDay);

  // Generate 35 days grid (5 weeks)
  const days = [];
  const current = new Date(startDate);
  for (let i = 0; i < 35; i++) {
    days.push(new Date(current));
    current.setDate(current.getDate() + 1);
  }

  // Group episodes by date key YYYY-MM-DD
  const byDate = new Map();
  for (const ep of rows) {
    const d = parseAirDate(ep.airDateTime || ep.airDate);
    if (!d) continue;
    const key = localDateKey(d);
    if (!byDate.has(key)) byDate.set(key, []);
    byDate.get(key).push(ep);
  }

  const html = days.map(date => {
    const key = localDateKey(date);
    const eps = byDate.get(key) || [];
    const isToday = key === localDateKey(today);
    const hasEpisodes = eps.length > 0;
    const dayClasses = `calendar-day ${isToday ? "today" : ""} ${hasEpisodes ? "has-episodes" : ""}`;

    const dots = eps.map(ep => {
      const isWatched = ep.watched;
      return `<div class="calendar-dot ${isWatched ? "watched" : "unwatched"}"></div>`;
    }).join("");

    const detailHtml = hasEpisodes ? `
      <div class="calendar-day-detail">
        <div style="font-size:11px;font-weight:700;margin-bottom:6px;color:var(--text);border-bottom:1px solid var(--border);padding-bottom:4px;">
          ${date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}
        </div>
        ${eps.map(ep => `
          <div class="cal-ep-row">
            <div class="cal-ep-poster"><img src="${esc(ep.poster || "icons/icon48.png")}"></div>
            <div class="cal-ep-info">
              <div class="cal-ep-show">${esc(ep.showName)}</div>
              <div class="cal-ep-title">${esc(ep.seasonNumber)}x${esc(ep.number)}</div>
            </div>
          </div>
        `).join("")}
      </div>
    ` : "";

    return `
      <div class="${dayClasses}">
        <div class="calendar-date">${date.getDate()}</div>
        <div class="calendar-dots">${dots}</div>
        ${detailHtml}
      </div>
    `;
  }).join("");

  container.innerHTML = `
    <div class="calendar-grid">
      <div class="calendar-day-header">Sun</div>
      <div class="calendar-day-header">Mon</div>
      <div class="calendar-day-header">Tue</div>
      <div class="calendar-day-header">Wed</div>
      <div class="calendar-day-header">Thu</div>
      <div class="calendar-day-header">Fri</div>
      <div class="calendar-day-header">Sat</div>
      ${html}
    </div>
  `;
}

// Previously duplicate updateSeasonBadge was here
