from PIL import Image
import numpy as np, json
im = Image.open('floorplan.png').convert('RGB')
a = np.asarray(im).astype(int)
R,G,B=a[:,:,0],a[:,:,1],a[:,:,2]
tan=(R>150)&(R<240)&(G>120)&(G<215)&(B>85)&(B<190)&(R-B>22)&(R-B<95)
PXPF=11.03
# world<->pixel for MAIN level. X=(px-104)/P ; Y=(948-py)/P
def px(X): return int(round(104 + X*PXPF))
def py(Y): return int(round(948 - Y*PXPF))
def is_tan(X,Y):
    x,y=px(X),py(Y)
    if 0<=y<a.shape[0] and 0<=x<a.shape[1]: return bool(tan[y,x])
    return False

import importlib.util
spec=importlib.util.spec_from_file_location('r','src/rooms.js')  # can't import JS; hardcode subset
# Parse rooms.js ROOMS via regex
import re
txt=open('src/rooms.js').read()
rooms=[]
for m in re.finditer(r'name:\s*"([^"]+)".*?x:\s*([\d.]+),\s*y:\s*([\d.]+),\s*w:\s*([\d.]+),\s*d:\s*([\d.]+),\s*level:\s*(\d)', txt):
    n,x,y,w,d,lv=m.group(1),*map(float,m.groups()[1:5]),int(m.group(6))
    rooms.append(dict(name=n,x=x,y=y,w=w,d=d,level=lv))
main=[r for r in rooms if r['level']==1]
print('main rooms:',len(main))

def overlap(a0,a1,b0,b1): return max(0,min(a1,b1)-max(a0,b0))
doors=[]
for i,A in enumerate(main):
  for B in main[i+1:]:
    # vertical shared wall: A right near B left (or vice versa)
    for (L,Rr) in [(A,B),(B,A)]:
      gap = Rr['x'] - (L['x']+L['w'])
      if -0.6 <= gap <= 1.8:  # L is left of R
        yo0,yo1=max(L['y'],Rr['y']), min(L['y']+L['d'], Rr['y']+Rr['d'])
        if yo1-yo0 >= 2.0:
          cx = (L['x']+L['w']+Rr['x'])/2
          # scan Y over overlap, open where tan across centerline
          openys=[Y for Y in np.arange(yo0+0.3,yo1-0.3,0.15) if is_tan(cx-0.7,Y) and is_tan(cx+0.7,Y) and is_tan(cx,Y)]
          # contiguous runs
          if openys:
            openys=sorted(openys); runs=[[openys[0],openys[0]]]
            for v in openys[1:]:
              if v-runs[-1][1]<0.4: runs[-1][1]=v
              else: runs.append([v,v])
            for s,e in runs:
              if 1.8<=e-s<=4.5: doors.append(dict(o='v',x=round(cx,1),y=round((s+e)/2,1),w=round(e-s,1),a=L['name'],b=Rr['name']))
    # horizontal shared wall: A top near B bottom
    for (Lo,Up) in [(A,B),(B,A)]:
      gap = Up['y'] - (Lo['y']+Lo['d'])
      if -0.6 <= gap <= 1.8:
        xo0,xo1=max(Lo['x'],Up['x']), min(Lo['x']+Lo['w'], Up['x']+Up['w'])
        if xo1-xo0 >= 2.0:
          cy=(Lo['y']+Lo['d']+Up['y'])/2
          openxs=[X for X in np.arange(xo0+0.3,xo1-0.3,0.15) if is_tan(X,cy-0.7) and is_tan(X,cy+0.7) and is_tan(X,cy)]
          if openxs:
            openxs=sorted(openxs); runs=[[openxs[0],openxs[0]]]
            for v in openxs[1:]:
              if v-runs[-1][1]<0.4: runs[-1][1]=v
              else: runs.append([v,v])
            for s,e in runs:
              if 1.8<=e-s<=4.5: doors.append(dict(o='h',x=round((s+e)/2,1),y=round(cy,1),w=round(e-s,1),a=Lo['name'],b=Up['name']))
print(f'detected {len(doors)} doorways:')
for d in doors: print('  ',d)
json.dump(doors,open('/tmp/doors.json','w'))
