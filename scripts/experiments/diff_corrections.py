#!/usr/bin/env python3
"""修正成本分析：对比 AI 阶段与人工修正后的标注快照（原生 .lr-agent/annotations）。

统计口径（协议 §5.2）：
  - kept      身份匹配（IoU≥0.5）且标签不变 → 采纳
  - relabeled 身份匹配但标签变化（含 AI 无标签 → 人工补标签）
  - moved     未身份匹配、但几何匹配（0.1≤IoU<0.5）→ 视为移动
  - deleted   AI 阶段存在、修正后消失（含 FP 删除）
  - added     修正后新增（含漏检补充）

可选 --gt：额外计算 AI 阶段与修正后的「对 GT」质量（类别无关 P/R/F1 与标签正确率），
用于验证修正后质量不降、并量化漏检/误检。

用法：
  python scripts/experiments/diff_corrections.py \
    --ai experiments/runs/C-s1/ai \
    --final experiments/runs/C-s1/final \
    --gt experiments/data/gt/instances_project.json \
    --out experiments/results/metrics/C-s1-corrections.json
"""

import argparse
import json
import os
import sys
from collections import defaultdict


def load_json(path):
    with open(path, 'r', encoding='utf-8') as handle:
        return json.load(handle)


def iou_xyxy(a, b):
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    ix1, iy1 = max(ax1, bx1), max(ay1, by1)
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    iw, ih = max(0.0, ix2 - ix1), max(0.0, iy2 - iy1)
    inter = iw * ih
    if inter <= 0:
        return 0.0
    area_a = max(0.0, ax2 - ax1) * max(0.0, ay2 - ay1)
    area_b = max(0.0, bx2 - bx1) * max(0.0, by2 - by1)
    union = area_a + area_b - inter
    return inter / union if union > 0 else 0.0


def to_xyxy(ann):
    return (
        float(ann['x']),
        float(ann['y']),
        float(ann['x']) + float(ann['width']),
        float(ann['y']) + float(ann['height']),
    )


def label_of(ann, label_names):
    label_id = ann.get('labelId')
    if not label_id:
        return None
    return label_names.get(label_id)


def read_snapshot(snapshot_dir):
    annotations_dir = os.path.join(snapshot_dir, 'annotations')
    index_path = os.path.join(annotations_dir, 'index.json')
    docs = {}

    entries = None
    if os.path.exists(index_path):
        index = load_json(index_path)
        entries = list((index.get('files') or {}).values())

    if entries is not None:
        for entry in entries:
            doc_path = os.path.join(
                annotations_dir, 'files', f"{entry['fileKey']}.json"
            )
            if not os.path.exists(doc_path):
                continue
            doc = load_json(doc_path)
            docs[entry['relativePath']] = doc
    else:
        files_dir = os.path.join(annotations_dir, 'files')
        if os.path.isdir(files_dir):
            for name in os.listdir(files_dir):
                if not name.endswith('.json'):
                    continue
                doc = load_json(os.path.join(files_dir, name))
                docs[doc.get('filePath') or name] = doc
    return docs


def read_project(snapshot_dir):
    project_path = os.path.join(snapshot_dir, 'project.json')
    if not os.path.exists(project_path):
        return {}
    project = load_json(project_path)
    return {label['id']: label['name'] for label in project.get('labels', [])}


def bbox_list(doc):
    anns = doc.get('annotations') or []
    return [a for a in anns if a.get('kind') == 'bbox']


def match_pairs(boxes_a, boxes_b, threshold):
    candidates = []
    for i, a in enumerate(boxes_a):
        for j, b in enumerate(boxes_b):
            value = iou_xyxy(to_xyxy(a), to_xyxy(b))
            if value >= threshold:
                candidates.append((value, i, j))
    candidates.sort(reverse=True)
    used_a, used_b, pairs = set(), set(), []
    for value, i, j in candidates:
        if i in used_a or j in used_b:
            continue
        used_a.add(i)
        used_b.add(j)
        pairs.append((i, j, value))
    return pairs, used_a, used_b


