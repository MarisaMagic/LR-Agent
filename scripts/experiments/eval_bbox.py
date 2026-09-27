#!/usr/bin/env python3
"""bbox 评测：对 GT 计算生成标注的质量指标。

输入均为 COCO 格式：
  --gt    experiments/data/gt/instances_project.json（prepare 脚本生成）
  --pred  应用导出的 instances.json（标注导出 → COCO JSON）

输出（JSON，同时打印摘要）：
  - COCO 指标：mAP@0.5:0.95、AP50、AP75（pycocotools）
  - 类别无关检测指标：Precision / Recall / F1@IoU0.5
  - 标签正确率：几何匹配后类别一致的比例（LLM 语义映射的核心指标）
  - unknown_category_predictions：类别名不在 GT 中的预测数

依赖：pip install pycocotools

用法：
  python scripts/experiments/eval_bbox.py \
    --gt experiments/data/gt/instances_project.json \
    --pred experiments/results/C/instances.json \
    --out experiments/results/metrics/C-final.json
"""

import argparse
import json
import os
import sys
from collections import defaultdict


def load_json(path):
    with open(path, 'r', encoding='utf-8') as handle:
        return json.load(handle)


def iou_xywh(a, b):
    ax1, ay1, aw, ah = a
    bx1, by1, bw, bh = b
    ax2, ay2 = ax1 + aw, ay1 + ah
    bx2, by2 = bx1 + bw, by1 + bh
    ix1, iy1 = max(ax1, bx1), max(ay1, by1)
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    iw, ih = max(0.0, ix2 - ix1), max(0.0, iy2 - iy1)
    inter = iw * ih
    if inter <= 0:
        return 0.0
    union = aw * ah + bw * bh - inter
    return inter / union if union > 0 else 0.0


def index_by_image(coco):
    grouped = defaultdict(list)
    for ann in coco.get('annotations', []):
        grouped[ann['image_id']].append(ann)
    return grouped


def evaluate_coco(gt, pred_anns):
    from pycocotools.coco import COCO
    from pycocotools.cocoeval import COCOeval

    coco_gt = COCO()
    coco_gt.dataset = gt
    coco_gt.createIndex()

    if not pred_anns:
        return None, {}

    coco_dt = coco_gt.loadRes(pred_anns)
    evaluator = COCOeval(coco_gt, coco_dt, 'bbox')
    evaluator.evaluate()
    evaluator.accumulate()
    evaluator.summarize()

    stats = evaluator.stats
    metrics = {
        'mAP': stats[0],
        'AP50': stats[1],
        'AP75': stats[2],
        'AP_small': stats[3],
        'AP_medium': stats[4],
        'AP_large': stats[5],
    }

    per_class = {}
    precision = evaluator.eval.get('precision')
    if precision is not None and precision.size > 0:
        cat_ids = evaluator.params.catIds
        for k, cat_id in enumerate(cat_ids):
            values = precision[0, :, k, 0, -1]
            valid = values[values > -1]
            if valid.size > 0:
                per_class[str(cat_id)] = float(valid.mean())
    return metrics, per_class


def evaluate_label_agnostic(gt, pred_anns, gt_name_by_id, threshold):
    gt_by_image = index_by_image(gt)
    pred_by_image = defaultdict(list)
    for ann in pred_anns:
        pred_by_image[ann['image_id']].append(ann)

    tp = fp = fn = 0
    matched = correct_label = 0
    unknown_category = sum(
        1 for ann in pred_anns if ann.get('_unknown_category')
    )

    for image_id, gt_anns in gt_by_image.items():
        dets = sorted(
            pred_by_image.get(image_id, []),
            key=lambda a: float(a.get('score', 0.0)),
            reverse=True,
        )
        used = [False] * len(gt_anns)
        for det in dets:
            best_index = -1
            best_iou = threshold
            for index, gt_ann in enumerate(gt_anns):
                if used[index]:
                    continue
                value = iou_xywh(det['bbox'], gt_ann['bbox'])
                if value >= best_iou:
                    best_iou = value
                    best_index = index
            if best_index >= 0:
                used[best_index] = True
                tp += 1
                matched += 1
                if (
                    not det.get('_unknown_category')
                    and det.get('_label_name') is not None
                    and det.get('_label_name')
                    == gt_name_by_id.get(gt_anns[best_index]['category_id'])
                ):
                    correct_label += 1
            else:
                fp += 1
        fn += sum(1 for value in used if not value)

    precision = tp / (tp + fp) if (tp + fp) > 0 else 0.0
    recall = tp / (tp + fn) if (tp + fn) > 0 else 0.0
    f1 = (
        2 * precision * recall / (precision + recall)
        if (precision + recall) > 0
        else 0.0
    )
    label_accuracy = correct_label / matched if matched > 0 else None
    return {
        'iou_threshold': threshold,
        'tp': tp,
        'fp': fp,
        'fn': fn,
        'precision': precision,
        'recall': recall,
        'f1': f1,
        'matched': matched,
        'correct_label': correct_label,
        'label_accuracy': label_accuracy,
        'unknown_category_predictions': unknown_category,
    }


