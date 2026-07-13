// @vitest-environment jsdom

import React, { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'

import ProfilePage from '@/app/[locale]/profile/page'

;(globalThis as typeof globalThis & { React: typeof React }).React = React

const navigation = vi.hoisted(() => ({
  searchParams: null as URLSearchParams | null,
  replace: vi.fn(),
  push: vi.fn(),
}))

vi.mock('next/navigation', () => ({ useSearchParams: () => navigation.searchParams }))
vi.mock('@/i18n/navigation', () => ({ useRouter: () => ({ replace: navigation.replace, push: navigation.push }) }))
vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: { user: { id: 'user-1', name: 'User' } }, status: 'authenticated' }),
  signOut: vi.fn(),
}))
vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }))
vi.mock('@/components/Navbar', () => ({ default: () => createElement('div', null, 'Navbar') }))
vi.mock('@/components/ui/icons', () => ({ AppIcon: () => createElement('span') }))
vi.mock('@/app/[locale]/profile/components/ApiConfigTab', () => ({ default: () => createElement('div', null, 'API CONTENT') }))
vi.mock('@/app/[locale]/profile/components/comfyui/ComfyUiSettings', () => ({ default: () => createElement('div', null, 'COMFY CONTENT') }))

afterEach(() => {
  cleanup()
  navigation.searchParams = null
  navigation.replace.mockReset()
  navigation.push.mockReset()
})

describe('profile section URL navigation', () => {
  it('treats nullable search params as empty instead of throwing', () => {
    const view = render(createElement(ProfilePage))
    expect(view.getByText('API CONTENT')).toBeTruthy()
  })

  it('writes tab clicks to the URL and follows back/forward query changes', () => {
    navigation.searchParams = new URLSearchParams('section=apiConfig')
    const view = render(createElement(ProfilePage))
    fireEvent.click(view.getByRole('button', { name: /comfyui/i }))
    expect(navigation.replace).toHaveBeenCalledWith({ pathname: '/profile', query: { section: 'comfyui' } })

    navigation.searchParams = new URLSearchParams('section=comfyui')
    view.rerender(createElement(ProfilePage))
    expect(view.getByText('COMFY CONTENT')).toBeTruthy()

    navigation.searchParams = new URLSearchParams('section=apiConfig')
    view.rerender(createElement(ProfilePage))
    expect(view.getByText('API CONTENT')).toBeTruthy()

    navigation.searchParams = new URLSearchParams('section=invalid')
    view.rerender(createElement(ProfilePage))
    expect(view.getByText('API CONTENT')).toBeTruthy()
  })
})
