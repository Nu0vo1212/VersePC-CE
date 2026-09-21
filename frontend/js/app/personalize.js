/* personalize.js - 个性化设置逻辑层
 * 结构：
 *   1. 值参数核心函数（applyXxxValue/applyXxxByName）：副作用 + 持久化，供 Vue 卡片组件直接调用
 *   2. DOM 兼容层（selectXxx/onXxxChange）：保留 class/label 等 DOM 操作后委托核心，
 *      供启动恢复（init-setup.js）与旧调用方使用
 *   3. 共享响应式状态读写辅助：window.VersePC.personalizeState 由 Vue 页面组件创建
 */

// ============== 共享状态辅助 ==============

function getPersonalizeState() {
  return (window.VersePC && window.VersePC.personalizeState) || null;
}

/** 兼容 Tauri readFileBuffer 三种返回格式（Base64 字符串 / number[] / Uint8Array）→ Uint8Array */
window.decodeFileBuffer = function (res) {
  if (typeof res === 'string') {
    try {
      const bin = atob(res);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return bytes;
    } catch (e) {
      return new Uint8Array(0);
    }
  }
  return res instanceof Uint8Array ? res : new Uint8Array(res || []);
};

// ============== 壁纸：值参数核心函数 ==============

/** 懒初始化壁纸引擎 */
async function _ensureWallpaperEngine() {
  if (typeof wallpaperEngine === 'undefined' || !wallpaperEngine) {
    if (typeof _lazyLoadScript === 'function') {
      try { await _lazyLoadScript('js/three.bundle.js'); } catch (e) {}
    }
    if (typeof initWallpaper === 'function') {
      try { initWallpaper(); } catch (e) { console.error('[Wallpaper] init error:', e); }
    }
  }
}

/** 应用壁纸模式（引擎切换 + 副作用 + 持久化；不含页面子区域显隐，由 Vue 状态派生） */
async function applyWallpaperByName(mode) {
  // Wallpaper Engine 专用模式：按所选壁纸类型分发渲染
  if (mode === 'wallpaperEngine') {
    const st = getPersonalizeState();
    let sel = st && st.weWallpaper;
    if (!sel) {
      try {
        const saved = await window.electronAPI?.store?.get('versepc_we_wallpaper');
        if (saved) sel = JSON.parse(saved);
      } catch (e) {}
    }
    if (!sel) return;
    await _ensureWallpaperEngine();
    _applyWeDispatch(sel);
    return;
  }

  await _ensureWallpaperEngine();

  // 普通自定义视频保持静音（仅 WE 视频壁纸开启音频）
  if (mode === 'customVideo' && typeof setWeVideoAudio === 'function') {
    setWeVideoAudio(false);
  }

  if (typeof switchWallpaperMode === 'function') {
    switchWallpaperMode(mode);
  }

  const st = getPersonalizeState();
  if (st) st.wallpaper = mode;

  const isAurora = mode === 'auroraVideo';
  const isPanorama = mode === 'panorama';

  if (isAurora) {
    if (typeof setWallpaperFitMode === 'function') setWallpaperFitMode('cover');
    if (typeof setWallpaperBlur === 'function') setWallpaperBlur(0);
    if (typeof setWallpaperOpacity === 'function') setWallpaperOpacity(1);
    document.body.classList.add('aurora-theme');
    if (st) st.fit = 'cover';
    try {
      await window.electronAPI.store.set('versepc_wallpaper_fit', 'cover');
    } catch (e) {}
  } else {
    document.body.classList.remove('aurora-theme');
  }

  if (isPanorama) {
    try {
      const [savedTheme, savedSpeed, savedFollow] = await Promise.all([
        window.electronAPI?.store?.get('versepc_panorama_theme'),
        window.electronAPI?.store?.get('versepc_panorama_speed'),
        window.electronAPI?.store?.get('versepc_panorama_mouse_follow'),
      ]);
      if (savedTheme && typeof setPanoramaTheme === 'function') setPanoramaTheme(savedTheme);
      if (savedSpeed != null && typeof setPanoramaRotationSpeed === 'function') setPanoramaRotationSpeed(savedSpeed * 0.001);
      if (savedFollow === true && typeof setPanoramaMouseFollow === 'function') setPanoramaMouseFollow(true);
    } catch (e) {
      console.warn('[Settings] Failed to restore panorama settings:', e);
    }
  }

  try {
    await window.electronAPI.store.set('versepc_wallpaper', mode);
  } catch (e) {
    console.error('[Settings] Save wallpaper error:', e);
  }
}

