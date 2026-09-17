#!/usr/bin/env node
/**
 * 「为你推荐」目标量契约测试（1.0.33：每份 35 首）
 *
 * 为什么这么测：本机没有任何在线的汽水/酷狗账号，真实在线源打不了。所以只把
 * **网络边界**（onlineSources / onlineSearch）换成假响应，其余全走真实实现 ——
 * 口味画像、本地挑选、跨卡片去重、交错、单歌手上限、当天确定性都是真代码在跑。
 * 真机（NAS 上配了在线源）的最终观感仍以用户侧为准，这里只证明「凑到 35」的逻辑成立。
 *
 * 用法：node tools/test-foryou-target.mjs
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = (p) => require(path.join(root, 'server/server', p));

// 服务端模块在 load 期就会读 global.lx（dataPath/config），平时由 server/server/index.js
// 的启动流程填好。这里不进 HTTP 服务，只把最小骨架补上，数据目录用临时目录，
// 不碰真实实例的 data/。
import fs from 'node:fs';
const tmp = '/tmp/foryou-harness';
fs.mkdirSync(tmp + '/data/users', { recursive: true });
fs.mkdirSync(tmp + '/logs', { recursive: true });
const File = load('constants.js').File;
globalThis.lx = {
  logPath: tmp + '/logs',
  dataPath: tmp + '/data',
  userPath: tmp + '/data/' + File.userDir,
  config: { ...load('defaultConfig.js').default, users: [] },
  listenPort: 19527,
};

const forYouMod = load('library/for-you.js');
const tenant = load('library/tenant.js');
const playlists = load('web/playlists.js');
const online = load('online/index.js');

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ← ' + extra : '')); }
};

// ---------- 夹具：20 位歌手 × 3 首 = 60 首本地曲目 ----------
const SINGERS = Array.from({ length: 20 }, (_, i) => '测试歌手' + String.fromCharCode(97 + i));
const local = [];
for (const s of SINGERS) {
  for (let k = 1; k <= 3; k++) {
    local.push({
      id: 'L' + local.length, relPath: `${s}/${s}-${k}.mp3`, ext: 'mp3', size: 100000 + local.length,
      mtime: 1700000000000 + local.length, name: `${s} 作品${k}`, singer: s, album: s + ' 专辑',
      trackNum: k, year: 2024, interval: '3:00', hasCover: false,
    });
  }
}
// 播放历史：9 位歌手各一首（数组「最近在前」），前 6 首会被「今日推荐」跳过
const history = SINGERS.slice(0, 9).map((s, i) => ({ ...local[i * 3], id: 'P' + i, singer: s, name: `${s} 作品1` }));

// ---------- 打桩：只换掉网络边界 ----------
const real = {
  getTenantTracks: tenant.getTenantTracks,
  getPlayed: playlists.getPlayed,
  getPlayedOnline: playlists.getPlayedOnline,
  onlineSources: online.onlineSources,
  onlineSearch: online.onlineSearch,
};
let searchCalls = 0;
const stubOnline = () => {
  online.onlineSources = () => [{ id: 'kw', name: '酷狗', enabled: true }];
  online.onlineSearch = async (_source, query) => {
    searchCalls++;
    return { list: Array.from({ length: 20 }, (_, i) => ({
      id: `${query}#${i}`, name: `${query} 新歌${i}`, singer: query, album: query + ' 新碟',
      intervalMs: 180000, pic: 'https://example.invalid/' + i + '.jpg',
    })) };
  };
};
const stubNoOnline = () => {
  online.onlineSources = () => [];
  online.onlineSearch = async () => ({ list: [] });
};
const wire = (tracks, played) => {
  tenant.getTenantTracks = () => tracks;
  playlists.getPlayed = () => played;
  playlists.getPlayedOnline = () => [];
};

const keys = (tracks) => tracks.map((t) => (t.name || '') + '|' + (t.singer || ''));
const onlineKeys = (tracks) => tracks.filter((t) => t.kind === 'online').map((t) => (t.name || '') + '|' + (t.singer || ''));

const main = async () => {
  console.log('\n— 1. 在线源可用：两份都凑满 35 —');
  stubOnline();
  wire(local, history);
  forYouMod.dropForYouCache();
  const a = await forYouMod.forYou('t35-full');
  check('今日推荐 = 35 首', a.daily.tracks.length === 35, 'n=' + a.daily.tracks.length);
  check('今日推荐 本地 20 + 在线 15 恰好填满', a.daily.localCount === 20 && a.daily.onlineCount === 15,
        `local=${a.daily.localCount} online=${a.daily.onlineCount}`);
  check('猜你喜欢 = 35 首', a.guess.tracks.length === 35, 'n=' + a.guess.tracks.length);
  check('猜你喜欢 本地 14 + 在线 21 恰好填满', a.guess.localCount === 14 && a.guess.onlineCount === 21,
        `local=${a.guess.localCount} online=${a.guess.onlineCount}`);

  console.log('\n— 2. 不重复、不超上限、交替排列 —');
  for (const [label, card] of [['今日推荐', a.daily], ['猜你喜欢', a.guess]]) {
    const k = keys(card.tracks);
    check(`${label} 内无重复曲目`, new Set(k).size === k.length, `unique=${new Set(k).size}/${k.length}`);
    const bySinger = {};
    for (const t of card.tracks.filter((x) => x.kind === 'online')) bySinger[t.singer] = (bySinger[t.singer] || 0) + 1;
    const worst = Math.max(0, ...Object.values(bySinger));
    check(`${label} 单歌手在线曲目 ≤ 4`, worst <= 4, 'max=' + worst);
    const local1 = card.tracks.findIndex((t) => t.kind !== 'online');
    const online1 = card.tracks.findIndex((t) => t.kind === 'online');
    check(`${label} 本地与在线交错（不是先全本地后全在线）`,
          local1 === -1 || online1 === -1 || Math.abs(local1 - online1) === 1,
          `firstLocal=${local1} firstOnline=${online1}`);
    check(`${label} 在线行带来源与封面字段`,
          card.tracks.filter((t) => t.kind === 'online').every((t) => t.source && t.id),
          JSON.stringify(card.tracks.find((t) => t.kind === 'online') || {}).slice(0, 90));
  }
  const cross = new Set(onlineKeys(a.daily.tracks));
  const dup = onlineKeys(a.guess.tracks).filter((k) => cross.has(k));
  check('两张卡片之间在线歌不重复', dup.length === 0, 'dup=' + dup.slice(0, 3).join(','));

  console.log('\n— 3. 同一账户同一天：结果稳定（可缓存、不会刷新一次换一批） —');
  forYouMod.dropForYouCache();
  const b = await forYouMod.forYou('t35-full');
  check('今日推荐当天两次调用顺序完全一致', keys(b.daily.tracks).join(',') === keys(a.daily.tracks).join(','),
        'first=' + keys(a.daily.tracks)[0] + ' second=' + keys(b.daily.tracks)[0]);
  check('猜你喜欢当天两次调用顺序完全一致', keys(b.guess.tracks).join(',') === keys(a.guess.tracks).join(','));

  console.log('\n— 4. 换账户换种子（不是所有人同一份顺序） —');
  wire(local, history.map((t, i) => ({ ...t, singer: SINGERS[8 - (i % 9)], })));
  forYouMod.dropForYouCache();
  const c = await forYouMod.forYou('t35-other');
  check('不同账户的今日推荐顺序不同', keys(c.daily.tracks).join(',') !== keys(a.daily.tracks).join(','));

  console.log('\n— 5. 在线源不可用 / 冷启动：不打第三方，也不崩 —');
  stubNoOnline();
  wire(local, history);
  forYouMod.dropForYouCache();
  const d = await forYouMod.forYou('t35-noonline');
  check('没有可用在线源时今日推荐只出本地（20 首）',
        d.daily.tracks.length === 20 && d.daily.onlineCount === 0,
        `n=${d.daily.tracks.length} online=${d.daily.onlineCount}`);
  check('没有可用在线源时猜你喜欢只出本地（14 首）',
        d.guess.tracks.length === 14 && d.guess.onlineCount === 0,
        `n=${d.guess.tracks.length} online=${d.guess.onlineCount}`);

  stubOnline();
  wire(local, []);
  forYouMod.dropForYouCache();
  const before = searchCalls;
  const e = await forYouMod.forYou('t35-cold');
  check('冷启动（无播放历史）不去打在线源', searchCalls === before, `calls=${searchCalls - before}`);
  check('冷启动文案仍是「还不太了解你的口味」', e.daily.reason.includes('还不太了解你的口味'), e.daily.reason);
  check('冷启动在线数为 0', e.daily.onlineCount === 0 && e.guess.onlineCount === 0);

  console.log('\n— 6. 口味面很窄（画像只有 3 位歌手）：尽量凑，但不硬凑 —');
  stubOnline();
  const narrow = SINGERS.slice(0, 3).flatMap((s) => local.filter((t) => t.singer === s));
  wire(narrow, [narrow[0], narrow[3], narrow[6]]);  // 每位歌手各一首播放历史（画像才认得出 3 位）
  forYouMod.dropForYouCache();
  const f = await forYouMod.forYou('t35-narrow');
  // 本地 3 位 × 2 首 = 6，在线 3 位 × 8 首（放宽后的上限）= 24 → 30 首，到不了 35 就是到不了
  check('口味面窄时按 8 首/歌手放宽（3×8=24 在线）', f.daily.onlineCount === 24, 'online=' + f.daily.onlineCount);
  check('口味面窄时不硬凑到 35（30 首：本地 6 + 在线 24）', f.daily.tracks.length === 30,
        'n=' + f.daily.tracks.length);
  const perS = {};
  for (const t of f.daily.tracks.filter((x) => x.kind === 'online')) perS[t.singer] = (perS[t.singer] || 0) + 1;
  check('单歌手在线最多 8 首（不放宽到无限）', Math.max(0, ...Object.values(perS)) <= 8,
        'max=' + Math.max(0, ...Object.values(perS)));
  check('放宽后仍然没有重复曲目', new Set(keys(f.daily.tracks)).size === f.daily.tracks.length);

  console.log(`\nRESULT ${pass} passed / ${fail} failed`);
  // 还原，别把桩留在 require 缓存里影响同进程后续（本进程本来就是一次性的）
  Object.assign(tenant, { getTenantTracks: real.getTenantTracks });
  Object.assign(playlists, { getPlayed: real.getPlayed, getPlayedOnline: real.getPlayedOnline });
  Object.assign(online, { onlineSources: real.onlineSources, onlineSearch: real.onlineSearch });
  process.exit(fail ? 1 : 0);
};

main().catch((e) => { console.error('harness error:', e); process.exit(2); });
