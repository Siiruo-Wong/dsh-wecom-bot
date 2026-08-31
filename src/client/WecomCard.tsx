/**
 * wecom-bot 配置卡片:展示在 设置 → 插件 → 插件配置 中,编辑 botId / botSecret /
 * provider / model / workspace / maxTokens / taskPrefix。
 *
 * 自包含实现(不依赖 ui-settings-plugins 的卡片外观):纯内联样式 + 自有暂存表单。
 */
import { useState } from 'react'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { WecomCardState, ProviderEntry } from './wecom-card-controller.ts'
import type { WecomLocaleKey } from './locales.ts'

/** 渲染器为卡片绑定的 props:locale 读 + 注入面(快照 hook + 表单动作)。 */
export interface WecomCardProps {
  t: (key: WecomLocaleKey) => string
  useWecomCard: <T>(selector: (state: WecomCardState) => T) => T
  edit: (field: string, text: string) => void
  resetField: (field: string) => void
  save: () => void
  discard: () => void
}

const fieldStyle: React.CSSProperties = {
  flexDirection: 'column',
  gap: 6,
  padding: '12px 0',
  display: 'flex',
  borderTop: '1px solid var(--dsw-alias-border-l2, #eee)',
}
const headStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8 }
const labelStyle: React.CSSProperties = {
  minWidth: 0,
  color: 'var(--dsw-alias-label-primary, #222)',
  flex: 1,
  fontSize: 13,
  fontWeight: 500,
  lineHeight: 1.5,
}
const badgeStyle: React.CSSProperties = {
  whiteSpace: 'nowrap',
  background: 'var(--dsw-alias-bg-module-platform, #f0f0f0)',
  color: 'var(--dsw-alias-label-secondary, #666)',
  borderRadius: 999,
  padding: '1px 8px',
  fontSize: 11,
  fontWeight: 500,
  lineHeight: '17px',
}
const resetStyle: React.CSSProperties = {
  font: 'inherit',
  color: 'var(--dsw-alias-label-secondary, #666)',
  cursor: 'pointer',
  background: 'none',
  border: 'none',
  padding: 0,
  fontSize: 12,
  lineHeight: 1.5,
}
const inputStyle: React.CSSProperties = {
  border: '1px solid var(--dsw-alias-border-l2, #ddd)',
  background: 'var(--dsw-alias-bg-layer-3, #fff)',
  height: 34,
  font: 'inherit',
  color: 'var(--dsw-alias-label-primary, #222)',
  borderRadius: 8,
  padding: '0 12px',
  fontSize: 13,
  lineHeight: 1.5,
}
const hintStyle: React.CSSProperties = {
  color: 'var(--dsw-alias-label-tertiary, #999)',
  margin: 0,
  fontSize: 12,
  lineHeight: 1.5,
}
const invalidStyle: React.CSSProperties = {
  ...hintStyle,
  color: 'var(--dsw-alias-label-error, #d33)',
}
const selectStyle: React.CSSProperties = { ...inputStyle, height: 34 }

interface FieldProps {
  id: string
  label: string
  hint: string
  text: string
  overridden: boolean
  invalid: boolean
  overriddenLabel: string
  resetLabel: string
  invalidLabel: string
  disabled: boolean
  onEdit: (text: string) => void
  onReset: () => void
  password?: boolean
  numeric?: boolean
  placeholder?: string
}

function Field(props: FieldProps) {
  return (
    <div style={fieldStyle}>
      <div style={headStyle}>
        <label style={labelStyle} htmlFor={props.id}>{props.label}</label>
        {props.overridden
          ? (
            <span style={{ alignItems: 'center', gap: 8, display: 'inline-flex' }}>
              <span style={badgeStyle}>{props.overriddenLabel}</span>
              <button type="button" style={resetStyle} disabled={props.disabled} onClick={props.onReset}>
                {props.resetLabel}
              </button>
            </span>
          )
          : null}
      </div>
      <input
        id={props.id}
        style={{ ...inputStyle, borderColor: props.invalid ? 'var(--dsw-alias-label-error, #d33)' : undefined }}
        type={props.password ? 'password' : 'text'}
        {...props.numeric ? { inputMode: 'numeric' as const } : {}}
        {...props.invalid ? { 'aria-invalid': true } : {}}
        value={props.text}
        placeholder={props.placeholder ?? ''}
        disabled={props.disabled}
        onChange={(event) => { props.onEdit(event.target.value) }}
      />
      <p style={props.invalid ? invalidStyle : hintStyle}>
        {props.invalid ? props.invalidLabel : props.hint}
      </p>
    </div>
  )
}

