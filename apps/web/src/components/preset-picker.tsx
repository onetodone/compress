'use client'

import { COMPRESSION_PRESETS, type CompressionPreset } from '@onetodone/compress-shared'

const LABELS: Record<CompressionPreset, { label: string; hint: string }> = {
  balanced: { label: 'Balanced', hint: 'Looks the same as the original' },
  smaller: { label: 'Smaller', hint: 'Smaller files, slightly lower quality' },
}

interface PresetPickerProps {
  value: CompressionPreset
  disabled: boolean
  onChange: (preset: CompressionPreset) => void
}

export function PresetPicker({ value, disabled, onChange }: PresetPickerProps) {
  return (
    <fieldset disabled={disabled} className="flex flex-col items-start gap-1.5">
      <legend className="sr-only">Compression</legend>
      <div className="inline-flex rounded-full border border-zinc-300 p-0.5 dark:border-zinc-700">
        {COMPRESSION_PRESETS.map((preset) => (
          <label
            key={preset}
            title={LABELS[preset].hint}
            className={`cursor-pointer rounded-full px-3 py-1 text-sm transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-emerald-500 ${
              value === preset
                ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
                : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800'
            }`}
          >
            <input
              type="radio"
              name="preset"
              value={preset}
              checked={value === preset}
              onChange={() => onChange(preset)}
              className="sr-only"
            />
            {LABELS[preset].label}
          </label>
        ))}
      </div>
      <span className="text-xs text-zinc-500 dark:text-zinc-400">{LABELS[value].hint}</span>
    </fieldset>
  )
}
