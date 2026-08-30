import { describe, expect, it } from 'vitest'
import {
  constantTimeEqual,
  decryptWecomMessage,
  encryptWecomMessage,
  sha1,
  verifySignature,
} from '../src/crypto.js'

/** 43 位合法 EncodingAESKey(26 大写 + 17 小写) */
const KEY = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq'

describe('crypto', () => {
  it('测试用 KEY 解码后应为 32 字节(AES-256)', () => {
    expect(Buffer.from(KEY + '=', 'base64')).toHaveLength(32)
  })

  it('加密 -> 解密 回环一致(含中文与 XML)', () => {
    const msg = '<xml><ToUserName><![CDATA[ww123]]></ToUserName><Content><![CDATA[你好,测试]]></Content></xml>'
    const enc = encryptWecomMessage(msg, KEY, 'ww123')
    expect(decryptWecomMessage(enc, KEY)).toBe(msg)
  })

  it('解密时密钥错误必须失败', () => {
    const enc = encryptWecomMessage('hello', KEY, 'ww123')
    const other = 'ZYXWVUTSRQPONMLKJIHGFEDCBAzyxwvutsrqponmlk'
    expect(() => decryptWecomMessage(enc, other)).toThrow()
  })

  it('密文被篡改必须失败(填充/长度校验)', () => {
    const enc = encryptWecomMessage('hello world', KEY, 'ww123')
    const buf = Buffer.from(enc, 'base64')
    buf[16] ^= 0x80 // 翻转 msgLen 字段的首字节(明文第 16 字节),长度校验必然失败
    expect(() => decryptWecomMessage(buf.toString('base64'), KEY)).toThrow()
  })

  it('密钥长度非法必须抛错', () => {
    expect(() => decryptWecomMessage('x', 'short')).toThrow()
    expect(() => encryptWecomMessage('x', 'short', 'ww')).toThrow()
  })

  it('空密文/垃圾输入抛错而非崩溃', () => {
    expect(() => decryptWecomMessage('', KEY)).toThrow()
    expect(() => decryptWecomMessage('!!!not-base64!!!', KEY)).toThrow()
  })

  it('签名:正确通过、错误拒绝、缺参拒绝', () => {
    const token = 'tok'
    const timestamp = '123'
    const nonce = 'abc'
    const encrypt = 'ciphertext'
    const sig = sha1([token, timestamp, nonce, encrypt].sort().join(''))
    expect(verifySignature({ token, timestamp, nonce, encrypt, signature: sig })).toBe(true)
    expect(verifySignature({ token, timestamp, nonce, encrypt, signature: 'deadbeef' })).toBe(false)
    expect(verifySignature({ token, timestamp, nonce, encrypt, signature: undefined })).toBe(false)
    expect(verifySignature({ token, timestamp, nonce, encrypt: '', signature: sig })).toBe(false)
  })

  it('常数时间比较:相等与不等', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true)
    expect(constantTimeEqual('abc', 'abd')).toBe(false)
    expect(constantTimeEqual('abc', 'abcd')).toBe(false)
  })
})