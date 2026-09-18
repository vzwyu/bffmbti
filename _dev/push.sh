#!/usr/bin/env bash
# ==========================================================================
# 一键同步到 GitHub —— **先做泄密审查，通过才推送**
#
#   用法：bash _dev/push.sh "提交信息"
#         FORCE=1 bash _dev/push.sh "提交信息"   # 人工确认过 HIGH 命中后强推
#
# 背景：仓库 https://github.com/vzwyu/bffmbti 是 **Public**，
#   推上去就永久公开（删了也在历史里）。所以每次推送前必须扫一遍。
#
# 审查范围：工作区文件 + **全部 git 历史 blob**（删掉的文件仍留在历史里）。
# 判定与退出码见 _dev/audit-secrets.js 顶部说明。
# ==========================================================================
set -uo pipefail

export PATH="/c/Users/vzwyu/.workbuddy/binaries/PortableGit/versions/1.2.0/cmd:/c/Windows/System32:/c/Windows/System32/OpenSSH:/usr/bin:/bin:$PATH"
export HOME=/c/Users/vzwyu

MSG="${1:?用法: bash _dev/push.sh \"提交信息\"}"
REPO="mbti-game"
NODE_BIN="${NODE_BIN:-/c/Users/vzwyu/.workbuddy/binaries/node/versions/22.22.2-3/node.exe}"

cd "$(dirname "$0")/.." || exit 1
[ -d .git ] || { echo "❌ 当前目录不是 git 仓库"; exit 1; }

echo "════════ 1/4 本地改动 ════════"
CHANGED=$(git status --porcelain | wc -l | tr -d ' ')
echo "  待提交文件: $CHANGED"
if [ "$CHANGED" -eq 0 ]; then
  echo "  没有改动，但仍会跑一遍审查确认线上是干净的。"
fi
git status --short | head -15 | sed 's/^/    /'
echo

echo "════════ 2/4 泄密审查（工作区 + 全部历史）════════"
"$NODE_BIN" _dev/audit-secrets.js "$(pwd)"
RC=$?
case "$RC" in
  0) ;;                                   # 干净 / 仅 MED
  1) echo "❌ 发现 CRIT 级泄露，已中止推送。请先把凭据换成占位符。"; exit 1 ;;
  2) if [ "${FORCE:-0}" != "1" ]; then
       echo "❌ 发现 HIGH 级命中，已中止推送。"
       echo "   确认这些是误报后，用 FORCE=1 重跑。"
       exit 1
     fi
     echo "   ⚠️  FORCE=1，跳过 HIGH 命中继续推送" ;;
  *) echo "❌ 审查脚本执行异常（退出码 $RC），已中止"; exit 1 ;;
esac
echo

echo "════════ 3/4 提交 ════════"
if [ "$CHANGED" -gt 0 ]; then
  git add -A
  # 推送前硬检查：不能有文件被误删（历史上踩过：reset --mixed 后 add -A 把远端已有文件记成删除）
  DEL=$(git diff --cached --name-status | grep -c '^D' || true)
  if [ "$DEL" != "0" ]; then
    echo "  ❌ 暂存区里有 $DEL 个**删除**："
    git diff --cached --name-status | grep '^D' | sed 's/^/     /'
    echo "     如果确认要删，请手工处理；否则先恢复。已中止。"
    exit 1
  fi
  git commit -q -m "$MSG" || { echo "  ❌ 提交失败"; exit 1; }
  echo "  已提交: $(git log -1 --format='%h %s')"
else
  echo "  无改动，跳过提交。"
fi
echo

echo "════════ 4/4 推送 + 远端核实 ════════"
git fetch -q origin main 2>/dev/null
if [ "$(git rev-parse HEAD)" = "$(git rev-parse FETCH_HEAD 2>/dev/null)" ]; then
  echo "  远端已是最新，无需推送。"
else
  git push origin main 2>&1 | tail -3 | sed 's/^/  /'
fi

LOCAL=$(git rev-parse HEAD)
REMOTE=$(git ls-remote origin main | awk '{print $1}')
echo "  本地 HEAD: $(echo $LOCAL | cut -c1-7)"
echo "  远端 HEAD: $(echo $REMOTE | cut -c1-7)"
if [ "$LOCAL" = "$REMOTE" ]; then
  echo "  ✅ 已同步"
else
  echo "  ❌ 远端与本地不一致，推送可能失败"
  exit 1
fi
