const fs = require('fs');
const src = fs.readFileSync('utils/qianData.js', 'utf8');
const match = src.match(/const QIAN_DB = (\[[\s\S]*?\n\]);/);
const data = eval('(' + match[1] + ')');
const qAll = data;

// 区间参数：node gen_preview.js [start] [end]，不传则全量
const startArg = process.argv[2] ? parseInt(process.argv[2], 10) : null;
const endArg = process.argv[3] ? parseInt(process.argv[3], 10) : null;
const qRange = qAll.filter(q => (startArg == null || q.id >= startArg) && (endArg == null || q.id <= endArg));
const rangeLabel = (startArg != null && endArg != null) ? `${startArg}-${endArg}` : `1-${qAll.length}`;
const outFile = (startArg != null && endArg != null) ? `preview_${startArg}_${endArg}.html` : `preview_1_${qAll.length}.html`;

const levelColor = (l) => {
  if (l === '上上签') return '#A8201A';
  if (l === '上签') return '#C9A961';
  if (l === '中签') return '#6B7280';
  return '#999';
};

let html = `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>签诗预览 (${rangeLabel})</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { background: #F5F0E6; font-family: -apple-system, BlinkMacSystemFont, sans-serif; padding: 20px; }
h1 { text-align: center; color: #A8201A; margin-bottom: 30px; font-size: 28px; }
.card { max-width: 500px; margin: 0 auto 30px; background: rgba(255,253,248,0.9); border-radius: 20px; padding: 28px; box-shadow: 0 4px 20px rgba(120,85,50,0.08); border: 1px solid rgba(201,169,97,0.22); }
.header { display: flex; align-items: center; gap: 14px; margin-bottom: 18px; }
.badge { padding: 6px 18px; color: #fff; font-size: 13px; font-weight: bold; border-radius: 8px; letter-spacing: 2px; }
.title { font-size: 16px; font-weight: bold; color: #333; }
.label { display: block; font-size: 13px; color: #A8201A; font-weight: bold; margin-bottom: 8px; }
.poem { font-size: 16px; color: #333; line-height: 1.9; letter-spacing: 2px; font-weight: bold; margin-bottom: 16px; font-family: KaiTi, STKaiti, serif; }
.divider { height: 1px; background: linear-gradient(90deg, transparent, rgba(201,169,97,0.3), transparent); margin: 16px 0; }
.basic { display: block; font-size: 14px; color: #555; line-height: 1.7; margin-bottom: 12px; }
.yiji-text { display: block; font-size: 14px; color: #555; line-height: 1.7; }
</style>
</head>
<body>
<h1>阿鹏趣签 · 签诗预览 (${rangeLabel})</h1>
`;

qRange.forEach(q => {
  const c = levelColor(q.level);
  html += `<div class="card">
  <div class="header">
    <span class="badge" style="background:${c}">${q.level}</span>
    <span class="title">第 ${q.id} 签 · ${q.level}</span>
  </div>
  <span class="label">【签诗】</span>
  <div class="poem">${q.poem.join('<br>')}</div>
  <div class="divider"></div>
  <span class="label">【解签】</span>
  <span class="basic">${q.basic}</span>
${q.yiji ? `<div class="divider"></div>
  <span class="label">【宜忌】</span>
  <span class="yiji-text">${q.yiji}</span>` : ''}
</div>

`;
});

html += '</body>\n</html>';
fs.writeFileSync(outFile, html, 'utf8');
console.log('Done: ' + outFile + ' (' + qRange.length + ' cards)');
