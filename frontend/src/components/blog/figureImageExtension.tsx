'use client'

import Image from '@tiptap/extension-image'
import { ReactNodeViewRenderer, NodeViewWrapper, type NodeViewProps } from '@tiptap/react'
import { useEffect, useState } from 'react'

/**
 * Image node with an optional, VISIBLE caption plus the usual hidden `alt`
 * (SEO/accessibility). It keeps the name `image`, so `setImage()` and any
 * legacy `<img class="blog-img">` content keep working — but it renders as a
 * `<figure><img><figcaption>` and provides an inline editor (click the image →
 * edit Caption / Alt → Save) instead of a clunky window.prompt.
 *
 * The public page renders the stored `<figure>` HTML directly; the backend
 * sanitiser already allows figure/figcaption.
 */
export const FigureImage = Image.extend({
  name: 'image',
  draggable: true,

  addAttributes() {
    const fromImg = (el: HTMLElement, attr: string) =>
      (el.tagName === 'FIGURE' ? el.querySelector('img')?.getAttribute(attr) : el.getAttribute(attr)) || null

    return {
      src: { default: null, parseHTML: (el) => fromImg(el as HTMLElement, 'src') },
      alt: { default: null, parseHTML: (el) => fromImg(el as HTMLElement, 'alt') },
      title: { default: null, parseHTML: (el) => fromImg(el as HTMLElement, 'title') },
      caption: {
        default: '',
        parseHTML: (el) =>
          (el as HTMLElement).tagName === 'FIGURE'
            ? (el as HTMLElement).querySelector('figcaption')?.textContent || ''
            : '',
      },
    }
  },

  parseHTML() {
    // New figure format first, then bare images (legacy posts / pasted content).
    return [{ tag: 'figure.blog-figure' }, { tag: 'img[src]' }]
  },

  renderHTML({ HTMLAttributes }) {
    const { caption, ...imgAttrs } = HTMLAttributes as Record<string, unknown>
    const img: [string, Record<string, unknown>] = ['img', { ...imgAttrs, class: 'blog-img' }]
    const cap = typeof caption === 'string' ? caption.trim() : ''
    return cap
      ? ['figure', { class: 'blog-figure' }, img, ['figcaption', { class: 'blog-caption' }, cap]]
      : ['figure', { class: 'blog-figure' }, img]
  },

  addNodeView() {
    return ReactNodeViewRenderer(FigureImageView)
  },
})

function FigureImageView({ node, updateAttributes, selected }: NodeViewProps) {
  const savedAlt = (node.attrs.alt as string | null) ?? ''
  const savedCaption = (node.attrs.caption as string | null) ?? ''
  const [alt, setAlt] = useState(savedAlt)
  const [caption, setCaption] = useState(savedCaption)

  // Resync local fields if the node's attrs change from outside (undo/redo).
  useEffect(() => { setAlt(savedAlt) }, [savedAlt])
  useEffect(() => { setCaption(savedCaption) }, [savedCaption])

  const dirty = alt !== savedAlt || caption !== savedCaption

  return (
    <NodeViewWrapper className="blog-figure-nv">
      <figure className="blog-figure" data-selected={selected ? 'true' : undefined}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={node.attrs.src as string} alt={alt} className="blog-img" />
        {caption.trim() && !selected && <figcaption className="blog-caption">{caption}</figcaption>}
      </figure>

      {selected && (
        <div className="blog-figure-editor" contentEditable={false}>
          <input
            className="blog-figure-input"
            value={caption}
            onChange={(e) => setCaption(e.target.value)}
            placeholder="Caption (optional — shown under the image)"
          />
          <input
            className="blog-figure-input"
            value={alt}
            onChange={(e) => setAlt(e.target.value)}
            placeholder="Alt text (optional — hidden, helps SEO &amp; screen readers)"
          />
          <button
            type="button"
            // preventDefault keeps the node selected so the click reaches us
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => updateAttributes({ alt: alt.trim(), caption: caption.trim() })}
            disabled={!dirty}
            className="blog-figure-save"
          >
            {dirty ? 'Save' : 'Saved'}
          </button>
        </div>
      )}
    </NodeViewWrapper>
  )
}
