/**
 * @deepseek-ai/cordis 类型桩。
 *
 * 该包由 dsh 宿主在运行时提供(其依赖 cosmokit 未发布到 npm,无法作为依赖安装),
 * 故这里仅声明插件用到的极小 API 面,保证 tsc 类型检查与产物构建。
 * 运行时:import 语句保留原样,由宿主 node_modules 解析。
 */
declare module '@deepseek-ai/cordis' {
  /** cordis Logger(与 dsh 内部一致) */
  export interface Logger {
    info(message: string, ...args: unknown[]): void
    warn(message: string, ...args: unknown[]): void
    error(message: string, ...args: unknown[]): void
    debug(message: string, ...args: unknown[]): void
  }

  /** Context:插件可用的宿主上下文(只声明插件用到的成员) */
  export class Context {
    readonly logger: Logger
    /** 订阅宿主事件,返回取消订阅函数 */
    on(event: string, handler: (...args: unknown[]) => void): () => void
    /** 注册一个随卸载执行的清理 effect */
    effect(fn: () => unknown, name?: string): void
    /** 声明服务依赖,宿主在 setup 阶段按序注入(settings 等) */
    inject<T extends readonly string[]>(services: T, callback: (ctx: unknown) => void): void
    plugin<T>(plugin: T, config?: unknown): Promise<void>
    get<T>(key: string): T | undefined
    [key: string]: unknown
  }

  /** Service:插件基类(宿主提供 init/dispose 生命周期符号) */
  export abstract class Service {
    static readonly init: unique symbol
    static readonly dispose: unique symbol
    constructor(ctx: Context, name: string)
    protected readonly ctx: Context
  }
}