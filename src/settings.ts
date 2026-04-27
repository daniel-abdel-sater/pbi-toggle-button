"use strict";

import powerbi from "powerbi-visuals-api";
import { formattingSettings } from "powerbi-visuals-utils-formattingmodel";
import FormattingSettingsCard = formattingSettings.SimpleCard;
import FormattingSettingsModel = formattingSettings.Model;

// FX (conditional formatting / lightning-bolt) — enable per CLAUDE.md §P25:
// `instanceKind: ConstantOrRule` on every ColorPicker that should expose the FX UI.
// ColorPicker only — NumUpDown / ToggleSwitch / ItemDropdown don't accept it.
const FX = powerbi.VisualEnumerationInstanceKinds.ConstantOrRule;

// Wildcard selector that tells PBI "this slice can be applied per data-point of the
// rule's inputRole". With this, PBI emits per-row FX rule output to cat.objects[i].
// Without it, FX rules are global (single resolved value across the whole visual).
// Equivalent to powerbi-visuals-utils-dataviewutils's `dataViewWildcard.createDataViewWildcardSelector(InstancesAndTotals)`;
// inlined to avoid the extra dependency.
const FX_SELECTOR = {
    data: [{ dataViewWildcard: { matchingOption: 0 } }]
} as unknown as powerbi.data.Selector;

// ── Title ────────────────────────────────────────────────────────────
// Apply-to dropdown pattern: "all" (defaults applied to every toggle) or
// "toggle:<queryName>" (overrides applied only to that toggle's slot).
// Slot indices stored in titleIndexMap so settings follow the field across rebindings.
const TITLE_POSITION_ITEMS = [
    { value: "top-left",      displayName: "Top Left" },
    { value: "top-center",    displayName: "Top Center" },
    { value: "top-right",     displayName: "Top Right" },
    { value: "left",          displayName: "Left" },
    { value: "right",         displayName: "Right" },
    { value: "bottom-left",   displayName: "Bottom Left" },
    { value: "bottom-center", displayName: "Bottom Center" },
    { value: "bottom-right",  displayName: "Bottom Right" }
];

class TitleCard extends FormattingSettingsCard {
    // ── Apply-to switcher (items rebuilt at runtime in visual.ts to include bound queryNames)
    view = new formattingSettings.ItemDropdown({
        name: "view", displayName: "Apply to",
        description: "All toggles: edits below apply as defaults to every toggle. Pick a specific toggle to override its title settings independently.",
        value: { value: "all", displayName: "All toggles" },
        items: [{ value: "all", displayName: "All toggles" }]
    });
    titleIndexMap = new formattingSettings.TextInput({
        name: "titleIndexMap", displayName: "Slot Map (internal)",
        description: "Internal — tracks which slot each field uses so overrides survive field reordering. Hidden in the format pane.",
        value: "", placeholder: ""
    });

    // ── "All" defaults (visible when view = "all")
    showTitle = new formattingSettings.ToggleSwitch({
        name: "showTitle", displayName: "Show Title",
        description: "Show or hide a text label next to the toggle (e.g. 'Currency').",
        value: true
    });
    titleText = new formattingSettings.TextInput({
        name: "titleText", displayName: "Title Text",
        description: "Text shown next to the toggle. Leave empty to hide the title.",
        value: "label", placeholder: "Enter title"
    });
    titlePosition = new formattingSettings.ItemDropdown({
        name: "titlePosition", displayName: "Title Position",
        description: "Where to place the title relative to the toggle.",
        value: { value: "left", displayName: "Left" },
        items: TITLE_POSITION_ITEMS
    });
    titleColor = new formattingSettings.ColorPicker({
        name: "titleColor", displayName: "Title Color",
        description: "Color of the title text.",
        value: { value: "#334155" }
    });
    titleFontSize = new formattingSettings.NumUpDown({
        name: "titleFontSize", displayName: "Title Font Size",
        description: "Size of the title text in pixels.",
        value: 16
    });

    // ── Slot 0 (visible when view = "toggle:<qn>" and indexMap[qn] = 0)
    showTitle_0     = new formattingSettings.ToggleSwitch({ name: "showTitle_0",     displayName: "Show Title",      value: true });
    titleText_0     = new formattingSettings.TextInput   ({ name: "titleText_0",     displayName: "Title Text",      value: "", placeholder: "Override (leave empty to inherit)" });
    titlePosition_0 = new formattingSettings.ItemDropdown({ name: "titlePosition_0", displayName: "Title Position",  value: { value: "left", displayName: "Left" }, items: TITLE_POSITION_ITEMS });
    titleColor_0    = new formattingSettings.ColorPicker ({ name: "titleColor_0",    displayName: "Title Color",     value: { value: "#334155" } });
    titleFontSize_0 = new formattingSettings.NumUpDown   ({ name: "titleFontSize_0", displayName: "Title Font Size", value: 16 });

    showTitle_1     = new formattingSettings.ToggleSwitch({ name: "showTitle_1",     displayName: "Show Title",      value: true });
    titleText_1     = new formattingSettings.TextInput   ({ name: "titleText_1",     displayName: "Title Text",      value: "", placeholder: "Override (leave empty to inherit)" });
    titlePosition_1 = new formattingSettings.ItemDropdown({ name: "titlePosition_1", displayName: "Title Position",  value: { value: "left", displayName: "Left" }, items: TITLE_POSITION_ITEMS });
    titleColor_1    = new formattingSettings.ColorPicker ({ name: "titleColor_1",    displayName: "Title Color",     value: { value: "#334155" } });
    titleFontSize_1 = new formattingSettings.NumUpDown   ({ name: "titleFontSize_1", displayName: "Title Font Size", value: 16 });

