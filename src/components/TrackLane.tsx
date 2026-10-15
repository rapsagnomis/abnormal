import { convertFileSrc } from "@tauri-apps/api/core";
import type { Region, Section, Slot, SongStructure, StructureSegment, TrackInfo } from "../lib/api";
import type { Part } from "../lib/structure";
import { formatChannels, formatRate, formatTime } from "../lib/format";
import type { Overlay } from "../lib/overlay";
import type { View } from "../lib/view";
import { Waveform } from "./Waveform";
import { partPalette } from "../lib/color";
import type { CSSProperties } from "react";

/** `--section-0…7` for a lane from its cover's colours; nothing (the standard palette) without. */
function partColors(palette: string[]): CSSProperties | undefined {
  if (palette.length === 0) return undefined;
  return Object.fromEntries(partPalette(palette).map((c, i) => [`--section-${i}`, c])) as CSSProperties;
}
import type { Display } from "./Waveform";

interface Props {
  slot: Slot;
  /** A, B, C or D: where the lane sits, not its engine slot. */
  label: string;
  /** Position in the lane list, for the number-key shortcut. */
  index: number;
  /** Collapsed: about to open, or closing. */
  closing: boolean;
  /** Its row is growing or shrinking. */
  resizing: boolean;
  /** Decoding or measuring: shows a sweep under the header. */
  busy: boolean;
  track: TrackInfo | null;
  loading: boolean;
  error: string | null;
  position: number;
  region: Region | null;
  view: View | null;
  overlay: Overlay | null;
  display: Display;
  sections: Section[] | null;
  structure: SongStructure | null;
  /** The structure model is analysing this track. */
  structurePending: boolean;
  onPart: (part: Part) => void;
  onPartsEdit: (segments: StructureSegment[]) => void;
  onPartsReset: () => void;
  /** Its part in the compared pair, when worth showing. */
  role: "track" | "reference" | null;
  /** Other tracks are compared; this one is just for listening (dimmed a little). */
  outsidePair: boolean;
  /** Make this the reference everything is compared with. */
  onPinReference: () => void;
  /** Playback EQ is being auditioned on this track. */
  eqOn: boolean;
  /** Playback trim applied by loudness matching, dB (0 when off). */
  trimDb: number;
  active: boolean;
  dropTarget: boolean;
  onActivate: () => void;
  onOpen: () => void;
  onClear: () => void;
  onSeek: (seconds: number) => void;
  onRegion: (region: Region | null) => void;
  /** This track loops its selection. */
  looping: boolean;
  onToggleLoop: () => void;
  onView: (view: View) => void;
}

