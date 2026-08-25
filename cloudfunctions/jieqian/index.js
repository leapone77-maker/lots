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
 *        dailyLimit=每日可咨询次数上限(默认1；用完基础次数后分享成功会临时升为2，跨天重置回1); dialogCount=当日已用次数; dialogDate=计数对应日期(北京时间)，跨天重置
 *   - memories: { _id, uid, profile, updatedAt }
 *        uid=关联 users._id（唯一索引，每用户一条）
 *        profile = { permanent: "长期事实文本", recent: [{text, date}] }
 *        updatedAt = 最后更新时间戳(Date.now())
 *   - draws   : { _id, uid, account, date, sign, chats:[{role,content,t}], createdAt }
 *        签文独立表（users 只记账号信息），一人一天一条：
 *        uid=已登录为 users._id，未登录为设备游客ID(guest_xxx，前端 localStorage 持久)；
 *        date=抽签日期(YYYY-MM-DD)；sign=签号(0=仅聊天未抽签)；chats=当天聊天记录挂签文下；
 *        登录后前端调 mergeGuest 一次性把游客记录并入账号，同天冲突保留 createdAt 更早的整条；
 *        建议建 uid+date 组合索引。users 旧的 draws/chats 内嵌字段已废弃(2026-08-20 全量清空)
 *   - app_config (后台开关，手动创建一次): 文档 _id='global'
 *        { testMode: bool, localMode: bool }
 *        testMode=true 测试态(抽签无限次 + AI咨询无限次); false=正式(抽签每天1次, AI每天1次)
 *        localMode=true 纯本地模式(隐藏输入框/不登录/不连远程解读); false=完整功能(需登录才可用AI)
 *        说明：loginRequired / promoEnabled 已取消——登录门槛与首页引流卡片均由 localMode 派生
 *   - shares: { _id(shareId), signId, level, poemText, basic, yiji,
 *              chats:[{role,content}], uid, account, nickname, createdAt, expireAt }
 *        shareId=10位混淆短码(主键)，由 uid+signId 确定性生成，同一用户同一签文只存一份；
 *        expireAt=过期时间戳(7天=7*24h)，每次分享会刷新；getShareById 只读读取、不校验 token；另有定时触发器 cleanExpiredShares 每天物理删除过期记录
 */
const cloud = require('wx-server-sdk')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const users = db.collection('users')
const memories = db.collection('memories')
const shares = db.collection('shares')
const draws = db.collection('draws')

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

// 同一用户同一签文生成确定性 shareId，避免数据库出现重复分享记录
function getShareIdByUidSign(uid, signId) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'
  const hash = crypto.createHash('sha256').update(uid + ':' + String(signId)).digest()
  let s = ''
  for (let i = 0; i < 10; i++) s += chars[hash[i] % chars.length]
  return s
}

async function authByToken(token) {
  if (!token) return null
  const res = await users.where({ token }).get()
  if (res.data && res.data.length) return res.data[0]
  return null
}

// 定时清理：物理删除 shares 集合中 expireAt 已过期的分享快照（每日定时触发器触发）
async function cleanExpiredShares() {
  const _ = db.command
  const now = Date.now()
  const r = await shares.where({ expireAt: _.lt(now) }).remove()
  const removed = (r && r.stats) ? r.stats.removed : 0
  console.log('[cleanExpiredShares] removed=' + removed + ' before=' + new Date(now).toISOString())
  return { code: 0, removed: removed }
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
    await users.doc(caller._id).update({ data: { dialogCount: 0, dialogDate: today, dailyLimit: 1 } })
  }
  return { caller, used, limit, today, onDate }
}

/**
 * 读取后台开关配置（testMode / localMode），统一来源避免多处重复实现
 * 读取后台开关，文档不存在时返回默认值但**不自动写入**（避免覆盖用户手动设置）
 * 集合异常时安全回退默认值
 */
