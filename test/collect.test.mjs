import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createProvider } from '../provider/server.mjs';
import { Archive, digest } from '../src/archive.mjs';
import { collectFromSource } from '../src/collect.mjs';
import { createIntake } from '../src/server.mjs';

const PREVIEW_SHA = digest(Buffer.from('仅供试看的一页'));
async function withSource(context, flags = {}) {
  const service = createProvider(); service.listen(0, '127.0.0.1'); await once(service, 'listening');
  context.after(async () => { service.closeAllConnections(); await new Promise(resolve => service.close(resolve)); });
  const base = `http://127.0.0.1:${service.address().port}`;
  const control = value => fetch(base + '/__control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
  if (Object.keys(flags).length) await control(flags);
  return { base, control };
}
async function withArchive(context) {
  const directory = await mkdtemp(join(tmpdir(), 'collect-')); context.after(() => rm(directory, { recursive: true, force: true }));
  return new Archive(directory).initialize();
}
const item = (report, publication) => report.items.find(entry => entry.publication === publication);
const fulltexts = records => records.filter(record => record.versions.at(-1).data.kind === 'fulltext');

test('开放获取正文入库，样章永不登记，目录条目与正文对应', async context => {
  const { base } = await withSource(context); const archive = await withArchive(context);
  const report = await collectFromSource(archive, base);
  const a = item(report, 'book-a');
  assert.equal(a.status, 'acquired'); assert.equal(a.retention, 'permanent');
  assert.equal(a.license, 'open-1'); assert.equal(a.format, 'text/plain'); assert.equal(a.purpose, 'archive-open');
  assert.ok(a.rationale.some(line => line.includes('archive-open')));
  assert.ok(a.alternatives.some(alt => alt.relation === 'preview' && alt.decision === 'rejected'));
  const records = await archive.list();
  const full = fulltexts(records).find(record => record.identity.license === 'open-1');
  assert.equal(full.identity.publication, 'book-a'); assert.ok(full.source.startsWith('partner:'));
  assert.equal(full.versions[0].data.retention, 'permanent');
  assert.deepEqual(full.versions[0].data.catalogEntry, { publication: 'book-a', license: 'catalog-entry' });
  assert.ok(records.some(record => record.identity.license === 'catalog-entry' && record.identity.publication === 'book-a'));
  assert.ok(!records.some(record => record.versions.some(version => version.sha256 === PREVIEW_SHA)));
  assert.equal((await archive.bytes(full.versions[0].sha256)).toString(), '海岛馆藏导读完整正文');
});

test('借阅实例按临时阅读登记，续借生成独立实例而不并馆', async context => {
  const { base, control } = await withSource(context); const archive = await withArchive(context);
  const first = await collectFromSource(archive, base);
  const b = item(first, 'book-b');
  assert.equal(b.status, 'acquired'); assert.equal(b.retention, 'temporary'); assert.equal(b.license, 'loan-1');
  assert.equal(b.loan.loanId, 'loan-1'); assert.ok(b.rationale.some(line => line.includes('不并入永久馆藏')));
  await control({ revision: 2 });
  const second = await collectFromSource(archive, base);
  assert.equal(item(second, 'book-b').license, 'loan-2');
  const records = fulltexts(await archive.list()).filter(record => record.identity.publication === 'book-b');
  assert.deepEqual(records.map(record => record.identity.license).sort(), ['loan-1', 'loan-2']);
  for (const record of records) assert.equal(record.versions.length, 1);
  assert.equal(records.find(record => record.identity.license === 'loan-1').versions[0].data.loan.loanId, 'loan-1');
});

test('席位不可用保留等待状态，不以样章顶替，恢复后可领取', async context => {
  const { base, control } = await withSource(context, { unavailable: true }); const archive = await withArchive(context);
  const first = await collectFromSource(archive, base);
  const b = item(first, 'book-b');
  assert.equal(b.status, 'waiting'); assert.equal(b.license, null);
  assert.ok(b.rationale.some(line => line.includes('等待')));
  let records = await archive.list();
  assert.ok(!fulltexts(records).some(record => record.identity.publication === 'book-b'));
  const waiting = records.find(record => record.identity.license === 'loan-waiting' && record.identity.publication === 'book-b');
  assert.equal(waiting.versions.at(-1).data.kind, 'loan-waiting');
  assert.ok(!records.some(record => record.versions.some(version => version.sha256 === PREVIEW_SHA)));
  const again = await collectFromSource(archive, base);
  assert.equal(item(again, 'book-b').duplicate, true);
  assert.equal((await archive.list()).find(record => record.identity.license === 'loan-waiting').versions.length, 1);
  await control({ unavailable: false });
  const third = await collectFromSource(archive, base);
  assert.equal(item(third, 'book-b').status, 'acquired');
  assert.ok(fulltexts(await archive.list()).some(record => record.identity.license === 'loan-1'));
});

test('授权实例到期不等于书目下架', async context => {
  const { base, control } = await withSource(context); const archive = await withArchive(context);
  await collectFromSource(archive, base);
  await control({ expired: true });
  const report = await collectFromSource(archive, base);
  const b = item(report, 'book-b');
  assert.equal(b.status, 'expired'); assert.equal(b.license, 'loan-1');
  assert.ok(b.rationale.some(line => line.includes('到期不等于下架')));
  const records = await archive.list();
  assert.ok(records.some(record => record.identity.license === 'catalog-entry' && record.identity.publication === 'book-b'));
  const kept = fulltexts(records).find(record => record.identity.license === 'loan-1');
  assert.equal(kept.versions.length, 1);
  assert.ok(!fulltexts(records).some(record => record.identity.license === 'loan-2'));
});

test('目录分页逐一跟随 next 链接', async context => {
  const { base } = await withSource(context, { paged: true }); const archive = await withArchive(context);
  const report = await collectFromSource(archive, base);
  assert.equal(report.summary.publications, 2); assert.equal(report.summary.acquired, 2);
  assert.ok(item(report, 'book-a')); assert.ok(item(report, 'book-b'));
});

test('同一书目多种格式只选一条并在复核中列出备选', async context => {
  const { base } = await withSource(context, { extraFormat: true }); const archive = await withArchive(context);
  const report = await collectFromSource(archive, base);
  const a = item(report, 'book-a');
  assert.equal(a.status, 'acquired'); assert.equal(a.format, 'text/plain');
  assert.ok(a.alternatives.some(alt => alt.decision === 'deferred' && alt.format === 'text/html'));
  const records = fulltexts(await archive.list()).filter(record => record.identity.license === 'open-1');
  assert.equal(records.length, 1); assert.equal(records[0].versions.length, 1);
});

test('HTTP 自动采集入口、复核查询与来源故障', async context => {
  const { base: source } = await withSource(context);
  const directory = await mkdtemp(join(tmpdir(), 'intake-')); context.after(() => rm(directory, { recursive: true, force: true }));
  const service = await createIntake(directory, { source });
  service.listen(0, '127.0.0.1'); await once(service, 'listening');
  context.after(async () => { service.closeAllConnections(); await new Promise(resolve => service.close(resolve)); });
  const base = `http://127.0.0.1:${service.address().port}`;
  assert.equal((await fetch(base + '/api/review')).status, 404);
  const response = await fetch(base + '/api/collect', { method: 'POST' });
  assert.equal(response.status, 200);
  const report = await response.json();
  assert.equal(report.summary.acquired, 2);
  const review = await (await fetch(base + '/api/review')).json();
  assert.equal(review.startedAt, report.startedAt);
  const records = await (await fetch(base + '/api/records')).json();
  assert.ok(records.some(record => record.source.startsWith('partner:')));
  const brokenDir = await mkdtemp(join(tmpdir(), 'intake-')); context.after(() => rm(brokenDir, { recursive: true, force: true }));
  const broken = await createIntake(brokenDir, { source: 'http://127.0.0.1:1' });
  broken.listen(0, '127.0.0.1'); await once(broken, 'listening');
  context.after(async () => { broken.closeAllConnections(); await new Promise(resolve => broken.close(resolve)); });
  const failed = await fetch(`http://127.0.0.1:${broken.address().port}/api/collect`, { method: 'POST' });
  assert.equal(failed.status, 502);
});
