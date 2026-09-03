/**
 * 落盘日志:把插件运行日志(含 SDK 的 aibot 发送/回执)同时写入
 * `$DSH_HOME/logs/wecom-bot.log`,解决"桌面实例 stdout 不可读、偶发丢回复
 * 只有日志能定位 errcode"的问题。写文件失败不影响主流程(全部 try/catch)。
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import type { LoggerLike } from './types.js'

/** 超过该大小轮转为 wecom-bot.log.1(丢弃旧档) */
const MAX_LOG_BYTES = 8 * 1024 * 1024

const LEVELS = ['debug', 'info', 'warn', 'error'] as const

function two(n: number): string {
  return n < 10 ? '0' + n : String(n)
}

function timestamp(): string {
  const d = new Date()
  return (
    `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ` +
    `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`
  )
}

function render(args: unknown[]): string {
  return args
    .map((arg) => {
      if (typeof arg === 'string') return arg
      try {
        return JSON.stringify(arg)
      } catch {
        return String(arg)
      }
    })
    .join(' ')
}

/**
 * 包装宿主 logger:原样转发到宿主,同时追加写入文件(自动建目录、超限轮转)。
 */
export function createTeeLogger(base: LoggerLike, file: string): LoggerLike {
  const write = (level: string, args: unknown[]): void => {
    try {
      mkdirSync(dirname(file), { recursive: true })
      try {
        if (statSync(file).size > MAX_LOG_BYTES) {
          renameSync(file, file + '.1')
        }
      } catch {
        /* 文件尚不存在:忽略 */
      }
      appendFileSync(file, `${timestamp()} [${level}] ${render(args)}\n`, 'utf8')
    } catch {
      /* 落盘失败不影响主流程 */
    }
  }
  const out = {} as Record<string, (...args: unknown[]) => void>
  for (const level of LEVELS) {
    const fn = (base as unknown as Record<string, (...args: unknown[]) => void>)[level]
    out[level] = (...args: unknown[]) => {
      try {
        if (typeof fn === 'function') fn(...args)
      } catch {
        /* 宿主 logger 异常不阻断 */
      }
      write(level, args)
    }
  }
  return out as unknown as LoggerLike
}
