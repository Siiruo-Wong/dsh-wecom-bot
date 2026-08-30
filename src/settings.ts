/**
 * dsh-wecom-bot 的用户设置命名空间(wecom-bot)。
 *
 * 该命名空间承载 UI 可编辑的字段(botId / botSecret / provider / model /
 * workspace / maxTokens / taskPrefix),由 dsh 设置服务的三层语义解析:
 * schema 默认值 → 注册方 base(即 cordis 装配配置)→ 用户层(UI 写入)。
 * 插件在启动时读取 settings.get() 得到生效值,并在 watch 到变更时热更新。
 *
 * 安全说明:botSecret 作为普通字段存储(与 cordis.patch.yml 明文配置同级),
 * 仅存于本机 dsh 设置文档;卡片控件用 password 类型输入。
 */
import z from '@deepseek-ai/schemastery'

/** 用户设置命名空间(小写 kebab-case,与插件短名一致)。 */
export const WECOM_SETTINGS_NAMESPACE = 'wecom-bot' as const

/** UI 可编辑的设置字段。 */
export interface WecomSettings {
  /** 智能机器人 ID(longconn 模式必填,企业微信后台获取)。 */
  botId: string
  /** 智能机器人 Secret(longconn 模式必填,企业微信后台获取)。 */
  botSecret: string
  /** dsh agent 的 provider;留空由宿主默认模型选择决定。 */
  provider: string
  /** dsh agent 的 model;留空由宿主默认模型选择决定。 */
  model: string
  /** agent 的工作目录(绝对路径;留空使用宿主进程 cwd)。 */
  workspace: string
  /** 单次模型请求输出 token 上限;0 表示不限制。 */
  maxTokens: number
  /** 拼在每条消息前的系统提示/人设(可注入安全约束)。 */
  taskPrefix: string
}

/** 运行时 schema:所有字段可空(由 UI 或装配层填充后解析)。 */
export const WecomSettingsSchema: z<WecomSettings> = z.object({
  botId: z.string().default(''),
  botSecret: z.string().default(''),
  provider: z.string().default(''),
  model: z.string().default(''),
  workspace: z.string().default(''),
  maxTokens: z.natural().default(0),
  taskPrefix: z.string().default(''),
})
