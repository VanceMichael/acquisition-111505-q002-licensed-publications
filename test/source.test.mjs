import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createProvider } from '../provider/server.mjs';
async function withSource(context) {
  const service = createProvider(); service.listen(0, '127.0.0.1'); await once(service, 'listening');
  context.after(async () => { service.closeAllConnections(); await new Promise(resolve => service.close(resolve)); });
  const base = `http://127.0.0.1:${service.address().port}`;
  const control = value => fetch(base + '/__control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
  const post = (path, value) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
  return { base, control, post };
}

test('书目获取关系不把试看等同正文', async context => {
  const { base } = await withSource(context); const catalog = await (await fetch(base + '/catalog')).json();
  assert.equal(catalog.publications[0].links[0].rel, 'preview');
  const preview = await fetch(base + '/preview/book-a'); assert.equal(preview.headers.get('x-content-scope'), 'preview');
  assert.notEqual(await preview.text(), await (await fetch(base + '/content/book-a/open-1')).text());
});
test('授权实例更新和到期独立于书目存在', async context => {
  const { base, control } = await withSource(context); await control({ revision: 2 });
  const loan = await (await fetch(base + '/loans/book-b')).json(); assert.equal(loan.loanId, 'loan-2');
  assert.equal((await fetch(base + loan.href)).status, 403);
  assert.equal((await fetch(base + loan.href, { headers: { authorization: 'Bearer borrow-2' } })).status, 200);
  await control({ expired: true }); assert.equal((await fetch(base + loan.href, { headers: { authorization: 'Bearer borrow-2' } })).status, 403);
});
