// background.js
importScripts("shared.js");

const DEFAULT_SETTINGS = {
  throttleMs: 350,
  openInBackground: true,
  sequentialSingleTab: true,
  autoCloseAfterClick: false
};

const SEQUENTIAL_STEP_FALLBACK_MS = 20000; // in case a tab never reports back

// Sequential single-tab batches are tracked by their worker tab id (rather
// than one global variable) so a manual "Add to DMM" click on a list page
// and a link-tracking import/re-check can each run their own worker tab
// without stepping on each other.
const activeBatches = new Map(); // workerTabId -> batch

const SUPPORTED_HOST_SUFFIXES = [
  "imdb.com",
  "letterboxd.com",
  "mdblist.com",
  "trakt.tv",
  "themoviedb.org",
  "thetvdb.com"
];

const LINK_CHECK_ALARM = "dmmLinkCheck";
const LINK_CHECK_PERIOD_MINUTES = 24 * 60;

const SCAN_LOAD_TIMEOUT_MS = 25000;
const SCAN_SETTLE_MS = 3000;
const SCAN_RETRY_COUNT = 3;
const SCAN_RETRY_DELAY_MS = 1500;

// Scanning scrolls the tab repeatedly, re-checking the item count after each
// scroll, and keeps going until the count stops growing (rather than a fixed
// number of scrolls) — long lazy-loaded lists (large MDBList/IMDb lists,
// etc.) can need many more than a couple of nudges to reach the end.
const SCAN_MAX_SCROLL_ROUNDS = 40;
const SCAN_SCROLL_ROUND_DELAY_MS = 900;
const SCAN_STABLE_ROUNDS_TO_STOP = 3; // consecutive no-growth rounds before we call it done
const SCAN_MAX_TOTAL_SCROLL_MS = 45000; // hard cap so a huge/broken list can't hang a scan forever

async function getSettings() {
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...stored };
}

async function bumpTotalSentCount(n) {
  const { totalSent = 0 } = await chrome.storage.local.get("totalSent");
  await chrome.storage.local.set({ totalSent: totalSent + n });
}

function notifyOrigin(originTabId, done, total) {
  if (originTabId == null) return;
  chrome.tabs.sendMessage(originTabId, { type: "DMM_BULK_PROGRESS", done, total }).catch(() => {});
}

function clearBatchTimeout(batch) {
  if (batch && batch.timeoutHandle) {
    clearTimeout(batch.timeoutHandle);
    batch.timeoutHandle = null;
  }
}

function finishBatch(tabId) {
  const batch = activeBatches.get(tabId);
  if (!batch) return;
  clearBatchTimeout(batch);
  activeBatches.delete(tabId);
  if (batch.resolve) batch.resolve();
}

async function advanceSequentialBatch(tabId) {
  const batch = activeBatches.get(tabId);
  if (!batch) return;
  clearBatchTimeout(batch);
  batch.index++;
  notifyOrigin(batch.originTabId, batch.index, batch.total);

  if (batch.index >= batch.total) {
    await bumpTotalSentCount(batch.total);
    finishBatch(tabId);
    return;
  }

  await new Promise((r) => setTimeout(r, batch.settings.throttleMs));
  if (!activeBatches.has(tabId)) return; // could have been cancelled during the delay

  const nextUrl = batch.urls[batch.index];
  try {
    await chrome.tabs.update(tabId, { url: nextUrl });
  } catch (e) {
    console.warn("DMM Bulk Add: failed to navigate worker tab, stopping batch", e);
    finishBatch(tabId);
    return;
  }
  armStepFallback(tabId);
}

function armStepFallback(tabId) {
  const batch = activeBatches.get(tabId);
  if (!batch) return;
  batch.timeoutHandle = setTimeout(() => {
    console.warn("DMM Bulk Add: no response from tab in time, advancing anyway");
    advanceSequentialBatch(tabId);
  }, SEQUENTIAL_STEP_FALLBACK_MS);
}

function startSequentialBatch(urls, originTabId, settings) {
  return new Promise(async (resolve) => {
    notifyOrigin(originTabId, 0, urls.length);
    let tab;
    try {
      tab = await chrome.tabs.create({ url: urls[0], active: !settings.openInBackground });
    } catch (e) {
      console.warn("DMM Bulk Add: failed to open first tab in batch", e);
      resolve();
      return;
    }
    const batch = {
      urls,
      total: urls.length,
      index: 0,
      originTabId,
      settings,
      timeoutHandle: null,
      resolve
    };
    activeBatches.set(tab.id, batch);
    armStepFallback(tab.id);
  });
}

