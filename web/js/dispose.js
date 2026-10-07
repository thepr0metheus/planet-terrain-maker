// Freeing three.js objects. three.js keeps a geometry, a material or a texture
// on the GPU until its dispose() is called: dropping the last reference is not
// enough, so a model replaced without this stays in memory until the page reloads.
//
// Plain functions, not a class: they hold no state and only walk what they are
// given.

// Every texture a material uses: its own maps, and the ones handed to its shader
// through userData uniforms ({ value: texture }).
export function texturesOf(material) {
  const found = [];
  for (const value of Object.values(material)) if (value?.isTexture) found.push(value);
  for (const uniform of Object.values(material.userData || {})) if (uniform?.value?.isTexture) found.push(uniform.value);
  return found;
}

// Free an object and everything hung on it: geometries, materials and their
// textures, plus the textures in `extra` (kept aside, not on any material now).
// Textures in `keep` are shared with other objects and stay. Each thing is
// freed once, however many materials use it.
export function disposeTree(root, { extra = [], keep = [] } = {}) {
  const textures = new Set(extra.filter(Boolean));
  root.traverse((obj) => {
    if (!obj.isMesh) return;
    obj.geometry?.dispose();
    for (const m of Array.isArray(obj.material) ? obj.material : [obj.material]) {
      if (!m) continue;
      for (const t of texturesOf(m)) textures.add(t);
      m.dispose();
    }
  });
  for (const t of keep) textures.delete(t);
  for (const t of textures) t.dispose();
}
