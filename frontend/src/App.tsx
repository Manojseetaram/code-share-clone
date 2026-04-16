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

interface SharedFile { id: string; name: string; url: string; size: number; mime: string }

function randomSlug() {
  return Math.random().toString(36).slice(2, 10)
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function fileIcon(mime: string): string {
  if (mime.startsWith('image/'))       return '🖼'
  if (mime === 'application/zip' ||
      mime === 'application/x-zip-compressed') return '🗜'
  if (mime.startsWith('text/'))        return '📄'
  if (mime.includes('pdf'))            return '📕'
  if (mime.includes('json'))           return '📋'
  return '📦'
}

// ─── Fetch with retry (handles Render cold-start 502s) ───────────────────────
async function fetchWithRetry(
  url: string,
  options?: RequestInit,
  retries = 4,
  delayMs = 2000,
): Promise<Response> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, options)
      // Retry on 502/503/504 (Render cold start / proxy errors)
      if ((res.status === 502 || res.status === 503 || res.status === 504) && attempt < retries) {
        await new Promise(r => setTimeout(r, delayMs * (attempt + 1)))
        continue
      }
      return res
    } catch (err) {
      if (attempt === retries) throw err
      await new Promise(r => setTimeout(r, delayMs * (attempt + 1)))
    }
  }
  throw new Error('All retries exhausted')
}

// ─── Icons ────────────────────────────────────────────────────────────────────
function IconSun() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/>
      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
      <line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/>
      <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
    </svg>
  )
}

function IconMoon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
    </svg>
  )
}

function IconLink() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
    </svg>
  )
}

function IconCheck() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12"/>
    </svg>
  )
}

function IconX() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
    </svg>
  )
}

function IconUpload() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="16 16 12 12 8 16"/>
      <line x1="12" y1="12" x2="12" y2="21"/>
      <path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3"/>
    </svg>
  )
}

function IconDownload() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="8 17 12 21 16 17"/>
      <line x1="12" y1="21" x2="12" y2="3"/>
      <path d="M20.88 18.09A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.29"/>
    </svg>
  )
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
      <button onClick={onClose} className="absolute top-4 right-4 text-white text-2xl w-9 h-9 flex items-center justify-center rounded-full bg-black/50 hover:bg-black/80">
        <IconX />
      </button>
    </div>
  )
}

