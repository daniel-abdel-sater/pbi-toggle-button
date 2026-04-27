# Toggle Button — Project Knowledge File

**Created:** 2026-04-24
**Type:** Power BI custom visual
**Tech stack:** TypeScript 4.9, pbiviz 5.4, powerbi-visuals-api 5.11, powerbi-visuals-utils-formattingmodel 6.x, LESS

---

## Scope

A slicer-style toggle button bound to a field that has **1 or 2 distinct values**. With 2 values: classic A/B toggle (click switches sides). With 1 value: single-button toggle that toggles between selected (filter active) and cleared (filter off). Up to 5 fields can be bound; each renders an independent toggle pill.

### Format pane
- Toggle size (overall height; padding, thumb, font scale proportionally)
- Corner radius (0 → pill)
- Value A color (track when A selected)
- Value B color (track when B selected)
- Value A label color
- Value B label color
- Show border + border color

### Behaviour
- Click label A / label B → selects that value
- Click currently-selected label → clears selection
- Selection persists across page navigation + report reload via `toolbar.selectedValue` (standard §39 pattern)
- External cross-filter sync: `registerOnSelectCallback` re-aligns thumb when another visual changes selection
- Landing page when no field bound
- Error state when bound field has ≠ 2 distinct values

---

## Files

```
src/visual.ts        — IVisual, toggle render, click/persist/sync logic
src/settings.ts      — formattingSettings.Model (GeneralCard)
style/visual.less    — .tb-root scope, CSS-var driven
capabilities.json    — 1 Grouping role "field"; objects: general + toolbar
pbiviz.json          — API 5.11.0
```

---

## Session log

### Multi-instance update loop from unstable selectionIds
[retry-lesson] [date: 2026-04-24]

**Context:** Two instances of this visual on the same page (same OR different fields) entered an endless `update()` loop after either of them auto-selected on first load.

**First attempt that failed:** Added a "live selection > persisted > force-default" priority in `update()` to avoid two same-field toggles fighting over persisted state. Worked for that case but the different-field case still looped.

**Root cause:** Every `update()` was calling `createSelectionIdBuilder().withCategory(cat, i).createSelectionId()` to rebuild `items`. The freshly-built selectionIds did not `.equals()` the ones we'd stored via `selectionManager.select()` in the previous update (the underlying identity expressions can differ subtly across updates, especially when the dataView was filtered by another visual). So `liveMatch` returned undefined → we'd rehydrate persisted → call `select()` again → PBI fires a new `update()` → same thing repeats.

**Solution:**
1. Cache `items` across updates. Only rebuild them when the bound field's `queryName` changes OR the two raw values themselves change. This keeps selectionId identity stable so `.equals()` succeeds on subsequent updates.
2. Add a `hasRestoredSelection` flag. Run the rehydrate-persisted / force-default path at most ONCE per field binding. Subsequent updates with no live match simply keep `selectedValue` as-is — they never call `selectionManager.select()` or `persist()` on their own.
3. Reset the flag when the field (queryName) changes or when values change.

**Impact:** Eliminates the update loop for any number of instances on the same page, independent of whether they're bound to the same or different fields. Also reduces update cost since we don't rebuild `items` on every viewport/resize update.

---

### Click reverts on multi-field bind: cross-product cat identity false-positive
[retry-lesson] [date: 2026-04-26]

**Context:** With 2+ fields bound, clicking a toggle would set `selectedValue = B`, run `commitSelections()` (correctly building a fresh selectionId at the right idx), but the post-`select()` `update()` would silently revert `selectedValue` back to `A`. UI snapped back to the original side. With 3 fields, this happened on the FIRST click; with 2 fields, it took a few cycles to surface (the third A→B switch).

**First attempt that failed (commit aa6f08e):** Rebuilt fresh selectionIds in `commitSelections()` to fix an unrelated `expr is undefined` error. This regressed the multi-instance loop fix because cached `items[]` selectionIds (from the previous fix) no longer reference-matched what the host echoed back through `getSelectionIds()`.

**Second attempt that failed:** Always rebuilt fresh `items[]` per update, hoping fresh-vs-fresh `.equals()` would compare correctly. Worked for 2 fields but broke immediately on 3 fields.

