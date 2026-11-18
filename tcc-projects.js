const { Document, Packer, Paragraph, TextRun, AlignmentType, PageBreak } = require('docx');
const db = require('./database');

async function initTccProjects() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL não configurado.');
  await db.query(`
    CREATE TABLE IF NOT EXISTS tcc_projects (
      id BIGSERIAL PRIMARY KEY,
      discord_user_id VARCHAR(32) NOT NULL,
      discord_username VARCHAR(100) NOT NULL,
      guild_id VARCHAR(32),
      student_name VARCHAR(100) NOT NULL,
      advisor_name VARCHAR(100) NOT NULL,
      institution VARCHAR(120) NOT NULL,
      course VARCHAR(100) NOT NULL,
      title VARCHAR(250) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_tcc_projects_user_created
      ON tcc_projects (discord_user_id, created_at DESC);
  `);
  console.log('📚 Tabela de projetos de TCC verificada.');
}

async function saveProject({ userId, username, guildId, studentName, advisorName, institution, course, title }) {
  const result = await db.query(
    `INSERT INTO tcc_projects
      (discord_user_id, discord_username, guild_id, student_name, advisor_name, institution, course, title)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, created_at`,
    [String(userId), String(username || 'desconhecido').slice(0, 100), guildId ? String(guildId) : null,
      studentName, advisorName, institution, course, title]
  );
  return result.rows[0];
}

function centered(text, options = {}) {
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: options.after ?? 240 },
    children: [new TextRun({ text, bold: Boolean(options.bold), size: options.size ?? 24, font: 'Times New Roman' })]
  });
}

function body(text) {
  return new Paragraph({
    alignment: AlignmentType.JUSTIFIED,
    indent: { firstLine: 709 },
    spacing: { after: 120, line: 360 },
    children: [new TextRun({ text, size: 24, font: 'Times New Roman' })]
  });
}

async function generateTccDocx(project) {
  const currentYear = new Date().getFullYear();
  const doc = new Document({
    creator: 'Assistente TCC ABNT',
    title: project.title,
    description: 'Documento inicial de TCC para revisão do estudante.',
    styles: {
      default: {
        document: {
          run: { font: 'Times New Roman', size: 24 },
          paragraph: { spacing: { line: 360, after: 120 } }
        }
      }
    },
    sections: [{
      properties: {
        page: {
          margin: { top: 1701, right: 1134, bottom: 1134, left: 1701 }
        }
      },
      children: [
        ...Array.from({ length: 4 }, () => new Paragraph({ children: [] })),
        centered(project.institution.toUpperCase(), { bold: true }),
        centered(project.studentName.toUpperCase(), { after: 1600 }),
        centered(project.title.toUpperCase(), { bold: true, after: 1800 }),
        centered(project.course, { after: 120 }),
        centered(`Orientador(a): ${project.advisorName}`, { after: 1600 }),
        centered('Caraguatatuba', { after: 120 }),
        centered(String(currentYear)),
        new Paragraph({ children: [new PageBreak()] }),
        centered(project.studentName.toUpperCase(), { after: 1200 }),
        centered(project.title.toUpperCase(), { bold: true, after: 1400 }),
        body(`Trabalho de Conclusão de Curso apresentado ao curso de ${project.course}, da instituição ${project.institution}, como parte dos requisitos para conclusão do curso.`),
        body(`Orientador(a): ${project.advisorName}`),
        ...Array.from({ length: 5 }, () => new Paragraph({ children: [] })),
        centered('Caraguatatuba', { after: 120 }),
        centered(String(currentYear)),
        new Paragraph({ children: [new PageBreak()] }),
        new Paragraph({ heading: 'Heading1', children: [new TextRun({ text: '1 INTRODUÇÃO', bold: true, font: 'Times New Roman', size: 24 })] }),
        body('Apresente aqui a contextualização do tema, o problema de pesquisa, a justificativa e os objetivos do trabalho. Este documento é um modelo inicial e não contém conteúdo acadêmico pesquisado ou validado.'),
        new Paragraph({ heading: 'Heading1', children: [new TextRun({ text: '2 OBJETIVOS', bold: true, font: 'Times New Roman', size: 24 })] }),
        body('Defina o objetivo geral e os objetivos específicos do estudo.'),
        new Paragraph({ heading: 'Heading1', children: [new TextRun({ text: '3 METODOLOGIA', bold: true, font: 'Times New Roman', size: 24 })] }),
        body('Descreva os procedimentos metodológicos que serão utilizados na pesquisa.'),
        new Paragraph({ heading: 'Heading1', children: [new TextRun({ text: 'REFERÊNCIAS', bold: true, font: 'Times New Roman', size: 24 })] }),
        body('Inclua somente as fontes efetivamente consultadas e confira sua formatação conforme as normas e orientações da instituição.'),
        new Paragraph({ spacing: { before: 240 }, children: [new TextRun({ text: 'Observação: modelo inicial gerado automaticamente. Revise as exigências atuais da ABNT e o manual da sua instituição antes de entregar.', italics: true, size: 20, font: 'Times New Roman' })] })
      ]
    }]
  });
  return Packer.toBuffer(doc);
}

module.exports = { initTccProjects, saveProject, generateTccDocx };
