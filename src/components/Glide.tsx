import { useLayoutEffect, useRef } from "react";

/**
 * A highlight that slides to the selected button (`button.on`) of the group it's placed in, as
 * its first child: segmented controls and the track switch. It follows class changes and the
 * group's size (buttons growing, shrinking or appearing), and takes the selected button's
 * `--accent` when it has one (the track switch's lane colours).
 */
export function Glide() {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const pill = ref.current!;
    const group = pill.parentElement!;
    group.classList.add("has-glide");
    let shown = false;
    const place = (animate: boolean) => {
      const on = group.querySelector<HTMLElement>("button.on");
      if (!on) {
        pill.style.opacity = "0";
        shown = false;
        return;
      }
      const g = group.getBoundingClientRect();
      const b = on.getBoundingClientRect();
      // Appearing (nothing selected before) or resizing: jump; changing selection: slide.
      pill.style.transition = animate && shown ? "" : "none";
      pill.style.opacity = "1";
      // Layout size, not the on-screen one: a just-clicked button may still be scaled down.
      const width = on.offsetWidth;
      pill.style.transform = `translateX(${b.left + (b.width - width) / 2 - g.left - group.clientLeft}px)`;
      pill.style.width = `${width}px`;
      pill.style.background = getComputedStyle(on).getPropertyValue("--accent").trim();
      shown = true;
    };
    place(false);
    const mo = new MutationObserver(() => place(true));
    mo.observe(group, { subtree: true, childList: true, attributes: true, attributeFilter: ["class"] });
    const ro = new ResizeObserver(() => place(false));
    ro.observe(group);
    // Not the pill itself: resizing it here would notify again, in a loop.
    for (const child of Array.from(group.children)) if (child !== pill) ro.observe(child);
    return () => {
      mo.disconnect();
      ro.disconnect();
      group.classList.remove("has-glide");
    };
  }, []);
  return <span ref={ref} className="glide" aria-hidden="true" />;
}