async function startMultiTabBatch(urls, originTabId, settings) {
  const total = urls.length;
  let done = 0;
  for (let i = 0; i < urls.length; i++) {
    try {
      await chrome.tabs.create({
        url: urls[i],
        active: i === 0 ? true : !settings.openInBackground
      });
    } catch (e) {
      console.warn("DMM Bulk Add: failed to open", urls[i], e);
    }
    done++;
    notifyOrigin(originTabId, done, total);
    if (i < urls.length - 1) {
      await new Promise((r) => setTimeout(r, settings.throttleMs));
    }
  }
  await bumpTotalSentCount(total);
}

// Opens each item's DMM page and lets the existing single/multi-tab batch
// logic (with auto-pick, if enabled) work through them. Used both for the
// user-facing "Add to DMM" button and for link-tracking import/re-checks.
async function addItemsToDmm(items, settings) {
  const urls = items.map(dmmBuildUrl);
  if (!urls.length) return;
  if (settings.sequentialSingleTab) {
    await startSequentialBatch(urls, null, settings);
  } else {
    await startMultiTabBatch(urls, null, settings);
  }
}

chrome.tabs.onRemoved.addListener((tabId) => {
  finishBatch(tabId);
});

// ---------- Link tracking: scanning a list page for its current items ----------

function isSupportedListUrl(urlStr) {
  try {
    const host = new URL(urlStr).hostname.toLowerCase();
    return SUPPORTED_HOST_SUFFIXES.some((s) => host === s || host.endsWith("." + s));
  } catch (e) {
    return false;
  }
}

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(false);
    }, timeoutMs);
    function listener(updatedTabId, info) {
      if (updatedTabId === tabId && info.status === "complete") {
        if (done) return;
        done = true;
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(true);
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// Scrolls the scanned tab one "round": the window itself, plus any element
// on the page that's its own scroll container (some sites put the list in
// an inner div with overflow-y:auto rather than scrolling the whole page).
async function scrollTabOnce(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      window.scrollTo(0, document.body.scrollHeight);
      document.querySelectorAll("*").forEach((el) => {
        if (el.scrollHeight - el.clientHeight > 200) {
          el.scrollTop = el.scrollHeight;
        }
      });
    }
  });
}

// Asks content.js what it's found so far. content.js accumulates every item
// it's ever seen on the page (state.known), not just what's currently in the
// DOM, so this naturally grows monotonically as more of the list loads in —
// safe to call repeatedly across scroll rounds.
async function requestKnownItems(tabId) {
  for (let attempt = 0; attempt < SCAN_RETRY_COUNT; attempt++) {
    try {
      const resp = await chrome.tabs.sendMessage(tabId, { type: "DMM_REQUEST_KNOWN_ITEMS" });
      if (resp && Array.isArray(resp.items)) return resp.items;
    } catch (e) {
      /* content script not injected/ready yet — retry after a short wait */
    }
    await new Promise((r) => setTimeout(r, SCAN_RETRY_DELAY_MS));
  }
  return [];
}

async function scanLinkForItems(url) {
  const tab = await chrome.tabs.create({ url, active: false });
  const tabId = tab.id;
  try {
    await waitForTabComplete(tabId, SCAN_LOAD_TIMEOUT_MS);
    await new Promise((r) => setTimeout(r, SCAN_SETTLE_MS));

    let items = await requestKnownItems(tabId);
    let stableRounds = 0;
    const scrollStart = Date.now();

    for (let round = 0; round < SCAN_MAX_SCROLL_ROUNDS; round++) {
      if (Date.now() - scrollStart > SCAN_MAX_TOTAL_SCROLL_MS) break;

      try {
        await scrollTabOnce(tabId);
      } catch (e) {
        break; // page doesn't allow scripting (rare) — nothing more we can do
      }
      await new Promise((r) => setTimeout(r, SCAN_SCROLL_ROUND_DELAY_MS));

      const next = await requestKnownItems(tabId);
      if (next.length > items.length) {
        items = next;
        stableRounds = 0;
      } else {
        stableRounds++;
        if (stableRounds >= SCAN_STABLE_ROUNDS_TO_STOP) break;
      }
    }

    return items;
  } finally {
    chrome.tabs.remove(tabId).catch(() => {});
  }
}

