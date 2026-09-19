/* page-toolbox.js - 工具箱页 Vue 组件（渐进式改造）
 * 原则：
 *   1. CSS 一行不动（class 名保留原样）
 *   2. HTML 结构原样搬运（标签、层级、id 全部不变）
 *   3. JS 函数全部复用（来自 js/app/*.js 的全局函数）
 */
const PageToolbox = {
  template: `
          <div class="page-header">
            <h2>工具箱</h2>
            <p class="page-subtitle">MC 实用网站资源集合</p>
          </div>

          <div class="toolbox-section">
            <h3 class="toolbox-category">百科攻略</h3>
            <div class="toolbox-grid">
              <div class="toolbox-card" onclick="openExternalUrl('https://zh.minecraft.wiki')">
                <img src="" data-domain="zh.minecraft.wiki" alt="" class="toolbox-icon" loading="lazy">
                <div class="toolbox-info">
                  <span class="toolbox-name">Minecraft Wiki</span>
                  <span class="toolbox-desc">最权威的官方百科</span>
                </div>
              </div>
              <div class="toolbox-card" onclick="openExternalUrl('https://www.mcmod.cn')">
                <img src="" data-domain="mcmod.cn" alt="" class="toolbox-icon" loading="lazy">
                <div class="toolbox-info">
                  <span class="toolbox-name">MC百科</span>
                  <span class="toolbox-desc">中文 Mod 百科数据库</span>
                </div>
              </div>
              <div class="toolbox-card" onclick="openExternalUrl('https://www.digminecraft.com')">
                <img src="" data-domain="digminecraft.com" alt="" class="toolbox-icon" loading="lazy">
                <div class="toolbox-info">
                  <span class="toolbox-name">DigMinecraft</span>
                  <span class="toolbox-desc">全物品/方块 ID 查询</span>
                </div>
              </div>
            </div>
          </div>

          <div class="toolbox-section">
            <h3 class="toolbox-category">模组与整合包</h3>
            <div class="toolbox-grid">
              <div class="toolbox-card" onclick="openExternalUrl('https://www.curseforge.com/minecraft')">
                <img src="" data-domain="curseforge.com" alt="" class="toolbox-icon" loading="lazy">
                <div class="toolbox-info">
                  <span class="toolbox-name">CurseForge</span>
                  <span class="toolbox-desc">全球最大 Mod 整合包平台</span>
                </div>
              </div>
              <div class="toolbox-card" onclick="openExternalUrl('https://modrinth.com')">
                <img src="" data-domain="modrinth.com" alt="" class="toolbox-icon" loading="lazy">
                <div class="toolbox-info">
                  <span class="toolbox-name">Modrinth</span>
                  <span class="toolbox-desc">新兴开源 Mod 平台</span>
                </div>
              </div>
              <div class="toolbox-card" onclick="openExternalUrl('https://www.planetminecraft.com')">
                <img src="" data-domain="planetminecraft.com" alt="" class="toolbox-icon" loading="lazy">
                <div class="toolbox-info">
                  <span class="toolbox-name">Planet Minecraft</span>
                  <span class="toolbox-desc">全球最大 MC 社区</span>
                </div>
              </div>
              <div class="toolbox-card" onclick="openExternalUrl('https://www.mcbbs.co/forum.php')">
                <img src="" data-domain="mcbbs.co" alt="" class="toolbox-icon" loading="lazy">
                <div class="toolbox-info">
                  <span class="toolbox-name">MCBBS</span>
                  <span class="toolbox-desc">国内最大 MC 中文论坛</span>
                </div>
              </div>
              <div class="toolbox-card" onclick="openExternalUrl('https://mcpedl.com')">
                <img src="" data-domain="mcpedl.com" alt="" class="toolbox-icon" loading="lazy">
                <div class="toolbox-info">
                  <span class="toolbox-name">MCPEDL</span>
                  <span class="toolbox-desc">基岩版资源大全</span>
                </div>
              </div>
            </div>
          </div>

          <div class="toolbox-section">
            <h3 class="toolbox-category">玩家社区</h3>
            <div class="toolbox-grid">
              <div class="toolbox-card" onclick="openExternalUrl('https://www.minebbs.com')">
                <img src="" data-domain="minebbs.com" alt="" class="toolbox-icon" loading="lazy">
                <div class="toolbox-info">
                  <span class="toolbox-name">MineBBS</span>
                  <span class="toolbox-desc">国内 MC 中文论坛</span>
                </div>
              </div>
              <div class="toolbox-card" onclick="openExternalUrl('https://klpbbs.com')">
                <img src="" data-domain="klpbbs.com" alt="" class="toolbox-icon" loading="lazy">
                <div class="toolbox-info">
                  <span class="toolbox-name">苦力怕论坛</span>
                  <span class="toolbox-desc">资源丰富的中文社区</span>
                </div>
              </div>
              <div class="toolbox-card" onclick="openExternalUrl('https://search.bilibili.com/all?keyword=我的世界')">
                <img src="" data-domain="bilibili.com" alt="" class="toolbox-icon" loading="lazy">
                <div class="toolbox-info">
                  <span class="toolbox-name">Bilibili MC</span>
                  <span class="toolbox-desc">视频教程 / 实况 / 攻略</span>
                </div>
              </div>
            </div>
          </div>

          <div class="toolbox-section">
            <h3 class="toolbox-category">材质与光影</h3>
            <div class="toolbox-grid">
              <div class="toolbox-card" onclick="openExternalUrl('https://resourcepack.net')">
                <img src="" data-domain="resourcepack.net" alt="" class="toolbox-icon" loading="lazy">
                <div class="toolbox-info">
                  <span class="toolbox-name">ResourcePack</span>
                  <span class="toolbox-desc">海量材质包下载</span>
                </div>
              </div>
              <div class="toolbox-card" onclick="openExternalUrl('https://shadersmods.com')">
                <img src="" data-domain="shadersmods.com" alt="" class="toolbox-icon" loading="lazy">
                <div class="toolbox-info">
                  <span class="toolbox-name">ShadersMods</span>
                  <span class="toolbox-desc">光影资源合集</span>
                </div>
              </div>
              <div class="toolbox-card" onclick="openExternalUrl('https://vanillatweaks.net')">
                <img src="" data-domain="vanillatweaks.net" alt="" class="toolbox-icon" loading="lazy">
                <div class="toolbox-info">
                  <span class="toolbox-name">Vanilla Tweaks</span>
                  <span class="toolbox-desc">原版微调增强包</span>
                </div>
              </div>
            </div>
          </div>

          <div class="toolbox-section">
            <h3 class="toolbox-category">地图与建筑</h3>
            <div class="toolbox-grid">
              <div class="toolbox-card" onclick="openExternalUrl('https://www.plotz.co.uk')">
                <img src="" data-domain="plotz.co.uk" alt="" class="toolbox-icon" loading="lazy">
                <div class="toolbox-info">
                  <span class="toolbox-name">Plotz</span>
                  <span class="toolbox-desc">圆形/球形建造蓝图</span>
                </div>
              </div>
              <div class="toolbox-card" onclick="openExternalUrl('https://www.blockpalettes.com')">
                <img src="" data-domain="blockpalettes.com" alt="" class="toolbox-icon" loading="lazy">
                <div class="toolbox-info">
                  <span class="toolbox-name">Block Palettes</span>
                  <span class="toolbox-desc">方块配色方案库</span>
                </div>
              </div>
              <div class="toolbox-card" onclick="openExternalUrl('https://minecraftshapes.com')">
                <img src="" data-domain="minecraftshapes.com" alt="" class="toolbox-icon" loading="lazy">
                <div class="toolbox-info">
                  <span class="toolbox-name">MinecraftShapes</span>
                  <span class="toolbox-desc">几何形状建造指南</span>
                </div>
              </div>
              <div class="toolbox-card" onclick="openExternalUrl('https://www.minecraftmaps.com')">
                <img src="" data-domain="minecraftmaps.com" alt="" class="toolbox-icon" loading="lazy">
                <div class="toolbox-info">
                  <span class="toolbox-name">Minecraft Maps</span>
                  <span class="toolbox-desc">冒险/解谜地图下载</span>
                </div>
              </div>
            </div>
          </div>

          <div class="toolbox-section">
            <h3 class="toolbox-category">在线工具</h3>
            <div class="toolbox-grid">
              <div class="toolbox-card" onclick="openExternalUrl('https://www.chunkbase.com')">
                <img src="" data-domain="chunkbase.com" alt="" class="toolbox-icon" loading="lazy">
                <div class="toolbox-info">
                  <span class="toolbox-name">Chunkbase</span>
                  <span class="toolbox-desc">种子地图 / 结构定位</span>
                </div>
              </div>
              <div class="toolbox-card" onclick="openExternalUrl('https://mcstacker.net')">
                <img src="" data-domain="mcstacker.net" alt="" class="toolbox-icon" loading="lazy">
                <div class="toolbox-info">
                  <span class="toolbox-name">MCStacker</span>
                  <span class="toolbox-desc">命令在线生成器</span>
                </div>
              </div>
              <div class="toolbox-card" onclick="openExternalUrl('https://minecraft.tools')">
                <img src="" data-domain="minecraft.tools" alt="" class="toolbox-icon" loading="lazy">
                <div class="toolbox-info">
                  <span class="toolbox-name">MC Tools</span>
                  <span class="toolbox-desc">合成/烟花/药水/旗帜</span>
                </div>
              </div>
              <div class="toolbox-card" onclick="openExternalUrl('https://misode.github.io')">
                <img src="" data-domain="misode.github.io" alt="" class="toolbox-icon" loading="lazy">
                <div class="toolbox-info">
                  <span class="toolbox-name">Misode</span>
                  <span class="toolbox-desc">数据包 / 世界编辑器</span>
                </div>
              </div>
              <div class="toolbox-card" onclick="openExternalUrl('https://mclo.gs')">
                <img src="" data-domain="mclo.gs" alt="" class="toolbox-icon" loading="lazy">
                <div class="toolbox-info">
                  <span class="toolbox-name">mclo.gs</span>
                  <span class="toolbox-desc">游戏日志分析工具</span>
                </div>
              </div>
              <div class="toolbox-card" onclick="openExternalUrl('https://minecraft-heads.com')">
                <img src="" data-domain="minecraft-heads.com" alt="" class="toolbox-icon" loading="lazy">
                <div class="toolbox-info">
                  <span class="toolbox-name">Minecraft Heads</span>
                  <span class="toolbox-desc">头颅数据库/give指令</span>
                </div>
              </div>
              <div class="toolbox-card" onclick="openExternalUrl('https://colorize.fun')">
                <img src="" data-domain="colorize.fun" alt="" class="toolbox-icon" loading="lazy">
                <div class="toolbox-info">
                  <span class="toolbox-name">Colorize FUN</span>
                  <span class="toolbox-desc">MC 彩色文本生成器</span>
                </div>
              </div>
              <div class="toolbox-card" onclick="openExternalUrl('https://textcraft.net')">
                <img src="" data-domain="textcraft.net" alt="" class="toolbox-icon" loading="lazy">
                <div class="toolbox-info">
                  <span class="toolbox-name">Textcraft</span>
                  <span class="toolbox-desc">MC 风格 Logo 生成</span>
                </div>
              </div>
              <div class="toolbox-card" onclick="openExternalUrl('https://www.craftmc.net')">
                <img src="" data-domain="craftmc.net" alt="" class="toolbox-icon" loading="lazy">
                <div class="toolbox-info">
                  <span class="toolbox-name">CraftMC Tools</span>
                  <span class="toolbox-desc">红石模拟/圆形生成</span>
                </div>
              </div>
            </div>
          </div>

          <div class="toolbox-section">
            <h3 class="toolbox-category">皮肤资源</h3>
            <div class="toolbox-grid">
              <div class="toolbox-card" onclick="openExternalUrl('https://namemc.com')">
                <img src="" data-domain="namemc.com" alt="" class="toolbox-icon" loading="lazy">
                <div class="toolbox-info">
                  <span class="toolbox-name">NameMC</span>
                  <span class="toolbox-desc">正版皮肤 / UUID 查询</span>
                </div>
              </div>
              <div class="toolbox-card" onclick="openExternalUrl('https://littleskin.cn')">
                <img src="" data-domain="littleskin.cn" alt="" class="toolbox-icon" loading="lazy">
                <div class="toolbox-info">
                  <span class="toolbox-name">LittleSkin</span>
                  <span class="toolbox-desc">国内皮肤站</span>
                </div>
              </div>
              <div class="toolbox-card" onclick="openExternalUrl('https://novaskin.me')">
                <img src="" data-domain="novaskin.me" alt="" class="toolbox-icon" loading="lazy">
                <div class="toolbox-info">
                  <span class="toolbox-name">Nova Skin</span>
                  <span class="toolbox-desc">3D 皮肤编辑器</span>
                </div>
              </div>
              <div class="toolbox-card" onclick="openExternalUrl('https://www.minecraftskins.com')">
                <img src="" data-domain="minecraftskins.com" alt="" class="toolbox-icon" loading="lazy">
                <div class="toolbox-info">
                  <span class="toolbox-name">The Skindex</span>
                  <span class="toolbox-desc">百万皮肤分享社区</span>
                </div>
              </div>
              <div class="toolbox-card" onclick="openExternalUrl('https://skinmc.net')">
                <img src="" data-domain="skinmc.net" alt="" class="toolbox-icon" loading="lazy">
                <div class="toolbox-info">
                  <span class="toolbox-name">SkinMC</span>
                  <span class="toolbox-desc">3D 皮肤查看器</span>
                </div>
              </div>
            </div>
          </div>

          <div class="toolbox-section">
            <h3 class="toolbox-category">服务器与插件</h3>
            <div class="toolbox-grid">
              <div class="toolbox-card" onclick="openExternalUrl('https://findmcserver.com')">
                <img src="" data-domain="findmcserver.com" alt="" class="toolbox-icon" loading="lazy">
                <div class="toolbox-info">
                  <span class="toolbox-name">FindMCServer</span>
                  <span class="toolbox-desc">Mojang 官方服务器列表</span>
                </div>
              </div>
              <div class="toolbox-card" onclick="openExternalUrl('https://minecraftservers.org')">
                <img src="" data-domain="minecraftservers.org" alt="" class="toolbox-icon" loading="lazy">
                <div class="toolbox-info">
                  <span class="toolbox-name">MC Servers</span>
                  <span class="toolbox-desc">国际服务器列表</span>
                </div>
              </div>
              <div class="toolbox-card" onclick="openExternalUrl('https://www.spigotmc.org')">
                <img src="" data-domain="spigotmc.org" alt="" class="toolbox-icon" loading="lazy">
                <div class="toolbox-info">
                  <span class="toolbox-name">SpigotMC</span>
                  <span class="toolbox-desc">服务器插件/Paper核心</span>
                </div>
              </div>
              <div class="toolbox-card" onclick="openExternalUrl('https://www.mczfw.com')">
                <img src="" data-domain="mczfw.com" alt="" class="toolbox-icon" loading="lazy">
                <div class="toolbox-info">
                  <span class="toolbox-name">找服网</span>
                  <span class="toolbox-desc">国内服务器大全</span>
                </div>
              </div>
            </div>
          </div>

          <div class="toolbox-section">
            <h3 class="toolbox-category">资源导航</h3>
            <div class="toolbox-grid">
              <div class="toolbox-card" onclick="openExternalUrl('https://www.mcnav.net')">
                <img src="" data-domain="mcnav.net" alt="" class="toolbox-icon" loading="lazy">
                <div class="toolbox-info">
                  <span class="toolbox-name">MCNav</span>
                  <span class="toolbox-desc">MC 资源大全一站导航</span>
                </div>
              </div>
            </div>
          </div>

          <div class="toolbox-section">
            <h3 class="toolbox-category">下载自定义文件</h3>
            <div class="toolbox-grid" style="grid-template-columns:1fr;">
              <div style="background:var(--glass-bg);border-radius:12px;padding:20px;border:1px solid var(--border-color);">
                <p class="hint" style="margin-bottom:16px;">使用启动器的高速多线程下载引擎下载任意文件。请注意，部分网站（例如百度网盘）可能会报错（403），无法正常下载。</p>
                <div class="form-group" style="margin-bottom:12px;">
                  <label style="font-weight:500;margin-bottom:6px;display:block;">下载地址</label>
                  <input type="text" id="custom-dl-url" class="text-input" style="width:100%;" placeholder="https://example.com/file.zip">
                </div>
                <div class="form-group" style="margin-bottom:12px;">
                  <label style="font-weight:500;margin-bottom:6px;display:block;">保存到</label>
                  <div style="display:flex;gap:8px;align-items:center;">
                    <input type="text" id="custom-dl-path" class="text-input" style="flex:1;" placeholder="点击右侧按钮选择" readonly>
                    <button type="button" class="btn btn-secondary btn-sm" onclick="browseCustomDlPath()">选择</button>
                  </div>
                </div>
                <div class="form-group" style="margin-bottom:16px;">
                  <label style="font-weight:500;margin-bottom:6px;display:block;">文件名</label>
                  <input type="text" id="custom-dl-filename" class="text-input" style="width:100%;" placeholder="留空则自动获取">
                </div>
                <div id="custom-dl-progress" style="display:none;margin-bottom:16px;">
                  <div class="progress-container">
                    <div class="progress-bar">
                      <div id="custom-dl-progress-fill" class="progress-fill" style="width:0%"></div>
                    </div>
                    <div id="custom-dl-progress-text" class="progress-text">0%</div>
                  </div>
                  <p id="custom-dl-status" class="hint" style="margin-top:8px;">准备下载...</p>
                </div>
                <div style="display:flex;gap:12px;">
                  <button type="button" class="btn btn-primary" id="custom-dl-start-btn" onclick="startCustomDownload()">开始下载</button>
                  <button type="button" class="btn btn-secondary" id="custom-dl-cancel-btn" style="display:none;" onclick="cancelCustomDownload()">取消下载</button>
                  <button type="button" class="btn btn-secondary" onclick="openCustomDlFolder()">打开文件夹</button>
                </div>
              </div>
            </div>
          </div>

          <div class="toolbox-section">
            <h3 class="toolbox-category">测试服务器</h3>
            <div class="toolbox-grid" style="grid-template-columns:1fr;">
              <div style="background:var(--glass-bg);border-radius:12px;padding:20px;border:1px solid var(--border-color);">
                <p class="hint" style="margin-bottom:16px;">输入服务器地址查询在线状态、MOTD、版本与延迟。支持：IP / 域名、IP:端口、IPv6，不填端口默认 25565。</p>
                <div style="display:flex;gap:8px;margin-bottom:14px;">
                  <input type="text" v-model="sqInput" class="text-input" style="flex:1;min-width:0;" placeholder="例如：mc.hypixel.net 或 play.example.com:25565" @keydown.enter="doQuery">
                  <button type="button" class="btn btn-primary" :disabled="sqQuerying" @click="doQuery">{{ sqQuerying ? '查询中...' : '查询' }}</button>
                </div>
                <div id="mc-server-query-results" class="mc-sq-list">
                  <div v-for="(r, idx) in sqResults" :key="idx" v-html="r.html"></div>
                  <p v-if="sqResults.length === 0" class="empty-text">暂无查询结果</p>
                </div>
              </div>
            </div>
          </div>

  `,
  data() {
    return {
      sqInput: '',
      sqQuerying: false,
      sqResults: []
    };
  },
  methods: {
    async doQuery() {
      var self = this;
      if (self.sqQuerying) return;
      var input = (self.sqInput || '').trim();
      if (!input) {
        if (typeof showToast === 'function') showToast('请输入服务器地址', 'info');
        return;
      }
      var parsed = (typeof window._sqParseAddress === 'function') ? window._sqParseAddress(input) : null;
      if (!parsed || !parsed.host) {
        if (typeof showToast === 'function') showToast('地址格式无法识别，请检查后重试', 'error');
        return;
      }
      var core = null;
      if (window.__TAURI__ && window.__TAURI__.core) core = window.__TAURI__.core;
      else if (window.__TAURI_INTERNALS__) core = window.__TAURI_INTERNALS__;
      if (!core || !core.invoke) {
        if (typeof showToast === 'function') showToast('当前环境不支持服务器查询', 'error');
        return;
      }

      var addressLabel = parsed.host + (parsed.port && parsed.port !== 25565 ? ':' + parsed.port : '');
      self.sqQuerying = true;

      // 先插一个查询中的占位（追加到列表顶部，最新在上）
      self.sqResults.unshift({
        html: '<div class="mc-sq-row mc-sq-row--querying">' +
          '<div class="mc-sq-icon mc-sq-icon-fallback"><svg class="dl-spinner" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="width:20px;height:20px;"><path d="M21 12a9 9 0 11-6.2-8.56"/></svg></div>' +
          '<div class="mc-sq-main"><div class="mc-sq-name">' + window._sqEsc(addressLabel) + '</div>' +
          '<div class="mc-sq-motd" style="opacity:.6;">正在查询服务器信息...</div></div></div>'
      });
      var placeholderIdx = 0;

      try {
        var result = await core.invoke('tool_server_query', {
          address: parsed.host,
          port: parsed.port ? parsed.port : null
        });
        var row = (result && result.ok)
          ? window._sqResultRow({ ok: true, address: addressLabel, status: result.status, pingMs: result.pingMs })
          : window._sqResultRow({ ok: false, address: addressLabel, error: (result && result.error) || '查询失败' });
        self.sqResults.splice(placeholderIdx, 1, { html: row });
        if (typeof showToast === 'function') showToast('查询完成：' + addressLabel, 'success');
      } catch (e) {
        var msg = (e && e.message) ? e.message : String(e);
        self.sqResults.splice(placeholderIdx, 1, { html: window._sqResultRow({ ok: false, address: addressLabel, error: msg }) });
        if (typeof showToast === 'function') showToast('查询失败：' + addressLabel, 'error');
      } finally {
        self.sqQuerying = false;
      }
    }
  }
};

