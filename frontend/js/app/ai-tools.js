/**
 * ai-tools.js — 「Verse 助手」可调用的工具集（Agent 能力层）
 * ============================================================================
 * 定位：把启动器**真实的**能力暴露给 AI（function calling）。
 *       每个工具都是一次真实的宿主调用 —— 优先走 Rust 后端命令 / api_proxy，
 *       少数纯 UI 动作（切页面）才用前端函数。
 *
 * 两个关键约定：
 *   1. kind === 'read'  → 只查不改，助手可直接执行；
 *      kind === 'write' → 会改变磁盘 / 启动栏 / 账户等状态，**必须用户点确认**后才执行。
 *   2. run() 一律返回**字符串**（tool 结果回灌给模型）。返回前做裁剪，
 *      避免把巨大的设置对象 / 日志全文塞进上下文。
 *
 * 供 assistant.js 使用：window.VerseAITools
 *
 * VersePC - Minecraft Launcher
 * Copyright (c) 2026 豆杰. All Rights Reserved.
 */
(function () {
  'use strict';

  // ========================================================================
  // 小工具
  // ========================================================================
  function _s(v) {
    try { return JSON.stringify(v); } catch (e) { return String(v); }
  }

  /** 截断长文本（日志、列表），避免上下文被撑爆 */
  function _clip(s, max) {
    var t = String(s == null ? '' : s);
    max = max || 2000;
    return t.length > max ? t.slice(0, max) + '\n…（已截断，共 ' + t.length + ' 字符）' : t;
  }

  function _require(args, key, label) {
    var v = args ? args[key] : undefined;
    if (v === undefined || v === null || v === '') {
      throw new Error('缺少必要参数「' + (label || key) + '」');
    }
    return v;
  }

  function _ok(obj) { return _s(obj); }

  /** 宿主不可用（非 Tauri / 脚本未加载）时给出人话错误 */
  function _need(cond, what) {
    if (!cond) throw new Error(what + '当前不可用（宿主未就绪或接口缺失）');
  }

  function _api() { return window.API || null; }
  function _bridge() { return window.bridge || null; }

  /** 调用 Rust 后端命令 */
  function _invoke(cmd, args) {
    var b = _bridge();
    if (!b || typeof b.invoke !== 'function') throw new Error('后端通道不可用：' + cmd);
    return b.invoke(cmd, args || {});
  }

  /** 走 Rust 的 api_proxy 路由 */
  function _proxy(method, path, params, body) {
    var b = _bridge();
    if (!b || typeof b.apiProxy !== 'function') throw new Error('后端路由不可用：' + path);
    return b.apiProxy(method, path, params || {}, body || null).then(function (r) {
      return r.json();
    });
  }

  /** 版本 id → 显示名（用于给模型看的可读文本） */
  function _vName(id) {
    try {
      var list = (typeof installedVersions !== 'undefined' && Array.isArray(installedVersions)) ? installedVersions : [];
      var hit = list.filter(function (v) { return v.id === id; })[0];
      if (hit) return hit.customName || hit.id;
    } catch (e) {}
    return id;
  }

  function _curVersionId() {
    try { return (typeof currentLaunchVersionId !== 'undefined' && currentLaunchVersionId) || ''; } catch (e) { return ''; }
  }

  /** 版本对象 → 精简描述 */
  function _briefVersion(v) {
    var loaders = [];
    if (v.isFabric) loaders.push('Fabric');
    if (v.isForge) loaders.push('Forge');
    if (v.isNeoForge) loaders.push('NeoForge');
    if (v.isModpack) loaders.push('整合包');
    if (!loaders.length) loaders.push('原版');
    return {
      id: v.id,
      name: v.customName || v.id,
      type: v.type || 'release',
      loaders: loaders.join('+'),
      external: !!v.isExternal
    };
  }

  function _versions() {
    try {
      return (typeof installedVersions !== 'undefined' && Array.isArray(installedVersions)) ? installedVersions : [];
    } catch (e) { return []; }
  }

  function _accounts() {
    var api = _api();
    _need(api && api.getAccounts, '账户列表');
    return api.getAccounts();
  }

  /** 把「用户给的版本 id/名称」解析成真实 id：支持直接传名称、也支持不传（用当前选中的） */
  function _resolveVersionId(args) {
    var raw = String((args && (args.version || args.versionId)) || '').trim();
    var list = _versions();
    if (!raw) {
      var cur = _curVersionId();
      if (cur) return cur;
      if (list.length === 1) return list[0].id;
      throw new Error('没有指定版本，且启动栏当前未选中版本。可先调用 list_versions 看看有哪些版本。');
    }
    // 精确命中 id
    var byId = list.filter(function (v) { return v.id === raw; })[0];
    if (byId) return byId.id;
    // 命中显示名（忽略大小写）
    var low = raw.toLowerCase();
    var byName = list.filter(function (v) {
      return String(v.customName || '').toLowerCase() === low || String(v.id).toLowerCase() === low;
    })[0];
    if (byName) return byName.id;
    // 模糊包含
    var fuzzy = list.filter(function (v) {
      return String(v.id).toLowerCase().indexOf(low) !== -1 ||
             String(v.customName || '').toLowerCase().indexOf(low) !== -1;
    });
    if (fuzzy.length === 1) return fuzzy[0].id;
    if (fuzzy.length > 1) throw new Error('版本名「' + raw + '」匹配到多个：' + fuzzy.map(function (v) { return v.id; }).join('、') + '，请用完整 id。');
    throw new Error('找不到版本「' + raw + '」。已安装：' + (list.map(function (v) { return v.id; }).join('、') || '（无）'));
  }

  /**
   * 解析「要安装的远程版本」的 json 下载地址。
   * 后端安装接口要求 url 非空，Agent 一般只给版本号，所以要在这里补全：
   *   1. 调用方传了 url  → 直接用；
   *   2. 命中全局远程清单 allVersions → 取其 url；
   *   3. 还没有清单 → 拉一次 /api/versions 再找。
   * 返回 { id, url }；找不到时抛人话错误。
   */
  function _resolveVersionUrl(api, version, givenUrl) {
    var want = String(version || '').trim();
    if (givenUrl) return Promise.resolve({ id: want, url: givenUrl });
    if (!want) throw new Error('缺少必要参数「version」');

    function findIn(list) {
      if (!Array.isArray(list)) return null;
      var low = want.toLowerCase();
      // 先精确，再忽略大小写（快照版本号可能大小写不同）
      return list.filter(function (x) { return x && x.id === want && x.url; })[0] ||
             list.filter(function (x) { return x && String(x.id || '').toLowerCase() === low && x.url; })[0] ||
             null;
    }

    var cached = [];
    try { if (typeof allVersions !== 'undefined' && Array.isArray(allVersions)) cached = allVersions; } catch (e) {}
    var hit = findIn(cached);
    if (hit) return Promise.resolve({ id: hit.id, url: hit.url });

    if (api && typeof api.getVersions === 'function') {
      return api.getVersions(false).then(function (data) {
        var fresh = (data && data.versions) || [];
        var h = findIn(fresh);
        if (h) return { id: h.id, url: h.url };
        throw new Error('官方远程清单里没有版本「' + want + '」，请确认版本号（例如 1.20.1）是否正确。');
      });
    }
    throw new Error('拿不到版本清单，无法解析「' + want + '」的下载地址（网络或宿主不可用）。');
  }

  // ========================================================================
  // 模组加载器（Fabric / Forge / NeoForge）辅助
  // ========================================================================
  // 之前 Agent 只能装「原版」，用户说「装个带 Fabric 的 1.20.1」就卡住了。
  // 这里把加载器相关的查询与安装补齐，全部走启动器自己的安装链路：
  //   · 已装原版 → API.installFabric / installForge / installNeoForge
  //   · 全新安装 → versions.js::installVersionWithLoader（进下载任务、有进度）
  // ========================================================================

  var LOADER_KEYS = ['fabric', 'forge', 'neoforge'];
  var LOADER_NAMES = { fabric: 'Fabric', forge: 'Forge', neoforge: 'NeoForge' };

  /** 「1.20.1-fabric-0.15.11」/「fabric-loader-0.15.11-1.20.1」→ 「1.20.1」：取 MC 原版号 */
  function _mcVersionOf(raw) {
    var s = String(raw || '').trim();
    if (!s) return '';
    var LOADER_WORDS = ['fabric', 'loader', 'forge', 'neoforge', 'quilt', 'optifine'];
    var segs = s.split(/[-_ /]+/).filter(function (x) { return !!x; });
    var isVer = function (x) { return /^\d+(\.\d+){1,2}$/.test(x); };
    // 1) 主流 MC 版本号是 1.x，优先按它取（避免把 fabric-loader-0.15.11 当成游戏版本）
    for (var i = 0; i < segs.length; i++) {
      if (isVer(segs[i]) && segs[i].indexOf('1.') === 0) return segs[i];
    }
    // 2) 其它数字版本号：紧跟在加载器名后面的跳过
    for (var j = 0; j < segs.length; j++) {
      if (!isVer(segs[j])) continue;
      var prev = j > 0 ? segs[j - 1].toLowerCase() : '';
      if (LOADER_WORDS.indexOf(prev) >= 0) continue;
      return segs[j];
    }
    // 3) 保底：快照这类名字直接取第一个片段
    return segs[0] || s;
  }

  /** 已安装版本里有没有这个 MC 原版（用于决定「加装」还是「全新装」） */
  function _hasVanilla(mc) {
    return _versions().some(function (v) {
      return String(v.id || '').indexOf(mc) === 0;
    });
  }

  /** 拉取某 MC 版本可用的加载器版本列表 */
  function _loaderVersions(api, loader, mc) {
    if (loader === 'fabric') {
      _need(api && api.getFabricVersions, 'Fabric 版本接口');
      return api.getFabricVersions(mc).then(_pickList);
    }
    if (loader === 'forge') {
      _need(api && api.getForgeVersions, 'Forge 版本接口');
      return api.getForgeVersions(mc).then(_pickList);
    }
    if (loader === 'neoforge') {
      return _proxy('GET', '/api/neoforge/versions', { game: mc }).then(function (r) {
        return _pickList(r && r.versions);
      });
    }
    return Promise.reject(new Error('不支持的加载器：' + loader));
  }

  /** 从加载器版本列表里挑一个：给了就按给的找，没给就取最新的稳定版 */
  function _pickLoaderVersion(list, want, loader) {
    var items = (list || []).map(function (x) {
      return typeof x === 'string' ? { version: x } : (x || {});
    }).filter(function (x) { return x.version; });
    if (!items.length) {
      throw new Error('这个游戏版本没有可用的 ' + (LOADER_NAMES[loader] || loader) + ' 版本（可能太老或太新）。');
    }
    if (want) {
      var low = String(want).toLowerCase();
      var hit = items.filter(function (x) { return String(x.version).toLowerCase() === low; })[0] ||
                items.filter(function (x) { return String(x.version).toLowerCase().indexOf(low) === 0; })[0];
      if (!hit) {
        throw new Error((LOADER_NAMES[loader] || loader) + ' 没有版本「' + want + '」。可用的前几个：' +
          items.slice(0, 8).map(function (x) { return x.version; }).join('、'));
      }
      return hit;
    }
    // 列表一般按新→旧排，优先挑标记为稳定版的第一个
    var stable = items.filter(function (x) { return x.stable === true || x.type === 'release' || x.releaseType === 'release'; });
    return (stable.length ? stable : items)[0];
  }

  /** Fabric API 的推荐版本（装 Fabric 时一并装上，否则绝大多数模组跑不起来） */
  function _fabricApiInfo(api, mc) {
    if (!api || typeof api.getFabricApiVersions !== 'function') return Promise.resolve(null);
    return api.getFabricApiVersions(mc).then(function (r) {
      var list = (r && r.versions) || [];
      if (!list.length) return null;
      var rec = r && r.recommended;
      var hit = list.filter(function (x) { return (x.versionId || x.version) === rec; })[0] || list[0];
      return {
        id: hit.versionId || hit.version || '',
        url: hit.url || '',
        filename: hit.filename || ''
      };
    }).catch(function () { return null; });
  }

  /** 装完加载器后刷新版本列表（全局 loadVersions 存在就调，失败不影响结果） */
  function _reloadVersions() {
    try {
      if (typeof loadVersions === 'function') return Promise.resolve(loadVersions(true)).catch(function () {});
    } catch (e) {}
    return Promise.resolve();
  }

  // ========================================================================
  // 工具定义
  // ========================================================================
  var TOOLS = [

    // ------------------------------ 只读 ------------------------------
    {
      name: 'get_launcher_state',
      desc: '获取启动器当前状态总览：已安装的游戏版本、启动栏当前选中的版本、已登录账户与当前账户、当前所在页面。排查问题或需要了解用户环境时先调这个。',
      kind: 'read',
      params: {},
      run: function () {
        var vers = _versions().map(_briefVersion);
        var cur = _curVersionId();
        var page = (document.querySelector('.page.active') || {}).id || '';
        page = page.replace(/^page-/, '') || '未知';
        var out = {
          installedVersionsCount: vers.length,
          installedVersions: vers.slice(0, 30),
          currentLaunchVersion: cur || null,
          currentPage: page
        };
        return _accounts().then(function (list) {
          var arr = Array.isArray(list) ? list : (list && list.accounts) || [];
          var sel = '';
          try { sel = localStorage.getItem('versepc_selected_account') || ''; } catch (e) {}
          out.accounts = (arr || []).slice(0, 10).map(function (a) {
            return {
              id: a.id || a.uuid || '',
              name: a.username || a.name || '(未命名)',
              type: a.type || '',
              current: (a.id || '') === sel
            };
          });
          out.currentAccount = sel || null;
          return _ok(out);
        }).catch(function () {
          out.accounts = [];
          out.accountsNote = '账户信息读取失败';
          return _ok(out);
        });
      }
    },

    {
      name: 'list_versions',
      desc: '列出已安装的游戏版本（含加载器类型、是否外部目录）。想知道用户装了哪些版本、都是什么加载器时用。',
      kind: 'read',
      params: {},
      run: function () {
        var list = _versions();
        if (!list.length) return '当前没有安装任何游戏版本。可以在「下载」页安装，或让我帮你装。';
        return _ok({
          count: list.length,
          currentLaunchVersion: _curVersionId() || null,
          versions: list.map(_briefVersion)
        });
      }
    },

    {
      name: 'list_installed_mods',
      desc: '列出某个版本已安装的模组（可选指定版本，默认当前选中的版本）。回答「我装了什么模组 / 模组有没有装对」时用。',
      kind: 'read',
      params: { version: { type: 'string', description: '游戏版本 id 或名称，留空表示当前选中的版本' } },
      run: function (args) {
        var api = _api();
        _need(api && api.getVersionMods, '模组列表接口');
        var vid = _resolveVersionId(args);
        return api.getVersionMods(vid).then(function (res) {
          var mods = (res && (res.mods || res.installed || res)) || [];
          if (!Array.isArray(mods)) mods = [];
          if (!mods.length) return '版本 ' + _vName(vid) + ' 里没有装任何模组（或该版本还没有 mods 目录）。';
          return _ok({
            version: vid,
            count: mods.length,
            mods: mods.slice(0, 80).map(function (m) {
              return {
                name: m.name || m.fileName || m.filename || '',
                fileName: m.fileName || m.filename || '',
                enabled: !m.disabled,
                version: m.version || ''
              };
            })
          });
        });
      }
    },

    {
      name: 'search_mods',
      desc: '在 Modrinth / CurseForge 上搜索模组 / 资源（模组、整合包、材质、光影、数据包），只返回搜索结果，不安装。想给用户推荐东西时用。source 留空表示两个平台一起搜（推荐，一次就能搜全，别一个平台搜不到再搜另一个）。',
      kind: 'read',
      params: {
        query: { type: 'string', description: '搜索关键词，例如 "sodium"、"小地图"' },
        type: { type: 'string', description: 'mod / modpack / resourcepack / shader / datapack，默认 mod', enum: ['mod', 'modpack', 'resourcepack', 'shader', 'datapack'] },
        source: { type: 'string', description: '留空 = 两个平台一起搜（推荐）；也可指定 modrinth / curseforge' },
        loader: { type: 'string', description: 'fabric / forge / neoforge / quilt，可留空' },
        gameVersion: { type: 'string', description: '游戏版本，例如 1.20.1，可留空' },
        limit: { type: 'integer', description: '返回条数，默认 8，最多 20' }
      },
      required: ['query'],
      run: function (args) {
        var api = _api();
        var q = _require(args, 'query', 'query');
        var type = args.type || 'mod';
        var limit = Math.min(Math.max(parseInt(args.limit, 10) || 8, 1), 20);
        if (type === 'mod') {
          _need(api && api.searchMods, '模组搜索接口');
          // source 留空 → any：两个平台一起搜（后端只认 modrinth / curseforge / any）
          return api.searchMods(q, args.source || 'any', args.loader || '', args.gameVersion || '', '', 'relevance', limit, 0)
            .then(function (r) { return _fmtSearch(r, limit); });
        }
        _need(api && api.searchResources, '资源搜索接口');
        return api.searchResources(q, type, args.loader || '', args.gameVersion || '', '', 'downloads', limit, 0, args.source || '')
          .then(function (r) { return _fmtSearch(r, limit); });
      }
    },

    {
      name: 'list_loader_versions',
      desc: '查询某个游戏版本可用的模组加载器版本（Fabric / Forge / NeoForge）。用户想指定加载器版本，或你想确认某个版本能不能装加载器时用。',
      kind: 'read',
      params: {
        loader: { type: 'string', description: 'fabric / forge / neoforge', enum: ['fabric', 'forge', 'neoforge'] },
        version: { type: 'string', description: '游戏版本号，例如 1.20.1' }
      },
      required: ['loader', 'version'],
      run: function (args) {
        var api = _api();
        var loader = String(_require(args, 'loader', 'loader')).toLowerCase();
        if (LOADER_KEYS.indexOf(loader) === -1) {
          throw new Error('只支持 fabric / forge / neoforge，收到的是 ' + args.loader);
        }
        var mc = _mcVersionOf(_require(args, 'version', 'version'));
        return _loaderVersions(api, loader, mc).then(function (list) {
          var items = (list || []).map(function (x) { return typeof x === 'string' ? { version: x } : (x || {}); });
          if (!items.length) return '游戏版本 ' + mc + ' 没有可用的 ' + (LOADER_NAMES[loader] || loader) + ' 版本。';
          return _ok({
            gameVersion: mc,
            loader: loader,
            count: items.length,
            // 列表本身已是新→旧，直接取前若干个即可
            versions: items.slice(0, 15).map(function (x) {
              return {
                version: x.version,
                stable: !!(x.stable || x.type === 'release' || x.releaseType === 'release')
              };
            })
          });
        });
      }
    },

    {
      name: 'list_java',
      desc: '列出本机可用的 Java 运行时（含版本号与路径），以及启动器当前指定的 Java。排查「Java 版本不对 / 找不到 Java」时用。',
      kind: 'read',
      params: {},
      run: function () {
        var api = _api();
        _need(api && (api.getInstalledJava || api.getJavaList), 'Java 列表接口');
        var fn = api.getInstalledJava || api.getJavaList;
        return fn.call(api).then(function (r) {
          var list = Array.isArray(r) ? r : ((r && (r.javaList || r.installed || r.list)) || []);
          if (!Array.isArray(list)) list = [];
          return _ok({
            count: list.length,
            javas: list.slice(0, 20).map(function (j) {
              return {
                version: j.version || j.majorVersion || '',
                path: j.path || j.javaHome || j.home || '',
                arch: j.arch || '',
                current: !!j.isCurrent
              };
            })
          });
        });
      }
    },

    {
      name: 'get_launch_settings',
      desc: '读取启动相关设置：内存分配、JVM 参数、游戏窗口大小等。用户抱怨卡顿 / 内存不够时先看这个。',
      kind: 'read',
      params: {},
      run: function () {
        return _proxy('GET', '/api/settings').then(function (res) {
          var s = (res && (res.settings || res)) || {};
          var keys = ['memory', 'minMemory', 'maxMemory', 'memoryMin', 'memoryMax', 'jvmArgs', 'jvm', 'windowWidth', 'windowHeight', 'fullscreen', 'javaPath', 'versionIsolation', 'gameDir', 'downloadSource'];
          var picked = {};
          keys.forEach(function (k) { if (s[k] !== undefined) picked[k] = s[k]; });
          if (!Object.keys(picked).length) return _clip(_s(s), 1500);
          return _ok(picked);
        });
      }
    },

    {
      name: 'read_crash_logs',
      desc: '读取某个版本的崩溃日志列表（文件名、时间、大小）。用户说"启动崩溃 / 闪退"时先调这个，再决定要不要读详情。',
      kind: 'read',
      params: { version: { type: 'string', description: '游戏版本 id 或名称，留空表示当前选中的版本' } },
      run: function (args) {
        var api = _api();
        _need(api && api.getCrashLogs, '崩溃日志接口');
        var vid = _resolveVersionId(args);
        return api.getCrashLogs(vid).then(function (r) {
          var list = Array.isArray(r) ? r : ((r && (r.logs || r.files)) || []);
          if (!Array.isArray(list)) list = [];
          if (!list.length) return '版本 ' + _vName(vid) + ' 下没有找到崩溃日志。';
          return _ok({
            version: vid,
            count: list.length,
            logs: list.slice(0, 15).map(function (f) {
              return {
                name: f.name || f.fileName || '',
                path: f.path || '',
                time: f.time || f.mtime || f.modified || '',
                size: f.size || 0
              };
            })
          });
        });
      }
    },

    {
      name: 'analyze_crash',
      desc: '让启动器自带的崩溃分析器分析某个版本的最近一次崩溃，返回可疑模组与结论。比让模型自己读日志准得多，优先用它。',
      kind: 'read',
      params: { version: { type: 'string', description: '游戏版本 id 或名称，留空表示当前选中的版本' } },
      run: function (args) {
        var api = _api();
        _need(api && api.analyzeCrash, '崩溃分析接口');
        var vid = _resolveVersionId(args);
        return api.analyzeCrash(vid).then(function (r) {
          if (r && r.success === false) return '分析失败：' + (r.error || '未知错误');
          return _clip(_s(r), 3000);
        });
      }
    },

    {
      name: 'get_game_status',
      desc: '查询游戏进程状态：是否正在运行、当前运行的版本与启动会话。',
      kind: 'read',
      params: {},
      run: function () {
        var api = _api();
        _need(api && api.getGameStatus, '游戏状态接口');
        return api.getGameStatus().then(function (r) { return _clip(_s(r), 1200); });
      }
    },

    {
      name: 'list_plugins',
      desc: '列出启动器已安装的插件（id / 名称 / 版本 / 安装目录）。用户问插件或要排查插件问题时用。',
      kind: 'read',
      params: {},
      run: function () {
        return _invoke('plugin_list').then(function (r) {
          var list = (r && r.plugins) || [];
          if (!list.length) return '当前没有安装任何插件。';
          return _ok({
            count: list.length,
            plugins: list.map(function (p) {
              return { id: p.id, name: p.name, version: p.version || p.installedVersion || '', dir: p.installedDir || '' };
            })
          });
        });
      }
    },

    {
      name: 'list_online_status',
      desc: '查询联机相关状态：红石联机可用服务器列表、私有服务器列表、陶瓦联机(easytier)运行状态。用户问联机、开服相关问题时用。',
      kind: 'read',
      params: {},
      run: function () {
        var api = _api();
        var easytier = (api && api.easytierStatus)
          ? api.easytierStatus().catch(function (e) { return { error: String(e) }; })
          : Promise.resolve({ note: '陶瓦联机接口不可用' });
        return Promise.all([
          _invoke('redstone_servers').catch(function (e) { return { error: String(e) }; }),
          _invoke('private_server_list').catch(function (e) { return { error: String(e) }; }),
          easytier
        ]).then(function (arr) {
          return _clip(_s({ redstoneServers: arr[0], privateServers: arr[1], easytier: arr[2] }), 2000);
        });
      }
    },

    {
      name: 'navigate',
      desc: '切换到启动器里的某个页面（如用户说「带我去模组页」「打开设置」）。',
      kind: 'read',
      params: {
        page: {
          type: 'string',
          description: '页面 id',
          enum: ['home', 'versions', 'installed-versions', 'mods', 'modpacks', 'datapacks', 'resourcepacks',
                 'shaders', 'toolbox', 'accounts', 'plugins', 'runtime-log', 'console', 'downloads',
                 'settings-launch', 'settings-personalize', 'settings-other', 'assistant']
        }
      },
      required: ['page'],
      run: function (args) {
        var page = _require(args, 'page', 'page');
        if (typeof navigateToPage !== 'function') throw new Error('页面跳转功能当前不可用');
        if (!document.getElementById('page-' + page)) throw new Error('页面「' + page + '」不存在');
        navigateToPage(page);
        return '已切换到「' + page + '」页面。';
      }
    },

    {
      name: 'open_folder',
      desc: '在文件资源管理器里打开某个文件夹（模组 / 存档 / 截图 / 版本目录 / 游戏目录）。',
      kind: 'read',
      params: {
        type: {
          type: 'string',
          description: '文件夹类型',
          enum: ['mods', 'saves', 'screenshots', 'version', 'game', 'resourcepacks', 'shaderpacks', 'logs']
        },
        version: { type: 'string', description: '游戏版本 id 或名称，留空表示当前选中的版本' }
      },
      required: ['type'],
      run: function (args) {
        var api = _api();
        _need(api && api.openVersionFolder, '打开文件夹接口');
        var type = _require(args, 'type', 'type');
        var vid = _resolveVersionId(args);
        return api.openVersionFolder(vid, type).then(function () {
          return '已打开 ' + _vName(vid) + ' 的「' + type + '」文件夹。';
        });
      }
    },

    // ------------------------------ 写操作（需确认） ------------------------------
    {
      name: 'launch_game',
      desc: '启动 Minecraft 游戏（会先选中指定版本，再走完整的启动流程，包括补齐缺失依赖）。会真正把游戏跑起来，必须用户确认。',
      kind: 'write',
      params: { version: { type: 'string', description: '要启动的游戏版本 id 或名称，留空表示当前选中的版本' } },
      run: function (args) {
        var vid = _resolveVersionId(args);
        if (typeof selectLaunchVersion === 'function') selectLaunchVersion(vid);
        if (typeof handleLaunch !== 'function') throw new Error('启动入口不可用');
        // handleLaunch 自己会处理依赖补齐、启动遮罩、错误提示
        return Promise.resolve(handleLaunch()).then(function () {
          return '已触发启动 ' + _vName(vid) + '，启动流程正在进行（缺失依赖会自动下载）。';
        });
      }
    },

    {
      name: 'select_version',
      desc: '把启动栏当前选中的版本切换为另一个版本（不启动游戏）。',
      kind: 'write',
      params: { version: { type: 'string', description: '要切换到的版本 id 或名称' } },
      required: ['version'],
      run: function (args) {
        var vid = _resolveVersionId(args);
        if (typeof selectLaunchVersion !== 'function') throw new Error('版本切换功能不可用');
        selectLaunchVersion(vid);
        return '启动栏当前版本已切换为 ' + _vName(vid) + '。';
      }
    },

    {
      name: 'select_account',
      desc: '切换当前使用的游戏账户（按用户名或 id 匹配）。',
      kind: 'write',
      params: { account: { type: 'string', description: '账户名或账户 id' } },
      required: ['account'],
      run: function (args) {
        var api = _api();
        _need(api && api.selectAccount, '账户切换接口');
        var want = String(_require(args, 'account', 'account')).toLowerCase();
        return _accounts().then(function (list) {
          var arr = Array.isArray(list) ? list : (list && list.accounts) || [];
          var hit = (arr || []).filter(function (a) {
            return String(a.id || '').toLowerCase() === want ||
                   String(a.username || a.name || '').toLowerCase() === want;
          })[0];
          if (!hit) {
            var names = (arr || []).map(function (a) { return a.username || a.name; }).join('、');
            throw new Error('找不到账户「' + args.account + '」。现有账户：' + (names || '（无）'));
          }
          return api.selectAccount(hit.id).then(function () {
            return '已切换到账户 ' + (hit.username || hit.name) + '。';
          });
        });
      }
    },

    {
      name: 'install_mod',
      desc: '从 Modrinth / CurseForge 搜索并安装一个模组到指定版本的 mods 目录（自动选最匹配的一个结果，含依赖）。默认两个平台一起搜；会按目标版本的 MC 版本号 + 加载器挑文件。会真的写入磁盘，必须用户确认。',
      kind: 'write',
      params: {
        query: { type: 'string', description: '模组名称或搜索关键词' },
        version: { type: 'string', description: '装到哪个游戏版本，留空表示当前选中的版本' },
        source: { type: 'string', description: '留空 = 两个平台一起搜（推荐）；也可指定 modrinth / curseforge' }
      },
      required: ['query'],
      run: function (args) {
        var api = _api();
        var b = _bridge();
        _need(api && api.searchMods && api.downloadResource, '模组安装接口');
        _need(b && b.getDefaultModPath, 'mods 目录解析');
        var vid = _resolveVersionId(args);
        var source = args.source || 'any';
        var parts = _verParts(vid);
        return Promise.all([_searchBestMod(api, String(args.query), vid, source), b.getDefaultModPath(vid)])
          .then(function (r) {
            var top = r[0];
            var savePath = r[1] || '';
            if (!savePath) throw new Error('拿不到 ' + _vName(vid) + ' 的 mods 目录，请先在启动器里确认该版本正常。');
            // 明确带上 MC 版本 + 加载器：后端会照这个挑文件，避免装成别的版本/加载器的构建
            return api.downloadResource('', top.pid, 'mod', '', savePath, '', top.source, parts.gameVersion, parts.loader)
              .then(function (res) {
                if (res && res.success === false) throw new Error(res.error || '安装失败');
                if (typeof showModDownloadModal === 'function' && res && res.fileName) {
                  showModDownloadModal(res.fileName, res.sessionId || '', savePath);
                }
                return '已开始安装模组「' + top.title + '」到 ' + _vName(vid) + ' 的 mods 目录（按 ' +
                  parts.gameVersion + (parts.loader ? ' / ' + parts.loader : '') + ' 匹配，含依赖，后台下载中）。';
              });
          });
      }
    },

    {
      name: 'list_resource_versions',
      desc: '查一个模组 / 整合包 / 材质包支持哪些游戏版本（返回可选的 MC 版本、加载器、文件号）。用户说了「要 1.20.1 的整合包」但不确定有没有这个版本，或要让用户挑版本时，先调它查清楚。只读。',
      kind: 'read',
      params: {
        query: { type: 'string', description: '项目名或关键词（与 projectId 二选一）' },
        projectId: { type: 'string', description: '已知的项目 ID，优先用它，避免再搜一次' },
        type: { type: 'string', description: 'mod / modpack / resourcepack / shader，默认 modpack', enum: ['mod', 'modpack', 'resourcepack', 'shader'] },
        source: { type: 'string', description: 'modrinth / curseforge，默认自动' },
        gameVersion: { type: 'string', description: '只看某个游戏版本，例如 1.20.1，可留空' }
      },
      run: function (args) {
        var api = _api();
        _need(api && api.getResourceVersions, '版本列表接口');
        var type = args.type || 'modpack';
        var gv = _wantGameVersion(args.gameVersion);

        // 先定位项目（给了 projectId 就直接用）
        var projectP = args.projectId
          ? Promise.resolve({ pid: String(args.projectId), source: args.source || '', title: '' })
          : (function () {
              var q = _require(args, 'query', 'query');
              // 两个平台都搜一遍，取更贴近关键词的那个结果
              return api.searchResources(q, type, '', gv, '', 'downloads', 5, 0, args.source || '')
                .then(function (r) {
                  var list = _pickList(r);
                  if (list.length || args.source) return list;
                  return api.searchResources(q, type, '', gv, '', 'downloads', 5, 0, 'curseforge').then(_pickList);
                })
                .then(function (list) {
                  if (!list.length) throw new Error('没搜到「' + args.query + '」' + (gv ? '（' + gv + '）' : '') + '，换个关键词试试。');
                  var top = list[0];
                  var pid = top.project_id || top.projectId || top.id || top.slug;
                  if (!pid) throw new Error('搜索结果缺少 projectId。');
                  return { pid: pid, source: top.source || '', title: top.title || top.name || args.query };
                });
            })();

        return projectP.then(function (p) {
          // 版本列表接口只认 modrinth / curseforge，来源不明时两个都试
          var sources = p.source ? [p.source] : ['modrinth', 'curseforge'];
          var fetchOne = function (i) {
            if (i >= sources.length) return Promise.resolve([]);
            return api.getResourceVersions(p.pid, sources[i], '', gv).then(function (r) {
              var list = _pickList((r && r.versions) || r) || [];
              if (list.length) return list;
              return fetchOne(i + 1);
            });
          };
          return fetchOne(0).then(function (list) {
            if (!list.length) return '「' + (p.title || p.pid) + '」' + (gv ? ' 没有支持 ' + gv + ' 的版本。' : ' 没有查到可用版本。');
            // 去重：按「MC 版本 + 加载器」合并，只保留最新的一条
            var seen = {};
            var out = [];
            list.forEach(function (x) {
              var mcs = (x.gameVersions || []).filter(function (s) { return /^\d+\.\d+(\.\d+)?$/.test(s); });
              var loaders = (x.loaders || []).filter(function (s) { return /^(fabric|forge|neoforge|quilt)$/.test(String(s).toLowerCase()); });
              var mc = mcs[0] || '(未标注)';
              var key = mc + '|' + (loaders.join(',') || 'any');
              if (seen[key]) return;
              seen[key] = 1;
              out.push({
                gameVersion: mc,
                loaders: loaders,
                fileId: x.id || '',
                file: (x.files && x.files[0] && x.files[0].filename) || '',
                releaseType: x.releaseType || 'release',
                date: (x.datePublished || '').slice(0, 10)
              });
            });
            out.sort(function (a, b) { return String(b.gameVersion).localeCompare(String(a.gameVersion), undefined, { numeric: true }); });
            return _ok({
              project: p.title || p.pid,
              source: p.source || 'auto',
              count: out.length,
              // 支持的游戏版本清单（给用户挑版本用）
              gameVersions: out.slice(0, 20)
            });
          });
        });
      }
    },

    {
      name: 'install_modpack',
      desc: '从 Modrinth / CurseForge 搜索并安装一个整合包（会用搜索到的名称新建一个版本）。用户说了游戏版本（如「1.20.1 的 XX 整合包」）就传 gameVersion，会安装该整合包对应那个版本的构建；没说就先问清楚或先调 list_resource_versions 看有哪些版本。下载量大，必须用户确认。',
      kind: 'write',
      params: {
        query: { type: 'string', description: '整合包名称或搜索关键词' },
        gameVersion: { type: 'string', description: '要安装哪个游戏版本的整合包，例如 1.20.1；留空表示该整合包的最新版' },
        source: { type: 'string', description: 'modrinth / curseforge，留空表示两个平台一起搜' }
      },
      required: ['query'],
      run: function (args) {
        var api = _api();
        _need(api && api.searchResources && api.downloadResource, '整合包安装接口');
        var source = args.source || '';
        var gv = _wantGameVersion(args.gameVersion);

        // 先按指定源搜；没结果时自动换另一个源再试一次（CurseForge 上整合包很多，
        // 只搜 Modrinth 经常会「一个都没搜到」）
        var search = function (src) {
          return api.searchResources(String(args.query), 'modpack', '', gv, '', 'downloads', 5, 0, src).then(_pickList);
        };
        var chain = source ? [source] : ['', 'curseforge', 'modrinth'];

        var tryNext = function (i) {
          if (i >= chain.length) {
            throw new Error('没搜到「' + args.query + '」' + (gv ? '（' + gv + '）' : '') + '对应的整合包。可换个关键词，或用 search_mods 先看看结果。');
          }
          return search(chain[i]).then(function (list) {
            if (!list.length) return tryNext(i + 1);
            var top = list[0];
            var pid = top.project_id || top.projectId || top.id || top.slug;
            if (!pid) throw new Error('搜索结果缺少 projectId，无法安装。');
            var title = top.title || top.name || args.query;
            var src = top.source || chain[i] || 'curseforge';
            return api.downloadResource('', pid, 'modpack', '', '', title, src, gv, '')
              .then(function (res) {
                if (res && res.success === false) throw new Error(res.error || '安装失败');
                if (typeof showModpackInstallModal === 'function' && res && res.fileName) {
                  showModpackInstallModal(res.fileName, res.sessionId || '');
                }
                return '已开始安装整合包「' + title + '」' + (gv ? '（' + gv + '）' : '') +
                  '，来源 ' + (src === 'curseforge' ? 'CurseForge' : 'Modrinth') + '；下载解压完成后会在主页出现对应版本。';
              });
          });
        };
        return tryNext(0);
      }
    },

    {
      name: 'install_game_version',
      desc: '安装一个游戏版本：可以只装原版，也可以一步装上加载器（Fabric / Forge / NeoForge）。要装带加载器的版本时就传 loader，不要让用户自己先装原版再装加载器。必须用户确认。',
      kind: 'write',
      params: {
        version: { type: 'string', description: '要安装的游戏版本号，例如 1.20.1' },
        loader: { type: 'string', description: '要一起装的加载器：fabric / forge / neoforge；留空表示只装原版', enum: ['fabric', 'forge', 'neoforge'] },
        loaderVersion: { type: 'string', description: '加载器版本，留空表示用最新的稳定版' },
        fabricApi: { type: 'boolean', description: '装 Fabric 时是否一并装 Fabric API，默认 true（绝大多数模组都需要）' },
        url: { type: 'string', description: '可选的版本 JSON 下载地址；一般不用传，助手会自动从远程清单里查。' }
      },
      required: ['version'],
      run: function (args) {
        var api = _api();
        _need(api && api.installVersion, '版本安装接口');
        var v = String(_require(args, 'version', 'version')).trim();
        var mc = _mcVersionOf(v);
        var givenUrl = String((args && args.url) || '').trim();
        var loader = String((args && args.loader) || '').toLowerCase();

        if (loader && LOADER_KEYS.indexOf(loader) === -1) {
          throw new Error('只支持 fabric / forge / neoforge 三种加载器，收到的是 ' + args.loader);
        }

        // 后端 /api/install-start 要求 versionId 与 url 同时非空。
        // Agent 通常只给版本号，所以这里自动从远程清单解析出该版本的 json 地址。
        return _resolveVersionUrl(api, v, givenUrl).then(function (resolved) {
          if (!loader) {
            // 关键：必须走「版本管理页」那条安装链路（全局 installVersion），
            // 它内部会 showInstallModal + pollInstallProgress：
            //   · 在下载列表里建一条任务（图标/进度/取消都能用）
            //   · 轮询安装进度并写回任务
            // 之前直接调 api.installVersion 只会在后台静默开一个会话，
            // 用户既看不到进度也没法取消 —— 就是「安装没进下载任务」的原因。
            var start = (typeof window.installVersion === 'function') ? window.installVersion : null;
            if (start) {
              return Promise.resolve(start(resolved.url, resolved.id, null, 'mojang', '')).then(function () {
                return '已开始安装原版 ' + v + '，进度已加入右下角的「下载」任务列表。';
              });
            }
            return api.installVersion(resolved.url, resolved.id, null, 'mojang', '');
          }

          // 带加载器：先定加载器版本，再走 installVersionWithLoader（同样进下载任务）
          return _loaderVersions(api, loader, mc).then(function (list) {
            var picked = _pickLoaderVersion(list, args.loaderVersion, loader);
            var lv = picked.version;
            var withApi = loader === 'fabric' && args.fabricApi !== false;
            return (withApi ? _fabricApiInfo(api, mc) : Promise.resolve(null)).then(function (apiInfo) {
              var loaderInfo = {
                type: loader,
                version: lv,
                fabricApiId: apiInfo ? apiInfo.id : '',
                fabricApiUrl: apiInfo ? apiInfo.url : '',
                fabricApiFilename: apiInfo ? apiInfo.filename : ''
              };
              var suffix = LOADER_NAMES[loader];
              var name = mc + '-' + suffix + '-' + lv;
              var startLoader = (typeof window.installVersionWithLoader === 'function') ? window.installVersionWithLoader : null;
              if (startLoader) {
                return Promise.resolve(startLoader(resolved.url, resolved.id, loaderInfo, 'mojang', name))
                  .then(function () { return loaderInfo; });
              }
              return api.installVersion(resolved.url, resolved.id, loaderInfo, 'mojang', name)
                .then(function (r) {
                  if (r && r.success === false) throw new Error(r.error || '安装失败');
                  return loaderInfo;
                });
            }).then(function (loaderInfo) {
              return '已开始安装 ' + mc + ' + ' + LOADER_NAMES[loader] + ' ' + loaderInfo.version +
                '（版本名：' + mc + '-' + LOADER_NAMES[loader] + '-' + loaderInfo.version +
                (loaderInfo.fabricApiId ? '，含 Fabric API' : '') +
                '），进度已加入右下角的「下载」任务列表。';
            });
          });
        }).then(function (res) {
          if (res && res.success === false) throw new Error(res.error || '安装失败');
          return res;
        });
      }
    },

    {
      name: 'install_loader',
      desc: '给**已经装好的**游戏版本加装模组加载器（Fabric / Forge / NeoForge）。用户说「给 1.20.1 装个 Fabric」时用；如果这个版本还没装过，改用 install_game_version 一步装「原版+加载器」。必须用户确认。',
      kind: 'write',
      params: {
        version: { type: 'string', description: '已安装的游戏版本 id 或版本号，例如 1.20.1' },
        loader: { type: 'string', description: 'fabric / forge / neoforge', enum: ['fabric', 'forge', 'neoforge'] },
        loaderVersion: { type: 'string', description: '加载器版本，留空表示用最新的稳定版' },
        fabricApi: { type: 'boolean', description: '装 Fabric 时是否一并装 Fabric API，默认 true' }
      },
      required: ['version', 'loader'],
      run: function (args) {
        var api = _api();
        _need(api && api.installFabric && api.installForge && api.installNeoForge, '加载器安装接口');
        var loader = String(_require(args, 'loader', 'loader')).toLowerCase();
        if (LOADER_KEYS.indexOf(loader) === -1) {
          throw new Error('只支持 fabric / forge / neoforge 三种加载器，收到的是 ' + args.loader);
        }
        var mc = _mcVersionOf(_require(args, 'version', 'version'));
        if (!_hasVanilla(mc)) {
          throw new Error('本机还没有装 ' + mc + ' 这个原版。请改用 install_game_version 直接装「' + mc + ' + ' + (LOADER_NAMES[loader] || loader) + '」（一步到位，不用分两次）。');
        }

        return _loaderVersions(api, loader, mc).then(function (list) {
          var picked = _pickLoaderVersion(list, args.loaderVersion, loader);
          var lv = picked.version;
          var p;
          if (loader === 'fabric') p = api.installFabric(mc, lv);
          else if (loader === 'forge') p = api.installForge(mc, lv);
          else p = api.installNeoForge(mc, lv);

          return p.then(function (res) {
            if (!res || res.success === false) throw new Error((res && res.error) || '加载器安装失败');
            var installedId = res.versionId ||
              (loader === 'fabric' ? ('fabric-loader-' + lv + '-' + mc) : (mc + '-' + loader + '-' + lv));

            var withApi = loader === 'fabric' && args.fabricApi !== false;
            if (!withApi) return { id: installedId, apiOk: false, apiSkipped: true };
            return _fabricApiInfo(api, mc).then(function (info) {
              if (!info || !info.id) return { id: installedId, apiOk: false };
              return api.installFabricApi(mc, info.id, installedId, info.url || '', info.filename || '')
                .then(function (r) { return { id: installedId, apiOk: !!(r && r.success !== false) }; })
                .catch(function () { return { id: installedId, apiOk: false }; });
            });
          }).then(function (out) {
            return _reloadVersions().then(function () {
              var tail = loader === 'fabric'
                ? (out.apiSkipped ? '（按你的要求没装 Fabric API）' : (out.apiOk ? '，Fabric API 已一并装好' : '，但 Fabric API 没装上（多数模组需要它，可以让我补装）'))
                : '';
              return '已给 ' + mc + ' 装上 ' + (LOADER_NAMES[loader] || loader) + ' ' + lv +
                '，新版本 id：' + out.id + tail + '。';
            });
          });
        });
      }
    },

    {
      name: 'toggle_mod',
      desc: '启用或禁用一个已安装的模组（不删除文件）。',
      kind: 'write',
      params: {
        name: { type: 'string', description: '模组文件名或名称关键词' },
        enabled: { type: 'boolean', description: 'true 启用，false 禁用' },
        version: { type: 'string', description: '游戏版本 id 或名称，留空表示当前选中的版本' }
      },
      required: ['name', 'enabled'],
      run: function (args) {
        var api = _api();
        _need(api && api.getVersionMods && api.toggleMod, '模组开关接口');
        var vid = _resolveVersionId(args);
        var want = String(_require(args, 'name', 'name')).toLowerCase();
        var enabled = !!args.enabled;
        return api.getVersionMods(vid).then(function (r) {
          var mods = (r && (r.mods || r.installed || r)) || [];
          if (!Array.isArray(mods)) mods = [];
          var hit = mods.filter(function (m) {
            return String(m.fileName || m.filename || m.name || '').toLowerCase().indexOf(want) !== -1;
          })[0];
          if (!hit) throw new Error('在 ' + _vName(vid) + ' 里找不到包含「' + args.name + '」的模组。可先调用 list_installed_mods 看看有哪些。');
          var fileName = hit.fileName || hit.filename || hit.name;
          return api.toggleMod(fileName, enabled, vid).then(function () {
            return (enabled ? '已启用' : '已禁用') + '模组 ' + fileName + '。';
          });
        });
      }
    },

    {
      name: 'install_java',
      desc: '让启动器自动下载安装指定大版本的 Java（8 / 17 / 21）。必须用户确认。',
      kind: 'write',
      params: {
        majorVersion: { type: 'integer', description: 'Java 大版本：8 / 17 / 21', enum: [8, 17, 21] }
      },
      required: ['majorVersion'],
      run: function (args) {
        var api = _api();
        _need(api && api.autoInstallJava, 'Java 安装接口');
        var v = parseInt(_require(args, 'majorVersion', 'majorVersion'), 10);
        if ([8, 17, 21].indexOf(v) === -1) throw new Error('只支持 Java 8 / 17 / 21，收到的是 ' + args.majorVersion);
        return api.autoInstallJava(v).then(function () {
          return '已开始下载安装 Java ' + v + '，可在「Java」页看进度。';
        });
      }
    },

    {
      name: 'set_current_java',
      desc: '指定启动器使用哪个 Java（按版本大号或路径关键词匹配已检测到的 Java）。',
      kind: 'write',
      params: {
        java: { type: 'string', description: 'Java 路径，或版本关键词（如 17 / 21）' }
      },
      required: ['java'],
      run: function (args) {
        var api = _api();
        _need(api && (api.getInstalledJava || api.getJavaList) && api.setCurrentJava, 'Java 设置接口');
        var want = String(_require(args, 'java', 'java'));
        var low = want.toLowerCase();
        var getter = api.getInstalledJava || api.getJavaList;
        return getter.call(api).then(function (r) {
          var list = Array.isArray(r) ? r : ((r && (r.javaList || r.installed || r.list)) || []);
          if (!Array.isArray(list)) list = [];
          var hit = list.filter(function (j) {
            var p = String(j.path || j.javaHome || j.home || '').toLowerCase();
            var v = String(j.version || j.majorVersion || '');
            return p === low || (p && p.indexOf(low) !== -1) || (v && want && String(v).split('.')[0] === want);
          })[0];
          if (!hit) throw new Error('找不到匹配「' + want + '」的 Java，请先调用 list_java 看看有哪些。');
          var path = hit.path || hit.javaHome || hit.home || '';
          return api.setCurrentJava(path).then(function () {
            return '已把启动器使用的 Java 设为 ' + (hit.version || path) + '。';
          });
        });
      }
    },

    {
      name: 'repair_version',
      desc: '修复某个版本缺失或损坏的文件（等同「版本设置 → 修复」）。必须用户确认。',
      kind: 'write',
      params: { version: { type: 'string', description: '游戏版本 id 或名称，留空表示当前选中的版本' } },
      run: function (args) {
        var api = _api();
        _need(api && api.repairStart, '版本修复接口');
        var vid = _resolveVersionId(args);
        return api.repairStart(vid).then(function (r) {
          return '已开始修复 ' + _vName(vid) + '（sessionId: ' + ((r && r.sessionId) || '未知') + '），可在版本设置里看进度。';
        });
      }
    },

    {
      name: 'stop_game',
      desc: '结束正在运行的游戏进程。',
      kind: 'write',
      params: {},
      run: function () {
        var api = _api();
        _need(api && api.getGameStatus && api.stopGameInstance, '游戏停止接口');
        return api.getGameStatus().then(function (st) {
          var sid = (st && (st.sessionId || (st.game && st.game.sessionId))) || '';
          if (!st || !(st.running || st.isRunning || sid)) throw new Error('当前没有正在运行的游戏。');
          if (!sid) throw new Error('拿不到会话 id，无法安全结束游戏。');
          return api.stopGameInstance(sid).then(function () { return '已发出结束游戏的请求。'; });
        });
      }
    }
  ];

  /** 按目标版本的加载器 / 游戏大版本搜索，取最匹配的一条 */
  function _searchBestMod(api, query, versionId, source) {
    var ver = _versions().filter(function (v) { return v.id === versionId; })[0] || {};
    var loader = ver.isFabric ? 'fabric' : (ver.isForge ? 'forge' : (ver.isNeoForge ? 'neoforge' : ''));
    var gameVersion = String(versionId).split(/[-_ ]/)[0];
    return api.searchMods(query, source, loader, gameVersion, '', 'relevance', 5, 0).then(function (r) {
      var list = _pickList(r);
      if (!list.length) {
        throw new Error('没搜到「' + query + '」对应的模组（版本 ' + versionId + ' / 加载器 ' + (loader || '原版') + '）。可以换个关键词，或先确认这个版本能装模组。');
      }
      var top = list[0];
      var pid = top.project_id || top.projectId || top.id || top.slug;
      if (!pid) throw new Error('搜索结果缺少 projectId，无法安装。');
      return {
        pid: pid,
        title: top.title || top.name || query,
        source: top.source || source,
        loader: loader,
        gameVersion: gameVersion
      };
    });
  }

  /** 把一个版本 id（如 1.20.1-forge-47.2.0）解析成 { gameVersion, loader } */
  function _verParts(versionId) {
    var ver = _versions().filter(function (v) { return v.id === versionId; })[0] || {};
    var loader = ver.isFabric ? 'fabric' : (ver.isForge ? 'forge' : (ver.isNeoForge ? 'neoforge' : ''));
    return { gameVersion: _mcVersionOf(versionId), loader: loader };
  }

  /** 校验一个「1.20.1」样式的 MC 版本号；不合法就抛错 */
  function _wantGameVersion(v) {
    var s = String(v || '').trim();
    if (!s) return '';
    if (!/^\d+\.\d+(\.\d+)?$/.test(s)) {
      throw new Error('游戏版本号看起来不对：「' + s + '」。请用 1.20.1 这样的写法。');
    }
    return s;
  }

  /** 兼容不同接口的列表包装：{ hits:[...] } / { data:[...] } / [...] */
  function _pickList(r) {
    if (Array.isArray(r)) return r;
    if (!r) return [];
    var cands = [r.hits, r.data, r.results, r.mods, r.items, r.list];
    for (var i = 0; i < cands.length; i++) {
      if (Array.isArray(cands[i])) return cands[i];
    }
    return [];
  }

  function _fmtSearch(r, limit) {
    var list = _pickList(r);
    if (!list.length) return '没有搜到结果。';
    return _ok({
      count: list.length,
      results: list.slice(0, limit).map(function (m) {
        return {
          projectId: m.project_id || m.projectId || m.id || m.slug || '',
          name: m.title || m.name || '',
          source: m.source || '',
          description: _clip(String(m.description || m.summary || '').replace(/\s+/g, ' '), 160),
          downloads: m.downloads || m.downloadCount || 0,
          author: m.author || (m.team && m.team.name) || ''
        };
      })
    });
  }

  // ========================================================================
  // 对外接口
  // ========================================================================
  var _byName = {};
  TOOLS.forEach(function (t) { _byName[t.name] = t; });

  /** 转成 openai 的 tools 数组（后端再转成 anthropic / google 格式） */
  function toSchema() {
    return TOOLS.map(function (t) {
      var props = {};
      Object.keys(t.params || {}).forEach(function (k) {
        var p = t.params[k];
        var o = { type: p.type || 'string' };
        if (p.description) o.description = p.description;
        if (p.enum) o.enum = p.enum;
        props[k] = o;
      });
      return {
        type: 'function',
        function: {
          name: t.name,
          description: t.desc,
          parameters: {
            type: 'object',
            properties: props,
            required: t.required || []
          }
        }
      };
    });
  }

  function get(name) { return _byName[name] || null; }

  /** 人话描述工具要做什么（用于确认卡片与执行记录） */
  function describe(name, args) {
    args = args || {};
    var map = {
      launch_game: function () { return '启动游戏 ' + (args.version || '（当前选中版本）'); },
      select_version: function () { return '把启动栏版本切换为 ' + (args.version || '?'); },
      select_account: function () { return '切换账户为 ' + (args.account || '?'); },
      install_mod: function () { return '安装模组「' + (args.query || '?') + '」到 ' + (args.version || '当前版本'); },
      install_modpack: function () {
        return '安装整合包「' + (args.query || '?') + '」' + (args.gameVersion ? '（' + args.gameVersion + '）' : '');
      },
      install_game_version: function () {
        var v = args.version || '?';
        var l = args.loader ? (' + ' + (LOADER_NAMES[String(args.loader).toLowerCase()] || args.loader) +
          (args.loaderVersion ? ' ' + args.loaderVersion : '')) : '';
        return '安装 ' + v + l;
      },
      install_loader: function () {
        return '给 ' + (args.version || '?') + ' 加装 ' + (LOADER_NAMES[String(args.loader || '').toLowerCase()] || (args.loader || '?'));
      },
      toggle_mod: function () { return (args.enabled ? '启用' : '禁用') + '模组「' + (args.name || '?') + '」'; },
      install_java: function () { return '下载安装 Java ' + (args.majorVersion || '?'); },
      set_current_java: function () { return '把 Java 切换为 ' + (args.java || '?'); },
      repair_version: function () { return '修复版本 ' + (args.version || '（当前选中版本）'); },
      stop_game: function () { return '结束正在运行的游戏'; }
    };
    var f = map[name];
    if (f) return f();
    if (name === 'navigate') return '前往「' + (args.page || '?') + '」页面';
    if (name === 'open_folder') return '打开「' + (args.type || '?') + '」文件夹';
    if (name === 'get_launcher_state') return '读取启动器状态';
    if (name === 'list_versions') return '读取已安装版本列表';
    if (name === 'list_installed_mods') return '读取模组列表';
    if (name === 'search_mods') return '搜索「' + (args.query || '?') + '」';
    if (name === 'list_loader_versions') return '查询 ' + (args.version || '?') + ' 可用的 ' + (args.loader || '?') + ' 版本';
    if (name === 'list_resource_versions') {
      return '查询「' + (args.query || args.projectId || '?') + '」支持的游戏版本' + (args.gameVersion ? '（筛 ' + args.gameVersion + '）' : '');
    }
    if (name === 'list_java') return '读取 Java 列表';
    if (name === 'get_launch_settings') return '读取启动设置';
    if (name === 'read_crash_logs') return '读取崩溃日志列表';
    if (name === 'analyze_crash') return '分析最近一次崩溃';
    if (name === 'get_game_status') return '查询游戏运行状态';
    if (name === 'list_plugins') return '读取插件列表';
    if (name === 'list_online_status') return '查询联机状态';
    if (name === 'check_update') return '检查启动器更新';
    var t = get(name);
    return t ? t.desc.slice(0, 40) : name;
  }

  /** 执行一个工具。返回 Promise<string>；异常会被包装成可读消息抛给调用方。 */
  function run(name, args) {
    var t = get(name);
    if (!t) return Promise.reject(new Error('未知工具：' + name));
    var a = args;
    if (typeof a === 'string') {
      try { a = JSON.parse(a); } catch (e) { a = {}; }
    }
    if (!a || typeof a !== 'object') a = {};
    return Promise.resolve()
      .then(function () { return t.run(a); })
      .then(function (out) {
        return typeof out === 'string' ? out : _s(out);
      })
      .catch(function (e) {
        throw new Error((e && e.message) ? e.message : String(e));
      });
  }

  window.VerseAITools = {
    list: function () { return TOOLS.map(function (t) { return t.name; }); },
    defs: function () { return TOOLS; },
    get: get,
    toSchema: toSchema,
    describe: describe,
    run: run,
    isWrite: function (name) { var t = get(name); return !!(t && t.kind === 'write'); }
  };
})();
