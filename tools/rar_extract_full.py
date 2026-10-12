#!/usr/bin/env python3
"""Developer utility (NOT runtime): extract a RAR4 archive with OUR OWN decoder (tools/rar3ppm.c) and verify every file against the CRC32 stored
in its RAR header. Exists because system libarchive mis-decodes some PPMd->LZ block switches and cannot run VM filters.
Supports: stored, LZ, PPMd var.H, mixed blocks, standard VM filters (DELTA/E8/E8E9/RGB/AUDIO). NOT supported (reported, never guessed):
encrypted entries, solid archives, RAR5, non-standard VM programs, ITANIUM filter semantics.
Usage: rar_extract_full.py ARCHIVE OUTDIR"""
import os, struct, subprocess, sys, tempfile, zlib
HERE = os.path.dirname(os.path.abspath(__file__))
def build_decoder():
    """Compile tools/rar3ppm.c. The binary name carries the SOURCE hash, so a binary built from a different (e.g. mutated) source can never be reused."""
    import hashlib
    src = os.path.join(HERE, 'rar3ppm.c'); h = hashlib.sha1(open(src, 'rb').read()).hexdigest()[:12]
    exe = os.path.join(tempfile.gettempdir(), 'rar3ppm_%s_%d' % (h, os.getuid()))
    if not os.path.exists(exe):
        r = subprocess.run(['gcc', '-O2', '-w', '-o', exe, src], capture_output=True, text=True)
        if r.returncode != 0: raise SystemExit('gcc failed: ' + r.stderr[:300])
    return exe
def entries(path):
    d = open(path, 'rb').read(); assert d[:7] == b'Rar!\x1a\x07\x00', 'not a RAR4 archive'
    pos = 7; out = []
    while pos + 7 <= len(d):
        crc, typ, flags, size = struct.unpack_from('<HBHH', d, pos)
        if size < 7: break
        add = 0
        if typ == 0x74:
            pack, unp, host, fcrc, ftime, ver, meth, nlen, attr = struct.unpack_from('<IIBIIBBHI', d, pos + 7); o = pos + 32
            if flags & 0x100:
                hp, hu = struct.unpack_from('<II', d, o); o += 8; pack |= hp << 32; unp |= hu << 32
            nm = d[o:o + nlen].split(b'\0')[0]
            try: nm = nm.decode('utf8')
            except UnicodeDecodeError: nm = nm.decode('cp1251', 'replace')
            out.append(dict(name=nm, pack=pack, unp=unp, crc=fcrc, meth=meth, enc=bool(flags & 4), solid=bool(flags & 0x10), dir=(flags & 0xE0) == 0xE0, data=pos + size)); add = pack
        elif flags & 0x8000: add = struct.unpack_from('<I', d, pos + 7)[0]
        pos += size + add
        if typ == 0x7B: break
    return d, out
def extract(path, outdir):
    d, ents = entries(path); exe = build_decoder(); res = []
    for e in ents:
        if e['dir']: continue
        rel = e['name'].replace('\\', '/').lstrip('/')
        if '..' in rel.split('/'): res.append((e['name'], 'SKIPPED-UNSAFE-PATH', 0)); continue
        if e['enc']: res.append((e['name'], 'ENCRYPTED-NOT-SUPPORTED', 0)); continue
        raw = d[e['data']:e['data'] + e['pack']]
        if e['meth'] == 0x30: data = raw; status = 'stored'
        elif e['solid']: res.append((e['name'], 'SOLID-NOT-SUPPORTED', 0)); continue
        else:
            with tempfile.TemporaryDirectory() as t:
                pk, op = os.path.join(t, 'p.bin'), os.path.join(t, 'o.bin'); open(pk, 'wb').write(raw)
                r = subprocess.run([exe, pk, str(e['unp']), op], capture_output=True, text=True)
                data = open(op, 'rb').read() if os.path.exists(op) else b''; status = r.stdout.strip().split('status=')[-1] if r.stdout else 'NO-OUTPUT'
        c = zlib.crc32(data) & 0xffffffff
        ok = (c == e['crc'] and len(data) == e['unp'])
        dst = os.path.join(outdir, rel); os.makedirs(os.path.dirname(dst) or outdir, exist_ok=True)
        if ok: open(dst, 'wb').write(data)
        res.append((e['name'], 'OK' if ok else 'FAILED(%s crc %08x!=%08x, %d/%d bytes)' % (status, c, e['crc'], len(data), e['unp']), len(data)))
    return res
if __name__ == '__main__':
    os.makedirs(sys.argv[2], exist_ok=True); res = extract(sys.argv[1], sys.argv[2])
    ok = sum(1 for r in res if r[1] == 'OK'); print('files', len(res), 'crc-verified ok', ok)
    for r in res:
        if r[1] != 'OK': print('  !', r)
    sys.exit(0 if ok == len(res) else 1)
