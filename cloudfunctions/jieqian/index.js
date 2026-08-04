/**
 * 阿鹏趣签 - 微信云函数（微信原生云开发）
 *
 * 部署方式：
 *   1. 本地修改 PROMPT.md 后，在微信开发者工具中，右键 cloudfunctions/jieqian → 上传并部署：云端安装依赖
 *   2. 在云开发控制台 → 云函数 → jieqian → 版本与配置 → 配置 → 环境变量 中设置：
 *        INTERP_KEY    （远程解读服务密钥，不内置明文）
 *        INTERP_API    （必填）解读服务接口地址
 *        INTERP_MODEL  （必填）所用模型名
 *     注：接口地址与模型名全部取自环境变量，代码中不内置任何供应商/模型关键词。
 *
 * 数据库集合（需在云开发控制台手动创建）：
 *   - users    : { _id, account, password, token, nickname, created, dailyLimit, dialogCount, dialogDate }
 *        dailyLimit=每日可咨询次数上限(免费会员默认1，付费会员后续设置N); dialogCount=当日已用次数; dialogDate=计数对应日期(北京时间)，跨天重置
 *   - memories: { _id, uid, account, tag, created }
 *        uid=关联 users._id；account=冗余存一份便于人工排查(非查询键)；tag=合并标签(分类+文本, 如"[life]2026年本命年")；created=北京时间字符串(如"2026-07-31 10:19:27")
 *   - app_config (后台开关，手动创建一次): 文档 _id='global'
 *        { testMode: bool, localMode: bool }
 *        testMode=true 测试态(抽签无限次 + AI咨询无限次); false=正式(抽签每天1次, AI每天1次)
 *        localMode=true 纯本地模式(隐藏输入框/不登录/不连远程解读); false=完整功能(需登录才可用AI)
 *        说明：loginRequired / promoEnabled 已取消——登录门槛与首页引流卡片均由 localMode 派生
 *   - shares: { _id(shareId), signId, level, poemText, basic:{career,love,wealth,health},
 *              chats:[{role,content}], uid, account, createdAt, expireAt }
 *        shareId=10位混淆短码(主键)；expireAt=过期时间戳(24h)；getShareById 只读读取、不校验 token
 */
const cloud = require('wx-server-sdk')
const fs = require('fs')
const path = require('path')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const users = db.collection('users')
const memories = db.collection('memories')
const shares = db.collection('shares')

// 远程解读服务密钥（在云开发控制台以环境变量 INTERP_KEY 配置，不内置明文，不在代码中体现供应商名）
const INTERP_KEY = process.env.INTERP_KEY || ''

function genToken() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
}

// 生成 10 位混淆短码（大小写+数字，足够 62^10 ≈ 8e17 种组合，冲突概率极低）
function genShareId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'
  let s = ''
  for (let i = 0; i < 10; i++) s += chars[Math.floor(Math.random() * chars.length)]
  return s
}

async function authByToken(token) {
  if (!token) return null
  const res = await users.where({ token }).get()
  if (res.data && res.data.length) return res.data[0]
  return null
}

// 北京时间日期字符串（用于每日配额按北京 0 点重置）
function beijingDateStr() {
  const bj = new Date(Date.now() + 8 * 60 * 60 * 1000)
  const y = bj.getUTCFullYear()
  const m = String(bj.getUTCMonth() + 1).padStart(2, '0')
  const d = String(bj.getUTCDate()).padStart(2, '0')
  return y + '-' + m + '-' + d
}

// 解析当日配额：按登录账号取记录，跨天自动重置；无登录账号返回 null
// 返回 { caller, used, limit, today, onDate }
async function resolveQuota(token) {
  if (!token) return null
  const caller = await authByToken(token)
  if (!caller) return null
  const today = beijingDateStr()
  let used = caller.dialogCount || 0
  let onDate = caller.dialogDate || ''
  const limit = (typeof caller.dailyLimit === 'number' && caller.dailyLimit > 0) ? caller.dailyLimit : 1
  if (onDate !== today) {
    used = 0
    onDate = today
    await users.doc(caller._id).update({ data: { dialogCount: 0, dialogDate: today } })
  }
  return { caller, used, limit, today, onDate }
}

/**
 * 读取后台开关配置（testMode / localMode），统一来源避免多处重复实现
 * 首次读取时若文档不存在则写入默认值，集合异常时安全回退默认值
 */
