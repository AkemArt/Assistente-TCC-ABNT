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
    if (interaction.customId === 'iniciar_tcc_modal') {
      const nomeAluno = interaction.fields.getTextInputValue('tcc_aluno').trim();
      const orientador = interaction.fields.getTextInputValue('tcc_orientador').trim();
      const instituicao = interaction.fields.getTextInputValue('tcc_instituicao').trim();
      const curso = interaction.fields.getTextInputValue('tcc_curso').trim();
      const titulo = interaction.fields.getTextInputValue('tcc_titulo').trim();

      await interaction.deferReply({ ephemeral: true });
      try {
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
        const saved = await tccProjects.saveProject(project);
        const documentBuffer = await tccProjects.generateTccDocx(project);

        await stats.recordEvent({
          userId: interaction.user.id,
          username: interaction.user.username,
          guildId: interaction.guildId,
          eventType: 'tcc_started'
        });
        await stats.recordEvent({
          userId: interaction.user.id,
          username: interaction.user.username,
          guildId: interaction.guildId,
          eventType: 'document_generated'
        });

        const resumo = new EmbedBuilder()
          .setTitle('📚 Projeto de TCC salvo e documento criado')
          .setDescription(`Seu projeto foi salvo no banco de dados (projeto nº ${saved.id}) e gerei um modelo Word inicial para você revisar. Ele contém capa, folha de rosto e seções estruturais; ainda não é um TCC pesquisado ou concluído.`)
          .addFields(
            { name: 'Aluno(a)', value: nomeAluno, inline: false },
            { name: 'Orientador(a)', value: orientador, inline: false },
            { name: 'Instituição', value: instituicao, inline: true },
            { name: 'Curso', value: curso, inline: true },
            { name: 'Título provisório', value: titulo, inline: false }
          )
          .setColor('#5865F2')
          .setFooter({ text: 'Assistente de TCC • Modelo inicial para revisão' });

        return interaction.editReply({
          embeds: [resumo],
          files: [{ attachment: documentBuffer, name: `TCC_modelo_${saved.id}.docx` }]
        });
      } catch (error) {
        console.error('❌ Falha ao salvar projeto/gerar documento:', error);
        return interaction.editReply({
          content: '❌ Não consegui salvar o projeto ou gerar o Word. Confira se o bot foi reiniciado após a atualização e se a tabela de projetos foi criada no PostgreSQL. Consulte o terminal para ver o erro.'
        });
      }
    }

    if (interaction.customId === 'vincular_modal') {
      const realName = interaction.fields.getTextInputValue('real_name_input').trim();
      const username = interaction.user.username.toLowerCase();

      try {
        await db.query(
          `INSERT INTO discord_mappings (discord_username, real_name)
           VALUES ($1, $2)
           ON CONFLICT (discord_username) DO UPDATE SET real_name = EXCLUDED.real_name`,
          [username, realName]
        );

        await interaction.reply({
          content: `✅ Conta vinculada com sucesso a **${realName}**!\nDigite o comando \`/presenca\` novamente para registrar sua presença.`,
          ephemeral: true
        });
      } catch (err) {
        console.error(err);
        await interaction.reply({
          content: '❌ Erro ao vincular sua conta.',
          ephemeral: true
        });
      }
    }
    return;
  }

  // 2. Button Handler
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
          `SELECT real_name FROM discord_mappings WHERE LOWER(discord_username) = LOWER($1)`,
          [username]
        );
        if (mappingRes.rowCount === 0) {
          return interaction.reply({
            content: '⚠️ Sua conta ainda não está vinculada. Por favor, digite `/presenca` para vincular primeiro.',
            ephemeral: true
          });
        }

        const mappedName = mappingRes.rows[0].real_name;

        const classRes = await db.query('SELECT name FROM classes WHERE id = $1', [classId]);
        const className = classRes.rowCount > 0 ? classRes.rows[0].name : 'Aula';

        const checkAtt = await db.query(
          `SELECT 1 FROM attendances WHERE class_session_id = $1 AND student_name = $2`,
          [sessionId, mappedName]
        );
        if (checkAtt.rowCount === 0) {
          await db.query(
            `INSERT INTO attendances (class_session_id, class_id, student_name, login_at, student_id) VALUES ($1, $2, $3, NOW(), $4)`,
            [sessionId, classId, mappedName, userId]
          );
        }

        // 💾 salva presença geral na tabela Discord
        await db.query(
          `INSERT INTO presencas (user_id, username, guild_id, data) VALUES ($1, $2, $3, NOW())`,
          [userId, username, guildId]
        );

        const total = await db.query(
          `SELECT COUNT(*) as total FROM presencas WHERE user_id = $1 AND guild_id = $2`,
          [userId, guildId]
        );
        const totalPresencas = total.rows[0].total;

        const embed = new EmbedBuilder()
          .setTitle('✅ Presença Confirmada!')
          .setDescription(`Olá, **${mappedName}**!\nSua presença foi registrada com sucesso na matéria: **${className}**!`)
          .addFields(
            { name: '📅 Matéria', value: className, inline: true },
            { name: '📊 Total no Discord', value: String(totalPresencas), inline: true }
          )
          .setColor('#10B981')
          .setFooter({ text: 'Mercury Class' })
          .setTimestamp();

        await interaction.update({
          embeds: [embed],
          components: [],
          ephemeral: true
        });
      } catch (error) {
        console.error('Erro ao clicar no botão de presença:', error);
        await interaction.reply({
          content: '❌ Erro ao registrar presença na matéria selecionada.',
          ephemeral: true
        });
      }
    } else if (interaction.commandName !== 'chamada') {
      // Allow other buttons like standard check-in links to proceed
    }
  }

  if (!interaction.isChatInputCommand()) return;

  // Registra cada uso de comando. Falha no registro não deve impedir o comando principal.
  stats.recordEvent({
    userId: interaction.user.id,
    username: interaction.user.username,
    guildId: interaction.guildId,
    eventType: 'command',
    commandName: interaction.commandName
  });

  // Geração de rascunho acadêmico com pesquisa de fontes
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
          `🔍 Foram encontradas ${resultado.fontes.length} fontes acadêmicas.\n` +
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

  // Estatísticas: visíveis apenas para administradores do servidor ou usuários com o cargo configurado.
  if (interaction.commandName === 'estatisticas') {
    const allowedRoleId = process.env.STATS_ROLE_ID;
    const isAdmin = interaction.memberPermissions?.has('Administrator');
    const hasAllowedRole = Boolean(allowedRoleId && interaction.member?.roles?.cache?.has(allowedRoleId));
    if (!isAdmin && !hasAllowedRole) {
      return interaction.reply({ content: '🔒 Este comando é restrito à equipe autorizada.', ephemeral: true });
    }

    try {
      const data = await stats.getSummary();
      const t = data.totals;
      const bars = data.commands.length
        ? data.commands.slice(0, 5).map(item => `**/${item.command_name}** — ${item.total} uso(s)`).join('\n')
        : 'Ainda não há comandos registrados.';
      const embed = new EmbedBuilder()
        .setTitle('📊 Estatísticas do Bot TCC')
        .setDescription('Indicadores calculados a partir dos eventos registrados desde a ativação das estatísticas.')
        .addFields(
          { name: '👥 Usuários únicos', value: String(t.unique_users), inline: true },
          { name: '📅 Ativos nas últimas 24h', value: String(t.active_today), inline: true },
          { name: '🗓️ Ativos em 7 dias', value: String(t.active_week), inline: true },
          { name: '📈 Ativos em 30 dias', value: String(t.active_month), inline: true },
          { name: '📚 TCCs iniciados', value: String(t.tccs_started), inline: true },
          { name: '📄 Documentos gerados', value: String(t.documents_generated), inline: true },
          { name: '⌨️ Comandos mais usados', value: bars, inline: false },
          { name: '🌐 Painel web', value: 'Consulte `/admin/tcc-stats` no site quando o servidor web estiver configurado.', inline: false }
        )
        .setColor('#5865F2')
        .setTimestamp();
      return interaction.reply({ embeds: [embed], ephemeral: true });
    } catch (error) {
      console.error('Erro ao montar estatísticas:', error.message);
      return interaction.reply({
        content: 'Não consegui consultar as estatísticas. Confira se o PostgreSQL está configurado e se o bot já inicializou as tabelas.',
        ephemeral: true
      });
    }
  }

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

    const appBaseUrl = (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');
    const chamadaUrl = `${appBaseUrl}/login`;

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setLabel('Abrir Sistema de Chamada')
        .setStyle(ButtonStyle.Link)
        .setURL(chamadaUrl)
    );

    const embed = new EmbedBuilder()
      .setTitle('📋 Sistema de Chamada')
      .setDescription('Clique no botão abaixo para entrar no sistema atual de chamadas.')
      .setColor('#5865F2')
      .setFooter({ text: 'Mercury Class' })
      .setTimestamp();

    return interaction.reply({
      embeds: [embed],
      components: [row],
      ephemeral: true
    });
  }

  if (interaction.commandName === 'presenca') {
    const userId = interaction.user.id;
    const username = interaction.user.username;
    const guildId = interaction.guild.id;

    // 🚫 COOLDOWN (5s)
    if (cooldown.has(userId)) {
      return interaction.reply({
        content: '⏳ Aguarde alguns segundos antes de tentar novamente.',
        ephemeral: true
      });
    }

    cooldown.set(userId, true);
    setTimeout(() => cooldown.delete(userId), 5000);

    try {
      // 🔍 verifica se já marcou hoje no Discord
      const hoje = new Date().toISOString().split('T')[0];
      const check = await db.query(
        `SELECT 1 FROM presencas
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

      // 💾 busca mapeamento para nome real
      const mappingRes = await db.query(
        `SELECT real_name FROM discord_mappings WHERE LOWER(discord_username) = LOWER($1)`,
        [username]
      );

      // CASO A: Aluno NÃO está vinculado ainda -> Exibe o MODAL do Discord
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

        const firstRow = new ActionRowBuilder().addComponents(realNameInput);
        modal.addComponents(firstRow);

        await interaction.showModal(modal);
        return;
      }

      // CASO B: Aluno já vinculado
      const mappedName = mappingRes.rows[0].real_name;

      // Busca todas as sessões de aula ativas
      const activeSessions = await db.query(
        `SELECT cs.id, cs.class_id, c.name AS class_name
         FROM class_sessions cs
         JOIN classes c ON c.id = cs.class_id
         WHERE cs.active = true
         ORDER BY cs.start_time DESC`
      );

      // Sub-Caso 1: Nenhuma aula ativa
      if (activeSessions.rowCount === 0) {
        await db.query(
          `INSERT INTO presencas (user_id, username, guild_id, data) VALUES ($1, $2, $3, NOW())`,
          [userId, username, guildId]
        );

        const total = await db.query(
          `SELECT COUNT(*) as total FROM presencas WHERE user_id = $1 AND guild_id = $2`,
          [userId, guildId]
        );
        const totalPresencas = total.rows[0].total;

        const embed = new EmbedBuilder()
          .setTitle('✅ Presença Registrada')
          .setDescription(`Olá, **${mappedName}**!\nSua presença geral no Discord foi confirmada (nenhuma aula ativa no momento).`)
          .addFields(
            { name: '📅 Hoje', value: 'Confirmada', inline: true },
            { name: '📊 Total', value: String(totalPresencas), inline: true }
          )
          .setColor('#5865F2')
          .setFooter({ text: 'Mercury Class' })
          .setTimestamp();

        return interaction.reply({ embeds: [embed] });
      }

      // Sub-Caso 2: Exatamente uma aula ativa -> registra presença automaticamente
      if (activeSessions.rowCount === 1) {
        const sessionId = activeSessions.rows[0].id;
        const classId = activeSessions.rows[0].class_id;
        const className = activeSessions.rows[0].class_name;

        const checkAtt = await db.query(
          `SELECT 1 FROM attendances WHERE class_session_id = $1 AND student_name = $2`,
          [sessionId, mappedName]
        );
        if (checkAtt.rowCount === 0) {
          await db.query(
            `INSERT INTO attendances (class_session_id, class_id, student_name, login_at, student_id) VALUES ($1, $2, $3, NOW(), $4)`,
            [sessionId, classId, mappedName, userId]
          );
        }

        // 💾 salva presença geral na tabela Discord
        await db.query(
          `INSERT INTO presencas (user_id, username, guild_id, data) VALUES ($1, $2, $3, NOW())`,
          [userId, username, guildId]
        );

        const total = await db.query(
          `SELECT COUNT(*) as total FROM presencas WHERE user_id = $1 AND guild_id = $2`,
          [userId, guildId]
        );
        const totalPresencas = total.rows[0].total;

        const embed = new EmbedBuilder()
          .setTitle('✅ Presença Registrada')
          .setDescription(`Olá, **${mappedName}**!\n📖 **Chamada Escolar:** Presença confirmada na aula ativa de **${className}**!`)
          .addFields(
            { name: '📅 Matéria', value: className, inline: true },
            { name: '📊 Total', value: String(totalPresencas), inline: true }
          )
          .setColor('#5865F2')
          .setFooter({ text: 'Mercury Class' })
          .setTimestamp();

        return interaction.reply({ embeds: [embed] });
      }

      // Sub-Caso 3: Múltiplas aulas ativas -> gera botões interativos para escolha
      const embed = new EmbedBuilder()
        .setTitle('🏫 Escolha sua Aula')
        .setDescription(`Olá, **${mappedName}**!\nIdentificamos mais de uma aula ativa no momento. Clique no botão correspondente para registrar sua presença:`)
        .setColor('#5865F2')
        .setFooter({ text: 'Mercury Class' })
        .setTimestamp();

      const row = new ActionRowBuilder();
      activeSessions.rows.forEach(session => {
        const emoji = getEmojiForClass(session.class_name);
        row.addComponents(
          new ButtonBuilder()
            .setCustomId(`presenca_aula_${session.id}_${session.class_id}`)
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
      console.error(error);
      await interaction.reply({
        content: '❌ Erro ao registrar presença.',
        ephemeral: true
      });
    }
  }
});

client.login(BOT_TOKEN);
