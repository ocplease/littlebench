import { useEffect, useState } from 'react'
import type { Settings } from '../types'

export default function SettingsView() {
  const [s, setS] = useState<Settings | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    window.api.getSettings().then((v) => setS(v as Settings))
  }, [])

  if (!s) return <div className="empty">Loading…</div>

  const save = async () => {
    await window.api.setSettings(s as unknown as Record<string, string>)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  return (
    <div className="settings">
      <h2>Settings</h2>
      <div className="setting-row">
        <label>
          Agent model
          <span className="muted small">blank = default</span>
        </label>
        <input value={s.model} onChange={(e) => setS({ ...s, model: e.target.value })} placeholder="sonnet / opus / …" />
      </div>
      <div className="setting-row">
        <label>Triage model</label>
        <input value={s.triageModel} onChange={(e) => setS({ ...s, triageModel: e.target.value })} placeholder="haiku" />
      </div>
      <div className="setting-row">
        <label>
          Auto-advance queue
          <span className="muted small">start the next queued job when the current one finishes</span>
        </label>
        <input
          type="checkbox"
          checked={s.autoQueue === 'true'}
          onChange={(e) => setS({ ...s, autoQueue: e.target.checked ? 'true' : 'false' })}
        />
      </div>
      <div className="setting-row">
        <label>
          Bypass permissions
          <span className="muted small">
            agent runs unattended with all tools allowed (recommended for the full pipeline; allowlist mode
            will stall on unexpected Bash commands)
          </span>
        </label>
        <input
          type="checkbox"
          checked={s.bypassPermissions === 'true'}
          onChange={(e) => setS({ ...s, bypassPermissions: e.target.checked ? 'true' : 'false' })}
        />
      </div>
      <div className="setting-row">
        <label>
          Max videos per ingest
        </label>
        <input value={s.maxVideos} onChange={(e) => setS({ ...s, maxVideos: e.target.value })} />
      </div>
      <div className="setting-row">
        <label>
          Worker slots
          <span className="muted small">concurrent builder sessions (card0 uploads are serialized per game)</span>
        </label>
        <input
          value={s.maxWorkers}
          onChange={(e) => setS({ ...s, maxWorkers: e.target.value })}
          placeholder="3"
        />
      </div>
      <div className="setting-row">
        <label>
          Auto-localize every game
          <span className="muted small">queue zh-Hans + ja builds when the English game lands in review</span>
        </label>
        <input
          type="checkbox"
          checked={s.autoLocalize === 'true'}
          onChange={(e) => setS({ ...s, autoLocalize: e.target.checked ? 'true' : 'false' })}
        />
      </div>
      <div className="setting-row column">
        <label>
          Claude API keys
          <span className="muted small">
            one per line - builders and the foreman rotate through them so one 5h quota window
            doesn't stall the factory. A key that hits 429 is skipped until its window resets.
            Leave empty to use your default login. Stored only in the local workbench DB.
          </span>
        </label>
        <textarea
          rows={3}
          className="key-input"
          spellCheck={false}
          value={s.claudeApiKeys}
          onChange={(e) => setS({ ...s, claudeApiKeys: e.target.value })}
          placeholder={'ark-…\nark-…'}
        />
      </div>
      <div className="setting-row column">
        <label>
          Image generation API keys
          <span className="muted small">
            one per line - Seedream art generation rotates through these independently of the
            claude keys. Leave empty to reuse the claude key / default login.
          </span>
        </label>
        <textarea
          rows={3}
          className="key-input"
          spellCheck={false}
          value={s.imageApiKeys}
          onChange={(e) => setS({ ...s, imageApiKeys: e.target.value })}
          placeholder={'ark-…\nark-…'}
        />
      </div>
      <button className="primary" onClick={save}>
        {saved ? 'Saved ✓' : 'Save'}
      </button>
    </div>
  )
}