async function readConfig() {
  const DEFAULTS = { testMode: false, localMode: true }
  try {
    const col = db.collection('app_config')
    let doc = null
    try { doc = (await col.doc('global').get()).data } catch (e) { doc = null }
    if (!doc) {
      try {
        await col.add({ data: { _id: 'global', testMode: false, localMode: true, updatedAt: new Date() } })
      } catch (e) { /* 集合不存在等，忽略，回退默认 */ }
      return DEFAULTS
    }
    return {
      testMode: typeof doc.testMode === 'boolean' ? doc.testMode : DEFAULTS.testMode,
      localMode: typeof doc.localMode === 'boolean' ? doc.localMode : DEFAULTS.localMode
    }
  } catch (e) {
    return DEFAULTS
  }
}

/**
 * 身份锁定常量 —— 每次发送前校验，prompt 必须包含此身份，不可偏离
 */
const EXPECTED_IDENTITY = '解签大师'

/**
 * 单一来源：从 PROMPT.md 读取静态 System Prompt（身份 + 语气 + 格式要求）
 * 修改 PROMPT.md 后需重新「上传并部署」云函数方可生效
 */
let BASE_PROMPT = ''
try {
  BASE_PROMPT = fs.readFileSync(path.join(__dirname, 'PROMPT.md'), 'utf8').trim()
} catch (e) {
  // 兜底：PROMPT.md 缺失时仍保证身份正确，避免以错误身份作答
  BASE_PROMPT = '你是「解签大师」，一位隐居山林、精通易经卦象与签文的世外高人。\n你说话半文半白、温和而恳切，善于从签诗中读出求签人当下的处境与转机。'
}

/**
 * 身份校对：最终 prompt 必须包含 EXPECTED_IDENTITY，否则拦截发送
 */
function verifyIdentity(prompt) {
  if (!prompt || !prompt.includes(EXPECTED_IDENTITY)) {
    throw new Error('身份校验失败：System Prompt 未包含「' + EXPECTED_IDENTITY + '」，已阻止发送，避免以错误身份对外作答。')
  }
}

/**
 * 构建 System Prompt —— 基础提示词(PROMPT.md) + 动态签文/记忆
 */
function buildSystemPrompt(qian, memList, question) {
  let p = BASE_PROMPT

  // 签文信息（动态注入）
  if (qian) {
    p += '\n\n【当前签文】'
    p += '\n签号：' + (qian.id || '?') + '　等级：' + (qian.level || '?')
    const poemText = Array.isArray(qian.poem) ? qian.poem.join('，') : (qian.poem || '')
    p += '\n签诗：' + poemText
    if (qian.basic) {
      p += '\n\n基础解签：'
      p += '\n事业：' + (qian.basic.career || '')
      p += '\n感情：' + (qian.basic.love || '')
      p += '\n财运：' + (qian.basic.wealth || '')
      p += '\n健康：' + (qian.basic.health || '')
    }
  }

  // 用户记忆（核心卖点，动态注入）
  if (memList && memList.length > 0) {
    p += '\n\n【求签人的个人背景（长期记忆）】'
    p += '\n以下是该用户过往透露的重要人生事件/状态，这是你的"独家信息"。解读时必须自然地引用这些信息来拉近距离——就像老朋友一样记得对方说过的话。'
    p += '\n引用方式示例："刚好应了你本命年的转机""之前情感里的失意都是在为对的人清场""结合你最近提到的升职压力"...'
    p += '\n切忌不要生硬罗列记忆列表，而是将相关记忆有机织入解读正文的开头或对应段落。'
    memList.forEach(function(m) { p += '\n- ' + String(m) })
  }

  // 身份校验：每次发送前校对，不能偏离
  verifyIdentity(p)

  return p
}

/**
 * 调用远程解读服务
 */
