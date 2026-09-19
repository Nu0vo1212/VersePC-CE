/* page-plugins.js - 插件市场页 Vue 组件
 * 说明：从统一 Gitee 插件仓库拉取 index.json，叠加已安装信息，
 * 支持按分类筛选、搜索和一键安装/更新/卸载插件。
 * 通信统一走 window.bridge.invoke（唯一 IPC 入口）。
 */
const PagePlugins = {
  data() {
    return {
      tabs: [
        { key: 'all', name: '全部' },
        { key: 'function', name: '功能' },
        { key: 'personalize', name: '个性化' }
      ],
      curTab: 'all',
      keyword: '',
      plugins: [],
      loading: true,
      error: '',
      busy: ''
    };
  },
  computed: {
    filtered() {
      const kw = this.keyword.trim().toLowerCase();
      return this.plugins.filter(p => {
        // 开服类插件并入"功能"分类展示
        const cat = p.category || 'function';
        let okTab;
        if (this.curTab === 'all') okTab = true;
        else if (this.curTab === 'function') okTab = cat === 'function' || cat === 'server';
        else okTab = cat === this.curTab;
        if (!okTab) return false;
        if (!kw) return true;
        return (
          (p.name || '').toLowerCase().includes(kw) ||
          (p.description || '').toLowerCase().includes(kw) ||
          (p.id || '').toLowerCase().includes(kw)
        );
      });
    }
  },
  methods: {
    catName(c) {
      const m = { server: '开服', function: '功能', personalize: '个性化' };
      return m[c] || '其他';
    },
    catIcon(c) {
      if (c === 'server') {
        return '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/>';
      }
      if (c === 'personalize') {
        return '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>';
      }
      return '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>';
    },
    setTab(k) {
      this.curTab = k;
    },
    openDocs() {
      const url = 'https://doujie081231.github.io/verseplugin-docs/';
      if (window.bridge && window.bridge.invoke) {
        window.bridge.invoke('open_external', { url }).catch(() => {
          if (typeof showToast === 'function') showToast('无法打开开发文档', 'error');
        });
      } else if (typeof window.open === 'function') {
        window.open(url, '_blank');
      }
    },
    // 加载本地插件包（离线安装）：选文件 → 预览清单 → 权限确认 → 安装 → 刷新
    async loadLocalPlugin() {
      if (this.busy) return;
      let path = '';
      try {
        const picked = await window.bridge.invoke('select_file', { title: '选择插件包（.zip）' });
        if (!picked || picked.cancelled !== false || !picked.path) return;
        path = picked.path;
      } catch (e) {
        this.showToast('无法打开文件选择框：' + (e && e.message ? e.message : e), 'error');
        return;
      }
      if (!/\.zip$/i.test(path)) {
        this.showToast('请选择 .zip 格式的插件包', 'error');
        return;
      }
      this.busy = 'local';
      try {
        // 先读清单做预览与权限确认，避免未经确认直接执行插件代码
        const info = await window.bridge.invoke('plugin_local_inspect', { path });
        if (!info || !info.ok) {
          this.showToast((info && info.error) || '无法读取插件包', 'error');
          return;
        }
        const m = info.manifest || {};
        const perms = this.pluginPermissionDesc(m);
        const lines = [
          '插件包：<b>' + (m.name || m.id) + '</b> v' + (m.version || '未知版本'),
          '标识：' + (m.id || ''),
          m.author ? '作者：' + m.author : ''
        ].filter(Boolean);
        if (perms.length) {
          lines.push('<br>该插件声明了以下权限：<br>' + perms.map(s => '&#8226; ' + s).join('<br>'));
        } else {
          lines.push('<br>该插件未声明高危权限。');
        }
        lines.push('<br>请确认来源可信后再安装。');
        const ok = await window.showConfirmDialog(
          '安装本地插件',
          lines.join('<br>'),
          perms.length ? '信任并安装' : '安装',
          '取消'
        );
        if (!ok) return;
        const res = await window.bridge.invoke('plugin_install_local', { path });
        if (res && res.ok) {
          const pm = res.plugin || {};
          this.showToast('已安装本地插件：' + (pm.name || m.name || m.id), 'success');
        } else {
          this.showToast((res && res.error) || '安装失败', 'error');
        }
      } catch (e) {
        this.showToast(e && e.message ? e.message : String(e), 'error');
      } finally {
        this.busy = '';
        this.loadMarket();
        if (window.VersePC && window.VersePC.reloadPluginUI) window.VersePC.reloadPluginUI();
      }
    },
    async loadMarket() {
      this.loading = true;
      this.error = '';
      try {
        const res = await window.bridge.invoke('plugin_market_index', { indexUrl: '' });
        if (res && res.ok) {
          this.plugins = Array.isArray(res.plugins) ? res.plugins : [];
        } else {
          this.error = (res && res.error) || '无法拉取插件市场索引';
        }
      } catch (e) {
        this.error = e && e.message ? e.message : String(e);
      } finally {
        this.loading = false;
      }
    },
    // 插件声明的权限中文描述（用于安装前确认卡片）
    pluginPermissionDesc(p) {
      const list = [];
      const perms = (p && p.permissions) || {};
      if (perms.network === true) list.push('访问网络：可请求外部服务、下载数据');
      if (Array.isArray(perms.native) && perms.native.indexOf('exec') >= 0) {
        list.push('执行外部程序：可启动/停止本地进程（如 frpc.exe），用于进程托管');
      }
      return list;
    },
    needsPermissionConfirm(p) {
      return this.pluginPermissionDesc(p).length > 0;
    },
    async install(p) {
      if (this.busy) return;
      // 安装前权限确认：插件声明了网络/执行外部程序等高危权限时，必须用户点「信任并安装」才继续
      const perms = this.pluginPermissionDesc(p);
      if (perms.length) {
        const ok = await window.showConfirmDialog(
          '权限确认',
          '插件「' + (p.name || p.id) + '」声明了以下权限：<br>' +
            perms.map(s => '&#8226; ' + s).join('<br>') +
            '<br><br>请确认您信任该插件后再继续安装。',
          '信任并安装',
          '取消'
        );
        if (!ok) return;
      }
      this.busy = p.id;
      try {
        const res = await window.bridge.invoke('plugin_download_install', {
          url: p.downloadUrl || p.url || '',
          sha256: p.sha256 || '',
          size: p.size || 0,
          expectedId: p.id
        });
        if (res && res.ok) {
          this.showToast('插件已安装', 'success');
        } else {
          this.showToast((res && res.error) || '安装失败', 'error');
        }
      } catch (e) {
        this.showToast(e && e.message ? e.message : String(e), 'error');
      } finally {
        this.busy = '';
        this.loadMarket();
        if (window.VersePC && window.VersePC.reloadPluginUI) window.VersePC.reloadPluginUI();
      }
    },
    async uninstall(p) {
      if (this.busy) return;
      this.busy = p.id;
      try {
        const res = await window.bridge.invoke('plugin_uninstall', { id: p.id });
        if (res && res.ok) {
          this.showToast('插件已卸载', 'success');
        } else {
          this.showToast((res && res.error) || '卸载失败', 'error');
        }
      } catch (e) {
        this.showToast(e && e.message ? e.message : String(e), 'error');
      } finally {
        this.busy = '';
        this.loadMarket();
        if (window.VersePC && window.VersePC.reloadPluginUI) window.VersePC.reloadPluginUI();
      }
    },
    showToast(msg, type) {
      if (typeof showToast === 'function') showToast(msg, type);
      else if (typeof toast === 'function') toast(msg, type);
    }
  },
  async mounted() {
    await this.loadMarket();
  },
  template: `
    <div class="page-header">
      <h2>插件市场</h2>
      <p class="page-subtitle">从统一插件仓库下载扩展功能（功能 / 个性化）</p>
    </div>

    <div class="plugins-toolbar">
      <div class="plugins-top-row">
        <div class="search-bar plugins-search">
          <input type="text" v-model="keyword" placeholder="搜索插件..." class="search-input">
        </div>
        <button class="btn btn-secondary plugins-action-btn" @click="openDocs">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
          开发文档
        </button>
        <button class="btn btn-secondary plugins-action-btn" @click="loadMarket" :disabled="loading">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
          刷新市场
        </button>
        <button class="btn btn-secondary plugins-action-btn" @click="loadLocalPlugin" :disabled="busy === 'local'">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h3.6l1.8 2H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/></svg>
          {{ busy === 'local' ? '安装中...' : '加载本地插件' }}
        </button>
      </div>
      <div class="plugins-tabs">
        <button
          v-for="t in tabs"
          :key="t.key"
          class="plugins-tab"
          :class="{ active: curTab === t.key }"
          @click="setTab(t.key)">
          {{ t.name }}
        </button>
      </div>
    </div>

    <div v-if="loading" class="plugins-state">
      <div class="loading-spinner"><div class="spinner"></div></div>
      <p class="plugins-state-text">正在加载插件市场...</p>
    </div>

    <div v-else-if="error" class="plugins-state">
      <div class="plugins-error-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
      </div>
      <p class="plugins-state-text">{{ error }}</p>
      <button class="btn btn-primary btn-sm" @click="loadMarket">重试</button>
    </div>

    <div v-else-if="!filtered.length" class="plugins-state">
      <p class="plugins-state-text">暂无匹配的插件</p>
    </div>

    <div v-else class="plugins-grid">
      <div class="plugin-card" v-for="p in filtered" :key="p.id">
        <div class="plugin-icon-wrap">
          <img v-if="p.icon" :src="p.icon" class="plugin-icon" alt="">
          <span v-else class="plugin-icon-fallback" v-html="'<svg viewBox=&quot;0 0 24 24&quot; fill=&quot;none&quot; stroke=&quot;currentColor&quot; stroke-width=&quot;1.8&quot;>' + catIcon(p.category) + '</svg>'"></span>
        </div>
        <div class="plugin-main">
          <div class="plugin-name">{{ p.name || p.id }}</div>
          <span class="plugin-cat">{{ catName(p.category) }}</span>
          <div class="plugin-description">{{ p.description || '' }}</div>
          <div class="plugin-meta">
            <span class="plugin-version">v{{ p.version }}</span>
            <span v-if="p.author" class="plugin-author">{{ p.author }}</span>
            <span v-if="p.isInstalled" class="plugin-installed-tag">已安装 v{{ p.installedVersion }}</span>
          </div>
        </div>
        <div class="plugin-actions">
          <template v-if="p.isInstalled">
            <button v-if="p.hasUpdate" class="btn btn-accent btn-sm" :disabled="busy === p.id" @click="install(p)">更新</button>
            <button class="btn btn-secondary btn-sm" :disabled="busy === p.id" @click="uninstall(p)">卸载</button>
          </template>
          <button v-else class="btn btn-primary btn-sm" :disabled="busy === p.id" @click="install(p)">
            {{ busy === p.id ? '安装中...' : '安装' }}
          </button>
        </div>
      </div>
    </div>
  `
};

window.VersePC = window.VersePC || {};
window.VersePC.PagePlugins = PagePlugins;