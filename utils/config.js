// 后台开关（热更新，无需提交小程序版本）
// 后台位置：微信云开发「数据库」集合 app_config，文档 _id=global
//   - testMode           : true=关闭每日抽签限制(测试态)；false=启用每日一次(正式)
//   - phoneLoginRequired : true=要求手机号登录(记忆标签云端同步)；false=关闭手机号登录(记忆仅存本地)
// 切换方式：云开发控制台改该文档字段值保存 → 下次小程序冷启动自动生效
// 默认值（首次 getConfig 自动写入）：testMode=false, phoneLoginRequired=false

const DEFAULTS = { testMode: false, phoneLoginRequired: false };

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
        phoneLoginRequired: typeof c.phoneLoginRequired === 'boolean' ? c.phoneLoginRequired : DEFAULTS.phoneLoginRequired
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