async function readConfig() {
  const DEFAULTS = { testMode: false, localMode: true }
  try {
    const col = db.collection('app_config')
    let doc = null
    try { doc = (await col.doc('global').get()).data } catch (e) { doc = null }
    if (!doc) {
      // 文档不存在 → 只返回默认值，不自动写入（由用户在云开发控制台手动配置）
      return { ...DEFAULTS }
    }
    return {
      testMode: typeof doc.testMode === 'boolean' ? doc.testMode : DEFAULTS.testMode,
      localMode: typeof doc.localMode === 'boolean' ? doc.localMode : DEFAULTS.localMode
    }
  } catch (e) {
    return { ...DEFAULTS }
  }
}

/**
 * 身份锁定常量 —— 每次发送前校验，prompt 必须包含此身份，不可偏离
 */
const EXPECTED_IDENTITY = '阿鹏'

/**
 * 单一来源：从 PROMPT.md 读取静态 System Prompt（身份 + 语气 + 格式要求）
 * 修改 PROMPT.md 后需重新「上传并部署」云函数方可生效
 */
let BASE_PROMPT = ''
try {
  BASE_PROMPT = fs.readFileSync(path.join(__dirname, 'PROMPT.md'), 'utf8').trim()
} catch (e) {
  // 兜底：PROMPT.md 缺失时仍保证身份正确，避免以错误身份作答
  BASE_PROMPT = '你是「阿鹏」，一位隐居山林、精通易经卦象与签文的世外高人。\n你说话半文半白、温和而恳切，善于从签诗中读出求签人当下的处境与转机。'
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
 * 构建 System Prompt —— 基础提示词(PROMPT.md) + 动态签文/画像
 */
function buildSystemPrompt(qian, profileText, question) {
  let p = BASE_PROMPT

  // 签文信息（动态注入）
  if (qian) {
    p += '\n\n【当前签文】'
    p += '\n签号：' + (qian.id || '?') + ' 等级：' + (qian.level || '?')
    const poemText = Array.isArray(qian.poem) ? qian.poem.join('，') : (qian.poem || '')
    p += '\n签诗：' + poemText
    if (qian.basic) {
      p += '\n\n基础解签：' + qian.basic
    }
  }

  // 用户画像（动态注入，替代旧的 memories 标签列表）
  if (profileText && profileText.length > 0) {
    p += '\n\n【求签人的个人背景】'
    p += '\n' + profileText
    p += '\n\n（以上是系统从该用户过往对话中自动提取的画像信息，解读时自然引用以拉近距离，像老朋友一样记得对方说过的话。切忌生硬罗列。）'
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
    max_tokens: 2000
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
          var replyText = ''
          // 兼容两种返回格式：OpenAI 标准格式 和 阿里云部分模型旧版 { finish_reason, text }
          if (json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content) {
            replyText = json.choices[0].message.content
          } else if (json && json.text) {
            replyText = json.text
          } else {
            reject(new Error('远程解读服务返回异常：' + data.slice(0, 200)))
            return
          }
          resolve(replyText)
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

/**
 * 健壮解析 AI 返回（模型偶发不守规矩：正文写一遍又把 JSON 贴后面）
 * 三段式提取 { answer, profile }：
 *   ① 全文本身就是纯 JSON → 直接 parse
 *   ② 从 ```代码围栏里提取（倒序尝试，围栏通常出现在尾部）
 *   ③ 花括号配对：定位 {"answer" 所在的最外层大括号
 * 三段全失败时兜底清洗：剥掉代码块/JSON 残余，用户永远看不到裸代码
 */
function _answerOk(o) {
  return o && typeof o === 'object' && typeof o.answer === 'string' && o.answer.length > 0
}

// 从指定下标的大括号起做配对扫描（识别字符串与转义），返回配平片段或 null
function _matchBraces(text, start) {
  var depth = 0, inStr = false, esc = false
  for (var i = start; i < text.length; i++) {
    var c = text[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
    } else {
      if (c === '"') inStr = true
      else if (c === '{') depth++
      else if (c === '}') {
        depth--
        if (depth === 0) return text.slice(start, i + 1)
      }
    }
  }
  return null
}

function _fallbackClean(text) {
  var t = String(text || '')
  t = t.replace(/```[\s\S]*?```/g, '')          // 成对代码块整体移除
  t = t.replace(/```[\s\S]*$/g, '')             // 未闭合的尾部代码块
  var idx = t.lastIndexOf('{"answer"')
  if (idx > 0) t = t.slice(0, idx)              // 尾部裸 JSON
  t = t.trim()
  return t || '抱歉，阿鹏这边一时没接上话，稍后再试试吧 🙏'
}

function extractJsonReply(raw) {
  var text = String(raw || '').trim()
  var obj = null

  // ① 全文是纯 JSON
  try {
    var o1 = JSON.parse(text)
    if (_answerOk(o1)) obj = o1
  } catch (e) {}

  // ② 代码围栏（倒序：模型"正文在前、JSON 在后"时取尾部围栏）
  if (!obj) {
    var fences = text.match(/```(?:json|JSON)?\s*[\s\S]*?```/g) || []
    for (var i = fences.length - 1; i >= 0; i--) {
      var body = fences[i].replace(/^```(?:json|JSON)?\s*/, '').replace(/```\s*$/, '')
      try {
        var o2 = JSON.parse(body.trim())
        if (_answerOk(o2)) { obj = o2; break }
      } catch (e) {}
    }
  }

  // ③ 花括号配对：从 "answer" 键向前找最近的 { 开始配平
  if (!obj) {
    var keyIdx = text.indexOf('"answer"')
    if (keyIdx !== -1) {
      var start = text.lastIndexOf('{', keyIdx)
      while (start >= 0 && !obj) {
        var snippet = _matchBraces(text, start)
        if (snippet) {
          try {
            var o3 = JSON.parse(snippet)
            if (_answerOk(o3)) obj = o3
          } catch (e) {}
        }
        start = start > 0 ? text.lastIndexOf('{', start - 1) : -1
      }
    }
  }

  if (obj) {
    console.log('[chat] AI返回JSON提取成功')
    return { answer: obj.answer, profile: Array.isArray(obj.profile) ? obj.profile : [] }
  }
  console.log('[chat] AI返回无法解析为JSON，走兜底清洗')
  return { answer: _fallbackClean(text), profile: [] }
}

exports.main = async function(event, context) {
  // 定时触发器（config.json 中的 timer）每天触发：物理删除 shares 中已过期的分享快照
  if (event && event.Type === 'timer') {
    return await cleanExpiredShares()
  }
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
        // 昵称选填：不填则自动生成"鹏友"+手机尾号后4位
        if (!nickname || nickname.length < 2 || nickname.length > 12) {
          nickname = '鹏友' + account.slice(-4)
        }
        var tk = genToken()
        console.log('[register] 开始新建用户 account=' + account + ' nickname=' + nickname)
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
        return { code: 0, token: tk, nickname: nickname }

      } else {
        // 已有账号，验证密码
        var user = list[0]
        if (user.password !== password) return { code: 1, msg: '密码错误' }
        // 复用已有 token（老账号无 token 字段时才新生成）
        var tk = user.token
        if (!tk) {
          tk = genToken()
          await users.doc(user._id).update({ data: { token: tk } })
        }
        // 昵称规则：有填新的则更新，没填则保留原有的
        if (nickname && nickname !== user.nickname) {
          await users.doc(user._id).update({ data: { nickname: nickname } })
        }
        var finalNick = nickname || user.nickname || ('鹏友' + account.slice(-4))
        return { code: 0, token: tk, nickname: finalNick }
      }
    }

    // ---- 保存/更新用户画像 ----
    // profile: [{ text: '2026年本命年', type: 'permanent' }, ...]
    // 合并到已有画像：permanent 追加去重，recent 追加并清理过期
    if (action === 'saveProfile') {
      var profileItems = event.profile
      if (!profileItems || !Array.isArray(profileItems) || profileItems.length === 0) {
        return { code: 0, saved: 0 }
      }
      var token = event.token
      var u = token ? await authByToken(token) : null
      if (!u) return { code: 401, msg: '请先登录' }
      var uid = u._id
      console.log('[saveProfile] uid=' + uid + ' items=' + JSON.stringify(profileItems).slice(0, 200))

      // 北京时间今日日期 YYYY-MM-DD
      function todayStr() {
        var d = new Date(Date.now() + 8 * 60 * 60 * 1000)
        return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0')
      }
      var today = todayStr()

      // 读取已有画像
      var existing = null
      var existRes = await memories.where({ uid: uid }).get()
      if (existRes.data && existRes.data.length > 0) {
        existing = existRes.data[0]
      }

      // 合并逻辑
      var permText = (existing && existing.profile && existing.profile.permanent) || ''
      var recentArr = (existing && existing.profile && Array.isArray(existing.profile.recent)) ? existing.profile.recent : []

      // 先清理过期 recent（>=30天删除）
      var now = Date.now()
      recentArr = recentArr.filter(function(item) {
        var itemDate = new Date(item.date + 'T00:00:00+08:00').getTime()
        return (now - itemDate) < 30 * 24 * 60 * 60 * 1000
      })

      profileItems.forEach(function(item) {
        if (!item.text) return
        if (item.type === 'permanent') {
          // 追加去重
          if (permText.indexOf(item.text) === -1) {
            permText = permText ? permText + '，' + item.text : item.text
          }
        } else {
          // recent：追加（同text不重复）
          var exists = recentArr.some(function(r) { return r.text === item.text })
          if (!exists) {
            recentArr.push({ text: item.text, date: today })
          }
        }
      })

      var newProfile = { permanent: permText, recent: recentArr }

      if (existing) {
        await memories.doc(existing._id).update({
          data: { profile: newProfile, updatedAt: now }
        })
      } else {
        await memories.add({
          data: { uid: uid, profile: newProfile, updatedAt: now }
        })
      }

      console.log('[saveProfile] 画像已更新 permanent=' + permText.slice(0, 60) + ' recent=' + recentArr.length)
      return { code: 0, saved: profileItems.length }
    }

    // ---- 读取用户画像（拼接为描述文本，含时间衰减）----
    if (action === 'getMemories') {
      var token = event.token
      var u = await authByToken(token)
      if (!u) return { code: 401, memories: [], profile: '' }
      var res = await memories.where({ uid: u._id }).get()
      if (!res.data || res.data.length === 0) {
        return { code: 0, memories: [], profile: '' }
      }
      var doc = res.data[0]
      var profile = doc.profile || {}
      var permText = profile.permanent || ''
      var recentArr = Array.isArray(profile.recent) ? profile.recent : []

      // 拼接画像文本：recent >=15天标"此前"，>=30天删除
      var now = Date.now()
      var recentTexts = []
      recentArr.forEach(function(item) {
        var itemDate = new Date(item.date + 'T00:00:00+08:00').getTime()
        var daysDiff = Math.floor((now - itemDate) / (24 * 60 * 60 * 1000))
        if (daysDiff >= 30) return  // 超过30天，不加入
        if (daysDiff >= 15) {
          recentTexts.push('此前' + item.text)  // 降权，标"此前"
        } else {
          recentTexts.push(item.text)
        }
      })

      var fullProfile = [permText].concat(recentTexts).filter(Boolean).join('；')
      return { code: 0, memories: [], profile: fullProfile }
    }

    // ---- 深度解读对话 ----
    if (action === 'chat') {
      var qian = event.currentQian || null       // 当前签文对象
      var profileText = event.profile || ''  // 前端传入的画像文本（从 getMemories 获取）
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
      var systemPrompt = buildSystemPrompt(qian, profileText, question)

      // 调用远程解读服务
      var reply = await callInterp(systemPrompt, question, history)

      // 调用成功，累加当日配额并算剩余次数（仅非测试态）
      if (!testMode) {
        var quota2 = await resolveQuota(callerToken)
        var newUsed = (quota2.onDate === quota2.today ? quota2.used : 0) + 1
        await users.doc(quota2.caller._id).update({ data: { dialogCount: newUsed, dialogDate: quota2.today } })
        remain = quota2.limit - newUsed
        console.log('[chat] 配额累加完成 account=' + caller.account + ' used=' + newUsed + '/' + quota2.limit + ' remain=' + remain)
      }

      // ---- 解析 AI 返回的 JSON，提取画像（三段式健壮提取 + 兜底清洗）----
      var extracted = extractJsonReply(reply)
      var answerText = extracted.answer
      var profileItems = extracted.profile.filter(function(item) {
        return item && item.text && (item.type === 'permanent' || item.type === 'recent')
      })

      // ---- 异步保存画像（不阻塞返回）----
      if (profileItems.length > 0 && caller && caller._id) {
        console.log('[chat] 提取到画像', profileItems.length, '条')
        ;(async function() {
          try {
            var existing = null
            var existRes = await memories.where({ uid: caller._id }).get()
            if (existRes.data && existRes.data.length > 0) existing = existRes.data[0]
            
            function todayStr() {
              var d = new Date(Date.now() + 8 * 60 * 60 * 1000)
              return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0')
            }
            var today = todayStr()
            var now2 = Date.now()
            
            var permText = (existing && existing.profile && existing.profile.permanent) || ''
            var recentArr = (existing && existing.profile && Array.isArray(existing.profile.recent)) ? existing.profile.recent : []
            
            // 清理过期 recent（>=30天删除）
            recentArr = recentArr.filter(function(item) {
              var itemDate = new Date(item.date + 'T00:00:00+08:00').getTime()
              return (now2 - itemDate) < 30 * 24 * 60 * 60 * 1000
            })
            
            profileItems.forEach(function(item) {
              if (item.type === 'permanent') {
                if (permText.indexOf(item.text) === -1) {
                  permText = permText ? permText + '，' + item.text : item.text
                }
              } else {
                var exists = recentArr.some(function(r) { return r.text === item.text })
                if (!exists) recentArr.push({ text: item.text, date: today })
              }
            })
            
            var newProfile = { permanent: permText, recent: recentArr }
            if (existing) {
              await memories.doc(existing._id).update({ data: { profile: newProfile, updatedAt: now2 } })
            } else {
              await memories.add({ data: { uid: caller._id, profile: newProfile, updatedAt: now2 } })
            }
            console.log('[chat] 画像已保存')
          } catch(saveErr) {
            console.error('[chat] 画像保存失败:', saveErr.message)
          }
        })()
      }

      // 返回给前端的是解签正文（不含 profile）
      if (!testMode) {
        return { code: 0, content: answerText, remain: remain, dailyLimit: quota2.limit }
      } else {
        console.log('[chat] 测试态，跳过配额统计')
        return { code: 0, content: answerText, remain: null, dailyLimit: null }
      }
    }



    // ---- 查询当日剩余咨询次数（前端进入页面时展示）----
    if (action === 'getQuota') {
      var cfgQ = await readConfig()
      // 纯本地模式 / 测试态：无配额概念，返回 null 让前端隐藏次数提示
      if (cfgQ.localMode !== false || cfgQ.testMode === true) {
        return { code: 0, remain: null, limit: null }
      }
      var q = await resolveQuota(event.token)
      if (!q) return { code: 401, remain: null, dailyLimit: null }
      return { code: 0, remain: q.limit - q.used, dailyLimit: q.limit }
    }

    // ---- 分享成功发放额外咨询次数（无新增字段，复用 dailyLimit）----
    // 规则：仅当今天上限仍是基础值(1) 且 基础次数已用完(used>=1) 才发奖，把 dailyLimit 临时升为 2
    // 用 where({_id, dailyLimit:1}) 条件更新，并发下也只 +1 次，避免快速重复点击刷次数
    if (action === 'grantShareBonus') {
      const caller = await authByToken(event.token)
      if (!caller) return { code: 401, msg: '未登录' }
      const q = await resolveQuota(event.token)  // 先确保跨天已重置（dailyLimit 回到 1）
      if (!q) return { code: 401, remain: null, dailyLimit: null }
      // 未到发奖条件：基础未用完 / 已领过奖励（dailyLimit 已为 2）
      if (q.limit !== 1 || q.used < 1) {
        return { code: 0, granted: false, remain: q.limit - q.used, dailyLimit: q.limit }
      }
      const _ = db.command
      const upd = await users.where({ _id: caller._id, dailyLimit: 1 }).update({ data: { dailyLimit: 2 } })
      const affected = (upd && upd.stats) ? upd.stats.updated : (upd ? upd.updated : 0)
      const q2 = await resolveQuota(event.token)
      return { code: 0, granted: affected > 0, remain: q2.limit - q2.used, dailyLimit: q2.limit }
    }

    // ---- 清空全部测试数据（users + memories）----
    if (action === 'clearAllData') {
      const _ = db.command
      await users.where({ _id: _.exists(true) }).remove()
      await memories.where({ _id: _.exists(true) }).remove()
      await draws.where({ _id: _.exists(true) }).remove()
      return { code: 0, msg: 'users、memories、draws 已清空' }
    }

    // ---- 读取后台开关（热更新，无需提交小程序版本）----
    // 集合 app_config 文档 _id='global'：{ testMode, localMode }
    // 首次调用自动写入默认值；集合未创建时安全回退默认值，不报错
    if (action === 'getConfig') {
      return { code: 0, config: await readConfig() }
    }

    // ---- 写入当日签号到 draws 集合（一天一条，upsert），供历史页跨设备展示 ----
    // 身份：已登录用 token 解析 uid；未登录用前端设备游客ID（guest_xxx），登录后由 mergeGuest 并入账号
    if (action === 'recordDraw') {
      const token = event.token || ''
      const date = event.date || ''          // 形如 "2026-07-31"
      const sign = event.sign                // 签号（数字）
      if (!date || !sign) return { code: 1, msg: '参数缺失' }
      let uid = '', account = ''
      if (token) {
        const caller = await authByToken(token)
        if (caller) { uid = caller._id; account = caller.account || '' }
      }
      if (!uid && event.guestId) { uid = event.guestId }
      if (!uid) return { code: 401, msg: '缺少身份' }
      const exist = await draws.where({ uid, date }).limit(1).get()
      if (exist.data && exist.data.length) {
        await draws.doc(exist.data[0]._id).update({ data: { sign } })
      } else {
        await draws.add({
          data: { uid, account, date, sign, chats: [], createdAt: Date.now() }
        })
      }
      console.log('[recordDraw] uid=' + uid + ' date=' + date + ' sign=' + sign)
      return { code: 0, ok: true }
    }

    // ---- 追加当日聊天记录到 draws 表当天记录的 chats 字段 ----
    if (action === 'recordChat') {
      const token = event.token || ''
      const date = event.date || ''
      const msgs = event.messages || []
      if (!date || !Array.isArray(msgs) || msgs.length === 0) return { code: 1, msg: '参数缺失' }
      let uid = '', account = ''
      if (token) {
        const caller = await authByToken(token)
        if (caller) { uid = caller._id; account = caller.account || '' }
      }
      if (!uid && event.guestId) { uid = event.guestId }
      if (!uid) return { code: 401, msg: '缺少身份' }
      const _ = db.command
      const exist = await draws.where({ uid, date }).limit(1).get()
      if (exist.data && exist.data.length) {
        await draws.doc(exist.data[0]._id).update({ data: { chats: _.push({ each: msgs }) } })
      } else {
        // 当天没抽过签：建一条只有聊天的记录（sign=0 表示仅聊天）
        await draws.add({
          data: { uid, account, date, sign: 0, chats: msgs, createdAt: Date.now() }
        })
      }
      console.log('[recordChat] uid=' + uid + ' date=' + date + ' count=' + msgs.length)
      return { code: 0, ok: true }
    }

    // ---- 登录成功后一次性把游客记录并入账号 ----
    // 同一天两边都有：保留 createdAt 更早的那条（整条保留，不做内容合并），另一条删除
    if (action === 'mergeGuest') {
      const token = event.token || ''
      const guestId = event.guestId || ''
      const caller = await authByToken(token)
      if (!caller) return { code: 401, msg: '请先登录' }
      if (!guestId) return { code: 0, merged: 0 }
      const gList = await draws.where({ uid: guestId }).limit(400).get()
      if (!gList.data || !gList.data.length) return { code: 0, merged: 0 }
      let merged = 0
      for (const g of gList.data) {
        const own = await draws.where({ uid: caller._id, date: g.date }).limit(1).get()
        if (!own.data || !own.data.length) {
          // 账号该天无记录：游客记录直接改挂到账号
          await draws.doc(g._id).update({ data: { uid: caller._id, account: caller.account || '' } })
        } else {
          // 同天冲突：保留更早的记录
          const o = own.data[0]
          const gTime = g.createdAt || 0
          const oTime = o.createdAt || 0
          if (gTime && oTime && gTime < oTime) {
            // 游客的更早 → 账号记录换成游客内容，删游客条
            await draws.doc(o._id).update({
              data: { sign: g.sign || o.sign, chats: g.chats || [], createdAt: gTime }
            })
          }
          // 账号的更早（或时间缺失）→ 保留账号，删游客条
          await draws.doc(g._id).remove()
        }
        merged++
      }
      console.log('[mergeGuest] account=' + caller.account + ' merged=' + merged)
      return { code: 0, merged }
    }

    // ---- 读取历史（签号 + 聊天），登录用户跨设备展示 ----
    // 从 draws 集合聚合，返回结构与旧版一致 { draws:{date:sign}, chats:{date:[...] } }，前端零改动
    if (action === 'getHistory') {
      const token = event.token || ''
      const caller = await authByToken(token)
      if (!caller) return { code: 401, draws: {}, chats: {} }
      const list = await draws.where({ uid: caller._id }).limit(400).get()
      const drawMap = {}
      const chatMap = {}
      ;(list.data || []).forEach(r => {
        if (r.sign) drawMap[r.date] = r.sign
        if (r.chats && r.chats.length) chatMap[r.date] = r.chats
      })
      return { code: 0, draws: drawMap, chats: chatMap }
    }

    // ---- 预计算 shareId（只读不写库；仅点击分享按钮时才真正写 shares）----
    if (action === 'getShareId') {
      const token = event.token || ''
      const caller = token ? await authByToken(token) : null
      if (!caller) return { code: 401, msg: '请先登录后再分享' }
      const signId = event.signId
      if (!signId) return { code: 1, msg: '缺少签号' }
      return { code: 0, shareId: getShareIdByUidSign(caller._id, signId) }
    }

    // ---- 生成只读分享快照（签运诗 + 聊天记录），7天(7*24h)过期 ----
    // 前端把当前展示的数据组装成 snapshot 传过来，云函数只做存储，不暴露用户 token
    // 同一用户同一签文用确定性 shareId，重复点击分享只更新同一条记录
    // 必须登录：仅已登录账号可创建分享（已移除匿名分享）
    if (action === 'createShare') {
      const token = event.token || ''
      const caller = token ? await authByToken(token) : null
      if (!caller) return { code: 401, msg: '请先登录后再分享' }
      const snap = event.snapshot || {}
      if (!snap.signId) return { code: 1, msg: '缺少签号' }

      // 同一用户同一签文使用确定性 shareId，避免重复分享记录
      const shareId = getShareIdByUidSign(caller._id, snap.signId)

      const now = Date.now()
      const doc = {
        signId: snap.signId,
        level: snap.level || '',
        poemText: snap.poemText || '',
        basic: snap.basic || null,
        yiji: snap.yiji || null,
        nickname: snap.nickname || '',
        chats: Array.isArray(snap.chats) ? snap.chats : [],
        uid: caller._id,
        account: caller.account,
        createdAt: now,
        expireAt: now + 7 * 24 * 60 * 60 * 1000   // 7天(7*24h)过期
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
