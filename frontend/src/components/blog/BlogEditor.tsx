'use client'

import { useEditor, EditorContent, type Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Link from '@tiptap/extension-link'
import Placeholder from '@tiptap/extension-placeholder'
import Youtube from '@tiptap/extension-youtube'
import { TextSelection } from '@tiptap/pm/state'
import type { Fragment, Node as ProseMirrorNode } from '@tiptap/pm/model'
import { marked } from 'marked'
import { Iframe } from './iframeExtension'
import { FigureImage } from './figureImageExtension'
import { useRef, useState } from 'react'
import {
  Bold, Italic, Strikethrough, Heading2, Heading3, List, ListOrdered,
  Quote, Code, Link2, ImagePlus, Youtube as YoutubeIcon, Undo2, Redo2, Minus, RemoveFormatting, Wand2,
} from 'lucide-react'
import { useFileUpload } from '@/hooks/useFileUpload'
import { UploadProgress } from '@/components/ui/UploadProgress'
import { cn } from '@/lib/utils'

// Heuristic: does this pasted plain text look like Markdown worth converting?
// Deliberately conservative — only fires on clear Markdown syntax so ordinary
// prose (with the odd asterisk) is pasted verbatim.
function looksLikeMarkdown(t: string): boolean {
  return /(^|\n)\s{0,3}#{1,6}\s/.test(t)          // # headings
    || /\*\*[^*\n]+\*\*/.test(t)                   // **bold**
    || /__[^_\n]+__/.test(t)                       // __bold__
    || /(^|\n)\s{0,3}>\s/.test(t)                  // > blockquote
    || /(^|\n)\s{0,3}[-*+]\s+\S/.test(t)           // - bullet list
    || /(^|\n)\s{0,3}\d+\.\s+\S/.test(t)           // 1. ordered list
    || /\[[^\]]+\]\([^)\s]+\)/.test(t)             // [text](url)
    || /`[^`\n]+`/.test(t)                          // `inline code`
    || /(^|\n)```/.test(t)                          // ``` code fence
    || /(^|\n)(-{3,}|\*{3,}|_{3,})\s*(\n|$)/.test(t) // --- horizontal rule
}

// Drop hard line-breaks sitting at the very start/end of an inline fragment so
// isolating a line doesn't leave empty leading/trailing lines behind.
function stripEdgeBreaks(frag: Fragment): Fragment {
  let f = frag
  while (f.firstChild && f.firstChild.type.name === 'hardBreak') f = f.cut(f.firstChild.nodeSize, f.size)
  while (f.lastChild && f.lastChild.type.name === 'hardBreak') f = f.cut(0, f.size - f.lastChild.nodeSize)
  return f
}

