#!/usr/bin/env python3
"""唯讀盤點 v2：逐 session 掃全部記錄行，收集所有 transcript_path，分類互斥。輸出 JSONL 候選清單。"""
import json, os, sys, time, collections, hashlib
from pathlib import Path
ROOT=Path.home()/".cache/cc-memory/spool"
OUT=Path(sys.argv[1]) if len(sys.argv)>1 else None
now=time.time()
rows=[]
for d in sorted(ROOT.iterdir()):
    if not d.is_dir() or d.name=='.dead': continue
    for p in sorted(d.iterdir()):
        if not (p.is_file() and p.name.endswith('.jsonl')): continue
        size=p.stat().st_size
        st=p.with_name(p.name[:-6]+'.capture-state.json'); cur=0; cps={}
        if st.exists():
            try:
                j=json.loads(st.read_text()); cur=int(j['spool']['cursor']); cps={k:v.get('checkpoint',0) for k,v in j.get('transcripts',{}).items()}
            except Exception: pass
        pend=max(size-cur,0)
        if pend<=0: continue
        paths=set(); first_off={}
        try:
            with open(p,'rb') as fh:
                for line in fh:
                    try: r=json.loads(line)
                    except Exception: continue
                    tp=r.get('transcript_path')
                    if tp:
                        paths.add(tp)
                        if tp not in first_off and isinstance(r.get('transcript_offset'),int): first_off[tp]=r['transcript_offset']
        except Exception: pass
        present=[t for t in paths if os.path.exists(t)]
        missing=[t for t in paths if not os.path.exists(t)]
        if not paths: cls='no_path'
        elif not present: cls='all_missing'
        elif not missing: cls='all_present'
        else: cls='mixed'
        tpend=0
        for t in present:
            h=hashlib.sha256(t.encode()).hexdigest()
            tpend+=max(os.path.getsize(t)-cps.get(h,first_off.get(t,0)),0)
        age_days=(now-p.stat().st_mtime)/86400
        rows.append(dict(project=d.name,session=p.stem,jsonl=str(p),state=str(st) if st.exists() else None,size=size,cursor=cur,pending=pend,cls=cls,n_paths=len(paths),age_days=round(age_days,1),transcript_pending=tpend))
agg=collections.defaultdict(lambda:[0,0,0])
for r in rows: a=agg[r['cls']]; a[0]+=1; a[1]+=r['pending']; a[2]+=r['transcript_pending']
print(f"pending sessions={len(rows)}")
for k,v in sorted(agg.items()): print(f"  {k:12s} sessions={v[0]:6d} spool_MB={v[1]/1e6:5.1f} transcript_pending_MB={v[2]/1e6:7.0f} windows~{v[2]//(256*1024)+v[0]}")
q=[r for r in rows if r['cls']=='all_missing' and r['age_days']>=7]
print(f"quarantine candidates (all_missing & age>=7d): {len(q)}  (all_missing age<7d: {sum(1 for r in rows if r['cls']=='all_missing' and r['age_days']<7)})")
print("all_missing by project top 8:", collections.Counter(r['project'] for r in q).most_common(8))
print("all_present windows by project top 12:")
w=collections.defaultdict(lambda:[0,0])
for r in rows:
    if r['cls']=='all_present': w[r['project']][0]+=1; w[r['project']][1]+=r['transcript_pending']//(256*1024)+1
for k,v in sorted(w.items(), key=lambda kv:-kv[1][1])[:12]: print(f"  {k:40s} sessions={v[0]:5d} windows={v[1]:6d}")
if OUT:
    with open(OUT,'w') as f:
        for r in rows: f.write(json.dumps(r,ensure_ascii=False)+'\n')
    print("wrote",OUT)
