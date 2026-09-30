// 生产库只读导出（不写入、不改动任何数据）
// 用法（服务器上）：sudo node /tmp/mbti-dump.js
// 输出：JSON 到 stdout，供本地生成 xlsx
'use strict';
const { DatabaseSync } = require('node:sqlite');

const DB = '/var/lib/mbti-game/mbti.sqlite';
const db = new DatabaseSync(DB, { readOnly: true });
const all = (sql, ...p) => db.prepare(sql).all(...p);
const one = (sql, ...p) => db.prepare(sql).get(...p);

const out = { generated_at: new Date().toISOString(), db: DB };

// ---------- 表计数 ----------
out.counts = {};
for (const t of ['users', 'votes', 'sessions', 'audit_log']) {
  out.counts[t] = one('SELECT COUNT(*) AS n FROM ' + t).n;
}

// ---------- 列探测（生产库可能带 v2 迁移列） ----------
const voteCols = all("PRAGMA table_info(votes)").map((c) => c.name);
out.vote_has_invalid = voteCols.includes('invalid');

// ---------- 用户 ----------
const mask = (s) => {
  if (!s) return '';
  if (s.includes('@')) {
    const [a, d] = s.split('@');
    return (a.length <= 2 ? a[0] + '*' : a.slice(0, 2) + '*'.repeat(Math.max(1, a.length - 2))) + '@' + d;
  }
  if (/^\d{11}$/.test(s)) return s.slice(0, 3) + '****' + s.slice(-4);
  return s.length <= 2 ? s[0] + '*' : s.slice(0, 2) + '***';
};
const acctType = (s) => (s && s.includes('@') ? '邮箱' : /^\d{11}$/.test(s) ? '手机号' : '其他');

out.users = all(
  `SELECT id, nickname, gender, login_account, mbti_self, mbti_edit_count,
          created_at, updated_at, last_login_at, banned, reg_ip IS NOT NULL AS has_ip
     FROM users ORDER BY id`
).map((u) => ({
  id: u.id,
  nickname: u.nickname,
  gender: u.gender,
  account_masked: mask(u.login_account),
  account_type: acctType(u.login_account),
  mbti_self: u.mbti_self || '',
  mbti_edit_count: u.mbti_edit_count,
  created_at: u.created_at,
  last_login_at: u.last_login_at || '',
  banned: u.banned,
}));

// ---------- 评价 ----------
const vWhere = out.vote_has_invalid ? 'WHERE v.invalid = 0' : '';
out.votes = all(
  `SELECT v.id, v.target_user_id, u.nickname AS target_nickname, u.gender AS target_gender,
          v.voter_nickname, v.voter_user_id, v.axis_ie, v.axis_ns, v.axis_tf, v.axis_pj,
          v.result_mbti, v.created_at${out.vote_has_invalid ? ', v.invalid' : ', 0 AS invalid'}
     FROM votes v JOIN users u ON u.id = v.target_user_id
    ORDER BY v.id`
).map((v) => ({
  id: v.id,
  target_user_id: v.target_user_id,
  target_nickname: v.target_nickname,
  voter_nickname: v.voter_nickname,
  voter_registered: v.voter_user_id ? '已注册' : '匿名',
  axis_ie: v.axis_ie, axis_ns: v.axis_ns, axis_tf: v.axis_tf, axis_pj: v.axis_pj,
  result_mbti: v.result_mbti,
  created_at: v.created_at,
  invalid: v.invalid,
}));

// 有效/失效拆分
out.votes_total_rows = one('SELECT COUNT(*) AS n FROM votes').n;
out.votes_valid = out.votes.filter((v) => !v.invalid).length;
out.votes_invalid = out.votes.filter((v) => v.invalid).length;

