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
