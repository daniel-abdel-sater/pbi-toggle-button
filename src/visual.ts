"use strict";

import "core-js/stable";
import "./../style/visual.less";

import powerbi from "powerbi-visuals-api";
import VisualConstructorOptions = powerbi.extensibility.visual.VisualConstructorOptions;
import VisualUpdateOptions = powerbi.extensibility.visual.VisualUpdateOptions;
import IVisual = powerbi.extensibility.visual.IVisual;
import IVisualHost = powerbi.extensibility.visual.IVisualHost;
import ISelectionManager = powerbi.extensibility.ISelectionManager;
import ISelectionId = powerbi.visuals.ISelectionId;
import DataView = powerbi.DataView;

import { FormattingSettingsService, formattingSettings } from "powerbi-visuals-utils-formattingmodel";
import { ToggleFormattingModel, clr, hexToRgbTriplet } from "./settings";

// Lightweight diagnostic logging — set to true in dev, false for release
const TB_DEBUG = true;
const MAX_TOGGLES = 5;
let _tbInstanceCounter = 0;

interface ToggleItem {
    value: string;
    display: string;
    selectionId: ISelectionId;
    /** First row index in cat.values where this distinct value appears. Used to read
     *  per-row FX color outputs from cat.objects[rowIdx] when conditional formatting
     *  rules are active on color properties. */
    rowIdx: number;
}

interface ToggleState {
    queryName: string;
    cat: powerbi.DataViewCategoryColumn;
    columnDisplayName: string;
    items: ToggleItem[];
    cachedItems: ToggleItem[];
    cachedFieldQueryName: string | null;
    hasRestoredSelection: boolean;
    selectedValue: string | null;
    /** Full active set. In single-select mode this contains 0 or 1 entry that mirrors
     *  selectedValue. In multi-select mode this can grow to N entries; selectedValue
     *  tracks the most recently clicked one (used as the thumb anchor when the set
     *  briefly drops to 1, and for cascade-display fallbacks). Always kept in sync
     *  with selectedValue via setSelection/addSelection/removeSelection/clearSelection. */
    selectedSet: Set<string>;
    /** Last value the `defaultValue` Measure flagged as truthy, kept across updates so we
     *  can detect when the measure's chosen default changes (context shift) and slide the
     *  thumb to the new side. null = no driver bound or no truthy row. */
    lastDriverVal: string | null;
    /** Signature of cat.source's sort-by-column metadata. When this changes between
     *  updates the cached A/B/C order is invalidated so the visual reorders to match
     *  the new sort. Cross-product reshuffles don't change this signature, so they
     *  don't flip sides spuriously. */
    lastSortKey: string;
    /** Signature of all upstream toggles' selectedValues at the time of the previous
     *  parseToggle call. When this changes (the cascade input changed) we force a
     *  cache rebuild — preserving the cache when going from a longer month to a
     *  shorter one would leave stale buttons (e.g. Dec=31 → Feb=28 keeps 31 buttons).
     *  When upstream is unchanged but n < cache, cache-fallback still fires (real
     *  transient shrinkage from PBI's row pruning, not an intentional cascade switch). */
    lastUpstreamKey: string;

    // DOM refs (per toggle)
    blockEl:  HTMLDivElement | null;
    titleEl:  HTMLDivElement | null;
    wrapEl:   HTMLDivElement | null;
    toggleEl: HTMLDivElement | null;
    /** Inner scroll track inside .tb-toggle. Hosts the thumb (::before) and the
     *  buttons. When the buttons' total width exceeds the toggle's available
     *  width, the track scrolls horizontally — scrollbar hidden, edges fade
     *  via mask-image, drag-to-scroll via pointer events. */
    trackEl:  HTMLDivElement | null;
    /** Per-side DOM refs, parallel arrays indexed by side position (0 = A, 1 = B, 2 = C, …).
     *  Length matches the number of rendered buttons (= items.length at render time).
     *  Generalized from named A/B/C refs so the visual handles any number of distinct
     *  values up to whatever PBI's dataReductionAlgorithm delivers (top 10 by default). */
    btnEls:   HTMLButtonElement[];
    symEls:   HTMLSpanElement[];
    lblEls:   HTMLSpanElement[];
    resizeObs: ResizeObserver | null;
}

const POSITION_CLASSES = [
    "pos-top-left", "pos-top-center", "pos-top-right",
    "pos-left", "pos-right",
    "pos-bottom-left", "pos-bottom-center", "pos-bottom-right"
];

export class Visual implements IVisual {
    private readonly _id: number = ++_tbInstanceCounter;
    private host: IVisualHost;
    private root: HTMLDivElement;
    private togglesWrapEl: HTMLDivElement | null = null;
    private selectionManager: ISelectionManager;
    private fmtService: FormattingSettingsService;
    private fmtSettings: ToggleFormattingModel;

    // Per-toggle state — kept across updates so cached items / selectionId identity stays stable.
    private toggles: ToggleState[] = [];

    private viewportW: number = 0;
    private viewportH: number = 0;

    private lastRenderKey: string = "";

    // Apply-to dropdown plumbing per per-toggle card (Phase B/C). Snapshot of the active dataView's
    // metadata.objects so resolve helpers can read raw overrides without parsing again.
    private currentDvMeta: Record<string, Record<string, unknown> | undefined> | undefined;
    // Snapshot of the latest DataView itself — used by getDriverDefaultForToggle to read
    // the optional `defaultValue` Measure aligned to each bound field's slot.
    private currentDv: DataView | undefined;
    // <cardName, <queryName, slotIdx>> — populated from `<card>.<card>IndexMap` in metadata; used
    // to resolve per-toggle slot reads. Stays stable across rebindings.
    private cardIndexMaps: Record<string, Record<string, number>> = { title: {}, content: {}, text: {}, thumb: {}, selection: {}, spacing: {}, animation: {} };
    // <cardName, "all" | "toggle:<queryName>"> — read from metadata directly per §11.0c.
    private activeViewByCard: Record<string, string> = { title: "all", content: "all", text: "all", thumb: "all", selection: "all", spacing: "all", animation: "all" };
    // Cards that have the Apply-to dropdown wired (grow this list as B2/C1/C2 land)
    private static readonly PER_TOGGLE_CARDS: ReadonlyArray<"title"|"content"|"text"|"thumb"|"selection"|"spacing"|"animation"> = ["title", "content", "text", "thumb", "selection", "spacing", "animation"];

    private log(...args: unknown[]): void {
        if (!TB_DEBUG) return;
        // eslint-disable-next-line no-console
        console.log(`%c[TB #${this._id}]`, "color:#4f8cff;font-weight:bold", ...args);
    }

    constructor(options?: VisualConstructorOptions) {
        if (!options) return;
        this.host = options.host;
        this.selectionManager = this.host.createSelectionManager();
        this.fmtService = new FormattingSettingsService();
        this.fmtSettings = new ToggleFormattingModel();

        this.root = document.createElement("div");
        this.root.className = "tb-root";
        options.element.appendChild(this.root);

        this.log("constructor");
        this.selectionManager.registerOnSelectCallback(() => {
            this.resyncAllFromSelectionManager();
            this.applyLayout();
        });
    }

    public update(options: VisualUpdateOptions): void {
        this.host.eventService.renderingStarted(options);
        try {
            this.viewportW = options.viewport?.width  || 0;
            this.viewportH = options.viewport?.height || 0;
            // Single dataViewMapping; the bound fields live in dv.categorical.categories[].
            // Fields must be from the same table or related tables (PBI requires a relationship).
            const dv: DataView | undefined = options.dataViews?.[0];
            const settingsDv = dv;
            this.currentDv = dv;
            this.log(`update() type=${options.type} hasDv=${!!dv} viewport=${this.viewportW}x${this.viewportH}`);

            // ── Diagnostic dump: dv.categorical structure ───────────────────────────
            if (dv?.categorical) {
                const cats = dv.categorical.categories || [];
                const vals = dv.categorical.values || [];
                this.log(`  DV categorical: cats=${cats.length} valueCols=${vals.length}`);
                cats.forEach((c, i) => {
                    const arr = c.values || [];
                    const sample = arr.slice(0, 6).map(v => v == null ? "(blank)" : `${v}<${typeof v}>`);
                    this.log(`    cat[${i}] qn=${c.source?.queryName} len=${arr.length} sample=[${sample.join(", ")}]`);
                    if (c.objects && c.objects.length > 0) {
                        const objSample = c.objects.slice(0, 4).map((o, oi) => `r${oi}=${o ? JSON.stringify(o) : "null"}`);
                        this.log(`    cat[${i}] objects: ${objSample.join(" | ")}`);
                    }
                });
                vals.forEach((v, i) => {
                    const arr = v.values || [];
                    const sample = arr.slice(0, 6).map(x => x == null ? "(blank)" : `${x}<${typeof x}>`);
                    this.log(`    val[${i}] qn=${v.source?.queryName} roles=${JSON.stringify(v.source?.roles || {})} len=${arr.length} sample=[${sample.join(", ")}]`);
                    // ── Cross-filter / highlight detection ──────────────────────
                    // PBI uses two cross-filter mechanisms:
                    //   FILTER mode  → cat.values[r] is REDUCED to only matching rows;
                    //                  highlights array is undefined.
                    //   HIGHLIGHT mode → cat.values[r] is FULL; values[i].highlights[r]
                    //                    is non-null only for rows matching the source
                    //                    visual's selection. (Slicers use this when
                    //                    selecting from charts/maps.)
                    // We need to honor BOTH to behave like a native slicer.
                    const hl = (v as unknown as { highlights?: unknown[] }).highlights;
                    if (hl && Array.isArray(hl)) {
                        let hlCount = 0;
                        for (const h of hl) if (h != null) hlCount++;
                        const hlSample = hl.slice(0, 12).map(h => h == null ? "_" : "X").join("");
                        this.log(`    val[${i}] HIGHLIGHTS present: ${hlCount}/${hl.length} non-null  pattern[0..11]=[${hlSample}]`);
                    } else {
                        this.log(`    val[${i}] highlights: NONE (filter-mode or no cross-filter)`);
                    }
                });
            }
            // ── Diagnostic: general.filter state (set by THIS visual via applyJsonFilter) ──
            const generalFilter = (dv?.metadata?.objects as { general?: { filter?: unknown } } | undefined)?.general?.filter;
            this.log(`  general.filter: ${generalFilter ? JSON.stringify(generalFilter).slice(0, 300) : "absent"}`);

            if (settingsDv) {
                this.fmtSettings = this.fmtService.populateFormattingSettingsModel(
                    ToggleFormattingModel, settingsDv
                );
                // §11.0c: text-typed ItemDropdowns are not reliably bound by populate.
                const meta = settingsDv.metadata?.objects as Record<string, Record<string, unknown> | undefined> | undefined;
                const syncDropdown = (
                    slice: formattingSettings.ItemDropdown, cardName: string, propName: string
                ): void => {
                    const raw = meta?.[cardName]?.[propName];
                    if (typeof raw === "string") {
                        const items = (slice.items as Array<{ value: string; displayName: string }> | undefined) || [];
                        const item = items.find(it => it.value === raw);
                        if (item) slice.value = item;
                    }
                };
                syncDropdown(this.fmtSettings.sizing.sizeMode,             "sizing",      "sizeMode");
                syncDropdown(this.fmtSettings.title.titlePosition,         "title",       "titlePosition");
                syncDropdown(this.fmtSettings.animation.transitionEase,    "animation",   "transitionEase");
                syncDropdown(this.fmtSettings.orientation.mode,            "orientation", "mode");
                syncDropdown(this.fmtSettings.orientation.verticalAlign,   "orientation", "verticalAlign");
                syncDropdown(this.fmtSettings.orientation.horizontalAlign, "orientation", "horizontalAlign");
                syncDropdown(this.fmtSettings.orientation.valuesLayout,    "orientation", "valuesLayout");

                // Cache metadata snapshot for resolve helpers
                this.currentDvMeta = settingsDv.metadata?.objects as Record<string, Record<string, unknown> | undefined> | undefined;

                // One-time: turn off PBI host chrome (Title bar + Background fill) by default.
                // Sentinel `toolbar.pbiDefaultsApplied` is persisted alongside so we never
                // re-apply on subsequent updates (which would also fight the user if they
                // re-enable either chrome later).
                this.applyPbiHostDefaults();
            }

            // Each bound column in the single Field role is one toggle.
            const cats: powerbi.DataViewCategoryColumn[] = [];
            const allCats = dv?.categorical?.categories || [];
            for (const c of allCats) {
                if (c && Array.isArray(c.values)) cats.push(c);
            }
            if (cats.length === 0) { this.renderLanding(); return; }

            // Reconcile toggles by queryName so cached items + selection state survive updates
            const newToggles: ToggleState[] = [];
            for (let i = 0; i < Math.min(cats.length, MAX_TOGGLES); i++) {
                const cat = cats[i];
                const queryName = cat.source?.queryName || "";
                const existing = this.toggles.find(t => t.queryName === queryName);
                if (existing) {
                    existing.cat = cat;
                    existing.columnDisplayName = String(cat.source?.displayName || queryName);
                    newToggles.push(existing);
                } else {
                    newToggles.push(this.createEmptyToggleState(cat, queryName));
                }
            }
            // Tear down removed toggles' resize observers
            for (const old of this.toggles) {
                if (!newToggles.includes(old) && old.resizeObs) {
                    old.resizeObs.disconnect();
                    old.resizeObs = null;
                }
            }
            this.toggles = newToggles;

            // ── Apply-to plumbing: read view + ensure each bound queryName has a slot
            for (const card of Visual.PER_TOGGLE_CARDS) {
                this.ensureSlotsForCard(card);
                this.refreshViewItemsAndRead(card);
            }

            // Parse + restore selection per toggle
            const persistedMap = this.readPersistedMap(settingsDv);

            // Snapshot pre-parse selections so we can detect MY-OWN-state changes after
            // parseToggle (first-bind force-default or cascade-reset). We never re-assert
            // based on what's in liveSelIds — when two instances of this visual are bound
            // to the same fields with different selections, that turns into a flip-flop
            // loop where each instance keeps overwriting the other's commit.
            // Compare the FULL set per toggle (sorted) so multi-select changes are detected
            const prevSelections: string[] = this.toggles.map(t =>
                Array.from(t.selectedSet).sort().join("␟"));

            // Slicer-style cascade: each toggle's available values are filtered by the
            // selections of all upstream toggles (j < i). `constraints` is built incrementally
            // so toggle i sees toggles 0..i-1 with their freshly-parsed selections.
            // string[] | null  →  null = no constraint (cleared toggle), array = OR-match
            // (multi-select sends N values; single-select sends [primary]). Empty array
            // is normalized to null at the use-site to keep downstream code simple.
            const constraints: (string[] | null)[] = new Array(this.toggles.length).fill(null);
            let anyError = false;
            const errorCounts: number[] = [];
            for (let i = 0; i < this.toggles.length; i++) {
                const ok = this.parseToggle(i, constraints, persistedMap);
                if (!ok.ok) {
                    anyError = true;
                    errorCounts.push(ok.distinctCount);
                }
                const t = this.toggles[i];
                constraints[i] = t.selectedSet.size > 0 ? Array.from(t.selectedSet) : null;
            }

            // Commit + persist only when MY-OWN selectedValue changed during parse.
            // This catches first-bind force-default and cascade-reset, but stays silent
            // on plain preserve passes — which is exactly what breaks the multi-instance loop.
            const selectionsChanged = this.toggles.some((t, i) => {
                const cur = Array.from(t.selectedSet).sort().join("␟");
                return cur !== prevSelections[i];
            });
            if (selectionsChanged) {
                this.log(`selectionsChanged → commit & persist`);
                this.commitSelections();
                this.persistAll();
            }
            const anyRenderable = this.toggles.some(t => t.items.length >= 1);
            if (anyError && !anyRenderable) {
                // No usable toggles at all → show error reflecting the first problem
                this.renderError(errorCounts[0] ?? 0);
                return;
            }

            // Build the global render-key (structure of all toggles + orientation + global show flags).
            const orientationMode = (this.fmtSettings.orientation.mode.value as { value?: string })?.value || "auto";
            const showSymbols = this.fmtSettings.content.showSymbols.value !== false;
            const showLabels  = this.fmtSettings.content.showLabels.value !== false;
            const symA = String(this.fmtSettings.content.symbolA.value ?? "");
            const symB = String(this.fmtSettings.content.symbolB.value ?? "");
            const symC = String(this.fmtSettings.content.symbolC.value ?? "");

            // Per-toggle STRUCTURAL fields only. Items count + label text are PATCHED
            // in applyLayout via syncButtonCount + label updates, so they don't enter
            // the renderKey — that's what keeps cascade-driven items count changes
            // (e.g. Day 28 → 30) from triggering a full DOM rebuild + flicker. Same
            // for titleText. Things that genuinely affect the DOM structure (toggle
            // count, queryNames, title visibility, title position, symbol presence)
            // remain so a real structural change still triggers renderAll.
            const togglesKey = this.toggles.map(t => {
                // Use the effective `show` (showFlag AND text!=="") — same predicate that
                // resolveTitleForToggle uses to decide whether to add a `pos-*` grid class.
                // If the renderKey only tracked the raw `showTitle` flag, clearing the title
                // text wouldn't trigger a rebuild → the stale `pos-*` class would keep
                // reserving a title row/column → phantom side gap in fit-container mode.
                const tt = this.resolveTitleForToggle(t.queryName);
                return [t.queryName, tt.show ? "T" : "t", tt.show ? tt.validPos : ""].join("␟");
            }).join("␞");

            const renderKey = [
                togglesKey,
                this.toggles.length,
                orientationMode,
                showSymbols ? "S" : "s", symA, symB, symC,
                showLabels ? "L" : "l"
            ].join("␟");

            if (renderKey !== this.lastRenderKey || !this.togglesWrapEl) {
                this.log(`renderKey CHANGED → renderAll() (was ${this.lastRenderKey ? `len=${this.lastRenderKey.length}` : "empty"}, now len=${renderKey.length})`);
                this.renderAll();
                this.lastRenderKey = renderKey;
            } else {
                this.log(`renderKey unchanged → skip renderAll, applyLayout only`);
            }
            this.applyLayout();
        } catch (e) {
            console.error("[ToggleButton] update error:", e);
        } finally {
            this.host.eventService.renderingFinished(options);
        }
    }

