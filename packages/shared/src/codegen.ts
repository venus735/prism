export type CodegenLang = 'curl' | 'python' | 'fetch' | 'axios' | 'go'

export const CODEGEN_LANGS: { lang: CodegenLang; label: string }[] = [
  { lang: 'curl', label: 'cURL' },
  { lang: 'python', label: 'Python (requests)' },
  { lang: 'fetch', label: 'JS (fetch)' },
  { lang: 'axios', label: 'Node (axios)' },
  { lang: 'go', label: 'Go (net/http)' }
]