    showTitle_2     = new formattingSettings.ToggleSwitch({ name: "showTitle_2",     displayName: "Show Title",      value: true });
    titleText_2     = new formattingSettings.TextInput   ({ name: "titleText_2",     displayName: "Title Text",      value: "", placeholder: "Override (leave empty to inherit)" });
    titlePosition_2 = new formattingSettings.ItemDropdown({ name: "titlePosition_2", displayName: "Title Position",  value: { value: "left", displayName: "Left" }, items: TITLE_POSITION_ITEMS });
    titleColor_2    = new formattingSettings.ColorPicker ({ name: "titleColor_2",    displayName: "Title Color",     value: { value: "#334155" } });
    titleFontSize_2 = new formattingSettings.NumUpDown   ({ name: "titleFontSize_2", displayName: "Title Font Size", value: 16 });

    showTitle_3     = new formattingSettings.ToggleSwitch({ name: "showTitle_3",     displayName: "Show Title",      value: true });
    titleText_3     = new formattingSettings.TextInput   ({ name: "titleText_3",     displayName: "Title Text",      value: "", placeholder: "Override (leave empty to inherit)" });
    titlePosition_3 = new formattingSettings.ItemDropdown({ name: "titlePosition_3", displayName: "Title Position",  value: { value: "left", displayName: "Left" }, items: TITLE_POSITION_ITEMS });
    titleColor_3    = new formattingSettings.ColorPicker ({ name: "titleColor_3",    displayName: "Title Color",     value: { value: "#334155" } });
    titleFontSize_3 = new formattingSettings.NumUpDown   ({ name: "titleFontSize_3", displayName: "Title Font Size", value: 16 });

    showTitle_4     = new formattingSettings.ToggleSwitch({ name: "showTitle_4",     displayName: "Show Title",      value: true });
    titleText_4     = new formattingSettings.TextInput   ({ name: "titleText_4",     displayName: "Title Text",      value: "", placeholder: "Override (leave empty to inherit)" });
    titlePosition_4 = new formattingSettings.ItemDropdown({ name: "titlePosition_4", displayName: "Title Position",  value: { value: "left", displayName: "Left" }, items: TITLE_POSITION_ITEMS });
    titleColor_4    = new formattingSettings.ColorPicker ({ name: "titleColor_4",    displayName: "Title Color",     value: { value: "#334155" } });
    titleFontSize_4 = new formattingSettings.NumUpDown   ({ name: "titleFontSize_4", displayName: "Title Font Size", value: 16 });

    name: string = "title";
    displayName: string = "Title";
    slices: formattingSettings.Slice[] = [
        this.view, this.titleIndexMap,
        // "all" defaults
        this.showTitle, this.titleText, this.titlePosition, this.titleColor, this.titleFontSize,
        // slots 0..4
        this.showTitle_0, this.titleText_0, this.titlePosition_0, this.titleColor_0, this.titleFontSize_0,
        this.showTitle_1, this.titleText_1, this.titlePosition_1, this.titleColor_1, this.titleFontSize_1,
        this.showTitle_2, this.titleText_2, this.titlePosition_2, this.titleColor_2, this.titleFontSize_2,
        this.showTitle_3, this.titleText_3, this.titlePosition_3, this.titleColor_3, this.titleFontSize_3,
        this.showTitle_4, this.titleText_4, this.titlePosition_4, this.titleColor_4, this.titleFontSize_4
    ];
}

// ── Sizing ───────────────────────────────────────────────────────────
class SizingCard extends FormattingSettingsCard {
    sizeMode = new formattingSettings.ItemDropdown({
        name: "sizeMode", displayName: "Size Mode",
        description: "Fit Container: toggle stretches to fill its container in both directions; font and padding scale with the container height. Fixed: natural size, controlled by the Scale (%) slider below.",
        value: { value: "fixed", displayName: "Fixed" },
        items: [
            { value: "auto",  displayName: "Fit Container" },
            { value: "fixed", displayName: "Fixed" }
        ]
    });
    size = new formattingSettings.NumUpDown({
        name: "size", displayName: "Fixed Size (px)",
        description: "Master size of the toggle in pixels — drives both height and (proportionally) width. Reference 30 px = default; 60 px = roughly double everything; 15 px = half. Only used when Size Mode = Fixed.",
        value: 31
    });
    textScaling = new formattingSettings.NumUpDown({
        name: "textScaling", displayName: "Text Scaling (%)",
        description: "Only used when Size Mode = Fit Container. Controls how much label/symbol text scales when the container grows. 0 = text stays at the size you set under Content; 100 = text scales linearly with the container; values in between blend.",
        value: 0
    });

    name: string = "sizing";
    displayName: string = "Sizing";
    slices: formattingSettings.Slice[] = [this.sizeMode, this.size, this.textScaling];
}

// ── Capsule (track shape + surface) ─────────────────────────────────
class CapsuleCard extends FormattingSettingsCard {
    cornerRadius = new formattingSettings.NumUpDown({
        name: "cornerRadius", displayName: "Roundness (%)",
        description: "Corner roundness as a percentage of the toggle's height. 0 = sharp square; 50 = half-rounded; 100 = full pill (default). Every step now produces a visible change because the value scales with the actual toggle height.",
        value: 100
    });
    thumbPadding = new formattingSettings.NumUpDown({
        name: "thumbPadding", displayName: "Track Padding (px)",
        description: "Gap between the thumb and the track edges. 0 = thumb fills the track edge-to-edge; higher values produce a thinner thumb floating inside a larger capsule.",
        value: 3
    });
    trackBgTopAlpha = new formattingSettings.NumUpDown({
        name: "trackBgTopAlpha", displayName: "Track Top α (×1000)",
        description: "Top of the track's vertical gradient. White at this opacity divided by 1000. Default 40 = rgba(255,255,255,0.040). Higher = brighter top edge.",
        value: 40
    });
    trackBgBotAlpha = new formattingSettings.NumUpDown({
        name: "trackBgBotAlpha", displayName: "Track Bottom α (×1000)",
        description: "Bottom of the gradient. Default 15 = rgba(255,255,255,0.015). Together with the top alpha this creates the subtle top-to-bottom curve illusion.",
        value: 15
    });
    trackBorderAlpha = new formattingSettings.NumUpDown({
        name: "trackBorderAlpha", displayName: "Track Border α (×1000)",
        description: "1px outline around the capsule. White at this opacity / 1000. Default 60 = rgba(255,255,255,0.060). Defines the capsule's edge against the report background.",
        value: 60
    });

