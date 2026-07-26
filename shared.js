// shared.js
// Small helpers shared between background.js (loaded via importScripts) and
// content.js (loaded as a regular content script file). Keeping these in one
// place means the "identity" of a title (for de-duping / detecting "new"
// items on a tracked link) and the DMM URL it maps to can't drift apart.

function dmmItemKey(item) {
  if (!item) return "";
  return item.id || `${(item.title || "").toLowerCase()}::${item.year || ""}`;
}

function dmmBuildUrl(item) {
  if (item.id && /:s\d+$/.test(item.id)) {
    const [imdbId, seasonPart] = item.id.split(":s");
    return `https://debridmediamanager.com/show/${imdbId}/${seasonPart}`;
  }
  if (item.id) {
    const kind = item.type === "show" ? "show" : "movie";
    return `https://debridmediamanager.com/${kind}/${item.id}`;
  }
  const q = encodeURIComponent(item.year ? `${item.title} ${item.year}` : item.title);
  return `https://debridmediamanager.com/search?query=${q}`;
}

// A show's individual season is tracked (for "skip already added" purposes)
// as its own pseudo-item with id "<imdbId>:s<seasonNumber>", so a show with
// 5 seasons produces 5 independent dedup entries instead of one.
function dmmSeasonItem(showItem, seasonNumber) {
  return {
    id: `${showItem.id}:s${seasonNumber}`,
    title: `${showItem.title} — Season ${seasonNumber}`,
    year: showItem.year,
    type: "show-season"
  };
}