interface SelectProps {
  id: string
  label: string
  hint: string
  text: string
  overridden: boolean
  overriddenLabel: string
  resetLabel: string
  disabled: boolean
  options: { value: string; label: string }[]
  emptyLabel: string
  placeholder: string
  onEdit: (text: string) => void
  onReset: () => void
}

function SelectField(props: SelectProps) {
  const hasText = props.options.some(o => o.value === props.text)
  const options = props.text && !hasText
    ? [{ value: props.text, label: props.text }, ...props.options]
    : props.options
  return (
    <div style={fieldStyle}>
      <div style={headStyle}>
        <label style={labelStyle} htmlFor={props.id}>{props.label}</label>
        {props.overridden
          ? (
            <span style={{ alignItems: 'center', gap: 8, display: 'inline-flex' }}>
              <span style={badgeStyle}>{props.overriddenLabel}</span>
              <button type="button" style={resetStyle} disabled={props.disabled} onClick={props.onReset}>
                {props.resetLabel}
              </button>
            </span>
          )
          : null}
      </div>
      <select
        id={props.id}
        style={selectStyle}
        value={props.text}
        disabled={props.disabled}
        onChange={(event) => { props.onEdit(event.target.value) }}
      >
        <option value="">{props.emptyLabel}</option>
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <p style={hintStyle}>{props.hint}</p>
    </div>
  )
}

/**
 * 渲染企业微信机器人配置卡片。
 * @param props - locale、快照 hook 与表单动作。
 * @returns 卡片;命名空间不可用时渲染为空。
 */
