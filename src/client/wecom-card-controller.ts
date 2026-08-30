/**
 * wecom-bot 设置卡片:暂存表单 + llm.models 目录(provider/model 下拉)。
 *
 * 自包含实现(不复刻 ui-settings-plugins 的 CardForm):每个字段暂存草稿,
 * 保存时逐字段经 settingsScope.set/unset 写入;provider/model 下拉的数据来自
 * api.llm.models(宿主模型目录),目录不可用时不阻塞保存(可手动输入)。
 */
import type { SettingsScope, SettingsScopeSnapshot, SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { IApiClient } from '@deepseek-ai/dsh-client-connection/client'

/** 命名空间:与 Host 侧 src/settings.ts 拼写的值一致。 */
export const WECOM_NS = 'wecom-bot'

/** UI 可编辑字段(与 Host 侧 WecomSettings 对应)。 */
export interface WecomSettings {
  botId: string
  botSecret: string
  provider: string
  model: string
  workspace: string
  maxTokens: number
  taskPrefix: string
}

/** 字段名顺序(渲染与保存共用)。 */
export const FIELDS = ['botId', 'botSecret', 'provider', 'model', 'workspace', 'maxTokens', 'taskPrefix'] as const
export type WecomField = (typeof FIELDS)[number]

/** 模型目录中一个提供方。 */
export interface ProviderEntry {
  id: string
  name: string
  models: { id: string; label: string }[]
}

/** 一个字段的渲染状态。 */
export interface CardFieldState {
  /** 暂存文本(保存前所见即所得)。 */
  text: string
  /** 用户层是否携带该字段(或暂存了编辑)。 */
  overridden: boolean
  /** 草稿是否不可接受(阻塞保存)。 */
  invalid: boolean
}

/** 卡片渲染状态。 */
export interface WecomCardState {
  /** 命名空间未被宿主服务时渲染为空。 */
  available: boolean
  writable: boolean
  dirty: boolean
  invalid: boolean
  saving: boolean
  failed: boolean
  fields: Record<WecomField, CardFieldState>
  /** provider 下拉选项。 */
  providers: ProviderEntry[]
  /** 当前(暂存)provider 下的模型选项。 */
  providerModels: { id: string; label: string }[]
}

/** 注册面:渲染器注入快照 hook 与表单动作。 */
export interface WecomCardFace {
  hooks: { wecomCard: SnapshotStore<WecomCardState> }
  edit: (field: string, text: string) => void
  resetField: (field: string) => void
  save: () => void
  discard: () => void
}

/** 数字字段的合法草稿;其他字符串字段任意文本(空=清除)。 */
function parseValue(field: WecomField, text: string): { kind: 'set'; value: unknown } | { kind: 'clear' } | undefined {
  if (field === 'maxTokens') {
    const trimmed = text.trim()
    if (trimmed === '') return { kind: 'clear' }
    const n = Number(trimmed)
    // z.natural():非负整数;0 表示"跟随宿主默认"(保存后宿主 maxTokens>0 才应用)
    return Number.isInteger(n) && n >= 0 ? { kind: 'set', value: n } : undefined
  }
  const trimmed = text.trim()
  return trimmed === '' ? { kind: 'clear' } : { kind: 'set', value: trimmed }
}

function formatValue(field: WecomField, value: unknown): string {
  if (value === undefined || value === null) return ''
  return String(value)
}

export class WecomCardController {
  private readonly staged = new Map<WecomField, string>()
  private saving = false
  private failed = false
  private providers: ProviderEntry[] = []
  private readonly store: SnapshotStore<WecomCardState>

  constructor(
    private readonly scope: SettingsScope<WecomSettings>,
    private readonly api: IApiClient,
  ) {
    this.store = createSnapshotStore<WecomCardState>(this.projection())
    scope.subscribe(() => this.publish())
    void this.loadModels()
  }

  private snapshot(): SettingsScopeSnapshot<WecomSettings> {
    return this.scope.getSnapshot()
  }

  private field(field: WecomField): CardFieldState {
    const snap = this.snapshot()
    const draft = this.staged.get(field)
    const section = snap.value
    const value = section !== undefined ? (section as Record<string, unknown>)[field] : undefined
    const userOverridden = isObject(snap.user) && field in snap.user
    if (draft !== undefined) {
      const parsed = parseValue(field, draft)
      return {
        text: draft,
        overridden: true,
        invalid: parsed === undefined,
      }
    }
    return {
      text: formatValue(field, value),
      overridden: userOverridden,
      invalid: false,
    }
  }

  private providerModels(): { id: string; label: string }[] {
    const provider = this.field('provider').text
    const entry = this.providers.find(p => p.id === provider)
    return entry ? entry.models : []
  }

  private projection(): WecomCardState {
    const snap = this.snapshot()
    const dirty = this.staged.size > 0
    const invalid = FIELDS.some(f => this.field(f).invalid)
    return {
      available: snap.status === 'ready',
      writable: snap.writable,
      dirty,
      invalid,
      saving: this.saving,
      failed: this.failed,
      fields: {
        botId: this.field('botId'),
        botSecret: this.field('botSecret'),
        provider: this.field('provider'),
        model: this.field('model'),
        workspace: this.field('workspace'),
        maxTokens: this.field('maxTokens'),
        taskPrefix: this.field('taskPrefix'),
      },
      providers: this.providers,
      providerModels: this.providerModels(),
    }
  }

  private publish(): void {
    this.store.set(this.projection())
  }

  private async loadModels(): Promise<void> {
    try {
      const response = await this.api.llm.models({})
      const groups = (response?.result as { groups?: { id: string; name: string; models: { id: string; name?: string }[] }[] } | undefined)?.groups ?? []
      this.providers = groups.map(g => ({
        id: g.id,
        name: g.name ?? g.id,
        models: (g.models ?? []).map(m => ({ id: m.id, label: m.name ?? m.id })),
      }))
    } catch {
      // 目录不可用(如提供方未配置):保留空列表,手动输入仍可保存
      this.providers = []
    }
    this.publish()
  }

  edit(field: string, text: string): void {
    if (!isField(field)) return
    this.staged.set(field, text)
    this.publish()
  }

  resetField(field: string): void {
    if (!isField(field)) return
    this.staged.delete(field)
    this.publish()
  }

  discard(): void {
    this.staged.clear()
    this.failed = false
    this.publish()
  }

  async save(): Promise<void> {
    if (!this.snapshot().writable) return
    if (FIELDS.some(f => this.field(f).invalid)) return
    this.saving = true
    this.failed = false
    this.publish()
    try {
      const writes: Promise<void>[] = []
      for (const field of FIELDS) {
        const draft = this.staged.get(field)
        if (draft === undefined) continue
        const parsed = parseValue(field, draft)
        if (parsed === undefined) continue
        writes.push(parsed.kind === 'clear' ? this.scope.unset(field) : this.scope.set(field, parsed.value))
      }
      await Promise.all(writes)
    } catch {
      this.failed = true
    }
    this.staged.clear()
    this.saving = false
    this.publish()
  }

  /** 构建注册面。 */
  inject(): WecomCardFace {
    return {
      hooks: { wecomCard: this.store },
      edit: (f, t) => this.edit(f, t),
      resetField: (f) => this.resetField(f),
      save: () => void this.save(),
      discard: () => this.discard(),
    }
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

function isField(value: string): value is WecomField {
  return (FIELDS as readonly string[]).includes(value)
}
