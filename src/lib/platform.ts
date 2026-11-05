/** Where the app runs, for the few things that differ: shortcut keys and file paths. */
export const isMac = /Mac/i.test(navigator.userAgent);
export const isWindows = /Windows/i.test(navigator.userAgent);

/** The shortcut modifier's name: ⌘ on a Mac, Ctrl elsewhere. */
export const MOD = isMac ? "⌘" : "Ctrl";

/** The shortcut modifier is held (⌘ on a Mac, Ctrl elsewhere), and not the other one. */
export const modKey = (e: { metaKey: boolean; ctrlKey: boolean }) => (isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey);

/** A shortcut with the modifier, as its label: "⌘K" / "⇧⌘S" on a Mac, "Ctrl+K" / "Ctrl+Shift+S" elsewhere. */
export const withMod = (key: string, shift = false) => (isMac ? `${shift ? "⇧" : ""}⌘${key}` : `Ctrl+${shift ? "Shift+" : ""}${key}`);
