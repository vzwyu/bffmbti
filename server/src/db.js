'use strict';
/**
 * 数据库层 —— 基于 Node 22 内置 node:sqlite，零第三方依赖。
 *
 * 防删库设计（三层）：
 *   1. 代码层：整个项目不出现任何 DELETE / DROP / ALTER 语句；
 *      sessions 过期清理使用「标记 + 覆盖」而非删除。
 *   2. 文件层：数据库文件位于 webroot 之外，权限 600，属主为运行用户。
 *   3. 备份层：使用内置 db.backup() 定期做版本化快照，保留 N 份。
 *
 * 所有 SQL 一律走 prepare() 参数化，杜绝拼接。
 */

const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync, backup: sqliteBackup } = require('node:sqlite');

const SCHEMA_VERSION = 2;   // 必须与 MIGRATIONS.length 一致

/** 统一的 ISO8601 UTC 时间戳，便于字符串排序 */
function nowIso() {
  return new Date().toISOString();
}

const MIGRATIONS = [
  // ---- v1：初始结构 ----
  function v1(db) {
    db.exec(`
      CREATE TABLE users (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        token              TEXT    NOT NULL UNIQUE,
        nickname           TEXT    NOT NULL,
        gender             TEXT    NOT NULL DEFAULT 'unset',
        login_account      TEXT    NOT NULL UNIQUE,
        password_hash      TEXT    NOT NULL,
        recovery_code_hash TEXT    NOT NULL,
        mbti_self          TEXT,
        mbti_edit_count    INTEGER NOT NULL DEFAULT 0,
        created_at         TEXT    NOT NULL,
        updated_at         TEXT    NOT NULL,
        last_login_at      TEXT,
        reg_ip             TEXT,
        reg_ua             TEXT,
        wx_openid          TEXT,
        banned             INTEGER NOT NULL DEFAULT 0,
        CHECK (gender IN ('male','female','other','unset')),
        CHECK (mbti_self IS NULL OR length(mbti_self) = 4),
        CHECK (mbti_edit_count >= 0)
      )
    `);
    db.exec('CREATE INDEX idx_users_account ON users(login_account)');
    db.exec('CREATE INDEX idx_users_wx_openid ON users(wx_openid)');

    db.exec(`
      CREATE TABLE votes (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        target_user_id INTEGER NOT NULL REFERENCES users(id),
        voter_nickname TEXT    NOT NULL,
        voter_user_id  INTEGER REFERENCES users(id),
        axis_ie        TEXT    NOT NULL,
        axis_ns        TEXT    NOT NULL,
        axis_tf        TEXT    NOT NULL,
        axis_pj        TEXT    NOT NULL,
        result_mbti    TEXT    NOT NULL,
        created_at     TEXT    NOT NULL,
        voter_ip       TEXT,
        voter_ua       TEXT,
        CHECK (axis_ie IN ('I','E')),
        CHECK (axis_ns IN ('N','S')),
        CHECK (axis_tf IN ('T','F')),
        CHECK (axis_pj IN ('P','J'))
      )
    `);
    db.exec('CREATE INDEX idx_votes_target ON votes(target_user_id, id DESC)');

    db.exec(`
      CREATE TABLE sessions (
        token_hash TEXT    PRIMARY KEY,
        user_id    INTEGER NOT NULL REFERENCES users(id),
        created_at TEXT    NOT NULL,
        expires_at TEXT    NOT NULL,
        revoked    INTEGER NOT NULL DEFAULT 0,
        ip         TEXT,
        ua         TEXT
      )
    `);
    db.exec('CREATE INDEX idx_sessions_user ON sessions(user_id)');

    db.exec(`
      CREATE TABLE audit_log (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    INTEGER,
        action     TEXT    NOT NULL,
        field      TEXT,
        old_value  TEXT,
        new_value  TEXT,
        ip         TEXT,
        ua         TEXT,
        created_at TEXT    NOT NULL
      )
    `);
    db.exec('CREATE INDEX idx_audit_user ON audit_log(user_id, id DESC)');
  },

  // ---- v2：评价失效标记 ----
  // 用户可以把某条评价标为失效，失效的不计入统计。
  // 用标记位而不是物理删除：评价是别人写的，本体要保留可追溯，
  // 而且要支持随时恢复。全库没有任何 DELETE。
  function v2(db) {
    db.exec('ALTER TABLE votes ADD COLUMN invalid INTEGER NOT NULL DEFAULT 0');
    db.exec('ALTER TABLE votes ADD COLUMN invalid_at TEXT');
    // 统计与明细都按 (target_user_id, invalid) 过滤
    db.exec('CREATE INDEX idx_votes_valid ON votes(target_user_id, invalid)');
  }
];

