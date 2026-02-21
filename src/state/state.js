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
let upcomingViewMode = "list"; // 'list' or 'calendar'

let watchListViewMode = localStorage.getItem("wl_view") || "list"; // 'list' or 'grouped'
let watchListCompact = localStorage.getItem("wl_compact") === "true";

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
