const fs = require('fs');
const path = require('path');
const { minify } = require('html-minifier-terser');

// 部署管线（listen 版）：内联 CSS → vendor Vue 内联为独立 <script>（原样嵌入，不经过 terser）
//   → 压缩其余 HTML/应用脚本 → 转义 → 注入 worker.js 的 htmlContent 标记
// 与 jev-decides 的差异：Vue 副本 vendor 在 src/vendor/，构建期内联（无运行时 CDN）。
// 用法：node src/deploy.js && npx wrangler deploy
//       node src/deploy.js --no-minify   # 开发调试：跳过压缩，产物可读

const noMinify = process.argv.includes('--no-minify');

// vendor 脚本在压缩阶段的占位文本（普通文本节点，压缩后原样保留），随后替换回脚本原文。
// 不能直接内联后再压缩——html-minifier 的 minifyJS 会把 vendor 也 terser 一遍（约定：不压 vendor）。
const VENDOR_PLACEHOLDER = '%%VUE_VENDOR%%';
const VENDOR_TAG_RE = /<script\s+src="vendor\/vue\.global\.prod\.js"><\/script>/;

console.log('🚀 开始部署...');

(async () => {
try {
  // 1. 读取 app.html 的全部内容
  const htmlPath = path.join(__dirname, 'app.html');
  console.log('📖 读取 HTML 文件:', htmlPath);

  if (!fs.existsSync(htmlPath)) {
    throw new Error('app.html 文件不存在');
  }

  const htmlContent = fs.readFileSync(htmlPath, 'utf-8');
  console.log('✅ HTML 文件读取成功，大小:', htmlContent.length, '字符');

  // 1.5. 内联 CSS 文件
  console.log('🎨 处理 CSS 内联...');
  let processedHtml = htmlContent;

  const cssLinkRegex = /<link\s+rel="stylesheet"\s+href="style\.css"\s*\/?>/i;

  if (cssLinkRegex.test(processedHtml)) {
    const cssPath = path.join(__dirname, 'style.css');
    console.log('📖 读取 CSS 文件:', cssPath);

    if (!fs.existsSync(cssPath)) {
      throw new Error('style.css 文件不存在');
    }

    const cssContent = fs.readFileSync(cssPath, 'utf-8');
    console.log('✅ CSS 文件读取成功，大小:', cssContent.length, '字符');

    // 函数形式替换：避免替换串中的 $ 被当特殊模式（同 1.8 注释）
    processedHtml = processedHtml.replace(
      cssLinkRegex,
      () => `<style>\n${cssContent}\n</style>`
    );
    console.log('✅ CSS 内联完成');
  } else {
    throw new Error('未找到 style.css 链接（app.html 必须引用它）');
  }

  // 1.6. vendor Vue：<script src> 标签 → 占位文本（压缩后换回脚本原文）
  console.log('📦 处理 vendor Vue 内联...');
  const vendorPath = path.join(__dirname, 'vendor', 'vue.global.prod.js');
  if (!VENDOR_TAG_RE.test(processedHtml)) {
    throw new Error('未找到 vendor Vue 脚本标签（app.html 必须在应用脚本前引用它）');
  }
  if (!fs.existsSync(vendorPath)) {
    throw new Error('src/vendor/vue.global.prod.js 不存在（见 CHECKLIST Phase 0 下载步骤）');
  }
  const vendorContent = fs.readFileSync(vendorPath, 'utf-8');
  if (vendorContent.length < 100000) {
    throw new Error(`vendor Vue 文件可疑（仅 ${vendorContent.length} 字符，约 16 万才是正常副本）`);
  }
  processedHtml = processedHtml.replace(VENDOR_TAG_RE, VENDOR_PLACEHOLDER);
  console.log(`✅ vendor Vue 读取成功（${vendorContent.length} 字符），压缩阶段用占位文本` );

  // 1.7. 压缩：HTML 空白/注释 + 内联 CSS + 应用 <script>；vendor 尚未内联，不受影响
  if (!noMinify) {
    console.log('🗜️  压缩 HTML/CSS/应用脚本...');
    const before = processedHtml.length;
    processedHtml = await minify(processedHtml, {
      collapseWhitespace: true, // 文本内空白折叠为单空格，标签间空白删除
      removeComments: true, // 删 HTML 注释
      minifyCSS: true, // <style> 内 CSS 压缩（clean-css）
      minifyJS: true, // 应用 <script> 用 terser 压缩（对象属性/顶层名不动，Vue Options API 安全）
      keepClosingSlash: true // 保持自闭合斜杠风格
    });
    const saved = before - processedHtml.length;
    console.log(
      `✅ 压缩完成：${before} → ${processedHtml.length} 字符（省 ${saved}，${Math.round((saved / before) * 100)}%）`
    );
  } else {
    console.log('ℹ️  --no-minify：跳过压缩（调试模式）');
  }

  // 1.8. 占位文本 → vendor 脚本原文（独立 <script> 块，data-src 标记来源）
  if (!processedHtml.includes(VENDOR_PLACEHOLDER)) {
    throw new Error('压缩后占位文本丢失（html-minifier 不应动普通文本节点）');
  }
  // ⚠️ 必须用函数形式替换：字符串替换形式会把 vendor 源码里的 $&、$$ 等当特殊模式解释，
  //    Vue 源码含上千个 $，会静默损坏脚本（曾在 Phase 0 调试中真实踩坑）。
  processedHtml = processedHtml.replace(
    VENDOR_PLACEHOLDER,
    () => `<script data-src="vendor/vue.global.prod.js">\n${vendorContent}\n</script>`
  );
  console.log('✅ vendor Vue 已内联为独立脚本块（未压缩）');

  // 2. 读取 worker.js 文件
  const workerPath = path.join(__dirname, '..', 'worker.js');
  console.log('📖 读取 worker.js 文件:', workerPath);

  if (!fs.existsSync(workerPath)) {
    throw new Error('worker.js 文件不存在');
  }

  const workerContent = fs.readFileSync(workerPath, 'utf-8');
  console.log('✅ worker.js 文件读取成功，大小:', workerContent.length, '字符');

  // 2.5. 转义 HTML 内容用于模板字符串（vendor 脚本里的 \ ` $ 一并转义）
  console.log('🔒 转义 HTML 内容用于模板字符串...');
  processedHtml = processedHtml
    .replace(/\\/g, '\\\\') // 先转义反斜杠
    .replace(/`/g, '\\`') // 转义反引号
    .replace(/\$/g, '\\$'); // 转义美元符号
  console.log('✅ HTML 内容转义完成');

  // 3. 使用正则替换 htmlContent 部分
  // 匹配模式：let htmlContent = `...任意内容...`; // htmlContent FINISHED
  const regex = /(let htmlContent = `)([\s\S]*?)(`; \/\/ htmlContent FINISHED)/;

  if (!regex.test(workerContent)) {
    throw new Error('在 worker.js 中未找到 htmlContent 标记');
  }

  console.log('🔄 替换 HTML 内容...');
  const newWorkerContent = workerContent.replace(
    regex,
    (match, prefix, oldContent, suffix) => {
      console.log(
        '💡 找到 htmlContent 标记，原内容长度:',
        oldContent.length,
        '字符'
      );
      return prefix + processedHtml + suffix;
    }
  );

  // 4. 写回 worker.js 文件
  console.log('💾 写入更新后的 worker.js...');
  fs.writeFileSync(workerPath, newWorkerContent, 'utf-8');

  console.log('✨ 部署完成！');
  console.log('📊 统计信息:');
  console.log('   - HTML 内容长度:', processedHtml.length, '字符');
  console.log('   - worker.js 总长度:', newWorkerContent.length, '字符');
  console.log('ℹ️  下一步: npx wrangler deploy（本地调试用 npx wrangler dev）');
} catch (error) {
  console.error('❌ 部署失败:', error.message);
  process.exit(1);
}
})();
