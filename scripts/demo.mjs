import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createIntake } from '../src/server.mjs';
import { createProvider } from '../provider/server.mjs';
const directory = await mkdtemp(join(tmpdir(), 'intake-demo-'));
const provider = createProvider();
let intake;
try {
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
  const source = `http://127.0.0.1:${provider.address().port}`;
  intake = await createIntake(directory, { source });
  intake.listen(0, '127.0.0.1'); await once(intake, 'listening');
  const base = `http://127.0.0.1:${intake.address().port}`;
  const control = value => fetch(source + '/__control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
  const collect = async () => (await fetch(base + '/api/collect', { method: 'POST' })).json();
  const brief = report => report.items.map(({ publication, status, license, retention, duplicate }) => ({ publication, status, license, retention, duplicate }));
  const sample = JSON.parse(await readFile(new URL('../fixtures/manual.json', import.meta.url), 'utf8'));
  const manual = await fetch(base + '/api/manual', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(sample) });
  console.log(JSON.stringify({ 人工收件: await manual.json() }));
  const first = await collect();
  console.log(JSON.stringify({ 首次自动采集: first.summary, 明细: brief(first) }));
  await control({ unavailable: true, revision: 2 });
  const second = await collect();
  console.log(JSON.stringify({ 席位占用时: second.summary, 明细: brief(second) }));
  await control({ unavailable: false });
  const third = await collect();
  console.log(JSON.stringify({ 席位恢复后: third.summary, 明细: brief(third) }));
  const records = await (await fetch(base + '/api/records')).json();
  console.log(JSON.stringify({ 归档记录: records.map(record => ({ 来源: record.source, 身份: record.identity, 版本数: record.versions.length, 类型: record.versions.at(-1).data.kind ?? 'manual' })) }));
} finally {
  intake?.closeAllConnections(); provider.closeAllConnections();
  await Promise.all([intake ? new Promise(resolve => intake.close(resolve)) : null, new Promise(resolve => provider.close(resolve))]);
  await rm(directory, { recursive: true, force: true });
}
