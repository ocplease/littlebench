import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { Settings, Card0AccountInfo, Card0AuthResult } from '../types'
import { MODEL_OPTIONS, DEFAULT_MODEL } from '../models'

type Card0State = Card0AccountInfo | { loading: true }

// ---------- tiny building blocks ----------

function Toggle({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className={`st-switch${disabled ? ' is-disabled' : ''}`}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="st-switch-track" />
    </label>
  )
}

function Segmented({
  options, value, onChange
}: {
  options: ReadonlyArray<{ value: string; label: string }>
  value: string
  onChange: (v: string) => void
}) {
  return (
    <div className="st-seg" role="radiogroup">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          className={value === o.value ? 'is-active' : ''}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

function Section({ icon, title, desc, children }: { icon: ReactNode; title: string; desc: string; children: ReactNode }) {
  return (
    <section className="st-section">
      <header className="st-section-head">
        <div className="st-section-icon">{icon}</div>
        <div className="st-section-copy">
          <div className="st-section-title">{title}</div>
          <div className="st-section-desc">{desc}</div>
        </div>
      </header>
      <div className="st-section-body">{children}</div>
    </section>
  )
}

function Row({ title, desc, children }: { title: string; desc?: string; children?: ReactNode }) {
  return (
    <div className="st-row">
      <div className="st-row-label">
        <div className="st-row-title">{title}</div>
        {desc && <div className="st-row-desc">{desc}</div>}
      </div>
      <div className="st-row-ctrl">{children}</div>
    </div>
  )
}

// ---------- icons (16px, stroke) ----------

function IconUser() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.4">
      <circle cx="8" cy="5.5" r="3" />
      <path d="M2.5 14c.8-2.6 2.9-4 5.5-4s4.7 1.4 5.5 4" strokeLinecap="round" />
    </svg>
  )
}

function IconSpark() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.4">
      <path d="M8 1.5l1.2 3.3L12.5 6 9.2 7.2 8 10.5 6.8 7.2 3.5 6l3.3-1.2L8 1.5z" strokeLinejoin="round" />
      <path d="M12.5 10.5l.6 1.6 1.6.6-1.6.6-.6 1.6-.6-1.6-1.6-.6 1.6-.6.6-1.6z" strokeLinejoin="round" />
    </svg>
  )
}

function IconFlow() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.4">
      <rect x="1.5" y="2" width="4.5" height="3.5" rx="1" />
      <rect x="1.5" y="10.5" width="4.5" height="3.5" rx="1" />
      <rect x="10" y="6.2" width="4.5" height="3.5" rx="1" />
      <path d="M6 3.75h2.25a1.5 1.5 0 0 1 1.5 1.5v1.45M6 12.25h2.25a1.5 1.5 0 0 0 1.5-1.5v-1.6" strokeLinecap="round" />
    </svg>
  )
}

function IconKey() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.4">
      <circle cx="5.5" cy="10.5" r="3" />
      <path d="M7.6 8.4L13 3m-1.8 1.8L13 6.6M9.9 6.1l1.3 1.3" strokeLinecap="round" />
    </svg>
  )
}

function GoogleG() {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden>
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
      <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
    </svg>
  )
}

// ---------- main view ----------

