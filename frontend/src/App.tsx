import './App.css'
import { useState, useRef, useEffect, useCallback } from 'react'
import Editor from '@monaco-editor/react'
import type * as Monaco from 'monaco-editor'
import { useParams, useNavigate } from 'react-router-dom'

// ─── Config ───────────────────────────────────────────────────────────────────
const BACKEND    = (import.meta.env.VITE_BACKEND_URL as string | undefined) ?? ''
const WS_BACKEND = BACKEND
  ? BACKEND.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:')
  : 'ws://localhost:3004'

// ─── Types ────────────────────────────────────────────────────────────────────
interface PastedImage { id: string; url: string; width: number; height: number }
interface BackendImage { id: string; url: string; width: number; height: number }
const toBackendImage   = (img: PastedImage): BackendImage => ({ ...img })
const fromBackendImage = (img: BackendImage): PastedImage => ({ ...img })

// ─── Home page — redirect to a random room ───────────────────────────────────
function randomSlug() {
  return Math.random().toString(36).slice(2, 10)
}

// ─── Image lightbox ───────────────────────────────────────────────────────────
function ImageViewer({ img, onClose }: { img: PastedImage; onClose: () => void }) {
  useEffect(() => {
    const fn = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', fn)
    return () => window.removeEventListener('keydown', fn)
  }, [onClose])
  return (
    <div className="fixed inset-0 z-[100] bg-black/80 flex items-center justify-center" onClick={onClose}>
      <img src={img.url} alt="full" className="max-w-[90vw] max-h-[90vh] object-contain rounded shadow-2xl" onClick={e => e.stopPropagation()} />
      <button onClick={onClose} className="absolute top-4 right-4 text-white text-2xl w-9 h-9 flex items-center justify-center rounded-full bg-black/50 hover:bg-black/80">×</button>
    </div>
  )
}

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  const { slug } = useParams<{ slug?: string }>()
  const navigate  = useNavigate()

  const [theme, setTheme]               = useState<'dark' | 'light'>('dark')
  const [pastedImages, setPastedImages] = useState<PastedImage[]>([])
  const [viewerImage, setViewerImage]   = useState<PastedImage | null>(null)
  const [code, setCode]                 = useState('// Start typing or paste your code here...\n\n')
  const [language, setLanguage]         = useState('javascript')
  const [viewers, setViewers]           = useState(1)
  const [wsReady, setWsReady]           = useState(false)
  const [status, setStatus]             = useState<'loading' | 'ready' | 'error'>('loading')

  const editorRef   = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null)
  const monacoRef   = useRef<typeof Monaco | null>(null)
  const wsRef       = useRef<WebSocket | null>(null)
  const isRemote    = useRef(false)
  const sendTimer   = useRef<ReturnType<typeof setTimeout> | null>(null)
  const reconnTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isDark      = theme === 'dark'

  // ── If no slug → redirect to a new random room ────────────────────────────
  useEffect(() => {
    if (!slug) navigate(`/${randomSlug()}`, { replace: true })
  }, [slug, navigate])

  // ── Load or auto-create room ───────────────────────────────────────────────
  useEffect(() => {
    if (!slug) return
    setStatus('loading')

    async function loadOrCreate() {
      try {
        // Try to load existing room
        let res = await fetch(`${BACKEND}/api/snippets/${encodeURIComponent(slug)}`)

        // Room doesn't exist → create it automatically
        if (res.status === 404) {
          await fetch(`${BACKEND}/api/snippets`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              slug,
              content: '// Start typing or paste your code here...\n\n',
              language: 'javascript',
            }),
          })
          // Load the freshly created room
          res = await fetch(`${BACKEND}/api/snippets/${encodeURIComponent(slug)}`)
        }

        if (!res.ok) throw new Error('failed')

        const data = await res.json()
        isRemote.current = true
        setCode(data.content)
        setLanguage(data.language)
        if (Array.isArray(data.images) && data.images.length > 0)
          setPastedImages((data.images as BackendImage[]).map(fromBackendImage))
        setTimeout(() => { isRemote.current = false }, 50)
        setStatus('ready')
      } catch {
        setStatus('error')
      }
    }

    loadOrCreate()
  }, [slug])

  // ── WebSocket ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!slug) return
    let dead = false

    function connect() {
      if (dead) return
      const ws = new WebSocket(`${WS_BACKEND}/ws/${slug}`)
      wsRef.current = ws
      ws.onopen  = () => { if (!dead) setWsReady(true) }
      ws.onerror = () => ws.close()
      ws.onclose = () => {
        setWsReady(false)
        if (!dead) reconnTimer.current = setTimeout(connect, 3000)
      }
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data)
          if      (msg.type === 'connected')        setViewers(msg.viewers ?? 1)
          else if (msg.type === 'viewers')          setViewers(msg.count ?? 1)
          else if (msg.type === 'broadcast_edit') {
            isRemote.current = true
            setCode(msg.content); setLanguage(msg.language)
            setTimeout(() => { isRemote.current = false }, 50)
          }
          else if (msg.type === 'broadcast_image')
            setPastedImages(p => p.find(i => i.id === msg.image.id) ? p : [...p, fromBackendImage(msg.image)])
          else if (msg.type === 'broadcast_remove_image')
            setPastedImages(p => p.filter(i => i.id !== msg.id))
        } catch {}
      }
    }

    connect()
    return () => {
      dead = true
      if (reconnTimer.current) clearTimeout(reconnTimer.current)
      wsRef.current?.close(); wsRef.current = null
    }
  }, [slug])

  const wsSend = useCallback((msg: object) => {
    if (wsRef.current?.readyState === WebSocket.OPEN)
      wsRef.current.send(JSON.stringify(msg))
  }, [])

  // ── Process pasted image ───────────────────────────────────────────────────
  const processImage = useCallback((file: File) => {
    const reader = new FileReader()
    reader.onload = ev => {
      const url = ev.target?.result as string
      const image = new Image()
      image.onload = () => {
        const newImg: PastedImage = { id: crypto.randomUUID(), url, width: image.naturalWidth, height: image.naturalHeight }
        setPastedImages(prev => [...prev, newImg])
        wsSend({ type: 'image', image: toBackendImage(newImg) })
      }
      image.src = url
    }
    reader.readAsDataURL(file)
  }, [wsSend])

  // ── Monaco mount ───────────────────────────────────────────────────────────
  const handleEditorMount = useCallback((editor: Monaco.editor.IStandaloneCodeEditor, monaco: typeof Monaco) => {
    editorRef.current = editor; monacoRef.current = monaco
  }, [])

  // ── Paste handler for images ───────────────────────────────────────────────
  useEffect(() => {
    const handler = (e: ClipboardEvent) => {
      const active = document.activeElement
      if (!active) return
      if (!active.classList.contains('inputarea') && !active.closest('.monaco-editor')) return
      const imageItem = Array.from(e.clipboardData?.items || []).find(i => i.type.startsWith('image/'))
      if (!imageItem) return
      e.preventDefault(); e.stopPropagation()
      const file = imageItem.getAsFile()
      if (file) processImage(file)
    }
    document.addEventListener('paste', handler, true)
    return () => document.removeEventListener('paste', handler, true)
  }, [processImage])

  // ── Code change → debounce → WebSocket ────────────────────────────────────
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

  // ── Copy room URL ──────────────────────────────────────────────────────────
  const [copied, setCopied] = useState(false)
  const copyUrl = () => {
    navigator.clipboard.writeText(window.location.href)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  if (!slug) return null

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }} className={isDark ? 'bg-[#1e1e1e]' : 'bg-white'}>

      {/* Navbar */}
      <nav className={`flex items-center justify-between px-5 h-12 shrink-0 border-b ${isDark ? 'bg-[#1e1e1e] border-[#3c3c3c]' : 'bg-white border-gray-200'}`}>
        {/* Logo — click to go to a brand new room */}
        <button onClick={() => navigate(`/${randomSlug()}`)}
          className={`text-base font-bold tracking-tight ${isDark ? 'text-white' : 'text-gray-900'}`}>
          <span className={isDark ? 'text-blue-400' : 'text-blue-600'}>×</span>codeshare
        </button>

        <div className="flex items-center gap-2">
          {/* Live indicator */}
          <span title={wsReady ? 'Live' : 'Connecting…'}
            className={`w-2 h-2 rounded-full ${wsReady ? 'bg-green-500' : 'bg-yellow-400 animate-pulse'}`} />

          {/* Viewer count */}
          {viewers > 1 && (
            <span className={`text-xs px-2 py-0.5 rounded-full ${isDark ? 'bg-[#2d2d2d] text-gray-400' : 'bg-gray-100 text-gray-500'}`}>
              👁 {viewers}
            </span>
          )}

          {/* Theme toggle */}
          <button onClick={() => setTheme(t => t === 'dark' ? 'light' : 'dark')}
            className={`w-8 h-8 rounded flex items-center justify-center text-sm transition-colors ${isDark ? 'hover:bg-[#2d2d2d] text-gray-400' : 'hover:bg-gray-100 text-gray-500'}`}>
            {isDark ? '☀' : '🌙'}
          </button>

          {/* Copy room URL — this IS the share button */}
          <button onClick={copyUrl}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-sm font-medium transition-colors ${copied ? 'bg-green-600 text-white' : 'bg-blue-600 hover:bg-blue-700 text-white'}`}>
            {copied ? '✓ Copied!' : '🔗 Share'}
          </button>
        </div>
      </nav>

      {/* Loading / error banner */}
      {status === 'loading' && (
        <div className={`text-xs px-5 py-2 ${isDark ? 'bg-[#2d2d2d] text-gray-400' : 'bg-gray-100 text-gray-500'}`}>
          Loading room…
        </div>
      )}
      {status === 'error' && (
        <div className="bg-red-900/40 border-b border-red-800 text-red-300 text-xs px-5 py-2">
          Could not connect to server. Check your internet connection.
        </div>
      )}

      {/* Monaco editor */}
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
            renderValidationDecorations: 'off',
            quickSuggestions: false,
            parameterHints: { enabled: false },
            suggestOnTriggerCharacters: false,
            acceptSuggestionOnEnter: 'off',
            tabCompletion: 'off',
            wordBasedSuggestions: 'off',
            hover: { enabled: false },
            contextmenu: false,
            lightbulb: { enabled: 'off' },
          }}
        />
      </div>

      {/* Image strip */}
      {pastedImages.length > 0 && (
        <div className={`shrink-0 border-t ${isDark ? 'border-[#3c3c3c] bg-[#252526]' : 'border-gray-200 bg-gray-50'}`}>
          <div className="flex items-center gap-3 px-4 py-2 overflow-x-auto">
            <span className={`text-xs shrink-0 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
              Images ({pastedImages.length})
            </span>
            {pastedImages.map(img => (
              <div key={img.id} className="relative group shrink-0 cursor-pointer" onClick={() => setViewerImage(img)}>
                <img src={img.url} alt="pasted" className="h-14 w-auto rounded border object-cover"
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
        <span className="opacity-40">|</span>
        <span className="opacity-70 font-mono">/{slug}</span>
        {pastedImages.length > 0 && (
          <><span className="opacity-40">|</span><span>{pastedImages.length} image{pastedImages.length > 1 ? 's' : ''}</span></>
        )}
      </div>

      {viewerImage && <ImageViewer img={viewerImage} onClose={() => setViewerImage(null)} />}
    </div>
  )
}