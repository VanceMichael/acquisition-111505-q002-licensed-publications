import { request, decodeJson } from './transport.mjs';

export const RELATION = { openAccess: 'acquisition/open-access', borrow: 'acquisition/borrow', preview: 'preview' };
const RETENTION = { 'archive-open': 'permanent', 'temporary-reading': 'temporary' };
const CATALOG_ENTRY = 'catalog-entry';
const LOAN_WAITING = 'loan-waiting';
const MAX_PAGES = 20;
const MAX_CONTENT_BYTES = 8 * 1024 * 1024;

const resolve = (base, href) => new URL(href, base).href;
const parseJson = bytes => { try { return JSON.parse(bytes.toString('utf8')); } catch { return null; } };

async function fetchPolicy(base) {
  const policy = decodeJson(await request(resolve(base, '/policy')));
  return new Set(Array.isArray(policy.purposes) ? policy.purposes : []);
}

async function fetchCatalog(base) {
  const publications = [];
  const visited = new Set();
  let url = resolve(base, '/catalog');
  while (url && !visited.has(url) && visited.size < MAX_PAGES) {
    visited.add(url);
    const catalog = decodeJson(await request(url));
    for (const publication of catalog.publications ?? []) publications.push(publication);
    const next = (catalog.links ?? []).find(link => link.rel === 'next');
    url = next ? new URL(next.href, url).href : null;
  }
  return publications;
}

function planPublication(publication, purposes) {
  const links = Array.isArray(publication.links) ? publication.links : [];
  const item = {
    publication: publication.metadata?.identifier ?? null,
    title: publication.metadata?.title ?? null,
    status: 'pending', relation: null, format: null, purpose: null, retention: null,
    license: null, loan: null, catalogEntry: null,
    receipt: null, version: null, duplicate: null, sha256: null, contentBytes: null,
    rationale: [], alternatives: [], error: null,
  };
  const acquisition = [];
  for (const link of links) {
    if (link.rel === RELATION.openAccess || link.rel === RELATION.borrow) acquisition.push(link);
    else if (link.rel === RELATION.preview) item.alternatives.push({ relation: link.rel, format: link.type ?? null, decision: 'rejected', reason: '样章不构成正文，不能登记为馆藏' });
    else item.alternatives.push({ relation: link.rel ?? null, format: link.type ?? null, decision: 'rejected', reason: '未识别的获取关系，不自动处理' });
  }
  const eligible = acquisition.filter(link => link.purpose && purposes.has(link.purpose));
  for (const link of acquisition.filter(link => !eligible.includes(link))) {
    item.alternatives.push({ relation: link.rel, format: link.type ?? null, purpose: link.purpose ?? null, decision: 'rejected', reason: link.purpose ? `用途 ${link.purpose} 不在本馆允许范围` : '未声明用途，不自动同意额外条款' });
  }
  if (!item.publication) { item.status = 'skipped'; item.rationale.push('目录条目缺少书目标识，无法建立正文、授权与目录的对应关系'); return { item }; }
  if (!eligible.length) {
    item.status = 'skipped';
    item.rationale.push(acquisition.length ? '现有获取路径的用途均不在本馆允许范围内，不自动同意额外条款' : '目录未提供正文获取路径；仅有样章时不登记为馆藏');
    return { item };
  }
  const chosen = [...eligible].sort((a, b) => (a.rel === RELATION.openAccess ? 0 : 1) - (b.rel === RELATION.openAccess ? 0 : 1))[0];
  for (const link of eligible.filter(candidate => candidate !== chosen)) {
    item.alternatives.push({ relation: link.rel, format: link.type ?? null, purpose: link.purpose, decision: 'deferred', reason: `同一书目的其他获准路径，本次选用 ${chosen.rel}（${chosen.type ?? '未知格式'}）` });
  }
  item.relation = chosen.rel;
  item.format = chosen.type ?? null;
  item.purpose = chosen.purpose;
  item.retention = RETENTION[chosen.purpose] ?? 'temporary';
  return { item, chosen };
}

async function archiveCatalogEntry(archive, source, publication) {
  const links = Array.isArray(publication.links) ? publication.links : [];
  const data = {
    kind: CATALOG_ENTRY,
    publication: publication.metadata.identifier,
    title: publication.metadata?.title ?? null,
    relations: links.map(link => ({ rel: link.rel ?? null, format: link.type ?? null, purpose: link.purpose ?? null, href: link.href ?? null })),
  };
  await archive.accept(source, { publication: data.publication, license: CATALOG_ENTRY }, data, Buffer.from(JSON.stringify(publication)));
}

async function fetchContent(base, href, headers = {}) {
  const reply = await request(resolve(base, href), { headers });
  if (reply.status >= 300 && reply.status < 400) throw new Error('内容地址返回重定向，为避免凭据外泄未跟随');
  if (reply.status !== 200) throw new Error(`正文领取失败，来源返回 ${reply.status}`);
  if (reply.bytes.length > MAX_CONTENT_BYTES) throw new Error('正文超出本馆接收上限');
  return reply;
}