// Re-scans a tracked link, updates its stored state, and returns any items
// not already in its known set. Does NOT send anything to DMM itself —
// callers decide whether/when to do that.
async function checkSingleLink(linkId) {
  const { watchedLinks = [] } = await chrome.storage.local.get("watchedLinks");
  const idx = watchedLinks.findIndex((l) => l.id === linkId);
  if (idx === -1) return { ok: false, error: "That link isn't tracked anymore." };
  const link = watchedLinks[idx];

  let items;
  try {
    items = await scanLinkForItems(link.url);
  } catch (e) {
    return { ok: false, error: "Couldn't load that page to check it." };
  }

  if (!items.length) {
    // Don't wipe out a previously-good knownKeys list just because a scan
    // came back empty (page might have failed to load fully this time).
    watchedLinks[idx] = { ...link, lastCheckedAt: Date.now() };
    await chrome.storage.local.set({ watchedLinks });
    return { ok: true, newItems: [], itemCount: link.itemCount || 0 };
  }

  const knownSet = new Set(link.knownKeys || []);
  const newItems = items.filter((it) => !knownSet.has(dmmItemKey(it)));
  const mergedKeys = Array.from(new Set([...(link.knownKeys || []), ...items.map(dmmItemKey)]));

  watchedLinks[idx] = {
    ...link,
    lastCheckedAt: Date.now(),
    itemCount: items.length,
    knownKeys: mergedKeys
  };
  await chrome.storage.local.set({ watchedLinks });

  return { ok: true, newItems, itemCount: items.length };
}

async function checkAllLinks() {
  const { watchedLinks = [] } = await chrome.storage.local.get("watchedLinks");
  const settings = await getSettings();
  for (const link of watchedLinks) {
    try {
      const result = await checkSingleLink(link.id);
      if (result.ok && result.newItems.length) {
        await addItemsToDmm(result.newItems, settings);
      }
    } catch (e) {
      console.warn("DMM Bulk Add: auto-check failed for", link.url, e);
    }
  }
}

// Make sure the recurring alarm exists whenever the service worker (re)starts —
// covers first install, browser restart, and the service worker being woken
// back up after being suspended.
chrome.alarms.get(LINK_CHECK_ALARM, (existing) => {
  if (!existing) {
    chrome.alarms.create(LINK_CHECK_ALARM, { delayInMinutes: 1, periodInMinutes: LINK_CHECK_PERIOD_MINUTES });
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === LINK_CHECK_ALARM) {
    checkAllLinks().catch((e) => console.warn("DMM Bulk Add: checkAllLinks failed", e));
  }
});

// ---------- TV show: scan a show page for its season list ----------

const SHOW_PAGE_RE = /^https:\/\/debridmediamanager\.com\/show\/([^/]+)(?:\/(\d+))?\/?(?:[?#].*)?$/;
const SEASON_HREF_RE = /\/show\/[^/]+\/(\d+)\/?$/;

const SEASON_SCAN_SETTLE_MS = 2000;

function buildShowBaseUrl(urlStr) {
  const m = (urlStr || "").trim().match(SHOW_PAGE_RE);
  if (!m) return null;
  return `https://debridmediamanager.com/show/${m[1]}`;
}

// Reads the season nav bar (the row of "Season 1" / "Season 2" / ... links
// at the top of a show page) to get the exact season list DMM knows about,
// rather than guessing/hardcoding a season count. Tries the show's base URL
// first; if that page doesn't render the nav for some reason, falls back to
// the season-1 URL, since the same nav also appears there.
async function scanSeasonHrefs(showUrl) {
  const base = buildShowBaseUrl(showUrl);
  if (!base) {
    return { ok: false, error: "That doesn't look like a debridmediamanager.com show URL." };
  }

  const candidates = [base, `${base}/1`];
  for (const url of candidates) {
    let tab;
    try {
      tab = await chrome.tabs.create({ url, active: false });
    } catch (e) {
      continue;
    }
    try {
      await waitForTabComplete(tab.id, SCAN_LOAD_TIMEOUT_MS);
      await new Promise((r) => setTimeout(r, SEASON_SCAN_SETTLE_MS));

      let hrefs = [];
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => {
            const nav = document.querySelector('[data-testid="media-header-season-nav"]');
            if (!nav) return [];
            return Array.from(nav.querySelectorAll("a[href]")).map((a) => a.getAttribute("href"));
          }
        });
        hrefs = (results && results[0] && results[0].result) || [];
      } catch (e) {
        hrefs = [];
      }

      if (hrefs.length) {
        return { ok: true, base, hrefs };
      }
    } finally {
      chrome.tabs.remove(tab.id).catch(() => {});
    }
  }

  return {
    ok: false,
    error: "Couldn't find a season list on that page — make sure it's a DMM show page."
  };
}

function seasonUrlsFromHrefs(hrefs, base, includeSpecials) {
  const numbers = [];
  for (const href of hrefs) {
    const m = (href || "").match(SEASON_HREF_RE);
    if (!m) continue;
    const n = parseInt(m[1], 10);
    if (!includeSpecials && n === 0) continue; // "Specials" is season 0
    numbers.push(n);
  }
  const uniqueSorted = Array.from(new Set(numbers)).sort((a, b) => a - b);
  return uniqueSorted.map((n) => `${base}/${n}`);
}

