//! A track's colour from its cover art: the brighter, more saturated of the cover's two dominant
//! hues, lifted to read well on the dark UI. Used for its lane (waveform, accents) in place of the
//! lane letter's colour.

use std::path::Path;

/// Pixels this desaturated or dark are ignored (greys, black, white, shadows).
const MIN_SATURATION: f64 = 0.3;
const MIN_VALUE: f64 = 0.3;
/// Hue families (30° each).
const HUE_BINS: usize = 12;
/// A cover needs this share of vivid pixels to have a colour at all.
const MIN_VIVID_SHARE: f64 = 0.03;
/// The secondary hue is only a candidate with at least this share of the primary's weight.
const SECONDARY_SHARE: f64 = 0.25;

/// `None` when the cover has no real colour (or can't be read).
pub fn cover_accent(path: &Path) -> Option<String> {
    let img = image::open(path).ok()?.thumbnail(64, 64).to_rgb8();
    accent_of(img.pixels().map(|p| p.0))
}

/// The accent, "#rrggbb", from RGB pixels (see the module docs).
pub fn accent_of(pixels: impl Iterator<Item = [u8; 3]>) -> Option<String> {
    // Per hue family: weight (saturation × value per vivid pixel) and the weighted colour sum.
    let mut bins = [(0.0f64, [0.0f64; 3]); HUE_BINS];
    let (mut total, mut vivid) = (0usize, 0usize);
    for [r, g, b] in pixels {
        total += 1;
        let (h, s, v) = hsv(r, g, b);
        if s < MIN_SATURATION || v < MIN_VALUE {
            continue;
        }
        vivid += 1;
        let w = s * v;
        let bin = &mut bins[((h / 360.0 * HUE_BINS as f64) as usize).min(HUE_BINS - 1)];
        bin.0 += w;
        for (sum, c) in bin.1.iter_mut().zip([r, g, b]) {
            *sum += w * c as f64;
        }
    }
    let mut order: Vec<usize> = (0..HUE_BINS).collect();
    order.sort_by(|&a, &b| bins[b].0.total_cmp(&bins[a].0));
    let (primary, secondary) = (order[0], order[1]);
    if total == 0 || (vivid as f64) < MIN_VIVID_SHARE * total as f64 {
        return None;
    }
    let mean = |i: usize| bins[i].1.map(|sum| sum / bins[i].0);
    let vividness = |c: [f64; 3]| {
        let (_, s, v) = hsv(c[0] as u8, c[1] as u8, c[2] as u8);
        s * v
    };
    let has_secondary = bins[secondary].0 >= SECONDARY_SHARE * bins[primary].0;
    let mut pick = mean(primary);
    if has_secondary && vividness(mean(secondary)) > vividness(pick) {
        pick = mean(secondary);
    }
    Some(lift(pick))
}

/// Readable on the dark UI: bright, saturated but not garish.
fn lift(c: [f64; 3]) -> String {
    let (h, s, v) = hsv(c[0] as u8, c[1] as u8, c[2] as u8);
    let [r, g, b] = rgb(h, s.clamp(0.45, 0.85), v.max(0.8));
    format!("#{r:02x}{g:02x}{b:02x}")
}

fn hsv(r: u8, g: u8, b: u8) -> (f64, f64, f64) {
    let (r, g, b) = (r as f64 / 255.0, g as f64 / 255.0, b as f64 / 255.0);
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    let d = max - min;
    let h = if d == 0.0 {
        0.0
    } else if max == r {
        60.0 * ((g - b) / d).rem_euclid(6.0)
    } else if max == g {
        60.0 * ((b - r) / d + 2.0)
    } else {
        60.0 * ((r - g) / d + 4.0)
    };
    (h, if max == 0.0 { 0.0 } else { d / max }, max)
}

fn rgb(h: f64, s: f64, v: f64) -> [u8; 3] {
    let c = v * s;
    let x = c * (1.0 - ((h / 60.0) % 2.0 - 1.0).abs());
    let m = v - c;
    let (r, g, b) = match (h / 60.0) as u32 {
        0 => (c, x, 0.0),
        1 => (x, c, 0.0),
        2 => (0.0, c, x),
        3 => (0.0, x, c),
        4 => (x, 0.0, c),
        _ => (c, 0.0, x),
    };
    [r, g, b].map(|u| ((u + m) * 255.0).round().clamp(0.0, 255.0) as u8)
}
