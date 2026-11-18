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
console.log('ðŸš€ Iniciando bot Discord...');

const BOT_TOKEN = process.env.TOKEN || process.env.DISCORD_TOKEN;
if (!BOT_TOKEN) {
  console.error('âŒ TOKEN/DISCORD_TOKEN nÃ£o configurado. O bot nÃ£o pode iniciar.');
  process.exit(1);
}

if (!process.env.DATABASE_URL) {
  console.warn('âš ï¸ DATABASE_URL nÃ£o configurado. O comando /presenca pode falhar.');
}

// ðŸ”¥ cria cliente
const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

// ðŸ§  cooldown em memÃ³ria
const cooldown = new Map();


function getSlashCommands() {
  return [
    new SlashCommandBuilder()
      .setName('presenca')
      .setDescription('Registrar presenÃ§a'),

    new SlashCommandBuilder()
      .setName('chamada')
      .setDescription('Abrir o sistema atual de chamada'),

    new SlashCommandBuilder()
      .setName('iniciar_tcc')
      .setDescription('Iniciar um novo projeto de TCC'),

    new SlashCommandBuilder()
      .setName('estatisticas')
      .setDescription('Ver estatÃ­sticas de uso do bot de TCC'),

    new SlashCommandBuilder()
      .setName('rascunho_tcc')
      .setDescription('Gerar um rascunho acadÃªmico com IA')
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
    console.warn('âš ï¸ CLIENT_ID nÃ£o encontrado; nÃ£o foi possÃ­vel sincronizar slash commands.');
    return;
  }

  try {
    if (process.env.GUILD_ID) {
      await rest.put(
        Routes.applicationGuildCommands(appId, process.env.GUILD_ID),
        { body: commands }
      );
      console.log(`âœ… Slash commands sincronizados na guild ${process.env.GUILD_ID}.`);
    } else {
      await rest.put(
        Routes.applicationCommands(appId),
        { body: commands }
      );
      console.log('âœ… Slash commands globais sincronizados (pode levar alguns minutos para aparecer).');
    }
  } catch (err) {
    console.error('âŒ Erro ao sincronizar slash commands:', err);
  }
}

client.once(Events.ClientReady, () => {
  console.log(`ðŸ¤– Bot logado como ${client.user.tag}`);
  syncSlashCommands(client);
  stats.initStats().catch(error => console.error('âŒ Falha ao preparar estatÃ­sticas:', error.message));
  tccProjects.initTccProjects().catch(error => console.error('âŒ Falha ao preparar projetos de TCC:', error.message));
});

client.on('error', (error) => {
  console.error('âŒ Erro no cliente Discord:', error);
});

