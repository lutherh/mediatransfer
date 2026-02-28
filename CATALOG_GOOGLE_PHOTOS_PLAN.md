# Google Photos–Inspired Catalog Enhancement Plan

## References

1. **`google_photos_inspiration.html`** — actual Google Photos web UI source (sidebar, search, icons, CSS vars, ripple).
2. **[Immich](https://github.com/immich-app/immich)** — top Google Photos alternative, 55 k+ ★, SvelteKit/TypeScript web UI. Deep-dived into sidebar, layout, timeline, asset viewer, detail panel, navigation bar.
3. **[Ente](https://github.com/ente-io/ente)** — E2E encrypted photo alternative, React/TypeScript gallery. Reviewed FileInfo component, viewer, and metadata display patterns.
4. **[GitHub: google-photos topic](https://github.com/topics/google-photos)** — 305+ repos surveyed for patterns.

---

## 1. Current State Summary

The catalog is a fully inline SPA served from `buildCatalogHtml()` in `src/api/routes/catalog.ts` (~1 531 lines). It provides:

| Feature          | Current Implementation |
|------------------|----------------------|
| Navigation       | Horizontal tab bar (Photos / Albums / Date Repair) |
| Layout           | Sticky top bar → content area with CSS grid |
| Photo grid       | Uniform square tiles (`aspect-ratio:1`), auto-fill `minmax(140px,1fr)` |
| Date grouping    | Sticky section headers with date label, item count, section-select checkbox, problematic-date warning |
| Selection        | Click check-circle on tile, Ctrl+A, section-select; selection toolbar appears at top |
| Actions          | Delete, Download, Add-to-Album, Date-Repair (from selection toolbar) |
| Preview/Viewer   | Full-screen modal overlay with left/right arrows, keyboard nav, download/delete from viewer |
| Albums           | Side panel: create, delete, add items to album, view album contents |
| Date Repair      | Dedicated tab: scans for `1970/`, `2001/01/01/`, etc., lists moves, bulk apply |
| Search/Filter    | Prefix text input + media-type dropdown + sort dropdown (6 options) |
| Theme            | Dark only |
| Lazy loading     | IntersectionObserver with 400 px root margin, chunked rendering (200/batch) |
| Keyboard         | Ctrl+A, Escape, left/right arrows in viewer |

### Pain Points

- Horizontal tabs don't scale (adding Favorites / Trash would crowd the bar)
- No real search — just S3 prefix filter
- Viewer is minimal (no zoom, no info panel, no swipe)
- Dark-only, no light theme
- Grid is uniform squares — wastes vertical space on landscape photos
- No concept of Favorites, Trash, or Archive
- No keyboard-driven grid navigation (arrow keys between tiles)
- Section headers are functional but dull

---

## 2. Google Photos UI Patterns (from inspected source)

### 2.1 Overall Layout

```
┌──────────────────────────────────────────────────────────────┐
│  [≡]  Photos  [🔍 Search your photos and albums…]   [+] ⚙ ? •••  [avatar] │
├──────────┬───────────────────────────────────────────────────┤
│ sidebar  │                                                   │
│          │   Section header:  "Jun 17, 2025"                │
│ ● Photos │   ┌───┬───────┬───┬───┐                          │
│ ○ Updates│   │   │       │   │   │  ← variable-height rows  │
│ ○ Shop   │   ├───┼───┬───┼───┼───┤                          │
│          │   │   │   │   │   │   │                          │
│Collections   └───┴───┴───┴───┴───┘                          │
│ ▸ Albums │                                                   │
│ ▸ Docs   │   Section header:  "May 12, 2025"                │
│          │   ┌───┬───┬───┬───┬───┐                          │
│          │   │   │   │   │   │   │                          │
│          │   └───┴───┴───┴───┴───┘                          │
└──────────┴───────────────────────────────────────────────────┘
```

### 2.2 Key UI Elements Extracted

| Element | Google Photos Implementation |
|---------|------------------------------|
| **Sidebar** | 220 px fixed left rail, `role="navigation"`. Contains avatar, branding, primary tabs (Photos, Updates, Print store), "Collections" header, expandable sub-items (Albums, Documents). Selected tab has active/filled icon. |
| **Header/Top bar** | Hamburger menu (≡), "Photos" branding text, search combobox with autocomplete (`role="combobox"`, `aria-autocomplete="list"`), action buttons: Create (+), Settings (⚙), Help (?), More options (•••). Right side: Google Apps grid, account avatar with dropdown. |
| **Search** | Pill-shaped input with magnifying glass icon, placeholder "Search your photos and albums", clear button (×), `role="combobox"` with `aria-haspopup="true"`. Has loading spinner. |
| **Photo grid** | Justified layout (variable row heights to fill width), thumbnails crop-to-fill. Uses `data-src` lazy loading. |
| **Selection** | Check circle top-left of each tile (appears on hover). Once 1+ items selected, header transforms into selection bar with count + actions. |
| **Icons** | All SVG, 24×24 viewBox. Material Design icon set. Icon buttons have 48×48 touch target with ripple (`@keyframes mdc-ripple-fg-radius-in`). |
| **Tooltips** | `data-is-tooltip-wrapper`, `role="tooltip"`, `aria-hidden` toggled. |
| **Typography** | `Google Sans Text` (wght 400;500;700), `Google Sans` for headings. |
| **Colors (light)** | White background, dark text, blue accent (#1a73e8 / Google Blue). Uses CSS custom properties `--gm3-sys-color-*` (Material Design 3). |
| **Theme** | `<meta name="theme-color" content="#fff" media="(prefers-color-scheme: light)">` and `content="#1f1f1f"` for dark. Supports both. |
| **Overflow menu** | Three-dot button → dropdown menu with "Select photos" option. |
| **Animations** | Ripple effect on buttons, smooth expand/collapse on sidebar sub-items, transitions on hover states. |

### 2.3 SVG Icons Extracted (exact paths from source)

```
Hamburger ≡:  M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z
Search 🔍:    M20.49 19l-5.73-5.73C15.53 12.2 16 10.91 16 9.5A6.5 6.5 0 1 0 9.5 16c1.41 0 2.7-.47 3.77-1.24L19 20.49 20.49 19zM5 9.5C5 7.01 7.01 5 9.5 5S14 7.01 14 9.5 11.99 14 9.5 14 5 11.99 5 9.5z
Close/Back ←: M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z
Plus +  :     M20 13h-7v7h-2v-7H4v-2h7V4h2v7h7v2z
Settings ⚙:   (gear path — complex, extracted from source)
Help ? :      M11 18h2v-2h-2v2zm1-16C6.48 2 2 6.48 2 12s4.48 10 10 10...
More •••:     M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z
Photos:       M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H5V5h14v14zm-5-7l-3 3.72L9 13l-3 4h12l-4-5z
Albums:       M18 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 18H6V4h6v7l2.5-1.88L17 11V4h1v16zm-4.33-6L17 18H7l2.5-3.2 1.67 2.18 2.5-2.98z
Notifications: M160-200v-80h80v-280q0-83 50-147.5T420-792v-28... (960 viewBox bell icon)
Shopping bag:  M19 6h-2c0-2.76-2.24-5-5-5S7 3.24 7 6H5c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2z...
Chevron ▾:    M7 10l5 5 5-5H7z
Check ✓:      M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z  (already used)
Select circle: M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4... 
```

---

## 2b. Open-Source Implementation Patterns (Immich & Ente)

### Immich — Architecture & Components

Immich is the most mature OSS Google Photos alternative (55 k+ stars). Its web UI is a SvelteKit SPA.

#### Layout (user-page-layout.svelte)

```
CSS Grid: grid-cols-[0_auto] → sidebar:grid-cols-[256px_auto]
┌──────┬──────────────────────────────────────┐
│      │  NavigationBar (top)                 │
│ Side │──────────────────────────────────────│
│ bar  │  Main content (overflow-y-auto)      │
│ 256px│  class="immich-scrollbar"            │
│ w-64 │                                      │
└──────┴──────────────────────────────────────┘
```

- Desktop sidebar is always visible (`w-64` = 256 px), mobile collapses to `w-0`.
- Toggle: hamburger in nav bar sets `sidebarStore.isOpen`. Uses `clickOutside` + `focusTrap` on mobile overlay.
- Transition: `transition-all duration-200`, `shadow-2xl` when expanded on mobile.
- Main area uses `contain: layout` for scroll performance.

#### Sidebar (user-sidebar.svelte)

**Navigation items** — each has outline/filled icon pair (`@mdi/js` icons), filled when active:

| Item | Icon (outline → filled) | Section |
|------|------------------------|---------|
| Photos | mdiImageMultipleOutline → mdiImageMultiple | Primary |
| Explore | mdiMagnify | Primary |
| Map | mdiMapOutline → mdiMap | Primary |
| People | mdiAccountOutline → mdiAccount | Primary |
| Sharing | mdiAccountMultipleOutline → mdiAccountMultiple | Primary |
| **Favorites** | mdiHeartOutline → mdiHeart | Library |
| **Albums** | mdiImageAlbum (+ expandable recent albums sub-list) | Library |
| Tags | mdiTagOutline → mdiTag | Library |
| Folders | mdiFolderOutline → mdiFolder | Library |
| Utilities | mdiToolboxOutline → mdiToolbox | — |
| Archive | mdiArchiveArrowDownOutline | — |
| Locked Folder | mdiLockOutline → mdiLock | — |
| **Trash** | mdiTrashCanOutline → mdiTrashCan | — |

**Key patterns:**
- "Library" section group with header label.
- Albums item has an expandable `RecentAlbums` child list (most recently created/edited albums shown inline).
- `BottomInfo` component at sidebar bottom (version, storage).
- Active item: filled icon + highlighted background.

#### Navigation Bar (navigation-bar.svelte)

```
[≡ hamburger] [Logo] [────── SearchBar ──────] [Upload] [Theme] [🔔 Notifications] [Cast] [Avatar]
```

- Hamburger button is `sidebar:hidden` (only shows on mobile).
- Logo: full text on desktop, icon-only on mobile.
- SearchBar: hidden on mobile, replaced by search icon linking to `/search`.
- Upload: text label on `lg`, icon-only smaller.
- **ThemeButton**: toggles light/dark.
- Notifications: bell icon with badge count.
- Responsive grid: `grid-cols-[32px_auto] sidebar:grid-cols-[64px_auto]` (sidebar-area reserved).

#### Timeline (Timeline.svelte, AssetLayout.svelte)

**Virtual scrolling** with absolute positioning (NOT DOM flow):

```
MonthGroup {
  title: "June 2025"
  DayGroup[] {
    title: "Wednesday, June 18"
    assets: Thumbnail[]
  }
}
```

- Each month group: `contain: layout size paint`.
- Tiles positioned via `style:top`, `style:left`, `style:width`, `style:height` (computed geometry).
- `filterIntersecting` for visibility culling — only renders tiles in/near viewport.
- `Skeleton` placeholders for unloaded months.
- Row heights: 100 px mobile, 235 px desktop.
- Header heights: 32 px mobile, 48 px desktop.
- `user-select: none` on grid (prevents text selection during multi-select drag).

**Scrubber (Scrubber.svelte):**
- Right-side vertical bar showing month labels.
- Click/drag to jump to any month instantly.
- Like a timeline elevator — very useful for large collections.

**Selection:**
- Shift-click range select across month boundaries.
- Day-group header checkbox selects entire day.
- `animate:flip` on tiles for smooth reorder on selection changes.
- `out:scale` transition on tile removal.

#### Asset Viewer (asset-viewer-nav-bar.svelte)

Full viewer toolbar on hover (fades in from `from-black/40` gradient):

```
[← Back/Close]                                    [Cast] [Share] [Offline]
[PlayMotion] [ZoomIn] [ZoomOut] [Copy] [Download] [Info] [♡ Favorite] [⭐ Rate] [Edit] [🗑 Delete]
```

**Overflow "More" menu** (three-dot icon):
- Slideshow
- Download / Download Original
- Restore (if trashed)
- Add to Album
- Stack / Unstack operations
- Set as Album Cover
- Set as Profile Picture
- Archive
- Replace with Upload
- View in Timeline
- View Similar Photos
- Set Visibility
- Play Original Video
- Admin: Refresh Faces / Metadata / Thumbnail / Transcode job

**Key pattern:** Delete has "undo" (toast with undo button). Very few are relevant for our use case — we mainly need: Back, Download, Info, Favorite, Delete.

#### Detail Panel (detail-panel.svelte)

Right-side sliding drawer with rich metadata:

```
┌─ Info ─────────────── [×] ─┐
│                             │
│  📝 Description (editable)  │
│  ⭐ Star Rating              │
│                             │
│  👤 People                   │
│   [face1] [face2] [+Add]   │
│                             │
│  📅 Details                  │
│   Wed, Jun 18, 2025 4:32 PM│
│   UTC+02:00 (editable)     │
│                             │
│  🖼️ IMG_4521.jpg             │
│   /path/to/original (toggle)│
│   4032 × 3024 · 12 MP      │
│   3.2 MB                   │
│                             │
│  📷 Camera                   │
│   Apple iPhone 15 Pro       │
│   1/120s · ISO 50           │
│                             │
│  🔭 Lens                     │
│   iPhone 15 Pro (6.86mm)    │
│   f/1.78 · 6.86mm          │
│                             │
│  📍 Location                 │
│   [=== Map ===]             │
│   View on OpenStreetMap →   │
│                             │
│  📁 Albums                   │
│   [Vacation] [Family]       │
│                             │
│  🏷️ Tags                     │
│   [landscape] [sunset]      │
└─────────────────────────────┘
```

**Ente (FileInfo.tsx)** has a nearly identical layout but uses Material UI's `SidebarDrawer` anchor="right". Sections:
- Caption (editable text field with save/cancel)
- CreationTime (CalendarTodayIcon, editable via date-time picker)
- FileName (PhotoOutlined/VideocamOutlined icon, with megapixels, resolution, file size)
- Camera (CameraOutlinedIcon: make + model, fNumber, exposureTime, ISO)
- Location (LocationOnOutlinedIcon: map toggle, OpenStreetMap link, edit location)
- Raw EXIF viewer (secondary drawer, shows all EXIF tags)
- People (FaceRetouchingNaturalIcon: face thumbnails, add person)
- Albums (FolderOutlinedIcon: chip buttons per album)

**Applicable to our project:**
- We have EXIF data from `exifr` already (used in date repair).
- We can show: date, filename, path (S3 key), dimensions, file size, camera make/model, exposure, ISO, f-number.
- Albums: show as clickable chips.
- Skip: People/faces, location/map, star rating (out of scope).
- Description: could be stored in album metadata JSON (stretch goal).

### Summary: What to Adopt

| Pattern | Source | Priority | Notes |
|---------|--------|----------|-------|
| 256 px sidebar, collapsible on mobile | Immich | **Phase 1** | w-64, transition-all, clickOutside |
| Outline/filled icon pairs for nav | Immich | **Phase 1** | Active item = filled icon |
| "Library" section group in sidebar | Immich | **Phase 1** | Groups Albums, Favorites, etc. |
| Expandable recent albums in sidebar | Immich | **Phase 7** | Show last 5 albums inline |
| Theme toggle button in nav bar | Immich | **Phase 2** | Light/dark toggle |
| Scrubber (right-side month elevator) | Immich | **Phase 3** | Fast navigation for large collections |
| Virtual/absolute tile positioning | Immich | Skip | Too complex for our inline SPA; keep CSS grid |
| Shift-click range select | Immich | **Phase 6** | Range selection across sections |
| Day-group header checkbox | Immich | Already done | Section-select checkbox |
| Rich detail panel (EXIF, camera, lens) | Immich+Ente | **Phase 5** | We have exifr data already |
| Viewer: Info/Favorite/Delete toolbar | Immich | **Phase 5** | Gradient overlay toolbar |
| Viewer: Delete with undo toast | Immich | **Phase 5** | Toast with undo action |
| Search bar center of nav bar | Immich+Google | **Phase 4** | Hidden on mobile, icon fallback |
| Hamburger sidebar toggle on mobile | Immich | **Phase 1** | sidebar:hidden on desktop |
| Skeleton placeholders for loading | Immich | **Phase 3** | Show grey rectangles while loading |
| `user-select: none` on grid | Immich | **Phase 3** | Prevent text selection during multi-select |
| Caption/description on media | Ente | Stretch | Would need metadata storage |
| Raw EXIF viewer drawer | Ente | **Phase 5** | Show all EXIF tags in secondary panel |

---

## 3. Proposed Changes — Organized by Priority

### Phase 1: Layout Overhaul (Sidebar + Header)  ⭐ High Impact

**Goal:** Replace horizontal tab bar with a Google Photos-style left sidebar; redesign the top bar.

#### 3.1 Sidebar Navigation

Replace the `.tab-bar` with a persistent 256 px left sidebar (matching Immich's `w-64`):

```
┌─────────────────────┐
│  📷 MediaTransfer    │  ← branding/logo
├─────────────────────┤
│  ● Photos           │  ← filled icon when active (mdiImageMultiple)
│  ○ Explore/Search   │  ← mdiMagnify  (stretch)
├─────────────────────┤
│  Library             │  ← section header (like Immich)
│  ○ Favorites  ♡     │  ← mdiHeartOutline → mdiHeart (Phase 8)
│  ○ Albums    🖼️     │  ← mdiImageAlbum (expandable recent albums)
├─────────────────────┤
│  Tools               │  ← section header
│  ○ Date Repair  🔧  │  ← was tab, now sidebar item
│  ○ Trash  🗑        │  ← mdiTrashCanOutline (future)
├─────────────────────┤
│  12,345 items · 42.3 GB │  ← BottomInfo (like Immich)
└─────────────────────┘
```

**Implementation notes (informed by Immich user-sidebar.svelte):**

- **Layout**: CSS grid `grid-template-columns: 256px 1fr` (like Immich's `grid-cols-[--spacing(64)_auto]`). Sidebar is `height:100vh; overflow-y:auto; display:flex; flex-direction:column`.
- **Width**: 256 px on desktop, 0 px on mobile — matching Immich's `w-64` / `w-0` transition.
- **Each sidebar item**: 44 px height, icon (24×24 SVG) + label, `border-radius:9999px` pill shape on hover/active.
- **Active state**: Filled (not outline) icon + tinted background (`var(--accent)` at 12% opacity). Immich uses outline/filled icon pairs from `@mdi/js`. We'll use inline SVGs with two paths per item (outline default, filled active).
- **Section groups**: "Library" and "Tools" headers — small uppercase label (like Immich's section dividers).
- **Expandable albums**: Under the "Albums" item, a chevron toggles a scrollable sub-list of recent albums (max 5). Inspired by Immich's `RecentAlbums` component.
- **Mobile behavior**: `transition: all 200ms ease` (Immich uses `duration-200`). On mobile (< 768 px), sidebar overlaps content with `position:fixed; z-index:100; box-shadow:0 25px 50px -12px rgba(0,0,0,.25)` (Immich's `shadow-2xl`). Hamburger button in nav bar toggles `sidebarOpen` state. Uses click-outside to close.
- **Bottom info**: Item count + storage at sidebar bottom, like Immich's `BottomInfo` component.

#### 3.2 Redesigned Top Bar (Navigation Bar)

Inspired by Immich's `navigation-bar.svelte`:

```
┌──────────────────────────────────────────────────────────────────────┐
│  [≡]   [🔍 Search your photos…                        ×]   [☀/🌙] ⚙  │
└──────────────────────────────────────────────────────────────────────┘
```

- **Hamburger** (≡): Only visible on mobile (`sidebar:hidden` in Immich). Toggles sidebar overlay.
- **Search bar**: Pill-shaped, centered (`flex:1; max-width:720px; margin:0 auto`). On mobile: collapses to magnifying-glass icon that links to a search view. Replaces both `#prefix` input and media-type dropdown.
- **Theme toggle** (☀/🌙): Like Immich's `ThemeButton`. Toggles light/dark with single click.
- **Settings gear** (⚙): Opens a dropdown with: Sort order, Media type filter, Grid size, Reload.
- Responsive grid: Match sidebar width in nav bar — left area is 256 px on desktop (mirrors sidebar below), main area stretches.
- Remove: sort dropdown, media-type dropdown, reload button from the top bar (move to settings menu).

#### 3.3 CSS Layout Changes

```css
/* Old: */
.topbar { position:sticky; top:0; ... }
.tab-bar { display:flex; ... }

/* New: */
.app { display:flex; height:100vh; }
.sidebar { flex:0 0 240px; display:flex; flex-direction:column; ... }
.sidebar.collapsed { flex:0 0 56px; }
.main { flex:1; display:flex; flex-direction:column; overflow:hidden; }
.topbar { ... } /* stays in .main */
.scroll-area { flex:1; overflow-y:auto; }
```

---

### Phase 2: Visual Polish & Theming  ⭐ High Impact

#### 4.1 Light + Dark Theme

Add a light theme via CSS custom properties. Toggle stored in `localStorage`.

```css
:root, [data-theme="dark"] {
  --bg: #0f1115; --surface: #141923; --surface2: #1a2030;
  --border: #252b39; --text: #e8ecf3; --text-dim: #9aa6bf;
  --accent: #4d8bff; ...
}

[data-theme="light"] {
  --bg: #ffffff; --surface: #f8f9fa; --surface2: #f1f3f4;
  --border: #dadce0; --text: #202124; --text-dim: #5f6368;
  --accent: #1a73e8; --accent-light: #4285f4;
  --danger: #d93025; --success: #1e8e3e; --warning: #f9ab00;
  --check-bg: #1a73e8; --select-ring: #1a73e855;
  --tile-radius: 4px;
}
```

**Toggle mechanism:** Icon button in settings menu or sidebar footer. On toggle: `document.documentElement.dataset.theme = theme; localStorage.setItem('catalogTheme', theme);`.

#### 4.2 Typography

- Use `'Google Sans Text', 'Google Sans', system-ui, -apple-system, sans-serif` (already partially there).
- Section headers: 14 px, font-weight 500, letter-spacing 0.1 px.
- Sidebar labels: 14 px, font-weight 400 (500 when active).
- Subtle size hierarchy: branding 20 px, toolbar 14 px, badges 11 px.

#### 4.3 Ripple Effect on Buttons

Google Photos uses Material Design ripple on all click targets. Add a lightweight CSS-only version:

```css
.icon-btn { position:relative; overflow:hidden; }
.icon-btn::after {
  content:''; position:absolute; inset:0;
  background: radial-gradient(circle, var(--text) 10%, transparent 10.01%) no-repeat 50%;
  transform: scale(10); opacity:0;
  transition: transform .5s, opacity 1s;
}
.icon-btn:active::after { transform:scale(0); opacity:.12; transition:0s; }
```

#### 4.4 Icon Buttons

Standardize all icon buttons to 40×40 with 24×24 SVG. Circular hover background (8% text color). Tooltip on hover via CSS `::after` with `content:attr(data-tooltip)`.

```css
.icon-btn {
  width:40px; height:40px; border-radius:50%;
  display:inline-flex; align-items:center; justify-content:center;
  border:none; background:transparent; cursor:pointer; color:var(--text-dim);
  transition: background .15s;
}
.icon-btn:hover { background: var(--text-dim)14; }  /* 8% opacity */
.icon-btn svg { width:24px; height:24px; fill:currentColor; }
```

---

### Phase 3: Enhanced Photo Grid  — Medium Impact

#### 5.1 Improved Tile Layout

Keep CSS grid (Immich's absolute-positioned virtual scrolling is too complex for our inline SPA).

- **Larger default tile size**: `minmax(180px, 1fr)` instead of 140 px. Desktop row height target ~200 px (Immich uses 235 px desktop, 100 px mobile).
- **object-fit: cover** with slight padding-bottom to show more of portrait photos.
- **Rounded corners**: 8 px radius.
- **Hover effect**: Scale 1.02 + subtle shadow + check-circle fade-in at 100% opacity.
- **Smooth image load**: Fade-in on `load` event via opacity transition.
- **`user-select: none`** on grid container (Immich pattern — prevents text selection during multi-select drag).

```css
.tile img, .tile video {
  opacity:0; transition: opacity .3s ease;
}
.tile img.loaded, .tile video.loaded { opacity:1; }
.grid { user-select: none; }
```

Add `media.onload = () => media.classList.add('loaded');` in `renderItem`.

#### 5.2 Section Headers (Google Photos style)

Current: Small sticky headers with date + count.
Proposed: Larger, bolder headers matching Google Photos / Immich:

- Immich uses 48 px header height on desktop, 32 px on mobile.
- Section-select check button appears on hover of the header (like Google — already done).
- Date labels use human-friendly formatting: "Today", "Yesterday", "Monday, Jun 16", "Jun 12, 2025", "Dec 2024".

```css
.section-header {
  padding: 24px 0 8px;
  font-size: 15px;
  font-weight: 500;
  color: var(--text);
  display:flex; align-items:center; gap:12px;
  height: 48px;
}
@media (max-width: 768px) { .section-header { height: 32px; font-size: 13px; } }
```

#### 5.3 Skeleton Placeholders (from Immich)

While tiles are lazy-loading, show grey rectangles instead of blank space:

```css
.tile.skeleton {
  background: var(--surface2);
  animation: skeleton-pulse 1.5s ease-in-out infinite;
}
@keyframes skeleton-pulse {
  0%, 100% { opacity: 0.6; }
  50% { opacity: 1; }
}
```

Immich uses `Skeleton` components for months not yet loaded. We can apply this per-tile:
- Render tiles with `.skeleton` class initially.
- When IntersectionObserver triggers and image loads, remove skeleton + fade in.

#### 5.4 Month Scrubber (from Immich — stretch)

A right-side vertical bar showing month labels for fast chronological navigation:

```
┌──────────────────────────────────┐ ┌─────┐
│  grid content                    │ │ Jun │
│                                  │ │ May │ ← click/drag to jump
│                                  │ │ Apr │
│                                  │ │ Mar │
│                                  │ │ ... │
└──────────────────────────────────┘ └─────┘
```

Immich's `Scrubber.svelte` shows abbreviated month labels; clicking/dragging jumps scroll position immediately. Very valuable for collections with years of photos. Stretch goal — implement after core grid is solid.

#### 5.5 Empty State

When no items match a search or filter, show a centered illustration + message:

```html
<div class="empty-state">
  <svg ...> <!-- camera/photo icon --> </svg>
  <h3>No photos found</h3>
  <p>Try a different search or filter</p>
</div>
```

---

### Phase 4: Enhanced Search  — Medium Impact

#### 6.1 Client-Side Search

Replace prefix filter input with a proper search bar that filters by:
- **Filename**: substring match
- **Date**: "2024", "january", "jan 2023"
- **Album name**: matches items belonging to matching albums

Implementation:
```javascript
function searchItems(query) {
  const q = query.toLowerCase().trim();
  if (!q) return allItems;
  return allItems.filter(item => {
    // Match filename
    if (item.key.toLowerCase().includes(q)) return true;
    // Match date
    if (item.sectionDate && item.sectionDate.includes(q)) return true;
    if (item.capturedAt && item.capturedAt.includes(q)) return true;
    // Match album
    if (albumsForItem(item.encodedKey).some(a => a.name.toLowerCase().includes(q))) return true;
    return false;
  });
}
```

The search bar replaces both `#prefix` and `#mediaType` filter. Media-type filter moves to a chip/pill below the search bar or to the settings menu.

#### 6.2 Search UI

- Pill-shaped input in the top bar center.
- Magnifying glass icon on the left (decorative).
- Clear (×) button on the right when input is non-empty.
- Debounce input events by 200 ms before filtering.
- Show result count below search bar: "Showing 43 of 2,372 items".

---

### Phase 5: Enhanced Viewer/Lightbox  — Medium Impact

#### 7.1 Full-Screen Viewer

Replace the current modal with a true full-screen viewer. Inspired by Immich's `asset-viewer-nav-bar.svelte`:

```
┌──────────────────────────────────────────────────────────────┐
│  [←]   filename.jpg                    [♡] [🗑] [⬇] [ⓘ] [×] │  ← gradient overlay (from-black/40)
├──────────────────────────────────────────────────────────────┤
│                                                              │
│                                                              │
│         ◄          [  centered photo  ]          ►           │
│                                                              │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

**Toolbar** (fades in on hover, Immich-style gradient overlay):
- **Back** (←): Close viewer, return to grid.
- **Filename**: Displayed in center of toolbar.
- **Download** (⬇): Download original.
- **Info** (ⓘ): Toggles right-side detail panel (see §7.3).
- **Favorite** (♡): Star/unstar (Phase 8). 
- **Delete** (🗑): Delete with undo toast (Immich pattern — 5-second undo window).
- **Close** (×): Same as Back.

**Changes from current:**
- Full `position:fixed; inset:0` background, solid black (not semi-transparent).
- **Zoom**: Double-click or mouse wheel to zoom. CSS `transform:scale()` + `transform-origin`. Pan when zoomed.
- **Swipe support** on touch devices for prev/next.
- **Smooth transition** when opening: animate from tile position to center.
- Toolbar auto-hides after 3 seconds of no mouse activity (like Immich).

#### 7.2 Viewer Keyboard Shortcuts

| Key | Action |
|-----|--------|
| ← / → | Previous / Next |
| Escape | Close viewer |
| I | Toggle info panel |
| Delete | Delete current item |
| D | Download current item |
| F | Toggle favorite (future) |
| + / - | Zoom in/out |
| 0 | Reset zoom |

#### 7.3 Detail Panel (from Immich + Ente)

Right-side sliding drawer (like Immich's `detail-panel.svelte` and Ente's `FileInfo.tsx`):

```
┌─ Info ─────────────── [×] ─┐
│                             │
│  📅 Date                     │
│   Wed, Jun 18, 2025 4:32 PM│
│   (captured date)           │
│                             │
│  🖼️ File                     │
│   IMG_4521.jpg              │
│   s3://2025/06/18/album/... │
│   4032 × 3024 · 12 MP      │
│   3.2 MB                   │
│                             │
│  📷 Camera (if EXIF avail)   │
│   Apple iPhone 15 Pro       │
│   1/120s · ISO 50           │
│                             │
│  🔭 Lens (if EXIF avail)     │
│   f/1.78 · 6.86mm          │
│                             │
│  📁 Albums                   │
│   [Vacation] [Family]       │
│                             │
│  🏷️ Raw EXIF (expand)        │
│   ► View all EXIF data      │
└─────────────────────────────┘
```

**Implementation (inspired by Ente's `InfoItem` pattern):**

Each metadata row uses a consistent `InfoItem` component: icon (left, 48×48 container) + title + caption text:
```html
<div class="info-item">
  <div class="info-icon"><svg>...</svg></div>
  <div class="info-content">
    <div class="info-title">Wed, Jun 18, 2025 4:32 PM</div>
    <div class="info-caption">Captured date</div>
  </div>
</div>
```

**Data sources we already have:**
- Filename, S3 key, last modified: from catalog list page response.
- Dimensions: from `img.naturalWidth` / `img.naturalHeight` after load.
- File size: from S3 `ContentLength` header (add to API response, or HEAD request).
- EXIF (camera, lens, exposure, ISO, f-number): from `exifr` — we already parse EXIF for date repair. Fetch via new API endpoint `/catalog/api/exif/:key` that reads S3 object + runs exifr.
- Album memberships: from existing album data.

**Raw EXIF sub-panel (from Ente):**
Ente shows a secondary drawer with all EXIF tags in namespace:tagName format. We'll show an expandable section at the bottom that JSON-dumps all exifr output — very useful for debugging and power users.

**New API endpoint needed:**
```
GET /catalog/api/exif/:key → { exif: { Make, Model, ExposureTime, ISO, FNumber, FocalLength, ... }, dimensions: { width, height }, fileSize: number }
```

---

### Phase 6: Selection Improvements  — Lower Priority

#### 8.1 Selection Toolbar (Google Photos / Immich style)

When items are selected, the top bar transforms:

```
┌──────────────────────────────────────────────────────────────┐
│  [×]  3 selected                    [♡] [+album] [🗑] [⬇] [•••] │
└──────────────────────────────────────────────────────────────┘
```

- **×** button to clear selection (or Escape).
- Count updates in real-time.
- Actions as icon buttons with tooltips.
- Overflow (•••) menu for less-common actions: "Date Repair", "Move to…".
- This is similar to existing behavior but with cleaner icon-button styling.

#### 8.2 Shift-Click Range Select (from Immich)

Immich's Timeline.svelte implements shift-click range selection across month group boundaries. Our implementation:

- Track `lastSelectedIndex` (index in the current visible items array).
- On shift+click: find indices of last-selected and clicked items, select all items in that range (inclusive).
- Works across section headers — iterate through flattened visible items array.
- On mobile: long-press (500 ms) enters selection mode.

#### 8.3 Delete with Undo Toast (from Immich)

Instead of confirm dialog, show a toast with undo button for 5 seconds. Immich does this for delete. If user doesn't undo, delete executes. More Google Photos–like workflow.

---

### Phase 7: Albums Enhancement  — Lower Priority

#### 9.1 Albums as Sidebar Sub-Items (Immich pattern)

Immich's sidebar shows Albums with an expandable `RecentAlbums` sub-list. We'll adopt this:

```
▾ Albums  (5)        ← click chevron to expand/collapse
    Vacation 2024    ← click to filter grid to album
    Family
    Screenshots
    Landscapes
    + Create album   ← inline quick-create
```

**Implementation:**
- Under the "Albums" sidebar item, show a chevron (▾ / ▸) that expands/collapses a sub-list.
- Show up to 5 most recently edited albums.
- Each album name is a clickable link that filters the grid.
- "+ Create album" link at bottom of sub-list.
- Album count badge next to "Albums" label.

#### 9.2 Album Detail View

When viewing an album:
- Top bar shows album name + back arrow.
- Grid shows only album items.
- "Add photos" button in toolbar.
- Cover image thumbnail in sidebar next to album name (stretch goal).
- Album chips in the detail panel (Phase 5) are clickable — clicking navigates to that album.

---

### Phase 8: Favorites System  — Future / Stretch

#### 10.1 Favorites Concept

- Star/heart icon on each tile (appears on hover, like check circle).
- Favorites stored in the albums manifest JSON under a special `__favorites__` key.
- "Favorites" sidebar item shows all starred items.
- Toggle via viewer (♡ button) or from grid hover.

*Not in the initial implementation. Listed here for planning.*

---

### Phase 9: Settings & Preferences  — Lower Priority  

#### 11.1 Settings Dropdown

Accessible via ⚙ icon in top bar. Contains:

| Setting | Options |
|---------|---------|
| Sort order | Date (newest), Date (oldest), Name (A→Z), Name (Z→A), Size |
| Grid size | Small / Medium / Large (changes minmax) |
| Theme | Light / Dark / System |
| Show problematic items | On / Off |

All settings persisted in `localStorage`.

---

## 4. Implementation Order & Verification Gates

Each step must pass **all verification checks** before proceeding to the next. This ensures incremental stability and prevents regressions.

### Baseline Verification (run before starting)

```bash
npx vitest run                 # All 311 tests pass
npx tsc --noEmit               # Zero type errors
curl http://localhost:3000/catalog  # HTML served, page loads
```

---

### Step 1 — Phase 1.1: Sidebar nav (256 px, collapsible, section groups)

**Files:** catalog.ts (CSS + HTML + JS) | **Effort:** Large

**Verification checklist:**
- [ ] `npx vitest run` — all 311 tests pass (HTML output tests still match `text/html`)
- [ ] `npx tsc --noEmit` — zero type errors
- [ ] **Manual: desktop** — sidebar renders at 256 px with Photos, Albums, Date Repair items + section groups
- [ ] **Manual: click** — clicking sidebar items switches content view (no broken tab references)
- [ ] **Manual: active state** — active item shows filled icon + tinted background
- [ ] **Manual: stats** — bottom of sidebar shows item count + storage
- [ ] **Manual: mobile** — at < 768 px viewport, sidebar is hidden; hamburger visible
- [ ] **Smoke test:** existing functionality (grid loads, tiles render, images lazy-load) works unchanged

---

### Step 2 — Phase 1.2: Redesigned top bar + search + hamburger

**Files:** catalog.ts | **Effort:** Medium

**Verification checklist:**
- [ ] `npx vitest run` — all 311 tests pass
- [ ] `npx tsc --noEmit` — zero type errors
- [ ] **Manual: top bar** — pill-shaped search input centered, theme toggle + settings gear visible
- [ ] **Manual: search** — typing a query filters items by filename/date (replaces old prefix input)
- [ ] **Manual: clear** — × button clears search and restores all items
- [ ] **Manual: hamburger** — at < 768 px, hamburger toggles sidebar overlay
- [ ] **Manual: old controls removed** — no more sort/mediaType dropdowns in top bar (moved to settings)
- [ ] **Regression:** all items load correctly, pagination (loadMore) still fires on scroll

---

### Step 3 — Phase 2.1: Light/dark theme + theme toggle

**Files:** catalog.ts (CSS only) | **Effort:** Small

**Verification checklist:**
- [ ] `npx vitest run` — all 311 tests pass
- [ ] `npx tsc --noEmit` — zero type errors
- [ ] **Manual: dark** — default theme looks identical to current dark theme
- [ ] **Manual: light** — clicking theme toggle switches to light; all text readable, borders visible
- [ ] **Manual: toggle persistence** — refresh page → theme persists from `localStorage`
- [ ] **Manual: both themes** — check tiles, sidebar, topbar, modals, dialogs, toasts, selection toolbar in both themes
- [ ] **Regression:** selection toolbar colors, danger/success status badges still contrast correctly

---

### Step 4 — Phase 2.3–2.4: Ripple + icon button styling

**Files:** catalog.ts (CSS) | **Effort:** Small

**Verification checklist:**
- [ ] `npx vitest run` — all 311 tests pass
- [ ] `npx tsc --noEmit` — zero type errors
- [ ] **Manual: styling** — all icon buttons are 40×40, circular hover background, consistent look
- [ ] **Manual: ripple** — clicking any icon button shows brief radial ripple animation
- [ ] **Manual: tooltips** — hovering icon buttons shows tooltip label
- [ ] **Manual: both themes** — ripple and hover states work in light and dark
- [ ] **Regression:** button click handlers still fire correctly (delete, download, etc.)

---

### Step 5 — Phase 3.1–3.3: Grid improvements + skeleton loading

**Files:** catalog.ts | **Effort:** Small-Medium

**Verification checklist:**
- [ ] `npx vitest run` — all 311 tests pass
- [ ] `npx tsc --noEmit` — zero type errors
- [ ] **Manual: tile size** — tiles are larger (≥ 180 px minmax), rounded corners (8 px)
- [ ] **Manual: skeleton** — on first load, grey pulsing rectangles visible before images load
- [ ] **Manual: fade-in** — images fade in smoothly when loaded (no pop-in)
- [ ] **Manual: hover** — tiles scale up slightly on hover, check circle appears
- [ ] **Manual: sections** — section headers are 48 px, bold, human-friendly dates ("Today", "Yesterday")
- [ ] **Manual: `user-select: none`** — text in grid area not selectable (no accidental text selection during multi-select)
- [ ] **Manual: empty state** — searching for nonexistent term shows empty state illustration
- [ ] **Regression:** lazy loading still works (scroll down fast, images load progressively)

---

### Step 6 — Phase 3.4: Month scrubber (stretch)

**Files:** catalog.ts | **Effort:** Medium

**Verification checklist:**
- [ ] `npx vitest run` — all 311 tests pass
- [ ] `npx tsc --noEmit` — zero type errors
- [ ] **Manual: scrubber visible** — right-side vertical bar with month labels appears
- [ ] **Manual: click** — clicking a month label scrolls grid to that month's section
- [ ] **Manual: drag** — dragging along scrubber scrubs through months
- [ ] **Manual: sync** — scrolling the grid updates the scrubber highlight position
- [ ] **Manual: mobile** — scrubber is hidden or minimal on narrow viewports
- [ ] **Regression:** scroll-based lazy loading not broken by scrubber scroll events

---

### Step 7 — Phase 4: Enhanced search

**Files:** catalog.ts (JS) | **Effort:** Medium

**Verification checklist:**
- [ ] `npx vitest run` — all 311 tests pass
- [ ] `npx tsc --noEmit` — zero type errors
- [ ] **Manual: filename search** — searching "IMG_2024" finds matching filenames
- [ ] **Manual: date search** — searching "2024" or "january" or "jan 2023" finds matching dates
- [ ] **Manual: album search** — searching an album name shows items belonging to that album
- [ ] **Manual: debounce** — typing rapidly doesn't cause jank (200 ms debounce)
- [ ] **Manual: result count** — "Showing X of Y items" label displays during search
- [ ] **Manual: clear** — clearing search restores full item list with correct sort order
- [ ] **Regression:** sort order still works after clearing search; section headers still correct

---

### Step 8 — Phase 5.1–5.2: Enhanced viewer + toolbar

**Files:** catalog.ts | **Effort:** Medium

**Verification checklist:**
- [ ] `npx vitest run` — all 311 tests pass
- [ ] `npx tsc --noEmit` — zero type errors
- [ ] **Manual: open** — clicking a tile opens full-screen viewer with solid black background
- [ ] **Manual: toolbar** — gradient overlay toolbar appears on hover with Back, Download, Info, Delete buttons
- [ ] **Manual: auto-hide** — toolbar hides after 3 seconds of no mouse movement
- [ ] **Manual: navigate** — ← / → arrows and keyboard work for prev/next
- [ ] **Manual: zoom** — mouse wheel zooms in/out; double-click zooms; pan when zoomed
- [ ] **Manual: keyboard** — all shortcuts from §7.2 work (I, D, Delete, Escape, +, -, 0)
- [ ] **Manual: delete** — deleting from viewer shows undo toast, navigates to next item
- [ ] **Regression:** viewer still opens/closes from selection; Escape still deselects if no viewer open

---

### Step 9 — Phase 5.3: Detail panel with EXIF

**Files:** catalog.ts + new API endpoint in catalog routes | **Effort:** Medium-Large

**Verification checklist:**
- [ ] `npx vitest run` — all tests pass (including NEW tests for EXIF endpoint)
- [ ] `npx tsc --noEmit` — zero type errors
- [ ] **New test:** `GET /catalog/api/exif/:key` returns date, dimensions, file size, EXIF camera data
- [ ] **New test:** EXIF endpoint returns gracefully when EXIF is unavailable (e.g., video or no EXIF)
- [ ] **New test:** EXIF endpoint errors on invalid encoded key
- [ ] **Manual: info panel** — pressing I in viewer opens right-side sliding panel
- [ ] **Manual: metadata** — panel shows date, filename, S3 key, dimensions, file size
- [ ] **Manual: EXIF** — camera make/model, exposure, ISO, f-number shown when available
- [ ] **Manual: albums** — albums shown as clickable chips
- [ ] **Manual: raw EXIF** — expandable section shows full EXIF dump
- [ ] **Manual: close** — clicking × or pressing I again closes panel
- [ ] **Regression:** viewer navigation (prev/next) still works with panel open

---

### Step 10 — Phase 6: Selection improvements (shift-select, undo delete)

**Files:** catalog.ts (JS) | **Effort:** Small-Medium

**Verification checklist:**
- [ ] `npx vitest run` — all tests pass
- [ ] `npx tsc --noEmit` — zero type errors
- [ ] **Manual: shift-click** — hold Shift + click two non-adjacent tiles → all tiles in range selected
- [ ] **Manual: cross-section** — shift-click works across different date section boundaries
- [ ] **Manual: undo delete** — deleting selection shows toast with "Undo" button for 5 seconds
- [ ] **Manual: undo works** — clicking "Undo" within 5 seconds restores items
- [ ] **Manual: undo expires** — waiting 5 seconds confirms deletion (no undo)
- [ ] **Manual: selection toolbar** — icon button styling consistent with Phase 4 ripple/hover
- [ ] **Regression:** Ctrl+A still selects all; section-select checkbox still works; Escape clears selection

---

### Step 11 — Phase 7: Albums in sidebar with expandable list

**Files:** catalog.ts | **Effort:** Medium

**Verification checklist:**
- [ ] `npx vitest run` — all tests pass
- [ ] `npx tsc --noEmit` — zero type errors
- [ ] **Manual: sidebar** — Albums item in sidebar has chevron; clicking expands sub-list of albums
- [ ] **Manual: album count** — badge shows number of albums
- [ ] **Manual: album click** — clicking album name filters grid to that album's items
- [ ] **Manual: create** — "+ Create album" link in sub-list works
- [ ] **Manual: collapse** — chevron toggles sub-list open/closed
- [ ] **Manual: album view** — viewing an album shows back arrow + album name in top bar
- [ ] **Regression:** all existing album CRUD (create, delete, add items, view) still works; album side panel still functions

---

### Step 12 — Phase 9: Settings dropdown

**Files:** catalog.ts | **Effort:** Small

**Verification checklist:**
- [ ] `npx vitest run` — all tests pass
- [ ] `npx tsc --noEmit` — zero type errors
- [ ] **Manual: gear icon** — clicking ⚙ opens dropdown menu
- [ ] **Manual: sort** — sort order options work: Date newest/oldest, Name A-Z/Z-A, Size
- [ ] **Manual: grid size** — Small/Medium/Large changes tile minmax dimension
- [ ] **Manual: media filter** — media type filter (All/Photos/Videos) works
- [ ] **Manual: persistence** — all settings persist across page reload via `localStorage`
- [ ] **Manual: close** — clicking outside dropdown closes it
- [ ] **Regression:** sort affects both normal view and album view; filter + search compose correctly

---

### Final Verification (after all steps complete)

```bash
npx vitest run                 # All tests pass (311 original + new EXIF tests)
npx tsc --noEmit               # Zero type errors
```

**Full manual regression:**
- [ ] Page loads in < 2 seconds
- [ ] All sidebar nav items work (Photos, Albums, Date Repair)
- [ ] Light and dark themes both fully functional
- [ ] Search filters by filename, date, album
- [ ] Grid renders correctly with skeleton → fade-in
- [ ] Selection: click, Ctrl+A, shift-click, section-select, Escape to deselect
- [ ] Viewer: open, navigate, zoom, info panel, download, delete with undo
- [ ] Albums: create, view, add items, delete, sidebar nav
- [ ] Date Repair: scan, review, apply repairs
- [ ] Settings: sort, grid size, media filter all persist
- [ ] Mobile (< 768 px): hamburger toggle, sidebar overlay, touch-friendly targets

## 5. What NOT to Change

- **Backend API routes** — All `/catalog/api/*` endpoints are stable and correct.
- **`scaleway-catalog.ts`** — S3 service layer is solid after the recent listPage fix.
- **Test suite** — 311 tests must continue to pass.
- **`CatalogService` interface** — One new method may be needed for EXIF endpoint (Phase 5.3 only).
- **Inline SPA approach** — Keep everything in `buildCatalogHtml()` for simplicity; no build step needed.
- **Virtual scrolling** — Skip Immich's absolute-positioned layout; too complex for inline SPA. CSS grid is sufficient.

## 6. Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| Huge single file (1531 → ~2500 lines) | Split CSS/JS into tagged template literal functions; consider helper modules for detail panel |
| Search performance with 10k+ items | Debounce + limit display to first 1000 matches; already have chunked rendering |
| Mobile sidebar overlay | Hamburger toggle with overlay + click-outside close (proven pattern from Immich) |
| Light theme contrast | Test all status colors (danger, warning, success) in both themes |
| Zoom implementation complexity | Start with CSS `transform:scale()` + `transform-origin`; skip pinch-zoom initially |
| EXIF endpoint latency | Cache exifr results in-memory (LRU); fetch lazily when info panel opens |
| Detail panel + viewer layout on mobile | Panel overlays full-screen on mobile (like Ente's SidebarDrawer); separate from desktop sliding panel |

## 7. Success Criteria

- [ ] Sidebar navigation (256 px) replaces tabs, with outline/filled icon active states
- [ ] Sidebar has "Library" and "Tools" section groups
- [ ] Sidebar collapses on mobile with hamburger toggle + click-outside close
- [ ] Top bar has centered pill-shaped search input that filters items
- [ ] Both light and dark themes work, toggled from nav bar theme button
- [ ] Icon buttons have consistent 40×40 styling with hover/active states + ripple
- [ ] Photo grid tiles have smooth image fade-in + skeleton placeholders
- [ ] Section headers are 48 px height with hover-reveal section-select
- [ ] Viewer has gradient-overlay toolbar with Back/Download/Info/Delete buttons
- [ ] Viewer has right-side detail panel showing date, file info, dimensions, EXIF camera/lens data
- [ ] Viewer supports keyboard shortcuts (listed in §7.2)
- [ ] Delete shows undo toast instead of confirm dialog
- [ ] Shift-click range select works across section boundaries
- [ ] Settings menu consolidates sort, filter, and grid-size controls
- [ ] Albums appear as expandable sub-list in sidebar
- [ ] All 311 existing tests pass
- [ ] `tsc --noEmit` clean
