## 0.3.2 (未发布)

### 修复

- **回复被静默截断成前半段**:此前回复在桥层按 `replyLimitBytes`(默认 2000B)无条件按字节硬切,
  无任何提示——长报告常只到一半。现按通道各自协议上限处理:
  长连接(流式单帧上限 20480B)默认提到 **16000B**,回调模式固定按企微文本 **2000B** 截断;
  超长截断时文末附「…(内容过长已截断,完整版见 dsh 会话记录)」可见标记,不再静默丢尾。
- **长任务"处理完了但没回复出去"**:此前思考占位与最终答复共用一条流,15 分钟级的长任务里
  旧流易被服务端判过期/断线,收尾帧失败只记一行日志、整条丢失。现:
  - 占位流超过 5 分钟不再原位刷新,最终答复作为**独立新消息**发送,不依赖旧流;
  - 发送失败按 1s/3s/5s/10s 有限重试,断线期间待发回复在重连(connected)后自动补发;
  - 服务端明确拒绝当前流(errcode≠0)时切换独立新消息补发一次,仍失败才放弃并记错(带 errcode)。

## 0.3.1

### 修复

- **agent 无工具目录导致复杂问题答非所问**:此前插件用 `agents.create` 创建会话时未挂载 agent 预设,
  agent 只有默认 persona、没有任何工具。模型面对需要查目录/跑命令的问题时,只能把工具调用
  写成 `<tool_calls>` 文本,会话即告完成,机器人把这段文本原样回复给用户。
  现与 web 会话一致:解析部署默认预设(code)并写入 `meta.agentPreset` + `setup: presets.mount`,
  agent 获得完整工具目录(The available tools + run_code),系统提示词由 1771 字符增至 36k+。
  进程内实测:挂载后 tools 参数含 run_code,与 web 会话行为一致。

# 更新日志

## 0.3.0 (未发布)

### 新增

- **界面配置**:安装后在 dsh「设置 → 插件 → 插件配置」出现「企业微信机器人」卡片,可可视化配置
  botId/botSecret、从 dsh 已配置的模型中选择 provider/model、设置 AI 会话工作路径、maxTokens 与 taskPrefix;
  保存即热生效(applies: live),botId/botSecret 变更立即重建长连接。
- 浏览器半侧 bundle(lib/client.js):经 dsh 的 client-modules 以 __ModuleLoader__ closure-factory 加载,
  自包含卡片实现(内联样式,无 CSS 依赖),模型下拉列表来自 dsh 模型目录 api.llm.models。

### 变更

- 设置命名空间 wecom-bot:装配配置作为 base,UI 用户层覆盖;settings 服务缺失的 profile 静默降级到装配配置。
- AgentBridge 上报轮次错误详情:回复末尾附错误信息(不再只显示笼统失败)。
- 会话冲突重建:创建 agent 会话失败时按冲突提示重试(避免持久化会话与内存状态错位)。
- 移除调试期 console.log,lib 由干净构建重新生成。

### 修复

- 设置热更新对相对 workspace 按 dsh 工作区解析后再应用。

## 0.2.0 (未发布)

### 新增

- **长连接模式(默认)**:基于官方 @wecom/aibot-node-sdk 的 WebSocket 通道(wss://openws.work.weixin.qq.com),
  无需公网地址与内网穿透;自动认证(botId/botSecret)、心跳保活、指数退避重连、回执队列。
- **mode 配置**:longconn(默认) / callback / both,两条通道共享同一 AgentBridge(会话/队列/多轮互通)。
- **流式「思考中」占位**:长连接模式下任务开始时先回占位(finish=false),最终答案刷新(finish=true)。
- 新增配置:botId / botSecret / scene / wsUrl / heartbeatIntervalMs / reconnectBaseDelayMs /
  maxReconnectAttempts / maxAuthFailureAttempts / requestTimeoutMs / thinkingHint(含 WECOM_BOT_* 环境变量)。
- 新增适配器测试 wecom-longconn(10 个用例)。

### 变更

- 默认接收通道由回调改为长连接;回调模式需显式 mode: callback。
- AgentBridge 的回复依赖由 WecomApi 收窄为 ReplySender 接口(回调 / 长连接双实现)。

## 0.1.0 (未发布)

- 回调模式:GET URL 验证、POST 消息验签解密、先回 200 再异步;
- 进程内 agent 驱动:每会话 FIFO 队列、同一 sessionId 多轮记忆、单轮超时、agent 失效自愈;
- 配置 fail-fast 校验(schemastery schema + 环境变量合并);
- 安全默认:常数时间签名比较、AES 严格校验、长度与队列上限、凭据不入日志;
- CI:typecheck + test + lint + build(GitHub Actions)。
