'use client'
import { useEffect, useState } from 'react'
import { useSession, signOut } from 'next-auth/react'
import { useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import Navbar from '@/components/Navbar'
import ApiConfigTab from './components/ApiConfigTab'
import ComfyUiSettings from './components/comfyui/ComfyUiSettings'
import { AppIcon } from '@/components/ui/icons'
import { useRouter } from '@/i18n/navigation'
import { resolveProfileSection, type ProfileSection } from './profile-section'

export default function ProfilePage() {
  const { data: session, status } = useSession()
  const router = useRouter()
  const searchParams = useSearchParams()
  const t = useTranslations('profile')
  const tc = useTranslations('common')

  // 主要分区：扣费记录 / API配置
  const requestedSection = searchParams?.get('section') ?? null
  const [activeSection, setActiveSection] = useState<ProfileSection>(() => resolveProfileSection(requestedSection))

  useEffect(() => {
    setActiveSection(resolveProfileSection(requestedSection))
  }, [requestedSection])

  useEffect(() => {
    if (status === 'loading') return
    if (!session) { router.push({ pathname: '/auth/signin' }); return }
  }, [router, session, status])

  if (status === 'loading' || !session) {
    return (
      <div className="glass-page flex min-h-screen items-center justify-center">
        <div className="text-[var(--glass-text-secondary)]">{tc('loading')}</div>
      </div>
    )
  }

  const noBillingText = t('openSourceNoBilling')
  const navigateSection = (section: ProfileSection) => {
    router.replace({ pathname: '/profile', query: { section } })
  }

  return (
    <div className="glass-page min-h-screen">
      <Navbar />

      <main className="mx-auto max-w-[1400px] px-4 py-5 sm:px-6 sm:py-8">
        <div className="flex flex-col md:flex-row min-h-[calc(100vh-120px)] gap-4 md:h-[calc(100vh-140px)] md:gap-6">

          {/* 左侧侧边栏 */}
          <div className="w-full md:w-64 flex-shrink-0">
            <div className="glass-surface-elevated flex h-auto flex-col p-4 md:h-full md:p-5">

              {/* 用户信息 */}
              <div className="mb-6">
                <div className="mb-4">
                  <h2 className="font-semibold text-[var(--glass-text-primary)]">{session.user?.name || t('user')}</h2>
                  <p className="text-xs text-[var(--glass-text-tertiary)]">{t('personalAccount')}</p>
                </div>

                {/* 余额卡片 */}
                <div className="glass-surface-soft rounded-2xl border border-[var(--glass-stroke-base)] p-4">
                  <div className="text-xs font-medium text-[var(--glass-text-secondary)]">{t('availableBalance')}</div>
                  <div className="mt-2 text-base font-semibold text-[var(--glass-text-primary)]">{noBillingText}</div>
                </div>
              </div>

              {/* 导航菜单 */}
              <nav className="flex flex-1 gap-2 overflow-x-auto md:overflow-visible md:block md:space-y-2">
                <button
                  onClick={() => navigateSection('apiConfig')}
                  className={`w-auto min-w-max md:w-full flex items-center gap-3 px-4 py-3 rounded-xl text-left transition-all cursor-pointer ${activeSection === 'apiConfig'
                    ? 'glass-btn-base glass-btn-tone-info'
                    : 'text-[var(--glass-text-secondary)] hover:bg-[var(--glass-bg-muted)]'
                    }`}
                >
                  <AppIcon name="settingsHexAlt" className="w-5 h-5" />
                  <span className="font-medium">{t('apiConfig')}</span>
                </button>

                <button
                  onClick={() => navigateSection('comfyui')}
                  className={`w-auto min-w-max md:w-full flex items-center gap-3 px-4 py-3 rounded-xl text-left transition-all cursor-pointer ${activeSection === 'comfyui'
                    ? 'glass-btn-base glass-btn-tone-info'
                    : 'text-[var(--glass-text-secondary)] hover:bg-[var(--glass-bg-muted)]'
                    }`}
                >
                  <AppIcon name="settingsHexAlt" className="w-5 h-5" />
                  <span className="font-medium">{t('comfyui')}</span>
                </button>

                <button
                  onClick={() => navigateSection('billing')}
                  className={`w-auto min-w-max md:w-full flex items-center gap-3 px-4 py-3 rounded-xl text-left transition-all cursor-pointer ${activeSection === 'billing'
                    ? 'glass-btn-base glass-btn-tone-info'
                    : 'text-[var(--glass-text-secondary)] hover:bg-[var(--glass-bg-muted)]'
                    }`}
                >
                  <AppIcon name="receipt" className="w-5 h-5" />
                  <span className="font-medium">{t('billingRecords')}</span>
                </button>
              </nav>
              {/* 退出登录 */}
              <button
                onClick={() => signOut({ callbackUrl: '/' })}
                className="glass-btn-base glass-btn-tone-danger mt-auto flex items-center gap-2 px-4 py-3 text-sm rounded-xl transition-all cursor-pointer"
              >
                <AppIcon name="logout" className="w-4 h-4" />
                {t('logout')}
              </button>
            </div>
          </div>

          {/* 右侧内容区 */}
          <div className="flex-1 min-w-0">
            <div className="glass-surface-elevated h-full flex flex-col">

              {activeSection === 'apiConfig' ? (
                <ApiConfigTab />
              ) : activeSection === 'comfyui' ? (
                <ComfyUiSettings />
              ) : (
                <div className="flex h-full flex-col items-center justify-center px-6 text-center">
                  <AppIcon name="receipt" className="mb-4 h-12 w-12 text-[var(--glass-text-tertiary)]" />
                  <p className="text-base font-semibold text-[var(--glass-text-primary)]">{noBillingText}</p>
                </div>
              )}
            </div>
          </div>
        </div>
      </main >
    </div >
  )
}
