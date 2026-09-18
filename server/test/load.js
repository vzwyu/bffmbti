'use strict';
/**
 * 温和并发压测 —— 只回答两个问题：
 *   1. 并发上来会不会崩（500 / 连接失败 / 服务重启）
 *   2. SQLite 在并发写下会不会锁死（database is locked）
 *
 * ⚠️ 刻意保持克制：最高 60 并发、单轮 15 秒、轮间冷却。
 *    这是正常站点会遇到的真实流量形态，不是流量洪泛。
 *    不动用任何放大攻击手段，避免触发云厂商的 DDoS 防护。
 *
 * 用法：node test/load.js
 */

// 默认打测试环境（独立库）。压测会写入大量账号，绝不能指向生产。
const BASE = process.env.MBTI_TEST_BASE || 'http://127.0.0.1:3001/games/mbti-test/api';

if (/oictech\.cn/.test(BASE) && !process.env.MBTI_ALLOW_PROD) {
  console.error('\n⛔ 拒绝对生产环境压测：它会写入大量真实账号并占用线上资源。');
  console.error('   设置 MBTI_ALLOW_PROD=1 可强行运行（不建议）。\n');
  process.exit(2);
}

const LEVELS = [10, 30, 60];     // 并发档位：低 → 中 → 高
const PER_LEVEL_MS = 15000;      // 每档持续
const COOLDOWN_MS = 4000;        // 档间冷却，让服务器喘口气

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = () => Math.floor(Math.random() * 1e9).toString(36);

