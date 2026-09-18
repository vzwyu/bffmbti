#!/usr/bin/env node
'use strict';
/**
 * mbticli —— MBTI 游戏数据库运维工具
 *
 * 设计目标：**任何破坏性操作都必须先有一份可验证的快照，且恢复过程可一键完成。**
 *
 * 用法（服务器上执行）：
 *   node mbticli.js list    [--env prod|test]   列出所有快照（含用户数）
 *   node mbticli.js snap    [--env prod|test]   立刻打一份快照
 *   node mbticli.js verify  <文件>              校验某个快照是否可读、数据是否完整
 *   node mbticlif.js restore <文件> [--env prod] 用快照覆盖当前库（会先自动备份现状）
 *   node mbticli.js stat    [--env prod|test]   查看当前库概况
 *
 * 环境：
 *   prod（默认）→ /var/lib/mbti-game/      对应线上服务 mbti-game
 *   test        → /var/lib/mbti-game-test/ 对应测试服务 mbti-game-test
 */

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync, backup } = require('node:sqlite');

const ENVS = {
  prod: {
    dir: '/var/lib/mbti-game',
    service: 'mbti-game',
    label: '生产'
  },
  test: {
    dir: '/var/lib/mbti-game-test',
    service: 'mbti-game-test',
    label: '测试'
  }
};

function parseArgs(argv) {
  const cmd = argv[2];
  let env = 'prod';
  const rest = [];
  for (let i = 3; i < argv.length; i++) {
    if (argv[i] === '--env') { env = argv[++i]; continue; }
    rest.push(argv[i]);
  }
  if (!ENVS[env]) {
    console.error('未知环境: ' + env + '（可选 prod / test）');
    process.exit(2);
  }
  return { cmd, env, rest };
}

function dbPath(env) { return path.join(ENVS[env].dir, 'mbti.sqlite'); }
function backupDir(env) { return path.join(ENVS[env].dir, 'backups'); }

/** 打开一个库并统计行数，用于校验快照 */
function inspect(file) {
  const db = new DatabaseSync(file);
  const out = {
    users: db.prepare('SELECT COUNT(*) c FROM users').get().c,
    votes: db.prepare('SELECT COUNT(*) c FROM votes').get().c,
    sessions: db.prepare('SELECT COUNT(*) c FROM sessions').get().c,
    audit: db.prepare('SELECT COUNT(*) c FROM audit_log').get().c,
    integrity: db.prepare('PRAGMA integrity_check').get().integrity_check,
    names: db.prepare('SELECT nickname FROM users ORDER BY id LIMIT 8').all().map((r) => r.nickname)
  };
  db.close();
  return out;
}

function listSnapshots(env) {
  const dirs = [
    { kind: '常规', dir: backupDir(env) },
    { kind: '迁移前', dir: path.join(ENVS[env].dir, 'pre-migration') }
  ];
  let total = 0;
  for (const { kind, dir } of dirs) {
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sqlite')).sort().reverse();
    if (!files.length) continue;
    console.log('\n【' + kind + '快照】' + dir);
    for (const f of files) {
      const p = path.join(dir, f);
      const sz = (fs.statSync(p).size / 1024).toFixed(0);
      let info = '读取失败';
      try {
        const i = inspect(p);
        info = '用户=' + i.users + ' 评价=' + i.votes +
          (i.names.length ? '  ' + i.names.slice(0, 3).join('/') : '') +
          '  ' + i.integrity;
      } catch (e) { /* 保持"读取失败" */ }
      console.log('  ' + f + '  ' + sz + 'KB  ' + info);
      total++;
    }
  }
  if (!total) console.log('（无快照）');
  console.log('');
}

async function doSnapshot(env, reason) {
  const src = dbPath(env);
  if (!fs.existsSync(src)) { console.error('数据库不存在: ' + src); process.exit(1); }
  const dir = backupDir(env);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const tag = reason ? '-' + String(reason).replace(/[^\w-]/g, '') : '';
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const dest = path.join(dir, `mbti-${stamp}${tag}.sqlite`);

  const db = new DatabaseSync(src);
  if (typeof backup === 'function') await backup(db, dest);
  else { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); fs.copyFileSync(src, dest); }
  db.close();

  fs.chmodSync(dest, 0o600);
  const i = inspect(dest);
  console.log('✅ 快照完成: ' + dest);
  console.log('   用户=' + i.users + ' 评价=' + i.votes + ' 完整性=' + i.integrity);
  return dest;
}