export function TrackLane(props: Props) {
  const { slot, label, track, loading, error, position, region, active, dropTarget, trimDb } = props;

  return (
    <section
      className={`lane slot-${label.toLowerCase()}${active ? " active" : ""}${dropTarget ? " drop-target" : ""}${props.closing ? " closing" : ""}${props.resizing ? " resizing" : ""}${props.outsidePair ? " outside-pair" : ""}${props.role ? ` in-pair role-${props.role}` : ""}${props.busy ? " busy" : ""}${track && !active ? " selectable" : ""}`}
      data-slot={slot}
      // Song-part colours from the cover's dominant colours, when it has any.
      style={partColors(track?.palette ?? [])}
      // Any click in a loaded lane (badge, header, timeline) switches to it; the click still does its
      // own thing too (seek, select, open a part). Only the lane's own action buttons don't switch.
      onPointerDownCapture={(e) => {
        if (track && !active && e.button === 0 && !(e.target as Element).closest(".lane-actions")) props.onActivate();
      }}
    >
      <header className="lane-header">
        <button
          className="slot-badge"
          onClick={props.onActivate}
          disabled={!track}
          title={`Listen to ${label} (number-row key ${props.index + 1})`}
        >
          {label}
        </button>
        {track &&
          (track.cover ? (
            <img className="lane-cover" src={convertFileSrc(track.cover)} alt="" />
          ) : (
            <span className="lane-cover" aria-hidden="true">
              ♪
            </span>
          ))}
        <div className="lane-title">
          {track ? (
            <>
              <span className="track-name" title={track.path}>
                {/* Tags when the file has them, else its name. */}
                {track.title ? (track.artist ? `${track.title} – ${track.artist}` : track.title) : track.name.replace(/\.[^.]+$/, "")}
              </span>
              <span className="track-meta">
                {track.album && <span className="track-album">{track.album} · </span>}
                {formatRate(track.sampleRate)} · {formatChannels(track.channels)} ·{" "}
                {formatTime(track.duration)}
                {props.structure?.bpm != null && ` · ${Math.round(props.structure.bpm)} BPM`}
                {props.structurePending && (
                  <span
                    className="structure-pending"
                    title="Finding tempo, bars and song parts (intro, verse, chorus…) with All-In-One: about half a minute"
                  >
                    {" "}
                    · analysing structure…
                  </span>
                )}
              </span>
            </>
          ) : (
            <span className="track-meta">{slot === 0 ? "Your track" : slot === 1 ? "Reference track" : "Another track to switch to"}</span>
          )}
        </div>
        {props.role === "track" && (
          <span className="role-chip" title="Analysed: compared with the reference in the analysis panel (follows the track you listen to)">
            <AnalysedIcon /> Analysed
          </span>
        )}
        {props.role === "reference" && (
          <span className="role-chip reference" title="The reference: every analysis compares against this track">
            <PinIcon /> Reference
          </span>
        )}
        {track && props.eqOn && (
          <span className="trim-badge" title="Suggested EQ is applied to playback (E)">
            EQ
          </span>
        )}
        {track && Math.abs(trimDb) >= 0.05 && (
          <span className="trim-badge" title="Playback trim: loudness matching and EQ level compensation">
            {trimDb > 0 ? "+" : ""}
            {trimDb.toFixed(1)} dB
          </span>
        )}
        {track && (
          <span className="lane-time">
            {formatTime(position)}
            {region && (
              <span className="region-time">
                {" "}
                · sel {formatTime(region.start)}–{formatTime(region.end)}
              </span>
            )}
          </span>
        )}
        <div className="lane-actions">
          {track && props.role !== "reference" && (
            <button className="pin-button" onClick={props.onPinReference} title={`Use ${label} as the reference`} aria-label={`Use ${label} as the reference`}>
              <PinIcon />
            </button>
          )}
          <button onClick={props.onOpen} disabled={loading}>
            Open…
          </button>
          {track && (
            <button onClick={props.onClear} disabled={loading} title="Remove track">
              ✕
            </button>
          )}
        </div>
      </header>

      <div className="lane-body">
        {track ? (
          <Waveform
            slot={slot}
            peaks={track.peaks}
            duration={track.duration}
            position={position}
            region={region}
            view={props.view ?? { start: 0, end: track.duration }}
            overlay={props.overlay}
            display={props.display}
            sections={props.sections}
            structure={props.structure}
            onPart={props.onPart}
            onPartsEdit={props.onPartsEdit}
            onPartsReset={props.onPartsReset}
            onView={props.onView}
            onSeek={props.onSeek}
            onRegion={props.onRegion}
            looping={props.looping}
            onToggleLoop={props.onToggleLoop}
          />
        ) : (
          <button
            className="drop-zone"
            onClick={props.onOpen}
            disabled={loading}
            title="Drop an mp3, flac or wav file here, or click to browse"
            aria-label="Drop an mp3, flac or wav file here, or click to browse"
          >
            {loading ? (
              "Decoding…"
            ) : (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 3v12m0 0-4.5-4.5M12 15l4.5-4.5" />
                <path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
              </svg>
            )}
          </button>
        )}
        {loading && track && <div className="lane-overlay">Decoding…</div>}
        {error && <div className="lane-error">{error}</div>}
      </div>
    </section>
  );
}

function PinIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 4h6l-1 5 3 3v2H7v-2l3-3-1-5Z" />
      <path d="M12 14v6" />
    </svg>
  );
}

function AnalysedIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M5 19V11M10 19V5M15 19v-6M20 19V9" />
    </svg>
  );
}