    public getFormattingModel(): powerbi.visuals.FormattingModel {
        // View-aware visibility per per-toggle card (slice-leakage prevention — see scaling-skill incident)
        for (const card of Visual.PER_TOGGLE_CARDS) {
            this.applyCardVisibility(card);
        }
        return this.fmtService.buildFormattingModel(this.fmtSettings);
    }

    /** First-load only: disable the PBI host's default Title bar and Background fill so
     *  the visual presents itself without chrome. We persist a sentinel under `toolbar`
     *  to make this idempotent — once the user (or this method) has touched those
     *  switches, we never re-assert them, so the user can re-enable either chrome later
     *  and it sticks. */
    private applyPbiHostDefaults(): void {
        const flag = this.currentDvMeta?.toolbar?.pbiDefaultsApplied;
        if (flag === true) return;
        this.log("applyPbiHostDefaults: persisting title.show=false, background.show=false");
        this.host.persistProperties({
            merge: [
                { objectName: "title",      properties: { show: false } as Record<string, powerbi.DataViewPropertyValue>, selector: null as unknown as powerbi.data.Selector },
                { objectName: "background", properties: { show: false } as Record<string, powerbi.DataViewPropertyValue>, selector: null as unknown as powerbi.data.Selector },
                { objectName: "toolbar",    properties: { pbiDefaultsApplied: true } as Record<string, powerbi.DataViewPropertyValue>, selector: null as unknown as powerbi.data.Selector }
            ]
        });
    }

    // ── Apply-to plumbing ──────────────────────────────────────────────

    /** Read the card's indexMap from metadata, assign slots to any new queryNames, persist if changed. */
    private ensureSlotsForCard(cardName: "title"|"content"|"text"|"thumb"|"selection"|"spacing"|"animation"): void {
        const propName = `${cardName}IndexMap`;
        const raw = this.currentDvMeta?.[cardName]?.[propName];
        let map: Record<string, number> = {};
        if (typeof raw === "string" && raw !== "") {
            try {
                const p = JSON.parse(raw);
                if (p && typeof p === "object") map = p as Record<string, number>;
            } catch (e) { /* fall through to empty map */ }
        }
        const used = new Set<number>(Object.values(map).filter(v => typeof v === "number"));
        let dirty = false;
        for (const t of this.toggles) {
            if (typeof map[t.queryName] !== "number") {
                for (let i = 0; i < MAX_TOGGLES; i++) {
                    if (!used.has(i)) {
                        map[t.queryName] = i;
                        used.add(i);
                        dirty = true;
                        break;
                    }
                }
            }
        }
        this.cardIndexMaps[cardName] = map;
        if (dirty) {
            const props: Record<string, unknown> = {};
            props[propName] = JSON.stringify(map);
            this.host.persistProperties({
                merge: [{
                    objectName: cardName,
                    properties: props as Record<string, powerbi.DataViewPropertyValue>,
                    selector: null as unknown as powerbi.data.Selector
                }]
            });
        }
    }

    /** Rebuild the card's `view` ItemDropdown items list from current bound toggles, and direct-read
     *  the active view from metadata (§11.0c — text-typed dynamic dropdown). */
    private refreshViewItemsAndRead(cardName: "title"|"content"|"text"|"thumb"|"selection"|"spacing"|"animation"): void {
        const items: Array<{ value: string; displayName: string }> = [
            { value: "all", displayName: "All toggles" }
        ];
        for (const t of this.toggles) {
            items.push({ value: `toggle:${t.queryName}`, displayName: t.columnDisplayName });
        }
        const card = (this.fmtSettings as unknown as Record<string, { view: formattingSettings.ItemDropdown }>)[cardName];
        if (card?.view) {
            (card.view.items as unknown as typeof items) = items;
            // Direct read of active view from metadata
            const raw = this.currentDvMeta?.[cardName]?.["view"];
            const viewVal = (typeof raw === "string" && (raw === "all" || raw.startsWith("toggle:"))) ? raw : "all";
            // Validate that the toggle:<qn> still exists
            const valid = items.find(it => it.value === viewVal) || items[0];
            card.view.value = valid;
            this.activeViewByCard[cardName] = valid.value;
        }
    }

    private applyCardVisibility(cardName: "title"|"content"|"text"|"thumb"|"selection"|"spacing"|"animation"): void {
        const view = this.activeViewByCard[cardName] || "all";
        const isAll = view === "all" || !view.startsWith("toggle:");
        const qn = isAll ? "" : view.slice("toggle:".length);
        const slotIdx = isAll ? -1 : (this.cardIndexMaps[cardName]?.[qn] ?? -1);

        // Per-card prop lists (drives both visibility AND resolve helpers)
        const cardProps: Record<string, string[]> = {
            title:     ["showTitle", "titleText", "titlePosition", "titleColor", "titleFontSize"],
            content:   ["showSymbols", "symbolA", "symbolB", "symbolC", "symbolFontSize", "showLabels", "labelFontSize"],
            text:      ["labelActiveColor", "labelInactiveColor", "symbolActiveColor", "symbolInactiveColor", "symbolInactiveAlpha"],
            thumb:     ["thumbGlowColor", "thumbRingAlpha", "thumbBloomAlpha", "thumbGlowSpread", "thumbHighlightAlpha"],
            selection: ["forceSelection", "multiSelect"],
            spacing:   ["valueGap"],
            animation: ["transitionDuration", "transitionEase", "shimmerEnabled", "shimmerMode", "shimmerColor", "shimmerDuration", "shimmerOpacity"]
        };
        const indexMapProps: Record<string, string> = {
            title: "titleIndexMap", content: "contentIndexMap", text: "textIndexMap", thumb: "thumbIndexMap",
            selection: "selectionIndexMap", spacing: "spacingIndexMap", animation: "animationIndexMap"
        };

        const card = (this.fmtSettings as unknown as Record<string, Record<string, formattingSettings.Slice>>)[cardName];
        if (!card) return;
        const props = cardProps[cardName] || [];

        for (const p of props) {
            const slice = card[p];
            if (slice) (slice as unknown as { visible: boolean }).visible = isAll;
        }
        for (let i = 0; i < MAX_TOGGLES; i++) {
            const visibleSlot = !isAll && i === slotIdx;
            for (const p of props) {
                const slice = card[`${p}_${i}`];
                if (slice) (slice as unknown as { visible: boolean }).visible = visibleSlot;
            }
        }
        // view always visible; <card>IndexMap always hidden
        if (card.view)                              (card.view as unknown as { visible: boolean }).visible = true;
        if (card[indexMapProps[cardName]])          (card[indexMapProps[cardName]] as unknown as { visible: boolean }).visible = false;
    }

    // ── Resolve helpers (slot-override → "all" default → fallback) ─────

    private resolveCardProp(cardName: string, propName: string, qn: string): unknown {
        const slotIdx = this.cardIndexMaps[cardName]?.[qn];
        if (slotIdx == null) return undefined;
        return this.currentDvMeta?.[cardName]?.[`${propName}_${slotIdx}`];
    }

    private resolveColor(cardName: string, propName: string, qn: string, fallback: string): string {
        const v = this.resolveCardProp(cardName, propName, qn);
        if (v && typeof v === "object") {
            const c = (v as { solid?: { color?: string } }).solid?.color;
            if (typeof c === "string" && c !== "") return c;
        }
        const slice = (this.fmtSettings as unknown as Record<string, Record<string, formattingSettings.ColorPicker>>)[cardName]?.[propName];
        return clr(slice as formattingSettings.ColorPicker, fallback);
    }

    /** Resolve a color for a SPECIFIC ROW of a category column. With per-row FX rule
     *  metadata (capabilities `rule.inputRole: "field"`, `output.selector: ["field"]`)
     *  and the wildcard slice selector, PBI emits per-row resolved colors on
     *  `cat.objects[rowIdx][card][propertyName]`.
     *
     *  Apply-to slot system: when the author sets the FX rule from the "All toggles"
     *  dropdown, PBI keys the output under the unprefixed prop name ("thumbGlowColor").
     *  When they set it from a per-toggle view, it's keyed under the slot variant
     *  ("thumbGlowColor_2"). We try the slot variant FIRST (per-toggle override wins),
     *  then the all-default. Falls through to the constant resolveColor chain when no
     *  FX output is present. */
    private colorForRow(tog: ToggleState, rowIdx: number, cardName: string, propName: string, fallback: string): string {
        if (tog.cat?.objects && rowIdx >= 0) {
            const row = tog.cat.objects[rowIdx] as Record<string, Record<string, unknown> | undefined> | undefined;
            const cardObj = row?.[cardName];
            if (cardObj) {
                const slotIdx = this.cardIndexMaps[cardName]?.[tog.queryName];
                const keys: string[] = (typeof slotIdx === "number")
                    ? [`${propName}_${slotIdx}`, propName]
                    : [propName];
                for (const key of keys) {
                    const obj = (cardObj as Record<string, unknown>)[key] as { solid?: { color?: string } } | undefined;
                    const c = obj?.solid?.color;
                    if (typeof c === "string" && c !== "") return c;
                }
            }
        }
        return this.resolveColor(cardName, propName, tog.queryName, fallback);
    }

