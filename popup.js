const DEFAULT_SETTINGS = {
  throttleMs: 350,
  openInBackground: true,
  autoClickInstant: true,
  autoCloseAfterClick: false,
  sequentialSingleTab: true,
  settleMs: 1000
};

async function load() {
  const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  document.getElementById("throttleMs").value = settings.throttleMs;
  document.getElementById("openInBackground").checked = settings.openInBackground;
  document.getElementById("autoClickInstant").checked = settings.autoClickInstant;
  document.getElementById("autoCloseAfterClick").checked = settings.autoCloseAfterClick;
  document.getElementById("sequentialSingleTab").checked = settings.sequentialSingleTab;
  document.getElementById("settleMs").value = settings.settleMs;

  const { totalSent = 0 } = await chrome.storage.local.get("totalSent");
  document.getElementById("totalSent").textContent = totalSent;
}

function save() {
  const throttleMs = Math.max(100, parseInt(document.getElementById("throttleMs").value, 10) || 350);
  const settleMs = Math.max(300, parseInt(document.getElementById("settleMs").value, 10) || 1000);
  const openInBackground = document.getElementById("openInBackground").checked;
  const autoClickInstant = document.getElementById("autoClickInstant").checked;
  const autoCloseAfterClick = document.getElementById("autoCloseAfterClick").checked;
  const sequentialSingleTab = document.getElementById("sequentialSingleTab").checked;
  chrome.storage.sync.set({
    throttleMs,
    openInBackground,
    autoClickInstant,
    autoCloseAfterClick,
    sequentialSingleTab,
    settleMs
  });
}

[
  "throttleMs",
  "openInBackground",
  "autoClickInstant",
  "autoCloseAfterClick",
  "sequentialSingleTab",
  "settleMs"
].forEach((id) => document.getElementById(id).addEventListener("change", save));

load();

// ---------- Auto-tracked links ----------

function relativeTime(ts) {
  if (!ts) return "never checked";
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return "checked just now";
  if (mins < 60) return `checked ${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `checked ${hours}h ago`;
  const days = Math.round(hours / 24);
  return `checked ${days}d ago`;
}

function escapeHtml(s) {
  return (s || "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[c]);
}

async function renderLinks() {
  const { watchedLinks = [] } = await chrome.storage.local.get("watchedLinks");
  const list = document.getElementById("linksList");
  list.innerHTML = "";

  if (!watchedLinks.length) {
    const li = document.createElement("li");
    li.className = "empty-hint";
    li.textContent = "No links tracked yet.";
    list.appendChild(li);
    return;
  }

  watchedLinks
    .slice()
    .sort((a, b) => b.addedAt - a.addedAt)
    .forEach((link) => {
      const li = document.createElement("li");
      li.className = "link-card";
      li.innerHTML = `
        <div class="url">${escapeHtml(link.url)}</div>
        <div class="meta">${link.itemCount || 0} title${link.itemCount === 1 ? "" : "s"} &middot; ${relativeTime(link.lastCheckedAt)}</div>
        <div class="actions">
          <button data-action="check" data-id="${link.id}">Check now</button>
          <button data-action="remove" data-id="${link.id}">Remove</button>
        </div>
      `;
      list.appendChild(li);
    });
}

document.getElementById("linksList").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;
  const { action, id } = btn.dataset;
  const statusEl = document.getElementById("linkStatus");

  if (action === "remove") {
    const { watchedLinks = [] } = await chrome.storage.local.get("watchedLinks");
    await chrome.storage.local.set({ watchedLinks: watchedLinks.filter((l) => l.id !== id) });
    renderLinks();
    return;
  }

  if (action === "check") {
    btn.disabled = true;
    statusEl.textContent = "Checking for new titles…";
    chrome.runtime.sendMessage({ type: "DMM_CHECK_LINK_NOW", id }, (resp) => {
      btn.disabled = false;
      if (chrome.runtime.lastError) {
        statusEl.textContent = "Check failed — try again.";
        return;
      }
      if (!resp || !resp.ok) {
        statusEl.textContent = (resp && resp.error) || "Check failed.";
        return;
      }
      statusEl.textContent = resp.newCount
        ? `Found ${resp.newCount} new title${resp.newCount === 1 ? "" : "s"} — sending to DMM.`
        : "No new titles found.";
      renderLinks();
    });
  }
});

document.getElementById("addLinkBtn").addEventListener("click", () => {
  const input = document.getElementById("linkUrlInput");
  const addBtn = document.getElementById("addLinkBtn");
  const statusEl = document.getElementById("linkStatus");
  const url = input.value.trim();
  if (!url) return;

  addBtn.disabled = true;
  statusEl.textContent = "Importing… this briefly opens a background tab to scan the list.";

  chrome.runtime.sendMessage({ type: "DMM_ADD_LINK", url }, (resp) => {
    addBtn.disabled = false;
    if (chrome.runtime.lastError) {
      statusEl.textContent = "Something went wrong — try again.";
      return;
    }
    if (!resp || !resp.ok) {
      statusEl.textContent = (resp && resp.error) || "Couldn't add that link.";
      return;
    }
    input.value = "";
    statusEl.textContent = `Imported ${resp.count} title${resp.count === 1 ? "" : "s"} — sending to DMM now.`;
    renderLinks();
  });
});

renderLinks();

// ---------- TV show: all seasons ----------

document.getElementById("addShowBtn").addEventListener("click", () => {
  const input = document.getElementById("showUrlInput");
  const modeSel = document.getElementById("showSeasonMode");
  const includeSpecials = document.getElementById("showIncludeSpecials").checked;
  const btn = document.getElementById("addShowBtn");
  const statusEl = document.getElementById("showStatus");
  const url = input.value.trim();
  if (!url) return;

  btn.disabled = true;
  statusEl.textContent = "Finding seasons… this briefly opens a background tab.";

  chrome.runtime.sendMessage(
    { type: "DMM_ADD_SHOW_SEASONS", url, mode: modeSel.value, includeSpecials },
    (resp) => {
      btn.disabled = false;
      if (chrome.runtime.lastError) {
        statusEl.textContent = "Something went wrong — try again.";
        return;
      }
      if (!resp || !resp.ok) {
        statusEl.textContent = (resp && resp.error) || "Couldn't add that show.";
        return;
      }
      statusEl.textContent = `Found ${resp.count} season${resp.count === 1 ? "" : "s"} — sending to DMM now.`;
    }
  );
});
