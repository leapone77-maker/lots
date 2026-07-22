# 云鹏解绪 · 微信原生小程序版 操作指南

> **这是原生微信小程序版本**（WXML/WXSS/JS，不是 uni-app），**不需要 HBuilderX、不需要任何编译步骤**。
> 直接拿「微信开发者工具」打开项目目录就能跑。

---

## 和第 10 次迭代（uni-app 版）的区别

| | uni-app 版 | 原生版（本版） |
|---|---|---|
| 打开方式 | 必须 HBuilderX 编译后才有 app.json | **微信开发者工具直接打开** |
| 需要装 HBuilderX | 是 | **否** |
| 需要 npm 编译 | 是（几百个包） | **否** |
| 代码文件 | .vue | .wxml / .wxss / .js / .json |

两个版本**功能完全一样**：抽签动画、AI 解签、手机号登录、长期记忆、微信云开发后端。

---

## 第 1 步：注册小程序，拿 AppID

1. 打开 **https://mp.weixin.qq.com** → 注册 → 选「小程序」
2. 登录后台 → 开发管理 → 开发设置 → 复制 **AppID**（形如 `wx1a2b3c4d5e6f`）
3. 打开本项目的 `project.config.json`，把 `"appid": "wxYOUR_APPID_HERE"` 改成你的真实 AppID
   > 也可以在微信开发者工具里导入项目时直接填，会自动写入。

---

## 第 2 步：用微信开发者工具打开项目

1. 打开 **微信开发者工具** → 「导入项目」
2. 目录选择：`D:\AI\wechat\jieqian-native`
3. AppID 填你的（或用测试号也行，但测试号不能开云开发）
4. 点「导入」

⚠️ **不会再报 `app.json 未找到` 了**——因为原生小程序天生就有 `app.json`。

---

## 第 3 步：开通云开发 + 填环境 ID

1. 微信开发者工具顶部点 **「云开发」** 按钮（云朵图标）
2. 按向导开通 → 选 **免费基础版** → 环境名 `jieqian-prod`
3. 开通后在「控制台 → 设置」里看到 **环境 ID**（形如 `jieqian-prod-xxxxx`）
4. 打开 `app.js`，把这行改成你的环境 ID：
   ```js
   env: 'jieqian-prod',  // ← 改成你的真实环境ID
   ```

---

## 第 4 步：创建数据库集合

云开发控制台 → 数据库 → 添加集合：

- `users`（字段自动创建，无需手填）：phone / password / token / nickname / created
- `memories`：uid / phone / event / cat / tag / created

两个集合权限都设为 **「仅创建者可读写」**。

---

## 第 5 步：上传部署云函数

1. 左侧文件树右键 `cloudfunctions/jieqian/`
2. 选 **「上传并部署：云端安装依赖（依赖上传）」**
   > `node_modules` 已经在文件夹里了（我帮你装好的），上传会直接带上。
3. 部署完成后，云开发控制台 → 云函数 里能看到 `jieqian`

### 设置智谱 API Key（环境变量）

1. 云开发控制台 → 云函数 → 点 `jieqian` → 编辑
2. 环境变量 → 添加：
   | 变量名 | 值 |
   |--------|-----|
   | `ZHIPU_KEY` | `dbc2baa0a8744885bc95d68315fd83fd.9R5ec8jBo73vFvt4` |
3. 保存（自动重新部署）

---

## 第 6 步：运行测试

1. 微信开发者工具顶部点 **「编译」**
2. 模拟器里应显示「云鹏解绪」首页
3. 测试流程：
   - 点签筒或「诚心求签」→ 摇签动画 → 显示签文
   - 点「请云鹏解读」→ 跳到解签页
   - 点登录提示条 → 弹登录框 → 手机号+密码（首次自动注册）
   - 输入问题 → 等 AI 返回古风解读
4. **真机预览**：点「预览」→ 手机微信扫码 → 真实环境验证「不挂 VPN」

---

## 常见问题

| 现象 | 原因 | 解决 |
|------|------|------|
| 编译报错 `xxx is not defined` | app.js 环境ID没填 | 第3步填真实环境ID |
| 登录报 `数据库权限不足` | 集合权限不对 | 第4步设为「仅创建者可读写」 |
| AI 解签返回错误 | 没设 ZHIPU_KEY 或Key失效 | 第5步设环境变量 |
| 云函数报 `wx-server-sdk 不存在` | 上传时没带 node_modules | 确认 `cloudfunctions/jieqian/node_modules` 存在再上传 |
| 提示需配置合法域名 | 云开发不需要 | 确认 `project.config.json` 里 `urlCheck:false` 已设 |

---

## 项目结构

```
jieqian-native/
├── app.js / app.json / app.wxss     ← 小程序入口+全局配置（tabBar：抽签/解签）
├── project.config.json              ← 改这里填 AppID
├── sitemap.json
│
├── pages/
│   ├── index/   (抽签页: 摇签动画+签结果)
│   └── chat/    (解签页: AI对话+记忆上下文)
│
├── components/
│   └── login-modal/   (手机号+密码登录弹窗, 自动注册)
│
├── utils/
│   ├── qianData.js   (666签数据库, CommonJS)
│   ├── cloud.js      (wx.cloud.callFunction 封装)
│   ├── user.js       (登录态)
│   └── memory.js     (记忆提取/存取)
│
└── cloudfunctions/
    └── jieqian/      (云函数: login/saveMemory/getMemories/chat)
        ├── index.js
        ├── package.json
        └── node_modules/   (wx-server-sdk 已装好)
```