/**
 * 打开数据库并应用迁移。
 * @param {string} dbPath 数据库文件绝对路径
 */
function openDatabase(dbPath) {
  const dir = path.dirname(dbPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const db = new DatabaseSync(dbPath);

  // 并发与一致性
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA synchronous = NORMAL');

  // 迁移
  const cur = Number(db.prepare('PRAGMA user_version').get().user_version) || 0;
  const pending = MIGRATIONS.length - cur;

  // 有待应用的迁移时，先做一次快照 —— 迁移写错会毁数据，必须留退路
  if (pending > 0 && cur > 0) {
    try {
      const dir = path.join(path.dirname(dbPath), 'pre-migration');
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
      const dest = path.join(dir, `v${cur}-to-v${MIGRATIONS.length}-${stamp}.sqlite`);
      // 启动阶段没有并发写入，先 checkpoint 再直接复制文件即可
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      fs.copyFileSync(dbPath, dest);
      fs.chmodSync(dest, 0o600);
      console.log('[migrate] 迁移前快照 -> ' + dest);
    } catch (e) {
      console.warn('[migrate] 快照失败（继续迁移）: ' + e.message);
    }
  }

  for (let v = cur; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      MIGRATIONS[v](db);
      db.exec('PRAGMA user_version = ' + (v + 1));
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  // 收紧文件权限：仅属主可读写
  try {
    fs.chmodSync(dbPath, 0o600);
  } catch (_) {
    /* Windows 下可能不支持，忽略 */
  }

  const jm = db.prepare('PRAGMA journal_mode').get();
  return { db, journalMode: jm ? jm.journal_mode : 'unknown' };
}

/** 把一组写操作包进事务；任一抛错则整体回滚 */
function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) { /* ignore */ }
    throw e;
  }
}

/** 写审计日志。任何字段变更都必须调用，供事后查验。 */
function audit(db, { userId, action, field, oldValue, newValue, ip, ua }) {
  db.prepare(
    `INSERT INTO audit_log
       (user_id, action, field, old_value, new_value, ip, ua, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    userId == null ? null : Number(userId),
    String(action),
    field == null ? null : String(field),
    oldValue == null ? null : String(oldValue),
    newValue == null ? null : String(newValue),
    ip == null ? null : String(ip),
    ua == null ? null : String(ua),
    nowIso()
  );
}

/**
 * 版本化备份：写出 mbti-YYYYMMDD-HHMMSS.sqlite，超量则滚动保留。
 * 优先用 node:sqlite 的内置 backup()（无需 sqlite3 CLI，服务器未安装）；
 * 若当前 Node 未提供该能力，退化为「先 WAL checkpoint 再文件复制」。
 */
async function backup(db, backupDir, keep = 30) {
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const stamp = nowIso().replace(/[-:T]/g, '').slice(0, 14);
  const dest = path.join(backupDir, `mbti-${stamp}.sqlite`);

  if (typeof sqliteBackup === 'function') {
    await sqliteBackup(db, dest);
  } else {
    // 退化路径：把 WAL 落盘后直接复制主文件
    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch (_) { /* ignore */ }
    const src = db.prepare('PRAGMA database_list').get();
    fs.copyFileSync(src.file, dest);
  }

  try { fs.chmodSync(dest, 0o600); } catch (_) { /* Windows 忽略 */ }

  const all = fs.readdirSync(backupDir)
    .filter((f) => /^mbti-\d{14}\.sqlite$/.test(f))
    .sort();
  const excess = all.length - keep;
  for (let i = 0; i < excess; i++) {
    try { fs.unlinkSync(path.join(backupDir, all[i])); } catch (_) { /* ignore */ }
  }
  return dest;
}

module.exports = { openDatabase, tx, audit, backup, nowIso, SCHEMA_VERSION };