// Apply an H2/H3 heading to ONLY the selected line(s).
//
// TipTap headings are block-level, so a plain `toggleHeading` converts the whole
// paragraph — including sibling lines joined to it by soft line-breaks (which is
// how pasted Markdown drafts arrive). To honour "only what I selected", we split
// the paragraph at the line-breaks bracketing the selection, turn the isolated
// middle into a heading, and keep the lines before/after as their own paragraphs.
function applyHeading(editor: Editor, level: 2 | 3) {
  // Already this heading on the block → toggle back to normal text.
  if (editor.isActive('heading', { level })) {
    editor.chain().focus().setParagraph().run()
    return
  }

  const { state, view } = editor
  const { from, to } = state.selection
  const $from = state.doc.resolve(from)
  const $to = state.doc.resolve(to)
  const parent = $from.parent

  // Only do the line-isolation surgery for a plain top-level paragraph. Anything
  // else (lists, quotes, multi-block selections, existing headings) falls back to
  // TipTap's native behaviour, which is correct for those cases.
  const canIsolate = $from.sameParent($to) && $from.depth === 1 && parent.type.name === 'paragraph'
  if (!canIsolate) {
    editor.chain().focus().toggleHeading({ level }).run()
    return
  }

  const blockStart = $from.start()
  const blockEnd = $from.end()

  // Find the hard-break boundaries that bracket the selection.
  let lineStart = blockStart
  let lineEnd = blockEnd
  let pos = blockStart
  parent.forEach((child) => {
    const start = pos
    const end = pos + child.nodeSize
    if (child.type.name === 'hardBreak') {
      if (end <= from) lineStart = end                          // nearest break before selection
      if (start >= to && lineEnd === blockEnd) lineEnd = start  // nearest break after selection
    }
    pos = end
  })

  const c = parent.content
  const before = stripEdgeBreaks(c.cut(0, lineStart - blockStart))
  const line = stripEdgeBreaks(c.cut(lineStart - blockStart, lineEnd - blockStart))
  const after = stripEdgeBreaks(c.cut(lineEnd - blockStart, blockEnd - blockStart))

  const { schema } = state
  const nodes: ProseMirrorNode[] = []
  if (before.size > 0) nodes.push(schema.nodes.paragraph.create(null, before))
  nodes.push(schema.nodes.heading.create({ level }, line))
  if (after.size > 0) nodes.push(schema.nodes.paragraph.create(null, after))

  const tr = state.tr.replaceWith(blockStart - 1, blockEnd + 1, nodes)
  // Re-select the new heading's text.
  const headingContentStart = blockStart - 1 + (before.size > 0 ? before.size + 2 : 0) + 1
  tr.setSelection(TextSelection.create(tr.doc, headingContentStart, headingContentStart + line.size))
  view.dispatch(tr)
  view.focus()
}

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
  const { upload, uploading, progress } = useFileUpload('blog-image')
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

  // Turn literal Markdown (## heading, **bold**, - lists, [text](url) …) that was
  // typed or pasted as plain text into real formatting. Converts the current
  // selection when there is one; otherwise reflows the whole article.
  function formatMarkdown() {
    const { state } = editor
    const { from, to, empty } = state.selection

    if (!empty) {
      const text = state.doc.textBetween(from, to, '\n\n', '\n')
      if (!looksLikeMarkdown(text)) { window.alert('The selected text has no Markdown to convert.'); return }
      const rendered = marked.parse(text, { async: false, gfm: true }) as string
      editor.chain().focus().deleteSelection().insertContent(rendered).run()
      return
    }

    const text = editor.getText({ blockSeparator: '\n\n' })
    if (!looksLikeMarkdown(text)) { window.alert('No Markdown found in this article to convert.'); return }
    if (!window.confirm('Convert Markdown in this article to formatting?\n\nThis reflows the whole article and will drop any inserted images or videos. Press Undo (Ctrl+Z) if you don’t like the result.')) return
    const rendered = marked.parse(text, { async: false, gfm: true }) as string
    editor.chain().focus().setContent(rendered, true).run()
  }

  return (
    <div className="flex flex-wrap items-center gap-0.5 border-b border-border p-1.5 bg-surface sticky top-14 z-20 rounded-t-lg">
      <ToolbarButton title="Bold" active={editor.isActive('bold')} onClick={() => editor.chain().focus().toggleBold().run()}><Bold size={16} /></ToolbarButton>
      <ToolbarButton title="Italic" active={editor.isActive('italic')} onClick={() => editor.chain().focus().toggleItalic().run()}><Italic size={16} /></ToolbarButton>
      <ToolbarButton title="Strikethrough" active={editor.isActive('strike')} onClick={() => editor.chain().focus().toggleStrike().run()}><Strikethrough size={16} /></ToolbarButton>
      <span className="w-px h-5 bg-border mx-1" />
      <ToolbarButton title="Heading 2 (applies to the selected line only)" active={editor.isActive('heading', { level: 2 })} onClick={() => applyHeading(editor, 2)}><Heading2 size={16} /></ToolbarButton>
      <ToolbarButton title="Heading 3 (applies to the selected line only)" active={editor.isActive('heading', { level: 3 })} onClick={() => applyHeading(editor, 3)}><Heading3 size={16} /></ToolbarButton>
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
      <ToolbarButton title="Format Markdown (convert selected — or all — ## **bold** lists etc. into real formatting)" onClick={formatMarkdown}><Wand2 size={16} /></ToolbarButton>
      <ToolbarButton title="Clear formatting (turn selection back into normal text)" onClick={() => editor.chain().focus().unsetAllMarks().clearNodes().run()}><RemoveFormatting size={16} /></ToolbarButton>
      <ToolbarButton title="Undo" disabled={!editor.can().undo()} onClick={() => editor.chain().focus().undo().run()}><Undo2 size={16} /></ToolbarButton>
      <ToolbarButton title="Redo" disabled={!editor.can().redo()} onClick={() => editor.chain().focus().redo().run()}><Redo2 size={16} /></ToolbarButton>
      <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={handleFile} />
      {imgError && <span className="text-xs text-rose-500 ml-2">{imgError}</span>}
      {uploading && progress && <div className="basis-full px-1 pt-1"><UploadProgress progress={progress} /></div>}
    </div>
  )
}

export function BlogEditor({ value, onChange }: { value: string; onChange: (html: string) => void }) {
  // Ref so the paste handler (captured once at init) can reach the live editor.
  const editorRef = useRef<Editor | null>(null)

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
      // Paste Markdown as real formatting. When the clipboard carries only plain
      // text that looks like Markdown (e.g. copied from an .md file), convert it
      // to HTML so **bold**, headings, lists, quotes etc. render properly. If the
      // source provided real HTML, we defer to Tiptap's native rich-paste.
      handlePaste(view, event) {
        const cd = event.clipboardData
        if (!cd) return false
        const html = cd.getData('text/html')
        if (html && html.trim()) return false
        const text = cd.getData('text/plain')
        if (!text || !looksLikeMarkdown(text)) return false
        const rendered = marked.parse(text, { async: false, gfm: true }) as string
        editorRef.current?.chain().focus().insertContent(rendered).run()
        return true // handled — prevent the default plain-text paste
      },
    },
  })
  editorRef.current = editor

  if (!editor) {
    return <div className="border border-border rounded-lg h-[420px] flex items-center justify-center text-text-muted text-sm">Loading editor…</div>
  }

  return (
    <div className="border border-border rounded-lg bg-canvas">
      <Toolbar editor={editor} />
      <EditorContent editor={editor} />
    </div>
  )
}
