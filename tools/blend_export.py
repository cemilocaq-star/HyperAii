#!/usr/bin/env python3
"""Developer utility (NOT runtime): export meshes of an UNCOMPRESSED .blend (2.7x, 64-bit LE) to OBJ with UVs, WITHOUT Blender.
Reads the file's own DNA schema, so field offsets are not guessed. Usage: blend_export.py in.blend out.obj [--report]"""
import struct, sys, collections
d = open(sys.argv[1], 'rb').read()
assert d[:7] == b'BLENDER', 'not an uncompressed .blend (gzip/zstd .blend are not supported)'
P = 8 if d[7:8] == b'-' else 4; assert d[8:9] == b'v', 'little-endian only'
bh = 4 + 4 + P + 4 + 4
pos = 12; blocks = []
while pos + bh <= len(d):
    code = d[pos:pos+4]; size = struct.unpack_from('<i', d, pos+4)[0]; old = int.from_bytes(d[pos+8:pos+8+P], 'little'); sd, nr = struct.unpack_from('<ii', d, pos+8+P)
    blocks.append(dict(code=code.rstrip(b'\0').decode('latin1'), size=size, old=old, sdna=sd, nr=nr, off=pos+bh)); pos += bh + size
    if code == b'ENDB': break
by_old = {b['old']: b for b in blocks if b['code'] != 'ENDB'}
dna = next(b for b in blocks if b['code'] == 'DNA1'); o = dna['off']
assert d[o:o+4] == b'SDNA'; o += 4; assert d[o:o+4] == b'NAME'; n = struct.unpack_from('<i', d, o+4)[0]; o += 8
names = []
for _ in range(n):
    e = d.index(b'\0', o); names.append(d[o:e].decode()); o = e + 1
o = (o + 3) & ~3; assert d[o:o+4] == b'TYPE'; n = struct.unpack_from('<i', d, o+4)[0]; o += 8; types = []
for _ in range(n):
    e = d.index(b'\0', o); types.append(d[o:e].decode()); o = e + 1
o = (o + 3) & ~3; assert d[o:o+4] == b'TLEN'; o += 4; tlen = list(struct.unpack_from('<%dh' % len(types), d, o)); o += 2 * len(types)
o = (o + 3) & ~3; assert d[o:o+4] == b'STRC'; n = struct.unpack_from('<i', d, o+4)[0]; o += 8; structs = []
for _ in range(n):
    t, nf = struct.unpack_from('<hh', d, o); o += 4; f = []
    for _ in range(nf): ft, fn = struct.unpack_from('<hh', d, o); o += 4; f.append((types[ft], names[fn]))
    structs.append((types[t], f))
SI = {s[0]: i for i, s in enumerate(structs)}
def arr_count(nm):
    c = 1
    import re
    for m in re.findall(r'\[(\d+)\]', nm): c *= int(m)
    return c
def fsize(tn, nm):
    if nm.startswith('*') or nm.startswith('(*'): return P * arr_count(nm)
    base = {'char': 1, 'uchar': 1, 'short': 2, 'ushort': 2, 'int': 4, 'float': 4, 'double': 8, 'int64_t': 8, 'uint64_t': 8, 'long': 8, 'ulong': 8}.get(tn)
    if base is None: base = sizeof(tn)
    return base * arr_count(nm)
_cache = {}
def sizeof(tn):
    if tn in _cache: return _cache[tn]
    if tn == 'void': return 0
    s = sum(fsize(a, b) for a, b in structs[SI[tn]][1]); _cache[tn] = s; return s
def layout(tn):
    off = 0; L = {}
    for a, b in structs[SI[tn]][1]:
        import re
        key = re.sub(r'^\**|\[.*', '', b.lstrip('(*').rstrip(')')) if b.startswith('(*') else re.sub(r'^\*+|\[.*$', '', b)
        L[key] = (off, a, b); off += fsize(a, b)
    return L, off
def read_ptr(buf, o): return int.from_bytes(buf[o:o+P], 'little')
def field(buf, L, nm, fmt): return struct.unpack_from(fmt, buf, L[nm][0])[0]
def data_of(ptr):
    b = by_old.get(ptr); return None if not b else d[b['off']:b['off']+b['size']]

