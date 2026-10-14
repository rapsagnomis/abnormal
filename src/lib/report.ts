import type { AnalysisReport, MatchReport, Region, TrackInfo } from "./api";
import { describe, formatGain, formatHz, isSide, isWidth, movesOf, typeLabel } from "./eq";
import { formatChannels, formatRate, formatTime } from "./format";
import { fmt, SECTIONS, showValue } from "./metrics";

export interface ReportInput {
  tracks: [TrackInfo | null, TrackInfo | null];
  reports: [AnalysisReport | null, AnalysisReport | null];
  scope: "full" | "selection";
  regions: [Region | null, Region | null];
  eq: MatchReport | null;
  /** Whether the EQ match measured only the loudest parts. */
  loudest: boolean;
}

const TAB_TITLES = { loudness: "Loudness", dynamics: "Dynamics", tonal: "Tonal balance", stereo: "Stereo" } as const;
const SLOT = ["A", "B"] as const;

const rangeLabel = (input: ReportInput, i: number) => {
  const r = input.regions[i];
  return input.scope === "selection" && r ? `${formatTime(r.start)}–${formatTime(r.end)}` : "full track";
};

/** Every metric row as plain data: the shared source for both export formats. */
function metricRows(input: ReportInput) {
  return Object.entries(SECTIONS).map(([tab, sections]) => ({
    tab: TAB_TITLES[tab as keyof typeof TAB_TITLES],
    sections: sections.map((s) => ({
      heading: s.heading ?? null,
      rows: s.rows.map((row) => {
        const [a, b] = input.reports.map((r) => (r ? row.get(r) : null));
        return { row, a, b, delta: a !== null && b !== null ? a - b : null };
      }),
    })),
  }));
}

export function reportMarkdown(input: ReportInput): string {
  const lines: string[] = [];
  lines.push("# (a/b)normal report", "", `Generated ${new Date().toLocaleString()}`, "");
  lines.push("| | Track | Format | Measured |", "|---|---|---|---|");
  input.tracks.forEach((t, i) => {
    if (t) {
      lines.push(
        `| ${SLOT[i]} | ${t.name} | ${formatRate(t.sampleRate)} ${formatChannels(t.channels)}, ${formatTime(t.duration)} | ${rangeLabel(input, i)} |`,
      );
    }
  });
  lines.push("", "Δ is A − B. Tonal levels are relative to each track's integrated loudness.", "");

  for (const tab of metricRows(input)) {
    lines.push(`## ${tab.tab}`, "");
    for (const section of tab.sections) {
      if (section.heading) lines.push(`**${section.heading}**`, "");
      lines.push("| Metric | Unit | A | B | Δ |", "|---|---|---:|---:|---:|");
      for (const { row, a, b, delta } of section.rows) {
        lines.push(`| ${row.label} | ${row.unit} | ${showValue(row, a)} | ${showValue(row, b)} | ${fmt(delta, row.digits, true)} |`);
      }
      lines.push("");
    }
  }

  lines.push("## EQ match", "");
  if (!input.eq) {
    lines.push("Needs a track in both A and B.", "");
  } else if (movesOf(input.eq).length === 0) {
    lines.push("No move larger than 0.75 dB needed: the tonal balances already match.", "");
  } else {
    const { eq } = input;
    lines.push(
      `Moves on A to approach the tonal balance of B at equal loudness${input.loudest ? ", measured over the loudest parts only" : ""}`,
      `(level offset ${formatGain(eq.offset)} left to loudness matching; fit ${eq.errorBefore.toFixed(1)} → ${eq.errorAfter.toFixed(1)} dB RMS` +
        (eq.side ? `, side ${eq.side.errorBefore.toFixed(1)} → ${eq.side.errorAfter.toFixed(1)} dB RMS` : "") +
        `; ${eq.full.gap.toFixed(1)} dB RMS from the full match).`,
      "",
      "| # | Where | Type | Freq | Gain | Q | Meaning |",
      "|---|---|---|---:|---:|---:|---|",
    );
    movesOf(eq).forEach((f, i) => {
      const [freq, q] = isWidth(f) ? ["all", "–"] : [formatHz(f.freq), f.q.toFixed(1)];
      lines.push(`| ${i + 1} | ${isSide(f) ? "Side" : "Stereo"} | ${typeLabel(f)} | ${freq} | ${formatGain(f.gain)} | ${q} | ${describe(f)} |`);
    });
    lines.push("");
  }
  return lines.join("\n");
}

/** Summary values only (no curves or spectra), for spreadsheets or scripts. */
export function reportJson(input: ReportInput): string {
  const tracks = input.tracks.map((t, i) =>
    t && {
      slot: SLOT[i],
      name: t.name,
      path: t.path,
      sampleRate: t.sampleRate,
      channels: t.channels,
      duration: t.duration,
      measured: input.scope === "selection" && input.regions[i] ? input.regions[i] : "full",
    },
  );
  const metrics = metricRows(input).map((tab) => ({
    tab: tab.tab,
    sections: tab.sections.map((s) => ({
      heading: s.heading,
      rows: s.rows.map(({ row, a, b, delta }) => ({ metric: row.label, unit: row.unit, a, b, delta })),
    })),
  }));
  return JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      deltaIs: "A - B",
      tracks,
      metrics,
      eq: input.eq && {
        appliesTo: "A",
        towards: "B",
        offsetDb: input.eq.offset,
        errorBeforeDb: input.eq.errorBefore,
        errorAfterDb: input.eq.errorAfter,
        loudestPartsOnly: input.loudest,
        suggestions: input.eq.suggestions,
        side: input.eq.side && {
          width: input.eq.side.width,
          suggestions: input.eq.side.suggestions,
          errorBeforeDb: input.eq.side.errorBefore,
          errorAfterDb: input.eq.side.errorAfter,
        },
        fullMatchGapDb: input.eq.full.gap,
      },
    },
    null,
    2,
  );
}
