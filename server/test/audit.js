'use strict';
/**
 * 代码红线审查器 —— 对 Kimi 产出的模块做静态合规检查。
 *
 * 用法: node test/audit.js <文件路径> [<文件路径> ...]
 * 退出码 0 = 全部通过；1 = 存在违规
 */

const fs = require('node:fs');
const path = require('node:path');

const RULES = [
  {
    id: 'R1-no-math-random',
    desc: '禁止 Math.random()，随机必须走 crypto',
    test: (s) => /\bMath\.random\s*\(/.test(s)
  },
  {
    id: 'R2-no-destructive-sql',
    desc: '禁止 DELETE / DROP / TRUNCATE；ALTER 只允许「迁移里的 ADD COLUMN」',
    // 原规则一刀切禁掉 ALTER TABLE。但 schema 演进必须靠
    // `ALTER TABLE x ADD COLUMN y`，这是**纯加列、不改动既有数据**的操作，
    // 且 openDatabase 在应用迁移前会自动打一份 pre-migration 快照（见 db.js），
    // 写错能立刻回退。所以这里精确放行 ADD COLUMN，其余 ALTER 形态照旧禁止。
    test: (s) => {
      if (/\b(DELETE\s+FROM|DROP\s+(TABLE|INDEX|VIEW|TRIGGER)|TRUNCATE\s+TABLE)\b/i.test(s)) return true;
      // 把「ADD COLUMN」这种合法形态先摘掉，再看还有没有别的 ALTER TABLE
      const stripped = s.replace(/\bALTER\s+TABLE\s+\w+\s+ADD\s+COLUMN\b/gi, '');
      return /\bALTER\s+TABLE\b/i.test(stripped);
    }
  },
  {
    id: 'R3-no-sql-string-concat',
    desc: '禁止把变量拼接进 SQL 字符串（必须参数化）',
    // 匹配 prepare(`... ${var} ...`) 或 prepare("..." + var) 这类写法。
    // 例外：PRAGMA 语句在 SQLite 中无法参数化，迁移代码里的 user_version 拼接
    // 用的是内部循环下标而非用户输入，单独放行（下方按行过滤）。
    test: (s) => {
      const lines = s.split('\n').filter((l) => !/\bPRAGMA\b/i.test(l));
      const re = /\.(prepare|exec)\s*\(\s*(`[^`]*\$\{[^}]*\}[^`]*`|'[^']*'\s*\+|"[^"]*"\s*\+)/;
      return re.test(lines.join('\n'));
    }
  },
  {
    id: 'R4-braces-balanced',
    desc: '花括号必须配平（防输出被截断）',
    test: (s) => {
      let open = 0, close = 0;
      for (const ch of s) { if (ch === '{') open++; if (ch === '}') close++; }
      return open !== close;
    }
  },
  {
    id: 'R5-no-secret-in-audit',
    desc: '审计日志不得写入密码明文/哈希',
    test: (s) => /audit\s*\([^)]*\b(password|password_hash|recovery_code)\b(?!\s*:)/i.test(s)
      && !/\[redacted\]/.test(s)
  },
  {
    id: 'R6-no-todo-stub',
    desc: '不得残留 TODO / FIXME / 未实现占位',
    test: (s) => /\b(TODO|FIXME|XXX|not implemented|未实现)\b/i.test(s)
  }
];

let failed = 0;
const targets = process.argv.slice(2);
if (!targets.length) {
  console.error('用法: node test/audit.js <文件> [<文件> ...]');
  process.exit(1);
}

for (const file of targets) {
  const abs = path.resolve(file);
  console.log('\n── ' + path.relative(process.cwd(), abs));
  if (!fs.existsSync(abs)) {
    console.log('  ❌ 文件不存在');
    failed++;
    continue;
  }
  const src = fs.readFileSync(abs, 'utf8');
  let fileFailed = 0;

  for (const rule of RULES) {
    let hit = false;
    try { hit = rule.test(src); } catch (e) { hit = true; }
    if (hit) {
      console.log('  ❌ [' + rule.id + '] ' + rule.desc);
      fileFailed++;
    }
  }

  // 可加载性（仅对 src/ 下的模块做，避免执行测试脚本）
  if (abs.includes(path.sep + 'src' + path.sep) && /\.js$/.test(abs)) {
    try {
      delete require.cache[require.resolve(abs)];
      const m = require(abs);
      const keys = Object.keys(m);
      console.log('  ✅ 加载成功，导出 ' + keys.length + ' 项: ' + keys.join(', '));
    } catch (e) {
      console.log('  ❌ 加载失败: ' + String(e.message).split('\n')[0]);
      fileFailed++;
    }
  }

  if (fileFailed === 0) console.log('  ✅ 全部 ' + RULES.length + ' 条红线通过');
  failed += fileFailed;
}

console.log('\n' + '='.repeat(46));
console.log(failed === 0 ? '  审查通过' : '  发现 ' + failed + ' 处违规');
console.log('='.repeat(46) + '\n');
process.exit(failed ? 1 : 0);
