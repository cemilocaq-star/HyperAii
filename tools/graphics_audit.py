#!/usr/bin/env python3
"""Measured asset inventory for the graphics audit (offline, read-only).
Writes docs/graphics_audit_data.json and prints a summary. Nothing here is an estimate: every number is parsed from the files.
Usage: python3 tools/graphics_audit.py"""
import glob, json, os, struct, re, sys
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
PUB = os.path.join(ROOT, 'public')

def is_pot(n): return n > 0 and (n & (n - 1)) == 0

def audit_obj(path):
    v = vt = vn = tri = vcol = 0; objs = 0; mtllib = []; usemtl = set(); mn = [1e30] * 3; mx = [-1e30] * 3
    faces_with_vt = faces_with_vn = faces = 0
    for line in open(path, encoding='utf8', errors='ignore'):
        if line.startswith('v '):
            p = line.split(); v += 1
            xyz = [float(x) for x in p[1:4]]
            for i in range(3): mn[i] = min(mn[i], xyz[i]); mx[i] = max(mx[i], xyz[i])
            if len(p) >= 7: vcol += 1
        elif line.startswith('vt '): vt += 1
        elif line.startswith('vn '): vn += 1
        elif line.startswith('f '):
            toks = line.split()[1:]; faces += 1; tri += max(0, len(toks) - 2)
            if all('/' in t and t.split('/')[1] != '' for t in toks): faces_with_vt += 1
            if all(t.count('/') == 2 for t in toks): faces_with_vn += 1
        elif line.startswith(('o ', 'g ')): objs += 1
        elif line.startswith('mtllib'): mtllib.append(line.split(None, 1)[1].strip())
        elif line.startswith('usemtl'): usemtl.add(line.split(None, 1)[1].strip())
    mtl_exist = {m: os.path.exists(os.path.join(os.path.dirname(path), m)) for m in mtllib}
    def _mtl_status(m):  # ORIGINAL only if the file exists and is not one of our generated stand-ins
        fp = os.path.join(os.path.dirname(path), m)
        if not os.path.exists(fp): return 'MISSING'
        head = open(fp, encoding='utf8', errors='ignore').read(200)
        return 'RECONSTRUCTED' if head.startswith('# RECONSTRUCTED') else 'ORIGINAL'
    mtl_status = {m: _mtl_status(m) for m in mtllib}
    return dict(kind='obj', kb=round(os.path.getsize(path) / 1024), verts=v, tris=tri, objects=objs, uv=faces_with_vt == faces and faces > 0, normals=faces_with_vn == faces and faces > 0,
                vertex_colors=vcol == v and v > 0, mtllib=mtllib, mtl_present=mtl_exist, mtl_status=mtl_status, usemtl=sorted(usemtl),
                size=[round(mx[i] - mn[i], 3) for i in range(3)] if v else None)

def audit_glb(path):
    b = open(path, 'rb').read(); L = struct.unpack('<I', b[12:16])[0]; j = json.loads(b[20:20 + L])
    tri = 0; prims = 0; uv = nrm = tan = True; any_prim = False
    for m in j.get('meshes', []):
        for p in m['primitives']:
            any_prim = True; prims += 1; a = p['attributes']
            uv &= 'TEXCOORD_0' in a; nrm &= 'NORMAL' in a; tan &= 'TANGENT' in a
            tri += (j['accessors'][p['indices']]['count'] if 'indices' in p else j['accessors'][a['POSITION']]['count']) // 3
    mats = []
    for m in j.get('materials', []):
        pbr = m.get('pbrMetallicRoughness', {})
        mats.append(dict(name=m.get('name'), baseColorTexture='baseColorTexture' in pbr, metallicRoughnessTexture='metallicRoughnessTexture' in pbr, normalTexture='normalTexture' in m,
                         emissive=('emissiveFactor' in m) or ('emissiveTexture' in m), metallic=pbr.get('metallicFactor', 1.0), roughness=pbr.get('roughnessFactor', 1.0), alphaMode=m.get('alphaMode', 'OPAQUE')))
    return dict(kind='glb', kb=round(os.path.getsize(path) / 1024), tris=tri, prims=prims, materials=mats, images=len(j.get('images', [])), skins=len(j.get('skins', [])), animations=len(j.get('animations', [])),
                uv=uv and any_prim, normals=nrm and any_prim, tangents=tan and any_prim)