/** 按 WE 壁纸类型分发到对应渲染器（需引擎已初始化） */
async function _applyWeDispatch(sel) {
  if (!sel || typeof wallpaperEngine === 'undefined' || !wallpaperEngine) return;
  const type = sel.type;
  if (type === 'video' && sel.filePath) {
    if (typeof setWeVideoAudio === 'function') setWeVideoAudio(true);
    wallpaperEngine.customVideoPath = sel.filePath;
    if (wallpaperEngine.currentMode === 'customVideo' && wallpaperEngine.renderer && wallpaperEngine.renderer.loadVideo) {
      wallpaperEngine.renderer.loadVideo(sel.filePath);
    } else if (typeof switchWallpaperMode === 'function') {
      switchWallpaperMode('customVideo');
    }
  } else if (type === 'web') {
    const relFile = sel.file || 'index.html';
    const segs = String(relFile).split(/[\\/]/).map(s => encodeURIComponent(s)).join('/');
    const src = 'wewp://localhost/' + encodeURIComponent(sel.id || '0') + '/' + segs;
    wallpaperEngine.webWallpaperSrc = src;
    if (wallpaperEngine.currentMode === 'webWallpaper' && wallpaperEngine.renderer && wallpaperEngine.renderer.loadWeb) {
      wallpaperEngine.renderer.loadWeb(src);
    } else if (typeof switchWallpaperMode === 'function') {
      switchWallpaperMode('webWallpaper');
    }
  } else if (type === 'scene') {
    // 场景壁纸：启动离屏渲染进程，<img> 显示本地 MJPEG 流
    if (typeof startSceneWallpaper === 'function') {
      const ok = await startSceneWallpaper(sel.id);
      if (!ok && typeof showToast === 'function') {
        showToast('场景壁纸渲染失败，请查看数据目录 logs/scene-renderer.log', 'error');
      }
    }
  } else {
    // application / 未知类型：用预览图静态占位，并明确提示限制
    if (sel.previewPath) {
      wallpaperEngine.customImagePath = sel.previewPath;
      if (wallpaperEngine.currentMode === 'customImage' && wallpaperEngine.renderer && wallpaperEngine.renderer.loadImage) {
        wallpaperEngine.renderer.loadImage(sel.previewPath);
      } else if (typeof switchWallpaperMode === 'function') {
        switchWallpaperMode('customImage');
      }
    }
    if (typeof showToast === 'function' && type !== 'background') {
      const typeName = type === 'application' ? '应用' : '该';
      showToast(`${typeName}型壁纸暂不支持动态渲染，已显示静态预览`, 'info');
    }
  }
}

/** 应用用户选择的 WE 壁纸：写入状态 + 持久化 + 分发渲染 */
async function applyWeWallpaper(sel) {
  if (!sel) return;
  const st = getPersonalizeState();
  if (st) {
    st.wallpaper = 'wallpaperEngine';
    st.weWallpaper = sel;
  }
  try { await window.electronAPI.store.set('versepc_we_wallpaper', JSON.stringify(sel)); } catch (e) {}
  try { await window.electronAPI.store.set('versepc_wallpaper', 'wallpaperEngine'); } catch (e) {}
  await _ensureWallpaperEngine();
  _applyWeDispatch(sel);
}

/** 应用全景主题（引擎 + 持久化） */
function applyPanoramaThemeByName(theme) {
  if (typeof setPanoramaTheme === 'function') setPanoramaTheme(theme);
  window.electronAPI?.store?.set('versepc_panorama_theme', theme).catch(() => {});
  const st = getPersonalizeState();
  if (st) st.panoramaTheme = theme;
}

/** 应用壁纸不透明度（引擎 + 持久化） */
function applyWallpaperOpacityValue(value) {
  const opacity = value / 100;
  if (typeof setWallpaperOpacity === 'function') setWallpaperOpacity(opacity);
  window.electronAPI?.store?.set('versepc_wallpaper_opacity', value).catch(() => {});
  const st = getPersonalizeState();
  if (st) st.opacity = Number(value);
}

