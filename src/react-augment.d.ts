import 'react'

declare module 'react' {
  // Folder picking on `<input type="file">`; supported by Chromium, Firefox and Safari but missing from React's typings.
  interface InputHTMLAttributes<T> {
    webkitdirectory?: string
    directory?: string
  }
}
