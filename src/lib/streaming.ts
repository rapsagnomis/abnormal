/**
 * Streaming-platform loudness normalisation: the playback gain each platform would apply to a
 * track, from its integrated loudness (ITU BS.1770) and true peak over the whole file.
 *
 * Only Spotify publishes its rules (support.spotify.com, "Loudness normalization"): targets −14
 * (Normal, the default), −11 (Loud) and −19 LUFS (Quiet); quieter tracks are raised only until
 * their true peak reaches −1 dBTP, except in Loud, which raises them regardless and limits at
 * −1 dB sample value (5 ms attack, 100 ms decay). The other platforms don't publish theirs; their
 * targets and whether they raise quiet tracks are what mastering engineers have measured.
 */

export type PlatformId = "spotify" | "spotify-loud" | "spotify-quiet" | "apple" | "youtube" | "tidal" | "amazon" | "deezer";

/** How a track quieter than the target is treated. */
type Boost =
  /** Raised towards the target, but only until its true peak reaches `PEAK_CEILING_DBTP`. */
  | "peak"
  /** Raised to the target whatever its peak, through a limiter. */
  | "limiter"
  /** Left as it is: only louder tracks are turned down. */
  | "none";

export interface Platform {
  id: PlatformId;
  name: string;
  /** LUFS. */
  target: number;
  boost: Boost;
  /** The rules come from the platform itself (otherwise from engineers' measurements). */
  published: boolean;
  note: string;
}

/** Highest true peak a "peak" platform raises a quiet track to, dBTP. */
const PEAK_CEILING_DBTP = -1;

export const PLATFORMS: Platform[] = [
  {
    id: "spotify",
    name: "Spotify",
    target: -14,
    boost: "peak",
    published: true,
    note: "Default setting. Quieter tracks are raised until their true peak reaches −1 dBTP.",
  },
  {
    id: "spotify-loud",
    name: "Spotify Loud",
    target: -11,
    boost: "limiter",
    published: true,
    note: "Premium setting. Every track is set to −11 LUFS; a limiter at −1 dB (5 ms attack, 100 ms decay) catches the peaks.",
  },
  {
    id: "spotify-quiet",
    name: "Spotify Quiet",
    target: -19,
    boost: "peak",
    published: true,
    note: "Premium setting. Quieter tracks are raised until their true peak reaches −1 dBTP.",
  },
  {
    id: "apple",
    name: "Apple Music",
    target: -16,
    boost: "peak",
    published: false,
    note: "Sound Check (on by default). Apple publishes no figures: −16 LUFS is measured; quieter tracks are raised only as far as their peaks allow (modelled as up to −1 dBTP).",
  },
  {
    id: "youtube",
    name: "YouTube",
    target: -14,
    boost: "none",
    published: false,
    note: "Not documented by YouTube: measured at −14 LUFS (Stats for nerds, “content loudness”). Louder tracks are turned down, quieter ones are left alone.",
  },
  {
    id: "tidal",
    name: "Tidal",
    target: -14,
    boost: "none",
    published: false,
    note: "−14 LUFS, normalising whole albums (a single gets its own gain). Louder tracks are turned down, quieter ones are left alone.",
  },
  {
    id: "amazon",
    name: "Amazon Music",
    target: -14,
    boost: "none",
    published: false,
    note: "Measured at −14 LUFS. Louder tracks are turned down, quieter ones are left alone.",
  },
  {
    id: "deezer",
    name: "Deezer",
    target: -15,
    boost: "peak",
    published: false,
    note: "Always on, per track. Measured at −15 LUFS; quieter tracks are raised as far as their peaks allow (modelled as up to −1 dBTP).",
  },
];

export const platformById = (id: PlatformId | null) => PLATFORMS.find((p) => p.id === id) ?? null;

/** Playback gain the platform applies to a track, dB; null without a loudness reading. */
export function platformGain(p: Platform, integrated: number | null, truePeak: number | null): number | null {
  if (integrated === null) return null;
  const gain = p.target - integrated;
  if (gain <= 0 || p.boost === "limiter") return gain;
  if (p.boost === "none") return 0;
  // Raised only as far as the true peak allows; never turned down because of its peak.
  return truePeak === null ? 0 : Math.max(0, Math.min(gain, PEAK_CEILING_DBTP - truePeak));
}
