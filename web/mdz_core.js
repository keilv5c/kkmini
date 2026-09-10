/* ============================================================================
 * mdz_core.js —— Mini DAYZ 双模式联机：纯逻辑层（无 DOM、无 WebRTC、可 Node 单测）
 * ----------------------------------------------------------------------------
 * 本文件只做"可离线验证"的事情：
 *   1) SDP 打包/解包（模式A 走二维码、模式B 走文本，格式相同）
 *   2) SDP 安全裁剪（删无用字段 + 必需字段白名单校验 + 失败自动降级）
 *   3) ICE 候选统计（识别 mDNS .local / 内网 IP / 公网），供模式A 判定与引导
 *   4) 代理对安全的字符串切片 + 分块编解码（SCTP 大消息兜底）
 *   5) 消息分流分类（高频状态走无序副通道，其余走可靠有序主通道）
 *   6) 二维码容量估算
 *
 * 之所以独立成文件：Node 里可以直接 require 做单元测试，浏览器里挂 window.MdzCore。
 * ==========================================================================*/
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('pako'));
  } else {
    root.MdzCore = factory(root.pako);
  }
})(typeof self !== 'undefined' ? self : this, function (pako) {
  'use strict';

  var VERSION = 'MDZ1';          // 打包格式版本前缀
  var PREFIX = VERSION + '.';

  // 纯 DataChannel 的 SDP 必需字段：裁剪后必须仍然全部存在，否则判定裁剪失败
  var REQUIRED_TOKENS = [
    'v=', 'o=', 's=', 't=',
    'm=application',
    'a=ice-ufrag:', 'a=ice-pwd:', 'a=fingerprint:', 'a=setup:', 'a=mid:', 'a=sctp-port:'
  ];

  // 可以安全丢弃的行（纯 DataChannel 场景下这些对连接没有贡献）
  var DROPPABLE_PATTERNS = [
    /^a=extmap-allow-mixed\s*$/i,
    /^a=msid-semantic:/i,
    /^a=rtcp-mux\s*$/i,
    /^a=rtcp-rsize\s*$/i,
    /^b=/i,
    /^a=fmtp:/i,
    /^a=rtpmap:/i,
    /^a=extmap:/i,
    /^a=rtcp-fb:/i,
    /^a=ssrc:/i,
    /^a=msid:/i
  ];

  /* ------------------------------------------------------------------ 编码 */

  var B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

  function utf8Encode(str) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
    var bin = unescape(encodeURIComponent(str));
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i) & 0xff;
    return out;
  }

  function utf8Decode(bytes) {
    if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8').decode(bytes);
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return decodeURIComponent(escape(bin));
  }

  // base64url（无填充），自己实现以免 Node/Browser 的 Buffer/btoa 差异
  function bytesToB64Url(bytes) {
    var out = '';
    for (var i = 0; i < bytes.length; i += 3) {
      var b0 = bytes[i], b1 = bytes[i + 1], b2 = bytes[i + 2];
      out += B64_ALPHABET[b0 >> 2];
      out += B64_ALPHABET[((b0 & 3) << 4) | ((b1 === undefined ? 0 : b1) >> 4)];
      if (b1 === undefined) break;
      out += B64_ALPHABET[((b1 & 15) << 2) | ((b2 === undefined ? 0 : b2) >> 6)];
      if (b2 === undefined) break;
      out += B64_ALPHABET[b2 & 63];
    }
    return out;
  }

  function b64UrlToBytes(str) {
    var clean = String(str).replace(/[^A-Za-z0-9\-_]/g, '');
    var len = clean.length;
    var out = new Uint8Array(Math.floor(len * 6 / 8));
    var o = 0, buffer = 0, bits = 0;
    for (var i = 0; i < len; i++) {
      var v = B64_ALPHABET.indexOf(clean[i]);
      if (v < 0) continue;
      buffer = (buffer << 6) | v;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        out[o++] = (buffer >> bits) & 0xff;
      }
    }
    return out.subarray(0, o);
  }

  // FNV-1a 32 位校验和（用于二维码被截断/误扫时快速发现）
  function fnv1a32(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i) & 0xff;
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
      h ^= (str.charCodeAt(i) >> 8) & 0xff;
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h >>> 0;
  }

  /* -------------------------------------------------------- SDP 打包 / 解包 */

  /**
   * 打包：{type, sdp} -> "MDZ1.<base64url(deflateRaw(json))>.<checksum>"
   * @param {{type:string,sdp:string}} desc
   * @returns {string}
   */
  function packSdp(desc) {
    if (!desc || typeof desc.sdp !== 'string') throw new Error('packSdp: 缺少 sdp');
    var payload = JSON.stringify({ t: desc.type || 'offer', s: desc.sdp });
    var packed = pako.deflateRaw(utf8Encode(payload), { level: 9 });
    var body = bytesToB64Url(packed);
    var sum = fnv1a32(payload).toString(36);
    return PREFIX + body + '.' + sum;
  }

  /**
   * 解包：容忍首尾空白、中间换行、被聊天软件插入的空格。
   * @param {string} text
   * @returns {{type:string,sdp:string,chars:number}}
   */
  function unpackSdp(text) {
    if (typeof text !== 'string') throw new Error('unpackSdp: 输入不是字符串');
    // 去掉所有空白（二维码/微信/QQ 复制都可能带换行和空格）
    var s = text.replace(/\s+/g, '');
    if (s.indexOf(PREFIX) !== 0) {
      throw new Error('不是本程序的握手串（应以 ' + PREFIX + ' 开头，实际以 "' + s.slice(0, 8) + '" 开头）');
    }
    var rest = s.slice(PREFIX.length);
    var dot = rest.lastIndexOf('.');
    if (dot < 0) throw new Error('握手串缺少校验字段，可能被截断');
    var body = rest.slice(0, dot);
    var sum = rest.slice(dot + 1);
    var raw = b64UrlToBytes(body);
    var payload;
    try {
      payload = utf8Decode(pako.inflateRaw(raw));
    } catch (e) {
      throw new Error('解压失败（数据可能不完整）：' + e.message);
    }
    if (fnv1a32(payload).toString(36) !== sum) {
      throw new Error('校验和不匹配，握手串在传输中损坏或被截断');
    }
    var obj = JSON.parse(payload);
    return { type: obj.t, sdp: obj.s, chars: s.length };
  }

  /* ------------------------------------------------------------ SDP 安全裁剪 */

  function countMLines(sdp) {
    var n = 0, lines = String(sdp).split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) if (/^m=/.test(lines[i])) n++;
    return n;
  }

  /**
   * 尽量删掉与本次连接无关的字段以缩小二维码。
   * 关键：纯 DataChannel 的 SDP 本来就没有音视频 m-line，这里做的是"瘦身"而不是"动手术"。
   * 只要裁剪后必需字段缺失 / m-line 数量变化 / 结果异常，就**回退到原始 SDP**（文档要求的降级兜底）。
   *
   * @param {string} sdp
   * @returns {{sdp:string, dropped:number, degraded:boolean, reason:string|null}}
   */
  function mungeSdp(sdp) {
    var original = String(sdp);
    try {
      var lines = original.split(/\r?\n/);
      var kept = [];
      var dropped = 0;
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        var drop = false;
        for (var d = 0; d < DROPPABLE_PATTERNS.length; d++) {
          if (DROPPABLE_PATTERNS[d].test(line)) { drop = true; break; }
        }
        if (drop) { dropped++; } else { kept.push(line); }
      }
      var out = kept.join('\r\n');

      // —— 白名单校验：任何一项不满足就降级 ——
      var missing = [];
      for (var r = 0; r < REQUIRED_TOKENS.length; r++) {
        if (out.indexOf(REQUIRED_TOKENS[r]) < 0) missing.push(REQUIRED_TOKENS[r]);
      }
      if (missing.length) {
        return { sdp: original, dropped: 0, degraded: true, reason: '裁剪后缺少必需字段: ' + missing.join(',') };
      }
      if (countMLines(out) !== countMLines(original)) {
        return { sdp: original, dropped: 0, degraded: true, reason: '裁剪后 m-line 数量变化' };
      }
      if (!/^v=0/.test(out)) {
        return { sdp: original, dropped: 0, degraded: true, reason: '裁剪后首行异常' };
      }
      return { sdp: out, dropped: dropped, degraded: false, reason: null };
    } catch (e) {
      // 正则/解析异常一律降级：用完整原始 SDP 继续（文档避坑清单第 1 条）
      return { sdp: original, dropped: 0, degraded: true, reason: '裁剪过程异常: ' + e.message };
    }
  }

  /* -------------------------------------------------------------- ICE 分析 */

  function ipKind(addr) {
    if (!addr) return 'unknown';
    if (/\.local$/i.test(addr)) return 'mdns';
    var m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(addr);
    if (m) {
      var a = +m[1], b = +m[2];
      if (a === 10) return 'lan';
      if (a === 172 && b >= 16 && b <= 31) return 'lan';
      if (a === 192 && b === 168) return 'lan';
      if (a === 169 && b === 254) return 'linklocal';
      if (a === 100 && b >= 64 && b <= 127) return 'cgnat';
      if (a === 127) return 'loopback';
      return 'public';
    }
    if (/^[0-9a-f:]+$/i.test(addr)) return 'ipv6';
    return 'unknown';
  }

  /**
   * 统计 SDP 里的候选，用于模式A 判定：
   *  - 只认真实内网 IP 可能不足（现代浏览器会 mDNS 混淆），所以 mDNS 也算"可用候选"
   *  - 没有任何候选 -> 模式A 无法工作，引导用户切模式B
   * @param {string} sdp
   */
  function analyzeCandidates(sdp) {
    var lines = String(sdp || '').split(/\r?\n/);
    var list = [];
    for (var i = 0; i < lines.length; i++) {
      var m = /^a=candidate:(\S+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(\S+)\s+(\d+)\s+typ\s+(\S+)/i.exec(lines[i]);
      if (!m) continue;
      // 注意：mDNS 候选的地址字段形如 "1a2b3c4d-....local"
      var addr = m[5];
      list.push({ foundation: m[1], component: m[2], transport: m[3], priority: +m[4], address: addr, port: +m[6], type: m[7], kind: ipKind(addr) });
    }
    var host = list.filter(function (c) { return c.type === 'host'; });
    var mdns = list.filter(function (c) { return c.kind === 'mdns'; });
    var lan = list.filter(function (c) { return c.kind === 'lan' || c.kind === 'linklocal'; });
    var srflx = list.filter(function (c) { return c.type === 'srflx'; });
    var relay = list.filter(function (c) { return c.type === 'relay'; });
    return {
      total: list.length, candidates: list,
      host: host.length, mdns: mdns.length, lan: lan.length, srflx: srflx.length, relay: relay.length,
      lanAddresses: lan.map(function (c) { return c.address + ':' + c.port; }),
      // 模式A 可用性判定
      modeAUsable: list.length > 0 && (lan.length > 0 || mdns.length > 0),
      // 需要引导用户"取消 mDNS 混淆"的情况：只有 mDNS、没有真实内网 IP
      needsUnobfuscation: list.length > 0 && lan.length === 0 && mdns.length > 0
    };
  }

  /* ------------------------------------------------- 字符串安全切片 / 分块 */

  /**
   * 按 UTF-16 码元切片，但不切开代理对（emoji 等会因此变成乱码）。
   */
  function splitStringSafely(str, maxUnits) {
    var out = [];
    var i = 0;
    while (i < str.length) {
      var end = Math.min(i + maxUnits, str.length);
      if (end < str.length) {
        var code = str.charCodeAt(end - 1);
        // 高位代理结尾 -> 退一格，避免把代理对劈开
        if (code >= 0xd800 && code <= 0xdbff) end -= 1;
      }
      if (end <= i) end = i + 1;
      out.push(str.slice(i, end));
      i = end;
    }
    return out;
  }

  // 分块阈值：游戏自己按 12000 字节分块世界快照，这里只是"再大就兜底"的安全网
  var CHUNK_THRESHOLD = 24 * 1024;   // 超过 24KB 的字符串走分块
  var CHUNK_MAX_UNITS = 12 * 1024;   // 每块最多 12K 码元（与游戏自身的分块大小对齐）

  /**
   * 把一个大字符串切成多个可独立发送的 JSON 信封。
   * 接收端由 ChunkReassembler 还原。
   */
  function makeChunks(str, id) {
    var parts = splitStringSafely(str, CHUNK_MAX_UNITS);
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      out.push({ __mdz: { id: id, i: i, t: parts.length }, d: parts[i] });
    }
    return out;
  }

  /** 分块重组器：按 id 聚合，处理乱序/重复/超时丢弃 */
  function ChunkReassembler(opts) {
    opts = opts || {};
    this.timeoutMs = opts.timeoutMs || 30000;
    this.buffers = {};
  }
  ChunkReassembler.prototype.push = function (meta, data) {
    var b = this.buffers[meta.id];
    if (!b || (Date.now() - b.at) > this.timeoutMs) {
      b = this.buffers[meta.id] = { parts: new Array(meta.t), got: 0, total: meta.t, at: Date.now() };
    }
    if (b.parts[meta.i] === undefined) {
      b.parts[meta.i] = data;
      b.got++;
    }
    b.at = Date.now();
    if (b.got === b.total) {
      delete this.buffers[meta.id];
      return b.parts.join('');
    }
    return null;
  };
  ChunkReassembler.prototype.stats = function () {
    var n = 0, keys = Object.keys(this.buffers);
    for (var i = 0; i < keys.length; i++) n += this.buffers[keys[i]].got;
    return { pending: keys.length, parts: n };
  };

  /* --------------------------------------------------------- 消息分流策略 */

  // 高频、可自愈（丢一包下一包就覆盖）的消息 -> 无序副通道
  // 其余（世界快照 mpj_*、物品、背包、伤害、聊天、emote…）-> 可靠有序主通道
  var FAST_TYPES = {
    'player_state': 1,
    'player_visual': 1
  };

  function classifyMessage(obj) {
    if (!obj || typeof obj !== 'object') return 'reliable';
    if (obj.__mdz) return 'reliable';                 // 分块信封永远走可靠通道
    if (FAST_TYPES[obj.type]) return 'fast';
    return 'reliable';
  }

  /* ------------------------------------------------------------ 候选瘦身 */

  /**
   * 只保留每类（host/srflx/relay…）优先级最高的前 N 个候选。
   * 目的：把二维码里的握手串压小。同一台机器的多个 host 候选是"等价备选"，
   * 局域网下只留 1~2 个完全够用；但必须保证至少留下 1 个，否则原样返回。
   *
   * @param {string} sdp
   * @param {number} maxPerType  每类最多保留几个（默认 2）
   * @returns {{sdp:string, dropped:number, degraded:boolean, reason:string|null}}
   */
  function trimCandidates(sdp, maxPerType) {
    var original = String(sdp);
    var limit = maxPerType || 2;
    try {
      var lines = original.split(/\r?\n/);
      var groups = {};        // type -> [{line, priority, idx}]
      var candCount = 0;
      for (var i = 0; i < lines.length; i++) {
        var m = /^a=candidate:(\S+)\s+\d+\s+(\S+)\s+(\d+)\s+(\S+)\s+(\d+)\s+typ\s+(\S+)/i.exec(lines[i]);
        if (!m) continue;
        candCount++;
        var type = (m[6] || 'host').toLowerCase();
        (groups[type] = groups[type] || []).push({ line: lines[i], priority: +m[3], idx: i });
      }
      if (candCount === 0) {
        return { sdp: original, dropped: 0, degraded: true, reason: '没有任何候选' };
      }
      var keepIdx = {};
      var dropped = 0;
      Object.keys(groups).forEach(function (type) {
        var arr = groups[type].sort(function (a, b) { return b.priority - a.priority; });
        for (var k = 0; k < arr.length; k++) {
          if (k < limit) keepIdx[arr[k].idx] = true;
          else dropped++;
        }
      });
      if (dropped === 0) return { sdp: original, dropped: 0, degraded: false, reason: null };

      var out = [];
      var keptCandidates = 0;
      for (var j = 0; j < lines.length; j++) {
        if (!/^a=candidate:/i.test(lines[j])) { out.push(lines[j]); continue; }
        if (keepIdx[j]) { out.push(lines[j]); keptCandidates++; }
      }
      if (keptCandidates === 0) {
        return { sdp: original, dropped: 0, degraded: true, reason: '瘦身后候选为空' };
      }
      var joined = out.join('\r\n');
      // 必需字段校验（和 mungeSdp 一样，宁可回退也不能交出坏 SDP）
      for (var r = 0; r < REQUIRED_TOKENS.length; r++) {
        if (joined.indexOf(REQUIRED_TOKENS[r]) < 0) {
          return { sdp: original, dropped: 0, degraded: true, reason: '瘦身后缺少必需字段: ' + REQUIRED_TOKENS[r] };
        }
      }
      if (countMLines(joined) !== countMLines(original)) {
        return { sdp: original, dropped: 0, degraded: true, reason: '瘦身后 m-line 数量变化' };
      }
      return { sdp: joined, dropped: dropped, degraded: false, reason: null };
    } catch (e) {
      return { sdp: original, dropped: 0, degraded: true, reason: '瘦身异常: ' + e.message };
    }
  }

  /* ------------------------------------------------------------ 工具与容量 */

  var QR_MAX_BYTES_L = 2953;   // 版本40 + 纠错等级L 的字节模式上限

  /** 估算二维码是否放得下 */
  function qrFit(text) {
    var bytes = utf8Encode(String(text)).length;
    var hint;
    if (bytes <= 1200) hint = '轻松识别';
    else if (bytes <= 2000) hint = '正常，屏幕调亮即可';
    else if (bytes <= QR_MAX_BYTES_L) hint = '接近上限，建议手机靠近/放大二维码';
    else hint = '超出单张二维码容量，需要分片（本程序会提示）';
    return { bytes: bytes, chars: String(text).length, maxBytesL: QR_MAX_BYTES_L, fits: bytes <= QR_MAX_BYTES_L, hint: hint };
  }

  function safeStringify(obj) {
    try {
      return JSON.stringify(obj);
    } catch (e) {
      return null;
    }
  }

  function safeParse(str) {
    try {
      return JSON.parse(str);
    } catch (e) {
      return null;
    }
  }

  return {
    VERSION: VERSION,
    PREFIX: PREFIX,
    REQUIRED_TOKENS: REQUIRED_TOKENS,
    CHUNK_THRESHOLD: CHUNK_THRESHOLD,
    CHUNK_MAX_UNITS: CHUNK_MAX_UNITS,
    QR_MAX_BYTES_L: QR_MAX_BYTES_L,

    utf8Encode: utf8Encode,
    utf8Decode: utf8Decode,
    bytesToB64Url: bytesToB64Url,
    b64UrlToBytes: b64UrlToBytes,
    fnv1a32: fnv1a32,

    packSdp: packSdp,
    unpackSdp: unpackSdp,

    mungeSdp: mungeSdp,
    trimCandidates: trimCandidates,
    countMLines: countMLines,

    ipKind: ipKind,
    analyzeCandidates: analyzeCandidates,

    splitStringSafely: splitStringSafely,
    makeChunks: makeChunks,
    ChunkReassembler: ChunkReassembler,

    classifyMessage: classifyMessage,
    FAST_TYPES: FAST_TYPES,

    qrFit: qrFit,
    safeStringify: safeStringify,
    safeParse: safeParse
  };
});
