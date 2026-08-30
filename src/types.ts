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
    meta: { cwd: string }
    agentOptions?: { provider?: string; model?: string; maxTokens?: number }
  }): Promise<AgentHandleLike>
  get(id: string): AgentLike | undefined
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

/** 回复目标:私聊 touser / 群聊 chatid 二选一 */
export interface ReplyTarget {
  touser?: string
  chatid?: string
}

/** 轻量 logger 接口(与 cordis Logger 的方法名一致) */
export interface LoggerLike {
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
  debug(message: string, ...args: unknown[]): void
}
