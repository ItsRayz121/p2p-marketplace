import type { Config } from 'tailwindcss'

const config: Config = {
  darkMode: ['class'],
  content: [
    './src/pages/**/*.{ts,tsx}',
    './src/components/**/*.{ts,tsx}',
    './src/app/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        // ── Brand ────────────────────────────────────────────────────────────
        primary: {
          DEFAULT: '#2563eb',
          hover:   '#1d4ed8',
          light:   '#eff6ff',
          muted:   '#dbeafe',
        },

        // ── Semantic status ───────────────────────────────────────────────────
        success: {
          DEFAULT: '#10b981',
          hover:   '#059669',
          light:   '#ecfdf5',
          muted:   '#d1fae5',
        },
        warning: {
          DEFAULT: '#d97706',
          hover:   '#b45309',
          light:   '#fffbeb',
          muted:   '#fef3c7',
        },
        danger: {
          DEFAULT: '#ef4444',
          hover:   '#dc2626',
          light:   '#fef2f2',
          muted:   '#fee2e2',
        },
        info: {
          DEFAULT: '#3b82f6',
          hover:   '#2563eb',
          light:   '#eff6ff',
          muted:   '#dbeafe',
        },
        gold: {
          DEFAULT: '#f59e0b',
          light:   '#fef3c7',
        },

        // ── Surface / background hierarchy ───────────────────────────────────
        // canvas     → page background (body)
        // surface    → card / panel background
        // surface-alt→ inset / subtle background (input fields, code, tags)
        canvas:        '#f8fafc',
        surface:       '#ffffff',
        'surface-alt': '#f1f5f9',

        // ── Border hierarchy ─────────────────────────────────────────────────
        'border-subtle': '#e2e8f0',   // hairline dividers
        border:          '#cbd5e1',   // default border
        'border-strong': '#94a3b8',   // active / focus border

        // ── Text hierarchy ────────────────────────────────────────────────────
        'text-primary':   '#0f172a',
        'text-secondary': '#475569',
        'text-muted':     '#94a3b8',
        'text-disabled':  '#cbd5e1',
      },

      // ── Shadows ──────────────────────────────────────────────────────────────
      // card      → default resting card
      // card-md   → hovered / focused card
      // card-lg   → modals, dropdowns, popovers
      boxShadow: {
        card:    '0 1px 3px 0 rgb(0 0 0 / 0.10), 0 1px 2px -1px rgb(0 0 0 / 0.08)',
        'card-md':'0 4px 6px -1px rgb(0 0 0 / 0.12), 0 2px 4px -2px rgb(0 0 0 / 0.08)',
        'card-lg':'0 10px 15px -3px rgb(0 0 0 / 0.10), 0 4px 6px -4px rgb(0 0 0 / 0.06)',
        focus:   '0 0 0 3px rgb(37 99 235 / 0.15)',
      },

      fontFamily: {
        sans: [
          '-apple-system',
          'BlinkMacSystemFont',
          '"Segoe UI"',
          'Roboto',
          'sans-serif',
        ],
      },

      fontSize: {
        input: ['16px', { lineHeight: '1.5' }],
      },

      screens: {
        xs: '375px',
        sm: '640px',
        md: '768px',
        lg: '1024px',
        xl: '1280px',
      },

      minHeight: {
        screen: '100dvh',
      },

      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },

      animation: {
        'fade-in':        'fadeIn 150ms ease-out',
        'slide-up':       'slideUp 200ms ease-out',
        'pulse-subtle':   'pulseSubtle 2s ease-in-out infinite',
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up':   'accordion-up 0.2s ease-out',
      },

      keyframes: {
        fadeIn: {
          '0%':   { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideUp: {
          '0%':   { transform: 'translateY(8px)', opacity: '0' },
          '100%': { transform: 'translateY(0)',   opacity: '1' },
        },
        pulseSubtle: {
          '0%, 100%': { opacity: '1'   },
          '50%':      { opacity: '0.7' },
        },
        'accordion-down': {
          from: { height: '0' },
          to:   { height: 'var(--radix-accordion-content-height)' },
        },
        'accordion-up': {
          from: { height: 'var(--radix-accordion-content-height)' },
          to:   { height: '0' },
        },
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
}

export default config