async function main() {
  const { cmd, env, rest } = parseArgs(process.argv);
  const envInfo = ENVS[env];

  switch (cmd) {
    case 'list':
      console.log('\n环境: ' + envInfo.label + '  ' + envInfo.dir);
      listSnapshots(env);
      break;

    case 'snap':
      console.log('\n环境: ' + envInfo.label);
      await doSnapshot(env, rest[0] || '');
      break;

    case 'stat': {
      const p = dbPath(env);
      if (!fs.existsSync(p)) { console.error('数据库不存在: ' + p); process.exit(1); }
      const i = inspect(p);
      const sz = (fs.statSync(p).size / 1024).toFixed(0);
      console.log('\n环境: ' + envInfo.label + '  ' + p);
      console.log('  大小  : ' + sz + ' KB');
      console.log('  用户  : ' + i.users);
      console.log('  评价  : ' + i.votes);
      console.log('  会话  : ' + i.sessions);
      console.log('  审计  : ' + i.audit);
      console.log('  完整性: ' + i.integrity);
      if (i.names.length) console.log('  昵称  : ' + i.names.join(' / '));
      console.log('');
      break;
    }

    case 'verify': {
      const f = rest[0];
      if (!f) { console.error('用法: node mbticli.js verify <文件>'); process.exit(2); }
      if (!fs.existsSync(f)) { console.error('文件不存在: ' + f); process.exit(1); }
      const i = inspect(f);
      console.log('\n校验: ' + f);
      console.log('  用户=' + i.users + ' 评价=' + i.votes + ' 会话=' + i.sessions + ' 审计=' + i.audit);
      console.log('  完整性检查: ' + i.integrity + (i.integrity === 'ok' ? ' ✅' : ' ❌'));
      if (i.names.length) console.log('  含昵称: ' + i.names.join(' / '));
      console.log('');
      process.exit(i.integrity === 'ok' ? 0 : 1);
    }

    case 'restore': {
      const f = rest[0];
      if (!f) { console.error('用法: node mbticli.js restore <快照文件> [--env prod]'); process.exit(2); }
      if (!fs.existsSync(f)) { console.error('快照不存在: ' + f); process.exit(1); }

      const i = inspect(f);
      if (i.integrity !== 'ok') {
        console.error('❌ 快照完整性检查未通过，拒绝恢复');
        process.exit(1);
      }

      console.log('\n⚠️  即将用以下快照覆盖【' + envInfo.label + '】库:');
      console.log('   文件  : ' + f);
      console.log('   用户  : ' + i.users + (i.names.length ? '  (' + i.names.join(' / ') + ')' : ''));
      console.log('   评价  : ' + i.votes);
      console.log('');

      // 覆盖前先给现状留一份，万一恢复错了还能退回来
      const safety = await doSnapshot(env, 'prerestore');
      console.log('   （已先备份当前状态: ' + path.basename(safety) + '）\n');

      const dst = dbPath(env);
      fs.copyFileSync(f, dst);
      fs.chmodSync(dst, 0o600);
      for (const suffix of ['-wal', '-shm']) {
        try { fs.unlinkSync(dst + suffix); } catch (_) { /* 不存在则忽略 */ }
      }

      const after = inspect(dst);
      console.log('✅ 恢复完成');
      console.log('   用户=' + after.users + ' 评价=' + after.votes + ' 完整性=' + after.integrity);
      console.log('\n⚠️  请重启服务使恢复生效:');
      console.log('   sudo systemctl restart ' + envInfo.service);
      console.log('');
      break;
    }

    default:
      console.log(`
mbticli —— MBTI 游戏数据库运维工具

  list    [--env prod|test]   列出所有快照（含用户数，便于确认没删错）
  snap    [--env prod|test]   立刻打一份快照
  stat    [--env prod|test]   查看当前库概况
  verify  <文件>              校验快照是否可读、数据是否完整
  restore <文件> [--env prod] 用快照覆盖当前库（自动先备份现状）

环境：prod = /var/lib/mbti-game        （线上）
      test = /var/lib/mbti-game-test   （测试，随便造）
`);
      break;
  }
}

main().catch((e) => { console.error('执行失败:', e.message); process.exit(1); });
