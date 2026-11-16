export const initialState = () => ({ name: '授权数字书目', revision: 1, unavailable: false, expired: false, catalogEmpty: false, paged: false, extraFormat: false });

const bookA = state => ({ metadata: { identifier: 'book-a', title: '海岛馆藏导读' }, links: [
  { rel: 'preview', href: '/preview/book-a', type: 'text/plain' },
  { rel: 'acquisition/open-access', href: '/content/book-a/open-1', type: 'text/plain', purpose: 'archive-open' },
  ...(state.extraFormat ? [{ rel: 'acquisition/open-access', href: '/content/book-a/open-1.html', type: 'text/html', purpose: 'archive-open' }] : []),
] });
const bookB = () => ({ metadata: { identifier: 'book-b', title: '文物修复基础' }, links: [
  { rel: 'acquisition/borrow', href: '/loans/book-b', type: 'text/plain', purpose: 'temporary-reading' },
] });

export async function handle({ incoming, url, state, json, bytes }) {
  if (url.pathname === '/policy') { json(200, { purposes: ['archive-open', 'temporary-reading'] }); return true; }
  if (url.pathname === '/catalog') {
    const page = url.searchParams.get('page') ?? '1';
    const publications = state.paged ? (page === '1' ? [bookA(state)] : [bookB(state)]) : [bookA(state), bookB(state)];
    const links = [];
    if (!state.catalogEmpty) {
      links.push({ rel: 'self', href: state.paged ? `/catalog?page=${page}` : '/catalog' });
      if (state.paged && page === '1') links.push({ rel: 'next', href: '/catalog?page=2' });
    }
    json(200, { metadata: { title: '联合数字书展' }, publications, links });
    return true;
  }
  if (url.pathname === '/loans/book-b') {
    if (state.unavailable) { json(409, { state: 'waiting', reason: '借阅席位使用中' }); return true; }
    json(200, { loanId: `loan-${state.revision}`, expires: '2026-12-01T00:00:00Z', state: state.expired ? 'expired' : 'active', href: `/content/book-b/loan-${state.revision}`, token: `borrow-${state.revision}` }); return true;
  }
  if (url.pathname.startsWith('/preview/')) { bytes(200, '仅供试看的一页', 'text/plain; charset=utf-8', { 'x-content-scope': 'preview' }); return true; }
  if (url.pathname.startsWith('/content/book-a/')) {
    if (url.pathname.endsWith('.html')) { bytes(200, '<article>海岛馆藏导读完整正文</article>', 'text/html; charset=utf-8', { 'x-license-id': 'open-1' }); return true; }
    bytes(200, '海岛馆藏导读完整正文', 'text/plain; charset=utf-8', { 'x-license-id': 'open-1' }); return true;
  }
  if (url.pathname.startsWith('/content/book-b/')) {
    if (state.expired || incoming.headers.authorization !== `Bearer borrow-${state.revision}`) { json(403, { state: 'expired-or-unlicensed' }); return true; }
    bytes(200, '文物修复基础借阅正文', 'text/plain; charset=utf-8', { 'x-license-id': `loan-${state.revision}` }); return true;
  }
  return false;
}
