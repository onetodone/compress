import './globals.css'

import { imageFormats } from '@onetodone/image-compressor-shared'
import type { Metadata } from 'next'
import type { ReactNode } from 'react'

export const metadata: Metadata = {
  title: 'Image Compressor',
  description: `Make ${imageFormats.names('and')} images smaller without changing how they look.`,
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
