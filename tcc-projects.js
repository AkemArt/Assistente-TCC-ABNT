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
    [
      String(userId),
      String(username || 'desconhecido').slice(0, 100),
      guildId ? String(guildId) : null,
      String(studentName || '').trim(),
      String(advisorName || '').trim(),
      String(institution || '').trim(),
      String(course || '').trim(),
      String(title || '').trim()
    ]
  );
  return result.rows[0];
}

function centered(text, options = {}) {
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: options.after ?? 240, line: options.line ?? 240 },
    children: [
      new TextRun({
        text: String(text || ''),
        bold: Boolean(options.bold),
        size: options.size ?? 24,
        font: 'Times New Roman'
      })
    ]
  });
}

function natureBlock(text, options = {}) {
  return new Paragraph({
    alignment: AlignmentType.LEFT,
    indent: { left: 4535 }, // ~8 cm deslocado à direita conforme padrão de folha de rosto ABNT
    spacing: { after: options.after ?? 240, line: 240 },
    children: [
      new TextRun({
        text: String(text || ''),
        size: 20, // 10pt na folha de rosto costuma ser usado em notas/natureza do trabalho
        font: 'Times New Roman'
      })
    ]
  });
}

function body(text) {
  return new Paragraph({
    alignment: AlignmentType.JUSTIFIED,
    indent: { firstLine: 709 }, // ~1,25 cm recuo de primeira linha
    spacing: { after: 120, line: 360 }, // espaçamento 1,5 entre linhas (240 = simples, 360 = 1,5)
    children: [
      new TextRun({
        text: String(text || ''),
        size: 24, // 12pt
        font: 'Times New Roman'
      })
    ]
  });
}

function sectionHeading(title) {
  return new Paragraph({
    heading: 'Heading1',
    spacing: { before: 240, after: 120, line: 360 },
    children: [
      new TextRun({
        text: String(title || '').toUpperCase(),
        bold: true,
        font: 'Times New Roman',
        size: 24
      })
    ]
  });
}

async function generateTccDocx(project) {
  const currentYear = new Date().getFullYear();
  const institution = String(project.institution || '').toUpperCase();
  const studentName = String(project.studentName || '').toUpperCase();
  const title = String(project.title || '').toUpperCase();
  const course = String(project.course || '');
  const advisorName = String(project.advisorName || '');

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
    sections: [
      {
        properties: {
          page: {
            // Margens ABNT: superior e esquerda 3 cm (~1701 twips); inferior e direita 2 cm (~1134 twips)
            margin: { top: 1701, right: 1134, bottom: 1134, left: 1701 }
          }
        },
        children: [
          // CAPA
          centered(institution, { bold: true, after: 1200 }),
          centered(studentName, { after: 1800 }),
          centered(title, { bold: true, after: 2400 }),
          centered('Caraguatatuba', { after: 120 }),
          centered(String(currentYear)),

          new Paragraph({ children: [new PageBreak()] }),

          // FOLHA DE ROSTO
          centered(studentName, { after: 1400 }),
          centered(title, { bold: true, after: 1400 }),
          natureBlock(
            `Trabalho de Conclusão de Curso apresentado ao curso de ${course}, da instituição ${institution}, como requisito parcial para obtenção de título/conclusão do curso.`,
            { after: 240 }
          ),
          natureBlock(`Orientador(a): ${advisorName}`, { after: 1800 }),
          centered('Caraguatatuba', { after: 120 }),
          centered(String(currentYear)),

          new Paragraph({ children: [new PageBreak()] }),

          // ELEMENTOS TEXTUAIS INICIAIS
          sectionHeading('1 INTRODUÇÃO'),
          body(
            'Apresente aqui a contextualização do tema, o problema de pesquisa, a justificativa e os objetivos do trabalho. Este documento é um modelo inicial e não contém conteúdo acadêmico pesquisado ou validado.'
          ),

          sectionHeading('2 OBJETIVOS'),
          body('Defina o objetivo geral e os objetivos específicos do estudo.'),

          sectionHeading('3 METODOLOGIA'),
          body('Descreva os procedimentos metodológicos que serão utilizados na pesquisa.'),

          sectionHeading('REFERÊNCIAS'),
          body(
            'Inclua somente as fontes efetivamente consultadas e confira sua formatação conforme as normas e orientações da instituição.'
          ),

          new Paragraph({
            spacing: { before: 240 },
            children: [
              new TextRun({
                text: 'Observação: modelo inicial gerado automaticamente. Revise as exigências atuais da ABNT e o manual da sua instituição antes de entregar.',
                italics: true,
                size: 20,
                font: 'Times New Roman'
              })
            ]
          })
        ]
      }
    ]
  });

  return Packer.toBuffer(doc);
}

module.exports = { initTccProjects, saveProject, generateTccDocx };