/** 单个请求，返回 { ok, status, ms, err } —— 绝不抛异常 */
async function once(method, path, body, cookie) {
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (cookie) headers.Cookie = cookie;
    const res = await fetch(BASE + path, {
      method, headers, signal: ctrl.signal,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    await res.arrayBuffer();   // 读干净，避免连接悬挂
    return { ok: res.status < 500, status: res.status, ms: Date.now() - t0, err: null };
  } catch (e) {
    return { ok: false, status: 0, ms: Date.now() - t0, err: e.name || 'Error' };
  } finally {
    clearTimeout(timer);
  }
}

/** 在给定并发下持续打请求，返回统计。
 *  makeReq(id) 返回 [method, path, body?] —— 方法由每次请求自己决定，
 *  不能整个场景写死（否则带 body 的 GET 会被 undici 直接拒绝）。 */
async function hammer(name, concurrency, durationMs, makeReq) {
  const stats = { n: 0, ok: 0, e5xx: 0, e4xx: 0, fail: 0, lat: [], codes: {} };
  const deadline = Date.now() + durationMs;

  async function worker(id) {
    while (Date.now() < deadline) {
      const [m, p, b] = makeReq(id);
      const r = await once(m, p, b);
      stats.n++;
      stats.lat.push(r.ms);
      if (r.status >= 500) stats.e5xx++;
      else if (r.status >= 400) stats.e4xx++;
      else if (r.status > 0) stats.ok++;
      else stats.fail++;
      stats.codes[r.status] = (stats.codes[r.status] || 0) + 1;
    }
  }

  await Promise.all(Array.from({ length: concurrency }, (_, i) => worker(i)));

  stats.lat.sort((a, b) => a - b);
  const pct = (p) => stats.lat[Math.min(stats.lat.length - 1, Math.floor(stats.lat.length * p))] || 0;
  const avg = stats.lat.reduce((a, b) => a + b, 0) / (stats.lat.length || 1);
  const qps = stats.n / (durationMs / 1000);

  console.log(
    '  ' + name.padEnd(22) +
    ' 并发 ' + String(concurrency).padStart(2) +
    ' | 请求 ' + String(stats.n).padStart(5) +
    ' | ' + qps.toFixed(1).padStart(5) + ' req/s' +
    ' | 均 ' + avg.toFixed(0).padStart(4) + 'ms' +
    ' P95 ' + pct(0.95).toFixed(0).padStart(4) + 'ms' +
    ' P99 ' + pct(0.99).toFixed(0).padStart(4) + 'ms' +
    ' | 2xx ' + stats.ok + ' 4xx ' + stats.e4xx + ' 5xx ' + stats.e5xx + ' 失败 ' + stats.fail
  );
  if (Object.keys(stats.codes).length) {
    console.log('     状态码分布: ' + JSON.stringify(stats.codes));
  }
  return stats;
}

(async function main() {
  console.log('\n══════ 温和并发压测 ══════');
  console.log('目标: ' + BASE);
  console.log('最高并发 60，单档 15 秒，档间冷却 4 秒 —— 模拟真实流量峰值，不是攻击\n');

  // 准备一个可被公开读取的目标
  const acc = 'load' + rnd() + '@test.com';
  const reg = await fetch(BASE + '/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nickname: '压测用户', account: acc, password: '3729' })
  });
  const regBody = await reg.json();
  if (reg.status !== 201) { console.error('准备失败:', reg.status, regBody); process.exit(1); }
  const token = regBody.share_token;
  await fetch(BASE + '/me/mbti', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: (reg.headers.getSetCookie() || []).map((c) => c.split(';')[0]).join('; ')
    },
    body: JSON.stringify({ mbti: 'INTJ' })
  });
  console.log('  已准备测试目标 token=' + token + '\n');

  const results = [];

  // ---- 场景 1：纯读（最典型的公开流量）----
  console.log('▸ 场景 1：汇总接口读取（GET /summary）');
  for (const c of LEVELS) {
    const s = await hammer('读 /summary', c, PER_LEVEL_MS,
      () => ['GET', '/u/' + token + '/summary']);
    results.push({ name: '读', c, s });
    await sleep(COOLDOWN_MS);
  }

  // ---- 场景 2：混合读写 ----
  console.log('\n▸ 场景 2：混合负载（80% 读 + 20% 写）');
  for (const c of [10, 30]) {
    let counter = 0;
    const s = await hammer('混合读写', c, PER_LEVEL_MS, (id) => {
      counter++;
      // 每 5 次夹一次写；写用独立账号，避开 30 秒重复节流
      if (counter % 5 === 0) {
        return ['POST', '/auth/register', {
          nickname: 'p' + id + '_' + counter,
          account: 'p' + rnd() + '@t.com',
          password: '8361'
        }];
      }
      return ['GET', '/u/' + token + '/summary'];
    });
    results.push({ name: '混合', c, s });
    await sleep(COOLDOWN_MS);
  }

  // ---- 场景 3：写密集（检验 SQLite 并发写是否锁死）----
  console.log('\n▸ 场景 3：写密集（并发注册，检验 SQLite 写锁）');
  {
    const c = 20;
    const s = await hammer('注册写入', c, 10000,
      (id) => ['POST', '/auth/register', {
        nickname: 'w' + id,
        account: 'w' + rnd() + '@test.com',
        password: '8361'
      }]);
    results.push({ name: '写', c, s });
  }

  // ---- 服务端状态检查 ----
  console.log('\n▸ 压测后健康检查');
  await sleep(2000);
  const h = await once('GET', '/health');
  console.log('  /health → ' + h.status + ' (' + h.ms + 'ms)');

  const agg = {
    n: results.reduce((a, r) => a + r.s.n, 0),
    e5xx: results.reduce((a, r) => a + r.s.e5xx, 0),
    fail: results.reduce((a, r) => a + r.s.fail, 0)
  };
  console.log('\n══════ 汇总 ══════');
  console.log('  总请求 ' + agg.n + '  5xx ' + agg.e5xx + '  连接失败 ' + agg.fail);
  const verdict = (agg.e5xx === 0 && agg.fail === 0 && h.status === 200)
    ? '✅ 未崩溃，服务健康'
    : '❌ 出现异常，需要排查';
  console.log('  ' + verdict);
  console.log('═════════════════\n');
  process.exit(agg.e5xx === 0 && agg.fail === 0 ? 0 : 1);
})().catch((e) => { console.error('压测脚本异常:', e); process.exit(2); });
