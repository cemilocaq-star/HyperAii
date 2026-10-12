#!/usr/bin/env python3
"""Developer utility (NOT runtime): audits public/models/weapons/all_weapons.obj.
Reports objects, groups, materials, connected components, spatial clusters, MTL/texture status.
Usage: python3 tools/weapon_audit.py [--gap 0.35] [--json out.json]"""
import sys, os, json, collections, argparse
ap = argparse.ArgumentParser(); ap.add_argument('--gap', type=float, default=0.35); ap.add_argument('--json')
a = ap.parse_args()
root = os.path.join(os.path.dirname(__file__), '..', 'public', 'models', 'weapons')
obj = os.path.join(root, 'all_weapons.obj')
verts, faces, objs, mats, groups, mtllibs = [], [], [], set(), 0, []
cur = None
for ln in open(obj, encoding='utf8', errors='ignore'):
    p = ln.split()
    if not p: continue
    if p[0] == 'o': cur = {'name': p[1], 'f0': len(faces)}; objs.append(cur)
    elif p[0] == 'g': groups += 1
    elif p[0] == 'usemtl': mats.add(p[1])
    elif p[0] == 'mtllib': mtllibs.append(' '.join(p[1:]))
    elif p[0] == 'v': verts.append(tuple(map(float, p[1:4])))
    elif p[0] == 'f': faces.append([int(x.split('/')[0]) - 1 for x in p[1:]])
par = list(range(len(verts)))
def find(x):
    while par[x] != x: par[x] = par[par[x]]; x = par[x]
    return x
for f in faces:
    for v in f[1:]:
        ra, rb = find(f[0]), find(v)
        if ra != rb: par[ra] = rb
comp = collections.defaultdict(lambda: [1e9]*3 + [-1e9]*3 + [0])
for f in faces:
    c = comp[find(f[0])]; c[6] += 1
    for v in f:
        for i in range(3):
            c[i] = min(c[i], verts[v][i]); c[i+3] = max(c[i+3], verts[v][i])
boxes = list(comp.values())
# cluster components whose bboxes overlap/touch within `gap` (barrel+magazine+sight => one weapon)
cp = list(range(len(boxes)))
def cf(x):
    while cp[x] != x: cp[x] = cp[cp[x]]; x = cp[x]
    return x
def near(b1, b2, g):
    return all(b1[i] - g <= b2[i+3] and b2[i] - g <= b1[i+3] for i in range(3))
for i in range(len(boxes)):
    for j in range(i+1, len(boxes)):
        if near(boxes[i], boxes[j], a.gap):
            ri, rj = cf(i), cf(j)
            if ri != rj: cp[ri] = rj
clusters = collections.Counter(cf(i) for i in range(len(boxes)))
mtl_missing = [m for m in mtllibs if not os.path.exists(os.path.join(root, m))]
zero = sum(1 for b in boxes if b[3] - b[0] <= 0 or b[4] - b[1] <= 0 or b[5] - b[2] <= 0)
rep = {'obj_files_total': sum(f.endswith('.obj') for _, _, fs in os.walk(os.path.join(root, '..')) for f in fs),
       'objects': len(objs), 'groups': groups, 'materials': len(mats), 'vertices': len(verts), 'faces': len(faces),
       'connected_components': len(boxes), 'spatial_clusters(gap=%s)' % a.gap: len(clusters),
       'mtllib': mtllibs, 'mtl_missing': mtl_missing, 'zero_size_components': zero,
       'exported_weapon_files': len([f for f in os.listdir(os.path.join(root,'split'))]) if os.path.isdir(os.path.join(root,'split')) else 0,
       'objects_equal_clusters': len(objs) == len(clusters),
       'verdict': ('MODEL COUNT = %d (objects == spatial clusters); 94 NOT confirmed' % len(clusters) if len(objs) == len(clusters) else 'BLOCKED — asset topology does not allow reliable automatic separation') + ('; MTL MISSING: textures/materials unresolved' if mtl_missing else '')}
print(json.dumps(rep, indent=2, ensure_ascii=False))
if a.json: json.dump(rep, open(a.json, 'w'), indent=2)
