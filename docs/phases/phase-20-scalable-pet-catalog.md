# Phase 20: Scalable Pet Catalog and Lightweight Picker Images

## Goal

Scale the public pet catalog and desktop Pet Manager beyond 1,000 pets without loading full spritesheets for every visible card.

The clean solution is to move lightweight preview generation into the `web/` catalog pipeline and have desktop consume paginated catalog metadata with small thumbnail assets.

## Non-goals

- Do not change Codex/local pet discovery, import, preview inlining, or `~/.codex/pets` behavior in this phase.
- Do not change installed pet runtime rendering; installed pets still use `spritesheet.webp` after install.
- Do not remove or break `catalog.v2.json`; keep it available for older desktop clients.
- Do not make the Electron renderer construct untrusted image URLs independently.
- Do not broaden desktop CSP beyond the exact image origins needed.

## Problem

The current desktop Pet Manager reads `catalog.v2.json`, then uses each pet's `preview` URL as a card preview. Today `web/scripts/*` writes `preview` as the full spritesheet:

```js
preview: `${PUBLIC_BASE_URL}${pet.spritesheetPath}`
```

That means the picker can request hundreds or thousands of full files like:

```text
https://openpets.dev/pets/<slug>/spritesheet.webp
```

With a 1,000+ pet catalog, this creates excessive network, decode, memory, and layout work. Desktop-side lazy loading helps, but it does not solve the root issue: gallery cards need tiny thumbnails, not full runtime spritesheets.

## Desired outcome

- Public catalog supports 1,000+ pets without a huge single JSON payload.
- Pet Manager initially loads only a small page of metadata and small thumbnails.
- Full spritesheets are fetched only when needed for install/runtime or, optionally, selected-pet detail preview.
- Pet Manager keeps existing filters, including `Codex`, and adds the same high-level public catalog filters already used on the web: `Western` and `Asian`.
- Existing desktop clients can continue using `catalog.v2.json`.
- Codex/local pet behavior remains unchanged.

## Implementation status

Implemented.

This phase now ships the scalable path end-to-end:

- `web/` generates static `thumb.webp` files from each catalog pet spritesheet.
- `web/` writes `catalog.v3.json` plus paginated `catalog.v3/page-XXX.json` files.
- Desktop fetches/validates v3 first and falls back to v2/fixture when v3 is unavailable or invalid.
- Desktop Pet Manager card thumbnails use v3 `thumbnail` URLs instead of full `spritesheet.webp` files.
- Desktop keeps `All`, `Installed`, and `Codex`, and exposes `Western` / `Asian` only when v3 metadata is available.
- Desktop install lookup can resolve v3 pets outside the initially loaded page.
- Codex/local pet discovery, import, and preview behavior were intentionally left unchanged.

## Implemented asset model

For every public catalog pet under `web/public/pets/<slug>/`, the web pipeline now generates and publishes:

```text
spritesheet.webp  # existing full runtime/install asset
thumb.webp        # new tiny static thumbnail for gallery cards
preview.webp      # not generated in this implementation
<petId>.zip       # existing install package, served from zip.openpets.dev
```

Recommended budgets:

- `thumb.webp`: 96-160px static image, target < 10-20 KB.
- `preview.webp`: optional short idle animation or selected-detail image, target < 50-100 KB.
- `spritesheet.webp`: unchanged; used for installs/runtime, not bulk gallery cards.

`preview.webp` was not implemented in this phase. Desktop uses `thumbnail` for v3 cards and keeps `spritesheet` for install/runtime metadata. Existing v2 clients still receive full spritesheet `preview` values through `catalog.v2.json`.

Implemented thumbnail generation details:

- Helper: `web/scripts/catalog-v3.js`.
- Dependency: `sharp` added to `web/package.json` and `web/bun.lock`.
- Source: `spritesheet.webp`.
- Crop: idle first frame from the universal 8-column by 9-row spritesheet grid.
- Output: `thumb.webp`, resized to fit within 128×128 as WebP.
- Stale detection: regenerate when `spritesheet.webp` is newer than `thumb.webp`.
- Budget warning: logs when a generated thumbnail exceeds 32 KB.

