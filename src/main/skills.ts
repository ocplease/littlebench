import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, symlinkSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { skillsDir } from './paths'

/** Ensure every managed skill is symlinked into <targetDir>/.claude/skills/
 *  so a claude session started with cwd=targetDir discovers them as
 *  project-level skills. Idempotent and self-healing. */
export function installSkills(targetDir: string): void {
  const src = skillsDir()
  if (!existsSync(src)) return
  const dest = path.join(targetDir, '.claude', 'skills')
  mkdirSync(dest, { recursive: true })
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    if (!existsSync(path.join(src, entry.name, 'SKILL.md'))) continue // not a skill
    const from = path.join(src, entry.name)
    const to = path.join(dest, entry.name)
    try {
      const st = lstatSync(to)
      if (st.isSymbolicLink()) {
        try {
          if (realpathSync(to) === realpathSync(from)) continue // already correct
        } catch {
          /* dangling link - fall through to recreate */
        }
        unlinkSync(to) // wrong target or broken: refresh
      } else {
        continue // real file/dir: never clobber a hand-placed skill
      }
    } catch {
      /* nothing there yet */
    }
    try {
      symlinkSync(from, to, 'dir')
    } catch (e) {
      console.warn(`skills: failed to link ${entry.name} into ${targetDir}:`, e)
    }
  }
}
