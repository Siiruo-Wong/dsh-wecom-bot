# 更新日志

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
