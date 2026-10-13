export type Segment = { name: string; tokens: number; color: string; kind: 'used' | 'free' | 'buffer' }
export type Gauge = { used: number; max: number; segments: Segment[] }
export type SharedCache = { warm: boolean; expiresAt: number | null; writtenAt: number }
export type Consumer = { name: string; tokens: number }
export type Details = {
  model: string
  isFull: boolean
  used: number
  max: number
  segments: Segment[]
  groups: { title: string; items: Consumer[] }[]
}

declare module 'claude-code' {
  interface PluginState {
    'context-gauge': {
      gauge: Gauge | null
      details: Details | null
      lastResponseAt: number | null
      shared: SharedCache | null
      now: number
      warnedAt: number | null
    }
  }
}
