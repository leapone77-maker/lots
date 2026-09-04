// app.js
const config = require('./utils/config.js')

App({
  onLaunch() {
    // 版本更新检查：新版本下载完成后弹窗提示重启应用
    this.checkUpdate()
    // 初始化云开发
    if (!wx.cloud) {
      console.error('请使用 2.2.3 或以上的基础库以使用云能力')
    } else {
      wx.cloud.init({
        env: 'cloud1-d5gu979b4065ca21a', // ← 替换成你的云开发环境ID（云开发控制台→设置→环境ID）
        traceUser: true
      })
    }
    // 预热后台开关（热更新，无需提交小程序版本）
    config.fetchConfig()
  },

  // 小程序更新机制（wx.getUpdateManager，基础库 >= 1.9.90）：
  // 冷启动时微信后台静默下载新版 → onUpdateReady 弹窗 → applyUpdate 强制重启生效
  checkUpdate() {
    if (!wx.getUpdateManager) return  // 低版本基础库不支持，忽略
    const updateManager = wx.getUpdateManager()

    updateManager.onUpdateReady(() => {
      // 强制更新：无取消按钮，点确定即重启；弹窗期间阻断用户操作
      wx.showModal({
        title: '更新提示',
        content: '新版本已准备好，请重启应用以继续使用',
        confirmText: '立即更新',
        showCancel: false,          // 不给取消选项
        success(res) {
          if (res.confirm) updateManager.applyUpdate()  // 强制重启应用新版本
        }
      })
    })

    updateManager.onUpdateFailed(() => {
      // 新版下载失败：静默处理，下次启动会重试
      console.warn('[update] 新版本下载失败')
    })
  },

  globalData: {
    // 收藏变更暂存（同会话内即时同步用）：{ date: {id, favorite} }
    // 详情页收藏/取消后写入，历史页 onShow 读取并叠加到 favs 上，避免云端异步延迟导致⭐不显示
    favChanges: {}
  }
})
