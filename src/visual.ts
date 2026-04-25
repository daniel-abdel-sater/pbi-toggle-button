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
import { ToggleFormattingModel, clr } from "./settings";

interface ToggleItem {
    value: string;              // stringified for persistence / comparison
    display: string;            // label text
    selectionId: ISelectionId;
}

// Lightweight diagnostic logging — toggle via localStorage or remove entirely before ship
const TB_DEBUG = false;
let _tbInstanceCounter = 0;

export class Visual implements IVisual {
    private readonly _id: number = ++_tbInstanceCounter;
    private host: IVisualHost;
    private root: HTMLDivElement;
    private selectionManager: ISelectionManager;
    private fmtService: FormattingSettingsService;
    private fmtSettings: ToggleFormattingModel;

    private log(...args: unknown[]): void {
        if (!TB_DEBUG) return;
        // eslint-disable-next-line no-console
        console.log(`%c[TB #${this._id}]`, "color:#4f8cff;font-weight:bold", ...args);
    }

    private items: ToggleItem[] = [];
    private selectedValue: string | null = null;

    // Cache last-seen 2 values so external filters that reduce the dataView to 1 (or 0) values
    // don't break the toggle — instead we keep showing both sides and just reflect the filter.
    // Also keeps selectionId identity stable across updates so liveMatch comparisons work.
    private cachedItems: ToggleItem[] = [];
    private cachedFieldQueryName: string | null = null;
    private hasRestoredSelection: boolean = false;
    private lastRenderKey: string = ""; // reuse DOM when structure hasn't changed (no blink)

    private viewportW: number = 0;
    private viewportH: number = 0;

    private wrapEl: HTMLDivElement | null = null;
    private toggleEl: HTMLDivElement | null = null;
    private labelAEl: HTMLSpanElement | null = null;
    private labelBEl: HTMLSpanElement | null = null;
    private thumbEl: HTMLDivElement | null = null;
    private titleEl: HTMLDivElement | null = null;

