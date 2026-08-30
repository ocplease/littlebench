import type { WorkbenchApi } from '../../preload/api-types'

declare global {
  interface Window {
    api: WorkbenchApi
  }
}

export {}
