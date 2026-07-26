// dmm-autopick.js
// Runs on debridmediamanager.com. DMM labels already-cached torrents with an
// "Instant RD" button (vs "DL with RD" for ones that still need downloading).
//
// Two modes, chosen by URL shape:
// - Movie/search pages (runGeneric, below): waits for the results list to
//   settle (not just "first appear" — DMM streams results in over a second
//   or two and re-sorts as better matches come in), then clicks the first
//   "Instant RD" it finds.
// - Show season pages, /show/<imdbId>/<seasonNumber> (runSeasonPick, below):
//   clicks the fixed "Instant RD (Whole Season)" or "Instant RD (Every
//   Episode)" button instead — see SEASON_PAGE_RE.

const DEFAULT_SETTINGS = {
  autoClickInstant: true,
  autoCloseAfterClick: false,
  closeDelayMs: 1200,
  maxWaitMs: 15000,
  settleMs: 1000,
  // Only used on show season pages (see runSeasonPick below): which of the
  // two fixed action buttons — "Instant RD (Whole Season)" or
  // "Instant RD (Every Episode)" — to click. Set by the popup right before
  // a season batch starts (DMM_ADD_SHOW_SEASONS in background.js).
  seasonPickMode: "whole"
};

let handled = false;

// Season pages (debridmediamanager.com/show/<imdbId>/<seasonNumber>) don't
// stream in a growing list of torrent results the way movie/search pages do
// — they show two fixed action buttons up top ("Instant RD (Whole Season)"
// and "Instant RD (Every Episode)") plus a results list further down. We
// only ever want one of those two fixed buttons here, never a result from
// the list below, so this gets its own matcher instead of reusing
// findInstantButtons().
const SEASON_PAGE_RE = /^\/show\/[^/]+\/\d+\/?$/;

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

function findInstantButtons() {
  const candidates = Array.from(document.querySelectorAll("button, a, [role='button']"));
  return candidates.filter((el) => {
    const text = (el.textContent || "").trim();
    return /instant\s*rd/i.test(text) && text.length < 60 && isVisible(el);
  });
}

function findSeasonActionButton(mode) {
  const wantText =
    mode === "episodes" ? "instant rd (every episode)" : "instant rd (whole season)";
  const candidates = Array.from(document.querySelectorAll("button, a, [role='button']"));
  return (
    candidates.find((el) => {
      if (el.disabled) return false;
      const text = (el.textContent || "").trim().toLowerCase();
      return text === wantText && isVisible(el);
    }) || null
  );
}

function findDownloadButtons() {
  const candidates = Array.from(document.querySelectorAll("button, a, [role='button']"));
  return candidates.filter((el) => {
    const text = (el.textContent || "").trim();
    return /^dl\s*with\s*rd/i.test(text) && isVisible(el);
  });
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

// Season pages don't need the "wait for the list to go quiet" logic that
// movie/search pages need, since the two action buttons are fixed (not a
// streamed-in results list) — just poll until the right one shows up and
// is clickable, then click it. Still bounded by maxWaitMs so a batch can't
// get stuck forever if a season page fails to load the button at all.
async function runSeasonPick(settings) {
  if (!settings.autoClickInstant) {
    reportResult(false);
    return;
  }

  const start = Date.now();

  const evaluate = () => {
    if (handled) return;
    const btn = findSeasonActionButton(settings.seasonPickMode);

    if (btn) {
      handled = true;
      btn.scrollIntoView({ block: "center", behavior: "instant" });
      btn.click();
      showToast(`✓ Auto-added: "${btn.textContent.trim()}"`, "success");
      if (settings.autoCloseAfterClick) requestTabClose(settings.closeDelayMs);
      reportResult(true);
      return;
    }

    if (Date.now() - start > settings.maxWaitMs) {
      handled = true;
      showToast("Couldn't find that season's Instant RD button — pick manually.", "warn");
      reportResult(false);
      return;
    }
    setTimeout(evaluate, 300);
  };

  setTimeout(evaluate, 300);
}

async function runGeneric(settings) {
  if (!settings.autoClickInstant) {
    // Still tell the queue (if any) to move on immediately — nothing to wait for.
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

  const finish = (found, target) => {
    if (handled) return;
    handled = true;
    observer.disconnect();
    if (found) {
      target.scrollIntoView({ block: "center", behavior: "instant" });
      target.click();
      showToast(`✓ Auto-added instant result: "${target.textContent.trim()}"`, "success");
      if (settings.autoCloseAfterClick) requestTabClose(settings.closeDelayMs);
    } else {
      const anyDownloadButtons = findDownloadButtons();
      if (anyDownloadButtons.length > 0) {
        showToast("No Instant RD result found — pick one manually.", "warn");
      }
    }
    reportResult(found);
  };

  const evaluate = () => {
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
    setTimeout(evaluate, 300);
  };

  setTimeout(evaluate, 300);
}

async function main() {
  const settings = await getSettings();
  if (SEASON_PAGE_RE.test(location.pathname)) {
    await runSeasonPick(settings);
  } else {
    await runGeneric(settings);
  }
}

main();

