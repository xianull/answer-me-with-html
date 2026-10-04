import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.js';

let dir;
before(() => { dir = mkdtempSync(join(tmpdir(), 'am-test-')); });
after(() => rmSync(dir, { recursive: true, force: true }));

function sink() {
  let text = '';
  const stream = new Writable({ write(chunk, _enc, cb) { text += chunk; cb(); } });
  return { stream, get text() { return text; } };
}

async function run(args, { stdin = '', env = {} } = {}) {
  const out = sink();
  const err = sink();
  const code = await main(args, {
    stdout: out.stream, stderr: err.stream, stdin: Readable.from([stdin]),
    env: { AM_NO_OPEN: '1', AM_HOME: dir, ...env }, cwd: dir,
  });
  return { code, out: out.text, err: err.text };
}

const GOOD = '---\ntitle: CLI 测试\n---\n## A 流程\n```flow\nA -> B\n```\n';

test('cli: --version 与 --help', async () => {
  assert.match((await run(['--version'])).out, /^\d+\.\d+\.\d+/);
  assert.match((await run([])).out, /用法/);
});

test('cli render: 从 stdin 读取，写入 AM_HOME/pages，打印路径与统计', async () => {
  const r = await run(['render', '-'], { stdin: GOOD });
  assert.equal(r.code, 0, r.err);
  const file = r.out.match(/✓ (.+\.html)/)[1];
  assert.ok(file.startsWith(join(dir, 'pages', 'CLI-测试-')));
  assert.match(readFileSync(file, 'utf8'), /<h1>CLI 测试<\/h1>/);
  assert.match(r.out, /sheet · blueprint · 1 面板 · flow×1/);
  assert.match(r.out, /STE ✓ 0 条警告/);
});

test('cli render: 文件参数 + -o + 主题覆盖', async () => {
  writeFileSync(join(dir, 'in.md'), GOOD);
  const r = await run(['render', 'in.md', '-o', 'out/x.html', '--theme', 'shadcn']);
  assert.equal(r.code, 0, r.err);
  assert.match(readFileSync(join(dir, 'out/x.html'), 'utf8'), /data-theme="shadcn"/);
});

test('cli render: limits 0 / 0 能出页，不挂起', { timeout: 5000 }, async () => {
  const r = await run(['render', '-', '-o', 'zero.html'], { stdin: '## A\n```limits\nx | 0 / 0\n```\n' });
  assert.equal(r.code, 0, r.err);
  assert.match(readFileSync(join(dir, 'zero.html'), 'utf8'), /am-lim/);
});

