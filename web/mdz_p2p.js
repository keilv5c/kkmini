/* ============================================================================
 * mdz_p2p.js —— Mini DAYZ 双模式零服务器联机：WebRTC 传输层 + window.Peer 垫片
 * ----------------------------------------------------------------------------
 * 设计要点（为什么是"垫片"而不是"重写 lan_bridge.js"）：
 *   反查 lan_bridge.js 后确认，它是纯传输适配层——它 new 出 PeerJS 的 Peer，
 *   再把手里的 conn 对象通过 setSender()/setConn() 注入给 MPNet / MPJoin /
 *   MPWorldState / MPEntities / MPPlayers / MPInteractions 六个模块。
 *   它需要的接口只有：
 *     Peer : on('open'|'connection') / connect(id) / destroy()
 *     conn : send(obj) / open / on('open'|'data'|'close'|'error') / close() / bufferSize
 *   所以本文件提供 window.Peer 顶替 PeerJS，lan_bridge.js 与 mp_*.js 一个字节都不用改。
 *
 * 双通道：
 *   mdz_game_sync  可靠有序(order:true)      —— 游戏唯一通道，世界快照 mpj_* 依赖它
 *   mdz_fast       无序不重传(order:false)   —— 只走 player_state / player_visual
 *   （游戏自身的 mpj_* 分块无重传机制，所以主通道绝不能设成无序）
 *
 * 模式：
 *   qr   模式A：无 STUN，只收集 host 候选（mDNS 也算可用），握手串压缩后画二维码
 *   text 模式B：国内 STUN，完整候选，握手串手动复制粘贴
 *
 * 依赖注入：RTCPeerConnection 等由 opts.RTC 传入，缺省取 window/global 上的实现，
 *           因此同一份代码可以在浏览器和 Node(node-datachannel) 里跑测试。
 * ==========================================================================*/
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./mdz_core.js'));
  } else {
    root.MDZP2P = factory(root.MdzCore);
  }
})(typeof self !== 'undefined' ? self : this, function (Core) {
  'use strict';

  var CFG = {
    CH_RELIABLE: 'mdz_game_sync',
    CH_FAST: 'mdz_fast',
    // 实测可用（2026-09 本机 STUN Binding 探测）：stun.qq.com 已失效，故不采用
    STUN_TEXT: [
      'stun:stun.miwifi.com:3478',
      'stun:stun.chat.bilibili.com:3478',
      'stun:stun.hitv.com:3478'
    ],
    ICE_TIMEOUT_QR: 6000,     // 局域网只有 host 候选，收敛很快
    ICE_TIMEOUT_TEXT: 12000,  // 要等 STUN 反射候选
    OPEN_TIMEOUT: 45000,
    PREOPEN_QUEUE_MAX: 200,
    DEBUG: true
  };

  var ERR = {
    NO_CANDIDATES: 'MDZ_E_NO_CANDIDATES',
    ICE_FAILED: 'MDZ_E_ICE_FAILED',
    PARSE: 'MDZ_E_PARSE',
    TIMEOUT: 'MDZ_E_TIMEOUT',
    CAMERA: 'MDZ_E_CAMERA',
    STATE: 'MDZ_E_STATE'
  };

  function nowts() { return new Date().toLocaleTimeString('zh-CN', { hour12: false }); }

  function makeLogger(tag, on) {
    var prefix = '[MDZ-P2P' + (tag ? ' ' + tag : '') + ']';
    return function () {
      if (!CFG.DEBUG) return;
      var args = Array.prototype.slice.call(arguments);
      if (typeof console !== 'undefined' && console.log) console.log.apply(console, [prefix, nowts()].concat(args));
    };
  }

  function err(code, message, extra) {
    var e = new Error(message);
    e.code = code;
    if (extra) e.extra = extra;
    return e;
  }

  /* --------------------------------------------------------------- 环境解析 */

  function defaultEnv() {
    if (typeof window !== 'undefined') return window;
    if (typeof globalThis !== 'undefined') return globalThis;
    return {};
  }

  function resolveRTC(opts) {
    var env = (opts && opts.env) || defaultEnv();
    var o = (opts && opts.RTC) || {};
    var PC = o.RTCPeerConnection || env.RTCPeerConnection || env.webkitRTCPeerConnection;
    if (!PC) throw err(ERR.STATE, '当前环境没有 RTCPeerConnection（浏览器需 https 或 localhost）');
    return {
      RTCPeerConnection: PC,
      RTCSessionDescription: o.RTCSessionDescription || env.RTCSessionDescription || null,
      RTCIceCandidate: o.RTCIceCandidate || env.RTCIceCandidate || null
    };
  }

  /* ------------------------------------------------------------ 通用小工具 */

  function waitIceComplete(pc, timeoutMs, log) {
    return new Promise(function (resolve) {
      if (pc.iceGatheringState === 'complete') { log('ICE 收集：已经是 complete'); return resolve('already'); }
      var done = false, timer = null;
      function finish(why, extra) {
        if (done) return; done = true;
        if (timer) clearTimeout(timer);
        try { if (pc.removeEventListener) pc.removeEventListener('icegatheringstatechange', onch); } catch (e) {}
        try { pc.onicegatheringstatechange = null; } catch (e) {}
        log('ICE 收集结束：' + why + (extra ? ' (' + extra + ')' : ''));
        resolve(why);
      }
      function onch() { if (pc.iceGatheringState === 'complete') finish('complete'); }
      try {
        if (pc.addEventListener) pc.addEventListener('icegatheringstatechange', onch);
        else pc.onicegatheringstatechange = onch;
      } catch (e) { pc.onicegatheringstatechange = onch; }
      timer = setTimeout(function () {
        finish('timeout', '仍有候选在收集中，先用手上的候选继续');
      }, timeoutMs);
    });
  }

  function setRemote(pc, desc, rtc) {
    var d = desc;
    if (rtc.RTCSessionDescription && !(desc instanceof Object && desc.constructor === rtc.RTCSessionDescription)) {
      try { d = new rtc.RTCSessionDescription(desc); } catch (e) { d = desc; }
    }
    return Promise.resolve(pc.setRemoteDescription(d));
  }

  function looksLikePc(obj) {
    return obj && typeof obj.createDataChannel === 'function' && typeof obj.createOffer === 'function';
  }

  /* ==========================================================================
   * MdzSession —— 一局连接（一条 RTCPeerConnection + 两条 DataChannel）
   * ========================================================================*/
  function MdzSession(opts) {
    opts = opts || {};
    this.role = opts.role === 'host' ? 'host' : 'client';
    this.mode = opts.mode === 'qr' ? 'qr' : 'text';
    this.env = opts.env || defaultEnv();
    this.rtc = resolveRTC(opts);
    this.log = makeLogger(this.role + '/' + this.mode, opts.debug);
    this.iceTimeoutMs = opts.iceTimeoutMs || (this.mode === 'qr' ? CFG.ICE_TIMEOUT_QR : CFG.ICE_TIMEOUT_TEXT);
    this.iceStats = null;
    this.hint = null;            // 'mdns' 表示建议取消 mDNS 混淆
    this.pc = null;
    this.chReliable = null;
    this.chFast = null;
    this.open = false;
    this.closed = false;

    this.onData = null;
    this.onState = null;
    this.onError = null;

    this._preopen = [];          // 通道还没开就要发出去的包，先排队
    this._rxPending = [];        // 业务方（MdzConn）还没挂上监听时收到的包，先缓存
    this._openWaiters = [];      // 多个地方会同时等"通道打开"，必须支持多等待者
    this._reassembler = new Core.ChunkReassembler();
    this._chunkId = 1;
    this._stats = { txMsgs: 0, txBytes: 0, rxMsgs: 0, rxBytes: 0, chunks: 0, dropped: 0 };
  }

  MdzSession.prototype._config = function () {
    if (this.mode === 'qr') {
      // 模式A：故意不给 STUN —— 只要内网 host 候选，握手更快也不泄露公网地址
      return { iceServers: [], iceCandidatePoolSize: 0, bundlePolicy: 'max-bundle' };
    }
    return {
      iceServers: [{ urls: CFG.STUN_TEXT }],
      iceCandidatePoolSize: 0,
      bundlePolicy: 'max-bundle'
    };
  };

  MdzSession.prototype._createPc = function () {
    var self = this;
    var PC = this.rtc.RTCPeerConnection;
    var pc = new PC(this._config());
    this.pc = pc;

    pc.oniceconnectionstatechange = function () {
      self.log('iceConnectionState =', pc.iceConnectionState);
      self._emitState({ ice: pc.iceConnectionState, conn: pc.connectionState });
      if (pc.iceConnectionState === 'failed') {
        self._fail(err(ERR.ICE_FAILED,
          self.mode === 'qr' ? '局域网直连失败（可能不在同一 Wi-Fi，或路由器开了客户端隔离）'
                             : 'P2P 打洞失败，双方网络 NAT 类型受限（需要 TURN 中继）'));
      }
    };
    pc.onconnectionstatechange = function () {
      self.log('connectionState =', pc.connectionState);
      self._emitState({ ice: pc.iceConnectionState, conn: pc.connectionState });
    };
    pc.ondatachannel = function (ev) {
      var ch = ev.channel;
      self.log('收到对端数据通道：' + ch.label);
      self._bindChannel(ch);
    };
    return pc;
  };

  MdzSession.prototype._bindChannel = function (ch) {
    var self = this;
    // 通道关闭/销毁后再读 ch.label 可能直接抛错（部分实现会），所以一开始就记住
    var label = ch.label;
    if (label === CFG.CH_FAST) this.chFast = ch;
    else this.chReliable = ch;

    try { ch.binaryType = 'arraybuffer'; } catch (e) {}

    ch.onopen = function () {
      self.log('通道已打开：' + label);
      if (ch === self.chReliable) self._onReliableOpen();
    };
    ch.onclose = function () {
      self.log('通道已关闭：' + label);
      if (ch === self.chReliable) {
        self.open = false;
        self._emitState({ channel: 'closed' });
        self._emitClosed();
      }
    };
    ch.onerror = function (e) {
      var msg = (e && (e.message || e.error)) || '未知';
      self.log('通道错误：' + label + ' -> ' + msg);
      if (ch === self.chReliable) self._fail(err(ERR.ICE_FAILED, '数据通道错误：' + msg));
    };
    ch.onmessage = function (ev) { self._handleIncoming(ev.data, label); };

    // 某些实现（含 node-datachannel polyfill）在绑定前就已经 open
    var rs = null;
    try { rs = ch.readyState; } catch (e) {}
    if (rs === 'open' && ch === this.chReliable) this._onReliableOpen();
  };

  MdzSession.prototype._onReliableOpen = function () {
    if (this.open) return;
    this.open = true;
    this.log('主通道就绪，开始游戏同步');
    this._flushPreopen();
    // 唤醒所有等待者：房主侧 Peer 的 'connection' 与 hostAcceptPeer 会同时挂在这里
    var waiters = this._openWaiters; this._openWaiters = [];
    for (var i = 0; i < waiters.length; i++) {
      clearTimeout(waiters[i].timer);
      try { waiters[i].resolve(); } catch (e) {}
    }
    this._emitState({ channel: 'open' });
  };

  MdzSession.prototype.waitOpen = function (timeoutMs) {
    var self = this;
    if (this.open) return Promise.resolve();
    return new Promise(function (resolve, reject) {
      var waiter = { resolve: resolve, timer: null };
      waiter.timer = setTimeout(function () {
        var i = self._openWaiters.indexOf(waiter);
        if (i >= 0) self._openWaiters.splice(i, 1);
        reject(err(ERR.TIMEOUT, '等待对端建立连接超时（' + Math.round((timeoutMs || CFG.OPEN_TIMEOUT) / 1000) + 's）'));
      }, timeoutMs || CFG.OPEN_TIMEOUT);
      self._openWaiters.push(waiter);
    });
  };

  /* ------------------------------------------------------------ 握手（非 trickle） */

  MdzSession.prototype.createOffer = function () {
    var self = this;
    var pc = this._createPc();
    // 房主侧自己建两条通道；客机侧靠 ondatachannel 拿到
    var rel = pc.createDataChannel(CFG.CH_RELIABLE, { ordered: true });
    var fast;
    try {
      fast = pc.createDataChannel(CFG.CH_FAST, { ordered: false, maxRetransmits: 0 });
    } catch (e) {
      self.log('副通道创建失败（将全部走主通道）：' + e.message);
    }
    this._bindChannel(rel);
    if (fast) this._bindChannel(fast);

    return Promise.resolve(pc.createOffer())
      .then(function (offer) { return pc.setLocalDescription(offer); })
      .then(function () { return waitIceComplete(pc, self.iceTimeoutMs, self.log); })
      .then(function () { return self._finishHandshake(); });
  };

  MdzSession.prototype.acceptOffer = function (offerDesc) {
    var self = this;
    var pc = this.pc || this._createPc();
    return setRemote(pc, offerDesc, this.rtc)
      .then(function () { return pc.createAnswer(); })
      .then(function (answer) { return pc.setLocalDescription(answer); })
      .then(function () { return waitIceComplete(pc, self.iceTimeoutMs, self.log); })
      .then(function () { return self._finishHandshake(); });
  };

  MdzSession.prototype.acceptAnswer = function (answerDesc) {
    var self = this;
    var pc = this.pc;
    if (!pc) return Promise.reject(err(ERR.STATE, '还没生成 Offer，无法接受 Answer'));
    return setRemote(pc, answerDesc, this.rtc).then(function () {
      self._analyze(pc.localDescription && pc.localDescription.sdp, 'local');
      self.log('已应用 Answer，等待直连建立…');
      return pc;
    });
  };

  MdzSession.prototype._finishHandshake = function () {
    var ld = this.pc.localDescription;
    if (!ld || !ld.sdp) throw err(ERR.STATE, '本地描述为空，握手失败');
    this.iceStats = this._analyze(ld.sdp, 'local');

    if (this.mode === 'qr') {
      if (!this.iceStats.modeAUsable) {
        throw err(ERR.NO_CANDIDATES, '没有收集到任何局域网候选，扫码模式无法工作（建议切换到"异地文本 SDP"模式）');
      }
      if (this.iceStats.needsUnobfuscation) {
        this.hint = 'mdns';
        this.log('提示：只拿到 mDNS 候选（.local），若扫码后连不上，可点"取消 mDNS 混淆"重试');
      }
    } else if (this.iceStats.srflx === 0) {
      this.log('提示：没有拿到公网反射候选（STUN 未响应），异地联机可能失败');
    }

    var munged = Core.mungeSdp(ld.sdp);
    if (munged.degraded) this.log('SDP 裁剪降级（已回退完整 SDP）：' + munged.reason);
    else this.log('SDP 裁剪：减少 ' + munged.dropped + ' 行');

    // 再把候选瘦身：同一台机器的多个 host 候选是等价备选，
    // 但每一行都要占二维码空间（约 110 字符），局域网留 2 个足够。
    var trimmed = Core.trimCandidates(munged.sdp, this.mode === 'qr' ? 2 : 3);
    if (trimmed.degraded) this.log('候选瘦身降级（保留原样）：' + trimmed.reason);
    else if (trimmed.dropped) this.log('候选瘦身：丢掉 ' + trimmed.dropped + ' 个冗余候选');

    return Core.packSdp({ type: ld.type, sdp: trimmed.sdp });
  };

  MdzSession.prototype._analyze = function (sdp, which) {
    var st = Core.analyzeCandidates(sdp);
    this.log('候选统计（' + which + '）：总数=' + st.total + ' host=' + st.host + ' mDNS=' + st.mdns +
      ' 内网=' + st.lan + ' srflx=' + st.srflx + ' relay=' + st.relay);
    if (st.lanAddresses.length) this.log('内网地址：' + st.lanAddresses.join(', '));
    return st;
  };

  /* ---------------------------------------------------------------- 收发数据 */

  MdzSession.prototype._flushPreopen = function () {
    var q = this._preopen; this._preopen = [];
    for (var i = 0; i < q.length; i++) this._sendNow(q[i]);
  };

  MdzSession.prototype.send = function (obj) {
    if (!this.open) {
      if (this._preopen.length >= CFG.PREOPEN_QUEUE_MAX) {
        this._preopen.shift();
        this._stats.dropped++;
        this.log('发送队列已满，丢弃最早的包（对端可能还没连上）');
      }
      this._preopen.push(obj);
      return false;
    }
    this._sendNow(obj);
    return true;
  };

  MdzSession.prototype._sendNow = function (obj) {
    var str = typeof obj === 'string' ? obj : Core.safeStringify(obj);
    if (str === null) { this.log('无法序列化，丢弃一个包'); this._stats.dropped++; return; }

    var lane = (typeof obj === 'string') ? 'reliable' : Core.classifyMessage(obj);
    var ch = (lane === 'fast' && this.chFast && this.chFast.readyState === 'open') ? this.chFast : this.chReliable;
    if (!ch || ch.readyState !== 'open') { this._stats.dropped++; return; }

    if (str.length > Core.CHUNK_THRESHOLD) {
      // 超大消息：切成多个信封，只走可靠通道
      var id = this._chunkId++;
      var parts = Core.makeChunks(str, id);
      this.log('大消息 ' + str.length + ' 字符 -> 切成 ' + parts.length + ' 块');
      for (var i = 0; i < parts.length; i++) this.chReliable.send(Core.safeStringify(parts[i]));
      this._stats.chunks += parts.length;
      this._stats.txMsgs++;
      this._stats.txBytes += str.length;
      return;
    }
    try {
      ch.send(str);
      this._stats.txMsgs++;
      this._stats.txBytes += str.length;
    } catch (e) {
      this._stats.dropped++;
      this.log('发送失败：' + e.message);
    }
  };

  MdzSession.prototype._handleIncoming = function (data, label) {
    var str;
    if (typeof data === 'string') str = data;
    else if (data instanceof ArrayBuffer || (data && data.buffer instanceof ArrayBuffer)) {
      str = Core.utf8Decode(new Uint8Array(data.buffer ? data.buffer : data, data.byteOffset || 0, data.byteLength || data.length));
    } else if (data && typeof data.toString === 'function') str = data.toString();
    else return;

    this._stats.rxMsgs++;
    this._stats.rxBytes += str.length;

    var obj = Core.safeParse(str);
    if (obj === null) { this.log('收到无法解析的数据（已忽略）'); return; }

    // 我们自己的分块信封
    if (obj.__mdz && typeof obj.__mdz === 'object') {
      var joined = this._reassembler.push(obj.__mdz, obj.d);
      if (joined === null) return;   // 还没收齐
      obj = Core.safeParse(joined);
      if (obj === null) { this.log('分块重组后无法解析（已忽略）'); return; }
      this.log('分块重组完成：' + joined.length + ' 字符');
    }

    if (this.onData) {
      try { this.onData(obj, label); } catch (e) { this.log('业务处理抛错：' + e.message); }
    } else {
      // MdzConn 还没构造好（UI 流程里 sendAnswer 早于 joinGame），先缓存避免丢包
      this._rxPending.push(obj);
      if (this._rxPending.length > 500) this._rxPending.shift();
    }
  };

  /** MdzConn 构造时调用：挂上业务回调，并把缓存里的包补发出去 */
  MdzSession.prototype.attachDataHandler = function (cb) {
    var self = this;
    this.onData = cb;
    var q = this._rxPending; this._rxPending = [];
    for (var i = 0; i < q.length; i++) {
      try { cb(q[i], 'buffered'); } catch (e) { self.log('补发缓存包时抛错：' + e.message); }
    }
  };

  /* ---------------------------------------------------------------- 状态事件 */

  MdzSession.prototype._emitState = function (info) {
    if (this.onState) { try { this.onState(info, this); } catch (e) {} }
  };
  MdzSession.prototype._emitClosed = function () {
    if (this.onClose) { try { this.onClose(this); } catch (e) {} }
  };
  MdzSession.prototype._fail = function (e) {
    this.log('错误：' + e.message);
    if (this.onError) { try { this.onError(e, this); } catch (_) {} }
  };

  MdzSession.prototype.stats = function () {
    return {
      role: this.role, mode: this.mode, open: this.open, closed: this.closed,
      reliable: this.chReliable && this.chReliable.readyState,
      fast: this.chFast && this.chFast.readyState,
      buffered: this.bufferSize(),
      ice: this.pc && this.pc.iceConnectionState,
      conn: this.pc && this.pc.connectionState,
      iceStats: this.iceStats ? {
        total: this.iceStats.total, mdns: this.iceStats.mdns, lan: this.iceStats.lan,
        srflx: this.iceStats.srflx, relay: this.iceStats.relay, lanAddresses: this.iceStats.lanAddresses
      } : null,
      tx: this._stats
    };
  };

  /** lan_bridge 的隐藏契约：mp_join 用它做发送背压 */
  MdzSession.prototype.bufferSize = function () {
    var n = 0;
    try {
      if (this.chReliable && typeof this.chReliable.bufferedAmount === 'number') n = this.chReliable.bufferedAmount;
      if (this.chFast && typeof this.chFast.bufferedAmount === 'number') n += this.chFast.bufferedAmount;
    } catch (e) {}
    return n;
  };

  MdzSession.prototype.close = function () {
    if (this.closed) return;
    this.closed = true;
    this.open = false;
    try { if (this.chReliable) this.chReliable.close(); } catch (e) {}
    try { if (this.chFast) this.chFast.close(); } catch (e) {}
    try { if (this.pc) this.pc.close(); } catch (e) {}
    this.log('会话已关闭');
    this._emitClosed();
  };

  /* ==========================================================================
   * MdzConn —— 顶替 PeerJS 的 DataConnection，供 lan_bridge 与 6 个 MP 模块使用
   * ========================================================================*/
  function MdzConn(session, peer) {
    this._s = session;
    this._handlers = { open: [], data: [], close: [], error: [] };
    this.peer = peer || null;         // 兼容 PeerJS 字段
    this.label = CFG.CH_RELIABLE;
    this.metadata = null;
    var self = this;
    session.attachDataHandler(function (obj) { self._emit('data', obj); });
    session.onClose = function () { self._emit('close'); };
    session.onError = function (e) { self._emit('error', e); };
    // 客机侧的 conn 是"先 connect() 再等通道"的，必须由这里补发 'open'；
    // 房主侧走 on('connection') 时通道通常已经打开，由 on() 里的补发分支处理。
    session.waitOpen().then(function () {
      if (self._s.open) self._emit('open');
    }).catch(function () { /* 超时/失败由 error 事件表达 */ });
  }
  Object.defineProperty(MdzConn.prototype, 'open', {
    get: function () { return !!this._s.open; }
  });
  Object.defineProperty(MdzConn.prototype, 'bufferSize', {
    get: function () { return this._s.bufferSize(); }
  });
  Object.defineProperty(MdzConn.prototype, 'dataChannel', {
    get: function () { return this._s.chReliable; }
  });
  MdzConn.prototype.send = function (obj) { return this._s.send(obj); };
  MdzConn.prototype.close = function () { this._s.close(); };
  MdzConn.prototype.on = function (evt, cb) {
    var list = this._handlers[evt];
    if (list) list.push(cb);
    // 通道已经打开时补发 'open'，否则 lan_bridge 挂上监听后永远收不到
    if (evt === 'open' && this.open) {
      var self = this;
      setTimeout(function () { try { cb(); } catch (e) { self._emit('error', e); } }, 0);
    }
    return this;
  };
  MdzConn.prototype._emit = function (evt, arg) {
    var list = this._handlers[evt] || [];
    for (var i = 0; i < list.length; i++) {
      try { list[i](arg); } catch (e) { this._s.log('conn 监听器抛错(' + evt + ')：' + e.message); }
    }
  };

  /* ==========================================================================
   * window.Peer 垫片 —— 顶替 PeerJS 的 Peer 类
   * ========================================================================*/
  // 当前活跃会话槽。
  // 房主与客机各占一个槽：真机上两者在不同设备，但自测页/单进程测试需要在同一
  // 页面里同时跑通两端，所以不能共用一个槽位。
  var current = {
    host: null, client: null,          // MdzSession
    connHost: null, connClient: null,  // MdzConn
    peerHost: null, peerClient: null,  // MdzPeer
    mode: 'qr',
    role: null,
    pendingPeerOpen: null,
    clientReady: false,
    // 记下调用方（UI 或测试）传进来的运行环境，供"自动补建会话"复用
    envHint: null,
    rtcHint: null,
    listeners: {}
  };

  function emit(evt, arg) {
    var l = current.listeners[evt] || [];
    for (var i = 0; i < l.length; i++) { try { l[i](arg); } catch (e) {} }
  }

  function MdzPeer(idOrOpts, maybeOpts) {
    var optEnv = (maybeOpts && maybeOpts.env) || (idOrOpts && idOrOpts.env) || current.envHint || null;
    var optRTC = (maybeOpts && maybeOpts.RTC) || (idOrOpts && idOrOpts.RTC) || current.rtcHint || null;
    var env = optEnv || defaultEnv();
    var isHostCall;

    if (looksLikePc(idOrOpts)) {            // 直接传一个现成的 pc（调试用）
      isHostCall = false;
    } else if (typeof idOrOpts === 'string' || typeof idOrOpts === 'number') {
      isHostCall = true;                    // new Peer(roomId, opts) —— 房主
    } else {
      isHostCall = false;                   // new Peer(opts) —— 客机
    }

    this.id = isHostCall ? String(idOrOpts) : null;
    this.open = false;
    this.disconnected = false;
    this.destroyed = false;
    this._handlers = {};
    this._isHost = isHostCall;

    var self = this;
    this._pending = [];

    // 复用 UI 已经建好的会话（正常流程），否则按默认模式现开一个（用户直接点了游戏原面板时）
    var slotName = isHostCall ? 'host' : 'client';
    var connSlot = isHostCall ? 'connHost' : 'connClient';
    var peerSlot = isHostCall ? 'peerHost' : 'peerClient';
    var s = current[slotName];
    var autoCreated = false;
    if (!s || s.closed || s.role !== slotName) {
      s = MdzSessionFactory({ role: slotName, mode: current.mode, env: env, RTC: optRTC });
      current[slotName] = s;
      current[connSlot] = null;             // 会话换了，旧 conn 作废
      autoCreated = true;
    }
    this._session = s;
    if (!current[connSlot] || current[connSlot]._s !== s) current[connSlot] = new MdzConn(s);
    this._conn = current[connSlot];
    this._conn.peer = this;
    current[peerSlot] = this;

    s.log('Peer 垫片就绪（' + (isHostCall ? '房主' : '客机') + '，模式=' + s.mode + '）');

    if (isHostCall) {
      // 房主：立刻"注册成功"，随后等对端连进来
      setTimeout(function () {
        self.open = true;
        self._fire('open', self.id);
        s.waitOpen().then(function () {
          s.log('对端通道已打开 -> 触发 connection 事件（lan_bridge 将接管全部同步）');
          self._fire('connection', self._conn);
          emit('connected', { role: 'host' });
        }).catch(function (e) {
          s.log('等待对端超时/失败：' + e.message);
          self._fire('error', e);
          emit('error', e);
        });
      }, 0);
      // 用户点的是游戏原面板的 HOST 按钮：我们这边还没有 Offer，补生成一个并通知 UI 显示二维码
      if (autoCreated && !s.pc) {
        current.role = 'host';
        s.createOffer().then(function (payload) {
          var fit = Core.qrFit(payload);
          s.log('（原面板入口）Offer 就绪：' + fit.chars + ' 字符');
          emit('payload', { role: 'host', payload: payload, fit: fit, hint: s.hint, iceStats: s.iceStats });
        }).catch(function (e) { emit('error', e); });
      }
    } else {
      // 客机：两种情况
      //  a) UI 流程中 clientAcceptHost() 已经先生成好 Answer -> 现在就 fire 'open'
      //  b) 用户直接点了游戏原面板的"加入" -> 先挂着，等 Answer 就绪再 fire 'open'
      if (current.clientReady) {
        setTimeout(function () {
          if (self.destroyed) return;
          self.open = true;
          self._fire('open', self.id || 'mdz-client');
        }, 0);
      } else {
        current.pendingPeerOpen = function () {
          if (self.destroyed) return;
          self.open = true;
          self._fire('open', self.id || 'mdz-client');
        };
        // 用户点的是游戏原面板的 JOIN：通知 UI 弹出扫码/粘贴面板去要房主的握手串
        if (autoCreated) {
          current.role = 'client';
          s.log('（原面板入口）等待房主握手串，已通知界面引导用户');
          emit('needsHostPayload', { mode: s.mode });
        }
      }
    }
  }

  MdzPeer.prototype.on = function (evt, cb) {
    (this._handlers[evt] = this._handlers[evt] || []).push(cb);
    return this;
  };
  MdzPeer.prototype._fire = function (evt, arg) {
    var l = this._handlers[evt] || [];
    for (var i = 0; i < l.length; i++) { try { l[i](arg); } catch (e) { this._session.log('peer 监听器抛错(' + evt + ')：' + e.message); } }
  };
  /** 顶替 peer.connect(hostId)：返回的连接对象会在 DataChannel 打开时触发 'open' */
  MdzPeer.prototype.connect = function () {
    var self = this;
    var conn = this._conn;
    this._session.waitOpen().then(function () {
      self._session.log('connect() 的通道已打开');
      emit('connected', { role: 'client' });
    }).catch(function (e) {
      self._session.log('connect() 失败：' + e.message);
      conn._emit('error', e);
      emit('error', e);
    });
    return conn;
  };
  MdzPeer.prototype.destroy = function () {
    this.destroyed = true;
    this.open = false;
    this._fire('close');
    if (this._session) this._session.close();
    var slotName = this._isHost ? 'host' : 'client';
    var connSlot = this._isHost ? 'connHost' : 'connClient';
    var peerSlot = this._isHost ? 'peerHost' : 'peerClient';
    if (current[slotName] === this._session) { current[slotName] = null; current[connSlot] = null; }
    if (current[peerSlot] === this) current[peerSlot] = null;
    if (!this._isHost) current.pendingPeerOpen = null;
  };
  MdzPeer.prototype.reconnect = function () { this._session.log('reconnect() 被调用（零服务器模式下不支持重连，请重新握手）'); };
  MdzPeer.prototype.disconnect = function () { this.destroy(); };

  /* ==========================================================================
   * 对外 API（给 mdz_ui.js 用）
   * ========================================================================*/
  function MdzSessionFactory(opts) { return new MdzSession(opts); }

  function hostBegin(o) {
    o = o || {};
    var mode = o.mode || current.mode || 'qr';
    current.mode = mode;
    current.role = 'host';
    current.clientReady = false;
    current.envHint = o.env || current.envHint;
    current.rtcHint = o.RTC || current.rtcHint;
    if (current.host) { try { current.host.close(); } catch (e) {} }
    var s = MdzSessionFactory({ role: 'host', mode: mode, env: o.env, RTC: o.RTC, iceTimeoutMs: o.iceTimeoutMs });
    current.host = s;
    current.connHost = null;
    var log = s.log;

    return Promise.resolve()
      .then(function () {
        // 取消 mDNS 混淆与用哪种模式无关：候选质量差时两种模式都值得试一次
        if (o.unobfuscated) return requestCameraForUnobfuscation(s);
        return null;
      })
      .then(function () { log('生成 Offer 并收集候选…'); return s.createOffer(); })
      .then(function (payload) {
        var fit = Core.qrFit(payload);
        log('Offer 握手串就绪：' + fit.chars + ' 字符（' + fit.hint + '）');
        emit('payload', { role: 'host', payload: payload, fit: fit, hint: s.hint, iceStats: s.iceStats });
        return { payload: payload, fit: fit, hint: s.hint, iceStats: s.iceStats, session: s };
      })
      .catch(function (e) { emit('error', e); throw e; });
  }

  function hostAcceptPeer(payloadStr) {
    var s = current.host;
    if (!s || s.role !== 'host') return Promise.reject(err(ERR.STATE, '当前没有等待握手的房主会话'));
    var desc;
    try { desc = Core.unpackSdp(payloadStr); }
    catch (e) { var pe = err(ERR.PARSE, '客机握手串解析失败：' + e.message); emit('error', pe); return Promise.reject(pe); }
    if (desc.type !== 'answer') {
      var te = err(ERR.PARSE, '客机应发回 answer，但收到的是 ' + desc.type + '（是不是把两个二维码搞反了？）');
      emit('error', te); return Promise.reject(te);
    }
    s.log('收到客机 Answer，应用远端描述…');
    return s.acceptAnswer(desc).then(function () {
      emit('state', { stage: 'answer-applied' });
      return s.waitOpen();
    }).then(function () {
      s.log('直连已建立');
    }).catch(function (e) { emit('error', e); throw e; });
  }

  function clientBegin(o) {
    o = o || {};
    var mode = o.mode || current.mode || 'text';
    current.mode = mode;
    current.role = 'client';
    current.clientReady = false;
    current.envHint = o.env || current.envHint;
    current.rtcHint = o.RTC || current.rtcHint;
    if (current.client) { try { current.client.close(); } catch (e) {} }
    var s = MdzSessionFactory({ role: 'client', mode: mode, env: o.env, RTC: o.RTC, iceTimeoutMs: o.iceTimeoutMs });
    current.client = s;
    current.connClient = null;
    s.log('等待房主握手串…');
    return Promise.resolve(s);
  }

  function clientAcceptHost(payloadStr, modeOverride) {
    var s = current.client;
    // 容错：调用方可能没先调 clientBegin（自测页/脚本化调用最容易漏），这里自动补一个客机会话
    if (!s || s.role !== 'client' || s.closed) {
      s = MdzSessionFactory({
        role: 'client',
        mode: modeOverride || current.mode,
        env: current.envHint,
        RTC: current.rtcHint
      });
      current.client = s;
      current.connClient = null;
      current.clientReady = false;
      s.log('（自动补建客机会话）');
    }
    var desc;
    try { desc = Core.unpackSdp(payloadStr); }
    catch (e) { var pe = err(ERR.PARSE, '房主握手串解析失败：' + e.message); emit('error', pe); return Promise.reject(pe); }
    if (desc.type !== 'offer') {
      var te = err(ERR.PARSE, '房主应发来 offer，但收到的是 ' + desc.type + '（是不是扫了房主的"客机二维码"？）');
      emit('error', te); return Promise.reject(te);
    }
    s.log('收到房主 Offer，生成 Answer…');
    return s.acceptOffer(desc).then(function (payload) {
      var fit = Core.qrFit(payload);
      s.log('Answer 握手串就绪：' + fit.chars + ' 字符');
      emit('payload', { role: 'client', payload: payload, fit: fit, hint: s.hint, iceStats: s.iceStats });
      // 客机这一步之后就可以让 lan_bridge 接管了。
      // 注意：UI 可能先调本函数、后调 window.joinGame()，所以两种顺序都要能 fire 'open'。
      current.clientReady = true;
      if (current.pendingPeerOpen) { current.pendingPeerOpen(); current.pendingPeerOpen = null; }
      return { payload: payload, fit: fit, hint: s.hint, iceStats: s.iceStats, session: s };
    }).catch(function (e) { emit('error', e); throw e; });
  }

  /** 模式A 的可选步骤：申请一次摄像头权限以取消 Chrome 的 mDNS 候选混淆 */
  function requestCameraForUnobfuscation(session) {
    var env = session.env;
    var md = env.navigator && env.navigator.mediaDevices;
    if (!md || !md.getUserMedia) {
      session.log('本环境没有摄像头接口，跳过"取消 mDNS 混淆"');
      return Promise.resolve({ ok: false, reason: 'no-media-api' });
    }
    session.log('申请摄像头权限以取消 mDNS 混淆…');
    return md.getUserMedia({ video: true })
      .then(function (stream) {
        try { stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
        session.log('权限已获得：本次 Offer 应能拿到真实内网 IP');
        emit('state', { stage: 'camera-granted' });
        return { ok: true };
      })
      .catch(function (e) {
        session.log('摄像头权限被拒绝：' + (e && e.name));
        emit('state', { stage: 'camera-denied', error: e && e.name });
        return { ok: false, reason: e && e.name };
      });
  }

  function cancel() {
    ['host', 'client'].forEach(function (slot) {
      var s = current[slot];
      if (s) { try { s.close(); } catch (e) {} }
      var p = current[slot === 'host' ? 'peerHost' : 'peerClient'];
      if (p && !p.destroyed) { try { p.destroy(); } catch (e) {} }
    });
    current.host = null; current.client = null;
    current.connHost = null; current.connClient = null;
    current.peerHost = null; current.peerClient = null;
    current.role = null;
    current.pendingPeerOpen = null;
    current.clientReady = false;
    emit('state', { stage: 'cancelled' });
  }

  function install(env) {
    env = env || defaultEnv();
    env.Peer = MdzPeer;
    env.MDZP2P = API;
    return MdzPeer;
  }

  var API = {
    CFG: CFG,
    ERR: ERR,
    MdzSession: MdzSession,
    MdzConn: MdzConn,
    MdzPeer: MdzPeer,

    install: install,
    on: function (evt, cb) { (current.listeners[evt] = current.listeners[evt] || []).push(cb); return API; },
    off: function (evt, cb) {
      var l = current.listeners[evt] || [];
      var i = l.indexOf(cb); if (i >= 0) l.splice(i, 1);
      return API;
    },
    emit: emit,

    setMode: function (m) { current.mode = (m === 'qr') ? 'qr' : 'text'; return current.mode; },
    getMode: function () { return current.mode; },

    /**
     * 双通道回退开关：关掉之后所有消息都走可靠有序主通道（排查问题时用）。
     * 控制台执行：MDZP2P.setFastLane(false)
     */
    setFastLane: function (enabled) {
      var t = Core.FAST_TYPES;
      Object.keys(t).forEach(function (k) { delete t[k]; });
      if (enabled !== false) { t['player_state'] = 1; t['player_visual'] = 1; }
      return Object.keys(t);
    },
    hostBegin: hostBegin,
    hostAcceptPeer: hostAcceptPeer,
    clientBegin: clientBegin,
    clientAcceptHost: clientAcceptHost,
    cancel: cancel,

    currentHost: function () { return current.host; },
    currentClient: function () { return current.client; },
    currentConn: function (role) { return role === 'client' ? current.connClient : current.connHost; },
    stats: function (role) {
      var s = role === 'client' ? current.client : (role === 'host' ? current.host : (current.host || current.client));
      return s ? s.stats() : null;
    },

    // 供测试/调试：把会话槽重置
    _reset: function () { cancel(); current.listeners = {}; }
  };

  return API;
});