/** 应用壁纸模糊（引擎 + 持久化） */
function applyWallpaperBlurValue(value) {
  if (typeof setWallpaperBlur === 'function') setWallpaperBlur(parseInt(value));
  window.electronAPI?.store?.set('versepc_wallpaper_blur', value).catch(() => {});
  const st = getPersonalizeState();
  if (st) st.blur = Number(value);
}

/** 应用壁纸适配方式（引擎 + 持久化） */
function applyWallpaperFitValue(value) {
  if (typeof setWallpaperFitMode === 'function') setWallpaperFitMode(value);
  window.electronAPI?.store?.set('versepc_wallpaper_fit', value).catch(() => {});
  const st = getPersonalizeState();
  if (st) st.fit = value;
}

/** 应用全景转速（引擎 + 持久化） */
function applyPanoramaSpeedValue(value) {
  const speed = value * 0.001;
  if (typeof setPanoramaRotationSpeed === 'function') setPanoramaRotationSpeed(speed);
  window.electronAPI?.store?.set('versepc_panorama_speed', parseInt(value)).catch(() => {});
  const st = getPersonalizeState();
  if (st) st.panoramaSpeed = Number(value);
}

/** 应用全景跟随鼠标（引擎 + 持久化） */
function applyPanoramaFollowValue(enabled) {
  if (typeof setPanoramaMouseFollow === 'function') setPanoramaMouseFollow(enabled);
  window.electronAPI?.store?.set('versepc_panorama_mouse_follow', enabled);
  const st = getPersonalizeState();
  if (st) st.panoramaFollow = !!enabled;
}

// ============== 视觉效果：值参数核心函数 ==============
// 四个互斥选项：none（扁平默认）/ frosted 毛玻璃 / liquid 液态玻璃 / acrylic 亚克力
// 开关落在 <html data-glass="..."> 上，具体材质见 css/glass-effect.css。
// ⚠️ 只改这一个属性：不需要重算主题变量，切换即时生效且不触碰 --bg-* 系列。
// ⚠️ 材质只在深色主题（黑 / 自定义深色）下生效：浅色底上玻璃没有层次，只剩一层灰膜。
//    用户在浅色下做的选择会被记住（存 store），切回深色自动恢复，不用重选。

const GLASS_EFFECT_MODES = ['none', 'frosted', 'liquid', 'acrylic'];

/** 用户上一次选择的材质（store 之外再记一份，供主题切换时重算 DOM 用） */
let _glassEffectPref = 'none';
/** 上一次的"被浅色禁用"状态，只在状态翻转时提示一次，避免反复弹 toast */
let _glassBlockedPrev = false;

/** 当前界面是否处于浅色（白色主题，或自定义主题的浅色模式） */
function isLightThemeActive() {
  const de = document.documentElement;
  if (de.classList.contains('light-theme')) return true;
  const theme = de.getAttribute('data-theme') || '';
  if (theme === 'light') return true;
  if (theme === 'custom') return de.getAttribute('data-custom-theme-mode') === 'light';
  return false;
}

/** 材质在当前主题下是否不可用（只有浅色会禁用；'none' 永远可用） */
function isGlassEffectBlocked(mode) {
  return !!mode && mode !== 'none' && isLightThemeActive();
}

/** 只写 DOM：被禁用时摘掉 data-glass，偏好值不动 */
function renderGlassEffect(mode) {
  const root = document.documentElement;
  if (mode && mode !== 'none' && !isGlassEffectBlocked(mode)) root.setAttribute('data-glass', mode);
  else root.removeAttribute('data-glass');
}

/**
 * 应用视觉效果（副作用 + 持久化）
 * @param {string} mode none | frosted | liquid | acrylic
 * @param {{silent?: boolean}} [opts] silent=true 时不弹提示（启动恢复用）
 */