    private resolveBool(cardName: string, propName: string, qn: string, fallback: boolean): boolean {
        const v = this.resolveCardProp(cardName, propName, qn);
        if (typeof v === "boolean") return v;
        const slice = (this.fmtSettings as unknown as Record<string, Record<string, { value?: unknown }>>)[cardName]?.[propName];
        if (slice && typeof slice.value === "boolean") return slice.value;
        return fallback;
    }

    private resolveNum(cardName: string, propName: string, qn: string, fallback: number): number {
        const v = this.resolveCardProp(cardName, propName, qn);
        if (typeof v === "number") return v;
        const slice = (this.fmtSettings as unknown as Record<string, Record<string, { value?: unknown }>>)[cardName]?.[propName];
        if (slice && typeof slice.value === "number") return slice.value;
        return fallback;
    }

    private resolveText(cardName: string, propName: string, qn: string, fallback: string): string {
        const v = this.resolveCardProp(cardName, propName, qn);
        // Empty string in slot = "inherit from all" (intentional UX)
        if (typeof v === "string" && v !== "") return v;
        const slice = (this.fmtSettings as unknown as Record<string, Record<string, { value?: unknown }>>)[cardName]?.[propName];
        if (slice && typeof slice.value === "string") return slice.value;
        return fallback;
    }

    private resolveDropdown(cardName: string, propName: string, qn: string, fallback: string): string {
        const v = this.resolveCardProp(cardName, propName, qn);
        if (typeof v === "string") return v;
        const slice = (this.fmtSettings as unknown as Record<string, Record<string, { value?: unknown }>>)[cardName]?.[propName];
        const dv = slice?.value;
        if (dv && typeof dv === "object" && typeof (dv as { value?: string }).value === "string") {
            return (dv as { value: string }).value;
        }
        if (typeof slice?.value === "string") return slice.value as string;
        return fallback;
    }

    // ── Per-toggle data parsing ────────────────────────────────────────

    private createEmptyToggleState(cat: powerbi.DataViewCategoryColumn, queryName: string): ToggleState {
        return {
            queryName,
            cat,
            columnDisplayName: String(cat.source?.displayName || queryName),
            items: [],
            cachedItems: [],
            cachedFieldQueryName: null,
            hasRestoredSelection: false,
            selectedValue: null,
            selectedSet: new Set<string>(),
            lastDriverVal: null,
            lastSortKey: "",
            lastUpstreamKey: "",
            blockEl: null, titleEl: null, wrapEl: null, toggleEl: null, trackEl: null,
            btnEls: [], symEls: [], lblEls: [],
            resizeObs: null
        };
    }

    /** Read the optional Default Selection Measure for the given toggle slot and return
     *  the distinct value that the measure flags as truthy (non-zero / non-blank / true).
     *  Returns null when no measure is bound at this slot, when no row evaluates truthy,
     *  or when the truthy row's value isn't actually one of the toggle's items.
     *
     *  Field-well order rules: PBI emits bound `defaultValue` measures into
     *  `dv.categorical.values` in the order they're added. Measure at slot i drives
     *  the field at slot i. Reorder the field-well to reorder the binding. */
    private getDriverDefaultForToggle(
        togIdx: number,
        distinct: { raw: powerbi.PrimitiveValue; idx: number }[]
    ): string | null {
        const valCols = this.currentDv?.categorical?.values;
        if (!valCols || valCols.length === 0) {
            this.log(`  getDriverDefaultForToggle slot=${togIdx} → NO MEASURES BOUND (valCols=${valCols ? valCols.length : "undef"})`);
            return null;
        }
        if (togIdx >= valCols.length) {
            this.log(`  getDriverDefaultForToggle slot=${togIdx} → NO MEASURE AT THIS SLOT (have ${valCols.length} measure(s))`);
            return null;
        }
        const measure = valCols[togIdx];
        if (!measure?.values) {
            this.log(`  getDriverDefaultForToggle slot=${togIdx} → measure has no .values (qn=${measure?.source?.queryName})`);
            return null;
        }

        const trace: string[] = [];
        let chosen: string | null = null;
        for (const d of distinct) {
            const v = measure.values[d.idx];
            const valStr = d.raw == null ? "(blank)" : String(d.raw);
            const truthy =
                (typeof v === "number"  && v !== 0)            ||
                (typeof v === "string"  && v !== "" && v !== "0") ||
                (typeof v === "boolean" && v === true);
            trace.push(`${valStr}@row${d.idx}=${v == null ? "BLANK" : `${v}<${typeof v}>`}${truthy ? "✓" : ""}`);
            if (truthy && chosen == null) chosen = valStr;
        }
        this.log(`  getDriverDefaultForToggle slot=${togIdx} measure=${measure.source?.queryName} rows=[${trace.join(", ")}] → chosen=${chosen}`);
        return chosen;
    }

