/**
 * 企业微信回调加解密与签名(规范见 developer.work.weixin.qq.com/document/path/90930)。
 *
 * 安全要点:
 * - 签名比较使用 timingSafeEqual(常数时间),避免时序侧信道;
 * - AES 密钥长度、PKCS7 填充、消息长度均严格校验,越界即抛错;
 * - 所有抛错信息不含密钥内容。
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto'

/** sha1 十六进制 */
export function sha1(input: string): string {
  return createHash('sha1').update(input, 'utf8').digest('hex')
}

/** 常数时间字符串比较;长度不同直接不等,不泄露内容 */
export function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

export interface SignatureInput {
  token: string
  timestamp: string
  nonce: string
  encrypt: string
  signature: string | undefined
}

/**
 * 校验 msg_signature = sha1(sort([token, timestamp, nonce, encrypt]).join(''))
 */
export function verifySignature(input: SignatureInput): boolean {
  const { token, timestamp, nonce, encrypt, signature } = input
  if (!signature || !encrypt) return false
  const expected = sha1([token, timestamp, nonce, encrypt].sort().join(''))
  return constantTimeEqual(expected, signature)
}

/**
 * 解密企微密文(AES-256-CBC / PKCS7)。
 * 密钥 = Base64Decode(EncodingAESKey + '='),iv = 密钥前 16 字节。
 * 明文结构:16 字节随机串 + 4 字节网络序 msg_len + msg + receiveid。
 */
export function decryptWecomMessage(encryptedBase64: string, aesKey: string): string {
  const key = Buffer.from(aesKey + '=', 'base64')
  if (key.length !== 32) throw new Error('aesKey 非法(解码后应为 32 字节)')
  const iv = key.subarray(0, 16)
  const decipher = createDecipheriv('aes-256-cbc', key, iv)
  decipher.setAutoPadding(false)
  let plain: Buffer
  try {
    plain = Buffer.concat([
      decipher.update(Buffer.from(encryptedBase64, 'base64')),
      decipher.final(),
    ])
  } catch (error) {
    throw new Error(`AES 解密失败: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (plain.length === 0) throw new Error('解密结果为空')
  // PKCS7 去填充:末尾字节即填充长度
  const pad = plain[plain.length - 1]!
  if (pad < 1 || pad > 32 || pad > plain.length) throw new Error('PKCS7 填充非法')
  plain = plain.subarray(0, plain.length - pad)
  // 16 字节随机串 + 4 字节长度
  if (plain.length < 20) throw new Error('明文长度非法(不足 20 字节)')
  const msgLen = plain.readUInt32BE(16)
  if (20 + msgLen > plain.length) throw new Error('消息长度越界')
  return plain.subarray(20, 20 + msgLen).toString('utf8')
}

/**
 * 加密(被动回复/测试用):构造 16 随机 + 4 字节长度 + msg + receiveid,PKCS7 填充到 32 字节倍数。
 */
export function encryptWecomMessage(msg: string, aesKey: string, receiveId: string): string {
  const key = Buffer.from(aesKey + '=', 'base64')
  if (key.length !== 32) throw new Error('aesKey 非法(解码后应为 32 字节)')
  const iv = key.subarray(0, 16)
  const random = randomBytes(16)
  const lenBuf = Buffer.alloc(4)
  lenBuf.writeUInt32BE(Buffer.byteLength(msg, 'utf8'), 0)
  const body = Buffer.concat([
    random,
    lenBuf,
    Buffer.from(msg, 'utf8'),
    Buffer.from(receiveId, 'utf8'),
  ])
  const padLen = 32 - (body.length % 32)
  const padded = Buffer.concat([body, Buffer.alloc(padLen, padLen)])
  const cipher = createCipheriv('aes-256-cbc', key, iv)
  cipher.setAutoPadding(false)
  return Buffer.concat([cipher.update(padded), cipher.final()]).toString('base64')
}
