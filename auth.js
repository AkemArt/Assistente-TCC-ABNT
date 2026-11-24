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

function parseKeepConnected(rawValue, defaultValue = true) {
  const normalized = String(rawValue || '').trim().toLowerCase();
  if (!normalized) return defaultValue;
  if (['nao', 'não', 'n', 'no', 'false', '0'].includes(normalized)) return false;
  if (['sim', 's', 'yes', 'y', 'true', '1', 'manter'].includes(normalized)) return true;
  return defaultValue;
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
      login_user VARCHAR(80) UNIQUE NOT NULL,
      saved_login_user VARCHAR(80),
      keep_connected BOOLEAN NOT NULL DEFAULT TRUE,
      password_hash TEXT NOT NULL,
      is_logged_in BOOLEAN NOT NULL DEFAULT FALSE,
      last_login_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE tcc_users ADD COLUMN IF NOT EXISTS saved_login_user VARCHAR(80);
    ALTER TABLE tcc_users ADD COLUMN IF NOT EXISTS keep_connected BOOLEAN NOT NULL DEFAULT TRUE;
  `);

  console.log('🔐 Tabela de usuários (tcc_users) verificada.');
}

async function registerUser({
  discordUserId,
  discordUsername,
  loginUser,
  password,
  keepConnectedInput
}) {
  const cleanLogin = String(loginUser || '').trim().toLowerCase();
  const cleanPass = String(password || '').trim();
  const keepConnected = parseKeepConnected(keepConnectedInput, true);

  if (cleanLogin.length < 3) {
    return { ok: false, message: 'O usuário de login deve ter pelo menos 3 caracteres.' };
  }
  if (cleanPass.length < 4) {
    return { ok: false, message: 'A senha deve ter pelo menos 4 caracteres.' };
  }

  const existingByDiscord = await db.query(
    'SELECT id, login_user FROM tcc_users WHERE discord_user_id = $1',
    [String(discordUserId)]
  );
  if (existingByDiscord.rowCount > 0) {
    return {
      ok: false,
      message: `Sua conta do Discord já está cadastrada com o login **${existingByDiscord.rows[0].login_user}**. Use \`/login\`.`
    };
  }

  const existingByLogin = await db.query(
    'SELECT id FROM tcc_users WHERE LOWER(login_user) = LOWER($1)',
    [cleanLogin]
  );
  if (existingByLogin.rowCount > 0) {
    return {
      ok: false,
      message: 'Esse nome de usuário de login já está em uso. Escolha outro.'
    };
  }

  const passwordHash = hashPassword(cleanPass);

  await db.query(
    `INSERT INTO tcc_users
      (discord_user_id, discord_username, login_user, saved_login_user, keep_connected, password_hash, is_logged_in, last_login_at)
     VALUES ($1, $2, $3, $4, $5, $6, TRUE, NOW())`,
    [
      String(discordUserId),
      String(discordUsername || 'desconhecido').slice(0, 100),
      cleanLogin,
      cleanLogin,
      keepConnected,
      passwordHash
    ]
  );

  return {
    ok: true,
    message:
      `Cadastro concluído e login ativo com **${cleanLogin}**!\n` +
      `• Login salvo: **${cleanLogin}**\n` +
      `• Manter conectado: **${keepConnected ? 'Ativado' : 'Desativado'}**`
  };
}

async function loginUser({
  discordUserId,
  discordUsername,
  loginUser,
  password,
  keepConnectedInput
}) {
  const cleanLogin = String(loginUser || '').trim().toLowerCase();
  const cleanPass = String(password || '').trim();

  const res = await db.query(
    `SELECT id, discord_user_id, login_user, keep_connected, password_hash
     FROM tcc_users
     WHERE LOWER(login_user) = LOWER($1)`,
    [cleanLogin]
  );

  if (res.rowCount === 0) {
    return { ok: false, message: 'Usuário ou senha inválidos.' };
  }

  const user = res.rows[0];

  if (String(user.discord_user_id) !== String(discordUserId)) {
    return {
      ok: false,
      message: 'Este login pertence a outra conta do Discord.'
    };
  }

  if (!verifyPassword(cleanPass, user.password_hash)) {
    return { ok: false, message: 'Usuário ou senha inválidos.' };
  }

  const keepConnected = parseKeepConnected(keepConnectedInput, user.keep_connected);

  await db.query(
    `UPDATE tcc_users
     SET is_logged_in = TRUE,
         saved_login_user = $2,
         keep_connected = $3,
         discord_username = $4,
         last_login_at = NOW()
     WHERE id = $1`,
    [user.id, user.login_user, keepConnected, String(discordUsername || 'desconhecido').slice(0, 100)]
  );

  return {
    ok: true,
    message:
      `Login realizado com sucesso! Bem-vindo(a), **${user.login_user}**.\n` +
      `• Login salvo: **${user.login_user}**\n` +
      `• Manter conectado: **${keepConnected ? 'Ativado' : 'Desativado'}**`
  };
}

async function getSavedLogin(discordUserId) {
  const res = await db.query(
    'SELECT login_user, saved_login_user, keep_connected FROM tcc_users WHERE discord_user_id = $1',
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
     RETURNING login_user, keep_connected`,
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
    'SELECT is_logged_in, keep_connected, login_user FROM tcc_users WHERE discord_user_id = $1',
    [String(discordUserId)]
  );
  if (res.rowCount === 0) {
    return { loggedIn: false, reason: 'not_registered' };
  }
  const row = res.rows[0];
  if (!row.is_logged_in && !row.keep_connected) {
    return { loggedIn: false, reason: 'logged_out', loginUser: row.login_user };
  }
  return { loggedIn: true, loginUser: row.login_user, keepConnected: row.keep_connected };
}

async function listRegisteredUsers() {
  const res = await db.query(
    `SELECT discord_user_id, discord_username, login_user, saved_login_user, keep_connected, is_logged_in, last_login_at, created_at
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
