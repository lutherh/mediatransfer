# Virtualized Grid Plan

Improve catalog page performance for large photo libraries (10k+ items) by replacing the
fully-rendered DOM grid with a **windowed virtual list** that only mounts DOM nodes for
sections near the viewport.

## Background

The React catalog page (`frontend/src/pages/catalog-page.tsx`) previously rendered every
loaded section into the DOM simultaneously. For large libraries this caused:

- Thousands of simultaneous `<img>` nodes and IntersectionObserver callbacks
- High memory usage growing with each infinite-scroll page load
- Sluggish scrolling on mobile or low-end devices

The page already used `content-visibility: auto` (CSS-native virtualization) as a
mitigation, but this only skips **layout/paint**; DOM nodes still exist and JavaScript
still tracks them.

## Architecture

```
sections (data)
    └─▶  virtualRows[]  (one per date-section, with embedded month-divider metadata)
              └─▶  useWindowVirtualizer   (@tanstack/react-virtual)
                        └─▶  renders only N visible rows (+ overscan)
```

Each **virtual row** wraps one date-section and an optional "Best of Month" divider.
Section-level granularity (rather than item-level) is chosen because:

- It keeps the existing grid layout (`grid-cols-3 ... lg:grid-cols-8`) without changes
- A 10x DOM reduction (10 visible sections × 30 items = 300 nodes vs 3000+) is
  sufficient for good perf
- It preserves all existing features without layout gymnastics

## Steps

### Step 1 — Extract inline SPA to file `[x]`

Changed `src/api/routes/catalog-html.ts` to load HTML from `archive_browser.html` on disk
rather than keeping a large inline string. This makes the file independently editable and
enables iterative development without TypeScript recompiles.

> **Issue after Step 1:** `archive_browser.html` was never committed, so `GET /catalog`
> returned the fallback stub page. **Fixed** in Step 2.

---

### Step 2 — Fix `GET /catalog` endpoint `[x]`

Created `archive_browser.html` as a lightweight redirect page that sends users to the
React frontend at `http://localhost:5173/catalog`. A JavaScript snippet on the page
automatically redirects from port 3000 → 5173.

---

### Step 3 — Implement section-level virtual grid `[x]`

**Files changed:**
- `frontend/src/pages/catalog-page.tsx`
- `frontend/src/components/date-scroller.tsx`

**New dependency:** `@tanstack/react-virtual@^3`

**Changes:**

1. `VirtualSectionRow` type — one entry per date section, carrying:
   - `date`, `items`, `sectionIndex`, `sectionOffset` (flat item index for lightbox)
   - `monthDivider` metadata when this section opens a new calendar month

2. `virtualRows` useMemo — derives the flat row list from `sections` + `monthGroups`

3. `scrollMargin` — measured via `useLayoutEffect` on the grid container, keeps
   `useWindowVirtualizer` in sync with the page header height.

4. `useWindowVirtualizer` from `@tanstack/react-virtual`:
   - `estimateSize` — month divider (~220 px) + section header (~56 px) +
     grid rows (tile height × `ceil(items/6)`)
   - `measureElement` — corrects estimates via real DOM measurement after render
   - `overscan: 2` — keeps 2 extra sections above/below the viewport in the DOM

5. `scrollToDate` callback — given a date string, finds its virtual row index and
   calls `virtualizer.scrollToIndex()`. Passed to `DateScroller` as `onScrollToDate`.

6. `DateScroller.onScrollToDate` (optional prop) — used instead of `scrollIntoView`
   when available, enabling accurate scrolling to sections not currently in the DOM.

---

### Step 4 — Future: item-level virtualization (optional)

If sections grow very large (hundreds of items per day), item-level virtualization
within each row can be layered on top. Not needed for typical photo libraries.

---

## Verification

```bash
# Tests must pass (2 pre-existing failures are expected and unrelated)
cd frontend && npx vitest run

# TypeScript must compile cleanly
cd frontend && npx tsc --noEmit
```

**Manual checklist:**
- [ ] `http://localhost:5173/catalog` loads, grid renders correctly
- [ ] Scrolling a large library is smooth (no DOM node explosion)
- [ ] DateScroller scrubber jumps to months correctly (including off-screen months)
- [ ] Shift-click range selection works across sections
- [ ] Lightbox prev/next navigation is correct
- [ ] "Best of Month" dividers appear at month boundaries
- [ ] Infinite scroll continues loading new pages at the bottom
