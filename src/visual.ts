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

    // DOM refs (per toggle)
    blockEl:  HTMLDivElement | null;
    titleEl:  HTMLDivElement | null;
    wrapEl:   HTMLDivElement | null;
    toggleEl: HTMLDivElement | null;
    btnAEl:   HTMLButtonElement | null;
    btnBEl:   HTMLButtonElement | null;
    symAEl:   HTMLSpanElement | null;
    symBEl:   HTMLSpanElement | null;
    lblAEl:   HTMLSpanElement | null;
    lblBEl:   HTMLSpanElement | null;
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
    // <cardName, <queryName, slotIdx>> — populated from `<card>.<card>IndexMap` in metadata; used
    // to resolve per-toggle slot reads. Stays stable across rebindings.
    private cardIndexMaps: Record<string, Record<string, number>> = { title: {}, content: {}, text: {}, thumb: {} };
    // <cardName, "all" | "toggle:<queryName>"> — read from metadata directly per §11.0c.
    private activeViewByCard: Record<string, string> = { title: "all", content: "all", text: "all", thumb: "all" };
    // Cards that have the Apply-to dropdown wired (grow this list as B2/C1/C2 land)
    private static readonly PER_TOGGLE_CARDS: ReadonlyArray<"title"|"content"|"text"|"thumb"> = ["title", "content", "text", "thumb"];

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
            this.log(`update() type=${options.type} hasDv=${!!dv} viewport=${this.viewportW}x${this.viewportH}`);

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
            const liveSelIds = this.selectionManager.getSelectionIds() || [];

            let anyError = false;
            const errorCounts: number[] = [];
            for (const tog of this.toggles) {
                const ok = this.parseToggle(tog, liveSelIds, persistedMap);
                if (!ok.ok) {
                    anyError = true;
                    errorCounts.push(ok.distinctCount);
                }
            }
            if (anyError && this.toggles.every(t => t.items.length !== 2)) {
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

            // Per-toggle structural fields — resolved title via Apply-to overrides
            const togglesKey = this.toggles.map(t => {
                const tShowTitle = this.resolveBool("title", "showTitle", t.queryName, true);
                const tTitleText = this.resolveText("title", "titleText", t.queryName, "");
                const tTitlePos  = this.resolveDropdown("title", "titlePosition", t.queryName, "top-left");
                const items = t.items.length === 2
                    ? `${t.items[0].display}|${t.items[1].display}`
                    : "none";
                return [t.queryName, items, tShowTitle ? "T" : "t", tShowTitle ? tTitleText : "", tShowTitle ? tTitlePos : ""].join("␟");
            }).join("␞");

            const renderKey = [
                togglesKey,
                this.toggles.length,
                orientationMode,
                showSymbols ? "S" : "s", symA, symB,
                showLabels ? "L" : "l"
            ].join("␟");

            if (renderKey !== this.lastRenderKey || !this.togglesWrapEl) {
                this.renderAll();
                this.lastRenderKey = renderKey;
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

    // ── Apply-to plumbing ──────────────────────────────────────────────

    /** Read the card's indexMap from metadata, assign slots to any new queryNames, persist if changed. */
    private ensureSlotsForCard(cardName: "title"|"content"|"text"|"thumb"): void {
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
    private refreshViewItemsAndRead(cardName: "title"|"content"|"text"|"thumb"): void {
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

    private applyCardVisibility(cardName: "title"|"content"|"text"|"thumb"): void {
        const view = this.activeViewByCard[cardName] || "all";
        const isAll = view === "all" || !view.startsWith("toggle:");
        const qn = isAll ? "" : view.slice("toggle:".length);
        const slotIdx = isAll ? -1 : (this.cardIndexMaps[cardName]?.[qn] ?? -1);

        // Per-card prop lists (drives both visibility AND resolve helpers)
        const cardProps: Record<string, string[]> = {
            title:   ["showTitle", "titleText", "titlePosition", "titleColor", "titleFontSize"],
            content: ["showSymbols", "symbolA", "symbolB", "symbolFontSize", "showLabels", "labelFontSize"],
            text:    ["labelActiveColor", "labelInactiveColor", "symbolActiveColor", "symbolInactiveColor", "symbolInactiveAlpha"],
            thumb:   ["thumbGlowColor", "thumbRingAlpha", "thumbBloomAlpha", "thumbGlowSpread", "thumbHighlightAlpha"]
        };
        const indexMapProps: Record<string, string> = {
            title: "titleIndexMap", content: "contentIndexMap", text: "textIndexMap", thumb: "thumbIndexMap"
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
            blockEl: null, titleEl: null, wrapEl: null, toggleEl: null,
            btnAEl: null, btnBEl: null,
            symAEl: null, symBEl: null,
            lblAEl: null, lblBEl: null,
            resizeObs: null
        };
    }

    /** Parse one toggle's data + restore selection. Returns {ok:true} for n=2 / cache reuse,
     *  or {ok:false, distinctCount} for an error state to bubble up. */
    private parseToggle(
        tog: ToggleState,
        liveSelIds: ReadonlyArray<unknown>,
        persistedMap: Record<string, string>
    ): { ok: boolean; distinctCount: number } {
        const cat = tog.cat;
        if (!cat || !Array.isArray(cat.values)) return { ok: false, distinctCount: 0 };

        // Field change → reset cache
        if (tog.queryName !== tog.cachedFieldQueryName) {
            tog.cachedItems = [];
            tog.cachedFieldQueryName = tog.queryName;
            tog.hasRestoredSelection = false;
        }

        // Collect up to 3 distinct values to detect "too many"
        const values = cat.values;
        const distinct: { raw: powerbi.PrimitiveValue; idx: number }[] = [];
        const seen = new Set<string>();
        for (let i = 0; i < values.length; i++) {
            const k = values[i] == null ? "(blank)" : String(values[i]);
            if (seen.has(k)) continue;
            seen.add(k);
            distinct.push({ raw: values[i], idx: i });
            if (distinct.length >= 3) break;
        }
        const n = distinct.length;

        if (n === 2) {
            const currentValues = distinct.map(d => d.raw == null ? "(blank)" : String(d.raw));
            const cachedValues = tog.cachedItems.map(i => i.value);
            const valuesChanged = tog.cachedItems.length !== 2 ||
                currentValues[0] !== cachedValues[0] || currentValues[1] !== cachedValues[1];

            // ALWAYS rebuild items from the CURRENT cat. Caching items across updates
            // previously worked because commitSelections() passed cached selectionId refs
            // to select() — the host echoed them back, so .equals() matched by reference.
            // Now commitSelections() passes FRESH ids (required to avoid "expr is undefined"
            // in PBI's SQL generator). After the round-trip, cached items have stale identity
            // expressions and .equals() degrades to column-only matching — every cached id
            // on column X falsely matches any live id on column X, so Array.find() always
            // returns items[0]. Rebuilding fresh each update keeps identity expressions
            // tied to the live cat, restoring per-row .equals() correctness.
            tog.items = distinct.map((d) => {
                const sid = this.host.createSelectionIdBuilder()
                    .withCategory(cat, d.idx)
                    .createSelectionId();
                const display = d.raw == null ? "(blank)" : String(d.raw);
                return { value: display, display, selectionId: sid };
            });

            if (valuesChanged) {
                tog.cachedItems = tog.items;
                tog.hasRestoredSelection = false;
            }
            // else: cachedItems retained for valuesChanged detection only

            // The click handler is the single source of truth for selectedValue.
            // We deliberately do NOT read it back from `liveSelIds` via `.equals()`:
            // when multiple fields are bound to the single `categorical.categories.for.in`
            // mapping, PBI emits a cross-product — cat.values has duplicates, and
            // cat.identity[i] encodes the full cross-row scope, not a per-field
            // selector. withCategory(cat, idx).createSelectionId() at different idx
            // values shares column-level expressions, so `.equals()` cross-matches
            // them and Array.find() always returns items[0], silently overwriting
            // the click's value. Trusting click + persisted-on-first-bind eliminates
            // that failure mode and is safe because:
            //   • applyLayout's needsFirstCommit branch always re-asserts the union
            //     after a click, keeping live selectionManager state aligned.
            //   • External cross-filter sync is handled separately by
            //     registerOnSelectCallback → resyncAllFromSelectionManager.
            if (!tog.hasRestoredSelection) {
                tog.hasRestoredSelection = true;
                const persistedVal = persistedMap[tog.queryName];
                if (typeof persistedVal === "string" && persistedVal !== "" &&
                    (persistedVal === tog.items[0].value || persistedVal === tog.items[1].value)) {
                    tog.selectedValue = persistedVal;
                    this.log(`  parseToggle(${tog.queryName}): first bind — restored from persisted=${persistedVal}`);
                } else {
                    tog.selectedValue = tog.items[0].value;
                    this.log(`  parseToggle(${tog.queryName}): first bind — force-default A=${tog.items[0].value}`);
                }
            } else {
                this.log(`  parseToggle(${tog.queryName}): preserve selectedValue=${tog.selectedValue}`);
            }
            return { ok: true, distinctCount: 2 };
        } else if ((n === 1 || n === 0) && tog.cachedItems.length === 2) {
            tog.items = tog.cachedItems;
            if (n === 1) {
                const remaining = distinct[0].raw == null ? "(blank)" : String(distinct[0].raw);
                const match = tog.items.find(it => it.value === remaining);
                if (match) tog.selectedValue = match.value;
            }
            return { ok: true, distinctCount: n };
        }
        // n === 0 with no cache → not yet usable
        // n >= 3 → wrong field
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
            if (t.selectedValue != null) map[t.queryName] = t.selectedValue;
        }
        this.host.persistProperties({
            merge: [{
                objectName: "toolbar",
                properties: { selectedValues: JSON.stringify(map) },
                selector: null as unknown as powerbi.data.Selector
            }]
        });
    }

    /** Apply the union of every toggle's currently-active selectionId. Replaces all selections
     *  with this set so each toggle's filter coexists with the others.
     *
     *  IMPORTANT: cached selectionIds in tog.items work for `.equals()` (which fixed the
     *  multi-instance loop) but PBI's QueryGenerator needs a FRESH SQExpr at select() time —
     *  passing a stale cached id throws "Cannot read properties of undefined (reading 'expr')".
     *  So we rebuild from the CURRENT `cat` here. */
    private commitSelections(): void {
        const ids: ISelectionId[] = [];
        const tracelog: string[] = [];
        for (const t of this.toggles) {
            if (t.selectedValue == null) continue;
            const cat = t.cat;
            if (!cat || !Array.isArray(cat.values)) continue;
            const idx = (cat.values as powerbi.PrimitiveValue[]).findIndex((v: powerbi.PrimitiveValue) =>
                (v == null ? "(blank)" : String(v)) === t.selectedValue
            );
            if (idx < 0) continue;
            const freshId = this.host.createSelectionIdBuilder()
                .withCategory(cat, idx)
                .createSelectionId();
            ids.push(freshId);
            tracelog.push(`${t.queryName}=${t.selectedValue}@${idx}`);
        }
        this.log(`commitSelections() ids.count=${ids.length} [${tracelog.join(", ")}]`);
        if (ids.length === 0) {
            this.selectionManager.clear();
        } else {
            (this.selectionManager.select as unknown as (ids: ISelectionId[], multi: boolean) => unknown)(ids, false);
        }
        const live = this.selectionManager.getSelectionIds() || [];
        this.log(`  → after select, getSelectionIds().length=${live.length}`);
    }

    private resyncAllFromSelectionManager(): void {
        const selIds = this.selectionManager.getSelectionIds() || [];
        if (selIds.length === 0) return; // preserve local choices
        for (const t of this.toggles) {
            for (const item of t.items) {
                if (selIds.some(s => (s as unknown as { equals?: (o: ISelectionId) => boolean }).equals?.(item.selectionId))) {
                    t.selectedValue = item.value;
                    break;
                }
            }
        }
    }

    // ── Click handling ─────────────────────────────────────────────────

    private onButtonClick(toggleIdx: number, side: "A" | "B"): void {
        const tog = this.toggles[toggleIdx];
        if (!tog || tog.items.length !== 2) return;
        const clicked = side === "A" ? tog.items[0] : tog.items[1];
        this.log(`onButtonClick(idx=${toggleIdx} qn=${tog.queryName} side=${side} clicked=${clicked.value} prevSelected=${tog.selectedValue})`);
        if (tog.selectedValue === clicked.value) { this.log(`  → no-op (already on ${side})`); return; }

        tog.selectedValue = clicked.value;
        this.commitSelections();
        this.persistAll();
        this.refreshActiveClasses(tog);
        this.positionThumb(tog);
    }

    private refreshActiveClasses(tog: ToggleState): void {
        if (!tog.btnAEl || !tog.btnBEl) return;
        const isA = tog.items[0] && tog.selectedValue === tog.items[0].value;
        const isB = tog.items[1] && tog.selectedValue === tog.items[1].value;
        tog.btnAEl.classList.toggle("is-active", isA);
        tog.btnBEl.classList.toggle("is-active", isB);
        tog.btnAEl.setAttribute("aria-pressed", String(isA));
        tog.btnBEl.setAttribute("aria-pressed", String(isB));
    }

    // ── Rendering ──────────────────────────────────────────────────────

    private clearRoot(): void {
        // Disconnect every per-toggle resize observer before nuking the DOM
        for (const t of this.toggles) {
            if (t.resizeObs) { t.resizeObs.disconnect(); t.resizeObs = null; }
            t.blockEl = null; t.titleEl = null; t.wrapEl = null; t.toggleEl = null;
            t.btnAEl = null; t.btnBEl = null;
            t.symAEl = null; t.symBEl = null;
            t.lblAEl = null; t.lblBEl = null;
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
        sub.textContent = "Bind 1–5 fields. Each must have exactly 2 distinct values.";
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
        title.textContent = "Need exactly 2 values";
        const sub = document.createElement("div");
        sub.className = "tb-landing-sub";
        sub.textContent = `Bound field has ${n} distinct value${n === 1 ? "" : "s"}. Use a field with exactly 2.`;
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
        showSymbols: boolean; symbolA: string; symbolB: string;
        showLabels: boolean; symbolFontSize: number; labelFontSize: number;
    } {
        return {
            showSymbols:    this.resolveBool("content", "showSymbols", qn, true),
            symbolA:        this.resolveText("content", "symbolA", qn, ""),
            symbolB:        this.resolveText("content", "symbolB", qn, ""),
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
            if (tog.items.length !== 2) continue;
            const t = this.resolveTitleForToggle(tog.queryName);
            const c = this.resolveContentForToggle(tog.queryName);
            this.renderToggleBlock(tog, i, {
                showTitle: t.show, titleText: t.text, validPos: t.validPos,
                showSymbols: c.showSymbols, showLabels: c.showLabels,
                symA: c.symbolA, symB: c.symbolB
            });
            togglesWrap.appendChild(tog.blockEl!);
        }
    }

    private renderToggleBlock(
        tog: ToggleState, idx: number,
        opts: {
            showTitle: boolean; titleText: string; validPos: string;
            showSymbols: boolean; showLabels: boolean; symA: string; symB: string;
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

        const buildBtn = (side: "A" | "B"): { btn: HTMLButtonElement; sym: HTMLSpanElement; lbl: HTMLSpanElement } => {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = `tb-btn tb-btn-${side.toLowerCase()}`;

            const sym = document.createElement("span");
            sym.className = "tb-sym";
            sym.textContent = side === "A" ? opts.symA : opts.symB;
            if (!opts.showSymbols || !sym.textContent) sym.classList.add("is-hidden");

            const lbl = document.createElement("span");
            lbl.className = "tb-lbl";
            lbl.textContent = side === "A" ? tog.items[0].display : tog.items[1].display;
            if (!opts.showLabels) lbl.classList.add("is-hidden");

            btn.appendChild(sym);
            btn.appendChild(lbl);
            btn.addEventListener("click", (e) => { e.stopPropagation(); this.onButtonClick(idx, side); });
            return { btn, sym, lbl };
        };

        const a = buildBtn("A");
        const b = buildBtn("B");
        toggle.appendChild(a.btn);
        toggle.appendChild(b.btn);
        wrap.appendChild(toggle);
        block.appendChild(wrap);

        tog.btnAEl = a.btn; tog.symAEl = a.sym; tog.lblAEl = a.lbl;
        tog.btnBEl = b.btn; tog.symBEl = b.sym; tog.lblBEl = b.lbl;

        this.refreshActiveClasses(tog);

        // Per-toggle resize observer
        if (typeof ResizeObserver !== "undefined") {
            tog.resizeObs = new ResizeObserver(() => {
                requestAnimationFrame(() => this.positionThumb(tog));
            });
            tog.resizeObs.observe(toggle);
        }
    }

    /** Compute --thumb-x and --thumb-w from active button rect relative to track for ONE toggle. */
    private positionThumb(tog: ToggleState): void {
        if (!tog.toggleEl || !tog.btnAEl || !tog.btnBEl) return;
        const isB = tog.items[1] && tog.selectedValue === tog.items[1].value;
        const active = isB ? tog.btnBEl : tog.btnAEl;

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

        const showVAlign = !isFit && effectiveOrient === "vertical";
        const showHAlign = !isFit && effectiveOrient === "horizontal";
        s.orientation.verticalAlign.visible   = showVAlign;
        s.orientation.horizontalAlign.visible = showHAlign;

        // Apply to the toggles wrap as inline justify-content (overrides the LESS default)
        if (this.togglesWrapEl) {
            if (isFit) {
                // Fit mode: alignment is moot (toggles fill the space). Use sane defaults.
                this.togglesWrapEl.style.justifyContent = effectiveOrient === "vertical" ? "center" : "stretch";
            } else if (effectiveOrient === "vertical") {
                const v = (s.orientation.verticalAlign.value as { value?: string })?.value || "center";
                const map: Record<string, string> = { top: "flex-start", center: "center", bottom: "flex-end" };
                this.togglesWrapEl.style.justifyContent = map[v] || "center";
            } else {
                const h = (s.orientation.horizontalAlign.value as { value?: string })?.value || "center";
                const map: Record<string, string> = { left: "flex-start", center: "center", right: "flex-end" };
                this.togglesWrapEl.style.justifyContent = map[h] || "center";
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

        // ── Per-toggle Content patching: text content, visibility classes, font sizes (CSS vars on each block)
        for (const t of this.toggles) {
            if (!t.toggleEl || !t.symAEl || !t.symBEl || !t.lblAEl || !t.lblBEl) continue;
            const c = this.resolveContentForToggle(t.queryName);

            // Symbols + labels (text + visibility patched in place — no DOM rebuild)
            t.symAEl.textContent = c.symbolA;
            t.symBEl.textContent = c.symbolB;
            t.symAEl.classList.toggle("is-hidden", !c.showSymbols || !c.symbolA);
            t.symBEl.classList.toggle("is-hidden", !c.showSymbols || !c.symbolB);
            t.lblAEl.classList.toggle("is-hidden", !c.showLabels);
            t.lblBEl.classList.toggle("is-hidden", !c.showLabels);

            // Per-block font-size CSS vars (overrides root-level vars for this block only)
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

            // Thumb (resolved per toggle)
            const accentHex = this.resolveColor("thumb", "thumbGlowColor", t.queryName, "#60A5FA");
            const accentTriplet = hexToRgbTriplet(accentHex);
            blk.style.setProperty("--thumb-glow-color", accentTriplet);
            blk.style.setProperty("--thumb-bg-top", `rgba(${accentTriplet}, 0.18)`);
            blk.style.setProperty("--thumb-bg-bot", `rgba(${accentTriplet}, 0.06)`);
            blk.style.setProperty("--thumb-border", `rgba(${accentTriplet}, 0.35)`);

            const ringα  = Math.max(0, Math.min(100, this.resolveNum("thumb", "thumbRingAlpha",      t.queryName, 18))) / 100;
            const bloomα = Math.max(0, Math.min(100, this.resolveNum("thumb", "thumbBloomAlpha",     t.queryName, 45))) / 100;
            const spread = Math.max(0, Math.min(80,  this.resolveNum("thumb", "thumbGlowSpread",     t.queryName, 14)));
            const hlα    = Math.max(0, Math.min(100, this.resolveNum("thumb", "thumbHighlightAlpha", t.queryName, 18))) / 100;
            blk.style.setProperty("--thumb-ring-opacity",  String(ringα));
            blk.style.setProperty("--thumb-bloom-opacity", String(bloomα));
            blk.style.setProperty("--thumb-glow-spread",   spread + "px");
            blk.style.setProperty("--thumb-inner-hl",      `rgba(255,255,255,${hlα})`);

            // Text (resolved per toggle)
            blk.style.setProperty("--label-active-color",    this.resolveColor("text", "labelActiveColor",    t.queryName, "#F1F5F9"));
            blk.style.setProperty("--label-color",            this.resolveColor("text", "labelInactiveColor",  t.queryName, "#94A3B8"));
            blk.style.setProperty("--symbol-color-active",   this.resolveColor("text", "symbolActiveColor",   t.queryName, "#60A5FA"));
            blk.style.setProperty("--symbol-color-inactive", this.resolveColor("text", "symbolInactiveColor", t.queryName, "#94A3B8"));
            const symα = Math.max(0, Math.min(100, this.resolveNum("text", "symbolInactiveAlpha", t.queryName, 55))) / 100;
            blk.style.setProperty("--symbol-opacity-inactive", String(symα));
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

        // ── First-time only: if any toggle just got a forced default (no live, no persisted),
        // commit the union to the host so cross-filter actually fires.
        const liveSelIdsForCheck = this.selectionManager.getSelectionIds() || [];
        const missing: string[] = [];
        for (const t of this.toggles) {
            if (!t.hasRestoredSelection || t.selectedValue == null) continue;
            const inLive = liveSelIdsForCheck.some(s2 =>
                t.items.some(i => (s2 as unknown as { equals?: (o: ISelectionId) => boolean }).equals?.(i.selectionId))
            );
            if (!inLive) missing.push(`${t.queryName}=${t.selectedValue}`);
        }
        if (missing.length > 0) {
            this.log(`needsFirstCommit: missing in live selections → [${missing.join(", ")}]`);
            this.commitSelections();
            this.persistAll();
        } else {
            this.log(`applyLayout end — all expected selections present in live (count=${liveSelIdsForCheck.length})`);
        }
    }
}
