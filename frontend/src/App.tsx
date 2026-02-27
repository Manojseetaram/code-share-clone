import './App.css'
import { useState, useRef, useEffect, useCallback } from 'react'
import Editor from '@monaco-editor/react'
import type * as Monaco from 'monaco-editor'
import { useParams, useNavigate } from 'react-router-dom'

// ─── Types ───────────────────────────────────────────────────────────────────
interface PastedImage { id: string; dataUrl: string; width: number; height: number }

// ─── Image lightbox ───────────────────────────────────────────────────────────
function ImageViewer({ img, onClose }: { img: PastedImage; onClose: () => void }) {
  useEffect(() => {
    const fn = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', fn)
    return () => window.removeEventListener('keydown', fn)
  }, [onClose])
  return (
    <div className="fixed inset-0 z-[100] bg-black/80 flex items-center justify-center" onClick={onClose}>
      <img src={img.dataUrl} alt="full" className="max-w-[90vw] max-h-[90vh] object-contain rounded shadow-2xl" onClick={e => e.stopPropagation()} />
      <button onClick={onClose} className="absolute top-4 right-4 text-white text-2xl w-9 h-9 flex items-center justify-center rounded-full bg-black/50 hover:bg-black/80">×</button>
    </div>
  )
}

// ─── Share Modal ──────────────────────────────────────────────────────────────
function ShareModal({ onClose, theme, code, language, images, currentSlug }: {
  onClose: () => void; theme: 'dark' | 'light'; code: string
  language: string; images: PastedImage[]; currentSlug?: string
}) {
  const isDark = theme === 'dark'
  const navigate = useNavigate()
  const [customSlug, setCustomSlug] = useState(currentSlug ?? '')
  const [slugStatus, setSlugStatus] = useState<'idle' | 'checking' | 'available' | 'taken'>('idle')
  const [sharedUrl, setSharedUrl]   = useState(currentSlug ? `${window.location.origin}/${currentSlug}` : '')
  const [copied, setCopied]         = useState(false)
  const [loading, setLoading]       = useState(false)
  const [error, setError]           = useState('')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const checkSlug = useCallback(async (v: string) => {
    if (!v.trim()) { setSlugStatus('idle'); return }
    if (v === currentSlug) { setSlugStatus('available'); return }
    setSlugStatus('checking')
    try {
      const r = await fetch(`/api/check/${encodeURIComponent(v)}`)
      const d = await r.json()
      setSlugStatus(d.available ? 'available' : 'taken')
    } catch { setSlugStatus('idle') }
  }, [currentSlug])

  const handleSlugChange = (v: string) => {
    setCustomSlug(v); setSharedUrl(''); setError('')
    if (timer.current) clearTimeout(timer.current)
    if (!v.trim()) { setSlugStatus('idle'); return }
    setSlugStatus('checking')
    timer.current = setTimeout(() => checkSlug(v), 400)
  }

  const handleShare = async () => {
    setLoading(true); setError('')
    try {
      const res = await fetch('/api/snippets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slug: customSlug.trim() || undefined,
          content: code, language,
          images: images.length > 0 ? images : undefined,
        }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error || 'Something went wrong'); return }
      setSharedUrl(`${window.location.origin}/${data.slug}`)
      navigate(`/${data.slug}`)
    } catch { setError('Could not connect to server') }
    finally { setLoading(false) }
  }

  const ic = isDark ? 'bg-[#2d2d2d] border-[#555] text-gray-200 focus:border-blue-500' : 'bg-gray-50 border-gray-300 text-gray-800 focus:border-blue-500'
  const badge = () => {
    if (slugStatus === 'checking')  return <span className="text-yellow-400 text-[11px]">checking…</span>
    if (slugStatus === 'available') return <span className="text-green-400 text-[11px]">✓ available</span>
    if (slugStatus === 'taken')     return <span className="text-red-400 text-[11px]">✗ taken</span>
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className={`w-[440px] mx-4 rounded-lg shadow-2xl border ${isDark ? 'bg-[#1e1e1e] border-[#3c3c3c]' : 'bg-white border-gray-200'}`}>
        <div className={`flex items-center justify-between px-5 py-4 border-b ${isDark ? 'border-[#3c3c3c]' : 'border-gray-100'}`}>
          <span className={`font-semibold text-sm ${isDark ? 'text-white' : 'text-gray-900'}`}>Share Snippet</span>
          <button onClick={onClose} className={`text-xl leading-none ${isDark ? 'text-gray-400 hover:text-white' : 'text-gray-400 hover:text-gray-700'}`}>×</button>
        </div>
        <div className="px-5 py-5 flex flex-col gap-4">
          {!sharedUrl && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>Custom URL <span className="opacity-50">(optional)</span></label>
                {badge()}
              </div>
              <input value={customSlug} onChange={e => handleSlugChange(e.target.value)}
                placeholder="e.g. manoj or my-snippet"
                className={`w-full px-3 py-2 rounded border text-sm font-mono outline-none ${ic}`} />
              {customSlug && (
                <p className={`mt-1.5 text-[11px] font-mono ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                  {window.location.host}/<span className={isDark ? 'text-blue-400' : 'text-blue-600'}>{customSlug.toLowerCase().replace(/[^a-z0-9-]/g, '-')}</span>
                </p>
              )}
            </div>
          )}
          {error && <p className="text-xs text-red-400 bg-red-400/10 px-3 py-2 rounded border border-red-400/20">{error}</p>}
          {sharedUrl ? (
            <div className="flex flex-col gap-3">
              <p className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                ✅ Shared! Valid for <strong>24 hours</strong>.{images.length > 0 && ` (${images.length} image${images.length > 1 ? 's' : ''} included)`}
              </p>
              <div className={`flex items-center gap-2 p-3 rounded border font-mono text-xs ${isDark ? 'bg-[#2d2d2d] border-[#444] text-gray-300' : 'bg-gray-50 border-gray-200 text-gray-700'}`}>
                <span className="flex-1 truncate">{sharedUrl}</span>
                <button onClick={() => { navigator.clipboard.writeText(sharedUrl); setCopied(true); setTimeout(() => setCopied(false), 2000) }}
                  className={`shrink-0 px-2 py-1 rounded text-xs transition-colors ${copied ? 'bg-green-600 text-white' : 'bg-blue-600 hover:bg-blue-700 text-white'}`}>
                  {copied ? '✓' : 'Copy'}
                </button>
              </div>
              <button onClick={onClose} className={`text-sm py-2 rounded border ${isDark ? 'border-[#555] text-gray-300 hover:bg-[#2d2d2d]' : 'border-gray-300 text-gray-600 hover:bg-gray-50'}`}>Close</button>
            </div>
          ) : (
            <button onClick={handleShare} disabled={loading || slugStatus === 'taken' || slugStatus === 'checking'}
              className="w-full py-2.5 rounded text-sm font-medium bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
              {loading ? 'Sharing…' : 'Share'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  const { slug } = useParams<{ slug?: string }>()
  const navigate = useNavigate()

  const [theme, setTheme]               = useState<'dark' | 'light'>('dark')
  const [shareOpen, setShareOpen]       = useState(false)
  const [pastedImages, setPastedImages] = useState<PastedImage[]>([])
  const [viewerImage, setViewerImage]   = useState<PastedImage | null>(null)
  const [code, setCode]                 = useState('// Start typing or paste your code here...\n\n')
  const [language, setLanguage]         = useState('javascript')
  const [loadError, setLoadError]       = useState('')
  const [viewers, setViewers]           = useState(1)
  const [wsReady, setWsReady]           = useState(false)

  const editorRef   = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null)
  const monacoRef   = useRef<typeof Monaco | null>(null)
  const wsRef       = useRef<WebSocket | null>(null)
  const isRemote    = useRef(false)
  const sendTimer   = useRef<ReturnType<typeof setTimeout> | null>(null)
  const reconnTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mountCount  = useRef(0)
  const isDark      = theme === 'dark'

  // ── WebSocket ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!slug) return
    let dead = false

    function connect() {
      if (dead) return
      // ← CORRECT: use window.location.host so Vite proxy handles it
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      const ws = new WebSocket(`${proto}//${window.location.host}/ws/${slug}`)
      wsRef.current = ws

      ws.onopen = () => { if (!dead) setWsReady(true) }
      ws.onerror = () => ws.close()
      ws.onclose = () => {
        setWsReady(false)
        if (!dead) reconnTimer.current = setTimeout(connect, 3000)
      }
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data)
          if (msg.type === 'connected')              setViewers(msg.viewers ?? 1)
          else if (msg.type === 'viewers')           setViewers(msg.count ?? 1)
          else if (msg.type === 'broadcast_edit') {
            isRemote.current = true
            setCode(msg.content)
            setLanguage(msg.language)
            setTimeout(() => { isRemote.current = false }, 50)
          }
          else if (msg.type === 'broadcast_image')
            setPastedImages(p => p.find(i => i.id === msg.image.id) ? p : [...p, msg.image])
          else if (msg.type === 'broadcast_remove_image')
            setPastedImages(p => p.filter(i => i.id !== msg.id))
        } catch {}
      }
    }

    connect()
    return () => {
      dead = true
      if (reconnTimer.current) clearTimeout(reconnTimer.current)
      wsRef.current?.close()
      wsRef.current = null
    }
  }, [slug])

  const wsSend = useCallback((msg: object) => {
    if (wsRef.current?.readyState === WebSocket.OPEN)
      wsRef.current.send(JSON.stringify(msg))
  }, [])

  // ── Load snippet ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!slug) return
    setLoadError('')
    fetch(`/api/snippets/${encodeURIComponent(slug)}`)
      .then(r => { if (!r.ok) throw new Error(); return r.json() })
      .then(d => {
        isRemote.current = true
        setCode(d.content)
        setLanguage(d.language)
        if (Array.isArray(d.images) && d.images.length > 0) setPastedImages(d.images)
        setTimeout(() => { isRemote.current = false }, 50)
      })
      .catch(() => setLoadError('Snippet not found or has expired.'))
  }, [slug])

  // ── Process image file ────────────────────────────────────────────────────
  const processImage = useCallback((file: File) => {
    const reader = new FileReader()
    reader.onload = ev => {
      const dataUrl = ev.target?.result as string
      const image = new Image()
      image.onload = () => {
        const newImg: PastedImage = {
          id: crypto.randomUUID(),
          dataUrl,
          width: image.naturalWidth,
          height: image.naturalHeight,
        }
        setPastedImages(prev => [...prev, newImg])
        wsSend({ type: 'image', image: newImg })

        const editor = editorRef.current
        const monaco = monacoRef.current
        if (editor && monaco) {
          const pos = editor.getPosition()
          if (pos) {
            editor.executeEdits('img', [{
              range: new monaco.Range(pos.lineNumber, pos.column, pos.lineNumber, pos.column),
              text: `# [image: ${image.naturalWidth}×${image.naturalHeight}]\n`,
            }])
            editor.focus()
          }
        }
      }
      image.src = dataUrl
    }
    reader.readAsDataURL(file)
  }, [wsSend])

  // ── Monaco mount ─────────────────────────────────────────────────────────
  //
  // ROOT CAUSE OF IMAGE PASTE NOT WORKING:
  // Monaco wraps a hidden <textarea> for input. We must attach to that element
  // using capture:true. BUT React StrictMode double-mounts in dev — so we track
  // mount count and re-attach every time. The 'dead' flag per closure stops
  // stale listeners from firing.
  //
