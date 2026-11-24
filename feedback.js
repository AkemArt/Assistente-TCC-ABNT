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
      improvement_notes TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  console.log('⭐ Tabela de avaliações (tcc_avaliacoes) verificada.');
}

async function saveFeedback({
  discordUserId,
  discordUsername,
  userEmail,
  ratingInput,
  improvementNotes
}) {
  const cleanRating = String(ratingInput || '').trim();
  const cleanNotes = String(improvementNotes || '').trim();

  if (!cleanRating) {
    return { ok: false, message: 'Informe uma avaliação (emoji, escrita ou nota de 1 a 10).' };
  }

  if (!cleanNotes) {
    return { ok: false, message: 'Escreva o que precisa melhorar ou uma observação.' };
  }

  const res = await db.query(
    `INSERT INTO tcc_avaliacoes
      (discord_user_id, discord_username, user_email, rating_input, improvement_notes)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, created_at`,
    [
      String(discordUserId),
      String(discordUsername || 'desconhecido').slice(0, 100),
      userEmail ? String(userEmail).trim().toLowerCase().slice(0, 160) : null,
      cleanRating.slice(0, 120),
      cleanNotes.slice(0, 2000)
    ]
  );

  return {
    ok: true,
    id: res.rows[0].id,
    message: 'Avaliação registada com sucesso! Obrigado pelo feedback.'
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
  saveFeedback,
  listFeedback
};