    /** Parse one toggle's data + restore selection. Returns {ok:true} for n=1/2 / cache reuse,
     *  or {ok:false, distinctCount} for an error state to bubble up.
     *  Applies slicer-style cascade: rows where any upstream toggle's value !== its
     *  current selection are excluded from the distinct collection. */
    private parseToggle(
        togIdx: number,
        constraints: (string[] | null)[],
        persistedMap: Record<string, string[]>
    ): { ok: boolean; distinctCount: number } {
        const tog = this.toggles[togIdx];
        const cat = tog.cat;
        if (!cat || !Array.isArray(cat.values)) return { ok: false, distinctCount: 0 };

        // Field change → reset cache
        if (tog.queryName !== tog.cachedFieldQueryName) {
            tog.cachedItems = [];
            tog.cachedFieldQueryName = tog.queryName;
            tog.hasRestoredSelection = false;
        }

        // Detect sort-by-column metadata changes. PBI populates `cat.source.sortOrder`
        // (1 = Asc, 2 = Desc) when the author has set a "sort by column" rule on this
        // field. Cross-product reshuffles don't flip this, so it's a clean signal that
        // a real sort change happened — used below to invalidate the cached A/B/C order.
        const src = cat.source as { sortOrder?: number } | undefined;
        const sortKey = `${src?.sortOrder ?? "none"}`;
        const sortChanged = sortKey !== tog.lastSortKey;
        tog.lastSortKey = sortKey;

        // Collect distinct values from cat.values, masked by upstream toggle selections
        // (slicer cascade). Diagnostic: log entry state + final distinct set so a "stops
        // working" regression can be traced row-by-row.
        const values = cat.values;
        const upstreamConstraints = constraints.slice(0, togIdx)
            .map((v, j) => `${j}:[${v ? v.join("|") : ""}]`).join(",");
        // Did the cascade input change since the last parseToggle? Used below to decide
        // whether the cache fallback is safe (preserve N buttons on transient shrinkage)
        // or whether we must rebuild (the cascade legitimately points at a different
        // upstream value with a different valid distinct set).
        // Build the upstream signature. Includes highlight-mask digest so an
        // external visual's click (which doesn't change our toggle's own
        // selection but DOES change which rows are highlighted) is detected
        // and forces the cache-fallback to re-evaluate.
        let upstreamKey = constraints.slice(0, togIdx)
            .map(v => v ? v.slice().sort().join("|") : "").join("␟");

        // ── External-cross-filter highlights (slicer-style row mask) ─────
        // When another visual on the page cross-filters via highlight mode
        // (e.g., a map marker click), PBI sends our cat.values[] in FULL but
        // populates dv.categorical.values[i].highlights[r] non-null only for
        // the rows that pass the source visual's filter. Native slicers honor
        // this — they show only the highlighted distinct values. We do the
        // same here: build a row-level mask from the highlights arrays of all
        // bound value columns, OR'd together (a row is "in" if ANY value
        // column highlights it).
        //   • If NO value column has highlights → mask is null → show all rows.
        //   • If at least one value column has highlights → mask is a Set of
        //     row indices to keep.
        // Filter-mode cross-filter is not affected (cat.values is already
        // reduced; highlights are absent).
        const dvVals = (this.currentDv?.categorical?.values as unknown as Array<{ highlights?: unknown[] }> | undefined) || [];
        let hlMask: Set<number> | null = null;
        let hlSourceCount = 0;
        for (const vc of dvVals) {
            const hl = vc?.highlights;
            if (!hl || !Array.isArray(hl)) continue;
            hlSourceCount++;
            if (!hlMask) hlMask = new Set<number>();
            for (let r = 0; r < hl.length; r++) {
                if (hl[r] != null) hlMask.add(r);
            }
        }
        if (hlMask) {
            this.log(`  parseToggle(${tog.queryName}) HIGHLIGHT mask: ${hlMask.size}/${values.length} rows kept (across ${hlSourceCount} value columns)`);
            // Mix the mask into the upstreamKey: digest = "hl:size:firstIdx:lastIdx".
            // Two different highlight patterns of the same size would still produce
            // the same digest if their first+last match, but for ALL realistic
            // selection patterns this is unique enough to bust the cache fallback.
            const arr = Array.from(hlMask).sort((a, b) => a - b);
            const digest = `hl:${arr.length}:${arr[0] ?? -1}:${arr[arr.length - 1] ?? -1}`;
            upstreamKey += "␟" + digest;
        }
        const upstreamChanged = upstreamKey !== tog.lastUpstreamKey;
        tog.lastUpstreamKey = upstreamKey;
        this.log(`  parseToggle(${tog.queryName}) ENTRY cat.len=${values.length} upstream=[${upstreamConstraints}] upstreamChanged=${upstreamChanged} hlMask=${hlMask ? hlMask.size : "none"} selectedValue=${tog.selectedValue} selectedSet={${Array.from(tog.selectedSet).join(",")}}`);

        // Pre-compute Set<string> per upstream constraint so the per-row mask check is O(1)
        const upstreamSets: (Set<string> | null)[] = constraints.slice(0, togIdx).map(arr =>
            arr && arr.length > 0 ? new Set(arr) : null
        );
        const distinct: { raw: powerbi.PrimitiveValue; idx: number }[] = [];
        const seen = new Set<string>();
        let rowsKept = 0;
        let rowsSkipped = 0;
        for (let r = 0; r < values.length; r++) {
            // External cross-filter (highlight mode): drop rows the source
            // visual didn't highlight.
            if (hlMask && !hlMask.has(r)) { rowsSkipped++; continue; }

            // Slicer cascade: row must satisfy every upstream toggle's selection
            // (multi-select = OR-match against any value in the upstream's set).
            let matches = true;
            for (let j = 0; j < togIdx; j++) {
                const otherSet = upstreamSets[j];
                if (otherSet == null) continue; // cleared upstream → no constraint
                const otherCat = this.toggles[j].cat;
                const otherVal = otherCat?.values?.[r];
                const otherStr = otherVal == null ? "(blank)" : String(otherVal);
                if (!otherSet.has(otherStr)) { matches = false; break; }
            }
            if (!matches) { rowsSkipped++; continue; }

            // ── Blank-value filter (per /generic-pbi-blank-row-col-filter) ──
            // Skip rows whose field value is null OR an empty/whitespace-only
            // string. These rows appear when:
            //   • the column has genuine NULL cells in the source data
            //   • "Show items with no data" is enabled in the field well —
            //     PBI emits rows for categories that have no fact rows
            //   • cross-filter from another visual leaves a category with no
            //     fact data but PBI still keeps the dim row
            // None of those produce a meaningful toggle button; drop them.
            // (PBI already drops cross-product rows where every bound measure
            // returns BLANK — see capabilities.json defaultValue description —
            // so we only need to handle the field-value case here.)
            const fv = values[r];
            if (fv == null) { rowsSkipped++; continue; }
            if (typeof fv === "string" && fv.trim() === "") { rowsSkipped++; continue; }

            rowsKept++;
            const k = String(fv);
            if (seen.has(k)) continue;
            seen.add(k);
            distinct.push({ raw: fv, idx: r });
            // No upper cap — let the visual render whatever PBI's dataReductionAlgorithm
            // delivers. The toggle pill stretches via flexbox so any count fits;
            // symbols A/B/C are the only labelled positions, sides D+ render label-only.
        }
        const n = distinct.length;
        const distinctTrace = distinct.map(d => `${d.raw == null ? "(blank)" : String(d.raw)}<${typeof d.raw}>@${d.idx}`).join(", ");
        this.log(`  parseToggle(${tog.queryName}) MASK rowsKept=${rowsKept} rowsSkipped=${rowsSkipped} distinct.n=${n} [${distinctTrace}]`);

        // Cache fallback (NARROWED): only fires for an UPSTREAM-CASCADE pass-through
        // that lost ONE item (off-by-one PBI artifact during transitional updates).
        // The original behavior — fire whenever n < cache.length & upstream unchanged
        // — over-preserved cached buttons when an EXTERNAL visual cross-filtered our
        // dataView (PBI legitimately reduces cat.values; we must respect that). With
        // single-toggle visuals (no cascade) the fallback fired on every external
        // filter and showed stale buttons. Now we only preserve cache for the very
        // specific cascade-transition off-by-one case (togIdx > 0 = downstream
        // toggle, n exactly cache.length - 1).
        const hasUpstream = togIdx > 0;
        if (hasUpstream && !upstreamChanged && n === tog.cachedItems.length - 1 && tog.cachedItems.length >= 2) {
            this.log(`  parseToggle(${tog.queryName}) CACHE-FALLBACK (off-by-one cascade) n=${n} cache=${tog.cachedItems.length} → keep cached items`);
            tog.items = tog.cachedItems;
            return { ok: true, distinctCount: n };
        }

        // Helper: rebuild items in cached order when the value SET matches cache, else
        // rebuild in cat order and reset cache. Always uses fresh selectionIds (PBI's
        // QueryGenerator needs current SQExpr at applyJsonFilter time).
        const rebuildItemsForN = (expectedN: number): void => {
            const currentValues = distinct.map(d => d.raw == null ? "(blank)" : String(d.raw));
            const cachedValues = tog.cachedItems.map(i => i.value);
            // Set-equality preserves cached A/B/… order against PBI cross-product reshuffles.
            // BUT: a real sort-by-column change also reshuffles cat.values; in that case we
            // WANT to rebuild in the new (sort-by-column-driven) order. sortChanged forces
            // the rebuild branch even when the value set itself is unchanged.
            const sameSet = !sortChanged &&
                cachedValues.length === expectedN && currentValues.length === expectedN &&
                cachedValues.every(v => currentValues.indexOf(v) !== -1);
            if (sameSet) {
                tog.items = cachedValues.map(cv => {
                    const d = distinct.find(dd =>
                        (dd.raw == null ? "(blank)" : String(dd.raw)) === cv);
                    const sid = this.host.createSelectionIdBuilder()
                        .withCategory(cat, d!.idx)
                        .createSelectionId();
                    return { value: cv, display: cv, selectionId: sid, rowIdx: d!.idx };
                });
            } else {
                tog.items = distinct.map((d) => {
                    const sid = this.host.createSelectionIdBuilder()
                        .withCategory(cat, d.idx)
                        .createSelectionId();
                    const display = d.raw == null ? "(blank)" : String(d.raw);
                    return { value: display, display, selectionId: sid, rowIdx: d.idx };
                });
                tog.cachedItems = tog.items;
                // DELIBERATELY do NOT reset hasRestoredSelection here. The "set
                // changed" trigger fires on every external filter (cross-filter
                // from another visual narrows the toggle's available values),
                // and resetting hasRestoredSelection would re-run the first-bind
                // auto-default path on every filter — which would auto-select a
                // value the user never asked for. hasRestoredSelection is reset
                // ONLY on actual field rebinding (queryName change), handled
                // earlier in parseToggle.
            }
        };

        if (n >= 2) {
            const cachedLenBefore = tog.cachedItems.length;
            rebuildItemsForN(n);
            this.log(`  parseToggle(${tog.queryName}) n>=2 BRANCH expectedN=${n} cachedItems.length: ${cachedLenBefore} → ${tog.cachedItems.length} hasRestoredSelection=${tog.hasRestoredSelection}`);

            // Driver evaluation — drives first-bind default and post-bind re-eval when
            // the measure's chosen default changes (context shift). lastDriverVal tells
            // a real change from a no-op echo from persistProperties round-trips.
            const driverVal = this.getDriverDefaultForToggle(togIdx, distinct);
            const driverChanged = driverVal !== tog.lastDriverVal;
            const driverInItems = driverVal != null && tog.items.some(it => it.value === driverVal);

            if (!tog.hasRestoredSelection) {
                tog.hasRestoredSelection = true;
                const persistedArr = persistedMap[tog.queryName];
                const force = this.resolveBool("selection", "forceSelection", tog.queryName, false);
                const validItems = (arr: string[]): string[] =>
                    arr.filter(v => tog.items.some(it => it.value === v));
                if (persistedArr && persistedArr.length === 1 && persistedArr[0] === "" && !force) {
                    // "" sentinel = user explicitly cleared. Preserve cleared state across
                    // cascades; Force ON overrides — fall through.
                    this.clearSelection(tog);
                    this.log(`  parseToggle(${tog.queryName}) n=${n}: first bind — restored cleared`);
                } else if (persistedArr && validItems(persistedArr).length > 0) {
                    const valid = validItems(persistedArr);
                    this.setSelection(tog, valid);
                    this.log(`  parseToggle(${tog.queryName}) n=${n}: first bind — restored from persisted=[${valid.join(",")}]`);
                } else if (driverInItems) {
                    this.setSelection(tog, [driverVal!]);
                    this.log(`  parseToggle(${tog.queryName}) n=${n}: first bind — measure-driven default=${driverVal}`);
                } else {
                    this.setSelection(tog, [tog.items[0].value]);
                    this.log(`  parseToggle(${tog.queryName}) n=${n}: first bind — force-default A=${tog.items[0].value}${force ? " (Force ON, ignoring \"\" sentinel)" : ""}`);
                }
            } else if (driverChanged && driverInItems) {
                this.log(`  parseToggle(${tog.queryName}) n=${n}: driver re-fired ${tog.selectedValue} → ${driverVal}`);
                this.setSelection(tog, [driverVal!]);
            } else if (tog.selectedSet.size === 0 &&
                this.resolveBool("selection", "forceSelection", tog.queryName, false)) {
                // Force-Selection retroactivity: the toggle is currently cleared AND
                // Force Selection is now ON. Re-select to the driver value if available,
                // else default A. Catches the case where the author flips Force ON after
                // the user has already deselected.
                if (driverInItems) {
                    this.setSelection(tog, [driverVal!]);
                    this.log(`  parseToggle(${tog.queryName}) n=${n}: force-reactivate (driver)=${driverVal}`);
                } else {
                    this.setSelection(tog, [tog.items[0].value]);
                    this.log(`  parseToggle(${tog.queryName}) n=${n}: force-reactivate (default A)=${tog.items[0].value}`);
                }
            } else {
                // Cascade-reset: drop selectedSet entries no longer in items.
                // If the resulting set is empty (e.g., user's selection isn't in
                // the externally-filtered context anymore), CLEAR — never auto-snap
                // to first. A native slicer doesn't auto-select on external filter,
                // and neither should this. Force Selection is the one exception: it
                // explicitly opts into "no empty state", so under Force we DO snap.
                const before = tog.selectedSet.size;
                const filtered = Array.from(tog.selectedSet).filter(v =>
                    tog.items.some(it => it.value === v));
                if (filtered.length !== before) {
                    if (filtered.length === 0 && before > 0) {
                        const force = this.resolveBool("selection", "forceSelection", tog.queryName, false);
                        if (force) {
                            this.setSelection(tog, [tog.items[0].value]);
                            this.log(`  parseToggle(${tog.queryName}) n=${n}: cascade-reset (all dropped, Force ON) → ${tog.items[0].value}`);
                        } else {
                            this.clearSelection(tog);
                            this.log(`  parseToggle(${tog.queryName}) n=${n}: cascade-reset (all dropped) → cleared`);
                        }
                    } else {
                        this.setSelection(tog, filtered);
                        this.log(`  parseToggle(${tog.queryName}) n=${n}: cascade-trim → [${filtered.join(",")}]`);
                    }
                } else {
                    this.log(`  parseToggle(${tog.queryName}) n=${n}: preserve selectedSet={${Array.from(tog.selectedSet).join(",")}}`);
                }
            }
            tog.lastDriverVal = driverVal;
            return { ok: true, distinctCount: n };
        } else if (n === 1) {
            // Genuine single-value field — render as a single-button toggle.
            // Click toggles between selected (filter active) and cleared (null).
            const v = distinct[0];
            const display = v.raw == null ? "(blank)" : String(v.raw);
            const cachedSame = tog.cachedItems.length === 1 && tog.cachedItems[0].value === display;

            tog.items = [{
                value: display,
                display,
                selectionId: this.host.createSelectionIdBuilder().withCategory(cat, v.idx).createSelectionId(),
                rowIdx: v.idx
            }];
            if (!cachedSame) {
                tog.cachedItems = tog.items;
                // Same rationale as the n>=2 branch: do NOT reset
                // hasRestoredSelection on every "value changed" — that would
                // re-trigger the first-bind auto-default on each external
                // filter. Reset only on actual field rebinding.
            }

            if (!tog.hasRestoredSelection) {
                tog.hasRestoredSelection = true;
                const persistedArr = persistedMap[tog.queryName];
                const force = this.resolveBool("selection", "forceSelection", tog.queryName, false);
                if (persistedArr && persistedArr.length === 1 && persistedArr[0] === "" && !force) {
                    this.clearSelection(tog);
                    this.log(`  parseToggle(${tog.queryName}): first bind (n=1) — restored cleared`);
                } else if (persistedArr && persistedArr.indexOf(display) >= 0) {
                    this.setSelection(tog, [display]);
                    this.log(`  parseToggle(${tog.queryName}): first bind (n=1) — restored from persisted=${display}`);
                } else {
                    // Default to selected: a single-value field's natural state is "filter on".
                    this.setSelection(tog, [display]);
                    this.log(`  parseToggle(${tog.queryName}): first bind (n=1) — default selected=${display}${force ? " (Force ON, ignoring \"\" sentinel)" : ""}`);
                }
            } else if (tog.selectedValue != null && tog.selectedValue !== display) {
                // Cascade-reset (n=1): user had a previous selection that's no
                // longer in the filtered context. Clear instead of auto-snapping
                // to the (now lone) remaining value — auto-selecting on external
                // filter is the wrong UX. Force Selection is the only override.
                const force = this.resolveBool("selection", "forceSelection", tog.queryName, false);
                if (force) {
                    this.setSelection(tog, [display]);
                    this.log(`  parseToggle(${tog.queryName}): cascade-reset (n=1, Force ON) → ${display}`);
                } else {
                    this.clearSelection(tog);
                    this.log(`  parseToggle(${tog.queryName}): cascade-reset (n=1) → cleared`);
                }
            } else if (tog.selectedSet.size === 0 &&
                this.resolveBool("selection", "forceSelection", tog.queryName, false)) {
                // Force-Selection retroactivity (n=1).
                this.setSelection(tog, [display]);
                this.log(`  parseToggle(${tog.queryName}): force-reactivate (n=1) → ${tog.selectedValue}`);
            } else {
                this.log(`  parseToggle(${tog.queryName}): preserve selectedValue=${tog.selectedValue} (n=1)`);
            }
            return { ok: true, distinctCount: 1 };
        } else if (n === 0 && tog.cachedItems.length >= 1) {
            // Filtered down to nothing — preserve cached UI so layout stays stable.
            tog.items = tog.cachedItems;
            return { ok: true, distinctCount: 0 };
        }
        // n === 0 fresh or n >= 3 → not usable
        return { ok: false, distinctCount: n };
    }

    // ── Selection state helpers (keep selectedValue + selectedSet in sync) ─

    /** Replace the toggle's full active set with `vals`. selectedValue follows the LAST
     *  entry of `vals` (so it tracks the most-recently-added value for thumb anchoring),
     *  or null when the set is empty. Use this for fresh restores / driver / default-A. */
    private setSelection(tog: ToggleState, vals: string[]): void {
        const filtered = vals.filter(v => typeof v === "string");
        tog.selectedSet = new Set(filtered);
        tog.selectedValue = filtered.length > 0 ? filtered[filtered.length - 1] : null;
    }

    /** Add a single value to the active set (multi-select click). Updates selectedValue
     *  to point at the freshly-added value so the thumb glides there if size drops to 1. */
    private addSelection(tog: ToggleState, val: string): void {
        tog.selectedSet.add(val);
        tog.selectedValue = val;
    }

    /** Remove a single value from the active set. Updates selectedValue to the next
     *  remaining entry (set iteration order = insertion order in JS) or null if empty. */
    private removeSelection(tog: ToggleState, val: string): void {
        tog.selectedSet.delete(val);
        if (tog.selectedValue === val) {
            // Pick the most-recently-inserted remaining entry as the new primary
            let last: string | null = null;
            for (const v of tog.selectedSet) last = v;
            tog.selectedValue = last;
        }
    }

    /** Clear the entire active set. */
    private clearSelection(tog: ToggleState): void {
        tog.selectedSet.clear();
        tog.selectedValue = null;
    }

    /** Resolved per-toggle multi-select flag (Apply-to chain → slot → "all" default → false). */
    private isMultiSelect(tog: ToggleState): boolean {
        return this.resolveBool("selection", "multiSelect", tog.queryName, false);
    }

    // ── Persistence (JSON map by queryName, with single-value back-compat) ─

    /** Map qn → string[]. Single-select toggles persist [val] (or [""] for "explicitly
     *  cleared"); multi-select persists the full array. Back-compat: a string value in
     *  the persisted JSON is wrapped to [val]. The legacy single-string `selectedValue`
     *  sentinel still seeds the first toggle when no map is found. */
    private readPersistedMap(dv: DataView | undefined): Record<string, string[]> {
        if (!dv) return {};
        const tb = (dv?.metadata?.objects as { toolbar?: { selectedValue?: string; selectedValues?: string } } | undefined)?.toolbar;
        const raw = typeof tb?.selectedValues === "string" ? tb.selectedValues : "";
        if (raw) {
            try {
                const parsed = JSON.parse(raw);
                if (parsed && typeof parsed === "object") {
                    const out: Record<string, string[]> = {};
                    for (const k of Object.keys(parsed)) {
                        const v = (parsed as Record<string, unknown>)[k];
                        if (Array.isArray(v)) {
                            out[k] = v.filter(x => typeof x === "string") as string[];
                        } else if (typeof v === "string") {
                            // Back-compat: previously persisted as a flat string-per-qn map.
                            out[k] = [v];
                        }
                    }
                    return out;
                }
            } catch (e) { /* fall through to legacy single value */ }
        }
        // Legacy single-value: pin to the first toggle's queryName when only one is bound.
        const legacy = typeof tb?.selectedValue === "string" ? tb.selectedValue : "";
        if (legacy && this.toggles.length >= 1) {
            return { [this.toggles[0].queryName]: [legacy] };
        }
        return {};
    }