process.on('unhandledRejection', (reason) => {
  console.error('âŒ Unhandled Rejection:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('âŒ Uncaught Exception:', error);
});

function getEmojiForClass(className) {
  const name = className.toLowerCase();
  if (name.includes('matematica') || name.includes('cÃ¡lculo') || name.includes('calculo') || name.includes('math')) return 'ðŸ§®';
  if (name.includes('fisica') || name.includes('fÃ­sica') || name.includes('phys')) return 'â³';
  if (name.includes('quimica') || name.includes('quÃ­mica') || name.includes('chem')) return 'ðŸ§ª';
  if (name.includes('biolo')) return 'ðŸ§¬';
  if (name.includes('program') || name.includes('web') || name.includes('comput') || name.includes('dev')) return 'ðŸ’»';
  if (name.includes('historia') || name.includes('histÃ³ria')) return 'ðŸ“œ';
  if (name.includes('portugues') || name.includes('portuguÃªs') || name.includes('literatura') || name.includes('redacao')) return 'ðŸ“š';
  if (name.includes('geografia')) return 'ðŸ—ºï¸';
  if (name.includes('ingles') || name.includes('inglÃªs') || name.includes('english')) return 'ðŸ‡¬ðŸ‡§';
  return 'ðŸ«';
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
        const project = { userId: interaction.user.id, username: interaction.user.username,
          guildId: interaction.guildId, studentName: nomeAluno, advisorName: orientador,
          institution: instituicao, course: curso, title: titulo };
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
          .setTitle('ðŸ“š Projeto de TCC salvo e documento criado')
          .setDescription(`Seu projeto foi salvo no banco de dados (projeto nÂº ${saved.id}) e gerei um modelo Word inicial para vocÃª revisar. Ele contÃ©m capa, folha de rosto e seÃ§Ãµes estruturais; ainda nÃ£o Ã© um TCC pesquisado ou concluÃ­do.`)
          .addFields(
            { name: 'Aluno(a)', value: nomeAluno, inline: false },
            { name: 'Orientador(a)', value: orientador, inline: false },
            { name: 'InstituiÃ§Ã£o', value: instituicao, inline: true },
            { name: 'Curso', value: curso, inline: true },
            { name: 'TÃ­tulo provisÃ³rio', value: titulo, inline: false }
          )
          .setColor('#5865F2')
          .setFooter({ text: 'Assistente de TCC â€¢ Modelo inicial para revisÃ£o' });

        return interaction.editReply({ embeds: [resumo], files: [{ attachment: documentBuffer, name: `TCC_modelo_${saved.id}.docx` }] });
      } catch (error) {
        console.error('âŒ Falha ao salvar projeto/gerar documento:', error);
        return interaction.editReply({ content: 'âŒ NÃ£o consegui salvar o projeto ou gerar o Word. Confira se o bot foi reiniciado apÃ³s a atualizaÃ§Ã£o e se a tabela de projetos foi criada no PostgreSQL. Consulte o terminal para ver o erro.' });
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
          content: `âœ… Conta vinculada com sucesso a **${realName}**!\nDigite o comando `/presenca` novamente para registrar sua presenÃ§a.`,
          ephemeral: true
        });
      } catch (err) {
        console.error(err);
        await interaction.reply({
          content: 'âŒ Erro ao vincular sua conta.',
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
        // Busca mapeamento
        const mappingRes = await db.query(
          `SELECT real_name FROM discord_mappings WHERE LOWER(discord_username) = LOWER($1)`,
          [username]
        );
        if (mappingRes.rowCount === 0) {
          return interaction.reply({
            content: 'âš ï¸ Sua conta ainda nÃ£o estÃ¡ vinculada. Por favor, digite `/presenca` para vincular primeiro.',
            ephemeral: true
          });
        }

        const mappedName = mappingRes.rows[0].real_name;

        // Busca nome da sala
        const classRes = await db.query('SELECT name FROM classes WHERE id = $1', [classId]);
        const className = classRes.rowCount > 0 ? classRes.rows[0].name : 'Aula';

        // Registra presenÃ§a na chamada oficial
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

        // ðŸ’¾ salva presenÃ§a geral na tabela Discord
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
          .setTitle('âœ… PresenÃ§a Confirmada!')
          .setDescription(`OlÃ¡, **${mappedName}**!\nSua presenÃ§a foi registrada com sucesso na matÃ©ria: **${className}**!`)
          .addFields(
            { name: 'ðŸ“… MatÃ©ria', value: className, inline: true },
            { name: 'ðŸ“Š Total no Discord', value: String(totalPresencas), inline: true }
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
        console.error('Erro ao clicar no botÃ£o de presenÃ§a:', error);
        await interaction.reply({
          content: 'âŒ Erro ao registrar presenÃ§a na matÃ©ria selecionada.',
          ephemeral: true
        });
      }
    } else if (interaction.commandName !== 'chamada') {
      // Allow other buttons like standard check-in links to proceed
    }
  }

  if (!interaction.isChatInputCommand()) return;

  // Registra cada uso de comando. Falha no registro nÃ£o deve impedir o comando principal.
  stats.recordEvent({
    userId: interaction.user.id,
    username: interaction.user.username,
    guildId: interaction.guildId,
    eventType: 'command',
    commandName: interaction.commandName
  });



  // GeraÃ§Ã£o de rascunho acadÃªmico com pesquisa de fontes
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
        resultado.texto || 'A IA nÃ£o retornou texto.',
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
          'ðŸ“š **Seu rascunho acadÃªmico estÃ¡ pronto!**\n' +
          `ðŸ”Ž Foram encontradas ${resultado.fontes.length} fontes acadÃªmicas.\n` +
          'Confira os tÃ­tulos, autores e links; leia as fontes antes de utilizar as informaÃ§Ãµes no TCC e revise o texto com seu orientador.',
        files: [
          {
            attachment: arquivo,
            name: 'rascunho_tcc.txt'
          }
        ]
      });
    } catch (error) {
      console.error('Erro ao gerar rascunho com pesquisa acadÃªmica:', error);

      return interaction.editReply({
        content:
          'âŒ NÃ£o foi possÃ­vel gerar o rascunho ou pesquisar as fontes. ' +
          'Tente novamente em alguns minutos ou use um tema diferente.'
      });
    }
  }



  // EstatÃ­sticas: visÃ­veis apenas para administradores do servidor ou usuÃ¡rios com o cargo configurado.
  if (interaction.commandName === 'estatisticas') {
    const allowedRoleId = process.env.STATS_ROLE_ID;
    const isAdmin = interaction.memberPermissions?.has('Administrator');
    const hasAllowedRole = Boolean(allowedRoleId && interaction.member?.roles?.cache?.has(allowedRoleId));
    if (!isAdmin && !hasAllowedRole) {
      return interaction.reply({ content: 'ðŸ”’ Este comando Ã© restrito Ã  equipe autorizada.', ephemeral: true });
    }

    try {
      const data = await stats.getSummary();
      const t = data.totals;
      const bars = data.commands.length
        ? data.commands.slice(0, 5).map(item => `**/${item.command_name}** â€” ${item.total} uso(s)`).join('\n')
        : 'Ainda nÃ£o hÃ¡ comandos registrados.';
      const embed = new EmbedBuilder()
        .setTitle('ðŸ“Š EstatÃ­sticas do Bot TCC')
        .setDescription('Indicadores calculados a partir dos eventos registrados desde a ativaÃ§Ã£o das estatÃ­sticas.')
        .addFields(
          { name: 'ðŸ‘¥ UsuÃ¡rios Ãºnicos', value: String(t.unique_users), inline: true },
          { name: 'ðŸ“… Ativos nas Ãºltimas 24h', value: String(t.active_today), inline: true },
          { name: 'ðŸ—“ï¸ Ativos em 7 dias', value: String(t.active_week), inline: true },
          { name: 'ðŸ“ˆ Ativos em 30 dias', value: String(t.active_month), inline: true },
          { name: 'ðŸ“š TCCs iniciados', value: String(t.tccs_started), inline: true },
          { name: 'ðŸ“„ Documentos gerados', value: String(t.documents_generated), inline: true },
          { name: 'âŒ¨ï¸ Comandos mais usados', value: bars, inline: false },
          { name: 'ðŸŒ Painel web', value: 'Consulte `/admin/tcc-stats` no site quando o servidor web estiver configurado.', inline: false }
        )
        .setColor('#5865F2')
        .setTimestamp();
      return interaction.reply({ embeds: [embed], ephemeral: true });
    } catch (error) {
      console.error('Erro ao montar estatÃ­sticas:', error.message);
      return interaction.reply({ content: 'NÃ£o consegui consultar as estatÃ­sticas. Confira se o PostgreSQL estÃ¡ configurado e se o bot jÃ¡ inicializou as tabelas.', ephemeral: true });
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
      .setLabel('InstituiÃ§Ã£o de ensino')
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
      .setLabel('TÃ­tulo provisÃ³rio do trabalho')
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
        content: 'âš ï¸ Este comando sÃ³ pode ser usado dentro do servidor.',
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
          content: 'â›” Apenas aluno, professor ou admin podem usar este comando.',
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
      .setTitle('ðŸ“‹ Sistema de Chamada')
      .setDescription('Clique no botÃ£o abaixo para entrar no sistema atual de chamadas.')
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

    // ðŸš« COOLDOWN (5s)
    if (cooldown.has(userId)) {
      return interaction.reply({
        content: 'â³ Aguarde alguns segundos antes de tentar novamente.',
        ephemeral: true
      });
    }

    cooldown.set(userId, true);
    setTimeout(() => cooldown.delete(userId), 5000);

    try {
      // ðŸ” verifica se jÃ¡ marcou hoje no Discord
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
          content: 'âš ï¸ VocÃª jÃ¡ marcou presenÃ§a hoje!',
          ephemeral: true
        });
      }

      // ðŸ’¾ busca mapeamento para nome real
      const mappingRes = await db.query(
        `SELECT real_name FROM discord_mappings WHERE LOWER(discord_username) = LOWER($1)`,
        [username]
      );

      // CASO A: Aluno NÃƒO estÃ¡ vinculado ainda -> Exibe o MODAL do Discord
      if (mappingRes.rowCount === 0) {
        const modal = new ModalBuilder()
          .setCustomId('vincular_modal')
          .setTitle('ðŸ‘¾ Vincular Conta | Mercury Class');

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

      // CASO B: Aluno jÃ¡ vinculado
      const mappedName = mappingRes.rows[0].real_name;

      // Busca todas as sessÃµes de aula ativas
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
          .setTitle('âœ… PresenÃ§a Registrada')
          .setDescription(`OlÃ¡, **${mappedName}**!\nSua presenÃ§a geral no Discord foi confirmada (nenhuma aula ativa no momento).`)
          .addFields(
            { name: 'ðŸ“… Hoje', value: 'Confirmada', inline: true },
            { name: 'ðŸ“Š Total', value: String(totalPresencas), inline: true }
          )
          .setColor('#5865F2')
          .setFooter({ text: 'Mercury Class' })
          .setTimestamp();

        return interaction.reply({ embeds: [embed] });
      }

      // Sub-Caso 2: Exatamente uma aula ativa -> registra presenÃ§a automaticamente
      if (activeSessions.rowCount === 1) {
        const sessionId = activeSessions.rows[0].id;
        const classId = activeSessions.rows[0].class_id;
        const className = activeSessions.rows[0].class_name;

        // Registra presenÃ§a na chamada oficial
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

        // ðŸ’¾ salva presenÃ§a geral na tabela Discord
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
          .setTitle('âœ… PresenÃ§a Registrada')
          .setDescription(`OlÃ¡, **${mappedName}**!\nðŸ“– **Chamada Escolar:** PresenÃ§a confirmada na aula ativa de **${className}**!`)
          .addFields(
            { name: 'ðŸ“… MatÃ©ria', value: className, inline: true },
            { name: 'ðŸ“Š Total', value: String(totalPresencas), inline: true }
          )
          .setColor('#5865F2')
          .setFooter({ text: 'Mercury Class' })
          .setTimestamp();

        return interaction.reply({ embeds: [embed] });
      }

      // Sub-Caso 3: MÃºltiplas aulas ativas -> gera botÃµes interativos para escolha
      const embed = new EmbedBuilder()
        .setTitle('ðŸ« Escolha sua Aula')
        .setDescription(`OlÃ¡, **${mappedName}**!\nIdentificamos mais de uma aula ativa no momento. Clique no botÃ£o correspondente para registrar sua presenÃ§a:`)
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
      interaction.reply({
        content: 'âŒ Erro ao registrar presenÃ§a.',
        ephemeral: true
      });
    }
  }
});

client.login(BOT_TOKEN);
