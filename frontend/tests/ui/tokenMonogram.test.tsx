import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { TokenMonogram } from '@/components/portfolio/TokenMonogram'

describe('TokenMonogram', () => {
  it('shows initials only for a token the user typed in', () => {
    render(<TokenMonogram name="Sidra Chain" />)
    expect(screen.getByTestId('token-monogram')).toBeInTheDocument()
    expect(screen.queryByTestId('token-logo')).toBeNull()
  })
  it('shows the platform logo for a linked token, and falls back to initials if it fails to load', () => {
    render(<TokenMonogram name="Sidra Chain" logoUrl="https://cdn.example/sda.png" />)
    const img = screen.getByTestId('token-logo')
    expect(img).toHaveAttribute('src', 'https://cdn.example/sda.png')
    fireEvent.error(img)
    expect(screen.getByTestId('token-monogram')).toBeInTheDocument()
  })
})
