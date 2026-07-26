const DEFAULT_SETTINGS = {
  throttleMs: 350,
  openInBackground: true,
  autoClickInstant: true,
  autoCloseAfterClick: false,
  sequentialSingleTab: true,
  settleMs: 1000,
  syncIntervalHours: 24,
  retryUncached: true,
  includeSpecials: false,
  librarySweepIntervalDays: 30
};

const SETTINGS_FIELDS = [
  "throttleMs",
  "openInBackground",
  "autoClickInstant",
  "autoCloseAfterClick",
  "sequentialSingleTab",
  "settleMs",
  "syncIntervalHours",
  "retryUncached",
  "includeSpecials",
  "librarySweepIntervalDays"
];

function fmtTime(ts) {
  if (!ts) return "never";
  const diffMs = Date.now() - ts;
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

async function loadSettings() {
  const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  document.getElementById("throttleMs").value = settings.throttleMs;
  document.getElementById("settleMs").value = settings.settleMs;
  document.getElementById("syncIntervalHours").value = settings.syncIntervalHours;
  document.getElementById("librarySweepIntervalDays").value = settings.librarySweepIntervalDays;
  document.getElementById("openInBackground").checked = settings.openInBackground;
  document.getElementById("autoClickInstant").checked = settings.autoClickInstant;
  document.getElementById("autoCloseAfterClick").checked = settings.autoCloseAfterClick;
  document.getElementById("sequentialSingleTab").checked = settings.sequentialSingleTab;
  document.getElementById("retryUncached").checked = settings.retryUncached;
  document.getElementById("includeSpecials").checked = settings.includeSpecials;
}

function saveSettings() {
  const throttleMs = Math.max(100, parseInt(document.getElementById("throttleMs").value, 10) || 350);
  const settleMs = Math.max(300, parseInt(document.getElementById("settleMs").value, 10) || 1000);
  const syncIntervalHours = Math.max(1, parseInt(document.getElementById("syncIntervalHours").value, 10) || 24);
  const librarySweepIntervalDays = Math.max(
    1,
    parseInt(document.getElementById("librarySweepIntervalDays").value, 10) || 30
  );
  const settings = {
    throttleMs,
    settleMs,
    syncIntervalHours,
    librarySweepIntervalDays,
    openInBackground: document.getElementById("openInBackground").checked,
    autoClickInstant: document.getElementById("autoClickInstant").checked,
    autoCloseAfterClick: document.getElementById("autoCloseAfterClick").checked,
    sequentialSingleTab: document.getElementById("sequentialSingleTab").checked,
    retryUncached: document.getElementById("retryUncached").checked,
    includeSpecials: document.getElementById("includeSpecials").checked
  };
  chrome.storage.sync.set(settings);
  chrome.runtime.sendMessage({ type: "DMM_RESCHEDULE_ALARM" }).catch(() => {});
}

SETTINGS_FIELDS.forEach((id) => document.getElementById(id).addEventListener("change", saveSettings));

// ---------- sources ----------

async function renderSources() {
  const { sources = [] } = await chrome.storage.local.get("sources");
  const container = document.getElementById("sourcesList");
  container.innerHTML = "";

  if (!sources.length) {
    container.innerHTML = '<div class="empty">No tracked links yet.</div>';
    return;
  }

  sources.forEach((source) => {
    const div = document.createElement("div");
    div.className = "source-item";
    const found = source.lastFoundCount == null ? "—" : source.lastFoundCount;
    const added = source.lastAddedCount == null ? "—" : source.lastAddedCount;
    div.innerHTML = `
      <div class="label">${source.label || source.url}</div>
      <div class="meta">${source.url}</div>
      <div class="meta">Last checked: ${fmtTime(source.lastRunAt)} — found ${found}, sent ${added} new</div>
      <div class="actions">
        <label style="display:flex;align-items:center;gap:4px;">
          <input type="checkbox" class="source-enabled" ${source.enabled ? "checked" : ""} />
          Enabled
        </label>
        <button class="btn-secondary source-check-now">Check now</button>
        <button class="btn-danger source-remove">Remove</button>
      </div>
    `;
    div.querySelector(".source-enabled").addEventListener("change", (e) => {
      chrome.runtime.sendMessage({ type: "DMM_TOGGLE_SOURCE", id: source.id, enabled: e.target.checked });
    });
    div.querySelector(".source-check-now").addEventListener("click", (e) => {
      e.target.textContent = "Checking…";
      e.target.disabled = true;
      chrome.runtime.sendMessage({ type: "DMM_SYNC_NOW", sourceId: source.id });
      setTimeout(() => renderSources(), 3000);
    });
    div.querySelector(".source-remove").addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "DMM_REMOVE_SOURCE", id: source.id });
      setTimeout(renderSources, 200);
    });
    container.appendChild(div);
  });
}

document.getElementById("addSourceBtn").addEventListener("click", () => {
  const input = document.getElementById("sourceUrlInput");
  const url = input.value.trim();
  if (!url) return;
  try {
    new URL(url);
  } catch (e) {
    alert("That doesn't look like a valid URL.");
    return;
  }
  chrome.runtime.sendMessage({ type: "DMM_ADD_SOURCE", url });
  input.value = "";
  setTimeout(renderSources, 300);
});

// ---------- TV show — all seasons ----------

function extractImdbId(text) {
  const m = (text || "").match(/tt\d{6,9}/);
  return m ? m[0] : null;
}

document.getElementById("addShowBtn").addEventListener("click", () => {
  const input = document.getElementById("showUrlInput");
  const status = document.getElementById("showStatus");
  const imdbId = extractImdbId(input.value);
  if (!imdbId) {
    status.textContent = "Couldn't find an IMDb ID (tt1234567) in that.";
    return;
  }
  status.textContent = "Discovering seasons and sending…";
  chrome.runtime.sendMessage({
    type: "DMM_ADD_SHOW_ALL_SEASONS",
    imdbId,
    includeSpecials: document.getElementById("includeSpecials").checked
  });
  input.value = "";
  setTimeout(() => {
    status.textContent = "Sent — check the shared/worker tab for progress.";
  }, 1500);
});

// ---------- library sweep ----------

async function renderLibrarySweepStatus() {
  const { librarySweep } = await chrome.storage.local.get("librarySweep");
  const el = document.getElementById("librarySweepStatus");
  if (!librarySweep || !librarySweep.lastRunAt) {
    el.textContent = "Never run yet.";
    el.classList.add("empty");
    return;
  }
  el.classList.remove("empty");
  el.textContent = `Last run ${fmtTime(librarySweep.lastRunAt)} — reinserted ${librarySweep.lastCount} item(s).`;
}

document.getElementById("librarySweepBtn").addEventListener("click", (e) => {
  e.target.disabled = true;
  e.target.textContent = "Sweeping… (this can take a while)";
  chrome.runtime.sendMessage({ type: "DMM_LIBRARY_SWEEP_NOW" });
  setTimeout(() => {
    e.target.disabled = false;
    e.target.textContent = "Refresh DMM library now";
    renderLibrarySweepStatus();
  }, 8000);
});

// ---------- stats ----------

async function renderStats() {
  const { totalSent = 0 } = await chrome.storage.local.get("totalSent");
  document.getElementById("totalSent").textContent = totalSent;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.sources) renderSources();
  if (changes.totalSent) renderStats();
  if (changes.librarySweep) renderLibrarySweepStatus();
});

loadSettings();
renderSources();
renderStats();
renderLibrarySweepStatus();
