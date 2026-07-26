DMM Bulk Add
A Chrome extension that adds a select-all + bulk add workflow on top of what the official Debrid Media Manager extension does one title at a time.
On IMDb, MDBList, Trakt, TMDB, TheTVDB, and Letterboxd list/watchlist pages it:
Injects a small checkbox on each poster/row in the list
Adds a floating "Select all / N selected / Add to DMM" bar in the bottom right
When you click Add to DMM, it opens each selected title's DMM page in its own tab, throttled a few hundred ms apart so the browser doesn't choke on 200 tabs at once
Install (unpacked, for testing)
Unzip this folder somewhere permanent (don't delete it after installing — Chrome loads the extension from this folder).
Go to chrome://extensions.
Turn on Developer mode (top right).
Click Load unpacked and select this folder.
Visit an IMDb list/watchlist (e.g. imdb.com/list/ls... or your watchlist), check a few titles, and click Add to DMM in the bottom-right bar.
How "bulk add" actually works
DMM (debridmediamanager.com) doesn't have a public "add 200 titles at once with one click" endpoint — adding a title still means picking the specific torrent release you want on that title's DMM page. What this extension automates is the navigation part: instead of opening each title's page yourself one by one, you check the ones you want and it opens all of them for you as tabs, each already pointed at:
debridmediamanager.com/movie/<imdbId> or /show/<imdbId> when an IMDb ID could be read from the page, or
debridmediamanager.com/search?query=<title> <year> as a fallback when no IMDb ID is present in the list page's HTML (this happens on some sites like Letterboxd/TMDB, which don't expose IMDb IDs on list pages)
From there you still do the final "pick this release" click per tab, but you no longer have to search for each title individually.
Auto-picking "Instant RD"
DMM labels already-cached results "Instant RD" and not-yet-cached ones "DL with RD". When a bulk-opened tab lands on a title page, a second content script (dmm-autopick.js) watches the results list and:
Waits for the list to go quiet — no new results appearing for ~1 second (settleMs, tunable in the popup) — before picking anything. DMM streams results in over a second or two, so clicking on the very first "Instant RD" it sees can grab a lower-quality result that happened to render first. Waiting for a quiet period fixes that.
Once settled, clicks the first Instant RD result (this is what actually adds it to your library) and shows a toast confirming which one it picked.
If nothing's cached after ~15 seconds (maxWaitMs), it leaves the page alone so you can pick "DL with RD" yourself, with a toast saying so.
Caveats worth knowing:
Real-Debrid removed its official "instant availability" endpoint, so DMM's cached/not-cached info is crowdsourced rather than a live check — usually right for popular titles, less reliable for obscure ones.
It always clicks the first Instant RD result. If you care about a specific resolution/release group, turn off "auto-click Instant RD" and pick manually.
Site markup can change; dmm-autopick.js matches on visible button text ("Instant RD" / "DL with RD") rather than CSS classes, since that's more stable than internal class names — but if DMM changes the wording, this is the file to update.
One shared tab instead of opening many
Turning on "Use one shared tab" (default on) changes the bulk-add flow so it opens a single tab, waits for dmm-autopick.js to report back (clicked, or gave up), then re-navigates that same tab to the next title — instead of opening one tab per title. Same end result, far less tab-bar clutter; you can pin that one tab off to the side and ignore it.
This mode assumes auto-click is doing the picking for you, since the page gets replaced automatically once a result comes back. If you want to manually review every title yourself, turn off "Use one shared tab" (or turn off "Auto-click Instant RD", though then progress will only advance once each page's max-wait timeout hits — better to just use multi-tab mode for manual review).
There's no way to skip opening a real DMM page at all — DMM doesn't have a public "add without loading the site" API, and reverse-engineering their private endpoints instead would be fragile and could stop working with any of their deploys, so this sticks to using their actual site through a regular (if reused) browser tab.
Auto-tracked links
In the popup, under Auto-tracked links, you can paste a list/watchlist URL (same sites as above) and click Add. This:
Opens that page in a background tab, scans it for every title it can find (scrolling it a few times first, to help pages that lazy-load their list via infinite scroll), and closes the tab.
Sends every title found straight into the same "Add to DMM" flow described above (respecting your settings — one shared tab or many, auto-click Instant RD, etc.).
Saves the link and remembers exactly which titles it saw.
From then on, that link is re-checked automatically every 24 hours (using chrome.alarms, so it keeps running as long as the browser is open — it doesn't need the popup open). Each check re-scans the page, compares against what it saw last time, and sends only the new titles to DMM. Titles removed from the list aren't removed from DMM or from what's "known" — this only ever adds.
Each tracked link also has a Check now button to re-check it immediately instead of waiting for the next 24-hour cycle, and a Remove button to stop tracking it (this only stops future checks — it doesn't undo anything already sent to DMM).
Things worth knowing:
Scanning reuses the exact same page-scraping logic as the checkbox/toolbar feature (site-adapters.js), so it's subject to the same caveats. For long lazy-loaded lists (MDBList, IMDb, etc.), the scan scrolls the tab repeatedly — re-checking the item count after each scroll — and keeps going until the count stops growing for a few rounds in a row, rather than a fixed number of scrolls, so it should reach the end even on lists with hundreds of titles. It's capped at 40 scroll rounds / 45 seconds total so a stuck or endless list can't hang a scan forever; if a list is unusually long, re-run Check now afterward to pick up anything still missed.
Private lists (e.g. a private Trakt list or IMDb watchlist) work as long as you're logged into that site in your normal browser profile, since the background tab shares your cookies.
Briefly opening a background tab every 24 hours (and once immediately when you add a link) is how the scan happens — there's no way around loading the real page, for the same reason there's no way to add to DMM without loading the real DMM page (see above).
The 24-hour timer starts fresh whenever the browser (re)starts if it had stopped for some reason, but won't skip your regular checks — it's driven by chrome.alarms, which persists independently of the popup being open.
TV show — all seasons
In the popup, under TV show — all seasons, paste a DMM show URL (debridmediamanager.com/show/<imdbId>) or just the bare IMDb ID, and click Add all seasons. This reads the show's season-nav bar to find every season it has, then sends them all through the same whole-season → every-episode logic described below — as a one-off, without waiting for a tracked link's next scheduled check.
"Include Specials (season 0)" (in Settings) applies here too — off by default.
Season handling for tracked TV shows
Auto-tracked links (and the all-seasons tool below) don't stop at season 1. For any show, the extension first opens its base show page to read the season-nav bar (however many seasons it has, including Season 0 if "Include Specials" is on), then queues every season individually. Each season page:
Tries "Instant RD (Whole Season)" first.
Falls back to "Instant RD (Every Episode)" if the whole-season option isn't there.
Leaves the page alone for manual review if neither shows up in time.
Each season is tracked and skipped/retried independently — so if season 3 isn't cached yet but seasons 1, 2, and 4 are, only season 3 gets retried on the next check, instead of the whole show being marked done or redone as a unit.
Things worth knowing:
This turns off if "Auto-click Instant RD" is off — with it off, each season page is just opened and left for you to pick manually.
Discovering a show's seasons briefly opens and closes a background tab, same as everything else here — there's no way around loading the real page for this.
Library refresh (reinsert everything)
DMM's /library page has a per-item "reinsert" icon (a green refresh arrow) — distinct from the single "Refresh library" button in the top bar — that re-checks/re-adds that one item. Library refresh in the popup automates clicking that icon on every item in your library:
Refresh DMM library now opens /library in a tab, scrolls through the whole list (handling however many items you have, not just what first renders), clicks every per-item reinsert icon it finds, then closes the tab and records how many it hit.
It also runs automatically on a schedule — Re-check every (days), default 30 — via the same alarm mechanism as auto-tracked links, so it keeps happening as long as the browser is open, popup or not.
This is a full sweep: every movie and every show in your library gets its reinsert icon clicked, not just recently-added ones.
Settings
Click the extension icon to adjust:
Use one shared tab — reuse a single tab sequentially instead of opening one per title
Delay between tabs — pause between titles/navigations; raise this if DMM's server or your connection needs a beat between searches
Re-check every (hours) — how often tracked links are rescanned for new titles; the default is 24 hours
Open new tabs in background — keeps your current tab focused
Auto-click "Instant RD" — turn off to review every result yourself
Settle time before picking (ms) — how long the results list must stay unchanged before the first Instant RD is clicked; raise this if it's still grabbing an early, non-ideal result on a slow connection
Auto-close tab after adding — only applies in multi-tab mode (the shared tab in sequential mode is never closed mid-batch, since it needs to be reused)
Retry titles not yet cached — when on (default), a title/season that wasn't cached last time gets tried again on future checks instead of being skipped forever; titles that were successfully added are always skipped
Include Specials (season 0) — off by default; include a show's Specials season when expanding into all seasons
Re-check every (days) — how often the full library reinsert sweep runs automatically; default 30 days
Extending to more sites
Site-specific scraping logic lives in site-adapters.js. Each entry in SITE_ADAPTERS just needs:
{
  name: "example",
  hostMatches: (host) => host.endsWith("example.com"),
  findItems() {
    // return [{ id: imdbIdOrNull, title, year, type: "movie"|"show", container: domNode }]
  }
}
Then add the site's URL pattern to host_permissions and the content_scripts matches array in manifest.json.
Notes
This is an independent tool and isn't affiliated with the Debrid Media Manager project.
Site markup (especially IMDb's) changes periodically; if checkboxes stop appearing on a site, the CSS selectors in site-adapters.js likely need a small update.
