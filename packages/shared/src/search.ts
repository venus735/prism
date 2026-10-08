import type { FlowSummary } from './flow'

export type FilterNode = { type: 'text'; value: string } | { type: 'kv'; key: string; value: string }

const KNOWN_KEYS = new Set([
  'host',
  'path',
  'url',
  'method',
  'status',
  'body',
  'type',
  'flag',
  'has',
  'sni',
  'app',
  'ip',
  'label',
  'note',
  'trace'
])

export function parseFilter(input: string): FilterNode[] {
  const nodes: FilterNode[] = []
  const tokens = tokenize(input)
  for (const token of tokens) {
    const colon = token.indexOf(':')
    if (colon > 0) {
      const key = token.slice(0, colon).toLowerCase()
      let value = token.slice(colon + 1)
      if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
        value = value.slice(1, -1)
      }
      if (KNOWN_KEYS.has(key) && value) {
        nodes.push({ type: 'kv', key, value: value.toLowerCase() })
        continue
      }
    }
    if (token) nodes.push({ type: 'text', value: token.toLowerCase() })
  }
  return nodes
}

function tokenize(input: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quoted = false
  for (const ch of input) {
    if (ch === '"') {
      quoted = !quoted
      current += ch
    } else if (/\s/.test(ch) && !quoted) {
      if (current) tokens.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  if (current) tokens.push(current)
  return tokens
}

export function matchSummary(summary: FlowSummary, nodes: FilterNode[]): boolean {
  for (const node of nodes) {
    if (!matchNode(summary, node)) return false
  }
  return true
}

function matchNode(summary: FlowSummary, node: FilterNode): boolean {
  if (node.type === 'text') {
    const hay = `${summary.host ?? ''} ${summary.path ?? ''} ${summary.url ?? ''}`.toLowerCase()
    return hay.includes(node.value)
  }
  const value = node.value
  switch (node.key) {
    case 'host':
      return (summary.host ?? '').toLowerCase().includes(value)
    case 'path':
      return (summary.path ?? '').toLowerCase().includes(value)
    case 'url':
      return (summary.url ?? '').toLowerCase().includes(value)
    case 'method':
      return matchAlternatives(value, (alt) => (summary.method ?? '').toLowerCase() === alt)
    case 'status': {
      const status = summary.status
      if (status === undefined) return false
      return matchAlternatives(value, (alt) => {
        if (/^\d+$/.test(alt)) return status === Number(alt)
        const m = /^(\d)xx$/.exec(alt)
        if (m) return Math.floor(status / 100) === Number(m[1])
        return false
      })
    }
    case 'type':
      if (value === 'grpc') return summary.flags.some((f) => f === 'grpc')
      return summary.kind === value
    case 'flag':
      return summary.flags.some((f) => f.toLowerCase() === value)
    case 'app':
      return (summary.clientApp ?? '').toLowerCase().includes(value)
    case 'ip':
      return (summary.clientIp ?? '').toLowerCase().includes(value)
    case 'label':
      return (summary.label ?? '').toLowerCase().includes(value)
    case 'note':
      return (summary.note ?? '').toLowerCase().includes(value)
    case 'trace':
      return (summary.traceId ?? '').toLowerCase().includes(value)
    case 'sni':
      return (summary.sni ?? '').toLowerCase().includes(value)
    case 'has':
      return matchAlternatives(value, (alt) => {
        switch (alt) {
          case 'response':
            return summary.status !== undefined
          case 'reqbody':
            return summary.reqSize > 0
          case 'respbody':
            return summary.respSize > 0
          case 'error':
            return summary.error !== undefined
          default:
            return false
        }
      })
    default:
      return true
  }
}

function matchAlternatives(value: string, match: (alt: string) => boolean): boolean {
  return value.split('|').some((alt) => alt && match(alt.trim()))
}