function applyGlassEffectByName(mode, opts) {
  const m = GLASS_EFFECT_MODES.indexOf(mode) >= 0 ? mode : 'none';
  const silent = !!(opts && opts.silent);
  _glassEffectPref = m;

  renderGlassEffect(m);
  window.electronAPI?.store?.set('versepc_glass_effect', m).catch(() => {});

  const blocked = isGlassEffectBlocked(m);
  const st = getPersonalizeState();
  if (st) {
    st.glassEffect = m;
    st.glassBlocked = blocked;
  }
  if (!silent && blocked && !_glassBlockedPrev && typeof showToast === 'function') {
    showToast('视觉效果仅在深色主题下可用，已保留你的选择', 'warning');
  }
  _glassBlockedPrev = blocked;
  return m;
}

/**
 * 主题切换后重新校验材质（偏好保留在 store，切回深色自动恢复）
 * @param {{silent?: boolean}} [opts]
 */
function syncGlassEffectWithTheme(opts) {
  const silent = !!(opts && opts.silent);
  const st = getPersonalizeState();
  const mode = (st && st.glassEffect) || _glassEffectPref || 'none';

  renderGlassEffect(mode);

  const blocked = isGlassEffectBlocked(mode);
  if (st) st.glassBlocked = blocked;
  if (!silent && blocked && !_glassBlockedPrev && typeof showToast === 'function') {
    showToast('当前为浅色主题，视觉效果已暂时关闭（切回深色自动恢复）', 'info');
  }
  _glassBlockedPrev = blocked;
  return !blocked;
}

// ============== 动画速度：值参数核心函数 ==============

/** 应用全局动画速度（倍率：1.1 = 比 1.0 快 10%，0.9 = 慢 10%，1.0 = 标准） */
function applyAnimationSpeedValue(value) {
  const mult = Number(value);
  if (!isFinite(mult) || mult <= 0) return;
  const v = Math.round(mult * 100) / 100;
  if (typeof applyAnimationSpeed === 'function') applyAnimationSpeed(v);
  window.electronAPI?.store?.set('versepc_anim_speed', v).catch(() => {});
  const st = getPersonalizeState();
  if (st) st.animSpeed = v;
}

// ============== 壁纸：DOM 兼容层（保留给启动恢复等非 Vue 调用） ==============

async function selectWallpaper(element) {
  document.querySelectorAll('.wallpaper-option').forEach(opt => opt.classList.remove('active'));
  element.classList.add('active');

  const mode = element.dataset.wallpaper;
  const st = getPersonalizeState();
  if (st) st.wallpaper = mode;

  await applyWallpaperByName(mode);
}

