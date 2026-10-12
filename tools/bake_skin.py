#!/usr/bin/env python3
"""Developer utility (NOT runtime): turn a full-body OBJ (many groups / materials / per-material JPG textures) into ONE decimated mesh
with per-vertex colours, normalised to a player height, so a skin costs one draw call and a few thousand triangles.
 - colour per corner = texture sample at the corner UV (PIL) when the material has a readable map_Kd, else the MTL Kd
 - material -> texture file rule is evidence based and chosen per model with --tex-rule (material-name | strip-suffix | mtl)
 - vertex clustering (numpy) to --target triangles, cluster colour/position = mean of members
 - output: y-up, feet at y=0, height --height, centred on x/z; facing estimated from the feet (toes) and rotated to face -Z
Usage: bake_skin.py in.obj in.mtl OUT.obj --target 6000 --height 1.8 [--texdir DIR --tex-rule material-name] [--strip-namespace] [--report out.json]"""
import argparse, json, os, re, sys
import numpy as np
ap = argparse.ArgumentParser()
for a in ('obj', 'mtl', 'out'): ap.add_argument(a)
ap.add_argument('--target', type=int, default=6000); ap.add_argument('--height', type=float, default=1.8)
ap.add_argument('--texdir'); ap.add_argument('--tex-rule', default='mtl', choices=['mtl', 'material-name'])
ap.add_argument('--strip-namespace', action='store_true', help="usemtl 'ns:name' -> 'name' (Maya namespace prefix)")
ap.add_argument('--report'); a = ap.parse_args()

# ---- MTL: Kd and map_Kd per material (first definition wins; later duplicates with the same name are identical in the sources we use) ----
kd, mapkd = {}, {}
cur = None
for ln in open(a.mtl, encoding='utf8', errors='ignore').read().replace('\r', '').split('\n'):
    t = ln.strip()
    if t.startswith('newmtl'): cur = t.split(None, 1)[1].strip(); kd.setdefault(cur, None); continue
    if cur and t.startswith('Kd ') and kd[cur] is None: kd[cur] = tuple(float(x) for x in t.split()[1:4])
    if cur and t.startswith('map_Kd') and cur not in mapkd: mapkd[cur] = t.split(None, 1)[1].strip()
tex_cache = {}
def texture(mat):
    if not a.texdir: return None
    names = [mat + '.jpg'] if a.tex_rule == 'material-name' else [mapkd.get(mat), re.sub(r'_\d+(\.\w+)$', r'\1', mapkd.get(mat) or '')]
    for n in names:
        if n and os.path.exists(os.path.join(a.texdir, n)):
            if n not in tex_cache:
                from PIL import Image
                tex_cache[n] = np.asarray(Image.open(os.path.join(a.texdir, n)).convert('RGB'), dtype=np.float32) / 255.0
            return tex_cache[n]
    return None

# ---- OBJ ----
V, VT = [], []; faces = []   # (vi, ti or -1, material) per triangle corner triples
mat = None; undefined = set()
for ln in open(a.obj, encoding='utf8', errors='ignore'):
    if ln.startswith('v '): V.append(ln.split()[1:4])
    elif ln.startswith('vt '): VT.append(ln.split()[1:3])
    elif ln.startswith('usemtl'):
        mat = ln.split(None, 1)[1].strip()
        if a.strip_namespace and ':' in mat and mat not in kd: mat = mat.split(':', 1)[1]
        if mat not in kd: undefined.add(mat)
    elif ln.startswith('f '):
        pts = ln.split()[1:]; vi = []; ti = []
        for p in pts:
            q = p.split('/'); i = int(q[0]); vi.append(i - 1 if i > 0 else len(V) + i)   # negative = relative to the vertices defined SO FAR
            t = int(q[1]) if len(q) > 1 and q[1] else 0; ti.append(t if t >= 0 else len(VT) + 1 + t)  # kept 1-based (0 = none)
        for k in range(1, len(pts) - 1): faces.append((vi[0], vi[k], vi[k + 1], ti[0], ti[k], ti[k + 1], mat))
V = np.array(V, dtype=np.float64); VT = np.array(VT, dtype=np.float64) if VT else np.zeros((0, 2))
n = len(V); tri_v = np.array([[f[0], f[1], f[2]] for f in faces], dtype=np.int64)
assert tri_v.max() < n and tri_v.min() >= 0, 'face index out of range'
# ---- per-vertex colour (mean over the corners that use the vertex) ----
col = np.zeros((n, 3)); cnt = np.zeros(n)
mats = sorted({f[6] for f in faces if f[6]}); fallback = (0.6, 0.6, 0.65)
for m in mats + [None]:
    idx = [i for i, f in enumerate(faces) if f[6] == m]
    if not idx: continue
    tex = texture(m) if m else None; base = np.array((kd.get(m) or fallback) if m else fallback)
    for c in range(3):
        vv = tri_v[idx, c]
        if tex is not None and len(VT):
            tt = np.array([faces[i][3 + c] for i in idx]); ok = (tt > 0) & (tt <= len(VT))
            uv = VT[np.where(ok, tt - 1, 0)]; h, w = tex.shape[:2]
            x = np.clip((uv[:, 0] % 1.0) * (w - 1), 0, w - 1).astype(int); y = np.clip((1.0 - (uv[:, 1] % 1.0)) * (h - 1), 0, h - 1).astype(int)
            rgb = np.where(ok[:, None], tex[y, x], base[None, :])
        else: rgb = np.repeat(base[None, :], len(idx), axis=0)
        np.add.at(col, vv, rgb); np.add.at(cnt, vv, 1)
