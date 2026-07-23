// 北京时间（东八区 UTC+8）日期工具
// 微信小程序内 new Date().toISOString() 返回的是 UTC 时间，
// 直接用会导致"每日"界限偏移（+8 小时），故统一用本文件换算。

function getBeijingDateStr() {
  const now = new Date();
  // 本地时间 → UTC 毫秒
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
  // UTC 毫秒 + 8 小时 = 北京时间墙钟
  const beijing = new Date(utcMs + 8 * 3600000);
  return beijing.toISOString().slice(0, 10); // YYYY-MM-DD（北京时间）
}

module.exports = { getBeijingDateStr };
