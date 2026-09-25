from __future__ import annotations

from typing import Any

from runners.runtime import resolve_device
from runners.yolo import _class_names_from_model, _crop_by_norm_box, _load_image


def _aabb_iou(a: dict[str, float], b: dict[str, float]) -> float:
    ax1, ay1 = a["x"], a["y"]
    ax2, ay2 = ax1 + a["width"], ay1 + a["height"]
    bx1, by1 = b["x"], b["y"]
    bx2, by2 = bx1 + b["width"], by1 + b["height"]
    inter_w = max(0.0, min(ax2, bx2) - max(ax1, bx1))
    inter_h = max(0.0, min(ay2, by2) - max(ay1, by1))
    inter = inter_w * inter_h
    if inter <= 0:
        return 0.0
    area_a = max(0.0, ax2 - ax1) * max(0.0, ay2 - ay1)
    area_b = max(0.0, bx2 - bx1) * max(0.0, by2 - by1)
    union = area_a + area_b - inter
    return inter / union if union > 0 else 0.0


def _dedupe_class_agnostic(
    items: list[dict[str, Any]], iou_threshold: float
) -> list[dict[str, Any]]:
    """跨类去重。

    ultralytics 的 NMS 按类执行：同一物体被多个提示词（如 bottle / product）各命中一次时
    会产出几何几乎重合的重复框。这里按置信度降序做一次类别无关的抑制，只保留高分框。
    """
    if iou_threshold <= 0 or len(items) <= 1:
        return items

    ordered = sorted(
        items, key=lambda it: float(it.get("confidence", 0.0)), reverse=True
    )
    kept: list[dict[str, Any]] = []
    for item in ordered:
        geometry = item["geometry"]
        if any(
            _aabb_iou(geometry, existing["geometry"]) > iou_threshold
            for existing in kept
        ):
            continue
        kept.append(item)
    return kept


def _resolve_prompts(model_cfg: dict[str, Any]) -> list[str]:
    raw = model_cfg.get("promptClasses")
    if raw is None:
        params = model_cfg.get("params") or {}
        raw = params.get("promptClasses")
    if isinstance(raw, str):
        parts = raw.replace("\n", ",").split(",")
    elif isinstance(raw, (list, tuple)):
        parts = [str(item) for item in raw]
    else:
        parts = []
    prompts = [part.strip() for part in parts if part and part.strip()]
    if not prompts:
        raise ValueError("开放词表检测需要至少一个提示词 (promptClasses)")
    return prompts


def get_yolo_world_model(checkpoint: str, device: str, prompts: tuple[str, ...]):
    from ultralytics import YOLOWorld

    cache_key = f"{checkpoint}:{device}:{'|'.join(prompts)}"
    if not hasattr(get_yolo_world_model, "_cache"):
        get_yolo_world_model._cache = {}  # type: ignore[attr-defined]
    cache: dict[str, Any] = get_yolo_world_model._cache  # type: ignore[attr-defined]
    if cache_key not in cache:
        model = YOLOWorld(checkpoint)
        model.set_classes(list(prompts))
        cache[cache_key] = model
    return cache[cache_key]


def run_yolo_world(request: dict[str, Any]) -> dict[str, Any]:
    image_path = str(request["imagePath"])
    model_cfg = request.get("model") or {}
    checkpoint = str(model_cfg.get("checkpointPath") or "")
    if not checkpoint:
        raise ValueError("missing checkpointPath")

    params = model_cfg.get("params") or {}
    conf = float(params.get("confThreshold", 0.25))
    iou = float(params.get("iouThreshold", 0.5))
    device = resolve_device(params.get("device"))
    prompts = _resolve_prompts(model_cfg)

    image, full_w, full_h = _load_image(image_path)
    roi = request.get("box")
    crop, off_x, off_y, _crop_w, _crop_h = _crop_by_norm_box(image, roi)

    model = get_yolo_world_model(checkpoint, device, tuple(prompts))
    results = model.predict(
        source=crop, conf=conf, iou=iou, device=device, verbose=False
    )
    class_names = _class_names_from_model(model) or prompts

    items: list[dict[str, Any]] = []
    for result in results:
        boxes = result.boxes
        if boxes is None:
            continue
        for det in boxes:
            xywh = det.xywh[0].tolist()
            cx, cy, bw, bh = xywh
            x = (off_x + cx - bw / 2) / full_w
            y = (off_y + cy - bh / 2) / full_h
            w_n = bw / full_w
            h_n = bh / full_h
            cls_id = int(det.cls.item()) if det.cls is not None else 0
            conf_v = float(det.conf.item()) if det.conf is not None else 0.0
            cls_name = class_names[cls_id] if cls_id < len(class_names) else str(cls_id)
            items.append(
                {
                    "className": cls_name,
                    "classId": cls_id,
                    "confidence": conf_v,
                    "geometry": {
                        "x": max(0.0, min(1.0, x)),
                        "y": max(0.0, min(1.0, y)),
                        "width": max(0.0, min(1.0, w_n)),
                        "height": max(0.0, min(1.0, h_n)),
                    },
                }
            )

    return {"items": _dedupe_class_agnostic(
        items,
        float(params.get("dedupeIouThreshold", iou)),
    ), "classNames": class_names}