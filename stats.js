const db = require('./database');

let initialized = false;

async function initStats() {
  if (!process.env.DATABASE_URL) {
    console.warn('📊 Estatísticas desativadas: configure DATABASE_URL em Bot/.env.');
    return false;
  }

  await db.query(`
    CREATE TABLE IF NOT EXISTS tcc_bot_usage_events (
      id BIGSERIAL PRIMARY KEY,
      discord_user_id VARCHAR(32) NOT NULL,
      username VARCHAR(100) NOT NULL,
      guild_id VARCHAR(32),
      event_type VARCHAR(40) NOT NULL,
      command_name VARCHAR(80),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_tcc_usage_created_at ON tcc_bot_usage_events (created_at);
    CREATE INDEX IF NOT EXISTS idx_tcc_usage_user_created ON tcc_bot_usage_events (discord_user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_tcc_usage_event_type ON tcc_bot_usage_events (event_type);
  `);
  initialized = true;
  console.log('📊 Tabelas de estatísticas verificadas.');
  return true;
}

async function recordEvent({ userId, username, guildId = null, eventType, commandName = null }) {
  if (!initialized || !userId || !eventType) return;
  try {
    await db.query(
      `INSERT INTO tcc_bot_usage_events
       (discord_user_id, username, guild_id, event_type, command_name)
       VALUES ($1, $2, $3, $4, $5)`,
      [String(userId), String(username || 'desconhecido').slice(0, 100), guildId ? String(guildId) : null, eventType, commandName]
    );
  } catch (error) {
    console.error('📊 Não foi possível registrar evento de estatística:', error.message);
  }
}

async function getSummary() {
  if (!initialized) throw new Error('Estatísticas ainda não foram inicializadas. Inicie o bot com DATABASE_URL configurado.');
  const totals = await db.query(`
    SELECT
      COUNT(DISTINCT discord_user_id)::int AS unique_users,
      COUNT(DISTINCT discord_user_id) FILTER (WHERE created_at >= NOW() - INTERVAL '1 day')::int AS active_today,
      COUNT(DISTINCT discord_user_id) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days')::int AS active_week,
      COUNT(DISTINCT discord_user_id) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days')::int AS active_month,
      COUNT(*) FILTER (WHERE event_type = 'tcc_started')::int AS tccs_started,
      COUNT(*) FILTER (WHERE event_type = 'document_generated')::int AS documents_generated,
      COUNT(*) FILTER (WHERE event_type = 'command')::int AS command_uses
    FROM tcc_bot_usage_events
  `);
  const daily = await db.query(`
    SELECT TO_CHAR(day::date, 'DD/MM') AS label,
           COALESCE(counts.users, 0)::int AS users,
           COALESCE(counts.uses, 0)::int AS uses
    FROM generate_series(CURRENT_DATE - INTERVAL '29 days', CURRENT_DATE, INTERVAL '1 day') AS day
    LEFT JOIN (
      SELECT created_at::date AS event_day,
             COUNT(DISTINCT discord_user_id) AS users,
             COUNT(*) AS uses
      FROM tcc_bot_usage_events
      WHERE created_at >= CURRENT_DATE - INTERVAL '29 days'
      GROUP BY created_at::date
    ) counts ON counts.event_day = day::date
    ORDER BY day
  `);
  const commands = await db.query(`
    SELECT command_name, COUNT(*)::int AS total
    FROM tcc_bot_usage_events
    WHERE event_type = 'command' AND command_name IS NOT NULL
    GROUP BY command_name ORDER BY total DESC, command_name ASC LIMIT 8
  `);
  return { totals: totals.rows[0], daily: daily.rows, commands: commands.rows };
}

module.exports = { initStats, recordEvent, getSummary };