    name: string = "capsule";
    displayName: string = "Capsule";
    slices: formattingSettings.Slice[] = [
        this.cornerRadius, this.thumbPadding,
        this.trackBgTopAlpha, this.trackBgBotAlpha, this.trackBorderAlpha
    ];
}

// ── Content (symbols + label visibility) ────────────────────────────
class ContentCard extends FormattingSettingsCard {
    view = new formattingSettings.ItemDropdown({
        name: "view", displayName: "Apply to",
        description: "All toggles: edits below apply as defaults to every toggle. Pick a specific toggle to override its content settings independently.",
        value: { value: "all", displayName: "All toggles" },
        items: [{ value: "all", displayName: "All toggles" }]
    });
    contentIndexMap = new formattingSettings.TextInput({
        name: "contentIndexMap", displayName: "Slot Map (internal)",
        description: "Internal — tracks which slot each field uses so overrides survive field reordering.",
        value: "", placeholder: ""
    });

    showSymbols = new formattingSettings.ToggleSwitch({
        name: "showSymbols", displayName: "Show Symbols",
        description: "Show or hide the small mono-font character (e.g. '$', 'D') displayed before each label.",
        value: true
    });
    symbolA = new formattingSettings.TextInput({
        name: "symbolA", displayName: "Symbol A",
        description: "Symbol shown on the A side. Typically 1–3 characters (e.g. '$', '€', '#', 'Q1').",
        value: "$", placeholder: "e.g. $"
    });
    symbolB = new formattingSettings.TextInput({
        name: "symbolB", displayName: "Symbol B",
        description: "Symbol shown on the B side.",
        value: "D", placeholder: "e.g. D"
    });
    symbolC = new formattingSettings.TextInput({
        name: "symbolC", displayName: "Symbol C",
        description: "Symbol shown on the C side. Only renders when the bound field has 3 distinct values (three-segment toggle).",
        value: "M", placeholder: "e.g. M"
    });
    symbolFontSize = new formattingSettings.NumUpDown({
        name: "symbolFontSize", displayName: "Symbol Font Size (px)",
        description: "Symbol text size in pixels. Still multiplied by Sizing scale.",
        value: 12
    });
    showLabels = new formattingSettings.ToggleSwitch({
        name: "showLabels", displayName: "Show Labels",
        description: "Show or hide the uppercase label text. Labels come from your bound field's distinct values — they're not editable here.",
        value: true
    });
    labelFontSize = new formattingSettings.NumUpDown({
        name: "labelFontSize", displayName: "Label Font Size (px)",
        description: "Label text size in pixels. Still multiplied by Sizing scale.",
        value: 12
    });

    showSymbols_0    = new formattingSettings.ToggleSwitch({ name: "showSymbols_0",    displayName: "Show Symbols", value: true });
    symbolA_0        = new formattingSettings.TextInput   ({ name: "symbolA_0",        displayName: "Symbol A", value: "", placeholder: "Override (leave empty to inherit)" });
    symbolB_0        = new formattingSettings.TextInput   ({ name: "symbolB_0",        displayName: "Symbol B", value: "", placeholder: "Override (leave empty to inherit)" });
    symbolC_0        = new formattingSettings.TextInput   ({ name: "symbolC_0",        displayName: "Symbol C", value: "", placeholder: "Override (leave empty to inherit)" });
    symbolFontSize_0 = new formattingSettings.NumUpDown   ({ name: "symbolFontSize_0", displayName: "Symbol Font Size (px)", value: 12 });
    showLabels_0     = new formattingSettings.ToggleSwitch({ name: "showLabels_0",     displayName: "Show Labels", value: true });
    labelFontSize_0  = new formattingSettings.NumUpDown   ({ name: "labelFontSize_0",  displayName: "Label Font Size (px)", value: 12 });

    showSymbols_1    = new formattingSettings.ToggleSwitch({ name: "showSymbols_1",    displayName: "Show Symbols", value: true });
    symbolA_1        = new formattingSettings.TextInput   ({ name: "symbolA_1",        displayName: "Symbol A", value: "", placeholder: "Override (leave empty to inherit)" });
    symbolB_1        = new formattingSettings.TextInput   ({ name: "symbolB_1",        displayName: "Symbol B", value: "", placeholder: "Override (leave empty to inherit)" });
    symbolC_1        = new formattingSettings.TextInput   ({ name: "symbolC_1",        displayName: "Symbol C", value: "", placeholder: "Override (leave empty to inherit)" });
    symbolFontSize_1 = new formattingSettings.NumUpDown   ({ name: "symbolFontSize_1", displayName: "Symbol Font Size (px)", value: 12 });
    showLabels_1     = new formattingSettings.ToggleSwitch({ name: "showLabels_1",     displayName: "Show Labels", value: true });
    labelFontSize_1  = new formattingSettings.NumUpDown   ({ name: "labelFontSize_1",  displayName: "Label Font Size (px)", value: 12 });

