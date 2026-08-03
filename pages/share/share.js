const app = getApp()

Page({
  data: {
    loading: true,
    expired: false,
    notFound: false,
    share: null,
    chatMessages: []
  },

  onLoad(options) {
    const shareId = options.shareId
    if (!shareId) {
      this.setData({ loading: false, notFound: true })
      return
    }

    wx.cloud.callFunction({
      name: 'jieqian',
      data: {
        action: 'getShareById',
        shareId: shareId
      }
    }).then(res => {
      if (res.result && res.result.code === 0) {
        const share = res.result.share
        const chatMessages = (share.chats || []).map(m => ({
          role: m.role,
          content: m.role === 'user'
            ? `<div style="color:#4a3728;font-size:14px;line-height:1.6;">${this._escHtml(m.content)}</div>`
            : this._formatReply(m.content)
        }))

        this.setData({
          loading: false,
          share: share,
          chatMessages: chatMessages
        })
      } else if (res.result && res.result.code === 410) {
        this.setData({ loading: false, expired: true })
      } else {
        this.setData({ loading: false, notFound: true })
      }
    }).catch(err => {
      console.error('[share] 加载失败:', err)
      this.setData({ loading: false, notFound: true })
    })
  },

  _escHtml(str) {
    if (!str) return ''
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  },

  _formatReply(text) {
    if (!text) return ''
    var s = String(text)
      .replace(/^(?:【?解签大师?】?|【?阿鹏趣签?】?|【?解读?】?|【?解答?】?)[：:，,\s]*/i, '')
      .replace(/^(?:您好|你好|福主您好|福主你好)[，,。.\s]*/i, '')
      .replace(/<\/?(div|span|p|br|section|article|h[1-6]|ul|ol|li|blockquote|pre|code)\b[^>]*>/gi, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
    if (!s) return ''

    s = s.replace(/^[#\s]+/gm, '').replace(/^\s+|\s+$/gm, '')
    s = s.replace(/\*\*([^*]+?)\*\*:?/g, '<strong>$1</strong>')
    s = s.replace(/(?=\d+[\.\、\s]\*?(?:方面|建议|提醒|注意|运势|财运|感情|健康|事业|学业|解读|签意))/gi, '\n')
    s = s.replace(/(?=(?:此外|另外|同时|综上|总之|最后|需要注意的是|值得一提的是)\s*[，,：:])/g, '\n')
    s = this._boldKeywords(s)

    var lines = s.split('\n')
    var parts = []
    var hasSummaryDivider = false
    for (var i = 0; i < lines.length; i++) {
      var t = lines[i].trim()
      if (!t) continue

      if (/^<strong>[^<]*?<\/strong>\s*:?\s*$/.test(t)) {
        parts.push('<div style="color:#A8201A;font-weight:bold;font-size:15px;margin:18px 0 10px 0;padding-bottom:6px;border-bottom:1px solid rgba(168,32,26,0.12);">' + t + '</div>')
        continue
      }

      var numMatch = t.match(/^(\d+[\.\、])\s*((?:<strong>)?[^：:]+(?:<\/strong>)?)[：:]\s*(.*)$/)
      if (numMatch) {
        var numPrefix = numMatch[1] + ' ' + numMatch[2] + '：'
        var numBody = numMatch[3]
        parts.push('<div style="margin:12px 0 8px 0;line-height:1.85;font-size:13px;"><span style="color:#A8201A;font-weight:bold;font-size:14px;">' + numPrefix + '</span><span style="color:#444;">' + numBody + '</span></div>')
        continue
      }

      if (t.length <= 20 && t.indexOf('。') < 0 && t.indexOf('，') < 0 && !/^<strong>/.test(t)) {
        parts.push('<div style="color:#A8201A;font-weight:bold;font-size:15px;margin:18px 0 10px 0;padding-bottom:6px;border-bottom:1px solid rgba(168,32,26,0.12);">' + t + '</div>')
        continue
      }

      if (/^(?:总的来说|总而言之|综上所述|总之|综上|一言以蔽之)[，,：:]/.test(t)) {
        hasSummaryDivider = true
        parts.push('<div style="margin:18px 0 10px 0;border-top:1px solid rgba(168,32,26,0.15);"></div>')
        parts.push('<div style="color:#555;margin:5px 0;line-height:1.85;font-size:13px;">' + t + '</div>')
        continue
      }

      parts.push('<div style="color:#444;margin:5px 0;line-height:1.85;font-size:13px;">' + t + '</div>')
    }

    if (!hasSummaryDivider && parts.length > 0) {
      var lastIdx = parts.length - 1
      parts.splice(lastIdx, 0, '<div style="margin:18px 0 10px 0;border-top:1px solid rgba(168,32,26,0.15);"></div>')
    }

    return '<div style="padding:2px 0;">' + parts.join('') + '</div>'
  },

  _boldKeywords(text) {
    var s = text
    s = s.replace(/「([^」]+)」/g, '<strong>「$1」</strong>')
    s = s.replace(/"([^"]+)"/g, '<strong>"$1"</strong>')
    s = s.replace(/"([^"]+)"/g, '<strong>"$1"</strong>')
    var keyPatterns = [
      /(?:当前困境|潜在转机|时间预期|应对建议|核心提示|总体研判|转折点|突破口|关键节点)(?=[:：])/g,
      /(?:风梅初隐|月累已喜|水星自聚|凤星黎闲)/g,
      /(?:低谷蓄力|真心换真心|切忌猜疑|极度困顿|投资入出|量入为出|需自省|当速就医|早睡早起|身心自安)/g,
    ]
    for (var k = 0; k < keyPatterns.length; k++) {
      s = s.replace(keyPatterns[k], '<strong>$&</strong>')
    }
    return s
  },

  onShareAppMessage() {
    const share = this.data.share
    const title = share ? `阿鹏趣签·第${share.signId}签` : '阿鹏趣签'
    return {
      title: title,
      path: '/pages/share/share?shareId=' + (share ? share._id : ''),
      imageUrl: '/images/jieqian-logo-peng.png'
    }
  }
})
