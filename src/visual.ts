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
    private cardIndexMaps: Record<string, Record<string, number>> = { title: {}, content: {}, text: {}, thumb: {}, selection: {} };
    // <cardName, "all" | "toggle:<queryName>"> — read from metadata directly per §11.0c.
    private activeViewByCard: Record<string, string> = { title: "all", content: "all", text: "all", thumb: "all", selection: "all" };
    // Cards that have the Apply-to dropdown wired (grow this list as B2/C1/C2 land)
    private static readonly PER_TOGGLE_CARDS: ReadonlyArray<"title"|"content"|"text"|"thumb"|"selection"> = ["title", "content", "text", "thumb", "selection"];

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
                });
            }

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
            const prevSelections: (string | null)[] = this.toggles.map(t => t.selectedValue);

            // Slicer-style cascade: each toggle's available values are filtered by the
            // selections of all upstream toggles (j < i). `constraints` is built incrementally
            // so toggle i sees toggles 0..i-1 with their freshly-parsed selections.
            const constraints: (string | null)[] = new Array(this.toggles.length).fill(null);
            let anyError = false;
            const errorCounts: number[] = [];
            for (let i = 0; i < this.toggles.length; i++) {
                const ok = this.parseToggle(i, constraints, persistedMap);
                if (!ok.ok) {
                    anyError = true;
                    errorCounts.push(ok.distinctCount);
                }
                constraints[i] = this.toggles[i].selectedValue;
            }

            // Commit + persist only when MY-OWN selectedValue changed during parse.
            // This catches first-bind force-default and cascade-reset, but stays silent
            // on plain preserve passes — which is exactly what breaks the multi-instance loop.
            const selectionsChanged = this.toggles.some((t, i) => t.selectedValue !== prevSelections[i]);
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
                const tShowTitle = this.resolveBool("title", "showTitle", t.queryName, true);
                const tTitlePos  = this.resolveDropdown("title", "titlePosition", t.queryName, "top-left");
                return [t.queryName, tShowTitle ? "T" : "t", tShowTitle ? tTitlePos : ""].join("␟");
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
    private ensureSlotsForCard(cardName: "title"|"content"|"text"|"thumb"|"selection"): void {
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
    private refreshViewItemsAndRead(cardName: "title"|"content"|"text"|"thumb"|"selection"): void {
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

    private applyCardVisibility(cardName: "title"|"content"|"text"|"thumb"|"selection"): void {
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
            selection: ["forceSelection"]
        };
        const indexMapProps: Record<string, string> = {
            title: "titleIndexMap", content: "contentIndexMap", text: "textIndexMap", thumb: "thumbIndexMap",
            selection: "selectionIndexMap"
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
            lastDriverVal: null,
            lastSortKey: "",
            lastUpstreamKey: "",
            blockEl: null, titleEl: null, wrapEl: null, toggleEl: null,
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
        constraints: (string | null)[],
        persistedMap: Record<string, string>
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
        const upstreamConstraints = constraints.slice(0, togIdx).map((v, j) => `${j}:${v}`).join(",");
        // Did the cascade input change since the last parseToggle? Used below to decide
        // whether the cache fallback is safe (preserve N buttons on transient shrinkage)
        // or whether we must rebuild (the cascade legitimately points at a different
        // upstream value with a different valid distinct set).
        const upstreamKey = constraints.slice(0, togIdx).map(v => v ?? "").join("␟");
        const upstreamChanged = upstreamKey !== tog.lastUpstreamKey;
        tog.lastUpstreamKey = upstreamKey;
        this.log(`  parseToggle(${tog.queryName}) ENTRY cat.len=${values.length} upstream=[${upstreamConstraints}] upstreamChanged=${upstreamChanged} selectedValue=${tog.selectedValue}`);
        const distinct: { raw: powerbi.PrimitiveValue; idx: number }[] = [];
        const seen = new Set<string>();
        let rowsKept = 0;
        let rowsSkipped = 0;
        for (let r = 0; r < values.length; r++) {
            // Slicer cascade: row must satisfy every upstream toggle's selection
            let matches = true;
            for (let j = 0; j < togIdx; j++) {
                const otherSel = constraints[j];
                if (otherSel == null) continue; // cleared upstream → no constraint
                const otherCat = this.toggles[j].cat;
                const otherVal = otherCat?.values?.[r];
                const otherStr = otherVal == null ? "(blank)" : String(otherVal);
                if (otherStr !== otherSel) { matches = false; break; }
            }
            if (!matches) { rowsSkipped++; continue; }
            rowsKept++;

            const k = values[r] == null ? "(blank)" : String(values[r]);
            if (seen.has(k)) continue;
            seen.add(k);
            distinct.push({ raw: values[r], idx: r });
            // No upper cap — let the visual render whatever PBI's dataReductionAlgorithm
            // delivers. The toggle pill stretches via flexbox so any count fits;
            // symbols A/B/C are the only labelled positions, sides D+ render label-only.
        }
        const n = distinct.length;
        const distinctTrace = distinct.map(d => `${d.raw == null ? "(blank)" : String(d.raw)}<${typeof d.raw}>@${d.idx}`).join(", ");
        this.log(`  parseToggle(${tog.queryName}) MASK rowsKept=${rowsKept} rowsSkipped=${rowsSkipped} distinct.n=${n} [${distinctTrace}]`);

        // Cache fallback: cat shrunk transiently (cross-filter, BLANK measure pruning).
        // If cache holds more buttons than the current data shows AND the upstream
        // cascade input is UNCHANGED, preserve cached UI structure (the shrinkage is
        // a PBI artifact, not an intentional change). When upstream changed, this
        // toggle's available items legitimately depend on the new upstream value —
        // we MUST rebuild (e.g. Dec=31 → Feb=28 needs 28 buttons, not 31).
        if (!upstreamChanged && n >= 1 && n < tog.cachedItems.length && tog.cachedItems.length >= 2) {
            this.log(`  parseToggle(${tog.queryName}) CACHE-FALLBACK n=${n} < cache=${tog.cachedItems.length} (upstream unchanged) → keep cached items, selectedValue=${tog.selectedValue}`);
            tog.items = tog.cachedItems;
            if (n === 1) {
                const remaining = distinct[0].raw == null ? "(blank)" : String(distinct[0].raw);
                const match = tog.items.find(it => it.value === remaining);
                if (match) tog.selectedValue = match.value;
            }
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
                tog.hasRestoredSelection = false;
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
                const persistedVal = persistedMap[tog.queryName];
                const force = this.resolveBool("selection", "forceSelection", tog.queryName, false);
                if (persistedVal === "" && !force) {
                    // "" sentinel = user explicitly cleared. Preserve null across cascades
                    // that change which items are available (otherwise selecting an
                    // upstream toggle would auto-revive a downstream selection the user
                    // had deliberately cleared). Force ON overrides — fall through.
                    tog.selectedValue = null;
                    this.log(`  parseToggle(${tog.queryName}) n=${n}: first bind — restored cleared (persistedVal="")`);
                } else if (typeof persistedVal === "string" && persistedVal !== "" &&
                    tog.items.some(it => it.value === persistedVal)) {
                    tog.selectedValue = persistedVal;
                    this.log(`  parseToggle(${tog.queryName}) n=${n}: first bind — restored from persisted=${persistedVal}`);
                } else if (driverInItems) {
                    tog.selectedValue = driverVal;
                    this.log(`  parseToggle(${tog.queryName}) n=${n}: first bind — measure-driven default=${driverVal}`);
                } else {
                    tog.selectedValue = tog.items[0].value;
                    this.log(`  parseToggle(${tog.queryName}) n=${n}: first bind — force-default A=${tog.items[0].value}${force ? " (Force ON, ignoring \"\" sentinel)" : ""}`);
                }
            } else if (driverChanged && driverInItems) {
                this.log(`  parseToggle(${tog.queryName}) n=${n}: driver re-fired ${tog.selectedValue} → ${driverVal}`);
                tog.selectedValue = driverVal;
            } else if (tog.selectedValue == null &&
                this.resolveBool("selection", "forceSelection", tog.queryName, false)) {
                // Force-Selection retroactivity: the toggle is currently cleared AND
                // Force Selection is now ON. Re-select to the driver value if available,
                // else default A. Catches the case where the author flips Force ON after
                // the user has already deselected.
                if (driverInItems) {
                    tog.selectedValue = driverVal;
                    this.log(`  parseToggle(${tog.queryName}) n=${n}: force-reactivate (driver)=${driverVal}`);
                } else {
                    tog.selectedValue = tog.items[0].value;
                    this.log(`  parseToggle(${tog.queryName}) n=${n}: force-reactivate (default A)=${tog.items[0].value}`);
                }
            } else {
                // Cascade-reset: if the upstream selection invalidated this toggle's
                // current non-null selectedValue, snap to the first available value.
                // null is "user deliberately cleared" — never cascade-reset over null
                // (unless Force is ON, handled in the branch above).
                const stillValid = tog.selectedValue == null ||
                                   tog.items.some(it => it.value === tog.selectedValue);
                if (!stillValid) {
                    tog.selectedValue = tog.items[0].value;
                    this.log(`  parseToggle(${tog.queryName}) n=${n}: cascade-reset → ${tog.selectedValue}`);
                } else {
                    this.log(`  parseToggle(${tog.queryName}) n=${n}: preserve selectedValue=${tog.selectedValue}`);
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
                tog.hasRestoredSelection = false;
            }

            if (!tog.hasRestoredSelection) {
                tog.hasRestoredSelection = true;
                const persistedVal = persistedMap[tog.queryName];
                const force = this.resolveBool("selection", "forceSelection", tog.queryName, false);
                if (persistedVal === "" && !force) {
                    tog.selectedValue = null;
                    this.log(`  parseToggle(${tog.queryName}): first bind (n=1) — restored cleared`);
                } else if (persistedVal === display) {
                    tog.selectedValue = display;
                    this.log(`  parseToggle(${tog.queryName}): first bind (n=1) — restored from persisted=${persistedVal}`);
                } else {
                    // Default to selected: a single-value field's natural state is "filter on".
                    tog.selectedValue = display;
                    this.log(`  parseToggle(${tog.queryName}): first bind (n=1) — default selected=${display}${force ? " (Force ON, ignoring \"\" sentinel)" : ""}`);
                }
            } else if (tog.selectedValue != null && tog.selectedValue !== display) {
                // Cascade-reset (n=1): only one option available, snap to it.
                tog.selectedValue = display;
                this.log(`  parseToggle(${tog.queryName}): cascade-reset (n=1) → ${tog.selectedValue}`);
            } else if (tog.selectedValue == null &&
                this.resolveBool("selection", "forceSelection", tog.queryName, false)) {
                // Force-Selection retroactivity (n=1).
                tog.selectedValue = display;
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

    // ── Persistence (JSON map by queryName, with single-value back-compat) ─

    private readPersistedMap(dv: DataView | undefined): Record<string, string> {
        if (!dv) return {};
        const tb = (dv?.metadata?.objects as { toolbar?: { selectedValue?: string; selectedValues?: string } } | undefined)?.toolbar;
        const raw = typeof tb?.selectedValues === "string" ? tb.selectedValues : "";
        if (raw) {
            try {
                const parsed = JSON.parse(raw);
                if (parsed && typeof parsed === "object") return parsed as Record<string, string>;
            } catch (e) { /* fall through to legacy */ }
        }
        // Legacy single-value: pin to the first toggle's queryName when only one is bound.
        const legacy = typeof tb?.selectedValue === "string" ? tb.selectedValue : "";
        if (legacy && this.toggles.length >= 1) {
            return { [this.toggles[0].queryName]: legacy };
        }
        return {};
    }

    private persistAll(): void {
        const map: Record<string, string> = {};
        for (const t of this.toggles) {
            // Always persist — "" sentinel marks "explicitly cleared" so single-value
            // toggles can restore an off state across reloads. n=2 toggles never have
            // selectedValue=null after init, so this is harmless for them.
            map[t.queryName] = t.selectedValue ?? "";
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
    private buildBasicFilter(cat: powerbi.DataViewCategoryColumn, rawValue: powerbi.PrimitiveValue): unknown | null {
        const source = cat.source as { queryName?: string; expr?: { source?: { entity?: string }; ref?: string } } | undefined;
        let table = "";
        let column = "";
        const expr = source?.expr;
        if (expr?.source?.entity && expr?.ref) {
            table = expr.source.entity;
            column = expr.ref;
        } else if (source?.queryName) {
            // queryName format: "Table.Column" (or "Table.Measure"). Use first dot as split.
            const qn = source.queryName;
            const dotIdx = qn.indexOf(".");
            if (dotIdx > 0) {
                table = qn.substring(0, dotIdx);
                column = qn.substring(dotIdx + 1);
            }
        }
        this.log(`  buildBasicFilter qn=${source?.queryName} → target={table:${table}, column:${column}} value=${rawValue}<${typeof rawValue}>`);
        if (!table || !column) return null;
        return {
            $schema: "http://powerbi.com/product/schema#basic",
            target: { table, column },
            operator: "In",
            values: [rawValue],
            filterType: 1
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
            if (t.selectedValue == null) continue;
            const cat = t.cat;
            if (!cat?.source || !Array.isArray(cat.values)) continue;
            const idx = (cat.values as powerbi.PrimitiveValue[]).findIndex(v =>
                (v == null ? "(blank)" : String(v)) === t.selectedValue);
            if (idx < 0) continue;
            const rawValue = cat.values[idx];
            const f = this.buildBasicFilter(cat, rawValue);
            if (f) {
                filters.push(f);
                tracelog.push(`${t.queryName}=${rawValue}<${typeof rawValue}>`);
            }
        }
        const action = filters.length === 0
            ? 1 /* FilterAction.remove — clears all filters from this visual */
            : 0 /* FilterAction.merge — replaces filter set with these */;
        this.log(`commitSelections() applyJsonFilter filters=${filters.length} action=${action} [${tracelog.join(", ")}]`);
        // Dump the full filter payload so the actual JSON sent to PBI is visible
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
        this.log(`onButtonClick(idx=${toggleIdx} qn=${tog.queryName} side=${sideIdx} clicked=${clicked.value} prevSelected=${tog.selectedValue})`);
        if (tog.selectedValue === clicked.value) {
            // Click the already-selected button → clear (toggle off) — UNLESS Selection
            // Mode → Force Selection is ON for this toggle, in which case the click is
            // ignored. Force is the author's "no-empty-state" guarantee.
            const force = this.resolveBool("selection", "forceSelection", tog.queryName, false);
            if (force) {
                this.log(`  → click on active ignored (Force Selection ON)`);
                return;
            }
            tog.selectedValue = null;
            this.commitSelections();
            this.persistAll();
            this.refreshActiveClasses(tog);
            this.applyButtonColors(tog);
            this.positionThumb(tog);
            this.log(`  → toggled off`);
            return;
        }

        tog.selectedValue = clicked.value;
        this.commitSelections();
        this.persistAll();
        this.refreshActiveClasses(tog);
        this.applyButtonColors(tog);
        this.positionThumb(tog);
    }

    private refreshActiveClasses(tog: ToggleState): void {
        for (let i = 0; i < tog.btnEls.length; i++) {
            const item = tog.items[i];
            const isActive = !!(item && tog.selectedValue === item.value);
            tog.btnEls[i].classList.toggle("is-active", isActive);
            tog.btnEls[i].setAttribute("aria-pressed", String(isActive));
        }
    }

    /** Per-button label/symbol color + active-row thumb glow color application. Reads
     *  per-row FX colors from cat.objects when conditional formatting rules are active
     *  (capabilities `rule.inputRole: "field"`) so each button gets its own value-driven
     *  color and the thumb glow follows the currently-selected button's row. */
    private applyButtonColors(tog: ToggleState): void {
        // Per-button label/symbol colors
        for (let i = 0; i < tog.btnEls.length; i++) {
            const item = tog.items[i];
            const lblEl = tog.lblEls[i];
            const symEl = tog.symEls[i];
            if (!item || !lblEl || !symEl) continue;
            const isActive = item.value === tog.selectedValue;
            const labelColor = isActive
                ? this.colorForRow(tog, item.rowIdx, "text", "labelActiveColor",   "#F1F5F9")
                : this.colorForRow(tog, item.rowIdx, "text", "labelInactiveColor", "#94A3B8");
            const symColor = isActive
                ? this.colorForRow(tog, item.rowIdx, "text", "symbolActiveColor",   "#60A5FA")
                : this.colorForRow(tog, item.rowIdx, "text", "symbolInactiveColor", "#94A3B8");
            lblEl.style.color = labelColor;
            symEl.style.color = symColor;
        }

        // Thumb glow color follows the ACTIVE button's row (only that button's glow shows)
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
            t.blockEl = null; t.titleEl = null; t.wrapEl = null; t.toggleEl = null;
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
        this.togglesWrapEl = togglesWrap;
        this.root.appendChild(togglesWrap);

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

        tog.btnEls = [];
        tog.symEls = [];
        tog.lblEls = [];
        const sideCount = Math.max(tog.items.length, 1);
        for (let i = 0; i < sideCount; i++) {
            const { btn, sym, lbl } = this.buildButton(tog, idx, i);
            toggle.appendChild(btn);
            tog.btnEls.push(btn);
            tog.symEls.push(sym);
            tog.lblEls.push(lbl);
        }
        wrap.appendChild(toggle);
        block.appendChild(wrap);

        this.refreshActiveClasses(tog);

        // Per-toggle resize observer
        if (typeof ResizeObserver !== "undefined") {
            tog.resizeObs = new ResizeObserver(() => {
                requestAnimationFrame(() => this.positionThumb(tog));
            });
            tog.resizeObs.observe(toggle);
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
        if (!tog.toggleEl) return;
        const target = Math.max(tog.items.length, 1);
        const toggleIdx = this.toggles.indexOf(tog);
        if (toggleIdx < 0) return;
        while (tog.btnEls.length < target) {
            const sideIdx = tog.btnEls.length;
            const { btn, sym, lbl } = this.buildButton(tog, toggleIdx, sideIdx);
            tog.toggleEl.appendChild(btn);
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

    /** Compute --thumb-x and --thumb-w from active button rect relative to track for ONE toggle. */
    private positionThumb(tog: ToggleState): void {
        if (!tog.toggleEl || tog.btnEls.length === 0) return;
        // Cleared state: hide thumb (no active button to slide over).
        if (tog.selectedValue == null) {
            tog.toggleEl.classList.remove("tb-ready");
            return;
        }
        const activeIdx = tog.items.findIndex(it => it.value === tog.selectedValue);
        const active = activeIdx >= 0 ? tog.btnEls[activeIdx] : tog.btnEls[0];
        if (!active) return;

        // Reset any prior overflow-safety transform so getBoundingClientRect is unscaled
        const priorTransform = tog.toggleEl.style.transform;
        tog.toggleEl.style.transform = "";

        const t = tog.toggleEl.getBoundingClientRect();
        const a = active.getBoundingClientRect();
        const padNum = parseFloat(getComputedStyle(tog.toggleEl).getPropertyValue("--toggle-padding")) || 0;
        const x = a.left - t.left - padNum;
        const w = a.width + 6;
        tog.toggleEl.style.setProperty("--thumb-x", x + "px");
        tog.toggleEl.style.setProperty("--thumb-w", w + "px");
        tog.toggleEl.classList.add("tb-ready");

        // Width-overflow safety
        if (this.viewportW > 0 && this.viewportH > 0 && tog.wrapEl) {
            const wrapW = tog.wrapEl.clientWidth - 2;
            const wrapH = tog.wrapEl.clientHeight - 2;
            const tW = tog.toggleEl.offsetWidth;
            const tH = tog.toggleEl.offsetHeight;
            const sx = tW > wrapW && tW > 0 ? wrapW / tW : 1;
            const sy = tH > wrapH && tH > 0 ? wrapH / tH : 1;
            const s = Math.min(sx, sy, 1);
            if (s < 0.999) {
                tog.toggleEl.style.transform = `scale(${s})`;
                tog.toggleEl.style.transformOrigin = "center center";
            } else if (priorTransform) {
                tog.toggleEl.style.transform = "";
            }
        }
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

        s.sizing.size.visible        = !isFit;
        s.sizing.textScaling.visible =  isFit;

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
            if (isFit) {
                this.togglesWrapEl.style.justifyContent = effectiveOrient === "vertical" ? "center" : "stretch";
                this.togglesWrapEl.style.alignItems = "stretch";
            } else {
                const v = (s.orientation.verticalAlign.value   as { value?: string })?.value || "stretch";
                const h = (s.orientation.horizontalAlign.value as { value?: string })?.value || "stretch";
                const mapY: Record<string, string> = { stretch: "stretch", top:  "flex-start", center: "center", bottom: "flex-end" };
                const mapX: Record<string, string> = { stretch: "stretch", left: "flex-start", center: "center", right:  "flex-end" };
                // justify-content has no "stretch" value; treat it as flex-start (toggles
                // stack from the start, equal-size still comes from the cross-axis side).
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
            const textFactor = Math.max(0, Math.min(100, Number(s.sizing.textScaling.value) || 0)) / 100;
            textScale = 1 + (containerScale - 1) * textFactor;
        } else {
            const fixedSize = Math.max(8, Math.min(400, Number(s.sizing.size.value) || REFERENCE_H));
            scaleVal = fixedSize / REFERENCE_H;
            textScale = scaleVal;
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
        }

        // ── Animation
        const dur = Math.max(0, Math.min(5000, Number(s.animation.transitionDuration.value) || 350));
        root.style.setProperty("--transition-duration", dur + "ms");
        const ease = (s.animation.transitionEase.value as { value?: string })?.value || "cubic-bezier(.22,.61,.36,1)";
        root.style.setProperty("--transition-ease", ease);

        // ── Sync active classes + reposition each thumb
        for (const t of this.toggles) {
            this.refreshActiveClasses(t);
        }
        requestAnimationFrame(() => {
            for (const t of this.toggles) this.positionThumb(t);
        });

        // Commit decisions live in update() (diff between pre-parse snapshot and post-parse
        // selectedValue). applyLayout is pure layout/style — never reads liveSelIds for
        // re-assertion, otherwise multi-instance flip-flop loops re-emerge.
    }
}