async function callInterp(systemContent, userQuestion, chatHistory) {
  const https = require('https')
  // 接口地址与模型均取自云函数环境变量，不在代码中内置任何供应商/模型名
  const apiUrl = process.env.INTERP_API
  const apiModel = process.env.INTERP_MODEL
  if (!apiUrl) throw new Error('未配置解读服务地址：请在云函数环境变量中设置 INTERP_API')
  if (!apiModel) throw new Error('未配置解读模型名：请在云函数环境变量中设置 INTERP_MODEL')
  const url = new URL(apiUrl)

  // 构建消息数组：system + 历史对话(如果有) + 当前问题
  const msgs = [
    { role: 'system', content: systemContent }
  ]

  // 追加最近的聊天历史（保持上下文连贯）
  if (Array.isArray(chatHistory)) {
    chatHistory.forEach(function(m) {
      msgs.push({ role: m.role || 'user', content: m.content || '' })
    })
  }

  // 追加当前问题
  msgs.push({ role: 'user', content: userQuestion })

  const body = JSON.stringify({
    model: apiModel,
    messages: msgs,
    temperature: 0.7,
    max_tokens: 1000
  })

  return new Promise(function(resolve, reject) {
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + INTERP_KEY,
        'Content-Length': Buffer.byteLength(body)
      }
    }, function(res) {
      let data = ''
      res.on('data', function(chunk) { data += chunk })
      res.on('end', function() {
        try {
          var json = JSON.parse(data)
          if (!json || !json.choices || !json.choices[0]) {
            reject(new Error('远程解读服务返回异常：' + data.slice(0, 200)))
            return
          }
          resolve(json.choices[0].message.content)
        } catch(e) {
          reject(new Error('远程解读服务响应解析失败：' + data.slice(0, 200)))
        }
      })
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

exports.main = async function(event, context) {
  var action = event.action

  try {
    // ---- 注册 / 登录（账号+密码，自动注册）----
    if (action === 'register') {
      var account = event.account
      var password = event.password
      var nickname = (event.nickname || '').trim()
      if (!account || !/^1\d{10}$/.test(account)) return { code: 1, msg: '账号格式不正确' }
      if (!password) return { code: 1, msg: '请输入密码' }

      var res = await users.where({ account }).get()
      var list = res.data || []

      if (list.length === 0) {
        // 自动注册（直接返回生成的 token，不再二次查询）
        if (!nickname || nickname.length < 2 || nickname.length > 12) {
          return { code: 1, msg: '请输入 2-12 个字符的昵称' }
        }
        var tk = genToken()
        console.log('[register] 开始新建用户 account=' + account)
        try {
          const addRes = await users.add({
            data: {
              account: account,
              password: password,
              token: tk,
              nickname: nickname,
              created: Date.now(),
              dailyLimit: 1,   // 每日可咨询次数上限（未来按会员身份设置不同值，免费=1）
              dialogCount: 0,  // 当日已咨询次数
              dialogDate: ''   // 当日计数对应的日期（北京时间），跨天重置
            }
          })
          console.log('[register] 新建用户成功 _id=' + (addRes && addRes._id) + ' account=' + account + ' token=' + tk.slice(0, 8) + '...')
        } catch (addErr) {
          console.error('[register] 写入数据库失败:', addErr.message || addErr)
          return { code: 500, msg: '注册失败，请稍后重试' }
        }
        return { code: 0, token: tk }

      } else {
        // 已有账号，验证密码
        var user = list[0]
        if (user.password !== password) return { code: 1, msg: '密码错误' }
        // 刷新 token 并直接返回新 token
        var newTk = genToken()
        await users.doc(user._id).update({ data: { token: newTk } })
        return { code: 0, token: newTk }
      }
    }

    // ---- 保存记忆（批量）----
    // items: [{ tag: '2026年本命年', cat: 'life' }, ...]
    // cat 与 tag 合并为单一字段 tag = "[life]2026年本命年" 存储（不再单独存 cat）
    // 每条提取结果独立存一条记录；相同 tag 不重复写入（滤重）
    if (action === 'saveMemory') {
      var items = event.items
      if (!items || !Array.isArray(items) || items.length === 0) return { code: 1, msg: '记忆内容为空' }
      console.log('[saveMemory] 收到保存请求 items=' + JSON.stringify(items).slice(0, 120) + ' token=' + (event.token || '').slice(0, 8))
      var u = null
      var token = event.token
      if (token) u = await authByToken(token)
      console.log('[saveMemory] 查询用户结果 uid=' + (u ? u._id : 'null') + ' account=' + (u ? u.account : 'anonymous'))

      // 格式化北京时间（UTC+8）：2026-07-31 10:19:27
      // 云函数服务器运行在 UTC 时区，必须手动 +8h 偏移
      function fmtBeijingDate() {
        var d = new Date(Date.now() + 8 * 60 * 60 * 1000)
        var pad = function(n) { return n < 10 ? '0' + n : '' + n }
        return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()) +
          ' ' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds())
      }

      var saved = 0
      for (var i = 0; i < items.length; i++) {
        var it = items[i]
        var rawTag = (it.tag || '').trim()
        if (!rawTag) continue
        // cat + tag 合并为单一存储值，如 "[life]2026年本命年"
        var combinedTag = '[' + (it.cat || '其他').trim() + ']' + rawTag
        // 滤重：同一用户+同一tag 不重复存（避免多次聊天重复记录"本命年"等）
        var dup = await memories.where({ uid: u ? u._id : '', tag: combinedTag }).count()
        if (dup.total > 0) { console.log('[saveMemory] 跳过重复 tag=' + combinedTag); continue }
        await memories.add({
          data: {
            uid: u ? u._id : '',
            account: u ? u.account : '',
            tag: combinedTag,
            created: fmtBeijingDate()
          }
        })
        saved++
      }
      console.log('[saveMemory] 新增 ' + saved + ' 条记忆')
      return { code: 0, saved: saved }
    }

    // ---- 读取记忆 ----
    if (action === 'getMemories') {
      var token = event.token
      var u = await authByToken(token)
      if (!u) return { code: 401, memories: [] }
      var res = await memories
        .where({ uid: u._id })
        .orderBy('created', 'desc')
        .limit(50)
        .get()
      // 返回格式：memories 数组（每项取 tag 字段）
      var list = (res.data || []).map(function(m) { return m.tag || '' }).filter(Boolean)
      return { code: 0, memories: list }
    }

    // ---- 深度解读对话 ----
    if (action === 'chat') {
      var qian = event.currentQian || null       // 当前签文对象
      var memList = Array.isArray(event.memories) ? event.memories : (event.memories ? [event.memories] : [])
      var question = event.question || event.message || ''
      var history = event.messages || []         // 聊天历史

      if (!question) return { code: 1, content: '请输入你的问题' }

      // ---- 读取后台开关 ----
      var cfg = await readConfig()
      var localMode = cfg.localMode !== false   // 默认纯本地
      var testMode = cfg.testMode === true

      // 纯本地模式：输入框隐藏，理论上不会调用到这里，保险拦截
      if (localMode) {
        return { code: 403, content: '本地模式不支持在线咨询' }
      }

      // 完整功能模式：必须有效登录态（localMode=false 才需登录）
      var callerToken = event.token || ''
      var caller = await authByToken(callerToken)
      if (!caller) {
        console.error('[chat] 完整功能模式但无有效登录态，token=' + (callerToken ? callerToken.slice(0, 8) + '...' : '(空)'))
        return { code: 401, content: '请先登录后再咨询，或退出小程序重新登录 🙏' }
      }

      // ---- 每日配额校验（按登录账号，北京时间 0 点重置）----
      // testMode=true 时为测试态：跳过配额限制，AI 咨询无限次
      var remain = null
      if (!testMode) {
        var quota = await resolveQuota(callerToken)
        if (quota.used >= quota.limit) {
          return { code: 429, content: '今日咨询次数已用完，明天再来找阿鹏聊聊吧 🙏' }
        }
      }

      // 构建带记忆的 system prompt
      var systemPrompt = buildSystemPrompt(qian, memList, question)

      // 调用远程解读服务
      var reply = await callInterp(systemPrompt, question, history)

      // 调用成功，累加当日配额并算剩余次数（仅非测试态）
      if (!testMode) {
        var quota2 = await resolveQuota(callerToken)
        var newUsed = (quota2.onDate === quota2.today ? quota2.used : 0) + 1
        await users.doc(quota2.caller._id).update({ data: { dialogCount: newUsed, dialogDate: quota2.today } })
        remain = quota2.limit - newUsed
        console.log('[chat] 配额累加完成 account=' + caller.account + ' used=' + newUsed + '/' + quota2.limit + ' remain=' + remain)
      } else {
        console.log('[chat] 测试态，跳过配额统计')
      }

      return { code: 0, content: reply, remain: remain }
    }

    // ---- 查询当日剩余咨询次数（前端进入页面时展示）----
    if (action === 'getQuota') {
      var cfgQ = await readConfig()
      // 纯本地模式 / 测试态：无配额概念，返回 null 让前端隐藏次数提示
      if (cfgQ.localMode !== false || cfgQ.testMode === true) {
        return { code: 0, remain: null, limit: null }
      }
      var q = await resolveQuota(event.token)
      if (!q) return { code: 401, remain: null, limit: null }
      return { code: 0, remain: q.limit - q.used, limit: q.limit }
    }

    // ---- 清空全部测试数据（users + memories）----
    if (action === 'clearAllData') {
      const _ = db.command
      await users.where({ _id: _.exists(true) }).remove()
      await memories.where({ _id: _.exists(true) }).remove()
      return { code: 0, msg: 'users 与 memories 已清空' }
    }

    // ---- 读取后台开关（热更新，无需提交小程序版本）----
    // 集合 app_config 文档 _id='global'：{ testMode, localMode }
    // 首次调用自动写入默认值；集合未创建时安全回退默认值，不报错
    if (action === 'getConfig') {
      return { code: 0, config: await readConfig() }
    }

    // ---- 写入当日签号到 users.draws[date]，供历史页跨设备展示 ----
    // draws 结构：{ "2026-07-31": 657, ... }，value=签号(1-888)，无 key 或 0 表示当天没抽
    if (action === 'recordDraw') {
      const token = event.token || ''
      const date = event.date || ''          // 形如 "2026-07-31"
      const sign = event.sign                // 签号（数字）
      if (!date || !sign) return { code: 1, msg: '参数缺失' }
      const caller = await authByToken(token)
      if (!caller) return { code: 401, msg: '请先登录' }
      await users.doc(caller._id).update({ data: { ['draws.' + date]: sign } })
      console.log('[recordDraw] account=' + caller.account + ' date=' + date + ' sign=' + sign)
      return { code: 0, ok: true }
    }

    // ---- 追加当日聊天记录到 users.chats[date]（数组 push，性能好）----
    // chats 结构：{ "2026-07-31": [ {role, content, t}, ... ] }
    if (action === 'recordChat') {
      const token = event.token || ''
      const date = event.date || ''
      const msgs = event.messages || []
      if (!date || !Array.isArray(msgs) || msgs.length === 0) return { code: 1, msg: '参数缺失' }
      const caller = await authByToken(token)
      if (!caller) return { code: 401, msg: '请先登录' }
      const _ = db.command
      await users.doc(caller._id).update({
        data: { ['chats.' + date]: _.push({ each: msgs }) }
      })
      console.log('[recordChat] account=' + caller.account + ' date=' + date + ' count=' + msgs.length)
      return { code: 0, ok: true }
    }

    // ---- 读取历史（签号 + 聊天），登录用户跨设备展示 ----
    if (action === 'getHistory') {
      const token = event.token || ''
      const caller = await authByToken(token)
      if (!caller) return { code: 401, draws: {}, chats: {} }
      return {
        code: 0,
        draws: (caller.draws) || {},
        chats: (caller.chats) || {}
      }
    }

    // ---- 生成只读分享快照（签运诗 + 聊天记录），24小时过期 ----
    // 前端把当前展示的数据组装成 snapshot 传过来，云函数只做存储，不暴露用户 token
    // 传 shareId 则更新该快照（同一会话只维护一个分享文档），否则新建
    // 必须登录：仅已登录账号可创建分享（已移除匿名分享）
    if (action === 'createShare') {
      const token = event.token || ''
      const caller = token ? await authByToken(token) : null
      if (!caller) return { code: 401, msg: '请先登录后再分享' }
      const snap = event.snapshot || {}
      if (!snap.signId) return { code: 1, msg: '缺少签号' }

      // 生成或复用 shareId
      let shareId = event.shareId || ''
      if (!shareId) shareId = genShareId()

      const now = Date.now()
      const doc = {
        signId: snap.signId,
        level: snap.level || '',
        poemText: snap.poemText || '',
        basic: snap.basic || null,
        nickname: snap.nickname || '',
        chats: Array.isArray(snap.chats) ? snap.chats : [],
        uid: caller._id,
        account: caller.account,
        createdAt: now,
        expireAt: now + 24 * 60 * 60 * 1000   // 24小时过期
      }
      await shares.doc(shareId).set({ data: doc })
      console.log('[createShare] shareId=' + shareId + ' chats=' + doc.chats.length + ' account=' + caller.account)
      return { code: 0, shareId: shareId }
    }

    // ---- 读取分享快照（只读，不校验 token，任何人可访问） ----
    if (action === 'getShareById') {
      const shareId = event.shareId || ''
      if (!shareId) return { code: 1, msg: '缺少shareId' }
      try {
        const res = await shares.doc(shareId).get()
        if (!res.data) return { code: 404, msg: '分享不存在' }
        if (res.data.expireAt && res.data.expireAt < Date.now()) return { code: 410, msg: '分享已过期' }
        return { code: 0, share: res.data }
      } catch (e) {
        if (e.errCode === -1 || (e.message && e.message.includes('not exist'))) return { code: 404, msg: '分享不存在' }
        return { code: 404, msg: '分享不存在' }
      }
    }

    return { code: 1, msg: '未知操作：' + action }
  } catch (e) {
    console.error('[jieqian] error:', e)
    return { code: 500, msg: e.message || '服务器错误', content: '网络不佳，请稍后再试' }
  }
}
