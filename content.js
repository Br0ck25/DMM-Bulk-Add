// content.js
(function () {
  const adapter = getActiveAdapter();
  if (!adapter) return;

  const state = {
    // key -> item info, key is imdbId if known else "title::year"
    selected: new Map(),
    known: new Map()
  };

  // keyFor/buildDmmUrl live in shared.js (loaded before this file) so the
  // background script's link-tracking uses the exact same identity logic.
  const keyFor = dmmItemKey;
  const buildDmmUrl = dmmBuildUrl;

  function ensureCheckbox(item) {
    const container = item.container;
    if (!container || container.dataset.dmmBulkInjected) return;
    container.dataset.dmmBulkInjected = "1";
    if (getComputedStyle(container).position === "static") {
      container.style.position = "relative";
    }

    const box = document.createElement("label");
    box.className = "dmm-bulk-checkbox-wrap";
    box.title = "Select for bulk add to DMM";

    const input = document.createElement("input");
    input.type = "checkbox";
    input.className = "dmm-bulk-checkbox";

    input.addEventListener("change", (e) => {
      e.stopPropagation();
      const key = keyFor(item);
      if (input.checked) {
        state.selected.set(key, item);
      } else {
        state.selected.delete(key);
      }
      updateToolbar();
    });
    // Prevent the click from also triggering the underlying link/card.
    box.addEventListener("click", (e) => e.stopPropagation());

    box.appendChild(input);
    container.appendChild(box);
  }

  function scan() {
    const items = adapter.findItems();
    items.forEach((item) => {
      const key = keyFor(item);
      if (!state.known.has(key)) {
        state.known.set(key, item);
      }
      ensureCheckbox(item);
    });
    updateToolbar();
  }

  // ---------- Toolbar ----------
  let toolbarEl;

  function buildToolbar() {
    toolbarEl = document.createElement("div");
    toolbarEl.id = "dmm-bulk-toolbar";
    toolbarEl.innerHTML = `
      <label class="dmm-bulk-selectall">
        <input type="checkbox" id="dmm-bulk-selectall-checkbox" />
        Select all
      </label>
      <span id="dmm-bulk-count">0 selected</span>
      <button id="dmm-bulk-add-btn" disabled>Add to DMM</button>
      <button id="dmm-bulk-clear-btn">Clear</button>
      <span id="dmm-bulk-progress"></span>
    `;
    document.body.appendChild(toolbarEl);

    toolbarEl.querySelector("#dmm-bulk-selectall-checkbox").addEventListener("change", (e) => {
      if (e.target.checked) {
        state.known.forEach((item, key) => state.selected.set(key, item));
      } else {
        state.selected.clear();
      }
      document.querySelectorAll(".dmm-bulk-checkbox").forEach((cb) => {
        cb.checked = e.target.checked;
      });
      updateToolbar();
    });

    toolbarEl.querySelector("#dmm-bulk-clear-btn").addEventListener("click", () => {
      state.selected.clear();
      document.querySelectorAll(".dmm-bulk-checkbox").forEach((cb) => (cb.checked = false));
      const selectAll = toolbarEl.querySelector("#dmm-bulk-selectall-checkbox");
      if (selectAll) selectAll.checked = false;
      updateToolbar();
    });

    toolbarEl.querySelector("#dmm-bulk-add-btn").addEventListener("click", onAddClicked);
  }

  function updateToolbar() {
    if (!toolbarEl) return;
    const count = state.selected.size;
    toolbarEl.querySelector("#dmm-bulk-count").textContent =
      count === 1 ? "1 selected" : `${count} selected`;
    toolbarEl.querySelector("#dmm-bulk-add-btn").disabled = count === 0;
    const selectAll = toolbarEl.querySelector("#dmm-bulk-selectall-checkbox");
    if (selectAll) {
      selectAll.checked = state.known.size > 0 && count === state.known.size;
    }
    // show/hide the whole bar depending on whether we found anything on the page
    toolbarEl.style.display = state.known.size > 0 ? "flex" : "none";
  }

  function onAddClicked() {
    const items = Array.from(state.selected.values());
    if (!items.length) return;
    const urls = items.map(buildDmmUrl);

    const progressEl = toolbarEl.querySelector("#dmm-bulk-progress");
    progressEl.textContent = `Starting… 0 / ${urls.length}`;

    chrome.runtime.sendMessage(
      { type: "DMM_BULK_OPEN", urls },
      () => {
        /* fire and forget; progress comes via runtime messages below */
      }
    );
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === "DMM_REQUEST_KNOWN_ITEMS") {
      // Used when this page was opened by background.js to import/re-check a
      // tracked link, rather than by the user browsing normally. Re-scan
      // first in case this fires before the mutation observer's debounce
      // settles, then report back everything found (minus the DOM node,
      // which can't cross the messaging boundary anyway).
      scan();
      const items = Array.from(state.known.values()).map((it) => ({
        id: it.id || null,
        title: it.title,
        year: it.year,
        type: it.type
      }));
      sendResponse({ items });
      return false;
    }

    if (msg && msg.type === "DMM_BULK_PROGRESS" && toolbarEl) {
      const progressEl = toolbarEl.querySelector("#dmm-bulk-progress");
      if (progressEl) {
        progressEl.textContent =
          msg.done < msg.total ? `Processing ${msg.done} / ${msg.total}…` : `Done — processed ${msg.total} titles.`;
        if (msg.done >= msg.total) {
          setTimeout(() => {
            progressEl.textContent = "";
          }, 4000);
        }
      }
    }
  });

  // ---------- Init ----------
  buildToolbar();
  scan();

  // Re-scan when the list changes (infinite scroll / pagination via JS).
  const observer = new MutationObserver(() => {
    clearTimeout(window.__dmmBulkScanTimer);
    window.__dmmBulkScanTimer = setTimeout(scan, 400);
  });
  observer.observe(document.body, { childList: true, subtree: true });
})();
