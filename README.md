# Glass Slicer — Power BI Custom Visual

A glass-pill slicer with sliding thumb, per-value glow, and animated shimmer. Bind 1–5 fields, each renders its own pill. Cross-filters the report like a native slicer.

![Glass Slicer](assets/icon.png)

<img width="1098" height="139" alt="image" src="https://github.com/user-attachments/assets/e7057172-ab2b-4c94-b9e7-d72c23b5ae93" />
<img width="149" height="920" alt="image" src="https://github.com/user-attachments/assets/f5c475bd-99e2-468e-b245-6487873eb3df" />

## Install

- Download the latest `.pbiviz` from the [releases](https://github.com/daniel-abdel-sater/pbi-toggle-button/blob/main/dist/toggleButtonDA2604241000A1B2.1.0.0.0.pbiviz)
- Power BI Desktop → **Insert** → **More visuals** → **From my files** → select the `.pbiviz`

## Data roles

- **Field** — up to 5 columns. Each column produces its own toggle pill (one button per distinct value)
- **Default Selection (optional)** — one DAX measure per field (same field-well order). Returns `1` for the value that should be the default, `0` otherwise. Always return `0` (never `BLANK()`) for non-default rows or PBI silently drops the cross-product

## Selection behavior

- **Single-select (default)** — click a value to select; click the active value again to clear
- **Multi-select** — click toggles membership in the active set; clicked values stay highlighted; the filter sends an `In` array
- **Force Selection** — disables clearing; clicking the active button is a no-op (guarantees no empty state)
- **Cascade** — when multiple fields are bound, downstream toggles reflect the upstream selection (slicer-style chained filtering)
- Selection persists across page navigation and report reload (saved per field)
- Cross-filters siblings on the page via `applyJsonFilter` — native-slicer behavior, multi-column AND, native-typed values
- Honors **Sync Slicers** across pages
- Right-click → drillthrough on the active selection
- Honors external cross-filters (filter mode + highlight mode); buttons whose values aren't in the filtered context are hidden automatically

## Format pane

Every card below uses an **Apply to** dropdown — set defaults under "All toggles" or override per bound field independently.

### Sizing

- **Size Mode** — `Fit Container` (toggle fills its area, buttons share equally) or `Fixed` (toggle = explicit pixel size)
- **Fixed Size (px)** — toggle height in pixels (default 31). Padding, gap, thumb spread scale with this
- **Equal-Width Buttons** — when ON, every button shares toggle width equally regardless of label length

### Fields Label (per toggle)

- **Show Title** + **Title Text** + **Title Position** (8 positions: top-left/center/right, left, right, bottom-left/center/right)
- **Title Color** + **Title Font Size**

### Capsule (global)

- **Roundness (%)** — 0 = sharp, 100 = full pill
- **Track Padding (px)** — gap between thumb and pill edge
- **Track Top / Bottom / Border α** (×1000) — fine alpha control on the glass surface

### Content (per toggle)

- **Show Symbols** — small mono character before each label (e.g. `$` `D` `M`)
- **Symbol A / B / C** — text per side
- **Symbol Font Size** + **Show Labels** + **Label Font Size**

### Text (per toggle, FX-enabled)

- **Label Color (Active / Inactive)**
- **Symbol Color (Active / Inactive)** + **Inactive Symbol α**
- All four colors expose the FX lightning-bolt → drive per-value colors from DAX

### Thumb (per toggle, FX-enabled)

- **Accent Color** — drives thumb gradient + active symbol + glow ring + bloom (FX)
- **Ring α** + **Bloom α** + **Bloom Spread (px)** + **Inner Highlight α**

### Animation (per toggle, FX-enabled)

- **Transition Duration (ms)** + **Transition Easing** (Smooth / Material / Overshoot / Ease Out / Linear)
- **Track Shimmer** — sweeping highlight band over the toggle (`mix-blend-mode: screen`)
- **Shimmer Mode** — two flavors:
  - **Per Value** — every button shimmers in its OWN FX-resolved color simultaneously
  - **Wave** — ONE band sweeps the full toggle and changes color as it crosses each button (multi-stop gradient + animated CSS mask)
- **Shimmer Color** — tint (FX → per-value DAX colors)
- **Shimmer Duration (ms)** + **Shimmer Transparency (%)**
- Both modes ping-pong (left↔right or top↔bottom)

### Orientation (global)

- **Layout Direction** — Auto / Vertical / Horizontal — how multiple toggles arrange when 2+ fields are bound
- **Vertical Alignment** + **Horizontal Alignment** — `Stretch` (fill) / Top / Center / Bottom / Left / Right — both visible regardless of direction
- **Values Layout** — values inside ONE toggle are arranged horizontally (default) or stacked vertically. Wave shimmer follows the layout (left↔right or top↔bottom); Per-Value shimmer stays horizontal regardless

### Spacing

- **Spacing Between Values (px)** — gap between buttons inside a toggle (per-toggle override)
- **Spacing Between Fields (px)** — gap between toggles when multiple fields are bound (global)

### Selection Mode (per toggle)

- **Force Selection** — see Selection behavior above
- **Multi Select** — see Selection behavior above

## Conditional formatting (FX)

- Lightning-bolt icon on every color in Text, Thumb, and Animation cards
- Bind a DAX measure that returns a hex string per value:
  ```dax
  Color = SWITCH(SELECTEDVALUE('Status'[State]),
      "Active", "#10B981",
      "Inactive", "#EF4444",
      "Maintenance", "#F59E0B",
      "#94A3B8")
  ```
- Per-toggle slot variants — set different rules for each bound field independently
- Wave shimmer reads the same FX rule and slices the gradient per-button

## Scrolling & overflow

- When buttons overflow the toggle (Fixed mode + many values + small container), the track scrolls horizontally — **scrollbar hidden**
- **Edge fades** appear at the active edges via `mask-image` (driven by scroll position)
- **Click + drag** to scroll. Cursor swaps `grab` → `grabbing`. Click suppression: a drag of >8 px AND actual scroll movement consumes the trailing click; small wiggles still register as clicks
- Mouse wheel scrolls along the track axis (vertical wheel → horizontal scroll on horizontal tracks; native vertical scroll on vertical tracks)
- Touch and trackpad swipe work via `overflow: auto`
- Same pattern at the multi-toggle wrap level — when many fields don't fit, the wrap scrolls along its orientation axis (horizontal in row layout, vertical in column layout)

## What it doesn't do (yet)

- Search / filter buttons by label
- Custom per-button text overrides (labels come from data values)
- Range / numeric slider mode

## Tech

- TypeScript 4.9, `pbiviz` 5.4, `powerbi-visuals-api` 5.11
- `powerbi-visuals-utils-formattingmodel` 6.x
- LESS for styling
- No external runtime dependencies

## Build from source

```bash
npm install
npx pbiviz package
# output: dist/toggleButtonDA2604241000A1B2.1.0.0.0.pbiviz
```

## Author

Daniel Abdel Sater — [danielabdelsate@gmail.com](mailto:danielabdelsate@gmail.com)
