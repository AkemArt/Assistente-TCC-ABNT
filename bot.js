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
// IMPORTANTE: esta função precisa ser async para permitir await.
// ======================================================

client.on(Events.InteractionCreate, async interaction => {

  // ====================================================
  // 1. ENVIO DE FORMULÁRIOS (MODALS)
  // ====================================================

  if (interaction.isModalSubmit()) {

    // ----------------------------------------------
    // FORMULÁRIO DE INÍCIO DO TCC
    // ----------------------------------------------

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

        await interaction.deferReply({ ephemeral: true });

        console.log(
          `⏱️ [${totalLabel}] deferReply: ${Date.now() - deferStart}ms`
        );

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

        // Salva o projeto e gera o documento Word em paralelo.
        console.time(`${totalLabel}_db_e_docx`);

        const [saved, documentBuffer] = await Promise.all([
          tccProjects.saveProject(project),
          tccProjects.generateTccDocx(project)
        ]);

        console.timeEnd(`${totalLabel}_db_e_docx`);

        console.log(
          `📦 [${totalLabel}] Projeto salvo: ${saved.id}. ` +
          `Documento gerado: ${documentBuffer?.length || 0} bytes.`
        );

        // Estatísticas não devem bloquear a entrega do documento.
        Promise.all([
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
          console.error(
            `⚠️ [${totalLabel}] Erro nas estatísticas:`,
            describeError(error)
          );
        });

        // Monta a confirmação do projeto.
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

        // Primeiro envia a confirmação.
        const respostaStart = Date.now();

        console.log(`📨 [${totalLabel}] Enviando confirmação ao Discord...`);

        await interaction.editReply({
          embeds: [resumo],
          content: ''
        });

        console.log(
          `✅ [${totalLabel}] Confirmação enviada em ` +
          `${Date.now() - respostaStart}ms.`
        );

        // Depois envia o arquivo Word.
        const envioStart = Date.now();

        console.log(`📤 [${totalLabel}] Enviando documento Word...`);

        try {
          await interaction.followUp({
            content: '📄 Seu modelo inicial de TCC está pronto:',
            files: [
              {
                attachment: documentBuffer,
                name: `TCC_modelo_${saved.id}.docx`
              }
            ],
            ephemeral: true
          });

          console.log(
            `✅ [${totalLabel}] Documento enviado em ` +
            `${Date.now() - envioStart}ms.`
          );

        } catch (uploadError) {
          console.error(
            `❌ [${totalLabel}] Erro ao enviar o Word:`,
            describeError(uploadError)
          );

          try {
            await interaction.editReply({
              content:
                '✅ Seu projeto foi salvo, mas o Discord não conseguiu ' +
                'entregar o arquivo Word. Tente novamente ou avise a equipe.',
              embeds: []
            });
          } catch (replyError) {
            console.error(
              `❌ [${totalLabel}] Erro ao atualizar a confirmação:`,
              describeError(replyError)
            );
          }

          console.timeEnd(totalLabel);
          return;
        }

        console.timeEnd(totalLabel);

        console.log(`🎉 [${totalLabel}] TCC concluído com sucesso.`);

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
              embeds: []
            });
          } else {
            await interaction.reply({
              content: '❌ Não consegui iniciar o projeto de TCC. Tente novamente.',
              ephemeral: true
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

    // ----------------------------------------------
    // FORMULÁRIO DE VINCULAÇÃO DE CONTA
    // ----------------------------------------------

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
          ephemeral: true
        });

      } catch (error) {
        console.error('Erro ao vincular conta:', error);

        await interaction.reply({
          content: '❌ Erro ao vincular sua conta.',
          ephemeral: true
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
            ephemeral: true
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
            ephemeral: true
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

  // Registro de uso dos comandos sem bloquear a execução.
  stats.recordEvent({
    userId: interaction.user.id,
    username: interaction.user.username,
    guildId: interaction.guildId,
    eventType: 'command',
    commandName: interaction.commandName
  }).catch(error => {
    console.error(
      '⚠️ Falha ao registrar uso do comando:',
      describeError(error)
    );
  });

  // ====================================================
  // COMANDO /RASCUNHO_TCC
  // ====================================================

  if (interaction.commandName === 'rascunho_tcc') {
    const tema = interaction.options.getString('tema');
    const objetivo = interaction.options.getString('objetivo') || '';

    await interaction.deferReply({ ephemeral: true });

    try {
      const resultado = await gerarRascunhoComPesquisa({
        tema,
        objetivo,
        limite: 5
      });

      const arquivo = Buffer.from(
        resultado.texto || 'A IA não retornou texto.',
        'utf8'
      );

      await stats.recordEvent({
        userId: interaction.user.id,
        username: interaction.user.username,
        guildId: interaction.guildId,
        eventType: 'ai_draft_generated'
      });

      return interaction.editReply({
        content:
          '📚 **Seu rascunho acadêmico está pronto!**\n' +
          `🔍 Foram encontradas ${(resultado.fontes || []).length} fontes acadêmicas.\n` +
          'Confira os títulos, autores e links; leia as fontes antes de utilizar as informações no TCC e revise o texto com seu orientador.',
        files: [
          {
            attachment: arquivo,
            name: 'rascunho_tcc.txt'
          }
        ]
      });

    } catch (error) {
      console.error('Erro ao gerar rascunho com pesquisa acadêmica:', error);

      return interaction.editReply({
        content:
          '❌ Não foi possível gerar o rascunho ou pesquisar as fontes. ' +
          'Tente novamente em alguns minutos ou use um tema diferente.'
      });
    }
  }

  // ====================================================
  // COMANDO /ESTATISTICAS
  // ====================================================

  if (interaction.commandName === 'estatisticas') {
    const allowedRoleId = process.env.STATS_ROLE_ID;

    const isAdmin = interaction.memberPermissions?.has('Administrator');

    const hasAllowedRole = Boolean(
      allowedRoleId &&
      interaction.member?.roles?.cache?.has(allowedRoleId)
    );

    if (!isAdmin && !hasAllowedRole) {
      return interaction.reply({
        content: '🔒 Este comando é restrito à equipe autorizada.',
        ephemeral: true
      });
    }

    try {
      const data = await stats.getSummary();
      const totals = data.totals;

      const bars = data.commands.length
        ? data.commands
            .slice(0, 5)
            .map(item => `**/${item.command_name}** — ${item.total} uso(s)`)
            .join('\n')
        : 'Ainda não há comandos registrados.';

      const embed = new EmbedBuilder()
        .setTitle('📊 Estatísticas do Bot TCC')
        .setDescription(
          'Indicadores calculados a partir dos eventos registrados desde a ativação das estatísticas.'
        )
        .addFields(
          { name: '👥 Usuários únicos', value: String(totals.unique_users), inline: true },
          { name: '📅 Ativos nas últimas 24h', value: String(totals.active_today), inline: true },
          { name: '🗓️ Ativos em 7 dias', value: String(totals.active_week), inline: true },
          { name: '📈 Ativos em 30 dias', value: String(totals.active_month), inline: true },
          { name: '📚 TCCs iniciados', value: String(totals.tccs_started), inline: true },
          { name: '📄 Documentos gerados', value: String(totals.documents_generated), inline: true },
          { name: '⌨️ Comandos mais usados', value: bars, inline: false },
          {
            name: '🌐 Painel web',
            value: 'Consulte `/admin/tcc-stats` no site quando o servidor web estiver configurado.',
            inline: false
          }
        )
        .setColor('#5865F2')
        .setTimestamp();

      return interaction.reply({
        embeds: [embed],
        ephemeral: true
      });

    } catch (error) {
      console.error('Erro ao montar estatísticas:', error);

      return interaction.reply({
        content:
          'Não consegui consultar as estatísticas. Confira se o PostgreSQL está configurado e se o bot já inicializou as tabelas.',
        ephemeral: true
      });
    }
  }

  // ====================================================
  // COMANDO /INICIAR_TCC
  // ====================================================

  if (interaction.commandName === 'iniciar_tcc') {
    const modal = new ModalBuilder()
      .setCustomId('iniciar_tcc_modal')
      .setTitle('Novo projeto de TCC');

    const aluno = new TextInputBuilder()
      .setCustomId('tcc_aluno')
      .setLabel('Nome completo do aluno')
      .setStyle(TextInputStyle.Short)
      .setMinLength(3)
      .setMaxLength(100)
      .setRequired(true);

    const orientador = new TextInputBuilder()
      .setCustomId('tcc_orientador')
      .setLabel('Nome do professor orientador')
      .setStyle(TextInputStyle.Short)
      .setMinLength(3)
      .setMaxLength(100)
      .setRequired(true);

    const instituicao = new TextInputBuilder()
      .setCustomId('tcc_instituicao')
      .setLabel('Instituição de ensino')
      .setStyle(TextInputStyle.Short)
      .setMinLength(2)
      .setMaxLength(120)
      .setRequired(true);

    const curso = new TextInputBuilder()
      .setCustomId('tcc_curso')
      .setLabel('Curso')
      .setStyle(TextInputStyle.Short)
      .setMinLength(2)
      .setMaxLength(100)
      .setRequired(true);

    const titulo = new TextInputBuilder()
      .setCustomId('tcc_titulo')
      .setLabel('Título provisório do trabalho')
      .setStyle(TextInputStyle.Paragraph)
      .setMinLength(5)
      .setMaxLength(250)
      .setRequired(true);

    modal.addComponents(
      new ActionRowBuilder().addComponents(aluno),
      new ActionRowBuilder().addComponents(orientador),
      new ActionRowBuilder().addComponents(instituicao),
      new ActionRowBuilder().addComponents(curso),
      new ActionRowBuilder().addComponents(titulo)
    );

    return interaction.showModal(modal);
  }

  // ====================================================
  // COMANDO /CHAMADA
  // ====================================================

  if (interaction.commandName === 'chamada') {
    if (!interaction.inGuild()) {
      return interaction.reply({
        content: '⚠️ Este comando só pode ser usado dentro do servidor.',
        ephemeral: true
      });
    }

    const roles = interaction.member?.roles?.cache;

    const alunoRoleId = process.env.ALUNO_ROLE_ID;
    const professorRoleId = process.env.PROFESSOR_ROLE_ID;

    if (alunoRoleId && professorRoleId && roles) {
      const isAluno = roles.has(alunoRoleId);
      const isProfessor = roles.has(professorRoleId);
      const isAdmin = interaction.memberPermissions?.has('Administrator');

      if (!isAluno && !isProfessor && !isAdmin) {
        return interaction.reply({
          content: '⛔ Apenas aluno, professor ou admin podem usar este comando.',
          ephemeral: true
        });
      }
    }

    const appBaseUrl = (
      process.env.APP_URL || 'http://localhost:3000'
    ).replace(/\/$/, '');

    const chamadaUrl = `${appBaseUrl}/login`;

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setLabel('Abrir Sistema de Chamada')
        .setStyle(ButtonStyle.Link)
        .setURL(chamadaUrl)
    );

    const embed = new EmbedBuilder()
      .setTitle('📋 Sistema de Chamada')
      .setDescription(
        'Clique no botão abaixo para entrar no sistema atual de chamadas.'
      )
      .setColor('#5865F2')
      .setFooter({ text: 'Mercury Class' })
      .setTimestamp();

    return interaction.reply({
      embeds: [embed],
      components: [row],
      ephemeral: true
    });
  }

  // ====================================================
  // COMANDO /PRESENCA
  // ====================================================

  if (interaction.commandName === 'presenca') {
    const userId = interaction.user.id;
    const username = interaction.user.username;
    const guildId = interaction.guild.id;

    // Cooldown de cinco segundos.
    if (cooldown.has(userId)) {
      return interaction.reply({
        content: '⏳ Aguarde alguns segundos antes de tentar novamente.',
        ephemeral: true
      });
    }

    cooldown.set(userId, true);

    setTimeout(() => {
      cooldown.delete(userId);
    }, 5000);

    try {
      // Verifica se já marcou presença hoje.
      const hoje = new Date().toISOString().split('T')[0];

      const check = await db.query(
        `SELECT 1
         FROM presencas
         WHERE user_id = $1
         AND guild_id = $2
         AND data::date = $3`,
        [userId, guildId, hoje]
      );

      if (check.rows.length > 0) {
        return interaction.reply({
          content: '⚠️ Você já marcou presença hoje!',
          ephemeral: true
        });
      }

      // Busca o nome real vinculado à conta.
      const mappingRes = await db.query(
        `SELECT real_name
         FROM discord_mappings
         WHERE LOWER(discord_username) = LOWER($1)`,
        [username]
      );

      // Se não estiver vinculado, abre o formulário.
      if (mappingRes.rowCount === 0) {
        const modal = new ModalBuilder()
          .setCustomId('vincular_modal')
          .setTitle('👾 Vincular Conta | Mercury Class');

        const realNameInput = new TextInputBuilder()
          .setCustomId('real_name_input')
          .setLabel('Seu Nome Completo (como na chamada)')
          .setStyle(TextInputStyle.Short)
          .setMinLength(3)
          .setMaxLength(100)
          .setRequired(true)
          .setPlaceholder('Ex: Ygor Belarmino da silva');

        modal.addComponents(
          new ActionRowBuilder().addComponents(realNameInput)
        );

        return interaction.showModal(modal);
      }

      const mappedName = mappingRes.rows[0].real_name;

      // Busca sessões de aula ativas.
      const activeSessions = await db.query(
        `SELECT cs.id, cs.class_id, c.name AS class_name
         FROM class_sessions cs
         JOIN classes c ON c.id = cs.class_id
         WHERE cs.active = true
         ORDER BY cs.start_time DESC`
      );

      // Nenhuma aula ativa.
      if (activeSessions.rowCount === 0) {
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
          .setTitle('✅ Presença Registrada')
          .setDescription(
            `Olá, **${mappedName}**!\n` +
            'Sua presença geral no Discord foi confirmada (nenhuma aula ativa no momento).'
          )
          .addFields(
            { name: '📅 Hoje', value: 'Confirmada', inline: true },
            { name: '📊 Total', value: String(totalPresencas), inline: true }
          )
          .setColor('#5865F2')
          .setFooter({ text: 'Mercury Class' })
          .setTimestamp();

        return interaction.reply({
          embeds: [embed]
        });
      }

      // Apenas uma aula ativa: registra automaticamente.
      if (activeSessions.rowCount === 1) {
        const sessionId = activeSessions.rows[0].id;
        const classId = activeSessions.rows[0].class_id;
        const className = activeSessions.rows[0].class_name;

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
          .setTitle('✅ Presença Registrada')
          .setDescription(
            `Olá, **${mappedName}**!\n` +
            `📖 **Chamada Escolar:** Presença confirmada na aula ativa de **${className}**!`
          )
          .addFields(
            { name: '📅 Matéria', value: className, inline: true },
            { name: '📊 Total', value: String(totalPresencas), inline: true }
          )
          .setColor('#5865F2')
          .setFooter({ text: 'Mercury Class' })
          .setTimestamp();

        return interaction.reply({
          embeds: [embed]
        });
      }

      // Mais de uma aula ativa: apresenta botões para escolha.
      const embed = new EmbedBuilder()
        .setTitle('🏫 Escolha sua Aula')
        .setDescription(
          `Olá, **${mappedName}**!\n` +
          'Identificamos mais de uma aula ativa no momento. ' +
          'Clique no botão correspondente para registrar sua presença:'
        )
        .setColor('#5865F2')
        .setFooter({ text: 'Mercury Class' })
        .setTimestamp();

      const row = new ActionRowBuilder();

      activeSessions.rows.forEach(session => {
        const emoji = getEmojiForClass(session.class_name);

        row.addComponents(
          new ButtonBuilder()
            .setCustomId(
              `presenca_aula_${session.id}_${session.class_id}`
            )
            .setLabel(`${emoji} ${session.class_name}`)
            .setStyle(ButtonStyle.Primary)
        );
      });

      return interaction.reply({
        embeds: [embed],
        components: [row],
        ephemeral: true
      });

    } catch (error) {
      console.error('Erro ao registrar presença:', error);

      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          content: '❌ Erro ao registrar presença.',
          ephemeral: true
        });
      }
    }
  }
});

// ======================================================
// LOGIN DO BOT
// ======================================================

client.login(BOT_TOKEN).catch(error => {
  console.error('❌ Não foi possível conectar o bot ao Discord:', error);
});

// ======================================================
// SERVIDOR HTTP PARA O RENDER
// ======================================================

const PORT = process.env.PORT || 3000;

http.createServer((req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8'
  });

  res.end('Bot online');
}).listen(PORT, () => {
  console.log(`🌐 Servidor HTTP de health-check rodando na porta ${PORT}`);
});
