import { Matrix3, Matrix4, Vector3 } from 'three';

export function bakeStatic(document) {
  const root = document.getRoot();
  const scene = root.listScenes()[0];
  if (root.listScenes().length !== 1) throw new Error('Static showroom assets must contain exactly one scene');
  const baked = [];
  for (const node of root.listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const world = new Matrix4().fromArray(node.getWorldMatrix());
    const skin = node.getSkin();
    const joints = skin?.listJoints().map(joint => new Matrix4().fromArray(joint.getWorldMatrix()));
    const binds = skin?.getInverseBindMatrices();
    const jointMatrices = joints?.map((joint, i) => joint.multiply(binds ? new Matrix4().fromArray(binds.getElement(i, [])) : new Matrix4()));
    const output = document.createMesh(mesh.getName());
    for (const primitive of mesh.listPrimitives()) {
      if (primitive.getMode() !== 4) throw new Error('Static showroom assets must use triangle primitives');
      const copy = primitive.clone();
      for (const target of copy.listTargets()) copy.removeTarget(target);
      const position = primitive.getAttribute('POSITION');
      const indices = primitive.getAttribute('JOINTS_0');
      const weights = primitive.getAttribute('WEIGHTS_0');
      const pos = position.clone().setArray(new Float32Array(position.getCount() * 3)).setNormalized(false);
      copy.setAttribute('POSITION', pos);
      const normal = primitive.getAttribute('NORMAL');
      const tangent = primitive.getAttribute('TANGENT');
      const nor = normal?.clone().setArray(new Float32Array(normal.getCount() * 3)).setNormalized(false);
      const tan = tangent?.clone().setArray(new Float32Array(tangent.getCount() * 4)).setNormalized(false);
      if (nor) copy.setAttribute('NORMAL', nor);
      if (tan) copy.setAttribute('TANGENT', tan);
      const matrix = new Matrix4();
      const normalMatrix = new Matrix3();
      const vector = new Vector3();
      for (let i = 0; i < position.getCount(); i++) {
        if (skin) {
          if (!indices || !weights) throw new Error('Skinned primitive is missing joints or weights');
          const joint = indices.getElement(i, []), weight = weights.getElement(i, []);
          matrix.elements.fill(0);
          for (let k = 0; k < 4; k++) {
            if (!weight[k]) continue;
            const elements = jointMatrices[joint[k]].elements;
            for (let e = 0; e < 16; e++) matrix.elements[e] += weight[k] * elements[e];
          }
        } else matrix.copy(world);
        vector.fromArray(position.getElement(i, [])).applyMatrix4(matrix);
        pos.setElement(i, vector.toArray());
        normalMatrix.getNormalMatrix(matrix);
        if (nor) {
          vector.fromArray(normal.getElement(i, [])).applyMatrix3(normalMatrix).normalize();
          nor.setElement(i, vector.toArray());
        }
        if (tan) {
          const value = tangent.getElement(i, []);
          vector.fromArray(value).applyMatrix3(normalMatrix).normalize();
          tan.setElement(i, [...vector.toArray(), value[3]]);
        }
      }
      copy.setAttribute('JOINTS_0', null).setAttribute('WEIGHTS_0', null);
      output.addPrimitive(copy);
    }
    baked.push(document.createNode(node.getName()).setMesh(output));
  }
  for (const child of scene.listChildren()) scene.removeChild(child);
  for (const node of baked) scene.addChild(node);
  for (const animation of root.listAnimations()) animation.dispose();
}
