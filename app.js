// app.js
App({
  onLaunch() {
    // 初始化云开发
    if (!wx.cloud) {
      console.error('请使用 2.2.3 或以上的基础库以使用云能力')
    } else {
      wx.cloud.init({
        env: 'cloud1-d5gu979b4065ca21a', // ← 替换成你的云开发环境ID（云开发控制台→设置→环境ID）
        traceUser: true
      })
    }
  },
  globalData: {}
})
