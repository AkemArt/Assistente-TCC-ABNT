const db = require('./database');

async function initGenerationQueue() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS tcc_generation_queue (
      id BIGSERIAL PRIMARY KEY,
      discord_user_id VARCHAR(32) NOT NULL,
      discord_username VARCHAR(100) NOT NULL DEFAULT 'aluno',
      guild_id VARCHAR(64),
      project_data JSONB NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','processing','waiting_quota','completed','failed')),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      retry_at TIMESTAMPTZ,
      locked_at TIMESTAMPTZ,
      last_error TEXT,
      result_message_id VARCHAR(64),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      completed_at TIMESTAMPTZ
    );
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_tcc_generation_queue_due
    ON tcc_generation_queue (status, retry_at, created_at)
    WHERE status IN ('pending','waiting_quota');
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_tcc_generation_queue_user
    ON tcc_generation_queue (discord_user_id, created_at DESC);
  `);
}

async function enqueueGeneration(project, errorMessage = '') {
  await initGenerationQueue();
  const res = await db.query(`
    INSERT INTO tcc_generation_queue
      (discord_user_id, discord_username, guild_id, project_data, status, last_error)
    VALUES ($1,$2,$3,$4::jsonb,'waiting_quota',$5)
    RETURNING id, status, created_at
  `, [
    String(project.userId || ''),
    String(project.username || 'aluno').slice(0,100),
    project.guildId ? String(project.guildId) : null,
    JSON.stringify(project),
    String(errorMessage || '').slice(0,2000)
  ]);
  return res.rows[0];
}

async function claimNextGeneration() {
  await initGenerationQueue();
  const res = await db.query(`
    WITH candidate AS (
      SELECT id FROM tcc_generation_queue
      WHERE status IN ('pending','waiting_quota')
        AND (retry_at IS NULL OR retry_at <= now())
      ORDER BY COALESCE(retry_at, created_at), created_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    UPDATE tcc_generation_queue q
    SET status='processing', attempts=q.attempts+1, locked_at=now(),
        updated_at=now(), retry_at=NULL
    FROM candidate c
    WHERE q.id=c.id
    RETURNING q.*
  `);
  return res.rows[0] || null;
}

async function markGenerationWaiting(id, retryAt, errorMessage) {
  await db.query(`
    UPDATE tcc_generation_queue
    SET status='waiting_quota', retry_at=$2, locked_at=NULL,
        last_error=$3, updated_at=now()
    WHERE id=$1
  `, [id, retryAt, String(errorMessage || '').slice(0,2000)]);
}

async function markGenerationCompleted(id, messageId = null) {
  await db.query(`
    UPDATE tcc_generation_queue
    SET status='completed', locked_at=NULL, last_error=NULL,
        result_message_id=$2, completed_at=now(), updated_at=now()
    WHERE id=$1
  `, [id, messageId]);
}

async function markGenerationFailed(id, errorMessage) {
  await db.query(`
    UPDATE tcc_generation_queue
    SET status='failed', locked_at=NULL, last_error=$2, updated_at=now()
    WHERE id=$1
  `, [id, String(errorMessage || '').slice(0,2000)]);
}

function calcularRetryAt(attempts = 1, now = Date.now()) {
  const numero = Math.max(1, Number(attempts) || 1);
  const minutos = Math.min(12 * 60, 30 * (2 ** Math.min(numero - 1, 5)));
  return new Date(now + minutos * 60 * 1000);
}

async function recoverStaleGenerations(minutes = 15) {
  const res = await db.query(`
    UPDATE tcc_generation_queue
    SET status='pending', locked_at=NULL, retry_at=now(),
        last_error=COALESCE(last_error,'Processamento interrompido; tarefa recuperada automaticamente.'),
        updated_at=now()
    WHERE status='processing'
      AND locked_at < now() - ($1::int * interval '1 minute')
    RETURNING id
  `, [minutes]);
  return res.rowCount || 0;
}

module.exports = {
  initGenerationQueue,
  enqueueGeneration,
  claimNextGeneration,
  markGenerationWaiting,
  markGenerationCompleted,
  markGenerationFailed,
  recoverStaleGenerations,
  calcularRetryAt
};
