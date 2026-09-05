import { dialog, BrowserWindow } from 'electron'
import { mkdirSync, copyFileSync, statSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { workbenchRoot, jobWorkspace } from './paths'

/** One file the user attached in a composer. `content` is populated for small
 *  text files so the foreman (which can't Read/Bash arbitrary files) can act
 *  on it inline; binary or oversized files carry only a path. */
export interface Attachment {
  /** original filename, e.g. "design.md" */
  name: string
  /** absolute path inside the agent's reachable filesystem - the workspace
   *  for jobs, a foreman-attachments/ subdir for chat */
  path: string
  /** bytes */
  size: number
  /** MIME type, best-effort from the file extension */
  type: string
  /** populated for text files <= INLINE_MAX_BYTES */
  content?: string
}

const INLINE_MAX_BYTES = 64 * 1024

const TEXT_EXTS = new Set([
  '.md', '.txt', '.json', '.yaml', '.yml', '.csv', '.tsv',
  '.js', '.ts', '.tsx', '.jsx', '.mjs', '.cjs',
  '.py', '.rb', '.rs', '.go', '.java', '.kt', '.swift',
  '.sh', '.bash', '.zsh', '.fish',
  '.html', '.htm', '.xml', '.svg', '.css', '.scss', '.sass', '.less',
  '.env', '.ini', '.toml', '.cfg', '.conf',
  '.sql', '.graphql', '.proto'
])

function guessType(name: string): string {
  const ext = path.extname(name).toLowerCase()
  if (!ext) return 'application/octet-stream'
  const map: Record<string, string> = {
    '.md': 'text/markdown', '.txt': 'text/plain', '.json': 'application/json',
    '.yaml': 'text/yaml', '.yml': 'text/yaml', '.csv': 'text/csv',
    '.js': 'text/javascript', '.ts': 'text/typescript', '.tsx': 'text/typescript',
    '.jsx': 'text/javascript', '.py': 'text/x-python', '.rb': 'text/x-ruby',
    '.rs': 'text/x-rust', '.go': 'text/x-go', '.java': 'text/x-java',
    '.kt': 'text/x-kotlin', '.swift': 'text/x-swift', '.sh': 'text/x-shellscript',
    '.html': 'text/html', '.htm': 'text/html', '.xml': 'application/xml',
    '.svg': 'image/svg+xml', '.css': 'text/css', '.scss': 'text/x-scss',
    '.sql': 'text/x-sql', '.env': 'text/plain', '.ini': 'text/plain',
    '.toml': 'text/x-toml',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.webp': 'image/webp', '.gif': 'image/gif', '.pdf': 'application/pdf'
  }
  return map[ext] ?? 'application/octet-stream'
}

function isTextExt(name: string): boolean {
  return TEXT_EXTS.has(path.extname(name).toLowerCase())
}

/** Stable per-send subdirectory so two attachment bursts don't collide. */
function dirFor(target: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-') + '-' + Math.random().toString(36).slice(2, 8)
  return target === 'foreman'
    ? path.join(workbenchRoot(), 'foreman-attachments', stamp)
    : path.join(jobWorkspace(target), 'attachments', stamp)
}

/** Open the system file picker, then copy the chosen files into the right
 *  place for the target composer and return rich metadata. */
export async function pickAndAttach(target: string, win: BrowserWindow | null): Promise<Attachment[]> {
  const res = await dialog.showOpenDialog(win ?? undefined!, {
    title: target === 'foreman' ? 'Attach files to Steven' : 'Attach files to the builder',
    properties: ['openFile', 'multiSelections']
  })
  if (res.canceled || res.filePaths.length === 0) return []
  return attachPaths(target, res.filePaths)
}

/** Copy paths into the right place and return metadata. Use this when the
 *  renderer already has paths (e.g. drag-and-drop later). */
export function attachPaths(target: string, sourcePaths: string[]): Attachment[] {
  if (sourcePaths.length === 0) return []
  const dir = dirFor(target)
  mkdirSync(dir, { recursive: true })
  const out: Attachment[] = []
  for (const src of sourcePaths) {
    let stat
    try { stat = statSync(src) } catch { continue }
    if (!stat.isFile()) continue
    const name = path.basename(src)
    // Same-name collisions in a single send: suffix with a counter.
    let dst = path.join(dir, name)
    if (exists(dst)) {
      const ext = path.extname(name)
      const stem = name.slice(0, name.length - ext.length)
      for (let n = 2; n < 1000; n++) {
        dst = path.join(dir, `${stem}-${n}${ext}`)
        if (!exists(dst)) break
      }
    }
    copyFileSync(src, dst)
    let content: string | undefined
    if (isTextExt(name) && stat.size <= INLINE_MAX_BYTES) {
      try { content = readFileSync(dst, 'utf8') } catch { /* binary after all - skip */ }
    }
    out.push({ name, path: dst, size: stat.size, type: guessType(name), content })
  }
  return out
}

function exists(p: string): boolean {
  try { statSync(p); return true } catch { return false }
}