const handleEditorMount = useCallback((
  editor: Monaco.editor.IStandaloneCodeEditor,
  monaco: typeof Monaco,
) => {
  editorRef.current = editor
  monacoRef.current = monaco

  function attachListener() {
    const dom = editor.getDomNode()
    if (!dom) return

    const textarea = dom.querySelector<HTMLTextAreaElement>('.inputarea')
    if (!textarea) {
      // Monaco not ready yet → retry
      setTimeout(attachListener, 100)
      return
    }

    console.log("Found Monaco inputarea ✅")

  const handler = (e: ClipboardEvent) => {
  alert("PASTE DETECTED")
}

    textarea.addEventListener('paste', handler, true)
  }

  attachListener()
}, [processImage])
useEffect(() => {
  const handler = (e: ClipboardEvent) => {
    // Check if Monaco is focused
    const active = document.activeElement
    if (!active) return

    const isMonaco =
      active.classList.contains('inputarea') ||
      active.closest('.monaco-editor')

    if (!isMonaco) return

    console.log("GLOBAL PASTE DETECTED")

    const items = Array.from(e.clipboardData?.items || [])
    console.log("Clipboard types:", items.map(i => i.type))

    const imageItem = items.find(i => i.type.startsWith('image/'))
    if (!imageItem) return

    e.preventDefault()
    e.stopPropagation()

    const file = imageItem.getAsFile()
    if (file) processImage(file)
  }

  document.addEventListener('paste', handler, true)

  return () => {
    document.removeEventListener('paste', handler, true)
  }
}, [processImage])
  // ── Code change ──────────────────────────────────────────────────────────
  const handleCodeChange = useCallback((val: string | undefined) => {
    if (isRemote.current) return
    const v = val ?? ''
    setCode(v)
    if (sendTimer.current) clearTimeout(sendTimer.current)
    sendTimer.current = setTimeout(() => wsSend({ type: 'edit', content: v, language }), 300)
  }, [wsSend, language])

  const removeImage = useCallback((id: string) => {
    setPastedImages(p => p.filter(i => i.id !== id))
    wsSend({ type: 'remove_image', id })
  }, [wsSend])

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}
      className={isDark ? 'bg-[#1e1e1e]' : 'bg-white'}>

      {/* Navbar */}
      <nav className={`flex items-center justify-between px-5 h-12 shrink-0 border-b ${isDark ? 'bg-[#1e1e1e] border-[#3c3c3c]' : 'bg-white border-gray-200'}`}>
        <a href="/" className={`text-base font-bold tracking-tight no-underline ${isDark ? 'text-white' : 'text-gray-900'}`}>
          <span className={isDark ? 'text-blue-400' : 'text-blue-600'}>×</span>codeshare
        </a>
        <div className="flex items-center gap-2">
          {slug && <span title={wsReady ? 'Live' : 'Connecting…'} className={`w-2 h-2 rounded-full ${wsReady ? 'bg-green-500' : 'bg-yellow-400 animate-pulse'}`} />}
          {slug && viewers > 1 && (
            <span className={`text-xs px-2 py-0.5 rounded-full ${isDark ? 'bg-[#2d2d2d] text-gray-400' : 'bg-gray-100 text-gray-500'}`}>👁 {viewers}</span>
          )}
          <button onClick={() => setTheme(t => t === 'dark' ? 'light' : 'dark')}
            className={`w-8 h-8 rounded flex items-center justify-center text-sm transition-colors ${isDark ? 'hover:bg-[#2d2d2d] text-gray-400' : 'hover:bg-gray-100 text-gray-500'}`}>
            {isDark ? '☀' : '🌙'}
          </button>
          <button onClick={() => setShareOpen(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded text-sm font-medium bg-blue-600 hover:bg-blue-700 text-white transition-colors">
            <svg width="13" height="13" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
            </svg>
            Share
          </button>
        </div>
      </nav>

      {loadError && (
        <div className="bg-red-900/40 border-b border-red-800 text-red-300 text-xs px-5 py-2 flex items-center justify-between">
          <span>{loadError}</span><a href="/" className="underline ml-2">Start new</a>
        </div>
      )}

      {/* Monaco */}
      <div style={{ flex: 1, overflow: 'hidden' }}>
        <Editor
          height="100%"
          language={language}
          value={code}
          theme={isDark ? 'vs-dark' : 'vs'}
          onChange={handleCodeChange}
          onMount={handleEditorMount}
          options={{
            fontSize: 14,
            fontFamily: "'Fira Code', 'Cascadia Code', Consolas, monospace",
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

      {/* Image strip */}
      {pastedImages.length > 0 && (
        <div className={`shrink-0 border-t ${isDark ? 'border-[#3c3c3c] bg-[#252526]' : 'border-gray-200 bg-gray-50'}`}>
          <div className="flex items-center gap-3 px-4 py-2 overflow-x-auto">
            <span className={`text-xs shrink-0 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>Images ({pastedImages.length})</span>
            {pastedImages.map(img => (
              <div key={img.id} className="relative group shrink-0 cursor-pointer" onClick={() => setViewerImage(img)}>
                <img src={img.dataUrl} alt="pasted" className="h-14 w-auto rounded border object-cover"
                  style={{ borderColor: isDark ? '#3c3c3c' : '#e5e7eb' }} />
                <span className={`absolute bottom-0.5 left-0.5 text-[9px] px-1 rounded pointer-events-none ${isDark ? 'bg-black/70 text-gray-300' : 'bg-black/50 text-white'}`}>
                  {img.width}×{img.height}
                </span>
                <button onClick={e => { e.stopPropagation(); removeImage(img.id) }}
                  className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-red-600 text-white text-[10px] flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">×</button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Status bar */}
      <div className={`h-6 shrink-0 flex items-center px-4 gap-3 text-[11px] ${isDark ? 'bg-[#007acc] text-white' : 'bg-blue-600 text-white'}`}>
        <span className="capitalize">{language}</span>
        <span className="opacity-40">|</span>
        <span>UTF-8</span>
        {slug && <><span className="opacity-40">|</span><span className="opacity-70">/{slug}</span></>}
        {pastedImages.length > 0 && <><span className="opacity-40">|</span><span>{pastedImages.length} image{pastedImages.length > 1 ? 's' : ''}</span></>}
      </div>

      {shareOpen && <ShareModal onClose={() => setShareOpen(false)} theme={theme} code={code} language={language} images={pastedImages} currentSlug={slug} />}
      {viewerImage && <ImageViewer img={viewerImage} onClose={() => setViewerImage(null)} />}
    </div>
  )
}