    private persistAll(): void {
        const map: Record<string, string[]> = {};
        for (const t of this.toggles) {
            // Always persist — [""] sentinel marks "explicitly cleared" so single-value
            // toggles can restore an off state across reloads. Empty selectedSet (e.g.
            // user just deselected everything) gets [""].
            map[t.queryName] = t.selectedSet.size > 0
                ? Array.from(t.selectedSet)
                : [""];
        }
        this.host.persistProperties({
            merge: [{
                objectName: "toolbar",
                properties: { selectedValues: JSON.stringify(map) },
                selector: null as unknown as powerbi.data.Selector
            }]
        });
    }

    /** Build an IBasicFilter (column-scoped In filter) from a category column + raw
     *  cat.values[] entry. Passes the **native typed value** (number / Date / string /
     *  bool) directly so PBI's filter engine matches correctly — sending a stringified
     *  "2024" to an integer column silently drops the filter. Returns null if we can't
     *  extract a clean { table, column } target. */
    private buildBasicFilter(cat: powerbi.DataViewCategoryColumn, rawValues: powerbi.PrimitiveValue[]): unknown | null {
        const source = cat.source as { queryName?: string; expr?: { source?: { entity?: string }; ref?: string } } | undefined;
        let table = "";
        let column = "";
        // queryName is the most reliable signal — it's what every Microsoft-published
        // slicer (SampleSlicer, HierarchySlicer) splits on. expr.source.entity may
        // resolve to an internal entity name that doesn't match the user-visible
        // table reference other visuals are bound to, breaking cross-filter.
        if (source?.queryName) {
            const qn = source.queryName;
            const dotIdx = qn.indexOf(".");
            if (dotIdx > 0) {
                table = qn.substring(0, dotIdx);
                column = qn.substring(dotIdx + 1);
            }
        }
        // Last-resort fallback to expr if queryName is missing
        if ((!table || !column) && source?.expr?.source?.entity && source?.expr?.ref) {
            table = source.expr.source.entity;
            column = source.expr.ref;
        }
        this.log(`  buildBasicFilter qn=${source?.queryName} → target={table:${table}, column:${column}} values=[${rawValues.map(v => `${v}<${typeof v}>`).join(", ")}]`);
        if (!table || !column) return null;
        if (rawValues.length === 0) return null;
        // IBasicFilter shape — matches Microsoft SampleSlicer & HierarchySlicer.
        // Note the http (not https) schema URL — that's what powerbi-models v1
        // emits and what PBI Desktop's validator accepts cross-version.
        return {
            $schema: "http://powerbi.com/product/schema#basic",
            target: { table, column },
            operator: "In",
            values: rawValues,
            filterType: 1 // FilterType.Basic
        };
    }

    /** Apply the union of every toggle's currently-active selection as per-column basic
     *  filters via host.applyJsonFilter. This is column-scoped (not row-scoped like
     *  withCategory selectionIds), so deselecting one toggle truly removes its filter
     *  contribution — siblings on the page see only the remaining toggles' filters.
     *
     *  selectedValue is stored as a stringified display value, but `cat.values[]` keeps
     *  the native typed entries (number / Date / string / bool). We round-trip through
     *  cat.values[idx] so the filter receives the column's native type. */
    private commitSelections(): void {
        const filters: unknown[] = [];
        const tracelog: string[] = [];
        for (const t of this.toggles) {
            if (t.selectedSet.size === 0) continue;
            const cat = t.cat;
            if (!cat?.source || !Array.isArray(cat.values)) continue;

            // For each selected display value, find the FIRST cat.values entry whose
            // stringified form matches and grab the native typed value. De-dupe by
            // stringified key so the filter doesn't carry redundant entries when the
            // same value appears in multiple cross-product rows.
            const rawValues: powerbi.PrimitiveValue[] = [];
            const seenKeys = new Set<string>();
            const wanted = t.selectedSet;
            const catValues = cat.values as powerbi.PrimitiveValue[];
            for (let i = 0; i < catValues.length; i++) {
                const v = catValues[i];
                const k = v == null ? "(blank)" : String(v);
                if (!wanted.has(k) || seenKeys.has(k)) continue;
                seenKeys.add(k);
                rawValues.push(v);
            }
            if (rawValues.length === 0) continue;
            const f = this.buildBasicFilter(cat, rawValues);
            if (f) {
                filters.push(f);
                tracelog.push(`${t.queryName}=[${rawValues.map(v => `${v}<${typeof v}>`).join(",")}]`);
            }
        }
        const action = filters.length === 0
            ? 1 /* FilterAction.remove */
            : 0 /* FilterAction.merge */;
        this.log(`commitSelections() applyJsonFilter filters=${filters.length} action=${action} [${tracelog.join(", ")}]`);
        for (let i = 0; i < filters.length; i++) {
            this.log(`  filter[${i}]=${JSON.stringify(filters[i])}`);
        }
        try {
            (this.host.applyJsonFilter as unknown as (
                f: unknown, objectName: string, propertyName: string, action: number
            ) => void)(filters, "general", "filter", action);
            this.log(`  applyJsonFilter OK`);
        } catch (e) {
            this.log(`  applyJsonFilter THREW: ${(e as Error)?.message || e}`);
            console.error("[ToggleButton] applyJsonFilter error:", e);
        }
    }

    private resyncAllFromSelectionManager(): void {
        // Intentionally a no-op. Reading liveSelIds via .equals() is unreliable with
        // cross-product cat identities (false-positive matches always pick items[0]),
        // and writing the result back would also undo independent state across multiple
        // instances of this visual — exactly the loop we're trying to break. Each
        // instance owns its own selectedValue; cross-filter to other visuals is one-way
        // (commit → host); read-back is not attempted.
    }

    // ── Click handling ─────────────────────────────────────────────────

    private onButtonClick(toggleIdx: number, sideIdx: number): void {
        const tog = this.toggles[toggleIdx];
        if (!tog || tog.items.length === 0) return;
        if (sideIdx < 0 || sideIdx >= tog.items.length) return;
        const clicked = tog.items[sideIdx];
        if (!clicked) return;
        const isMulti = this.isMultiSelect(tog);
        const force = this.resolveBool("selection", "forceSelection", tog.queryName, false);
        const wasActive = tog.selectedSet.has(clicked.value);
        this.log(`onButtonClick(idx=${toggleIdx} qn=${tog.queryName} side=${sideIdx} clicked=${clicked.value} multi=${isMulti} wasActive=${wasActive} prevSet={${Array.from(tog.selectedSet).join(",")}})`);

        if (isMulti) {
            // Multi-select: toggle membership in the set.
            if (wasActive) {
                // Removing the only remaining selected item AND Force is ON → ignore
                // (preserves the no-empty-state guarantee for multi-select too).
                if (force && tog.selectedSet.size === 1) {
                    this.log(`  → multi: removing last under Force ignored`);
                    return;
                }
                this.removeSelection(tog, clicked.value);
                this.log(`  → multi: removed; now {${Array.from(tog.selectedSet).join(",")}}`);
            } else {
                this.addSelection(tog, clicked.value);
                this.log(`  → multi: added; now {${Array.from(tog.selectedSet).join(",")}}`);
            }
        } else {
            // Single-select: existing replace-or-clear behavior.
            if (wasActive) {
                if (force) {
                    this.log(`  → click on active ignored (Force Selection ON)`);
                    return;
                }
                this.clearSelection(tog);
                this.log(`  → toggled off`);
            } else {
                this.setSelection(tog, [clicked.value]);
                this.log(`  → set to ${clicked.value}`);
            }
        }

        this.commitSelections();
        this.persistAll();
        this.refreshActiveClasses(tog);
        this.applyButtonColors(tog);
        this.positionThumb(tog);
    }

    private refreshActiveClasses(tog: ToggleState): void {
        const isMulti = this.isMultiSelect(tog);
        // In multi-select with size > 1, the thumb is hidden (positionThumb removes
        // tb-ready); the .multi-active class on each selected button drives the visual
        // fill so the active set is still visible.
        const showMultiFill = isMulti && tog.selectedSet.size > 1;
        for (let i = 0; i < tog.btnEls.length; i++) {
            const item = tog.items[i];
            const isActive = !!(item && tog.selectedSet.has(item.value));
            tog.btnEls[i].classList.toggle("is-active", isActive);
            tog.btnEls[i].classList.toggle("multi-active", isActive && showMultiFill);
            tog.btnEls[i].setAttribute("aria-pressed", String(isActive));
        }
    }

    /** Per-button label/symbol color + per-button glow + active-row thumb glow.
     *  Each button gets its OWN `--btn-glow-color` CSS variable based on its row's FX
     *  color, so the hover preview matches the hovered button (not the active button's
     *  color). The block-level `--thumb-glow-color` still drives the active thumb. */
    private applyButtonColors(tog: ToggleState): void {
        // Per-button colors: label, symbol, AND per-button glow color (drives hover preview)
        for (let i = 0; i < tog.btnEls.length; i++) {
            const item = tog.items[i];
            const btnEl = tog.btnEls[i];
            const lblEl = tog.lblEls[i];
            const symEl = tog.symEls[i];
            if (!item || !btnEl || !lblEl || !symEl) continue;
            const isActive = tog.selectedSet.has(item.value);
            const labelColor = isActive
                ? this.colorForRow(tog, item.rowIdx, "text", "labelActiveColor",   "#F1F5F9")
                : this.colorForRow(tog, item.rowIdx, "text", "labelInactiveColor", "#94A3B8");
            const symColor = isActive
                ? this.colorForRow(tog, item.rowIdx, "text", "symbolActiveColor",   "#60A5FA")
                : this.colorForRow(tog, item.rowIdx, "text", "symbolInactiveColor", "#94A3B8");
            const btnGlowHex = this.colorForRow(tog, item.rowIdx, "thumb", "thumbGlowColor", "#60A5FA");
            lblEl.style.color = labelColor;
            symEl.style.color = symColor;
            btnEl.style.setProperty("--btn-glow-color", hexToRgbTriplet(btnGlowHex));

            // Per-button shimmer color — driven by the animation.shimmerColor FX rule.
            // Each button reads its OWN row's resolved color so the sweep tints each
            // value differently while all bands stay synchronized to the same keyframe
            // (one continuous wave across the toggle in N distinct colors).
            const btnShimmerHex = this.colorForRow(tog, item.rowIdx, "animation", "shimmerColor", "#FFFFFF");
            btnEl.style.setProperty("--btn-shimmer-rgb", hexToRgbTriplet(btnShimmerHex, "255, 255, 255"));
        }

        // Thumb glow color follows the PRIMARY active button's row (selectedValue tracks
        // the most-recent click in multi-select). Falls back to the toggle-level constant
        // when no selection is active.
        const blk = tog.blockEl;
        if (blk) {
            const activeIdx = tog.items.findIndex(it => it.value === tog.selectedValue);
            const activeRowIdx = activeIdx >= 0 ? tog.items[activeIdx].rowIdx : -1;
            const accentHex = activeRowIdx >= 0
                ? this.colorForRow(tog, activeRowIdx, "thumb", "thumbGlowColor", "#60A5FA")
                : this.resolveColor("thumb", "thumbGlowColor", tog.queryName, "#60A5FA");
            const accentTriplet = hexToRgbTriplet(accentHex);
            blk.style.setProperty("--thumb-glow-color", accentTriplet);
            blk.style.setProperty("--thumb-bg-top", `rgba(${accentTriplet}, 0.18)`);
            blk.style.setProperty("--thumb-bg-bot", `rgba(${accentTriplet}, 0.06)`);
            blk.style.setProperty("--thumb-border", `rgba(${accentTriplet}, 0.35)`);
        }
    }

    // ── Rendering ──────────────────────────────────────────────────────

    private clearRoot(): void {
        // Disconnect every per-toggle resize observer before nuking the DOM
        for (const t of this.toggles) {
            if (t.resizeObs) { t.resizeObs.disconnect(); t.resizeObs = null; }
            t.blockEl = null; t.titleEl = null; t.wrapEl = null; t.toggleEl = null; t.trackEl = null;
            t.btnEls = []; t.symEls = []; t.lblEls = [];
        }
        while (this.root.firstChild) this.root.removeChild(this.root.firstChild);
        for (const cls of POSITION_CLASSES) this.root.classList.remove(cls);
        this.root.classList.remove("tb-orient-vertical", "tb-orient-horizontal");
        this.togglesWrapEl = null;
    }

    private renderLanding(): void {
        this.clearRoot();
        this.lastRenderKey = "";
        const box = document.createElement("div");
        box.className = "tb-landing";
        const title = document.createElement("div");
        title.className = "tb-landing-title";
        title.textContent = "Toggle Button";
        const sub = document.createElement("div");
        sub.className = "tb-landing-sub";
        sub.textContent = "Bind 1–5 fields. Each toggle renders one button per distinct value (no fixed upper limit, capped by Power BI's data reduction).";
        box.appendChild(title);
        box.appendChild(sub);
        this.root.appendChild(box);
    }

    private renderError(n: number): void {
        this.clearRoot();
        this.lastRenderKey = "";
        const box = document.createElement("div");
        box.className = "tb-landing tb-error";
        const title = document.createElement("div");
        title.className = "tb-landing-title";
        title.textContent = "No data";
        const sub = document.createElement("div");
        sub.className = "tb-landing-sub";
        sub.textContent = "Bound field has no rows.";
        box.appendChild(title);
        box.appendChild(sub);
        this.root.appendChild(box);
    }

