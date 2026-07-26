// site-adapters.js
// Each adapter knows how to find "list items" on a given site and pull out
// enough info (imdb id if possible, otherwise title+year) to build a DMM link.
//
// To add support for a new site: copy an adapter, adjust `hostMatches` and
// `findItems`, and add it to the SITE_ADAPTERS array at the bottom.

function textOf(el) {
  return (el && el.textContent || "").replace(/\s+/g, " ").trim();
}

function findImdbIdIn(el) {
  if (!el) return null;
  // Look at the element itself and every anchor inside/around it for a
  // /title/tt1234567/ style IMDb id.
  const candidates = [el, ...el.querySelectorAll("a[href]")];
  for (const c of candidates) {
    const href = c.getAttribute && c.getAttribute("href");
    if (!href) continue;
    const m = href.match(/tt\d{6,9}/);
    if (m) return m[0];
  }
  // Also check common data-attributes some sites use.
  const dataAttrs = ["data-imdb-id", "data-imdbid", "data-imdb"];
  for (const attr of dataAttrs) {
    const v = el.getAttribute && el.getAttribute(attr);
    if (v && /tt\d{6,9}/.test(v)) return v.match(/tt\d{6,9}/)[0];
  }
  return null;
}

function guessType(text) {
  const t = (text || "").toLowerCase();
  if (t.includes("tv series") || t.includes("tv mini") || t.includes("tv show") || t.includes("series")) {
    return "show";
  }
  return "movie";
}

function guessYear(text) {
  const m = (text || "").match(/\((19|20)\d{2}\)/);
  return m ? m[0].replace(/[()]/g, "") : "";
}

const SITE_ADAPTERS = [
  {
    name: "imdb",
    hostMatches: (h) => h.endsWith("imdb.com"),
    findItems() {
      const selectors = [
        "li.ipc-metadata-list-summary-item",
        ".lister-item",
        ".titleColumn",
        "li.cli-parent"
      ];
      const nodes = new Set();
      selectors.forEach((sel) => document.querySelectorAll(sel).forEach((n) => nodes.add(n)));
      const items = [];
      nodes.forEach((container) => {
        const anchor = container.querySelector('a[href*="/title/tt"]');
        if (!anchor) return;
        const imdbId = findImdbIdIn(container);
        if (!imdbId) return;
        const title = textOf(anchor.closest("h3, .titleColumn, .ipc-title") || anchor) || textOf(anchor);
        const fullText = textOf(container);
        items.push({
          id: imdbId,
          title: title || imdbId,
          year: guessYear(fullText),
          type: guessType(fullText),
          container
        });
      });
      return items;
    }
  },
  {
    name: "mdblist",
    hostMatches: (h) => h.endsWith("mdblist.com"),
    findItems() {
      const nodes = document.querySelectorAll(
        "[class*='item'], [class*='card'], .list-group-item, tr"
      );
      const items = [];
      nodes.forEach((container) => {
        const imdbId = findImdbIdIn(container);
        if (!imdbId) return;
        if (container.dataset.dmmScanned) return;
        const anchor = container.querySelector("a[href]");
        const fullText = textOf(container);
        items.push({
          id: imdbId,
          title: (anchor && textOf(anchor)) || imdbId,
          year: guessYear(fullText),
          type: guessType(fullText),
          container
        });
      });
      return items;
    }
  },
  {
    name: "trakt",
    hostMatches: (h) => h.endsWith("trakt.tv"),
    findItems() {
      const nodes = document.querySelectorAll(
        "[data-movie-ids], [data-show-ids], .grid-item, .row.summary"
      );
      const items = [];
      nodes.forEach((container) => {
        let imdbId = findImdbIdIn(container);
        // Trakt sometimes stashes IDs as JSON in a data attribute.
        if (!imdbId) {
          const raw = container.getAttribute("data-movie-ids") || container.getAttribute("data-show-ids");
          if (raw) {
            try {
              const parsed = JSON.parse(raw.replace(/&quot;/g, '"'));
              if (parsed && parsed.imdb) imdbId = parsed.imdb;
            } catch (e) {
              /* ignore parse errors */
            }
          }
        }
        const titleEl = container.querySelector("h3, .titles h3, a.titles, .title");
        const title = titleEl ? textOf(titleEl) : "";
        if (!imdbId && !title) return;
        const fullText = textOf(container);
        items.push({
          id: imdbId || null,
          title: title || imdbId,
          year: guessYear(fullText),
          type: container.matches("[data-show-ids]") ? "show" : guessType(fullText),
          container
        });
      });
      return items;
    }
  },
  {
    name: "themoviedb",
    hostMatches: (h) => h.endsWith("themoviedb.org"),
    findItems() {
      const nodes = document.querySelectorAll(".card, .poster.card");
      const items = [];
      nodes.forEach((container) => {
        const anchor = container.querySelector('a[href*="/movie/"], a[href*="/tv/"]');
        if (!anchor) return;
        const title = anchor.getAttribute("title") || textOf(container.querySelector("h2, .title"));
        const isShow = anchor.getAttribute("href").includes("/tv/");
        items.push({
          id: findImdbIdIn(container), // usually null on TMDB list DOM
          title: title || "",
          year: guessYear(textOf(container)),
          type: isShow ? "show" : "movie",
          container
        });
      });
      return items.filter((i) => i.title);
    }
  },
  {
    name: "thetvdb",
    hostMatches: (h) => h.endsWith("thetvdb.com"),
    findItems() {
      const nodes = document.querySelectorAll(".card, .series, [class*='item']");
      const items = [];
      nodes.forEach((container) => {
        const anchor = container.querySelector('a[href*="/series/"], a[href*="/movies/"]');
        if (!anchor) return;
        const title = textOf(anchor);
        if (!title) return;
        items.push({
          id: findImdbIdIn(container),
          title,
          year: guessYear(textOf(container)),
          type: anchor.getAttribute("href").includes("/movies/") ? "movie" : "show",
          container
        });
      });
      return items;
    }
  },
  {
    name: "letterboxd",
    hostMatches: (h) => h.endsWith("letterboxd.com"),
    findItems() {
      const nodes = document.querySelectorAll("li.poster-container, .film-poster");
      const items = [];
      nodes.forEach((container) => {
        const posterDiv = container.querySelector(".film-poster") || container;
        const title =
          posterDiv.getAttribute("data-film-name") ||
          posterDiv.getAttribute("data-original-title") ||
          textOf(container.querySelector("img")?.getAttribute && container.querySelector("img")) ||
          "";
        const img = container.querySelector("img[alt]");
        const altTitle = img ? img.getAttribute("alt") : "";
        items.push({
          id: findImdbIdIn(container),
          title: title || altTitle || "",
          year: "",
          type: "movie",
          container
        });
      });
      return items.filter((i) => i.title);
    }
  }
];

function getActiveAdapter() {
  const host = location.hostname;
  return SITE_ADAPTERS.find((a) => a.hostMatches(host)) || null;
}
