// ============================================================
// TV Time Quick Tracker - Popup v4
// ============================================================

const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);

let currentTab = "up-next";
let showsCache = null;
let upNextCache = null;
let searchTimeout = null;

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
  $("#detail-back").addEventListener("click", () => $("#show-detail").classList.add("hidden"));
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
  showsCache = upNextCache = null;
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
  if (currentTab === "up-next") { upNextCache = null; await loadUpNext(); }
  else if (currentTab === "my-shows") { showsCache = null; await loadMyShows(); }
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
    c.querySelectorAll(".watch-btn").forEach(btn =>
      btn.addEventListener("click", e => { e.stopPropagation(); toggleWatch(btn, btn.dataset.eid); })
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
      const shows = extractSearchResults(r);
      if (!shows.length) {
        $("#search-results").innerHTML = stateHTML("empty", `No results for "${esc(q)}"`);
        return;
      }
      let header = r.local ? `<div style="padding:8px 16px;font-size:11px;color:var(--text-muted);">Showing matches from your library</div>` : "";
      $("#search-results").innerHTML = header + shows.map(searchResultHTML).join("");
      $("#search-results").querySelectorAll(".follow-btn").forEach(btn =>
        btn.addEventListener("click", e => { e.stopPropagation(); handleFollow(btn, btn.dataset.sid); })
      );
      // Make search results clickable to open detail
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
    await msg({ action: was ? "unfollowShow" : "followShow", showId });
    btn.classList.toggle("following");
    btn.textContent = was ? "+ Follow" : "✓ Following";
    showToast(was ? "Unfollowed" : "Show added!");
    showsCache = null;
  } catch {
    btn.textContent = was ? "✓ Following" : "+ Follow";
    showToast("Failed", "error");
  } finally {
    btn.disabled = false;
  }
}

// ========== SHOW DETAIL ==========
async function openShowDetail(showId, showName) {
  const panel = $("#show-detail");
  const hero = $("#detail-hero");
  const content = $("#detail-content");
  $("#detail-title").textContent = showName || "Show";
  panel.classList.remove("hidden");
  hero.innerHTML = "";
  content.innerHTML = stateHTML("loading", "Loading show...");

  try {
    // Fetch show details and seasons in parallel
    const [details, seasonsData] = await Promise.all([
      msg({ action: "getShowDetails", showId }),
      msg({ action: "getShowSeasons", showId }),
    ]);

    // Build hero section
    const poster = purl(details.poster);
    const fanart = purl(details.fanart || details.all_images?.fanart);
    const network = details.network || "";
    const seasonCount = seasonsData.seasons?.length || details.season_count || 0;

    if (fanart || poster) {
      hero.innerHTML = `
        <div class="detail-hero">
          <img class="hero-bg" src="${fanart || poster}" alt="" onerror="this.style.display='none'">
          <div class="hero-gradient"></div>
          <div class="hero-content">
            ${poster ? `<div class="hero-poster"><img src="${poster}" alt="" onerror="this.parentElement.innerHTML='📺'"></div>` : ""}
            <div class="hero-info">
              <div class="hero-title">${esc(details.name || showName)}</div>
              <div class="hero-meta">
                ${network ? `<span>${esc(network)}</span>` : ""}
                ${seasonCount ? `<span>${seasonCount} season${seasonCount > 1 ? "s" : ""}</span>` : ""}
              </div>
            </div>
          </div>
        </div>
      `;
    }

    // Show overview/description if available
    if (details.overview) {
      hero.innerHTML += `<div style="padding:12px 16px;font-size:12px;color:var(--text-secondary);line-height:1.6;">${esc(details.overview).substring(0, 200)}${details.overview.length > 200 ? "..." : ""}</div>`;
    }

    // Build seasons
    const seasons = extractSeasons(seasonsData);
    if (!seasons.length) {
      content.innerHTML = stateHTML("empty", "No season data");
      return;
    }

    // Load episodes for each season
    let html = "";
    const epPromises = seasons.map(s => msg({ action: "getSeasonEpisodes", showId, seasonNumber: s.number }));
    const epResults = await Promise.all(epPromises);

    seasons.forEach((season, i) => {
      const episodes = extractSeasonEpisodes(epResults[i]);
      const isLast = i === seasons.length - 1;
      const watchedCount = episodes.filter(e => e.watched).length;
      const totalCount = episodes.length;

      html += `
        <div class="season-section">
          <div class="season-header ${isLast ? "" : "collapsed"}" data-season="${season.number}">
            <svg class="chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>
            Season ${season.number}
            <span class="season-badge">${watchedCount}/${totalCount}</span>
          </div>
          <div class="season-episodes ${isLast ? "" : "collapsed"}">
            ${episodes.map(ep => `
              <div class="ep-row">
                <span class="ep-number">E${String(ep.number).padStart(2, "0")}</span>
                <span class="ep-name" title="${esc(ep.name)}">${esc(ep.name || `Episode ${ep.number}`)}</span>
                ${ep.airDate ? `<span class="ep-date">${fmtDate(ep.airDate)}</span>` : ""}
                <button class="ep-watch-btn ${ep.watched ? "watched" : ""}" data-eid="${ep.id}" title="${ep.watched ? "Unwatch" : "Watch"}">
                  ${ep.watched ? checkSVG : ""}
                </button>
              </div>
            `).join("") || '<div class="ep-row"><span class="ep-name" style="color:var(--text-muted)">No episodes</span></div>'}
          </div>
        </div>
      `;
    });

    content.innerHTML = html;

    // Events
    content.querySelectorAll(".season-header").forEach(h =>
      h.addEventListener("click", () => {
        h.classList.toggle("collapsed");
        h.nextElementSibling.classList.toggle("collapsed");
      })
    );
    content.querySelectorAll(".ep-watch-btn").forEach(btn =>
      btn.addEventListener("click", () => toggleEpWatch(btn, btn.dataset.eid))
    );
  } catch (err) {
    content.innerHTML = stateHTML("error", "Couldn't load show details");
  }
}

