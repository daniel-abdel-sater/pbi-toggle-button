"use strict";

import { formattingSettings } from "powerbi-visuals-utils-formattingmodel";
import FormattingSettingsCard = formattingSettings.SimpleCard;
import FormattingSettingsModel = formattingSettings.Model;

// ── Title ────────────────────────────────────────────────────────────
class TitleCard extends FormattingSettingsCard {
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
        description: "Where to place the title relative to the toggle. Left/right put it on the same row; top/bottom stack vertically.",
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
        name: "titleColor", displayName: "Title Color",
        description: "Color of the title text.",
        value: { value: "#334155" }
    });
    titleFontSize = new formattingSettings.NumUpDown({
        name: "titleFontSize", displayName: "Title Font Size",
        description: "Size of the title text in pixels.",
        value: 16
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
    symbolFontSize = new formattingSettings.NumUpDown({
        name: "symbolFontSize", displayName: "Symbol Font Size (px)",
        description: "Symbol text size in pixels. Still multiplied by Sizing > Scale (%) and by the container scale in Fit Container mode.",
        value: 12
    });
    showLabels = new formattingSettings.ToggleSwitch({
        name: "showLabels", displayName: "Show Labels",
        description: "Show or hide the uppercase label text. Labels come from your bound field's distinct values — they're not editable here.",
        value: true
    });
    labelFontSize = new formattingSettings.NumUpDown({
        name: "labelFontSize", displayName: "Label Font Size (px)",
        description: "Label text size in pixels. Still multiplied by Sizing > Scale (%) and by the container scale in Fit Container mode.",
        value: 12
    });

    name: string = "content";
    displayName: string = "Content";
    slices: formattingSettings.Slice[] = [
        this.showSymbols, this.symbolA, this.symbolB,
        this.symbolFontSize,
        this.showLabels, this.labelFontSize
    ];
}

// ── Text (typography colours) ───────────────────────────────────────
class TextCard extends FormattingSettingsCard {
    labelActiveColor = new formattingSettings.ColorPicker({
        name: "labelActiveColor", displayName: "Label Color (Active)",
        description: "Color of the label on the currently selected side.",
        value: { value: "#F1F5F9" }
    });
    labelInactiveColor = new formattingSettings.ColorPicker({
        name: "labelInactiveColor", displayName: "Label Color (Inactive)",
        description: "Color of the label on the non-selected side.",
        value: { value: "#94A3B8" }
    });
    symbolActiveColor = new formattingSettings.ColorPicker({
        name: "symbolActiveColor", displayName: "Symbol Color (Active)",
        description: "Color of the symbol on the currently selected side. Default matches the Accent Color (Thumb card) but is independent — changing the accent later won't override this.",
        value: { value: "#60A5FA" }
    });
    symbolInactiveColor = new formattingSettings.ColorPicker({
        name: "symbolInactiveColor", displayName: "Symbol Color (Inactive)",
        description: "Color of the symbol on the non-selected side. Combined with Inactive Symbol α to produce the dimmed look.",
        value: { value: "#94A3B8" }
    });
    symbolInactiveAlpha = new formattingSettings.NumUpDown({
        name: "symbolInactiveAlpha", displayName: "Inactive Symbol α (×100)",
        description: "Opacity of the symbol on the non-selected side (value / 100). Default 55 = 0.55. Multiplies the Symbol Color (Inactive) above.",
        value: 55
    });

    name: string = "text";
    displayName: string = "Text";
    slices: formattingSettings.Slice[] = [
        this.labelActiveColor, this.labelInactiveColor,
        this.symbolActiveColor, this.symbolInactiveColor, this.symbolInactiveAlpha
    ];
}

// ── Thumb (accent + glow) ───────────────────────────────────────────
class ThumbCard extends FormattingSettingsCard {
    thumbGlowColor = new formattingSettings.ColorPicker({
        name: "thumbGlowColor", displayName: "Accent Color",
        description: "Drives the thumb's tinted gradient, the active symbol color, and the glow ring + bloom hue. The dominant brand color of the visual.",
        value: { value: "#60A5FA" }
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