async function pickCustomWallpaperFile() {
  const st = getPersonalizeState();
  const activeMode = st ? st.wallpaper : (document.querySelector('.wallpaper-option.active')?.dataset.wallpaper);
  const isVideo = activeMode === 'customVideo';

  const filters = isVideo
    ? [{ name: '视频文件', extensions: ['mp4', 'webm', 'mkv', 'avi'] }]
    : [{ name: '图片文件', extensions: ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp'] }];

  try {
    const result = await window.electronAPI.selectFile({
      title: isVideo ? '选择视频壁纸' : '选择图片壁纸',
      filters
    });

    if (result.cancelled) return;

    const filePath = result.path;
    if (!filePath) {
      if (typeof showToast === 'function') showToast('未获取到文件路径，请重新选择', 'error');
      return;
    }
    await _applyCustomWallpaperFile(filePath, isVideo);
  } catch (e) {
    console.error('[Wallpaper] Pick file error:', e);
  }
}

async function _applyCustomWallpaperFile(filePath, isVideo) {
  if (!filePath) {
    if (typeof showToast === 'function') showToast('未获取到文件路径，请重新选择', 'error');
    return;
  }
  const fileName = filePath.split(/[\\/]/).pop();
  const st = getPersonalizeState();
  if (st) st.customFileName = fileName;
  document.getElementById('custom-wallpaper-file-name').textContent = fileName;

  if (isVideo) {
    if (typeof setCustomWallpaperVideo === 'function') {
      setCustomWallpaperVideo(filePath);
    }
    try { await window.electronAPI.store.set('versepc_custom_video', filePath); } catch (e) {}
  } else {
    if (typeof setCustomWallpaperImage === 'function') {
      setCustomWallpaperImage(filePath);
    }
    try { await window.electronAPI.store.set('versepc_custom_image', filePath); } catch (e) {}
    _updateCustomImagePreview(filePath);
  }
}

function _updateCustomImagePreview(filePath) {
  const preview = document.getElementById('wp-preview-custom-image');
  if (!preview) return;
  const icon = preview.querySelector('.wp-preview-icon');
  if (filePath) {
    if (icon) icon.style.display = 'none';
    let img = preview.querySelector('.wp-preview-thumb');
    if (!img) {
      img = document.createElement('img');
      img.className = 'wp-preview-thumb';
      img.style.cssText = 'width:100%;height:100%;object-fit:cover;position:absolute;inset:0;';
      preview.style.position = 'relative';
      preview.appendChild(img);
    }
    // Tauri 环境未注册 wpfile:// 协议，改用 readFileBuffer → blob 加载本地图片预览
    img.src = '';
    if (window.electronAPI && window.electronAPI.readFileBuffer) {
      window.electronAPI.readFileBuffer(filePath)
        .then((buffer) => {
          const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer || []);
          if (!u8 || u8.byteLength === 0) throw new Error('empty');
          const ext = String(filePath).toLowerCase().split('.').pop();
          const mimeMap = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp', svg: 'image/svg+xml' };
          const mime = mimeMap[ext] || 'image/png';
          const blob = new Blob([u8], { type: mime });
          img.src = URL.createObjectURL(blob);
        })
        .catch(() => {
          img.src = typeof wpfilePath === 'function' ? wpfilePath(filePath) : '';
        });
    } else {
      img.src = typeof wpfilePath === 'function' ? wpfilePath(filePath) : '';
    }
  } else {
    if (icon) icon.style.display = '';
    const img = preview.querySelector('.wp-preview-thumb');
    if (img) img.remove();
  }
}

function initWallpaperAutoAdapt() {
  if (typeof onWallpaperBrightnessChange !== 'function') return;

  onWallpaperBrightnessChange((brightness) => {
    const overlay = document.getElementById('wallpaper-overlay');
    if (!overlay) return;

    const app = document.getElementById('app');
    if (!app) return;

    const currentTheme = document.documentElement.getAttribute('data-theme') || 'dark';
    const isLightTheme = currentTheme === 'light' ||
        (currentTheme === 'custom' && document.documentElement.getAttribute('data-custom-theme-mode') === 'light');
    const isLight = brightness > 0.55;
    const isDark = brightness < 0.35;

    if (isLightTheme) {
      app.classList.remove('wp-light', 'wp-dark');
      overlay.style.background = 'transparent';
    } else if (isLight) {
      overlay.style.background = 'rgba(0, 0, 0, 0.15)';
      app.classList.add('wp-light');
      app.classList.remove('wp-dark');
    } else if (isDark) {
      overlay.style.background = 'transparent';
      app.classList.add('wp-dark');
      app.classList.remove('wp-light');
    } else {
      const alpha = (0.55 - brightness) * 0.3;
      overlay.style.background = `rgba(0, 0, 0, ${Math.max(0, alpha)})`;
      app.classList.remove('wp-light', 'wp-dark');
    }

    document.documentElement.style.setProperty('--wp-brightness', brightness);
  });
}

// ============== 壁纸控制：DOM 兼容层（值传给核心） ==============

function onWallpaperOpacityChange(value) {
  const el = document.getElementById('wallpaper-opacity-value');
  if (el) el.textContent = value + '%';
  applyWallpaperOpacityValue(value);
}

function onWallpaperBlurChange(value) {
  const el = document.getElementById('wallpaper-blur-value');
  if (el) el.textContent = value + 'px';
  applyWallpaperBlurValue(value);
}

function onWallpaperFitChange(value) {
  applyWallpaperFitValue(value);
}

function selectPanoramaTheme(element) {
  document.querySelectorAll('.panorama-theme-option').forEach(opt => opt.classList.remove('active'));
  element.classList.add('active');
  applyPanoramaThemeByName(element.dataset.theme);
}

function onPanoramaSpeedChange(value) {
  const label = document.getElementById('panoramaSpeedLabel');
  if (label) label.textContent = value;
  applyPanoramaSpeedValue(value);
}

function onPanoramaMouseFollowChange(enabled) {
  applyPanoramaFollowValue(enabled);
}

// ============== AI 密钥可见性（其他页面使用） ==============

function aiToggleApiKeyVisibility() {
  const input = document.getElementById('ai-api-key-input');
  if (!input) return;
  const btn = input.parentElement.querySelector('button');
  if (input.type === 'password') {
    input.type = 'text';
    if (btn) btn.textContent = '隐藏';
  } else {
    input.type = 'password';
    if (btn) btn.textContent = '显示';
  }
}

// ============== 主题辅助 ==============
// 原先这里有一对 applyThemeColors() / updateCustomAccentColor()，属于已下线的
// "自定义强调色"UI（#custom-accent-color / #color-preview-dot）的遗留代码：
// 它们同样会把 --accent 以 inline 方式写到 <html> 上，永久压过 themes.css 的主题值。
// 这两个函数全项目已无调用方，且会污染主题，故整体删除。

/** 旧版内置主题名（多色彩主题），一律归一到浅色 */
const LEGACY_THEME_NAMES = ['blue', 'purple', 'green', 'orange', 'red', 'pink', 'teal', 'cyan', 'amber'];

/**
 * 应用"已保存的主题"（三档：黑色 dark / 白色 light / 自定义 custom）。
 *
 * 单一数据源 = store 单项键 `versepc_theme`（个性化页保存时写入）。
 * settings.json 里的 `settings.theme` 是旧版遗留字段（现在没有任何地方再写它），
 * 只能作为一次性迁移回退 —— 否则会出现"明明选了黑色，重启又变回白色"：
 *   启动早期按 store 键贴上了 dark → loadSettings() 又按 settings.theme 贴回 light。
 *
 * @param {{legacyTheme?: string}} [opts] legacyTheme: settings.json 里的旧主题值（迁移用）
 * @returns {Promise<string>} 最终生效的主题名
 */
async function applySavedTheme(opts = {}) {
  let themeName = null;
  try {
    themeName = await window.electronAPI?.store?.get('versepc_theme');
  } catch (e) { /* ignore */ }

  if (!themeName) {
    // 迁移：老版本只把主题写在 settings.json 的 theme 字段里
    const legacy = opts.legacyTheme;
    themeName = (!legacy || LEGACY_THEME_NAMES.includes(legacy)) ? 'light' : legacy;
    try { await window.electronAPI?.store?.set('versepc_theme', themeName); } catch (e) { /* ignore */ }
  } else if (LEGACY_THEME_NAMES.includes(themeName)) {
    themeName = 'light';
  }

  if (typeof applyThemeByName === 'function') {
    await applyThemeByName(themeName);
  } else {
    // 兜底：applyThemeByName 未加载时至少把 data-theme 贴对
    const de = document.documentElement;
    de.setAttribute('data-theme', themeName);
    de.classList.toggle('dark-theme', themeName === 'dark' || themeName === 'custom');
    de.classList.toggle('light-theme', themeName === 'light');
  }

  // 同步主题卡片的高亮（DOM 兼容层；Vue 卡片本身由 personalizeState.theme 驱动）
  document.querySelectorAll('.theme-option').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-theme') === themeName);
  });

  return themeName;
}

