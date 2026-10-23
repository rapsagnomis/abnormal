import { convertFileSrc } from "@tauri-apps/api/core";
import type { Curve, Marker, Region, Slot, TrackInfo } from "../lib/api";
import { formatChannels, formatRate, formatTime } from "../lib/format";
import type { Overlay } from "../lib/overlay";
import type { View } from "../lib/view";
import { Waveform } from "./Waveform";
import type { PointerEvent as ReactPointerEvent } from "react";

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
  /** Momentary loudness over the whole track, as it plays (normalizing included). */
  loudness: Curve | null;
  display: Display;
  markers: Marker[];
  /** Time of the marker whose note is being edited, or null. */
  editingMarker: number | null;
  onMarkers: (markers: Marker[]) => void;
  onEditMarker: (time: number | null) => void;
  /** Drop a marker at the playhead and start writing its note. */
  onAddMarker: () => void;
  /** Its part in the compared pair, when worth showing. */
  role: "track" | "reference" | null;
  /** Other tracks are compared; this one is just for listening (dimmed a little). */
  outsidePair: boolean;
  /** Make this the reference everything is compared with. */
  onPinReference: () => void;
  /** Playback EQ is being auditioned on this track. */
  eqOn: boolean;
  /** Playback trim applied by normalizing, loudness matching and EQ compensation, dB (0 when off). */
  trimDb: number;
  /** Played peak-normalized. */
  normalized: boolean;
  /** Name of the streaming platform being previewed: it sets the level, normalizing is set aside. */
  streaming: string | null;
  /** Gain normalizing would add, dB (null until the track is measured). */
  headroomDb: number | null;
  onToggleNormalize: () => void;
  active: boolean;
  dropTarget: boolean;
  /** Lane reordering: this is the lane being dragged, or the dragged one would land before/after it. */
  reorder: "source" | "before" | "after" | null;
  /** Pointer down on the header: may become a drag to reorder the lanes. */
  onReorderStart: (e: ReactPointerEvent) => void;
  /** What the song is called (the name given to it, else the front version's title). */
  songName: string | null;
  /** Changes with each new song in the lane, not when another version comes in front. */
  song: number;
  /** Which version is in front, when the song has several. */
  version: { index: number; count: number } | null;
  /** Its versions drawer is open. */
  versionsOpen: boolean;
  onOpenVersions: () => void;
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
      className={`lane slot-${label.toLowerCase()}${active ? " active" : ""}${dropTarget ? " drop-target" : ""}${props.closing ? " closing" : ""}${props.resizing ? " resizing" : ""}${props.outsidePair ? " outside-pair" : ""}${props.role ? ` in-pair role-${props.role}` : ""}${props.busy ? " busy" : ""}${track && !active ? " selectable" : ""}${props.reorder ? ` reorder-${props.reorder}` : ""}`}
      data-slot={slot}
      // Any click in a loaded lane (badge, header, timeline) switches to it; the click still does its
      // own thing too (seek, select, open a part). Only the lane's own action buttons don't switch.
      // In the header it waits for the click, since a press there may start dragging the lane.
      onPointerDownCapture={(e) => {
        const target = e.target as Element;
        if (track && !active && e.button === 0 && !target.closest(".lane-actions, .lane-header")) props.onActivate();
      }}
    >
      <header
        className="lane-header"
        onPointerDown={props.onReorderStart}
        onClick={(e) => {
          if (track && !active && !(e.target as Element).closest(".lane-actions")) props.onActivate();
        }}
        title="Drag to move this track up or down"
      >
        <button
          className="slot-badge"
          onClick={props.onActivate}
          disabled={!track}
          title={`Listen to ${label} (number-row key ${props.index + 1})`}
        >
          {label}
        </button>
        {track ? (
          // The song: cover and titles in one tile that opens its versions.
          <button
            className={`lane-tile${props.versionsOpen ? " open" : ""}`}
            onClick={props.onOpenVersions}
            aria-expanded={props.versionsOpen}
            title={`${track.path}\nClick for this song's versions: name it, switch the version in front, add or remove versions`}
          >
            {track.cover ? (
              <img className="lane-cover" src={convertFileSrc(track.cover)} alt="" />
            ) : (
              <span className="lane-cover" aria-hidden="true">
                ♪
              </span>
            )}
            <span className="lane-title">
              <span className="track-name">
                {props.songName}
                {track.artist && <span className="track-artist"> – {track.artist}</span>}
                {props.version && (
                  <span className="version-chip" title={`Version ${props.version.index + 1} of ${props.version.count}`}>
                    v{props.version.index + 1}/{props.version.count}
                  </span>
                )}
              </span>
              <span className="track-meta">
                {props.version ? <span className="track-file">{track.name} · </span> : track.album && <span className="track-album">{track.album} · </span>}
                {formatRate(track.sampleRate)} · {formatChannels(track.channels)} · {formatTime(track.duration)}
              </span>
            </span>
          </button>
        ) : (
          <div className="lane-title">
            <span className="track-meta">{slot === 0 ? "Your mix" : slot === 1 ? "Reference" : "Another track to switch to"}</span>
          </div>
        )}
        {props.role === "track" && (
          <span className="role-chip" title="The mix: compared with the reference in the analysis panel (follows the track you listen to)">
            <AnalysedIcon /> Mix
          </span>
        )}
        {props.role === "reference" && (
          <span className="role-chip reference" title="The reference: the mix is compared with it">
            <PinIcon /> Reference
          </span>
        )}
        {track && props.eqOn && (
          <span className="trim-badge" title="Suggested EQ is applied to playback (E)">
            EQ
          </span>
        )}
        {track && Math.abs(trimDb) >= 0.05 && (
          <span
            className="trim-badge"
            title={
              props.streaming
                ? `${props.streaming} playback gain (and EQ level compensation)`
                : "Playback trim: normalizing, loudness matching and EQ level compensation"
            }
          >
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
          {track && (
            <button className="pin-button" onClick={props.onAddMarker} title="Add a marker at the playhead (N)" aria-label={`Add a marker to ${label}`}>
              <MarkerIcon />
            </button>
          )}
          {track && (
            <button
              className={`pin-button normalize-button${props.normalized ? " on" : ""}`}
              onClick={props.onToggleNormalize}
              // Nothing to gain on a track already peaking at the target, unless it's on (to switch off).
              disabled={!!props.streaming || (!props.normalized && (props.headroomDb === null || props.headroomDb < 0.05))}
              aria-pressed={props.normalized}
              aria-label={`Normalize ${label}`}
              title={
                props.streaming
                  ? `Normalize is set aside while previewing ${props.streaming}: the platform sets the level of the file as it is`
                  : props.headroomDb === null
                  ? "Normalize: measuring the track…"
                  : props.headroomDb < 0.05
                    ? "Normalize: already peaks at −1 dBTP, nothing to gain"
                    : `${props.normalized ? "Normalized" : "Normalize"}: raise ${label} by ${props.headroomDb.toFixed(1)} dB to peak at −1 dBTP, so loudness matching doesn't turn the other tracks down to it`
              }
            >
              <NormalizeIcon />
            </button>
          )}
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
            song={props.song}
            duration={track.duration}
            position={position}
            region={region}
            view={props.view ?? { start: 0, end: track.duration }}
            overlay={props.overlay}
            gainDb={props.normalized ? (props.headroomDb ?? 0) : 0}
            loudness={props.loudness}
            display={props.display}
            markers={props.markers}
            editingMarker={props.editingMarker}
            onMarkers={props.onMarkers}
            onEditMarker={props.onEditMarker}
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
            title="Drop an audio file (mp3, flac, wav, aiff, m4a) here, or click to browse"
            aria-label="Drop an audio file here, or click to browse"
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

/** A waveform getting bigger. */
function NormalizeIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M4 11v2M8 9.5v5M12 8v8M16 6v12M20 4v16" />
    </svg>
  );
}

function MarkerIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 21V4M6 4h11l-2.5 4L17 12H6" />
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
