require('dotenv').config();

const { Client } = require('discord.js');
const tccProjects = require('./tcc-projects');
const queue = require('./tcc-generation-queue');

function isQuotaError(error) {
  const message = String(error?.message || '');
  const status = String(error?.status || error?.code || '').toUpperCase();
  return status === 'RESOURCE_EXHAUSTED' ||
    /RESOURCE_EXHAUSTED|You exceeded your current quota|check your plan and billing|quota exceeded|insufficient quota|billing details/i.test(message);
}

function safeError(error) {
  return String(error?.message || error?.name || 'Erro desconhecido')
    .replace(/(key|token|authorization|password)=?[^\s&]+/ig, '$1=[redigido]')
    .slice(0, 1800);
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL não configurado.');
  if (!process.env.DISCORD_TOKEN && !process.env.TOKEN) throw new Error('DISCORD_TOKEN não configurado.');
  if (!process.env.GEMINI_API_KEY && !process.env.GOOGLE_API_KEY) throw new Error('GEMINI_API_KEY não configurado.');

  await queue.initGenerationQueue();
  const recuperadas = await queue.recoverStaleGenerations(20);
  if (recuperadas) console.log('Tarefas recuperadas após interrupção:', recuperadas);

  const task = await queue.claimNextGeneration();
  if (!task) {
    console.log('Nenhuma tarefa pendente para processar.');
    return;
  }

  const project = task.project_data || {};
  const projectId = project.projectId || project.savedProjectId;
  if (!projectId) {
    await queue.markGenerationFailed(task.id, 'Projeto sem identificador do registro original; necessário reenvio para evitar duplicação.');
    throw new Error('A tarefa não contém projectId. Registro marcado como falha segura.');
  }

  const client = new Client({ intents: [] });
  try {
    await client.login(process.env.DISCORD_TOKEN || process.env.TOKEN);
    console.log('Processando protocolo:', task.id, 'tentativa:', task.attempts);

    const pesquisa = await tccProjects.generateTccResearch(project);
    const [docxBuffer, pptxBuffer] = await Promise.all([
      tccProjects.generateTccDocx(project, pesquisa),
      tccProjects.generateTccPptx(project, pesquisa)
    ]);

    const docx = Buffer.isBuffer(docxBuffer) ? docxBuffer : Buffer.from(docxBuffer || []);
    const pptx = Buffer.isBuffer(pptxBuffer) ? pptxBuffer : Buffer.from(pptxBuffer || []);
    const zip = Buffer.from([0x50, 0x4b]);
    if (docx.length < 1000 || pptx.length < 1000 ||
        !docx.subarray(0, 2).equals(zip) || !pptx.subarray(0, 2).equals(zip)) {
      throw new Error('Validação de integridade dos arquivos Word/PowerPoint falhou.');
    }

    const user = await client.users.fetch(String(task.discord_user_id));
    const message = await user.send({
      content: '✅ **Seu projeto acadêmico foi retomado e concluído!**\n' +
        'Protocolo #' + task.id + ' — Word ABNT e apresentação PowerPoint anexados. ' +
        'Confira os artigos, DOI e referências com seu orientador.',
      files: [
        { attachment: docx, name: 'TCC_ABNT_projeto_' + projectId + '.docx' },
        { attachment: pptx, name: 'Apresentacao_TCC_projeto_' + projectId + '.pptx' }
      ]
    });
    if (!message?.attachments || message.attachments.size !== 2) {
      throw new Error('Discord não confirmou os dois arquivos na mensagem privada.');
    }

    await queue.markGenerationCompleted(task.id, message.id);
    console.log('Tarefa concluída e arquivos entregues por DM:', task.id);
  } catch (error) {
    const message = safeError(error);
    if (isQuotaError(error)) {
      const retryAt = new Date(Date.now() + 60 * 60 * 1000);
      await queue.markGenerationWaiting(task.id, retryAt, message);
      console.error('Cota Gemini indisponível. Próxima verificação após:', retryAt.toISOString());
    } else if (task.attempts < 3) {
      const retryAt = new Date(Date.now() + 30 * 60 * 1000);
      await queue.markGenerationWaiting(task.id, retryAt, message);
      console.error('Falha temporária. Tarefa agendada para nova tentativa:', retryAt.toISOString());
    } else {
      await queue.markGenerationFailed(task.id, message);
      console.error('Tarefa encerrada após três tentativas:', task.id);
    }
    throw error;
  } finally {
    client.destroy();
  }
}

main().catch(error => {
  console.error('Falha no worker da fila:', safeError(error));
  process.exitCode = 1;
});