// ============== 状态加载 / 保存 / 重置 ==============

/** 读取壁纸子状态（透明度/模糊/适配/全景/自定义文件名）到共享 store */
async function loadWallpaperSubState() {
  const st = getPersonalizeState();
  if (!st) return;
  try {
    const [opacity, blur, fit, panoTheme, panoSpeed, panoFollow, customImage, customVideo, animSpeed, glassEffect] = await Promise.all([
      window.electronAPI?.store?.get('versepc_wallpaper_opacity'),
      window.electronAPI?.store?.get('versepc_wallpaper_blur'),
      window.electronAPI?.store?.get('versepc_wallpaper_fit'),
      window.electronAPI?.store?.get('versepc_panorama_theme'),
      window.electronAPI?.store?.get('versepc_panorama_speed'),
      window.electronAPI?.store?.get('versepc_panorama_mouse_follow'),
      window.electronAPI?.store?.get('versepc_custom_image'),
      window.electronAPI?.store?.get('versepc_custom_video'),
      window.electronAPI?.store?.get('versepc_anim_speed'),
      window.electronAPI?.store?.get('versepc_glass_effect'),
    ]);
    if (opacity != null) st.opacity = Number(opacity);
    if (blur != null) st.blur = Number(blur);
    if (fit) st.fit = fit;
    if (panoTheme) st.panoramaTheme = panoTheme;
    if (panoSpeed != null) st.panoramaSpeed = Number(panoSpeed);
    if (panoFollow === true) st.panoramaFollow = true;
    const customPath = customImage || customVideo || '';
    if (customPath) st.customFileName = customPath.split(/[\\/]/).pop();
    if (animSpeed != null) {
      st.animSpeed = Number(animSpeed);
      if (typeof applyAnimationSpeed === 'function') applyAnimationSpeed(st.animSpeed);
    }
    // 视觉效果：启动时恢复（旧版的布尔键 versepc_liquid_glass 已废弃，不再兼容）
    // silent：恢复动作不弹提示，浅色主题下只静默不生效，偏好值保留
    if (typeof applyGlassEffectByName === 'function') applyGlassEffectByName(glassEffect || 'none', { silent: true });
  } catch (e) {
    console.warn('[Settings] Load wallpaper sub state error:', e);
  }
}

