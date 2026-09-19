// scripts/dev-server.mjs — VersePC-CE 开发用「前端热重载服务器」
//
// 用途：配合 dev.bat 使用，让**改前端不再需要重新编译 exe**。
//
// 原理（不是猜的，是 Tauri 2 的实际行为）：
//   tauri/build.rs:  let dev = !has_feature("custom-protocol");
//   manager::get_app_url():
//     #[cfg(dev)]  url = config.build.dev_url            ← 有 devUrl 就用它
//     #[cfg(not(dev))] url = frontendDist(若为 Url)
//   也就是说：
//     · 没有 devUrl（正式 tauri.conf.json）→ 前端资源被编译进 exe，
//       改前端必须 prepare-frontend + cargo build（50~70s）
//     · 有 devUrl（src-tauri/tauri.dev.conf.json 注入）→ 窗口从本服务器实时取资源，
//       改前端只需刷新页面（本脚本已内置自动刷新）
//
// 工作流程：
//   1) 启动时先跑一遍 prepare-frontend.mjs，保证 frontend/ → frontend-tauri/ 结构一致
//   2) 常驻监听 frontend/ 变更，只把"变了的那几个文件"增量同步过去
//   3) 以 http://127.0.0.1:1430 提供静态文件；HTML 注入一段自动刷新脚本，
//      文件一变就通知页面 location.reload()
//
// 单独使用（只起服务器、不开窗口）：
//   node scripts/dev-server.mjs
// 端口默认 1430，可用环境变量 VERSE_DEV_PORT 覆盖。

import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  watch,
} from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');
const SRC_DIR = join(projectRoot, 'frontend');
const OUT_DIR = join(projectRoot, 'frontend-tauri');
const PORT = Number(process.env.VERSE_DEV_PORT || 1430);
const HOST = '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.plist': 'application/xml; charset=utf-8',
};

const IGNORED_DIRS = new Set(['node_modules', '.git', '.vscode', '.idea']);

// ── 1. 首轮全量同步 ───────────────────────────────────────────────
log('首轮同步 frontend/ → frontend-tauri/ ...');
try {
  execFileSync(process.execPath, [join(__dirname, 'prepare-frontend.mjs')], {
    cwd: projectRoot,
    stdio: 'inherit',
  });
} catch (e) {
  log(`prepare-frontend 执行失败：${e.message}`);
  process.exit(1);
}

// ── 2. 增量同步工具 ───────────────────────────────────────────────
function syncOne(rel) {
  const from = join(SRC_DIR, rel);
  const to = join(OUT_DIR, rel);
  try {
    if (existsSync(from)) {
      const st = statSync(from);
      if (st.isDirectory()) {
        cpSync(from, to, {
          recursive: true,
          filter: (p) =>
            !p.split(sep).some((seg) => IGNORED_DIRS.has(seg)),
        });
      } else {
        mkdirSync(dirname(to), { recursive: true });
        copyFileSync(from, to);
      }
    } else if (existsSync(to)) {
      rmSync(to, { recursive: true, force: true });
    }
  } catch (e) {
    log(`同步失败 ${rel}：${e.message}`);
  }
}

// ── 3. 热重载广播（SSE） ──────────────────────────────────────────
const sseClients = new Set();

function broadcastReload() {
  for (const res of sseClients) {
    try {
      res.write('data: reload\n\n');
    } catch {
      sseClients.delete(res);
    }
  }
}

let reloadTimer = null;
function scheduleReload() {
  if (reloadTimer) clearTimeout(reloadTimer);
  reloadTimer = setTimeout(broadcastReload, 60);
}

// ── 4. 监听 frontend/ 变更 ────────────────────────────────────────
const pending = new Set();
let flushTimer = null;

function flushPending() {
  const list = [...pending];
  pending.clear();
  for (const rel of list) syncOne(rel);
  if (list.length) {
    log(`已同步 ${list.length} 项：${list.slice(0, 4).join(', ')}${list.length > 4 ? ' …' : ''}`);
    scheduleReload();
  }
}