    showSymbols_2    = new formattingSettings.ToggleSwitch({ name: "showSymbols_2",    displayName: "Show Symbols", value: true });
    symbolA_2        = new formattingSettings.TextInput   ({ name: "symbolA_2",        displayName: "Symbol A", value: "", placeholder: "Override (leave empty to inherit)" });
    symbolB_2        = new formattingSettings.TextInput   ({ name: "symbolB_2",        displayName: "Symbol B", value: "", placeholder: "Override (leave empty to inherit)" });
    symbolC_2        = new formattingSettings.TextInput   ({ name: "symbolC_2",        displayName: "Symbol C", value: "", placeholder: "Override (leave empty to inherit)" });
    symbolFontSize_2 = new formattingSettings.NumUpDown   ({ name: "symbolFontSize_2", displayName: "Symbol Font Size (px)", value: 12 });
    showLabels_2     = new formattingSettings.ToggleSwitch({ name: "showLabels_2",     displayName: "Show Labels", value: true });
    labelFontSize_2  = new formattingSettings.NumUpDown   ({ name: "labelFontSize_2",  displayName: "Label Font Size (px)", value: 12 });

    showSymbols_3    = new formattingSettings.ToggleSwitch({ name: "showSymbols_3",    displayName: "Show Symbols", value: true });
    symbolA_3        = new formattingSettings.TextInput   ({ name: "symbolA_3",        displayName: "Symbol A", value: "", placeholder: "Override (leave empty to inherit)" });
    symbolB_3        = new formattingSettings.TextInput   ({ name: "symbolB_3",        displayName: "Symbol B", value: "", placeholder: "Override (leave empty to inherit)" });
    symbolC_3        = new formattingSettings.TextInput   ({ name: "symbolC_3",        displayName: "Symbol C", value: "", placeholder: "Override (leave empty to inherit)" });
    symbolFontSize_3 = new formattingSettings.NumUpDown   ({ name: "symbolFontSize_3", displayName: "Symbol Font Size (px)", value: 12 });
    showLabels_3     = new formattingSettings.ToggleSwitch({ name: "showLabels_3",     displayName: "Show Labels", value: true });
    labelFontSize_3  = new formattingSettings.NumUpDown   ({ name: "labelFontSize_3",  displayName: "Label Font Size (px)", value: 12 });

    showSymbols_4    = new formattingSettings.ToggleSwitch({ name: "showSymbols_4",    displayName: "Show Symbols", value: true });
    symbolA_4        = new formattingSettings.TextInput   ({ name: "symbolA_4",        displayName: "Symbol A", value: "", placeholder: "Override (leave empty to inherit)" });
    symbolB_4        = new formattingSettings.TextInput   ({ name: "symbolB_4",        displayName: "Symbol B", value: "", placeholder: "Override (leave empty to inherit)" });
    symbolC_4        = new formattingSettings.TextInput   ({ name: "symbolC_4",        displayName: "Symbol C", value: "", placeholder: "Override (leave empty to inherit)" });
    symbolFontSize_4 = new formattingSettings.NumUpDown   ({ name: "symbolFontSize_4", displayName: "Symbol Font Size (px)", value: 12 });
    showLabels_4     = new formattingSettings.ToggleSwitch({ name: "showLabels_4",     displayName: "Show Labels", value: true });
    labelFontSize_4  = new formattingSettings.NumUpDown   ({ name: "labelFontSize_4",  displayName: "Label Font Size (px)", value: 12 });

    name: string = "content";
    displayName: string = "Content";
    slices: formattingSettings.Slice[] = [
        this.view, this.contentIndexMap,
        this.showSymbols, this.symbolA, this.symbolB, this.symbolC, this.symbolFontSize, this.showLabels, this.labelFontSize,
        this.showSymbols_0, this.symbolA_0, this.symbolB_0, this.symbolC_0, this.symbolFontSize_0, this.showLabels_0, this.labelFontSize_0,
        this.showSymbols_1, this.symbolA_1, this.symbolB_1, this.symbolC_1, this.symbolFontSize_1, this.showLabels_1, this.labelFontSize_1,
        this.showSymbols_2, this.symbolA_2, this.symbolB_2, this.symbolC_2, this.symbolFontSize_2, this.showLabels_2, this.labelFontSize_2,
        this.showSymbols_3, this.symbolA_3, this.symbolB_3, this.symbolC_3, this.symbolFontSize_3, this.showLabels_3, this.labelFontSize_3,
        this.showSymbols_4, this.symbolA_4, this.symbolB_4, this.symbolC_4, this.symbolFontSize_4, this.showLabels_4, this.labelFontSize_4
    ];
}

// ── Text (typography colours) ───────────────────────────────────────
class TextCard extends FormattingSettingsCard {
    view = new formattingSettings.ItemDropdown({
        name: "view", displayName: "Apply to",
        description: "All toggles or per-toggle override.",
        value: { value: "all", displayName: "All toggles" },
        items: [{ value: "all", displayName: "All toggles" }]
    });
    textIndexMap = new formattingSettings.TextInput({
        name: "textIndexMap", displayName: "Slot Map (internal)", value: "", placeholder: ""
    });
    labelActiveColor = new formattingSettings.ColorPicker({
        name: "labelActiveColor", displayName: "Label Color (Active)",
        description: "Color of the label on the currently selected side. Click the FX icon to drive this from a DAX measure.",
        value: { value: "#F1F5F9" },
        instanceKind: FX,
        selector: FX_SELECTOR
    });
    labelInactiveColor = new formattingSettings.ColorPicker({
        name: "labelInactiveColor", displayName: "Label Color (Inactive)",
        description: "Color of the label on the non-selected side. Click the FX icon to drive this from a DAX measure.",
        value: { value: "#94A3B8" },
        instanceKind: FX,
        selector: FX_SELECTOR
    });
    symbolActiveColor = new formattingSettings.ColorPicker({
        name: "symbolActiveColor", displayName: "Symbol Color (Active)",
        description: "Color of the symbol on the currently selected side. Default matches the Accent Color (Thumb card) but is independent — changing the accent later won't override this. Click the FX icon to drive this from a DAX measure.",
        value: { value: "#60A5FA" },
        instanceKind: FX,
        selector: FX_SELECTOR
    });
    symbolInactiveColor = new formattingSettings.ColorPicker({
        name: "symbolInactiveColor", displayName: "Symbol Color (Inactive)",
        description: "Color of the symbol on the non-selected side. Combined with Inactive Symbol α to produce the dimmed look. Click the FX icon to drive this from a DAX measure.",
        value: { value: "#94A3B8" },
        instanceKind: FX,
        selector: FX_SELECTOR
    });
    symbolInactiveAlpha = new formattingSettings.NumUpDown({
        name: "symbolInactiveAlpha", displayName: "Inactive Symbol α (×100)",
        description: "Opacity of the symbol on the non-selected side (value / 100). Default 55 = 0.55. Multiplies the Symbol Color (Inactive) above.",
        value: 55
    });

