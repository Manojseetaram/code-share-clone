import './App.css'
import { useState, useRef, useEffect, useCallback } from 'react'
import Editor, { type OnMount } from '@monaco-editor/react'
import { useParams, useNavigate } from 'react-router-dom'

// ─── Config ───────────────────────────────────────────────────────────────────
const BACKEND    = ((import.meta.env.VITE_BACKEND_URL as string | undefined) ?? '').replace(/\/+$/, '')
const WS_BACKEND = BACKEND
  ? BACKEND.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:')
  : 'ws://localhost:3001'

const DEFAULT_CODE = '// Start typing or paste your code, image or any file here...\n\n'

// ─── Types ────────────────────────────────────────────────────────────────────
interface PastedImage { id: string; url: string; width: number; height: number }
interface BackendImage { id: string; url: string; width: number; height: number }
const toBackendImage   = (img: PastedImage): BackendImage => ({ ...img })
const fromBackendImage = (img: BackendImage): PastedImage => ({ ...img })

interface SharedFile { id: string; name: string; url: string; size: number; mime: string; folder?: string | null }

interface SnippetData {
  content: string
  language: string
  images?: BackendImage[]
  files?: SharedFile[]
}

// ─── Slug helpers (MUST match the backend `sanitize` / `validate`) ────────────
const RESERVED_SLUGS = ['api', 'admin', 'health', 'ws', 'new', 'static', 'assets']

function normalizeSlug(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/^-+|-+$/g, '')
}

function isValidSlug(slug: string): boolean {
  return (
    slug.length >= 3 &&
    slug.length <= 60 &&
    /^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(slug) &&
    !RESERVED_SLUGS.includes(slug)
  )
}

function randomSlug(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'
  const bytes = new Uint8Array(8)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, b => alphabet[b % alphabet.length]).join('')
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
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
function ImageViewer({ img, slug, onClose }: { img: PastedImage; slug: string; onClose: () => void }) {
  useEffect(() => {
    const fn = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', fn)
    return () => window.removeEventListener('keydown', fn)
  }, [onClose])
  return (
    <div className="fixed inset-0 z-[100] bg-black/80 flex items-center justify-center" onClick={onClose}>
      <img
        src={`${BACKEND}/api/snippets/${encodeURIComponent(slug)}/images/${encodeURIComponent(img.id)}`}
        alt="full"
        className="max-w-[90vw] max-h-[90vh] object-contain rounded shadow-2xl"
        onClick={e => e.stopPropagation()}
      />
      <button onClick={onClose} className="absolute top-4 right-4 text-white text-2xl w-9 h-9 flex items-center justify-center rounded-full bg-black/50 hover:bg-black/80">
        <IconX />
      </button>
    </div>
  )
}

