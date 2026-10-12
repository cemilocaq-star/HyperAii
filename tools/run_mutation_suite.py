#!/usr/bin/env python3
"""Resumable orchestration of the full mutation suite (tests/mutation22.py).

* Runs the mutants in chunks (--chunk, default 20) through the existing runner's own `--range=lo:hi` interface, one chunk at a time.
* Every finished chunk is saved at once to <results>/chunk_<lo>_<hi>.json; a re-run SKIPS chunks that are complete, so a restart/timeout never loses or repeats work.
* Statuses are kept apart: KILLED, SURVIVED, TIMEOUT, ERROR (stale pattern / harness crash), NOT RUN (mutant absent from a chunk's output).
* `--merge` (always done at the end) writes <results>/merged.json and prints one combined report over ALL mutants.
Usage: python3 tools/run_mutation_suite.py [--chunk=20] [--results=DIR] [--only=lo:hi] [--merge-only]
"""
import ast, json, os, re, subprocess, sys, time
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
def arg(name, default=None):
    for a in sys.argv[1:]:
        if a.startswith('--' + name + '='): return a.split('=', 1)[1]
    return default
def mutant_names():
    t = ast.parse(open(os.path.join(ROOT, 'tests', 'mutation22.py'), encoding='utf8').read())
    for n in t.body:
        if isinstance(n, ast.Assign) and getattr(n.targets[0], 'id', '') == 'MUTANTS': return [e.elts[0].value for e in n.value.elts]
    raise SystemExit('MUTANTS not found in tests/mutation22.py')
LINE = re.compile(r'^  (KILLED|SURVIVED|TIMEOUT|ERROR)\s+(.*?)\s{2,}(.*)$')
def parse(out): 
    res = {}
    for l in out.splitlines():
        m = LINE.match(l)
        if m: res[m.group(2).strip()] = dict(status=m.group(1), detail=m.group(3).strip()[:200])
    return res
def chunk_file(d, lo, hi): return os.path.join(d, 'chunk_%d_%d.json' % (lo, hi))
def run_chunk(d, names, lo, hi):
    t0 = time.time(); p = subprocess.run([sys.executable, '-u', os.path.join(ROOT, 'tests', 'mutation22.py'), '--jobs=1', '--range=%d:%d' % (lo, hi)], cwd=ROOT, capture_output=True, text=True, timeout=7200)
    out = p.stdout + p.stderr; got = parse(out); base = re.search(r'BASELINE \(unmutated copy\): (\d+/\d+ PASS)', out)
    rows = []
    for i in range(lo, min(hi, len(names))):
        r = got.get(names[i]); rows.append(dict(index=i, name=names[i], status=(r['status'] if r else 'NOT RUN'), detail=(r['detail'] if r else 'absent from the runner output (baseline failed or runner died)')))
    rec = dict(lo=lo, hi=min(hi, len(names)), baseline=(base.group(1) if base else None), seconds=round(time.time() - t0), exit=p.returncode, results=rows)
    json.dump(rec, open(chunk_file(d, lo, hi), 'w', encoding='utf8'), indent=1); return rec
def complete(path): 
    try: rec = json.load(open(path, encoding='utf8'))
    except Exception: return False
    return bool(rec.get('baseline')) and all(r['status'] != 'NOT RUN' for r in rec['results'])
def merge(d, names):
    by = {}; ranges = []
    files = sorted((f for f in os.listdir(d) if f.startswith('chunk_') and f.endswith('.json')), key=lambda f: os.path.getmtime(os.path.join(d, f)))
    for f in files:  # oldest first: a later real result replaces an earlier ERROR/TIMEOUT (re-run of a repaired mutant); NOT RUN never replaces a result
        rec = json.load(open(os.path.join(d, f), encoding='utf8')); ranges.append((rec['lo'], rec['hi'], rec['baseline'], rec['seconds']))
        for r in rec['results']:
            if r['index'] not in by or r['status'] != 'NOT RUN': by[r['index']] = r
    rows = [by.get(i, dict(index=i, name=names[i], status='NOT RUN', detail='no chunk covers this mutant')) for i in range(len(names))]
    cnt = {k: sum(1 for r in rows if r['status'] == k) for k in ('KILLED', 'SURVIVED', 'TIMEOUT', 'ERROR', 'NOT RUN')}
    rep = dict(total=len(names), **{k.lower().replace(' ', '_'): v for k, v in cnt.items()}, ranges_completed=sorted(ranges), mutants=rows, complete=(cnt['NOT RUN'] == 0 and cnt['ERROR'] == 0 and cnt['TIMEOUT'] == 0))
    json.dump(rep, open(os.path.join(d, 'merged.json'), 'w', encoding='utf8'), indent=1)
    print('MUTATION TOTAL=%d KILLED=%d SURVIVED=%d TIMEOUT=%d ERROR=%d NOT_RUN=%d' % (rep['total'], cnt['KILLED'], cnt['SURVIVED'], cnt['TIMEOUT'], cnt['ERROR'], cnt['NOT RUN']))
    print('ranges done:', ', '.join('%d:%d(%s)' % (a, b, bl) for a, b, bl, _ in sorted(ranges)))
    for r in rows:
        if r['status'] not in ('KILLED',): print('  %-8s #%d %s | %s' % (r['status'], r['index'], r['name'], r['detail'][:110]))
    return rep
def main():
    d = os.path.abspath(arg('results', os.path.join(os.path.dirname(ROOT), 'mutation_results'))); os.makedirs(d, exist_ok=True); names = mutant_names(); n = len(names); k = int(arg('chunk', '20'))
    if '--merge-only' not in sys.argv:
        only = arg('only'); lo0, hi0 = (int(x) for x in only.split(':')) if only else (0, n)
        for lo in range(lo0, hi0, k):
            hi = min(lo + k, hi0, n)
            if complete(chunk_file(d, lo, hi)): print('skip complete chunk %d:%d' % (lo, hi), flush=True); continue
            print('running chunk %d:%d ...' % (lo, hi), flush=True); rec = run_chunk(d, names, lo, hi)
            print('  chunk %d:%d baseline=%s %ds: %s' % (lo, hi, rec['baseline'], rec['seconds'], {s: sum(1 for r in rec['results'] if r['status'] == s) for s in set(r['status'] for r in rec['results'])}), flush=True)
    rep = merge(d, names); return 0 if rep['complete'] and rep['survived'] == 0 else 1
if __name__ == '__main__': sys.exit(main())