    labelActiveColor_0    = new formattingSettings.ColorPicker({ name: "labelActiveColor_0",    displayName: "Label Color (Active)",     value: { value: "#F1F5F9" }, instanceKind: FX, selector: FX_SELECTOR });
    labelInactiveColor_0  = new formattingSettings.ColorPicker({ name: "labelInactiveColor_0",  displayName: "Label Color (Inactive)",   value: { value: "#94A3B8" }, instanceKind: FX, selector: FX_SELECTOR });
    symbolActiveColor_0   = new formattingSettings.ColorPicker({ name: "symbolActiveColor_0",   displayName: "Symbol Color (Active)",    value: { value: "#60A5FA" }, instanceKind: FX, selector: FX_SELECTOR });
    symbolInactiveColor_0 = new formattingSettings.ColorPicker({ name: "symbolInactiveColor_0", displayName: "Symbol Color (Inactive)",  value: { value: "#94A3B8" }, instanceKind: FX, selector: FX_SELECTOR });
    symbolInactiveAlpha_0 = new formattingSettings.NumUpDown   ({ name: "symbolInactiveAlpha_0", displayName: "Inactive Symbol α (×100)", value: 55 });

    labelActiveColor_1    = new formattingSettings.ColorPicker({ name: "labelActiveColor_1",    displayName: "Label Color (Active)",     value: { value: "#F1F5F9" }, instanceKind: FX, selector: FX_SELECTOR });
    labelInactiveColor_1  = new formattingSettings.ColorPicker({ name: "labelInactiveColor_1",  displayName: "Label Color (Inactive)",   value: { value: "#94A3B8" }, instanceKind: FX, selector: FX_SELECTOR });
    symbolActiveColor_1   = new formattingSettings.ColorPicker({ name: "symbolActiveColor_1",   displayName: "Symbol Color (Active)",    value: { value: "#60A5FA" }, instanceKind: FX, selector: FX_SELECTOR });
    symbolInactiveColor_1 = new formattingSettings.ColorPicker({ name: "symbolInactiveColor_1", displayName: "Symbol Color (Inactive)",  value: { value: "#94A3B8" }, instanceKind: FX, selector: FX_SELECTOR });
    symbolInactiveAlpha_1 = new formattingSettings.NumUpDown   ({ name: "symbolInactiveAlpha_1", displayName: "Inactive Symbol α (×100)", value: 55 });

    labelActiveColor_2    = new formattingSettings.ColorPicker({ name: "labelActiveColor_2",    displayName: "Label Color (Active)",     value: { value: "#F1F5F9" }, instanceKind: FX, selector: FX_SELECTOR });
    labelInactiveColor_2  = new formattingSettings.ColorPicker({ name: "labelInactiveColor_2",  displayName: "Label Color (Inactive)",   value: { value: "#94A3B8" }, instanceKind: FX, selector: FX_SELECTOR });
    symbolActiveColor_2   = new formattingSettings.ColorPicker({ name: "symbolActiveColor_2",   displayName: "Symbol Color (Active)",    value: { value: "#60A5FA" }, instanceKind: FX, selector: FX_SELECTOR });
    symbolInactiveColor_2 = new formattingSettings.ColorPicker({ name: "symbolInactiveColor_2", displayName: "Symbol Color (Inactive)",  value: { value: "#94A3B8" }, instanceKind: FX, selector: FX_SELECTOR });
    symbolInactiveAlpha_2 = new formattingSettings.NumUpDown   ({ name: "symbolInactiveAlpha_2", displayName: "Inactive Symbol α (×100)", value: 55 });

    labelActiveColor_3    = new formattingSettings.ColorPicker({ name: "labelActiveColor_3",    displayName: "Label Color (Active)",     value: { value: "#F1F5F9" }, instanceKind: FX, selector: FX_SELECTOR });
    labelInactiveColor_3  = new formattingSettings.ColorPicker({ name: "labelInactiveColor_3",  displayName: "Label Color (Inactive)",   value: { value: "#94A3B8" }, instanceKind: FX, selector: FX_SELECTOR });
    symbolActiveColor_3   = new formattingSettings.ColorPicker({ name: "symbolActiveColor_3",   displayName: "Symbol Color (Active)",    value: { value: "#60A5FA" }, instanceKind: FX, selector: FX_SELECTOR });
    symbolInactiveColor_3 = new formattingSettings.ColorPicker({ name: "symbolInactiveColor_3", displayName: "Symbol Color (Inactive)",  value: { value: "#94A3B8" }, instanceKind: FX, selector: FX_SELECTOR });
    symbolInactiveAlpha_3 = new formattingSettings.NumUpDown   ({ name: "symbolInactiveAlpha_3", displayName: "Inactive Symbol α (×100)", value: 55 });

