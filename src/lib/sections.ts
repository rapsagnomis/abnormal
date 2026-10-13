/**
 * Section labels as lowercase letters (0 → "a", 1 → "b", …), so they don't read as the A/B
 * slots. Sections with the same letter sound alike.
 */
export const sectionName = (label: number) => (label < 26 ? String.fromCharCode(97 + label) : `s${label + 1}`);
