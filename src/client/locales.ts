/**
 * wecom-bot 配置卡片的本地化词典(zh / en)。由浏览器插件在 apply 时注册。
 */
export type WecomLocaleKey =
  | 'wecomTitle' | 'wecomDescription'
  | 'botId' | 'botIdHint'
  | 'botSecret' | 'botSecretHint'
  | 'provider' | 'providerHint' | 'providerPlaceholder'
  | 'model' | 'modelHint' | 'modelPlaceholder'
  | 'workspace' | 'workspaceHint'
  | 'maxTokens' | 'maxTokensHint'
  | 'taskPrefix' | 'taskPrefixHint'
  | 'overridden' | 'reset'
  | 'save' | 'saving' | 'discard' | 'unsaved' | 'saveFailed' | 'invalidNumber'
  | 'emptyModelOption' | 'emptyProviderOption'

export const zh: Record<WecomLocaleKey, string> = {
  wecomTitle: '企业微信机器人',
  wecomDescription: '企业微信智能机器人:接收企微消息并驱动 dsh agent 回答。',
  botId: '机器人 ID (botId)',
  botIdHint: '企业微信后台 → 智能机器人 → 获取机器人 ID。留空使用装配配置。',
  botSecret: '机器人密钥 (botSecret)',
  botSecretHint: '企业微信后台获取的机器人 Secret。留空使用装配配置。',
  provider: '模型提供方',
  providerHint: '选择 dsh 中已配置的模型提供方;留空使用宿主默认模型。',
  providerPlaceholder: '选择提供方…',
  model: '模型',
  modelHint: '选择该提供方下的模型;留空使用宿主默认模型。',
  modelPlaceholder: '选择模型…',
  workspace: 'AI 会话工作目录',
  workspaceHint: 'agent 的工作目录(绝对路径),bash 与文件工具的活动根。',
  maxTokens: '输出上限 (maxTokens)',
  maxTokensHint: '单次模型请求输出 token 上限;留空不限制。',
  taskPrefix: '系统提示 / 人设',
  taskPrefixHint: '拼在每条消息前,可注入安全约束或身份设定。',
  overridden: '已覆盖',
  reset: '重置为默认',
  save: '保存',
  saving: '保存中…',
  discard: '放弃修改',
  unsaved: '未保存',
  saveFailed: '保存未被宿主接受,已保留草稿供修正。',
  invalidNumber: '请输入数字,或留空使用默认值。',
  emptyModelOption: '(留空:宿主默认模型)',
  emptyProviderOption: '(留空:宿主默认模型)',
}

export const en: Record<WecomLocaleKey, string> = {
  wecomTitle: 'WeCom Bot',
  wecomDescription: 'WeCom intelligent bot: receive messages and drive a dsh agent to answer.',
  botId: 'Bot ID (botId)',
  botIdHint: 'WeCom admin → AI Bot → bot ID. Leave blank to use the assembled config.',
  botSecret: 'Bot Secret (botSecret)',
  botSecretHint: 'Bot secret from the WeCom admin console. Leave blank to use the assembled config.',
  provider: 'Model provider',
  providerHint: 'Pick a provider configured in dsh; blank uses the host default model.',
  providerPlaceholder: 'Select provider…',
  model: 'Model',
  modelHint: 'Pick a model of the chosen provider; blank uses the host default model.',
  modelPlaceholder: 'Select model…',
  workspace: 'Agent working directory',
  workspaceHint: 'Absolute path the agent works in; the activity root of bash and file tools.',
  maxTokens: 'Max output tokens (maxTokens)',
  maxTokensHint: 'Per-request output token cap; blank leaves it unlimited.',
  taskPrefix: 'System prompt / persona',
  taskPrefixHint: 'Prepended to every message; inject security constraints or identity.',
  overridden: 'Overridden',
  reset: 'Reset to default',
  save: 'Save',
  saving: 'Saving…',
  discard: 'Discard',
  unsaved: 'Unsaved',
  saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
  invalidNumber: 'Enter a number, or leave blank to use the default.',
  emptyModelOption: '(blank: host default model)',
  emptyProviderOption: '(blank: host default model)',
}
