/**
 * 极简、安全的 XML 字段提取。
 *
 * 企微回调的 XML 结构固定(根标签 xml + 叶子标签,内容为纯文本或 CDATA),
 * 用正则提取即可。不做通用 XML 解析,天然规避 XXE/实体膨胀;
 * 输入长度由调用方(bodyLimitBytes)先行限制。
 */
const TAG_RE = /<([A-Za-z_][\w.-]*)(?:\s[^>]*)?>((?:<!\[CDATA\[[\s\S]*?\]\]>|[^<])*?)<\/\1>/g
const CDATA_RE = /^<!\[CDATA\[([\s\S]*?)\]\]>$/

/** 解包单个 CDATA 包装(非 CDATA 原样返回) */
function unwrap(value: string): string {
  const m = CDATA_RE.exec(value)
  return m ? m[1]! : value
}

/** 提取顶层字段:重复标签后者覆盖;无匹配返回空对象 */
export function extractXmlFields(xml: string): Record<string, string> {
  const out: Record<string, string> = {}
  if (!xml || xml.length === 0) return out
  TAG_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = TAG_RE.exec(xml)) !== null) {
    out[match[1]!] = unwrap(match[2]!).trim()
  }
  return out
}
