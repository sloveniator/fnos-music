#!/usr/bin/env node
/**
 * 歌词时间轴对齐契约测试（1.0.35）
 *
 * 2026-09-17 主人：「歌词和播放进程没对齐」。
 * 根因在 ui/app/assets/app.js 的 parseLrc：分钟×60 + 秒 得到的是**秒**，
 * 却把小数部分 `Number('0.'+m[3]) * 1000` 当**毫秒**加了进去。于是任何带小数
 * 的时间标签都被放大上千倍，而且按这个假时间排序会把整篇歌词打乱。
 *
 * 这个测试**不复制**函数体：它从 app.js 里把 parseLrc 抠出来在 node 里跑，
 * 测的就是真正要打包上线的那段源码（复制一份就等于测我自己的抄写）。
 *
 * 用法：node tools/test-lyric-align.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = path.join(root, 'ui/app/assets/app.js');

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ← ' + extra : '')); }
};

// ---------- 从 app.js 抠出 parseLrc（按大括号配平，不用正则猜结尾） ----------
const src = fs.readFileSync(APP, 'utf8');
function extractFn(name) {
  const at = src.indexOf('function ' + name + '(');
  if (at < 0) return null;
  const open = src.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (!depth) return src.slice(at, i + 1); }
  }
  return null;
}
const fnSrc = extractFn('parseLrc');
check('从 app.js 抠到 parseLrc（测的是要上线的那段源码）',
      !!fnSrc && /lines\.push/.test(fnSrc), fnSrc ? fnSrc.split('\n')[0] : 'not found');
if (!fnSrc) { console.log('\n== %d passed, %d failed ==', pass, fail); process.exit(1); }

const parseLrc = new Function(fnSrc + '; return parseLrc;')();

// ---------- 单位：时间戳必须与 audio.currentTime 同为「秒」 ----------
const one = (lrc) => parseLrc(lrc).map(x => x.t);
const eq = (a, b) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < 1e-6);

check('[00:12.50] → 12.5 秒（不是 512）', eq(one('[00:12.50]一句'), [12.5]), JSON.stringify(one('[00:12.50]一句')));
check('[01:02.00] → 62 秒', eq(one('[01:02.00]一句'), [62]), JSON.stringify(one('[01:02.00]一句')));
check('[01:20.75] → 80.75 秒', eq(one('[01:20.75]一句'), [80.75]), JSON.stringify(one('[01:20.75]一句')));
check('[00:05.5] → 5.5 秒（一位小数＝百毫秒）', eq(one('[00:05.5]一句'), [5.5]), JSON.stringify(one('[00:05.5]一句')));
check('[00:05.05] → 5.05 秒（两位小数里的 05 是 50 毫秒，不是 500）',
      eq(one('[00:05.05]一句'), [5.05]), JSON.stringify(one('[00:05.05]一句')));
check('[00:05.005] → 5.005 秒（三位小数＝毫秒）', eq(one('[00:05.005]一句'), [5.005]), JSON.stringify(one('[00:05.005]一句')));
check('[00:05:20] 冒号分隔的老写法同样成立', eq(one('[00:05:20]一句'), [5.2]), JSON.stringify(one('[00:05:20]一句')));
check('一行多标签展开成多行、各自独立计时',
      eq(one('[00:10.00][01:00.50]副歌'), [10, 60.5]), JSON.stringify(one('[00:10.00][01:00.50]副歌')));
check('无时间标签的元信息行（作词/作曲）被丢弃', parseLrc('[ar:某人]\n[00:10.00]正文').length === 1);

// ---------- 排序：假时间会让整篇乱序，这是「对不上」最直观的一面 ----------
const SONG = [
  '[00:00.00]前奏',
  '[00:12.50]第一句',
  '[00:15.35]第二句',
  '[01:02.00]第三句',
  '[01:20.75]第四句',
  '[02:03.40]尾声',
].join('\n');
const lines = parseLrc(SONG);
check('六行按真实时间升序（浅淡 → 逐行点亮，不乱跳）',
      eq(lines.map(l => l.t), [0, 12.5, 15.35, 62, 80.75, 123.4]),
      JSON.stringify(lines.map(l => l.t)));
check('行序与歌词原文一致（不是被假时间重排过的顺序）',
      lines.map(l => l.text).join('|') === '前奏|第一句|第二句|第三句|第四句|尾声',
      lines.map(l => l.text).join('|'));

// ---------- 高亮判定：复刻 syncLyric 的选行规则，验证「哪个时间点亮哪一行」 ----------
const activeAt = (ls, t) => { let idx = -1; for (let i = 0; i < ls.length; i++) { if (ls[i].t <= t + 0.2) idx = i; else break; } return idx; };
check('t=0.0s    → 第 0 行（前奏）', activeAt(lines, 0) === 0);
check('t=5.0s    → 仍第 0 行', activeAt(lines, 5) === 0);
check('t=12.5s   → 第 1 行（第一句）', activeAt(lines, 12.5) === 1);
check('t=14.0s   → 第 1 行；t=15.2s → 第 2 行（提前 200ms 起亮）',
      activeAt(lines, 14) === 1 && activeAt(lines, 15.2) === 2, `${activeAt(lines, 14)} / ${activeAt(lines, 15.2)}`);
check('t=62.0s   → 第 3 行（第三句，不是被 [00:12.50] 顶掉的某行）', activeAt(lines, 62) === 3, String(activeAt(lines, 62)));
check('t=123.4s  → 第 5 行（尾声）', activeAt(lines, 123.4) === 5);
check('t 超过最后一行 → 停在最后一行不越界', activeAt(lines, 999) === 5);
check('第一行之前（t=-1，加载中的 currentTime 可能为负）→ 无高亮', activeAt(lines, -1) === -1);

// ---------- 与「进度百分比」对齐：60% 的进度必须落在那条时间轴上 ----------
const dur = 180;
const at60 = activeAt(lines, dur * 0.6);
check('180s 的曲子 60%（108s）落在第 4 行（80.75s 起，第四句）', at60 === 4, String(at60));

console.log('\n== %d passed, %d failed ==', pass, fail);
process.exit(fail ? 1 : 0);
