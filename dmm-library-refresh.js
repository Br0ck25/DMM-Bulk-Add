// dmm-library-refresh.js
// Runs only on debridmediamanager.com/library. Never does anything on its
// own — it only sweeps when background.js explicitly asks it to (via a
// "Refresh DMM library now" click or the scheduled interval), so a normal
// visit to your library page never accidentally triggers a mass reinsert.

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function findLibraryRefreshButtons() {
  // Every library row has its own refresh-cw ("reinsert") icon. The page
  // also has a single top-bar "Refresh library" button using the same icon
  // with no color modifier — excluded here by its title/aria-label so we
  // only ever click the per-item ones.
  return Array.from(document.querySelectorAll("svg.lucide-refresh-cw"))
    .map((svg) => svg.closest("button"))
    .filter((btn) => {
      if (!btn) return false;
      const label = (btn.getAttribute("title") || btn.getAttribute("aria-label") || "").trim().toLowerCase();
      return label !== "refresh library";
    });
}

async function runSweep() {
  let clicked = 0;
  let stableRounds = 0;
  let lastHeight = -1;
  const maxRounds = 500;

  for (let round = 0; round < maxRounds; round++) {
    const buttons = findLibraryRefreshButtons();
    for (const btn of buttons) {
      if (btn.dataset.dmmSwept) continue;
      btn.dataset.dmmSwept = "1";
      btn.click();
      clicked++;
      await sleep(150); // small stagger so we don't fire a wall of requests at once
    }

    window.scrollTo(0, document.body.scrollHeight);
    await sleep(700);

    const newHeight = document.body.scrollHeight;
    if (newHeight === lastHeight) {
      stableRounds++;
      if (stableRounds >= 3) break; // list has stopped growing — we've reached the end
    } else {
      stableRounds = 0;
    }
    lastHeight = newHeight;
  }

  return clicked;
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "DMM_LIBRARY_SWEEP_RUN") {
    runSweep().then((count) => {
      chrome.runtime.sendMessage({ type: "DMM_LIBRARY_SWEEP_DONE", count }).catch(() => {});
    });
  }
  return false;
});
