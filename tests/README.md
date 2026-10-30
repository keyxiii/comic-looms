# Media controls and X list discovery

## Download pattern selection

Run `node --import ./tests/register.mjs --test tests/cherry-pick.test.mjs tests/download-selection.test.mjs`.
These tests cover expression validation, one-based numbering, appended pages,
manual overrides, initial idle requests, bounded download workers, cancellation,
empty source batches, metadata failures, chapter selection and panel drafts.
The tests simulate image data and never download remote media.

With Vite running, open `http://127.0.0.1:5173/tests/download-selection.html`.
This uses the production panel, styles and download worker loop with simulated
images. On 200 pages, apply `2n+1` and start: exactly 100 odd pages are requested.
Append 20 pages: the preview becomes 110 / 220. Check all presets, invalid input,
manual picks/exclusions, clearing, chapter switching and a 360-pixel viewport.
The rules affect automatic image loading and batch downloads; explicitly opening
an excluded image still loads it. Thumbnails/list metadata and previous requests
are unaffected. Rules are per chapter for the current reader session, and editing
the selection or switching chapters is blocked during batch downloads.

The pre-existing `tests/media-logic.test.mjs` still imports the absent
`src/ui/media-actions.ts`; this prevents that file from running in the full suite.
Live site/userscript-manager compatibility remains a manual check.

Context-menu range selection: `node --import ./tests/register.mjs --test tests/context-menu-selection.test.mjs`.
The tests right-click thumbnails and click the production menu actions. The first
range action on page 26 must select pages 1–26, matching its tooltip. Range actions
keep the anchor until a single-image pick/exclusion changes it. Tests also cover
repeated picks, reverse ranges, exclusions, per-chapter anchors and download locks.

## Media regression

Single-image context-menu tests: `node --import ./tests/register.mjs --test tests/single-image-download.test.mjs`.
They verify the captured thumbnail/large-image target, unchanged image bytes,
lazy fetching, in-flight reuse, duplicate suppression, filenames and failure feedback.
GIF/WebP are saved directly; multi-frame archives are rejected rather than zipped.
The browser fixture at `/tests/single-image-download.html` provides red and blue
images in both thumbnail and large-image modes. Right-click the second image and
download it: the result must be `second-blue.png`, a blue 160×120 PNG, with no ZIP.

Run `npm ci`, `npm test`, and `npm run build` using Node.js 24.
The Node tests use simulated media clocks, decoder responses and X responses.
They do not require a browser, authentication or access to X. They cover parser
boundaries, pagination, cache/account isolation, volume/seek limits and asynchronous
animation disposal. They do not prove real codec or live X API compatibility.

For the browser regression page, run `npx vite --host 127.0.0.1` and open
`http://127.0.0.1:5173/tests/media-controls.html` in a browser supporting ImageDecoder.
This exercises real GIF/WebP decoding, the original keyboard settings panel and
context menu. Video timing still uses a simulated clock in this page.
The fixtures are four solid-colour frames (red, green, blue, yellow), generated
with Pillow with delays of 100, 200, 100 and 300 ms; the static WebP is one red frame.

## Manual userscript checks

- Install the built userscript in a supported browser/userscript manager and open
  a video in big-image mode. Test K/J/L/,/./M/I/O, toolbar updates and pause state
  when switching media. The video step is approximately 1/30 second, not an exact
  frame seek. Confirm volume 0 remains 0 after switching videos and reloading.
- Remap a media key in the existing keyboard panel and verify it works. Typing in
  an input or editable field must not trigger media actions.
- Open direct animated GIF/WebP files on a supported gallery. Check stepping,
  fast progress dragging, multiple images per page, scroll modes, zoom/rotation,
  chapter changes, closing and reopening the reader. No canvas/control should
  remain after closing. Unsupported decoders retain the normal original image.
- Context menu: 8 media actions for video, 5 for animation, none for static images
  or grid mode. X “GIF” posts are usually videos and use the video path.
- On X home, show the first discovered List batch with the
  original three chapters; append later pages while the first batch is usable. If all sources are slow, release the base chapters after 1.5 seconds. With no
  cached management request, check pinned lists; visit the Lists page, then reopen
  Comic Looms on home and check owned/subscribed lists. Check names, duplicates,
  recommendation exclusion, list-specific pagination and switching accounts.
- Block a list endpoint or clear its cache and ensure the original chapters keep
  working. The management request cache is account-scoped, expires after seven
  days, and never stores authentication headers, cookies or request cursors.
  The legacy 4.16.0.1 descriptor is also accepted: it contains API metadata only,
  and results are requested using the current login, never copied from another account.
- Test upgrading with the old cache shape `{queryId, features, savedAt}`. Delay
  the main bundle and later management pages: the discovery helper should deliver
  pages without blocking each other, while the homepage renders the first available batch and later appends subsequent batches.
  Reopen the reader and verify the same main bundle is reused.

## Current limits

The user tested 4.16.1.257.3 after clearing site data: pinned lists appeared after
about one second on first login; all lists appeared after visiting X's Lists page.
The user subsequently verified the .4 batch presentation. The .6 progressive presentation and native-page action synchronization still need live browser checks.
Agent-driven authenticated X testing and the media browser regression page remain
blocked/unrun. The X fixture response shapes are synthetic, based on the
provided script; upstream API changes can require parser updates. Feature values
prefer the page state, then the working 4.16.0.1 defaults (unknown keys use false).
These compatibility defaults may need updating when X changes its API. Resource
timing visibility varies with the browser/userscript manager. The main bundle fallback
reads script URLs from the document and resource timing; it does not evaluate
downloaded code. Management pagination is capped at 20 requests. Per-list tweet
fetching reuses the existing upstream TwitterListsAPI (including its existing
tweet-timeline query ID).

## Native X action synchronization

- Existing favorited/bookmarked response fields initialize thumbnail actions for the
  exact media tweet, including retweets. The same tweet shares actions across thumbnails.
- In the same tab, native tweet controls update thumbnail state when their data-testid
  changes (like/unlike, bookmark/removeBookmark). Test both adding and removing.
- Missing controls are unknown; they must not clear a known state. Updates in other
  tabs or in collapsed menus without a visible state change are not observed.
- Existing thumbnail actions remain add-only and validate HTTP/GraphQL success before
  marking completion. For a rendered tweet, thumbnail actions click its native X button so React updates the page too. If the native control is absent, use a current-bundle GraphQL descriptor via GM.xmlHttpRequest; this fallback cannot force an unmounted React view to refresh. Mutations are never automatically retried.
- Test multiple photos, repeated tweets across chapters, native rerenders, and error
  responses. The automated tests cover state extraction and simulated DOM transitions;
  they do not click real account likes/bookmarks.