OL0, _o = layout('Object'); OBJ_OF = {}
for _b in blocks:
    if _b['code'] != 'OB': continue
    _buf = d[_b['off']:_b['off'] + _b['size']]
    _data = read_ptr(_buf, OL0['data'][0]); _typ = struct.unpack_from('<h', _buf, OL0['type'][0])[0]
    if _typ != 1 or not _data: continue
    _mods = []; _p = read_ptr(_buf, OL0['modifiers'][0]); _g = 0
    while _p and _g < 20 and _p in by_old:
        _mb = by_old[_p]; _mbuf = d[_mb['off']:_mb['off'] + _mb['size']]; _mods.append(struct.unpack_from('<i', _mbuf, 2 * P)[0]); _p = read_ptr(_mbuf, 0); _g += 1
    OBJ_OF[_data] = dict(loc=struct.unpack_from('<3f', _buf, OL0['loc'][0]), size=struct.unpack_from('<3f', _buf, OL0['size'][0]), rot=struct.unpack_from('<3f', _buf, OL0['rot'][0]), mods=_mods, name=_buf[4 * P: 4 * P + 66].split(b'\0')[0][2:].decode('latin1'))
APPLY = '--apply-object' in sys.argv
ML, msz = layout('Mesh'); CL, csz = layout('CustomData'); LL, lsz = layout('CustomDataLayer')
report = []; out = ['# exported from .blend by tools/blend_export.py (no Blender); materials/textures NOT carried']; voff = 1; uoff = 1; rows = []
meshes = [b for b in blocks if b['code'] == 'ME']
for mb in meshes:
    buf = d[mb['off']:mb['off']+mb['size']]; assert len(buf) >= msz or True
    nv = field(buf, ML, 'totvert', '<i'); npoly = field(buf, ML, 'totpoly', '<i'); nl = field(buf, ML, 'totloop', '<i')
    idname = buf[ML['id'][0] + 0x20 - 0x20: ][:0]
    nm = d[mb['off'] + 32 + 0:mb['off'] + 32 + 66].split(b'\0')[0].decode('latin1') if False else ''
    # ID struct: next,prev,newid,lib (4 ptrs) then name[66]
    nm = d[mb['off'] + 4 * P: mb['off'] + 4 * P + 66].split(b'\0')[0][2:].decode('latin1')
    mv = data_of(read_ptr(buf, ML['mvert'][0])); mp = data_of(read_ptr(buf, ML['mpoly'][0])); mlp = data_of(read_ptr(buf, ML['mloop'][0]))
    uvs = None
    ld = ML['ldata'][0]; nlay = struct.unpack_from('<i', buf, ld + CL['totlayer'][0])[0]; layptr = read_ptr(buf, ld + CL['layers'][0]); lay = data_of(layptr)
    if lay:
        for i in range(nlay):
            lb = lay[i * lsz:(i + 1) * lsz]; t = struct.unpack_from('<i', lb, LL['type'][0])[0]
            if t == 16:  # CD_MLOOPUV
                dp = read_ptr(lb, LL['data'][0]); uvs = data_of(dp); break
    ok = mv and mp and mlp
    row = dict(mesh=nm, verts=nv, polys=npoly, loops=nl, has_mvert=bool(mv), has_mpoly=bool(mp), has_mloop=bool(mlp), has_uv=bool(uvs), uv_layers=nlay)
    if not ok: rows.append(row); continue
    V = [struct.unpack_from('<3f', mv, i * 20) for i in range(nv)]
    ob = OBJ_OF.get(mb['old']); row['object'] = ob['name'] if ob else None; row['modifier_types'] = ob['mods'] if ob else None
    mirror = False
    if APPLY and ob:
        assert all(abs(r) < 1e-6 for r in ob['rot']), 'rotated object: not handled'
        V = [(v[0] * ob['size'][0] + ob['loc'][0], v[1] * ob['size'][1] + ob['loc'][1], v[2] * ob['size'][2] + ob['loc'][2]) for v in V]
        mirror = 5 in ob['mods']  # eModifierType_Mirror (X axis, Blender default); Subsurf/Solidify are NOT applied
    out.append('o ' + (ob['name'] if (APPLY and ob) else nm).replace(' ', '_'))
    out += ['v %.6f %.6f %.6f' % v for v in V]
    if mirror: out += ['v %.6f %.6f %.6f' % (-v[0], v[1], v[2]) for v in V]
    if uvs: 
        U = [struct.unpack_from('<2f', uvs, i * 12) for i in range(nl)]; out += ['vt %.6f %.6f' % u for u in U]
    ntri = 0
    for i in range(npoly):
        ls, tl = struct.unpack_from('<ii', mp, i * 12)[:2]
        idx = [struct.unpack_from('<i', mlp, (ls + k) * 8)[0] for k in range(tl)]
        for k in range(1, tl - 1):
            tri = [(0, idx[0], ls), (k, idx[k], ls + k), (k + 1, idx[k + 1], ls + k + 1)]
            if uvs: out.append('f ' + ' '.join('%d/%d' % (v + voff, l + uoff) for _, v, l in tri))
            else: out.append('f ' + ' '.join('%d' % (v + voff) for _, v, l in tri))
            ntri += 1
            if mirror:  # mirrored copy: vertices offset by nv, winding flipped
                m = [tri[0], tri[2], tri[1]]
                if uvs: out.append('f ' + ' '.join('%d/%d' % (v + nv + voff, l + uoff) for _, v, l in m))
                else: out.append('f ' + ' '.join('%d' % (v + nv + voff) for _, v, l in m))
                ntri += 1
    xs = list(zip(*V)); row.update(tris=ntri, bbox=[round(max(c) - min(c), 4) for c in xs], min=[round(min(c), 4) for c in xs])
    rows.append(row); voff += nv * (2 if mirror else 1); uoff += nl if uvs else 0
