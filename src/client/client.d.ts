/**
 * 浏览器半侧外部包的最小类型桩。
 *
 * 这些 @deepseek-ai/dsh-client-* 包由 dsh web 的模块表在运行时提供
 * (见 package.json 的 dsh.client.inject 与 esbuild external),插件构建
 * 不打包它们;此处仅声明本项目用到的极小 API 面,便于编辑器提示。
 * tsc 构建排除 src/client,类型正确性由 esbuild 产物在真实宿主验证。
 */
declare module '@deepseek-ai/cordis' {
  export class Context {
    readonly logger: {
      info(message: string, ...args: unknown[]): void
      warn(message: string, ...args: unknown[]): void
      error(message: string, ...args: unknown[]): void
      debug(message: string, ...args: unknown[]): void
    }
    on(event: string, handler: (...args: any[]) => void): () => void
    effect(fn: () => unknown, name?: string): void
    get<T>(key: string): T | undefined
    inject<T extends readonly string[]>(services: T, callback: (ctx: unknown) => void): void
    locale: ClientLocale
    slots: ClientSlots
    settingsScope: ClientSettingsScopeService
    [key: string]: unknown
  }
  export class Service {
    static readonly init: unique symbol
    static readonly dispose: unique symbol
    constructor(ctx: Context, name: string)
    protected readonly ctx: Context
  }
}

declare module '@deepseek-ai/dsh-client-runtime/client' {
  export interface ClientContext {
    logger: unknown
    get<T>(key: string): T | undefined
    effect(fn: () => unknown, name?: string): void
    on(event: string, handler: (...args: any[]) => void): () => void
    locale: ClientLocale
    slots: ClientSlots
    settingsScope: ClientSettingsScopeService
    [key: string]: unknown
  }
  export interface SettingsScopeSnapshot<T> {
    status: 'loading' | 'ready' | 'unavailable'
    value: T | undefined
    base: unknown
    user: unknown
    revision: number | undefined
    writable: boolean
    mode: 'host' | 'memory'
  }
  export interface SettingsScope<T> {
    getSnapshot(): SettingsScopeSnapshot<T>
    subscribe(listener: () => void): () => void
    set(field: string, value: unknown): Promise<void>
    unset(field: string): Promise<void>
  }
  export interface SnapshotStore<T> {
    getSnapshot(): T
    subscribe(listener: () => void): () => void
    set(value: T): void
  }
  export function createSnapshotStore<T>(initial: T): SnapshotStore<T>
  export interface ClientLocale {
    bind(namespace: string): (key: string) => string
    register(namespace: string, dictionaries: Record<string, Record<string, string>>): void
    subscribe(listener: () => void): () => void
  }
  export interface ClientSlots {
    register<T>(options: Record<string, unknown>, component: unknown): unknown
    inject(slot: string, thunk: () => Iterable<unknown> | unknown): void
    entries(slot: string): { options: Record<string, unknown> }[]
    getVersion(slot: string): number
    subscribe(slot: string, listener: () => void): () => void
  }
  export interface ClientSettingsScopeService {
    bind<T>(spec: { namespace: string }): SettingsScope<T>
    describe(): unknown
  }
}

declare module '@deepseek-ai/dsh-client-connection/client' {
  export interface IApiClient {
    llm: {
      models(request: unknown): Promise<{ result?: { groups?: unknown[] } }>
    }
    [domain: string]: unknown
  }
  export interface ConnectionHandle {
    api: IApiClient
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  export type ClientContext = import('@deepseek-ai/dsh-client-runtime/client').ClientContext
}

declare module '@deepseek-ai/dsh-client-locale/client' {
  export type ClientContext = import('@deepseek-ai/dsh-client-runtime/client').ClientContext
}

declare module '@deepseek-ai/dsh-client-ui-settings/client' {
  export type ClientContext = import('@deepseek-ai/dsh-client-runtime/client').ClientContext
}

declare module 'react' {
  export interface CSSProperties { [key: string]: string | number | undefined }
  export function useState<T>(initial: T): [T, (value: T) => void]
  export type ReactNode = unknown
}

declare module 'react/jsx-runtime' {
  export const jsx: (...args: unknown[]) => unknown
  export const jsxs: (...args: unknown[]) => unknown
}
