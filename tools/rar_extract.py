#!/usr/bin/env python3
"""Developer utility (NOT runtime): extract RAR/any archive through the system libarchive.so.13 via ctypes (no python binding needed).
Usage: rar_extract.py ARCHIVE OUTDIR"""
import ctypes, ctypes.util, os, sys, struct, zlib
L = ctypes.CDLL('libarchive.so.13')
L.archive_read_new.restype = ctypes.c_void_p
for f in ('archive_read_support_format_all', 'archive_read_support_filter_all', 'archive_read_support_format_rar', 'archive_read_support_format_rar5'):
    getattr(L, f).argtypes = [ctypes.c_void_p]
L.archive_read_open_filename.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_size_t]
L.archive_read_next_header.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p)]
L.archive_entry_pathname.argtypes = [ctypes.c_void_p]; L.archive_entry_pathname.restype = ctypes.c_char_p
L.archive_entry_size.argtypes = [ctypes.c_void_p]; L.archive_entry_size.restype = ctypes.c_int64
L.archive_entry_filetype.argtypes = [ctypes.c_void_p]; L.archive_entry_filetype.restype = ctypes.c_uint
L.archive_read_data.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_size_t]; L.archive_read_data.restype = ctypes.c_ssize_t
L.archive_error_string.argtypes = [ctypes.c_void_p]; L.archive_error_string.restype = ctypes.c_char_p
L.archive_read_free.argtypes = [ctypes.c_void_p]

def rar4_crcs(path):
    """name -> (unpacked size, CRC32) straight from the RAR4 file headers. libarchive does NOT report a CRC mismatch for stored files,
    so the extracted bytes are checked against these values here. Returns {} for non-RAR4 input (those files stay 'UNVERIFIED')."""
    d = open(path, 'rb').read(); out = {}
    if d[:7] != b'Rar!\x1a\x07\x00': return out
    pos = 7
    while pos + 7 <= len(d):
        crc, typ, flags, size = struct.unpack_from('<HBHH', d, pos)
        if size < 7: break
        add = 0
        if typ == 0x74:
            pack, unp, host, fcrc, ftime, ver, meth, nlen, attr = struct.unpack_from('<IIBIIBBHI', d, pos + 7); o = pos + 32
            if flags & 0x100:
                hp, hu = struct.unpack_from('<II', d, o); o += 8; pack |= hp << 32; unp |= hu << 32
            nm = d[o:o + nlen].split(b'\0')[0].decode('utf8', 'replace').replace('\\', '/').lstrip('/')
            if (flags & 0xE0) != 0xE0: out[nm] = (unp, fcrc)
            add = pack
        elif flags & 0x8000: add = struct.unpack_from('<I', d, pos + 7)[0]
        pos += size + add
        if typ == 0x7B: break
    return out
def extract(path, out):
    a = L.archive_read_new(); L.archive_read_support_format_all(a); L.archive_read_support_filter_all(a)
    if L.archive_read_open_filename(a, path.encode(), 1 << 16) != 0: return [], 'OPEN FAILED: ' + (L.archive_error_string(a) or b'').decode('latin1')
    expect = rar4_crcs(path); res = []; err = None; e = ctypes.c_void_p(); buf = ctypes.create_string_buffer(1 << 20)
    while True:
        r = L.archive_read_next_header(a, ctypes.byref(e))
        if r == 1: break
        if r < 0 and r != -20: err = 'HEADER ERROR %d: %s' % (r, (L.archive_error_string(a) or b'').decode('latin1')); break
        name = (L.archive_entry_pathname(e) or b'').decode('utf8', 'replace'); size = L.archive_entry_size(e)
        rel = name.replace('\\', '/').lstrip('/'); 
        if '..' in rel.split('/'): res.append((name, 'SKIPPED-UNSAFE-PATH', 0)); continue
        dst = os.path.join(out, rel)
        if L.archive_entry_filetype(e) == 0o040000: os.makedirs(dst, exist_ok=True); continue
        os.makedirs(os.path.dirname(dst) or out, exist_ok=True); n = 0
        with open(dst, 'wb') as f:
            while True:
                k = L.archive_read_data(a, buf, len(buf))
                if k == 0: break
                if k < 0: err = 'DATA ERROR in %s: %s' % (name, (L.archive_error_string(a) or b'').decode('latin1')); break
                f.write(buf.raw[:k]); n += k
        if err or n != size: status = 'SHORT(%d/%d)' % (n, size)
        elif rel in expect or len([k for k, v in expect.items() if v[0] == n]) == 1:  # name differs only by legacy codepage -> unique size match
            key = rel if rel in expect else [k for k, v in expect.items() if v[0] == n][0]
            c = zlib.crc32(open(dst, 'rb').read()) & 0xffffffff
            status = 'OK' if (c == expect[key][1] and n == expect[key][0]) else 'CRC-MISMATCH(%08x!=%08x)' % (c, expect[key][1])
        else: status = 'UNVERIFIED'  # no stored CRC available (not RAR4): size matched only
        res.append((name, status, n))
        if err: break
    L.archive_read_free(a); return res, err
if __name__ == '__main__':
    os.makedirs(sys.argv[2], exist_ok=True); res, err = extract(sys.argv[1], sys.argv[2])
    ok = sum(1 for r in res if r[1] == 'OK'); print('files', len(res), 'ok', ok, 'error:', err)
    for r in res:
        if r[1] != 'OK': print('  !', r)
