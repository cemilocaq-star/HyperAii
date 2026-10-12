#!/usr/bin/env python3
"""Developer utility (NOT runtime): export the Geometry nodes of a BINARY FBX (7.x, 32-bit offsets) to a static OBJ + MTL (DiffuseColor of the Materials).
Geometry is exported as stored (mesh space / bind pose); skeleton, skin weights and animation are NOT carried. Usage: fbx_static_export.py in.fbx out.obj out.mtl"""
import struct, sys, zlib
d = open(sys.argv[1], 'rb').read(); assert d[:20] == b'Kaydara FBX Binary  ', 'not a binary FBX'
ver = struct.unpack_from('<I', d, 23)[0]; assert ver < 7500, '64-bit offset FBX (>=7.5) not supported'; HS = 13
def node(o):
    end, np_, pl, nl = struct.unpack_from('<IIIB', d, o); return end, np_, pl, d[o + HS:o + HS + nl].decode('latin1'), o + HS + nl
def props(p, np_):
    out = []
    for _ in range(np_):
        t = chr(d[p]); p += 1
        if t in 'YCFDIL':
            sz = {'Y': 2, 'C': 1, 'F': 4, 'D': 8, 'I': 4, 'L': 8}[t]; out.append(struct.unpack({'Y': '<h', 'C': '<B', 'F': '<f', 'D': '<d', 'I': '<i', 'L': '<q'}[t], d[p:p + sz])[0]); p += sz
        elif t in 'SR':
            n = struct.unpack_from('<I', d, p)[0]; p += 4; out.append(d[p:p + n].decode('utf8', 'replace') if t == 'S' else d[p:p + n]); p += n
        else:
            n, enc, cl = struct.unpack_from('<III', d, p); p += 12; raw = d[p:p + cl]; p += cl
            if enc == 1: raw = zlib.decompress(raw)
            out.append(list(struct.unpack('<%d%s' % (n, {'f': 'f', 'd': 'd', 'l': 'q', 'i': 'i', 'b': 'b'}[t]), raw)))
    return out, p
def children(o, end):
    res = []; q = o
    while q < end:
        e, np_, pl, name, ps = node(q)
        if e == 0: break
        pr, pe = props(ps, np_); res.append((name, pr, pe, e)); q = e
    return res
top = []; o = 27
while True:
    e, np_, pl, name, ps = node(o)
    if e == 0: break
    top.append((name, ps + pl, e)); o = e
objs = [c for n, cs, e in top if n == 'Objects' for c in children(cs, e)]
def nm(pr): return pr[1].split('\x00')[0] if len(pr) > 1 and isinstance(pr[1], str) else ''
mats = []
for name, pr, pe, e in objs:
    if name == 'Material':
        col = (0.7, 0.7, 0.7)
        for k, p2, pe2, e2 in children(pe, e):
            if k == 'Properties70':
                for k2, p3, _, _ in children(pe2, e2):
                    if k2 == 'P' and p3 and p3[0] == 'DiffuseColor': col = tuple(float(x) for x in p3[4:7])
        mats.append((nm(pr), col))
vo = 1; out = ['# exported from FBX by tools/fbx_static_export.py (static geometry only; no skeleton/skin/animation)']; report = []
for name, pr, pe, e in objs:
    if name != 'Geometry': continue
    sub = {k: p for k, p, _, _ in children(pe, e)}; V = sub.get('Vertices', [[]])[0]; I = sub.get('PolygonVertexIndex', [[]])[0]
    if not V or not I: continue
    n = len(V) // 3; out.append('o ' + (nm(pr) or 'geometry').replace(' ', '_')); out.append('usemtl ' + (mats[0][0] if mats else 'default'))
    out += ['v %.5f %.5f %.5f' % (V[i * 3], V[i * 3 + 1], V[i * 3 + 2]) for i in range(n)]
    poly = []; tris = 0
    for i in I:
        end_ = i < 0; poly.append((~i) if end_ else i)
        if end_:
            for k in range(1, len(poly) - 1): out.append('f %d %d %d' % (poly[0] + vo, poly[k] + vo, poly[k + 1] + vo)); tris += 1
            poly = []
    ys = V[1::3]; report.append((nm(pr), n, tris, round(max(ys) - min(ys), 3), [round(max(V[j::3]) - min(V[j::3]), 3) for j in range(3)])); vo += n
open(sys.argv[2], 'w').write('\n'.join(out) + '\n')
open(sys.argv[3], 'w').write(''.join('newmtl %s\nKd %.4f %.4f %.4f\n' % (n_, *c) for n_, c in (mats or [('default', (0.7, 0.7, 0.7))])))
print('materials', mats); print('geometries', report)