window.VersePC = window.VersePC || {};
window.VersePC.PageToolbox = PageToolbox;

// 工具箱图标加载函数（兼容 Tauri v1/v2 invoke 和旧 HTTP）
function _loadToolboxFavicons() {
  // 统一获取 Tauri invoke 函数（兼容 v1 __TAURI__ 和 v2 __TAURI_INTERNALS__）
  function _getCore() {
    if (window.__TAURI__ && window.__TAURI__.core) return window.__TAURI__.core;
    if (window.__TAURI_INTERNALS__) return window.__TAURI_INTERNALS__;
    return null;
  }

  document.querySelectorAll('.toolbox-icon[data-domain]').forEach(img => {
    const domain = img.dataset.domain;
    if (!domain) return;
    if (img.src && img.src.startsWith('data:')) return; // 已加载

    const core = _getCore();
    if (core && core.invoke) {
      core.invoke('get_favicon', { domain }).then(result => {
        if (result && result.data_url) {
          img.src = result.data_url;
        }
      }).catch(() => {});
    } else {
      img.src = '/api/favicon?domain=' + encodeURIComponent(domain);
    }
  });
}

// 组件挂载后自动加载图标
if (PageToolbox.mounted) {
  const origMounted = PageToolbox.mounted;
  PageToolbox.mounted = function() {
    origMounted.call(this);
    setTimeout(_loadToolboxFavicons, 100);
  };
} else {
  PageToolbox.mounted = function() {
    setTimeout(_loadToolboxFavicons, 100);
  };
}