open(sys.argv[2], 'w').write('\n'.join(out) + '\n')
for r in rows: print(r)

if '--objects' in sys.argv:
    OL, osz = layout('Object'); import math
    def idname(buf): return buf[4 * P: 4 * P + 66].split(b'\0')[0][2:].decode('latin1')
    names_by_old = {b['old']: idname(d[b['off']:b['off'] + 4 * P + 66]) for b in blocks if b['code'] in ('ME', 'OB', 'MA', 'IM')}
    for b in blocks:
        if b['code'] != 'OB': continue
        buf = d[b['off']:b['off'] + b['size']]
        f3 = lambda n: struct.unpack_from('<3f', buf, OL[n][0])
        typ = struct.unpack_from('<h', buf, OL['type'][0])[0]
        data = read_ptr(buf, OL['data'][0]); par = read_ptr(buf, OL['parent'][0])
        mods = read_ptr(buf, OL['modifiers'][0]) if 'modifiers' in OL else 0  # ListBase.first at offset
        # modifiers is a ListBase (first,last pointers): its first pointer is at the field offset
        mod_names = []; p = mods
        guard = 0
        while p and guard < 20:
            mb = by_old.get(p)
            if not mb: break
            mbuf = d[mb['off']:mb['off'] + mb['size']]
            # ModifierData: next, prev, type(int), mode(int), stackindex, name[64]
            nxt = read_ptr(mbuf, 0); mt, mm = struct.unpack_from('<ii', mbuf, 2 * P)
            mod_names.append((mt, mm)); p = nxt; guard += 1
        print('OBJECT', idname(buf), 'type', typ, 'data->', names_by_old.get(data), 'parent->', names_by_old.get(par), 'loc', [round(x, 4) for x in f3('loc')], 'rot', [round(math.degrees(x), 2) for x in f3('rot')], 'size', [round(x, 4) for x in f3('size')], 'modifiers(type,mode)', mod_names)
    for b in blocks:
        if b['code'] == 'IM':
            buf = d[b['off']:b['off'] + b['size']]; print('IMAGE', idname(buf), 'filepath:', buf[4 * P + 66 + 0: 4 * P + 66 + 1024].split(b'\0')[0][:120] if False else '')
        if b['code'] == 'MA':
            print('MATERIAL', d[b['off'] + 4 * P:b['off'] + 4 * P + 66].split(b'\0')[0][2:].decode('latin1'))
