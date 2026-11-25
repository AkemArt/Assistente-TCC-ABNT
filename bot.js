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
            content: '⚠️ Ainda não tem conta registada. Use `/cadastrar` primeiro.',
            flags: MessageFlags.Ephemeral
          });
        }

        return interaction.update({
          content:
            `⚙️ Preferência guardada para **${updated.email}**: ` +
            `manter conectado = **${updated.keep_connected ? 'Sim' : 'Não'}**.`,
          components: []
        });
      } catch (error) {
        console.error('❌ Erro ao guardar escolha de manter conectado:', describeError(error));
        return interaction.reply({
          content: '❌ Não foi possível guardar a sua escolha agora.',
          flags: MessageFlags.Ephemeral
        });
      }
    }

    if (interaction.customId === 'avaliar_nota_select') {
      const notaNum = Number(interaction.values[0]);
      const ratingLabel = RATING_DESCRIPTIONS[notaNum] || `Nota ${notaNum}`;

      try {
        const savedLogin = await auth.getSavedLogin(interaction.user.id).catch(() => null);
        const created = await feedback.saveRating({
          discordUserId: interaction.user.id,
          discordUsername: interaction.user.username,
          userEmail: savedLogin?.email || savedLogin?.saved_email || null,
          ratingLabel
        });

        return interaction.update({
          content:
            `⭐ Nota selecionada: **${ratingLabel}**.\n` +
            'Agora clique no botão abaixo para escrever **o que precisa melhorar**:',
          components: [buildImprovementButton(created.id)]
        });
      } catch (error) {
        console.error('❌ Erro ao guardar nota de avaliação:', describeError(error));
        return interaction.reply({
          content: '❌ Não foi possível guardar a sua nota agora.',
          flags: MessageFlags.Ephemeral
        });
      }
    }

    return;
  }

  // ====================================================
  // 2. BOTÕES
  // ====================================================

  if (interaction.isButton()) {
    if (interaction.customId.startsWith('abrir_melhorias_')) {
      const feedbackId = interaction.customId.replace('abrir_melhorias_', '').trim();

      const modal = new ModalBuilder()
        .setCustomId(`melhorias_modal_${feedbackId}`)
        .setTitle('O que precisa melhorar?');

      const improvementInput = new TextInputBuilder()
        .setCustomId('feedback_improvements')
        .setLabel('O que precisa melhorar?')
        .setStyle(TextInputStyle.Paragraph)
        .setMinLength(2)
        .setMaxLength(2000)
        .setRequired(true)
        .setPlaceholder('Escreva o que podemos melhorar no bot');

      modal.addComponents(
        new ActionRowBuilder().addComponents(improvementInput)
      );

      return interaction.showModal(modal);
    }

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
              '⚠️ A sua conta ainda não está vinculada. ' +
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
            `A sua presença foi registada na disciplina: **${className}**!`
          )
          .addFields(
            { name: '📅 Disciplina', value: className, inline: true },
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
            content: '❌ Erro ao registar presença na disciplina selecionada.',
            flags: MessageFlags.Ephemeral
          });
        }
      }
    }

    return;
  }

  // ====================================================
  // 3. ENVIO DE FORMULÁRIOS (MODALS)
  // ====================================================

  if (interaction.isModalSubmit()) {

    if (interaction.customId.startsWith('melhorias_modal_')) {
      const feedbackId = interaction.customId.replace('melhorias_modal_', '').trim();
      const improvementNotes = interaction.fields.getTextInputValue('feedback_improvements').trim();

      try {
        const updated = await feedback.updateImprovementNotes({
          feedbackId,
          discordUserId: interaction.user.id,
          improvementNotes
        });

        if (!updated.ok) {
          return interaction.reply({
            content: `⚠️ ${updated.message}`,
            flags: MessageFlags.Ephemeral
          });
        }

        return interaction.reply({
          content:
            `✅ ${updated.message}\n` +
            `• Nota: **${updated.ratingInput}**\n` +
            `• O que precisa melhorar: ${improvementNotes}`,
          flags: MessageFlags.Ephemeral
        });
      } catch (error) {
        console.error('❌ Erro ao salvar melhorias:', describeError(error));
        return interaction.reply({
          content: '❌ Não foi possível salvar o que precisa melhorar agora.',
          flags: MessageFlags.Ephemeral
        });
      }
    }

    if (interaction.customId === 'cadastrar_modal') {
      const emailInput = interaction.fields.getTextInputValue('auth_email').trim();
      const passwordInput = interaction.fields.getTextInputValue('auth_password').trim();

      try {
        const result = await auth.registerUser({
          discordUserId: interaction.user.id,
          discordUsername: interaction.user.username,
          email: emailInput,
          password: passwordInput
        });

        if (!result.ok) {
          return interaction.reply({
            content: `⚠️ ${result.message}`,
            flags: MessageFlags.Ephemeral
          });
        }

        return interaction.reply({
          content:
            `✅ ${result.message}\n` +
            'Deseja manter conectado nas próximas vezes? Escolha uma opção abaixo:',
          components: [buildKeepConnectedMenu(true)],
          flags: MessageFlags.Ephemeral
        });
      } catch (error) {
        console.error('❌ Erro no registo de utilizador:', describeError(error));
        return interaction.reply({
          content: '❌ Erro ao concluir o registo. Tente novamente.',
          flags: MessageFlags.Ephemeral
        });
      }
    }

    if (interaction.customId === 'login_modal') {
      const emailInput = interaction.fields.getTextInputValue('auth_email').trim();
      const passwordInput = interaction.fields.getTextInputValue('auth_password').trim();

      try {
        const result = await auth.loginUser({
          discordUserId: interaction.user.id,
          discordUsername: interaction.user.username,
          email: emailInput,
          password: passwordInput
        });

        if (!result.ok) {
          return interaction.reply({
            content: `⚠️ ${result.message}`,
            flags: MessageFlags.Ephemeral
          });
        }

        const saved = await auth.getSavedLogin(interaction.user.id).catch(() => null);
        const currentKeep = saved?.keep_connected !== false;

        return interaction.reply({
          content:
            `✅ ${result.message}\n` +
            'Deseja manter conectado? Escolha uma opção abaixo:',
          components: [buildKeepConnectedMenu(currentKeep)],
          flags: MessageFlags.Ephemeral
        });
      } catch (error) {
        console.error('❌ Erro no login de utilizador:', describeError(error));
        return interaction.reply({
          content: '❌ Erro ao realizar o login. Tente novamente.',
          flags: MessageFlags.Ephemeral
        });
      }
    }

    if (interaction.customId === 'iniciar_tcc_modal') {
      const allowed = await ensureAuthenticated(interaction);
      if (!allowed) return;

      const nomeAluno = interaction.fields.getTextInputValue('tcc_aluno').trim();
      const cursoInstituicao = interaction.fields.getTextInputValue('tcc_curso_instituicao').trim();
      const orientador = interaction.fields.getTextInputValue('tcc_orientador').trim();
      const titulo = interaction.fields.getTextInputValue('tcc_titulo').trim();
      const folhasInput = interaction.fields.getTextInputValue('tcc_folhas').trim();

      const totalLabel = `iniciar_tcc_${interaction.user.id}_${Date.now()}`;
      console.time(totalLabel);

      try {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const project = {
          userId: interaction.user.id,
          username: interaction.user.username,
          guildId: interaction.guildId,
          studentName: nomeAluno,
          advisorName: orientador,
          institution: cursoInstituicao,
          course: cursoInstituicao,
          courseAndInstitution: cursoInstituicao,
          title: titulo,
          pageCount: folhasInput,
          focusNote: folhasInput
        };

        let saved = { id: 'novo' };
        try {
          saved = await tccProjects.saveProject(project);
        } catch (dbErr) {
          console.error(`⚠️ [${totalLabel}] Falha ao salvar no banco, prosseguindo com arquivos:`, describeError(dbErr));
        }

        const [docxBuffer, pptxBuffer] = await Promise.all([
          tccProjects.generateTccDocx(project),
          tccProjects.generateTccPptx(project)
        ]);

        const rawDocx = Buffer.isBuffer(docxBuffer) ? docxBuffer : Buffer.from(docxBuffer);
        const rawPptx = Buffer.isBuffer(pptxBuffer) ? pptxBuffer : Buffer.from(pptxBuffer);

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

        const payloadArquivos = {
          content: `📄 <@${interaction.user.id}> — Ficheiros do projeto nº ${saved.id} (${nomeAluno}) — Word ABNT e PowerPoint:`,
          files: [
            new AttachmentBuilder(rawDocx, { name: `TCC_ABNT_projeto_${saved.id}.docx` }),
            new AttachmentBuilder(rawPptx, { name: `Apresentacao_TCC_projeto_${saved.id}.pptx` })
          ]
        };

        let enviado = false;
        if (interaction.channel && typeof interaction.channel.send === 'function') {
          try {
            await withTimeout(interaction.channel.send(payloadArquivos), 12000, `${totalLabel}_channel_send`);
            enviado = true;
          } catch (channelErr) {
            console.warn(`⚠️ [${totalLabel}] Falha no channel.send, tentando followUp:`, describeError(channelErr));
          }
        }

        if (!enviado) {
          await withTimeout(
            interaction.followUp({
              content: `📄 Ficheiros do projeto nº ${saved.id} (${nomeAluno}) — Word ABNT e PowerPoint:`,
              files: [
                new AttachmentBuilder(rawDocx, { name: `TCC_ABNT_projeto_${saved.id}.docx` }),
                new AttachmentBuilder(rawPptx, { name: `Apresentacao_TCC_projeto_${saved.id}.pptx` })
              ]
            }),
            12000,
            `${totalLabel}_followUp_fallback`
          );
        }

        const resumo = new EmbedBuilder()
          .setTitle('📚 Projeto de TCC processado, Word ABNT e PowerPoint criados')
          .setDescription(
            `Projeto nº ${saved.id} processado com estrutura ABNT e apresentação em PowerPoint prontos para revisão.`
          )
          .addFields(
            { name: 'Aluno(a)', value: nomeAluno, inline: false },
            { name: 'Curso e Instituição', value: cursoInstituicao, inline: false },
            { name: 'Orientador(a)', value: orientador, inline: true },
            { name: 'Folhas / Foco', value: folhasInput || '10 folhas', inline: true },
            { name: 'Título / Tema', value: titulo, inline: false }
          )
          .setColor('#5865F2');

        await interaction.editReply({
          content: '✅ Ficheiros Word (.docx) + PowerPoint (.pptx) enviados!',
          embeds: [resumo]
        }).catch(() => {});

        console.timeEnd(totalLabel);
        return;
      } catch (error) {
        console.error(`❌ [${totalLabel}] Falha ao iniciar TCC:`, describeError(error), error);
        await interaction.editReply({
          content: '❌ Não consegui concluir o envio dos ficheiros. Tente novamente em instantes.',
          embeds: [],
          files: []
        }).catch(() => {});
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
            'Digite o comando `/presenca` novamente para registar a sua presença.',
          flags: MessageFlags.Ephemeral
        });
      } catch (error) {
        console.error('Erro ao vincular conta:', error);

        await interaction.reply({
          content: '❌ Erro ao vincular a sua conta.',
          flags: MessageFlags.Ephemeral
        });
      }
    }

    return;
  }

  // ====================================================
  // 4. COMANDOS SLASH
  // ====================================================

  if (!interaction.isChatInputCommand()) return;

  stats.recordEvent({
    userId: interaction.user.id,
    username: interaction.user.username,
    guildId: interaction.guildId,
    eventType: 'command',
    commandName: interaction.commandName
  }).catch(error => {
    console.error('⚠️ Falha ao registar uso do comando:', describeError(error));
  });

  if (interaction.commandName === 'avaliar') {
    return interaction.reply({
      content:
        '⭐ **O quanto você gostou do bot?**\n' +
        'Escolha uma nota de **1** (menos gostei) a **10** (gostei muito) no menu abaixo:',
      components: [buildRatingMenu()],
      flags: MessageFlags.Ephemeral
    });
  }

  if (interaction.commandName === 'avaliacoes_tcc') {
    if (!process.env.OWNER_USER_ID || String(interaction.user.id) !== String(process.env.OWNER_USER_ID)) {
      return interaction.reply({
        content: '🔒 Este comando é exclusivo do administrador do bot.',
        flags: MessageFlags.Ephemeral
      });
    }

    try {
      const items = await feedback.listFeedback(15);
      if (!items.length) {
        return interaction.reply({
          content: '⭐ Ainda não existem avaliações registadas.',
          flags: MessageFlags.Ephemeral
        });
      }

      const linhas = items.map((fb, idx) => {
        const who = fb.user_email ? `${fb.user_email} (@${fb.discord_username})` : `@${fb.discord_username}`;
        const melhorias = fb.improvement_notes || '(não preenchido)';
        return (
          `${idx + 1}. **Nota:** ${fb.rating_input} — *${who}*\n` +
          `   **Melhorar:** ${melhorias}`
        );
      });

      const embed = new EmbedBuilder()
        .setTitle('⭐ Avaliações Recebidas (Apenas Administrador)')
        .setDescription(linhas.join('\n\n').slice(0, 4000))
        .setColor('#5865F2')
        .setFooter({ text: `Exibindo até ${items.length} avaliação(ões) mais recentes` })
        .setTimestamp();

      return interaction.reply({
        embeds: [embed],
        flags: MessageFlags.Ephemeral
      });
    } catch (error) {
      console.error('❌ Erro ao consultar avaliações:', describeError(error));
      return interaction.reply({
        content: '❌ Erro ao consultar as avaliações.',
        flags: MessageFlags.Ephemeral
      });
    }
  }

  if (interaction.commandName === 'cadastrar') {
    const modal = new ModalBuilder()
      .setCustomId('cadastrar_modal')
      .setTitle('Registo • Assistente TCC');

    const emailInput = new TextInputBuilder()
      .setCustomId('auth_email')
      .setLabel('O seu e-mail')
      .setStyle(TextInputStyle.Short)
      .setMinLength(5)
      .setMaxLength(160)
      .setRequired(true)
      .setPlaceholder('exemplo@email.com');

    const passwordInput = new TextInputBuilder()
      .setCustomId('auth_password')
      .setLabel('Senha com 8 números (ex.: 12345678)')
      .setStyle(TextInputStyle.Short)
      .setMinLength(8)
      .setMaxLength(8)
      .setRequired(true)
      .setPlaceholder('8 dígitos numéricos');

    modal.addComponents(
      new ActionRowBuilder().addComponents(emailInput),
      new ActionRowBuilder().addComponents(passwordInput)
    );

    return interaction.showModal(modal);
  }

  if (interaction.commandName === 'login') {
    const saved = await auth.getSavedLogin(interaction.user.id).catch(() => null);
    const defaultEmail = saved?.saved_email || saved?.email || '';

    const modal = new ModalBuilder()
      .setCustomId('login_modal')
      .setTitle('Login • Assistente TCC');

    const emailInput = new TextInputBuilder()
      .setCustomId('auth_email')
      .setLabel('O seu e-mail')
      .setStyle(TextInputStyle.Short)
      .setMinLength(5)
      .setMaxLength(160)
      .setRequired(true);

    if (defaultEmail) {
      emailInput.setValue(defaultEmail);
    }

    const passwordInput = new TextInputBuilder()
      .setCustomId('auth_password')
      .setLabel('A sua senha de 8 números')
      .setStyle(TextInputStyle.Short)
      .setMinLength(8)
      .setMaxLength(8)
      .setRequired(true)
      .setPlaceholder('8 dígitos numéricos');

    modal.addComponents(
      new ActionRowBuilder().addComponents(emailInput),
      new ActionRowBuilder().addComponents(passwordInput)
    );

    return interaction.showModal(modal);
  }

  if (interaction.commandName === 'logout') {
    try {
      await auth.logoutUser(interaction.user.id);
      return interaction.reply({
        content: '👋 Sessão encerrada e modo manter conectado desativado.',
        flags: MessageFlags.Ephemeral
      });
    } catch (error) {
      console.error('❌ Erro no /logout:', describeError(error));
      return interaction.reply({
        content: '❌ Não foi possível encerrar a sessão agora.',
        flags: MessageFlags.Ephemeral
      });
    }
  }

  if (interaction.commandName === 'manter_conectado') {
    try {
      const saved = await auth.getSavedLogin(interaction.user.id);
      if (!saved) {
        return interaction.reply({
          content: '⚠️ Ainda não tem conta registada. Use `/cadastrar` primeiro.',
          flags: MessageFlags.Ephemeral
        });
      }

      return interaction.reply({
        content:
          `⚙️ Conta **${saved.email}** — escolha se deseja manter conectado:`,
        components: [buildKeepConnectedMenu(saved.keep_connected)],
        flags: MessageFlags.Ephemeral
      });
    } catch (error) {
      console.error('❌ Erro no /manter_conectado:', describeError(error));
      return interaction.reply({
        content: '❌ Não foi possível carregar a opção de manter conectado.',
        flags: MessageFlags.Ephemeral
      });
    }
  }

  if (interaction.commandName === 'usuarios_tcc') {
    if (!process.env.OWNER_USER_ID || String(interaction.user.id) !== String(process.env.OWNER_USER_ID)) {
      return interaction.reply({
        content: '🔒 Este comando é exclusivo do administrador do bot.',
        flags: MessageFlags.Ephemeral
      });
    }

    try {
      const users = await auth.listRegisteredUsers();
      if (!users.length) {
        return interaction.reply({
          content: '📋 Ainda não existem utilizadores registados na tabela `tcc_users`.',
          flags: MessageFlags.Ephemeral
        });
      }

      const linhas = users.slice(0, 20).map((u, idx) => {
        const estado = u.is_logged_in ? '🟢 Online' : '⚪ Offline';
        const manter = u.keep_connected ? 'Sim' : 'Não';
        const salvo = u.saved_email || u.email;
        return (
          `${idx + 1}. **${u.email}** (@${u.discord_username} • ID: \`${u.discord_user_id}\`)\n` +
          `   Estado: ${estado} | E-mail salvo: \`${salvo}\` | Manter conectado: **${manter}**`
        );
      });

      const embed = new EmbedBuilder()
        .setTitle('🔐 Registo de Utilizadores (Apenas Administrador)')
        .setDescription(linhas.join('\n\n').slice(0, 4000))
        .setColor('#5865F2')
        .setFooter({ text: `Total de registos: ${users.length}` })
        .setTimestamp();

      return interaction.reply({
        embeds: [embed],
        flags: MessageFlags.Ephemeral
      });
    } catch (error) {
      console.error('❌ Erro ao consultar utilizadores:', describeError(error));
      return interaction.reply({
        content: '❌ Erro ao consultar a lista de utilizadores registados.',
        flags: MessageFlags.Ephemeral
      });
    }
  }

  if (interaction.commandName === 'rascunho_tcc') {
    const allowed = await ensureAuthenticated(interaction);
    if (!allowed) return;

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
          '📚 **O seu rascunho académico está pronto!**\n' +
          `🔍 Foram encontradas ${(resultado.fontes || []).length} fontes académicas.\n` +
          'Confira os títulos, autores e links; leia as fontes antes de utilizar as informações no TCC e reveja o texto com o seu orientador.',
        files: [arquivo]
      });
    } catch (error) {
      console.error('Erro ao gerar rascunho com pesquisa académica:', error);

      return interaction.editReply({
        content:
          '❌ Não foi possível gerar o rascunho ou pesquisar as fontes. ' +
          'Tente novamente dentro de alguns minutos ou utilize um tema diferente.'
      });
    }
  }

  if (interaction.commandName === 'estatisticas') {
    const allowedRoleId = process.env.STATS_ROLE_ID;
    const isAdmin = interaction.memberPermissions?.has('Administrator');
    const hasAllowedRole = Boolean(
      allowedRoleId &&
      interaction.member?.roles?.cache?.has(allowedRoleId)
    );

    if (!isAdmin && !hasAllowedRole) {
      return interaction.reply({
        content: '🔒 Este comando é restrito à equipa autorizada.',
        flags: MessageFlags.Ephemeral
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
        : 'Ainda não há comandos registados.';

      const embed = new EmbedBuilder()
        .setTitle('📊 Estatísticas do Bot TCC')
        .setDescription(
          'Indicadores calculados a partir dos eventos registados desde a ativação das estatísticas.'
        )
        .addFields(
          { name: '👥 Utilizadores únicos', value: String(totals.unique_users), inline: true },
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
        flags: MessageFlags.Ephemeral
      });
    } catch (error) {
      console.error('Erro ao montar estatísticas:', error);

      return interaction.reply({
        content:
          'Não consegui consultar as estatísticas. Confira se o PostgreSQL está configurado e se o bot já inicializou as tabelas.',
        flags: MessageFlags.Ephemeral
      });
    }
  }

  if (interaction.commandName === 'iniciar_tcc') {
    const allowed = await ensureAuthenticated(interaction);
    if (!allowed) return;

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

    const cursoInstituicao = new TextInputBuilder()
      .setCustomId('tcc_curso_instituicao')
      .setLabel('Curso e Instituição (ex.: ADS - MODULO)')
      .setStyle(TextInputStyle.Short)
      .setMinLength(3)
      .setMaxLength(150)
      .setRequired(true);

    const orientador = new TextInputBuilder()
      .setCustomId('tcc_orientador')
      .setLabel('Nome do professor orientador')
      .setStyle(TextInputStyle.Short)
      .setMinLength(2)
      .setMaxLength(100)
      .setRequired(true);

    const titulo = new TextInputBuilder()
      .setCustomId('tcc_titulo')
      .setLabel('Título ou tema do trabalho')
      .setStyle(TextInputStyle.Paragraph)
      .setMinLength(3)
      .setMaxLength(250)
      .setRequired(true);

    const folhas = new TextInputBuilder()
      .setCustomId('tcc_folhas')
      .setLabel('Qtd. de folhas desejada (ex.: 10, 20)')
      .setStyle(TextInputStyle.Short)
      .setMinLength(1)
      .setMaxLength(80)
      .setRequired(true)
      .setPlaceholder('Ex.: 10 ou 20');

    modal.addComponents(
      new ActionRowBuilder().addComponents(aluno),
      new ActionRowBuilder().addComponents(cursoInstituicao),
      new ActionRowBuilder().addComponents(orientador),
      new ActionRowBuilder().addComponents(titulo),
      new ActionRowBuilder().addComponents(folhas)
    );

    return interaction.showModal(modal);
  }

  if (interaction.commandName === 'presenca') {
    const userId = interaction.user.id;
    const username = interaction.user.username;
    const guildId = interaction.guild.id;

    if (cooldown.has(userId)) {
      return interaction.reply({
        content: '⏳ Aguarde alguns segundos antes de tentar novamente.',
        flags: MessageFlags.Ephemeral
      });
    }

    cooldown.set(userId, true);
    setTimeout(() => {
      cooldown.delete(userId);
    }, 5000);

    try {
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
          content: '⚠️ Já marcou presença hoje!',
          flags: MessageFlags.Ephemeral
        });
      }

      const mappingRes = await db.query(
        `SELECT real_name
         FROM discord_mappings
         WHERE LOWER(discord_username) = LOWER($1)`,
        [username]
      );

      if (mappingRes.rowCount === 0) {
        const modal = new ModalBuilder()
          .setCustomId('vincular_modal')
          .setTitle('👾 Vincular Conta | Mercury Class');

        const realNameInput = new TextInputBuilder()
          .setCustomId('real_name_input')
          .setLabel('O seu Nome Completo (como na chamada)')
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

      const activeSessions = await db.query(
        `SELECT cs.id, cs.class_id, c.name AS class_name
         FROM class_sessions cs
         JOIN classes c ON c.id = cs.class_id
         WHERE cs.active = true
         ORDER BY cs.start_time DESC`
      );

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
          .setTitle('✅ Presença Registada')
          .setDescription(
            `Olá, **${mappedName}**!\n` +
            'A sua presença geral no Discord foi confirmada (nenhuma aula ativa de momento).'
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
          .setTitle('✅ Presença Registada')
          .setDescription(
            `Olá, **${mappedName}**!\n` +
            `📖 **Chamada Escolar:** Presença confirmada na aula ativa de **${className}**!`
          )
          .addFields(
            { name: '📅 Disciplina', value: className, inline: true },
            { name: '📊 Total', value: String(totalPresencas), inline: true }
          )
          .setColor('#5865F2')
          .setFooter({ text: 'Mercury Class' })
          .setTimestamp();

        return interaction.reply({
          embeds: [embed]
        });
      }

      const embed = new EmbedBuilder()
        .setTitle('🏫 Escolha a sua Aula')
        .setDescription(
          `Olá, **${mappedName}**!\n` +
          'Identificámos mais de uma aula ativa de momento. ' +
          'Clique no botão correspondente para registar a sua presença:'
        )
        .setColor('#5865F2')
        .setFooter({ text: 'Mercury Class' })
        .setTimestamp();

      const row = new ActionRowBuilder();

      activeSessions.rows.slice(0, 5).forEach(session => {
        const emoji = getEmojiForClass(session.class_name);

        row.addComponents(
          new ButtonBuilder()
            .setCustomId(
              `presenca_aula_${session.id}_${session.class_id}`
            )
            .setLabel(`${emoji} ${session.class_name}`.slice(0, 80))
            .setStyle(ButtonStyle.Primary)
        );
      });

      return interaction.reply({
        embeds: [embed],
        components: [row]
      });
    } catch (error) {
      console.error('Erro no comando /presenca:', error);

      if (!interaction.replied && !interaction.deferred) {
        return interaction.reply({
          content: '❌ Erro ao processar o comando `/presenca`.',
          flags: MessageFlags.Ephemeral
        });
      }
    }
  }
});

// ======================================================
// SERVIDOR HTTP (HEALTH-CHECK PARA O RENDER)
// ======================================================

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('OK');
});

server.listen(PORT, () => {
  console.log(`🌐 Servidor HTTP ativo na porta ${PORT}`);
});

client.login(BOT_TOKEN);