    labelActiveColor_4    = new formattingSettings.ColorPicker({ name: "labelActiveColor_4",    displayName: "Label Color (Active)",     value: { value: "#F1F5F9" }, instanceKind: FX, selector: FX_SELECTOR });
    labelInactiveColor_4  = new formattingSettings.ColorPicker({ name: "labelInactiveColor_4",  displayName: "Label Color (Inactive)",   value: { value: "#94A3B8" }, instanceKind: FX, selector: FX_SELECTOR });
    symbolActiveColor_4   = new formattingSettings.ColorPicker({ name: "symbolActiveColor_4",   displayName: "Symbol Color (Active)",    value: { value: "#60A5FA" }, instanceKind: FX, selector: FX_SELECTOR });
    symbolInactiveColor_4 = new formattingSettings.ColorPicker({ name: "symbolInactiveColor_4", displayName: "Symbol Color (Inactive)",  value: { value: "#94A3B8" }, instanceKind: FX, selector: FX_SELECTOR });
    symbolInactiveAlpha_4 = new formattingSettings.NumUpDown   ({ name: "symbolInactiveAlpha_4", displayName: "Inactive Symbol α (×100)", value: 55 });

    name: string = "text";
    displayName: string = "Text";
    slices: formattingSettings.Slice[] = [
        this.view, this.textIndexMap,
        this.labelActiveColor, this.labelInactiveColor, this.symbolActiveColor, this.symbolInactiveColor, this.symbolInactiveAlpha,
        this.labelActiveColor_0, this.labelInactiveColor_0, this.symbolActiveColor_0, this.symbolInactiveColor_0, this.symbolInactiveAlpha_0,
        this.labelActiveColor_1, this.labelInactiveColor_1, this.symbolActiveColor_1, this.symbolInactiveColor_1, this.symbolInactiveAlpha_1,
        this.labelActiveColor_2, this.labelInactiveColor_2, this.symbolActiveColor_2, this.symbolInactiveColor_2, this.symbolInactiveAlpha_2,
        this.labelActiveColor_3, this.labelInactiveColor_3, this.symbolActiveColor_3, this.symbolInactiveColor_3, this.symbolInactiveAlpha_3,
        this.labelActiveColor_4, this.labelInactiveColor_4, this.symbolActiveColor_4, this.symbolInactiveColor_4, this.symbolInactiveAlpha_4
    ];
}

// ── Thumb (accent + glow) ───────────────────────────────────────────
class ThumbCard extends FormattingSettingsCard {
    view = new formattingSettings.ItemDropdown({
        name: "view", displayName: "Apply to",
        description: "All toggles or per-toggle override.",
        value: { value: "all", displayName: "All toggles" },
        items: [{ value: "all", displayName: "All toggles" }]
    });
    thumbIndexMap = new formattingSettings.TextInput({
        name: "thumbIndexMap", displayName: "Slot Map (internal)", value: "", placeholder: ""
    });
    thumbGlowColor = new formattingSettings.ColorPicker({
        name: "thumbGlowColor", displayName: "Accent Color",
        description: "Drives the thumb's tinted gradient, the active symbol color, and the glow ring + bloom hue. The dominant brand color of the visual. Click the FX icon to drive this from a DAX measure.",
        value: { value: "#60A5FA" },
        instanceKind: FX,
        selector: FX_SELECTOR
    });
    thumbRingAlpha = new formattingSettings.NumUpDown({
        name: "thumbRingAlpha", displayName: "Ring α (×100)",
        description: "Opacity (value / 100) of the 1px tinted ring tightly hugging the thumb. Defines its sharp outer edge. Default 18 = 0.18.",
        value: 18
    });
    thumbBloomAlpha = new formattingSettings.NumUpDown({
        name: "thumbBloomAlpha", displayName: "Bloom α (×100)",
        description: "Opacity of the soft glow bloom radiating from beneath the thumb. Simulates ambient light leaking onto the surrounding surface — the main 'backlit' effect. Default 45 = 0.45.",
        value: 45
    });
    thumbGlowSpread = new formattingSettings.NumUpDown({
        name: "thumbGlowSpread", displayName: "Bloom Spread (px)",
        description: "How far the bloom extends in pixels. Larger = more diffuse, dreamier glow. 0 = no bloom.",
        value: 14
    });
    thumbHighlightAlpha = new formattingSettings.NumUpDown({
        name: "thumbHighlightAlpha", displayName: "Inner Highlight α (×100)",
        description: "Opacity of the 1px white highlight along the top inside edge of the thumb. Gives the glossy, 3D 'glass' feel — as if light is hitting a curved surface from above.",
        value: 18
    });

    thumbGlowColor_0      = new formattingSettings.ColorPicker({ name: "thumbGlowColor_0",      displayName: "Accent Color",             value: { value: "#60A5FA" }, instanceKind: FX, selector: FX_SELECTOR });
    thumbRingAlpha_0      = new formattingSettings.NumUpDown   ({ name: "thumbRingAlpha_0",      displayName: "Ring α (×100)",           value: 18 });
    thumbBloomAlpha_0     = new formattingSettings.NumUpDown   ({ name: "thumbBloomAlpha_0",     displayName: "Bloom α (×100)",          value: 45 });
    thumbGlowSpread_0     = new formattingSettings.NumUpDown   ({ name: "thumbGlowSpread_0",     displayName: "Bloom Spread (px)",        value: 14 });
    thumbHighlightAlpha_0 = new formattingSettings.NumUpDown   ({ name: "thumbHighlightAlpha_0", displayName: "Inner Highlight α (×100)", value: 18 });

