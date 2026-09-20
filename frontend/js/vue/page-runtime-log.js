/* page-runtime-log.js - 运行日志页 Vue 组件
 * ============================================================================
 * 「运行日志」= 启动器自己的操作流水：每一次接口调用、页面跳转、下载任务、
 *               启动流程以及全部报错，方便排查问题。
 * 与「日志」（page-console，游戏 stdout/stderr）完全独立，互不覆盖。
 *
 * 数据源：js/app/app-log.js 暴露的 window.AppLog
 *   · AppLog.subscribe(fn)  日志新增时回调（这里做了节流，避免高频刷新）
 *   · AppLog.list()         全部日志（按时间升序）
 *   · AppLog.stats()        各等级条数
 * ============================================================================ */
const PageRuntimeLog = {
  data() {
    return {
      entries: [],
      counts: { total: 0, op: 0, info: 0, warn: 0, error: 0 },
      level: 'all',
      q: '',
      autoScroll: true,
      paused: false,
      ready: false,
      _unsub: null,
      _syncTimer: null,
      filters: [
        { key: 'all', label: '全部' },
        { key: 'op', label: '操作' },
        { key: 'info', label: '信息' },
        { key: 'warn', label: '警告' },
        { key: 'error', label: '错误' }
      ]
    };
  },
  computed: {
    shown() {
      let arr = this.entries;
      if (this.level !== 'all') arr = arr.filter((e) => e.level === this.level);
      const kw = this.q.trim().toLowerCase();
      if (kw) {
        arr = arr.filter((e) =>
          (e.msg || '').toLowerCase().indexOf(kw) >= 0 ||
          (e.tag || '').toLowerCase().indexOf(kw) >= 0
        );
      }
      // 只渲染最后 1000 条，避免几千行 DOM 拖慢界面（导出仍是全量）
      return arr.length > 1000 ? arr.slice(-1000) : arr;
    },
    totalShown() {
      return this.shown.length;
    }
  },
  watch: {
    'shown.length'() {
      if (this.autoScroll) this.$nextTick(this.scrollBottom);
    },
    level() { if (this.autoScroll) this.$nextTick(this.scrollBottom); }
  },
  mounted() {
    this.sync();
    this.ready = true;
    const box = this.$refs.box;
    if (box) box.addEventListener('scroll', this.onScroll, { passive: true });
    this._unsub = (window.AppLog && window.AppLog.subscribe)
      ? window.AppLog.subscribe(() => this.scheduleSync())
      : null;
  },
  beforeUnmount() {
    if (this._unsub) { try { this._unsub(); } catch (e) {} this._unsub = null; }
    if (this._syncTimer) { clearTimeout(this._syncTimer); this._syncTimer = null; }
    const box = this.$refs.box;
    if (box) box.removeEventListener('scroll', this.onScroll);
  },
  methods: {
    /** 日志写入可能非常密集（例如批量接口），这里节流到 ~8 帧一次刷新 */
    scheduleSync() {
      if (this.paused || this._syncTimer) return;
      this._syncTimer = setTimeout(() => {
        this._syncTimer = null;
        this.sync();
      }, 120);
    },
    sync() {
      if (!window.AppLog) return;
      this.entries = window.AppLog.list();
      this.counts = window.AppLog.stats();
    },
    onScroll() {
      const box = this.$refs.box;
      if (!box) return;
      const atBottom = (box.scrollHeight - box.scrollTop - box.clientHeight) < 40;
      if (!atBottom && this.autoScroll) this.autoScroll = false;
    },
    scrollBottom() {
      const box = this.$refs.box;
      if (box) box.scrollTop = box.scrollHeight;
    },
    time(ts) {
      const d = new Date(ts || Date.now());
      const p = (n, w) => String(n).padStart(w, '0');
      return p(d.getHours(), 2) + ':' + p(d.getMinutes(), 2) + ':' + p(d.getSeconds(), 2) + '.' + p(d.getMilliseconds(), 3);
    },
    togglePause() {
      this.paused = !this.paused;
      if (!this.paused) this.sync();
    },
    clearAll() {
      if (!window.AppLog) return;
      if (typeof showConfirmDialog === 'function') {
        showConfirmDialog('清空运行日志', '确定清空当前全部运行日志吗？（不影响游戏日志）', '清空', '取消')
          .then((ok) => { if (ok) { window.AppLog.clear(); this.sync(); showToast('运行日志已清空', 'success'); } });
        return;
      }
      window.AppLog.clear();
      this.sync();
    },
    copyAll() {
      if (!window.AppLog) return;
      window.AppLog.copy().then((ok) => showToast(ok ? '已复制全部日志' : '复制失败', ok ? 'success' : 'error'));
    },
    downloadAll() {
      if (!window.AppLog) return;
      const name = window.AppLog.download();
      showToast('已导出 ' + name, 'success');
    }
  },
  template: `
    <div class="page-header">
      <h2>运行日志</h2>
      <p class="page-desc">启动器自己的操作流水：每一次接口调用、页面跳转、下载任务、启动流程与全部报错（和「日志」页的游戏日志互不影响）</p>
      <div class="page-actions">
        <button class="btn btn-secondary btn-sm" @click="togglePause">{{ paused ? '继续' : '暂停' }}</button>
        <button class="btn btn-secondary btn-sm" @click="copyAll">复制</button>
        <button class="btn btn-accent btn-sm" @click="downloadAll">导出</button>
        <button class="btn btn-secondary btn-sm" @click="clearAll">清空</button>
      </div>
    </div>

    <div class="rt-log-bar">
      <div class="rt-log-filters">
        <button v-for="f in filters" :key="f.key" type="button"
                class="rt-chip" :class="{ 'is-active': level === f.key }" @click="level = f.key">
          {{ f.label }}<span class="rt-chip-num" v-if="f.key === 'all' ? counts.total : counts[f.key]">{{ f.key === 'all' ? counts.total : counts[f.key] }}</span>
        </button>
      </div>
      <input class="text-input rt-log-search" v-model="q" placeholder="搜索关键字（消息 / 分类）…">
      <label class="checkbox-label rt-log-auto">
        <input type="checkbox" v-model="autoScroll">
        <span>自动滚动</span>
      </label>
      <span class="rt-log-stat">显示 {{ totalShown }} 条 {{ paused ? '· 已暂停' : '' }}</span>
    </div>

    <div class="console-output rt-log-output" ref="box">
      <p v-if="!shown.length" class="console-wait">暂无日志</p>
      <div v-for="e in shown" :key="e.id" class="console-line" :class="e.level">
        <span class="rt-log-time">{{ time(e.t) }}</span>
        <span class="rt-log-tag">{{ e.tag }}</span>
        <span class="rt-log-msg">{{ e.msg }}</span>
        <span class="rt-log-count" v-if="e.count > 1">×{{ e.count }}</span>
      </div>
    </div>
  `
};

window.VersePC = window.VersePC || {};
window.VersePC.PageRuntimeLog = PageRuntimeLog;
