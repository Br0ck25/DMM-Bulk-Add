// background.js
importScripts("shared.js");

const DEFAULT_SETTINGS = {
  throttleMs: 350,
  openInBackground: true,
  sequentialSingleTab: true,
  autoCloseAfterClick: false,
  syncIntervalHours: 24,
  retryUncached: true,
  includeSpecials: false,
  librarySweepIntervalDays: 30
};

const SEQUENTIAL_STEP_FALLBACK_MS = 20000;
const SOURCE_SCAN_TIMEOUT_MS = 50000; // content-side cap is 45s; give it a margin
const SEASON_NAV_TIMEOUT_MS = 12000;
const LIBRARY_SWEEP_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes safety cap

const SYNC_ALARM_NAME = "dmm-source-sync";
const LIBRARY_SWEEP_ALARM_NAME = "dmm-library-sweep";

let activeBatch = null; // sequential-mode batch (single shared tab)
const multiTabItemMap = new Map(); // tabId -> item, for multi-tab mode tracking

// ---------- settings / storage helpers ----------

async function getSettings() {
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...stored };
}

async function bumpTotalSentCount(n) {
  const { totalSent = 0 } = await chrome.storage.local.get("totalSent");
  await chrome.storage.local.set({ totalSent: totalSent + n });
}

async function recordProcessed(item, found) {
  if (!item) return;
  const key = dmmItemKey(item);
  const { processedIds = {} } = await chrome.storage.local.get("processedIds");
  processedIds[key] = {
    status: found ? "added" : "attempted",
    lastTriedAt: Date.now(),
    title: item.title || key,
    id: item.id || null
  };
  await chrome.storage.local.set({ processedIds });
}

async function filterUnprocessed(items, retryUncached) {
  const { processedIds = {} } = await chrome.storage.local.get("processedIds");
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const key = dmmItemKey(it);
    if (seen.has(key)) continue;
    seen.add(key);
    const rec = processedIds[key];
    if (rec) {
      if (rec.status === "added") continue;
      if (rec.status === "attempted" && !retryUncached) continue;
    }
    out.push(it);
  }
  return out;
}

// ---------- progress notifications ----------

function notifyOrigin(originTabId, done, total) {
  if (originTabId == null) return;
  chrome.tabs.sendMessage(originTabId, { type: "DMM_BULK_PROGRESS", done, total }).catch(() => {});
}

// ---------- sequential (single shared tab) batch ----------

function clearBatchTimeout() {
  if (activeBatch && activeBatch.timeoutHandle) {
    clearTimeout(activeBatch.timeoutHandle);
    activeBatch.timeoutHandle = null;
  }
}

async function advanceSequentialBatch(found) {
  if (!activeBatch) return;
  clearBatchTimeout();

  const finishedItem = activeBatch.items[activeBatch.index];
  await recordProcessed(finishedItem, !!found);

  activeBatch.index++;
  notifyOrigin(activeBatch.originTabId, activeBatch.index, activeBatch.total);

  if (activeBatch.index >= activeBatch.total) {
    activeBatch = null;
    return;
  }

  const settings = await getSettings();
  await new Promise((r) => setTimeout(r, settings.throttleMs));
  if (!activeBatch) return;

  const nextItem = activeBatch.items[activeBatch.index];
  try {
    await chrome.tabs.update(activeBatch.workerTabId, { url: nextItem.url });
  } catch (e) {
    console.warn("DMM Bulk Add: failed to navigate worker tab, stopping batch", e);
    activeBatch = null;
    return;
  }
  armStepFallback();
}

function armStepFallback() {
  if (!activeBatch) return;
  activeBatch.timeoutHandle = setTimeout(() => {
    console.warn("DMM Bulk Add: no response from tab in time, advancing anyway");
    advanceSequentialBatch(false);
  }, SEQUENTIAL_STEP_FALLBACK_MS);
}

async function startSequentialBatch(items, originTabId, settings) {
  activeBatch = {
    items, // [{url, id, title, year, type}]
    total: items.length,
    index: 0,
    workerTabId: null,
    originTabId,
    timeoutHandle: null
  };
  notifyOrigin(originTabId, 0, items.length);

  const tab = await chrome.tabs.create({
    url: items[0].url,
    active: !settings.openInBackground
  });
  if (!activeBatch) return;
  activeBatch.workerTabId = tab.id;
  armStepFallback();
}

// Waits for a sequential batch to fully finish — used by scheduled/automated
// flows (source sync, show expansion) that need to know when it's safe to
// move on to the next thing, rather than firing and forgetting.
function runQueueAndWait(items, originTabId, settings) {
  return new Promise(async (resolve) => {
    await startSequentialBatch(items, originTabId, settings);
    const check = setInterval(() => {
      if (!activeBatch) {
        clearInterval(check);
        resolve();
      }
    }, 500);
  });
}