## Implemented catalog model

`public/pets/catalog.v2.json` is still generated for compatibility. It remains capped to the desktop v2 validator's 1,000-pet limit if the public catalog grows beyond that size.

`public/pets/catalog.v3.json` is now generated as an index. Current generated output at implementation time:

- total pets: `668`
- page size: `100`
- page files: `7`
- category counts: `western: 340`, `asian: 328`

Index shape:

```json
{
  "version": 3,
  "generatedAt": "2026-05-12T15:54:53.434Z",
  "total": 668,
  "pageSize": 100,
  "filters": {
    "categories": [
      { "id": "western", "label": "Western", "count": 340 },
      { "id": "asian", "label": "Asian", "count": 328 }
    ]
  },
  "pages": [
    "https://openpets.dev/pets/catalog.v3/page-000.json",
    "https://openpets.dev/pets/catalog.v3/page-001.json"
  ]
}
```

Paginated page files are generated under `public/pets/catalog.v3/`:

```json
{
  "version": 3,
  "page": 0,
  "pageSize": 100,
  "pets": [
    {
      "id": "snoopy",
      "displayName": "Snoopy",
      "description": "A tiny black-and-white beagle with a red collar for calm coding sessions.",
      "thumbnail": "https://openpets.dev/pets/snoopy-23e05847/thumb.webp",
      "spritesheet": "https://openpets.dev/pets/snoopy-23e05847/spritesheet.webp",
      "zip": "https://zip.openpets.dev/pets/snoopy-23e05847/snoopy.zip",
      "category": "western",
      "subcategory": "cartoons"
    }
  ]
}
```

Fields:

- `thumbnail`: required for v3 catalog pets.
- `preview`: optional; not emitted by the current generator.
- `spritesheet`: emitted for install/runtime metadata and selected-detail fallback, but not used for card thumbnails.
- `zip`: required for installation.
- `category`: required for v3 public catalog pets and currently limited to `western` or `asian`.
- `subcategory`: optional; preserve existing web metadata where present.

V3 index invariants:

- Maximum index response size: 256 KB.
- Maximum page response size: 256 KB.
- Default page size: 100 pets.
- Maximum page size: 200 pets.
- Maximum page count: 100 pages for this phase.
- `total` must equal the sum of pets across all pages during generation.
- Pet IDs must be unique across all pages.
- Page URLs must match `https://openpets.dev/pets/catalog.v3/page-<3 digit>.json`.
- Deploy ordering must publish page files before publishing the index that references them.

Implemented desktop validation additionally enforces:

- index `version: 3`, valid `generatedAt`, bounded `total`, bounded `pageSize`, and max 100 page URLs;
- `pages.length === Math.ceil(total / pageSize)`;
- category filters include exactly non-duplicated `western` and `asian` entries;
- category counts sum to `total`;
- page URLs are exact `https://openpets.dev/pets/catalog.v3/page-XXX.json` URLs with no query/hash;
- v3 pet image URLs are HTTPS `openpets.dev` `/pets/` WebP URLs;
- zip URLs remain HTTPS `zip.openpets.dev` `/pets/` URLs;
- duplicate pet IDs are rejected within each page and across loaded/cached pages.

## Public catalog filters

The web app already groups public pets into two top-level filters: `Western` and `Asian`. V3 should carry this as canonical metadata so desktop does not infer categories from names, slugs, descriptions, or paths.

Filter contract:

- `category` is required for every v3 public catalog pet.
- Allowed initial values are exactly:
  - `western`
  - `asian`
