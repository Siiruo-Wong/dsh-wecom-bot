import { describe, expect, it } from 'vitest'
import { extractXmlFields } from '../src/xml.js'

describe('extractXmlFields', () => {
  it('解析加密信封', () => {
    const xml = '<xml><ToUserName><![CDATA[ww123]]></ToUserName><Encrypt><![CDATA[ENCRYPTED]]></Encrypt><AgentID><![CDATA[1000002]]></AgentID></xml>'
    const fields = extractXmlFields(xml)
    expect(fields.ToUserName).toBe('ww123')
    expect(fields.Encrypt).toBe('ENCRYPTED')
    expect(fields.AgentID).toBe('1000002')
  })

  it('解析内部消息(含无 CDATA 的纯文本标签)', () => {
    const xml = '<xml><ToUserName><![CDATA[ww123]]></ToUserName><FromUserName><![CDATA[ZhangSan]]></FromUserName><CreateTime>1348831860</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[你好]]></Content><MsgId>1234567890123456</MsgId><AgentID>1000002</AgentID></xml>'
    const fields = extractXmlFields(xml)
    expect(fields.FromUserName).toBe('ZhangSan')
    expect(fields.CreateTime).toBe('1348831860')
    expect(fields.MsgType).toBe('text')
    expect(fields.Content).toBe('你好')
    expect(fields.MsgId).toBe('1234567890123456')
  })

  it('群聊消息带 ChatId', () => {
    const xml = '<xml><FromUserName><![CDATA[ZhangSan]]></FromUserName><ChatId><![CDATA[wr_chat]]></ChatId><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[hi]]></Content></xml>'
    const fields = extractXmlFields(xml)
    expect(fields.ChatId).toBe('wr_chat')
  })

  it('空输入与无匹配返回空对象', () => {
    expect(extractXmlFields('')).toEqual({})
    expect(extractXmlFields('<foo>no closing')).toEqual({})
  })
})