test('cli render: 组件语法错误 → 绝对行号 + 组件名 + 正确示例，退出码 1', async () => {
  const r = await run(['render', '-'], { stdin: '## A\n文本\n```flow\nA -> B\n(未闭合 -> C\n```' });
  assert.equal(r.code, 1);
  assert.match(r.err, /✗ L5 \[flow\] flow 形状括号未闭合/);
  assert.match(r.err, /正确示例：\n {4}```flow/);
  assert.match(r.err, /am help flow/);
});

test('cli render: 解析错误给出行号', async () => {
  const r = await run(['render', '-'], { stdin: '## A\n```flow\nA -> B' });
  assert.equal(r.code, 1);
  assert.match(r.err, /✗ L2 稿件解析失败：围栏块/);
});

test('cli render: style 80 打印警告但仍生成；strict 拒绝生成', async () => {
  const bad = '## A\nUtilize the tool.';
  const soft = await run(['render', '-'], { stdin: bad });
  assert.equal(soft.code, 0);
  assert.match(soft.out, /STE 1 条警告[\s\S]*L2 \[word\] 不推荐 "Utilize" → use/);

  const before = readdirSync(join(dir, 'pages')).length;
  const strict = await run(['render', '-', '--style', 'strict'], { stdin: bad });
  assert.equal(strict.code, 1);
  assert.match(strict.err, /STE 检查未通过/);
  assert.equal(readdirSync(join(dir, 'pages')).length, before, 'strict 失败时不写文件');
});

test('cli lint: 仅检查；strict 下有警告返回 1；off 跳过', async () => {
  const bad = '## A\nUtilize the tool.';
  assert.equal((await run(['lint', '-'], { stdin: bad })).code, 0);
  assert.equal((await run(['lint', '-', '--style', 'strict'], { stdin: bad })).code, 1);
  assert.match((await run(['lint', '-', '--style', 'off'], { stdin: bad })).out, /已关闭/);
  assert.equal((await run(['lint', '-', '--style', 'x'], { stdin: bad })).code, 2);
});

test('cli list / help', async () => {
  assert.match((await run(['list'])).out, /flow\s+流程图/);
  const h = await run(['help', 'sequence']);
  assert.match(h.out, /sequence — 时序图[\s\S]*示例：\n```sequence/);
  assert.match((await run(['help', 'format'])).out, /template: sheet/);
  assert.equal((await run(['help', 'nope'])).code, 2);
});

test('cli: 参数错误与缺失', async () => {
  assert.equal((await run(['bogus'])).code, 2);
  assert.equal((await run(['render'])).code, 2);
  assert.equal((await run(['render', 'missing.md'])).code, 2);
  assert.equal((await run(['render', '-'], { stdin: '   ' })).code, 2);
  assert.equal((await run(['render', '--wat'])).code, 2);
});

test('cli config: 显示全部配置项、当前值与配置文件路径', async () => {
  const r = await run(['config']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /config\.json/);
  for (const key of ['open', 'always', 'theme', 'mode', 'style']) assert.match(r.out, new RegExp(`\\b${key}\\b`));
});

test('cli config: set / get / reset，改过的值带 * 标记', async () => {
  assert.equal((await run(['config', 'set', 'theme', 'shadcn'])).code, 0);
  assert.equal((await run(['config', 'get', 'theme'])).out.trim(), 'shadcn');
  assert.match((await run(['config'])).out, /\* theme\s+shadcn/);
  const rendered = await run(['render', '-', '-o', 'cfg.html'], { stdin: '## A\nx' });
  assert.match(readFileSync(join(dir, 'cfg.html'), 'utf8'), /data-theme="shadcn"/, 'render 读取配置里的默认主题');
  assert.equal(rendered.code, 0);
  assert.equal((await run(['config', 'reset', 'theme'])).code, 0);
  assert.equal((await run(['config', 'get', 'theme'])).out.trim(), 'blueprint');
});

test('cli config: 布尔值输出 on/off；非法键或值返回 2', async () => {
  await run(['config', 'set', 'open', 'off']);
  assert.equal((await run(['config', 'get', 'open'])).out.trim(), 'off');
  await run(['config', 'reset']);
  const bad = await run(['config', 'set', 'theme', 'neon']);
  assert.equal(bad.code, 2);
  assert.match(bad.err, /blueprint \| shadcn/);
  assert.equal((await run(['config', 'set', 'nope', '1'])).code, 2);
  assert.equal((await run(['config', 'frob'])).code, 2);
});

test('shouldOpen: --no-open > AM_NO_OPEN > 配置 open；--open 强制打开', async () => {
  const { shouldOpen } = await import('../src/cli.js');
  assert.equal(shouldOpen({}, {}, { open: true }), true);
  assert.equal(shouldOpen({}, {}, { open: false }), false);
  assert.equal(shouldOpen({ 'no-open': true }, {}, { open: true }), false);
  assert.equal(shouldOpen({}, { AM_NO_OPEN: '1' }, { open: true }), false);
  assert.equal(shouldOpen({}, { AM_NO_OPEN: '0' }, { open: true }), true, 'AM_NO_OPEN=0 不算关闭');
  assert.equal(shouldOpen({}, { CI: 'true' }, { open: true }), false);
  assert.equal(shouldOpen({ open: true }, { AM_NO_OPEN: '1' }, { open: false }), true);
});