- Desktop labels these as `Western` and `Asian`.
- Desktop keeps existing filters and adds category filters: `All`, `Installed`, `Codex`, `Western`, and `Asian`.
- `Codex` filter behavior must stay unchanged from the current Pet Manager.
- If a v3 pet has a missing/unknown category, validation should reject the page or mark the pet unavailable rather than guessing.
- v2 fallback does not provide reliable category filtering; when using v2 fallback, desktop should hide `Western`/`Asian` filters or show them disabled.
- Codex/local-only pets are not part of this category filter contract in this phase. If shown in the same grid, they continue to appear under the existing `Codex` filter and under `All`/`Installed` when applicable, but not under `Western`/`Asian` unless they correspond to a catalog pet with v3 category metadata.

Category source rules:

- `web/scripts/import-reviewed-pets.js` already validates reviewed-pet `category`; v3 must preserve it.
- `web/scripts/sync-pets.js` must preserve category from an existing manifest entry when present.
- `web/scripts/sync-local-pets.js` must preserve category from the existing generated/manifest entry when present.
- Any pet still missing `western`/`asian` after preservation is excluded from v3 and logged, while v2 remains unchanged for compatibility.
- Generation must not infer category from names, slugs, descriptions, upstream source, or folder paths.

## Web implementation details

Updated all public catalog writers that currently emit `catalog.v2.json`:

- `web/scripts/sync-pets.js`
- `web/scripts/import-reviewed-pets.js`
- `web/scripts/sync-local-pets.js`

Implemented tasks:

1. Added shared helper `web/scripts/catalog-v3.js` for thumbnail generation, v2 compatibility output, category preservation, v3 index/page generation, and v3 JSON size checks.
2. Generated `thumb.webp` for each public catalog pet if missing or stale.
3. Deferred `preview.webp`; current v3 output omits `preview`.
4. Kept `catalog.v2.json` compatible and capped through `v2CatalogCompatible()`.
5. Wrote `catalog.v3.json` plus `catalog.v3/page-XXX.json` files.
6. Kept zip URLs on `zip.openpets.dev` unchanged.
7. Preserved existing web category metadata as `category: "western" | "asian"`.
8. Excluded/logged pets missing known categories from v3 instead of guessing.
9. Added category counts to the v3 index so desktop can expose filters before every page is loaded.

Thumbnail generation behavior:

- Uses `sharp` in the web workspace.
- Extracts the top-left idle frame based on the universal 8×9 spritesheet grid.
- Resizes to 128×128 with `fit: contain` and writes WebP.
- Compares `thumb.webp` mtime to `spritesheet.webp` mtime.
- Warns if a generated thumbnail exceeds 32 KB.

## Desktop implementation details

Added a new desktop catalog path while keeping v2 fallback:

1. `apps/desktop/src/catalog.ts` fetches `https://openpets.dev/pets/catalog.v3.json` first.
2. `apps/desktop/src/catalog-validation.ts` validates index/page shape and URL contracts.
3. Initial Pet Manager state fetches only page 0.
4. Additional pages load through `openpets:get-catalog-page` and a Pet Manager `Load more pets` button.
5. Cards render from v3 `thumbnail`; v2 fallback still uses v2 `preview`.
6. Existing `Codex` filter is preserved; v3 enables `Western` and `Asian` filter buttons.
7. `Western`/`Asian` filtering uses only validated v3 `category` metadata.
8. `spritesheet` is not used for bulk card thumbnails.
9. If v3 fails, desktop falls back to v2, then fixture.
10. If a later v3 page fails during install lookup, install lookup falls back to v2/fixture instead of aborting immediately.
11. Remote image and catalog URLs are validated in the main process before preload consumes them.

Main-process data contract:

- `CatalogUiState` now includes `version: 2 | 3` and optional `v3` paging/filter metadata.
- Main process owns index/page fetch, validation, caching, and install lookup.
- `getCatalogPageUiState(pageIndex)` returns the currently loaded/cached v3 pages as a merged UI state.
- `getCatalogPetById(petId)` can scan/fetch validated v3 pages for install lookup, then falls back to v2/fixture.
- Installed v3 pets store `catalogVersion: 3` and thumbnail fallback in `InstalledPetState.source.preview`.
- Installed catalog pets outside loaded pages reuse `installed.source.preview` so their cards do not go blank after restart.