    private static POSITION_CLASSES = [
        "pos-top-left", "pos-top-center", "pos-top-right",
        "pos-left", "pos-right",
        "pos-bottom-left", "pos-bottom-center", "pos-bottom-right"
    ];

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
        // External cross-filter: another visual changed the selection — resync thumb
        this.selectionManager.registerOnSelectCallback(() => {
            this.log("onSelectCallback fired; liveSelIds=", (this.selectionManager.getSelectionIds() || []).length);
            this.resyncFromSelectionManager();
            this.applyLayout();
        });
    }

    public update(options: VisualUpdateOptions): void {
        this.host.eventService.renderingStarted(options);
        try {
            this.viewportW = options.viewport?.width  || 0;
            this.viewportH = options.viewport?.height || 0;
            const dv: DataView | undefined = options.dataViews?.[0];
            this.log(`update() entry type=${options.type} hasDv=${!!dv} viewport=${this.viewportW}x${this.viewportH}`);

            if (dv) {
                this.fmtSettings = this.fmtService.populateFormattingSettingsModel(
                    ToggleFormattingModel, dv
                );
                // Text-typed ItemDropdowns are not reliably bound by populate (see PBI
                // visuals kb §11.0c) — force-sync from metadata so dropdown changes
                // reflect live without requiring a page navigation.
                const meta = (dv.metadata?.objects as { general?: Record<string, unknown> } | undefined)?.general;
                const syncDropdown = (slice: formattingSettings.ItemDropdown, propName: string): void => {
                    const raw = meta?.[propName];
                    if (typeof raw === "string") {
                        const items = (slice.items as Array<{ value: string; displayName: string }> | undefined) || [];
                        const item = items.find(it => it.value === raw);
                        if (item) slice.value = item;
                    }
                };
                syncDropdown(this.fmtSettings.general.sizeMode,      "sizeMode");
                syncDropdown(this.fmtSettings.general.titlePosition, "titlePosition");
                syncDropdown(this.fmtSettings.general.labelAlign,    "labelAlign");
            }

            const cat = dv?.categorical?.categories?.[0];
            const hasField = !!cat && Array.isArray(cat.values);

            if (!hasField) {
                this.renderLanding();
                return;
            }

            // Reset the cache if the user bound a different field — and require a fresh restore
            const queryName = cat.source?.queryName || null;
            if (queryName !== this.cachedFieldQueryName) {
                this.log(`field changed: "${this.cachedFieldQueryName}" → "${queryName}" — cache cleared, restore=false`);
                this.cachedItems = [];
                this.cachedFieldQueryName = queryName;
                this.hasRestoredSelection = false;
            }

            // Collect up to 3 distinct values so we can detect the "too many" error
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

            // Branch: exactly 2 → build-or-reuse + restore once; 1/0 with cache → reuse; else error/landing.
            if (n === 2) {
                // Rebuild items ONLY when values actually changed — otherwise reuse cached ones
                // so selectionId identity stays stable across updates. Rebuilding every update
                // causes .equals() comparisons against previously-stored ids to fail, which
                // triggers re-rehydration → re-select → another update → endless loop (critical
                // when multiple instances of this visual are on the same page with different fields).
                const currentValues = distinct.map(d => d.raw == null ? "(blank)" : String(d.raw));
                const cachedValues = this.cachedItems.map(i => i.value);
                const valuesChanged = this.cachedItems.length !== 2 ||
                    currentValues[0] !== cachedValues[0] || currentValues[1] !== cachedValues[1];

                this.log(`n=2 values=[${currentValues.join(",")}] cachedValues=[${cachedValues.join(",")}] valuesChanged=${valuesChanged} restored=${this.hasRestoredSelection}`);

                if (valuesChanged) {
                    this.items = distinct.map((d) => {
                        const sid = this.host.createSelectionIdBuilder()
                            .withCategory(cat, d.idx)
                            .createSelectionId();
                        const display = d.raw == null ? "(blank)" : String(d.raw);
                        return { value: display, display, selectionId: sid };
                    });
                    this.cachedItems = this.items;
                    this.hasRestoredSelection = false;
                    this.log("built fresh items (values changed)");
                } else {
                    this.items = this.cachedItems;
                    this.log("reusing cached items");
                }

                // Priority: live selection > (once) persisted > (once) force-default.
                const liveSelIds = this.selectionManager.getSelectionIds() || [];
                const liveMatch = this.items.find(item =>
                    liveSelIds.some(s => (s as unknown as { equals?: (o: ISelectionId) => boolean }).equals?.(item.selectionId))
                );
                const persisted = (dv.metadata?.objects as { toolbar?: { selectedValue?: string } } | undefined)
                    ?.toolbar?.selectedValue;
                this.log(`liveSelIds=${liveSelIds.length} liveMatch=${liveMatch ? liveMatch.value : "none"} persisted="${persisted}" selectedValue="${this.selectedValue}"`);

                if (liveMatch) {
                    this.log("→ branch: liveMatch adopt");
                    this.selectedValue = liveMatch.value;
                    this.hasRestoredSelection = true;
                } else if (!this.hasRestoredSelection) {
                    this.hasRestoredSelection = true;
                    if (typeof persisted === "string" && persisted !== "" &&
                        (persisted === this.items[0].value || persisted === this.items[1].value)) {
                        this.log(`→ branch: rehydrate persisted="${persisted}" → calling select()`);
                        this.selectedValue = persisted;
                        const target = this.items.find(i => i.value === persisted)!;
                        this.selectionManager.select(target.selectionId, false);
                    } else {
                        this.log(`→ branch: force-default "${this.items[0].value}" → calling select() + persist()`);
                        this.selectedValue = this.items[0].value;
                        this.selectionManager.select(this.items[0].selectionId, false);
                        this.persist(this.items[0].value);
                    }
                } else {
                    // Already restored — never auto-reassert. PBI's selectionManager only
                    // supports one active filter at a time across all visuals; stealing it
                    // back from whoever clicked last would override the user's real intent.
                    // Visual state is preserved in resync; the thumb stays where the user
                    // last placed it even if the live filter got taken over.
                    this.log(`→ branch: no-op (selectedValue="${this.selectedValue}")`);
                }
            } else if ((n === 1 || n === 0) && this.cachedItems.length === 2) {
                this.log(`n=${n} → reusing cached items; external filter resolution`);
                this.items = this.cachedItems;
                if (n === 1) {
                    const remaining = distinct[0].raw == null ? "(blank)" : String(distinct[0].raw);
                    const match = this.items.find(it => it.value === remaining);
                    if (match) {
                        this.log(`external filter matches cached item "${match.value}" → selectedValue=${match.value}`);
                        this.selectedValue = match.value;
                    } else {
                        this.log(`external filter value "${remaining}" doesn't match cache — keeping selectedValue`);
                    }
                }
            } else {
                // No valid cache to fall back on — show the appropriate non-toggle state.
                if (n === 0) this.renderLanding();
                else this.renderError(n);
                return;
            }

            // Only rebuild DOM when structure actually changes — otherwise reuse existing
            // elements so format-pane / settings updates don't cause a visible blink.
            const g = this.fmtSettings.general;
            const titleText = String(g.titleText.value ?? "").trim();
            const showTitle = g.showTitle.value === true && titleText !== "";
            const titlePos  = (g.titlePosition.value as { value?: string })?.value || "top-left";
            const renderKey = [
                this.items[0].display, this.items[1].display,
                showTitle ? "T" : "t", showTitle ? titleText : "", showTitle ? titlePos : ""
            ].join("\u241F");

            if (renderKey !== this.lastRenderKey || !this.toggleEl) {
                this.log(`renderToggle() — structure changed: "${this.lastRenderKey}" → "${renderKey}"`);
                this.renderToggle();
                this.lastRenderKey = renderKey;
            }
            this.applyLayout();
        } catch (e) {
            // Fail loud in console, keep visual renderable
            console.error("[ToggleButton] update error:", e);
        } finally {
            this.host.eventService.renderingFinished(options);
        }
    }

    public getFormattingModel(): powerbi.visuals.FormattingModel {
        return this.fmtService.buildFormattingModel(this.fmtSettings);
    }

    // ── Selection sync ─────────────────────────────────────────────

    private resyncFromSelectionManager(): void {
        const selIds = this.selectionManager.getSelectionIds() || [];
        if (this.items.length === 0) return;
        if (selIds.length === 0) {
            // Don't null out our choice — another visual's interaction may have cleared our
            // selectionManager, but our last user choice is still what this visual represents.
            // The update() path will re-assert the filter.
            this.log("resync: selIds empty — preserving selectedValue");
            return;
        }
        for (const item of this.items) {
            if (selIds.some(s => (s as unknown as { equals?: (o: ISelectionId) => boolean }).equals?.(item.selectionId))) {
                this.log(`resync: matched "${item.value}"`);
                this.selectedValue = item.value;
                return;
            }
        }
        // Selections exist but don't match our items — another visual's filter. Keep our state.
        this.log("resync: selIds present but no match — preserving selectedValue");
    }

    private persist(val: string | null): void {
        this.log(`persist("${val}")`);
        this.host.persistProperties({
            merge: [{
                objectName: "toolbar",
                properties: { selectedValue: val == null ? "" : val },
                selector: null as unknown as powerbi.data.Selector
            }]
        });
    }

    // ── Click handling ─────────────────────────────────────────────

    private onLabelClick(side: "A" | "B"): void {
        if (this.items.length !== 2) return;
        const clickedVal = side === "A" ? this.items[0].value : this.items[1].value;
        this.log(`onLabelClick(${side}) clickedVal="${clickedVal}" currentSelected="${this.selectedValue}"`);
        if (this.selectedValue === clickedVal) return;

        const item = side === "A" ? this.items[0] : this.items[1];
        this.log(`→ calling select() on "${clickedVal}"`);
        this.selectionManager.select(item.selectionId, false);
        this.selectedValue = clickedVal;
        this.persist(clickedVal);
        this.applyLayout();
    }

    // ── Rendering ──────────────────────────────────────────────────

    private clearRoot(): void {
        while (this.root.firstChild) this.root.removeChild(this.root.firstChild);
        for (const cls of Visual.POSITION_CLASSES) this.root.classList.remove(cls);
        this.wrapEl = null;
        this.toggleEl = null;
        this.labelAEl = null;
        this.labelBEl = null;
        this.thumbEl = null;
        this.titleEl = null;
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
        sub.textContent = "Bind a field with exactly 2 distinct values.";

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

    private renderToggle(): void {
        this.clearRoot();

        const g = this.fmtSettings.general;
        const titleText = String(g.titleText.value ?? "").trim();
        const showTitle = g.showTitle.value === true && titleText !== "";
        const position = (g.titlePosition.value as { value?: string })?.value || "top-left";
        const validPos = Visual.POSITION_CLASSES.indexOf("pos-" + position) >= 0 ? position : "top-left";

        if (showTitle) {
            this.root.classList.add("pos-" + validPos);
            const title = document.createElement("div");
            title.className = "tb-title";
            title.textContent = titleText;
            this.root.appendChild(title);
            this.titleEl = title;
        }

        const wrap = document.createElement("div");
        wrap.className = "tb-wrap";
        this.wrapEl = wrap;

        const toggle = document.createElement("div");
        toggle.className = "tb-toggle";
        toggle.setAttribute("role", "switch");
        toggle.tabIndex = 0;

        const labelA = document.createElement("span");
        labelA.className = "tb-label tb-label-a";
        labelA.textContent = this.items[0].display;

        const labelB = document.createElement("span");
        labelB.className = "tb-label tb-label-b";
        labelB.textContent = this.items[1].display;

        const thumb = document.createElement("div");
        thumb.className = "tb-thumb";

        toggle.appendChild(labelA);
        toggle.appendChild(labelB);
        toggle.appendChild(thumb);
        wrap.appendChild(toggle);
        this.root.appendChild(wrap);

        this.toggleEl = toggle;
        this.labelAEl = labelA;
        this.labelBEl = labelB;
        this.thumbEl = thumb;

        labelA.addEventListener("click", (e) => { e.stopPropagation(); this.onLabelClick("A"); });
        labelB.addEventListener("click", (e) => { e.stopPropagation(); this.onLabelClick("B"); });
        toggle.addEventListener("click", () => {
            // Clicked on thumb or padding — toggle to the opposite side (or pick A if nothing selected)
            if (this.selectedValue === null) this.onLabelClick("A");
            else if (this.selectedValue === this.items[0].value) this.onLabelClick("B");
            else this.onLabelClick("A");
        });
        toggle.addEventListener("keydown", (e: KeyboardEvent) => {
            if (e.key === " " || e.key === "Enter") {
                e.preventDefault();
                if (this.selectedValue === null) this.onLabelClick("A");
                else if (this.selectedValue === this.items[0].value) this.onLabelClick("B");
                else this.onLabelClick("A");
            }
        });

        // Right-click → PBI context menu (supports drillthrough on selected value)
        this.root.addEventListener("contextmenu", (e: MouseEvent) => {
            const sid = this.selectedValue
                ? this.items.find(i => i.value === this.selectedValue)?.selectionId
                : null;
            this.selectionManager.showContextMenu(
                sid || ({} as ISelectionId),
                { x: e.clientX, y: e.clientY }
            );
            e.preventDefault();
        });
    }

    private applyLayout(): void {
        if (!this.toggleEl || !this.labelAEl || !this.labelBEl || !this.thumbEl) return;
        const g = this.fmtSettings.general;

        // Reset any prior safety-transform so we measure unscaled
        this.toggleEl.style.transform = "";

        // Title styling (if present)
        if (this.titleEl) {
            this.titleEl.style.color = clr(g.titleColor, "#334155");
            const titleFs = Math.max(8, Math.min(48, Number(g.titleFontSize.value) || 12));
            this.titleEl.style.fontSize = titleFs + "px";
        }

        const mode = (g.sizeMode.value as { value?: string })?.value || "auto";
        const isAuto = mode !== "fixed";
        // Use the wrap's available space (respects grid cell size reserved by the title)
        const wrapRect = this.wrapEl ? this.wrapEl.getBoundingClientRect() : null;
        const wrapW = wrapRect ? wrapRect.width  : this.viewportW - 4;
        const wrapH = wrapRect ? wrapRect.height : this.viewportH - 4;
        const containerW = Math.max(10, wrapW - 2);
        const containerH = Math.max(10, wrapH - 2);
        // Auto: render height = container height directly (fills vertical space).
        // Fixed: render at user-chosen absolute size.
        const fixedSize = Math.max(16, Math.min(400, Number(g.size.value) || 48));
        const size = isAuto ? Math.max(16, Math.min(800, containerH)) : fixedSize;

        const rawPad   = Number(g.thumbPadding.value);
        const pad      = Math.max(0, Math.min(Math.floor(size / 2), isFinite(rawPad) ? rawPad : 1));
        const thumbH   = Math.max(1, size - pad * 2);
        const fs       = Math.round(size * 0.40);
        const labelPad = Math.round(size * 0.45);

        const rawRadius = Number(g.cornerRadius.value);
        const radius = !isFinite(rawRadius) || rawRadius < 0 ? 999 : rawRadius;
        // Thumb radius = track radius minus inset so corners stay concentric
        const thumbRadius = Math.max(0, radius - pad);

        const root = this.toggleEl;
        root.style.setProperty("--tb-pad",       pad + "px");
        root.style.setProperty("--tb-thumb",     thumbH + "px");
        root.style.setProperty("--tb-fs",        fs + "px");
        root.style.setProperty("--tb-label-pad", labelPad + "px");
        root.style.setProperty("--tb-radius",    radius + "px");

        const thumbColorA   = clr(g.thumbColorA,    "#22c55e");
        const thumbColorB   = clr(g.thumbColorB,    "#94a3b8");
        const labelAOn      = clr(g.labelColorAOn,  "#ffffff");
        const labelAOff     = clr(g.labelColorAOff, "#e2e8f0");
        const labelBOn      = clr(g.labelColorBOn,  "#ffffff");
        const labelBOff     = clr(g.labelColorBOff, "#e2e8f0");

        const isA = this.items[0] && this.selectedValue === this.items[0].value;
        const isB = this.items[1] && this.selectedValue === this.items[1].value;

        // Track background is always transparent — the thumb is the only indicator.
        root.style.background = "transparent";

        if (g.showBorder.value === true) {
            root.style.border = `1px solid ${clr(g.borderColor, "#1f2937")}`;
        } else {
            root.style.border = "none";
        }

        const showLabels = g.showLabels.value !== false;
        const alignRaw = (g.labelAlign.value as { value?: string })?.value || "center";
        const align: "left" | "center" | "right" =
            alignRaw === "left" || alignRaw === "right" ? alignRaw : "center";
        this.labelAEl.style.color = isA ? labelAOn : labelAOff;
        this.labelBEl.style.color = isB ? labelBOn : labelBOff;
        this.labelAEl.style.visibility = showLabels ? "visible" : "hidden";
        this.labelBEl.style.visibility = showLabels ? "visible" : "hidden";
        this.labelAEl.style.textAlign = align;
        this.labelBEl.style.textAlign = align;
        this.thumbEl.style.background = isB ? thumbColorB : thumbColorA;

        // Thumb position/width — measure after CSS var update
        requestAnimationFrame(() => {
            if (!this.thumbEl || !this.labelAEl || !this.labelBEl) return;

            // Equalise both label widths to the wider one so the two halves are symmetric
            this.labelAEl.style.minWidth = "";
            this.labelBEl.style.minWidth = "";
            const natA = this.labelAEl.offsetWidth;
            const natB = this.labelBEl.offsetWidth;
            const halfW = Math.max(natA, natB);
            this.labelAEl.style.minWidth = halfW + "px";
            this.labelBEl.style.minWidth = halfW + "px";

            if (!isA && !isB) {
                this.thumbEl.style.opacity = "0";
                return;
            }
            this.thumbEl.style.opacity = "1";
            this.thumbEl.style.height = thumbH + "px";
            this.thumbEl.style.top = pad + "px";
            this.thumbEl.style.borderRadius = thumbRadius + "px";

            // Both halves are the same width now — thumb = halfW on whichever side is active
            this.thumbEl.style.width = halfW + "px";
            this.thumbEl.style.left  = (isB ? pad + halfW : pad) + "px";

            // Width-overflow safety: height is already container height in auto mode,
            // so we only uniformly shrink if natural width exceeds container width.
            // Fixed mode shrinks on either axis.
            if (this.toggleEl && containerW > 0 && containerH > 0) {
                const tW = this.toggleEl.offsetWidth;
                const tH = this.toggleEl.offsetHeight;
                const sx = tW > containerW && tW > 0 ? containerW / tW : 1;
                const sy = tH > containerH && tH > 0 ? containerH / tH : 1;
                const s = Math.min(sx, sy, 1);
                if (s < 0.999) {
                    this.toggleEl.style.transform = `scale(${s})`;
                    this.toggleEl.style.transformOrigin = "center center";
                }
            }
        });
    }
}
