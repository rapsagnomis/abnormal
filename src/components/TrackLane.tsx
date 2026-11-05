import { convertFileSrc } from "@tauri-apps/api/core";
import type { Curve, Marker, Region, Slot, TrackInfo } from "../lib/api";
import { formatChannels, formatRate, formatTime } from "../lib/format";
import type { Overlay } from "../lib/overlay";
import type { View } from "../lib/view";
import { SourceMenu } from "./SourceMenu";
import { Waveform } from "./Waveform";
import { useEffect, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from "react";

import type { Display } from "./Waveform";

interface Props {
  slot: Slot;
  /** The lane's number: where it sits, not its engine slot. */
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
  /** Compare with this reference (references only: their song, or the current song for the default). */
  onPinReference?: () => void;
  /** Playback EQ is being auditioned on this track. */
  eqOn: boolean;
  /** Playback trim applied by normalizing, loudness matching and EQ compensation, dB (0 when off). */
  trimDb: number;
  /** Played peak-normalized. */
  normalized: boolean;
  /** Gain normalizing would add, dB (null until the track is measured). */
  headroomDb: number | null;
  /** The lane's versions play loudness-matched, which sets normalizing aside. */
  versionsMatched: boolean;
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
  /** Open the Library to load into this lane (or add to its song's references, or as the default). */
  onOpenLibrary: () => void;
  onClear: () => void;
  onSeek: (seconds: number) => void;
  onRegion: (region: Region | null) => void;
  /** This track loops its selection. */
  looping: boolean;
  onToggleLoop: () => void;
  onView: (view: View) => void;
  /** A song's own reference, shown under its song's lane (nested in it), or the session's default
   *  reference (the strip above the lanes), rather than a lane. */
  variant?: "reference" | "default";
  /** Its song's lane number (reference variant). */
  songLabel?: string;
  /** The song's reference lane, nested at the bottom of this one. */
  children?: ReactNode;
}

export function TrackLane(props: Props) {
  const { slot, label, track, loading, error, position, region, active, dropTarget, trimDb } = props;
  const isRef = props.variant === "reference";
  const isDefault = props.variant === "default";

  // Becoming the track heard: a pulse of light runs out from the playhead along the bars.
  const [flash, setFlash] = useState(0);
  const wasActive = useRef(active);
  useEffect(() => {
    if (active && !wasActive.current && track) setFlash((n) => n + 1);
    wasActive.current = active;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
  const shown = props.view ?? { start: 0, end: track?.duration ?? 1 };
  const playheadAt = Math.min(1, Math.max(0, (position - shown.start) / (shown.end - shown.start || 1)));

  // Another version in front: its number rolls in (up for a later version, down for an earlier
  // one) and the lane briefly glows in its colour.
  const versionIndex = props.version?.index ?? null;
  const lastVersion = useRef(versionIndex);
  const [turn, setTurn] = useState<{ n: number; dir: "up" | "down" } | null>(null);
  useEffect(() => {
    const prev = lastVersion.current;
    lastVersion.current = versionIndex;
    if (prev !== null && versionIndex !== null && prev !== versionIndex) setTurn((t) => ({ n: (t?.n ?? 0) + 1, dir: versionIndex > prev ? "up" : "down" }));
  }, [versionIndex]);

  return (
    <section
      className={`lane slot-${label.toLowerCase()}${isRef ? " ref-lane" : ""}${isDefault ? " ref-lane default-lane" : ""}${props.children ? " has-ref" : ""}${active ? " active" : ""}${dropTarget ? " drop-target" : ""}${props.closing ? " closing" : ""}${props.resizing ? " resizing" : ""}${props.outsidePair ? " outside-pair" : ""}${props.role ? ` in-pair role-${props.role}` : ""}${props.busy ? " busy" : ""}${track && !active ? " selectable" : ""}${props.reorder ? ` reorder-${props.reorder}` : ""}`}
      data-slot={slot}
      // A song's reference has no number class of its own: its colour is set here.
      style={isRef || isDefault ? ({ "--accent": `var(--lane-${label.toLowerCase()})` } as CSSProperties) : undefined}
      // Any click in a loaded lane (badge, header, timeline) switches to it; the click still does its
      // own thing too (seek, select, open a part). Only the lane's own action buttons don't switch.
      // In the header it waits for the click, since a press there may start dragging the lane.
      onPointerDownCapture={(e) => {
        const target = e.target as Element;
        // The song's reference nested in this lane switches to itself.
        if (target.closest(".lane") !== e.currentTarget) return;
        if (track && !active && e.button === 0 && !target.closest(".lane-actions, .lane-header")) props.onActivate();
      }}
    >
      {turn && <span key={turn.n} className="version-tint" aria-hidden="true" />}
      <header
        className="lane-header"
        onPointerDown={isRef || isDefault ? undefined : props.onReorderStart}
        onClick={(e) => {
          if (track && !active && !(e.target as Element).closest(".lane-actions")) props.onActivate();
        }}
        title={isDefault ? "The default reference" : isRef ? `The reference of track ${props.songLabel}` : "Drag to move this track up or down"}
      >
        <button
          className="slot-badge"
          onClick={props.onActivate}
          disabled={!track}
          title={
            isDefault
              ? "Listen to the default reference (Tab from a song compared with it)"
              : isRef
                ? `Listen to track ${props.songLabel}'s reference (Tab from the song)`
                : `Listen to track ${label} (number-row key ${props.index + 1})`
          }
        >
          {label}
        </button>
        {track ? (
          // The song: cover and titles in one tile that opens its versions.
          <button
            className={`lane-tile${props.versionsOpen ? " open" : ""}`}
            onClick={props.onOpenVersions}
            aria-expanded={props.versionsOpen}
            title={
              isDefault
                ? `${track.path}\nThe session's default reference: every song without its own is compared with it. Click to replace it`
                : isRef
                ? `${track.path}\nClick for track ${props.songLabel}'s references: switch the one in use, add or remove references`
                : `${track.path}\nClick for this song's versions: name it, switch the version in front, add or remove versions`
            }
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
                  <span className="version-chip" title={`${isRef ? "Reference" : "Version"} ${props.version.index + 1} of ${props.version.count}`}>
                    {isRef ? "" : "v"}
                    <span className="version-roll">
                      <span key={props.version.index} className={turn ? `version-num roll-${turn.dir}` : "version-num"}>
                        {props.version.index + 1}
                      </span>
                    </span>
                    /{props.version.count}
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
            <span className="track-meta">{isDefault ? "Default reference" : isRef ? `Reference of ${props.songLabel}` : slot === 0 ? "Your track" : "Another track to switch to"}</span>
          </div>
        )}
        {props.role === "reference" && (
          <span
            className="role-chip reference"
            title={
              isDefault
                ? "The default reference: the current song is compared with it"
                : isRef
                  ? `Track ${props.songLabel}'s own reference: it's compared with it`
                  : "The current song is compared with this track"
            }
          >
            <PinIcon /> {isDefault ? "Default reference" : isRef ? `Reference of ${props.songLabel}` : "Reference"}
          </span>
        )}
        {(isRef || isDefault) && props.role !== "reference" && (
          <span
            className="role-chip ref-of"
            title={isDefault ? "Compared with every song without a reference of its own" : `Track ${props.songLabel}'s own reference (it's compared with something else meanwhile)`}
          >
            {isDefault ? "Default reference" : `Reference of ${props.songLabel}`}
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
            title="Playback trim: normalizing, loudness matching and EQ level compensation"
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
            <button className="pin-button" onClick={props.onAddMarker} title="Add a note at the playhead (N)" aria-label={`Add a note to track ${label}`}>
              <MarkerIcon />
            </button>
          )}
          {track && (
            <button
              className={`pin-button normalize-button${props.normalized ? " on" : ""}`}
              onClick={props.onToggleNormalize}
              // Nothing to gain on a track already peaking at the target, unless it's on (to switch off).
              disabled={props.versionsMatched || (!props.normalized && (props.headroomDb === null || props.headroomDb < 0.05))}
              aria-pressed={props.normalized}
              aria-label={`Normalize ${label}`}
              title={
                props.versionsMatched
                  ? "Normalize is set aside while this song's versions are loudness-matched (in its versions)"
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
          {track && props.onPinReference && props.role !== "reference" && (
            <button
              className="pin-button reference-pin"
              onClick={props.onPinReference}
              title={isDefault ? "Compare the current song with the default reference" : `Compare track ${props.songLabel} with this reference`}
              aria-label={isDefault ? "Compare the current song with the default reference" : `Compare track ${props.songLabel} with this reference`}
            >
              <PinIcon />
            </button>
          )}
          <SourceMenu
            label={isDefault ? "Replace" : isRef ? "Add" : "Open"}
            disabled={loading}
            title={
              isDefault
                ? "Replace the default reference: from a file or the Library"
                : isRef
                  ? `Add references to track ${props.songLabel}: from files or the Library`
                  : `Open a track in ${label}: from a file or the Library`
            }
            onFile={props.onOpen}
            onLibrary={props.onOpenLibrary}
          />
          {track && (
            <button
              onClick={props.onClear}
              disabled={loading}
              title={isDefault ? "Remove the default reference" : isRef ? `Remove this reference from track ${props.songLabel} (the file stays)` : "Remove track"}
            >
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
        {flash > 0 && track && (
          <span
            key={flash}
            className="switch-flash"
            style={{ "--at": `${playheadAt * 100}%` } as CSSProperties}
            onAnimationEnd={() => setFlash(0)}
            aria-hidden="true"
          />
        )}
        {loading && track && <div className="lane-overlay">Decoding…</div>}
        {error && <div className="lane-error">{error}</div>}
      </div>
      {props.children}
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

/** A text "T", for writing a note. */
function MarkerIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 7V5h14v2M12 5v14M9 19h6" />
    </svg>
  );
}
