from PIL import Image
import numpy as np
im = Image.open('floorplan.png').convert('RGB')
a = np.asarray(im).astype(int)
R,G,B=a[:,:,0],a[:,:,1],a[:,:,2]
tan=(R>150)&(R<240)&(G>120)&(G<215)&(B>85)&(B<190)&(R-B>22)
P=11.03
def isT(X,Y):
    x,y=int(round(104+X*P)),int(round(948-Y*P))
    return 0<=y<a.shape[0] and 0<=x<a.shape[1] and bool(tan[y,x])

# Hall polygon edges that face wood-floor rooms. (Bath/WC have tile floors -> handled separately.)
# Each: axis, fixed coord, scan range, label, neighbor side offset
def scan_v(xfix, y0, y1, label):  # vertical wall at X=xfix, opening spans Y
    op=[Y for Y in np.arange(y0,y1,0.12) if isT(xfix-0.8,Y) and isT(xfix+0.8,Y) and isT(xfix,Y)]
    return runs(op,label,'v',xfix,True)
def scan_h(yfix, x0, x1, label):  # horizontal wall at Y=yfix, opening spans X
    op=[X for X in np.arange(x0,x1,0.12) if isT(X,yfix-0.8) and isT(X,yfix+0.8) and isT(X,yfix)]
    return runs(op,label,'h',yfix,False)
def runs(op,label,orient,fix,isV):
    if not op: print(f'  {label}: (no opening found)'); return
    op=sorted(op); seg=[[op[0],op[0]]]
    for v in op[1:]:
        if v-seg[-1][1]<0.5: seg[-1][1]=v
        else: seg.append([v,v])
    for s,e in seg:
        if e-s>=1.6:
            c=round((s+e)/2,1); w=round(min(e-s,4.0),1)
            if isV: print(f'  {label}: orient v x={fix} y={c} w={w}')
            else:   print(f'  {label}: orient h x={c} y={fix} w={w}')

print('Hall entryway detection (wood-floor neighbors):')
scan_h(21.5, 3.7, 7.8, 'Hall<->Foyer (bottom)')
scan_v(7.8, 21.5, 30.1, 'Hall<->Dining/E (right-lower)')
scan_v(11.3, 35.3, 44.5,'Hall<->Kitchen (right-upper)')
scan_h(44.5, 6.0, 11.3, 'Hall<->Bedroom (top)')
scan_v(3.7, 21.5, 31.0, 'Hall<->WC/Foyer (left-lower)')