// ---------- multi-tab batch ----------

async function startMultiTabBatch(items, originTabId, settings) {
  const total = items.length;
  let done = 0;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    try {
      const tab = await chrome.tabs.create({
        url: item.url,
        active: i === 0 ? true : !settings.openInBackground
      });
      multiTabItemMap.set(tab.id, item);
    } catch (e) {
      console.warn("DMM Bulk Add: failed to open", item.url, e);
    }
    done++;
    notifyOrigin(originTabId, done, total);
    if (i < items.length - 1) {
      await new Promise((r) => setTimeout(r, settings.throttleMs));
    }
  }
  await bumpTotalSentCount(total);
}

chrome.tabs.onRemoved.addListener((tabId) => {
  if (activeBatch && activeBatch.workerTabId === tabId) {
    clearBatchTimeout();
    activeBatch = null;
  }
  multiTabItemMap.delete(tabId);
});

async function processQueue(items, originTabId, settings) {
  if (!items.length) return;
  if (settings.sequentialSingleTab) {
    await runQueueAndWait(items, originTabId, settings);
  } else {
    await startMultiTabBatch(items, originTabId, settings);
  }
}

// ---------- scanning an external list page (auto-tracked links) ----------

function scanSourceUrlViaTab(url) {
  return new Promise(async (resolve) => {
    let settled = false;
    let tabId;

    const cleanup = () => {
      chrome.runtime.onMessage.removeListener(listener);
      clearTimeout(timer);
      if (tabId != null) chrome.tabs.remove(tabId).catch(() => {});
    };

    const listener = (msg, sender) => {
      if (
        !settled &&
        msg &&
        msg.type === "DMM_SOURCE_SCAN_RESULT" &&
        sender.tab &&
        sender.tab.id === tabId
      ) {
        settled = true;
        cleanup();
        resolve(msg.items || []);
      }
    };
    chrome.runtime.onMessage.addListener(listener);

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        cleanup();
        resolve([]);
      }
    }, SOURCE_SCAN_TIMEOUT_MS);

    try {
      const tab = await chrome.tabs.create({ url, active: false });
      tabId = tab.id;
      // Give the content script a moment to load before asking it to scan.
      setTimeout(() => {
        chrome.tabs.sendMessage(tabId, { type: "DMM_SOURCE_SCAN_RUN" }).catch(() => {});
      }, 1200);
    } catch (e) {
      console.warn("DMM Bulk Add: failed to open source URL", url, e);
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        chrome.runtime.onMessage.removeListener(listener);
        resolve([]);
      }
    }
  });
}

// ---------- discovering a show's seasons ----------

function discoverShowSeasons(imdbId) {
  return new Promise(async (resolve) => {
    let settled = false;
    let tabId;

    const cleanup = () => {
      chrome.runtime.onMessage.removeListener(listener);
      clearTimeout(timer);
      if (tabId != null) chrome.tabs.remove(tabId).catch(() => {});
    };

    const listener = (msg, sender) => {
      if (
        !settled &&
        msg &&
        msg.type === "DMM_SEASON_NAV" &&
        msg.imdbId === imdbId &&
        sender.tab &&
        sender.tab.id === tabId
      ) {
        settled = true;
        cleanup();
        resolve(msg.seasons || []);
      }
    };
    chrome.runtime.onMessage.addListener(listener);

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        cleanup();
        resolve([]);
      }
    }, SEASON_NAV_TIMEOUT_MS);

    try {
      const tab = await chrome.tabs.create({
        url: `https://debridmediamanager.com/show/${imdbId}?dmmSeasonScan=1`,
        active: false
      });
      tabId = tab.id;
    } catch (e) {
      console.warn("DMM Bulk Add: failed to open show page for season discovery", imdbId, e);
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        chrome.runtime.onMessage.removeListener(listener);
        resolve([]);
      }
    }
  });
}

async function expandShowIntoSeasonItems(showItem, includeSpecials) {
  const seasons = await discoverShowSeasons(showItem.id);
  if (!seasons.length) {
    // Couldn't discover seasons (page failed to load, no seasons found,
    // etc.) — don't silently drop the show, fall back to its plain URL.
    return [showItem];
  }
  return seasons
    .filter((s) => includeSpecials || s !== 0)
    .map((s) => dmmSeasonItem(showItem, s));
}

// ---------- sources (auto-tracked links) ----------

async function getSources() {
  const { sources = [] } = await chrome.storage.local.get("sources");
  return sources;
}

async function saveSources(sources) {
  await chrome.storage.local.set({ sources });
}

