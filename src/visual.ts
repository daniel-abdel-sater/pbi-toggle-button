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

interface ToggleItem {
    value: string;
    display: string;
    selectionId: ISelectionId;
}

// Lightweight diagnostic logging — set to true in dev, false for release
const TB_DEBUG = false;
let _tbInstanceCounter = 0;

export class Visual implements IVisual {
    private readonly _id: number = ++_tbInstanceCounter;
    private host: IVisualHost;
    private root: HTMLDivElement;
    private selectionManager: ISelectionManager;
    private fmtService: FormattingSettingsService;
    private fmtSettings: ToggleFormattingModel;

    private items: ToggleItem[] = [];
    private selectedValue: string | null = null;

    // Cache last-seen 2 values so external filters that reduce the dataView to 1 (or 0) values
    // don't break the toggle, AND so selectionId identity stays stable across updates.
    private cachedItems: ToggleItem[] = [];
    private cachedFieldQueryName: string | null = null;
    private hasRestoredSelection: boolean = false;
    private lastRenderKey: string = "";

    private viewportW: number = 0;
    private viewportH: number = 0;

    private wrapEl:    HTMLDivElement | null = null;
    private toggleEl:  HTMLDivElement | null = null;
    private btnAEl:    HTMLButtonElement | null = null;
    private btnBEl:    HTMLButtonElement | null = null;
    private symAEl:    HTMLSpanElement | null = null;
    private symBEl:    HTMLSpanElement | null = null;
    private lblAEl:    HTMLSpanElement | null = null;
    private lblBEl:    HTMLSpanElement | null = null;
    private titleEl:   HTMLDivElement | null = null;
    private resizeObs: ResizeObserver | null = null;

