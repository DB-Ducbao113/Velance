// P7: explicit demand-driven GLB loading. The inventory still contains all
// sixteen bays, but navigation downloads only the current machine. An overview
// is an intentional request for the full collection, not a page-load side effect.
export function loadOrder(center, total, { all = false } = {}) {
  if (!Number.isInteger(center) || !Number.isInteger(total) || total < 1 || center < 0 || center >= total) {
    throw new RangeError('BAD_MODEL_INDEX');
  }
  if (!all) return [center];
  return Array.from({ length: total }, (_, i) => i).sort((a, b) => Math.abs(a - center) - Math.abs(b - center) || a - b);
}
