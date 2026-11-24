const crypto = require('crypto');
const db = require('./database');

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

function verifyPassword(password, storedHash) {
  if (!storedHash || !storedHash.includes(':')) return false;
  const [salt, originalHex] = storedHash.split(':');
  const derivedBuf = crypto.scryptSync(String(password), salt, 64);
  const originalBuf = Buffer.from(originalHex, 'hex');
  if (derivedBuf.length !== originalBuf.length) return false;
  return crypto.timingSafeEqual(derivedBuf, originalBuf);
}

function isValidEmail(email) {
  const normalized = String(email || '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized);
}

function isValidEightDigitPin(password) {
  return /^\d{8}$/.test(String(password || '').trim());
}

async function initAuth() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL não configurado.');
  }

  await db.query(`
    CREATE TABLE IF NOT EXISTS tcc_users (
      id BIGSERIAL PRIMARY KEY,
      discord_user_id VARCHAR(32) UNIQUE NOT NULL,
      discord_username VARCHAR(100) NOT NULL,
      email VARCHAR(160) UNIQUE NOT NULL,
      saved_email VARCHAR(160),
      keep_connected BOOLEAN NOT NULL DEFAULT TRUE,
      password_hash TEXT NOT NULL,
      is_logged_in BOOLEAN NOT NULL DEFAULT FALSE,
      last_login_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE tcc_users ADD COLUMN IF NOT EXISTS email VARCHAR(160);
    ALTER TABLE tcc_users ADD COLUMN IF NOT EXISTS saved_email VARCHAR(160);
    ALTER TABLE tcc_users ADD COLUMN IF NOT EXISTS keep_connected BOOLEAN NOT NULL DEFAULT TRUE;
  `);

  await db.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'tcc_users'
          AND column_name = 'login_user'
      ) THEN
        ALTER TABLE tcc_users ALTER COLUMN login_user DROP NOT NULL;
      END IF;
    END
    $$;
  `);

  console.log('🔐 Tabela de utilizadores (tcc_users) verificada.');
}

async function registerUser({ discordUserId, discordUsername, email, password }) {
  const cleanEmail = String(email || '').trim().toLowerCase();
  const cleanPass = String(password || '').trim();

  if (!isValidEmail(cleanEmail)) {
    return { ok: false, message: 'Introduza um endereço de e-mail válido.' };
  }
  if (!isValidEightDigitPin(cleanPass)) {
    return { ok: false, message: 'A senha deve conter exatamente 8 números (apenas dígitos de 0 a 9).' };
  }

  const existingByDiscord = await db.query(
    'SELECT id, email FROM tcc_users WHERE discord_user_id = $1',
    [String(discordUserId)]
  );
  if (existingByDiscord.rowCount > 0) {
    return {
      ok: false,
      message: `A sua conta do Discord já está registada com o e-mail **${existingByDiscord.rows[0].email}**. Utilize \`/login\`.`
    };
  }

  const existingByEmail = await db.query(
    'SELECT id FROM tcc_users WHERE LOWER(email) = LOWER($1)',
    [cleanEmail]
  );
  if (existingByEmail.rowCount > 0) {
    return {
      ok: false,
      message: 'Este e-mail já se encontra registado. Utilize outro ou faça \`/login\`.'
    };
  }

  const passwordHash = hashPassword(cleanPass);

  await db.query(
    `INSERT INTO tcc_users
      (discord_user_id, discord_username, email, saved_email, keep_connected, password_hash, is_logged_in, last_login_at)
     VALUES ($1, $2, $3, $3, TRUE, $4, TRUE, NOW())`,
    [
      String(discordUserId),
      String(discordUsername || 'desconhecido').slice(0, 100),
      cleanEmail,
      passwordHash
    ]
  );

  return {
    ok: true,
    email: cleanEmail,
    message: `Registo concluído e sessão iniciada com o e-mail **${cleanEmail}**!`
  };
}

async function loginUser({ discordUserId, discordUsername, email, password }) {
  const cleanEmail = String(email || '').trim().toLowerCase();
  const cleanPass = String(password || '').trim();

  if (!isValidEmail(cleanEmail) || !isValidEightDigitPin(cleanPass)) {
    return { ok: false, message: 'E-mail ou senha inválidos. A senha deve ter exatamente 8 números.' };
  }

  const res = await db.query(
    `SELECT id, discord_user_id, email, keep_connected, password_hash
     FROM tcc_users
     WHERE LOWER(email) = LOWER($1)`,
    [cleanEmail]
  );

  if (res.rowCount === 0) {
    return { ok: false, message: 'E-mail ou senha inválidos.' };
  }

  const user = res.rows[0];

  if (String(user.discord_user_id) !== String(discordUserId)) {
    return {
      ok: false,
      message: 'Este e-mail pertence a outra conta do Discord.'
    };
  }

  if (!verifyPassword(cleanPass, user.password_hash)) {
    return { ok: false, message: 'E-mail ou senha inválidos.' };
  }

  await db.query(
    `UPDATE tcc_users
     SET is_logged_in = TRUE,
         saved_email = $2,
         discord_username = $3,
         last_login_at = NOW()
     WHERE id = $1`,
    [user.id, user.email, String(discordUsername || 'desconhecido').slice(0, 100)]
  );

  return {
    ok: true,
    email: user.email,
    message: `Login efetuado com sucesso com o e-mail **${user.email}**!`
  };
}

async function getSavedLogin(discordUserId) {
  const res = await db.query(
    'SELECT email, saved_email, keep_connected FROM tcc_users WHERE discord_user_id = $1',
    [String(discordUserId)]
  );
  if (res.rowCount === 0) return null;
  return res.rows[0];
}

async function setKeepConnected(discordUserId, enabled) {
  const res = await db.query(
    `UPDATE tcc_users
     SET keep_connected = $2,
         is_logged_in = CASE WHEN $2 = TRUE THEN TRUE ELSE is_logged_in END
     WHERE discord_user_id = $1
     RETURNING email, saved_email, keep_connected`,
    [String(discordUserId), Boolean(enabled)]
  );
  return res.rows[0] || null;
}

async function logoutUser(discordUserId) {
  await db.query(
    'UPDATE tcc_users SET is_logged_in = FALSE, keep_connected = FALSE WHERE discord_user_id = $1',
    [String(discordUserId)]
  );
}

async function isUserLoggedIn(discordUserId) {
  const res = await db.query(
    'SELECT is_logged_in, keep_connected, email FROM tcc_users WHERE discord_user_id = $1',
    [String(discordUserId)]
  );
  if (res.rowCount === 0) {
    return { loggedIn: false, reason: 'not_registered' };
  }
  const row = res.rows[0];
  if (!row.is_logged_in && !row.keep_connected) {
    return { loggedIn: false, reason: 'logged_out', email: row.email };
  }
  return { loggedIn: true, email: row.email, keepConnected: row.keep_connected };
}

async function listRegisteredUsers() {
  const res = await db.query(
    `SELECT discord_user_id, discord_username, email, saved_email, keep_connected, is_logged_in, last_login_at, created_at
     FROM tcc_users
     ORDER BY created_at DESC`
  );
  return res.rows;
}

module.exports = {
  initAuth,
  registerUser,
  loginUser,
  getSavedLogin,
  setKeepConnected,
  logoutUser,
  isUserLoggedIn,
  listRegisteredUsers
};