async function acquireFulltext(archive, source, item, content, license, rationale) {
  item.status = 'acquired';
  item.license = license;
  item.rationale.push(...rationale);
  const data = {
    kind: 'fulltext',
    publication: item.publication, title: item.title, license,
    relation: item.relation, format: item.format, purpose: item.purpose, retention: item.retention,
    loan: item.loan, catalogEntry: item.catalogEntry, rationale: item.rationale,
  };
  const result = await archive.accept(source, { publication: item.publication, license }, data, content);
  Object.assign(item, { receipt: result.receipt, version: result.version, duplicate: result.duplicate, sha256: result.sha256, contentBytes: content.length });
}

async function executeBorrow(archive, source, base, chosen, item) {
  const loanReply = await request(resolve(base, chosen.href), { method: 'POST' });
  if (loanReply.status === 409) {
    const detail = parseJson(loanReply.bytes);
    const reason = detail?.reason ?? '借阅席位暂不可用';
    item.status = 'waiting';
    item.rationale.push(`借阅席位暂不可用（${reason}），保留等待状态，席位恢复后重试`);
    item.rationale.push('样章不构成正文，等待期间不以预览替代登记');
    const data = {
      kind: LOAN_WAITING,
      publication: item.publication, title: item.title,
      relation: chosen.rel, purpose: chosen.purpose, reason,
      note: '保留等待状态，未以样章或其他路径替代正文',
      catalogEntry: item.catalogEntry, rationale: item.rationale,
    };
    const result = await archive.accept(source, { publication: item.publication, license: LOAN_WAITING }, data, Buffer.from(JSON.stringify(data)));
    Object.assign(item, { receipt: result.receipt, version: result.version, duplicate: result.duplicate });
    return;
  }
  if (loanReply.status !== 200) throw new Error(`借阅请求失败，来源返回 ${loanReply.status}`);
  const loan = parseJson(loanReply.bytes);
  if (!loan || typeof loan !== 'object') throw new Error('借阅响应无法解析');
  item.loan = { loanId: loan.loanId ?? null, expires: loan.expires ?? null, state: loan.state ?? null };
  if (loan.state === 'expired') {
    item.status = 'expired';
    item.license = loan.loanId ?? null;
    item.rationale.push(`授权实例 ${loan.loanId ?? '未知'} 已到期，本次不领取正文；书目仍在目录中，到期不等于下架`);
    return;
  }
  if (loan.state !== 'active') throw new Error(`借阅状态无法处理：${loan.state}`);
  if (!loan.href || !loan.token) throw new Error('借阅响应缺少内容地址或授权凭据');
  const reply = await fetchContent(base, loan.href, { authorization: `Bearer ${loan.token}` });
  const license = reply.headers['x-license-id'] ?? loan.loanId;
  await acquireFulltext(archive, source, item, reply.bytes, license, [
    `目录声明 ${chosen.rel}，用途 ${chosen.purpose} 在本馆 /policy 允许范围内`,
    `借阅实例 ${loan.loanId}（到期 ${loan.expires ?? '未知'}）凭授权领取正文，按临时阅读登记，不并入永久馆藏；续借或新实例单独登记`,
  ]);
}

export async function collectFromSource(archive, base) {
  const normalized = base.replace(/\/+$/, '');
  const source = `partner:${normalized}`;
  const startedAt = new Date().toISOString();
  const purposes = await fetchPolicy(normalized);
  const publications = await fetchCatalog(normalized);
  const items = [];
  for (const publication of publications) {
    const { item, chosen } = planPublication(publication, purposes);
    try {
      if (item.publication) {
        item.catalogEntry = { publication: item.publication, license: CATALOG_ENTRY };
        await archiveCatalogEntry(archive, source, publication);
      }
      if (chosen?.rel === RELATION.openAccess) {
        const reply = await fetchContent(normalized, chosen.href);
        const license = reply.headers['x-license-id'] ?? chosen.href.split('/').filter(Boolean).pop();
        await acquireFulltext(archive, source, item, reply.bytes, license, [
          `目录声明 ${chosen.rel}，用途 ${chosen.purpose} 在本馆 /policy 允许范围内，直接领取正文`,
          `授权实例 ${license} 按${item.retention === 'permanent' ? '永久馆藏' : '临时阅读'}登记`,
        ]);
      } else if (chosen?.rel === RELATION.borrow) {
        await executeBorrow(archive, source, normalized, chosen, item);
      }
      if (item.status === 'pending') item.status = 'skipped';
    } catch (error) { item.status = 'failed'; item.error = error.message; }
    items.push(item);
  }
  const summary = { publications: items.length, acquired: 0, waiting: 0, expired: 0, skipped: 0, failed: 0 };
  for (const item of items) summary[item.status] = (summary[item.status] ?? 0) + 1;
  return { source: normalized, startedAt, finishedAt: new Date().toISOString(), policy: [...purposes], summary, items };
}
