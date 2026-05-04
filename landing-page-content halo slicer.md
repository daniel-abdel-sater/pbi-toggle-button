# Halo Slicer — Landing Page Content

## 1. Visual name + tagline
**Halo Slicer** — A glass-pill slicer with sliding thumb, glow, and shimmer.

## 2. Elevator pitch
Halo Slicer turns any low-cardinality field into a sleek glass pill where every value is a button and the active selection rides on a glowing thumb. Bind up to 5 fields side-by-side for a compact filter strip — perfect for status flags, date parts, categories, and any slicer where the native control feels heavy or visually flat.

## 3. Category
**Slicer**

## 4. Problems with default Power BI this visual solves
- Native slicers are visually flat — no thumb animation, no glow, no per-value styling, and they eat canvas space on small-cardinality fields.
- Stacking multiple small slicers (Year / Month / Day, Status / Region / Type) breaks visual rhythm and consumes a full column of report real estate.
- Default slicers offer no conditional formatting on selected state, no shimmer/animation, and no way to drive button colors from a DAX measure.

## 5. Three things this visual delivers
- A glass-pill toggle where every distinct value is a button and the active selection slides on a glowing thumb — single-select, multi-select, or force-select modes.
- Up to 5 independent toggles in one visual, with optional cascade (slicer-style chained filtering) — one compact filter strip instead of five separate slicers.
- Full styling control: per-value colors, FX conditional formatting on every color, track shimmer (per-value or wave), glass effects, custom symbols, and persisted user selections across pages and report reloads.

## 6. How it works (3 steps)
1. **Drop fields** into the field well — 1 to 5 columns, each renders its own pill with one button per distinct value.
2. **Click a value** to filter — the thumb glides to that button and cross-filters every connected visual via native `applyJsonFilter`.
3. **Format** colors, glow, shimmer, layout, and corner radius from the format pane; bind DAX measures via the FX lightning bolt for per-value data-driven colors.

## 7. Benefit bullets
- ⚡ One-click cross-filter with native slicer behavior
- 🎨 Per-value colors + FX conditional formatting on every color
- ✨ Glass shimmer (per-value or wave mode) and animated thumb glow
- 📐 Up to 5 toggles in a single visual with auto/vertical/horizontal layout
- 🔗 Cascade mode for chained slicer-style filtering across bound fields
- 💾 Selection persists across pages, reloads, and Sync Slicers

## 8. Demo description
A horizontal glass pill with multiple labeled buttons and a glowing thumb that smoothly slides to whichever button is clicked. A subtle shimmer band sweeps across the active value, other visuals on the page instantly cross-filter, and binding a second field stacks another pill below — creating a compact, animated filter strip.

## 9. Real-world use case
Construction PM dashboard tracking task schedule status — one Halo Slicer with three bound fields (Year / Month / Status) acts as a chained slicer strip, refiltering the Gantt, KPI cards, and cost summary with a single click and visible thumb animation, instead of three stacked native dropdowns.

## 10. Privacy
**No external services. No data leaves Power BI.** The visual runs entirely inside the Power BI sandbox using only the data and selections the report already has. No telemetry, no network calls, no third-party endpoints.
