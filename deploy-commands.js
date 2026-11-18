
const { REST, Routes, SlashCommandBuilder } = require('discord.js');
require('dotenv').config();

const commands = [
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
    .setDescription('Gerar um rascunho acadêmico com inteligência artificial')
    .addStringOption(option =>
      option
        .setName('tema')
        .setDescription('Tema do seu TCC')
        .setRequired(true)
    )
    .addStringOption(option =>
      option
        .setName('objetivo')
        .setDescription('Objetivo principal do trabalho')
        .setRequired(false)
    )
].map(cmd => cmd.toJSON());

const rest = new REST({ version: '10' }).setToken(
  process.env.TOKEN || process.env.DISCORD_TOKEN
);

(async () => {
  try {
    console.log('Registrando comandos...');

    if (process.env.GUILD_ID) {
      await rest.put(
        Routes.applicationGuildCommands(
          process.env.CLIENT_ID,
          process.env.GUILD_ID
        ),
        { body: commands }
      );

      console.log('Comandos registrados no servidor!');
    } else {
      await rest.put(
        Routes.applicationCommands(process.env.CLIENT_ID),
        { body: commands }
      );

      console.log('Comandos globais registrados!');
    }
  } catch (err) {
    console.error('Erro ao registrar comandos:', err);
  }
})();
