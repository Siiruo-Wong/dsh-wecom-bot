/**
 * dsh-wecom-bot 浏览器半侧:在 设置 → 插件 → 插件配置 注册 wecom-bot 配置卡片。
 *
 * 加载链路:package.json 的 dsh.client 声明被 client-modules 扫描进
 * window.__DSH_BOOT__,lib/client.js 以 closure-factory 形态加载;本入口
 * 通过 slots 注册卡片,卡片以 wecom-bot 命名空间为键,由宿主设置的
 * ConfigurablePluginsTab 配对渲染。
 */
import { WecomCard } from './WecomCard.tsx'
import { WECOM_NS, WecomCardController } from './wecom-card-controller.ts'
import { en, zh } from './locales.ts'

/** 本卡片拥有的 locale 词典命名空间。 */
const NS = 'wecom-bot'

/** 需要的客户端服务(cordis fiber inject)。 */
export const inject = ['slots', 'locale', 'connection', 'settingsScope']

/**
 * 挂载 wecom-bot 配置卡片。
 * @param ctx - 浏览器插件上下文。
 */
export function apply(ctx: unknown): void {
  const clientCtx = ctx as {
    locale: { register(namespace: string, dictionaries: Record<string, Record<string, string>>): void }
    slots: {
      inject(slot: string, thunk: () => Iterable<unknown> | unknown): void
      register(options: Record<string, unknown>, component: unknown): unknown
    }
    settingsScope: { bind(spec: { namespace: string }): unknown }
    get<T>(key: string): T | undefined
    effect(fn: () => unknown, name?: string): void
  }
  clientCtx.effect(
    () => clientCtx.locale.register(NS, { zh, en }),
    'dsh-wecom-bot: card dictionary',
  )

  const connection = clientCtx.get<{ api: { llm: { models(request: unknown): Promise<unknown> } } }>('connection')
  const api = connection?.api
  if (!api) {
    // 无连接(非常规宿主):不渲染卡片,静默
    return
  }
  const controller = new WecomCardController(
    clientCtx.settingsScope.bind({ namespace: WECOM_NS }),
    api as never,
  )

  clientCtx.slots.inject('settings.plugin.item', function* () {
    yield clientCtx.slots.register({
      name: 'settings.plugin.item',
      key: WECOM_NS,
      locale: NS,
      inject: () => controller.inject(),
    }, WecomCard)
  })
}
