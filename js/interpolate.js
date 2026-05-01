// Generic piecewise-linear interpolation over sorted [x, y] anchors.
// Clamps at endpoints. Used by engine.js for the base multiplier curve and
// reusable for any future continuous lookup (e.g., size-based discounts).

export function interpolate(anchors, x) {
  if (!Array.isArray(anchors) || anchors.length === 0) return 0;
  if (anchors.length === 1) return anchors[0][1];

  if (x <= anchors[0][0]) return anchors[0][1];
  if (x >= anchors[anchors.length - 1][0]) return anchors[anchors.length - 1][1];

  for (let i = 0; i < anchors.length - 1; i++) {
    const [x0, y0] = anchors[i];
    const [x1, y1] = anchors[i + 1];
    if (x >= x0 && x <= x1) {
      const t = (x - x0) / (x1 - x0);
      return y0 + t * (y1 - y0);
    }
  }
  return anchors[anchors.length - 1][1];
}