col = np.where(cnt[:, None] > 0, col / np.maximum(cnt, 1)[:, None], np.array(fallback))
# ---- normalise: y-up, feet y=0, height, centre x/z; estimate facing from the feet ----
used = np.unique(tri_v); lo, hi = V[used].min(0), V[used].max(0); H = hi[1] - lo[1]
feet = V[used][V[used][:, 1] < lo[1] + 0.04 * H]; cx, cz = (lo[0] + hi[0]) / 2, (lo[2] + hi[2]) / 2
toe_dir = np.sign(feet[:, 2].mean() - cz) or 1.0   # toes extend towards the front
s = a.height / H; P = (V - np.array([cx, lo[1], cz])) * s
if toe_dir > 0: P[:, 0] *= -1; P[:, 2] *= -1          # rotate 180 deg about Y so the front faces -Z (three.js forward)
flipped = toe_dir > 0
# ---- vertex clustering to the triangle budget ----
lo2, hi2 = P[used].min(0), P[used].max(0); diag = float(np.linalg.norm(hi2 - lo2))
def cluster(cell):
    key = np.floor((P[used] - lo2) / cell).astype(np.int64)
    _, inv, c = np.unique(key, axis=0, return_inverse=True, return_counts=True); inv = inv.reshape(-1)
    C = np.zeros((c.size, 3)); Cc = np.zeros((c.size, 3)); np.add.at(C, inv, P[used]); np.add.at(Cc, inv, col[used]); C /= c[:, None]; Cc /= c[:, None]
    remap = np.full(n, -1, dtype=np.int64); remap[used] = inv; t = remap[tri_v]
    keep = (t[:, 0] != t[:, 1]) & (t[:, 1] != t[:, 2]) & (t[:, 0] != t[:, 2]); t = t[keep]
    return C, Cc, t
a_, b_ = diag / 3000.0, diag / 3.0; best = None
for _ in range(30):
    mid = (a_ + b_) / 2; C, Cc, t = cluster(mid)
    if len(t) > a.target: a_ = mid
    else: b_ = mid; best = (mid, C, Cc, t)
cell, C, Cc, T = best
# clustering averages positions, which pulls the extremes inwards: re-normalise the FINAL mesh so feet are exactly on y=0, the height is exact and x/z are centred
ymin, ymax = C[:, 1].min(), C[:, 1].max(); C[:, 1] = (C[:, 1] - ymin) * (a.height / (ymax - ymin))
C[:, 0] -= (C[:, 0].min() + C[:, 0].max()) / 2; C[:, 2] -= (C[:, 2].min() + C[:, 2].max()) / 2
N = np.zeros_like(C); fn = np.cross(C[T[:, 1]] - C[T[:, 0]], C[T[:, 2]] - C[T[:, 0]])
for k in range(3): np.add.at(N, T[:, k], fn)
ln = np.linalg.norm(N, axis=1); ln[ln == 0] = 1; N /= ln[:, None]
with open(a.out, 'w') as f:
    f.write('# baked by tools/bake_skin.py: one mesh, per-vertex colours (v x y z r g b), y-up, feet y=0, height %.3f, front=-Z (%s)\n' % (a.height, 'estimated from feet, rotated 180 deg' if flipped else 'estimated from feet'))
    for p, c in zip(C, Cc): f.write('v %.4f %.4f %.4f %.3f %.3f %.3f\n' % (p[0], p[1], p[2], c[0], c[1], c[2]))
    for nn in N: f.write('vn %.3f %.3f %.3f\n' % tuple(nn))
    for t in T: f.write('f %d//%d %d//%d %d//%d\n' % (t[0] + 1, t[0] + 1, t[1] + 1, t[1] + 1, t[2] + 1, t[2] + 1))
rep = dict(src_tris=len(faces), src_verts=int(n), out_tris=int(len(T)), out_verts=int(len(C)), materials=len(mats), materials_with_texture=sum(1 for m in mats if texture(m) is not None),
           undefined_materials=sorted(undefined), height=a.height, facing_flipped=bool(flipped), cell=cell, size=[round(float(x), 3) for x in (C.max(0) - C.min(0))])
print(json.dumps(rep))
if a.report: json.dump(rep, open(a.report, 'w'), indent=2)
