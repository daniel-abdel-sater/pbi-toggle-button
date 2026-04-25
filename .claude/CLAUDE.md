# Toggle Button — Project Knowledge File

**Created:** 2026-04-24
**Type:** Power BI custom visual
**Tech stack:** TypeScript 4.9, pbiviz 5.4, powerbi-visuals-api 5.11, powerbi-visuals-utils-formattingmodel 6.x, LESS

---

## Scope

A slicer-style toggle button bound to a field that has **exactly 2 distinct values**. Clicking a side cross-filters the report to that value. Clicking the already-selected side clears the filter.

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