    /** Resolve the per-toggle title triple (show, text, validPos) using the Apply-to chain. */
    private resolveTitleForToggle(qn: string): { show: boolean; text: string; validPos: string } {
        const text = this.resolveText("title", "titleText", qn, "").trim();
        const showFlag = this.resolveBool("title", "showTitle", qn, true);
        const show = showFlag && text !== "";
        const rawPos = this.resolveDropdown("title", "titlePosition", qn, "top-left");
        const validPos = POSITION_CLASSES.indexOf("pos-" + rawPos) >= 0 ? rawPos : "top-left";
        return { show, text, validPos };
    }

    /** Resolve the per-toggle content fields using the Apply-to chain. */
    private resolveContentForToggle(qn: string): {
        showSymbols: boolean; symbolA: string; symbolB: string; symbolC: string;
        showLabels: boolean; symbolFontSize: number; labelFontSize: number;
    } {
        return {
            showSymbols:    this.resolveBool("content", "showSymbols", qn, true),
            symbolA:        this.resolveText("content", "symbolA", qn, ""),
            symbolB:        this.resolveText("content", "symbolB", qn, ""),
            symbolC:        this.resolveText("content", "symbolC", qn, ""),
            showLabels:     this.resolveBool("content", "showLabels", qn, true),
            symbolFontSize: this.resolveNum ("content", "symbolFontSize", qn, 12),
            labelFontSize:  this.resolveNum ("content", "labelFontSize", qn, 12)
        };
    }

    private renderAll(): void {
        this.clearRoot();

        const s = this.fmtSettings;

        // Auto orientation: vertical if ANY toggle's resolved title position is left/right.
        const orientMode = (s.orientation.mode.value as { value?: string })?.value || "auto";
        let orientation: "vertical" | "horizontal";
        if (orientMode === "vertical") orientation = "vertical";
        else if (orientMode === "horizontal") orientation = "horizontal";
        else {
            const anyLeftRight = this.toggles.some(t => {
                const { show, validPos } = this.resolveTitleForToggle(t.queryName);
                return show && (validPos === "left" || validPos === "right");
            });
            orientation = anyLeftRight ? "vertical" : "horizontal";
        }
        this.root.classList.add(`tb-orient-${orientation}`);

        const togglesWrap = document.createElement("div");
        togglesWrap.className = "tb-toggles-wrap";
        // Tag with the resolved orientation so CSS picks the right axis for
        // overflow + mask. is-axis-x = horizontal scroll, is-axis-y = vertical.
        togglesWrap.classList.add(orientation === "vertical" ? "is-axis-y" : "is-axis-x");
        this.togglesWrapEl = togglesWrap;
        this.root.appendChild(togglesWrap);

        // Wire scroll + edge fade + drag at the wrap level. When the user binds
        // multiple fields and the visual container can't fit them all, the wrap
        // scrolls along its layout axis (horizontal in row orientation, vertical
        // in column orientation). Same edge-fade + drag UX as the per-toggle track.
        this.attachScrollInteractions(
            togglesWrap,
            orientation === "vertical" ? "y" : "x",
            "wrap"
        );

        // Right-click context menu — uses any single-toggle's selection if one is set
        this.root.addEventListener("contextmenu", (e: MouseEvent) => {
            const first = this.toggles.find(t => t.selectedValue != null);
            const sid = first ? first.items.find(i => i.value === first.selectedValue)?.selectionId : null;
            this.selectionManager.showContextMenu(sid || ({} as ISelectionId), { x: e.clientX, y: e.clientY });
            e.preventDefault();
        });

        // Render one .tb-block per toggle, with per-toggle resolved Title + Content fields
        for (let i = 0; i < this.toggles.length; i++) {
            const tog = this.toggles[i];
            if (tog.items.length < 1) continue;
            const t = this.resolveTitleForToggle(tog.queryName);
            const c = this.resolveContentForToggle(tog.queryName);
            this.renderToggleBlock(tog, i, {
                showTitle: t.show, titleText: t.text, validPos: t.validPos,
                showSymbols: c.showSymbols, showLabels: c.showLabels,
                symA: c.symbolA, symB: c.symbolB, symC: c.symbolC
            });
            togglesWrap.appendChild(tog.blockEl!);
        }
    }

    private renderToggleBlock(
        tog: ToggleState, idx: number,
        opts: {
            showTitle: boolean; titleText: string; validPos: string;
            showSymbols: boolean; showLabels: boolean; symA: string; symB: string; symC: string;
        }
    ): void {
        const block = document.createElement("div");
        block.className = "tb-block";
        block.setAttribute("data-toggle-idx", String(idx));
        if (opts.showTitle) block.classList.add("pos-" + opts.validPos);
        tog.blockEl = block;

        if (opts.showTitle) {
            const titleEl = document.createElement("div");
            titleEl.className = "tb-title";
            titleEl.textContent = opts.titleText;
            block.appendChild(titleEl);
            tog.titleEl = titleEl;
        }

        const wrap = document.createElement("div");
        wrap.className = "tb-wrap";
        tog.wrapEl = wrap;

        const toggle = document.createElement("div");
        toggle.className = "tb-toggle";
        toggle.setAttribute("role", "group");
        tog.toggleEl = toggle;

        // Inner scroll track. Hosts the sliding thumb (::before) and the buttons.
        // .tb-toggle is the visible pill chrome; .tb-toggle-track is the scroll
        // viewport — overflow-x:auto, scrollbar hidden, edge fade via mask-image,
        // drag-to-scroll via pointer events. When buttons fit, looks identical
        // to before. When they overflow (e.g. 12 months at fixed size in a small
        // container), the track scrolls horizontally without showing a scrollbar.
        const track = document.createElement("div");
        track.className = "tb-toggle-track";
        tog.trackEl = track;
        toggle.appendChild(track);

        tog.btnEls = [];
        tog.symEls = [];
        tog.lblEls = [];
        const sideCount = Math.max(tog.items.length, 1);
        for (let i = 0; i < sideCount; i++) {
            const { btn, sym, lbl } = this.buildButton(tog, idx, i);
            track.appendChild(btn);
            tog.btnEls.push(btn);
            tog.symEls.push(sym);
            tog.lblEls.push(lbl);
        }
        wrap.appendChild(toggle);
        block.appendChild(wrap);

        this.refreshActiveClasses(tog);
        this.attachTrackInteractions(tog);

        // Per-toggle resize observer — recompute thumb position AND edge-fade
        // visibility classes when the toggle's size changes (window resize,
        // adding/removing buttons, format-pane size change).
        if (typeof ResizeObserver !== "undefined") {
            tog.resizeObs = new ResizeObserver(() => {
                requestAnimationFrame(() => {
                    this.positionThumb(tog);
                    this.updateEdgeFades(tog);
                });
            });
            tog.resizeObs.observe(toggle);
        }
    }

    /** Wire pointer-drag scroll + scroll-driven edge-fade visibility for ONE
     *  toggle's track (always horizontal). Idempotent at the listener level:
     *  each render rebuilds the track DOM, so listeners are fresh per render. */
    private attachTrackInteractions(tog: ToggleState): void {
        if (!tog.trackEl) return;
        // Axis depends on the Values Layout setting. Horizontal (default): the
        // track is a row of buttons that can scroll left/right. Vertical: the
        // track is a column of buttons that can scroll top/bottom. Read directly
        // from settings since this fires from renderToggleBlock (full DOM rebuild)
        // and the orientation card is global.
        const layout = (this.fmtSettings.orientation.valuesLayout.value as { value?: string })?.value || "horizontal";
        const axis = layout === "vertical" ? "y" : "x";
        this.attachScrollInteractions(tog.trackEl, axis, `track[${tog.queryName}]`);
    }

    /** Generic scroll-interaction wiring for any horizontally OR vertically
     *  scrollable element. Adds:
     *    • Scroll listener that flips .has-overflow-{l|r|t|b} classes (drives
     *      the conditional mask-image edge fade in CSS).
     *    • Pointer-drag scroll (mouse + pen + touch via Pointer Events).
     *    • Click suppression after a real drag (>5px) so dragging doesn't
     *      activate buttons under the cursor.
     *    • Wheel-to-scroll translation: vertical mouse wheel scrolls the
     *      element along its axis, even if the browser would normally route
     *      vertical wheel to a parent.
     *  axis: "x" = horizontal, "y" = vertical. */
    private attachScrollInteractions(el: HTMLElement, axis: "x" | "y", logTag: string): void {
        // ── Scroll-driven edge-fade classes ──────────────────────────
        const updateFades = () => {
            if (axis === "x") {
                const max = el.scrollWidth - el.clientWidth;
                const v = el.scrollLeft;
                el.classList.toggle("has-overflow-l", v > 4);
                el.classList.toggle("has-overflow-r", v < max - 4);
            } else {
                const max = el.scrollHeight - el.clientHeight;
                const v = el.scrollTop;
                el.classList.toggle("has-overflow-t", v > 4);
                el.classList.toggle("has-overflow-b", v < max - 4);
            }
        };
        el.addEventListener("scroll", updateFades, { passive: true });

        // ── Drag-to-scroll ───────────────────────────────────────────
        // Two-phase activation:
        //   Phase 1 (pointerdown): track the press but DO NOT capture the pointer
        //     yet. If the user releases without moving (= a click), the click event
        //     fires on its natural target (the button) because no capture was set.
        //   Phase 2 (pointermove past threshold): user is actually dragging — NOW
        //     we set pointer capture, add .is-dragging, and start scrolling. From
        //     this point on click is suppressed in capture phase.
        //
        // This avoids the spec gotcha where setPointerCapture reroutes the click
        // event target to the captured element, swallowing button clicks.
        let pressed = false;
        let captured = false;
        let activePointerId = -1;
        let startCoord = 0;
        let startScroll = 0;
        let movedPx = 0;
        let scrollMoved = false;
        const DRAG_THRESHOLD = 8;

        const isScrollable = () => {
            const sd = axis === "x" ? el.scrollWidth  - el.clientWidth
                                    : el.scrollHeight - el.clientHeight;
            return sd > 1;
        };

        el.addEventListener("pointerdown", (e: PointerEvent) => {
            if (e.button !== 0 && e.pointerType === "mouse") return;
            if (!isScrollable()) return;
            pressed = true;
            captured = false;
            activePointerId = e.pointerId;
            movedPx = 0;
            scrollMoved = false;
            startCoord  = axis === "x" ? e.pageX : e.pageY;
            startScroll = axis === "x" ? el.scrollLeft : el.scrollTop;
            // NB: no setPointerCapture here, no .is-dragging class yet — see header.
            this.log(`press ${logTag} axis=${axis}`);
        });

        el.addEventListener("pointermove", (e: PointerEvent) => {
            if (!pressed) return;
            const d = (axis === "x" ? e.pageX : e.pageY) - startCoord;
            movedPx = Math.max(movedPx, Math.abs(d));

            // Promote to a real drag once cursor passes the threshold
            if (!captured && movedPx > DRAG_THRESHOLD) {
                captured = true;
                el.classList.add("is-dragging");
                try { el.setPointerCapture(activePointerId); } catch (_) { /* ignore */ }
                this.log(`drag start ${logTag} axis=${axis}`);
            }
            if (!captured) return;

            const before = axis === "x" ? el.scrollLeft : el.scrollTop;
            if (axis === "x") el.scrollLeft = startScroll - d;
            else              el.scrollTop  = startScroll - d;
            const after = axis === "x" ? el.scrollLeft : el.scrollTop;
            if (after !== before) scrollMoved = true;
        });

        const endPress = () => {
            if (!pressed) return;
            pressed = false;
            if (captured) {
                el.classList.remove("is-dragging");
                try { el.releasePointerCapture(activePointerId); } catch (_) { /* ignore */ }
            }
            captured = false;
            activePointerId = -1;
        };
        el.addEventListener("pointerup",     endPress);
        el.addEventListener("pointercancel", endPress);
        el.addEventListener("pointerleave",  endPress);

        // Capture-phase click suppression — only when an actual drag happened
        // (cursor crossed threshold AND scroll position changed).
        el.addEventListener("click", (e: MouseEvent) => {
            if (movedPx > DRAG_THRESHOLD && scrollMoved) {
                e.stopPropagation();
                e.preventDefault();
            }
            movedPx = 0;
            scrollMoved = false;
        }, true);

        // ── Wheel → axis scroll ──────────────────────────────────────
        // For horizontal: vertical wheel translates to horizontal scroll
        // (browsers normally only do this with Shift held).
        // For vertical: native browser behavior already works for vertical
        // wheel on a vertically-scrollable element, so we only intervene
        // when the element actually has overflow.
        el.addEventListener("wheel", (e: WheelEvent) => {
            const overflow = axis === "x"
                ? el.scrollWidth  - el.clientWidth
                : el.scrollHeight - el.clientHeight;
            if (overflow <= 1) return;
            const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
            if (d === 0) return;
            if (axis === "x") el.scrollLeft += d;
            else              el.scrollTop  += d;
            e.preventDefault();
        }, { passive: false });

        // Initial paint
        updateFades();
    }

