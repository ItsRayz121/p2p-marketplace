'use client'

import { useEditor, EditorContent, type Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Image from '@tiptap/extension-image'
import Link from '@tiptap/extension-link'
import Placeholder from '@tiptap/extension-placeholder'
import Youtube from '@tiptap/extension-youtube'
import { useRef, useState } from 'react'
import {
  Bold, Italic, Strikethrough, Heading2, Heading3, List, ListOrdered,
  Quote, Code, Link2, ImagePlus, Youtube as YoutubeIcon, Undo2, Redo2, Minus,
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
      const alt = window.prompt('Image description (alt text — important for SEO & accessibility):', '') ?? ''
      editor.chain().focus().setImage({ src: url, alt }).run()
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
    const url = window.prompt('Paste a YouTube video URL (best for SEO). Drive/Telegram links will be added as a link:', 'https://')
    if (!url) return
    if (/youtu\.?be/.test(url)) {
      editor.commands.setYoutubeVideo({ src: url })
    } else {
      // Non-YouTube: insert a prominent clickable link (inline players for
      // Drive/Telegram can be added later; the link keeps the video reachable).
      editor.chain().focus().insertContent(`<p>📹 <a href="${url}" target="_blank" rel="noopener">Watch video</a></p>`).run()
    }
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
      Image.configure({ HTMLAttributes: { class: 'blog-img' } }),
      Link.configure({ openOnClick: false, autolink: true, HTMLAttributes: { rel: 'noopener', target: '_blank' } }),
      Placeholder.configure({ placeholder: 'Write your article… use the toolbar for headings, images, and videos.' }),
      Youtube.configure({ width: 640, height: 360, HTMLAttributes: { class: 'blog-embed' } }),
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
