import React from 'react';
import {
    Sparkles, Share2, TrendingUp, Scissors, Film, Youtube, Search, FileText,
    Mic, Video, Camera, Megaphone, Palette, BarChart3, Calendar, Headphones,
    Pencil, Image, Rocket, Star, User,
} from 'lucide-react';

// Curated set of lucide icons offered for services (admin picker + rendering). Admin may
// also type an emoji; anything not in this map is rendered as a text glyph (emoji fallback).
const ICONS: Record<string, React.ComponentType<{ size?: number }>> = {
    Sparkles, Share2, TrendingUp, Scissors, Film, Youtube, Search, FileText,
    Mic, Video, Camera, Megaphone, Palette, BarChart3, Calendar, Headphones,
    Pencil, Image, Rocket, Star, User,
};

/** Icon names offered in the admin service icon picker. */
export const SERVICE_ICON_OPTIONS = Object.keys(ICONS);

/**
 * Render a service icon from an `AddOnConfig.icon` value: a known lucide name → the icon,
 * otherwise the raw string as a glyph (emoji), falling back to Sparkles when empty.
 */
export function renderServiceIcon(icon: string | null | undefined, size = 24): React.ReactNode {
    if (!icon) return <Sparkles size={size} />;
    const Comp = ICONS[icon];
    if (Comp) return <Comp size={size} />;
    return <span style={{ fontSize: size, lineHeight: 1 }} aria-hidden>{icon}</span>;
}
