/* 在不启动启动器的情况下校验 Vue 组件模板：
 *   1. 用 @vue/compiler-dom 编译 template，捕获模板语法错误；
 *   2. 用 @vue/server-renderer 真渲染一次，捕获运行期才暴露的错误（如未定义组件/指令）。
 * 组件若在加载期依赖别的脚本（如 FRP 页依赖 js/app/frp-bridge.js 提供的全局对象），
 * 用 --preload 先灌进去，可重复：
 *   node scripts/check-vue-template.mjs frontend/js/vue/page-lan-sakura.js \
 *        --preload frontend/js/app/frp-bridge.js
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { parse } from '@vue/compiler-dom';
import * as VueRuntime from 'vue';
import { createSSRApp } from 'vue';
import { renderToString } from '@vue/server-renderer';

const argv = process.argv.slice(2);
const preloads = argv.filter((a) => a.startsWith('--preload=')).map((a) => a.slice('--preload='.length));
const target = argv.find((a) => !a.startsWith('--'));
if (!target) {
  console.error('用法：node scripts/check-vue-template.mjs <page-*.js> [--preload <dep.js>]');
  process.exit(2);
}

// 极简 DOM/global 垫片：组件文件只在加载期访问 window / document
const sandbox = {
  window: {},
  document: {
    addEventListener() {},
    getElementById() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  },
  localStorage: { getItem() { return null; }, setItem() {} },
  console,
  setTimeout,
  clearTimeout,
  // 组件文件在加载期可能起轮询（page-home.js 用它刷新运行时长），
  // 这里给空实现，避免沙箱里抛未定义 + 让进程被定时器吊住。
  setInterval() { return 0; },
  clearInterval() {},
};
sandbox.globalThis = sandbox;
sandbox.window.document = sandbox.document;
sandbox.window.localStorage = sandbox.localStorage;
sandbox.window.VersePC = {};
// 浏览器里由 js/vue.global.prod.js 提供全局 Vue；部分组件文件在加载期就会用
// （例如 page-home.js 的 Vue.reactive），沙箱必须补上，否则直接 ReferenceError。
sandbox.Vue = VueRuntime;
sandbox.window.Vue = VueRuntime;

const ctx = vm.createContext(sandbox);
// 依赖脚本必须先于目标组件执行（浏览器里是 index.html 的 script 顺序保证的）
for (const p of preloads) {
  vm.runInContext(readFileSync(p, 'utf8'), ctx, { filename: p });
  console.log(`· 已预载依赖：${p}`);
}
vm.runInContext(readFileSync(target, 'utf8'), ctx, { filename: target });

const reg = sandbox.window.VersePC;
const name = Object.keys(reg).find((k) => k.startsWith('Page'));
if (!name) {
  console.error('✗ 未在 window.VersePC 上找到 Page* 组件');
  process.exit(1);
}
const comp = reg[name];
console.log(`组件：${name}`);

let fatal = 0;

// 1) 模板编译
const errs = [];
const warns = [];
parse(comp.template, {
  onError: (e) => errs.push(e),
  onWarn: (e) => warns.push(e),
});
if (errs.length) {
  fatal++;
  console.error('✗ 模板编译报错：');
  for (const e of errs) console.error('   -', e.message || e);
} else {
  console.log('✓ 模板编译通过');
}
if (warns.length) {
  console.warn('⚠ 模板警告：');
  for (const e of warns) console.warn('   -', e.message || e);
}

// 2) 关键选择器自查（按文件名配置；未配置的文件自动跳过）
//    目的：防止模板被改坏、元素被误删，而逻辑层还在按旧 id / class 查找
const SELECTOR_CHECKS = {
  // 2026-09-19：V 岛及其 AI 配置卡片已整块删除（AI 设置移入 Verse 助手页），
  // 旧的 ai-provider / vIsland 等预期随之移除。
  'page-settings-other.js': [
    'id="setting-download-source"', 'id="setting-version-source"',
    'id="setting-max-threads"', 'id="setting-enable-chunk-download"',
  ],
  // assistant.js / page-assistant.js 通过类名与 ref 协作，这里同步守住
  'page-assistant.js': [
    'va-shell', 'va-side', 'va-convo-list', 'va-head', 'va-scroll',
    'va-welcome', 'va-msgs', 'va-compose', 'va-input', 'va-send',
    'ref="scroll"', 'ref="input"',
  ],
};
const baseName = target.replace(/\\/g, '/').split('/').pop();
const ids = SELECTOR_CHECKS[baseName] || [];
if (!ids.length) {
  console.log('· 未配置关键选择器清单，跳过');
} else {
  const missing = ids.filter((id) => !comp.template.includes(id));
  if (missing.length) {
    fatal++;
    console.error('✗ 模板缺少关键选择器：', missing.join(', '));
  } else {
    console.log('✓ 关键选择器齐全（' + ids.length + ' 个）');
  }
}

// 3) SSR 渲染
try {
  const html = await renderToString(createSSRApp(comp));
  console.log(`✓ SSR 渲染通过（${html.length} 字节）`);
} catch (e) {
  fatal++;
  console.error('✗ SSR 渲染失败：', e.message);
}

process.exit(fatal ? 1 : 0);
