require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  Events,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
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
const { gerarRascunhoComPesquisa } = require('./ia-tcc');

console.log('🚀 Iniciando bot Discord...');

const BOT_TOKEN = process.env.TOKEN || process.env.DISCORD_TOKEN;
if (!BOT_TOKEN) {
  console.error('❌ TOKEN/DISCORD_TOKEN não configurado. O bot não pode iniciar.');
  process.exit(1);
}

if (!process.env.DATABASE_URL) {
  console.warn('⚠️ DATABASE_URL não configurado. O comando /presenca pode falhar.');
}

// 🔥 cria cliente
const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

// 🧠 cooldown em memória
const cooldown = new Map();

// Exibe detalhes úteis de erros do Discord/Node nos logs do Render.
function describeError(error) {
  return {
    message: error?.message || String(error),
    code: error?.code,
    status: error?.status,
    method: error?.method,
    url: error?.url
  };
}

function getSlashCommands() {
  return [
    new SlashCommandBuilder()
      .setName('presenca')
      .setDescription('Registrar presença'),

    new SlashCommandBuilder()
      .setName('chamada')
      .setDescription('Abrir o sistema atual de chamada'),

    new SlashCommandBuilder()
      .setName('iniciar_tcc')
      .setDescription('Iniciar um novo projeto de TCC'),

    new SlashCommandBuilder()
      .setName('estatisticas')
      .setDescription('Ver estatísticas de uso do bot de TCC'),

    new SlashCommandBuilder()
      .setName('rascunho_tcc')
      .setDescription('Gerar um rascunho acadêmico com IA')
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
  ].map(cmd => cmd.toJSON());
}

async function syncSlashCommands(client) {
  const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
  const commands = getSlashCommands();
  const appId = process.env.CLIENT_ID || client.user?.id;

  if (!appId) {
    console.warn('⚠️ CLIENT_ID não encontrado; não foi possível sincronizar slash commands.');
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
      console.log('✅ Slash commands globais sincronizados (pode levar alguns minutos para aparecer).');
    }
  } catch (err) {
    console.error('❌ Erro ao sincronizar slash commands:', err);
  }
}

client.once(Events.ClientReady, () => {
  console.log(`🤖 Bot logado como ${client.user.tag}`);
  syncSlashCommands(client);
  stats.initStats().catch(error => console.error('❌ Falha ao preparar estatísticas:', error.message));
  tccProjects.initTccProjects().catch(error => console.error('❌ Falha ao preparar projetos de TCC:', error.message));
});

client.on('error', (error) => {
  console.error('❌ Erro no cliente Discord:', error);
});

process.on('unhandledRejection', (reason) => {
  console.error('❌ Unhandled Rejection:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
});

function getEmojiForClass(className) {
  const name = className.toLowerCase();
  if (name.includes('matematica') || name.includes('cálculo') || name.includes('calculo') || name.includes('math')) return '🧮';
  if (name.includes('fisica') || name.includes('física') || name.includes('phys')) return '⏳';
  if (name.includes('quimica') || name.includes('química') || name.includes('chem')) return '🧪';
  if (name.includes('biolo')) return '🧬';
  if (name.includes('program') || name.includes('web') || name.includes('comput') || name.includes('dev')) return '💻';
  if (name.includes('historia') || name.includes('história')) return '📜';
  if (name.includes('portugues') || name.includes('português') || name.includes('literatura') || name.includes('redacao')) return '📚';
  if (name.includes('geografia')) return '🗺️';
  if (name.includes('ingles') || name.includes('inglês') || name.includes('english')) return '🇬🇧';
  return '🏫';
}

client.on(Events.InteractionCreate, async (interaction) => {
  // 1. Modal Submit Handler
  if (interaction.isModalSubmit()) {
