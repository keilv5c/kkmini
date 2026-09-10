/* ============================================================================
 * tools/make-vendor.js —— 把 npm 依赖打成"浏览器直接 <script> 引入"的本地文件
 * ----------------------------------------------------------------------------
 * 目的：App 打包后不依赖任何外网 CDN（需求文档第五节第 6 条）。
 * 产出（全部落在 web/vendor/）：
 *   qrcode.min.js       由 npm qrcode 的浏览器入口打包（IIFE，全局 QRCode）
 *   pako.min.js         直接拷贝 pako 的官方浏览器包（全局 pako）
 *   html5-qrcode.min.js 直接拷贝官方浏览器包（全局 Html5Qrcode / Html5QrcodeScanner）
 *
 * 运行：npm run vendor
 * ==========================================================================*/
'use strict';
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'web', 'vendor');
fs.mkdirSync(OUT, { recursive: true });

// qrcode 是个 CommonJS 包，浏览器入口是 lib/browser.js；这里临时生成一个入口再打包
const entry = path.join(ROOT, 'tools', '.qrcode-entry.js');
fs.writeFileSync(entry, "module.exports = require('qrcode/lib/browser.js');\n", 'utf8');

(async () => {
  const built = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    minify: true,
    format: 'iife',
    globalName: 'QRCode',
    platform: 'browser',
    target: ['es2018'],
    outfile: path.join(OUT, 'qrcode.min.js'),
    logLevel: 'warning'
  });
  fs.unlinkSync(entry);
  console.log('生成 qrcode.min.js     ', built.errors.length ? '有错误' : 'OK');

  const copies = [
    ['node_modules/pako/dist/pako.min.js', 'pako.min.js'],
    ['node_modules/html5-qrcode/html5-qrcode.min.js', 'html5-qrcode.min.js']
  ];
  for (const [from, to] of copies) {
    const src = path.join(ROOT, from);
    if (!fs.existsSync(src)) { console.error('缺少依赖文件: ' + from); process.exitCode = 1; continue; }
    fs.copyFileSync(src, path.join(OUT, to));
    console.log('拷贝 ' + to.padEnd(20), (fs.statSync(src).size / 1024).toFixed(0) + ' KB');
  }

  console.log('\nweb/vendor 内容：');
  for (const f of fs.readdirSync(OUT)) {
    console.log('  ' + f.padEnd(24) + (fs.statSync(path.join(OUT, f)).size / 1024).toFixed(0) + ' KB');
  }
})();
