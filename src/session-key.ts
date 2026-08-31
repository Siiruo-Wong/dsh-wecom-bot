/**
 * 显式会话标识管理。
 *
 * 规则:
 * - 消息以 `#<数字>` 开头 → 续接该会话(复用/resume,保留多轮记忆);
 * - 不带标识 → 自动分配一个**递增数字**的新会话标识(独立上下文,零串味)。
 *
 * 递增计数器持久化在 `<dsh home>/wecom-bot/session-seq`(默认 `~/.dsh`),
 * 进程重启后继续递增,新会话不会撞上历史会话 id。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** `#` + 数字;数字后要求非数字或结尾,避免误吞后续文本(如 `#7继续`) */
const SESSION_TOKEN_RE = /^\s*#(\d+)(?=\D|$)/

/**
 * 从消息文本中剥离开头的会话标识。
 * @returns token 存在时为 `#` 后的数字串;rest 为去掉标识后的剩余文本。
 */
export function splitSessionToken(text: string): { token?: string; rest: string } {
  const match = SESSION_TOKEN_RE.exec(text)
  if (!match) return { rest: text }
  return { token: match[1]!, rest: text.slice(match[0].length).trimStart() }
}

/** dsh 主目录:`$DSH_HOME` 或 `~/.dsh` */
export function dshHome(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

export interface SessionCounter {
  (): string
}

/**
 * 创建递增会话号分配器。
 * 计数状态持久化在 `<home>/wecom-bot/session-seq`;同步读写保证单进程内
 * 分配串行,多实例并存时由宿主任一实例连接企微,竞争可忽略。
 * @param home - dsh 主目录(测试可注入临时目录)。
 * @param onError - 持久化失败回调(不阻断分配,进程内仍递增)。
 */
export function createSessionCounter(home: string = dshHome(), onError?: (error: unknown) => void): SessionCounter {
  const dir = join(home, 'wecom-bot')
  const file = join(dir, 'session-seq')
  let next = 0
  try {
    next = Number.parseInt(readFileSync(file, 'utf8').trim(), 10) || 0
  } catch {
    /* 首次运行:从 1 开始 */
  }
  return () => {
    next += 1
    try {
      mkdirSync(dir, { recursive: true })
      const tmp = file + '.tmp'
      writeFileSync(tmp, String(next), 'utf8')
      renameSync(tmp, file)
    } catch (error) {
      onError?.(error)
    }
    return String(next)
  }
}
