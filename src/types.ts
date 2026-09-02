/**
 * 结构化类型:与 dsh 内部类型(Agent/Session/Message)对齐但不 import 其包,
 * 使插件只依赖 npm 上稳定可用的 @deepseek-ai/cordis 与 @deepseek-ai/schemastery。
 *
 * 字段含义与 @deepseek-ai/dsh-agent、@deepseek-ai/dsh-llm、@deepseek-ai/dsh-session
 * 的运行时形状一一对应(见各包 README / 本仓库 packages/sdk/server 的用法)。
 */

/** 文本内容块(与 dsh-llm 的 ContentBlock 的 text 分支一致) */
export interface TextBlock {
  type: 'text'
  text: string
}

/** 用户消息(与 dsh-llm 的 UserMessage 一致:id 为 UUID 字符串) */
export interface UserMessageLike {
  id: string
  role: 'user'
  content: TextBlock[]
  source: { kind: 'user' }
}

/** Agent 句柄(与 @deepseek-ai/dsh-agent 的 Agent 一致) */
export interface AgentLike {
  id: string
  session: { id: string }
  followup(message: UserMessageLike): void
}

export interface AgentHandleLike {
  agent: AgentLike
  dispose(): Promise<void>
}

/** ctx.agents 服务的结构形状 */
export interface AgentsServiceLike {
  create(options: {
    sessionId: string
    meta: { cwd: string; agentPreset?: string }
    agentOptions?: { provider?: string; model?: string; maxTokens?: number }
    /** 创建期挂载 agent 预设(system prompt/工具目录等),与 web 会话一致 */
    setup?: (agentCtx: unknown) => Promise<void>
  }): Promise<AgentHandleLike>
  /**
   * 从持久化日志恢复一个既有会话并续接(应用重启后同 id 再创建会触发
   * "already has a persisted log" 冲突,resume 是官方续接路径,保留全部历史)。
   * 会话 cwd/预设取持久化头部,与 create 的 meta 无关。
   */
  resume(options: {
    resumeSessionId: string
    agentOptions?: { provider?: string; model?: string; maxTokens?: number }
    setup?: (agentCtx: unknown) => Promise<void>
  }): Promise<AgentHandleLike>
  get(id: string): AgentLike | undefined
}

/** ctx.get('agentPresets') 服务的最小接口面(与 dsh-agent-presets 形状对齐) */
export interface AgentPresetsServiceLike {
  /** 解析预设;id 省略时用部署配置的默认预设。 */
  resolve(id?: string): Promise<{ id: string }>
  /** 把预设的 agent 平面组合挂载到该 agent 的作用域上下文。 */
  mount(agentCtx: unknown, id: string): Promise<void>
}

/** ctx.get('sessionTitle') 服务的最小接口面(与 dsh-session-title 对齐,随 dsh-base 挂载) */
export interface SessionTitleServiceLike {
  /**
   * 以 user 源写入标题(钉住:自动标题生成不再覆盖),返回规范化后的标题。
   * 要求传入**活的**会话对象(agent 句柄的 session)。
   */
  rename(session: unknown, title: string): { title: string }
}

/** session/event 事件的结构形状(只需 assistant/message 与 turn/end 的字段) */
export interface SessionEventLike {
  type: string
  data?: {
    message?: { content?: unknown }
    reason?: { kind?: string }
    [key: string]: unknown
  }
  [key: string]: unknown
}

/** 企微回调解析后的消息 */
export interface ParsedCallback {
  fromUser: string
  msgType: string
  content: string | undefined
  chatId: string | undefined
  msgId: string | undefined
  createTime: string | undefined
}

/** 回复目标:回调模式私聊 touser / 群聊 chatid;长连接模式 reqId + streamId */
export interface ReplyTarget {
  touser?: string
  chatid?: string
  /** 长连接:企微 aibot_msg_callback 帧的 req_id,回复时原样回显 */
  reqId?: string
  /** 长连接:流式消息 ID,思考占位与最终回复共用 */
  streamId?: string
}

/** 长连接 WS 客户端最小接口面(由 @wecom/aibot-node-sdk 的 WSClient 实现;测试注入桩) */
export interface LongConnClientLike {
  connect(): unknown
  disconnect(): void
  removeListener?(event: string, handler: (...args: any[]) => void): void
  /** 当前 WebSocket 是否处于可发送状态(断开/重连期间为 false) */
  readonly isConnected: boolean
  replyStream(
    frame: { headers: { req_id: string } },
    streamId: string,
    content: string,
    finish?: boolean,
  ): Promise<unknown>
  on(event: string, handler: (...args: any[]) => void): unknown
}

/** 长连接收到的文本消息帧(与 SDK WsFrame<TextMessage> 结构对齐) */
export interface LongConnFrameLike {
  headers: { req_id: string }
  body?: {
    msgid?: string
    chatid?: string
    chattype?: string
    from?: { userid?: string }
    text?: { content?: string }
  }
}

/** 回复发送器:AgentBridge 只依赖这个接口(回调模式走企微 API,长连接模式走 WS) */
export interface ReplySender {
  sendText(target: ReplyTarget, content: string): Promise<void>
}

/** 轻量 logger 接口(与 cordis Logger 的方法名一致) */
export interface LoggerLike {
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
  debug(message: string, ...args: unknown[]): void
}
/** dsh 设置服务的最小接口面(与 @deepseek-ai/dsh-settings 的 Service 形状对齐)。 */
export interface SettingsServiceLike {
  register<T>(namespace: string, schema: unknown, options?: {
    base?: Partial<T>
    applies?: 'live' | 'restart'
  }): SettingsScopeLike<T>
}

/** 一个注册命名空间的 owner 句柄。 */
export interface SettingsScopeLike<T> {
  /** 当前解析值:schema 默认 → base → 用户层。 */
  get(): T
  /** 观察该命名空间的提交变更,返回取消函数。 */
  watch(callback: (next: T, prev: T) => void | Promise<void>): () => void
}