def diff_image(ai_boxes, final_boxes, label_names):
    stats = defaultdict(int)
    identity, used_ai, used_final = match_pairs(ai_boxes, final_boxes, 0.5)
    for i, j, _ in identity:
        if label_of(ai_boxes[i], label_names) == label_of(
            final_boxes[j], label_names
        ):
            stats['kept'] += 1
        else:
            stats['relabeled'] += 1

    remaining_ai = [i for i in range(len(ai_boxes)) if i not in used_ai]
    remaining_final = [j for j in range(len(final_boxes)) if j not in used_final]
    moved, moved_ai, moved_final = match_pairs(
        [ai_boxes[i] for i in remaining_ai],
        [final_boxes[j] for j in remaining_final],
        0.1,
    )
    stats['moved'] = len(moved)
    stats['deleted'] = len(remaining_ai) - len(moved_ai)
    stats['added'] = len(remaining_final) - len(moved_final)
    stats['ai_boxes'] = len(ai_boxes)
    stats['final_boxes'] = len(final_boxes)
    stats['ai_labeled'] = sum(
        1 for a in ai_boxes if label_of(a, label_names) is not None
    )
    stats['ai_unlabeled'] = stats['ai_boxes'] - stats['ai_labeled']
    return stats


def evaluate_stage(boxes, gt_boxes, label_names, gt_names, threshold):
    """boxes / gt_boxes 均为归一化 xywh；返回类别无关 P/R/F1 与标签正确率。"""
    match, used, used_gt = match_pairs(boxes, gt_boxes, threshold)
    correct = 0
    for i, j, _ in match:
        if label_of(boxes[i], label_names) == gt_names[j]:
            correct += 1
    tp = len(match)
    fp = len(boxes) - tp
    fn = len(gt_boxes) - tp
    precision = tp / (tp + fp) if tp + fp > 0 else 0.0
    recall = tp / (tp + fn) if tp + fn > 0 else 0.0
    f1 = (
        2 * precision * recall / (precision + recall)
        if precision + recall > 0
        else 0.0
    )
    return {
        'gt_boxes': len(gt_boxes),
        'pred_boxes': len(boxes),
        'tp': tp,
        'fp': fp,
        'fn': fn,
        'precision': precision,
        'recall': recall,
        'f1': f1,
        'label_accuracy': (correct / tp) if tp > 0 else None,
    }


def build_gt_index(gt):
    names = {c['id']: c['name'] for c in gt.get('categories', [])}
    images = {img['id']: img for img in gt.get('images', [])}
    per_image = defaultdict(lambda: {'boxes': [], 'names': []})
    for ann in gt.get('annotations', []):
        image = images.get(ann['image_id'])
        if not image:
            continue
        width = image.get('width') or 1
        height = image.get('height') or 1
        x, y, w, h = ann['bbox']
        per_image[image['file_name']]['boxes'].append(
            {
                'x': x / width,
                'y': y / height,
                'width': w / width,
                'height': h / height,
            }
        )
        per_image[image['file_name']]['names'].append(names.get(ann['category_id']))
    return per_image