    /** Update edge-fade classes for a single toggle's track. Called from the
     *  toggle's ResizeObserver and post-render rAF. Axis follows Values Layout. */
    private updateEdgeFades(tog: ToggleState): void {
        const track = tog.trackEl;
        if (!track) return;
        const layout = (this.fmtSettings.orientation.valuesLayout.value as { value?: string })?.value || "horizontal";
        if (layout === "vertical") {
            const max = track.scrollHeight - track.clientHeight;
            const v = track.scrollTop;
            track.classList.toggle("has-overflow-t", v > 4);
            track.classList.toggle("has-overflow-b", v < max - 4);
            track.classList.remove("has-overflow-l", "has-overflow-r");
        } else {
            const max = track.scrollWidth - track.clientWidth;
            const v = track.scrollLeft;
            track.classList.toggle("has-overflow-l", v > 4);
            track.classList.toggle("has-overflow-r", v < max - 4);
            track.classList.remove("has-overflow-t", "has-overflow-b");
        }
    }

    /** Update edge-fade classes for the toggles-wrap container. Axis depends
     *  on the resolved orientation (horizontal → l/r, vertical → t/b). */
    private updateWrapEdgeFades(): void {
        const wrap = this.togglesWrapEl;
        if (!wrap) return;
        if (wrap.classList.contains("is-axis-y")) {
            const max = wrap.scrollHeight - wrap.clientHeight;
            const v = wrap.scrollTop;
            wrap.classList.toggle("has-overflow-t", v > 4);
            wrap.classList.toggle("has-overflow-b", v < max - 4);
            wrap.classList.remove("has-overflow-l", "has-overflow-r");
        } else {
            const max = wrap.scrollWidth - wrap.clientWidth;
            const v = wrap.scrollLeft;
            wrap.classList.toggle("has-overflow-l", v > 4);
            wrap.classList.toggle("has-overflow-r", v < max - 4);
            wrap.classList.remove("has-overflow-t", "has-overflow-b");
        }
    }

    /** Build one toggle button (button + symbol span + label span). Used by both
     *  renderToggleBlock (full DOM build) and syncButtonCount (in-place add). The click
     *  handler is wired unconditionally and dispatches on the CURRENT items[sideIdx] at
     *  click time, so when items change in place the handler stays correct. */
    private buildButton(tog: ToggleState, toggleIdx: number, sideIdx: number): { btn: HTMLButtonElement; sym: HTMLSpanElement; lbl: HTMLSpanElement } {
        const c = this.resolveContentForToggle(tog.queryName);
        const item = tog.items[sideIdx];
        const sideTag = sideIdx <= 2 ? ["a", "b", "c"][sideIdx] : String(sideIdx);
        const sideSym = sideIdx === 0 ? c.symbolA : sideIdx === 1 ? c.symbolB : sideIdx === 2 ? c.symbolC : "";

        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = `tb-btn tb-btn-${sideTag}`;

        const sym = document.createElement("span");
        sym.className = "tb-sym";
        sym.textContent = sideSym;
        if (!c.showSymbols || !sideSym || !item) sym.classList.add("is-hidden");

        const lbl = document.createElement("span");
        lbl.className = "tb-lbl";
        lbl.textContent = item ? item.display : "";
        if (!c.showLabels || !item) lbl.classList.add("is-hidden");

        btn.appendChild(sym);
        btn.appendChild(lbl);
        btn.addEventListener("click", (e) => { e.stopPropagation(); this.onButtonClick(toggleIdx, sideIdx); });
        if (!item) {
            btn.style.display = "none";
            btn.setAttribute("aria-hidden", "true");
            btn.tabIndex = -1;
        }
        return { btn, sym, lbl };
    }

    /** Patch the toggle's button DOM in-place to match its current items.length, adding
     *  buttons at the end or removing the last ones. Called from applyLayout on every
     *  update so cascade-driven items count changes (e.g. Day 28 → 30 when Month flips
     *  Feb → April) don't trigger renderAll's full DOM nuke + rebuild — the visual
     *  patches in place and the user doesn't see a flicker. */
    private syncButtonCount(tog: ToggleState): void {
        const host = tog.trackEl || tog.toggleEl;
        if (!host) return;
        const target = Math.max(tog.items.length, 1);
        const toggleIdx = this.toggles.indexOf(tog);
        if (toggleIdx < 0) return;
        while (tog.btnEls.length < target) {
            const sideIdx = tog.btnEls.length;
            const { btn, sym, lbl } = this.buildButton(tog, toggleIdx, sideIdx);
            host.appendChild(btn);
            tog.btnEls.push(btn);
            tog.symEls.push(sym);
            tog.lblEls.push(lbl);
        }
        while (tog.btnEls.length > target) {
            const last = tog.btnEls.pop();
            if (last) last.remove();
            tog.symEls.pop();
            tog.lblEls.pop();
        }
    }

    /** Compute --thumb-x and --thumb-w for the sliding thumb. The thumb is a
     *  ::before pseudo of .tb-toggle-track (NOT .tb-toggle), so it lives inside
     *  the scroll container and naturally moves with the buttons when the track
     *  scrolls horizontally — no need to recompute on scroll. We use offsetLeft
     *  (relative to track's padding box) instead of bbox-diff because offsetLeft
     *  is independent of the scroll position, while bbox.left reflects the
     *  current scrolled screen position. */
    private positionThumb(tog: ToggleState): void {
        const track = tog.trackEl;
        if (!track || tog.btnEls.length === 0) return;
        // Cleared state OR multi-select with size > 1: hide thumb. Multi mode
        // paints each selected button's own fill via .multi-active instead.
        if (tog.selectedValue == null || tog.selectedSet.size === 0 || tog.selectedSet.size > 1) {
            track.classList.remove("tb-ready");
            return;
        }
        const activeIdx = tog.items.findIndex(it => it.value === tog.selectedValue);
        const active = activeIdx >= 0 ? tog.btnEls[activeIdx] : tog.btnEls[0];
        if (!active) return;

        const padNum = parseFloat(getComputedStyle(track).getPropertyValue("--toggle-padding")) || 0;
        // Values Layout = vertical → thumb slides along Y, sized by height.
        // offsetTop / offsetHeight (or offsetLeft / offsetWidth) are relative
        // to the track (positioned ancestor). Independent of scroll position,
        // so the thumb stays glued to the active button regardless of scroll.
        const layout = (this.fmtSettings.orientation.valuesLayout.value as { value?: string })?.value || "horizontal";
        if (layout === "vertical") {
            const y = active.offsetTop - padNum;
            const h = active.offsetHeight + 6;
            track.style.setProperty("--thumb-y", y + "px");
            track.style.setProperty("--thumb-h", h + "px");
        } else {
            const x = active.offsetLeft - padNum;
            const w = active.offsetWidth + 6;
            track.style.setProperty("--thumb-x", x + "px");
            track.style.setProperty("--thumb-w", w + "px");
        }
        track.classList.add("tb-ready");
    }