export function WecomCard(props: WecomCardProps) {
  const state = props.useWecomCard((s) => s)
  const [open, setOpen] = useState(false)
  const { t } = props
  if (!state.available) return null
  const blocked = !state.dirty || state.invalid || state.saving
  return (
    <li style={{
      border: '1px solid var(--dsw-alias-border-l2, #eee)',
      borderRadius: 10,
      background: 'var(--dsw-alias-bg-layer-2, #fafafa)',
      marginBottom: 8,
      listStyle: 'none',
    }}>
      <button
        type="button"
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '12px 16px',
          font: 'inherit',
          fontSize: 14,
          fontWeight: 600,
          color: 'var(--dsw-alias-label-primary, #222)',
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          textAlign: 'left',
        }}
        aria-expanded={open}
        onClick={() => { setOpen(!open) }}
      >
        <span style={{ flex: 1 }}>{t('wecomTitle')}</span>
        {state.dirty ? <span style={badgeStyle}>{t('unsaved')}</span> : null}
        <span style={{
          display: 'inline-flex',
          color: 'var(--dsw-alias-label-secondary, #666)',
          transition: 'transform 0.15s ease',
          transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
        }}>
          <IconChevronDownOutline14 />
        </span>
      </button>
      {open
        ? (
          <div style={{ padding: '0 16px 16px' }}>
            <p style={{ ...hintStyle, margin: '0 0 8px' }}>{t('wecomDescription')}</p>
            <Field
              id="wecom-botId"
              label={t('botId')}
              hint={t('botIdHint')}
              text={state.fields.botId.text}
              overridden={state.fields.botId.overridden}
              invalid={state.fields.botId.invalid}
              overriddenLabel={t('overridden')}
              resetLabel={t('reset')}
              invalidLabel={t('invalidNumber')}
              disabled={!state.writable}
              onEdit={(v) => { props.edit('botId', v) }}
              onReset={() => { props.resetField('botId') }}
            />
            <Field
              id="wecom-botSecret"
              label={t('botSecret')}
              hint={t('botSecretHint')}
              text={state.fields.botSecret.text}
              overridden={state.fields.botSecret.overridden}
              invalid={state.fields.botSecret.invalid}
              overriddenLabel={t('overridden')}
              resetLabel={t('reset')}
              invalidLabel={t('invalidNumber')}
              disabled={!state.writable}
              onEdit={(v) => { props.edit('botSecret', v) }}
              onReset={() => { props.resetField('botSecret') }}
              password
            />
            <SelectField
              id="wecom-provider"
              label={t('provider')}
              hint={t('providerHint')}
              text={state.fields.provider.text}
              overridden={state.fields.provider.overridden}
              overriddenLabel={t('overridden')}
              resetLabel={t('reset')}
              disabled={!state.writable}
              options={state.providers.map((p: ProviderEntry) => ({ value: p.id, label: p.name }))}
              emptyLabel={t('emptyProviderOption')}
              placeholder={t('providerPlaceholder')}
              onEdit={(v) => { props.edit('provider', v) }}
              onReset={() => { props.resetField('provider') }}
            />
            <SelectField
              id="wecom-model"
              label={t('model')}
              hint={t('modelHint')}
              text={state.fields.model.text}
              overridden={state.fields.model.overridden}
              overriddenLabel={t('overridden')}
              resetLabel={t('reset')}
              disabled={!state.writable}
              options={state.providerModels.map(m => ({ value: m.id, label: m.label }))}
              emptyLabel={t('emptyModelOption')}
              placeholder={t('modelPlaceholder')}
              onEdit={(v) => { props.edit('model', v) }}
              onReset={() => { props.resetField('model') }}
            />
            <Field
              id="wecom-workspace"
              label={t('workspace')}
              hint={t('workspaceHint')}
              text={state.fields.workspace.text}
              overridden={state.fields.workspace.overridden}
              invalid={state.fields.workspace.invalid}
              overriddenLabel={t('overridden')}
              resetLabel={t('reset')}
              invalidLabel={t('invalidNumber')}
              disabled={!state.writable}
              onEdit={(v) => { props.edit('workspace', v) }}
              onReset={() => { props.resetField('workspace') }}
            />
            <Field
              id="wecom-maxTokens"
              label={t('maxTokens')}
              hint={t('maxTokensHint')}
              text={state.fields.maxTokens.text}
              overridden={state.fields.maxTokens.overridden}
              invalid={state.fields.maxTokens.invalid}
              overriddenLabel={t('overridden')}
              resetLabel={t('reset')}
              invalidLabel={t('invalidNumber')}
              disabled={!state.writable}
              numeric
              onEdit={(v) => { props.edit('maxTokens', v) }}
              onReset={() => { props.resetField('maxTokens') }}
            />
            <Field
              id="wecom-taskPrefix"
              label={t('taskPrefix')}
              hint={t('taskPrefixHint')}
              text={state.fields.taskPrefix.text}
              overridden={state.fields.taskPrefix.overridden}
              invalid={state.fields.taskPrefix.invalid}
              overriddenLabel={t('overridden')}
              resetLabel={t('reset')}
              invalidLabel={t('invalidNumber')}
              disabled={!state.writable}
              onEdit={(v) => { props.edit('taskPrefix', v) }}
              onReset={() => { props.resetField('taskPrefix') }}
            />
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'flex-end', paddingTop: 8 }}>
              {state.failed
                ? <p style={{ ...invalidStyle, margin: '0 auto 0 0' }}>{t('saveFailed')}</p>
                : null}
              <button
                type="button"
                style={{ ...resetStyle, padding: '6px 14px', border: '1px solid var(--dsw-alias-border-l2, #ddd)', borderRadius: 8 }}
                disabled={!state.dirty}
                onClick={props.discard}
              >
                {t('discard')}
              </button>
              <button
                type="button"
                style={{
                  font: 'inherit',
                  fontSize: 13,
                  fontWeight: 500,
                  color: '#fff',
                  background: 'var(--dsw-alias-brand-primary, #4c6ef5)',
                  border: 'none',
                  borderRadius: 8,
                  padding: '6px 16px',
                  cursor: blocked ? 'default' : 'pointer',
                  opacity: blocked ? 0.6 : 1,
                }}
                disabled={blocked}
                onClick={props.save}
              >
                {state.saving ? t('saving') : t('save')}
              </button>
            </div>
          </div>
        )
        : null}
    </li>
  )
}
