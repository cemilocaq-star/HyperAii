#!/usr/bin/env python3
"""Developer utility (NOT runtime): reduce an OBJ to a triangle budget by per-object vertex clustering (numpy only).
Keeps the `o` object structure, drops usemtl/mtllib (source MTL is missing/mismatched), recomputes smooth normals.
Usage: python3 tools/decimate_obj.py IN.obj OUT.obj --target 60000 [--report out.json]"""
import sys, json, argparse, numpy as np
ap = argparse.ArgumentParser(); ap.add_argument('src'); ap.add_argument('dst'); ap.add_argument('--target', type=int, default=60000); ap.add_argument('--report'); ap.add_argument('--keep-usemtl', action='store_true', help='keep one usemtl per object (no mtllib is written)')
a = ap.parse_args()
V = []; objs = []; cur = None
for ln in open(a.src, encoding='utf8', errors='ignore'):
    if ln.startswith('v '): V.append(ln.split()[1:4])
    elif ln.startswith(('o ', 'g ')):
        cur = {'name': ln.split(None, 1)[1].strip(), 'tris': [], 'mat': None}; objs.append(cur)
    elif ln.startswith('usemtl') and cur is not None:
        if cur['mat'] not in (None, ln.split()[1]): raise SystemExit('object %s uses more than one material: split first' % cur['name'])
        cur['mat'] = ln.split()[1]
    elif ln.startswith('f '):
        if cur is None: cur = {'name': 'default', 'tris': [], 'mat': None}; objs.append(cur)
        idx = [int(t.split('/')[0]) for t in ln.split()[1:]]
        idx = [i - 1 if i > 0 else len(V) + i for i in idx]
        for k in range(1, len(idx) - 1): cur['tris'].append((idx[0], idx[k], idx[k + 1]))
V = np.array(V, dtype=np.float64)
for o in objs: o['tris'] = np.array(o['tris'], dtype=np.int64).reshape(-1, 3)
total_in = sum(len(o['tris']) for o in objs)
lo, hi = V.min(0), V.max(0); diag = float(np.linalg.norm(hi - lo))
def cluster(cell):
    out = []
    for o in objs:
        t = o['tris']
        if not len(t): out.append((np.zeros((0, 3)), np.zeros((0, 3), dtype=np.int64))); continue
        used = np.unique(t); P = V[used]
        od = float(np.linalg.norm(P.max(0) - P.min(0))) or 1.0
        c = min(cell, od / 6.0)  # never let a whole real object collapse to nothing
        key = np.floor((P - lo) / c).astype(np.int64)
        _, inv, cnt = np.unique(key, axis=0, return_inverse=True, return_counts=True)
        inv = inv.reshape(-1); C = np.zeros((cnt.size, 3)); np.add.at(C, inv, P); C /= cnt[:, None]
        remap = np.zeros(V.shape[0], dtype=np.int64); remap[used] = inv
        nt = remap[t]; keep = (nt[:, 0] != nt[:, 1]) & (nt[:, 1] != nt[:, 2]) & (nt[:, 0] != nt[:, 2])
        nt = nt[keep]
        if len(nt): nt = np.unique(np.sort(nt, axis=1), axis=0) if False else nt
        out.append((C, nt))
    return out
a_, b_ = diag / 4000.0, diag / 4.0
best = None
for _ in range(28):  # binary search the cell size to meet the triangle budget
    mid = (a_ + b_) / 2; res = cluster(mid); n = sum(len(r[1]) for r in res)
    if n > a.target: a_ = mid
    else: b_ = mid; best = (mid, res, n)
cell, res, n_out = best
lines = ['# decimated by tools/decimate_obj.py from %s (vertex clustering, cell=%.5f); mtllib intentionally NOT written' % (a.src.split('/')[-1], cell)]
off = 0; vtx = 0; report_objs = []
for o, (C, T) in zip(objs, res):
    if not len(T): continue
    N = np.zeros_like(C); p0, p1, p2 = C[T[:, 0]], C[T[:, 1]], C[T[:, 2]]
    fn = np.cross(p1 - p0, p2 - p0)
    for k in range(3): np.add.at(N, T[:, k], fn)
    ln = np.linalg.norm(N, axis=1); ln[ln == 0] = 1; N /= ln[:, None]
    lines.append('o ' + o['name'].replace(' ', '_'))
    if a.keep_usemtl and o.get('mat'): lines.append('usemtl ' + o['mat'])
    lines += ['v %.5f %.5f %.5f' % tuple(p) for p in C]
    lines += ['vn %.4f %.4f %.4f' % tuple(n) for n in N]
    lines += ['f %d//%d %d//%d %d//%d' % (t[0] + 1 + off, t[0] + 1 + off, t[1] + 1 + off, t[1] + 1 + off, t[2] + 1 + off, t[2] + 1 + off) for t in T]
    off += len(C); vtx += len(C); report_objs.append({'name': o['name'], 'tris': int(len(T))})
open(a.dst, 'w').write('\n'.join(lines) + '\n')
rep = {'src_tris': total_in, 'out_tris': int(n_out), 'out_vertices': int(vtx), 'objects_kept': len(report_objs), 'objects_in': len(objs), 'cell': cell}
print(json.dumps(rep))
if a.report: json.dump(rep, open(a.report, 'w'), indent=2)
