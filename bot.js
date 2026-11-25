require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  Events,
  MessageFlags,
  EmbedBuilder,
  AttachmentBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  REST,
  Routes,
  SlashCommandBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle
} = require('discord.js');

const db = require('./database');
const stats = require('./stats');
const tccProjects = require('./tcc-projects');
const auth = require('./auth');
const feedback = require('./feedback');
const { gerarRascunhoComPesquisa } = require('./ia-tcc');

const http = require('http');

console.log('🚀 Iniciando bot Discord...');

const BOT_TOKEN = process.env.TOKEN || process.env.DISCORD_TOKEN;

if (!BOT_TOKEN) {
  console.error('❌ TOKEN/DISCORD_TOKEN não configurado.');
  process.exit(1);
}

if (!process.env.DATABASE_URL) {
  console.warn('⚠️ DATABASE_URL não configurado. O comando /presenca pode falhar.');
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

const cooldown = new Map();

function describeError(error) {
  return {
    message: error?.message || String(error),
    code: error?.code,
    status: error?.status,
    method: error?.method,
    url: error?.url
  };
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Timeout de ${ms}ms em: ${label}`));
    }, ms);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timer);
  });
}

function buildKeepConnectedMenu(currentValue = true) {
  const select = new StringSelectMenuBuilder()
    .setCustomId('auth_keep_connected_select')
    .setPlaceholder('Escolha uma opção: Sim ou Não')
    .addOptions(
      {
        label: 'Sim — Manter conectado',
        description: 'Mantém a sessão ativa automaticamente nos próximos acessos',
        value: 'sim',
        default: Boolean(currentValue)
      },
      {
        label: 'Não — Não manter conectado',
        description: 'Sessão sem persistência automática após sair',
        value: 'nao',
        default: !currentValue
      }
    );

  return new ActionRowBuilder().addComponents(select);
}

const RATING_DESCRIPTIONS = {
  1: '1 — Menos gostei',
  2: '2 — Muito ruim',
  3: '3 — Ruim',
  4: '4 — Abaixo do esperado',
  5: '5 — Regular',
  6: '6 — Razoável',
  7: '7 — Bom',
  8: '8 — Muito bom',
  9: '9 — Ótimo',
  10: '10 — Gostei muito'
};

function buildRatingMenu() {
  const options = [];
  for (let n = 1; n <= 10; n += 1) {
    let description = 'Avaliação intermediária';
    if (n === 1) description = 'Menos gostei';
    else if (n === 10) description = 'Gostei muito';

    options.push({
      label: `Nota ${n}`,
      description,
      value: String(n)
    });
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId('avaliar_nota_select')
    .setPlaceholder('1 (Menos gostei) a 10 (Gostei muito)')
    .addOptions(options);

  return new ActionRowBuilder().addComponents(select);
}

function buildImprovementButton(feedbackId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`abrir_melhorias_${feedbackId}`)
      .setLabel('Escrever o que precisa melhorar')
      .setStyle(ButtonStyle.Primary)
  );
}

// ======================================================
// COMANDOS SLASH
// ======================================================

function getSlashCommands() {
  return [
    new SlashCommandBuilder()
      .setName('cadastrar')
      .setDescription('Criar conta com e-mail e senha de 8 números'),

    new SlashCommandBuilder()
      .setName('login')
      .setDescription('Entrar na sua conta com e-mail e senha de 8 números'),

    new SlashCommandBuilder()
      .setName('logout')
      .setDescription('Sair da sua sessão atual no bot'),

    new SlashCommandBuilder()
      .setName('manter_conectado')
      .setDescription('Escolher por múltipla escolha (Sim/Não) se deseja manter conectado'),

    new SlashCommandBuilder()
      .setName('avaliar')
      .setDescription('Avaliar de 1 (menos gostei) a 10 (gostei muito) e escrever melhorias'),

    new SlashCommandBuilder()
      .setName('avaliacoes_tcc')
      .setDescription('Consultar avaliações recebidas (restrito ao administrador)'),

    new SlashCommandBuilder()
      .setName('usuarios_tcc')
      .setDescription('Consultar utilizadores registados e sessões (restrito ao administrador)'),

    new SlashCommandBuilder()
      .setName('presenca')
      .setDescription('Registrar presença'),

    new SlashCommandBuilder()
      .setName('iniciar_tcc')
      .setDescription('Iniciar um novo projeto de TCC (Word + PowerPoint)'),

    new SlashCommandBuilder()
      .setName('estatisticas')
      .setDescription('Ver estatísticas de uso do bot de TCC'),

    new SlashCommandBuilder()
      .setName('rascunho_tcc')
      .setDescription('Gerar um rascunho académico com IA')
      .addStringOption(option =>
        option
          .setName('tema')
          .setDescription('Tema do seu TCC')
          .setRequired(true)
      )
      .addStringOption(option =>
        option
          .setName('objetivo')
          .setDescription('Objetivo principal do TCC')
          .setRequired(false)
      )
  ].map(command => command.toJSON());
}

async function syncSlashCommands(client) {
  const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
  const commands = getSlashCommands();
  const appId = process.env.CLIENT_ID || client.user?.id;

  if (!appId) {
    console.warn('⚠️ CLIENT_ID não encontrado. Não foi possível sincronizar os comandos.');
    return;
  }

  try {
    if (process.env.GUILD_ID) {
      await rest.put(
        Routes.applicationGuildCommands(appId, process.env.GUILD_ID),
        { body: commands }
      );

      console.log(`✅ Slash commands sincronizados na guild ${process.env.GUILD_ID}.`);
    } else {
      await rest.put(
        Routes.applicationCommands(appId),
        { body: commands }
      );

      console.log('✅ Slash commands globais sincronizados.');
    }
  } catch (error) {
    console.error('❌ Erro ao sincronizar slash commands:', describeError(error));
  }
}

async function ensureAuthenticated(interaction) {
  try {
    const status = await auth.isUserLoggedIn(interaction.user.id);
    if (status.loggedIn) {
      return true;
    }

    const msg =
      status.reason === 'not_registered'
        ? '🔒 Para usar este comando, faça primeiro o seu registo com `/cadastrar`.'
        : '🔒 A sua sessão foi encerrada. Faça `/login` para continuar.';

    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content: msg, flags: MessageFlags.Ephemeral }).catch(() => {});
    } else {
      await interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
    }
    return false;
  } catch (error) {
    console.error('❌ Erro ao verificar sessão do utilizador:', describeError(error));
    if (!interaction.deferred && !interaction.replied) {
      await interaction.reply({
        content: '❌ Não foi possível verificar o seu estado de login agora.',
        flags: MessageFlags.Ephemeral
      });
    }
    return false;
  }
}

// ======================================================
// INICIALIZAÇÃO
// ======================================================

client.once(Events.ClientReady, () => {
  console.log(`🤖 Bot logado como ${client.user.tag}`);

  syncSlashCommands(client);

  auth.initAuth().catch(error => {
    console.error('❌ Falha ao preparar tabela de utilizadores:', error);
  });

  feedback.initFeedback().catch(error => {
    console.error('❌ Falha ao preparar tabela de avaliações:', error);
  });

  stats.initStats().catch(error => {
    console.error('❌ Falha ao preparar estatísticas:', error);
  });

  tccProjects.initTccProjects().catch(error => {
    console.error('❌ Falha ao preparar projetos de TCC:', error);
  });
});

client.on('error', error => {
  console.error('❌ Erro no cliente Discord:', error);
});

process.on('unhandledRejection', reason => {
  console.error('❌ Unhandled Rejection:', reason);
});

process.on('uncaughtException', error => {
  console.error('❌ Uncaught Exception:', error);
});

// ======================================================
// EMOJIS DAS MATÉRIAS
// ======================================================

function getEmojiForClass(className) {
  const name = className.toLowerCase();

  if (
    name.includes('matematica') ||
    name.includes('cálculo') ||
    name.includes('calculo') ||
    name.includes('math')
  ) return '🧮';

  if (
    name.includes('fisica') ||
    name.includes('física') ||
    name.includes('phys')
  ) return '⏳';

  if (
    name.includes('quimica') ||
    name.includes('química') ||
    name.includes('chem')
  ) return '🧪';

  if (name.includes('biolo')) return '🧬';

  if (
    name.includes('program') ||
    name.includes('web') ||
    name.includes('comput') ||
    name.includes('dev')
  ) return '💻';

  if (name.includes('historia') || name.includes('história')) return '📜';

  if (
    name.includes('portugues') ||
    name.includes('português') ||
    name.includes('literatura') ||
    name.includes('redacao')
  ) return '📚';

  if (name.includes('geografia')) return '🗺️';

  if (
    name.includes('ingles') ||
    name.includes('inglês') ||
    name.includes('english')
  ) return '🇬🇧';

  return '🏫';
}

// ======================================================
// EVENTO PRINCIPAL DE INTERAÇÕES DO DISCORD
// ======================================================

client.on(Events.InteractionCreate, async interaction => {

  // ====================================================
  // 1. MENUS DE MÚLTIPLA ESCOLHA (SELECT MENUS)
  // ====================================================

  if (interaction.isStringSelectMenu()) {
    if (interaction.customId === 'auth_keep_connected_select') {
      const selectedValue = interaction.values[0];
      const enabled = selectedValue === 'sim';

      try {
        const updated = await auth.setKeepConnected(interaction.user.id, enabled);
        if (!updated) {
          return interaction.reply({
            content:
