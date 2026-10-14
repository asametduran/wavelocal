/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: { base: '#0a0a0f', panel: '#12121a', raised: '#1b1b27', accent: '#a78bfa' },
      keyframes: { fadeIn: { from: { opacity: 0, transform: 'translateY(6px)' }, to: { opacity: 1, transform: 'none' } } },
      animation: { fadeIn: 'fadeIn .35s ease-out' },
    },
  },
  plugins: [],
}
