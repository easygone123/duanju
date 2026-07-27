import createMiddleware from 'next-intl/middleware';
import { locales, defaultLocale } from '@/i18n';

export default createMiddleware({
    // 支持的所有语言
    locales,

    // 默认语言
    defaultLocale,

    // URL 路径策略: 始终显示语言前缀
    localePrefix: 'always',

    // 关闭自动语言检测，避免无前缀跳转触发语言漂移
    localeDetection: false
});

export const config = {
    // Public vendor assets must bypass locale redirects. The LTX/Bernini
    // director hosts load their original browser bundles from /vendor/*.
    matcher: [
        // 匹配根路径和所有带语言前缀的路径
        '/',
        '/(zh|en)/:path*',
        // 匹配所有其他路径（用于重定向到带语言前缀的路径）
        '/((?!api|m|vendor|_next/static|_next/image|favicon.ico|.*\\.png|.*\\.jpg|.*\\.jpeg|.*\\.svg|.*\\.gif|.*\\.ico).*)'
    ]
};
