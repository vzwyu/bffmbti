#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
人格形象图后处理：
  1. 缩放到 256×256（页面最大只显示 64px，2 倍图足够）
  2. 把纯白背景抠成透明，只留圆形底衬与人物
  3. 输出 WebP（体积约为 PNG 的 1/10）

用法: python3 process_avatars.py <原始目录> <输出目录>
"""
import sys, os, glob
from PIL import Image

# 生成顺序 → 类型 slug（与 MBTI.TYPES 的 4×4 顺序一致）
SLUGS = [
    'architect', 'logician', 'commander', 'debater',          # NT 紫
    'advocate', 'mediator', 'protagonist', 'campaigner',      # NF 绿
    'logistician', 'defender', 'executive', 'consul',         # SJ 蓝
    'virtuoso', 'adventurer', 'entrepreneur', 'entertainer',  # SP 黄
]

SIZE = 256
# 判定为"白底"的阈值：三通道都 >= 该值即视为背景
WHITE_MIN = 242


def whiten_to_alpha(img):
    """把接近纯白的像素置为透明（四角 flood 思路的简化版：全局阈值）"""
    img = img.convert('RGBA')
    px = img.load()
    w, h = img.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if r >= WHITE_MIN and g >= WHITE_MIN and b >= WHITE_MIN:
                px[x, y] = (r, g, b, 0)
    return img


def main():
    src_dir, out_dir = sys.argv[1], sys.argv[2]
    os.makedirs(out_dir, exist_ok=True)

    files = sorted(glob.glob(os.path.join(src_dir, '*.png')))
    if len(files) != len(SLUGS):
        print('❌ 期望 %d 张，实际 %d 张' % (len(SLUGS), len(files)))
        sys.exit(1)

    total_in = total_out = 0
    for f, slug in zip(files, SLUGS):
        img = Image.open(f)
        total_in += os.path.getsize(f)

        # 先缩放到统一尺寸再做抠图，边缘更干净
        img = img.convert('RGB').resize((SIZE, SIZE), Image.LANCZOS)
        img = whiten_to_alpha(img)

        out = os.path.join(out_dir, slug + '.webp')
        img.save(out, 'WEBP', quality=88, method=6, lossless=False)
        total_out += os.path.getsize(out)

        print('  %-14s %6.0fKB → %5.1fKB' % (
            slug, os.path.getsize(f) / 1024, os.path.getsize(out) / 1024))

    print('\n合计 %.1f MB → %.0f KB（压缩到 %.1f%%）' % (
        total_in / 1048576, total_out / 1024, total_out * 100.0 / total_in))


if __name__ == '__main__':
    main()