    private static POSITION_CLASSES = [
        "pos-top-left", "pos-top-center", "pos-top-right",
        "pos-left", "pos-right",
        "pos-bottom-left", "pos-bottom-center", "pos-bottom-right"
    ];

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
                // §11.0c: text-typed ItemDropdowns are not reliably bound by populate.
                // Force-sync from metadata so dropdown changes reflect live without page nav.
                const meta = dv.metadata?.objects as Record<string, Record<string, unknown> | undefined> | undefined;
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
                syncDropdown(this.fmtSettings.sizing.sizeMode,           "sizing",    "sizeMode");
                syncDropdown(this.fmtSettings.title.titlePosition,       "title",     "titlePosition");
                syncDropdown(this.fmtSettings.animation.transitionEase,  "animation", "transitionEase");
            }

            const cat = dv?.categorical?.categories?.[0];
            const hasField = !!cat && Array.isArray(cat.values);
            if (!hasField) { this.renderLanding(); return; }

            // Field change → reset cache and require a fresh restore
            const queryName = cat.source?.queryName || null;
            if (queryName !== this.cachedFieldQueryName) {
                this.log(`field changed: "${this.cachedFieldQueryName}" → "${queryName}" — cache cleared, restore=false`);
                this.cachedItems = [];
                this.cachedFieldQueryName = queryName;
                this.hasRestoredSelection = false;
            }

            // Collect up to 3 distinct values to detect the "too many" error
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
                // Rebuild items ONLY when values actually changed — keeps selectionId identity
                // stable across updates so the multi-instance loop stays fixed.
                const currentValues = distinct.map(d => d.raw == null ? "(blank)" : String(d.raw));
                const cachedValues = this.cachedItems.map(i => i.value);
                const valuesChanged = this.cachedItems.length !== 2 ||
                    currentValues[0] !== cachedValues[0] || currentValues[1] !== cachedValues[1];

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
                } else {
                    this.items = this.cachedItems;
                }

                // Priority: live selection > (once) persisted > (once) force-default A.
                const liveSelIds = this.selectionManager.getSelectionIds() || [];
                const liveMatch = this.items.find(item =>
                    liveSelIds.some(s => (s as unknown as { equals?: (o: ISelectionId) => boolean }).equals?.(item.selectionId))
                );
                const persisted = (dv.metadata?.objects as { toolbar?: { selectedValue?: string } } | undefined)
                    ?.toolbar?.selectedValue;

                if (liveMatch) {
                    this.selectedValue = liveMatch.value;
                    this.hasRestoredSelection = true;
                } else if (!this.hasRestoredSelection) {
                    this.hasRestoredSelection = true;
                    if (typeof persisted === "string" && persisted !== "" &&
                        (persisted === this.items[0].value || persisted === this.items[1].value)) {
                        this.selectedValue = persisted;
                        const target = this.items.find(i => i.value === persisted)!;
                        this.selectionManager.select(target.selectionId, false);
                    } else {
                        this.selectedValue = this.items[0].value;
                        this.selectionManager.select(this.items[0].selectionId, false);
                        this.persist(this.items[0].value);
                    }
                }
                // else: already restored — preserve selectedValue, never auto-reassert.
            } else if ((n === 1 || n === 0) && this.cachedItems.length === 2) {
                this.items = this.cachedItems;
                if (n === 1) {
                    const remaining = distinct[0].raw == null ? "(blank)" : String(distinct[0].raw);
                    const match = this.items.find(it => it.value === remaining);
                    if (match) this.selectedValue = match.value;
                }
            } else {
                if (n === 0) this.renderLanding();
                else this.renderError(n);
                return;
            }

            // Render-key gate: rebuild DOM only when STRUCTURE changes. Anything that's just a
            // CSS-var tweak (colors, alphas, durations, spread) goes through applyLayout() only.
            const s = this.fmtSettings;
            const titleText = String(s.title.titleText.value ?? "").trim();
            const showTitle = s.title.showTitle.value === true && titleText !== "";
            const titlePos  = (s.title.titlePosition.value as { value?: string })?.value || "top-left";
            const showSymbols = s.content.showSymbols.value !== false;
            const showLabels  = s.content.showLabels.value !== false;
            const symA = String(s.content.symbolA.value ?? "");
            const symB = String(s.content.symbolB.value ?? "");
            const renderKey = [
                this.items[0].display, this.items[1].display,
                showTitle ? "T" : "t", showTitle ? titleText : "", showTitle ? titlePos : "",
                showSymbols ? "S" : "s", symA, symB,
                showLabels ? "L" : "l"
            ].join("␟");

            if (renderKey !== this.lastRenderKey || !this.toggleEl) {
                this.renderToggle();
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
        return this.fmtService.buildFormattingModel(this.fmtSettings);
    }

    // ── Selection sync ─────────────────────────────────────────────

    private resyncFromSelectionManager(): void {
        const selIds = this.selectionManager.getSelectionIds() || [];
        if (this.items.length === 0) return;
        if (selIds.length === 0) return; // preserve our local choice
        for (const item of this.items) {
            if (selIds.some(s => (s as unknown as { equals?: (o: ISelectionId) => boolean }).equals?.(item.selectionId))) {
                this.selectedValue = item.value;
                return;
            }
        }
        // Selections present but none match ours — keep state.
    }

    private persist(val: string | null): void {
        this.host.persistProperties({
            merge: [{
                objectName: "toolbar",
                properties: { selectedValue: val == null ? "" : val },
                selector: null as unknown as powerbi.data.Selector
            }]
        });
    }

    // ── Click handling ─────────────────────────────────────────────

    private onButtonClick(side: "A" | "B"): void {
        if (this.items.length !== 2) return;
        const clicked = side === "A" ? this.items[0] : this.items[1];
        if (this.selectedValue === clicked.value) return; // strictly binary, no-op on active

        this.selectionManager.select(clicked.selectionId, false);
        this.selectedValue = clicked.value;
        this.persist(clicked.value);
        this.refreshActiveClasses();
        this.positionThumb();
    }

    private refreshActiveClasses(): void {
        if (!this.btnAEl || !this.btnBEl) return;
        const isA = this.items[0] && this.selectedValue === this.items[0].value;
        const isB = this.items[1] && this.selectedValue === this.items[1].value;
        this.btnAEl.classList.toggle("is-active", isA);
        this.btnBEl.classList.toggle("is-active", isB);
        this.btnAEl.setAttribute("aria-pressed", String(isA));
        this.btnBEl.setAttribute("aria-pressed", String(isB));
    }

    // ── Rendering ──────────────────────────────────────────────────

    private clearRoot(): void {
        if (this.resizeObs) { this.resizeObs.disconnect(); this.resizeObs = null; }
        while (this.root.firstChild) this.root.removeChild(this.root.firstChild);
        for (const cls of Visual.POSITION_CLASSES) this.root.classList.remove(cls);
        this.wrapEl = null;
        this.toggleEl = null;
        this.btnAEl = null; this.btnBEl = null;
        this.symAEl = null; this.symBEl = null;
        this.lblAEl = null; this.lblBEl = null;
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

        const s = this.fmtSettings;
        const titleText = String(s.title.titleText.value ?? "").trim();
        const showTitle = s.title.showTitle.value === true && titleText !== "";
        const position = (s.title.titlePosition.value as { value?: string })?.value || "top-left";
        const validPos = Visual.POSITION_CLASSES.indexOf("pos-" + position) >= 0 ? position : "top-left";
        const showSymbols = s.content.showSymbols.value !== false;
        const showLabels  = s.content.showLabels.value !== false;
        const symA = String(s.content.symbolA.value ?? "");
        const symB = String(s.content.symbolB.value ?? "");

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
        toggle.setAttribute("role", "group");

        const buildBtn = (side: "A" | "B"): { btn: HTMLButtonElement; sym: HTMLSpanElement; lbl: HTMLSpanElement } => {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = `tb-btn tb-btn-${side.toLowerCase()}`;

            const sym = document.createElement("span");
            sym.className = "tb-sym";
            sym.textContent = side === "A" ? symA : symB;
            if (!showSymbols || !sym.textContent) sym.classList.add("is-hidden");

            const lbl = document.createElement("span");
            lbl.className = "tb-lbl";
            lbl.textContent = side === "A" ? this.items[0].display : this.items[1].display;
            if (!showLabels) lbl.classList.add("is-hidden");

            btn.appendChild(sym);
            btn.appendChild(lbl);
            btn.addEventListener("click", (e) => { e.stopPropagation(); this.onButtonClick(side); });
            return { btn, sym, lbl };
        };

        const a = buildBtn("A");
        const b = buildBtn("B");
        toggle.appendChild(a.btn);
        toggle.appendChild(b.btn);
        wrap.appendChild(toggle);
        this.root.appendChild(wrap);

        this.toggleEl = toggle;
        this.btnAEl = a.btn; this.symAEl = a.sym; this.lblAEl = a.lbl;
        this.btnBEl = b.btn; this.symBEl = b.sym; this.lblBEl = b.lbl;

        this.refreshActiveClasses();

        // Right-click → PBI context menu (drillthrough on selected value)
        this.root.addEventListener("contextmenu", (e: MouseEvent) => {
            const sid = this.selectedValue
                ? this.items.find(i => i.value === this.selectedValue)?.selectionId
                : null;
            this.selectionManager.showContextMenu(sid || ({} as ISelectionId), { x: e.clientX, y: e.clientY });
            e.preventDefault();
        });

        // Resize observer — reposition thumb when container size changes
        if (typeof ResizeObserver !== "undefined") {
            this.resizeObs = new ResizeObserver(() => {
                requestAnimationFrame(() => this.positionThumb());
            });
            this.resizeObs.observe(this.toggleEl);
        }
    }

    /** Compute --thumb-x and --thumb-w from active button rect relative to track. */
    private positionThumb(): void {
        if (!this.toggleEl || !this.btnAEl || !this.btnBEl) return;
        const isB = this.items[1] && this.selectedValue === this.items[1].value;
        const active = isB ? this.btnBEl : this.btnAEl;

        // Reset any prior overflow-safety transform so getBoundingClientRect is unscaled
        const priorTransform = this.toggleEl.style.transform;
        this.toggleEl.style.transform = "";

        const t = this.toggleEl.getBoundingClientRect();
        const a = active.getBoundingClientRect();
        const padNum = parseFloat(getComputedStyle(this.toggleEl).getPropertyValue("--toggle-padding")) || 0;
        const x = a.left - t.left - padNum;
        const w = a.width + 6;
        this.toggleEl.style.setProperty("--thumb-x", x + "px");
        this.toggleEl.style.setProperty("--thumb-w", w + "px");
        this.toggleEl.classList.add("tb-ready");

        // Width-overflow safety: scale-to-fit if natural width exceeds container
        if (this.viewportW > 0 && this.viewportH > 0 && this.wrapEl) {
            const wrapW = this.wrapEl.clientWidth - 2;
            const wrapH = this.wrapEl.clientHeight - 2;
            const tW = this.toggleEl.offsetWidth;
            const tH = this.toggleEl.offsetHeight;
            const sx = tW > wrapW && tW > 0 ? wrapW / tW : 1;
            const sy = tH > wrapH && tH > 0 ? wrapH / tH : 1;
            const s = Math.min(sx, sy, 1);
            if (s < 0.999) {
                this.toggleEl.style.transform = `scale(${s})`;
                this.toggleEl.style.transformOrigin = "center center";
            } else if (priorTransform) {
                // Keep no transform when not needed
                this.toggleEl.style.transform = "";
            }
        }
    }

    private applyLayout(): void {
        if (!this.toggleEl) return;
        const s = this.fmtSettings;
        const root = this.root;

        // ── Title
        if (this.titleEl) {
            this.titleEl.style.color = clr(s.title.titleColor, "#334155");
            const titleFs = Math.max(8, Math.min(48, Number(s.title.titleFontSize.value) || 12));
            this.titleEl.style.fontSize = titleFs + "px";
        }

        // ── Sizing
        // sizeMode = "auto"  → Fit Container: toggle fills both dims; padding scales with container; text uses user font sizes (optionally scaled by Text Scaling %).
        // sizeMode = "fixed" → Fixed Size (px) is the master: it drives proportional padding + text + width.
        const sizeMode = (s.sizing.sizeMode.value as { value?: string })?.value || "fixed";
        const isFit = sizeMode === "auto";
        this.root.classList.toggle("tb-fit", isFit);

        // Conditional slice visibility — keep the format pane lean
        s.sizing.size.visible        = !isFit;
        s.sizing.textScaling.visible =  isFit;

        const REFERENCE_H = 30;
        let scaleVal: number;     // drives capsule chrome (padding + gap)
        let textScale: number;    // drives label + symbol font size
        if (isFit) {
            const wrapH = this.wrapEl ? this.wrapEl.clientHeight : (this.viewportH - 4);
            const containerScale = Math.max(0.5, Math.min(8, (wrapH || REFERENCE_H) / REFERENCE_H));
            scaleVal = containerScale;
            // Text scaling factor: 0 = text fixed at user size, 100 = text fully scales with container.
            const textFactor = Math.max(0, Math.min(100, Number(s.sizing.textScaling.value) || 0)) / 100;
            textScale = 1 + (containerScale - 1) * textFactor;
        } else {
            // Fixed Size is the master — drives chrome AND text proportionally.
            const fixedSize = Math.max(8, Math.min(400, Number(s.sizing.size.value) || REFERENCE_H));
            scaleVal = fixedSize / REFERENCE_H;
            textScale = scaleVal;
        }
        root.style.setProperty("--tb-scale", String(scaleVal));
        root.style.setProperty("--tb-text-scale", String(textScale));

        // ── Per-element font sizes (still multiplied by --tb-scale)
        const labelFs  = Math.max(6, Math.min(72, Number(s.content.labelFontSize.value)  || 12));
        const symbolFs = Math.max(6, Math.min(72, Number(s.content.symbolFontSize.value) || 12));
        root.style.setProperty("--tb-label-fs",  labelFs  + "px");
        root.style.setProperty("--tb-symbol-fs", symbolFs + "px");

        // ── Capsule (radius / padding / surface alphas)
        // Roundness is a 0–100 % of the toggle's natural height. 100 % = pill (radius = height/2).
        const naturalHeight = isFit
            ? (this.wrapEl ? this.wrapEl.clientHeight : REFERENCE_H)
            : scaleVal * REFERENCE_H;
        const roundnessPct = Math.max(0, Math.min(100, Number(s.capsule.cornerRadius.value) || 0));
        const radius = (roundnessPct / 100) * (naturalHeight / 2);
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

        // ── Thumb (accent + glow) — accent drives the thumb tint and glow only.
        // Active symbol color is now its own setting (text card), independent of accent.
        const accentHex = clr(s.thumb.thumbGlowColor, "#60A5FA");
        const accentTriplet = hexToRgbTriplet(accentHex);
        root.style.setProperty("--thumb-glow-color", accentTriplet);
        root.style.setProperty("--thumb-bg-top", `rgba(${accentTriplet}, 0.18)`);
        root.style.setProperty("--thumb-bg-bot", `rgba(${accentTriplet}, 0.06)`);
        root.style.setProperty("--thumb-border", `rgba(${accentTriplet}, 0.35)`);

        const ringα  = Math.max(0, Math.min(100, Number(s.thumb.thumbRingAlpha.value)      || 0)) / 100;
        const bloomα = Math.max(0, Math.min(100, Number(s.thumb.thumbBloomAlpha.value)     || 0)) / 100;
        const spread = Math.max(0, Math.min(80,  Number(s.thumb.thumbGlowSpread.value)     || 14));
        const hlα    = Math.max(0, Math.min(100, Number(s.thumb.thumbHighlightAlpha.value) || 0)) / 100;
        root.style.setProperty("--thumb-ring-opacity",  String(ringα));
        root.style.setProperty("--thumb-bloom-opacity", String(bloomα));
        root.style.setProperty("--thumb-glow-spread",   spread + "px");
        root.style.setProperty("--thumb-inner-hl",      `rgba(255,255,255,${hlα})`);

        // ── Text
        root.style.setProperty("--label-active-color",    clr(s.text.labelActiveColor,    "#F1F5F9"));
        root.style.setProperty("--label-color",            clr(s.text.labelInactiveColor,  "#94A3B8"));
        root.style.setProperty("--symbol-color-active",   clr(s.text.symbolActiveColor,   "#60A5FA"));
        root.style.setProperty("--symbol-color-inactive", clr(s.text.symbolInactiveColor, "#94A3B8"));
        const symα = Math.max(0, Math.min(100, Number(s.text.symbolInactiveAlpha.value) || 0)) / 100;
        root.style.setProperty("--symbol-opacity-inactive", String(symα));

        // ── Animation
        const dur = Math.max(0, Math.min(5000, Number(s.animation.transitionDuration.value) || 350));
        root.style.setProperty("--transition-duration", dur + "ms");
        const ease = (s.animation.transitionEase.value as { value?: string })?.value || "cubic-bezier(.22,.61,.36,1)";
        root.style.setProperty("--transition-ease", ease);

        // ── Sync active classes (handles cross-filter / external selection changes)
        this.refreshActiveClasses();

        // ── Position thumb (after layout is settled — needs button rects to be measurable)
        requestAnimationFrame(() => this.positionThumb());
    }
}