async function toggleWatch(btn, episodeId) {
  const was = btn.classList.contains("watched");
  btn.innerHTML = '<span class="spinner" style="width:14px;height:14px;border-width:2px;"></span>';
  btn.disabled = true;
  try {
    await msg({ action: was ? "markUnwatched" : "markWatched", episodeId });
    btn.classList.toggle("watched");
    btn.innerHTML = was ? playSVG : checkSVG;
    showToast(was ? "Unwatched" : "Watched!");
    upNextCache = null;
  } catch {
    btn.innerHTML = was ? checkSVG : playSVG;
    showToast("Failed", "error");
  } finally {
    btn.disabled = false;
  }
}

async function toggleEpWatch(btn, episodeId) {
  const was = btn.classList.contains("watched");
  btn.disabled = true;
  try {
    await msg({ action: was ? "markUnwatched" : "markWatched", episodeId });
    btn.classList.toggle("watched");
    btn.innerHTML = was ? "" : checkSVG;
    showToast(was ? "Unwatched" : "Watched!");
    upNextCache = null;
    // Update season badge count
    const section = btn.closest(".season-section");
    if (section) {
      const total = section.querySelectorAll(".ep-watch-btn").length;
      const watched = section.querySelectorAll(".ep-watch-btn.watched").length;
      const badge = section.querySelector(".season-badge");
      if (badge) badge.textContent = `${watched}/${total}`;
    }
  } catch {
    showToast("Failed", "error");
  } finally {
    btn.disabled = false;
  }
}

// ========== DATA EXTRACTION ==========
function purl(p) {
  if (!p) return "";
  if (typeof p === "string") return p;
  return p?.versions?.medium || p?.versions?.small || p?.versions?.big || p?.url || "";
}

function extractEpisodes(data) {
  if (!data) return [];
  const list = data.episodes || data.data || (Array.isArray(data) ? data : []);
  return (Array.isArray(list) ? list : []).map(ep => ({
    id: ep.id || ep.episode_id,
    name: ep.name || ep.title || "",
    number: ep.number || ep.episode_number || 0,
    seasonNumber: ep.season_number || ep.season?.number || ep.season || 0,
    showName: ep.show_name || ep.show?.name || "",
    showId: ep.show_id || ep.show?.id || "",
    poster: purl(ep.poster || ep.show?.poster),
    airDate: ep.air_date || ep.aired || "",
    watched: ep.watched || ep.is_watched || false,
  }));
}

