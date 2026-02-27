// import type { Tab } from '../App'

// const LANGUAGES = [
//   'javascript', 'typescript', 'python', 'rust', 'go',
//   'java', 'cpp', 'html', 'css', 'json', 'markdown',
//   'sql', 'shell', 'yaml', 'php', 'csharp',
// ]

// interface ToolbarProps {
//   theme: 'dark' | 'light'
//   tab: Tab
//   language: string
//   customUrl: string
//   onThemeToggle: () => void
//   onTabChange: (t: Tab) => void
//   onLanguageChange: (l: string) => void
//   onCustomUrlChange: (u: string) => void
//   onShare: () => void
// }

// export function Toolbar({
//   theme, tab, language,
//   onThemeToggle, onTabChange, onLanguageChange, onShare,
// }: ToolbarProps) {
//   const isDark = theme === 'dark'

//   const borderClass = isDark ? 'border-[#3c3c3c]' : 'border-gray-200'
//   const bgClass = isDark ? 'bg-[#252526]' : 'bg-gray-50'
//   const textClass = isDark ? 'text-gray-300' : 'text-gray-700'
//   const selectBg = isDark ? 'bg-[#3c3c3c] text-gray-200 border-[#555]' : 'bg-white text-gray-700 border-gray-300'

//   return (
//     <div className={`flex items-center gap-2 px-3 py-2 border-b ${borderClass} ${bgClass} shrink-0`}>

//       {/* Logo */}
//       <span className={`text-sm font-semibold mr-1 ${textClass}`}>CodeShare</span>

//       {/* Divider */}
//       <div className={`w-px h-5 ${isDark ? 'bg-[#555]' : 'bg-gray-300'}`} />

//       {/* Tabs: Code | Image */}
//       <div className={`flex rounded overflow-hidden border ${isDark ? 'border-[#555]' : 'border-gray-300'}`}>
//         {(['code', 'image'] as Tab[]).map(t => (
//           <button
//             key={t}
//             onClick={() => onTabChange(t)}
//             className={`px-3 py-1 text-xs font-medium transition-colors capitalize
//               ${tab === t
//                 ? isDark ? 'bg-[#0e639c] text-white' : 'bg-blue-500 text-white'
//                 : isDark ? 'bg-[#3c3c3c] text-gray-300 hover:bg-[#4c4c4c]' : 'bg-white text-gray-600 hover:bg-gray-100'
//               }`}
//           >
//             {t === 'code' ? '⌨ Code' : '🖼 Image'}
//           </button>
//         ))}
//       </div>

//       {/* Language selector (code tab only) */}
//       {tab === 'code' && (
//         <select
//           value={language}
//           onChange={e => onLanguageChange(e.target.value)}
//           className={`text-xs px-2 py-1 rounded border outline-none ${selectBg}`}
//         >
//           {LANGUAGES.map(l => (
//             <option key={l} value={l}>{l}</option>
//           ))}
//         </select>
//       )}

//       {/* Spacer */}
//       <div className="flex-1" />

//       {/* Theme toggle */}
//       <button
//         onClick={onThemeToggle}
//         className={`text-xs px-2 py-1 rounded border transition-colors
//           ${isDark ? 'border-[#555] text-gray-300 hover:bg-[#3c3c3c]' : 'border-gray-300 text-gray-600 hover:bg-gray-100'}`}
//         title="Toggle theme"
//       >
//         {isDark ? '☀ Light' : '🌙 Dark'}
//       </button>

//       {/* Share */}
//       <button
//         onClick={onShare}
//         className="text-xs px-3 py-1 rounded bg-blue-600 hover:bg-blue-700 text-white font-medium transition-colors"
//       >
//         Share →
//       </button>
//     </div>
//   )
// }