import './globals.css'

import { fileFormats } from '@onetodone/compress-shared'
import type { Metadata } from 'next'
import type { ReactNode } from 'react'

export const metadata: Metadata = {
  title: 'Compress OneToDone',
  description: `Make ${fileFormats.names('and')} files smaller without changing how they look.`,
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
