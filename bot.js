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

// ======================================================
// COMANDOS SLASH
// ======================================================

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

// ======================================================
// INICIALIZAÇÃO
// ======================================================

client.once(Events.ClientReady, () => {
  console.log(`🤖 Bot logado como ${client.user.tag}`);

  syncSlashCommands(client);

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
  // 1. ENVIO DE FORMULÁRIOS (MODALS)
  // ====================================================

  if (interaction.isModalSubmit()) {

    if (interaction.customId === 'iniciar_tcc_modal') {
      const nomeAluno = interaction.fields.getTextInputValue('tcc_aluno').trim();
      const orientador = interaction.fields.getTextInputValue('tcc_orientador').trim();
      const instituicao = interaction.fields.getTextInputValue('tcc_instituicao').trim();
      const curso = interaction.fields.getTextInputValue('tcc_curso').trim();
      const titulo = interaction.fields.getTextInputValue('tcc_titulo').trim();

      const totalLabel = `iniciar_tcc_${interaction.user.id}_${Date.now()}`;
      console.time(totalLabel);

      try {
        console.log(`📝 [${totalLabel}] Formulário recebido.`);
        const deferStart = Date.now();

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        console.log(`⏱️ [${totalLabel}] deferReply: ${Date.now() - deferStart}ms`);

        const project = {
          userId: interaction.user.id,
          username: interaction.user.username,
          guildId: interaction.guildId,
          studentName: nomeAluno,
          advisorName: orientador,
          institution: instituicao,
          course: curso,
          title: titulo
        };

        console.time(`${totalLabel}_db_e_docx`);
        const [saved, documentBuffer] = await Promise.all([
          tccProjects.saveProject(project),
          tccProjects.generateTccDocx(project)
        ]);
        console.timeEnd(`${totalLabel}_db_e_docx`);

        const rawBuffer = Buffer.isBuffer(documentBuffer)
          ? documentBuffer
          : Buffer.from(documentBuffer);

        console.log(
          `📦 [${totalLabel}] Projeto salvo: ${saved.id}. ` +
          `Documento gerado: ${rawBuffer.length} bytes.`
        );

        // Registra estatísticas em segundo plano sem bloquear a resposta.
        Promise.allSettled([
          stats.recordEvent({
            userId: interaction.user.id,
            username: interaction.user.username,
            guildId: interaction.guildId,
            eventType: 'tcc_started'
          }),
          stats.recordEvent({
            userId: interaction.user.id,
            username: interaction.user.username,
            guildId: interaction.guildId,
            eventType: 'document_generated'
          })
        ]).catch(error => {
          console.error(`⚠️ [${totalLabel}] Erro nas estatísticas:`, describeError(error));
        });

        const resumo = new EmbedBuilder()
          .setTitle('📚 Projeto de TCC salvo e documento criado')
          .setDescription(
            `Seu projeto foi salvo no banco de dados (projeto nº ${saved.id}) ` +
            'e gerei um modelo Word inicial para você revisar. ' +
            'Ele contém capa, folha de rosto e seções estruturais; ' +
            'ainda não é um TCC pesquisado ou concluído.'
          )
          .addFields(
            { name: 'Aluno(a)', value: nomeAluno, inline: false },
            { name: 'Orientador(a)', value: orientador, inline: false },
            { name: 'Instituição', value: instituicao, inline: true },
            { name: 'Curso', value: curso, inline: true },
            { name: 'Título provisório', value: titulo, inline: false }
          )
          .setColor('#5865F2')
          .setFooter({
            text: 'Assistente de TCC • Modelo inicial para revisão'
          });

        const arquivoWord = new AttachmentBuilder(rawBuffer, {
          name: `TCC_modelo_${saved.id}.docx`
        });

        const envioStart = Date.now();
        console.log(`📤 [${totalLabel}] Enviando confirmação e Word ao Discord...`);

        try {
          await withTimeout(
            interaction.editReply({
              content: '📄 Seu modelo inicial de TCC está pronto!',
              embeds: [resumo],
              files: [arquivoWord]
            }),
            20000,
            `${totalLabel}_editReply_docx`
          );

          console.log(
            `✅ [${totalLabel}] Confirmação e documento enviados em ` +
            `${Date.now() - envioStart}ms.`
          );
        } catch (uploadError) {
          console.error(
            `❌ [${totalLabel}] Falha ao enviar confirmação e Word:`,
            describeError(uploadError)
          );

          // Fallback rápido: envia a confirmação sem o arquivo se o upload falhar ou estourar tempo.
          try {
            await interaction.editReply({
              content:
                `✅ Projeto nº ${saved.id} salvo com sucesso! ` +
                'Não foi possível anexar o arquivo .docx neste envio.',
              embeds: [resumo],
              files: []
            });
          } catch (replyError) {
            console.error(
              `❌ [${totalLabel}] Não foi possível atualizar a resposta:`,
              describeError(replyError)
            );
          }
        }

        console.timeEnd(totalLabel);
        console.log(`🎉 [${totalLabel}] TCC concluído.`);
        return;
      } catch (error) {
        console.error(
          `❌ [${totalLabel}] Falha ao iniciar TCC:`,
          describeError(error),
          error
        );

        try {
          if (interaction.deferred || interaction.replied) {
            await interaction.editReply({
              content:
                '❌ Não consegui concluir a criação do projeto ou do Word. ' +
                'O erro foi registrado nos Logs do Render.',
              embeds: [],
              files: []
            });
          } else {
            await interaction.reply({
              content: '❌ Não consegui iniciar o projeto de TCC. Tente novamente.',
              flags: MessageFlags.Ephemeral
            });
          }
        } catch (replyError) {
          console.error(
            `❌ [${totalLabel}] Não foi possível enviar a mensagem de erro:`,
            describeError(replyError)
          );
        }

        console.timeEnd(totalLabel);
        return;
      }
    }

    if (interaction.customId === 'vincular_modal') {
      const realName = interaction.fields
        .getTextInputValue('real_name_input')
        .trim();

      const username = interaction.user.username.toLowerCase();

      try {
        await db.query(
          `INSERT INTO discord_mappings (discord_username, real_name)
           VALUES ($1, $2)
           ON CONFLICT (discord_username)
           DO UPDATE SET real_name = EXCLUDED.real_name`,
          [username, realName]
        );

        await interaction.reply({
          content:
            `✅ Conta vinculada com sucesso a **${realName}**!\n` +
            'Digite o comando `/presenca` novamente para registrar sua presença.',
          flags: MessageFlags.Ephemeral
        });
      } catch (error) {
        console.error('Erro ao vincular conta:', error);

        await interaction.reply({
          content: '❌ Erro ao vincular sua conta.',
          flags: MessageFlags.Ephemeral
        });
      }
    }

    return;
  }

  // ====================================================
  // 2. BOTÕES DE PRESENÇA
  // ====================================================

  if (interaction.isButton()) {

    if (interaction.customId.startsWith('presenca_aula_')) {
      const parts = interaction.customId.split('_');

      const sessionId = parseInt(parts[2], 10);
      const classId = parseInt(parts[3], 10);

      const userId = interaction.user.id;
      const username = interaction.user.username;
      const guildId = interaction.guild?.id || 'guild_default';

      try {
        const mappingRes = await db.query(
          `SELECT real_name
           FROM discord_mappings
           WHERE LOWER(discord_username) = LOWER($1)`,
          [username]
        );

        if (mappingRes.rowCount === 0) {
          return interaction.reply({
            content:
              '⚠️ Sua conta ainda não está vinculada. ' +
              'Digite `/presenca` para vincular primeiro.',
            flags: MessageFlags.Ephemeral
          });
        }

        const mappedName = mappingRes.rows[0].real_name;

        const classRes = await db.query(
          'SELECT name FROM classes WHERE id = $1',
          [classId]
        );

        const className = classRes.rowCount > 0
          ? classRes.rows[0].name
          : 'Aula';

        const checkAtt = await db.query(
          `SELECT 1
           FROM attendances
           WHERE class_session_id = $1
           AND student_name = $2`,
          [sessionId, mappedName]
        );

        if (checkAtt.rowCount === 0) {
          await db.query(
            `INSERT INTO attendances
             (class_session_id, class_id, student_name, login_at, student_id)
             VALUES ($1, $2, $3, NOW(), $4)`,
            [sessionId, classId, mappedName, userId]
          );
        }

        await db.query(
          `INSERT INTO presencas (user_id, username, guild_id, data)
           VALUES ($1, $2, $3, NOW())`,
          [userId, username, guildId]
        );

        const total = await db.query(
          `SELECT COUNT(*) AS total
           FROM presencas
           WHERE user_id = $1 AND guild_id = $2`,
          [userId, guildId]
        );

        const totalPresencas = total.rows[0].total;

        const embed = new EmbedBuilder()
          .setTitle('✅ Presença Confirmada!')
          .setDescription(
            `Olá, **${mappedName}**!\n` +
            `Sua presença foi registrada na matéria: **${className}**!`
          )
          .addFields(
            { name: '📅 Matéria', value: className, inline: true },
            { name: '📊 Total no Discord', value: String(totalPresencas), inline: true }
          )
          .setColor('#10B981')
          .setFooter({ text: 'Mercury Class' })
          .setTimestamp();

        await interaction.update({
          embeds: [embed],
          components: []
        });
      } catch (error) {
        console.error('Erro ao clicar no botão de presença:', error);

        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({
            content: '❌ Erro ao registrar presença na matéria selecionada.',
            flags: MessageFlags.Ephemeral
          });
        }
      }
    }

    return;
  }

  // ====================================================
  // 3. COMANDOS SLASH
  // ====================================================

  if (!interaction.isChatInputCommand()) return;

  stats.recordEvent({
    userId: interaction.user.id,
    username: interaction.user.username,
    guildId: interaction.guildId,
    eventType: 'command',
    commandName: interaction.commandName
  }).catch(error => {
    console.error('⚠️ Falha ao registrar uso do comando:', describeError(error));
  });

  if (interaction.commandName === 'rascunho_tcc') {
    const tema = interaction.options.getString('tema');
    const objetivo = interaction.options.getString('objetivo') || '';

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const resultado = await gerarRascunhoComPesquisa({
        tema,
        objetivo,
        limite: 5
      });

      const arquivo = new AttachmentBuilder(
        Buffer.from(resultado.texto || 'A IA não retornou texto.', 'utf8'),
        { name: 'rascunho_tcc.txt' }
      );

      stats.recordEvent({
        userId: interaction.user.id,
        username: interaction.user.username,
        guildId: interaction.guildId,
        eventType: 'ai_draft_generated'
      }).catch(() => {});

      return interaction.editReply({
        content:
          '📚 **Seu rascunho acadêmico está pronto!**\n'
