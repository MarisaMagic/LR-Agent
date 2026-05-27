import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react';
import type { BboxAnnotation } from '../../types/annotationDocument';
import { useAnnotation } from '../../context/AnnotationContext';
import { useAnnotationWorkspace } from '../../context/AnnotationWorkspaceContext';
import { getLabelTextColor } from '../../utils/labelColor';
import {
  BBOX_THEME,
  estimateLabelBarWidthNorm,
  pxToNormX,
  pxToNormY,
} from './annotationBboxTheme';
import { createResizeObserver } from '../../utils/resizeObserver';
import './ImageBboxAnnotationLayer.css';

function getDisplayedImageBox(img: HTMLImageElement): {
  ox: number;
  oy: number;
  dw: number;
  dh: number;
} {
  const nw = img.naturalWidth;
  const nh = img.naturalHeight;
  if (!nw || !nh) return { ox: 0, oy: 0, dw: 0, dh: 0 };
  const cw = img.clientWidth;
  const ch = img.clientHeight;
  const scale = Math.min(cw / nw, ch / nh);
  const dw = nw * scale;
  const dh = nh * scale;
  const ox = (cw - dw) / 2;
  const oy = (ch - dh) / 2;
  return { ox, oy, dw, dh };
}

function clientPointToNorm(
  img: HTMLImageElement,
  clientX: number,
  clientY: number,
): { nx: number; ny: number } | null {
  const rect = img.getBoundingClientRect();
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  const { ox, oy, dw, dh } = getDisplayedImageBox(img);
  if (dw <= 0 || dh <= 0) return null;
  const sx = x - ox;
  const sy = y - oy;
  if (sx < 0 || sy < 0 || sx > dw || sy > dh) return null;
  return { nx: sx / dw, ny: sy / dh };
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

function clampBbox(
  x: number,
  y: number,
  w: number,
  h: number,
): { x: number; y: number; width: number; height: number } {
  const width = clamp01(w);
  const height = clamp01(h);
  const cx = clamp01(x);
  const cy = clamp01(y);
  const x2 = Math.min(1, cx + width);
  const y2 = Math.min(1, cy + height);
  return {
    x: cx,
    y: cy,
    width: Math.max(0.001, x2 - cx),
    height: Math.max(0.001, y2 - cy),
  };
}

const MIN_CREATE = 0.008;

type DragState =
  | {
      kind: 'create';
      startX: number;
      startY: number;
      pointerId: number;
    }
  | {
      kind: 'move';
      id: string;
      pointerId: number;
      origin: BboxAnnotation;
      grabNx: number;
      grabNy: number;
    }
  | {
      kind: 'resize-br';
      id: string;
      pointerId: number;
      origin: BboxAnnotation;
    };

interface ImageBboxAnnotationLayerProps {
  imgRef: RefObject<HTMLImageElement | null>;
}

function BboxAnnotationGraphic({
  ann,
  stroke,
  labelName,
  isSelected,
  displayWidthPx,
  displayHeightPx,
}: {
  ann: BboxAnnotation;
  stroke: string;
  labelName: string;
  isSelected: boolean;
  displayWidthPx: number;
  displayHeightPx: number;
}) {
  const fillAlpha = BBOX_THEME.fillAlphaHex;
  const labelBarH = pxToNormY(BBOX_THEME.labelBarHeightPx, displayHeightPx);
  const labelW = estimateLabelBarWidthNorm(
    labelName,
    displayWidthPx,
    ann.width,
  );
  const labelX = ann.x;
  const labelY = Math.max(0, ann.y - labelBarH);
  const handleW = pxToNormX(BBOX_THEME.handleSizePx, displayWidthPx);
  const handleH = pxToNormY(BBOX_THEME.handleSizePx, displayHeightPx);
  const textColor = getLabelTextColor(stroke);

  const handles: { x: number; y: number; className: string }[] = isSelected
    ? [
        { x: ann.x, y: ann.y, className: 'image-bbox-handle' },
        {
          x: ann.x + ann.width - handleW,
          y: ann.y,
          className: 'image-bbox-handle',
        },
        {
          x: ann.x,
          y: ann.y + ann.height - handleH,
          className: 'image-bbox-handle',
        },
        {
          x: ann.x + ann.width - handleW,
          y: ann.y + ann.height - handleH,
          className: 'image-bbox-handle image-bbox-handle--br',
        },
      ]
    : [];

  return (
    <g className={isSelected ? 'image-bbox-group--selected' : undefined}>
      <rect
        x={ann.x}
        y={ann.y}
        width={ann.width}
        height={ann.height}
        className="image-bbox-rect-halo"
      />
      <rect
        x={ann.x}
        y={ann.y}
        width={ann.width}
        height={ann.height}
        className={`image-bbox-rect${isSelected ? ' image-bbox-rect--selected' : ''}`}
        fill={`${stroke}${fillAlpha}`}
        stroke={stroke}
      />
      {isSelected && (
        <rect
          x={ann.x}
          y={ann.y}
          width={ann.width}
          height={ann.height}
          className="image-bbox-rect-ring"
        />
      )}
      <foreignObject
        className="image-bbox-label-fo"
        x={labelX}
        y={labelY}
        width={labelW}
        height={labelBarH}
      >
        <div
          xmlns="http://www.w3.org/1999/xhtml"
          className="image-bbox-label-tag"
          style={{
            backgroundColor: stroke,
            color: textColor,
          }}
          title={labelName}
        >
          {labelName}
        </div>
      </foreignObject>
      {handles.map((h) => (
        <rect
          key={`${h.x}-${h.y}-${h.className}`}
          className={h.className}
          x={h.x}
          y={h.y}
          width={handleW}
          height={handleH}
          fill="#ffffff"
          stroke={stroke}
        />
      ))}
    </g>
  );
}

export default function ImageBboxAnnotationLayer({
  imgRef,
}: ImageBboxAnnotationLayerProps) {
  const { activeProject } = useAnnotation();
  const {
    bboxAnnotations,
    selectedAnnotationId,
    selectAnnotation,
    addBboxAnnotation,
    updateBboxGeometry,
    activeLabelId,
    reportImageNaturalSize,
  } = useAnnotationWorkspace();

  const [, rerenderOverlay] = useState(0);
  const [draft, setDraft] = useState<{
    x: number;
    y: number;
    width: number;
    height: number;
  } | null>(null);
  const dragRef = useRef<DragState | null>(null);

  const labelById = useMemo(() => {
    const map = new Map<string, { color: string; name: string }>();
    if (!activeProject) return map;
    activeProject.labels.forEach((l) => {
      map.set(l.id, { color: l.color, name: l.name });
    });
    return map;
  }, [activeProject]);

  const bumpLayout = useCallback(() => {
    rerenderOverlay((x) => x + 1);
  }, []);

  useEffect(() => {
    const img = imgRef.current;
    if (!img) return undefined;

    const onLoad = () => {
      reportImageNaturalSize(img.naturalWidth, img.naturalHeight);
      bumpLayout();
    };

    if (img.complete && img.naturalWidth > 0) {
      onLoad();
    }
    img.addEventListener('load', onLoad);

    const ro = createResizeObserver(() => bumpLayout());
    if (ro) ro.observe(img);

    return () => {
      img.removeEventListener('load', onLoad);
      ro?.disconnect();
    };
  }, [imgRef, reportImageNaturalSize, bumpLayout]);

  const hitResizeHandle = useCallback(
    (
      clientX: number,
      clientY: number,
      ann: BboxAnnotation,
      img: HTMLImageElement,
    ): boolean => {
      const rect = img.getBoundingClientRect();
      const { ox, oy, dw, dh } = getDisplayedImageBox(img);
      if (dw <= 0 || dh <= 0) return false;
      const brxNorm = ann.x + ann.width;
      const bryNorm = ann.y + ann.height;
      const bx = rect.left + ox + brxNorm * dw;
      const by = rect.top + oy + bryNorm * dh;
      return Math.hypot(bx - clientX, by - clientY) <= 10;
    },
    [],
  );

  const hitInside = useCallback(
    (nx: number, ny: number, ann: BboxAnnotation) => {
      return (
        nx >= ann.x &&
        ny >= ann.y &&
        nx <= ann.x + ann.width &&
        ny <= ann.y + ann.height
      );
    },
    [],
  );

  const onPointerDown = useCallback(
    (ev: ReactPointerEvent) => {
      const img = imgRef.current;
      if (!img) return;

      const norm = clientPointToNorm(img, ev.clientX, ev.clientY);
      if (!norm) {
        selectAnnotation(null);
        return;
      }

      const { nx, ny } = norm;

      const selected = bboxAnnotations.find(
        (b) => b.id === selectedAnnotationId,
      );

      if (selected && hitResizeHandle(ev.clientX, ev.clientY, selected, img)) {
        dragRef.current = {
          kind: 'resize-br',
          id: selected.id,
          pointerId: ev.pointerId,
          origin: { ...selected },
        };
        (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
        ev.preventDefault();
        return;
      }

      const hitAnn = [...bboxAnnotations].reverse().find((ann) => {
        return hitInside(nx, ny, ann);
      });
      if (hitAnn) {
        selectAnnotation(hitAnn.id);
        dragRef.current = {
          kind: 'move',
          id: hitAnn.id,
          pointerId: ev.pointerId,
          origin: { ...hitAnn },
          grabNx: nx - hitAnn.x,
          grabNy: ny - hitAnn.y,
        };
        (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
        ev.preventDefault();
        return;
      }

      selectAnnotation(null);

      if (!activeLabelId) return;

      dragRef.current = {
        kind: 'create',
        startX: nx,
        startY: ny,
        pointerId: ev.pointerId,
      };
      setDraft({ x: nx, y: ny, width: 0, height: 0 });
      (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
      ev.preventDefault();
    },
    [
      imgRef,
      bboxAnnotations,
      selectedAnnotationId,
      selectAnnotation,
      hitResizeHandle,
      hitInside,
      activeLabelId,
    ],
  );

  const onPointerMove = useCallback(
    (ev: ReactPointerEvent) => {
      const img = imgRef.current;
      const drag = dragRef.current;
      if (!img || !drag || ev.pointerId !== drag.pointerId) return;

      const norm = clientPointToNorm(img, ev.clientX, ev.clientY);
      if (!norm) return;

      if (drag.kind === 'create') {
        const x1 = Math.min(drag.startX, norm.nx);
        const y1 = Math.min(drag.startY, norm.ny);
        const x2 = Math.max(drag.startX, norm.nx);
        const y2 = Math.max(drag.startY, norm.ny);
        setDraft({
          x: x1,
          y: y1,
          width: x2 - x1,
          height: y2 - y1,
        });
        return;
      }

      if (drag.kind === 'move') {
        const { width, height } = drag.origin;
        let nx = norm.nx - drag.grabNx;
        let ny = norm.ny - drag.grabNy;
        nx = Math.min(Math.max(0, nx), 1 - width);
        ny = Math.min(Math.max(0, ny), 1 - height);
        updateBboxGeometry(drag.id, {
          x: nx,
          y: ny,
          width,
          height,
        });
        return;
      }

      if (drag.kind === 'resize-br') {
        const { x, y } = drag.origin;
        const w = Math.max(MIN_CREATE, norm.nx - x);
        const h = Math.max(MIN_CREATE, norm.ny - y);
        const fixed = clampBbox(x, y, w, h);
        updateBboxGeometry(drag.id, fixed);
      }
    },
    [imgRef, updateBboxGeometry],
  );

  const endDrag = useCallback(
    (ev: ReactPointerEvent) => {
      const drag = dragRef.current;
      if (!drag || ev.pointerId !== drag.pointerId) return;
      try {
        (ev.currentTarget as HTMLElement).releasePointerCapture(ev.pointerId);
      } catch {
        /* ignore */
      }
      dragRef.current = null;

      if (drag.kind === 'create') {
        setDraft(null);
        const img = imgRef.current;
        const norm = img
          ? clientPointToNorm(img, ev.clientX, ev.clientY)
          : null;
        const endNx = norm?.nx ?? drag.startX;
        const endNy = norm?.ny ?? drag.startY;
        const x1 = Math.min(drag.startX, endNx);
        const y1 = Math.min(drag.startY, endNy);
        const x2 = Math.max(drag.startX, endNx);
        const y2 = Math.max(drag.startY, endNy);
        const w = x2 - x1;
        const h = y2 - y1;
        if (w >= MIN_CREATE && h >= MIN_CREATE) {
          addBboxAnnotation(clampBbox(x1, y1, w, h));
        }
      }
    },
    [imgRef, addBboxAnnotation],
  );

  const img = imgRef.current;
  const disp = img ? getDisplayedImageBox(img) : { ox: 0, oy: 0, dw: 0, dh: 0 };

  if (!img || disp.dw <= 0 || disp.dh <= 0) {
    return null;
  }

  return (
    <div
      className="image-bbox-overlay"
      style={{
        left: disp.ox,
        top: disp.oy,
        width: disp.dw,
        height: disp.dh,
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      <svg
        className="image-bbox-svg"
        viewBox="0 0 1 1"
        preserveAspectRatio="none"
        aria-hidden
      >
        {bboxAnnotations.map((ann) => {
          const label = labelById.get(ann.labelId);
          const stroke = label?.color ?? BBOX_THEME.defaultStroke;
          const labelName = label?.name ?? '未知';
          const isSel = ann.id === selectedAnnotationId;
          return (
            <BboxAnnotationGraphic
              key={ann.id}
              ann={ann}
              stroke={stroke}
              labelName={labelName}
              isSelected={isSel}
              displayWidthPx={disp.dw}
              displayHeightPx={disp.dh}
            />
          );
        })}
        {draft && draft.width >= 0 && draft.height >= 0 && (
          <rect
            className="image-bbox-draft"
            x={draft.x}
            y={draft.y}
            width={Math.max(draft.width, MIN_CREATE / 4)}
            height={Math.max(draft.height, MIN_CREATE / 4)}
            fill="rgba(255,255,255,0.14)"
            stroke={BBOX_THEME.focusStroke}
          />
        )}
      </svg>
    </div>
  );
}
