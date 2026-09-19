/* page-lan-sakura.js - SakuraFrp（樱花内网穿透）联机页 Vue 组件
 * 自 NetTool SakuraFrpView 迁移（2026-09-19）：
 *   1. 登录用「访问密钥」（natfrp.com → 用户信息 → 访问密钥，后端校验后落盘）；
 *   2. 隧道配置由云端下发（/tunnel/config 会带本地 frpc 版本协商 ini/toml）；
 *   3. 使用内置 frpc（resources/frp/frpc.exe），有樱花专用 frpc 时自动优先。
 */
const PageLanSakura = {
  name: 'PageLanSakura',
  data() {
    return {
      auth: { loggedIn: false, username: null, tokenPreview: null },
      tokenInput: '',
      saving: false,
      user: null,
      tunnels: [],
      nodes: [],
      runStatus: [],
      frpc: null,
      loading: false,
      createOpen: false,
      createForm: { name: '', type: 'tcp', node: null, local_ip: '127.0.0.1', local_port: 25565, remote: '', note: '' },
      editOpen: false,
      editForm: { id: 0, note: '', local_ip: '127.0.0.1', local_port: 25565 },
      logOpen: false, logTunnel: '', logs: [],
      _unlisten: null, _uptimeTimer: 0, _logTimer: 0
    };
  },
  computed: {
    F() { return window.VerseFrp; },
    nodeOptions() {
      return this.nodes.map(function (n) { return { value: Number(n.id) || 0, text: n.name + '（ID ' + n.id + '）' }; });
    },
    runMap() {
      const m = {};
      this.runStatus.forEach(function (r) { m[r.tunnel] = r; });
      return m;
    }
  },
  methods: {
    nodeHost(id) {
      const target = String(id == null ? '' : id);
      const n = this.nodes.find(function (x) { return x.id === target; });
      return n ? n.host : '';
    },
    nodeName(id) {
      const target = String(id == null ? '' : id);
      const n = this.nodes.find(function (x) { return x.id === target; });
      return n ? n.name : (target ? 'ID ' + target : '—');
    },
    flagTags(flag) {
      const f = this.F.num(flag, 0);
      const out = [];
      if (f & 0b11) out.push('HTTP');
      if (!(f & (1 << 2))) out.push('满载');
      if (f & (1 << 3)) out.push('内地');
      if (f & (1 << 5)) out.push('UDP');
      if (f & (1 << 9)) out.push('离线');
      if (f & (1 << 10)) out.push('BETA');
      return out;
    },
    addrOf(t) {
      const ty = String(t.type || '');
      const host = this.nodeHost(t.node);
      const remote = this.F.fmtText(t.remote, '');
      if (ty === 'http' || ty === 'https') {
        if (remote) return ty + '://' + remote;
        return host ? ty + '://' + host : '—';
      }
      if (ty === 'wol') return '网络唤醒 · 无公网地址';
      if (remote) return host ? host + ':' + remote : remote;
      return host || '—';
    },
    async loadAuth() {
      try {
        const r = await this.F.invoke('sakura_auth_status');
        if (r) this.auth = r;
      } catch (e) { /* ignore */ }
    },
    async refresh() {
      const self = this, g = this.F.guard, inv = this.F.invoke;
      this.loading = true;
      try {
        const u = await g(function () { return inv('sakura_user_info'); });
        if (u) self.user = u;
        const n = await g(function () { return inv('sakura_nodes'); });
        if (n) {
          self.nodes = Object.keys(n).map(function (id) {
            return { id: id, name: self.F.fmtText(n[id] && n[id].name, id), host: self.F.fmtText(n[id] && n[id].host, ''), flag: self.F.num(n[id] && n[id].flag, 0) };
          });
        }
        const t = await g(function () { return inv('sakura_tunnel_list'); });
        if (t) this.tunnels = Array.isArray(t) ? t : [];
        const r = await inv('sakura_run_status').catch(function () { return null; });
        if (r) this.runStatus = r;
        const f = await inv('sakura_frpc_info').catch(function () { return null; });
        if (f) this.frpc = f;
      } finally { this.loading = false; }
    },
    async saveToken() {
      const t = String(this.tokenInput || '').trim();
      if (!t) { showToast('请先粘贴访问密钥', 'error'); return; }
      const self = this;
      this.saving = true;
      try {
        const r = await this.F.invoke('sakura_login', { token: t });
        this.auth = r || { loggedIn: true, username: null, tokenPreview: null };
        this.tokenInput = '';
        showToast('访问密钥已保存', 'success');
        await this.refresh();
      } catch (e) {
        showToast(e && e.message ? e.message : String(e), 'error');
      } finally { this.saving = false; }
    },
    async logout() {
      try { await this.F.invoke('sakura_logout'); } catch (e) { /* ignore */ }
      this.user = null; this.tunnels = []; this.nodes = []; this.runStatus = [];
      await this.loadAuth();
      showToast('已清除访问密钥', 'success');
    },
    openTokenPage() { window.bridge.openExternal('https://www.natfrp.com/user/'); },
    async startTunnel(t) {
      await this.F.guard(function () { return window.VerseFrp.invoke('sakura_tunnel_start', { query: String(t.id), autoRestart: true }); }, '隧道「' + t.name + '」已启动');
      this.refresh();
    },
    async stopTunnel(t) {
      await this.F.guard(function () { return window.VerseFrp.invoke('sakura_tunnel_stop', { query: String(t.id) }); }, '隧道「' + t.name + '」已停止');
      this.refresh();
    },
    openCreate() {
      this.createForm = { name: '', type: 'tcp', node: this.nodeOptions.length ? this.nodeOptions[0].value : null, local_ip: '127.0.0.1', local_port: 25565, remote: '', note: '' };
      this.createOpen = !this.createOpen;
      this.editOpen = false;
    },
    async submitCreate() {
      const f = this.createForm, self = this;
      if (!f.name.trim()) { showToast('请填写隧道名', 'error'); return; }
      if (!f.node) { showToast('请选择节点', 'error'); return; }
      const ok = await this.F.guard(function () {
        return self.F.invoke('sakura_tunnel_create', { name: f.name.trim(), tunnelType: f.type, node: f.node, localIp: f.local_ip, localPort: Number(f.local_port) || 25565, remote: (f.type === 'http' || f.type === 'https') ? f.remote : '', note: f.note });
      }, '隧道已创建');
      if (ok !== undefined) { this.createOpen = false; this.refresh(); }
    },
    openEdit(t) {
      this.editForm = { id: t.id, note: this.F.fmtText(t.note, ''), local_ip: this.F.fmtText(t.local_ip, '127.0.0.1'), local_port: this.F.num(t.local_port, 25565) };
      this.editOpen = true;
      this.createOpen = false;
    },
    async submitEdit() {
      const f = this.editForm, self = this;
      const ok = await this.F.guard(function () {
        return self.F.invoke('sakura_tunnel_edit', { id: f.id, note: f.note, localIp: f.local_ip, localPort: Number(f.local_port) || 25565 });
      }, '隧道已更新');
      if (ok !== undefined) { this.editOpen = false; this.refresh(); }
    },
    async removeTunnel(t) {
      if (!confirm('确定删除隧道「' + t.name + '」？此操作不可恢复。')) return;
      await this.F.guard(function () { return window.VerseFrp.invoke('sakura_tunnel_delete', { ids: String(t.id) }); }, '隧道已删除');
      this.refresh();
    },
    copyAddr(t) {
      const a = this.addrOf(t);
      if (a && a !== '—') { navigator.clipboard.writeText(a).then(function () { showToast('已复制联机地址', 'success'); }).catch(function () {}); }
    },
    openLogs(t) {
      const self = this;
      this.logTunnel = String(t.id);
      this.logs = [];
      this.logOpen = true;
      this.F.invoke('sakura_tunnel_logs', { query: this.logTunnel }).then(function (r) { if (r) self.logs = r; }).catch(function () {});
      this.stopLogTimer();
      this._logTimer = setInterval(function () {
        self.F.invoke('sakura_tunnel_logs', { query: self.logTunnel }).then(function (r) { if (r) self.logs = r; }).catch(function () {});
      }, 2000);
    },
    stopLogTimer() { if (this._logTimer) { clearInterval(this._logTimer); this._logTimer = 0; } },
    closeLogs() { this.logOpen = false; this.stopLogTimer(); }
  },
  mounted() {
    const self = this;
    this._unlisten = window.VerseFrp.onFrpLog('sakura-log', function (line) {
      if (self.logOpen && line.tunnel === self.logTunnel) {
        self.logs = self.logs.concat([line]).slice(-1000);
      }
    });
    const boot = async function () {
      await self.loadAuth();
      if (self.auth.loggedIn) await self.refresh();
    };
    boot();
  },
  beforeUnmount() {
    this.stopLogTimer();
    if (this._unlisten) this._unlisten();
  },
  template: `
          <div class="frp-wrap">
            <!-- 未登录 -->
            <div v-if="!auth.loggedIn" class="frp-card" style="max-width:560px;margin:0 auto;width:100%">
              <div class="frp-card-head">
                <span class="frp-card-title">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 7h3a5 5 0 0 1 0 10h-3"/><path d="M9 17H6a5 5 0 0 1 0-10h3"/><line x1="8" y1="12" x2="16" y2="12"/></svg>
                  SakuraFrp 访问密钥
                </span>
              </div>
              <p class="frp-card-hint">到 <a href="javascript:void(0)" @click="openTokenPage()" style="color:var(--accent)">natfrp.com → 用户信息</a> 复制「访问密钥」，粘贴到这里保存。密钥只保存在本机，日志里只显示打码后的前后 4 位。</p>
              <div class="frp-field" style="margin-top:12px">
                <span>访问密钥</span>
                <input class="text-input" type="password" v-model="tokenInput" placeholder="SakuraFrp 访问密钥" autocomplete="off" spellcheck="false" @keydown.enter="saveToken()">
              </div>
              <div class="frp-row" style="margin-top:12px">
                <button class="btn btn-primary" :disabled="saving" @click="saveToken()">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:15px;height:15px"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                  {{ saving ? '校验中...' : '保存并校验' }}
                </button>
              </div>
            </div>

            <!-- 已登录 -->
            <template v-else>
              <!-- 本地 frpc -->
              <div class="frp-card">
                <div class="frp-card-head">
                  <span class="frp-card-title">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><line x1="6" y1="9" x2="10" y2="9"/><line x1="6" y1="13" x2="10" y2="13"/><line x1="14" y1="15" x2="18" y2="15"/></svg>
                    本地客户端
                  </span>
                  <span v-if="frpc && frpc.exists" class="frp-badge frp-badge--ok">frpc {{ frpc.version }}{{ frpc.isSakura ? '（樱花专用）' : '（内置）' }}</span>
                  <span v-else class="frp-badge frp-badge--err">未找到 frpc</span>
                </div>
                <p class="frp-card-hint">使用内置的 frpc 客户端，启动隧道时会自动把真实版本报给云端协商配置格式（新版 toml / 旧版 ini）。</p>
              </div>

              <!-- 账号概览 -->
              <div class="frp-card">
                <div class="frp-card-head">
                  <span class="frp-card-title">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                    SakuraFrp 账号
                  </span>
                  <div class="frp-row" style="gap:8px">
                    <button class="btn btn-secondary btn-sm" :disabled="loading" @click="refresh()">刷新</button>
                    <button class="btn btn-secondary btn-sm" @click="logout()">退出登录</button>
                  </div>
                </div>
                <div class="frp-grid">
                  <div class="frp-stat"><div class="frp-stat-label">用户名</div><div class="frp-stat-value">{{ (user && user.name) || auth.username || '—' }}</div></div>
                  <div class="frp-stat" v-if="user && (user.traffic_limit || user.max_tunnels)"><div class="frp-stat-label">隧道 / 流量</div><div class="frp-stat-value">{{ tunnels.length }}{{ user.max_tunnels ? ' / ' + user.max_tunnels : '' }}{{ user.traffic_limit ? ' · 剩余 ' + F.fmtBytes(user.traffic_limit - (user.traffic_used || 0)) : '' }}</div></div>
                  <div class="frp-stat"><div class="frp-stat-label">访问密钥</div><div class="frp-stat-value">{{ auth.tokenPreview || '—' }}</div></div>
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

                <transition name="frp-collapse">
                <div v-if="createOpen" class="frp-collapse" style="margin-bottom:12px">
                  <div class="frp-grid" style="grid-template-columns:repeat(auto-fit,minmax(140px,1fr))">
                    <label class="frp-field"><span>节点</span>
                      <select class="select-input" v-model="createForm.node">
                        <option v-for="n in nodeOptions" :key="n.value" :value="n.value">{{ n.text }}</option>
                      </select>
                    </label>
                    <label class="frp-field"><span>协议类型</span>
                      <select class="select-input" v-model="createForm.type">
                        <option value="tcp">TCP</option><option value="udp">UDP</option><option value="http">HTTP</option><option value="https">HTTPS</option>
                      </select>
                    </label>
                    <label class="frp-field"><span>本地地址</span><input class="text-input" v-model="createForm.local_ip"></label>
                    <label class="frp-field"><span>本地端口</span><input class="text-input" type="number" v-model="createForm.local_port" placeholder="25565"></label>
                    <label class="frp-field" v-if="createForm.type === 'http' || createForm.type === 'https'"><span>绑定域名（必填）</span><input class="text-input" v-model="createForm.remote" placeholder="mc.example.com"></label>
                    <label class="frp-field"><span>隧道名</span><input class="text-input" v-model="createForm.name" placeholder="我的 MC 服务器"></label>
                  </div>
                  <div class="frp-row" style="margin-top:10px">
                    <button class="btn btn-primary btn-sm" @click="submitCreate()">创建</button>
                    <button class="btn btn-secondary btn-sm" @click="createOpen = false">取消</button>
                  </div>
                </div>
                </transition>

                <div v-if="tunnels.length" style="display:flex;flex-direction:column;gap:10px">
                  <div v-for="t in tunnels" :key="t.id" class="frp-tunnel" :class="{ 'is-running': runMap[String(t.id)] && runMap[String(t.id)].running }">
                    <div class="frp-tunnel-head">
                      <span class="frp-badge frp-badge--type">{{ t.type }}</span>
                      <span class="frp-tunnel-name">{{ t.name }}</span>
                      <span v-if="t.status === 2" class="frp-badge frp-badge--err">已封禁</span>
                      <span v-if="runMap[String(t.id)] && runMap[String(t.id)].running" class="frp-badge frp-badge--ok"><span class="frp-dot frp-dot--live"></span>本地运行中 · {{ F.fmtUptime(runMap[String(t.id)].uptimeSecs) }}</span>
                    </div>
                    <div class="frp-tunnel-meta">
                      <span>节点：{{ nodeName(t.node) }}</span>
                      <span>本地 {{ t.local_ip }}:{{ t.local_port }}</span>
                      <span v-for="tag in flagTags(t.flag)" :key="tag" class="frp-badge">{{ tag }}</span>
                    </div>
                    <div class="frp-tunnel-addr">
                      <code>{{ addrOf(t) }}</code>
                      <button class="btn btn-secondary btn-sm" @click="copyAddr(t)">复制</button>
                    </div>
                    <div class="frp-tunnel-actions">
                      <button v-if="!(runMap[String(t.id)] && runMap[String(t.id)].running)" class="btn btn-primary btn-sm" @click="startTunnel(t)">启动</button>
                      <button v-else class="btn btn-secondary btn-sm" @click="stopTunnel(t)">停止</button>
                      <button class="btn btn-secondary btn-sm" @click="openLogs(t)">日志</button>
                      <button class="btn btn-secondary btn-sm" @click="openEdit(t)">编辑</button>
                      <button class="btn btn-secondary btn-sm" style="color:#dc2626" @click="removeTunnel(t)">删除</button>
                    </div>
                  </div>
                </div>
                <div v-else-if="!loading" class="frp-card-hint" style="margin:0">还没有隧道，点右上角「新建隧道」创建一个吧。Minecraft 联机建议选 TCP 协议、本地端口 25565。</div>
                <div v-else class="frp-skeleton"></div>

                <transition name="frp-collapse">
                <div v-if="editOpen" class="frp-collapse" style="margin-top:12px">
                  <div class="frp-grid" style="grid-template-columns:repeat(auto-fit,minmax(140px,1fr))">
                    <label class="frp-field"><span>本地地址</span><input class="text-input" v-model="editForm.local_ip"></label>
                    <label class="frp-field"><span>本地端口</span><input class="text-input" type="number" v-model="editForm.local_port"></label>
                    <label class="frp-field"><span>备注</span><input class="text-input" v-model="editForm.note"></label>
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
window.VersePC.PageLanSakura = PageLanSakura;
