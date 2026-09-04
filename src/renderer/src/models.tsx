/** Shared model picker for the chat composer and Settings. The foreman and
 *  per-job builders both read the `model` setting, so a single component
 *  drives both surfaces and the picker can be reused in any view. */

import { useEffect, useState } from 'react'
import type { Settings } from './types'

export const MODEL_OPTIONS = [
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'opus', label: 'Opus' },
  { value: 'haiku', label: 'Haiku' }
] as const

export const DEFAULT_MODEL = 'sonnet'

/** Display label for any value the picker accepts, including legacy / custom
 *  values that aren't in MODEL_OPTIONS (renders the raw string then). */
export function modelLabel(value: string | null | undefined): string {
  const v = (value ?? '').trim() || DEFAULT_MODEL
  const found = MODEL_OPTIONS.find((o) => o.value === v)
  return found ? found.label : v
}

/** A small <select> bound to the global `model` setting. Used in the chat
 *  composer and inside Settings. Writes through window.api.setSettings so
 *  the main process picks up the new value on the next agent launch. */
export function ModelPicker({ className, id }: { className?: string; id?: string }) {
  const [value, setValue] = useState<string>(DEFAULT_MODEL)

  useEffect(() => {
    let mounted = true
    window.api.getSettings().then((s) => {
      if (!mounted) return
      const next = (s as Settings).model?.trim() || DEFAULT_MODEL
      setValue(next)
    })
    const off = window.api.on('settings:changed', () => {
      window.api.getSettings().then((s) => {
        if (!mounted) return
        const next = (s as Settings).model?.trim() || DEFAULT_MODEL
        setValue(next)
      })
    })
    return () => {
      mounted = false
      off()
    }
  }, [])

  const onChange = (next: string) => {
    setValue(next)
    void window.api.setSettings({ model: next })
  }

  return (
    <select
      id={id}
      className={className ?? 'model-picker'}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      title="Agent model (applies to foreman and the next job you queue)"
    >
      {MODEL_OPTIONS.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
      {!MODEL_OPTIONS.some((o) => o.value === value) && value && (
        <option value={value}>{value}</option>
      )}
    </select>
  )
}
