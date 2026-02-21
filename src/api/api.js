// ========== DATA CONTRACTS ==========

/**
 * @typedef {Object} TVTimeEpisode
 * @property {number|string} id - The episode ID
 * @property {string} name - Title of the episode
 * @property {number} number - Episode number within season
 * @property {number} seasonNumber - Season number
 * @property {string} showName - Name of the TV show
 * @property {number|string} showId - The show ID
 * @property {string} poster - Valid media URL for the poster
 * @property {string} airDate - Standard air date
 * @property {string} airDateTime - ISO or precise air datetime
 * @property {string} channel - Network or broadcast channel
 * @property {string} airTime - Specific air time
 * @property {string} toWatchCategory - Watchlist group (e.g., 'continue_watching')
 * @property {boolean} watched - Whether the user has watched the episode
 */

/**
 * @typedef {Object} TVTimeShow
 * @property {number|string} id - Show ID
 * @property {string} name - Name of the show
 * @property {string} poster - Poster URL
 * @property {boolean} following - Whether the user follows the show
 */

/**
 * @typedef {Object} TVTimeSeason
 * @property {number} number - The season number
 * @property {number} episodeCount - Total number of episodes in season
 * @property {number} watchedCount - Number of episodes watched by user
 */

// ========== DATA EXTRACTION ==========

/**
 * Safely extracts episodes from an untyped API response
 * @param {any} data - Raw API payload
 * @returns {TVTimeEpisode[]} - Cleaned up episodes
 */
function extractEpisodes(data) {
  if (!data) return [];
  const list = data.episodes || data.data || (Array.isArray(data) ? data : []);
  return (Array.isArray(list) ? list : []).map(ep => ({
    id: ep.id || ep.episode_id,
    name: ep.name || ep.title || "",
    number: ep.number || ep.episode_number || 0,
    seasonNumber: ep.season_number || ep.season?.number || ep.season || 0,
    showName: ep.show_name || ep.showName || ep.show?.name || ep.show?.title || ep.show?.show_name || "",
    showId: ep.show_id || ep.showId || ep.series_id || ep.show?.id || ep.show?.series_id || "",
    poster: purl(ep),
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

/**
 * Safely extracts upcoming episodes, deduplicating from mixed API responses
 * @param {any} data - Raw API payload
 * @returns {TVTimeEpisode[]} - Cleaned up upcoming episodes
 */
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

/**
 * Safely extracts TV shows from an untyped API response
 * @param {any} data - Raw API payload
 * @returns {TVTimeShow[]} - Cleaned up TV shows
 */
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

/**
 * Safely extracts search results from an untyped API response
 * @param {any} data - Raw API payload
 * @returns {TVTimeSearchResult[]} - Cleaned up search results
 */
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
    poster: purl(s),
    year:
      s.year ||
      s.release_year ||
      s.first_air_date?.substring?.(0, 4) ||
      s.release_date?.substring?.(0, 4) ||
      "",
    following: s.following || s.is_following || s.is_followed || false,
  }));
}

/**
 * Safely extracts TV seasons from an untyped API response
 * @param {any} data - Raw API payload
 * @returns {TVTimeSeason[]} - Cleaned up seasons
 */
function extractSeasons(data) {
  if (!data) return [];
  const list = data.seasons || (Array.isArray(data) ? data : []);
  return (Array.isArray(list) ? list : [])
    .map((s, i) => {
      const watched = Math.max(
        Number(s.seen_episodes) || 0,
        Number(s.watched_count) || 0,
        Number(s.watched_episodes) || 0,
        Number(s.watched_episodes_count) || 0,
        Number(s.nb_seen) || 0,
        Number(s.watched) || 0,
        Number(s.seen) || 0,
        Number(s.user_progress?.watched) || 0,
        Number(s.user_progress?.seen_count) || 0,
        Number(s.user_progress?.viewed_count) || 0,
        Number(s.user_progress?.seen) || 0,
      );
      return {
        number: parseSeasonNum(s.number || s.season_number, i + 1),
        episodeCount: s.episode_count || s.nb_episodes || 0,
        watchedCount: watched,
      };
    })
    .filter(s => s.number > 0);
}

/**
 * Safely extracts episodes for a specific season from an untyped API response
 * @param {any} data - Raw API payload
 * @returns {TVTimeEpisode[]} - Cleaned up episodes
 */
function extractSeasonEpisodes(data) {
  if (!data) return [];
  const list = data.episodes || (Array.isArray(data) ? data : []);
  return (Array.isArray(list) ? list : []).map(ep => ({
    id: ep.id || ep.episode_id,
    number: ep.number || ep.episode_number || 0,
    name: ep.name || ep.title || "",
    airDate: ep.air_date || ep.aired || ep.first_aired || ep.first_aired_date || ep.release_date || "",
    thumbnail: purl(ep),
    watched: Boolean(
      ep.watched ||
      ep.is_watched ||
      ep.is_seen ||
      ep.seen === true ||
      ep.seen === 1 ||
      ep.seen === "1" ||
      ep.seen_date ||
      ep.user_progress?.watched ||
      ep.user_progress?.seen
    ),
  }));
}


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
