import { useEffect, useRef, useState } from 'react';
import { viewportCoordsToSceneCoords } from '@excalidraw/excalidraw';
import { insertCard } from './scene.js';
import { useT } from './i18n.js';

// An explicit repeat-stamp mode. A drag/pan gesture never deposits a picture;
// Escape and the visible Done button return immediately to normal drawing.
export default function StampPlacement({ api, stamp, onClose }) {
    const t = useT(), area = useRef(null), down = useRef(null);
    const [point, setPoint] = useState(null), [count, setCount] = useState(0);
    useEffect(() => { area.current?.focus(); }, []);
    const place = (clientX, clientY) => {
        const at = viewportCoordsToSceneCoords({clientX, clientY}, api.getAppState());
        insertCard(api, {...stamp, at, undoable:true}); setCount(n => n + 1);
    };
    return <>
        <div ref={area} className="wbacc-stamp-area" tabIndex={0} role="button" aria-label={t('Допри за печат; Enter поставува во средината; Escape завршува')}
            onKeyDown={e => {
                if (e.key === 'Escape') { e.preventDefault(); onClose(); }
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault(); const r = area.current.getBoundingClientRect(); place(r.left+r.width/2,r.top+r.height/2);
                }
            }}
            onPointerDown={e => { if (e.isPrimary && e.button === 0) down.current={id:e.pointerId,x:e.clientX,y:e.clientY}; }}
            onPointerMove={e => { if (e.pointerType === 'mouse') setPoint({x:e.clientX,y:e.clientY}); }}
            onPointerLeave={() => {setPoint(null);down.current=null;}}
            onPointerCancel={() => {down.current=null;}}
            onPointerUp={e => {
                const start=down.current; down.current=null;
                if (start?.id===e.pointerId && Math.hypot(e.clientX-start.x,e.clientY-start.y)<8) place(e.clientX,e.clientY);
            }} />
        {point && <img className="wbacc-stamp-ghost" alt="" src={stamp.dataURL} style={{left:point.x,top:point.y,width:stamp.size*api.getAppState().zoom.value}} />}
        <div className="wbacc-stamp-instructions">
            <span>{t('Допри на платното за печат. Повтори каде што сакаш.')} <span role="status">{count}</span></span>
            <button type="button" onClick={onClose}>{t('Готово')}</button>
        </div>
    </>;
}
