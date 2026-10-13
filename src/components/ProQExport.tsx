import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { EqFilter } from "../lib/api";
import { eqAsText } from "../lib/eq";
import { proQPreset } from "../lib/proq";

/** The user's Pro-Q 4 "Default Setting" (null if none), read once. */
let template: Promise<string | null> | null = null;
const proQTemplate = () => (template ??= api.proQTemplate().catch(() => null));

const FEEDBACK_MS = 4000;

/** Copy the chosen EQ moves as a Pro-Q 4 preset, or save it into Pro-Q's preset browser. */
export function ProQExport({ filters, names }: { filters: EqFilter[]; names: [string | null, string | null] }) {
  const [status, setStatus] = useState<{ text: string; error?: boolean } | null>(null);
  useEffect(() => {
    if (!status) return;
    const timer = setTimeout(() => setStatus(null), FEEDBACK_MS);
    return () => clearTimeout(timer);
  }, [status]);

  const [a, b] = names.map((n) => (n ?? "").replace(/\.[^.]+$/, ""));
  const name = `EQ match - ${a} to ${b}`;
  const preset = async () => {
    const description =
      `From (a/b)normal: moves for "${a}" to approach the tonal balance of "${b}", compared at equal loudness. ` +
      `The level difference is left to loudness matching.\n\n${eqAsText(filters)}`;
    return proQPreset(filters, name, description, await proQTemplate());
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(await preset());
      setStatus({ text: "Copied: in Pro-Q 4, paste it from the instance menu" });
    } catch (e) {
      setStatus({ text: `Could not copy: ${e}`, error: true });
    }
  };
  const save = async () => {
    try {
      await api.saveProQPreset(name, await preset());
      setStatus({ text: "Saved: Pro-Q 4 presets ▸ abnormal" });
    } catch (e) {
      setStatus({ text: String(e), error: true });
    }
  };

  const disabled = filters.length === 0;
  return (
    <div className="proq-export">
      <button onClick={copy} disabled={disabled} title="Copy the switched-on moves as a FabFilter Pro-Q 4 preset: paste it into Pro-Q 4 from its instance menu">
        Copy for Pro-Q 4
      </button>
      <button onClick={save} disabled={disabled} title="Save the switched-on moves as a preset in Pro-Q 4's preset browser, in the abnormal folder">
        Save to Pro-Q 4
      </button>
      {status && <span className={`chart-note${status.error ? " library-error" : ""}`}>{status.text}</span>}
    </div>
  );
}