// ---------- 每人的汇总（复刻 computeSummary：按轴多数，票数持平取本人自我认知） ----------
const AXES = [
  { key: 'ie', col: 'axis_ie', a: 'I', b: 'E', selfIdx: 0 },
  { key: 'ns', col: 'axis_ns', a: 'N', b: 'S', selfIdx: 1 },
  { key: 'tf', col: 'axis_tf', a: 'T', b: 'F', selfIdx: 2 },
  { key: 'pj', col: 'axis_pj', a: 'P', b: 'J', selfIdx: 3 },
];
out.user_summary = out.users.map((u) => {
  const mine = out.votes.filter((v) => v.target_user_id === u.id && !v.invalid);
  const self = u.mbti_self || '';
  const letters = {};
  const detail = [];
  for (const ax of AXES) {
    let na = 0, nb = 0;
    for (const v of mine) {
      if (v[ax.col] === ax.a) na++;
      else if (v[ax.col] === ax.b) nb++;
    }
    let pick = '';
    let note = '';
    if (na === 0 && nb === 0) { pick = ''; note = '无有效票'; }
    else if (na > nb) { pick = ax.a; }
    else if (nb > na) { pick = ax.b; }
    else {
      pick = self ? self[ax.selfIdx] : ax.a;
      note = '票数持平，取本人自我认知';
    }
    letters[ax.key] = pick;
    detail.push({ axis: ax.a + '/' + ax.b, [ax.a]: na, [ax.b]: nb, 判定: pick || '—', 说明: note });
  }
  const consensus = (letters.ie && letters.ns && letters.tf && letters.pj)
    ? letters.ie + letters.ns + letters.tf + letters.pj : '';
  return {
    用户ID: u.id,
    昵称: u.nickname,
    性别: u.gender === 'unset' ? '未填' : u.gender === 'male' ? '男' : u.gender === 'female' ? '女' : '其他',
    自我认知MBTI: self || '未填',
    大家认为MBTI: consensus || '票数不足',
    是否一致: self && consensus ? (self === consensus ? '一致' : '不一致') : '—',
    有效票数: mine.length,
    投票人数_去重: new Set(mine.map((v) => v.voter_nickname)).size,
    注册时间: u.created_at,
    最近登录: u.last_login_at,
    账号: u.account_masked,
    账号类型: u.account_type,
    改签次数: u.mbti_edit_count,
    轴明细: detail,
  };
});

// ---------- 分布 ----------
const bucket = (arr, f) => {
  const m = new Map();
  for (const x of arr) { const k = f(x); if (k === null || k === undefined || k === '') continue; m.set(k, (m.get(k) || 0) + 1); }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
};
out.dist = {
  注册日: bucket(out.users, (u) => String(u.created_at).slice(0, 10)),
  性別: bucket(out.users, (u) => (u.gender === 'unset' ? '未填' : u.gender)),
  自我认知MBTI: bucket(out.users, (u) => u.mbti_self || '未填'),
  被评价结果MBTI: bucket(out.votes.filter((v) => !v.invalid), (v) => v.result_mbti),
  投票日: bucket(out.votes.filter((v) => !v.invalid), (v) => String(v.created_at).slice(0, 10)),
  评价人身份: bucket(out.votes.filter((v) => !v.invalid), (v) => v.voter_registered),
};
out.axis_totals = {};
for (const ax of AXES) {
  const vs = out.votes.filter((v) => !v.invalid);
  out.axis_totals[ax.a + '/' + ax.b] = bucket(vs, (v) => v[ax.col]);
}
out.hot = {
  被投票最多: out.user_summary.slice().sort((a, b) => b.有效票数 - a.有效票数).map((u) => ({
    昵称: u.昵称, 有效票数: u.有效票数, 大家认为MBTI: u.大家认为MBTI, 自我认知MBTI: u.自我认知MBTI,
  })),
  未收到票的用户: out.users.filter((u) => !out.votes.some((v) => v.target_user_id === u.id && !v.invalid))
    .map((u) => u.nickname),
};

console.log(JSON.stringify(out, null, 1));
