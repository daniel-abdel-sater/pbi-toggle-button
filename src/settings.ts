"use strict";

import { formattingSettings } from "powerbi-visuals-utils-formattingmodel";
import FormattingSettingsCard = formattingSettings.SimpleCard;
import FormattingSettingsModel = formattingSettings.Model;

// ── Title ────────────────────────────────────────────────────────────
class TitleCard extends FormattingSettingsCard {
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

    name: string = "title";
    displayName: string = "Title";
    slices: formattingSettings.Slice[] = [
        this.showTitle, this.titleText, this.titlePosition, this.titleColor, this.titleFontSize
    ];
}

// ── Sizing ───────────────────────────────────────────────────────────
class SizingCard extends FormattingSettingsCard {
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

    name: string = "sizing";
    displayName: string = "Sizing";
    slices: formattingSettings.Slice[] = [this.sizeMode, this.size];
}

// ── Capsule (track shape + surface) ─────────────────────────────────
class CapsuleCard extends FormattingSettingsCard {
    cornerRadius = new formattingSettings.NumUpDown({
        name: "cornerRadius", displayName: "Track Radius (0 = square, 999 = pill)", value: 999
    });
    thumbPadding = new formattingSettings.NumUpDown({
        name: "thumbPadding", displayName: "Track Padding (px)", value: 3
    });
    trackBgTopAlpha = new formattingSettings.NumUpDown({
        name: "trackBgTopAlpha", displayName: "Track Top α (×1000)", value: 40
    });
    trackBgBotAlpha = new formattingSettings.NumUpDown({
        name: "trackBgBotAlpha", displayName: "Track Bottom α (×1000)", value: 15
    });
    trackBorderAlpha = new formattingSettings.NumUpDown({
        name: "trackBorderAlpha", displayName: "Track Border α (×1000)", value: 60
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
    showSymbols = new formattingSettings.ToggleSwitch({
        name: "showSymbols", displayName: "Show Symbols", value: true
    });
    symbolA = new formattingSettings.TextInput({
        name: "symbolA", displayName: "Symbol A", value: "$", placeholder: "e.g. $"
    });
    symbolB = new formattingSettings.TextInput({
        name: "symbolB", displayName: "Symbol B", value: "D", placeholder: "e.g. D"
    });
    showLabels = new formattingSettings.ToggleSwitch({
        name: "showLabels", displayName: "Show Labels", value: true
    });

    name: string = "content";
    displayName: string = "Content";
    slices: formattingSettings.Slice[] = [
        this.showSymbols, this.symbolA, this.symbolB, this.showLabels
    ];
}

// ── Text (typography colours) ───────────────────────────────────────
class TextCard extends FormattingSettingsCard {
    labelActiveColor = new formattingSettings.ColorPicker({
        name: "labelActiveColor", displayName: "Label Color (Active)", value: { value: "#F1F5F9" }
    });
    labelInactiveColor = new formattingSettings.ColorPicker({
        name: "labelInactiveColor", displayName: "Label Color (Inactive)", value: { value: "#94A3B8" }
    });
    symbolInactiveAlpha = new formattingSettings.NumUpDown({
        name: "symbolInactiveAlpha", displayName: "Inactive Symbol α (×100)", value: 55
    });

    name: string = "text";
    displayName: string = "Text";
    slices: formattingSettings.Slice[] = [
        this.labelActiveColor, this.labelInactiveColor, this.symbolInactiveAlpha
    ];
}

// ── Thumb (accent + glow) ───────────────────────────────────────────
class ThumbCard extends FormattingSettingsCard {
    thumbGlowColor = new formattingSettings.ColorPicker({
        name: "thumbGlowColor", displayName: "Accent Color", value: { value: "#60A5FA" }
    });
    thumbRingAlpha = new formattingSettings.NumUpDown({
        name: "thumbRingAlpha", displayName: "Ring α (×100)", value: 18
    });
    thumbBloomAlpha = new formattingSettings.NumUpDown({
        name: "thumbBloomAlpha", displayName: "Bloom α (×100)", value: 45
    });
    thumbGlowSpread = new formattingSettings.NumUpDown({
        name: "thumbGlowSpread", displayName: "Bloom Spread (px)", value: 14
    });
    thumbHighlightAlpha = new formattingSettings.NumUpDown({
        name: "thumbHighlightAlpha", displayName: "Inner Highlight α (×100)", value: 18
    });

    name: string = "thumb";
    displayName: string = "Thumb";
    slices: formattingSettings.Slice[] = [
        this.thumbGlowColor, this.thumbRingAlpha, this.thumbBloomAlpha,
        this.thumbGlowSpread, this.thumbHighlightAlpha
    ];
}

// ── Animation ───────────────────────────────────────────────────────
class AnimationCard extends FormattingSettingsCard {
    transitionDuration = new formattingSettings.NumUpDown({
        name: "transitionDuration", displayName: "Transition Duration (ms)", value: 350
    });
    transitionEase = new formattingSettings.ItemDropdown({
        name: "transitionEase", displayName: "Transition Easing",
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

// ── Model ───────────────────────────────────────────────────────────
export class ToggleFormattingModel extends FormattingSettingsModel {
    title     = new TitleCard();
    sizing    = new SizingCard();
    capsule   = new CapsuleCard();
    content   = new ContentCard();
    text      = new TextCard();
    thumb     = new ThumbCard();
    animation = new AnimationCard();
    cards: formattingSettings.Cards[] = [
        this.title, this.sizing, this.capsule, this.content, this.text, this.thumb, this.animation
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