async function addSource(url) {
  const sources = await getSources();
  const id = `src_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch (e) {
    /* leave host blank if URL is malformed; UI already validates roughly */
  }
  sources.push({
    id,
    url,
    label: host,
    enabled: true,
    lastRunAt: null,
    lastFoundCount: null,
    lastAddedCount: null
  });
  await saveSources(sources);
  runSourceSync(id).catch((e) => console.warn("DMM Bulk Add: initial source sync failed", e));
  return id;
}

async function removeSource(id) {
  const sources = await getSources();
  await saveSources(sources.filter((s) => s.id !== id));
}

async function setSourceEnabled(id, enabled) {
  const sources = await getSources();
  const src = sources.find((s) => s.id === id);
  if (src) src.enabled = enabled;
  await saveSources(sources);
}

async function runSourceSync(specificSourceId) {
  const sources = await getSources();
  const settings = await getSettings();
  let changed = false;

  for (const source of sources) {
    if (specificSourceId && source.id !== specificSourceId) continue;
    if (!specificSourceId && !source.enabled) continue;

    const rawItems = await scanSourceUrlViaTab(source.url);
    const passedTopLevel = await filterUnprocessed(rawItems, settings.retryUncached);

    const groups = [];
    for (const it of passedTopLevel) {
      if (it.type === "show" && it.id) {
        const seasonItems = await expandShowIntoSeasonItems(it, settings.includeSpecials);
        const filteredSeasonItems = await filterUnprocessed(seasonItems, settings.retryUncached);
        groups.push({
          topLevelItem: it,
          queueItems: filteredSeasonItems,
          allSeasonKeys: seasonItems.map(dmmItemKey)
        });
      } else {
        groups.push({ topLevelItem: it, queueItems: [it], allSeasonKeys: null });
      }
    }

    const queueItems = groups
      .flatMap((g) => g.queueItems)
      .map((it) => ({ ...it, url: dmmBuildUrl(it) }));

    await processQueue(queueItems, null, settings);

    const { processedIds = {} } = await chrome.storage.local.get("processedIds");
    for (const g of groups) {
      if (g.allSeasonKeys) {
        const allAdded = g.allSeasonKeys.every(
          (k) => processedIds[k] && processedIds[k].status === "added"
        );
        if (allAdded) await recordProcessed(g.topLevelItem, true);
      }
    }

    source.lastRunAt = Date.now();
    source.lastFoundCount = rawItems.length;
    source.lastAddedCount = queueItems.length;
    changed = true;
  }

  if (changed) await saveSources(sources);
}

// ---------- library-wide reinsert sweep ----------

function runLibrarySweepTab(settings) {
  return new Promise(async (resolve) => {
    let settled = false;
    let tabId;

    const cleanup = () => {
      chrome.runtime.onMessage.removeListener(listener);
      clearTimeout(timer);
    };

    const listener = (msg, sender) => {
      if (
        !settled &&
        msg &&
        msg.type === "DMM_LIBRARY_SWEEP_DONE" &&
        sender.tab &&
        sender.tab.id === tabId
      ) {
        settled = true;
        cleanup();
        chrome.tabs.remove(tabId).catch(() => {});
        resolve(msg.count || 0);
      }
    };
    chrome.runtime.onMessage.addListener(listener);

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        cleanup();
        if (tabId != null) chrome.tabs.remove(tabId).catch(() => {});
        resolve(0);
      }
    }, LIBRARY_SWEEP_TIMEOUT_MS);

    try {
      const tab = await chrome.tabs.create({
        url: "https://debridmediamanager.com/library",
        active: !settings.openInBackground
      });
      tabId = tab.id;
      setTimeout(() => {
        chrome.tabs.sendMessage(tabId, { type: "DMM_LIBRARY_SWEEP_RUN" }).catch(() => {});
      }, 2500);
    } catch (e) {
      console.warn("DMM Bulk Add: failed to open library page", e);
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        chrome.runtime.onMessage.removeListener(listener);
        resolve(0);
      }
    }
  });
}

async function runLibrarySweepAndRecord() {
  const settings = await getSettings();
  const count = await runLibrarySweepTab(settings);
  await chrome.storage.local.set({
    librarySweep: { lastRunAt: Date.now(), lastCount: count }
  });
}

// ---------- alarms ----------

async function ensureAlarms() {
  const settings = await getSettings();
  chrome.alarms.create(SYNC_ALARM_NAME, {
    periodInMinutes: Math.max(60, settings.syncIntervalHours * 60),
    delayInMinutes: 1
  });
  chrome.alarms.create(LIBRARY_SWEEP_ALARM_NAME, {
    periodInMinutes: Math.max(60, settings.librarySweepIntervalDays * 24 * 60),
    delayInMinutes: 2
  });
}

chrome.runtime.onInstalled.addListener(ensureAlarms);
chrome.runtime.onStartup.addListener(ensureAlarms);

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SYNC_ALARM_NAME) {
    runSourceSync().catch((e) => console.warn("DMM Bulk Add: scheduled source sync failed", e));
  } else if (alarm.name === LIBRARY_SWEEP_ALARM_NAME) {
    runLibrarySweepAndRecord().catch((e) =>
      console.warn("DMM Bulk Add: scheduled library sweep failed", e)
    );
  }
});

// ---------- message handling ----------

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg && msg.type === "DMM_CLOSE_TAB") {
    const tabId = sender.tab && sender.tab.id;
    if (tabId != null && !(activeBatch && activeBatch.workerTabId === tabId)) {
      chrome.tabs.remove(tabId).catch(() => {});
    }
    return false;
  }

  if (msg && msg.type === "DMM_AUTOPICK_RESULT") {
    const tabId = sender.tab && sender.tab.id;
    if (activeBatch && activeBatch.workerTabId === tabId) {
      advanceSequentialBatch(!!msg.found);
    } else if (multiTabItemMap.has(tabId)) {
      const item = multiTabItemMap.get(tabId);
      multiTabItemMap.delete(tabId);
      recordProcessed(item, !!msg.found);
    }
    return false;
  }

  if (msg && msg.type === "DMM_BULK_OPEN") {
    (async () => {
      const settings = await getSettings();
      const originTabId = sender.tab && sender.tab.id;
      const rawItems = Array.isArray(msg.items) ? msg.items : [];
      if (!rawItems.length) return;

      const topLevelItems = msg.forceIncludeAll
        ? rawItems
        : await filterUnprocessed(rawItems, settings.retryUncached);

      // Shows need to be expanded into per-season items (same as
      // runSourceSync/DMM_ADD_SHOW_ALL_SEASONS) — otherwise a selected show
      // just resolves to its bare /show/<imdbId> page, which DMM redirects
      // to season 1 only, silently dropping every other season.
      const groups = [];
      for (const it of topLevelItems) {
        if (it.type === "show" && it.id) {
          const seasonItems = await expandShowIntoSeasonItems(it, settings.includeSpecials);
          const filteredSeasonItems = msg.forceIncludeAll
            ? seasonItems
            : await filterUnprocessed(seasonItems, settings.retryUncached);
          groups.push({
            topLevelItem: it,
            queueItems: filteredSeasonItems,
            allSeasonKeys: seasonItems.map(dmmItemKey)
          });
        } else {
          groups.push({ topLevelItem: it, queueItems: [it], allSeasonKeys: null });
        }
      }

      const queueItems = groups
        .flatMap((g) => g.queueItems)
        .map((it) => ({ ...it, url: dmmBuildUrl(it) }));

      if (!queueItems.length) {
        notifyOrigin(originTabId, 0, 0);
        return;
      }
      await processQueue(queueItems, originTabId, settings);

      const { processedIds = {} } = await chrome.storage.local.get("processedIds");
      for (const g of groups) {
        if (g.allSeasonKeys) {
          const allAdded = g.allSeasonKeys.every(
            (k) => processedIds[k] && processedIds[k].status === "added"
          );
          if (allAdded) await recordProcessed(g.topLevelItem, true);
        }
      }
    })();
    return false;
  }

  if (msg && msg.type === "DMM_SYNC_NOW") {
    runSourceSync(msg.sourceId).catch((e) => console.warn("DMM Bulk Add: manual sync failed", e));
    return false;
  }

  if (msg && msg.type === "DMM_ADD_SOURCE") {
    addSource(msg.url).catch((e) => console.warn("DMM Bulk Add: add source failed", e));
    return false;
  }

  if (msg && msg.type === "DMM_REMOVE_SOURCE") {
    removeSource(msg.id).catch(() => {});
    return false;
  }

  if (msg && msg.type === "DMM_TOGGLE_SOURCE") {
    setSourceEnabled(msg.id, msg.enabled).catch(() => {});
    return false;
  }

  if (msg && msg.type === "DMM_ADD_SHOW_ALL_SEASONS") {
    (async () => {
      const settings = await getSettings();
      const showItem = { id: msg.imdbId, title: msg.title || msg.imdbId, year: "", type: "show" };
      const seasonItems = await expandShowIntoSeasonItems(showItem, msg.includeSpecials);
      const filtered = await filterUnprocessed(seasonItems, settings.retryUncached);
      const queueItems = filtered.map((it) => ({ ...it, url: dmmBuildUrl(it) }));
      await processQueue(queueItems, null, settings);
    })().catch((e) => console.warn("DMM Bulk Add: add-all-seasons failed", e));
    return false;
  }

  if (msg && msg.type === "DMM_LIBRARY_SWEEP_NOW") {
    runLibrarySweepAndRecord().catch((e) => console.warn("DMM Bulk Add: library sweep failed", e));
    return false;
  }

  if (msg && msg.type === "DMM_RESCHEDULE_ALARM") {
    ensureAlarms();
    return false;
  }

  return false;
});
