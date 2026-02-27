import './App.css'
import { useState, useRef, useCallback, useEffect } from 'react'
import Editor from '@monaco-editor/react'
import type * as Monaco from 'monaco-editor'

const API = 'http://localhost:3001'

// ─── Types ───────────────────────────────────────────────────────────────────

interface PastedImage {
  id: string
  dataUrl: string
  width: number
  height: number
}

interface SnippetResponse {
  slug: string
  content: string
  language: string
  images: PastedImage[]
  expires_at: string
  url: string
}



function ShareModal({
  onClose,
  theme,
  code,
  language,
  images,
}: {
  onClose: () => void
  theme: 'dark' | 'light'
  code: string
  language: string
  images: PastedImage[]
}) {
  const isDark = theme === 'dark'
  const [slug, setSlug] = useState('')
  const [slugStatus, setSlugStatus] = useState<'idle' | 'checking' | 'available' | 'taken' | 'invalid'>('idle')
  const [sharedUrl, setSharedUrl] = useState('')
  const [copied, setCopied] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const checkTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Real-time slug availability check
  const checkSlug = useCallback(async (value: string) => {
    if (!value.trim()) { setSlugStatus('idle'); return }
    setSlugStatus('checking')
    try {
      const res = await fetch(`${API}/api/check/${encodeURIComponent(value)}`)
      const data = await res.json()
      setSlugStatus(data.available ? 'available' : 'taken')
    } catch {
      setSlugStatus('idle')
    }
  }, [])

  const handleSlugChange = (v: string) => {
    setSlug(v)
    setSharedUrl('')
    if (checkTimer.current) clearTimeout(checkTimer.current)
    if (!v.trim()) { setSlugStatus('idle'); return }
    setSlugStatus('checking')
    checkTimer.current = setTimeout(() => checkSlug(v), 400)
  }

  const handleShare = async () => {
    setLoading(true)
    setError('')
    try {
      const res = await fetch(`${API}/api/snippets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slug: slug.trim() || undefined,
          content: code,
          language,
          images: images.length > 0 ? images : undefined,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error || 'Something went wrong')
        return
      }
      const full = `${window.location.origin}/${data.slug}`
      setSharedUrl(full)
      // Update browser URL without reload
      window.history.pushState({}, '', `/${data.slug}`)
    } catch {
      setError('Could not connect to server')
    } finally {
      setLoading(false)
    }
  }

  const copy = () => {
    navigator.clipboard.writeText(sharedUrl)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const slugIndicator = () => {
    if (slugStatus === 'checking') return <span className="text-yellow-400">checking...</span>
    if (slugStatus === 'available') return <span className="text-green-400">✓ available</span>
    if (slugStatus === 'taken') return <span className="text-red-400">✗ taken</span>
    return null
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={e => e.target === e.currentTarget && onClose()}
    >
      <div className={`w-[440px] mx-4 rounded-lg shadow-2xl border ${
        isDark ? 'bg-[#1e1e1e] border-[#3c3c3c]' : 'bg-white border-gray-200'
      }`}>
        {/* Header */}
        <div className={`flex items-center justify-between px-5 py-4 border-b ${isDark ? 'border-[#3c3c3c]' : 'border-gray-100'}`}>
          <span className={`font-semibold ${isDark ? 'text-white' : 'text-gray-900'}`}>Share Snippet</span>
          <button onClick={onClose} className={`text-xl leading-none ${isDark ? 'text-gray-400 hover:text-white' : 'text-gray-400 hover:text-gray-700'}`}>×</button>
        </div>

        <div className="px-5 py-5 flex flex-col gap-4">
          {/* Custom URL input */}
          {!sharedUrl && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                  Custom URL <span className={`text-[10px] ${isDark ? 'text-gray-600' : 'text-gray-400'}`}>(optional)</span>
                </label>
                <span className="text-[11px]">{slugIndicator()}</span>
              </div>
              <input
                value={slug}
                onChange={e => handleSlugChange(e.target.value)}
                placeholder="leave blank for auto-generated"
                className={`w-full px-3 py-2 rounded border text-sm font-mono outline-none ${
                  isDark
                    ? 'bg-[#2d2d2d] border-[#555] text-gray-200 focus:border-blue-500'
                    : 'bg-gray-50 border-gray-300 text-gray-800 focus:border-blue-500'
                }`}
              />
              {slug && (
                <p className={`mt-1.5 text-[11px] font-mono ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                  {window.location.host}/<span className={isDark ? 'text-blue-400' : 'text-blue-600'}>
                    {slug.toLowerCase().replace(/[^a-z0-9-]/g, '-')}
                  </span>
                </p>
              )}
            </div>
          )}

          {/* Error */}
          {error && (
            <p className="text-xs text-red-400 bg-red-400/10 px-3 py-2 rounded border border-red-400/20">{error}</p>
          )}

          {/* Shared result */}
          {sharedUrl ? (
            <div className="flex flex-col gap-3">
              <p className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                ✅ Snippet shared! Link is valid for <strong>24 hours</strong>.
              </p>
              <div className={`flex items-center gap-2 p-3 rounded border font-mono text-xs ${
                isDark ? 'bg-[#2d2d2d] border-[#444] text-gray-300' : 'bg-gray-50 border-gray-200 text-gray-700'
              }`}>
                <span className="flex-1 truncate">{sharedUrl}</span>
                <button
                  onClick={copy}
                  className={`shrink-0 px-2 py-1 rounded text-xs transition-colors ${
                    copied ? 'bg-green-600 text-white' : 'bg-blue-600 hover:bg-blue-700 text-white'
                  }`}
                >
                  {copied ? '✓' : 'Copy'}
                </button>
              </div>
              <button onClick={onClose} className={`text-sm py-2 rounded border transition-colors ${
                isDark ? 'border-[#555] text-gray-300 hover:bg-[#2d2d2d]' : 'border-gray-300 text-gray-600 hover:bg-gray-50'
              }`}>
                Close
              </button>
            </div>
          ) : (
            <button
              onClick={handleShare}
              disabled={loading || slugStatus === 'taken' || slugStatus === 'checking'}
              className="w-full py-2.5 rounded text-sm font-medium transition-colors bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? 'Sharing...' : 'Share'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Main App ─────────────────────────────────────────────────────────────────

export default function App() {
  const [theme, setTheme] = useState<'dark' | 'light'>('dark')
  const [shareOpen, setShareOpen] = useState(false)
  const [pastedImages, setPastedImages] = useState<PastedImage[]>([])
  const [code, setCode] = useState(`// Start typing or paste your code here...\n\n`)
  const [language, setLanguage] = useState('javascript')
  const [loadError, setLoadError] = useState('')
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null)
  const monacoRef = useRef<typeof Monaco | null>(null)
  const isDark = theme === 'dark'

  // ── Load snippet from URL on mount ──
  useEffect(() => {
    const slug = window.location.pathname.replace(/^\//, '')
    if (!slug || slug === '') return

    fetch(`${API}/api/snippets/${encodeURIComponent(slug)}`)
      .then(res => {
        if (!res.ok) throw new Error('not found')
        return res.json() as Promise<SnippetResponse>
      })
      .then(data => {
        setCode(data.content)
        setLanguage(data.language)
        if (data.images?.length) setPastedImages(data.images)
      })
      .catch(() => {
        setLoadError('Snippet not found or has expired.')
      })
  }, [])

  // ── Handle image paste ──
  const handlePaste = useCallback((e: ClipboardEvent) => {
    const items = e.clipboardData?.items
    if (!items) return
    for (const item of Array.from(items)) {
      if (item.type.startsWith('image/')) {
        e.preventDefault()
        const file = item.getAsFile()
        if (!file) continue
        const reader = new FileReader()
        reader.onload = ev => {
          const dataUrl = ev.target?.result as string
          const img = new Image()
          img.onload = () => {
            const newImg: PastedImage = {
              id: crypto.randomUUID(),
              dataUrl,
              width: img.naturalWidth,
              height: img.naturalHeight,
            }
            setPastedImages(prev => [...prev, newImg])
            const editor = editorRef.current
            const monaco = monacoRef.current
            if (editor && monaco) {
              const pos = editor.getPosition()
              if (pos) {
                const range = new monaco.Range(pos.lineNumber, pos.column, pos.lineNumber, pos.column)
                editor.executeEdits('paste-image', [{
                  range,
                  text: `# [image ${img.naturalWidth}×${img.naturalHeight}]\n`,
                }])
              }
            }
          }
          img.src = dataUrl
        }
        reader.readAsDataURL(file)
      }
    }
  }, [])

  useEffect(() => {
    document.addEventListener('paste', handlePaste)
    return () => document.removeEventListener('paste', handlePaste)
  }, [handlePaste])

  const handleEditorMount = (
    editor: Monaco.editor.IStandaloneCodeEditor,
    monaco: typeof Monaco
  ) => {
    editorRef.current = editor
    monacoRef.current = monaco
  }

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}
      className={isDark ? 'bg-[#1e1e1e]' : 'bg-white'}
    >
      {/* ── Navbar ── */}
      <nav className={`flex items-center justify-between px-5 h-12 shrink-0 border-b ${
        isDark ? 'bg-[#1e1e1e] border-[#3c3c3c]' : 'bg-white border-gray-200'
      }`}>
        <a href="/" className={`text-base font-bold tracking-tight no-underline ${isDark ? 'text-white' : 'text-gray-900'}`}>
          <span className={isDark ? 'text-blue-400' : 'text-blue-600'}>×</span>codeshare
        </a>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setTheme(t => t === 'dark' ? 'light' : 'dark')}
            className={`w-8 h-8 rounded flex items-center justify-center text-sm transition-colors ${
              isDark ? 'hover:bg-[#2d2d2d] text-gray-400' : 'hover:bg-gray-100 text-gray-500'
            }`}
          >
            {isDark ? '☀' : '🌙'}
          </button>
          <button
            onClick={() => setShareOpen(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded text-sm font-medium bg-blue-600 hover:bg-blue-700 text-white transition-colors"
          >
            <svg width="13" height="13" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
            </svg>
            Share
          </button>
        </div>
      </nav>

      {/* ── Error banner ── */}
      {loadError && (
        <div className="bg-red-900/40 border-b border-red-800 text-red-300 text-xs px-5 py-2">
          {loadError}
        </div>
      )}

      {/* ── Monaco Editor ── */}
      <div style={{ flex: 1, overflow: 'hidden' }}>
        <Editor
          height="100%"
          language={language}
          value={code}
          theme={isDark ? 'vs-dark' : 'vs'}
          onChange={v => setCode(v ?? '')}
          onMount={handleEditorMount}
          options={{
            fontSize: 14,
            fontFamily: "'Fira Code', 'Cascadia Code', Consolas, 'Courier New', monospace",
            fontLigatures: true,
            lineNumbers: 'on',
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            padding: { top: 12, bottom: 12 },
            renderLineHighlight: 'line',
            smoothScrolling: true,
            cursorBlinking: 'smooth',
            wordWrap: 'off',
            automaticLayout: true,
            tabSize: 2,
            lineNumbersMinChars: 3,
            glyphMargin: false,
            folding: true,
          }}
        />
      </div>

      {/* ── Pasted images strip ── */}
      {pastedImages.length > 0 && (
        <div className={`shrink-0 border-t ${isDark ? 'border-[#3c3c3c] bg-[#252526]' : 'border-gray-200 bg-gray-50'}`}>
          <div className="flex items-center gap-3 px-4 py-2 overflow-x-auto">
            <span className={`text-xs shrink-0 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>Pasted images</span>
            {pastedImages.map(img => (
              <div key={img.id} className="relative group shrink-0">
                <img src={img.dataUrl} alt="pasted" className="h-14 w-auto rounded border object-cover"
                  style={{ borderColor: isDark ? '#3c3c3c' : '#e5e7eb' }} />
                <span className={`absolute bottom-0.5 left-0.5 text-[9px] px-1 rounded ${
                  isDark ? 'bg-black/70 text-gray-300' : 'bg-black/50 text-white'
                }`}>{img.width}×{img.height}</span>
                <button
                  onClick={() => setPastedImages(p => p.filter(i => i.id !== img.id))}
                  className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-red-600 text-white text-[10px] flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                >×</button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Status bar ── */}
      <div className={`h-6 shrink-0 flex items-center px-4 gap-3 text-[11px] ${
        isDark ? 'bg-[#007acc] text-white' : 'bg-blue-600 text-white'
      }`}>
        <span className="capitalize">{language}</span>
        <span className="opacity-40">|</span>
        <span>UTF-8</span>
        {pastedImages.length > 0 && (
          <>
            <span className="opacity-40">|</span>
            <span>{pastedImages.length} image{pastedImages.length > 1 ? 's' : ''}</span>
          </>
        )}
      </div>

      {shareOpen && (
        <ShareModal
          onClose={() => setShareOpen(false)}
          theme={theme}
          code={code}
          language={language}
          images={pastedImages}
        />
      )}
    </div>
  )
}