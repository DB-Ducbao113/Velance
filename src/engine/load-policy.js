// Direct-gallery navigation downloads only the current machine. The landing
// has a separate sixteen-bay preload order for its cinematic reveal.
export function loadOrder(center, total, { all = false } = {}) {
  if (!Number.isInteger(center) || !Number.isInteger(total) || total < 1 || center < 0 || center >= total) {
    throw new RangeError('BAD_MODEL_INDEX');
  }
  if (!all) return [center];
  return Array.from({ length: total }, (_, i) => i).sort((a, b) => Math.abs(a - center) - Math.abs(b - center) || a - b);
}

// GPURequestAdapterOptions accepts only low-power/high-performance. The WebGL
// enum also has "default", but forwarding that to WebGPU rejects the request.
export function gpuPowerPreference(memoryConstrained) {
  return memoryConstrained ? 'low-power' : 'high-performance';
}
