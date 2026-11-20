// Resources are owned by a model or by the showroom scene. Sets prevent
// duplicate disposal of shared geometry, materials, textures and bitmaps.
export function modelResources(root) {
  const geometries = new Set(), materials = new Set(), textures = new Set();
  root?.traverse(node => {
    if (node.geometry) geometries.add(node.geometry);
    for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
      if (material) materials.add(material);
    }
  });
  for (const material of materials) {
    for (const value of Object.values(material)) if (value?.isTexture) textures.add(value);
    if (material.userData?.baseMap?.isTexture) textures.add(material.userData.baseMap);
  }
  return { geometries, materials, textures };
}

export function disposeResources(root, extraTextures = []) {
  const { geometries, materials, textures } = modelResources(root);
  // InstancedMesh owns instance buffers in addition to shared mesh geometry.
  const instances = new Set();
  root?.traverse(node => { if (node.isInstancedMesh) instances.add(node); });
  for (const texture of extraTextures) if (texture) textures.add(texture);
  const images = new Set();
  for (const texture of textures) {
    if (texture.image) images.add(texture.image);
    texture.dispose();
  }
  for (const material of materials) material.dispose();
  for (const instance of instances) instance.dispose();
  for (const geometry of geometries) geometry.dispose();
  for (const image of images) image.close?.();
}

export function disposeModel(root) {
  if (!root) return;
  root.removeFromParent();
  disposeResources(root);
}

// Abort all DOM listeners together; a callback registered after close cannot
// retain the disposed engine even if the target outlives the scene.
export function inputLifetime() {
  const controller = new AbortController();
  return {
    listen(target, type, handler, options = {}) {
      target.addEventListener(type, handler, { ...options, signal: controller.signal });
    },
    close() { controller.abort(); }
  };
}