// ─── File strip ───────────────────────────────────────────────────────────────
function FileStrip({
  files, isDark, slug, onRemove, uploading
}: {
  files: SharedFile[]
  isDark: boolean
  slug: string
  onRemove: (id: string) => void
  uploading: boolean
}) {
  const [downloading, setDownloading] = useState(false)

  // All downloads go through the backend proxy so Cloudinary CORS/Content-Disposition
  // issues are avoided entirely. The backend fetches the bytes and streams them back
  // with proper headers.
  const proxyUrl = (fileId: string) =>
    `${BACKEND}/api/snippets/${encodeURIComponent(slug)}/files/${encodeURIComponent(fileId)}`

  const downloadSingle = async (f: SharedFile) => {
    const res  = await fetchWithRetry(proxyUrl(f.id))
    if (!res.ok) { alert('Download failed'); return }
    const blob = await res.blob()
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement('a')
    a.href     = url
    a.download = f.name
    a.click()
    URL.revokeObjectURL(url)
  }

  const downloadZip = async () => {
    setDownloading(true)
    try {
      const res = await fetchWithRetry(`${BACKEND}/api/snippets/${encodeURIComponent(slug)}/download-zip`)
      if (!res.ok) throw new Error('failed')
      const blob = await res.blob()
      const url  = URL.createObjectURL(blob)
      const a    = document.createElement('a')
      a.href     = url
      a.download = `${slug}.zip`
      a.click()
      URL.revokeObjectURL(url)
    } catch {
      alert('Download failed')
    } finally {
      setDownloading(false)
    }
  }

  return (
    <div className={`shrink-0 border-t ${isDark ? 'border-[#3c3c3c] bg-[#252526]' : 'border-gray-200 bg-gray-50'}`}>
      <div className="flex items-center gap-2 px-4 py-2 overflow-x-auto">

        {/* Label + count */}
        <span className={`text-xs shrink-0 font-medium ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
          Files ({files.length})
        </span>

        {/* File cards */}
        {files.map(f => (
          <div
            key={f.id}
            className={`group relative flex items-center gap-2 shrink-0 rounded px-2.5 py-1.5 text-xs border
              ${isDark ? 'bg-[#1e1e1e] border-[#3c3c3c] text-gray-300' : 'bg-white border-gray-200 text-gray-700'}`}
          >
            <span className="text-base leading-none">{fileIcon(f.mime)}</span>
            <div className="flex flex-col min-w-0 max-w-[120px]">
              <span className="truncate font-medium leading-tight">{f.name}</span>
              <span className={`text-[10px] ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>{formatBytes(f.size)}</span>
            </div>
            {/* Individual download — via backend proxy, not direct Cloudinary URL */}
            <button
              onClick={() => downloadSingle(f)}
              className={`ml-1 opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded
                ${isDark ? 'text-blue-400 hover:text-blue-300' : 'text-blue-600 hover:text-blue-700'}`}
              title="Download"
            >
              <IconDownload />
            </button>
            {/* Remove */}
            <button
              onClick={() => onRemove(f.id)}
              className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-red-600 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
              title="Remove"
            >
              <IconX />
            </button>
          </div>
        ))}

        {/* Spinner while uploading */}
        {uploading && (
          <div className={`flex items-center gap-1.5 text-xs px-2 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
            <svg className="animate-spin w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
            </svg>
            Uploading…
          </div>
        )}

        {/* Download all as ZIP */}
        {files.length > 1 && (
          <button
            onClick={downloadZip}
            disabled={downloading}
            className={`shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs font-medium transition-colors ml-auto
              ${downloading
                ? 'opacity-50 cursor-not-allowed bg-gray-600 text-white'
                : isDark
                  ? 'bg-[#3c3c3c] hover:bg-[#4a4a4a] text-gray-200'
                  : 'bg-gray-200 hover:bg-gray-300 text-gray-700'
              }`}
          >
            <IconDownload />
            {downloading ? 'Zipping…' : 'Download all (.zip)'}
          </button>
        )}
      </div>
    </div>
  )
}

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  const { slug } = useParams<{ slug?: string }>()
  const navigate  = useNavigate()

  const [theme, setTheme]                 = useState<'dark' | 'light'>('dark')
  const [pastedImages, setPastedImages]   = useState<PastedImage[]>([])
  const [sharedFiles, setSharedFiles]     = useState<SharedFile[]>([])
  const [fileUploading, setFileUploading] = useState(false)
  const [viewerImage, setViewerImage]     = useState<PastedImage | null>(null)
  const [code, setCode]                   = useState('// Start typing or paste your code, image here...\n\n')
  const [language, setLanguage]           = useState('javascript')
  const [viewers, setViewers]             = useState(1)
  const [wsReady, setWsReady]             = useState(false)
  const [status, setStatus]               = useState<'loading' | 'ready' | 'error' | 'waking'>('loading')
  const [isDraggingFile, setIsDraggingFile] = useState(false)

  const editorRef    = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null)
  const monacoRef    = useRef<typeof Monaco | null>(null)
  const wsRef        = useRef<WebSocket | null>(null)
  const isRemote     = useRef(false)
  const sendTimer    = useRef<ReturnType<typeof setTimeout> | null>(null)
  const reconnTimer  = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const isDark       = theme === 'dark'

  useEffect(() => {
    if (!slug) navigate(`/${randomSlug()}`, { replace: true })
  }, [slug, navigate])

  useEffect(() => {
    if (!slug) return
    setStatus('loading')

    async function loadOrCreate() {
      try {
        // fetchWithRetry handles 502 cold-start responses from Render
        let res = await fetchWithRetry(`${BACKEND}/api/snippets/${encodeURIComponent(slug)}`)

        // Show "waking up" message while retrying
        if (!res.ok && res.status !== 404) {
          setStatus('waking')
          res = await fetchWithRetry(`${BACKEND}/api/snippets/${encodeURIComponent(slug)}`, undefined, 6, 3000)
        }

        if (res.status === 404) {
          await fetchWithRetry(`${BACKEND}/api/snippets`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              slug,
              content: '// Start typing or paste your code or image here...\n\n',
              language: 'javascript',
            }),
          })
          res = await fetchWithRetry(`${BACKEND}/api/snippets/${encodeURIComponent(slug)}`)
        }

        if (!res.ok) throw new Error('failed')

        const data = await res.json()
        isRemote.current = true
        setCode(data.content)
        setLanguage(data.language)
        if (Array.isArray(data.images) && data.images.length > 0)
          setPastedImages((data.images as BackendImage[]).map(fromBackendImage))
        if (Array.isArray(data.files) && data.files.length > 0)
          setSharedFiles(data.files as SharedFile[])
        setTimeout(() => { isRemote.current = false }, 50)
        setStatus('ready')
      } catch {
        setStatus('error')
      }
    }

    loadOrCreate()
  }, [slug])

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
          if      (msg.type === 'connected')              setViewers(msg.viewers ?? 1)
          else if (msg.type === 'viewers')                setViewers(msg.count ?? 1)
          else if (msg.type === 'broadcast_edit') {
            isRemote.current = true
            setCode(msg.content); setLanguage(msg.language)
            setTimeout(() => { isRemote.current = false }, 50)
          }
          else if (msg.type === 'broadcast_image')
            setPastedImages(p => p.find(i => i.id === msg.image.id) ? p : [...p, fromBackendImage(msg.image)])
          else if (msg.type === 'broadcast_remove_image')
            setPastedImages(p => p.filter(i => i.id !== msg.id))
          else if (msg.type === 'broadcast_file')
            setSharedFiles(p => p.find(f => f.id === msg.file.id) ? p : [...p, msg.file as SharedFile])
          else if (msg.type === 'broadcast_remove_file')
            setSharedFiles(p => p.filter(f => f.id !== msg.id))
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

  // ── Upload a file to Cloudinary via backend, then broadcast via WS ──────────
  const uploadFile = useCallback(async (file: File) => {
    setFileUploading(true)
    try {
      const form = new FormData()
      form.append('file', file)
      // fetchWithRetry here handles cold-start 502s on upload too
      const res = await fetchWithRetry(`${BACKEND}/api/upload-file`, { method: 'POST', body: form })
      if (!res.ok) throw new Error('upload failed')
      const fileData: SharedFile = await res.json()
      setSharedFiles(prev => prev.find(f => f.id === fileData.id) ? prev : [...prev, fileData])
      wsSend({ type: 'file', file: fileData })
    } catch {
      alert('File upload failed. The server may be waking up — please try again in a moment.')
    } finally {
      setFileUploading(false)
    }
  }, [wsSend])

  const removeFile = useCallback((id: string) => {
    setSharedFiles(p => p.filter(f => f.id !== id))
    wsSend({ type: 'remove_file', id })
  }, [wsSend])

  // ── Drag-and-drop files onto the whole page ───────────────────────────────
  useEffect(() => {
    const onDragOver = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes('Files')) return
      e.preventDefault()
      setIsDraggingFile(true)
    }
    const onDragLeave = (e: DragEvent) => {
      if (!(e.relatedTarget instanceof Node)) setIsDraggingFile(false)
    }
    const onDrop = async (e: DragEvent) => {
      e.preventDefault()
      setIsDraggingFile(false)
      const items = Array.from(e.dataTransfer?.files ?? [])
      for (const file of items) {
        if (file.type.startsWith('image/')) {
          processImage(file)
        } else {
          await uploadFile(file)
        }
      }
    }
    document.addEventListener('dragover',  onDragOver)
    document.addEventListener('dragleave', onDragLeave)
    document.addEventListener('drop',      onDrop)
    return () => {
      document.removeEventListener('dragover',  onDragOver)
      document.removeEventListener('dragleave', onDragLeave)
      document.removeEventListener('drop',      onDrop)
    }
  }, [uploadFile])

  const processImage = useCallback((file: File) => {
    const reader = new FileReader()
    reader.onload = ev => {
      const url = ev.target?.result as string
      const image = new Image()
      image.onload = () => {
        const newImg: PastedImage = {
          id: crypto.randomUUID(), url,
          width: image.naturalWidth, height: image.naturalHeight,
        }
        setPastedImages(prev => [...prev, newImg])
        wsSend({ type: 'image', image: toBackendImage(newImg) })
      }
      image.src = url
    }
    reader.readAsDataURL(file)
  }, [wsSend])

  const handleEditorMount = useCallback((editor: Monaco.editor.IStandaloneCodeEditor, monaco: typeof Monaco) => {
    editorRef.current = editor; monacoRef.current = monaco
  }, [])

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

  const [copied, setCopied] = useState(false)
  const copyUrl = () => {
    navigator.clipboard.writeText(window.location.href)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  if (!slug) return null

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }} className={isDark ? 'bg-[#1e1e1e]' : 'bg-white'}>

      {/* Drag overlay */}
      {isDraggingFile && (
        <div className="fixed inset-0 z-50 bg-blue-600/20 border-4 border-dashed border-blue-500 flex items-center justify-center pointer-events-none">
          <div className="bg-blue-600 text-white px-6 py-3 rounded-xl text-lg font-semibold shadow-2xl">
            Drop files to share
          </div>
        </div>
      )}

      {/* Navbar */}
      <nav className={`flex items-center justify-between px-5 h-12 shrink-0 border-b ${isDark ? 'bg-[#1e1e1e] border-[#3c3c3c]' : 'bg-white border-gray-200'}`}>
        <button
          onClick={() => navigate(`/${randomSlug()}`)}
          className={`text-base font-bold tracking-tight ${isDark ? 'text-white' : 'text-gray-900'}`}
        >
          <span className={isDark ? 'text-blue-400' : 'text-blue-600'}>×</span>devshare
        </button>

        <div className="flex items-center gap-2">
          {/* Live dot */}
          <span
            title={wsReady ? 'Live' : 'Connecting…'}
            className={`w-2 h-2 rounded-full ${wsReady ? 'bg-green-500' : 'bg-yellow-400 animate-pulse'}`}
          />

          {/* Upload file button */}
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            multiple
            onChange={async e => {
              const files = Array.from(e.target.files ?? [])
              for (const f of files) {
                if (f.type.startsWith('image/')) processImage(f)
                else await uploadFile(f)
              }
              e.target.value = ''
            }}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            title="Upload file"
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs font-medium transition-colors
              ${isDark ? 'hover:bg-[#2d2d2d] text-gray-400 hover:text-gray-200' : 'hover:bg-gray-100 text-gray-500 hover:text-gray-700'}`}
          >
            <IconUpload />
            <span>Upload</span>
          </button>

          {/* Theme toggle */}
          <button
            onClick={() => setTheme(t => t === 'dark' ? 'light' : 'dark')}
            title={isDark ? 'Switch to light' : 'Switch to dark'}
            className={`w-8 h-8 rounded flex items-center justify-center transition-colors ${isDark ? 'hover:bg-[#2d2d2d] text-gray-400' : 'hover:bg-gray-100 text-gray-500'}`}
          >
            {isDark ? <IconSun /> : <IconMoon />}
          </button>

          {/* Share button */}
          <button
            onClick={copyUrl}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-sm font-medium transition-colors ${copied ? 'bg-green-600 text-white' : 'bg-blue-600 hover:bg-blue-700 text-white'}`}
          >
            {copied ? <IconCheck /> : <IconLink />}
            {copied ? 'Copied' : 'Share'}
          </button>
        </div>
      </nav>

      {/* Status banners */}
      {status === 'loading' && (
        <div className={`text-xs px-5 py-2 ${isDark ? 'bg-[#2d2d2d] text-gray-400' : 'bg-gray-100 text-gray-500'}`}>
          Loading room…
        </div>
      )}
      {status === 'waking' && (
        <div className={`text-xs px-5 py-2 flex items-center gap-2 ${isDark ? 'bg-yellow-900/30 text-yellow-300' : 'bg-yellow-50 text-yellow-700'}`}>
          <svg className="animate-spin w-3 h-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
          </svg>
          Server is waking up — this may take a few seconds…
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
                <img
                  src={img.url} alt="pasted"
                  className="h-14 w-auto rounded border object-cover"
                  style={{ borderColor: isDark ? '#3c3c3c' : '#e5e7eb' }}
                />
                <span className={`absolute bottom-0.5 left-0.5 text-[9px] px-1 rounded pointer-events-none ${isDark ? 'bg-black/70 text-gray-300' : 'bg-black/50 text-white'}`}>
                  {img.width}×{img.height}
                </span>
                <button
                  onClick={e => { e.stopPropagation(); removeImage(img.id) }}
                  className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-red-600 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  <IconX />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* File strip */}
      {(sharedFiles.length > 0 || fileUploading) && slug && (
        <FileStrip
          files={sharedFiles}
          isDark={isDark}
          slug={slug}
          onRemove={removeFile}
          uploading={fileUploading}
        />
      )}

      {/* Status bar */}
      <div className={`h-6 shrink-0 flex items-center px-4 gap-3 text-[11px] ${isDark ? 'bg-[#007acc] text-white' : 'bg-blue-600 text-white'}`}>
        <span className="opacity-70 font-mono">/{slug}</span>
        {viewers > 0 && (
          <>
            <span className="opacity-40">|</span>
            <span>{viewers} viewer{viewers !== 1 ? 's' : ''}</span>
          </>
        )}
        {pastedImages.length > 0 && (
          <>
            <span className="opacity-40">|</span>
            <span>{pastedImages.length} image{pastedImages.length > 1 ? 's' : ''}</span>
          </>
        )}
        {sharedFiles.length > 0 && (
          <>
            <span className="opacity-40">|</span>
            <span>{sharedFiles.length} file{sharedFiles.length > 1 ? 's' : ''}</span>
          </>
        )}
      </div>

      {viewerImage && <ImageViewer img={viewerImage} onClose={() => setViewerImage(null)} />}
    </div>
  )
}