def main():
    parser = argparse.ArgumentParser(description='AI 阶段与修正后快照对比')
    parser.add_argument('--ai', required=True, help='AI 阶段快照目录')
    parser.add_argument('--final', required=True, help='修正后快照目录')
    parser.add_argument('--gt', default=None, help='GT COCO JSON（可选）')
    parser.add_argument('--out', default=None, help='输出 JSON 路径')
    parser.add_argument('--iou', type=float, default=0.5)
    parser.add_argument(
        '--manifest',
        default=None,
        help='实验 manifest.json（配合 --session/--condition 只统计本 session 的图片，'
        '避免把历史 session 已修正的图计入「保留」）',
    )
    parser.add_argument('--session', default=None, help='session 编号（1|2|3）')
    parser.add_argument('--condition', default=None, help='条件（A|B|C）')
    args = parser.parse_args()

    if bool(args.manifest) != bool(args.session) or bool(args.session) != bool(
        args.condition
    ):
        parser.error('--manifest / --session / --condition 必须同时提供')

    label_names = read_project(args.ai) or read_project(args.final)
    ai_docs = read_snapshot(args.ai)
    final_docs = read_snapshot(args.final)
    paths = sorted(set(ai_docs) | set(final_docs))

    filter_info = None
    if args.manifest:
        manifest = load_json(args.manifest)
        schedule = (manifest.get('schedule') or {}).get(str(args.session)) or {}
        allowed = set(schedule.get(args.condition.upper()) or [])
        if not allowed:
            sys.exit(
                f'manifest 中没有 session={args.session} condition={args.condition} 的图片清单'
            )
        before = len(paths)
        paths = [p for p in paths if os.path.basename(p) in allowed]
        filter_info = {
            'session': str(args.session),
            'condition': args.condition.upper(),
            'images': len(paths),
            'skipped': before - len(paths),
        }
        if not paths:
            sys.exit(
                '过滤后没有可统计的图片：快照与本次 session 不匹配？'
                '（C 的 ai/final 快照应覆盖本次 session 的图片）'
            )

    totals = defaultdict(int)
    per_image = {}
    for rel_path in paths:
        ai_boxes = bbox_list(ai_docs.get(rel_path, {}))
        final_boxes = bbox_list(final_docs.get(rel_path, {}))
        stats = diff_image(ai_boxes, final_boxes, label_names)
        per_image[rel_path] = dict(stats)
        for key in (
            'ai_boxes',
            'final_boxes',
            'kept',
            'relabeled',
            'moved',
            'deleted',
            'added',
            'ai_labeled',
            'ai_unlabeled',
        ):
            totals[key] += stats[key]

    result = {
        'ai_snapshot': args.ai,
        'final_snapshot': args.final,
        'labels': label_names,
        'totals': dict(totals),
        'per_image': per_image,
    }
    if filter_info:
        result['filter'] = filter_info
    if totals['ai_boxes'] > 0:
        result['totals']['adoption_rate'] = (
            totals['kept'] / totals['ai_boxes']
        )

    if args.gt:
        gt_index = build_gt_index(load_json(args.gt))
        ai_stage = defaultdict(int)
        final_stage = defaultdict(int)
        for rel_path in paths:
            base = os.path.basename(rel_path)
            gt_entry = gt_index.get(base)
            if not gt_entry:
                continue
            ai_boxes = bbox_list(ai_docs.get(rel_path, {}))
            final_boxes = bbox_list(final_docs.get(rel_path, {}))
            for stage, boxes, bucket in (
                ('ai', ai_boxes, ai_stage),
                ('final', final_boxes, final_stage),
            ):
                evaluation = evaluate_stage(
                    boxes, gt_entry['boxes'], label_names, gt_entry['names'], args.iou
                )
                for key, value in evaluation.items():
                    if key == 'label_accuracy':
                        if value is not None:
                            bucket['label_accuracy_sum'] += value
                            bucket['label_accuracy_n'] += 1
                    else:
                        bucket[key] += value
        for stage, bucket in (('ai', ai_stage), ('final', final_stage)):
            tp = bucket['tp']
            fp = bucket['fp']
            fn = bucket['fn']
            result[f'gt_{stage}_stage'] = {
                'tp': tp,
                'fp': fp,
                'fn': fn,
                'precision': tp / (tp + fp) if tp + fp > 0 else 0.0,
                'recall': tp / (tp + fn) if tp + fn > 0 else 0.0,
                'f1': (
                    2 * tp / (2 * tp + fp + fn) if (2 * tp + fp + fn) > 0 else 0.0
                ),
                'label_accuracy': (
                    bucket['label_accuracy_sum'] / bucket['label_accuracy_n']
                    if bucket['label_accuracy_n'] > 0
                    else None
                ),
                'gt_boxes': bucket['gt_boxes'],
                'pred_boxes': bucket['pred_boxes'],
            }

    if args.out:
        out_dir = os.path.dirname(args.out)
        if out_dir:
            os.makedirs(out_dir, exist_ok=True)
        with open(args.out, 'w', encoding='utf-8') as handle:
            json.dump(result, handle, ensure_ascii=False, indent=2)

    summary = {
        'filter': filter_info,
        'totals': result['totals'],
        'gt_ai_stage': result.get('gt_ai_stage'),
        'gt_final_stage': result.get('gt_final_stage'),
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    if args.out:
        print(f'已写入 {args.out}')


if __name__ == '__main__':
    main()
