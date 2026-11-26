const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../database');
const queue = require('../tcc-generation-queue');

test('registra projeto na fila persistente sem descartar os dados informados', async () => {
  const originalQuery = db.query;
  const calls = [];
  db.query = async (sql, params = []) => {
    calls.push({ sql, params });
    if (/INSERT INTO tcc_generation_queue/i.test(sql)) {
      return { rows: [{ id: '42', status: 'waiting_quota', created_at: '2026-11-26T00:00:00Z' }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  try {
    const project = {
      userId: '123456789',
      username: 'aluno-teste',
      guildId: '987654321',
      title: 'Uso de IA na educação',
      pageCount: '15'
    };
    const item = await queue.enqueueGeneration(project, 'RESOURCE_EXHAUSTED');
    assert.equal(item.id, '42');
    assert.equal(item.status, 'waiting_quota');
    const insert = calls.find(call => /INSERT INTO tcc_generation_queue/i.test(call.sql));
    assert.ok(insert, 'deve executar INSERT na fila');
    assert.equal(insert.params[0], project.userId);
    assert.equal(insert.params[2], project.guildId);
    assert.deepEqual(JSON.parse(insert.params[3]), project);
    assert.match(insert.params[4], /RESOURCE_EXHAUSTED/);
  } finally {
    db.query = originalQuery;
  }
});

test('claim usa FOR UPDATE SKIP LOCKED para evitar dois workers pegarem a mesma tarefa', async () => {
  const originalQuery = db.query;
  const calls = [];
  db.query = async (sql) => {
    calls.push(sql);
    if (/UPDATE tcc_generation_queue q/i.test(sql)) {
      return { rows: [{ id: '42', status: 'processing', attempts: 1 }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  try {
    const claimed = await queue.claimNextGeneration();
    assert.equal(claimed.id, '42');
    const claimSql = calls.find(sql => /UPDATE tcc_generation_queue q/i.test(sql));
    assert.match(claimSql, /FOR UPDATE SKIP LOCKED/);
    assert.match(claimSql, /retry_at <= now\(\)/);
  } finally {
    db.query = originalQuery;
  }
});

test('calcula novas tentativas progressivas com limite de 12 horas', () => {
  const agora = Date.UTC(2026, 10, 26, 0, 0, 0);
  const primeira = queue.calcularRetryAt(1, agora);
  const segunda = queue.calcularRetryAt(2, agora);
  const ultima = queue.calcularRetryAt(8, agora);
  assert.equal(primeira.getTime() - agora, 30 * 60 * 1000);
  assert.equal(segunda.getTime() - agora, 60 * 60 * 1000);
  assert.equal(ultima.getTime() - agora, 12 * 60 * 60 * 1000);
});
