# Halo Slicer — User Documentation

## Contents

- [What it does](#what-it-does)
- [Sample data model](#sample-data-model)
- [Fields](#fields)
  - [Field](#field)
  - [Default Selection (optional)](#default-selection-optional)
- [Settings](#settings)
  - [Fields Label](#fields-label)
  - [Sizing](#sizing)
  - [Capsule](#capsule)
  - [Content](#content)
  - [Text](#text)
  - [Thumb](#thumb)
  - [Animation](#animation)
  - [Orientation](#orientation)
  - [Spacing](#spacing)
  - [Selection Mode](#selection-mode)
- [Common gotchas](#common-gotchas)
- [Tips](#tips)
- [Support](#support)

---

## What it does

- Renders any low-cardinality field as a glass-pill toggle — one button per distinct value, with a glowing thumb on the active value
- Bind up to 5 fields side-by-side; each gets its own pill, arranged horizontally or vertically
- Single-select, multi-select, or force-select per field
- Cross-filters the report via native `applyJsonFilter` — same behavior as the built-in slicer
- FX conditional formatting on every color (label, symbol, thumb, shimmer)
- Selection persists across page navigation, report reloads, and Sync Slicers

---

## Sample data model

Every DAX example below references this star schema:

```
        DimDate                            DimStatus
        +----------+                       +------------+
        | DateKey  |    1                  | StatusCode |    1
        | Year     |  ----+                +------------+ ---+
        | MonthName|      |                                   |
        | Day      |      |                                   |
        +----------+      *                                   *
                  +-----------------------------------------------+
                  |                FactTasks                       |
                  | TaskID | DateKey | StatusCode | Cost           |
                  +-----------------------------------------------+
```

**Tables**

| Table | Columns | Role |
|---|---|---|
| `DimDate` | `DateKey`, `Year`, `MonthName`, `Day` | Date dimension |
| `DimStatus` | `StatusCode` (e.g. "On Plan", "Delayed") | Status dimension |
| `FactTasks` | `TaskID`, `DateKey`, `StatusCode`, `Cost` | Fact table |

**Relationships** — 1 → many

- `DimDate[DateKey]` → `FactTasks[DateKey]`
- `DimStatus[StatusCode]` → `FactTasks[StatusCode]`

**Measures**

```dax
Default Status =
SWITCH(TRUE(),
    SELECTEDVALUE(DimStatus[StatusCode]) = "On Plan", 1,
    0)

Status Color =
SWITCH(TRUE(),
    SELECTEDVALUE(DimStatus[StatusCode]) = "On Plan", "#10B981",
    SELECTEDVALUE(DimStatus[StatusCode]) = "Delayed", "#EF4444",
    "#94A3B8")
```

Mental model: each bound Field becomes one pill; each distinct value of that field becomes one button.

---

## Fields

Bind these in the Visualizations pane. Required fields are marked ✅; everything else is optional.

### Field

- **What it is**: the column whose distinct values become buttons in the pill
- **Required**: ✅
- **How to use**: drop 1 to 5 columns. Each column produces its own toggle. Power BI's data reduction caps each toggle at the top 30,000 distinct values, but in practice keep this under ~10 for a usable strip
- **Special treatment**: when 2+ fields are bound they must be from the same table or related tables — Power BI requires a relationship to evaluate multiple bound columns in one visual. Native typed values are sent to the cross-filter (integer columns filter as integers, dates as dates) — no string coercion

### Default Selection (optional)

- **What it is**: a DAX measure that picks the value to select when the report first loads
- **Required**: ⚪
- **How to use**: bind one measure per Field, in the **same field-well order**. Return `1` for the value that should be the default, `0` for everything else. Only applies on first load — once the user clicks, their choice wins until the field is rebound
- **Special treatment**: ALWAYS return `0` (never `BLANK()`) for non-default rows. Power BI silently drops cross-product rows where every bound measure returns BLANK — the dropped rows then never appear as buttons, breaking the layout
- **DAX example**:
  ```dax
  Default Status =
  SWITCH(TRUE(),
      SELECTEDVALUE(DimStatus[StatusCode]) = "On Plan", 1,
      0)
  ```

---

## Settings

The format pane is organized into 10 cards. Most cards have an **Apply to** dropdown — set defaults under "All toggles" or override per bound field independently. Per-toggle overrides survive field reordering via an internal slot map.

### Fields Label

Title (label text) shown next to each toggle.

- **Apply to** — `All toggles` or pick a specific bound field to override
- **Show Title** — toggle the label on/off (default ON)
- **Title Text** — text to display (default `"label"`); overrides on a slot can leave this empty to inherit the All-toggles value
- **Title Position** — 8 positions: top-left / top-center / top-right / left / right / bottom-left / bottom-center / bottom-right (default `Left`)
- **Title Color** — hex color (default `#334155`)
- **Title Font Size** — pixels (default `16`)

### Sizing

How big the toggle renders.

- **Size Mode** — `Fit Container` (toggle stretches to fill its area, buttons share equal width) or `Fixed` (default — uses an explicit pixel size)
- **Fixed Size (px)** — toggle height; padding, gap, thumb spread all scale from this (default `31`)
- **Equal-Width Buttons** — when ON, every button shares the toggle's width equally regardless of label length; when OFF, each button takes its natural width (default OFF)

### Capsule

Track shape and the glass surface beneath the buttons.

- **Roundness (%)** — corner radius as a percentage of toggle height. `0` = sharp, `100` = full pill (default `100`)
- **Track Padding (px)** — gap between thumb and track edge. `0` = thumb fills edge-to-edge; higher = thinner thumb floating in a larger capsule (default `3`)
- **Track Top α (×1000)** — top of the track's vertical gradient (white at α/1000). Default `40` = `rgba(255,255,255,0.040)`
- **Track Bottom α (×1000)** — bottom of the gradient (default `15` = `0.015`). Top + bottom together create the glass-curve illusion
- **Track Border α (×1000)** — 1px outline around the capsule (default `60` = `0.060`)

### Content

Optional symbols (small mono character before each label) and label visibility.

- **Apply to** — All toggles or per-field override
- **Show Symbols** — show/hide the symbol prefix (default ON)
- **Symbol A / B / C** — text per side (defaults `$` `D` `M`); Symbol C only renders when the field has 3 distinct values
- **Symbol Font Size (px)** — default `12`
- **Show Labels** — show/hide the value labels themselves; labels come from the bound field's distinct values and are not editable here (default ON)
- **Label Font Size (px)** — default `12`

### Text

Label and symbol colors per state. Every color exposes the **FX lightning bolt** — bind a DAX measure for per-value coloring.

- **Apply to** — All toggles or per-field override
- **Label Color (Active)** — color on the currently selected button (default `#F1F5F9`, FX-enabled)
- **Label Color (Inactive)** — color on non-selected buttons (default `#94A3B8`, FX-enabled)
- **Symbol Color (Active)** — symbol on the active button (default `#60A5FA`, FX-enabled). Independent of Thumb → Accent Color
- **Symbol Color (Inactive)** — symbol on inactive buttons (default `#94A3B8`, FX-enabled)
- **Inactive Symbol α (×100)** — extra opacity multiplier on inactive symbols (default `55` = 0.55)

### Thumb

The sliding "selection pill" on top of the capsule, plus its glow.

- **Apply to** — All toggles or per-field override
- **Accent Color** — drives the thumb's tinted gradient, the active symbol color, and the glow ring + bloom (default `#60A5FA`, FX-enabled). The dominant brand color of the visual
- **Ring α (×100)** — opacity of the 1px tinted ring tightly hugging the thumb (default `18` = 0.18)
- **Bloom α (×100)** — opacity of the soft glow bleeding from beneath the thumb — the main "backlit" effect (default `45` = 0.45)
- **Bloom Spread (px)** — how far the bloom extends. `0` = no bloom; larger = more diffuse (default `14`)
- **Inner Highlight α (×100)** — the 1px white highlight along the top inside edge — the glassy 3D feel (default `18`)

### Animation

Thumb-slide timing and the optional shimmer band.

- **Apply to** — All toggles or per-field override
- **Transition Duration (ms)** — how long the thumb takes to slide. `0` = instant snap, `350` = smooth glide (default), `600+` = slow-mo
- **Transition Easing** — `Smooth (default)` / `Material` / `Overshoot` / `Ease Out` / `Linear`. Overshoot bounces slightly past the target before settling
- **Track Shimmer** — sweeping highlight band over the toggle; uses `mix-blend-mode: screen` so it lights up whatever it crosses (default OFF)
- **Shimmer Mode** — `Per Value` (every button shimmers in its own FX-resolved color simultaneously) or `Wave` (one band sweeps the toggle, picking up each value's color as it crosses that button)
- **Shimmer Color** — band tint (default `#FFFFFF`, FX-enabled). Bind a DAX measure to give each value its own shimmer color
- **Shimmer Duration (ms)** — time for one full pass; the band ping-pongs left↔right (default `2500`)
- **Shimmer Transparency (%)** — overall band opacity (default `100`)

### Orientation

Layout direction when multiple fields are bound, and the layout of values inside one toggle.

- **Layout Direction** — `Auto` (vertical when any title is positioned left/right, horizontal otherwise) / `Vertical` / `Horizontal`. Default `Auto`
- **Vertical Alignment** — `Stretch` (default — fill height) / `Top` / `Center` / `Bottom`. Stretch makes all toggles share the tallest height; the others use natural height
- **Horizontal Alignment** — `Stretch` (default) / `Left` / `Center` / `Right`. Same logic on the horizontal axis
- **Values Layout** — how buttons inside ONE toggle arrange. `Horizontal` (default) places them side-by-side; `Vertical` stacks them top-to-bottom. Wave shimmer follows this axis; Per-Value shimmer stays horizontal regardless

### Spacing

Gap between buttons inside a toggle (per-field) and gap between toggles (global).

- **Apply to** — All toggles or per-field override
- **Spacing Between Values (px)** — gap between buttons inside a toggle. `0` = buttons touch (default `0`)
- **Spacing Between Fields (px)** — gap between toggles when 2+ fields are bound. Applied along whichever axis the toggles arrange on (default `8`). Always visible regardless of Apply to

### Selection Mode

Per-field selection behavior.

- **Apply to** — All toggles or per-field override
- **Force Selection** — when ON, clicking the active button does nothing instead of deselecting. Guarantees one value is always selected (default OFF)
- **Multi Select** — when ON, clicking toggles a value's membership in the active set instead of replacing it. The thumb hides when 2+ values are active; selected buttons are styled directly. The downstream filter sends an `In` array (OR-match); cascade toggles evaluate against the union (default OFF)

---

## Common gotchas

- **"My default selection isn't appearing — only one button shows up."** → The Default Selection measure is returning `BLANK()` for non-default rows. Always return `0`; see [Default Selection (optional)](#default-selection-optional)
- **"Year (integer) doesn't cross-filter the table, but Status (text) does."** → This was a bug in older builds where filter values were stringified. Current build sends native typed values — update to the latest `.pbiviz`
- **"FX rule applied one color to every button instead of per-button colors."** → The DAX measure must reference the bound field via `SELECTEDVALUE(...)`, and the FX rule must be set from "All toggles" or the specific per-toggle slot — see the FX example in [Sample data model](#sample-data-model)
- **"Format pane changes don't reflect live."** → Click the visual once to give it focus, then change the setting. Some live updates require a click on the report canvas to reach the visual's update cycle
- **"Two toggles with same field stop responding after a while."** → Multi-instance same-field binding is supported, but selection state is per-instance. Don't bind the same field to two toggles on the same page unless that's what you want
- **"Map / chart cross-filtered me but my pill still shows all values."** → External filter propagation works in current builds; if you see stale buttons, force a refresh of the visual by clicking elsewhere then back

---

## Tips

- **Pair with date hierarchies** — bind Year + Month + Day in cascade order for a slicer-style chained filter strip; each downstream toggle hides values that aren't in the upstream selection
- **FX everything for theme support** — bind Accent Color, Label Color, and Shimmer Color to a DAX color measure that switches by selected value; the visual instantly themes to whatever palette your status/category column maps to
- **Wave shimmer + per-value FX color** — set Shimmer Mode to Wave, bind Shimmer Color FX to a per-value DAX measure; the band changes color mid-sweep as it crosses each button. Polished marketing-dashboard look
- **Force Selection for KPIs** — turn it on when the visual drives a KPI card that must always have a value (no empty-state handling needed)
- **Drillthrough** — right-click the active selection to drill through; the active value (or active set in multi-select) becomes the drillthrough filter
- **Fixed mode + many values** — the toggle scrolls horizontally with hidden scrollbar, edge fades, click-and-drag, and mouse-wheel-as-horizontal. Useful for 8+ value toggles in tight layouts

---

## Support

- **Email**: [support@danbistudio.com](mailto:danielabdelsater@gmail.com)
- **Repository**: [github.com/daniel-abdel-sater/pbi-toggle-button](https://github.com/daniel-abdel-sater/pbi-toggle-button)
- **Response time**: within 2 business days
