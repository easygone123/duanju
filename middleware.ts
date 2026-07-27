import createMiddleware from 'next-intl/middleware';
import { routing } from './src/i18n/routing';

export default createMiddleware(routing);

export const config = {
    // Public vendor assets must bypass locale redirects. The LTX/Bernini
    // director hosts load their original browser bundles from /vendor/*.
    matcher: [
        '/((?!api|m|vendor|_next/static|_next/image|favicon.ico|.*\\.png|.*\\.jpg|.*\\.jpeg|.*\\.svg|.*\\.gif|.*\\.ico).*)'
    ]
};
