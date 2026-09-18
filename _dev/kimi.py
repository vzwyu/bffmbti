#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Kimi K3 开发桥接器 —— 让 Kimi 作为主开发 AI 产出代码/文本。

用法:
  python kimi.py --prompt-file spec.md --out out.js
  python kimi.py --prompt-file spec.md --out out.js --system "你是资深 Node.js 工程师"

退出码:
  0  成功
  2  Kimi 额度耗尽 / 限流  -> 调用方应回退到 MiniMax 或 DeepSeek
  3  其它错误
"""
from __future__ import annotations

import argparse
import json
import os
import pathlib
import re
import sys
import time
import urllib.error
import urllib.request

DEFAULT_MODELS_JSON = pathlib.Path.home() / ".workbuddy" / "models.json"
DEFAULT_MODEL = "kimi-k3"

QUOTA_RE = re.compile(
    r"(quota|insufficient|balance|rate.?limit|too many|exceed|429)", re.I
)


def resolve_cfg(model_id: str):
    """从环境变量或 ~/.workbuddy/models.json 解析 apiKey / endpoint。

    注意 models.json 里 url 的写法并不统一：
      - kimi-k3 / MiniMax-M3 给的是 **base url**（如 https://api.kimi.com/coding/v1）
      - deepseek-* 给的是 **完整端点**（https://api.deepseek.com/chat/completions）
    早先无条件拼 "/chat/completions"，导致 DeepSeek 变成
    ".../chat/completions/chat/completions" 直接 404，备用模型形同虚设。
    这里判断一下：已经是完整端点就不再拼。
    """
    key = os.environ.get("KIMI_API_KEY")
    url = os.environ.get("KIMI_API_URL")
    name = None
    p = pathlib.Path(os.environ.get("KIMI_MODELS_JSON", str(DEFAULT_MODELS_JSON)))
    if p.exists():
        try:
            entries = json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            entries = []
        for m in entries:
            if m.get("id") == model_id:
                key = key or m.get("apiKey")
                base = (m.get("url") or "").rstrip("/")
                if base and not url:
                    url = base if base.endswith("/chat/completions") else base + "/chat/completions"
                # 配置里的 id 不一定等于厂商 API 的模型名（如 deepseek-v4-pro vs deepseek-chat），
                # 允许用可选的 "model" 字段覆盖实际发出的模型名
                name = m.get("model")
                break
    return key, url or "https://api.kimi.com/coding/v1/chat/completions", name


def chat(url, key, model, prompt, system, max_tokens, temperature, timeout):
    messages = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": prompt})
    payload = json.dumps(
        {
            "model": model,
            "messages": messages,
            "max_tokens": max_tokens,
            "temperature": temperature,
        },
        ensure_ascii=False,
    ).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=payload,
        method="POST",
        headers={
            "Authorization": "Bearer " + key,
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--prompt-file", help="提示词文件；省略则从 stdin 读")
    ap.add_argument("--out", help="输出文件；省略则写 stdout")
    ap.add_argument("--system", help="system prompt")
    ap.add_argument("--model", default=os.environ.get("KIMI_MODEL", DEFAULT_MODEL))
    # 实际发给厂商 API 的模型名；默认用 --model 的 id，可用 --model-name 覆盖
    ap.add_argument("--model-name", default=None)
    ap.add_argument("--max-tokens", type=int, default=32768)
    # 注意：Kimi K3 只接受 temperature=1，传其它值会 HTTP 400
    ap.add_argument("--temperature", type=float, default=1.0)
    ap.add_argument("--timeout", type=int, default=900)
    ap.add_argument("--retries", type=int, default=3)
    args = ap.parse_args()

    if args.prompt_file:
        prompt = pathlib.Path(args.prompt_file).read_text(encoding="utf-8")
    else:
        prompt = sys.stdin.read()
    if not prompt.strip():
        print("empty prompt", file=sys.stderr)
        return 3

    key, url, cfg_name = resolve_cfg(args.model)
    if not key:
        print("no api key for model " + args.model, file=sys.stderr)
        return 3
    # 优先级：命令行 --model-name > models.json 的 model 字段 > 模型 id
    send_model = args.model_name or cfg_name or args.model

    last = None
    t0 = time.time()
    data = None
    for attempt in range(1, args.retries + 1):
        try:
            data = chat(url, key, send_model, prompt, args.system,
                        args.max_tokens, args.temperature, args.timeout)
            break
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", "replace")
            last = "HTTP %s: %s" % (e.code, body[:500])
            if e.code == 429 or QUOTA_RE.search(body):
                print("QUOTA_LIMIT: " + last, file=sys.stderr)
                return 2
            print("attempt %d failed: %s" % (attempt, last), file=sys.stderr)
        except Exception as e:
            last = repr(e)
            print("attempt %d failed: %s" % (attempt, last), file=sys.stderr)
        if attempt < args.retries:
            time.sleep(2 * attempt)

    if data is None:
        print("all retries failed: %s" % last, file=sys.stderr)
        return 3

    choices = data.get("choices") or []
    text = (choices[0]["message"].get("content") or "") if choices else ""
    usage = data.get("usage") or {}
    if args.out:
        outp = pathlib.Path(args.out)
        outp.parent.mkdir(parents=True, exist_ok=True)   # 自动建父目录
        outp.write_text(text, encoding="utf-8")
    else:
        sys.stdout.write(text)
    print(
        "[kimi] model=%s in=%s out=%s elapsed=%.1fs"
        % (data.get("model"), usage.get("prompt_tokens"),
           usage.get("completion_tokens"), time.time() - t0),
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