// ─── File strip ───────────────────────────────────────────────────────────────
function FileStrip({
  files, isDark, slug, onRemove, uploading, progress, onOpen
}: {
  files: SharedFile[]
  isDark: boolean
  slug: string
  onRemove: (id: string) => void
  uploading: boolean
  progress: number | null
  onOpen: (f: SharedFile) => void
}) {
  const proxyUrl = (fileId: string) =>
    `${BACKEND}/api/snippets/${encodeURIComponent(slug)}/files/${encodeURIComponent(fileId)}`

  // Backend answers ?dl=1 with a redirect to a presigned S3 URL (attachment),
  // so the browser streams the download itself — no memory use, any size.
  const downloadSingle = (f: SharedFile) => {
    const a = document.createElement('a')
    a.href = `${proxyUrl(f.id)}?dl=1`
    a.download = f.name
    document.body.appendChild(a)
    a.click()
    a.remove()
  }

  // The server responds with Content-Disposition: attachment, so a plain
  // navigation streams the zip straight to disk.
  const downloadZip = () => {
    const a = document.createElement('a')
    a.href = `${BACKEND}/api/snippets/${encodeURIComponent(slug)}/download-zip`
    a.download = `${slug}.zip`
    document.body.appendChild(a)
    a.click()
    a.remove()
  }

  return (
    <div className={`shrink-0 border-t ${isDark ? 'border-[#3c3c3c] bg-[#252526]' : 'border-gray-200 bg-gray-50'}`}>
      <div className="flex items-center gap-2 px-4 py-2 overflow-x-auto">

        <span className={`text-xs shrink-0 font-medium ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
          Files ({files.length})
        </span>

        {files.map(f => (
          <div
            key={f.id}
            onClick={() => onOpen(f)}
            className={`group relative flex items-center gap-2 shrink-0 rounded px-2.5 py-1.5 text-xs border cursor-pointer
              ${isDark ? 'bg-[#1e1e1e] border-[#3c3c3c] text-gray-300' : 'bg-white border-gray-200 text-gray-700'}`}
          >
            {f.folder && (
              <span className={`text-[10px] px-1.5 py-0.5 rounded self-center ${isDark ? 'bg-[#3c3c3c] text-gray-300' : 'bg-gray-100 text-gray-600'}`}>
                {f.folder}
              </span>
            )}
            {f.mime.startsWith('video/') ? (
              <video
                src={proxyUrl(f.id)}
                preload="metadata"
                controls
                onClick={e => e.stopPropagation()}
                className="h-14 rounded bg-black"
              />
            ) : (
              <>
                <span className="text-base leading-none">{fileIcon(f.mime)}</span>
                <div className="flex flex-col min-w-0 max-w-[120px]">
                  <span className="truncate font-medium leading-tight">{f.name}</span>
                  <span className={`text-[10px] ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>{formatBytes(f.size)}</span>
                </div>
              </>
            )}
            <button
              onClick={(e) => { e.stopPropagation(); downloadSingle(f) }}
              className={`ml-1 opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded
                ${isDark ? 'text-blue-400 hover:text-blue-300' : 'text-blue-600 hover:text-blue-700'}`}
              title="Download"
            >
              <IconDownload />
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); onRemove(f.id) }}
              className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-red-600 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
              title="Remove"
            >
              <IconX />
            </button>
          </div>
        ))}

        {uploading && (
          <div className={`flex items-center gap-2 text-xs px-2 shrink-0 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
            <svg className="animate-spin w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
            </svg>
            <span>Uploading{progress !== null ? ` ${progress}%` : '…'}</span>
            {progress !== null && (
              <div className={`w-24 h-1.5 rounded overflow-hidden ${isDark ? 'bg-[#3c3c3c]' : 'bg-gray-200'}`}>
                <div className="h-full bg-blue-500 transition-all" style={{ width: `${progress}%` }} />
              </div>
            )}
          </div>
        )}

        {files.length > 1 && (
          <button
            onClick={downloadZip}
            className={`shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs font-medium transition-colors ml-auto
              ${isDark ? 'bg-[#3c3c3c] hover:bg-[#4a4a4a] text-gray-200' : 'bg-gray-200 hover:bg-gray-300 text-gray-700'}`}
          >
            <IconDownload />
            Download all (.zip)
          </button>
        )}
      </div>
    </div>
  )
}

// ─── File viewer (video / pdf / text / image) ─────────────────────────────────
function FileViewer({ file, slug, onClose }: { file: SharedFile; slug: string; onClose: () => void }) {
  const [text, setText] = useState<string | null>(null)
  const proxyUrl = `${BACKEND}/api/snippets/${encodeURIComponent(slug)}/files/${encodeURIComponent(file.id)}`

  useEffect(() => {
    const fn = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', fn)
    return () => window.removeEventListener('keydown', fn)
  }, [onClose])

  useEffect(() => {
    if (!file.mime.startsWith('text/')) return
    let dead = false
    fetch(proxyUrl)
      .then(r => r.text())
      .then(t => { if (!dead) setText(t) })
      .catch(() => { if (!dead) setText('Could not load file.') })
    return () => { dead = true }
  }, [file, proxyUrl])

  const isPlainFile =
    !file.mime.startsWith('video/') &&
    !file.mime.startsWith('audio/') &&
    !file.mime.startsWith('image/') &&
    file.mime !== 'application/pdf' &&
    !file.mime.startsWith('text/')

  return (
    <div className="fixed inset-0 z-[100] bg-black/80 flex items-center justify-center" onClick={onClose}>
      <div className="bg-[#252526] rounded-lg p-3 max-w-[95vw] max-h-[90vh] overflow-auto" onClick={e => e.stopPropagation()}>
        {file.mime.startsWith('video/') && <video src={proxyUrl} controls autoPlay className="max-w-[80vw] max-h-[70vh] rounded" />}
        {file.mime.startsWith('audio/') && <audio src={proxyUrl} controls autoPlay />}
        {file.mime.startsWith('image/') && <img src={proxyUrl} alt={file.name} className="max-w-[80vw] max-h-[70vh] rounded" />}
        {file.mime === 'application/pdf' && <iframe src={proxyUrl} title={file.name} className="w-[80vw] h-[70vh] rounded bg-white" />}
        {file.mime.startsWith('text/') && (
          text === null
            ? <div className="text-gray-400 text-sm p-4">Loading…</div>
            : <pre className="text-xs text-gray-200 whitespace-pre-wrap break-all max-h-[70vh] overflow-auto">{text}</pre>
        )}
        {isPlainFile && (
          <a href={`${proxyUrl}?dl=1`} download={file.name} className="text-blue-400 underline text-sm">Download file</a>
        )}
      </div>
      <button onClick={onClose} className="absolute top-4 right-4 text-white text-2xl w-9 h-9 flex items-center justify-center rounded-full bg-black/50 hover:bg-black/80">
        <IconX />
      </button>
    </div>
  )
}

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  const { slug: rawSlug } = useParams<{ slug?: string }>()
  const navigate = useNavigate()

  // Canonical slug: anything the backend would rewrite is redirected first,
  // so frontend and backend always agree on the room name.
  const normalized = rawSlug ? normalizeSlug(rawSlug) : ''
  const slugOk     = isValidSlug(normalized)
  const slug       = rawSlug && slugOk && normalized === rawSlug ? rawSlug : undefined

  const [theme, setTheme]                   = useState<'dark' | 'light'>('dark')
  const [pastedImages, setPastedImages]     = useState<PastedImage[]>([])
  const [sharedFiles, setSharedFiles]       = useState<SharedFile[]>([])
  const [uploadsActive, setUploadsActive]   = useState(0)
  const [uploadProgress, setUploadProgress] = useState<number | null>(null)
  const [viewerImage, setViewerImage]       = useState<PastedImage | null>(null)
  const [viewerFile, setViewerFile]         = useState<SharedFile | null>(null)
  const [code, setCode]                     = useState(DEFAULT_CODE)
  const [language, setLanguage]             = useState('javascript')
  const [viewers, setViewers]               = useState(1)
  const [wsReady, setWsReady]               = useState(false)
  const [status, setStatus]                 = useState<'loading' | 'ready' | 'error' | 'waking'>('loading')
  const [isDraggingFile, setIsDraggingFile] = useState(false)
  const [copied, setCopied]                 = useState(false)

  const wsRef        = useRef<WebSocket | null>(null)
  const isRemote     = useRef(false)
  const sendTimer    = useRef<ReturnType<typeof setTimeout> | null>(null)
  const reconnTimer  = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const isDark       = theme === 'dark'
  const fileUploading = uploadsActive > 0

  // ── Redirect to a canonical / valid slug ────────────────────────────────────
  useEffect(() => {
    if (!rawSlug || !slugOk) navigate(`/${randomSlug()}`, { replace: true })
    else if (normalized !== rawSlug) navigate(`/${normalized}`, { replace: true })
  }, [rawSlug, slugOk, normalized, navigate])

  // ── Apply a snapshot from the server ────────────────────────────────────────
  const applySnippet = useCallback((data: SnippetData) => {
    isRemote.current = true
    setCode(data.content)
    setLanguage(data.language)
    setPastedImages(Array.isArray(data.images) ? data.images.map(fromBackendImage) : [])
    setSharedFiles(Array.isArray(data.files) ? data.files : [])
    setTimeout(() => { isRemote.current = false }, 50)
  }, [])

  // ── Load (or create) the room ───────────────────────────────────────────────
  useEffect(() => {
    if (!slug) return
    let cancelled = false

    // reset everything from the previous room
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setStatus('loading')
    setCode(DEFAULT_CODE)
    setLanguage('javascript')
    setPastedImages([])
    setSharedFiles([])
    setViewerImage(null)
    setViewerFile(null)
    if (sendTimer.current) clearTimeout(sendTimer.current)

    const url = `${BACKEND}/api/snippets/${encodeURIComponent(slug)}`

    async function loadOrCreate() {
      try {
        let res = await fetchWithRetry(url)

        if (!res.ok && res.status !== 404) {
          if (cancelled) return
          setStatus('waking')
          res = await fetchWithRetry(url, undefined, 6, 3000)
        }

        if (res.status === 404) {
          await fetchWithRetry(`${BACKEND}/api/snippets`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ slug, content: DEFAULT_CODE, language: 'javascript' }),
          })
          res = await fetchWithRetry(url)
        }

        if (!res.ok) throw new Error('failed')
        const data = (await res.json()) as SnippetData
        if (cancelled) return
        applySnippet(data)
        setStatus('ready')
      } catch {
        if (!cancelled) setStatus('error')
      }
    }

    loadOrCreate()
    return () => { cancelled = true }
  }, [slug, applySnippet])

  // ── WebSocket with auto-reconnect + resync ──────────────────────────────────
  useEffect(() => {
    if (!slug) return
    let dead = false
    let hasOpened = false

    async function resync() {
      try {
        const res = await fetch(`${BACKEND}/api/snippets/${encodeURIComponent(slug as string)}`)
        if (res.ok && !dead) applySnippet((await res.json()) as SnippetData)
      } catch { /* ignore, next reconnect will retry */ }
    }

    function connect() {
      if (dead) return
      const ws = new WebSocket(`${WS_BACKEND}/ws/${encodeURIComponent(slug as string)}`)
      wsRef.current = ws

      ws.onopen = () => {
        if (dead) return
        setWsReady(true)
        if (hasOpened) resync() // we may have missed edits while offline
        hasOpened = true
      }
      ws.onerror = () => ws.close()
      ws.onclose = () => {
        setWsReady(false)
        if (!dead) reconnTimer.current = setTimeout(connect, 3000)
      }
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data)
          if      (msg.type === 'connected') setViewers(msg.viewers ?? 1)
          else if (msg.type === 'viewers')   setViewers(msg.count ?? 1)
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
        } catch (err) {
          console.warn('ws message error', err)
        }
      }
    }

    connect()
    return () => {
      dead = true
      if (reconnTimer.current) clearTimeout(reconnTimer.current)
      wsRef.current?.close()
      wsRef.current = null
    }
  }, [slug, applySnippet])

  const wsSend = useCallback((msg: object): boolean => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg))
      return true
    }
    return false
  }, [])

  // ── Upload a file straight to S3 via a presigned URL, then broadcast via WS ─
  const uploadFile = useCallback(async (file: File) => {
    setUploadsActive(n => n + 1)
    setUploadProgress(0)
    try {
      const mime = file.type || 'application/octet-stream'

      const pres = await fetchWithRetry(`${BACKEND}/api/presign-upload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: file.name, mime, size: file.size }),
      })
      if (!pres.ok) {
        let msg = 'could not start upload'
        try { const j = await pres.json(); msg = (j as { error?: string }).error ?? msg } catch { void 0 }
        throw new Error(msg)
      }
      const { upload_url, file: fileData } =
        await pres.json() as { upload_url: string; file: SharedFile }

      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest()
        xhr.open('PUT', upload_url)
        xhr.setRequestHeader('Content-Type', mime) // must match what was signed
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) setUploadProgress(Math.round((e.loaded / e.total) * 100))
        }
        xhr.onload  = () => (xhr.status >= 200 && xhr.status < 300)
          ? resolve()
          : reject(new Error(`S3 responded ${xhr.status}`))
        xhr.onerror = () => reject(new Error('network error during upload (check S3 CORS)'))
        xhr.send(file)
      })

      setSharedFiles(prev => prev.find(f => f.id === fileData.id) ? prev : [...prev, fileData])
      wsSend({ type: 'file', file: fileData })
    } catch (err) {
      alert(`File upload failed: ${err instanceof Error ? err.message : 'unknown error'}`)
    } finally {
      setUploadsActive(n => Math.max(0, n - 1))
      setUploadProgress(null)
    }
  }, [wsSend])

  const removeFile = useCallback((id: string) => {
    setSharedFiles(p => p.filter(f => f.id !== id))
    wsSend({ type: 'remove_file', id })
  }, [wsSend])

  const processImage = useCallback(async (file: File, roomSlug: string) => {
    try {
      const form = new FormData()
      form.append('file', file)
      const res = await fetchWithRetry(`${BACKEND}/api/upload`, { method: 'POST', body: form }, 1)
      if (!res.ok) {
        let msg = 'upload failed'
        try { const j = await res.json(); msg = (j as { error?: string }).error ?? msg } catch { void 0 }
        throw new Error(msg)
      }
      const image: BackendImage = await res.json()

      // Decode dimensions through the backend proxy (S3 bucket may be private).
      // The image isn't attached to the room yet, so read dims from the local file instead.
      let width = 0
      let height = 0
      try {
        const localUrl = URL.createObjectURL(file)
        const dims = await new Promise<{ w: number; h: number }>((resolve, reject) => {
          const img = new Image()
          img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight })
          img.onerror = () => reject(new Error('decode failed'))
          img.src = localUrl
        }).finally(() => URL.revokeObjectURL(localUrl))
        width = dims.w
        height = dims.h
      } catch { /* keep 0x0 */ }

      const newImg: PastedImage = { id: image.id, url: image.url, width, height }
      setPastedImages(prev => [...prev, newImg])
      wsSend({ type: 'image', image: toBackendImage(newImg) })
      void roomSlug
    } catch (err) {
      alert(`Image upload failed: ${err instanceof Error ? err.message : 'unknown error'}`)
    }
  }, [wsSend])

  // ── Drag-and-drop files onto the whole page ─────────────────────────────────
  useEffect(() => {
    if (!slug) return
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
        if (file.type.startsWith('image/')) processImage(file, slug)
        else await uploadFile(file)
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
  }, [uploadFile, processImage, slug])

  const handleEditorMount: OnMount = useCallback((editor, monaco) => {
    editor.updateOptions({
      lightbulb: { enabled: monaco.editor.ShowLightbulbIconMode.Off },
    })
  }, [])

  // ── Paste images from clipboard into the editor ─────────────────────────────
  useEffect(() => {
    if (!slug) return
    const handler = (e: ClipboardEvent) => {
      const active = document.activeElement
      if (!active) return
      if (!active.classList.contains('inputarea') && !active.closest('.monaco-editor')) return
      const imageItem = Array.from(e.clipboardData?.items || []).find(i => i.type.startsWith('image/'))
      if (!imageItem) return
      e.preventDefault(); e.stopPropagation()
      const file = imageItem.getAsFile()
      if (file) processImage(file, slug)
    }
    document.addEventListener('paste', handler, true)
    return () => document.removeEventListener('paste', handler, true)
  }, [processImage, slug])

  // ── Send edits (WebSocket, with HTTP PATCH fallback when offline) ───────────
  const sendEdit = useCallback((content: string, lang: string) => {
    if (!slug) return
    if (wsSend({ type: 'edit', content, language: lang })) return
    fetch(`${BACKEND}/api/snippets/${encodeURIComponent(slug)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, language: lang }),
    }).catch(() => { /* will resync on reconnect */ })
  }, [wsSend, slug])

  const handleCodeChange = useCallback((val: string | undefined) => {
    if (isRemote.current) return
    const v = val ?? ''
    setCode(v)
    if (sendTimer.current) clearTimeout(sendTimer.current)
    sendTimer.current = setTimeout(() => sendEdit(v, language), 300)
  }, [sendEdit, language])

  useEffect(() => () => { if (sendTimer.current) clearTimeout(sendTimer.current) }, [])

  const removeImage = useCallback((id: string) => {
    setPastedImages(p => p.filter(i => i.id !== id))
    wsSend({ type: 'remove_image', id })
  }, [wsSend])

  const copyUrl = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      window.prompt('Copy this link:', window.location.href)
    }
  }

  if (!slug) return null

  const proxyImageUrl = (imageId: string) =>
    `${BACKEND}/api/snippets/${encodeURIComponent(slug)}/images/${encodeURIComponent(imageId)}`

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
          <span
            title={wsReady ? 'Live' : 'Connecting…'}
            className={`w-2 h-2 rounded-full ${wsReady ? 'bg-green-500' : 'bg-yellow-400 animate-pulse'}`}
          />

          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            multiple
            onChange={async e => {
              const files = Array.from(e.target.files ?? [])
              e.target.value = ''
              for (const f of files) {
                if (f.type.startsWith('image/')) processImage(f, slug)
                else await uploadFile(f)
              }
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

          <button
            onClick={() => setTheme(t => t === 'dark' ? 'light' : 'dark')}
            title={isDark ? 'Switch to light' : 'Switch to dark'}
            className={`w-8 h-8 rounded flex items-center justify-center transition-colors ${isDark ? 'hover:bg-[#2d2d2d] text-gray-400' : 'hover:bg-gray-100 text-gray-500'}`}
          >
            {isDark ? <IconSun /> : <IconMoon />}
          </button>

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
        <div className="bg-red-900/40 border-b border-red-800 text-red-300 text-xs px-5 py-2 flex items-center gap-3">
          <span>Could not connect to server. Check your internet connection.</span>
          <button onClick={() => window.location.reload()} className="underline">Retry</button>
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
                  src={proxyImageUrl(img.id)} alt="pasted"
                  className="h-14 w-auto rounded border object-cover"
                  style={{ borderColor: isDark ? '#3c3c3c' : '#e5e7eb' }}
                />
                {img.width > 0 && img.height > 0 && (
                  <span className={`absolute bottom-0.5 left-0.5 text-[9px] px-1 rounded pointer-events-none ${isDark ? 'bg-black/70 text-gray-300' : 'bg-black/50 text-white'}`}>
                    {img.width}×{img.height}
                  </span>
                )}
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
      {(sharedFiles.length > 0 || fileUploading) && (
        <FileStrip
          files={sharedFiles}
          isDark={isDark}
          slug={slug}
          onRemove={removeFile}
          uploading={fileUploading}
          progress={uploadProgress}
          onOpen={setViewerFile}
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

      {viewerImage && <ImageViewer img={viewerImage} slug={slug} onClose={() => setViewerImage(null)} />}
      {viewerFile && <FileViewer file={viewerFile} slug={slug} onClose={() => setViewerFile(null)} />}
    </div>
  )
}