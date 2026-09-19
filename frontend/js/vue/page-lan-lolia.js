/* page-lan-lolia.js - LoliaFRP 联机页 Vue 组件
 * 自 NetTool LoliaFrpView 迁移（2026-09-19），适配 VersePC-CE：
 *   1. Naive UI 组件换成 VersePC-CE 的扁平 CSS（css/lan-frp.css）；
 *   2. 后端命令不变（src-tauri/src/frp/lolia.rs），OAuth2 回调端口 11451；
 *   3. 下拉一律用原生 <select class="select-input">（custom-select-ui 自动自绘接管）；
 *   4. 日志抽屉为页内右滑面板（Vue <transition name="frp-drawer">）。
 * 界面只保留穿透主链路：授权登录 → 隧道列表 → 启动/停止/日志 → 新建/编辑/删除。
 */
const PageLanLolia = {
  name: 'PageLanLolia',
  data() {
    return {
      auth: { loggedIn: false, username: '' },
      oauth: { status: 'idle', message: '' },
      user: null,
      tunnels: [],
      nodes: [],
      stats: null,
      runStatus: [],
      loading: false,
      createOpen: false,
      createForm: { node_id: null, kind: 'tcp', local_ip: '127.0.0.1', local_port: 8080, remote_port: 0, custom_domain: '', remark: '' },
      editOpen: false,
      editForm: { name: '', local_ip: '127.0.0.1', local_port: 8080, custom_domain: '', remark: '' },
      logOpen: false, logTunnel: '', logs: [],
      _unlisten: null, _pollTimer: 0, _uptimeTimer: 0, _logTimer: 0
    };
  },
  computed: {
    F() { return window.VerseFrp; },
    nodeOptions() {
      return this.nodes.map(function (n) {
        return { value: n.id, text: n.name + '（' + (n.region_code || '—') + ' · ' + (n.status === 'online' ? '在线' : '离线') + '）', disabled: n.status !== 'online' };
      });
    },
    trafficPercent() {
      const s = this.stats || this.user;
      if (!s || !s.traffic_limit) return 0;
      return Math.min(100, Math.round((s.traffic_used / s.traffic_limit) * 1000) / 10);
    },
    runMap() {
      const m = {};
      this.runStatus.forEach(function (r) { m[r.tunnel] = r; });
      return m;
    }
  },
  methods: {
    tStatus(s) { return s === 'active' ? '已启用' : '未启用'; },
    addrOf(t) {
      if (t.custom_domain) return t.custom_domain;
      if (t.node_address && t.remote_port) return t.node_address + ':' + t.remote_port;
      return '—';
    },
    async refresh() {
      this.loading = true;
      const g = this.F.guard, inv = this.F.invoke;
      const self = this;
      try {
        const results = await Promise.all([
          g(function () { return inv('lolia_user_info'); }),
          g(function () { return inv('lolia_tunnel_list', { page: 1, limit: 100 }); }),
          g(function () { return inv('lolia_nodes'); }),
          g(function () { return inv('lolia_traffic_stats'); }),
          g(function () { return inv('lolia_run_status'); })
        ]);
        if (results[0]) self.user = results[0];
        if (results[1] && results[1].list) self.tunnels = results[1].list;
        if (results[2] && results[2].nodes) self.nodes = results[2].nodes.slice().sort(function (a, b) { return a.id - b.id; });
        if (results[3]) self.stats = results[3];
        if (results[4]) self.runStatus = results[4];
      } finally { this.loading = false; }
    },
    async login() {
      const self = this;
      const url = await this.F.guard(function () { return self.F.invoke('lolia_oauth_begin'); });
      if (!url) return;
      this.oauth = { status: 'waiting', message: '已打开浏览器，请在授权页同意全部权限' };
      window.bridge.openExternal(url);
      this.stopPoll();
      let ticks = 0;
      this._pollTimer = setInterval(async function () {
        ticks++;
        if (ticks > 330) { self.stopPoll(); self.oauth = { status: 'error', message: '等待超时，请重试' }; return; }
        const r = await self.F.guard(function () { return self.F.invoke('lolia_oauth_status'); });
        if (!r) return;
        self.oauth = r;
        if (r.status === 'ok') {
          self.stopPoll();
          showToast('Lolia 授权登录成功', 'success');
          await self.loadAuth();
          await self.refresh();
        } else if (r.status === 'error') { self.stopPoll(); }
      }, 1000);
    },
    stopPoll() { if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = 0; } },
    async cancelLogin() {
      this.stopPoll();
      await this.F.guard(function () { return window.VerseFrp.invoke('lolia_oauth_cancel'); });
      this.oauth = { status: 'idle', message: '' };
    },
    async loadAuth() {
      const r = await this.F.guard(function () { return window.VerseFrp.invoke('lolia_auth_status'); });
      if (r) this.auth = r;
    },
    async logout() {
      await this.F.guard(function () { return window.VerseFrp.invoke('lolia_logout'); });
      this.user = null; this.tunnels = []; this.stats = null; this.runStatus = [];
      await this.loadAuth();
      showToast('已退出 Lolia 登录', 'success');
    },
    async startTunnel(t) {
      await this.F.guard(function () { return window.VerseFrp.invoke('lolia_tunnel_run', { name: t.name, autoRestart: true }); }, '隧道已启动');
      this.refresh();
    },
    async stopTunnel(t) {
      await this.F.guard(function () { return window.VerseFrp.invoke('lolia_tunnel_stop', { name: t.name }); }, '隧道已停止');
      this.refresh();
    },
    openCreate() {
      this.createForm = { node_id: this.nodeOptions.length ? this.nodeOptions[0].value : null, kind: 'tcp', local_ip: '127.0.0.1', local_port: 8080, remote_port: 0, custom_domain: '', remark: '' };
      this.createOpen = !this.createOpen;
      this.editOpen = false;
    },
    async submitCreate() {
      const f = this.createForm, self = this;
      if (!f.node_id) { showToast('请选择节点', 'error'); return; }
      if (!String(f.remark || '').trim()) { showToast('请填写隧道名称', 'error'); return; }
      if (!f.local_port) { showToast('请填写本地端口', 'error'); return; }
      const ok = await this.F.guard(function () {
        return self.F.invoke('lolia_tunnel_create', { nodeId: f.node_id, kind: f.kind, localIp: f.local_ip, localPort: Number(f.local_port) || 8080, remotePort: Number(f.remote_port) || 0, customDomain: f.custom_domain, remark: String(f.remark).trim() });
      }, '隧道已创建');
      if (ok !== undefined) { this.createOpen = false; this.refresh(); }
    },
    openEdit(t) {
      this.editForm = { name: t.name, local_ip: t.local_ip, local_port: t.local_port, custom_domain: t.custom_domain || '', remark: t.remark || '' };
      this.editOpen = true;
      this.createOpen = false;
    },
    async submitEdit() {
      const f = this.editForm, self = this;
      const ok = await this.F.guard(function () {
        return self.F.invoke('lolia_tunnel_update', { name: f.name, localIp: f.local_ip, localPort: Number(f.local_port) || 8080, customDomain: f.custom_domain, remark: f.remark, autoTls: false, proxyProtocolVersion: null, protocol: null });
      }, '隧道已更新');
      if (ok !== undefined) { this.editOpen = false; this.refresh(); }
    },
    async removeTunnel(t) {
      if (!confirm('确定删除隧道「' + (t.remark || t.name) + '」？此操作不可恢复。')) return;
      await this.F.guard(function () { return window.VerseFrp.invoke('lolia_tunnel_delete', { name: t.name }); }, '隧道已删除');
      this.refresh();
    },
    async copyAddr(t) {
      const a = this.addrOf(t);
      if (a && a !== '—') { try { await navigator.clipboard.writeText(a); showToast('已复制联机地址', 'success'); } catch (e) {} }
    },
    openLogs(t) {
      const self = this;
      this.logTunnel = t.name;
      this.logs = [];
      this.logOpen = true;
      this.F.invoke('lolia_tunnel_logs', { name: t.name }).then(function (r) { if (r) self.logs = r; }).catch(function () {});
      this.stopLogTimer();
      this._logTimer = setInterval(function () {
        self.F.invoke('lolia_tunnel_logs', { name: self.logTunnel }).then(function (r) { if (r) self.logs = r; }).catch(function () {});
      }, 2000);
    },
    stopLogTimer() { if (this._logTimer) { clearInterval(this._logTimer); this._logTimer = 0; } },
    closeLogs() { this.logOpen = false; this.stopLogTimer(); }
  },
  mounted() {
    const self = this;
    this._unlisten = window.VerseFrp.onFrpLog('lolia-log', function (line) {
      if (self.logOpen && line.tunnel === self.logTunnel) {
        self.logs = self.logs.concat([line]).slice(-500);
      }
    });
    const boot = async function () {
      await self.loadAuth();
      if (self.auth.loggedIn) await self.refresh();
    };
    boot();
  },
  beforeUnmount() {
    this.stopPoll(); this.stopLogTimer();
    if (this._unlisten) this._unlisten();
  },
  template: `
          <div class="frp-wrap">
            <!-- 未登录：授权卡片 -->
            <div v-if="!auth.loggedIn" class="frp-card" style="max-width:560px;margin:0 auto;width:100%">
              <div class="frp-card-head">
                <span class="frp-card-title">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 7h3a5 5 0 0 1 0 10h-3"/><path d="M9 17H6a5 5 0 0 1 0-10h3"/><line x1="8" y1="12" x2="16" y2="12"/></svg>
                  LoliaFRP 账号授权
                </span>
              </div>
              <p class="frp-card-hint">通过 OAuth2 授权登录 Lolia 账号，本机将在 127.0.0.1:11451 接收回调。<br>点击授权后会自动打开浏览器，请在授权页<b>同意全部权限</b>（隧道 / 流量 / 节点等）。</p>
              <div v-if="oauth.status === 'waiting'" class="frp-alert">
                <div class="frp-row"><span class="spinner" style="width:16px;height:16px"></span>{{ oauth.message || '等待授权...' }}</div>
              </div>
              <div v-else-if="oauth.status === 'error'" class="frp-alert is-error">{{ oauth.message }}</div>
              <div class="frp-row" style="margin-top:12px">
                <button v-if="oauth.status !== 'waiting'" class="btn btn-primary" @click="login()">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:15px;height:15px"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg>
                  验证并授权登录
                </button>
                <button v-else class="btn btn-secondary" @click="cancelLogin()">取消等待</button>
              </div>
            </div>

            <!-- 已登录 -->
            <template v-else>
              <!-- 账号概览 -->
              <div class="frp-card">
                <div class="frp-card-head">
                  <span class="frp-card-title">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                    LoliaFRP 账号
                  </span>
                  <div class="frp-row" style="gap:8px">
                    <button class="btn btn-secondary btn-sm" :disabled="loading" @click="refresh()">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px" :class="{'frp-spin': loading}"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><polyline points="21 3 21 9 15 9"/></svg>
                      刷新
                    </button>
                    <button class="btn btn-secondary btn-sm" @click="logout()">退出登录</button>
                  </div>
                </div>
                <div class="frp-grid" v-if="user || stats">
                  <div class="frp-stat"><div class="frp-stat-label">用户名</div><div class="frp-stat-value">{{ (user && user.username) || auth.username || '—' }}</div></div>
                  <div class="frp-stat"><div class="frp-stat-label">剩余流量</div><div class="frp-stat-value">{{ stats ? F.fmtBytes(stats.traffic_limit - stats.traffic_used) : '—' }}</div></div>
                  <div class="frp-stat"><div class="frp-stat-label">隧道数量</div><div class="frp-stat-value">{{ tunnels.length + (stats && stats.max_tunnel_count ? ' / ' + stats.max_tunnel_count : '') }}</div></div>
                </div>
                <div v-if="stats" style="margin-top:12px">
                  <div class="frp-bar"><div class="frp-bar-fill" :style="{ width: trafficPercent + '%' }"></div></div>
                  <p class="frp-card-hint" style="margin:6px 0 0">已用 {{ F.fmtBytes(stats.traffic_used) }} / {{ F.fmtBytes(stats.traffic_limit) }} · {{ trafficPercent }}%</p>
                </div>
              </div>

              <!-- 隧道列表 -->
              <div class="frp-card">
                <div class="frp-card-head">
                  <span class="frp-card-title">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"/><path d="M4 17h16"/><ellipse cx="9" cy="7" rx="5" ry="3"/><ellipse cx="15" cy="17" rx="5" ry="3"/></svg>
                    我的隧道
                  </span>
                  <button class="btn btn-primary btn-sm" @click="openCreate()">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                    新建隧道
                  </button>
                </div>

                <!-- 新建面板 -->
                <transition name="frp-collapse">
                <div v-if="createOpen" class="frp-collapse" style="margin-bottom:12px">
                  <div class="frp-grid" style="grid-template-columns:repeat(auto-fit,minmax(140px,1fr))">
                    <label class="frp-field"><span>节点</span>
                      <select class="select-input" v-model="createForm.node_id">
                        <option v-for="n in nodeOptions" :key="n.value" :value="n.value" :disabled="n.disabled">{{ n.text }}</option>
                      </select>
                    </label>
                    <label class="frp-field"><span>协议类型</span>
                      <select class="select-input" v-model="createForm.kind">
                        <option value="tcp">TCP</option><option value="udp">UDP</option><option value="http">HTTP</option><option value="https">HTTPS</option>
                      </select>
                    </label>
                    <label class="frp-field"><span>本地地址</span><input class="text-input" v-model="createForm.local_ip" placeholder="127.0.0.1"></label>
                    <label class="frp-field"><span>本地端口</span><input class="text-input" type="number" v-model="createForm.local_port" placeholder="25565"></label>
                    <label class="frp-field" v-if="createForm.kind === 'tcp' || createForm.kind === 'udp'"><span>远程端口（0 自动）</span><input class="text-input" type="number" v-model="createForm.remote_port" placeholder="0"></label>
                    <label class="frp-field" v-else><span>绑定域名（可选）</span><input class="text-input" v-model="createForm.custom_domain" placeholder="mc.example.com"></label>
                    <label class="frp-field"><span>隧道名称</span><input class="text-input" v-model="createForm.remark" placeholder="我的 MC 服务器"></label>
                  </div>
                  <div class="frp-row" style="margin-top:10px">
                    <button class="btn btn-primary btn-sm" @click="submitCreate()">创建</button>
                    <button class="btn btn-secondary btn-sm" @click="createOpen = false">取消</button>
                  </div>
                </div>
                </transition>

                <!-- 隧道卡片 -->
                <div v-if="tunnels.length" style="display:flex;flex-direction:column;gap:10px">
                  <div v-for="t in tunnels" :key="t.id" class="frp-tunnel" :class="{ 'is-running': runMap[t.name] && runMap[t.name].running }">
                    <div class="frp-tunnel-head">
                      <span class="frp-badge frp-badge--type">{{ t.type }}</span>
                      <span class="frp-tunnel-name">{{ t.remark || t.name }}</span>
                      <span v-if="runMap[t.name] && runMap[t.name].running" class="frp-badge frp-badge--ok"><span class="frp-dot frp-dot--live"></span>本地运行中 · {{ F.fmtUptime(runMap[t.name].uptimeSecs) }}</span>
                      <span v-else class="frp-badge">{{ tStatus(t.status) }}</span>
                    </div>
                    <div class="frp-tunnel-meta">
                      <span>节点：{{ t.node_name || ('#' + t.node_id) }}</span>
                      <span>本地 {{ t.local_ip }}:{{ t.local_port }}</span>
                    </div>
                    <div class="frp-tunnel-addr">
                      <code>{{ addrOf(t) }}</code>
                      <button class="btn btn-secondary btn-sm" @click="copyAddr(t)">复制</button>
                    </div>
                    <div class="frp-tunnel-actions">
                      <button v-if="!(runMap[t.name] && runMap[t.name].running)" class="btn btn-primary btn-sm" @click="startTunnel(t)">启动</button>
                      <button v-else class="btn btn-secondary btn-sm" @click="stopTunnel(t)">停止</button>
                      <button class="btn btn-secondary btn-sm" @click="openLogs(t)">日志</button>
                      <button class="btn btn-secondary btn-sm" @click="openEdit(t)">编辑</button>
                      <button class="btn btn-secondary btn-sm" style="color:#dc2626" @click="removeTunnel(t)">删除</button>
                    </div>
                  </div>
                </div>
                <div v-else-if="!loading" class="frp-card-hint" style="margin:0">还没有隧道，点右上角「新建隧道」创建一个吧。Minecraft 联机建议选 TCP 协议、本地端口 25565。</div>
                <div v-else class="frp-skeleton"></div>

                <!-- 编辑面板 -->
                <transition name="frp-collapse">
                <div v-if="editOpen" class="frp-collapse" style="margin-top:12px">
                  <div class="frp-grid" style="grid-template-columns:repeat(auto-fit,minmax(140px,1fr))">
                    <label class="frp-field"><span>本地地址</span><input class="text-input" v-model="editForm.local_ip"></label>
                    <label class="frp-field"><span>本地端口</span><input class="text-input" type="number" v-model="editForm.local_port"></label>
                    <label class="frp-field"><span>绑定域名</span><input class="text-input" v-model="editForm.custom_domain" placeholder="留空不绑定"></label>
                    <label class="frp-field"><span>隧道名称</span><input class="text-input" v-model="editForm.remark"></label>
                  </div>
                  <div class="frp-row" style="margin-top:10px">
                    <button class="btn btn-primary btn-sm" @click="submitEdit()">保存</button>
                    <button class="btn btn-secondary btn-sm" @click="editOpen = false">取消</button>
                  </div>
                </div>
                </transition>
              </div>
            </template>

            <!-- 日志抽屉 -->
            <transition name="frp-drawer">
              <div class="frp-log" v-if="logOpen" @mousedown.self="closeLogs()">
                <div class="frp-log-panel">
                  <div class="frp-log-head">
                    <h4>隧道日志 · {{ logTunnel }}</h4>
                    <button class="btn btn-secondary btn-sm" @click="closeLogs()">&times;</button>
                  </div>
                  <div class="frp-log-body">
                    <div v-if="!logs.length" class="frp-log-empty">暂无日志，启动隧道后这里会实时滚动输出</div>
                    <div v-for="(l, i) in logs" :key="i" class="frp-log-line" :class="'log-' + l.level">{{ l.message }}</div>
                  </div>
                  <div class="frp-log-foot">
                    <button class="btn btn-secondary btn-sm" @click="logs = []">清空显示</button>
                  </div>
                </div>
              </div>
            </transition>
          </div>
  `
};

window.VersePC = window.VersePC || {};
window.VersePC.PageLanLolia = PageLanLolia;
