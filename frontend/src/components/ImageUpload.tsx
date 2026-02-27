// import { useRef, useState, useCallback } from 'react'
// import type { ImageFile } from '../App'

// interface ImageUploadProps {
//   images: ImageFile[]
//   onImagesChange: (imgs: ImageFile[]) => void
//   theme: 'dark' | 'light'
// }

// export function ImageUpload({ images, onImagesChange, theme }: ImageUploadProps) {
//   const [dragging, setDragging] = useState(false)
//   const fileInputRef = useRef<HTMLInputElement>(null)
//   const isDark = theme === 'dark'

//   const processFiles = useCallback((files: FileList | null) => {
//     if (!files) return
//     Array.from(files)
//       .filter(f => f.type.startsWith('image/'))
//       .forEach(file => {
//         const reader = new FileReader()
//         reader.onload = e => {
//           const newImg: ImageFile = {
//             id: crypto.randomUUID(),
//             name: file.name,
//             url: e.target?.result as string,
//             size: file.size,
//           }
//           onImagesChange(prev => [...prev, newImg])
//         }
//         reader.readAsDataURL(file)
//       })
//   }, [onImagesChange])

//   const handleDrop = (e: React.DragEvent) => {
//     e.preventDefault()
//     setDragging(false)
//     processFiles(e.dataTransfer.files)
//   }

//   const removeImage = (id: string) => {
//     onImagesChange(images.filter(i => i.id !== id))
//   }

//   const bg = isDark ? 'bg-[#1e1e1e]' : 'bg-white'
//   const border = isDark ? 'border-[#3c3c3c]' : 'border-gray-200'
//   const text = isDark ? 'text-gray-400' : 'text-gray-500'

//   return (
//     <div className={`h-full flex flex-col ${bg}`}>

//       {/* Drop zone */}
//       <div
//         className={`m-4 rounded border-2 border-dashed transition-colors cursor-pointer
//           ${dragging
//             ? isDark ? 'border-blue-500 bg-blue-500/10' : 'border-blue-400 bg-blue-50'
//             : isDark ? 'border-[#444] hover:border-[#666]' : 'border-gray-300 hover:border-gray-400'
//           }`}
//         onClick={() => fileInputRef.current?.click()}
//         onDragOver={e => { e.preventDefault(); setDragging(true) }}
//         onDragLeave={() => setDragging(false)}
//         onDrop={handleDrop}
//       >
//         <div className={`flex flex-col items-center justify-center py-8 gap-2 ${text}`}>
//           <span className="text-3xl">📁</span>
//           <p className="text-sm font-medium">Drop images here or click to upload</p>
//           <p className="text-xs opacity-60">PNG, JPG, GIF, WebP, SVG</p>
//         </div>
//       </div>

//       <input
//         ref={fileInputRef}
//         type="file"
//         accept="image/*"
//         multiple
//         className="hidden"
//         onChange={e => processFiles(e.target.files)}
//       />

//       {/* Image grid */}
//       {images.length > 0 && (
//         <div className="flex-1 overflow-y-auto px-4 pb-4">
//           <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
//             {images.map(img => (
//               <div
//                 key={img.id}
//                 className={`relative group rounded overflow-hidden border ${border}`}
//               >
//                 <img
//                   src={img.url}
//                   alt={img.name}
//                   className="w-full h-36 object-cover"
//                 />
//                 {/* Overlay on hover */}
//                 <div className="absolute inset-0 bg-black/0 group-hover:bg-black/50 transition-colors flex items-center justify-center">
//                   <button
//                     onClick={() => removeImage(img.id)}
//                     className="opacity-0 group-hover:opacity-100 transition-opacity px-2 py-1 rounded bg-red-600 text-white text-xs font-medium"
//                   >
//                     Remove
//                   </button>
//                 </div>
//                 {/* Name */}
//                 <div className={`px-2 py-1 text-xs truncate ${isDark ? 'bg-[#252526] text-gray-400' : 'bg-gray-50 text-gray-500'}`}>
//                   {img.name}
//                 </div>
//               </div>
//             ))}
//           </div>
//         </div>
//       )}
//     </div>
//   )
// }