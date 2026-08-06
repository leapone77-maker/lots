// 北京时间（东八区 UTC+8）日期工具
// 微信小程序内 new Date().toISOString() 返回的是 UTC 时间，
// 直接用会导致"每日"界限偏移（+8 小时），故统一用本文件换算。

function getBeijingDateStr() {
  const now = new Date();
  // Date.now()/getTime() 是 UTC 毫秒数，直接 +8 小时即北京时间墙钟
  const beijing = new Date(now.getTime() + 8 * 3600000);
  const y = beijing.getUTCFullYear();
  const m = String(beijing.getUTCMonth() + 1).padStart(2, '0');
  const d = String(beijing.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

module.exports = { getBeijingDateStr };