def png_size(path):
    d = open(path, 'rb').read(32)
    if d[:8] == b'\x89PNG\r\n\x1a\n': return struct.unpack('>II', d[16:24])
    return None

def jpg_size(path):
    d = open(path, 'rb').read(); i = 2
    while i < len(d):
        if d[i] != 0xFF: i += 1; continue
        m = d[i + 1]
        if 0xC0 <= m <= 0xC3: h, w = struct.unpack('>HH', d[i + 5:i + 9]); return (w, h)
        i += 2 + struct.unpack('>H', d[i + 2:i + 4])[0]
    return None

def audit_tex(path):
    ext = path.lower().rsplit('.', 1)[-1]; s = png_size(path) if ext == 'png' else jpg_size(path)
    if not s: return dict(kind='texture', kb=round(os.path.getsize(path) / 1024), size=None)
    w, h = s
    return dict(kind='texture', kb=round(os.path.getsize(path) / 1024), size=[w, h], pot=is_pot(w) and is_pot(h), gpu_mb_with_mips=round(w * h * 4 * 4 / 3 / 1048576, 1))

def main():
    out = {}
    for f in sorted(glob.glob(PUB + '/**/*', recursive=True)):
        if not os.path.isfile(f): continue
        rel = os.path.relpath(f, PUB).replace(os.sep, '/'); e = rel.rsplit('.', 1)[-1].lower()
        if e == 'obj': out[rel] = audit_obj(f)
        elif e == 'glb': out[rel] = audit_glb(f)
        elif e in ('png', 'jpg', 'jpeg'): out[rel] = audit_tex(f)
    os.makedirs(os.path.join(ROOT, 'docs'), exist_ok=True)
    json.dump(out, open(os.path.join(ROOT, 'docs', 'graphics_audit_data.json'), 'w', encoding='utf8'), indent=1, sort_keys=True)
    objs = {k: v for k, v in out.items() if v['kind'] == 'obj'}; glbs = {k: v for k, v in out.items() if v['kind'] == 'glb'}; texs = {k: v for k, v in out.items() if v['kind'] == 'texture'}
    print('== OBJ (%d) ==' % len(objs))
    for k, v in objs.items():
        if 'weapons/split' in k and not k.endswith(('weapon_001.obj', 'weapon_006.obj')): continue
        print('%-52s %5dKB tris=%6d uv=%-5s nrm=%-5s vcol=%-5s mtllib=%s present=%s usemtl=%s' % (k, v['kb'], v['tris'], v['uv'], v['normals'], v['vertex_colors'], v['mtllib'], list(v['mtl_present'].values()), v['usemtl'][:3]))
    sp = [v for k, v in objs.items() if 'weapons/split' in k]
    print('weapon split files: %d | with UV: %d | with normals: %d | with usemtl: %d' % (len(sp), sum(1 for v in sp if v['uv']), sum(1 for v in sp if v['normals']), sum(1 for v in sp if v['usemtl'])))
    print('\n== GLB (%d) ==' % len(glbs))
    print('tris max=%d | with UV=%d | with normals=%d | with tangents=%d | with embedded images=%d | skins=%d | animations=%d' % (max(v['tris'] for v in glbs.values()), sum(v['uv'] for v in glbs.values()), sum(v['normals'] for v in glbs.values()), sum(v['tangents'] for v in glbs.values()), sum(1 for v in glbs.values() if v['images']), sum(v['skins'] for v in glbs.values()), sum(v['animations'] for v in glbs.values())))
    mats = [m for v in glbs.values() for m in v['materials']]
    print('GLB materials: %d | with baseColor texture: %d | with normal map: %d | with metal/rough map: %d | emissive: %d | metallic>0.5: %d' % (len(mats), sum(m['baseColorTexture'] for m in mats), sum(m['normalTexture'] for m in mats), sum(m['metallicRoughnessTexture'] for m in mats), sum(m['emissive'] for m in mats), sum(1 for m in mats if m['metallic'] > 0.5)))
    print('\n== textures (%d) ==' % len(texs))
    for k, v in texs.items(): print('%-52s %6dKB size=%s pot=%s gpuMB(mips)=%s' % (k, v['kb'], v.get('size'), v.get('pot'), v.get('gpu_mb_with_mips')))
if __name__ == '__main__': main()
