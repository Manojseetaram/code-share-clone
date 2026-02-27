
import './App.css'

import { useState, useRef, useCallback, useEffect } from 'react'
import Editor from '@monaco-editor/react'
import type * as Monaco from 'monaco-editor'

// ─── Share Modal ───
function ShareModal({ onClose, theme }: { onClose: () => void; theme: 'dark' | 'light' }) {
  const isDark = theme === 'dark'
  const [slug, setSlug] = useState(() => {
    const w1 = ['fast','cold','blue','wild','calm','grey','deep','bold']
    const w2 = ['river','peak','star','loop','byte','node','fire','wave']
    return `${w1[Math.floor(Math.random()*8)]}-${w2[Math.floor(Math.random()*8)]}-${Math.floor(Math.random()*9000)+1000}`
  })
  const [copied, setCopied] = useState(false)

  const copy = () => {
    navigator.clipboard.writeText(`https://codeshare.io/${slug.replace(/[^a-z0-9-]/gi,'-').toLowerCase()}`)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={e => e.target === e.currentTarget && onClose()}
    >
      <div className={`w-[420px] mx-4 rounded-lg shadow-2xl border ${
        isDark ? 'bg-[#1e1e1e] border-[#3c3c3c]' : 'bg-white border-gray-200'
      }`}>
        <div className={`flex items-center justify-between px-5 py-4 border-b ${isDark ? 'border-[#3c3c3c]' : 'border-gray-100'}`}>
          <span className={`font-semibold ${isDark ? 'text-white' : 'text-gray-900'}`}>Share</span>
          <button onClick={onClose} className={`text-xl leading-none ${isDark ? 'text-gray-400 hover:text-white' : 'text-gray-400 hover:text-gray-700'}`}>×</button>
        </div>
        <div className="px-5 py-5 flex flex-col gap-4">
          <div>
            <label className={`block text-xs mb-2 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>Custom URL</label>
            <input
              value={slug}
              onChange={e => setSlug(e.target.value)}
              className={`w-full px-3 py-2 rounded border text-sm font-mono outline-none ${
                isDark
                  ? 'bg-[#2d2d2d] border-[#555] text-gray-200 focus:border-blue-500'
                  : 'bg-gray-50 border-gray-300 text-gray-800 focus:border-blue-500'
              }`}
            />
            <p className={`mt-1.5 text-xs font-mono ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
              codeshare.io/<span className={isDark ? 'text-blue-400' : 'text-blue-600'}>{slug.replace(/[^a-z0-9-]/gi,'-').toLowerCase()}</span>
            </p>
          </div>
          <button
            onClick={copy}
            className={`w-full py-2.5 rounded text-sm font-medium transition-colors ${
              copied ? 'bg-green-600 text-white' : 'bg-blue-600 hover:bg-blue-700 text-white'
            }`}
          >
            {copied ? '✓ Copied!' : 'Copy Link'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Main App ───
interface PastedImage {
  id: string
  dataUrl: string
  width: number
  height: number
}

export default function App() {
  const [theme, setTheme] = useState<'dark' | 'light'>('dark')
  const [shareOpen, setShareOpen] = useState(false)
  const [pastedImages, setPastedImages] = useState<PastedImage[]>([])
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null)
  const monacoRef = useRef<typeof Monaco | null>(null)
  const isDark = theme === 'dark'

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
        <span className={`text-base font-bold tracking-tight ${isDark ? 'text-white' : 'text-gray-900'}`}>
          <span className={isDark ? 'text-blue-400' : 'text-blue-600'}>×</span>codeshare
        </span>
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

      {/* ── Monaco Editor ── */}
      <div style={{ flex: 1, overflow: 'hidden' }}>
        <Editor
          height="100%"
          defaultLanguage="javascript"
          defaultValue={`// Start typing or paste your code here...\n\n`}
          theme={isDark ? 'vs-dark' : 'vs'}
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
      <div className="h-6 shrink-0 flex items-center px-4 gap-4 text-[11px] bg-blue-600 text-white">
        <span>JavaScript</span>
        <span className="opacity-50">|</span>
        <span>UTF-8</span>
        <span className="opacity-50">|</span>
        <span>Spaces: 2</span>
        {pastedImages.length > 0 && <>
          <span className="opacity-50">|</span>
          <span>{pastedImages.length} image{pastedImages.length > 1 ? 's' : ''}</span>
        </>}
      </div>

      {shareOpen && <ShareModal onClose={() => setShareOpen(false)} theme={theme} />}
    </div>
  )
}