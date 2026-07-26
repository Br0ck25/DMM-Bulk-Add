// content.js
(function () {
  const adapter = getActiveAdapter();
  if (!adapter) return;

  const state = {
    selected: new Map(), // key -> item
    known: new Map(), // key -> item
    processedIds: {} // key -> {status, ...} mirrored from storage.local
  };

  function serializable(item) {
    return { id: item.id || null, title: item.title, year: item.year || "", type: item.type };
  }

  async function refreshProcessedIds() {
    const { processedIds = {} } = await chrome.storage.local.get("processedIds");
    state.processedIds = processedIds;
  }

  function isAlreadyAdded(item) {
    const rec = state.processedIds[dmmItemKey(item)];
    return !!(rec && rec.status === "added");
  }

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
      const key = dmmItemKey(item);
      if (input.checked) {
        state.selected.set(key, item);
      } else {
        state.selected.delete(key);
      }
      updateToolbar();
    });
    box.addEventListener("click", (e) => e.stopPropagation());

    box.appendChild(input);
    container.appendChild(box);
    applyAlreadyAddedStyle(item);
  }

  function applyAlreadyAddedStyle(item) {
    const container = item.container;
    const wrap = container.querySelector(".dmm-bulk-checkbox-wrap");
    const input = wrap && wrap.querySelector("input");
    if (!wrap || !input) return;

    const includeAll =
      toolbarEl && toolbarEl.querySelector("#dmm-bulk-includeall-checkbox").checked;
    const added = isAlreadyAdded(item);
    container.classList.toggle("dmm-bulk-already-added", added && !includeAll);

    if (added && !includeAll) {
      input.checked = false;
      input.disabled = true;
      wrap.title = 'Already added to DMM — check "Include already-added" to re-select';
      state.selected.delete(dmmItemKey(item));
    } else {
      input.disabled = false;
      wrap.title = "Select for bulk add to DMM";
    }
  }

  function refreshAllAlreadyAddedStyles() {
    state.known.forEach((item) => applyAlreadyAddedStyle(item));
  }

  function scan() {
    const items = adapter.findItems();
    items.forEach((item) => {
      const key = dmmItemKey(item);
      if (!state.known.has(key)) {
        state.known.set(key, item);
      }
      ensureCheckbox(item);
    });
    updateToolbar();
    return items;
  }

  // ---------- Toolbar (interactive manual selection) ----------
  let toolbarEl;

  function buildToolbar() {
    toolbarEl = document.createElement("div");
    toolbarEl.id = "dmm-bulk-toolbar";
    toolbarEl.innerHTML = `
      <label class="dmm-bulk-selectall">
        <input type="checkbox" id="dmm-bulk-selectall-checkbox" />
        Select all
      </label>
      <label class="dmm-bulk-selectall" title="Include titles already marked as added">
        <input type="checkbox" id="dmm-bulk-includeall-checkbox" />
        Include already-added
      </label>
      <span id="dmm-bulk-count">0 selected</span>
      <button id="dmm-bulk-add-btn" disabled>Add to DMM</button>
      <button id="dmm-bulk-clear-btn">Clear</button>
      <span id="dmm-bulk-progress"></span>
    `;
    document.body.appendChild(toolbarEl);

    toolbarEl.querySelector("#dmm-bulk-selectall-checkbox").addEventListener("change", (e) => {
      const includeAll = toolbarEl.querySelector("#dmm-bulk-includeall-checkbox").checked;
      if (e.target.checked) {
        state.known.forEach((item, key) => {
          if (includeAll || !isAlreadyAdded(item)) state.selected.set(key, item);
        });
      } else {
        state.selected.clear();
      }
      document.querySelectorAll(".dmm-bulk-checkbox:not(:disabled)").forEach((cb) => {
        cb.checked = e.target.checked;
      });
      updateToolbar();
    });

    toolbarEl.querySelector("#dmm-bulk-includeall-checkbox").addEventListener("change", () => {
      refreshAllAlreadyAddedStyles();
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
    toolbarEl.style.display = state.known.size > 0 ? "flex" : "none";
  }

  function onAddClicked() {
    const items = Array.from(state.selected.values()).map(serializable);
    if (!items.length) return;
    const forceIncludeAll = toolbarEl.querySelector("#dmm-bulk-includeall-checkbox").checked;

    const progressEl = toolbarEl.querySelector("#dmm-bulk-progress");
    progressEl.textContent = `Starting… 0 / ${items.length}`;

    chrome.runtime.sendMessage({ type: "DMM_BULK_OPEN", items, forceIncludeAll }, () => {
      /* fire and forget; progress comes via runtime messages below */
    });
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "DMM_BULK_PROGRESS" && toolbarEl) {
      const progressEl = toolbarEl.querySelector("#dmm-bulk-progress");
      if (progressEl) {
        progressEl.textContent =
          msg.done < msg.total
            ? `Processing ${msg.done} / ${msg.total}…`
            : `Done — processed ${msg.total} titles.`;
        if (msg.done >= msg.total) {
          setTimeout(() => {
            progressEl.textContent = "";
          }, 4000);
          refreshProcessedIds().then(refreshAllAlreadyAddedStyles);
        }
      }
      return;
    }

    // ---------- On-demand scan for background-driven source syncing ----------
    // Only runs when explicitly asked (never on a normal page visit), so it
    // won't scroll a page out from under someone just browsing normally.
    if (msg && msg.type === "DMM_SOURCE_SCAN_RUN") {
      scrollUntilStableAndScan().then((items) => {
        chrome.runtime.sendMessage({ type: "DMM_SOURCE_SCAN_RESULT", items }).catch(() => {});
      });
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.processedIds) {
      state.processedIds = changes.processedIds.newValue || {};
      refreshAllAlreadyAddedStyles();
    }
  });

  // Some list sites (MDBList's list pages, notably) don't scroll the whole
  // document — the page shell (nav/sidebar/filters) is fixed and the actual
  // item list lives in its own inner scrolling panel. Scrolling `window`
  // alone never reaches the bottom of that panel, so its lazy-load-on-scroll
  // never fires and the scan silently stops at whatever rendered on first
  // load. To handle both layouts, find any element that's actually
  // scrollable (scrollHeight taller than its own visible box, with a
  // scrolling overflow style) and scroll each of those too, in addition to
  // the window/document itself.
  function findScrollableContainers() {
    const found = [];
    const all = document.querySelectorAll("body *");
    for (const el of all) {
      if (el.scrollHeight - el.clientHeight < 100) continue;
      const style = getComputedStyle(el);
      if (!/(auto|scroll)/.test(style.overflowY)) continue;
      found.push(el);
    }
    // Largest scrollable area first — most likely to be the actual list panel.
    found.sort((a, b) => b.scrollHeight - a.scrollHeight);
    return found.slice(0, 5);
  }

  async function scrollUntilStableAndScan() {
    let lastCount = -1;
    let stableRounds = 0;
    const maxRounds = 60;
    const maxMs = 60000;
    const start = Date.now();

    for (let round = 0; round < maxRounds && Date.now() - start < maxMs; round++) {
      scan();
      const count = state.known.size;
      if (count === lastCount) {
        stableRounds++;
        if (stableRounds >= 3) break;
      } else {
        stableRounds = 0;
      }
      lastCount = count;

      window.scrollTo(0, document.body.scrollHeight);
      document.documentElement.scrollTop = document.documentElement.scrollHeight;
      findScrollableContainers().forEach((el) => {
        el.scrollTop = el.scrollHeight;
        // Some virtualized-list libraries only load more on an actual
        // scroll event rather than just reading scrollTop, so nudge it.
        el.dispatchEvent(new Event("scroll", { bubbles: true }));
      });

      await new Promise((r) => setTimeout(r, 800));
    }
    return Array.from(state.known.values()).map(serializable);
  }

  // ---------- Init ----------
  buildToolbar();
  refreshProcessedIds().then(scan);

  const observer = new MutationObserver(() => {
    clearTimeout(window.__dmmBulkScanTimer);
    window.__dmmBulkScanTimer = setTimeout(scan, 400);
  });
  observer.observe(document.body, { childList: true, subtree: true });
})();
