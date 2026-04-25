"use strict";

import { formattingSettings } from "powerbi-visuals-utils-formattingmodel";
import FormattingSettingsCard = formattingSettings.SimpleCard;
import FormattingSettingsModel = formattingSettings.Model;

class GeneralCard extends FormattingSettingsCard {
    showTitle = new formattingSettings.ToggleSwitch({
        name: "showTitle", displayName: "Show Title", value: true
    });
    titleText = new formattingSettings.TextInput({
        name: "titleText", displayName: "Title Text",
        value: "label", placeholder: "Enter title"
    });
    titlePosition = new formattingSettings.ItemDropdown({
        name: "titlePosition", displayName: "Title Position",
        value: { value: "left", displayName: "Left" },
        items: [
            { value: "top-left",      displayName: "Top Left" },
            { value: "top-center",    displayName: "Top Center" },
            { value: "top-right",     displayName: "Top Right" },
            { value: "left",          displayName: "Left" },
            { value: "right",         displayName: "Right" },
            { value: "bottom-left",   displayName: "Bottom Left" },
            { value: "bottom-center", displayName: "Bottom Center" },
            { value: "bottom-right",  displayName: "Bottom Right" }
        ]
    });
    titleColor = new formattingSettings.ColorPicker({
        name: "titleColor", displayName: "Title Color", value: { value: "#334155" }
    });
    titleFontSize = new formattingSettings.NumUpDown({
        name: "titleFontSize", displayName: "Title Font Size", value: 16
    });
    sizeMode = new formattingSettings.ItemDropdown({
        name: "sizeMode", displayName: "Size Mode",
        value: { value: "fixed", displayName: "Fixed" },
        items: [
            { value: "auto",  displayName: "Fit Container" },
            { value: "fixed", displayName: "Fixed" }
        ]
    });
    size = new formattingSettings.NumUpDown({
        name: "size", displayName: "Fixed Size (px)", value: 31
    });
    cornerRadius = new formattingSettings.NumUpDown({
        name: "cornerRadius", displayName: "Corner Radius (0 = square, 999 = pill)", value: 300
    });
    thumbPadding = new formattingSettings.NumUpDown({
        name: "thumbPadding", displayName: "Thumb Padding (px)", value: 5
    });
    thumbColorA = new formattingSettings.ColorPicker({
        name: "thumbColorA", displayName: "Thumb Color (A)", value: { value: "#22c55e" }
    });
    thumbColorB = new formattingSettings.ColorPicker({
        name: "thumbColorB", displayName: "Thumb Color (B)", value: { value: "#94a3b8" }
    });
    labelColorAOn = new formattingSettings.ColorPicker({
        name: "labelColorAOn", displayName: "Value A Label Color (On)", value: { value: "#ffffff" }
    });
    labelColorAOff = new formattingSettings.ColorPicker({
        name: "labelColorAOff", displayName: "Value A Label Color (Off)", value: { value: "#e2e8f0" }
    });
    labelColorBOn = new formattingSettings.ColorPicker({
        name: "labelColorBOn", displayName: "Value B Label Color (On)", value: { value: "#ffffff" }
    });
    labelColorBOff = new formattingSettings.ColorPicker({
        name: "labelColorBOff", displayName: "Value B Label Color (Off)", value: { value: "#e2e8f0" }
    });
    showLabels = new formattingSettings.ToggleSwitch({
        name: "showLabels", displayName: "Show Labels", value: false
    });
    labelAlign = new formattingSettings.ItemDropdown({
        name: "labelAlign", displayName: "Label Alignment",
        value: { value: "center", displayName: "Center" },
        items: [
            { value: "left",   displayName: "Left" },
            { value: "center", displayName: "Center" },
            { value: "right",  displayName: "Right" }
        ]
    });
    showBorder = new formattingSettings.ToggleSwitch({
        name: "showBorder", displayName: "Show Border", value: true
    });
    borderColor = new formattingSettings.ColorPicker({
        name: "borderColor", displayName: "Border Color", value: { value: "#000000" }
    });

    name: string = "general";
    displayName: string = "Toggle";
    slices: formattingSettings.Slice[] = [
        this.showTitle, this.titleText, this.titlePosition, this.titleColor, this.titleFontSize,
        this.sizeMode, this.size,
        this.cornerRadius, this.thumbPadding,
        this.thumbColorA, this.thumbColorB,
        this.showLabels, this.labelAlign,
        this.labelColorAOn, this.labelColorAOff,
        this.labelColorBOn, this.labelColorBOff,
        this.showBorder, this.borderColor
    ];
}

export class ToggleFormattingModel extends FormattingSettingsModel {
    general = new GeneralCard();
    cards: formattingSettings.Cards[] = [this.general];
}

export const clr = (p: formattingSettings.ColorPicker, fallback: string): string =>
    (p?.value as { value?: string })?.value || fallback;
