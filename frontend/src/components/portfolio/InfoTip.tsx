/** A small "i" with a plain-language explanation, reachable by keyboard and read out by screen readers. */
export function InfoTip({ text }: { text: string }) {
  return (
    <span
      role="img" aria-label={text} title={text} tabIndex={0}
      className="ml-1 inline-flex h-4 w-4 items-center justify-center rounded-full border border-border text-[10px] leading-none text-text-muted cursor-help align-middle"
    >
      i
    </span>
  )
}