export default function SettingsView() {
  const [s, setS] = useState<Settings | null>(null)
  const [snapshot, setSnapshot] = useState('')
  const [saved, setSaved] = useState(false)
  const [card0, setCard0] = useState<Card0State>({ loading: true })
  const [card0Msg, setCard0Msg] = useState<string | null>(null)
  const pollRef = useRef<number | null>(null)

  useEffect(() => {
    window.api.getSettings().then((v) => {
      // A blank model must never display as "Sonnet" while saving nothing -
      // that's how builds silently run on the CLI's own default model.
      const s = v as Settings
      if (!s.model?.trim()) s.model = DEFAULT_MODEL
      if (!s.triageModel?.trim()) s.triageModel = 'haiku'
      setS(s)
      setSnapshot(JSON.stringify(s))
    })
  }, [])

  useEffect(() => {
    refreshCard0()
    // main process tells us when a login child finished / logout happened
    const off = window.api.on('card0:authChanged', () => {
      refreshCard0()
    })
    return off
  }, [])

  // After opening the OAuth flow, poll for a few minutes — the user is in
  // their browser authorising, and `card0 account info` flips the moment
  // the CLI persists the new session.
  const startPolling = (ms = 180_000) => {
    if (pollRef.current) window.clearInterval(pollRef.current)
    const start = Date.now()
    pollRef.current = window.setInterval(async () => {
      if (Date.now() - start > ms) {
        if (pollRef.current) window.clearInterval(pollRef.current)
        pollRef.current = null
        return
      }
      try {
        const info = await window.api.card0AccountInfo()
        if (info.ok) {
          if (pollRef.current) window.clearInterval(pollRef.current)
          pollRef.current = null
          setCard0(info)
          setCard0Msg(null)
        }
      } catch {
        // transient IPC error - keep polling
      }
    }, 2_000)
  }

  useEffect(() => {
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current)
    }
  }, [])

  const refreshCard0 = async () => {
    setCard0({ loading: true })
    try {
      const info = await window.api.card0AccountInfo()
      setCard0(info)
    } catch (e) {
      setCard0({ ok: false, reason: 'unknown', message: `failed to check card0 session: ${String(e)}` })
    }
  }

  if (!s) return <div className="empty">Loading…</div>

  const dirty = snapshot !== '' && JSON.stringify(s) !== snapshot

  const save = async () => {
    await window.api.setSettings(s as unknown as Record<string, string>)
    setSnapshot(JSON.stringify(s))
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  const discard = () => {
    if (snapshot) setS(JSON.parse(snapshot) as Settings)
  }

  // ---------- card0 handlers ----------

  const handleLoginWeb = async () => {
    setCard0Msg(null)
    try {
      const r: Card0AuthResult = await window.api.card0LoginWeb({ provider: 'google' })
      if (!r.ok) {
        setCard0Msg(r.error)
        return
      }
      setCard0Msg('Login page opened in your browser — finish signing in and this card updates automatically.')
      startPolling()
    } catch (e) {
      setCard0Msg(`failed to open login: ${String(e)}`)
    }
  }

  const handleLogout = async () => {
    setCard0Msg(null)
    try {
      const r: Card0AuthResult = await window.api.card0Logout()
      if (!r.ok) {
        setCard0Msg(r.error)
        return
      }
      await refreshCard0()
    } catch (e) {
      setCard0Msg(`failed to log out: ${String(e)}`)
    }
  }

  // ---------- card0 render ----------

  const renderAccount = () => {
    if ('loading' in card0) {
      return <div className="st-account st-account-loading"><span className="spinner" /> Checking your card0 session…</div>
    }
    if (card0.ok) {
      const a = card0.account
      const label = a.email ?? a.name ?? a.id ?? 'Signed in'
      const initial = (label[0] ?? '?').toUpperCase()
      return (
        <div className="st-account st-account-in">
          {a.avatar_url ? (
            <img className="st-avatar st-avatar-img" src={a.avatar_url} alt="" />
          ) : (
            <div className="st-avatar">{initial}</div>
          )}
          <div className="st-account-id">
            {a.name && a.name !== label ? (
              <>
                <div className="st-account-email">{a.name}</div>
                <div className="st-account-sub">{label}</div>
              </>
            ) : (
              <div className="st-account-email">{label}</div>
            )}
            <div className="st-account-badge">
              <span className="st-dot st-dot-ok" /> Connected
            </div>
          </div>
          <button className="st-btn-danger" onClick={handleLogout}>Sign out</button>
        </div>
      )
    }

    const authMissing = card0.reason === 'auth_required'
    return (
      <div className="st-account st-account-out">
        {authMissing ? (
          <div className="st-account-warn">
            <span className="st-dot st-dot-warn" /> Not connected — publishing and status sync need a card0 session.
          </div>
        ) : (
          <div className="st-account-warn">
            <span className="st-dot st-dot-warn" /> {card0.message}
            <button className="st-linklike" onClick={() => refreshCard0()}>Retry</button>
          </div>
        )}

        <button className="st-google-btn" onClick={handleLoginWeb}>
          <GoogleG /> Continue with Google
        </button>

        <div className="st-account-hint">
          Already signed into card0.app in this browser? This completes instantly.
        </div>

        {card0Msg && <div className="st-account-msg">{card0Msg}</div>}
      </div>
    )
  }

  // ---------- view ----------

  const modelKnown = MODEL_OPTIONS.some((o) => o.value === s.model)
  const triageKnown = MODEL_OPTIONS.some((o) => o.value === s.triageModel)

  return (
    <div className="st-page">
      <header className="st-header">
        <h2>Settings</h2>
        <p>Preferences are stored locally in the workbench database.</p>
      </header>

      <Section
        icon={<IconUser />}
        title="Card0 account"
        desc="Session used to publish games and sync their status. Sign in again whenever it expires."
      >
        {renderAccount()}
      </Section>

      <Section
        icon={<IconSpark />}
        title="Agents"
        desc="Models and behavior for Steven (the foreman) and every builder job."
      >
        <Row
          title="Agent model"
          desc={`Used by Steven and new builder jobs. Default: ${DEFAULT_MODEL}.`}
        >
          <Segmented
            options={MODEL_OPTIONS}
            value={modelKnown ? s.model : MODEL_OPTIONS[0].value}
            onChange={(v) => setS({ ...s, model: v })}
          />
        </Row>
        {!modelKnown && (
          <Row title="Custom model id" desc="Legacy value kept for compatibility.">
            <input value={s.model} onChange={(e) => setS({ ...s, model: e.target.value })} />
          </Row>
        )}
        <Row
          title="Triage model"
          desc="Fast model that screens incoming videos for game potential."
        >
          <Segmented
            options={MODEL_OPTIONS}
            value={triageKnown ? s.triageModel : MODEL_OPTIONS[0].value}
            onChange={(v) => setS({ ...s, triageModel: v })}
          />
        </Row>
        {!triageKnown && (
          <Row title="Custom triage id" desc="Legacy value kept for compatibility.">
            <input value={s.triageModel} onChange={(e) => setS({ ...s, triageModel: e.target.value })} />
          </Row>
        )}
        <Row
          title="Auto-generate card images"
          desc="On: builders generate every card image automatically. Off: builders pause and ask before calling Seedream for card art — the cover and rule visuals still generate on their own."
        >
          <Toggle checked={s.autoImageGen === 'true'} onChange={(v) => setS({ ...s, autoImageGen: v ? 'true' : 'false' })} />
        </Row>
      </Section>

      <Section
        icon={<IconFlow />}
        title="Pipeline"
        desc="How the factory moves videos from queue to published game."
      >
        <Row title="Auto-advance queue" desc="Start the next queued job when the current one finishes.">
          <Toggle checked={s.autoQueue === 'true'} onChange={(v) => setS({ ...s, autoQueue: v ? 'true' : 'false' })} />
        </Row>
        <Row
          title="Bypass permissions"
          desc="Agents run unattended with all tools allowed. Recommended for the full pipeline — allowlist mode stalls on unexpected Bash commands."
        >
          <Toggle checked={s.bypassPermissions === 'true'} onChange={(v) => setS({ ...s, bypassPermissions: v ? 'true' : 'false' })} />
        </Row>
        <Row title="Auto-localize every game" desc="Queue zh-Hans + ja builds when the English game lands in review.">
          <Toggle checked={s.autoLocalize === 'true'} onChange={(v) => setS({ ...s, autoLocalize: v ? 'true' : 'false' })} />
        </Row>
        <Row title="Worker slots" desc="Concurrent builder sessions. Card0 uploads stay serialized per game.">
          <input
            className="st-num"
            type="number"
            min={1}
            value={s.maxWorkers}
            onChange={(e) => setS({ ...s, maxWorkers: e.target.value })}
            placeholder="3"
          />
        </Row>
        <Row title="Max videos per ingest" desc="Cap on how many videos one channel ingest pulls in.">
          <input
            className="st-num"
            type="number"
            min={1}
            value={s.maxVideos}
            onChange={(e) => setS({ ...s, maxVideos: e.target.value })}
          />
        </Row>
      </Section>

      <Section
        icon={<IconKey />}
        title="API keys"
        desc="Rotated per request and stored only in the local workbench DB. Leave empty to use your default login."
      >
        <div className="st-row st-row-col">
          <div className="st-row-label">
            <div className="st-row-title">Claude API keys</div>
            <div className="st-row-desc">
              One per line — builders and Steven rotate through them so one 5h quota window doesn't stall the factory. A key that hits 429 cools down until its window resets.
            </div>
          </div>
          <textarea
            rows={3}
            className="key-input"
            spellCheck={false}
            value={s.claudeApiKeys}
            onChange={(e) => setS({ ...s, claudeApiKeys: e.target.value })}
            placeholder={'ark-…\nark-…'}
          />
        </div>
        <div className="st-row st-row-col">
          <div className="st-row-label">
            <div className="st-row-title">Image generation keys</div>
            <div className="st-row-desc">
              One per line — Seedream art generation rotates through these independently of the Claude keys. Empty reuses the Claude key / default login.
            </div>
          </div>
          <textarea
            rows={3}
            className="key-input"
            spellCheck={false}
            value={s.imageApiKeys}
            onChange={(e) => setS({ ...s, imageApiKeys: e.target.value })}
            placeholder={'ark-…\nark-…'}
          />
        </div>
      </Section>

      {(dirty || saved) && (
        <div className="st-savebar">
          <span className="st-savebar-note">
            {saved ? 'All changes saved.' : 'You have unsaved changes.'}
          </span>
          <div className="st-savebar-actions">
            {!saved && dirty && (
              <button className="st-btn-ghost" onClick={discard}>Discard</button>
            )}
            <button className="st-btn-accent" onClick={save} disabled={!dirty && !saved}>
              {saved ? 'Saved ✓' : 'Save changes'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