function extractShows(data) {
  if (!data) return [];
  const list = data.shows || data.series || (Array.isArray(data) ? data : []);
  return (Array.isArray(list) ? list : []).map(s => ({
    id: s.id || s.series_id,
    name: s.name || s.title || "",
    poster: purl(s.poster || s.image),
  }));
}

function extractSearchResults(data) {
  if (!data) return [];
  const list = data.results || data.series || data.shows || (Array.isArray(data) ? data : []);
  return (Array.isArray(list) ? list : []).map(s => ({
    id: s.id || s.series_id,
    name: s.name || s.title || "",
    poster: purl(s.poster || s.image),
    year: s.year || s.first_air_date?.substring(0, 4) || "",
    following: s.following || s.is_following || s.is_followed || false,
  }));
}

function extractSeasons(data) {
  if (!data) return [];
  const list = data.seasons || (Array.isArray(data) ? data : []);
  return (Array.isArray(list) ? list : []).map(s => ({
    number: s.number || s.season_number || 0,
    episodeCount: s.episode_count || s.nb_episodes || 0,
    watchedCount: s.seen_episodes || 0,
  }));
}

function extractSeasonEpisodes(data) {
  if (!data) return [];
  const list = data.episodes || (Array.isArray(data) ? data : []);
  return (Array.isArray(list) ? list : []).map(ep => ({
    id: ep.id || ep.episode_id,
    number: ep.number || ep.episode_number || 0,
    name: ep.name || ep.title || "",
    airDate: ep.air_date || ep.aired || "",
    watched: ep.watched || ep.is_watched || false,
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
    <div class="episode-card" data-sid="${ep.showId}">
      <div class="ep-poster">${ep.poster ? `<img src="${ep.poster}" alt="">` : "📺"}</div>
      <div class="ep-info">
        <div class="ep-show">${esc(ep.showName)}</div>
        <div class="ep-title">${esc(ep.name || `Episode ${ep.number}`)}</div>
        <div class="ep-meta">S${pad(ep.seasonNumber)}E${pad(ep.number)}${ep.airDate ? " · " + fmtDate(ep.airDate) : ""}</div>
      </div>
      <button class="watch-btn ${ep.watched ? "watched" : ""}" data-eid="${ep.id}">${ep.watched ? checkSVG : playSVG}</button>
    </div>`;
}

function showCardHTML(show) {
  return `
    <div class="show-card" data-sid="${show.id}" data-sname="${esc(show.name)}">
      ${show.poster
        ? `<img src="${show.poster}" alt="${esc(show.name)}" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
        : ""}
      <div class="card-placeholder" ${show.poster ? 'style="display:none"' : ""}>📺</div>
      <div class="card-overlay"><div class="card-name">${esc(show.name)}</div></div>
    </div>`;
}

function searchResultHTML(show) {
  return `
    <div class="search-result" data-sid="${show.id}" data-sname="${esc(show.name)}">
      ${show.poster
        ? `<img class="search-poster" src="${show.poster}" alt="" loading="lazy">`
        : `<div class="search-poster">📺</div>`}
      <div class="search-info">
        <div class="search-title">${esc(show.name)}</div>
        <div class="search-meta">${show.year || ""}</div>
      </div>
      <button class="follow-btn ${show.following ? "following" : ""}" data-sid="${show.id}">
        ${show.following ? "✓ Following" : "+ Follow"}
      </button>
    </div>`;
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

function pad(n) { return String(n || 0).padStart(2, "0"); }

function fmtDate(s) {
  if (!s) return "";
  try { return new Date(s).toLocaleDateString("en-US", { month: "short", day: "numeric" }); }
  catch { return s; }
}

function showToast(message, type = "success") {
  document.querySelector(".toast")?.remove();
  const t = document.createElement("div");
  t.className = `toast ${type}`;
  t.textContent = message;
  document.body.appendChild(t);
  requestAnimationFrame(() => {
    t.classList.add("show");
    setTimeout(() => { t.classList.remove("show"); setTimeout(() => t.remove(), 300); }, 2000);
  });
}