    thumbGlowColor_1      = new formattingSettings.ColorPicker({ name: "thumbGlowColor_1",      displayName: "Accent Color",             value: { value: "#60A5FA" }, instanceKind: FX, selector: FX_SELECTOR });
    thumbRingAlpha_1      = new formattingSettings.NumUpDown   ({ name: "thumbRingAlpha_1",      displayName: "Ring α (×100)",           value: 18 });
    thumbBloomAlpha_1     = new formattingSettings.NumUpDown   ({ name: "thumbBloomAlpha_1",     displayName: "Bloom α (×100)",          value: 45 });
    thumbGlowSpread_1     = new formattingSettings.NumUpDown   ({ name: "thumbGlowSpread_1",     displayName: "Bloom Spread (px)",        value: 14 });
    thumbHighlightAlpha_1 = new formattingSettings.NumUpDown   ({ name: "thumbHighlightAlpha_1", displayName: "Inner Highlight α (×100)", value: 18 });

    thumbGlowColor_2      = new formattingSettings.ColorPicker({ name: "thumbGlowColor_2",      displayName: "Accent Color",             value: { value: "#60A5FA" }, instanceKind: FX, selector: FX_SELECTOR });
    thumbRingAlpha_2      = new formattingSettings.NumUpDown   ({ name: "thumbRingAlpha_2",      displayName: "Ring α (×100)",           value: 18 });
    thumbBloomAlpha_2     = new formattingSettings.NumUpDown   ({ name: "thumbBloomAlpha_2",     displayName: "Bloom α (×100)",          value: 45 });
    thumbGlowSpread_2     = new formattingSettings.NumUpDown   ({ name: "thumbGlowSpread_2",     displayName: "Bloom Spread (px)",        value: 14 });
    thumbHighlightAlpha_2 = new formattingSettings.NumUpDown   ({ name: "thumbHighlightAlpha_2", displayName: "Inner Highlight α (×100)", value: 18 });

    thumbGlowColor_3      = new formattingSettings.ColorPicker({ name: "thumbGlowColor_3",      displayName: "Accent Color",             value: { value: "#60A5FA" }, instanceKind: FX, selector: FX_SELECTOR });
    thumbRingAlpha_3      = new formattingSettings.NumUpDown   ({ name: "thumbRingAlpha_3",      displayName: "Ring α (×100)",           value: 18 });
    thumbBloomAlpha_3     = new formattingSettings.NumUpDown   ({ name: "thumbBloomAlpha_3",     displayName: "Bloom α (×100)",          value: 45 });
    thumbGlowSpread_3     = new formattingSettings.NumUpDown   ({ name: "thumbGlowSpread_3",     displayName: "Bloom Spread (px)",        value: 14 });
    thumbHighlightAlpha_3 = new formattingSettings.NumUpDown   ({ name: "thumbHighlightAlpha_3", displayName: "Inner Highlight α (×100)", value: 18 });

    thumbGlowColor_4      = new formattingSettings.ColorPicker({ name: "thumbGlowColor_4",      displayName: "Accent Color",             value: { value: "#60A5FA" }, instanceKind: FX, selector: FX_SELECTOR });
    thumbRingAlpha_4      = new formattingSettings.NumUpDown   ({ name: "thumbRingAlpha_4",      displayName: "Ring α (×100)",           value: 18 });
    thumbBloomAlpha_4     = new formattingSettings.NumUpDown   ({ name: "thumbBloomAlpha_4",     displayName: "Bloom α (×100)",          value: 45 });
    thumbGlowSpread_4     = new formattingSettings.NumUpDown   ({ name: "thumbGlowSpread_4",     displayName: "Bloom Spread (px)",        value: 14 });
    thumbHighlightAlpha_4 = new formattingSettings.NumUpDown   ({ name: "thumbHighlightAlpha_4", displayName: "Inner Highlight α (×100)", value: 18 });

    name: string = "thumb";
    displayName: string = "Thumb";
    slices: formattingSettings.Slice[] = [
        this.view, this.thumbIndexMap,
        this.thumbGlowColor, this.thumbRingAlpha, this.thumbBloomAlpha, this.thumbGlowSpread, this.thumbHighlightAlpha,
        this.thumbGlowColor_0, this.thumbRingAlpha_0, this.thumbBloomAlpha_0, this.thumbGlowSpread_0, this.thumbHighlightAlpha_0,
        this.thumbGlowColor_1, this.thumbRingAlpha_1, this.thumbBloomAlpha_1, this.thumbGlowSpread_1, this.thumbHighlightAlpha_1,
        this.thumbGlowColor_2, this.thumbRingAlpha_2, this.thumbBloomAlpha_2, this.thumbGlowSpread_2, this.thumbHighlightAlpha_2,
        this.thumbGlowColor_3, this.thumbRingAlpha_3, this.thumbBloomAlpha_3, this.thumbGlowSpread_3, this.thumbHighlightAlpha_3,
        this.thumbGlowColor_4, this.thumbRingAlpha_4, this.thumbBloomAlpha_4, this.thumbGlowSpread_4, this.thumbHighlightAlpha_4
    ];
}

// ── Animation ───────────────────────────────────────────────────────
class AnimationCard extends FormattingSettingsCard {
    transitionDuration = new formattingSettings.NumUpDown({
        name: "transitionDuration", displayName: "Transition Duration (ms)",
        description: "How long the thumb takes to slide between sides, in milliseconds. 0 = instant snap; 350 = default smooth glide; 600+ = deliberate slow-mo.",
        value: 350
    });
    transitionEase = new formattingSettings.ItemDropdown({
        name: "transitionEase", displayName: "Transition Easing",
        description: "Acceleration curve. Smooth (default) decelerates naturally. Material is Google's design-system easing. Overshoot bounces slightly past the target before settling. Ease Out softly arrives. Linear has no easing — constant speed.",
        value: { value: "cubic-bezier(.22,.61,.36,1)", displayName: "Smooth (default)" },
        items: [
            { value: "cubic-bezier(.22,.61,.36,1)",   displayName: "Smooth (default)" },
            { value: "cubic-bezier(.4,0,.2,1)",        displayName: "Material" },
            { value: "cubic-bezier(.34,1.56,.64,1)",   displayName: "Overshoot" },
            { value: "ease-out",                        displayName: "Ease Out" },
            { value: "linear",                          displayName: "Linear" }
        ]
    });