    private applyLayout(): void {
        if (!this.togglesWrapEl) return;
        const s = this.fmtSettings;
        const root = this.root;

        // ── Per-toggle title styling (resolved via Apply-to chain per toggle)
        for (const t of this.toggles) {
            if (t.titleEl) {
                t.titleEl.style.color = this.resolveColor("title", "titleColor", t.queryName, "#334155");
                const fs = Math.max(8, Math.min(48, this.resolveNum("title", "titleFontSize", t.queryName, 12)));
                t.titleEl.style.fontSize = fs + "px";
            }
        }

        // ── Sizing (global)
        const sizeMode = (s.sizing.sizeMode.value as { value?: string })?.value || "fixed";
        const isFit = sizeMode === "auto";
        this.root.classList.toggle("tb-fit", isFit);
        // Equal-Width Buttons (Sizing card). When ON, every button shares the
        // toggle width equally regardless of label length. CSS-only: the
        // .tb-equal-width class forces the toggle to width:100% and applies
        // flex:1 1 0 on the buttons. No-op in Fit mode (already equal-share).
        const equalWidth = s.sizing.equalWidth.value === true;
        this.root.classList.toggle("tb-equal-width", equalWidth);

        // Values Layout (Orientation card). When set to vertical, the values
        // inside ONE toggle stack top-to-bottom instead of arranging side-by-side.
        // Track flex-direction switches to column, thumb slides vertically,
        // overflow goes Y-axis, and the Wave shimmer's mask sweeps top-to-bottom.
        // Per-Value shimmer keeps its horizontal sweep regardless (per spec).
        const valuesLayout = (s.orientation.valuesLayout.value as { value?: string })?.value || "horizontal";
        const valuesVertical = valuesLayout === "vertical";
        this.root.classList.toggle("tb-values-vertical", valuesVertical);

        // Combined class: vertical-values + verticalAlign=stretch. Without this,
        // vertical-values toggles take their natural height (sum of stacked
        // button heights) and the wrap centers them. With it, the toggle and
        // its inner track expand to fill the available block height — the
        // user-visible "stretch" effect on the Y axis.
        const vAlign = (s.orientation.verticalAlign.value as { value?: string })?.value || "stretch";
        this.root.classList.toggle("tb-values-vertical-stretch", valuesVertical && vAlign === "stretch");

        s.sizing.size.visible        = !isFit;

        // ── Orientation alignment (only when leftover space exists, i.e. Fixed mode) ──
        // Resolve effective layout direction (mirrors renderAll())
        const orientModeForAlign = (s.orientation.mode.value as { value?: string })?.value || "auto";
        const titlePosForAlign = (s.title.titlePosition.value as { value?: string })?.value || "top-left";
        let effectiveOrient: "vertical" | "horizontal";
        if (orientModeForAlign === "vertical") effectiveOrient = "vertical";
        else if (orientModeForAlign === "horizontal") effectiveOrient = "horizontal";
        else effectiveOrient = (titlePosForAlign === "left" || titlePosForAlign === "right") ? "vertical" : "horizontal";

        // Both alignment dropdowns are visible whenever sizing is Fixed — regardless of
        // layout direction. Each axis has independent meaning: vertical alignment positions
        // toggles on Y, horizontal alignment on X. Together they cover every layout case.
        s.orientation.verticalAlign.visible   = !isFit;
        s.orientation.horizontalAlign.visible = !isFit;

        // Apply BOTH alignments simultaneously. Main axis (along which toggles arrange)
        // gets justify-content, cross axis gets align-items. "Stretch" (default) on the
        // cross axis keeps the equal-size behavior; non-stretch values use natural sizing.
        if (this.togglesWrapEl) {
            // Helper to apply main-axis "stretch" by setting flex:1 on each block
            // (justify-content has no real "stretch" value — falls back to
            // flex-start, which leaves blocks at natural size with empty space
            // at the end). flex:1 on children grows them to fill.
            const applyMainStretch = (mainStretch: boolean): void => {
                if (!this.togglesWrapEl) return;
                const blocks = this.togglesWrapEl.querySelectorAll<HTMLDivElement>(".tb-block");
                blocks.forEach(b => {
                    if (mainStretch) {
                        b.style.flex = "1 1 0";
                        b.style.minWidth = "0";
                        b.style.minHeight = "0";
                    } else {
                        b.style.flex = "";
                        b.style.minWidth = "";
                        b.style.minHeight = "";
                    }
                });
            };

            if (isFit) {
                this.togglesWrapEl.style.justifyContent = effectiveOrient === "vertical" ? "center" : "flex-start";
                this.togglesWrapEl.style.alignItems = "stretch";
                applyMainStretch(true); // fit always stretches main axis (blocks fill the wrap)
            } else {
                const v = (s.orientation.verticalAlign.value   as { value?: string })?.value || "stretch";
                const h = (s.orientation.horizontalAlign.value as { value?: string })?.value || "stretch";
                const mapY: Record<string, string> = { stretch: "stretch", top:  "flex-start", center: "center", bottom: "flex-end" };
                const mapX: Record<string, string> = { stretch: "stretch", left: "flex-start", center: "center", right:  "flex-end" };
                // justify-content has no "stretch" value; we handle that case by
                // applying flex:1 to each block (mainStretch path) so blocks
                // grow to fill the main axis. Otherwise blocks stay natural-size
                // and justify-content positions them.
                const mainVal = effectiveOrient === "vertical" ? v : h;
                const mainStretch = mainVal === "stretch";
                applyMainStretch(mainStretch);
                const mainFromVal = (val: string, m: Record<string, string>): string => {
                    const out = m[val];
                    return (!out || out === "stretch") ? "flex-start" : out;
                };
                if (effectiveOrient === "vertical") {
                    // Main = Y, cross = X
                    this.togglesWrapEl.style.justifyContent = mainFromVal(v, mapY);
                    this.togglesWrapEl.style.alignItems     = mapX[h] || "stretch";
                } else {
                    // Main = X, cross = Y
                    this.togglesWrapEl.style.justifyContent = mainFromVal(h, mapX);
                    this.togglesWrapEl.style.alignItems     = mapY[v] || "stretch";
                }
            }
        }

        const REFERENCE_H = 30;
        const REFERENCE_W = 220;
        let scaleVal: number;
        let textScale: number;
        if (isFit) {
            // Aspect-aware scale: take the SMALLER of height-derived and width-derived.
            // Use the FIRST toggle's wrap as a reference; all per-toggle wraps are equally sized in the flex container.
            const refWrap = this.toggles[0]?.wrapEl;
            const wrapW = refWrap ? refWrap.clientWidth  : (this.viewportW - 4);
            const wrapH = refWrap ? refWrap.clientHeight : (this.viewportH - 4);
            const scaleH = (wrapH || REFERENCE_H) / REFERENCE_H;
            const scaleW = (wrapW || REFERENCE_W) / REFERENCE_W;
            const containerScale = Math.max(0.5, Math.min(8, Math.min(scaleH, scaleW)));
            scaleVal = containerScale;
            // Text in fit mode stays at the EXACT font size set under Content. The toggle's
            // chrome (padding, gaps, thumb spread) still fills the container via --tb-scale,
            // but label/symbol font sizes are fixed — author-controlled, not container-driven.
            textScale = 1;
        } else {
            const fixedSize = Math.max(8, Math.min(400, Number(s.sizing.size.value) || REFERENCE_H));
            scaleVal = fixedSize / REFERENCE_H;
            // Text stays at the EXACT label/symbol font sizes set under Content,
            // independent of the toggle's pixel size. Same rule as fit mode — the
            // chrome (padding, gap, thumb spread) scales with --tb-scale, but font
            // sizes are author-controlled and never derived from the toggle size.
            textScale = 1;
        }
        root.style.setProperty("--tb-scale", String(scaleVal));
        root.style.setProperty("--tb-text-scale", String(textScale));

        // ── Per-toggle Content patching: button count, label text, symbol text +
        // visibility, font sizes. All in-place — no DOM nuke. This is the path that
        // keeps cascade-driven items count changes (e.g. Day 28 → 30 across months)
        // from triggering a full renderAll rebuild and visible flicker.
        for (const t of this.toggles) {
            if (!t.toggleEl) continue;

            // 1. Sync button count to items.length (add/remove buttons in place)
            this.syncButtonCount(t);

            const c = this.resolveContentForToggle(t.queryName);
            // 2. Per-button label text + visibility, symbol text + visibility, button
            //    presence (display:none when item missing). Symbol slots exist only for
            //    sides 0/1/2 (A/B/C); sides 3+ render label-only.
            for (let i = 0; i < t.btnEls.length; i++) {
                const item = t.items[i];
                const btn  = t.btnEls[i];
                const sym  = t.symEls[i];
                const lbl  = t.lblEls[i];
                if (!btn || !sym || !lbl) continue;
                if (item) {
                    btn.style.display = "";
                    btn.removeAttribute("aria-hidden");
                    btn.tabIndex = 0;
                    lbl.textContent = item.display;
                } else {
                    btn.style.display = "none";
                    btn.setAttribute("aria-hidden", "true");
                    btn.tabIndex = -1;
                }
                const sideSym = i === 0 ? c.symbolA : i === 1 ? c.symbolB : i === 2 ? c.symbolC : "";
                sym.textContent = sideSym;
                sym.classList.toggle("is-hidden", !c.showSymbols || !sideSym || !item);
                lbl.classList.toggle("is-hidden", !c.showLabels || !item);
            }

            // 3. Title text (titlePosition is structural, in renderKey; titleText patches here)
            if (t.titleEl) {
                const tt = this.resolveTitleForToggle(t.queryName);
                if (tt.show) t.titleEl.textContent = tt.text;
            }

            // 4. Per-block font-size CSS vars (overrides root-level vars for this block only)
            const labelFs  = Math.max(6, Math.min(72, c.labelFontSize  || 12));
            const symbolFs = Math.max(6, Math.min(72, c.symbolFontSize || 12));
            (t.blockEl as HTMLDivElement).style.setProperty("--tb-label-fs",  labelFs  + "px");
            (t.blockEl as HTMLDivElement).style.setProperty("--tb-symbol-fs", symbolFs + "px");
        }

        // ── Capsule
        // Prefer the actual measured wrap height: with equal-height stretching active in
        // horizontal orientation, the rendered pill can be taller than `fixedSize` when a
        // sibling has wrapping labels. Using `scaleVal * REFERENCE_H` (= fixedSize) under-
        // estimates the height and prevents a fully-rounded pill at 100%. Fall back to the
        // scaled reference only on the first paint before clientHeight is available.
        const refWrapForRadius = this.toggles[0]?.wrapEl;
        const measuredHeight = refWrapForRadius ? refWrapForRadius.clientHeight : 0;
        const fallbackHeight = isFit ? REFERENCE_H : scaleVal * REFERENCE_H;
        const naturalHeight = measuredHeight > 0 ? measuredHeight : fallbackHeight;
        const roundnessPct = Math.max(0, Math.min(100, Number(s.capsule.cornerRadius.value) || 0));
        // At 100%, output a large fixed radius — CSS clamps border-radius to half the
        // smaller dimension, so 9999px renders a perfect pill at any actual height.
        const radius = roundnessPct >= 100
            ? 9999
            : (roundnessPct / 100) * (naturalHeight / 2);
        const rawPad  = Number(s.capsule.thumbPadding.value);
        const pad = Math.max(0, isFinite(rawPad) ? rawPad : 3);
        root.style.setProperty("--toggle-radius", radius + "px");
        root.style.setProperty("--toggle-padding", pad + "px");

        const topα    = Math.max(0, Math.min(1000, Number(s.capsule.trackBgTopAlpha.value) || 0)) / 1000;
        const botα    = Math.max(0, Math.min(1000, Number(s.capsule.trackBgBotAlpha.value) || 0)) / 1000;
        const borderα = Math.max(0, Math.min(1000, Number(s.capsule.trackBorderAlpha.value) || 0)) / 1000;
        root.style.setProperty("--toggle-bg-top", `rgba(255,255,255,${topα})`);
        root.style.setProperty("--toggle-bg-bot", `rgba(255,255,255,${botα})`);
        root.style.setProperty("--toggle-border", `rgba(255,255,255,${borderα})`);

        // ── Per-toggle Thumb + Text overrides (CSS vars on each .tb-block)
        for (const t of this.toggles) {
            if (!t.blockEl) continue;
            const blk = t.blockEl as HTMLDivElement;

            // Thumb non-color knobs (alphas, spread). The thumb glow COLOR is set by
            // applyButtonColors() at the end of this loop — it depends on the active
            // button's row, not the toggle as a whole, so it can flow through FX rules.
            const ringα  = Math.max(0, Math.min(100, this.resolveNum("thumb", "thumbRingAlpha",      t.queryName, 18))) / 100;
            const bloomα = Math.max(0, Math.min(100, this.resolveNum("thumb", "thumbBloomAlpha",     t.queryName, 45))) / 100;
            const spread = Math.max(0, Math.min(80,  this.resolveNum("thumb", "thumbGlowSpread",     t.queryName, 14)));
            const hlα    = Math.max(0, Math.min(100, this.resolveNum("thumb", "thumbHighlightAlpha", t.queryName, 18))) / 100;
            blk.style.setProperty("--thumb-ring-opacity",  String(ringα));
            blk.style.setProperty("--thumb-bloom-opacity", String(bloomα));
            blk.style.setProperty("--thumb-glow-spread",   spread + "px");
            blk.style.setProperty("--thumb-inner-hl",      `rgba(255,255,255,${hlα})`);

            // Text colors — per-button inline style so per-row FX outputs land on the
            // correct button. Block-level fallbacks via CSS vars stay set for the (rare)
            // case where lblEls / symEls are missing.
            blk.style.setProperty("--label-active-color",    this.resolveColor("text", "labelActiveColor",    t.queryName, "#F1F5F9"));
            blk.style.setProperty("--label-color",            this.resolveColor("text", "labelInactiveColor",  t.queryName, "#94A3B8"));
            blk.style.setProperty("--symbol-color-active",   this.resolveColor("text", "symbolActiveColor",   t.queryName, "#60A5FA"));
            blk.style.setProperty("--symbol-color-inactive", this.resolveColor("text", "symbolInactiveColor", t.queryName, "#94A3B8"));
            const symα = Math.max(0, Math.min(100, this.resolveNum("text", "symbolInactiveAlpha", t.queryName, 55))) / 100;
            blk.style.setProperty("--symbol-opacity-inactive", String(symα));

            this.applyButtonColors(t);

            // ── Per-toggle "spacing between values" — gap between buttons inside this toggle
            const valueGap = Math.max(0, Math.min(60, this.resolveNum("spacing", "valueGap", t.queryName, 0)));
            blk.style.setProperty("--tb-value-gap", valueGap + "px");
        }

        // ── Global "spacing between fields" — gap on .tb-toggles-wrap
        // (flex container's `gap` resolves to row-gap in vertical, column-gap in horizontal,
        // so a single value covers both orientations automatically).
        const fieldGap = Math.max(0, Math.min(200, Number(s.spacing.fieldGap.value) || 0));
        root.style.setProperty("--tb-field-gap", fieldGap + "px");

        // ── Animation (PER-TOGGLE) ──────────────────────────────────
        // Each block resolves its own transition + shimmer settings via the
        // standard Apply-to chain: per-toggle slot override → "all" default →
        // hardcoded fallback. Classes (.tb-shimmer / .tb-shimmer-wave /
        // .tb-shimmer-per-value) and CSS variables (--transition-duration,
        // --transition-ease, --tb-shimmer-rgb, --tb-shimmer-dur,
        // --tb-shimmer-opacity, --tb-shimmer-track-gradient) are set on the
        // .tb-block element, so descendants (.tb-toggle, track, buttons)
        // inherit per-block values.
        for (const t of this.toggles) {
            if (!t.blockEl) continue;
            const blk = t.blockEl as HTMLDivElement;

            // Transition timing (thumb slide)
            const dur = Math.max(0, Math.min(5000, this.resolveNum("animation", "transitionDuration", t.queryName, 350)));
            blk.style.setProperty("--transition-duration", dur + "ms");
            const ease = this.resolveDropdown("animation", "transitionEase", t.queryName, "cubic-bezier(.22,.61,.36,1)");
            blk.style.setProperty("--transition-ease", ease);

            // Shimmer per-toggle
            const shimmerOn = this.resolveBool("animation", "shimmerEnabled", t.queryName, false);
            const shimmerMode = this.resolveDropdown("animation", "shimmerMode", t.queryName, "perValue");
            blk.classList.toggle("tb-shimmer", shimmerOn);
            blk.classList.toggle("tb-shimmer-wave", shimmerOn && shimmerMode === "wave");
            blk.classList.toggle("tb-shimmer-per-value", shimmerOn && shimmerMode !== "wave");

            if (shimmerOn) {
                const shimmerHex = this.resolveColor("animation", "shimmerColor", t.queryName, "#FFFFFF");
                blk.style.setProperty("--tb-shimmer-rgb", hexToRgbTriplet(shimmerHex, "255, 255, 255"));
                const shimmerDur = Math.max(200, Math.min(20000, this.resolveNum("animation", "shimmerDuration", t.queryName, 2500)));
                blk.style.setProperty("--tb-shimmer-dur", shimmerDur + "ms");
                const shimmerOpacityPct = Math.max(0, Math.min(100, this.resolveNum("animation", "shimmerOpacity", t.queryName, 100)));
                blk.style.setProperty("--tb-shimmer-opacity", String(shimmerOpacityPct / 100));

                // Wave mode — build the multi-stop gradient FROM ACTUAL button
                // positions (offsetLeft/offsetWidth) so color stops align with
                // each button's real edges (sharp transitions, no color leak).
                // Per-row FX color via colorForRow → slot variant first, then
                // unprefixed, then resolveColor fallback.
                if (shimmerMode === "wave" && t.toggleEl && t.trackEl && t.items.length > 0) {
                    const fallbackHex = shimmerHex;
                    const padPx = parseFloat(getComputedStyle(t.trackEl).getPropertyValue("--toggle-padding")) || 0;
                    const last = t.btnEls[t.btnEls.length - 1];
                    if (last) {
                        // Axis follows valuesLayout. Horizontal: 90deg gradient,
                        // stops along x (offsetLeft + offsetWidth). Vertical:
                        // 180deg gradient, stops along y (offsetTop + offsetHeight).
                        // The mask's animation direction is selected by the LESS
                        // class — see .tb-values-vertical .tb-block.tb-shimmer-wave
                        // .tb-toggle::after { animation: tb-shimmer-mask-sweep-y }.
                        const totalSpan = valuesVertical
                            ? last.offsetTop + last.offsetHeight - padPx
                            : last.offsetLeft + last.offsetWidth - padPx;
                        if (totalSpan > 0) {
                            const stops: string[] = [];
                            for (let i = 0; i < t.btnEls.length; i++) {
                                const btn = t.btnEls[i];
                                const item = t.items[i];
                                if (!btn || !item) continue;
                                const hex = this.colorForRow(t, item.rowIdx, "animation", "shimmerColor", fallbackHex);
                                const startPx = (valuesVertical ? btn.offsetTop : btn.offsetLeft) - padPx;
                                const sizePx  = valuesVertical ? btn.offsetHeight : btn.offsetWidth;
                                const start = (startPx / totalSpan) * 100;
                                const end   = ((startPx + sizePx) / totalSpan) * 100;
                                stops.push(`${hex} ${start.toFixed(4)}%`, `${hex} ${end.toFixed(4)}%`);
                            }
                            const angle = valuesVertical ? "180deg" : "90deg";
                            const grad = `linear-gradient(${angle}, ${stops.join(", ")})`;
                            t.toggleEl.style.setProperty("--tb-shimmer-track-gradient", grad);
                        }
                    }
                }
            }
        }
        // Strip any legacy root-level shimmer classes/vars from prior renders
        // (in case a previous build set them at root). The block-level ones
        // are the canonical source now.
        this.root.classList.remove("tb-shimmer", "tb-shimmer-wave", "tb-shimmer-per-value");

        // ── Sync active classes + reposition each thumb
        for (const t of this.toggles) {
            this.refreshActiveClasses(t);
        }
        requestAnimationFrame(() => {
            for (const t of this.toggles) {
                this.positionThumb(t);
                this.updateEdgeFades(t);
            }
            this.updateWrapEdgeFades();
        });

        // Commit decisions live in update() (diff between pre-parse snapshot and post-parse
        // selectedValue). applyLayout is pure layout/style — never reads liveSelIds for
        // re-assertion, otherwise multi-instance flip-flop loops re-emerge.
    }
}