/** 读取全部个性化设置到共享 store（供 Vue 卡片初始化 / 设置导入恢复） */
async function loadPersonalizeStateIntoStore() {
  const st = getPersonalizeState();
  if (!st) return;

  let legacy = null;
  try {
    const saved = await window.electronAPI?.store?.get('versepc_personalize_settings');
    if (saved) legacy = JSON.parse(saved);
  } catch (e) { /* 忽略旧数据解析错误 */ }

  const [savedTheme, savedWallpaper, customColor, customLight, weWallpaperSaved] = await Promise.all([
    window.electronAPI?.store?.get('versepc_theme'),
    window.electronAPI?.store?.get('versepc_wallpaper'),
    window.electronAPI?.store?.get('versepc_custom_theme_color'),
    window.electronAPI?.store?.get('versepc_custom_theme_light'),
    window.electronAPI?.store?.get('versepc_we_wallpaper'),
  ]);

  // ── 主题：单项键优先，其次旧复合键，最后默认浅色 ──
  let themeName = savedTheme || (legacy && legacy.theme) || null;
  if (themeName) {
    const legacyThemes = ['blue', 'purple', 'green', 'orange', 'red', 'pink', 'teal', 'cyan', 'amber'];
    if (legacyThemes.includes(themeName)) themeName = 'light';
  }
  st.theme = themeName || 'light';

  // ── 壁纸：单项键优先，其次旧复合键，最后无背景 ──
  let wpName = savedWallpaper || (legacy && legacy.wallpaper) || 'none';
  if (wpName === 'starry') wpName = 'panorama';
  st.wallpaper = wpName;

  // ── 视觉效果（毛玻璃 / 液态玻璃 / 亚克力）由 loadWallpaperSubState 统一恢复 ──

  if (customColor) st.customColor = customColor;
  if (customLight !== null && customLight !== undefined) {
    st.customLight = customLight === true || customLight === 'true' || customLight === '1';
  }

  // ── Wallpaper Engine 所选壁纸 ──
  st.weWallpaper = null;
  if (weWallpaperSaved) {
    try {
      st.weWallpaper = JSON.parse(weWallpaperSaved);
    } catch (e) { /* 忽略解析错误 */ }
  }

  await loadWallpaperSubState();
}

async function savePersonalizeSettings() {
  const st = getPersonalizeState();
  const settings = st
    ? {
        theme: st.theme,
        wallpaper: st.wallpaper
      }
    : {
        theme: document.querySelector('.theme-option.active')?.dataset.theme || 'light',
        wallpaper: document.querySelector('.wallpaper-option.active')?.dataset.wallpaper || 'none'
      };

  try {
    await window.electronAPI.store.set('versepc_personalize_settings', JSON.stringify(settings));
    // 同步写入单项键，保证"保存设置"与实时修改的单项键一致，重启后以单项键为准
    await window.electronAPI.store.set('versepc_theme', settings.theme);
    await window.electronAPI.store.set('versepc_wallpaper', settings.wallpaper);
    showToast('个性化设置已保存', 'success');
  } catch (e) {
    showToast('保存失败: ' + e.message, 'error');
  }
}

