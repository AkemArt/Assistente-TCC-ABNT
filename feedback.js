const db = require('./database');

async function initFeedback() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL não configurado.');
  }

  await db.query(`
    CREATE TABLE IF NOT EXISTS tcc_avaliacoes (
      id BIGSERIAL PRIMARY KEY,
      discord_user_id VARCHAR(32) NOT NULL,
      discord_username VARCHAR(100) NOT NULL,
      user_email VARCHAR(160),
      rating_input VARCHAR(120) NOT NULL,
      improvement_notes TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE tcc_avaliacoes ALTER COLUMN improvement_notes SET DEFAULT '';
  `);

  console.log('⭐ Tabela de avaliações (tcc_avaliacoes) verificada.');
}

async function saveRating({
  discordUserId,
  discordUsername,
  userEmail,
  ratingLabel
}) {
  const res = await db.query(
    `INSERT INTO tcc_avaliacoes
      (discord_user_id, discord_username, user_email, rating_input, improvement_notes)
     VALUES ($1, $2, $3, $4, '')
     RETURNING id, created_at`,
    [
      String(discordUserId),
      String(discordUsername || 'desconhecido').slice(0, 100),
      userEmail ? String(userEmail).trim().toLowerCase().slice(0, 160) : null,
      String(ratingLabel).slice(0, 120)
    ]
  );

  return {
    ok: true,
    id: res.rows[0].id
  };
}

async function updateImprovementNotes({ feedbackId, discordUserId, improvementNotes }) {
  const cleanNotes = String(improvementNotes || '').trim();
  if (!cleanNotes) {
    return { ok: false, message: 'Escreva o que precisa melhorar ou uma observação.' };
  }

  const res = await db.query(
    `UPDATE tcc_avaliacoes
     SET improvement_notes = $1
     WHERE id = $2 AND discord_user_id = $3
     RETURNING id, rating_input`,
    [cleanNotes.slice(0, 2000), Number(feedbackId), String(discordUserId)]
  );

  if (res.rowCount === 0) {
    return { ok: false, message: 'Avaliação não encontrada para atualizar.' };
  }

  return {
    ok: true,
    ratingInput: res.rows[0].rating_input,
    message: 'Avaliação e sugestões enviadas com sucesso! Muito obrigado.'
  };
}

async function listFeedback(limit = 15) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 15, 50));
  const res = await db.query(
    `SELECT id, discord_user_id, discord_username, user_email, rating_input, improvement_notes, created_at
     FROM tcc_avaliacoes
     ORDER BY created_at DESC
     LIMIT $1`,
    [safeLimit]
  );
  return res.rows;
}

module.exports = {
  initFeedback,
  saveRating,
  updateImprovementNotes,
  listFeedback
};
