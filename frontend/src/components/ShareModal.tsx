// import { useState } from 'react'

// interface ShareModalProps {
//   customUrl: string
//   onCustomUrlChange: (u: string) => void
//   onClose: () => void
//   theme: 'dark' | 'light'
// }

// function generateSlug() {
//   const a = ['fast', 'cold', 'blue', 'wild', 'calm', 'grey']
//   const b = ['river', 'peak', 'star', 'loop', 'byte', 'node']
//   const n = Math.floor(Math.random() * 9000) + 1000
//   return `${a[Math.floor(Math.random() * a.length)]}-${b[Math.floor(Math.random() * b.length)]}-${n}`
// }

// export function ShareModal({ customUrl, onCustomUrlChange, onClose, theme }: ShareModalProps) {
//   const isDark = theme === 'dark'
//   const [slug, setSlug] = useState(customUrl || generateSlug())
//   const [copied, setCopied] = useState(false)
//   const [shared, setShared] = useState(false)

//   const finalUrl = `https://codeshare.io/${slug.replace(/[^a-z0-9-]/gi, '-').toLowerCase()}`

//   const handleShare = () => {
//     setShared(true)
//     onCustomUrlChange(slug)
//   }

//   const handleCopy = () => {
//     navigator.clipboard.writeText(finalUrl)
//     setCopied(true)
//     setTimeout(() => setCopied(false), 2000)
//   }

//   const modalBg = isDark ? 'bg-[#252526] border-[#3c3c3c]' : 'bg-white border-gray-200'
//   const overlayBg = 'bg-black/60'
//   const inputCls = isDark
//     ? 'bg-[#1e1e1e] border-[#555] text-gray-200 focus:border-blue-500'
//     : 'bg-white border-gray-300 text-gray-800 focus:border-blue-500'
//   const labelCls = isDark ? 'text-gray-400' : 'text-gray-500'
//   const textCls = isDark ? 'text-gray-100' : 'text-gray-900'

//   return (
//     <div
//       className={`fixed inset-0 z-50 flex items-center justify-center ${overlayBg}`}
//       onClick={e => { if (e.target === e.currentTarget) onClose() }}
//     >
//       <div className={`w-full max-w-md mx-4 rounded-lg border shadow-xl ${modalBg}`}>

//         {/* Header */}
//         <div className={`flex items-center justify-between px-5 py-4 border-b ${isDark ? 'border-[#3c3c3c]' : 'border-gray-200'}`}>
//           <span className={`font-semibold text-sm ${textCls}`}>Share Snippet</span>
//           <button
//             onClick={onClose}
//             className={`text-lg leading-none ${labelCls} hover:opacity-80`}
//           >✕</button>
//         </div>

//         {/* Body */}
//         <div className="px-5 py-4 flex flex-col gap-4">

//           {/* Custom URL input */}
//           <div>
//             <label className={`block text-xs mb-1.5 ${labelCls}`}>Custom URL slug</label>
//             <div className="flex gap-2">
//               <input
//                 type="text"
//                 value={slug}
//                 onChange={e => { setSlug(e.target.value); setShared(false) }}
//                 className={`flex-1 text-sm px-3 py-2 rounded border outline-none font-mono ${inputCls}`}
//                 placeholder="my-snippet"
//               />
//               <button
//                 onClick={() => { setSlug(generateSlug()); setShared(false) }}
//                 className={`text-xs px-3 py-2 rounded border transition-colors
//                   ${isDark ? 'border-[#555] text-gray-300 hover:bg-[#3c3c3c]' : 'border-gray-300 text-gray-600 hover:bg-gray-50'}`}
//               >
//                 Random
//               </button>
//             </div>
//             <p className={`mt-1.5 text-xs font-mono ${labelCls}`}>
//               codeshare.io/<span className="text-blue-400">{slug.replace(/[^a-z0-9-]/gi, '-').toLowerCase() || 'your-slug'}</span>
//             </p>
//           </div>

//           {/* Shared result */}
//           {shared && (
//             <div className={`flex items-center gap-2 p-3 rounded border text-xs font-mono
//               ${isDark ? 'bg-[#1e1e1e] border-[#3c3c3c] text-gray-300' : 'bg-gray-50 border-gray-200 text-gray-600'}`}
//             >
//               <span className="flex-1 truncate">{finalUrl}</span>
//               <button
//                 onClick={handleCopy}
//                 className={`shrink-0 px-2 py-1 rounded text-xs
//                   ${copied
//                     ? 'bg-green-600 text-white'
//                     : isDark ? 'bg-[#3c3c3c] text-gray-200 hover:bg-[#4c4c4c]' : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
//                   }`}
//               >
//                 {copied ? '✓ Copied' : 'Copy'}
//               </button>
//             </div>
//           )}
//         </div>

//         {/* Footer */}
//         <div className={`flex gap-2 px-5 py-4 border-t ${isDark ? 'border-[#3c3c3c]' : 'border-gray-200'}`}>
//           <button
//             onClick={onClose}
//             className={`flex-1 py-2 text-sm rounded border transition-colors
//               ${isDark ? 'border-[#555] text-gray-300 hover:bg-[#3c3c3c]' : 'border-gray-300 text-gray-600 hover:bg-gray-50'}`}
//           >
//             Cancel
//           </button>
//           <button
//             onClick={handleShare}
//             className="flex-1 py-2 text-sm rounded bg-blue-600 hover:bg-blue-700 text-white font-medium transition-colors"
//           >
//             {shared ? '✓ Shared!' : 'Share'}
//           </button>
//         </div>
//       </div>
//     </div>
//   )
// }