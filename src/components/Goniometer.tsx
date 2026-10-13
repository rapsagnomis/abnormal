import { useEffect, useRef } from "react";

interface Props {
  label: string;
  color: string;
  /** Row-major density (top = +mid, left = −side), max cell = 1; null when not loaded. */
  density: number[] | null;
  size: number;
}

const PX = 150;

/**
 * Phase scope: sample density in the mid/side plane. A vertical line is mono, a round blob is
 * wide, and spread along the horizontal axis means out-of-phase content. Drawn with left on the
 * left, as on a hardware goniometer.
 */
export function Goniometer({ label, color, density, size }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current!;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = PX * dpr;
    canvas.height = PX * dpr;
    const ctx = canvas.getContext("2d")!;
    const w = canvas.width;
    ctx.clearRect(0, 0, w, w);

    // Guides: M (vertical), S (horizontal), L/R diagonals.
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.lineWidth = dpr;
    ctx.beginPath();
    ctx.moveTo(w / 2, 0);
    ctx.lineTo(w / 2, w);
    ctx.moveTo(0, w / 2);
    ctx.lineTo(w, w / 2);
    ctx.moveTo(0, 0);
    ctx.lineTo(w, w);
    ctx.moveTo(w, 0);
    ctx.lineTo(0, w);
    ctx.stroke();

    if (!density) return;
    // Canvas can't resolve CSS custom properties, so look the colour up first.
    const varName = color.match(/^var\((--[^)]+)\)$/)?.[1];
    const [r, g, b] = parseHex(varName ? getComputedStyle(canvas).getPropertyValue(varName).trim() : color);

    // Paint the density at its native resolution, then scale it up smoothly.
    const img = new ImageData(size, size);
    for (let row = 0; row < size; row++) {
      for (let col = 0; col < size; col++) {
        const v = density[row * size + col];
        if (v <= 0) continue;
        // Mirror horizontally: the data's x is (L−R)/2, a scope shows L-only up and to the left.
        const o = (row * size + (size - 1 - col)) * 4;
        // Square-root scaling keeps sparse outer samples visible next to the dense centre.
        img.data.set([r, g, b, 255 * Math.min(1, 0.15 + 0.85 * Math.sqrt(v))], o);
      }
    }
    const small = new OffscreenCanvas(size, size);
    small.getContext("2d")!.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(small, 0, 0, w, w);
  }, [density, size, color]);

  return (
    <figure className="gonio">
      <div className="gonio-frame">
        <canvas ref={ref} style={{ width: PX, height: PX }} aria-label={`Goniometer ${label}`} />
        <span className="gonio-axis l">L</span>
        <span className="gonio-axis m">M</span>
        <span className="gonio-axis r">R</span>
      </div>
      <figcaption>
        <i style={{ background: color }} />
        {label}
      </figcaption>
    </figure>
  );
}

/** "#rrggbb" → [r, g, b]. */
function parseHex(hex: string): [number, number, number] {
  const n = parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
