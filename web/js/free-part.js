// What part of the map the panels leave free, for the circle to stand in the middle of.
//
// Each panel takes away the side of the free part it stands on: of the parts left of it, right of
// it, above and below it, the biggest stays free. The map's panel on the left takes the left; the
// guide's bar at the bottom takes the bottom, though it stands right of the middle.

const GAP = 12;           // px between a panel and the free part
const LEAST = 120;        // px: a part smaller than this is no place for the circle

// area and every panel: { left, top, right, bottom } in the map's own pixels.
export function freePart(area, panels) {
  let free = { ...area };
  for (const p of panels) {
    if (p.right <= free.left || p.left >= free.right || p.bottom <= free.top || p.top >= free.bottom) continue;
    const sides = [
      { ...free, right: Math.min(free.right, p.left - GAP) },
      { ...free, left: Math.max(free.left, p.right + GAP) },
      { ...free, bottom: Math.min(free.bottom, p.top - GAP) },
      { ...free, top: Math.max(free.top, p.bottom + GAP) },
    ].filter((r) => r.right - r.left >= LEAST && r.bottom - r.top >= LEAST);
    if (!sides.length) continue;
    free = sides.reduce((a, b) => ((b.right - b.left) * (b.bottom - b.top) > (a.right - a.left) * (a.bottom - a.top) ? b : a));
  }
  return free;
}
