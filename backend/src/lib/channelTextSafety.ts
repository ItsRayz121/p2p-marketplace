import { AppError } from './errors'

/**
 * Zero-cost (no external API, pure regex) link-spam guard for channel posts.
 * Channels are broadcast to potentially thousands of subscribers, so a single
 * malicious post has much more reach than a 1:1 DM — this catches the cheap,
 * common abuse patterns without adding any third-party safe-browsing cost.
 */
const MAX_LINKS_PER_MESSAGE = 3
const URL_RE = /\bhttps?:\/\/[^\s<>"')]+/gi
const IP_HOST_RE = /^https?:\/\/(\d{1,3}\.){3}\d{1,3}(:\d+)?(\/|$)/i
// Punycode ("xn--") domains are the standard mechanism behind homograph/lookalike
// domain phishing (e.g. a Cyrillic 'а' standing in for a Latin 'a').
const PUNYCODE_HOST_RE = /^https?:\/\/(?:[^/]*\.)?xn--/i

export function assertSafeChannelText(body: string): void {
  const urls = body.match(URL_RE) ?? []
  if (urls.length > MAX_LINKS_PER_MESSAGE) {
    throw new AppError('VALIDATION_ERROR', `Too many links in one message (max ${MAX_LINKS_PER_MESSAGE}).`, 400)
  }
  for (const url of urls) {
    if (IP_HOST_RE.test(url)) {
      throw new AppError('VALIDATION_ERROR', 'Raw IP-address links are not allowed.', 400)
    }
    if (PUNYCODE_HOST_RE.test(url)) {
      throw new AppError('VALIDATION_ERROR', 'That link looks unsafe and was blocked.', 400)
    }
  }
}