Renderer behavior:

- Uses explicit paging via `Load more pets`; virtualization is deferred.
- Shows loaded-page UX copy: “Showing loaded pets only. Load more to continue browsing and filtering the full catalog.”
- Uses `new Image()` with async decoding and `no-referrer`, preserving existing graceful empty/failure surfaces.
- Treats v3 thumbnails as non-spritesheet images so installed v3 thumbnail fallbacks are not animated/cropped like spritesheets.
- Does not change Codex/local pet rendering or import behavior.

Updated desktop files:

- `apps/desktop/src/catalog-validation.ts`: v3 index/page/pet/category validators.
- `apps/desktop/src/catalog.ts`: v3 fetch/cache/page/lookup flow with v2 fallback.
- `apps/desktop/src/windows.ts`: IPC `openpets:get-catalog-page`, category filter buttons, load-more styling.
- `apps/desktop/preload.cjs`: v3 UI state, category filters, load-more behavior, thumbnail-first preview selection.
- `apps/desktop/src/pet-installation.ts`: install lookup uses `getCatalogPetById()` and stores catalog version/preview fallback.
- `apps/desktop/src/app-state.ts`: installed catalog source accepts `catalogVersion: 2 | 3`.
- `apps/desktop/src/check-catalog-fixture.ts`: v3 validation coverage.
- `apps/desktop/src/check-packaging-contract.ts`: Pet Manager v3/filter/thumbnail contract checks.

## Security and compatibility notes

- Desktop CSP should continue to allow only `data:` and `https://openpets.dev` for Pet Manager images unless the implementation requires a narrower path/origin rule.
- The renderer must not independently derive `thumbnail`, `preview`, `spritesheet`, or `zip` URLs.
- Main process should validate:
  - catalog index final URL,
  - page URL origin/path,
  - thumbnail/preview/spritesheet origin/path/extension,
  - zip origin/path/extension.
- `catalog.v2.json` remains the compatibility contract for currently shipped clients.
- If the total public catalog exceeds the current v2 validator's limit, `catalog.v2.json` should remain capped to a compatible curated subset rather than silently breaking shipped clients.
- `catalog.v3` can be rolled out on the web before desktop starts consuming it.

## Rollout plan

1. Web-only rollout:
   - Generate `thumb.webp` assets.
   - Publish `catalog.v3` alongside existing v2.
   - Verify URLs and asset sizes on production.
2. Desktop fallback support:
   - Add v3 fetch/validation with v2 fallback.
   - Keep existing Pet Manager behavior if v3 is missing.
3. Desktop performance update:
   - Switch cards to `thumbnail`.
   - Add paging/virtualization and bounded image loading.
4. Cleanup/observability:
   - Add size checks to web sync scripts.
   - Add desktop contract tests for v3 validation and fallback.

## Generated deployment artifacts

Generated in `web/public/pets/`:

- `catalog.v3.json`
- `catalog.v3/page-000.json` through `catalog.v3/page-006.json`
- `thumb.webp` for each generated public pet directory

Current generated v3 catalog validation:

- `total`: 668
- pages: 7
- `western`: 340
- `asian`: 328
- every v3 pet thumbnail ends in `/thumb.webp`
- every v3 pet category is either `western` or `asian`

## Acceptance criteria