async function resetPersonalizeSettings() {
  const confirmed = await showConfirmDialog('重置设置', '确定要重置个性化设置为默认值吗?', '重置', '取消');
  if (!confirmed) return;

  const st = getPersonalizeState();
  if (st) {
    st.theme = 'light';
    st.wallpaper = 'none';
    st.customColor = '#4c8dff';
    st.customLight = false;
    st.customColorGroupVisible = false;
    st.opacity = 100;
    st.blur = 0;
    st.fit = 'cover';
    st.panoramaTheme = 'overworld';
    st.panoramaSpeed = 5;
    st.panoramaFollow = false;
    st.customFileName = '未选择';
    st.animSpeed = 1;
    st.glassEffect = 'none';
  }

  await applyThemeByName('light');
  await applyWallpaperByName('none');
  if (typeof applyAnimationSpeed === 'function') applyAnimationSpeed(1);
  if (typeof applyGlassEffectByName === 'function') applyGlassEffectByName('none');

  if (typeof clearCustomThemeVars === 'function') clearCustomThemeVars();
  if (typeof syncCustomThemeColorUI === 'function') syncCustomThemeColorUI('#4c8dff');

  try {
    await window.electronAPI.store.set('versepc_personalize_settings', JSON.stringify({
      theme: 'light',
      wallpaper: 'none'
    }));
    await window.electronAPI.store.set('versepc_theme', 'light');
    await window.electronAPI.store.set('versepc_wallpaper', 'none');
    await window.electronAPI.store.delete('versepc_solid_color');
    await window.electronAPI.store.delete('versepc_custom_theme_color');
    await window.electronAPI.store.delete('versepc_custom_theme_light');
    await window.electronAPI.store.set('versepc_wallpaper_opacity', 100);
    await window.electronAPI.store.set('versepc_wallpaper_blur', 0);
    await window.electronAPI.store.set('versepc_wallpaper_fit', 'cover');
    await window.electronAPI.store.delete('versepc_custom_image');
    await window.electronAPI.store.delete('versepc_custom_video');
    await window.electronAPI.store.set('versepc_panorama_theme', 'overworld');
    await window.electronAPI.store.set('versepc_anim_speed', 1);
    await window.electronAPI.store.set('versepc_glass_effect', 'none');
    // 旧版遗留的布尔键（毛玻璃开关 / 液态玻璃开关）已废弃，重置时清掉
    await window.electronAPI.store.delete('versepc_liquid_glass');
    _updateCustomImagePreview(null);
    const nameEl = document.getElementById('custom-wallpaper-file-name');
    if (nameEl) nameEl.textContent = '未选择';
  } catch (e) {
    console.error('[Settings] Reset personalize settings save error:', e);
  }

  showToast('个性化设置已重置', 'success');
}

async function loadPersonalizeSettings() {
  await loadPersonalizeStateIntoStore();
  const st = getPersonalizeState();
  if (!st) return;

  // 应用效果（引擎/持久化由核心函数负责）
  await applyThemeByName(st.theme);
  await applyWallpaperByName(st.wallpaper);
}

// ============== 启动即恢复视觉效果 ==============
// 不能只在个性化页/设置页初始化时恢复：用户重启启动器后如果没进过设置页，
// 玻璃效果就会丢。这里和 animation-speed.js 的 boot 一个套路 —— 页面加载后
// 自己从 store 读一次并挂到 <html> 上（幂等，重复执行无副作用）。
(function bootGlassEffect() {
  let tries = 0;
  function run() {
    const api = window.electronAPI;
    if (!api || !api.store || !api.store.get) {
      if (++tries < 25) setTimeout(run, 200); // store 桥还没挂上，稍后再试
      return;
    }
    api.store.get('versepc_glass_effect').then(function (v) {
      if (typeof applyGlassEffectByName === 'function') applyGlassEffectByName(v || 'none');
    }).catch(function () {});
  }
  if (document.readyState === 'complete') setTimeout(run, 300);
  else window.addEventListener('load', function () { setTimeout(run, 300); });
})();
