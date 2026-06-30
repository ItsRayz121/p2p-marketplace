'use client'

import { useEditor, EditorContent, type Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Link from '@tiptap/extension-link'
import Placeholder from '@tiptap/extension-placeholder'
import Youtube from '@tiptap/extension-youtube'
import { Iframe } from './iframeExtension'
import { FigureImage } from './figureImageExtension'
import { useRef, useState } from 'react'
import {
  Bold, Italic, Strikethrough, Heading2, Heading3, List, ListOrdered,
  Quote, Code, Link2, ImagePlus, Youtube as YoutubeIcon, Undo2, Redo2, Minus, RemoveFormatting,
} from 'lucide-react'
import { useFileUpload } from '@/hooks/useFileUpload'
import { cn } from '@/lib/utils'

function ToolbarButton({
  onClick, active, disabled, title, children,
}: {
  onClick: () => void
  active?: boolean
  disabled?: boolean
  title: string
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      className={cn(
        'w-8 h-8 flex items-center justify-center rounded-md transition-colors disabled:opacity-40',
        active ? 'bg-primary text-white' : 'text-text-secondary hover:bg-surface-alt',
      )}
    >
      {children}
    </button>
  )
}

function Toolbar({ editor }: { editor: Editor }) {
  const fileRef = useRef<HTMLInputElement>(null)
  const { upload, uploading } = useFileUpload('blog-image')
  const [imgError, setImgError] = useState<string | null>(null)

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = '' // allow re-selecting the same file
    if (!file) return
    setImgError(null)
    try {
      const url = await upload(file)
      // Caption + alt are filled inline on the image itself (click it to edit),
      // so no prompt here.
      editor.chain().focus().setImage({ src: url, alt: '' }).run()
    } catch (err) {
      setImgError(err instanceof Error ? err.message : 'Upload failed')
    }
  }

  function addLink() {
    const prev = editor.getAttributes('link').href as string | undefined
    const url = window.prompt('Link URL:', prev ?? 'https://')
    if (url === null) return
    if (url === '') { editor.chain().focus().extendMarkRange('link').unsetLink().run(); return }
    editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run()
  }

  function addVideo() {
    const url = window.prompt('Paste a video URL — YouTube, Google Drive, or a Telegram public post:', 'https://')
    if (!url) return
    const caption = (window.prompt('Video title / caption (optional — shown under the video):', '') ?? '').trim()
    const safeCaption = caption.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string))

    const isYoutube = /youtu\.?be/.test(url)

    // Build an inline-embeddable iframe src for Drive / Telegram.
    let embedSrc: string | null = null
    if (!isYoutube && /drive\.google\.com/.test(url)) {
      const m = url.match(/\/file\/d\/([\w-]+)/) ?? url.match(/[?&]id=([\w-]+)/) ?? url.match(/\/d\/([\w-]+)/)
      if (m?.[1]) embedSrc = `https://drive.google.com/file/d/${m[1]}/preview`
    } else if (!isYoutube && /t\.me\//.test(url)) {
      const m = url.match(/t\.me\/([^/?#]+\/\d+)/)
      if (m?.[1]) embedSrc = `https://t.me/${m[1]}?embed=1`
    }

    if (isYoutube) {
      editor.commands.setYoutubeVideo({ src: url })
    } else if (embedSrc) {
      editor.chain().focus().insertContent({ type: 'iframe', attrs: { src: embedSrc } }).run()
    } else {
      // Unrecognised link → clickable fallback (uses the caption as link text).
      const safeUrl = url.replace(/"/g, '%22')
      editor.chain().focus().insertContent(`<p>📹 <a href="${safeUrl}" target="_blank" rel="noopener">${safeCaption || 'Watch video'}</a></p>`).run()
      return
    }

    if (safeCaption) editor.chain().focus().insertContent(`<p class="blog-caption">${safeCaption}</p>`).run()
  }

  return (
    <div className="flex flex-wrap items-center gap-0.5 border-b border-border p-1.5 bg-surface sticky top-0 z-10">
      <ToolbarButton title="Bold" active={editor.isActive('bold')} onClick={() => editor.chain().focus().toggleBold().run()}><Bold size={16} /></ToolbarButton>
      <ToolbarButton title="Italic" active={editor.isActive('italic')} onClick={() => editor.chain().focus().toggleItalic().run()}><Italic size={16} /></ToolbarButton>
      <ToolbarButton title="Strikethrough" active={editor.isActive('strike')} onClick={() => editor.chain().focus().toggleStrike().run()}><Strikethrough size={16} /></ToolbarButton>
      <span className="w-px h-5 bg-border mx-1" />
      <ToolbarButton title="Heading 2" active={editor.isActive('heading', { level: 2 })} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}><Heading2 size={16} /></ToolbarButton>
      <ToolbarButton title="Heading 3" active={editor.isActive('heading', { level: 3 })} onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}><Heading3 size={16} /></ToolbarButton>
      <span className="w-px h-5 bg-border mx-1" />
      <ToolbarButton title="Bullet list" active={editor.isActive('bulletList')} onClick={() => editor.chain().focus().toggleBulletList().run()}><List size={16} /></ToolbarButton>
      <ToolbarButton title="Numbered list" active={editor.isActive('orderedList')} onClick={() => editor.chain().focus().toggleOrderedList().run()}><ListOrdered size={16} /></ToolbarButton>
      <ToolbarButton title="Quote" active={editor.isActive('blockquote')} onClick={() => editor.chain().focus().toggleBlockquote().run()}><Quote size={16} /></ToolbarButton>
      <ToolbarButton title="Code block" active={editor.isActive('codeBlock')} onClick={() => editor.chain().focus().toggleCodeBlock().run()}><Code size={16} /></ToolbarButton>
      <ToolbarButton title="Divider" onClick={() => editor.chain().focus().setHorizontalRule().run()}><Minus size={16} /></ToolbarButton>
      <span className="w-px h-5 bg-border mx-1" />
      <ToolbarButton title="Link" active={editor.isActive('link')} onClick={addLink}><Link2 size={16} /></ToolbarButton>
      <ToolbarButton title={uploading ? 'Uploading…' : 'Insert image'} disabled={uploading} onClick={() => fileRef.current?.click()}><ImagePlus size={16} /></ToolbarButton>
      <ToolbarButton title="Embed video" onClick={addVideo}><YoutubeIcon size={16} /></ToolbarButton>
      <span className="w-px h-5 bg-border mx-1" />
      <ToolbarButton title="Clear formatting (turn selection back into normal text)" onClick={() => editor.chain().focus().unsetAllMarks().clearNodes().run()}><RemoveFormatting size={16} /></ToolbarButton>
      <ToolbarButton title="Undo" disabled={!editor.can().undo()} onClick={() => editor.chain().focus().undo().run()}><Undo2 size={16} /></ToolbarButton>
      <ToolbarButton title="Redo" disabled={!editor.can().redo()} onClick={() => editor.chain().focus().redo().run()}><Redo2 size={16} /></ToolbarButton>
      <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={handleFile} />
      {imgError && <span className="text-xs text-rose-500 ml-2">{imgError}</span>}
    </div>
  )
}

export function BlogEditor({ value, onChange }: { value: string; onChange: (html: string) => void }) {
  const editor = useEditor({
    immediatelyRender: false, // avoid Next.js SSR hydration mismatch
    extensions: [
      StarterKit,
      FigureImage,
      Link.configure({ openOnClick: false, autolink: true, HTMLAttributes: { rel: 'noopener', target: '_blank' } }),
      Placeholder.configure({ placeholder: 'Write your article… use the toolbar for headings, images, and videos.' }),
      Youtube.configure({ width: 640, height: 360, HTMLAttributes: { class: 'blog-embed' } }),
      Iframe,
    ],
    content: value || '',
    onUpdate: ({ editor }) => onChange(editor.getHTML()),
    editorProps: {
      attributes: { class: 'blog-content focus:outline-none min-h-[360px] px-4 py-3' },
    },
  })

  if (!editor) {
    return <div className="border border-border rounded-lg h-[420px] flex items-center justify-center text-text-muted text-sm">Loading editor…</div>
  }

  return (
    <div className="border border-border rounded-lg overflow-hidden bg-canvas">
      <Toolbar editor={editor} />
      <EditorContent editor={editor} />
    </div>
  )
}
