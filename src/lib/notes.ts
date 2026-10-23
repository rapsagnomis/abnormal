import type { Marker, TrackInfo } from "./api";
import { formatDuration } from "./format";

/** A song's notes for the recap: its name, which version is in front (when it has several), and
 *  that version's markers. */
export interface SongNotes {
  name: string;
  version: { index: number; count: number } | null;
  track: TrackInfo;
  markers: Marker[];
}

/** A recap of every track's markers, song by song in lane order, as Markdown. */
export function notesMarkdown(title: string, tracks: SongNotes[]): string {
  const total = tracks.reduce((sum, t) => sum + t.track.duration, 0);
  const noted = tracks.reduce((sum, t) => sum + t.markers.length, 0);
  const date = new Date().toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
  const lines = [
    `# ${title}`,
    "",
    `_${date} · ${tracks.length} track${tracks.length === 1 ? "" : "s"} · ${formatDuration(total)} · ${noted} note${noted === 1 ? "" : "s"}_`,
  ];
  tracks.forEach(({ name, version, track, markers }, i) => {
    const which = version ? `Version ${version.index + 1} of ${version.count} · ` : "";
    lines.push("", `## ${i + 1}. ${name}${track.artist ? ` — ${track.artist}` : ""}`, "", `${which}\`${track.name}\` · ${formatDuration(track.duration)}`, "");
    if (!markers.length) lines.push("_No notes._");
    for (const m of markers) {
      // Multi-line notes stay inside their list item.
      const text = m.note.trim() ? m.note.trim().replace(/\n/g, "\n  ") : "_(no text)_";
      lines.push(`- **${formatDuration(m.time)}** ${text}`);
    }
  });
  return `${lines.join("\n")}\n`;
}