def main():
    parser = argparse.ArgumentParser(description='bbox 生成质量评测')
    parser.add_argument('--gt', required=True, help='GT COCO JSON')
    parser.add_argument('--pred', required=True, help='预测 COCO JSON')
    parser.add_argument('--out', default=None, help='指标 JSON 输出路径')
    parser.add_argument('--iou', type=float, default=0.5, help='检测匹配 IoU 阈值')
    args = parser.parse_args()

    gt = load_json(args.gt)
    pred = load_json(args.pred)

    gt_name_by_id = {c['id']: c['name'] for c in gt.get('categories', [])}
    gt_id_by_name = {name: cid for cid, name in gt_name_by_id.items()}
    pred_name_by_id = {c['id']: c['name'] for c in pred.get('categories', [])}

    # 图片 id 对齐：导出的 image_id 按标注文档顺序编号，GT 按文件名编号，两者可能不一致；
    # 统一通过 basename(file_name) 把预测的 image_id 映射到 GT 的 image_id。
    gt_id_by_file = {
        os.path.basename(str(image.get('file_name', ''))): image['id']
        for image in gt.get('images', [])
        if image.get('file_name')
    }
    pred_image_id_to_gt_id = {}
    for image in pred.get('images', []) or []:
        if not image.get('file_name') or image.get('id') is None:
            continue
        gt_id = gt_id_by_file.get(
            os.path.basename(str(image['file_name']))
        )
        if gt_id is not None:
            pred_image_id_to_gt_id[image['id']] = gt_id
    gt_image_ids = {image['id'] for image in gt.get('images', [])}
    mapping_mode = (
        'by_file_name'
        if pred_image_id_to_gt_id
        else 'identity_fallback'
    )
    if mapping_mode == 'identity_fallback':
        print(
            '警告：预测缺少可对齐的 images/file_name，回退为按 image_id 直接对应；'
            '若编号顺序与 GT 不一致，指标将失真。',
            file=sys.stderr,
        )

    remapped = []
    known_category = 0
    unmapped_image = 0
    for ann in pred.get('annotations', []):
        if mapping_mode == 'by_file_name':
            gt_image_id = pred_image_id_to_gt_id.get(ann.get('image_id'))
            if gt_image_id is None:
                unmapped_image += 1
                continue
        else:
            gt_image_id = ann.get('image_id')
            if gt_image_id not in gt_image_ids:
                unmapped_image += 1
                continue

        name = pred_name_by_id.get(ann['category_id'])
        gt_category_id = gt_id_by_name.get(name)
        entry = dict(ann)
        entry['image_id'] = gt_image_id
        entry['_label_name'] = name
        if gt_category_id is None:
            entry['_unknown_category'] = True
            # pycocotools 会忽略非 GT 类别的预测，用任一 GT 类别 id 占位
            entry['category_id'] = next(iter(gt_name_by_id), 1)
        else:
            entry['category_id'] = gt_category_id
            known_category += 1
        entry.setdefault('score', 1.0)
        remapped.append(entry)

    try:
        coco_metrics, per_class = evaluate_coco(gt, remapped)
    except ImportError:
        print(
            '缺少 pycocotools，请先安装：pip install pycocotools',
            file=sys.stderr,
        )
        sys.exit(2)

    detection = evaluate_label_agnostic(
        gt,
        remapped,
        gt_name_by_id,
        args.iou,
    )

    result = {
        'gt_file': args.gt,
        'pred_file': args.pred,
        'gt_images': len(gt.get('images', [])),
        'gt_boxes': len(gt.get('annotations', [])),
        'pred_boxes': len(pred.get('annotations', [])),
        'known_category_predictions': known_category,
        'image_id_mapping': mapping_mode,
        'unmapped_image_predictions': unmapped_image,
        'coco': coco_metrics,
        'detection_class_agnostic': detection,
        'per_class_AP50': {
            gt_name_by_id[cid]: round(ap, 4)
            for cid, ap in per_class.items()
            if cid in gt_name_by_id
        },
    }

    if args.out:
        out_dir = os.path.dirname(args.out)
        if out_dir:
            os.makedirs(out_dir, exist_ok=True)
        with open(args.out, 'w', encoding='utf-8') as handle:
            json.dump(result, handle, ensure_ascii=False, indent=2)

    summary = {
        'image_id_mapping': mapping_mode,
        'unmapped_image_predictions': unmapped_image,
        'mAP': round(coco_metrics['mAP'], 4) if coco_metrics else None,
        'AP50': round(coco_metrics['AP50'], 4) if coco_metrics else None,
        'AP75': round(coco_metrics['AP75'], 4) if coco_metrics else None,
        'precision@0.5': round(detection['precision'], 4),
        'recall@0.5': round(detection['recall'], 4),
        'f1@0.5': round(detection['f1'], 4),
        'label_accuracy': (
            round(detection['label_accuracy'], 4)
            if detection['label_accuracy'] is not None
            else None
        ),
        'unknown_category_predictions': detection['unknown_category_predictions'],
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    if args.out:
        print(f'已写入 {args.out}')


if __name__ == '__main__':
    main()
