// 校验 lib/panel.html 与 lib/ui/*.html 的内联脚本语法。
// 面板是单个大文件，改完一行 JS 也要能立刻知道有没有语法错。
// 用法：node scripts/check-panel.mjs
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const files = [join(root, 'lib/panel.html')];
for (const name of readdirSync(join(root, 'lib/ui'))) {
  if (name.endsWith('.html')) files.push(join(root, 'lib/ui', name));
}

let failed = 0;
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const scripts = [...text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)];
  scripts.forEach((match, index) => {
    const body = match[1];
    if (!body.trim()) return;
    try {
      // 只编译不执行：语法错会抛 SyntaxError。
      new Function(body);
    } catch (error) {
      failed += 1;
      console.error(`${file} script#${index}: ${error.message}`);
    }
  });
  console.log(`${file}: ${scripts.length} 个内联脚本`);
}

if (failed > 0) {
  console.error(`\n${failed} 个脚本有语法错误`);
  process.exit(1);
}
console.log('\n全部通过');
