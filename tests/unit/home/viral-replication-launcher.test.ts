// @vitest-environment jsdom

import React, { createElement } from 'react'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import ViralReplicationLauncher from '@/components/home/ViralReplicationLauncher'

;(globalThis as typeof globalThis & { React: typeof React }).React = React

const navigation = vi.hoisted(() => ({ push: vi.fn() }))
const client = vi.hoisted(() => ({
  createViralReplicationSession: vi.fn(),
  uploadViralReplicationVideo: vi.fn(),
  getViralReplicationAvailability: vi.fn(),
}))

vi.mock('@/i18n/navigation', () => ({ useRouter: () => navigation }))
vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }))
vi.mock('@/lib/viral-replication/client', () => client)
vi.mock('@/components/ui/icons', () => ({ AppIcon: () => createElement('span') }))

afterEach(() => cleanup())

describe('viral replication homepage launcher', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    client.createViralReplicationSession.mockResolvedValue({ id: 'rep-1', status: 'uploading' })
    client.getViralReplicationAvailability.mockResolvedValue({ available: true })
    client.uploadViralReplicationVideo.mockResolvedValue({
      id: 'rep-1', status: 'analyzing', projectId: 'project-1',
    })
  })

  it('disables the launcher when the FFmpeg runtime is unavailable', async () => {
    client.getViralReplicationAvailability.mockResolvedValue({ available: false })
    const view = render(createElement(ViralReplicationLauncher))
    const trigger = view.getByRole('button', { name: 'trigger' }) as HTMLButtonElement
    await waitFor(() => expect(trigger.disabled).toBe(true))
    expect(view.getByText('unavailable')).toBeTruthy()
    fireEvent.click(trigger)
    expect(view.queryByRole('dialog')).toBeNull()
  })

  async function openLauncher() {
    const view = render(createElement(ViralReplicationLauncher))
    const trigger = view.getByRole('button', { name: 'trigger' }) as HTMLButtonElement
    await waitFor(() => expect(trigger.disabled).toBe(false))
    fireEvent.click(trigger)
    return view
  }

  it('is visible and blocks missing brief, invalid format, and files over 500 MB', async () => {
    const view = await openLauncher()
    const submit = view.getByRole('button', { name: 'start' }) as HTMLButtonElement
    expect(submit.disabled).toBe(true)

    const input = view.getByLabelText('videoLabel') as HTMLInputElement
    fireEvent.change(input, { target: { files: [new File(['x'], 'source.avi', { type: 'video/x-msvideo' })] } })
    expect(view.getByText('formatError')).toBeTruthy()
    expect(client.createViralReplicationSession).not.toHaveBeenCalled()

    const tooLarge = new File(['x'], 'source.mp4', { type: 'video/mp4' })
    Object.defineProperty(tooLarge, 'size', { configurable: true, value: 501 * 1024 * 1024 })
    fireEvent.change(input, { target: { files: [tooLarge] } })
    expect(view.getByText('sizeError')).toBeTruthy()
    expect(client.createViralReplicationSession).not.toHaveBeenCalled()
  })

  it('uses defaults, renders upload progress, and navigates to the replication page', async () => {
    let resolveUpload!: (value: { id: string; status: string; projectId: string }) => void
    client.uploadViralReplicationVideo.mockImplementation(async (
      _id: string,
      _file: File,
      options: { onProgress?: (progress: number) => void },
    ) => {
      options.onProgress?.(42)
      return await new Promise((resolve) => { resolveUpload = resolve })
    })
    const view = await openLauncher()
    fireEvent.change(view.getByLabelText('briefLabel'), { target: { value: '原创都市反转故事' } })
    const file = new File(['video'], 'source.mov', { type: 'video/quicktime' })
    fireEvent.change(view.getByLabelText('videoLabel'), { target: { files: [file] } })
    fireEvent.click(view.getByRole('button', { name: 'start' }))

    await waitFor(() => expect(client.uploadViralReplicationVideo).toHaveBeenCalled())
    expect(client.createViralReplicationSession).toHaveBeenCalledWith({
      brief: '原创都市反转故事', videoRatio: '9:16', artStyle: 'realistic',
    })
    expect(view.getByTestId('viral-upload-progress').textContent).toContain('42%')

    await act(async () => resolveUpload({ id: 'rep-1', status: 'analyzing', projectId: 'project-1' }))
    await waitFor(() => expect(navigation.push).toHaveBeenCalledWith({
      pathname: '/workspace/project-1/viral-replication/rep-1',
    }))
  })
})
