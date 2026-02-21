// ========== TOAST ==========
function showToast(message, type = "info") {
  let container = document.getElementById("toast-container");
  if (!container) {
    container = document.createElement("div");
    container.id = "toast-container";
    container.style.cssText = "position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:9999;display:flex;flex-direction:column;align-items:center;gap:6px;pointer-events:none;";
    document.body.appendChild(container);
  }
  const toast = document.createElement("div");
  toast.textContent = message;
  const bg = type === "error" ? "#e74c3c" : type === "success" ? "#2ecc71" : "#333";
  toast.style.cssText = `background:${bg};color:#fff;padding:8px 16px;border-radius:8px;font-size:13px;opacity:0;transition:opacity .3s;pointer-events:auto;max-width:280px;text-align:center;`;
  container.appendChild(toast);
  requestAnimationFrame(() => { toast.style.opacity = "1"; });
  setTimeout(() => {
    toast.style.opacity = "0";
    setTimeout(() => toast.remove(), 300);
  }, 2500);
}


// ========== HTML TEMPLATES ==========
function stateHTML(type, title, sub) {
  const icons = { loading: "", empty: "📺", error: "⚠️" };
  const safeTitle = esc(String(title || ""));
  const safeSub = sub ? esc(String(sub)) : "";
  const retryBtn = type === "error"
    ? `<button class="state-retry-btn">
           <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
           Retry
         </button>`
    : "";
  return `<div class="state-msg ${type}">
    ${type === "loading" ? '<div class="spinner"></div>' : `<div class="state-icon">${icons[type]}</div>`}
    <div class="state-title">${safeTitle}</div>
    ${safeSub ? `<div class="state-sub">${safeSub}</div>` : ""}
    ${retryBtn}
  </div>`;
}

function episodeCardHTML(ep) {
  return `
    <div class="episode-card" data-sid="${attr(ep.showId)}" data-sname="${esc(ep.showName)}" tabindex="0" role="button">
      <div class="ep-poster">${ep.poster ? `<img src="${ep.poster}" alt="" data-fallback="hide">` : "📺"}</div>
      <div class="ep-info">
        <div class="ep-show">${esc(ep.showName)}</div>
        <div class="ep-title">${esc(ep.name || `Episode ${ep.number}`)}</div>
        <div class="ep-meta">
          <span>S${pad(ep.seasonNumber)}E${pad(ep.number)}${ep.airDate ? " · " + fmtDate(ep.airDate) : ""}</span>
          ${airStatusBadgeHTML(ep.airDate)}
        </div>
      </div>
      <button class="watch-btn ${ep.watched ? "watched" : ""}" data-eid="${attr(ep.id)}" aria-label="${ep.watched ? 'Mark as unwatched' : 'Mark as watched'}">${ep.watched ? checkSVG : playSVG}</button>
    </div>
  `;
}

function upcomingCardHTML(ep) {
  const rightTime = formatUpcomingTime(ep);
  const rightChannel = String(ep.channel || "").trim();
  return `
    <div class="episode-card upcoming-card" data-sid="${attr(ep.showId)}" data-sname="${esc(ep.showName)}" tabindex="0" role="button">
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
        <button class="watch-btn ${ep.watched ? "watched" : ""}" data-eid="${attr(ep.id)}" aria-label="${ep.watched ? 'Mark as unwatched' : 'Mark as watched'}">
          ${ep.watched ? checkSVG : playSVG}
        </button>
      </div>
    </div>
  `;
}

function showCardHTML(show) {
  return `
    <div class="show-card" data-sid="${attr(show.id)}" data-sname="${esc(show.name)}" tabindex="0" role="button">
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
    <div class="search-result" data-sid="${attr(show.id)}" data-sname="${esc(show.name)}" tabindex="0" role="button">
      ${show.poster
      ? `<img class="search-poster" src="${show.poster}" alt="" loading="lazy" data-fallback="hide">`
      : '<div class="search-poster">📺</div>'}
      <div class="search-info">
        <div class="search-title">${esc(show.name)}</div>
        <div class="search-meta">${esc(String(show.year || ""))}</div>
      </div>
      <button class="follow-btn ${show.following ? "following" : ""}" data-sid="${attr(show.id)}" aria-label="${show.following ? 'Unfollow ' + esc(show.name) : 'Follow ' + esc(show.name)}">
        ${show.following ? "✓ Following" : "+ Follow"}
      </button>
    </div>
  `;
}

const checkSVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>';
const playSVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21"/></svg>';

