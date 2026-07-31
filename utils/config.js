// 后台开关（热更新，无需提交小程序版本）
// 后台位置：微信云开发「数据库」集合 app_config，文档 _id=global
//   - testMode   : true=测试态(抽签无限次 + AI咨询无限次)；false=正式(抽签每天1次，AI每天1次)
//   - localMode  : true=纯本地模式(隐藏输入框/咨询入口，不登录)；false=完整功能(显示输入框，需登录)
// 说明：原 loginRequired / promoEnabled 已取消——
//   · 登录门槛由 localMode 派生：localMode=true 不登录，localMode=false 才需登录
//   · 首页引流卡片由 localMode 派生：localMode=false 显示二维码，localMode=true 显示提示文字
// 切换方式：云开发控制台改该文档字段值保存 → 下次小程序冷启动自动生效
// 默认值（首次 getConfig 自动写入）：testMode=false, localMode=true

const DEFAULTS = { testMode: false, localMode: true };

let _cache = null;

function getCachedConfig() {
  if (_cache) return _cache;
  try { _cache = wx.getStorageSync('appConfig') || null; } catch (e) { _cache = null; }
  return _cache || DEFAULTS;
}

function fetchConfig() {
  return new Promise(function (resolve) {
    wx.cloud.callFunction({
      name: 'jieqian',
      data: { action: 'getConfig' }
    }).then(function (res) {
      const c = (res && res.result && res.result.config) || {};
      const cfg = {
        testMode: typeof c.testMode === 'boolean' ? c.testMode : DEFAULTS.testMode,
        localMode: typeof c.localMode === 'boolean' ? c.localMode : DEFAULTS.localMode
      };
      _cache = cfg;
      try { wx.setStorageSync('appConfig', cfg); } catch (e) {}
      resolve(cfg);
    }).catch(function () {
      // 拉取失败（如未部署云函数/断网）→ 退回本地缓存或默认值，保证可用
      resolve(getCachedConfig());
    });
  });
}

module.exports = { getCachedConfig, fetchConfig, DEFAULTS };