**Root cause:** Single `categorical.categories.for.in` with multiple bound fields produces a CROSS-PRODUCT `cat.values` (length = product of distinct counts, with duplicates). `cat.identity[i]` for each row encodes the FULL cross-row scope (all bound fields' values at that row), not a per-field selector. Two `withCategory(cat, idxA).createSelectionId()` and `withCategory(cat, idxB).createSelectionId()` calls on the same cat share their column-level expressions, so PBI's `.equals()` cross-matches them. `Array.find()` always returns `items[0]`, silently overwriting the click. The log signature: `commitSelections() ... [Value7=predefined date@2, ...]` (idx=2 for what should be the second distinct value proves the duplicates exist).

**Solution:** Stop reading `selectedValue` from live selections in `parseToggle` entirely. The click handler is the single source of truth. Persisted map restores once on first bind (`hasRestoredSelection` flag). `applyLayout`'s `needsFirstCommit` branch keeps the live `selectionManager` aligned by re-asserting the union after every click. No `.equals()` lookup against `liveSelIds` = no false-positive override.

**Impact:** All multi-field binding scenarios now work correctly regardless of cross-product cat shape. External cross-filter sync is best-effort via `registerOnSelectCallback` only (acceptable trade-off given the constraint).

**Generalized rule:** When a custom visual binds multiple fields to a single `for.in` mapping, do NOT rely on `.equals()` between selectionIds built from different `idx` values of the same cat — they share column-level expressions and false-positive match. Per-field selection state must be owned by the visual (click handler + persisted state), not derived from `getSelectionIds()`. For true per-field independent filtering (slicer-style), prefer `host.applyJsonFilter` with per-field IBasicFilter — selectionManager is for highlight/select-data-points semantics that don't compose across multiple fields.

---

### Per-row FX on Apply-to slot system: wildcard selector + slot-aware reader
[retry-lesson] [date: 2026-04-27]

**Context:** Adding FX (conditional formatting) to the 5 ColorPickers (`thumb.thumbGlowColor` + 4 `text.*` colors). Each ColorPicker has the §3.5 Apply-to slot system: `prop`, `prop_0..prop_4` for per-toggle overrides. We added `instanceKind: ConstantOrRule` per CLAUDE.md §P25 and the corresponding capability `rule` metadata. Author wrote a SWITCH(SELECTEDVALUE…) DAX measure expecting per-row colors. Result: **one color cascaded to every toggle button.**

**First attempt that failed:** Just `instanceKind: ConstantOrRule` + `rule` capability metadata. Diagnostic showed `cat.objects: NONE` — PBI evaluated the rule once per visual in overall filter context and returned a single color, did not emit per-row outputs.

**Second attempt that failed:** Added `selector: FX_SELECTOR` (inline `{ data: [{ dataViewWildcard: { matchingOption: 0 } }] }`) to enable per-row emission. Diagnostic now showed populated `cat.objects: r0={"thumb":{"thumbGlowColor_1":...}}` — per-row colors WERE in the metadata, but the visual still cascaded one color. Why: the author had set the FX rule from the per-toggle "Apply to: Toggle 2" view in the format pane, so PBI keyed the output under the slot variant **`thumbGlowColor_1`**, not the unprefixed `thumbGlowColor`. Our `colorForRow` reader only looked at the unprefixed name.

**Root cause:** With the Apply-to slot system, the FX output property name follows whichever Apply-to view the author was editing. "All toggles" → unprefixed; per-toggle slot → `prop_<slotIdx>`. Reader must check both.

**Solution:** `colorForRow` now tries `prop_<slotIdx>` first (per-toggle override wins), then `prop` (all-default), before falling back to the constant `resolveColor` chain. Slot index resolved from `cardIndexMaps[card][queryName]` — the same indexMap that drives the format-pane visibility. Generic over all 5 FX-enabled colors (one helper, all callers benefit).

**Generalized to parent CLAUDE.md §11.0d** — full four-piece protocol for per-row FX on categorical visuals (instanceKind + capability rule + wildcard selector + slot-aware reader).

---
