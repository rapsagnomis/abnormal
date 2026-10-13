import { convertFileSrc } from "@tauri-apps/api/core";
import type { Region, Section, Slot, SongStructure, StructureSegment, TrackInfo } from "../lib/api";
import type { Part } from "../lib/structure";
import { SLOT_LABELS } from "../lib/api";
import { formatChannels, formatRate, formatTime } from "../lib/format";
import type { Overlay } from "../lib/overlay";
import type { View } from "../lib/view";
import { Waveform } from "./Waveform";
import type { Display } from "./Waveform";

interface Props {
  slot: Slot;
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
  onView: (view: View) => void;
}

export function TrackLane(props: Props) {
  const { slot, track, loading, error, position, region, active, dropTarget, trimDb } = props;
  const label = SLOT_LABELS[slot];

  return (
    <section
      className={`lane slot-${label.toLowerCase()}${active ? " active" : ""}${dropTarget ? " drop-target" : ""}`}
      data-slot={slot}
    >
      <header className="lane-header">
        <button
          className="slot-badge"
          onClick={props.onActivate}
          disabled={!track}
          title={`Listen to ${label} (${slot + 1})`}
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
            <span className="track-meta">{slot === 0 ? "Your track" : "Reference track"}</span>
          )}
        </div>
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