// ---------- Message handling ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return false;

  if (msg.type === "DMM_CLOSE_TAB") {
    const tabId = sender.tab && sender.tab.id;
    // Never close a tab mid-batch — sequential mode reuses it for the
    // remaining titles.
    if (tabId != null && !activeBatches.has(tabId)) {
      chrome.tabs.remove(tabId).catch(() => {});
    }
    return false;
  }

  if (msg.type === "DMM_AUTOPICK_RESULT") {
    const tabId = sender.tab && sender.tab.id;
    if (tabId != null && activeBatches.has(tabId)) {
      advanceSequentialBatch(tabId);
    }
    return false;
  }

  if (msg.type === "DMM_BULK_OPEN") {
    (async () => {
      const settings = await getSettings();
      const originTabId = sender.tab && sender.tab.id;
      const urls = Array.isArray(msg.urls) ? msg.urls : [];
      if (!urls.length) return;

      if (settings.sequentialSingleTab) {
        await startSequentialBatch(urls, originTabId, settings);
      } else {
        await startMultiTabBatch(urls, originTabId, settings);
      }
    })();
    return false;
  }

  if (msg.type === "DMM_ADD_LINK") {
    (async () => {
      try {
        const url = (msg.url || "").trim();
        if (!url || !isSupportedListUrl(url)) {
          sendResponse({
            ok: false,
            error: "Unsupported or invalid URL. Use an IMDb, Letterboxd, MDBList, Trakt, TMDB, or TheTVDB list/watchlist link."
          });
          return;
        }
        const { watchedLinks = [] } = await chrome.storage.local.get("watchedLinks");
        if (watchedLinks.some((l) => l.url === url)) {
          sendResponse({ ok: false, error: "That link is already tracked." });
          return;
        }

        let items;
        try {
          items = await scanLinkForItems(url);
        } catch (e) {
          sendResponse({ ok: false, error: "Couldn't load or scan that page." });
          return;
        }
        if (!items.length) {
          sendResponse({
            ok: false,
            error: "No titles found on that page — double check it's a list/watchlist URL, and that you're logged in if it's private."
          });
          return;
        }

        const link = {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          url,
          addedAt: Date.now(),
          lastCheckedAt: Date.now(),
          itemCount: items.length,
          knownKeys: items.map(dmmItemKey)
        };
        watchedLinks.push(link);
        await chrome.storage.local.set({ watchedLinks });
        sendResponse({ ok: true, count: items.length });

        const settings = await getSettings();
        addItemsToDmm(items, settings).catch((e) =>
          console.warn("DMM Bulk Add: link import batch failed", e)
        );
      } catch (e) {
        console.warn("DMM Bulk Add: DMM_ADD_LINK failed", e);
        sendResponse({ ok: false, error: "Something went wrong." });
      }
    })();
    return true;
  }

  if (msg.type === "DMM_ADD_SHOW_SEASONS") {
    (async () => {
      try {
        const mode = msg.mode === "episodes" ? "episodes" : "whole";
        const includeSpecials = !!msg.includeSpecials;

        const scan = await scanSeasonHrefs(msg.url);
        if (!scan.ok) {
          sendResponse({ ok: false, error: scan.error });
          return;
        }

        const urls = seasonUrlsFromHrefs(scan.hrefs, scan.base, includeSpecials);
        if (!urls.length) {
          sendResponse({ ok: false, error: "No seasons found for that show." });
          return;
        }

        // dmm-autopick.js reads this to know which of the two season-page
        // action buttons to click; it's set right before the batch starts
        // so it applies for every season page this batch visits.
        await chrome.storage.sync.set({ seasonPickMode: mode });

        sendResponse({ ok: true, count: urls.length });

        const settings = await getSettings();
        if (settings.sequentialSingleTab) {
          await startSequentialBatch(urls, null, settings);
        } else {
          await startMultiTabBatch(urls, null, settings);
        }
      } catch (e) {
        console.warn("DMM Bulk Add: DMM_ADD_SHOW_SEASONS failed", e);
        sendResponse({ ok: false, error: "Something went wrong." });
      }
    })();
    return true;
  }

  if (msg.type === "DMM_CHECK_LINK_NOW") {
    (async () => {
      const result = await checkSingleLink(msg.id);
      sendResponse(
        result.ok
          ? { ok: true, newCount: result.newItems.length, itemCount: result.itemCount }
          : { ok: false, error: result.error }
      );
      if (result.ok && result.newItems.length) {
        const settings = await getSettings();
        addItemsToDmm(result.newItems, settings).catch((e) =>
          console.warn("DMM Bulk Add: manual check-now add failed", e)
        );
      }
    })();
    return true;
  }

  return false;
});