- `catalog.v2.json` output remains backward compatible.
- `catalog.v3.json` and page files are generated by all relevant web catalog sync/import flows.
- Every v3 pet has a small `thumbnail` URL under `https://openpets.dev/pets/` ending in `.webp`.
- Desktop Pet Manager card grid uses `thumbnail` for catalog pets.
- Desktop Pet Manager includes `All`, `Installed`, existing `Codex`, `Western`, and `Asian` filters when v3 metadata is available.
- `Codex` filter behavior is unchanged.
- `Western`/`Asian` filters are driven only by validated v3 `category` metadata.
- If desktop falls back to v2, `Western`/`Asian` filters are hidden or disabled because v2 does not guarantee category metadata.
- Opening Pet Manager with 1,000+ catalog pets does not request all full `spritesheet.webp` files.
- Initial Pet Manager open requests only the v3 index, first page, and thumbnails for rendered/visible cards.
- Full `spritesheet.webp` files are requested only for selected detail preview if explicitly implemented, install packages, or runtime installed pets.
- v3 outage or validation failure falls back to v2 without breaking install/default/remove operations.
- `catalog.v2.json` remains within the compatibility limit expected by shipped desktop clients.
- Codex/local pet behavior is unchanged.
- Web generation validates unique v3 IDs, category counts, page URLs, response-size budgets, and thumbnail existence.

## Test/check plan

Web:

```bash
cd web
bun lint
bun run build
bun run sync:pets
```

Desktop:

```bash
pnpm --filter @open-pets/desktop build
pnpm --filter @open-pets/desktop test
pnpm package:desktop:dir
```

Actual validation completed:

```bash
cd web
bun lint
node --check scripts/catalog-v3.js
node --check scripts/sync-pets.js
node --check scripts/import-reviewed-pets.js
node --check scripts/sync-local-pets.js
node -e "/* generated catalog.v3 validator */"
```

```bash
cd /home/alvin/pets
pnpm -r build
pnpm --filter @open-pets/desktop test
```

Results:

- Web lint passed.
- Web sync script syntax checks passed.
- Generated v3 catalog validation passed.
- Workspace build passed.
- Desktop test suite passed, including catalog fixture validation and packaging contract validation.

Notes:

- `bun run build` for `web/` timed out in this environment after Nuxt generated output and reported existing link-checker `/integrations` 500 errors; this was not caused by the catalog v3 implementation.
- `pnpm` was enabled through Corepack and resolved as `11.0.8` before running workspace build/test.

Manual verification:

1. Publish or locally serve a v3 catalog with at least 1,000 pets.
2. Open desktop Pet Manager.
3. Confirm only index/page JSON and card thumbnails are loaded initially.
4. Scroll/load more and confirm requests grow by page/viewport, not by total catalog size.
5. Switch between `All`, `Installed`, `Codex`, `Western`, and `Asian`; confirm Codex remains unchanged and category filters match web categories.
6. Select a pet and confirm detail still works.
7. Install a pet and confirm runtime installed pet behavior is unchanged.
8. Disable v3 and confirm v2 fallback works with category filters hidden/disabled.
9. Confirm Codex/local pets behave exactly as before.

## Oracle implementation review

Oracle reviewed the plan and implementation in two passes.

Plan review blockers fixed:

- Preserved the existing `Codex` filter.
- Defined category source rules instead of guessing categories.
- Added paged v3 install lookup through main-process catalog fetching/cache.
- Kept v2 compatibility bounded.
- Added category counts to the v3 index for correct filter labels before all pages are loaded.

Implementation review issues fixed:

- Added `web/scripts/catalog-v3.js`, generated v3 JSON files, and generated `thumb.webp` assets.
- Updated `web/bun.lock` for the new `sharp` dependency.
- Installed v3 pets outside loaded pages now reuse stored thumbnail fallback after restart.
- Desktop v3 validation now checks page count, category counts, category filter completeness, no page URL query/hash, and duplicate IDs across cached pages.
- Install lookup falls back to v2/fixture if a later v3 page is unavailable/invalid.
- Pet Manager now explicitly says filters/search apply to loaded pets until more pages are loaded.
- v3 installed thumbnail fallbacks are treated as thumbnails, not spritesheets.

Final Oracle result: no blockers and no remaining code should-fix defects.

## Remaining open questions

- Should `preview.webp` ship in the first implementation, or should v3 start with only `thumbnail` plus existing `spritesheet`?
- Should desktop search initially search loaded pages only with explicit copy, or should the web publish a lightweight searchable index in the same phase?