let watcher = null;
try {
  watcher = watch(SRC_DIR, { recursive: true }, (_event, filename) => {
    if (!filename) {
      pending.add('.');
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = setTimeout(flushPending, 120);
      return;
    }
    const rel = String(filename).split(/[\\/]/).filter(Boolean).join(sep);
    if (!rel) return;
    if (rel.split(sep).some((seg) => IGNORED_DIRS.has(seg))) return;
    pending.add(rel);
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(flushPending, 90);
  });
} catch (e) {
  log(`警告：无法监听 frontend/ 变更（${e.message}），改动后请在窗口按 Ctrl+R 手动刷新`);
}

// ── 5. 静态服务 ───────────────────────────────────────────────────
const RELOAD_SNIPPET = `<script data-verse-dev-reload>
(function(){try{var es=new EventSource('/__dev_reload');es.onmessage=function(e){if(e.data==='reload')location.reload();};}catch(_){}})();
</script>`;

function send404(res, rel) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(`404 Not Found: ${rel}`);
}

function resolveRequestPath(rawUrl) {
  let pathname = rawUrl.split('#')[0].split('?')[0];
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    /* 保留原样 */
  }
  let rel = pathname.replace(/^\/+/, '');
  if (rel === '') rel = 'index.html';
  const full = resolve(OUT_DIR, rel);
  // 目录穿越保护
  if (full !== OUT_DIR && !full.startsWith(OUT_DIR + sep)) return null;
  return { rel, full };
}

const server = createServer((req, res) => {
  const url = req.url || '/';

  // SSE：热重载通道
  if (url.split('?')[0] === '/__dev_reload') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    sseClients.add(res);
    const ping = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        clearInterval(ping);
      }
    }, 25000);
    req.on('close', () => {
      clearInterval(ping);
      sseClients.delete(res);
    });
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Method Not Allowed');
    return;
  }

  const mapped = resolveRequestPath(url);
  if (!mapped) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 Forbidden');
    return;
  }

  let { rel, full } = mapped;
  if (existsSync(full) && statSync(full).isDirectory()) {
    full = join(full, 'index.html');
    rel = rel.replace(/\/+$/, '') + '/index.html';
  }

  if (!existsSync(full)) {
    // 无扩展名时尝试补 .html（方便 dev.bat 直接访问 /editor 之类）
    if (!extname(full) && existsSync(full + '.html')) {
      full += '.html';
    } else {
      log(`404 ${rel}`);
      send404(res, rel);
      return;
    }
  }

  const ext = extname(full).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  const headers = {
    'Content-Type': type,
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'Access-Control-Allow-Origin': '*',
  };

  if (ext === '.html') {
    let html = readFileSync(full, 'utf8');
    html = html.includes('</body>')
      ? html.replace('</body>', `${RELOAD_SNIPPET}\n</body>`)
      : html + RELOAD_SNIPPET;
    const buf = Buffer.from(html, 'utf8');
    headers['Content-Length'] = buf.length;
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : buf);
    return;
  }

  const buf = readFileSync(full);
  headers['Content-Length'] = buf.length;
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : buf);
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    // 已经有实例在跑：当作成功（tauri dev 只要求这个 URL 能响应）
    log(`端口 ${PORT} 已被占用，认为已有 dev-server 在运行，本进程直接退出`);
    process.exit(0);
  }
  log(`服务器错误：${e.message}`);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log('');
  log(`前端服务已就绪 → http://${HOST}:${PORT}`);
  log('前端改动会增量同步，并自动刷新窗口（无需重新编译）');
  log('按 Ctrl+C 退出');
  console.log('');
});

process.on('SIGINT', () => {
  log('正在退出…');
  try {
    watcher?.close();
  } catch {
    /* ignore */
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
});

function log(msg) {
  console.log(`[dev-server] ${msg}`);
}
