// dmm-autopick.js
// Runs on every debridmediamanager.com page. Two jobs:
//
// 1. On a movie/search page: wait for the results list to settle, then click
//    the first "Instant RD" result.
// 2. On a specific season page (/show/<imdbId>/<n>): prefer clicking
//    "Instant RD (Whole Season)"; if that button isn't there, fall back to
//    "Instant RD (Every Episode)".
//
// It also reports the season-nav bar (Season 1 / Season 2 / ... links) back
// to the background script when present, so the "auto-tracked links" and
// "TV show — all seasons" features can discover every season a show has
// without hardcoding a season count.

const DEFAULT_SETTINGS = {
  autoClickInstant: true,
  autoCloseAfterClick: false,
  closeDelayMs: 1200,
  maxWaitMs: 15000,
  settleMs: 1000
};

let handled = false;
let seasonNavReported = false;

function showToast(text, kind) {
  const existing = document.getElementById("dmm-autopick-toast");
  if (existing) existing.remove();
  const toast = document.createElement("div");
  toast.id = "dmm-autopick-toast";
  toast.className = `dmm-autopick-toast dmm-autopick-${kind || "info"}`;
  toast.textContent = text;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 6000);
}

function isVisible(el) {
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function matchingButtons(regex) {
  const candidates = Array.from(document.querySelectorAll("button, a, [role='button']"));
  return candidates.filter((el) => {
    const text = (el.textContent || "").trim();
    return regex.test(text) && text.length < 80 && isVisible(el);
  });
}

function findInstantButtons() {
  // Movie/search-page cached results are just "Instant RD" — matching the
  // exact phrase (not "contains") naturally excludes the season-specific
  // "(Whole Season)" / "(Every Episode)" variants used on show pages.
  return matchingButtons(/^instant\s*rd$/i);
}

function findDownloadButtons() {
  return matchingButtons(/^dl\s*with\s*rd/i);
}

function findWholeSeasonButton() {
  return matchingButtons(/instant\s*rd\s*\(\s*whole\s*season\s*\)/i)[0] || null;
}

function findEveryEpisodeButton() {
  return matchingButtons(/instant\s*rd\s*\(\s*every\s*episode\s*\)/i)[0] || null;
}

function getSeasonPageInfo() {
  const m = location.pathname.match(/^\/show\/(tt\d+)\/(\d+)$/);
  return m ? { imdbId: m[1], season: parseInt(m[2], 10) } : null;
}

async function getSettings() {
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...stored };
}

function requestTabClose(delayMs) {
  setTimeout(() => {
    chrome.runtime.sendMessage({ type: "DMM_CLOSE_TAB" }).catch(() => {});
  }, delayMs);
}

function reportResult(found) {
  chrome.runtime.sendMessage({ type: "DMM_AUTOPICK_RESULT", found }).catch(() => {});
}

function reportSeasonNavIfPresent() {
  if (seasonNavReported) return;
  const m = location.pathname.match(/^\/show\/(tt\d+)(\/\d+)?$/);
  if (!m) return;
  const imdbId = m[1];
  const seasonLinkPattern = new RegExp(`^/show/${imdbId}/(\\d+)$`);
  const seasons = new Set();
  document.querySelectorAll("a[href]").forEach((a) => {
    const href = a.getAttribute("href") || "";
    const mm = href.match(seasonLinkPattern);
    if (mm) seasons.add(parseInt(mm[1], 10));
  });
  if (seasons.size > 0) {
    seasonNavReported = true;
    chrome.runtime
      .sendMessage({
        type: "DMM_SEASON_NAV",
        imdbId,
        seasons: Array.from(seasons).sort((a, b) => a - b)
      })
      .catch(() => {});
  }
}

async function run() {
  const settings = await getSettings();
  const seasonInfo = getSeasonPageInfo();
  const scanOnly = new URLSearchParams(location.search).has("dmmSeasonScan");

  // Season-nav discovery runs regardless of the auto-click setting — it's
  // read-only and other features (auto-tracked links, all-seasons tool)
  // depend on it.
  const navObserver = new MutationObserver(() => reportSeasonNavIfPresent());
  navObserver.observe(document.body, { childList: true, subtree: true });
  reportSeasonNavIfPresent();
  setTimeout(reportSeasonNavIfPresent, 1500);

  if (scanOnly) {
    // This tab was opened only to read the season-nav bar (e.g. discovering
    // how many seasons a show has) — don't also click anything on it.
    return;
  }

  if (!settings.autoClickInstant) {
    reportResult(false);
    return;
  }

  const start = Date.now();
  let lastMutation = Date.now();

  const observer = new MutationObserver(() => {
    if (!handled) lastMutation = Date.now();
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    characterData: true
  });

  const finish = (found, target, label) => {
    if (handled) return;
    handled = true;
    observer.disconnect();
    if (found) {
      target.scrollIntoView({ block: "center", behavior: "instant" });
      target.click();
      showToast(`✓ Auto-added: "${label || target.textContent.trim()}"`, "success");
      if (settings.autoCloseAfterClick) requestTabClose(settings.closeDelayMs);
    } else {
      const anyDownloadButtons = seasonInfo ? [] : findDownloadButtons();
      if (anyDownloadButtons.length > 0 || seasonInfo) {
        showToast("No Instant RD result found yet — pick one manually.", "warn");
      }
    }
    reportResult(found);
  };

  const evaluateSeasonPage = () => {
    if (handled) return;
    const now = Date.now();
    const quiet = now - lastMutation >= settings.settleMs;

    if (quiet) {
      const whole = findWholeSeasonButton();
      if (whole) {
        finish(true, whole, "Instant RD (Whole Season)");
        return;
      }
      const every = findEveryEpisodeButton();
      if (every) {
        finish(true, every, "Instant RD (Every Episode)");
        return;
      }
    }
    if (now - start > settings.maxWaitMs) {
      finish(false, null);
      return;
    }
    setTimeout(evaluateSeasonPage, 300);
  };

  const evaluateMoviePage = () => {
    if (handled) return;
    const now = Date.now();
    const instantButtons = findInstantButtons();
    const quiet = now - lastMutation >= settings.settleMs;

    if (instantButtons.length > 0 && quiet) {
      finish(true, instantButtons[0]);
      return;
    }
    if (now - start > settings.maxWaitMs) {
      finish(false, null);
      return;
    }
    setTimeout(evaluateMoviePage, 300);
  };

  setTimeout(seasonInfo ? evaluateSeasonPage : evaluateMoviePage, 300);
}

run();