    name: string = "animation";
    displayName: string = "Animation";
    slices: formattingSettings.Slice[] = [this.transitionDuration, this.transitionEase];
}

// ── Orientation ─────────────────────────────────────────────────────
class OrientationCard extends FormattingSettingsCard {
    mode = new formattingSettings.ItemDropdown({
        name: "mode", displayName: "Layout Direction",
        description: "How multiple toggles arrange when more than one field is bound. Auto = vertical when any title is positioned left/right, horizontal otherwise. Vertical/Horizontal force the chosen direction.",
        value: { value: "auto", displayName: "Auto" },
        items: [
            { value: "auto",       displayName: "Auto" },
            { value: "vertical",   displayName: "Vertical" },
            { value: "horizontal", displayName: "Horizontal" }
        ]
    });
    verticalAlign = new formattingSettings.ItemDropdown({
        name: "verticalAlign", displayName: "Vertical Alignment",
        description: "Where the vertical toggle stack sits along the vertical axis when there's leftover space. Only used when Sizing > Size Mode = Fixed and the resolved layout direction is Vertical.",
        value: { value: "center", displayName: "Center" },
        items: [
            { value: "top",    displayName: "Top" },
            { value: "center", displayName: "Center" },
            { value: "bottom", displayName: "Bottom" }
        ]
    });
    horizontalAlign = new formattingSettings.ItemDropdown({
        name: "horizontalAlign", displayName: "Horizontal Alignment",
        description: "Where the horizontal toggle row sits along the horizontal axis when there's leftover space. Only used when Sizing > Size Mode = Fixed and the resolved layout direction is Horizontal.",
        value: { value: "center", displayName: "Center" },
        items: [
            { value: "left",   displayName: "Left" },
            { value: "center", displayName: "Center" },
            { value: "right",  displayName: "Right" }
        ]
    });

    name: string = "orientation";
    displayName: string = "Orientation";
    slices: formattingSettings.Slice[] = [this.mode, this.verticalAlign, this.horizontalAlign];
}

// ── Selection Mode ─────────────────────────────────────────────────
// Apply-to dropdown with one boolean (Force Selection) + 5 slot variants.
// Force ON → clicking the active button does nothing (cannot be cleared).
class SelectionModeCard extends FormattingSettingsCard {
    view = new formattingSettings.ItemDropdown({
        name: "view", displayName: "Apply to",
        description: "All toggles: Force Selection applies to every bound field. Pick a specific toggle to override per-field.",
        value: { value: "all", displayName: "All toggles" },
        items: [{ value: "all", displayName: "All toggles" }]
    });
    selectionIndexMap = new formattingSettings.TextInput({
        name: "selectionIndexMap", displayName: "Slot Map (internal)",
        description: "Internal — tracks which slot each field uses so overrides survive field reordering. Hidden in the format pane.",
        value: "", placeholder: ""
    });

    forceSelection = new formattingSettings.ToggleSwitch({
        name: "forceSelection", displayName: "Force Selection",
        description: "When ON, the toggle cannot be cleared. Clicking the active button does nothing instead of deselecting.",
        value: false
    });

    forceSelection_0 = new formattingSettings.ToggleSwitch({ name: "forceSelection_0", displayName: "Force Selection", value: false });
    forceSelection_1 = new formattingSettings.ToggleSwitch({ name: "forceSelection_1", displayName: "Force Selection", value: false });
    forceSelection_2 = new formattingSettings.ToggleSwitch({ name: "forceSelection_2", displayName: "Force Selection", value: false });
    forceSelection_3 = new formattingSettings.ToggleSwitch({ name: "forceSelection_3", displayName: "Force Selection", value: false });
    forceSelection_4 = new formattingSettings.ToggleSwitch({ name: "forceSelection_4", displayName: "Force Selection", value: false });

    name: string = "selection";
    displayName: string = "Selection Mode";
    slices: formattingSettings.Slice[] = [
        this.view, this.selectionIndexMap,
        this.forceSelection,
        this.forceSelection_0, this.forceSelection_1, this.forceSelection_2,
        this.forceSelection_3, this.forceSelection_4
    ];
}

// ── Model ───────────────────────────────────────────────────────────
export class ToggleFormattingModel extends FormattingSettingsModel {
    title       = new TitleCard();
    sizing      = new SizingCard();
    capsule     = new CapsuleCard();
    content     = new ContentCard();
    text        = new TextCard();
    thumb       = new ThumbCard();
    animation   = new AnimationCard();
    orientation = new OrientationCard();
    selection   = new SelectionModeCard();
    cards: formattingSettings.Cards[] = [
        this.title, this.sizing, this.capsule, this.content, this.text, this.thumb,
        this.animation, this.orientation, this.selection
    ];
}

export const clr = (p: formattingSettings.ColorPicker, fallback: string): string =>
    (p?.value as { value?: string })?.value || fallback;

/** Hex (#RRGGBB) → "r, g, b" string for CSS rgba() composition. Falls back if invalid. */
export const hexToRgbTriplet = (hex: string, fallback: string = "96, 165, 250"): string => {
    const m = /^#?([0-9a-f]{6})$/i.exec((hex || "").trim());
    if (!m) return fallback;
    const n = parseInt(m[1], 16);
    return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
};
