import { Node, mergeAttributes } from '@tiptap/core'

/**
 * Minimal block-level iframe node for inline video embeds that TipTap's YouTube
 * extension doesn't cover (Google Drive `/preview`, Telegram `?embed=1`). We
 * insert these via editor.insertContent({ type: 'iframe', attrs: { src } }).
 *
 * Security: only allowlisted hosts are ever inserted by the editor (see
 * BlogEditor.addVideo), and the backend sanitiser independently strips any
 * iframe whose src isn't on the youtube/drive.google/t.me/vimeo allowlist — so
 * a pasted/edited stray iframe can never reach the public page.
 */
export const Iframe = Node.create({
  name: 'iframe',
  group: 'block',
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      src: { default: null },
    }
  },

  parseHTML() {
    return [{ tag: 'iframe[src]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'iframe',
      mergeAttributes(HTMLAttributes, {
        class: 'blog-embed',
        frameborder: '0',
        allowfullscreen: 'true',
        allow: 'autoplay; encrypted-media; picture-in-picture; fullscreen',
        loading: 'lazy',
      }),
    ]
  },
})
