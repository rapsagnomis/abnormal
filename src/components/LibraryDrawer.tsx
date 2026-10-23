import type { AnalysisReport, LibraryStatus } from "../lib/api";
import { PairContext, pairColors } from "../lib/pair";
import type { ComparedPair } from "../lib/pair";
import { LibraryView } from "./LibraryView";
import { LoadTargetsContext } from "./LoadMenu";
import type { LoadTargets } from "./LoadMenu";

interface Props {
  pair: ComparedPair;
  /** The compared pair's reports, for "similar to" matches. */
  reports: [AnalysisReport | null, AnalysisReport | null];
  paths: [string | null, string | null];
  status: LibraryStatus | null;
  loadTargets: LoadTargets;
  onRescan: () => void;
  onClose: () => void;
  /** A row is being dragged: the drawer fades and lets the pointer through to the lanes under it. */
  dragging: boolean;
}

/** The library (search, Deezer, similar tracks) in a drawer over the lanes, next to the analysis
 *  panel, so finding a reference never hides the measurements. */
export function LibraryDrawer(p: Props) {
  return (
    <PairContext.Provider value={p.pair}>
      <LoadTargetsContext.Provider value={p.loadTargets}>
        <aside className={`library-drawer${p.dragging ? " dragging" : ""}`} style={pairColors(p.pair.labels)} aria-label="Library">
          <header className="library-drawer-header">
            <h2>Library</h2>
            <button className="library-drawer-close" onClick={p.onClose} title="Close the library (Esc, ⌘K)" aria-label="Close the library">
              ✕
            </button>
          </header>
          <LibraryView reports={p.reports} paths={p.paths} status={p.status} onRescan={p.onRescan} onClose={p.onClose} />
        </aside>
      </LoadTargetsContext.Provider>
    </PairContext.Provider>
  );
}
